import "dotenv/config";
import {
  PlatformMetricsRegistry,
  PlatformService,
  PostgresBookingStore,
  PostgresDistributedLimiter,
  RuntimeTrafficLimiter,
  TimeSlotEngine,
  buildBudgetedPoolConfig,
  computeConnectionBudget,
  createBookingPool,
  createPlatformHttpServer,
} from "../../index.js";

const port = Number(process.env.PORT || 4100);
const postgresMaxConns = Number(process.env.PG_MAX_CONNECTIONS || 100);
const apiReplicas = Number(process.env.API_INSTANCE_COUNT || 4);

const budget = computeConnectionBudget({
  postgresMaxConnections: postgresMaxConns,
  apiInstanceCount: apiReplicas,
  ...(process.env.PGBOUNCER_DEFAULT_POOL_SIZE
    ? { pgbouncerDefaultPoolSize: Number(process.env.PGBOUNCER_DEFAULT_POOL_SIZE) }
    : {}),
});

const pool = createBookingPool(
  process.env.PGBOUNCER_URL || process.env.DATABASE_URL,
  buildBudgetedPoolConfig(budget, "api"),
);
pool.on("error", () => {});

const store = new PostgresBookingStore(pool, {
  maxPendingPoolRequests: budget.maxPendingPoolRequestsPerInstance,
});
const engine = new TimeSlotEngine(store);
const platform = new PlatformService(pool);
const limiter = new RuntimeTrafficLimiter();
const distributedLimiter = new PostgresDistributedLimiter(pool, {
  instanceId: process.env.HOSTNAME || `api-${process.pid}`,
});
const metricsRegistry = new PlatformMetricsRegistry();

const server = createPlatformHttpServer({
  pool,
  engine,
  platform,
  limiter,
  distributedLimiter,
  metricsRegistry,
  opsAuthToken: process.env.OLB_OPS_TOKEN,
  logger: (level, msg, meta) => {
    console.log(JSON.stringify({ ts: new Date().toISOString(), level, msg, ...meta }));
  },
});

server.listen(port, "0.0.0.0", () => {
  console.log(JSON.stringify({ ts: new Date().toISOString(), level: "info", msg: `API server listening on :${port}`, budget }));
});

const shutdown = async () => {
  server.close();
  await pool.end();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

