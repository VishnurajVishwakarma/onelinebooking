import "dotenv/config";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import type { Pool } from "pg";
import {
  ALL_PLATFORM_SCOPES,
  BookingError,
  PlatformService,
  PostgresBookingStore,
  PostgresDistributedLimiter,
  TimeSlotEngine,
  createBookingPool,
  createPlatformHttpServer,
  runMigrations,
} from "../../src/index.js";

const execFileAsync = promisify(execFile);

function listenServer(server: Server): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo;
      resolvePromise(`http://127.0.0.1:${addr.port}`);
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolvePromise) => server.close(() => resolvePromise()));
}

describe("Phase 10 Release Acceptance: Ops Security, Lease Renewal, Ledger Crash Recovery & All-5 SDK Examples", () => {
  let pool: Pool;
  let store: PostgresBookingStore;
  let engine: TimeSlotEngine;
  let platform: PlatformService;

  before(async () => {
    pool = createBookingPool(undefined, { max: 20 });
    await runMigrations(pool);
    store = new PostgresBookingStore(pool);
    engine = new TimeSlotEngine(store);
    platform = new PlatformService(pool, {
      masterKey: randomBytes(32),
      ssrfOptions: { allowLocalHttpForTesting: true },
    });
  });

  after(async () => {
    await pool.end();
  });

  it("restricts /v1/metrics and detailed /v1/ready, proves lease renewal past TTL, and verifies booking-to-usage crash recovery", async () => {
    const tag = randomUUID().slice(0, 8);
    const { organization } = await platform.createOrganization({
      name: `P10Sec ${tag}`,
      slug: `p10sec-${tag}`,
    });
    const proj = await platform.createProjectWithEnvironments({
      organizationId: organization.id,
      name: "P10Proj",
      slug: `p10proj-${tag}`,
    });
    const tenant = await platform.createScopedTenant({
      organizationId: organization.id,
      projectId: proj.project.id,
      environmentId: proj.testEnvironment.id,
      name: `P10Tenant ${tag}`,
    });
    const { token: apiKey } = await platform.createApiKey({
      organizationId: organization.id,
      projectId: proj.project.id,
      environmentId: proj.testEnvironment.id,
      tenantId: tenant.id,
      name: "P10 Key",
      scopes: [...ALL_PLATFORM_SCOPES],
    });

    const opsSecret = `ops_${randomBytes(16).toString("hex")}`;
    const apiServer = createPlatformHttpServer({
      pool,
      engine,
      platform,
      opsAuthToken: opsSecret,
      logRequestsToDb: false,
    });
    const apiUrl = await listenServer(apiServer);

    try {
      // 1. Operational endpoints restricted cleanly
      const unauthMetrics = await fetch(`${apiUrl}/v1/metrics`);
      assert.equal(unauthMetrics.status, 401);

      const unauthReady = await fetch(`${apiUrl}/v1/ready`);
      assert.equal(unauthReady.status, 200);
      const readyMin = (await unauthReady.json()) as Record<string, unknown>;
      assert.equal(readyMin.ready, true);
      assert.equal("pgVersion" in readyMin, false);
      assert.equal("activeConnections" in readyMin, false);

      const authMetrics = await fetch(`${apiUrl}/v1/metrics`, {
        headers: { "X-Ops-Token": opsSecret },
      });
      assert.equal(authMetrics.status, 200);
      assert.ok((await authMetrics.text()).includes("olb_pg_pool_connections"));

      const authReady = await fetch(`${apiUrl}/v1/ready`, {
        headers: { Authorization: `Bearer ${opsSecret}` },
      });
      assert.equal(authReady.status, 200);
      const readyFull = (await authReady.json()) as Record<string, unknown>;
      assert.ok(typeof readyFull.pgVersion === "string");
      assert.ok(typeof readyFull.activeConnections === "number");

      // 2. Actual distributed lease renewal keeping short TTL=1s lease alive across 1.6s long request
      const limiter = new PostgresDistributedLimiter(pool, {
        instanceId: `p10-renew-${tag}`,
        maxTenantConcurrentLeases: 1,
        leaseTtlSeconds: 1,
      });
      const lease = await limiter.acquireTenantLease(`long-req-${tag}`);
      await new Promise((r) => setTimeout(r, 650));
      assert.equal(await lease.renew(2), true);
      await new Promise((r) => setTimeout(r, 700)); // total 1.35s > initial 1s TTL!

      // Competing request MUST still be rejected because renewal extended expiry!
      await assert.rejects(
        () => limiter.acquireTenantLease(`long-req-${tag}`),
        (err: unknown) => err instanceof BookingError && err.code === "TEMPORARY_UNAVAILABLE",
      );
      await lease();

      // Now succeeds after release
      const lease2 = await limiter.acquireTenantLease(`long-req-${tag}`);
      await lease2();

      // 3. Booking-to-usage-ledger crash recovery (idempotent usage recording & zero double-charge)
      const crashIdem = `crash-rec-${tag}`;
      const uFirst = await platform.recordUsage({
        organizationId: organization.id,
        projectId: proj.project.id,
        environmentId: proj.testEnvironment.id,
        tenantId: tenant.id,
        scopeKey: `${tenant.id}:recovery`,
        metric: "booking_confirmed",
        idempotencyKey: `idem:${crashIdem}:booking_confirmed`,
      });
      const uRetryAfterCrash = await platform.recordUsage({
        organizationId: organization.id,
        projectId: proj.project.id,
        environmentId: proj.testEnvironment.id,
        tenantId: tenant.id,
        scopeKey: `${tenant.id}:recovery`,
        metric: "booking_confirmed",
        idempotencyKey: `idem:${crashIdem}:booking_confirmed`,
      });
      assert.equal(uFirst.recorded, true);
      assert.equal(uRetryAfterCrash.recorded, false);

      // Verify Bearer key works on /v1/facilities
      const facCheck = await fetch(`${apiUrl}/v1/facilities`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      assert.equal(facCheck.status, 200);
    } finally {
      await closeServer(apiServer);
    }
  });

  it("executes all 5 SDK examples (Next.js, Express, React/Chrome, Python, cURL) plus AbortSignal cancellation & retries", async () => {
    const tag = randomUUID().slice(0, 8);
    const { organization } = await platform.createOrganization({
      name: `P10Sdk ${tag}`,
      slug: `p10sdk-${tag}`,
    });
    const proj = await platform.createProjectWithEnvironments({
      organizationId: organization.id,
      name: "P10SdkProj",
      slug: `p10sdkproj-${tag}`,
    });
    const tenant = await platform.createScopedTenant({
      organizationId: organization.id,
      projectId: proj.project.id,
      environmentId: proj.testEnvironment.id,
      name: `P10SdkTenant ${tag}`,
    });
    const { token: apiKey } = await platform.createApiKey({
      organizationId: organization.id,
      projectId: proj.project.id,
      environmentId: proj.testEnvironment.id,
      tenantId: tenant.id,
      name: "P10 SDK Key",
      scopes: [...ALL_PLATFORM_SCOPES],
    });

    const facClient = engine.forTenant({
      tenantId: tenant.id,
      actor: { id: "sdk-setup", type: "admin", capabilities: ["facility:write", "schedule:write"] },
    });
    const baseDate = new Date(Date.now() + 12 * 86_400_000).toISOString().slice(0, 10);
    const fac = await facClient.createFacility({ name: "SDK Arena Bay 1", category: "pc", timeZone: "UTC" });
    await facClient.setSchedule(
      fac.id,
      [1, 2, 3, 4, 5, 6, 7].map((w) => ({
        weekday: w as 1 | 2 | 3 | 4 | 5 | 6 | 7,
        opensAt: "08:00",
        closesAt: "20:00",
        endDayOffset: 0 as const,
        effectiveFrom: baseDate,
        effectiveUntil: null,
        breaks: [],
      })),
    );
    await facClient.setSlotPolicy(fac.id, {
      durationMinutes: 60,
      intervalMinutes: 60,
      minNoticeMinutes: 0,
      maxAdvanceDays: 90,
      bufferBeforeMinutes: 0,
      bufferAfterMinutes: 0,
      maxSlotsPerBooking: 3,
      defaultHoldMinutes: 5,
      maxActiveHoldsPerCustomer: 10,
    });
    await facClient.setPricing({ facilityId: fac.id, amountMinor: 2500, currency: "USD" });

    const apiServer = createPlatformHttpServer({
      pool,
      engine,
      platform,
      logRequestsToDb: false,
    });
    const apiUrl = await listenServer(apiServer);

    const { OneLineBookingClient, OneLineBookingApiError } = (await import(
      pathToFileURL(resolve(process.cwd(), "packages/sdk/dist/esm/server.js")).href
    )) as {
      OneLineBookingClient: new (cfg: Record<string, unknown>) => {
        availability: { get: (q: Record<string, string>, opts?: Record<string, unknown>) => Promise<{ slots: Array<{ slotRef: string; available: boolean }> }> };
        holds: { create: (i: Record<string, unknown>, opts?: Record<string, unknown>) => Promise<{ id: string }> };
      };
      OneLineBookingApiError: new (...args: unknown[]) => Error & { status: number; code: string };
    };

    try {
      // A. Verify SDK AbortSignal request cancellation (aborts immediately, does not retry)
      const sdk = new OneLineBookingClient({
        baseUrl: apiUrl,
        apiKey,
        maxRetries: 3,
      });
      const abortCtrl = new AbortController();
      abortCtrl.abort(new Error("caller_cancelled_request"));
      await assert.rejects(
        () => sdk.availability.get({ facilityId: fac.id, fromDate: baseDate, toDate: baseDate }, { signal: abortCtrl.signal }),
      );

      // B. Verify non-retryable 409 OneLineBookingApiError + Next.js App Router BFF execution
      process.env.OLB_API_URL = apiUrl;
      process.env.OLB_API_KEY = apiKey;
      process.env.OLB_TENANT_ID = tenant.id;
      const nextRoute = (await import(
        pathToFileURL(resolve(process.cwd(), "examples/integrations/nextjs-app/dist/app/api/booking/route.js")).href
      )) as {
        GET: (req: Request) => Promise<Response>;
        POST: (req: Request) => Promise<Response>;
      };
      const nAvailResp = await nextRoute.GET(
        new Request(`http://localhost/api/booking?facilityId=${fac.id}&fromDate=${baseDate}&toDate=${baseDate}`),
      );
      assert.equal(nAvailResp.status, 200);
      const nAvail = (await nAvailResp.json()) as { slots: Array<{ slotRef: string; available: boolean }> };
      const openSlots = nAvail.slots.filter((s) => s.available);
      assert.ok(openSlots.length >= 6);

      const nBookResp = await nextRoute.POST(
        new Request("http://localhost/api/booking", {
          method: "POST",
          headers: { "Content-Type": "application/json", "Idempotency-Key": `next-${tag}` },
          body: JSON.stringify({ facilityId: fac.id, slotRefs: [openSlots[0]!.slotRef], customerId: "next-user" }),
        }),
      );
      assert.equal(nBookResp.status, 201);

      // Conflict via Next route returns 409 cleanly
      const nConflictResp = await nextRoute.POST(
        new Request("http://localhost/api/booking", {
          method: "POST",
          headers: { "Content-Type": "application/json", "Idempotency-Key": `next-conf-${tag}` },
          body: JSON.stringify({ facilityId: fac.id, slotRefs: [openSlots[0]!.slotRef], customerId: "next-user-2" }),
        }),
      );
      assert.equal(nConflictResp.status, 409);

      // C. Execute Express.js integration example
      const expressMod = (await import(
        pathToFileURL(resolve(process.cwd(), "examples/integrations/express-app/server.mjs")).href
      )) as { createExpressIntegrationApp: (cfg: Record<string, string>) => { listen: (p: number, h: string, cb: () => void) => Server } };
      const expApp = expressMod.createExpressIntegrationApp({ apiBaseUrl: apiUrl, apiKey, tenantId: tenant.id });
      const expSrv = await new Promise<Server>((resSrv) => {
        const s = expApp.listen(0, "127.0.0.1", () => resSrv(s));
      });
      const expUrl = `http://127.0.0.1:${(expSrv.address() as AddressInfo).port}`;
      try {
        const expBook = await fetch(`${expUrl}/api/book`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ facilityId: fac.id, slotRefs: [openSlots[1]!.slotRef], customerId: "exp-user" }),
        });
        assert.equal(expBook.status, 201);
      } finally {
        expSrv.close();
      }

      // D. Execute React <BookingWidget /> in live Headless Chrome via built widget.js + proxy
      const widgetJsPath = resolve(process.cwd(), "examples/integrations/react-widget/dist/widget.js");
      assert.ok(existsSync(widgetJsPath), "Missing built react-widget/dist/widget.js");
      const widgetJs = readFileSync(widgetJsPath, "utf8");
      const reactProxySrv = createServer(async (req, res) => {
        const u = new URL(req.url ?? "/", "http://127.0.0.1");
        if (req.method === "GET" && u.pathname === "/") {
          res.setHeader("Content-Type", "text/html; charset=utf-8");
          res.end(
            `<!doctype html><html><body><div id="root"></div><script>window.__OLB_WIDGET_CFG__=${JSON.stringify({
              proxyBaseUrl: "/proxy",
              facilityId: fac.id,
              dateIso: baseDate,
              customerId: "react-chrome-cust",
            })};</script><script type="module" src="/widget.js"></script></body></html>`,
          );
          return;
        }
        if (req.method === "GET" && u.pathname === "/widget.js") {
          res.setHeader("Content-Type", "application/javascript; charset=utf-8");
          res.end(widgetJs);
          return;
        }
        if (req.method === "GET" && u.pathname === "/proxy/availability") {
          const upstream = await fetch(`${apiUrl}/v1/availability${u.search}`, {
            headers: { Authorization: `Bearer ${apiKey}`, "X-Tenant-Id": tenant.id },
          });
          res.statusCode = upstream.status;
          res.setHeader("Content-Type", "application/json");
          res.end(await upstream.text());
          return;
        }
        if (req.method === "POST" && u.pathname === "/proxy/holds") {
          const chunks: Buffer[] = [];
          for await (const c of req) chunks.push(c as Buffer);
          const upstream = await fetch(`${apiUrl}/v1/holds`, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${apiKey}`,
              "X-Tenant-Id": tenant.id,
              "Content-Type": "application/json",
              "Idempotency-Key": String(req.headers["idempotency-key"] ?? randomUUID()),
            },
            body: Buffer.concat(chunks).toString("utf8"),
          });
          res.statusCode = upstream.status;
          res.setHeader("Content-Type", "application/json");
          res.end(await upstream.text());
          return;
        }
        const convMatch = /^\/proxy\/holds\/([^/]+)\/convert$/.exec(u.pathname);
        if (req.method === "POST" && convMatch) {
          const chunks: Buffer[] = [];
          for await (const c of req) chunks.push(c as Buffer);
          const upstream = await fetch(`${apiUrl}/v1/holds/${convMatch[1]}/convert`, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${apiKey}`,
              "X-Tenant-Id": tenant.id,
              "Content-Type": "application/json",
              "Idempotency-Key": String(req.headers["idempotency-key"] ?? randomUUID()),
            },
            body: Buffer.concat(chunks).toString("utf8") || "{}",
          });
          res.statusCode = upstream.status;
          res.setHeader("Content-Type", "application/json");
          res.end(await upstream.text());
          return;
        }
        res.statusCode = 404;
        res.end();
      });
      const reactUrl = await listenServer(reactProxySrv);
      const pwMod = (await import(
        pathToFileURL(resolve(process.cwd(), "examples/playwright-e2e/node_modules/playwright-core/index.mjs")).href
      )) as { chromium: { launch: (opts: Record<string, unknown>) => Promise<{ newContext: () => Promise<{ newPage: () => Promise<{ goto: (u: string) => Promise<void>; locator: (s: string) => { first: () => { waitFor: () => Promise<void>; click: () => Promise<void> }; waitFor: () => Promise<void> } }> }>; close: () => Promise<void> }> } };
      const browser = await pwMod.chromium.launch({
        executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
        headless: true,
      });
      try {
        const ctx = await browser.newContext();
        const page = await ctx.newPage();
        await page.goto(reactUrl);
        const firstBtn = page.locator("button").first();
        await firstBtn.waitFor();
        await firstBtn.click();
        await page.locator('p:has-text("Booking confirmed:")').waitFor();
      } finally {
        await browser.close();
        await closeServer(reactProxySrv);
      }

      // E. Execute Python 3 REST example
      const { stdout: pyOut } = await execFileAsync(
        "python",
        [resolve(process.cwd(), "examples/integrations/python-rest/client.py")],
        {
          env: {
            ...process.env,
            OLB_API_URL: apiUrl,
            OLB_API_KEY: apiKey,
            OLB_FACILITY_ID: fac.id,
            OLB_DATE: baseDate,
            OLB_TENANT_ID: tenant.id,
          },
        },
      );
      assert.equal((JSON.parse(pyOut.trim()) as { ok: boolean }).ok, true);

      // F. Execute cURL quickstart bash script
      const bashBin = existsSync("C:\\Program Files\\Git\\bin\\bash.exe")
        ? "C:\\Program Files\\Git\\bin\\bash.exe"
        : "bash";
      const { stdout: curlOut } = await execFileAsync(
        bashBin,
        ["examples/integrations/curl-quickstart/quickstart.sh"],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            OLB_API_URL: apiUrl,
            OLB_API_KEY: apiKey,
            OLB_FACILITY_ID: fac.id,
            OLB_DATE: baseDate,
            OLB_TENANT_ID: tenant.id,
          },
        },
      );
      const curlJson = JSON.parse(curlOut.trim()) as { ok: boolean; finalStatus: string };
      assert.equal(curlJson.ok, true);
      assert.equal(curlJson.finalStatus, "cancelled");

      // Confirm OneLineBookingApiError rejects invalid hold cleanly
      await assert.rejects(
        () => sdk.holds.create({ facilityId: fac.id, slotRefs: [openSlots[0]!.slotRef], externalCustomerId: "dup" }),
        (err: unknown) => err instanceof OneLineBookingApiError && err.status === 409,
      );
    } finally {
      delete process.env.OLB_API_URL;
      delete process.env.OLB_API_KEY;
      delete process.env.OLB_TENANT_ID;
      await closeServer(apiServer);
    }
  });
});
