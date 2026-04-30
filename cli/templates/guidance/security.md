---
name: security
description: Client-side security posture — secrets exposure, XSS surface, auth state assertions.
version: 1.0.0
---

# Security Testing Guidance

E2E isn't a substitute for a proper security audit, but it's the last line of defense against silent regressions that a scanner wouldn't catch.

## Things worth asserting

- [ ] Auth tokens never appear in `document.cookie` without `HttpOnly`. Use `evalScript` to read cookies — anything that reads as a bearer should be flagged.
- [ ] Error pages don't leak stack traces, env vars, or internal paths. Use `assertNoDefects` or `assertWithAI` with a prompt that explicitly flags "stack trace visible to user".
- [ ] Logged-out state flushes client-side state: after `click: "Logout"`, assert every protected route redirects to sign-in.
- [ ] Forms with sensitive input have `autocomplete` set appropriately (`off` for OTP/2FA, `current-password` for login, `new-password` for signup).

## Flow patterns

Verify sanitization on user-provided content:

```yaml
- type:
    selector: "[data-testid=comment-input]"
    value: "<script>window.__xss__=true</script>"
- click: "Submit"
- waitForElement: "[data-testid=comment]"
- evalScript: |
    return window.__xss__ === undefined;
- assertVisible: "[data-testid=comment]"
```

Check that a copy-to-clipboard of a token is the token, not a placeholder:

```yaml
- click: "[data-testid=copy-api-key]"
- copyTextFrom:
    selector: "[data-testid=api-key-display]"
    variable: KEY
# Later: assert KEY matches an expected shape via assertWithAI.
```

## Red flags — file a bug

- API responses visible in DevTools network tab that embed PII in URLs (should be request body + HTTPS).
- `dangerouslySetInnerHTML` on user-controlled strings (React) — the flow can't prove absence; add a unit test.
- Hash fragment containing session state after login (bookmarkable session).
- Third-party script loading before consent in EU locale profiles.
