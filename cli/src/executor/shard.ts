/**
 * Shard helpers for the runner. The TS-pivot moves sharding from per-flow to
 * per-test (see plan §4.0.1) — the runner partitions stable test ids
 * (`${file}#${ordinal}`) modulo N. This module retains a generic helper for any
 * caller that needs to round-robin partition a homogeneous list.
 */
export type ShardMode = "split" | "all";

export const partitionTests = <T>(items: T[], shardCount: number, mode: ShardMode): T[][] => {
  if (shardCount < 1) {
    throw new Error(`partitionTests: shardCount must be >= 1, got ${shardCount}`);
  }
  if (mode === "all") {
    return Array.from({ length: shardCount }, () => [...items]);
  }
  const slices: T[][] = Array.from({ length: shardCount }, () => []);
  for (let i = 0; i < items.length; i++) {
    slices[i % shardCount]!.push(items[i]!);
  }
  return slices;
};

/** @deprecated — use {@link partitionTests} (kept temporarily for migrating callers). */
export const partitionFlows = partitionTests;
