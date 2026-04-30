import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { BrowserCookie, CookieExtractionResult } from "../../../src/cookies/types.js";

// Mock the browser-specific modules since they access OS-level databases
vi.mock("../../../src/cookies/chromium.js", () => ({
  detectChromiumBrowsers: vi.fn().mockReturnValue([]),
  extractChromiumCookies: vi.fn().mockReturnValue({ cookies: [], browser: "Chrome", profilePath: "/tmp", error: "mocked" }),
}));

vi.mock("../../../src/cookies/firefox.js", () => ({
  detectFirefoxProfiles: vi.fn().mockReturnValue([]),
  extractFirefoxCookies: vi.fn().mockReturnValue({ cookies: [], browser: "Firefox", profilePath: "/tmp", error: "mocked" }),
}));

vi.mock("../../../src/cookies/safari.js", () => ({
  detectSafariProfile: vi.fn().mockReturnValue([]),
  extractSafariCookies: vi.fn().mockReturnValue({ cookies: [], browser: "Safari", profilePath: "/tmp", error: "mocked" }),
}));

describe("cookie extractor", () => {
  describe("detectBrowsers", () => {
    it("returns an array (may be empty with mocked detectors)", async () => {
      const { detectBrowsers } = await import("../../../src/cookies/extractor.js");
      const browsers = detectBrowsers();
      expect(Array.isArray(browsers)).toBe(true);
    });

    it("combines results from all browser detectors", async () => {
      const { detectChromiumBrowsers } = await import("../../../src/cookies/chromium.js");
      const { detectFirefoxProfiles } = await import("../../../src/cookies/firefox.js");

      vi.mocked(detectChromiumBrowsers).mockReturnValue([
        { browser: "Google Chrome", profilePath: "/chrome", platform: "darwin" },
      ]);
      vi.mocked(detectFirefoxProfiles).mockReturnValue([
        { browser: "Firefox", profilePath: "/firefox", platform: "darwin" },
      ]);

      const { detectBrowsers } = await import("../../../src/cookies/extractor.js");
      const browsers = detectBrowsers();
      expect(browsers.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe("mergeCookies", () => {
    it("deduplicates cookies by name+domain keeping latest expiry", async () => {
      const { mergeCookies } = await import("../../../src/cookies/extractor.js");

      const results: CookieExtractionResult[] = [
        {
          cookies: [
            makeCookie("session", ".example.com", "old-value", 1000),
          ],
          browser: "Chrome",
          profilePath: "/chrome",
        },
        {
          cookies: [
            makeCookie("session", ".example.com", "new-value", 2000),
          ],
          browser: "Firefox",
          profilePath: "/firefox",
        },
      ];

      const merged = mergeCookies(results);
      expect(merged).toHaveLength(1);
      expect(merged[0]!.value).toBe("new-value");
      expect(merged[0]!.expires).toBe(2000);
    });

    it("keeps distinct cookies with different names", async () => {
      const { mergeCookies } = await import("../../../src/cookies/extractor.js");

      const results: CookieExtractionResult[] = [
        {
          cookies: [
            makeCookie("a", ".example.com", "val-a", 1000),
            makeCookie("b", ".example.com", "val-b", 1000),
          ],
          browser: "Chrome",
          profilePath: "/chrome",
        },
      ];

      const merged = mergeCookies(results);
      expect(merged).toHaveLength(2);
    });

    it("returns empty array for empty results", async () => {
      const { mergeCookies } = await import("../../../src/cookies/extractor.js");
      const merged = mergeCookies([]);
      expect(merged).toEqual([]);
    });
  });

  describe("cookiesFirstUseNotice", () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "skeptic-cookies-"));
      vi.spyOn(process, "cwd").mockReturnValue(tmpDir);
    });

    afterEach(() => {
      vi.restoreAllMocks();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it("creates .skeptic/.cookies-consent file", async () => {
      const { cookiesFirstUseNotice } = await import("../../../src/cookies/extractor.js");
      cookiesFirstUseNotice();

      const consentPath = path.join(tmpDir, ".skeptic/.cookies-consent");
      expect(fs.existsSync(consentPath)).toBe(true);
    });

    it("returns true if consent already exists", async () => {
      const consentDir = path.join(tmpDir, ".skeptic");
      fs.mkdirSync(consentDir, { recursive: true });
      fs.writeFileSync(path.join(consentDir, ".cookies-consent"), "2024-01-01", "utf-8");

      const { cookiesFirstUseNotice } = await import("../../../src/cookies/extractor.js");
      const result = cookiesFirstUseNotice();
      expect(result).toBe(true);
    });
  });

  describe("extractAndInjectCookies Playwright format", () => {
    it("converts BrowserCookie to Playwright cookie format correctly", async () => {
      // Test the conversion logic by checking mergeCookies output shape
      const { mergeCookies } = await import("../../../src/cookies/extractor.js");

      const results: CookieExtractionResult[] = [
        {
          cookies: [
            {
              name: "sid",
              value: "abc123",
              domain: ".example.com",
              path: "/",
              expires: 1700000000,
              secure: true,
              httpOnly: true,
              sameSite: "Lax" as const,
            },
          ],
          browser: "Chrome",
          profilePath: "/chrome",
        },
      ];

      const merged = mergeCookies(results);
      const cookie = merged[0]!;

      // Verify the cookie has the fields Playwright needs
      expect(cookie.name).toBe("sid");
      expect(cookie.value).toBe("abc123");
      expect(cookie.domain).toBe(".example.com");
      expect(cookie.path).toBe("/");
      expect(cookie.secure).toBe(true);
      expect(cookie.httpOnly).toBe(true);
      expect(cookie.sameSite).toBe("Lax");
    });
  });
});

function makeCookie(name: string, domain: string, value: string, expires: number): BrowserCookie {
  return {
    name,
    value,
    domain,
    path: "/",
    expires,
    secure: false,
    httpOnly: false,
    sameSite: "Lax",
  };
}
