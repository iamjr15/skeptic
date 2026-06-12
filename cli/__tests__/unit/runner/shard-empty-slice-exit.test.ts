import { describe, expect, it } from "vitest";
import { resolveRunExitCode } from "../../../src/commands/run.js";

// Sharded runs must not spuriously fail on empty/over-provisioned shards (P2). A shard whose slice
// is empty because round-robin sharding distributed the discovered tests elsewhere is success, not
// the misleading "No tests found" failure. A genuinely empty/unmatched suite still exits 1.
describe("resolveRunExitCode — sharded empty slice (P2)", () => {
  it("(a) sharded slice is empty but tests were discovered → exit 0", () => {
    // `--shard-split 8` over 5 tests: shards 6-8 get an empty slice (total 0), 5 discovered overall.
    expect(
      resolveRunExitCode(false, { total: 0, failed: 0 }, { active: true, discoveredTestCount: 5 }),
    ).toBe(0);
  });

  it("(b) non-sharded run with zero matches → still exit 1", () => {
    expect(
      resolveRunExitCode(false, { total: 0, failed: 0 }, { active: false, discoveredTestCount: 0 }),
    ).toBe(1);
  });

  it("sharded run that discovered nothing at all → exit 1 (bad patterns, not an empty slice)", () => {
    expect(
      resolveRunExitCode(false, { total: 0, failed: 0 }, { active: true, discoveredTestCount: 0 }),
    ).toBe(1);
  });

  it("interrupt outranks the shard exception → 130", () => {
    expect(
      resolveRunExitCode(true, { total: 0, failed: 0 }, { active: true, discoveredTestCount: 5 }),
    ).toBe(130);
  });

  it("a sharded slice that ran tests and saw a failure still exits 1", () => {
    expect(
      resolveRunExitCode(false, { total: 2, failed: 1 }, { active: true, discoveredTestCount: 5 }),
    ).toBe(1);
  });

  it("omitting the shard argument preserves legacy behavior (zero tests → 1)", () => {
    expect(resolveRunExitCode(false, { total: 0, failed: 0 })).toBe(1);
  });
});
