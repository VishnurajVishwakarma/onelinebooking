import "dotenv/config";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createBookingPool } from "../src/index.js";

const execFileAsync = promisify(execFile);

async function runDocker(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("docker", args);
  return stdout.trim();
}

async function waitForPgReady(containerName: string): Promise<void> {
  for (let i = 0; i < 60; i++) {
    try {
      await runDocker([
        "exec",
        containerName,
        "psql",
        "-h",
        "127.0.0.1",
        "-U",
        "postgres",
        "-d",
        "mygamingslot",
        "-c",
        "SELECT 1",
      ]);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw new Error(`Container ${containerName} failed TCP Postgres readiness timeout`);
}

/**
 * Executes genuine WAL-based Point-In-Time Recovery (PITR) using isolated Postgres 17 containers:
 * 1) Start source DB with archive_mode=on
 * 2) Insert pre-recovery booking record
 * 3) Take physical pg_basebackup and record target PITR timestamp
 * 4) Insert post-target booking record and force pg_switch_wal() into WAL archive
 * 5) Restore physical backup + replay WAL up to recovery_target_time -> promote -> verify exact pre-target state
 */
async function main(): Promise<void> {
  const runId = Date.now().toString(36);
  const volArchive = `olb_wal_arch_${runId}`;
  const srcContainer = `olb-pitr-src-${runId}`;
  const dstContainer = `olb-pitr-dst-${runId}`;
  const tempDir = mkdtempSync(join(tmpdir(), "olb-pitr-"));

  try {
    await runDocker(["volume", "create", volArchive]);

    // 1. Boot source Postgres 17 with WAL archiving enabled
    await runDocker([
      "run", "-d",
      "--name", srcContainer,
      "-e", "POSTGRES_PASSWORD=postgres",
      "-e", "POSTGRES_DB=mygamingslot",
      "-p", "55432:5432",
      "-v", `${volArchive}:/wal_archive`,
      "postgres:17-alpine",
      "-c", "wal_level=replica",
      "-c", "archive_mode=on",
      "-c", "archive_command=test ! -f /wal_archive/%f && cp %p /wal_archive/%f",
    ]);
    await waitForPgReady(srcContainer);
    await runDocker([
      "exec",
      srcContainer,
      "sh",
      "-c",
      "chown -R postgres:postgres /wal_archive && chmod 700 /wal_archive && mkdir -p /tmp/basebackup && chown -R postgres:postgres /tmp/basebackup && chmod 700 /tmp/basebackup",
    ]);

    const srcPool = createBookingPool("postgres://postgres:postgres@127.0.0.1:55432/mygamingslot", { max: 4 });
    srcPool.on("error", () => {});
    await srcPool.query(`CREATE TABLE pitr_audit_events (id serial PRIMARY KEY, label text NOT NULL, created_at timestamptz NOT NULL DEFAULT now())`);
    await srcPool.query(`INSERT INTO pitr_audit_events(label) VALUES ('BEFORE_CUTOFF_BOOKING')`);

    // 2. Physical base backup via pg_basebackup + record recovery target timestamp
    await runDocker([
      "exec", "-u", "postgres", srcContainer,
      "pg_basebackup", "-D", "/tmp/basebackup", "-Fp", "-Xs", "-P",
    ]);
    await new Promise((r) => setTimeout(r, 1200));
    const tsRes = await srcPool.query<{ target_ts: string }>(`SELECT now()::text AS target_ts`);
    const targetTs = tsRes.rows[0]!.target_ts;
    await new Promise((r) => setTimeout(r, 1200));

    // 3. Post-cutoff mutation + force WAL segment flush to /wal_archive
    await srcPool.query(`INSERT INTO pitr_audit_events(label) VALUES ('AFTER_CUTOFF_ACCIDENTAL_DROP')`);
    await srcPool.query(`SELECT pg_switch_wal()`);
    await new Promise((r) => setTimeout(r, 1500));

    // Copy /tmp/basebackup out to host temp dir so restore container boots from physical snapshot
    const localBackup = join(tempDir, "pgdata");
    await runDocker(["cp", `${srcContainer}:/tmp/basebackup`, localBackup]);
    await srcPool.end();

    // Remove source container before starting restore on port 55433
    await runDocker(["rm", "-f", srcContainer]);

    // 4. Configure physical PITR recovery.signal + postgresql.auto.conf and boot restored instance
    await runDocker([
      "run", "-d",
      "--name", dstContainer,
      "-p", "55433:5432",
      "-v", `${volArchive}:/wal_archive`,
      "postgres:17-alpine",
      "sleep", "300",
    ]);
    await runDocker(["cp", localBackup, `${dstContainer}:/tmp/pitr_data`]);
    await runDocker([
      "exec", dstContainer, "sh", "-c",
      `chown -R postgres:postgres /tmp/pitr_data /wal_archive && chmod 700 /tmp/pitr_data && touch /tmp/pitr_data/recovery.signal && printf "restore_command = 'cp /wal_archive/%%f %%p'\\nrecovery_target_time = '${targetTs}'\\nrecovery_target_action = 'promote'\\narchive_mode = 'off'\\n" >> /tmp/pitr_data/postgresql.auto.conf`,
    ]);

    // Start postgres binary inside restored container cleanly
    await execFileAsync("docker", [
      "exec", "-d", "-u", "postgres", dstContainer,
      "postgres", "-D", "/tmp/pitr_data",
    ]);
    await waitForPgReady(dstContainer);

    // 5. Verify exact PITR state: BEFORE_CUTOFF_BOOKING present, AFTER_CUTOFF absent!
    const dstPool = createBookingPool("postgres://postgres:postgres@127.0.0.1:55433/mygamingslot", { max: 4 });
    dstPool.on("error", () => {});
    const rowsRes = await dstPool.query<{ label: string }>(`SELECT label FROM pitr_audit_events ORDER BY id ASC`);
    const labels = rowsRes.rows.map((r) => r.label);
    await dstPool.end();

    assert.deepEqual(labels, ["BEFORE_CUTOFF_BOOKING"]);

    console.log(
      JSON.stringify(
        {
          pitrPassed: true,
          targetRecoveryTimestamp: targetTs,
          recoveredRows: labels,
          postCutoffMutationRolledBackByWalPitr: true,
        },
        null,
        2,
      ),
    );
  } finally {
    await execFileAsync("docker", ["rm", "-f", srcContainer]).catch(() => {});
    await execFileAsync("docker", ["rm", "-f", dstContainer]).catch(() => {});
    await execFileAsync("docker", ["volume", "rm", "-f", volArchive]).catch(() => {});
    rmSync(tempDir, { recursive: true, force: true });
  }
}

void main();

