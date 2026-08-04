# Analyzer workers

`skeptic doctor --deep` runs detected TypeScript, Dart, and SwiftLint adapters,
ingests existing Android Lint/detekt SARIF reports, and runs analyzers declared
in `skeptic.toml`. Analyzer processes are supervised, time-limited, given
Skeptic's filtered environment, cached by configuration hash, and parsed as
SARIF 2.1 or Skeptic diagnostic NDJSON.

Project commands are a trust boundary. Configured analyzers do not run unless
the user supplies `--allow-project-commands`. Repository configuration is never
treated as consent, including `policy.allowProjectCommands`.

```toml
[policy]
allowProjectCommands = false

[analyzers.security]
command = ["osv-scanner", "scan", "--format", "sarif", "-r", "."]
format = "sarif"
capability = "security"
required = false
timeoutMs = 120000
trustProject = false

[analyzers.android-lint]
command = ["./gradlew", "lintDebug", "--console=plain"]
format = "sarif"
capability = "android"
required = false
timeoutMs = 300000
trustProject = true
```

Commands must emit their report to stdout. When a tool writes only to a file,
wrap it in a checked-in script that runs the tool and then prints its SARIF or
NDJSON file. The same protocol supports detekt, Android Lint, SwiftLint,
`xcresulttool` exporters, Dart Analyzer bridges, and osv-scanner without
linking those ecosystems into Skeptic.

`skeptic doctor analyzers list` reports project detection, tool availability,
and whether each built-in executes or ingests an existing report. `xcresult`
is intentionally explicit: export its results to JSON/SARIF and pass the file
with `--ingest`, because an `.xcresult` bundle may contain much more data than
source diagnostics.

Each NDJSON line must be one canonical Diagnostic object (raw or inside a
Skeptic response envelope). SARIF
locations, levels, rule ids, messages, and fixes are normalized into that
contract. Required analyzer failure is fatal; optional failure is reported as
partial capability coverage rather than silently swallowed.

Analyzer cache keys include the resolved configuration, command, analyzer
version, and source-content digest. Cache writes are atomic and child output
uses unique run-scoped files, so concurrent scans cannot cross-contaminate.

Use `skeptic doctor env` to inspect host tool availability, `skeptic doctor
analyzers list`, and `skeptic config show --format json` before granting
execution.
