# Releasing skeptic CLI

## Distribution model

`npm install -g skeptic-cli` is the **primary** distribution. npm picks the
matching `skeptic-cli-bin-<platform>` from `optionalDependencies` and the
launcher shim (`bin/launcher.mjs`) spawns the prebuilt binary. If the
platform isn't covered, the launcher falls back to the bundled JS at
`dist/skeptic.mjs` running on the user's Node.

Current binary targets are `darwin-arm64`, `linux-x64`, `linux-arm64`, and
`win32-x64`. Other platforms, including Intel macOS, use the JS fallback.

Direct binary downloads are **secondary**: same artifacts re-uploaded to
GitHub Releases for users without Node, or for `brew install` via the
Homebrew tap.

## Cutting a release

1. Make sure `main` is green.
2. Tag with the new version:
   ```sh
   git tag v0.2.0
   git push --tags
   ```
3. CI does the rest:
   - **bundle** job: bumps versions on `cli/` + release-target bin packages,
     verifies `skeptic --version` matches the tag, runs `npm pack --dry-run`.
   - **binary-build** matrix: builds SEA binaries on macos-14 (arm64),
     ubuntu-22.04 (x64), ubuntu-22.04-arm (arm64), and windows-2022 (x64).
     macOS binaries use an ad-hoc signature only.
   - **smoke-test** matrix: runs `--version`, `init`, `browsers install`,
     `inspect`, and (on macOS) `cookies list` to verify the native sidecar
     loads.
   - **publish**: pushes all `skeptic-cli-bin-*` packages to npm, then the
     main `skeptic-cli` package, then creates the GitHub Release with all 4
     tarballs attached.

A successful release takes ~12 minutes.

## Required secrets

Configure these in **Settings → Secrets and variables → Actions**:

| Secret | Purpose |
|---|---|
| `NPM_TOKEN` | `npm publish` for `skeptic-cli` + 4x `skeptic-cli-bin-*` |

## Version stamping

`tsup` substitutes `__SKEPTIC_CLI_VERSION__` from `cli/package.json` into the
bundle at build time. The release workflow bumps `cli/package.json` and each
release-target bin package **before** running the build, then asserts
`node dist/skeptic.mjs --version` equals the tag. Forgetting to bump fails the
build loudly rather than silently shipping a stale-version binary.

## Bin-package versions

Each `cli-bin-<platform>/package.json` has `0.0.0-LOCKFILE` placeholders
for `@playwright/test`, `accessibility-checker-engine`, `playwright`,
`playwright-core`, and `better-sqlite3`.
The CI step `Stamp bin-package version` runs
`scripts/gen-bin-package.mjs --bin-pkg <dir> --version <tag>`, which reads
`cli/package-lock.json` and writes the resolved versions into the bin
package. `0.0.0-LOCKFILE` is invalid semver — npm rejects publish if the
gen step didn't run, which is the failure mode we want.

The following `Stage sidecar node_modules` step runs
`scripts/stage-bin-sidecars.mjs --bin-pkg <dir>` to copy the exact dependency
closure from `cli/node_modules` into each bin package. This avoids partial
hand-copies and avoids a second `npm install` pass inside every platform
package.

## Local dry-run

To verify the release pipeline without publishing:

```sh
# From repo root
gh workflow run release.yml --ref v0.2.0-rc.1
# Use a pre-release tag so it doesn't ship to `latest`.
```

Or wire a local Verdaccio for a true install-from-tarball test:

```sh
npx verdaccio &
npm set registry http://localhost:4873
( cd cli && npm pack )
for d in cli-bin-darwin-arm64 cli-bin-linux-x64 cli-bin-linux-arm64 cli-bin-win32-x64; do
  (cd "$d" && npm pack)
done
for tgz in cli/*.tgz cli-bin-darwin-arm64/*.tgz cli-bin-linux-x64/*.tgz cli-bin-linux-arm64/*.tgz cli-bin-win32-x64/*.tgz; do
  npm publish --registry http://localhost:4873 "$tgz"
done
npm i -g skeptic-cli --registry http://localhost:4873
which skeptic && skeptic --version
```

## Rollback

If a release is broken:

```sh
# Deprecate (keeps installs working but warns):
npm deprecate skeptic-cli@<bad-version> "Use <previous-version> instead"

# Or unpublish within 72h:
npm unpublish skeptic-cli@<bad-version>
# Then unpublish each bin package similarly.
```

GitHub Release can be deleted with `gh release delete v<bad-version>`.
