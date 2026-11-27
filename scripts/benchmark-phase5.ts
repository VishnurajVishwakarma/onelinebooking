import "dotenv/config";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { DateTime } from "luxon";
import {
  ALL_ADMIN_CAPABILITIES,
  BookingError,
  createBookingPool,
  DEFAULT_CUSTOMER_CAPABILITIES,
  PostgresBookingStore,
  runMigrations,
  TimeSlotEngine,
  type Facility,
  type TransactionTimingMetrics,
} from "../src/index.js";

function percentile(arr: number[], p: number): number {
  if (arr.length === 0) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return Number(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!.toFixed(2));
}

async function runConcurrent<T>(items: T[], concurrency: number, fn: (item: T, idx: number) => Promise<void>): Promise<void> {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const idx = cursor++;
      if (idx >= items.length) return;
      await fn(items[idx]!, idx);
    }
  });
  await Promise.all(workers);
}

interface ScenarioMetrics {
  name: string;
  concurrency: number;
  offeredLoad: number;
  totalMs: number;
  throughputRps: number;
  succeeded: number;
  expectedConflicts: number;
  retryableFailures: number;
  unexpectedErrors: number;
  latencyMs: { p50: number; p95: number; p99: number };
  poolAcquireMs: { p50: number; p95: number };
  lockWaitMs: { p50: number; p95: number };
  txDurationMs: { p50: number; p95: number };
  maxPoolWaiting: number;
}

// Child worker mode for multi-process benchmark (#9)
if (process.argv[2] === "--worker") {
  const tenantId = process.argv[3]!;
  const facilityId = process.argv[4]!;
  const slotRefs = JSON.parse(process.argv[5]!) as string[];
  const workerPool = createBookingPool(process.env.DATABASE_URL, { max: 20 });
  const workerStore = new PostgresBookingStore(workerPool);
  const workerEngine = new TimeSlotEngine(workerStore);
  let ok = 0;
  let conflicts = 0;
  let retryable = 0;
  let unexpected = 0;
  const lats: number[] = [];
  await Promise.all(
    slotRefs.map(async (ref, idx) => {
      const c = workerEngine.forTenant({
        tenantId,
        actor: { id: `mp_${process.pid}_${idx}`, type: "customer", customerId: `mpc_${process.pid}_${idx}`, capabilities: DEFAULT_CUSTOMER_CAPABILITIES },
      });
      const t0 = performance.now();
      try {
        await c.createHold({ facilityId, slotRefs: [ref] }, { idempotencyKey: `mp-${process.pid}-${idx}-${randomUUID()}` });
        ok += 1;
      } catch (err) {
        if (err instanceof BookingError && err.retryable) retryable += 1;
        else if (err instanceof BookingError && err.category === "conflict") conflicts += 1;
        else unexpected += 1;
      } finally {
        lats.push(performance.now() - t0);
      }
    }),
  );
  await workerPool.end();
  process.stdout.write(JSON.stringify({ ok, conflicts, retryable, unexpected, lats }) + "\n");
  process.exit(0);
}

const pool = createBookingPool(process.env.DATABASE_URL, { max: 80, connectionTimeoutMillis: 10_000 });
let txMetricsBuffer: TransactionTimingMetrics[] = [];
const store = new PostgresBookingStore(pool, {
  maxPendingPoolRequests: 1000,
  onTransactionMetrics: (m) => txMetricsBuffer.push(m),
});
const engine = new TimeSlotEngine(store);

