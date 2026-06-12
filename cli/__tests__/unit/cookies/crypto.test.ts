import { describe, it, expect } from "vitest";
import { createCipheriv, createHash } from "node:crypto";
import { deriveChromiumKey, decryptChromiumValue } from "../../../src/cookies/crypto.js";

const CHROMIUM_IV = Buffer.alloc(16, 0x20);

/** Mirror Chromium's v10/v11 encryption: AES-128-CBC over an optional
 *  32-byte SHA256(host_key) prefix + the plaintext. */
function encryptChromium(plaintext: string, key: Buffer, hostKey?: string): Buffer {
  const prefix = hostKey
    ? createHash("sha256").update(hostKey).digest()
    : Buffer.alloc(0);
  const cipher = createCipheriv("aes-128-cbc", key, CHROMIUM_IV);
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.concat([prefix, Buffer.from(plaintext, "utf-8")])),
    cipher.final(),
  ]);
  return Buffer.concat([Buffer.from("v10", "ascii"), ciphertext]);
}

describe("decryptChromiumValue", () => {
  const key = deriveChromiumKey("peanuts");

  it("strips the 32-byte SHA256(host_key) prefix on M127+ values", () => {
    const hostKey = "example.com";
    const encrypted = encryptChromium("session=abc123", key, hostKey);
    expect(decryptChromiumValue(encrypted, key, hostKey)).toBe("session=abc123");
  });

  it("returns garbage-prefixed value when host_key is not supplied (regression guard)", () => {
    const hostKey = "example.com";
    const encrypted = encryptChromium("session=abc123", key, hostKey);
    const out = decryptChromiumValue(encrypted, key);
    // Without the host_key the 32-byte hash cannot be detected/stripped, so the
    // real value is buried after 32 bytes of binary — proves the prefix exists.
    expect(out.endsWith("session=abc123")).toBe(true);
    expect(out).not.toBe("session=abc123");
  });

  it("decrypts pre-M127 values (no prefix) without stripping", () => {
    const encrypted = encryptChromium("token=xyz", key);
    // host_key passed, but no prefix present → hash won't match → no strip.
    expect(decryptChromiumValue(encrypted, key, "example.com")).toBe("token=xyz");
  });

  it("returns plaintext for unencrypted (non-v10/v11) values", () => {
    const plain = Buffer.from("plainvalue", "utf-8");
    expect(decryptChromiumValue(plain, key, "example.com")).toBe("plainvalue");
  });
});
