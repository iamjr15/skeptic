/** Lightweight duration tracker. */
export class Timer {
  private readonly start: bigint;

  constructor() {
    this.start = process.hrtime.bigint();
  }

  /** Elapsed time in milliseconds. */
  elapsedMs(): number {
    return Number(process.hrtime.bigint() - this.start) / 1_000_000;
  }

  /** Human-readable elapsed time, e.g. "1.23s" or "456ms". */
  format(): string {
    const ms = this.elapsedMs();
    if (ms < 1000) return `${Math.round(ms)}ms`;
    return `${(ms / 1000).toFixed(2)}s`;
  }
}
