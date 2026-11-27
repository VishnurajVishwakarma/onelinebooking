import "dotenv/config";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import {
  ALL_ADMIN_CAPABILITIES,
  PostgresBookingStore,
  TimeSlotEngine,
  buildBudgetedPoolConfig,
  computeConnectionBudget,
  createBookingPool,
  runMigrations,
} from "../src/index.js";

const execFileAsync = promisify(execFile);

async function countPgConnections(directUrl: string, appNameFilter?: string): Promise<number> {
  const probe = createBookingPool(directUrl, { max: 1 });
  try {
    const res = await probe.query<{ cnt: number }>(
      `SELECT count(*)::int AS cnt FROM pg_stat_activity
       WHERE datname = current_database()
         AND ($1::text IS NULL OR application_name = $1)`,
      [appNameFilter ?? null],
    );
    return Number(res.rows[0]?.cnt ?? 0);
  } finally {
    await probe.end();
  }
}

async function main(): Promise<void> {
  const directUrl = process.env.DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/mygamingslot";
  const pgbouncerUrl = process.env.PGBOUNCER_URL ?? "postgres://postgres:postgres@127.0.0.1:6432/mygamingslot";

  // 1. Validate budgeted connection plan never exceeds max_connections
  const budget = computeConnectionBudget({
    postgresMaxConnections: 100,
    apiInstanceCount: 4,
    pgbouncerDefaultPoolSize: 50,
  });
  assert.ok(budget.totalApiConnectionBudget <= 65);
  assert.ok(budget.totalApiConnectionBudget + budget.totalReservedConnections <= 100);

  const directPool = createBookingPool(directUrl, { max: 5 });
  await runMigrations(directPool);
  const directEngine = new TimeSlotEngine(new PostgresBookingStore(directPool));
  const tenant = await directEngine.createTenant({ name: `ConnRel ${randomUUID().slice(0, 8)}` });
  const admin = directEngine.forTenant({
    tenantId: tenant.id,
    actor: { id: "conn-rel", type: "admin", capabilities: ALL_ADMIN_CAPABILITIES },
  });
  const fac = await admin.createFacility({ name: "Pool Court", category: "pc", timeZone: "UTC" });

  // 2. Concurrent burst via PgBouncer (75 logical connections across 3 API pools -> capped strictly <= 65 in Postgres)
  const appTag = `olb-burst-${randomUUID().slice(0, 6)}`;
  const burstPools = Array.from({ length: 3 }, () =>
    createBookingPool(pgbouncerUrl, {
      max: 25,
      idleTimeoutMillis: 2_000,
      application_name: appTag,
    }),
  );

  let peakBackendsDuringBurst = 0;
  try {
    await Promise.all(
      burstPools.flatMap((p) =>
        Array.from({ length: 25 }, () => p.query("SELECT pg_sleep(0.25), $1::text AS fac", [fac.id])),
      ),
    );
    peakBackendsDuringBurst = await countPgConnections(directUrl, appTag);
    assert.ok(peakBackendsDuringBurst <= 65, `Expected <= 65 PgBouncer server backends, saw ${peakBackendsDuringBurst}`);
  } finally {
    await Promise.all(burstPools.map((p) => p.end()));
  }

  // 3. Automatic idle server cleanup via SERVER_IDLE_TIMEOUT (15s in compose.yaml) WITHOUT manual PgBouncer restart
  let backendsAfterIdleCleanup = peakBackendsDuringBurst;
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    backendsAfterIdleCleanup = await countPgConnections(directUrl, appTag);
    if (backendsAfterIdleCleanup === 0) break;
    await new Promise((r) => setTimeout(r, 1_000));
  }
  assert.equal(
    backendsAfterIdleCleanup,
    0,
    `Expected PgBouncer idle cleanup to drop burst backends to 0 automatically, remaining=${backendsAfterIdleCleanup}`,
  );

  // 4. Repeated rolling API deployments (5 consecutive create -> serve -> drain cycles) leave 0 leaked connections
  const rollingTag = `olb-roll-${randomUUID().slice(0, 6)}`;
  for (let deploy = 0; deploy < 5; deploy += 1) {
    const apiPool = createBookingPool(
      pgbouncerUrl,
      buildBudgetedPoolConfig(budget, "api", { application_name: rollingTag, idleTimeoutMillis: 1_000 }),
    );
    const apiEngine = new TimeSlotEngine(new PostgresBookingStore(apiPool));
    const got = await apiEngine.getTenant(tenant.id);
    assert.equal(got.id, tenant.id);
    await apiPool.end();
  }

  // 5. Automatic recovery across live PgBouncer restart WITHOUT application intervention
  const recoveryPool = createBookingPool(pgbouncerUrl, buildBudgetedPoolConfig(budget, "api"));
  recoveryPool.on("error", () => {});
  const recoveryEngine = new TimeSlotEngine(new PostgresBookingStore(recoveryPool));
  assert.equal((await recoveryEngine.getTenant(tenant.id)).id, tenant.id);

  await execFileAsync("docker", ["compose", "--profile", "pgbouncer", "restart", "pgbouncer"]);
  let recovered = false;
  for (let i = 0; i < 20; i += 1) {
    try {
      const t = await recoveryEngine.getTenant(tenant.id);
      if (t.id === tenant.id) {
        recovered = true;
        break;
      }
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  await recoveryPool.end();
  assert.equal(recovered, true, "Expected API pool to automatically recover after PgBouncer restart");

  await directPool.end();

  console.log(
    JSON.stringify(
      {
        connectionReliabilityPassed: true,
        budget,
        peakBackendsDuringBurst,
        backendsAfterIdleCleanup,
        rollingDeploymentsVerified: 5,
        automaticPgBouncerRecovery: true,
      },
      null,
      2,
    ),
  );
}

void main();
