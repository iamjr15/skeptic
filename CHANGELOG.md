# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [2.0.0] - 2026-07-20

Skeptic v2 is a from-scratch, Rust-native QA engine. It replaces v1 without a
compatibility layer.

### Added

- Agent Browser-compatible CDP automation with live-Chrome auto-connect,
  semantic snapshots and refs, browser actions, diffs, policy controls, and
  structured v2 response envelopes.
- An embedded-V8 TypeScript test runner with in-process oxc type stripping,
  `test`/`expect`/`page`, isolation, retries, sharding, hard timeouts, JSON,
  NDJSON, and JUnit reporting.
- An in-process oxc Doctor with stable diagnostic identities, baselines,
  changed-file scope, SARIF, explainable rules, optional supervised analyzers,
  and native TypeScript, Dart, SwiftLint, Android Lint, and detekt integration.
- Versioned run manifests, append-only journals, marker transcripts, redacted
  console/network evidence, accessibility audits, performance evidence, video,
  and visual baseline/diff artifacts.
- Unified Android and iOS Simulator QA verbs, screenshots and recordings,
  mobile performance/log evidence, and opt-in platform accessibility helpers.
- Coverage-aware deterministic scoring, evidence correlation, terminal/JSON/SARIF
  reports, and the report-oriented terminal UI.
- Embedded, version-locked agent skills plus the npx-skills layout, GitHub
  Action workflow, schemas, npm native packages for seven targets, Homebrew
  formula generation, checksums, SBOMs, and build attestations.

### Changed

- Began the Skeptic v2 Rust rebuild and removed the v1 TypeScript/Playwright
  implementation without a compatibility layer.
- Vendored and rebranded the Agent Browser v0.32.2 Rust CDP/session foundation
  with Apache-2.0 attribution.
- Added the native `deno_core` runner spike, seven-platform npm package
  skeleton, Rust CI/release workflows, and v2-only repository guidance.
- Resolved the rusty_v8 149.4.0 musl archive gap by applying Deno's upstream
  V8 150.2.0 compatibility delta to the vendored runtime crates; added an
  enforced seven-target V8 build and native-smoke workflow.

### Removed

- Removed the standalone local web dashboard, its embedded frontend, and the
  per-session live WebSocket viewport stream. Skeptic's human interface is the
  report-oriented terminal UI; screenshots, video, traces, and machine-readable
  CI evidence remain opt-in artifacts rather than alternative interfaces.

## [1.0.1] - 2026-06-14

Release-infrastructure only — no runtime or API changes; `skeptic-cli@1.0.1` is
functionally identical to `1.0.0`.

### Changed

- **npm publishing now uses OIDC Trusted Publishing** instead of a long-lived
  `NPM_TOKEN`. The release workflow exchanges GitHub Actions' OIDC identity for a
  short-lived, per-publish credential (provenance is generated automatically), so
  there is no publish token to expire or leak.

### Fixed

- **Release CI no longer wedges on the Playwright browser download.** The release
  workflow restores the same cached Chromium that CI builds — with `restore-keys`
  so a version bump doesn't force a cold re-download — and bounds the install with
  a timeout + retry, fixing a hang where `playwright install` stalled after a
  100%-complete download under Node 24.

## [1.0.0] - 2026-06-13

First stable release. skeptic now drives **web, Android, and iOS simulators** as
co-equal platforms through one skill + CLI + daemon — the same `test`/`expect`, the
same runner, the same `results.json` — with no MCP and no model of its own.

### Added

- **Android driver (`--platform android`)** — driver-less device automation via
  `adb` + `uiautomator` (no Appium/Maestro). Interactive verbs, `skeptic run`
  against a device/emulator (the `device` spec fixture), and `skeptic scaffold`.
- **iOS simulator driver (`--platform ios-sim`)** — driver-less via `simctl` + `axe`
  (the maintained idb-framework redistribution: reads the accessibility tree and
  injects HID taps — no WebDriverAgent, no in-app test bundle). Same verbs, `run`,
  and `scaffold`. macOS + full Xcode + `axe` (`brew install cameroncooke/axe/axe`)
  required; real iOS devices are out of scope (axe/idb UI automation is sim-only).
- **`device` spec fixture** — `test("…", async ({ device }) => …)` drives a device
  via snapshot → `@eN`/selectorHint → act, sharing the runner/reporting/evidence
  pipeline with the web `page` fixture. Misusing `page`/`device` across platforms
  throws a clear, actionable error.
- **Mobile evidence collectors** (Android) — performance (gfxinfo jank + meminfo PSS
  + `am start -W` launch timings), accessibility (uiautomator structural heuristics),
  network (degraded per-uid totals), console (logcat), and video (screenrecord) —
  surfaced in `results.json` and the html/console reporters.
- **New CLI verbs** — `scroll`, `is <visible|enabled|checked>`, broadened `get`,
  device-evidence `perf`/`a11y`/`network`/`record`, and `devices` (lists connected
  Android devices + booted iOS simulators). `skeptic doctor` probes adb/simctl/axe.
- **`-t, --grep <substring>`** — run only tests whose name contains a substring.
- **Skill-evals harness** (`cli/evals/`) — scores SKILL.md compliance by running real
  `claude -p` / `codex exec` sessions against the bundled skill (the skill is the only
  front door now, so it's a standing quality gate).
- **Blank-capture detection** — flags a near-uniform device screenshot with the
  emulator GPU-mode remediation (`-gpu swiftshader_indirect`) instead of silently
  saving a blank image.

### Changed

- The runner generalized from a Playwright-only path to a shared device path
  (`runOneTestDevice`); `--platform`/`--target` thread through `run`, the interactive
  session daemon, `scaffold`, `devices`, and `doctor`.
- Mobile metrics render in the console metrics line, keyed distinctly from the
  web shapes.

### Fixed

- `skeptic add skill` resolved the wrong bundled-skill path from the flat dist and
  rewrote a stale `EMBEDDED_SKILL_MD` fallback that reintroduced the removed
  MCP/AI/`generate` surface (and clobbered good installs). Purged the last
  `--ai`/`--provider`/`ai`-fixture and `ai.*` references from docs and code.
- Sharded runs no longer spuriously exit 1 on an empty/over-provisioned shard slice.
- Enum flags (`--blank-frame-detection`, `wait --state`, `--platform`) validate input
  instead of silently degrading on a typo.
- Restored `fast-xml-parser` (used by the Android driver) after it was wrongly dropped
  as "unused"; fixed two integration tests that soft-returned green without asserting.

### Known issues

- `npm audit` reports transitive advisories on `esbuild` (via `tsx`, the spec loader,
  and the `tsup`/`vitest` build/test toolchain). They are **not applicable** to
  skeptic's usage — they concern Deno-only install integrity and the Windows
  `esbuild serve` dev server, which skeptic never runs (it uses esbuild's transform
  API). The patched esbuild line (≥ 0.28.1) is currently incompatible with the spec
  loader, so it's tracked for a follow-up rather than forced.

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

[Unreleased]: https://github.com/iamjr15/skeptic/compare/v2.0.0...HEAD
[2.0.0]: https://github.com/iamjr15/skeptic/compare/v1.0.1...v2.0.0
[1.0.1]: https://github.com/iamjr15/skeptic/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/iamjr15/skeptic/compare/v0.2.1...v1.0.0
[0.2.1]: https://github.com/iamjr15/skeptic/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/iamjr15/skeptic/releases/tag/v0.2.0
