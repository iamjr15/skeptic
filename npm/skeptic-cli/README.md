# skeptic-cli

Native package wrapper and TypeScript spec API for Skeptic v2. The package
selects platform binaries from optional dependencies and falls back to a
checksum-verified GitHub Release download.

Each native platform package contains the complete runtime: `skeptic`,
`skeptic-runner`, `skeptic-doctor`, `skeptic-mobile`, and `skeptic-report`.

Specs import `test`, `expect`, hooks, and `page` from `skeptic-cli`. They run in
an embedded, filesystem-free V8 isolate; local relative modules are supported,
while npm imports other than the virtual `skeptic-cli` module are intentionally
not supported in 2.0.

See the repository README for browser, Doctor, mobile, report, and CI usage.
