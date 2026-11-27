import "dotenv/config";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PerformanceObserver, performance } from "node:perf_hooks";
import v8 from "node:v8";
import {
  ALL_ADMIN_CAPABILITIES,
  BookingError,
  HoldExpiryWorker,
  PostgresBookingStore,
  TimeSlotEngine,
  createBookingPool,
  runMigrations,
} from "../src/index.js";

interface SampleSnapshot {
  stage: string;
  elapsedSec: number;
  opsCompleted: number;
  rssMb: number;
  heapTotalMb: number;
  heapUsedMb: number;
  externalMb: number;
  arrayBuffersMb: number;
  v8UsedHeapMb: number;
  v8HeapLimitMb: number;
  v8MallocedMb: number;
  spacesMb: Record<string, number>;
  activeHandles: number;
  handleTypes: Record<string, number>;
  poolTotal: number;
  poolIdle: number;
  poolWaiting: number;
  poolErrorListeners: number;
  gcCountSinceLast: number;
  gcDurationMsSinceLast: number;
  gcKinds: Record<string, number>;
  pendingOutboxEvents: number;
  allocationsRows: number;
  holdsRows: number;
  bookingsRows: number;
  dbSizeMb: number;
}

interface ParsedSnapshotSummary {
  totalNodes: number;
  totalSelfSizeBytes: number;
  topConstructorsByCount: Array<{ name: string; count: number; selfSizeKb: number }>;
  topConstructorsBySize: Array<{ name: string; count: number; selfSizeKb: number }>;
}

function summarizeHeapSnapshot(filePath: string): ParsedSnapshotSummary {
  const raw = JSON.parse(readFileSync(filePath, "utf8")) as {
    snapshot: {
      meta: {
        node_fields: string[];
        node_types: (string | string[])[];
      };
      node_count: number;
    };
    nodes: number[];
    strings: string[];
  };

  const fields = raw.snapshot.meta.node_fields;
  const stride = fields.length;
  const typeIdx = fields.indexOf("type");
  const nameIdx = fields.indexOf("name");
  const sizeIdx = fields.indexOf("self_size");
  const nodeTypes = (raw.snapshot.meta.node_types[typeIdx] ?? []) as string[];

  const byCtor = new Map<string, { count: number; selfSizeBytes: number }>();
  let totalSelfSizeBytes = 0;

  for (let i = 0; i < raw.nodes.length; i += stride) {
    const typeId = raw.nodes[i + typeIdx]!;
    const nameStrIdx = raw.nodes[i + nameIdx]!;
    const selfSize = raw.nodes[i + sizeIdx]!;
    totalSelfSizeBytes += selfSize;

    const typeName = nodeTypes[typeId] ?? "unknown";
    const rawName = raw.strings[nameStrIdx] ?? "(anon)";
    const label = `${typeName}:${rawName.slice(0, 48)}`;
    const prev = byCtor.get(label) ?? { count: 0, selfSizeBytes: 0 };
    prev.count += 1;
    prev.selfSizeBytes += selfSize;
    byCtor.set(label, prev);
  }

  const entries = [...byCtor.entries()].map(([name, val]) => ({
    name,
    count: val.count,
    selfSizeKb: Math.round((val.selfSizeBytes / 1024) * 10) / 10,
  }));

  return {
    totalNodes: raw.snapshot.node_count,
    totalSelfSizeBytes,
    topConstructorsByCount: [...entries].sort((a, b) => b.count - a.count).slice(0, 12),
    topConstructorsBySize: [...entries].sort((a, b) => b.selfSizeKb - a.selfSizeKb).slice(0, 12),
  };
}

function linearSlopeKbPerMin(points: Array<{ tSec: number; mb: number }>): number {
  if (points.length < 2) return 0;
  const n = points.length;
  const meanX = points.reduce((s, p) => s + p.tSec / 60, 0) / n;
  const meanY = points.reduce((s, p) => s + p.mb * 1024, 0) / n;
  let num = 0;
  let den = 0;
  for (const p of points) {
    const dx = p.tSec / 60 - meanX;
    const dy = p.mb * 1024 - meanY;
    num += dx * dy;
    den += dx * dx;
  }
  return den === 0 ? 0 : Math.round((num / den) * 100) / 100;
}

