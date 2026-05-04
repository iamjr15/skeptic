import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  safeJsonStringify,
  truncateText,
  wrapContentBoundaries,
  writeJsonResultFile,
} from "../../../src/utils/safe-json.js";

describe("safe-json utilities", () => {
  it("serializes circular, bigint, map, set, error, and long string values", () => {
    const circular: Record<string, unknown> = { name: "root" };
    circular["self"] = circular;
    const json = safeJsonStringify({
      circular,
      big: 12n,
      map: new Map([["a", 1]]),
      set: new Set(["x"]),
      error: new Error("boom"),
      long: "abcdef",
    }, {
      maxStringLength: 3,
    });

    expect(json).toContain("[Circular]");
    expect(json).toContain("12n");
    expect(json).toContain("boo... [truncated 1 chars]");
    expect(json).toContain("abc... [truncated 3 chars]");
  });

  it("truncates and wraps inline tool output", () => {
    expect(truncateText("abcdef", 3)).toBe("abc\n... [truncated 3 chars]");
    expect(wrapContentBoundaries("body", "x")).toBe("<x>\nbody\n</x>");
  });

  it("writes result files under a caller-provided directory", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skeptic-safe-json-"));
    try {
      const file = await writeJsonResultFile({ ok: true }, { directory: dir, prefix: "unit" });
      expect(file.startsWith(dir)).toBe(true);
      expect(JSON.parse(fs.readFileSync(file, "utf-8"))).toEqual({ ok: true });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
