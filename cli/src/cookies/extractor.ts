import * as fs from "node:fs";
import * as path from "node:path";
import type { BrowserContext } from "playwright";
import type { BrowserCookie, BrowserProfile, CookieExtractionResult } from "./types.js";
import { detectChromiumBrowsers, extractChromiumCookies } from "./chromium.js";
import { detectFirefoxProfiles, extractFirefoxCookies } from "./firefox.js";
import { detectSafariProfile, extractSafariCookies } from "./safari.js";
import { logger } from "../utils/logger.js";
import { PRODUCT_NAME } from "../constants.js";

const COOKIES_CONSENT_FILE = ".skeptic/.cookies-consent";

/** Detect all installed browsers that we can extract cookies from. */
export function detectBrowsers(): BrowserProfile[] {
  return [
    ...detectChromiumBrowsers(),
    ...detectFirefoxProfiles(),
    ...detectSafariProfile(),
  ];
}

export interface ExtractCookiesOptions {
  /** Only extract from these browser names (e.g. ["Google Chrome", "Firefox"]). */
  browsers?: string[];
}

/**
 * Extract cookies for a domain from all detected browsers.
 * Merges and dedupes (latest expiry wins for same name+domain).
 */
export function extractCookies(
  domain: string,
  options: ExtractCookiesOptions = {},
): CookieExtractionResult[] {
  let profiles = detectBrowsers();

  if (options.browsers && options.browsers.length > 0) {
    const allowed = new Set(options.browsers.map((b) => b.toLowerCase()));
    profiles = profiles.filter((p) => allowed.has(p.browser.toLowerCase()));
  }

  if (profiles.length === 0) {
    logger.warn("No supported browsers detected for cookie extraction");
    return [];
  }

  logger.info(
    `${PRODUCT_NAME} is reading cookies for ${domain} from: ${profiles.map((p) => p.browser).join(", ")}`,
  );

  const results: CookieExtractionResult[] = [];

  for (const profile of profiles) {
    const result = extractFromProfile(profile, domain);
    results.push(result);

    if (result.error) {
      logger.warn(`${profile.browser}: ${result.error}`);
    }
  }

  return results;
}

/** Merge cookies from multiple results, deduping by name+domain (latest expiry wins). */
export function mergeCookies(
  results: CookieExtractionResult[],
): BrowserCookie[] {
  const map = new Map<string, BrowserCookie>();

  for (const result of results) {
    for (const cookie of result.cookies) {
      const key = `${cookie.name}|${cookie.domain}`;
      const existing = map.get(key);
      if (!existing || cookie.expires > existing.expires) {
        map.set(key, cookie);
      }
    }
  }

  return [...map.values()];
}

/**
 * Extract cookies and inject them into a Playwright BrowserContext.
 * This is the main integration point for the engine.
 */
/**
 * Show a first-use notice about cookie extraction.
 * Returns true if consent was already given or just recorded.
 */
export function cookiesFirstUseNotice(): boolean {
  const consentPath = path.resolve(process.cwd(), COOKIES_CONSENT_FILE);
  if (fs.existsSync(consentPath)) return true;

  logger.warn(
    `${PRODUCT_NAME} cookie extraction reads browser cookie databases on your machine.\n` +
    `  Cookies are injected into test browser contexts and never leave your machine.\n` +
    `  This notice will not be shown again.`,
  );

  const dir = path.dirname(consentPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(consentPath, new Date().toISOString(), "utf-8");
  return true;
}

export async function extractAndInjectCookies(
  context: BrowserContext,
  domain: string,
  options: ExtractCookiesOptions = {},
): Promise<number> {
  cookiesFirstUseNotice();
  const results = extractCookies(domain, options);
  const merged = mergeCookies(results);

  if (merged.length === 0) {
    logger.debug(`No cookies found for ${domain}`);
    return 0;
  }

  // Convert to Playwright cookie format
  const playwrightCookies = merged.map((c) => ({
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path,
    expires: c.expires > 0 ? c.expires : undefined,
    secure: c.secure,
    httpOnly: c.httpOnly,
    sameSite: c.sameSite as "Strict" | "Lax" | "None",
  }));

  await context.addCookies(playwrightCookies);
  logger.success(`Injected ${playwrightCookies.length} cookies for ${domain}`);

  return playwrightCookies.length;
}

function extractFromProfile(
  profile: BrowserProfile,
  domain: string,
): CookieExtractionResult {
  if (profile.browser === "Firefox") {
    return extractFirefoxCookies(profile, domain);
  }
  if (profile.browser === "Safari") {
    return extractSafariCookies(profile, domain);
  }
  // All others are Chromium-based
  return extractChromiumCookies(profile, domain);
}
