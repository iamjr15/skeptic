# Contributing to Skeptic

Skeptic v2 is an active Rust rebuild. Read `docs/v2/blueprint.md` before making
architectural changes; it is the only active plan. v1 is intentionally retired
and has no compatibility requirement.

## Setup

Install the stable Rust toolchain, then run:

```bash
cargo build --workspace
cargo test --workspace
cargo run -p skeptic-cli -- --help
```

The first `skeptic-runner` build downloads a prebuilt rusty_v8 archive and is
therefore slower than later builds.

## Repository map

- `crates/skeptic-cli`: vendored browser foundation and current CLI binary.
- `crates/skeptic-contract`: shared machine contracts and schema generator.
- `crates/skeptic-runner`: embedded-V8 target spike.
- `vendor`: pinned Deno runtime crates and their upstream V8 compatibility
  delta; see `vendor/README.md` before changing them.
- `npm/skeptic-cli`: zero-dependency npm launcher and fallback installer.
- `npm/platforms`: native optional-package manifests.
- `skills/skeptic`: agent skill source.
- `docs/v2`: blueprint, reference research, and implementation spike notes.

The browser code is temporarily monolithic to establish upstream parity. Do
not split public contracts ahead of the M1 freeze.

## Quality gates

```bash
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
cargo run --quiet -p skeptic-contract --bin export-schemas -- schemas
git diff --exit-code -- schemas
node npm/skeptic-cli/scripts/check-versions.mjs
```

Browser-core changes also run the pinned upstream comparison. Build Agent
Browser v0.32.2 from `~/Desktop/skeptic-refs/agent-browser/cli`, then attach
both binaries to the existing debug-enabled Chrome:

```bash
PARITY_AUTO_CONNECT=1 \
AGENT_BROWSER_BIN="$HOME/Desktop/skeptic-refs/agent-browser/cli/target/debug/agent-browser" \
./scripts/browser-parity.sh
```

Add a focused regression test for every behavior change. Tests that require a
real browser/device must be clearly preflighted and leave no sessions or local
artifacts behind.

## Provenance and security

Copied or translated upstream material needs a per-file attribution header and
a `NOTICE` ledger entry with source repository, commit, and paths. Never commit
`.skeptic/`, cookies, auth state, screenshots containing secrets, or device
logs with credentials.

Report vulnerabilities through GitHub private vulnerability reporting or the
private contact in `SECURITY.md`, never a public issue.

## Releases

Push the commit to `main`, then push a matching version tag (for example `v2.0.0`).
Release builds can run alongside CI; publication waits for both main-branch
validation workflows to pass on that exact commit. The release workflow builds
all five binaries for seven targets and publishes
GitHub assets, checksums, a Homebrew formula, an SBOM, and the `skeptic-cli` npm
wrapper. The wrapper's trusted publisher must target `iamjr15/skeptic` and
`release.yml` without a GitHub environment. Its installer downloads and verifies
GitHub binaries when optional native npm packages are unavailable.

Before publication, separate macOS, Linux, and Windows jobs execute the built
bundles with no runtime source checkout or Cargo registry present. The smoke
script checks CLI dispatch and runs TypeScript using embedded web/crypto APIs.

Additional distribution channels are opt-in repository variables:

- Set `PUBLISH_NATIVE_NPM_PACKAGES=true` only after bootstrapping each package in
  `npm/platforms` and configuring its trusted publisher for the same workflow.
  Publishing under `@skeptic` requires access to that npm scope.
- Set `PUBLISH_HOMEBREW_TAP=true` after creating `iamjr15/homebrew-tap` and adding
  `HOMEBREW_TAP_TOKEN` with write access to the tap. The formula is included in
  GitHub release assets regardless of whether automatic tap updates are enabled.
