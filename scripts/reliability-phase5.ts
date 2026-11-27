import "dotenv/config";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { DateTime } from "luxon";
import {
  ALL_ADMIN_CAPABILITIES,
  BookingError,
  createBookingPool,
  PostgresBookingStore,
  runMigrations,
  TimeSlotEngine,
} from "../src/index.js";

const execFileAsync = promisify(execFile);

// Child worker for SIGKILL mid-transaction test
if (process.argv[2] === "--sigkill-worker") {
  const facilityId = process.argv[3]!;
  const tenantId = process.argv[4]!;
  const pool = createBookingPool(process.env.DATABASE_URL, { max: 2 });
  const client = await pool.connect();
  await client.query("BEGIN");
  await client.query("SELECT * FROM facilities WHERE tenant_id = $1 AND id = $2 FOR UPDATE", [tenantId, facilityId]);
  await client.query(
    `INSERT INTO holds (
       tenant_id, facility_id, state, expires_at, facility_time_zone, configuration_revision,
       pricing_revision, cancellation_policy_snapshot, total_minor, currency, quote_created_at,
       starts_at, ends_at, occupied_from, occupied_until
     ) VALUES ($1,$2,'active',now() + interval '5 minutes','Asia/Kolkata',1,1,'{}'::jsonb,100,'INR',now(),
       now() + interval '1 day', now() + interval '1 day 1 hour', now() + interval '1 day', now() + interval '1 day 1 hour')`,
    [tenantId, facilityId],
  );
  process.stdout.write("LOCK_HELD\n");
  await new Promise((r) => setTimeout(r, 30_000));
}

async function runDocker(args: string[], input?: string): Promise<string> {
  if (input !== undefined) {
    return new Promise((resolvePromise, reject) => {
      const child = spawn("docker", args, { stdio: ["pipe", "pipe", "pipe"] });
      let out = "";
      let err = "";
      child.stdout.on("data", (d) => { out += String(d); });
      child.stderr.on("data", (d) => { err += String(d); });
      child.on("close", (code) => {
        if (code !== 0) reject(new Error(`docker ${args.join(" ")} failed (${code}): ${err}`));
        else resolvePromise(out);
      });
      child.stdin.write(input);
      child.stdin.end();
    });
  }
  const { stdout } = await execFileAsync("docker", args);
  return stdout;
}

const results: Record<string, unknown> = {};
const pool = createBookingPool(process.env.DATABASE_URL, { max: 15 });
pool.on("error", () => {});

