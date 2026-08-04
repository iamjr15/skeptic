# Evidence contract

Runs live at `.skeptic/runs/<runId>/manifest.json` and use schema
`skeptic.run/2`. `.skeptic/runs/latest.json` is a pointer, never a symlink.
Session and run journals are append-only NDJSON using `skeptic.event/1`.

Every evidence reference contains:

- `kind`, `mediaType`, and run-relative `relPath`;
- byte count and lowercase SHA-256;
- producer and optional test ID;
- `sensitivity`: `normal` or `sensitive`;
- `redaction`: `none` or `redacted`.

Resolve paths relative to the manifest directory. Reject absolute or parent
traversal paths. Verify size and SHA-256 before trusting a sidecar. Do not upload
`sensitive` evidence unless the user explicitly opted in.

The manifest separates verdict (`outcome`) from collection health
(`completeness`). A passing partial run is not equivalent to a complete pass.
Capability availability and execution are separate; installed-but-not-run does
not count as score coverage.

The score formula is `skeptic.score/1`. Missing categories are `null`, not 100.
Score is informational; blocking findings and test outcomes determine failure.
