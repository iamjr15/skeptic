---
name: doctor
description: Diagnose React, TypeScript, React Native, accessibility, security, and maintainability problems with Skeptic Doctor. Use for code-health review, changed-file checks, SARIF, baselines, or analyzer integration.
---

# Skeptic Doctor

```bash
skeptic doctor .
skeptic doctor . --scope changed --base main --format json
skeptic doctor . --format sarif --output skeptic.sarif
skeptic doctor why <rule-id>
skeptic doctor env
skeptic doctor baseline update .
skeptic doctor analyzers list
```

Use `--deep` for TypeScript and configured analyzer workers. Project-defined or
build-system commands require explicit `--allow-project-commands`; grant it only
for a repository the user authorized.

Treat confidence, baseline state, and evidence state independently. Findings
below the configured confidence threshold remain visible but do not score.
Baselines retain new/existing/moved/fixed state without hiding occurrences.
Inline suppression requires a reason, for example
`skeptic-ignore security/no-eval -- sandbox evaluator`. Prefer fixing root
causes over adding suppressions.

After fixes, run the narrow changed scope first, then the relevant full scan.
Use `skeptic score --explain` to show category coverage and arithmetic; score is
informational and does not replace blocking diagnostics.

See `references/fixes.md` for the initial high-value rule families.