async function main(): Promise<void> {
  const warmupSec = 15;
  const sustainedSec = 45;
  const concurrency = 16;
  const snapDir = mkdtempSync(join(tmpdir(), "olb-mem-inv-"));

  let gcCount = 0;
  let gcMs = 0;
  const gcKindCounts: Record<string, number> = {};
  const gcKindNames: Record<number, string> = {
    1: "Scavenge",
    2: "MarkSweepCompact",
    4: "IncrementalMarking",
    8: "WeakPhantom",
    15: "All",
  };

  const gcObserver = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      gcCount += 1;
      gcMs += entry.duration;
      const detail = (entry as unknown as { detail?: { kind?: number } }).detail;
      const kindName = gcKindNames[detail?.kind ?? -1] ?? `kind_${detail?.kind ?? "unknown"}`;
      gcKindCounts[kindName] = (gcKindCounts[kindName] ?? 0) + 1;
    }
  });
  gcObserver.observe({ entryTypes: ["gc"] });

  const pool = createBookingPool(undefined, { max: 24 });
  await runMigrations(pool);
  const store = new PostgresBookingStore(pool, {
    lockTimeoutMs: 1_500,
    statementTimeoutMs: 5_000,
    maxPendingPoolRequests: 120,
  });
  const engine = new TimeSlotEngine(store);

  const tenant = await engine.createTenant({ name: `mem-inv-${randomUUID().slice(0, 8)}` });
  const client = engine.forTenant({
    tenantId: tenant.id,
    actor: { id: "mem-investigator", type: "admin", capabilities: ALL_ADMIN_CAPABILITIES },
  });

  const baseDate = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
  const facilityIds: string[] = [];
  const allSlotRefs: Array<{ facilityId: string; slotRef: string }> = [];

  for (let f = 0; f < 5; f++) {
    const fac = await client.createFacility({
      name: `Mem Bay ${f}`,
      category: "pc",
      timeZone: "UTC",
    });
    facilityIds.push(fac.id);
    await client.setSchedule(
      fac.id,
      [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
        weekday,
        opensAt: "00:00",
        closesAt: "23:59",
        endDayOffset: 0 as const,
        effectiveFrom: baseDate,
        effectiveUntil: null,
        breaks: [],
      })),
    );
    await client.setSlotPolicy(fac.id, {
      durationMinutes: 60,
      intervalMinutes: 60,
      minNoticeMinutes: 0,
      maxAdvanceDays: 365,
      bufferBeforeMinutes: 0,
      bufferAfterMinutes: 0,
      maxSlotsPerBooking: 4,
      defaultHoldMinutes: 5,
      maxActiveHoldsPerCustomer: 50,
    });
    await client.setPricing({ facilityId: fac.id, amountMinor: 1000, currency: "USD" });

    const avail = await client.getAvailability({
      facilityIds: [fac.id],
      fromDate: baseDate,
      toDate: new Date(new Date(`${baseDate}T00:00:00Z`).getTime() + 29 * 86_400_000).toISOString().slice(0, 10),
    });
    for (const s of avail.slots) {
      allSlotRefs.push({ facilityId: fac.id, slotRef: s.slotRef });
    }
  }

  const expiryWorker = new HoldExpiryWorker({ engine, intervalMs: 2_000, batchLimit: 100 });
  expiryWorker.start();

  const startedAt = performance.now();
  let opsCompleted = 0;
  let lastGcCount = 0;
  let lastGcMs = 0;

  async function takeSample(stage: string, forceGc = false): Promise<SampleSnapshot> {
    if (forceGc && typeof global.gc === "function") {
      global.gc();
      await new Promise((r) => setTimeout(r, 50));
      global.gc();
    }
    const mem = process.memoryUsage();
    const hStats = v8.getHeapStatistics();
    const spacesMb: Record<string, number> = {};
    for (const sp of v8.getHeapSpaceStatistics()) {
      spacesMb[sp.space_name] = Math.round((sp.space_used_size / (1024 * 1024)) * 100) / 100;
    }

    const procInternals = process as unknown as {
      _getActiveHandles?: () => unknown[];
    };
    const handles = procInternals._getActiveHandles ? procInternals._getActiveHandles() : [];
    const handleTypes: Record<string, number> = {};
    for (const h of handles) {
      const name = (h as { constructor?: { name?: string } })?.constructor?.name ?? "Unknown";
      handleTypes[name] = (handleTypes[name] ?? 0) + 1;
    }

    const dbRes = await pool.query<{
      pending_outbox: number;
      alloc_cnt: number;
      holds_cnt: number;
      bookings_cnt: number;
      db_mb: number;
    }>(`
      SELECT
        (SELECT count(*)::int FROM outbox_events WHERE status = 'pending') AS pending_outbox,
        (SELECT count(*)::int FROM allocations) AS alloc_cnt,
        (SELECT count(*)::int FROM holds) AS holds_cnt,
        (SELECT count(*)::int FROM bookings) AS bookings_cnt,
        round((pg_database_size(current_database())::numeric / (1024 * 1024)), 2)::float8 AS db_mb
    `);
    const d = dbRes.rows[0]!;
    const gcDeltaCount = gcCount - lastGcCount;
    const gcDeltaMs = Math.round((gcMs - lastGcMs) * 100) / 100;
    lastGcCount = gcCount;
    lastGcMs = gcMs;

    const toMb = (n: number) => Math.round((n / (1024 * 1024)) * 100) / 100;
    return {
      stage,
      elapsedSec: Math.round(((performance.now() - startedAt) / 1000) * 100) / 100,
      opsCompleted,
      rssMb: toMb(mem.rss),
      heapTotalMb: toMb(mem.heapTotal),
      heapUsedMb: toMb(mem.heapUsed),
      externalMb: toMb(mem.external),
      arrayBuffersMb: toMb(mem.arrayBuffers),
      v8UsedHeapMb: toMb(hStats.used_heap_size),
      v8HeapLimitMb: toMb(hStats.heap_size_limit),
      v8MallocedMb: toMb(hStats.malloced_memory),
      spacesMb,
      activeHandles: handles.length,
      handleTypes,
      poolTotal: pool.totalCount,
      poolIdle: pool.idleCount,
      poolWaiting: pool.waitingCount,
      poolErrorListeners: pool.listenerCount("error"),
      gcCountSinceLast: gcDeltaCount,
      gcDurationMsSinceLast: gcDeltaMs,
      gcKinds: { ...gcKindCounts },
      pendingOutboxEvents: Number(d.pending_outbox),
      allocationsRows: Number(d.alloc_cnt),
      holdsRows: Number(d.holds_cnt),
      bookingsRows: Number(d.bookings_cnt),
      dbSizeMb: Number(d.db_mb),
    };
  }

  let cursor = 0;
  async function runWindow(seconds: number): Promise<void> {
    const stopAt = Date.now() + seconds * 1000;
    await Promise.all(
      Array.from({ length: concurrency }, async (_v, workerId) => {
        let opIdx = 0;
        while (Date.now() < stopAt) {
          opIdx += 1;
          try {
            if (opIdx % 3 !== 0) {
              const facId = facilityIds[(opIdx + workerId) % facilityIds.length]!;
              await client.getAvailability({ facilityIds: [facId], fromDate: baseDate, toDate: baseDate });
            } else {
              const pick = allSlotRefs[(cursor++) % allSlotRefs.length]!;
              const hold = await client.createHold(
                { facilityId: pick.facilityId, slotRefs: [pick.slotRef], externalCustomerId: `mi-${workerId}-${opIdx % 10}` },
                { idempotencyKey: `mi-h-${workerId}-${opIdx}-${randomUUID()}` },
              );
              if (opIdx % 6 === 0) {
                await client.convertHoldToBooking(
                  { holdId: hold.id },
                  { idempotencyKey: `mi-c-${workerId}-${opIdx}-${randomUUID()}` },
                );
              } else {
                await client.releaseHold(hold.id, { idempotencyKey: `mi-r-${workerId}-${opIdx}` });
              }
            }
            opsCompleted += 1;
          } catch (err) {
            if (!(err instanceof BookingError)) throw err;
          }
        }
      }),
    );
  }

  try {
    const timeline: SampleSnapshot[] = [];
    timeline.push(await takeSample("baseline_pre_warmup", true));
    const snapBaselinePath = v8.writeHeapSnapshot(join(snapDir, "01-baseline.heapsnapshot"));

    await runWindow(warmupSec);
    timeline.push(await takeSample("post_warmup_pre_gc", false));
    timeline.push(await takeSample("post_warmup_post_gc", true));
    const snapWarmupPath = v8.writeHeapSnapshot(join(snapDir, "02-post-warmup.heapsnapshot"));

    // Split sustained window into 3 x 15s intervals to compute post-warmup slope
    for (let step = 1; step <= 3; step++) {
      await runWindow(sustainedSec / 3);
      timeline.push(await takeSample(`sustained_t${step}_post_gc`, true));
    }
    const snapSustainedPath = v8.writeHeapSnapshot(join(snapDir, "03-post-sustained.heapsnapshot"));

    const baselineSnap = summarizeHeapSnapshot(snapBaselinePath);
    const warmupSnap = summarizeHeapSnapshot(snapWarmupPath);
    const sustainedSnap = summarizeHeapSnapshot(snapSustainedPath);

    const postWarmupPoints = timeline
      .filter((s) => s.stage.includes("post_gc") && s.stage !== "baseline_pre_warmup")
      .map((s) => ({ tSec: s.elapsedSec, mb: s.heapUsedMb }));

    const warmupRssPoints = timeline
      .filter((s) => s.stage.includes("post_gc") && s.stage !== "baseline_pre_warmup")
      .map((s) => ({ tSec: s.elapsedSec, mb: s.rssMb }));

    console.log(
      JSON.stringify(
        {
          gcExposed: typeof global.gc === "function",
          IntlCacheEstimateZonesUsed: 1,
          timeline,
          slopesPostWarmup: {
            heapUsedKbPerMin: linearSlopeKbPerMin(postWarmupPoints),
            rssKbPerMin: linearSlopeKbPerMin(warmupRssPoints),
          },
          heapSnapshots: {
            baseline: baselineSnap,
            postWarmup: warmupSnap,
            postSustained: sustainedSnap,
            netNodeDeltaPostWarmup: sustainedSnap.totalNodes - warmupSnap.totalNodes,
            netSelfSizeDeltaKbPostWarmup:
              Math.round(((sustainedSnap.totalSelfSizeBytes - warmupSnap.totalSelfSizeBytes) / 1024) * 10) / 10,
          },
        },
        null,
        2,
      ),
    );
  } finally {
    expiryWorker.stop();
    gcObserver.disconnect();
    await pool.end();
    rmSync(snapDir, { recursive: true, force: true });
  }
}

void main();

