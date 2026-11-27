import type { PoolConfig } from "pg";
import { BookingError } from "../../domain/errors.js";

export interface ConnectionBudgetInput {
  /** PostgreSQL server max_connections setting (e.g. 100 on default Postgres, 400 behind PgBouncer). */
  postgresMaxConnections: number;
  /** Number of independent API processes sharing the same database budget. */
  apiInstanceCount: number;
  /** Connections reserved exclusively for PostgreSQL superuser/admin diagnostics and manual maintenance. */
  reservedAdminConnections?: number;
  /** Connections reserved for background workers (hold expiry, outbox/webhook dispatch, metering). */
  reservedWorkerConnections?: number;
  /** Connections reserved for zero-downtime schema migrations / CLI tasks. */
  reservedMigrationConnections?: number;
  /** Optional PgBouncer transaction pool ceiling when API processes connect through PgBouncer. */
  pgbouncerDefaultPoolSize?: number;
  /** Fraction (0..1) of per-instance pool size reserved before failing fast at local backpressure queue. */
  queueDepthMultiplier?: number;
}

export interface ConnectionBudgetPlan {
  postgresMaxConnections: number;
  apiInstanceCount: number;
  reservedAdminConnections: number;
  reservedWorkerConnections: number;
  reservedMigrationConnections: number;
  totalReservedConnections: number;
  totalApiConnectionBudget: number;
  perApiInstancePoolMax: number;
  perWorkerPoolMax: number;
  maxPendingPoolRequestsPerInstance: number;
  pgbouncerEnabled: boolean;
  pgbouncerClientMaxPerInstance: number;
}

/**
 * Computes deterministic PostgreSQL connection budgets across multiple API instances and background workers
 * so aggregate server connections never exhaust `postgresMaxConnections`.
 */
export function computeConnectionBudget(input: ConnectionBudgetInput): ConnectionBudgetPlan {
  const {
    postgresMaxConnections,
    apiInstanceCount,
    reservedAdminConnections = 5,
    reservedWorkerConnections = 8,
    reservedMigrationConnections = 3,
    pgbouncerDefaultPoolSize,
    queueDepthMultiplier = 4,
  } = input;

  if (!Number.isInteger(postgresMaxConnections) || postgresMaxConnections < 10) {
    throw new BookingError(
      "INVALID_INPUT",
      "postgresMaxConnections must be an integer >= 10",
      { details: { postgresMaxConnections } },
    );
  }
  if (!Number.isInteger(apiInstanceCount) || apiInstanceCount < 1) {
    throw new BookingError(
      "INVALID_INPUT",
      "apiInstanceCount must be an integer >= 1",
      { details: { apiInstanceCount } },
    );
  }
  if (
    !Number.isInteger(reservedAdminConnections) ||
    !Number.isInteger(reservedWorkerConnections) ||
    !Number.isInteger(reservedMigrationConnections) ||
    reservedAdminConnections < 1 ||
    reservedWorkerConnections < 1 ||
    reservedMigrationConnections < 1
  ) {
    throw new BookingError(
      "INVALID_INPUT",
      "Reserved connection counts for admin, workers, and migrations must be integers >= 1",
    );
  }

  const totalReservedConnections =
    reservedAdminConnections + reservedWorkerConnections + reservedMigrationConnections;

  const effectiveBackendPoolCap =
    pgbouncerDefaultPoolSize !== undefined
      ? Math.min(pgbouncerDefaultPoolSize, postgresMaxConnections - totalReservedConnections)
      : postgresMaxConnections - totalReservedConnections;

  if (effectiveBackendPoolCap < apiInstanceCount) {
    throw new BookingError(
      "INVALID_INPUT",
      "Not enough unreserved PostgreSQL connections for the requested apiInstanceCount",
      {
        details: {
          postgresMaxConnections,
          totalReservedConnections,
          effectiveBackendPoolCap,
          apiInstanceCount,
        },
      },
    );
  }

  const perApiInstancePoolMax = Math.max(1, Math.floor(effectiveBackendPoolCap / apiInstanceCount));
  const totalApiConnectionBudget = perApiInstancePoolMax * apiInstanceCount;
  const pgbouncerEnabled = pgbouncerDefaultPoolSize !== undefined;
  // Behind PgBouncer transaction pooling, each API instance can hold more logical app connections
  // that multiplex onto `pgbouncerDefaultPoolSize` server connections.
  const pgbouncerClientMaxPerInstance = pgbouncerEnabled
    ? Math.max(perApiInstancePoolMax, perApiInstancePoolMax * 3)
    : perApiInstancePoolMax;

  return {
    postgresMaxConnections,
    apiInstanceCount,
    reservedAdminConnections,
    reservedWorkerConnections,
    reservedMigrationConnections,
    totalReservedConnections,
    totalApiConnectionBudget,
    perApiInstancePoolMax,
    perWorkerPoolMax: Math.max(2, Math.floor(reservedWorkerConnections / 2)),
    maxPendingPoolRequestsPerInstance: Math.max(
      16,
      Math.floor((pgbouncerEnabled ? pgbouncerClientMaxPerInstance : perApiInstancePoolMax) * queueDepthMultiplier),
    ),
    pgbouncerEnabled,
    pgbouncerClientMaxPerInstance,
  };
}

/**
 * Produces pg Pool options honoring an explicit connection budget and safe idle/connect timeouts.
 */
export function buildBudgetedPoolConfig(
  plan: ConnectionBudgetPlan,
  role: "api" | "worker" | "admin",
  overrides?: Omit<PoolConfig, "connectionString">,
): Omit<PoolConfig, "connectionString"> {
  const max =
    role === "api"
      ? plan.pgbouncerEnabled
        ? plan.pgbouncerClientMaxPerInstance
        : plan.perApiInstancePoolMax
      : role === "worker"
        ? plan.perWorkerPoolMax
        : Math.max(1, plan.reservedAdminConnections - 1);

  return {
    max,
    idleTimeoutMillis: 15_000,
    connectionTimeoutMillis: 2_500,
    allowExitOnIdle: false,
    ...overrides,
  };
}

