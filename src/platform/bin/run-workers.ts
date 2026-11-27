import "dotenv/config";
import {
  HoldExpiryWorker,
  OutboxWebhookWorker,
  PlatformMetricsRegistry,
  PlatformService,
  PostgresBookingStore,
  TimeSlotEngine,
  buildBudgetedPoolConfig,
  computeConnectionBudget,
  createBookingPool,
} from "../../index.js";

const budget = computeConnectionBudget({
  postgresMaxConnections: Number(process.env.PG_MAX_CONNECTIONS || 100),
  apiInstanceCount: Number(process.env.API_INSTANCE_COUNT || 4),
});

const pool = createBookingPool(process.env.DATABASE_URL, buildBudgetedPoolConfig(budget, "worker"));
pool.on("error", () => {});

const store = new PostgresBookingStore(pool);
const engine = new TimeSlotEngine(store);
const platform = new PlatformService(pool);
const metricsRegistry = new PlatformMetricsRegistry();

const holdWorker = new HoldExpiryWorker({
  engine,
  intervalMs: Number(process.env.HOLD_EXPIRY_INTERVAL_MS || 5_000),
  batchLimit: 100,
  onSweep: (res) => metricsRegistry.recordHoldExpiryRun(res.expiredCount),
  onError: (err) => console.error(JSON.stringify({ level: "error", worker: "hold_expiry", error: String(err) })),
});

const webhookWorker = new OutboxWebhookWorker({
  pool,
  engine,
  platform,
  pollIntervalMs: Number(process.env.WEBHOOK_POLL_INTERVAL_MS || 500),
  batchSize: 50,
  metricsRegistry,
  onError: (err) => console.error(JSON.stringify({ level: "error", worker: "outbox_webhook", error: String(err) })),
});

holdWorker.start();
webhookWorker.start();
console.log(JSON.stringify({ ts: new Date().toISOString(), level: "info", msg: "OneLineBooking background workers started" }));

const shutdown = async () => {
  holdWorker.stop();
  webhookWorker.stop();
  await pool.end();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

