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
