# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
While skeptic is pre-1.0 (`0.x`), minor versions may carry breaking changes.

## [Unreleased]

## [0.2.1] - 2026-05-07

### Fixed

- **Cookie decryption (Chrome M127+).** Chromium ≥ M127 prepends a 32-byte
  SHA-256 hash of the cookie's `host_key` to the plaintext before encryption.
  Decryption now detects and strips that prefix (conditional on a hash match,
  so pre-M127 values are never corrupted) instead of returning 32 bytes of
  binary garbage.
- **Page-error capture.** The console collector now listens for the Playwright
  `pageerror` event (uncaught exceptions / unhandled rejections), which is
  surfaced separately from `console` — so genuine runtime errors are no longer
  silently dropped from observability output.
- **Network request duration.** Request duration is now derived from
  Playwright's `responseEnd` resource-timing value, with a guard that leaves
  the duration undefined when timing is uninitialized (`responseEnd < 0`) or
  the request never started, instead of emitting a bogus value.

### Security

- Ran `npm audit fix` (non-force) to clear dev-tooling advisories: the critical
  Vitest UI arbitrary file read/execute (GHSA-5xrq-8626-4rwp), the
  `brace-expansion` ReDoS/DoS (GHSA-jxxr-4gwj-5jf2), and the `ws` uninitialized
  memory disclosure (GHSA-58qx-3vcg-4xpx). `npm audit` now reports zero
  vulnerabilities.

## [0.2.0] - 2026-05-07

### Removed — BREAKING

skeptic is now **agent-native**: a skill, a CLI, and a daemon. The built-in
"intelligence" layer is gone — the host coding agent supplies it.

- **MCP server** — the `skeptic mcp` command and the `browser_*` /
  `list_tests` / `generate_test` / `run_test` MCP tool surface (and `src/mcp`)
  were removed.
- **ACP server** — the `skeptic acp` Agent Client Protocol server (and
  `src/acp`) was removed.
- **Built-in AI/model subsystem** — the entire `src/ai` subsystem (Gemini /
  OpenAI / Anthropic adapters) was removed. skeptic no longer reads
  `GEMINI_API_KEY` / `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` or any
  `SKEPTIC_AI_*` variable, and makes no outbound LLM calls.
- **`skeptic generate`** — AI-backed spec generation (`--message`, `--diff`)
  was removed.
- **AI flags and fixtures** — `skeptic run --analyze`, the run-level
  `--connect` CDP-attach flag, `skeptic add github-action --ai/--provider`, and
  the `ai.*` test fixture helpers (`ai.assert`, `ai.assertNoDefects`,
  `ai.extract`) were removed.
- Orphaned dependencies for the deleted subsystems were dropped:
  `@modelcontextprotocol/sdk`, `@agentclientprotocol/sdk`,
  `@google/generative-ai`, `@faker-js/faker`, and `oxc-resolver`.
  (`fast-xml-parser` was later re-introduced by the Android adb driver to parse
  uiautomator dumps, so it remains a bundled dependency.)

> Note: `skeptic inspect --connect <url>` (CDP auto-discovery and attach for
> page inspection) is unrelated to the removed AI attach flow and remains
> supported.

### Changed

- skeptic requires **no API keys** and makes **no LLM calls of its own**.
  Intelligence comes from the host coding agent; skeptic is the deterministic
  execution and evidence layer it drives through the bundled skill and CLI.

[Unreleased]: https://github.com/iamjr15/skeptic/compare/v0.2.1...HEAD
[0.2.1]: https://github.com/iamjr15/skeptic/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/iamjr15/skeptic/releases/tag/v0.2.0
