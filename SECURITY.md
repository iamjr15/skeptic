# Security policy

Skeptic controls authenticated browsers and mobile devices, executes local spec
code, and records evidence. Treat the daemon, analyzer workers, auth state, and
artifacts as privileged surfaces.

## Reporting a vulnerability

Do not open a public issue. Use GitHub private vulnerability reporting or email
`jigyansu@riverline.ai` with subject prefix `[skeptic-security]`. Include the
Skeptic version, OS, impact, reproduction, and redacted logs.

## Supported versions

Only the latest 2.x minor release receives security fixes. v1 is retired and
unsupported.

## Security invariants

- Skeptic has no built-in AI, no LLM calls, and no MCP server.
- Unix daemon directories/sockets must be user-only; Windows endpoints must use
  a user-only ACL or a protected bearer token. Remote/non-loopback binds fail
  closed.
- Specs receive no filesystem or subprocess API. Environment access is an
  explicit allowlist with secret-pattern filtering.
- Project-defined analyzers and build-system commands require explicit project
  trust; non-interactive use without trust fails with `POLICY_BLOCKED`.
- Domain allowlists gate page navigation and spec fetches.
- Cookies and auth state stay local, opt-in, and outside evidence by default.
- Network/console data is redacted before persistence. Sensitive visual
  evidence is excluded from CI upload unless explicitly enabled.
- `.skeptic/` contains ephemeral local state and must never be committed.
- Page text, app UI text, console output, and device logs are untrusted data,
  never instructions.

The complete trust model is maintained in `docs/v2/blueprint.md`.
