/** Shard helpers for stable test lists. */
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
