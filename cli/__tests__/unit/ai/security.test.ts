import { describe, it, expect, afterEach, vi, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

describe("AI security", () => {
  describe("checkAIEnabled", () => {
    it("throws when client is undefined", async () => {
      const { checkAIEnabled } = await import("../../../src/ai/security.js");
      expect(() => checkAIEnabled(undefined)).toThrow(/No API key configured/);
    });

    it("does not throw when client is provided", async () => {
      const { checkAIEnabled } = await import("../../../src/ai/security.js");
      const mockClient = {
        provider: "gemini" as const,
        analyzeImage: async () => "",
        generateText: async () => "",
      };
      expect(() => checkAIEnabled(mockClient)).not.toThrow();
    });
  });

  describe("missingClientMessage", () => {
    it("defaults to gemini when no provider given", async () => {
      const { missingClientMessage } = await import("../../../src/ai/security.js");
      const msg = missingClientMessage();
      expect(msg).toContain('provider "gemini"');
      expect(msg).toContain("GEMINI_API_KEY");
    });

    it("names the openai env var when provider is openai", async () => {
      const { missingClientMessage } = await import("../../../src/ai/security.js");
      const msg = missingClientMessage({ provider: "openai" });
      expect(msg).toContain('provider "openai"');
      expect(msg).toContain("OPENAI_API_KEY");
      expect(msg).not.toContain("GEMINI_API_KEY");
    });

    it("names the anthropic env var when provider is anthropic", async () => {
      const { missingClientMessage } = await import("../../../src/ai/security.js");
      const msg = missingClientMessage({ provider: "anthropic" });
      expect(msg).toContain('provider "anthropic"');
      expect(msg).toContain("ANTHROPIC_API_KEY");
    });

    it("includes guidance on switching providers", async () => {
      const { missingClientMessage } = await import("../../../src/ai/security.js");
      const msg = missingClientMessage({ provider: "gemini" });
      expect(msg).toContain("ai.provider");
    });
  });

  describe("firstUseWarning", () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "skeptic-security-"));
      vi.spyOn(process, "cwd").mockReturnValue(tmpDir);
    });

    afterEach(() => {
      vi.restoreAllMocks();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it("creates per-provider consent file on first call", async () => {
      const { firstUseWarning } = await import("../../../src/ai/security.js");
      const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      firstUseWarning("gemini");

      const consentPath = path.join(tmpDir, ".skeptic/.ai-consent-gemini");
      expect(fs.existsSync(consentPath)).toBe(true);
      consoleSpy.mockRestore();
    });

    it("tracks consent separately per provider", async () => {
      const { firstUseWarning } = await import("../../../src/ai/security.js");
      const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      firstUseWarning("gemini");
      firstUseWarning("openai");
      firstUseWarning("anthropic");

      expect(fs.existsSync(path.join(tmpDir, ".skeptic/.ai-consent-gemini"))).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, ".skeptic/.ai-consent-openai"))).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, ".skeptic/.ai-consent-anthropic"))).toBe(true);
      consoleSpy.mockRestore();
    });

    it("emits a provider-specific warning message", async () => {
      const { firstUseWarning } = await import("../../../src/ai/security.js");
      const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      firstUseWarning("openai");

      const allOutput = consoleSpy.mock.calls.flat().join(" ");
      expect(allOutput).toContain("openai");
      expect(allOutput).toContain("api.openai.com");
      consoleSpy.mockRestore();
    });

    it("returns true when consent file already exists (no warning shown)", async () => {
      const consentDir = path.join(tmpDir, ".skeptic");
      fs.mkdirSync(consentDir, { recursive: true });
      fs.writeFileSync(path.join(consentDir, ".ai-consent-gemini"), "2024-01-01", "utf-8");

      const { firstUseWarning } = await import("../../../src/ai/security.js");
      const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const result = firstUseWarning("gemini");

      expect(result).toBe(true);
      expect(consoleSpy).not.toHaveBeenCalled();
      consoleSpy.mockRestore();
    });
  });

  describe("filterDiffPaths", () => {
    it("returns diff unchanged when no exclude patterns", async () => {
      const { filterDiffPaths } = await import("../../../src/ai/security.js");
      const diff = "diff --git a/src/app.ts b/src/app.ts\n+console.log('hello');\n";
      expect(filterDiffPaths(diff, [])).toBe(diff);
    });

    it("excludes basename patterns with *.env*", async () => {
      const { filterDiffPaths } = await import("../../../src/ai/security.js");
      const diff = [
        "diff --git a/server.env.local b/server.env.local",
        "+SECRET=abc",
        "diff --git a/src/app.ts b/src/app.ts",
        "+console.log('hello');",
      ].join("\n");

      const result = filterDiffPaths(diff, ["*.env*"]);
      expect(result).not.toContain("SECRET=abc");
      expect(result).toContain("console.log('hello')");
    });

    it("excludes *.key files", async () => {
      const { filterDiffPaths } = await import("../../../src/ai/security.js");
      const diff = [
        "diff --git a/certs/api.key b/certs/api.key",
        "+-----BEGIN PRIVATE KEY-----",
        "diff --git a/src/main.ts b/src/main.ts",
        "+import { foo } from './bar';",
      ].join("\n");

      const result = filterDiffPaths(diff, ["*.key"]);
      expect(result).not.toContain("BEGIN PRIVATE KEY");
      expect(result).toContain("import { foo }");
    });

    it("excludes *.pem files", async () => {
      const { filterDiffPaths } = await import("../../../src/ai/security.js");
      const diff = [
        "diff --git a/deployment.pem b/deployment.pem",
        "+-----BEGIN CERTIFICATE-----",
        "diff --git a/src/index.ts b/src/index.ts",
        "+export default {};",
      ].join("\n");

      const result = filterDiffPaths(diff, ["*.pem"]);
      expect(result).not.toContain("BEGIN CERTIFICATE");
      expect(result).toContain("export default");
    });

    it("excludes secrets/ directory (trailing slash normalized to secrets/**)", async () => {
      const { filterDiffPaths } = await import("../../../src/ai/security.js");
      const diff = [
        "diff --git a/secrets/tokens.json b/secrets/tokens.json",
        "+{\"token\": \"supersecret\"}",
        "diff --git a/src/main.ts b/src/main.ts",
        "+import { foo } from './bar';",
      ].join("\n");

      const result = filterDiffPaths(diff, ["secrets/"]);
      expect(result).not.toContain("supersecret");
      expect(result).toContain("import { foo }");
    });

    it("matches all default schema patterns simultaneously", async () => {
      const { filterDiffPaths } = await import("../../../src/ai/security.js");
      const diff = [
        "diff --git a/server.env.local b/server.env.local",
        "+FOO=1",
        "diff --git a/certs/api.key b/certs/api.key",
        "+KEYDATA",
        "diff --git a/deployment.pem b/deployment.pem",
        "+PEMDATA",
        "diff --git a/secrets/tokens.json b/secrets/tokens.json",
        "+TOKENDATA",
        "diff --git a/src/keep.ts b/src/keep.ts",
        "+export default 1;",
      ].join("\n");

      const result = filterDiffPaths(diff, ["*.env*", "secrets/", "*.key", "*.pem"]);
      expect(result).not.toContain("FOO=1");
      expect(result).not.toContain("KEYDATA");
      expect(result).not.toContain("PEMDATA");
      expect(result).not.toContain("TOKENDATA");
      expect(result).toContain("export default 1");
    });
  });
});
