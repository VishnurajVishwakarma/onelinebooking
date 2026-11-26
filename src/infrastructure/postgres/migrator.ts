import { readdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";

const DEFAULT_MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "migrations");

/** Apply all unapplied SQL migrations in lexicographical order inside transactions. */
export async function runMigrations(
  pool: Pool,
  migrationsDir: string = DEFAULT_MIGRATIONS_DIR,
): Promise<string[]> {
  const entries = await readdir(migrationsDir);
  const files = entries.filter((name) => name.endsWith(".sql")).sort();
  const applied: string[] = [];

  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS booking_engine_migrations (
        name text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    for (const file of files) {
      const migrationName = file.replace(/\.sql$/, "");
      await client.query("BEGIN");
      try {
        const existing = await client.query(
          "SELECT 1 FROM booking_engine_migrations WHERE name = $1",
          [migrationName],
        );
        if (!existing.rowCount) {
          const sql = await readFile(resolve(migrationsDir, file), "utf8");
          await client.query(sql);
          await client.query(
            "INSERT INTO booking_engine_migrations(name) VALUES ($1)",
            [migrationName],
          );
          applied.push(migrationName);
        }
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
  } finally {
    client.release();
  }

  return applied;
}

