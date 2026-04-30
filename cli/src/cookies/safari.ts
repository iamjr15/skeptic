import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { BrowserCookie, BrowserProfile, CookieExtractionResult } from "./types.js";
import { logger } from "../utils/logger.js";

const COOKIES_PATH = "Library/Cookies/Cookies.binarycookies";

/** Detect Safari (macOS only). */
export function detectSafariProfile(): BrowserProfile[] {
  if (os.platform() !== "darwin") return [];

  const cookiesPath = path.join(os.homedir(), COOKIES_PATH);
  if (!fs.existsSync(cookiesPath)) return [];

  return [
    {
      browser: "Safari",
      profilePath: cookiesPath,
      platform: "darwin",
    },
  ];
}

/**
 * Extract cookies from Safari's Cookies.binarycookies file.
 *
 * Binary format:
 *   - 4 bytes: magic "cook"
 *   - 4 bytes BE: number of pages
 *   - N x 4 bytes BE: page sizes
 *   - Pages, each containing:
 *     - 4 bytes LE: page header (0x00000100)
 *     - 4 bytes LE: number of cookies
 *     - N x 4 bytes LE: cookie offsets
 *     - 4 bytes: page end (0x00000000)
 *     - Cookie records
 *
 * Cookie record:
 *   - 4 bytes LE: record size
 *   - 4 bytes LE: flags (1=secure, 4=httponly)
 *   - 4 bytes LE: padding
 *   - 4 bytes LE: url offset
 *   - 4 bytes LE: name offset
 *   - 4 bytes LE: path offset
 *   - 4 bytes LE: value offset
 *   - 8 bytes: comment (unused)
 *   - 8 bytes LE double: expiry (Mac epoch = 2001-01-01)
 *   - 8 bytes LE double: creation
 *   - Null-terminated strings at offsets
 */
export function extractSafariCookies(
  profile: BrowserProfile,
  domain: string,
): CookieExtractionResult {
  try {
    const data = fs.readFileSync(profile.profilePath);

    const magic = data.subarray(0, 4).toString("ascii");
    if (magic !== "cook") {
      return {
        cookies: [],
        browser: "Safari",
        profilePath: profile.profilePath,
        error: "Invalid binarycookies file (bad magic)",
      };
    }

    const numPages = data.readUInt32BE(4);
    const pageSizes: number[] = [];
    for (let i = 0; i < numPages; i++) {
      pageSizes.push(data.readUInt32BE(8 + i * 4));
    }

    let offset = 8 + numPages * 4;
    const allCookies: BrowserCookie[] = [];

    for (let p = 0; p < numPages; p++) {
      const pageData = data.subarray(offset, offset + pageSizes[p]!);
      const pageCookies = parsePage(pageData);
      allCookies.push(...pageCookies);
      offset += pageSizes[p]!;
    }

    // Filter by domain
    const domainClean = domain.startsWith(".") ? domain.slice(1) : domain;
    const filtered = allCookies.filter(
      (c) =>
        c.domain === domainClean ||
        c.domain === `.${domainClean}` ||
        c.domain.endsWith(`.${domainClean}`),
    );

    logger.debug(`Extracted ${filtered.length} cookies from Safari`);

    return { cookies: filtered, browser: "Safari", profilePath: profile.profilePath };
  } catch (err) {
    return {
      cookies: [],
      browser: "Safari",
      profilePath: profile.profilePath,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function parsePage(page: Buffer): BrowserCookie[] {
  // Skip 4-byte page header
  const numCookies = page.readUInt32LE(4);
  const cookies: BrowserCookie[] = [];

  const cookieOffsets: number[] = [];
  for (let i = 0; i < numCookies; i++) {
    cookieOffsets.push(page.readUInt32LE(8 + i * 4));
  }

  for (const cookieOffset of cookieOffsets) {
    try {
      const cookie = parseCookieRecord(page, cookieOffset);
      if (cookie) cookies.push(cookie);
    } catch {
      // Skip malformed cookie records
    }
  }

  return cookies;
}

function parseCookieRecord(
  page: Buffer,
  offset: number,
): BrowserCookie | null {
  const flags = page.readUInt32LE(offset + 4);
  const urlOffset = page.readUInt32LE(offset + 16);
  const nameOffset = page.readUInt32LE(offset + 20);
  const pathOffset = page.readUInt32LE(offset + 24);
  const valueOffset = page.readUInt32LE(offset + 28);

  // Expiry is a Mac epoch double at offset+40
  const expiryMac = page.readDoubleLE(offset + 40);
  // Mac epoch is 2001-01-01, Unix epoch is 1970-01-01 — diff is 978307200 seconds
  const expiryUnix = Math.round(expiryMac + 978307200);

  const domain = readNullTerminated(page, offset + urlOffset);
  const name = readNullTerminated(page, offset + nameOffset);
  const cookiePath = readNullTerminated(page, offset + pathOffset);
  const value = readNullTerminated(page, offset + valueOffset);

  if (!name || !domain) return null;

  return {
    name,
    value,
    domain,
    path: cookiePath || "/",
    expires: expiryUnix,
    secure: (flags & 0x1) !== 0,
    httpOnly: (flags & 0x4) !== 0,
    sameSite: "None",
  };
}

function readNullTerminated(buf: Buffer, offset: number): string {
  const end = buf.indexOf(0, offset);
  if (end === -1) return buf.subarray(offset).toString("utf-8");
  return buf.subarray(offset, end).toString("utf-8");
}
