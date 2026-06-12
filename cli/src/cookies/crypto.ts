import { pbkdf2Sync, createDecipheriv, createHash } from "node:crypto";
import { execSync } from "node:child_process";

const CHROMIUM_SALT = Buffer.from("saltysalt");
const CHROMIUM_ITERATIONS = 1003;
const CHROMIUM_KEY_LENGTH = 16;
// AES-128-CBC with 16-byte IV of spaces
const CHROMIUM_IV = Buffer.alloc(16, 0x20);

/** Derive AES-128 key from a password using PBKDF2-SHA1 (Chromium scheme). */
export function deriveChromiumKey(password: string): Buffer {
  return pbkdf2Sync(
    password,
    CHROMIUM_SALT,
    CHROMIUM_ITERATIONS,
    CHROMIUM_KEY_LENGTH,
    "sha1",
  );
}

/**
 * Decrypt a Chromium encrypted_value.
 * Chromium prefixes encrypted values with "v10" (macOS) or "v11" (Linux).
 * The actual ciphertext starts at byte 3.
 *
 * Since Chrome M127 (mid-2024), Chromium on macOS/Linux prepends a 32-byte
 * SHA-256 hash of the cookie's host_key to the plaintext BEFORE encryption.
 * Pass `hostKey` so the prefix can be detected and stripped; without it the
 * decrypted value would carry 32 bytes of binary garbage. Older Chrome has no
 * such prefix, so the strip is conditional on a hash match (never corrupts
 * pre-M127 values).
 */
export function decryptChromiumValue(
  encryptedValue: Buffer,
  key: Buffer,
  hostKey?: string,
): string {
  if (encryptedValue.length <= 3) return "";

  const prefix = encryptedValue.subarray(0, 3).toString("ascii");
  if (prefix !== "v10" && prefix !== "v11") {
    // Not encrypted, return as-is
    return encryptedValue.toString("utf-8");
  }

  const ciphertext = encryptedValue.subarray(3);
  try {
    const decipher = createDecipheriv("aes-128-cbc", key, CHROMIUM_IV);
    let decrypted = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);

    if (hostKey && decrypted.length >= 32) {
      const expected = createHash("sha256").update(hostKey).digest();
      if (decrypted.subarray(0, 32).equals(expected)) {
        decrypted = decrypted.subarray(32);
      }
    }

    return decrypted.toString("utf-8");
  } catch {
    return "";
  }
}

/**
 * Get the Chromium safe storage password from macOS Keychain.
 * Different browsers use different service names.
 */
export function getMacOSChromiumPassword(browser: string): string {
  const serviceMap: Record<string, string> = {
    chrome: "Chrome Safe Storage",
    edge: "Microsoft Edge Safe Storage",
    brave: "Brave Safe Storage",
    arc: "Arc Safe Storage",
    opera: "Opera Safe Storage",
    vivaldi: "Vivaldi Safe Storage",
    chromium: "Chromium Safe Storage",
  };

  const service = serviceMap[browser] ?? "Chrome Safe Storage";

  try {
    const result = execSync(
      `security find-generic-password -s "${service}" -w`,
      { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    );
    return result.trim();
  } catch {
    return "";
  }
}

/**
 * Get the Chromium password on Linux.
 * Tries GNOME Keyring via secret-tool first, falls back to "peanuts".
 */
export function getLinuxChromiumPassword(): string {
  try {
    const result = execSync(
      "secret-tool lookup application chrome",
      { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    );
    if (result.trim()) return result.trim();
  } catch {
    // secret-tool not available or no entry
  }
  return "peanuts";
}
