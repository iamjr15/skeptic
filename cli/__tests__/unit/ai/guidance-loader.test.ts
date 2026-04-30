import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  GUIDANCE_DOMAINS,
  isGuidanceDomain,
  loadGuidance,
} from "../../../src/ai/guidance-loader.js";
import { logger } from "../../../src/utils/logger.js";

describe("isGuidanceDomain", () => {
  it("accepts all 8 known domains", () => {
    for (const d of GUIDANCE_DOMAINS) expect(isGuidanceDomain(d)).toBe(true);
  });
  it("rejects unknown names", () => {
    expect(isGuidanceDomain("xyz")).toBe(false);
    expect(isGuidanceDomain("")).toBe(false);
  });
});

describe("loadGuidance — builtin", () => {
  it("returns the accessibility builtin with a recognizable heading", () => {
    const result = loadGuidance("accessibility");
    expect(result.source).toBe("builtin");
    expect(result.domain).toBe("accessibility");
    expect(result.content).toContain("Accessibility Testing Guidance");
  });

  it("each of the 8 domains loads, with frontmatter + non-trivial body", () => {
    for (const domain of GUIDANCE_DOMAINS) {
      const result = loadGuidance(domain);
      expect(result.source).toBe("builtin");
      // Frontmatter opens with ---
      expect(result.content.startsWith("---\n")).toBe(true);
      // Frontmatter includes name + description keys
      expect(result.content).toContain(`name: ${domain}`);
      expect(result.content).toMatch(/^description:/m);
      // Body closes frontmatter and has meaningful content
      const bodyStart = result.content.indexOf("\n---\n", 4);
      expect(bodyStart).toBeGreaterThan(0);
      const body = result.content.slice(bodyStart + 5);
      expect(body.length).toBeGreaterThan(100);
    }
  });
});

describe("loadGuidance — unknown domain", () => {
  it("throws with 'Did you mean' for near-match typo", () => {
    expect(() => loadGuidance("acessibility")).toThrow(/Did you mean 'accessibility'/);
  });

  it("throws without 'Did you mean' when no near-match", () => {
    expect(() => loadGuidance("qwerty-nothing-close")).toThrow(/Unknown guidance domain/);
    try {
      loadGuidance("qwerty-nothing-close");
    } catch (err) {
      expect((err as Error).message).not.toContain("Did you mean");
    }
  });

  it("lists all 8 domains in the Available: suffix", () => {
    try {
      loadGuidance("bogus");
    } catch (err) {
      const msg = (err as Error).message;
      for (const d of GUIDANCE_DOMAINS) expect(msg).toContain(d);
    }
  });
});

describe("loadGuidance — user override", () => {
  let tmp: string;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "skeptic-guidance-"));
    warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    warnSpy.mockRestore();
  });

  it("prefers a user override over the builtin and emits a warning", () => {
    const overrideDir = path.join(tmp, ".skeptic", "guidance");
    fs.mkdirSync(overrideDir, { recursive: true });
    const overridePath = path.join(overrideDir, "accessibility.md");
    fs.writeFileSync(overridePath, "# Custom A11y Rules\n\nUse axe-core.\n");

    const result = loadGuidance("accessibility", { cwd: tmp });
    expect(result.source).toBe(overridePath);
    expect(result.content).toContain("Custom A11y Rules");
    expect(warnSpy).toHaveBeenCalled();
    const warned = warnSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(warned).toContain("guidance override");
    expect(warned).toContain(overridePath);
  });

  it("walks up from a nested cwd to find the override", () => {
    const overrideDir = path.join(tmp, ".skeptic", "guidance");
    fs.mkdirSync(overrideDir, { recursive: true });
    fs.writeFileSync(path.join(overrideDir, "security.md"), "# Nested Override\n");

    const nested = path.join(tmp, "sub", "nested");
    fs.mkdirSync(nested, { recursive: true });

    const result = loadGuidance("security", { cwd: nested });
    expect(result.content).toContain("Nested Override");
  });
});
