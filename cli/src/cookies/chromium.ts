import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { getDatabaseConstructor } from "../utils/sqlite-loader.js";
import type { BrowserCookie, BrowserProfile, CookieExtractionResult } from "./types.js";
import {
  deriveChromiumKey,
  decryptChromiumValue,
  getMacOSChromiumPassword,
  getLinuxChromiumPassword,
} from "./crypto.js";
import { logger } from "../utils/logger.js";

interface ChromiumBrowserDef {
  name: string;
  /** Key used for Keychain lookup on macOS. */
  id: string;
  darwin: string;
  linux: string;
}

const BROWSERS: ChromiumBrowserDef[] = [
  {
    name: "Google Chrome",
    id: "chrome",
    darwin: "Google/Chrome",
    linux: "google-chrome",
  },
  {
    name: "Microsoft Edge",
    id: "edge",
    darwin: "Microsoft Edge",
    linux: "microsoft-edge",
  },
  {
    name: "Brave",
    id: "brave",
    darwin: "BraveSoftware/Brave-Browser",
    linux: "BraveSoftware/Brave-Browser",
  },
  {
    name: "Arc",
    id: "arc",
    darwin: "Arc/User Data",
    linux: "arc",
  },
  {
    name: "Opera",
    id: "opera",
    darwin: "com.operasoftware.Opera",
    linux: "opera",
  },
  {
    name: "Vivaldi",
    id: "vivaldi",
    darwin: "Vivaldi",
    linux: "vivaldi",
  },
  {
    name: "Chromium",
    id: "chromium",
    darwin: "Chromium",
    linux: "chromium",
  },
];

/** Detect installed Chromium-based browsers. */
export function detectChromiumBrowsers(): BrowserProfile[] {
  const platform = os.platform();
  if (platform !== "darwin" && platform !== "linux") return [];

  const home = os.homedir();
  const profiles: BrowserProfile[] = [];

  for (const browser of BROWSERS) {
    const baseDir =
      platform === "darwin"
        ? path.join(home, "Library", "Application Support", browser.darwin)
        : path.join(home, ".config", browser.linux);

    const cookiesPath = path.join(baseDir, "Default", "Cookies");
    if (fs.existsSync(cookiesPath)) {
      profiles.push({
        browser: browser.name,
        profilePath: baseDir,
        platform,
      });
    }
  }

  return profiles;
}

/** Extract cookies from a Chromium-based browser profile. */
export function extractChromiumCookies(
  profile: BrowserProfile,
  domain: string,
): CookieExtractionResult {
  const cookiesDbPath = path.join(profile.profilePath, "Default", "Cookies");

  if (!fs.existsSync(cookiesDbPath)) {
    return {
      cookies: [],
      browser: profile.browser,
      profilePath: profile.profilePath,
      error: "Cookies database not found",
    };
  }

  // Copy to temp to avoid locking the active browser's DB
  const tmpPath = path.join(
    os.tmpdir(),
    `skeptic-cookies-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`,
  );

  try {
    fs.copyFileSync(cookiesDbPath, tmpPath);

    // Also copy WAL/SHM if they exist (needed for recent writes)
    for (const suffix of ["-wal", "-shm"]) {
      const src = cookiesDbPath + suffix;
      if (fs.existsSync(src)) {
        fs.copyFileSync(src, tmpPath + suffix);
      }
    }

    const Database = getDatabaseConstructor();
    const db = new Database(tmpPath, { readonly: true });

    // Derive decryption key
    const key = getDecryptionKey(profile);

    const domainPattern = domain.startsWith(".") ? domain : `.${domain}`;
    const rows = db
      .prepare(
        `SELECT host_key, name, encrypted_value, path, expires_utc, is_secure, is_httponly, samesite
         FROM cookies
         WHERE host_key = ? OR host_key = ?`,
      )
      .all(domain, domainPattern) as ChromiumCookieRow[];

    db.close();

    const cookies: BrowserCookie[] = rows.map((row) => ({
      name: row.name,
      value: decryptCookieValue(row.encrypted_value, key),
      domain: row.host_key,
      path: row.path,
      expires: chromiumTimestampToUnix(row.expires_utc),
      secure: row.is_secure === 1,
      httpOnly: row.is_httponly === 1,
      sameSite: SAMESITE_MAP[row.samesite] ?? "Lax",
    }));

    logger.debug(
      `Extracted ${cookies.length} cookies from ${profile.browser}`,
    );

    return { cookies, browser: profile.browser, profilePath: profile.profilePath };
  } catch (err) {
    return {
      cookies: [],
      browser: profile.browser,
      profilePath: profile.profilePath,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    // Clean up temp files
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        fs.unlinkSync(tmpPath + suffix);
      } catch {
        // best-effort cleanup
      }
    }
  }
}

interface ChromiumCookieRow {
  host_key: string;
  name: string;
  encrypted_value: Buffer;
  path: string;
  expires_utc: number;
  is_secure: number;
  is_httponly: number;
  samesite: number;
}

const SAMESITE_MAP: Record<number, BrowserCookie["sameSite"]> = {
  [-1]: "None",
  0: "None",
  1: "Lax",
  2: "Strict",
};

function getDecryptionKey(profile: BrowserProfile): Buffer {
  const browserId =
    BROWSERS.find((b) => b.name === profile.browser)?.id ?? "chrome";

  const password =
    profile.platform === "darwin"
      ? getMacOSChromiumPassword(browserId)
      : getLinuxChromiumPassword();

  if (!password) {
    logger.warn(
      `Could not retrieve encryption key for ${profile.browser}. Cookie values may be empty.`,
    );
    return deriveChromiumKey("peanuts");
  }

  return deriveChromiumKey(password);
}

function decryptCookieValue(encrypted: Buffer, key: Buffer): string {
  if (!encrypted || encrypted.length === 0) return "";
  return decryptChromiumValue(encrypted, key);
}

/**
 * Chromium stores timestamps as microseconds since 1601-01-01.
 * Convert to Unix epoch seconds.
 */
function chromiumTimestampToUnix(microseconds: number): number {
  if (microseconds === 0) return -1; // session cookie
  // Difference between 1601-01-01 and 1970-01-01 in seconds
  const EPOCH_DIFF = 11644473600;
  return Math.round(microseconds / 1_000_000) - EPOCH_DIFF;
}
