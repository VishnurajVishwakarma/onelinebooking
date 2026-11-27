import { TimeSlotEngine } from "../../application/time-slot-engine.js";

export interface HoldExpiryWorkerOptions {
  engine: TimeSlotEngine;
  intervalMs?: number | undefined;
  batchLimit?: number | undefined;
  onSweep?: ((result: { expiredCount: number; durationMs: number }) => void) | undefined;
  onError?: ((error: unknown) => void) | undefined;
}

/**
 * Managed infrastructure background worker that periodically sweeps and expires stale holds.
 */
export class HoldExpiryWorker {
  private readonly intervalMs: number;
  private readonly batchLimit: number;
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(private readonly options: HoldExpiryWorkerOptions) {
    this.intervalMs = options.intervalMs ?? 5_000;
    this.batchLimit = options.batchLimit ?? 100;
  }

  async runOnce(): Promise<{ expiredCount: number; durationMs: number }> {
    const start = performance.now();
    const res = await this.options.engine.expireHolds(this.batchLimit);
    const durationMs = Math.round((performance.now() - start) * 100) / 100;
    this.options.onSweep?.({ expiredCount: res.expiredCount, durationMs });
    return { expiredCount: res.expiredCount, durationMs };
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.running) return;
      this.running = true;
      void this.runOnce()
        .catch((err) => {
          this.options.onError?.(err);
        })
        .finally(() => {
          this.running = false;
        });
    }, this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }
}
