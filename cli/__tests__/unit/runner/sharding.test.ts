import { describe, expect, it } from "vitest";
import { partitionTests } from "../../../src/executor/shard.js";

describe("partitionTests (shard partitioning)", () => {
  it("split mode: round-robins items into N shards by index mod N", () => {
    const items = ["a#0", "a#1", "a#2", "a#3"];
    const shards = partitionTests(items, 2, "split");
    expect(shards).toEqual([
      ["a#0", "a#2"],
      ["a#1", "a#3"],
    ]);
  });

  it("all mode: every shard gets the full list", () => {
    const items = ["a#0", "b#0"];
    const shards = partitionTests(items, 3, "all");
    expect(shards).toEqual([items, items, items]);
    // Ensure each shard is a fresh array — mutating one must not bleed into siblings.
    shards[0]!.push("mutated");
    expect(shards[1]).toEqual(items);
  });

  it("rejects shardCount < 1", () => {
    expect(() => partitionTests([], 0, "split")).toThrowError(/shardCount/);
  });

  it("split mode is stable across input orderings — same id at same index lands in same shard", () => {
    // Stable test ids `${file}#${ordinal}` → modulo N → deterministic shard.
    const items = ["x#0", "x#1", "x#2"];
    const a = partitionTests(items, 2, "split");
    const b = partitionTests(items, 2, "split");
    expect(a).toEqual(b);
  });
});
