import "dotenv/config";
import { resolve } from "node:path";
import { createBookingPool } from "../src/infrastructure/postgres/postgres-booking-store.js";
import { runMigrations } from "../src/infrastructure/postgres/migrator.js";

const migrationsDir = resolve(process.cwd(), "src/infrastructure/postgres/migrations");
const pool = createBookingPool();

try {
  const applied = await runMigrations(pool, migrationsDir);
  if (applied.length === 0) {
    process.stdout.write("All migrations already applied\n");
  } else {
    process.stdout.write(`Applied migrations: ${applied.join(", ")}\n`);
  }
} finally {
  await pool.end();
}
