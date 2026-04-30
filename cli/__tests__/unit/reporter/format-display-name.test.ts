import { describe, expect, it } from "vitest";
import { formatTestDisplayName } from "../../../src/reporter/types.js";

describe("formatTestDisplayName", () => {
  it("returns the bare name when no shard and no collisions", () => {
    expect(formatTestDisplayName({ name: "homepage smoke" })).toBe("homepage smoke");
  });

  it("appends [shard N] when shardId is set", () => {
    expect(formatTestDisplayName({ name: "x", shardId: 1 })).toBe("x [shard 2]");
  });

  it("appends #ordinal when name collides within the same file", () => {
    const siblings = [
      { name: "dup", file: "/spec.ts", testIndex: 0 },
      { name: "dup", file: "/spec.ts", testIndex: 1 },
    ];
    expect(
      formatTestDisplayName({ name: "dup", file: "/spec.ts", testIndex: 0 }, siblings),
    ).toBe("dup#0");
    expect(
      formatTestDisplayName({ name: "dup", file: "/spec.ts", testIndex: 1 }, siblings),
    ).toBe("dup#1");
  });

  it("does not collide when same name appears in different files", () => {
    const siblings = [
      { name: "dup", file: "/a.spec.ts", testIndex: 0 },
      { name: "dup", file: "/b.spec.ts", testIndex: 0 },
    ];
    expect(
      formatTestDisplayName({ name: "dup", file: "/a.spec.ts", testIndex: 0 }, siblings),
    ).toBe("dup");
  });

  it("stacks #ordinal with [shard N] when both apply", () => {
    const siblings = [
      { name: "dup", file: "/spec.ts", testIndex: 0 },
      { name: "dup", file: "/spec.ts", testIndex: 1 },
    ];
    expect(
      formatTestDisplayName(
        { name: "dup", file: "/spec.ts", testIndex: 0, shardId: 0 },
        siblings,
      ),
    ).toBe("dup#0 [shard 1]");
  });
});
