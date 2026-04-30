import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { getDatabaseConstructor } from "../utils/sqlite-loader.js";
import type { BrowserCookie, BrowserProfile, CookieExtractionResult } from "./types.js";
import { logger } from "../utils/logger.js";

/** Detect installed Firefox profiles. */
export function detectFirefoxProfiles(): BrowserProfile[] {
  const platform = os.platform();
  if (platform !== "darwin" && platform !== "linux") return [];

  const home = os.homedir();
  const profilesDir =
    platform === "darwin"
      ? path.join(home, "Library", "Application Support", "Firefox", "Profiles")
      : path.join(home, ".mozilla", "firefox");

  const iniPath =
    platform === "darwin"
      ? path.join(home, "Library", "Application Support", "Firefox", "profiles.ini")
      : path.join(home, ".mozilla", "firefox", "profiles.ini");

  if (!fs.existsSync(iniPath)) return [];

  const defaultProfile = findDefaultProfile(iniPath, profilesDir);
  if (!defaultProfile) return [];

  return [
    {
      browser: "Firefox",
      profilePath: defaultProfile,
      platform,
    },
  ];
}

/** Extract cookies from a Firefox profile. */
export function extractFirefoxCookies(
  profile: BrowserProfile,
  domain: string,
): CookieExtractionResult {
  const cookiesDbPath = path.join(profile.profilePath, "cookies.sqlite");

  if (!fs.existsSync(cookiesDbPath)) {
    return {
      cookies: [],
      browser: "Firefox",
      profilePath: profile.profilePath,
      error: "cookies.sqlite not found",
    };
  }

  const tmpPath = path.join(
    os.tmpdir(),
    `skeptic-ff-cookies-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`,
  );

  try {
    fs.copyFileSync(cookiesDbPath, tmpPath);

    for (const suffix of ["-wal", "-shm"]) {
      const src = cookiesDbPath + suffix;
      if (fs.existsSync(src)) {
        fs.copyFileSync(src, tmpPath + suffix);
      }
    }

    const Database = getDatabaseConstructor();
    const db = new Database(tmpPath, { readonly: true });

    const domainPattern = domain.startsWith(".") ? domain : `.${domain}`;
    const rows = db
      .prepare(
        `SELECT host, name, value, path, expiry, isSecure, isHttpOnly, sameSite
         FROM moz_cookies
         WHERE host = ? OR host = ?`,
      )
      .all(domain, domainPattern) as FirefoxCookieRow[];

    db.close();

    const cookies: BrowserCookie[] = rows.map((row) => ({
      name: row.name,
      value: row.value,
      domain: row.host,
      path: row.path,
      expires: row.expiry,
      secure: row.isSecure === 1,
      httpOnly: row.isHttpOnly === 1,
      sameSite: FF_SAMESITE_MAP[row.sameSite] ?? "None",
    }));

    logger.debug(`Extracted ${cookies.length} cookies from Firefox`);

    return { cookies, browser: "Firefox", profilePath: profile.profilePath };
  } catch (err) {
    return {
      cookies: [],
      browser: "Firefox",
      profilePath: profile.profilePath,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        fs.unlinkSync(tmpPath + suffix);
      } catch {
        // best-effort cleanup
      }
    }
  }
}

interface FirefoxCookieRow {
  host: string;
  name: string;
  value: string;
  path: string;
  expiry: number;
  isSecure: number;
  isHttpOnly: number;
  sameSite: number;
}

const FF_SAMESITE_MAP: Record<number, BrowserCookie["sameSite"]> = {
  0: "None",
  1: "Lax",
  2: "Strict",
};

/**
 * Parse profiles.ini to find the default profile directory.
 * Looks for Default=1 or the first profile with IsRelative + Path.
 */
function findDefaultProfile(
  iniPath: string,
  baseDir: string,
): string | null {
  const content = fs.readFileSync(iniPath, "utf-8");
  const sections = content.split(/\[Profile\d+\]/);

  for (const section of sections) {
    const lines = section.split("\n");
    const props: Record<string, string> = {};

    for (const line of lines) {
      const eqIdx = line.indexOf("=");
      if (eqIdx > 0) {
        const key = line.slice(0, eqIdx).trim();
        const val = line.slice(eqIdx + 1).trim();
        props[key] = val;
      }
    }

    if (props["Default"] === "1" && props["Path"]) {
      const profilePath =
        props["IsRelative"] === "1"
          ? path.join(baseDir, props["Path"])
          : props["Path"];
      if (fs.existsSync(profilePath)) return profilePath;
    }
  }

  // Fallback: find any profile with cookies.sqlite
  if (fs.existsSync(baseDir)) {
    try {
      const entries = fs.readdirSync(baseDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const candidate = path.join(baseDir, entry.name, "cookies.sqlite");
          if (fs.existsSync(candidate)) {
            return path.join(baseDir, entry.name);
          }
        }
      }
    } catch {
      // permission denied, etc.
    }
  }

  return null;
}
