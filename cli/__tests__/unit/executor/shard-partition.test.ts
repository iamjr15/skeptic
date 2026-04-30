import { describe, it, expect } from "vitest";
import { partitionFlows } from "../../../src/executor/shard.js";
import type { ResolvedFlow } from "../../../src/parser/flow-schema.js";

const make = (n: number): ResolvedFlow[] =>
  Array.from(
    { length: n },
    (_, i) =>
      ({
        filePath: `/f${i}.yaml`,
        metadata: { name: `flow-${i}`, tags: [], env: {} },
        steps: [],
      }) as unknown as ResolvedFlow,
  );

const namesOf = (slice: ResolvedFlow[]) => slice.map((f) => f.metadata.name);

describe("partitionFlows", () => {
  describe("split mode", () => {
    it("modulo round-robins 5 flows across 2 shards", () => {
      const flows = make(5);
      const slices = partitionFlows(flows, 2, "split");
      expect(slices).toHaveLength(2);
      expect(namesOf(slices[0]!)).toEqual(["flow-0", "flow-2", "flow-4"]);
      expect(namesOf(slices[1]!)).toEqual(["flow-1", "flow-3"]);
    });

    it("modulo round-robins 5 flows across 3 shards", () => {
      const slices = partitionFlows(make(5), 3, "split");
      expect(slices).toHaveLength(3);
      expect(namesOf(slices[0]!)).toEqual(["flow-0", "flow-3"]);
      expect(namesOf(slices[1]!)).toEqual(["flow-1", "flow-4"]);
      expect(namesOf(slices[2]!)).toEqual(["flow-2"]);
    });

    it("does not clamp internally — caller is responsible", () => {
      const slices = partitionFlows(make(3), 5, "split");
      expect(slices).toHaveLength(5);
      expect(namesOf(slices[0]!)).toEqual(["flow-0"]);
      expect(namesOf(slices[1]!)).toEqual(["flow-1"]);
      expect(namesOf(slices[2]!)).toEqual(["flow-2"]);
      expect(slices[3]!).toEqual([]);
      expect(slices[4]!).toEqual([]);
    });

    it("handles 0 flows gracefully (all empty slices)", () => {
      const slices = partitionFlows([], 3, "split");
      expect(slices).toHaveLength(3);
      expect(slices.every((s) => s.length === 0)).toBe(true);
    });

    it("preserves relative order within each shard (flowsOrder semantics)", () => {
      const flows = make(7);
      const slices = partitionFlows(flows, 2, "split");
      // Within slice 0, originals at indices 0, 2, 4, 6 — must appear in that order.
      expect(namesOf(slices[0]!)).toEqual(["flow-0", "flow-2", "flow-4", "flow-6"]);
      expect(namesOf(slices[1]!)).toEqual(["flow-1", "flow-3", "flow-5"]);
    });
  });

  describe("all mode", () => {
    it("returns identical full-list copies for every shard", () => {
      const flows = make(5);
      const slices = partitionFlows(flows, 3, "all");
      expect(slices).toHaveLength(3);
      for (const slice of slices) {
        expect(namesOf(slice)).toEqual(namesOf(flows));
      }
    });

    it("returns distinct array references per shard so mutators do not cross-contaminate", () => {
      const flows = make(3);
      const slices = partitionFlows(flows, 3, "all");
      // Each slice must be a distinct array (not the input array, not a reference
      // to a sibling slice). Comparing against flows[0] (a flow object) would
      // always pass because slices are arrays — that's why we compare against
      // the input array reference and against sibling slices.
      for (const slice of slices) {
        expect(slice).not.toBe(flows);
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
      const flows = make(3);
      const slices = partitionFlows(flows, 1, "all");
      expect(slices).toHaveLength(1);
      expect(namesOf(slices[0]!)).toEqual(["flow-0", "flow-1", "flow-2"]);
    });
  });

  describe("invariants", () => {
    it("is deterministic across repeated calls", () => {
      const flows = make(11);
      const a = partitionFlows(flows, 4, "split");
      const b = partitionFlows(flows, 4, "split");
      expect(a.map(namesOf)).toEqual(b.map(namesOf));
    });

    it("rejects shardCount < 1", () => {
      expect(() => partitionFlows(make(5), 0, "split")).toThrow(/shardCount must be >= 1/);
      expect(() => partitionFlows(make(5), -1, "all")).toThrow(/shardCount must be >= 1/);
    });
  });
});
