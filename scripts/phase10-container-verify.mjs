import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function docker(args) {
  const { stdout, stderr } = await execFileAsync("docker", args, { timeout: 60_000 });
  return `${stdout}\n${stderr}`.trim();
}

async function waitForHttp(url, headers = {}, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = null;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url, { headers });
      if (r.status < 500) return r;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Timed out waiting for ${url}: ${String(lastErr)}`);
}

async function main() {
  const tag = Date.now().toString(36);
  const docsName = `olb-cverify-docs-${tag}`;
  const apiName = `olb-cverify-api-${tag}`;
  const workerName = `olb-cverify-wrk-${tag}`;
  const consoleName = `olb-cverify-con-${tag}`;
  const masterKey = randomBytes(32).toString("hex");
  const opsToken = `ops_${randomBytes(16).toString("hex")}`;
  const dbUrl = "postgres://postgres:postgres@host.docker.internal:6432/mygamingslot";

  const containers = [docsName, apiName, workerName, consoleName];
  try {
    // 1. Start Docs container
    await docker(["run", "-d", "--name", docsName, "-p", "14300:4300", "olb-docs:rc1"]);
    // 2. Start API container (NODE_ENV=production via PgBouncer host.docker.internal:6432)
    await docker([
      "run", "-d", "--name", apiName,
      "--add-host=host.docker.internal:host-gateway",
      "-e", "NODE_ENV=production",
      "-e", "PORT=4100",
      "-e", `PGBOUNCER_URL=${dbUrl}`,
      "-e", "PG_MAX_CONNECTIONS=100",
      "-e", "PGBOUNCER_DEFAULT_POOL_SIZE=60",
      "-e", "API_INSTANCE_COUNT=4",
      "-e", `OLB_WEBHOOK_MASTER_KEY=${masterKey}`,
      "-e", `OLB_OPS_TOKEN=${opsToken}`,
      "-p", "14100:4100",
      "olb-api:rc1",
    ]);
    // 3. Start Persistent Workers container
    await docker([
      "run", "-d", "--name", workerName,
      "--add-host=host.docker.internal:host-gateway",
      "-e", "NODE_ENV=production",
      "-e", `DATABASE_URL=${dbUrl}`,
      "-e", "PG_MAX_CONNECTIONS=100",
      "-e", "API_INSTANCE_COUNT=4",
      "-e", `OLB_WEBHOOK_MASTER_KEY=${masterKey}`,
      "olb-api:rc1",
      "node", "dist/src/platform/bin/run-workers.js",
    ]);
    // 4. Start Developer Console container
    await docker([
      "run", "-d", "--name", consoleName,
      "--add-host=host.docker.internal:host-gateway",
      "-e", "NODE_ENV=production",
      "-e", `DATABASE_URL=${dbUrl}`,
      "-e", `OLB_WEBHOOK_MASTER_KEY=${masterKey}`,
      "-p", "13000:3000",
      "olb-console:rc1",
    ]);

    // Verify Docs HTTP 200
    const docsRes = await waitForHttp("http://127.0.0.1:14300/");
    assert.equal(docsRes.status, 200);
    assert.ok((await docsRes.text()).includes("Five-Minute Quickstart"));

    // Verify API health + restricted ops endpoints
    const healthRes = await waitForHttp("http://127.0.0.1:14100/v1/health");
    assert.equal(healthRes.status, 200);
    assert.deepEqual(await healthRes.json(), { status: "ok" });

    const unauthMetrics = await fetch("http://127.0.0.1:14100/v1/metrics");
    assert.equal(unauthMetrics.status, 401);

    const authMetrics = await fetch("http://127.0.0.1:14100/v1/metrics", {
      headers: { "X-Ops-Token": opsToken },
    });
    assert.equal(authMetrics.status, 200);
    assert.ok((await authMetrics.text()).includes("olb_pg_pool_connections"));

    const authReady = await fetch("http://127.0.0.1:14100/v1/ready", {
      headers: { Authorization: `Bearer ${opsToken}` },
    });
    assert.equal(authReady.status, 200);
    const readyBody = await authReady.json();
    assert.equal(readyBody.ready, true);
    assert.equal(readyBody.postgresOk, true);

    // Verify Workers logged startup cleanly
    await new Promise((r) => setTimeout(r, 1500));
    const workerLogs = await docker(["logs", workerName]);
    assert.ok(workerLogs.includes("OneLineBooking background workers started"), `Unexpected worker logs: ${workerLogs}`);

    // Verify Developer Console HTTP 200 on /login
    const consoleRes = await waitForHttp("http://127.0.0.1:13000/login");
    assert.equal(consoleRes.status, 200);

    // Verify graceful SIGTERM shutdown across API, Workers, Console, and Docs
    const exitCodes = {};
    for (const name of containers) {
      const t0 = Date.now();
      await docker(["stop", "-t", "10", name]);
      const elapsedMs = Date.now() - t0;
      const code = Number(await docker(["inspect", "--format", "{{.State.ExitCode}}", name]));
      exitCodes[name] = { code, elapsedMs };
    }

    assert.equal(exitCodes[apiName].code, 0, `API container non-zero SIGTERM exit: ${JSON.stringify(exitCodes[apiName])}`);
    assert.equal(exitCodes[workerName].code, 0, `Worker container non-zero SIGTERM exit: ${JSON.stringify(exitCodes[workerName])}`);

    console.log(
      JSON.stringify(
        {
          containerVerificationPassed: true,
          images: ["olb-docs:rc1", "olb-api:rc1", "olb-console:rc1"],
          pgBouncerPooledRuntime: true,
          restrictedMetricsVerified: true,
          gracefulShutdownExitCodes: exitCodes,
        },
        null,
        2,
      ),
    );
  } finally {
    await docker(["rm", "-f", ...containers]).catch(() => {});
  }
}

void main();
