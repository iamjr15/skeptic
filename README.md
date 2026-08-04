# Skeptic

Skeptic is an agent-native QA toolkit for web apps, Android devices, and iOS
Simulators. It combines semantic browser/device control, a TypeScript E2E
runner, React and React Native diagnosis, accessibility and network audits,
visual regression, durable evidence, and a report-oriented terminal UI.

Skeptic is deterministic infrastructure: it contains no model, requires no AI
API key, and does not interpret page or app text as instructions. Claude Code,
Codex, another coding agent, or a human can drive the same CLI and inspect the
same versioned artifacts.

## Install

```bash
npm install -g skeptic-cli
skeptic --version
skeptic manifest --format json
```

Native bundles are published for macOS arm64/x64, Linux glibc arm64/x64,
Linux musl arm64/x64, and Windows x64. Windows arm64 uses the Windows x64
bundle through the OS compatibility layer. The npm launcher verifies GitHub
Release downloads against `SHA256SUMS` when an optional platform package is
unavailable.

Build from source with Rust 1.94 or newer:

```bash
cargo build --workspace
cargo test --workspace
```

## Browser QA

Skeptic attaches to an existing debug-enabled Chromium when available and
keeps a warm named session:

```bash
skeptic --session checkout open http://localhost:3000/checkout
skeptic --session checkout snapshot -i -c
skeptic --session checkout click @e3
skeptic --session checkout snapshot -i -c
skeptic --session checkout audit --format json
skeptic --session checkout network requests --format json
skeptic --session checkout visual check checkout-main --selector main
skeptic --session checkout close
```

Element refs are deterministic but expire after navigation or meaningful DOM
changes. Re-snapshot before using them again; stale refs fail as `E_STALE_REF`
instead of silently targeting another element.

## TypeScript specs

```bash
skeptic scaffold tests/checkout.spec.ts
skeptic run
skeptic run tests/checkout.spec.ts --format junit --output skeptic-junit.xml
```

Each spec file runs in its own embedded V8 isolate with no filesystem or
subprocess API. Local TypeScript/JavaScript/JSON imports are allowed inside the
project; the virtual `skeptic-cli` module supplies `test`, hooks, `expect`, and
`page`/`device`. The sandbox includes real timers, `URL`, text encoding, Web
Crypto, and policy-gated `fetch`. Files run in parallel up to available CPU
concurrency, with retries, shards, per-test timeouts, a V8 watchdog, and
parent-process kill fallback. Use `test.use({ session, platform, device, app })`
to select a shared named web or mobile session. Evidence follows that actual
session: web runs collect network, console, accessibility, web-vitals, HAR,
and failure images; mobile failures collect their device snapshot and
screenshot. Structured assertion failures carry those evidence references in
the run manifest and live NDJSON journal.

## Doctor

```bash
skeptic doctor .
skeptic doctor . --scope changed --base main
skeptic doctor . --deep --allow-project-commands
skeptic doctor why correctness/no-array-index-key
skeptic doctor . --format sarif --output skeptic-doctor.sarif
```

Doctor uses in-process Oxc analysis, curated React/React Native/security/a11y
checks, advisory custom YAML regex packs, stable baseline fingerprints,
TypeScript, Dart, SwiftLint, existing Android Lint/detekt SARIF reports, and
supervised SARIF or NDJSON analyzer workers. Project commands are opt-in.

## Mobile

```bash
skeptic devices --format json

# Android
skeptic mobile setup android
skeptic --session app open com.example.app --platform android --device emulator-5554
skeptic --session app snapshot
skeptic --session app click @e4
skeptic mobile screenrecord .skeptic/manual/android.mp4 --duration 10 --device emulator-5554
skeptic mobile gfxinfo com.example.app --device emulator-5554
skeptic mobile logcat .skeptic/manual/logcat.txt --device emulator-5554
skeptic --session app close

# iOS Simulator
skeptic mobile setup ios --install
skeptic --session app open com.example.app --platform ios-sim --device <UDID>
skeptic --session app snapshot
skeptic --session app click @e4
skeptic mobile screenrecord .skeptic/manual/ios.mp4 --platform ios-sim --device <UDID>
skeptic mobile xctrace .skeptic/manual/profile.trace --device <UDID> --duration 10
skeptic --session app close
```

Android uses ADB with a permanent `uiautomator dump` snapshot path; no APK is
installed for normal control. Non-ASCII text is sent only through ADBKeyboard.
iOS support targets Simulator,
using checksum-pinned AXe 1.7.1 for accessibility/HID and `simctl io` for media.
Native accessibility helpers support an explicitly authorized Android ATF
instrumentation APK and XCUITest `performAccessibilityAudit` suites.

## Reports and agent skills

```bash
skeptic report
skeptic report --format json --output skeptic-report.json
skeptic report --format sarif --output skeptic-report.sarif
skeptic score --explain
skeptic skills list
skeptic skills get core --full
skeptic add skill
skeptic add github-action
```

The terminal report is the primary human interface and its TUI is intentionally
report-only. JSON is for agents and SARIF is for CI. Scores are coverage-aware:
a category with no successful capability is shown as unscored rather than
silently treated as perfect. Reports fold static findings, test outcomes,
session markers, and runtime evidence through versioned correlators.

## Stable automation contract

- `--format` chooses the representation; `--output` is always a file path.
- stdout is data, stderr is diagnostics.
- JSON responses use a stable success/error envelope; SARIF, JUnit, and NDJSON
  remain native formats.
- Exit codes and commands are discoverable with `skeptic manifest --format json`.
- Run bundles live in `.skeptic/runs/<runId>/`; tracked visual baselines live
  in `skeptic/baselines/`.
- Network, console, and device-log secrets are redacted before persistence.
  Pixel evidence is marked sensitive and omitted from CI unless explicitly
  allowed.

The implementation blueprint and architecture decisions are in
[docs/v2/blueprint.md](docs/v2/blueprint.md). Analyzer configuration is covered
in [docs/analyzers.md](docs/analyzers.md), and CI setup in
[docs/github-actions.md](docs/github-actions.md).

## License

Skeptic is MIT licensed. Vendored and embedded components retain their own
licenses and attribution; see [NOTICE](NOTICE) and [LICENSES](LICENSES/).