async function measureScenario(
  name: string,
  concurrency: number,
  offeredLoad: number,
  runner: (idx: number, recordOutcome: (kind: "ok" | "conflict" | "retryable" | "unexpected") => void) => Promise<void>,
): Promise<ScenarioMetrics> {
  txMetricsBuffer = [];
  const latencies: number[] = [];
  let succeeded = 0;
  let expectedConflicts = 0;
  let retryableFailures = 0;
  let unexpectedErrors = 0;
  let maxPoolWaiting = 0;

  const t0 = performance.now();
  await runConcurrent(Array.from({ length: offeredLoad }, (_, i) => i), concurrency, async (idx) => {
    if (pool.waitingCount > maxPoolWaiting) maxPoolWaiting = pool.waitingCount;
    const r0 = performance.now();
    await runner(idx, (kind) => {
      if (kind === "ok") succeeded += 1;
      else if (kind === "conflict") expectedConflicts += 1;
      else if (kind === "retryable") retryableFailures += 1;
      else unexpectedErrors += 1;
    });
    latencies.push(performance.now() - r0);
  });
  const totalMs = performance.now() - t0;

  const acq = txMetricsBuffer.map((m) => m.poolAcquireMs);
  const lock = txMetricsBuffer.map((m) => m.lockWaitMs);
  const tx = txMetricsBuffer.map((m) => m.txDurationMs);

  return {
    name,
    concurrency,
    offeredLoad,
    totalMs: Number(totalMs.toFixed(1)),
    throughputRps: Number(((offeredLoad / totalMs) * 1000).toFixed(1)),
    succeeded,
    expectedConflicts,
    retryableFailures,
    unexpectedErrors,
    latencyMs: { p50: percentile(latencies, 50), p95: percentile(latencies, 95), p99: percentile(latencies, 99) },
    poolAcquireMs: { p50: percentile(acq, 50), p95: percentile(acq, 95) },
    lockWaitMs: { p50: percentile(lock, 50), p95: percentile(lock, 95) },
    txDurationMs: { p50: percentile(tx, 50), p95: percentile(tx, 95) },
    maxPoolWaiting,
  };
}

function classifyError(err: unknown): "conflict" | "retryable" | "unexpected" {
  if (err instanceof BookingError) {
    if (err.retryable) return "retryable";
    if (err.category === "conflict" || err.code === "HOLD_LIMIT_EXCEEDED") return "conflict";
  }
  return "unexpected";
}

