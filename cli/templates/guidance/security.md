---
name: security
description: Client-side security posture — secrets exposure, XSS surface, auth state assertions.
version: 1.0.0
---

# Security Testing Guidance

E2E isn't a substitute for a proper security audit, but it's the last line of defense against silent regressions that a scanner wouldn't catch.

## Things worth asserting

- [ ] Auth tokens never appear in `document.cookie` without `HttpOnly`. Use `page.evaluate` to read cookies — anything that reads as a bearer should be flagged.
- [ ] Error pages don't leak stack traces, env vars, or internal paths. Use `ai.assertNoDefects()` or `ai.assert(...)` with a prompt that explicitly flags "stack trace visible to user".
- [ ] Logged-out state flushes client-side state: after clicking Logout, assert every protected route redirects to sign-in.
- [ ] Forms with sensitive input have `autocomplete` set appropriately (`off` for OTP/2FA, `current-password` for login, `new-password` for signup).

## Test patterns

Verify sanitization on user-provided content:

```ts
await page.getByTestId("comment-input").fill("<script>window.__xss__=true</script>");
await page.getByRole("button", { name: "Submit" }).click();
await expect(page.getByTestId("comment")).toBeVisible();
await expect(page.evaluate(() => (window as typeof window & { __xss__?: boolean }).__xss__)).resolves.toBeUndefined();
```

Check that a copy-to-clipboard of a token is the token, not a placeholder:

```ts
await page.getByTestId("copy-api-key").click();
const key = await page.getByTestId("api-key-display").innerText();
expect(key).toMatch(/^sk_[A-Za-z0-9_]+$/);
```

## Red flags — file a bug

- API responses visible in DevTools network tab that embed PII in URLs (should be request body + HTTPS).
- `dangerouslySetInnerHTML` on user-controlled strings (React) — E2E cannot prove absence; add a unit test.
- Hash fragment containing session state after login (bookmarkable session).
- Third-party script loading before consent in EU locale profiles.
