import { describe, expect, it } from "vitest";
import { redactUrl } from "../../../src/observability/url-redact.js";

describe("redactUrl — pass-throughs", () => {
  it("returns unchanged when there is no query string", () => {
    expect(redactUrl("https://example.com/path")).toBe("https://example.com/path");
  });

  it("preserves URL fragment", () => {
    expect(redactUrl("https://example.com/path?token=abc#section")).toBe(
      "https://example.com/path?token=***#section",
    );
  });

  it("returns unchanged for data: URIs", () => {
    expect(redactUrl("data:image/png;base64,abc?token=foo")).toBe(
      "data:image/png;base64,abc?token=foo",
    );
  });

  it("returns unchanged for blob: URIs", () => {
    expect(redactUrl("blob:https://example.com/abc?token=x")).toBe(
      "blob:https://example.com/abc?token=x",
    );
  });

  it("returns unchanged when no params match the redact list", () => {
    expect(redactUrl("https://example.com/?safe=1&page=2")).toBe(
      "https://example.com/?safe=1&page=2",
    );
  });

  it("handles empty input gracefully", () => {
    expect(redactUrl("")).toBe("");
  });

  it("handles trailing question mark with no query", () => {
    expect(redactUrl("https://example.com/?")).toBe("https://example.com/?");
  });
});

describe("redactUrl — exact-match defaults", () => {
  it("redacts ?token=abc", () => {
    expect(redactUrl("https://example.com/?token=abc")).toBe(
      "https://example.com/?token=***",
    );
  });

  it("redacts ?password=p", () => {
    expect(redactUrl("https://example.com/?password=secret")).toBe(
      "https://example.com/?password=***",
    );
  });

  it("redacts ?authorization=Bearer%20...", () => {
    expect(redactUrl("https://example.com/?authorization=Bearer%20xyz")).toBe(
      "https://example.com/?authorization=***",
    );
  });

  it("preserves safe params alongside redacted ones", () => {
    expect(redactUrl("https://example.com/?safe=1&token=abc&also=ok")).toBe(
      "https://example.com/?safe=1&token=***&also=ok",
    );
  });

  it("is case-insensitive on names", () => {
    expect(redactUrl("https://example.com/?Authorization=xyz")).toBe(
      "https://example.com/?Authorization=***",
    );
    expect(redactUrl("https://example.com/?TOKEN=xyz")).toBe(
      "https://example.com/?TOKEN=***",
    );
  });

  it("redacts every occurrence when name appears multiple times", () => {
    expect(redactUrl("https://example.com/?token=a&token=b")).toBe(
      "https://example.com/?token=***&token=***",
    );
  });

  it("redacts the bare 'key' name (Google Maps Static)", () => {
    expect(redactUrl("https://maps.googleapis.com/maps/api/staticmap?center=x&key=YOUR_API_KEY")).toBe(
      "https://maps.googleapis.com/maps/api/staticmap?center=x&key=***",
    );
  });

  it("redacts session-related names", () => {
    expect(redactUrl("https://example.com/?sessionid=xyz")).toBe(
      "https://example.com/?sessionid=***",
    );
    expect(redactUrl("https://example.com/?session_id=xyz")).toBe(
      "https://example.com/?session_id=***",
    );
  });
});

describe("redactUrl — vendor-prefixed (suffix-match)", () => {
  it("redacts AWS SigV4 X-Amz-Signature", () => {
    expect(redactUrl("https://s3.amazonaws.com/bucket?X-Amz-Signature=abc")).toBe(
      "https://s3.amazonaws.com/bucket?X-Amz-Signature=***",
    );
  });

  it("redacts X-Amz-Credential", () => {
    expect(redactUrl("https://s3.amazonaws.com/?X-Amz-Credential=AKIAEXAMPLE")).toBe(
      "https://s3.amazonaws.com/?X-Amz-Credential=***",
    );
  });

  it("redacts X-Amz-Security-Token", () => {
    expect(redactUrl("https://s3.amazonaws.com/?X-Amz-Security-Token=xyz")).toBe(
      "https://s3.amazonaws.com/?X-Amz-Security-Token=***",
    );
  });

  it("redacts GCP X-Goog-Signature", () => {
    expect(redactUrl("https://storage.googleapis.com/bucket?X-Goog-Signature=abc")).toBe(
      "https://storage.googleapis.com/bucket?X-Goog-Signature=***",
    );
  });

  it("is case-insensitive for vendor-prefixed names", () => {
    expect(redactUrl("https://s3.amazonaws.com/?x-amz-signature=abc")).toBe(
      "https://s3.amazonaws.com/?x-amz-signature=***",
    );
  });

  it("hyphen/underscore equivalence: X_Amz_Signature redacted same as X-Amz-Signature", () => {
    expect(redactUrl("https://s3.amazonaws.com/?X_Amz_Signature=abc")).toBe(
      "https://s3.amazonaws.com/?X_Amz_Signature=***",
    );
  });

  it("redacts custom vendor token suffix (e.g. acme-token)", () => {
    expect(redactUrl("https://example.com/?acme-token=xyz")).toBe(
      "https://example.com/?acme-token=***",
    );
  });
});

describe("redactUrl — false-positive guards", () => {
  it("?lookup=foo is NOT redacted (no separator before 'key' or any other suffix)", () => {
    expect(redactUrl("https://example.com/?lookup=foo")).toBe(
      "https://example.com/?lookup=foo",
    );
  });

  it("?subkey=x is NOT redacted (bare 'key' is exact-match-only; no separator before 'key')", () => {
    expect(redactUrl("https://example.com/?subkey=x")).toBe(
      "https://example.com/?subkey=x",
    );
  });

  it("?linkkey=x is NOT redacted (no separator)", () => {
    expect(redactUrl("https://example.com/?linkkey=x")).toBe(
      "https://example.com/?linkkey=x",
    );
  });

  it("?link_key=x IS redacted (separator present)", () => {
    expect(redactUrl("https://example.com/?link_key=x")).toBe(
      "https://example.com/?link_key=***",
    );
  });

  it("?network=foo is NOT redacted", () => {
    expect(redactUrl("https://example.com/?network=foo")).toBe(
      "https://example.com/?network=foo",
    );
  });

  it("?somesignature=foo IS redacted (suffix match without separator? — must NOT match)", () => {
    // No separator before 'signature' — must NOT match the suffix tier.
    expect(redactUrl("https://example.com/?somesignature=foo")).toBe(
      "https://example.com/?somesignature=foo",
    );
  });

  it("?some-signature=foo IS redacted (separator present)", () => {
    expect(redactUrl("https://example.com/?some-signature=foo")).toBe(
      "https://example.com/?some-signature=***",
    );
  });
});