try {
  await runMigrations(pool);
  const rootTenant = await engine.createTenant({ name: `Phase5Bench ${randomUUID()}` });
  const admin = engine.forTenant({
    tenantId: rootTenant.id,
    actor: { id: "bench5-admin", type: "admin", capabilities: ALL_ADMIN_CAPABILITIES },
  });

  const facilities: Facility[] = [];
  for (let i = 0; i < 10; i += 1) {
    const fac = await admin.createFacility({ name: `P5 Court ${i}`, category: "turf", timeZone: "Asia/Kolkata" });
    await admin.setSchedule(
      fac.id,
      Array.from({ length: 7 }, (_, d) => ({
        weekday: d + 1,
        opensAt: "00:00",
        closesAt: "23:00",
        endDayOffset: 0 as const,
        effectiveFrom: "2026-01-01",
        effectiveUntil: null,
        breaks: [],
      })),
    );
    await admin.setSlotPolicy(fac.id, {
      durationMinutes: 60,
      intervalMinutes: 60,
      minNoticeMinutes: 0,
      maxAdvanceDays: 365,
      bufferBeforeMinutes: 0,
      bufferAfterMinutes: 0,
      maxSlotsPerBooking: 6,
      defaultHoldMinutes: 5,
      maxActiveHoldsPerCustomer: 1000,
    });
    await admin.setPricing({ facilityId: fac.id, amountMinor: 25000, currency: "INR" });
    facilities.push(fac);
  }

  const report: Record<string, unknown> = {};

  // 0. PRESERVED Original Single-Facility Hotspot Benchmark (sequential facility slice -> Facility 0 saturated first!)
  const hotStart = DateTime.now().setZone("Asia/Kolkata").plus({ days: 10 }).toISODate()!;
  const hotEnd = DateTime.now().setZone("Asia/Kolkata").plus({ days: 15 }).toISODate()!;
  const seqAvail = await admin.getAvailability({ facilityIds: facilities.map((f) => f.id), fromDate: hotStart, toDate: hotEnd });
  const seqSlots = seqAvail.slots.slice(0, 500);
  report.originalSingleFacilityHotspotPreserved = await measureScenario(
    "original_single_facility_hotspot_500",
    50,
    500,
    async (idx, rec) => {
      const s = seqSlots[idx]!;
      const c = engine.forTenant({
        tenantId: rootTenant.id,
        actor: { id: `oh_${idx}`, type: "customer", customerId: `ohc_${idx}`, capabilities: DEFAULT_CUSTOMER_CAPABILITIES },
      });
      try {
        const h = await c.createHold({ facilityId: s.facilityId, slotRefs: [s.slotRef] }, { idempotencyKey: `oh-${idx}-${randomUUID()}` });
        await c.convertHoldToBooking({ holdId: h.id }, { idempotencyKey: `ohc-${idx}-${randomUUID()}` });
        rec("ok");
      } catch (e) {
        rec(classifyError(e));
      }
    },
  );

  // 1. Same-slot contention across concurrency 1, 10, 50, 100, 200, 500
  const contResults: ScenarioMetrics[] = [];
  for (const [idx, conc] of [1, 10, 50, 100, 200, 500].entries()) {
    const day = DateTime.now().setZone("Asia/Kolkata").plus({ days: 20 + idx }).toISODate()!;
    const a = await admin.getAvailability({ facilityIds: [facilities[0]!.id], localDate: day });
    const slot = a.slots[3]!;
    const load = conc <= 50 ? 200 : conc * 2;
    contResults.push(
      await measureScenario(`same_slot_c${conc}`, conc, load, async (i, rec) => {
        const c = engine.forTenant({
          tenantId: rootTenant.id,
          actor: { id: `ss_${conc}_${i}`, type: "customer", customerId: `ssc_${conc}_${i}`, capabilities: DEFAULT_CUSTOMER_CAPABILITIES },
        });
        try {
          await c.createHold({ facilityId: slot.facilityId, slotRefs: [slot.slotRef] }, { idempotencyKey: `ss-${conc}-${i}-${randomUUID()}` });
          rec("ok");
        } catch (e) {
          rec(classifyError(e));
        }
      }),
    );
  }
  report.sameSlotContention = contResults;

  // 2. Same-facility non-overlapping slots across concurrency 1, 10, 50, 100, 200
  const sfNonOverlap: ScenarioMetrics[] = [];
  for (const [idx, conc] of [1, 10, 50, 100, 200].entries()) {
    const fDate = DateTime.now().setZone("Asia/Kolkata").plus({ days: 30 + idx * 10 }).toISODate()!;
    const tDate = DateTime.now().setZone("Asia/Kolkata").plus({ days: 39 + idx * 10 }).toISODate()!;
    const a = await admin.getAvailability({ facilityIds: [facilities[1]!.id], fromDate: fDate, toDate: tDate });
    const slots = a.slots.slice(0, 200);
    sfNonOverlap.push(
      await measureScenario(`same_facility_disjoint_c${conc}`, conc, slots.length, async (i, rec) => {
        const s = slots[i]!;
        const c = engine.forTenant({
          tenantId: rootTenant.id,
          actor: { id: `sf_${conc}_${i}`, type: "customer", customerId: `sfc_${conc}_${i}`, capabilities: DEFAULT_CUSTOMER_CAPABILITIES },
        });
        try {
          await c.createHold({ facilityId: s.facilityId, slotRefs: [s.slotRef] }, { idempotencyKey: `sf-${conc}-${i}-${randomUUID()}` });
          rec("ok");
        } catch (e) {
          rec(classifyError(e));
        }
      }),
    );
  }
  report.sameFacilityNonOverlapping = sfNonOverlap;

  // 3. Multi-facility successful bookings (10 facilities, concurrency 1, 10, 50, 100, 200)
  const mfSuccess: ScenarioMetrics[] = [];
  for (const [idx, conc] of [1, 10, 50, 100, 200].entries()) {
    const fDate = DateTime.now().setZone("Asia/Kolkata").plus({ days: 90 + idx * 3 }).toISODate()!;
    const tDate = DateTime.now().setZone("Asia/Kolkata").plus({ days: 91 + idx * 3 }).toISODate()!;
    const a = await admin.getAvailability({ facilityIds: facilities.map((f) => f.id), fromDate: fDate, toDate: tDate });
    const slots = a.slots.slice(0, 200);
    mfSuccess.push(
      await measureScenario(`multi_facility_c${conc}`, conc, slots.length, async (i, rec) => {
        const s = slots[i]!;
        const c = engine.forTenant({
          tenantId: rootTenant.id,
          actor: { id: `mf_${conc}_${i}`, type: "customer", customerId: `mfc_${conc}_${i}`, capabilities: DEFAULT_CUSTOMER_CAPABILITIES },
        });
        try {
          const h = await c.createHold({ facilityId: s.facilityId, slotRefs: [s.slotRef] }, { idempotencyKey: `mfh-${conc}-${i}-${randomUUID()}` });
          await c.convertHoldToBooking({ holdId: h.id }, { idempotencyKey: `mfc-${conc}-${i}-${randomUUID()}` });
          rec("ok");
        } catch (e) {
          rec(classifyError(e));
        }
      }),
    );
  }
  report.multiFacilityBookings = mfSuccess;

  // 4. Multi-tenant traffic (10 tenants x 200 requests @ concurrency 100)
  const tenants = await Promise.all(
    Array.from({ length: 10 }, async (_, i) => {
      const t = await engine.createTenant({ name: `MT ${i} ${randomUUID()}` });
      const ta = engine.forTenant({ tenantId: t.id, actor: { id: "a", type: "admin", capabilities: ALL_ADMIN_CAPABILITIES } });
      const f = await ta.createFacility({ name: `MT Fac ${i}`, category: "turf", timeZone: "Asia/Kolkata" });
      await ta.setSchedule(f.id, [{ weekday: 1, opensAt: "00:00", closesAt: "23:00", endDayOffset: 0, effectiveFrom: "2026-01-01", effectiveUntil: null, breaks: [] },
      { weekday: 2, opensAt: "00:00", closesAt: "23:00", endDayOffset: 0, effectiveFrom: "2026-01-01", effectiveUntil: null, breaks: [] },
      { weekday: 3, opensAt: "00:00", closesAt: "23:00", endDayOffset: 0, effectiveFrom: "2026-01-01", effectiveUntil: null, breaks: [] },
      { weekday: 4, opensAt: "00:00", closesAt: "23:00", endDayOffset: 0, effectiveFrom: "2026-01-01", effectiveUntil: null, breaks: [] },
      { weekday: 5, opensAt: "00:00", closesAt: "23:00", endDayOffset: 0, effectiveFrom: "2026-01-01", effectiveUntil: null, breaks: [] },
      { weekday: 6, opensAt: "00:00", closesAt: "23:00", endDayOffset: 0, effectiveFrom: "2026-01-01", effectiveUntil: null, breaks: [] },
      { weekday: 7, opensAt: "00:00", closesAt: "23:00", endDayOffset: 0, effectiveFrom: "2026-01-01", effectiveUntil: null, breaks: [] }]);
      await ta.setSlotPolicy(f.id, { durationMinutes: 60, intervalMinutes: 60, minNoticeMinutes: 0, maxAdvanceDays: 365, bufferBeforeMinutes: 0, bufferAfterMinutes: 0, maxSlotsPerBooking: 6, defaultHoldMinutes: 5, maxActiveHoldsPerCustomer: 100 });
      await ta.setPricing({ facilityId: f.id, amountMinor: 10000, currency: "INR" });
      const av = await ta.getAvailability({ facilityIds: [f.id], fromDate: "2027-05-01", toDate: "2027-05-03" });
      return { tenantId: t.id, facilityId: f.id, slots: av.slots };
    }),
  );
  report.multiTenantTraffic = await measureScenario("multi_tenant_c100", 100, 200, async (i, rec) => {
    const t = tenants[i % tenants.length]!;
    const s = t.slots[Math.floor(i / tenants.length)]!;
    const c = engine.forTenant({
      tenantId: t.tenantId,
      actor: { id: `mt_${i}`, type: "customer", customerId: `mtc_${i}`, capabilities: DEFAULT_CUSTOMER_CAPABILITIES },
    });
    try {
      await c.createHold({ facilityId: t.facilityId, slotRefs: [s.slotRef] }, { idempotencyKey: `mt-${i}-${randomUUID()}` });
      rec("ok");
    } catch (e) {
      rec(classifyError(e));
    }
  });

  // 5. Read-heavy workloads (concurrency 10, 50, 100, 200)
  const readDate = DateTime.now().setZone("Asia/Kolkata").plus({ days: 120 }).toISODate()!;
  const readResults: ScenarioMetrics[] = [];
  for (const conc of [10, 50, 100, 200]) {
    readResults.push(
      await measureScenario(`read_heavy_c${conc}`, conc, 300, async (i, rec) => {
        try {
          await admin.getAvailability({ facilityIds: [facilities[i % facilities.length]!.id], localDate: readDate });
          rec("ok");
        } catch (e) {
          rec(classifyError(e));
        }
      }),
    );
  }
  report.readHeavy = readResults;

  // 6. Write-heavy workloads (direct createBooking across 10 facilities @ concurrency 10, 50, 100)
  const writeResults: ScenarioMetrics[] = [];
  for (const [idx, conc] of [10, 50, 100].entries()) {
    const wDate = DateTime.now().setZone("Asia/Kolkata").plus({ days: 130 + idx * 3 }).toISODate()!;
    const wEnd = DateTime.now().setZone("Asia/Kolkata").plus({ days: 131 + idx * 3 }).toISODate()!;
    const av = await admin.getAvailability({ facilityIds: facilities.map((f) => f.id), fromDate: wDate, toDate: wEnd });
    const slots = av.slots.slice(0, 200);
    writeResults.push(
      await measureScenario(`write_heavy_c${conc}`, conc, slots.length, async (i, rec) => {
        const s = slots[i]!;
        try {
          await admin.createBooking({ facilityId: s.facilityId, slotRefs: [s.slotRef], externalCustomerId: `wh_${i}` }, { idempotencyKey: `wh-${conc}-${i}-${randomUUID()}` });
          rec("ok");
        } catch (e) {
          rec(classifyError(e));
        }
      }),
    );
  }
  report.writeHeavy = writeResults;

  // 7. Mixed lifecycle operations (availability + createHold + convert/release + cancel + expireHolds)
  const mixStart = DateTime.now().setZone("Asia/Kolkata").plus({ days: 150 }).toISODate()!;
  const mixEnd = DateTime.now().setZone("Asia/Kolkata").plus({ days: 155 }).toISODate()!;
  const mixAvail = await admin.getAvailability({ facilityIds: facilities.map((f) => f.id), fromDate: mixStart, toDate: mixEnd });
  report.mixedLifecycle = await measureScenario("mixed_lifecycle_c50", 50, 200, async (i, rec) => {
    const s = mixAvail.slots[i]!;
    try {
      if (i % 4 === 0) {
        await admin.getAvailability({ facilityIds: [s.facilityId], localDate: mixStart });
        rec("ok");
      } else if (i % 4 === 1) {
        const h = await admin.createHold({ facilityId: s.facilityId, slotRefs: [s.slotRef], externalCustomerId: `mx_${i}` }, { idempotencyKey: `mxh-${i}-${randomUUID()}` });
        await admin.releaseHold(h.id);
        rec("ok");
      } else if (i % 4 === 2) {
        const b = await admin.createBooking({ facilityId: s.facilityId, slotRefs: [s.slotRef], externalCustomerId: `mxb_${i}` }, { idempotencyKey: `mxb-${i}-${randomUUID()}` });
        await admin.cancelBooking({ bookingId: b.id, reason: "mixed bench" });
        rec("ok");
      } else {
        await engine.expireHolds(20);
        rec("ok");
      }
    } catch (e) {
      rec(classifyError(e));
    }
  });

  // 8. Configuration mutation races (concurrent setPricing + createHold + getAvailability)
  const cfgDate = DateTime.now().setZone("Asia/Kolkata").plus({ days: 165 }).toISODate()!;
  const cfgFac = facilities[8]!;
  const cfgAvail = await admin.getAvailability({ facilityIds: [cfgFac.id], localDate: cfgDate });
  report.configurationMutationRace = await measureScenario("config_mutation_race_c50", 50, 150, async (i, rec) => {
    try {
      if (i % 10 === 0) {
        await admin.setPricing({ facilityId: cfgFac.id, amountMinor: 25000 + (i % 3) * 1000, currency: "INR" });
        rec("ok");
      } else if (i % 5 === 0) {
        await admin.getAvailability({ facilityIds: [cfgFac.id], localDate: cfgDate });
        rec("ok");
      } else {
        const latest = await admin.getAvailability({ facilityIds: [cfgFac.id], localDate: cfgDate });
        const slot = latest.slots[i % cfgAvail.slots.length]!;
        await admin.createHold({ facilityId: cfgFac.id, slotRefs: [slot.slotRef], externalCustomerId: `cm_${i}` }, { idempotencyKey: `cm-${i}-${randomUUID()}` });
        rec("ok");
      }
    } catch (e) {
      rec(classifyError(e));
    }
  });

  // 9. Multiple independent API OS processes (4 separate Node child processes racing on same slot)
  const mpDate = DateTime.now().setZone("Asia/Kolkata").plus({ days: 175 }).toISODate()!;
  const mpFac = facilities[9]!;
  const mpAvail = await admin.getAvailability({ facilityIds: [mpFac.id], localDate: mpDate });
  const mpSlot = mpAvail.slots[4]!;
  const mpT0 = performance.now();
  const childOutputs = await Promise.all(
    Array.from({ length: 4 }, () =>
      new Promise<{ ok: number; conflicts: number; retryable: number; unexpected: number; lats: number[] }>((resolve, reject) => {
        const refs = Array.from({ length: 25 }, () => mpSlot.slotRef);
        const child = spawn(process.execPath, ["dist/scripts/benchmark-phase5.js", "--worker", rootTenant.id, mpFac.id, JSON.stringify(refs)], {
          stdio: ["ignore", "pipe", "pipe"],
        });
        let out = "";
        let errOut = "";
        child.stdout.on("data", (d) => { out += String(d); });
        child.stderr.on("data", (d) => { errOut += String(d); });
        child.on("close", (code) => {
          if (code !== 0) return reject(new Error(`Worker exited ${code}: ${errOut}`));
          resolve(JSON.parse(out.trim()));
        });
      }),
    ),
  );
  const mpTotalMs = performance.now() - mpT0;
  const mpAllLats = childOutputs.flatMap((c) => c.lats);
  const mpOk = childOutputs.reduce((s, c) => s + c.ok, 0);
  const mpConf = childOutputs.reduce((s, c) => s + c.conflicts, 0);
  const mpRet = childOutputs.reduce((s, c) => s + c.retryable, 0);
  const mpUnexp = childOutputs.reduce((s, c) => s + c.unexpected, 0);
  assert.equal(mpOk, 1, "Multiple OS processes must yield strictly 1 winner on same slot");
  report.multipleApiProcesses = {
    processes: 4,
    totalRequests: 100,
    totalMs: Number(mpTotalMs.toFixed(1)),
    throughputRps: Number(((100 / mpTotalMs) * 1000).toFixed(1)),
    succeeded: mpOk,
    expectedConflicts: mpConf,
    retryableFailures: mpRet,
    unexpectedErrors: mpUnexp,
    latencyMs: { p50: percentile(mpAllLats, 50), p95: percentile(mpAllLats, 95), p99: percentile(mpAllLats, 99) },
  };

  // 10. Sustained traffic (10 seconds continuous load across 10 facilities @ concurrency 30)
  const susStartDate = DateTime.now().setZone("Asia/Kolkata").plus({ days: 185 }).toISODate()!;
  const susEndDate = DateTime.now().setZone("Asia/Kolkata").plus({ days: 205 }).toISODate()!;
  const susAvail = await admin.getAvailability({ facilityIds: facilities.slice(0, 8).map((f) => f.id), fromDate: susStartDate, toDate: susEndDate });
  const susSlots = susAvail.slots;
  let susCursor = 0;
  let susOk = 0;
  let susConf = 0;
  let susRet = 0;
  let susUnexp = 0;
  const susLats: number[] = [];
  const susEndAt = Date.now() + 10_000;
  const susMemBefore = process.memoryUsage().heapUsed;
  const susT0 = performance.now();
  await Promise.all(
    Array.from({ length: 30 }, async () => {
      while (Date.now() < susEndAt) {
        const idx = susCursor++;
        const s = susSlots[idx % susSlots.length]!;
        const r0 = performance.now();
        try {
          if (idx % 3 === 0) {
            await admin.getAvailability({ facilityIds: [s.facilityId], localDate: susStartDate });
          } else {
            await admin.createHold({ facilityId: s.facilityId, slotRefs: [s.slotRef], externalCustomerId: `sus_${idx}` }, { idempotencyKey: `sus-${idx}-${randomUUID()}` });
          }
          susOk += 1;
        } catch (e) {
          const k = classifyError(e);
          if (k === "conflict") susConf += 1;
          else if (k === "retryable") susRet += 1;
          else susUnexp += 1;
        } finally {
          susLats.push(performance.now() - r0);
        }
      }
    }),
  );
  const susTotalMs = performance.now() - susT0;
  const susMemAfter = process.memoryUsage().heapUsed;
  report.sustainedTraffic10s = {
    durationMs: Number(susTotalMs.toFixed(1)),
    concurrency: 30,
    totalOperations: susOk + susConf + susRet + susUnexp,
    throughputRps: Number((((susOk + susConf + susRet + susUnexp) / susTotalMs) * 1000).toFixed(1)),
    succeeded: susOk,
    expectedConflicts: susConf,
    retryableFailures: susRet,
    unexpectedErrors: susUnexp,
    latencyMs: { p50: percentile(susLats, 50), p95: percentile(susLats, 95), p99: percentile(susLats, 99) },
    heapDeltaMb: Number(((susMemAfter - susMemBefore) / (1024 * 1024)).toFixed(2)),
  };

  // Final DB integrity check across all benchmark tenants
  const [overlaps, orphanHolds, orphanBookings] = await Promise.all([
    pool.query<{ cnt: string }>(
      `SELECT COUNT(*)::text AS cnt FROM allocations a
       JOIN allocations b ON a.tenant_id = b.tenant_id AND a.facility_id = b.facility_id AND a.id < b.id
        AND a.status IN ('held','reserved') AND b.status IN ('held','reserved') AND a.occupied_range && b.occupied_range`,
    ),
    pool.query<{ cnt: string }>(
      `SELECT COUNT(*)::text AS cnt FROM holds h
       WHERE h.state = 'active' AND NOT EXISTS (SELECT 1 FROM allocations a WHERE a.hold_id = h.id AND a.status = 'held')`,
    ),
    pool.query<{ cnt: string }>(
      `SELECT COUNT(*)::text AS cnt FROM bookings b
       WHERE b.status = 'confirmed' AND NOT EXISTS (SELECT 1 FROM allocations a WHERE a.booking_id = b.id AND a.status = 'reserved')`,
    ),
  ]);
  report.integrity = {
    overlappingAllocations: Number(overlaps.rows[0]!.cnt),
    orphanActiveHolds: Number(orphanHolds.rows[0]!.cnt),
    orphanConfirmedBookings: Number(orphanBookings.rows[0]!.cnt),
  };
  assert.equal(Number(overlaps.rows[0]!.cnt), 0);
  assert.equal(Number(orphanHolds.rows[0]!.cnt), 0);
  assert.equal(Number(orphanBookings.rows[0]!.cnt), 0);

  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
} finally {
  await pool.end();
}
