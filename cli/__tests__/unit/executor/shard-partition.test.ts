import { describe, it, expect } from "vitest";
import { partitionTests } from "../../../src/executor/shard.js";

interface ShardTestItem {
  filePath: string;
  name: string;
}

const make = (n: number): ShardTestItem[] =>
  Array.from({ length: n }, (_, i) => ({
    filePath: `/f${i}.spec.ts`,
    name: `test-${i}`,
  }));

const namesOf = (slice: ShardTestItem[]) => slice.map((f) => f.name);

describe("partitionTests", () => {
  describe("split mode", () => {
    it("modulo round-robins 5 tests across 2 shards", () => {
      const tests = make(5);
      const slices = partitionTests(tests, 2, "split");
      expect(slices).toHaveLength(2);
      expect(namesOf(slices[0]!)).toEqual(["test-0", "test-2", "test-4"]);
      expect(namesOf(slices[1]!)).toEqual(["test-1", "test-3"]);
    });

    it("modulo round-robins 5 tests across 3 shards", () => {
      const slices = partitionTests(make(5), 3, "split");
      expect(slices).toHaveLength(3);
      expect(namesOf(slices[0]!)).toEqual(["test-0", "test-3"]);
      expect(namesOf(slices[1]!)).toEqual(["test-1", "test-4"]);
      expect(namesOf(slices[2]!)).toEqual(["test-2"]);
    });

    it("does not clamp internally — caller is responsible", () => {
      const slices = partitionTests(make(3), 5, "split");
      expect(slices).toHaveLength(5);
      expect(namesOf(slices[0]!)).toEqual(["test-0"]);
      expect(namesOf(slices[1]!)).toEqual(["test-1"]);
      expect(namesOf(slices[2]!)).toEqual(["test-2"]);
      expect(slices[3]!).toEqual([]);
      expect(slices[4]!).toEqual([]);
    });

    it("handles 0 tests gracefully (all empty slices)", () => {
      const slices = partitionTests([], 3, "split");
      expect(slices).toHaveLength(3);
      expect(slices.every((s) => s.length === 0)).toBe(true);
    });

    it("preserves relative order within each shard", () => {
      const tests = make(7);
      const slices = partitionTests(tests, 2, "split");
      // Within slice 0, originals at indices 0, 2, 4, 6 — must appear in that order.
      expect(namesOf(slices[0]!)).toEqual(["test-0", "test-2", "test-4", "test-6"]);
      expect(namesOf(slices[1]!)).toEqual(["test-1", "test-3", "test-5"]);
    });
  });

  describe("all mode", () => {
    it("returns identical full-list copies for every shard", () => {
      const tests = make(5);
      const slices = partitionTests(tests, 3, "all");
      expect(slices).toHaveLength(3);
      for (const slice of slices) {
        expect(namesOf(slice)).toEqual(namesOf(tests));
      }
    });

    it("returns distinct array references per shard so mutators do not cross-contaminate", () => {
      const tests = make(3);
      const slices = partitionTests(tests, 3, "all");
      // Each slice must be a distinct array (not the input array, not a reference
      // to a sibling slice). Comparing against tests[0] (a test object) would
      // always pass because slices are arrays — that's why we compare against
      // the input array reference and against sibling slices.
      for (const slice of slices) {
        expect(slice).not.toBe(tests);
      }
      expect(slices[0]).not.toBe(slices[1]);
      expect(slices[0]).not.toBe(slices[2]);
      expect(slices[1]).not.toBe(slices[2]);

      // Mutating one slice must not affect the others.
      slices[0]!.pop();
      expect(slices[0]!.length).toBe(2);
      expect(slices[1]!.length).toBe(3);
      expect(slices[2]!.length).toBe(3);
    });

    it("shardCount=1 returns a single full-list copy", () => {
      const tests = make(3);
      const slices = partitionTests(tests, 1, "all");
      expect(slices).toHaveLength(1);
      expect(namesOf(slices[0]!)).toEqual(["test-0", "test-1", "test-2"]);
    });
  });

  describe("invariants", () => {
    it("is deterministic across repeated calls", () => {
      const tests = make(11);
      const a = partitionTests(tests, 4, "split");
      const b = partitionTests(tests, 4, "split");
      expect(a.map(namesOf)).toEqual(b.map(namesOf));
    });

    it("rejects shardCount < 1", () => {
      expect(() => partitionTests(make(5), 0, "split")).toThrow(/shardCount must be >= 1/);
      expect(() => partitionTests(make(5), -1, "all")).toThrow(/shardCount must be >= 1/);
    });
  });
});
