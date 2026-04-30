import { describe, it, expect } from "vitest";
import { redactConsoleText } from "../../../src/observability/url-redact.js";

describe("redactConsoleText", () => {
  it("masks JWT-like tokens", () => {
    const input = "Token leaked: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c done";
    const out = redactConsoleText(input);
    expect(out).not.toContain("eyJhbGc");
    expect(out).toContain("[REDACTED]");
  });

  it("masks Bearer tokens", () => {
    const input = "Headers: Authorization: Bearer abc123def456ghi789jkl012";
    const out = redactConsoleText(input);
    expect(out).not.toContain("abc123def456ghi789jkl012");
    expect(out).toMatch(/Bearer \[REDACTED\]/);
  });

  it("masks credential key/value pairs", () => {
    const input = `password=hunter2 api_key=sk-abc123XYZ secret="my-secret-token"`;
    const out = redactConsoleText(input);
    expect(out).not.toContain("hunter2");
    expect(out).not.toContain("sk-abc123XYZ");
    expect(out).not.toContain("my-secret-token");
    expect(out).toContain("[REDACTED]");
  });

  it("redacts email local-parts but keeps the domain", () => {
    const input = "User: alice@example.com signed in";
    const out = redactConsoleText(input);
    expect(out).toContain("[EMAIL]@example.com");
    expect(out).not.toContain("alice@");
  });

  it("delegates URL redaction to redactUrl", () => {
    const input = "Calling https://api.example.com/endpoint?token=abc123&q=hello";
    const out = redactConsoleText(input);
    expect(out).toContain("token=***");
  });

  it("truncates output past 4 KB", () => {
    const input = "X".repeat(8000);
    const out = redactConsoleText(input);
    expect(out.length).toBeLessThanOrEqual(4 * 1024 + 1); // allow trailing ellipsis
    expect(out.endsWith("…")).toBe(true);
  });

  it("returns clean strings unchanged", () => {
    const input = "Hello world, no secrets here.";
    expect(redactConsoleText(input)).toBe(input);
  });
});
