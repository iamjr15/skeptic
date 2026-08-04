import { expect, test } from "skeptic-cli";

test("standard web globals are available", async () => {
  const url = new URL("/qa?mode=full", "https://skeptic.dev");
  expect(url.href).toBe("https://skeptic.dev/qa?mode=full");

  const bytes = new TextEncoder().encode("skeptic");
  expect(new TextDecoder().decode(bytes)).toBe("skeptic");

  const random = new Uint8Array(16);
  crypto.getRandomValues(random);
  expect(random.some((byte) => byte !== 0)).toBeTruthy();

  const digest = await crypto.subtle.digest("SHA-256", bytes);
  expect(digest.byteLength).toBe(32);
});
