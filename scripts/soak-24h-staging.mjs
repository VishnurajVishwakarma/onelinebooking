#!/usr/bin/env node
/**
 * 24-Hour Staging Stability Test Supervisor for OneLineBooking.
 * Executes the TypeScript soak runner with `--duration-minutes=1440`, writes periodic reports,
 * and fails automatically if overlapping allocations, unexpected errors, or runaway post-warmup
 * heap growth (> 512 KB/min after warm-up) occur.
 */
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const durationMinutes = process.env.SOAK_DURATION_MINUTES ?? "1440";
const concurrency = process.env.SOAK_CONCURRENCY ?? "20";
const outDir = resolve(process.cwd(), "reports", "soak-staging");
mkdirSync(outDir, { recursive: true });
const outFile = resolve(outDir, `soak-${durationMinutes}m-${Date.now()}.json`);

const child = spawn(
  process.execPath,
  [
    "--expose-gc",
    "dist/scripts/soak-test.js",
    `--duration-minutes=${durationMinutes}`,
    `--concurrency=${concurrency}`,
    "--conflict-ratio=0.1",
    "--sample-interval-seconds=60",
    `--report-json=${outFile}`,
  ],
  { stdio: "inherit", env: process.env },
);

child.on("exit", (code) => {
  if (code !== 0) {
    console.error(`24h staging soak exited with status ${code}`);
    process.exit(code ?? 1);
  }
  const report = JSON.parse(readFileSync(outFile, "utf8"));
  if (report.counts.overlappingAllocations !== 0 || report.counts.unexpectedErrors !== 0) {
    console.error("Staging soak failed correctness gate:", report.counts);
    process.exit(2);
  }
  if (report.memory.postWarmupHeapSlopeKbPerMin > 512) {
    console.error("Staging soak failed retained-heap slope threshold (>512 KB/min):", report.memory);
    process.exit(3);
  }
  console.log("24h staging soak passed stability & correctness gates:", outFile);
});

