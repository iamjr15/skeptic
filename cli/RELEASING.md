# Releasing skeptic CLI

## Distribution model

`npm install -g skeptic-cli` is the **primary** distribution. The package ships
the compiled JS bundle and the `skeptic` launcher runs it on the user's Node.
No Apple Developer account, signing certificate, notarization password, or
platform-specific binary package is required.

Direct binary packages are intentionally out of scope for now. Reintroduce them
only with a separate design and release plan.

## Cutting a release

1. Make sure `main` is green.
2. Tag with the new version:
   ```sh
   git tag v0.2.0
   git push --tags
   ```
3. CI does the rest:
   - bumps `cli/package.json` to the tag version,
   - installs dependencies and builds the JS bundle,
   - installs Playwright Chromium and runs the test suite with a constrained
     worker count,
   - verifies `skeptic --version` matches the tag,
   - runs `npm pack --dry-run`,
   - publishes `skeptic-cli` to npm,
   - creates the GitHub Release notes.

A successful release takes a few minutes.

## Required secrets

Configure these in **Settings → Secrets and variables → Actions**:

| Secret | Purpose |
|---|---|
| `NPM_TOKEN` | `npm publish` for `skeptic-cli` |

## Version stamping

`tsup` substitutes `__SKEPTIC_CLI_VERSION__` from `cli/package.json` into the
bundle at build time. The release workflow bumps `cli/package.json` before
running the build, then asserts `node dist/skeptic.mjs --version` equals the
tag. Forgetting to bump fails the build loudly rather than silently shipping a
stale-version package.

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
for tgz in cli/*.tgz; do
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
```

GitHub Release can be deleted with `gh release delete v<bad-version>`.
