# skeptic-cli-bin-darwin-x64

Platform-specific binary distribution for [skeptic-cli](https://github.com/iamjr15/skeptic).

This package is automatically resolved as an `optionalDependencies` of
`skeptic-cli` when installed on darwin-x64. You should not install it directly.

The actual versions of bundled deps (`@playwright/test`,
`accessibility-checker-engine`, `playwright`, `playwright-core`,
`better-sqlite3`) are populated at release time by
`scripts/gen-bin-package.mjs` from the root `package-lock.json`. The
`0.0.0-LOCKFILE` placeholders here are sentinels that fail the publish
job if the version-replace step didn't run.