try {
  await runMigrations(pool);
  const store = new PostgresBookingStore(pool);
  const engine = new TimeSlotEngine(store);

  const tenant = await engine.createTenant({ name: `Phase5E Ops ${randomUUID()}` });
  const admin = engine.forTenant({
    tenantId: tenant.id,
    actor: { id: "ops-admin", type: "admin", capabilities: ALL_ADMIN_CAPABILITIES },
  });
  const fac = await admin.createFacility({ name: "Ops Court", category: "turf", timeZone: "Asia/Kolkata" });
  const effectiveFrom = DateTime.now().setZone("Asia/Kolkata").toISODate()!;
  await admin.setSchedule(
    fac.id,
    Array.from({ length: 7 }, (_, i) => ({
      weekday: i + 1,
      opensAt: "06:00",
      closesAt: "23:00",
      endDayOffset: 0 as const,
      effectiveFrom,
      effectiveUntil: null,
      breaks: [],
    })),
  );
  await admin.setSlotPolicy(fac.id, {
    durationMinutes: 60,
    intervalMinutes: 60,
    minNoticeMinutes: 0,
    maxAdvanceDays: 30,
    bufferBeforeMinutes: 0,
    bufferAfterMinutes: 0,
    maxSlotsPerBooking: 6,
    defaultHoldMinutes: 5,
    maxActiveHoldsPerCustomer: 10,
  });
  await admin.setPricing({ facilityId: fac.id, amountMinor: 15000, currency: "INR" });
  const day = DateTime.now().setZone("Asia/Kolkata").plus({ days: 2 }).toISODate()!;
  const avail = await admin.getAvailability({ facilityIds: [fac.id], localDate: day });

  // 1. SIGKILL process termination mid-transaction
  const beforeCountRes = await pool.query<{ cnt: string }>("SELECT COUNT(*)::text AS cnt FROM holds WHERE facility_id = $1", [fac.id]);
  const beforeHolds = Number(beforeCountRes.rows[0]!.cnt);

  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(process.execPath, ["dist/scripts/reliability-phase5.js", "--sigkill-worker", fac.id, tenant.id], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (d) => {
      if (String(d).includes("LOCK_HELD")) {
        child.kill("SIGKILL");
      }
    });
    child.on("close", () => resolvePromise());
    child.on("error", reject);
  });

  // PostgreSQL aborts the dead process's tx, releases FOR UPDATE lock, and accepts new bookings immediately
  const postKillHold = await admin.createHold(
    { facilityId: fac.id, slotRefs: [avail.slots[0]!.slotRef], externalCustomerId: "after_kill" },
    { idempotencyKey: `after-kill-${randomUUID()}` },
  );
  const afterCountRes = await pool.query<{ cnt: string }>("SELECT COUNT(*)::text AS cnt FROM holds WHERE facility_id = $1", [fac.id]);
  assert.equal(Number(afterCountRes.rows[0]!.cnt), beforeHolds + 1);
  results.sigkillMidTx = { passed: true, uncommittedRolledBack: true, postKillHoldId: postKillHold.id };

  // 2. Actual PostgreSQL restart & recovery + ambiguous retry
  const preRestartKey = `pre-restart-${randomUUID()}`;
  const preBooking = await admin.createBooking(
    { facilityId: fac.id, slotRefs: [avail.slots[1]!.slotRef], externalCustomerId: "pre_rest" },
    { idempotencyKey: preRestartKey },
  );

  // Fire restart while attempting requests during downtime window
  const restartPromise = execFileAsync("docker", ["compose", "restart", "postgres"]);
  let sawRetryableDuringRestart = false;
  for (let i = 0; i < 6; i += 1) {
    try {
      await admin.getAvailability({ facilityIds: [fac.id], localDate: day });
    } catch (e) {
      if (e instanceof BookingError && e.retryable) sawRetryableDuringRestart = true;
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  await restartPromise;

  // Wait for pg_isready
  for (let i = 0; i < 30; i += 1) {
    try {
      await runDocker(["exec", "mygamingslot-postgres-1", "pg_isready", "-U", "postgres", "-d", "mygamingslot"]);
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  // Verify pre-restart booking survives + idempotent replay returns same booking + new booking succeeds
  const postRestartReplay = await admin.createBooking(
    { facilityId: fac.id, slotRefs: [avail.slots[1]!.slotRef], externalCustomerId: "pre_rest" },
    { idempotencyKey: preRestartKey },
  );
  assert.equal(postRestartReplay.id, preBooking.id);
  const postRestartNew = await admin.createHold(
    { facilityId: fac.id, slotRefs: [avail.slots[2]!.slotRef], externalCustomerId: "post_rest" },
    { idempotencyKey: `post-rest-${randomUUID()}` },
  );
  results.postgresRestartRecovery = {
    passed: true,
    sawRetryableDuringRestart,
    preBookingPreservedId: postRestartReplay.id,
    postRestartNewHoldId: postRestartNew.id,
  };

  // 3. Migration upgrade against a POPULATED 0001_initial database
  const migDb = `mygamingslot_mig_${Date.now()}`;
  const restoreDb = `mygamingslot_rest_${Date.now()}`;
  const baseUrl = process.env.DATABASE_URL!;
  const migUrl = baseUrl.replace(/\/[^/]+$/, `/${migDb}`);
  const restoreUrl = baseUrl.replace(/\/[^/]+$/, `/${restoreDb}`);

  await runDocker(["exec", "mygamingslot-postgres-1", "psql", "-U", "postgres", "-d", "postgres", "-c", `CREATE DATABASE ${migDb}`]);
  await runDocker(["exec", "mygamingslot-postgres-1", "psql", "-U", "postgres", "-d", "postgres", "-c", `CREATE DATABASE ${restoreDb}`]);

  const migPool = createBookingPool(migUrl, { max: 5 });
  const restorePool = createBookingPool(restoreUrl, { max: 5 });
  try {
    const sql0001 = await readFile(resolve(process.cwd(), "src/infrastructure/postgres/migrations/0001_initial.sql"), "utf8");
    await migPool.query(`CREATE TABLE IF NOT EXISTS booking_engine_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
    await migPool.query(sql0001);
    await migPool.query(`INSERT INTO booking_engine_migrations(name) VALUES ('0001_initial')`);

    // Seed populated M1 rows across pending, confirmed, cancelled, and expired statuses
    const tRes = await migPool.query<{ id: string }>(`INSERT INTO tenants(name) VALUES ('M1 Legacy Tenant') RETURNING id`);
    const tId = tRes.rows[0]!.id;
    const fRes = await migPool.query<{ id: string }>(
      `INSERT INTO facilities(tenant_id, name, category, time_zone) VALUES ($1,'Legacy Court','turf','Asia/Kolkata') RETURNING id`,
      [tId],
    );
    const fId = fRes.rows[0]!.id;
    await migPool.query(
      `INSERT INTO slot_policies(tenant_id, facility_id, duration_minutes, interval_minutes, price_minor, currency) VALUES ($1,$2,60,60,12000,'INR')`,
      [tId, fId],
    );
    await migPool.query(
      `INSERT INTO facility_schedules(tenant_id, facility_id, weekday, opens_at, closes_at, effective_from) VALUES ($1,$2,1,'09:00','18:00','2026-01-01')`,
      [tId, fId],
    );
    for (const [idx, status] of (["pending", "confirmed", "cancelled", "expired"] as const).entries()) {
      const start = new Date(Date.now() + (idx + 5) * 86_400_000);
      const end = new Date(start.getTime() + 3_600_000);
      const bRes = await migPool.query<{ id: string }>(
        `INSERT INTO bookings(tenant_id, facility_id, status, starts_at, ends_at, total_minor, currency)
         VALUES ($1,$2,$3,$4,$5,12000,'INR') RETURNING id`,
        [tId, fId, status, start, end],
      );
      const bId = bRes.rows[0]!.id;
      const holdState = status === "pending" ? "active" : status === "confirmed" ? "converted" : status === "cancelled" ? "released" : "expired";
      await migPool.query(
        `INSERT INTO booking_holds(tenant_id, booking_id, state, expires_at) VALUES ($1,$2,$3,now() + interval '5 minutes')`,
        [tId, bId, holdState],
      );
      const allocStatus = status === "pending" ? "held" : status;
      await migPool.query(
        `INSERT INTO booking_allocations(tenant_id, facility_id, booking_id, starts_at, ends_at, reserved_from, reserved_until, status, expires_at)
         VALUES ($1,$2,$3,$4,$5,$4,$5,$6,$7)`,
        [tId, fId, bId, start, end, allocStatus, allocStatus === "held" ? new Date(Date.now() + 300_000) : null],
      );
      await migPool.query(
        `INSERT INTO booking_items(tenant_id, booking_id, starts_at, ends_at, price_minor, currency) VALUES ($1,$2,$3,$4,12000,'INR')`,
        [tId, bId, start, end],
      );
    }

    // Apply 0002_v1_schema through 0005_phase7_security_and_ops on top of populated M1 DB
    const applied = await runMigrations(migPool);
    assert.deepEqual(applied, [
      "0002_v1_schema",
      "0003_v1_performance_indexes",
      "0004_platform_schema",
      "0005_phase7_security_and_ops",
    ]);

    const v1Holds = await migPool.query<{ cnt: string }>("SELECT COUNT(*)::text AS cnt FROM holds WHERE tenant_id = $1", [tId]);
    const v1Bookings = await migPool.query<{ cnt: string }>("SELECT COUNT(*)::text AS cnt FROM bookings WHERE tenant_id = $1", [tId]);
    const v1Allocs = await migPool.query<{ cnt: string }>("SELECT COUNT(*)::text AS cnt FROM allocations WHERE tenant_id = $1", [tId]);
    const v1Pricing = await migPool.query<{ amount_minor: string }>("SELECT amount_minor FROM pricing_rules WHERE tenant_id = $1 AND active = true", [tId]);
    assert.equal(Number(v1Holds.rows[0]!.cnt), 4);
    assert.equal(Number(v1Bookings.rows[0]!.cnt), 2); // confirmed + cancelled preserved in bookings; pending + expired migrated to holds!
    assert.equal(Number(v1Allocs.rows[0]!.cnt), 2); // confirmed + cancelled allocations migrated
    assert.equal(Number(v1Pricing.rows[0]!.amount_minor), 12000);

    results.populatedMigrationUpgrade = {
      passed: true,
      applied,
      migratedHolds: Number(v1Holds.rows[0]!.cnt),
      migratedBookings: Number(v1Bookings.rows[0]!.cnt),
      backfilledPriceMinor: Number(v1Pricing.rows[0]!.amount_minor),
    };

    // 4. Backup & Restore verification (pg_dump -> psql restore)
    const dumpSql = await runDocker(["exec", "mygamingslot-postgres-1", "pg_dump", "-U", "postgres", "--no-owner", "--no-privileges", migDb]);
    await runDocker(["exec", "-i", "mygamingslot-postgres-1", "psql", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", restoreDb], dumpSql);

    const restBookings = await restorePool.query<{ cnt: string }>("SELECT COUNT(*)::text AS cnt FROM bookings WHERE tenant_id = $1", [tId]);
    assert.equal(Number(restBookings.rows[0]!.cnt), 2);

    // Live V1 mutation on restored DB works and enforces constraints
    const restEngine = new TimeSlotEngine(new PostgresBookingStore(restorePool));
    const restAdmin = restEngine.forTenant({
      tenantId: tId,
      actor: { id: "rest-admin", type: "admin", capabilities: ALL_ADMIN_CAPABILITIES },
    });
    const nextMonday = DateTime.now().setZone("Asia/Kolkata").plus({ weeks: 2 }).startOf("week").toISODate()!;
    const restAvail = await restAdmin.getAvailability({ facilityIds: [fId], localDate: nextMonday });
    const restHold = await restAdmin.createHold(
      { facilityId: fId, slotRefs: [restAvail.slots[0]!.slotRef], externalCustomerId: "rest_c" },
      { idempotencyKey: `rest-${randomUUID()}` },
    );
    const restBooked = await restAdmin.convertHoldToBooking({ holdId: restHold.id }, { idempotencyKey: `rest-conv-${randomUUID()}` });
    assert.equal(restBooked.status, "confirmed");
    results.backupAndRestore = { passed: true, restoredBookingsInitial: 2, liveBookingAfterRestoreId: restBooked.id };
  } finally {
    await migPool.end();
    await restorePool.end();
    await runDocker(["exec", "mygamingslot-postgres-1", "psql", "-U", "postgres", "-d", "postgres", "-c", `DROP DATABASE IF EXISTS ${migDb}`]).catch(() => {});
    await runDocker(["exec", "mygamingslot-postgres-1", "psql", "-U", "postgres", "-d", "postgres", "-c", `DROP DATABASE IF EXISTS ${restoreDb}`]).catch(() => {});
  }

  process.stdout.write(JSON.stringify(results, null, 2) + "\n");
} finally {
  await pool.end();
}

