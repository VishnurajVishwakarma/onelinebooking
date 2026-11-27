import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import type { Pool } from "pg";
import { BookingError } from "../../../../src/domain/errors.js";
import { TimeSlotEngine } from "../../../../src/application/time-slot-engine.js";
import { PostgresBookingStore, createBookingPool } from "../../../../src/infrastructure/postgres/postgres-booking-store.js";
import { runMigrations } from "../../../../src/infrastructure/postgres/migrator.js";
import { PlatformService } from "../../../../src/platform/control-plane.js";
import { ConsoleAuthService, type ConsoleSessionContext, type ProjectRole } from "../../../../src/platform/console-auth.js";
import { ALL_PLATFORM_SCOPES, type PlatformScope } from "../../../../src/platform/model.js";
import { checkPlatformReadiness } from "../../../../src/platform/runtime/observability.js";

export { ALL_PLATFORM_SCOPES, checkPlatformReadiness };
export type { PlatformScope, ProjectRole };

export const CONSOLE_SESSION_COOKIE = "olb_console_session";

interface ConsoleBackend {
  pool: Pool;
  engine: TimeSlotEngine;
  platform: PlatformService;
  auth: ConsoleAuthService;
  migrated: Promise<unknown>;
}

const g = globalThis as unknown as { __olbConsoleBackend?: ConsoleBackend };

export async function getConsoleBackend(): Promise<ConsoleBackend> {
  if (!g.__olbConsoleBackend) {
    const dbUrl =
      process.env.DATABASE_URL ??
      "postgres://postgres:postgres@localhost:5432/mygamingslot";
    const pool = createBookingPool(dbUrl, { max: 12 });
    pool.on("error", () => {});
    const store = new PostgresBookingStore(pool);
    const engine = new TimeSlotEngine(store);
    const platform = new PlatformService(pool, {
      ssrfOptions:
        process.env.OLB_ALLOW_LOCAL_WEBHOOKS === "true"
          ? { allowLocalHttpForTesting: true }
          : undefined,
    });
    const auth = new ConsoleAuthService(pool);
    const migrated = runMigrations(pool, `${process.cwd().replace(/\\apps\\console$/, "")}/src/infrastructure/postgres/migrations`).catch(
      () => runMigrations(pool),
    );
    g.__olbConsoleBackend = { pool, engine, platform, auth, migrated };
  }
  await g.__olbConsoleBackend.migrated;
  return g.__olbConsoleBackend;
}

export async function requireConsoleSession(): Promise<{
  backend: ConsoleBackend;
  session: ConsoleSessionContext;
}> {
  const backend = await getConsoleBackend();
  const cookieStore = await cookies();
  const raw = cookieStore.get(CONSOLE_SESSION_COOKIE)?.value;
  if (!raw) {
    throw new BookingError("FORBIDDEN", "Authentication required");
  }
  const session = await backend.auth.verifySession(raw);
  if (!session) {
    throw new BookingError("FORBIDDEN", "Session expired or invalid");
  }
  return { backend, session };
}

export function jsonErrorResponse(err: unknown): NextResponse {
  if (err instanceof BookingError) {
    const status =
      err.code === "FORBIDDEN"
        ? err.message === "Authentication required" || err.message === "Session expired or invalid"
          ? 401
          : 403
        : err.code === "NOT_FOUND"
          ? 404
          : err.code === "SLOT_CONFLICT" || err.code === "INVALID_STATE_TRANSITION"
            ? 409
            : 400;
    return NextResponse.json({ error: err.message, code: err.code }, { status });
  }
  return NextResponse.json(
    { error: err instanceof Error ? err.message : "Internal server error" },
    { status: 500 },
  );
}
