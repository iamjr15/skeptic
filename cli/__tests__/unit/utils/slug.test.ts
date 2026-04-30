import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { slugify, uniqueSlug } from "../../../src/utils/slug.js";

describe("slug utilities", () => {
  describe("slugify", () => {
    it("lowercases and replaces non-alphanumeric with dashes", () => {
      expect(slugify("Login Flow")).toBe("login-flow");
    });

    it("collapses multiple separators", () => {
      expect(slugify("My  App / Test")).toBe("my-app-test");
    });

    it("neutralizes path traversal", () => {
      expect(slugify("../evil/name")).toBe("evil-name");
      expect(slugify("/etc/passwd")).toBe("etc-passwd");
    });

    it("falls back to 'flow' for punctuation-only input", () => {
      expect(slugify("!!!")).toBe("flow");
    });

    it("falls back to 'flow' for non-ASCII input", () => {
      expect(slugify("🚀")).toBe("flow");
    });

    it("falls back to 'flow' for empty string", () => {
      expect(slugify("")).toBe("flow");
    });

    it("trims leading and trailing dashes", () => {
      expect(slugify("  hello  ")).toBe("hello");
      expect(slugify("--hello--")).toBe("hello");
    });
  });

  describe("uniqueSlug", () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "skeptic-slug-"));
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it("returns the base slug when no file exists", () => {
      expect(uniqueSlug("login", tmpDir)).toBe("login");
    });

    it("appends -2 when base file exists", () => {
      fs.writeFileSync(path.join(tmpDir, "login.yaml"), "", "utf-8");
      expect(uniqueSlug("login", tmpDir)).toBe("login-2");
    });

    it("appends -3 when both base and -2 exist", () => {
      fs.writeFileSync(path.join(tmpDir, "login.yaml"), "", "utf-8");
      fs.writeFileSync(path.join(tmpDir, "login-2.yaml"), "", "utf-8");
      expect(uniqueSlug("login", tmpDir)).toBe("login-3");
    });

    it("handles fallback slug collisions", () => {
      fs.writeFileSync(path.join(tmpDir, "flow.yaml"), "", "utf-8");
      expect(uniqueSlug("!!!", tmpDir)).toBe("flow-2");
    });

    it("slugifies input before checking collisions", () => {
      fs.writeFileSync(path.join(tmpDir, "login-flow.yaml"), "", "utf-8");
      expect(uniqueSlug("Login Flow", tmpDir)).toBe("login-flow-2");
    });
  });
});
