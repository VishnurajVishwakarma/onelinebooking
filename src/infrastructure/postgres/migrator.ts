import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";

function resolveMigrationsDir(customDir?: string): string {
  if (customDir) return customDir;
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(moduleDir, "migrations"),
    resolve(moduleDir, "../../../../src/infrastructure/postgres/migrations"),
    resolve(process.cwd(), "src/infrastructure/postgres/migrations"),
  ];
  for (const dir of candidates) {
    if (existsSync(dir)) return dir;
  }
  return candidates[0]!;
}

/** Apply all unapplied SQL migrations in lexicographical order inside transactions. */
export async function runMigrations(
  pool: Pool,
  migrationsDir?: string,
): Promise<string[]> {
  const dir = resolveMigrationsDir(migrationsDir);
  const entries = await readdir(dir);
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
          const sql = await readFile(resolve(dir, file), "utf8");
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
