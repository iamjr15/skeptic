# Skeptic Doctor parity and 2.0 readiness audit

Date: 2026-07-20

Inputs: the current Skeptic Doctor implementation and React Doctor commit
`7c9dbeda0db7212a98a5c0945ff1675c51806e21` in `skeptic-refs`.

## Post-remediation verdict

The release pack is intentionally smaller than React Doctor, but it is now a
credible high-confidence 2.0 analyzer. Skeptic parses source with Oxc, uses
semantic binding identity where names can be shadowed, reports honest partial
coverage, and keeps advisory/custom output outside scoring and CI.

The release registry contains eleven focused checks across security,
accessibility, correctness, performance, maintainability, and React Native.
The noisy raw-text checks found in the first audit were removed instead of
being shipped under misleading engine metadata.

## Remediation evidence

- Global `eval`/`Function`, React Native imports, iterator-index keys, Web
  Storage calls, imports, and JSX attributes are evaluated from AST nodes;
  binding-sensitive checks use Oxc semantic references.
- Inline justified suppressions are retained as suppressed findings. Tests,
  stories, and fixtures are classified as non-production and remain visible
  without becoming release blockers.
- Diagnostic fingerprints exclude file/line location. Occurrence identity and
  context hashes preserve exact, moved, existing, and fixed baseline states.
- `score` is absent from Doctor output by design. The report layer scores only
  rule IDs and categories backed by successful capability records.
- The supervised analyzer path uses unique scratch output, process timeouts,
  filtered environments, content-aware cache keys, atomic cache writes, and
  strict SARIF 2.1/NDJSON validation.
- `--deep` has built-in TypeScript, Dart, and SwiftLint execution adapters,
  existing Android Lint/detekt SARIF ingestion, explicit xcresult ingestion,
  and configured SARIF/NDJSON workers behind project-command consent.
- The top-level CLI exposes `doctor`, `why`, `env`, `baseline update`,
  `analyzers list`, `--blocking`, `--fix-plan`, and `--ingest` without falling
  through to the old environment-repair command.

## Regression result

The Doctor crate currently runs nine active tests: seven source/baseline
regressions and two native-analyzer parser tests. Direct scans of React
Doctor's referenced no-eval and removed no-outline regression harnesses emit
zero false positives because source examples inside strings are not code.

The release fixture contains explicit positive and negative cases for every
registered rule. It protects shadowed identifiers, type-only imports,
unrelated component names, sanitizer boundaries, spread-attribute uncertainty,
server-only imports, and actual iterator binding identity.

## Deliberate scope boundaries

- Skeptic does not claim parity with React Doctor's rule count. The 2.0 pack
  favors evidence-backed checks with low false-positive risk.
- Custom YAML packs are advisory regex patterns, not ast-grep. They are labeled
  and documented that way and never affect score or CI.
- Whole-project dead-export analysis is not claimed in 2.0. Type checking and
  external analyzers cover that ecosystem boundary until a module-graph
  implementation has equivalent regression discipline.
- React Doctor output can still be normalized with `--ingest`; Skeptic does
  not require it at runtime.

## Verification commands

```text
cargo test -p skeptic-doctor
cargo test -p skeptic-cli --test doctor_cli
skeptic doctor <fixture> --format json --blocking none
skeptic doctor analyzers list
skeptic doctor why security/no-eval
```
