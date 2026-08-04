# M0 verification record

Date: 2026-07-20

This is the executed verification record for the Skeptic v2 foundation. It is
not a substitute for CI on every release runner.

## Browser parity

The reference binary was built from Agent Browser v0.32.2 at commit
`6ede7a9470ac4b681cabf838af8668b9aa99e957`. `scripts/browser-parity.sh` then
attached both that binary and Skeptic to the already-running Chrome instance
with `--auto-connect` and exercised the same local fixture:

1. open the fixture;
2. take a compact interactive semantic snapshot;
3. resolve and click the `Increment` button by `@eN` ref;
4. re-snapshot and read the resulting counter state;
5. diff upstream and Skeptic outputs byte-for-byte.

Result:

```text
Agent Browser v0.32.2 hot-loop parity: ok
```

The harness always closes both named sessions and removes its temporary server
directory. It requires an explicitly supplied upstream binary so a different
global Agent Browser version cannot silently satisfy the gate.

## Native V8 proof

`skeptic-runner` embeds `deno_core`, invokes a Rust op from JavaScript, and
asserts the result. The native macOS arm64 unit and executable smoke both pass
with Cargo resolving rusty_v8 150.2.0. All seven exact simdutf archives were
confirmed in the upstream v150.2.0 release. The blocking 149.4.0 musl gap is
resolved; CI now builds the V8-backed runner for every release target and
smoke-runs it on each available native runner.

Six targets were linked locally from macOS arm64. The native arm64 binary and
the x64 binary under Rosetta both passed the executable smoke; the four Linux
artifacts were inspected after successful linking. Windows x64 MSVC passes a
local target check and archive resolution; its representative link and runtime
smoke are left to the hosted Windows job because macOS cannot provide MSVC.

```text
aarch64-apple-darwin          build + smoke pass
x86_64-apple-darwin           build + smoke pass
x86_64-unknown-linux-gnu      cross-build pass
aarch64-unknown-linux-gnu     cross-build pass
x86_64-unknown-linux-musl     static cross-build pass
aarch64-unknown-linux-musl    static cross-build pass
x86_64-pc-windows-msvc        target check; hosted CI link + smoke
```

## Local quality gates

Executed after the reset and browser parity change:

```text
cargo fmt --all -- --check                         pass
cargo clippy --workspace --all-targets -- -D warnings  pass
cargo test --workspace                             927 passed, 84 ignored
actionlint                                         pass
rusty_v8 v150.2.0 seven-archive gate               pass
npm launcher syntax checks                         pass
npm/Cargo version invariant                        2.0.0 (final release invariant)
npm pack --dry-run                                 pass (5 files)
git diff --check                                   pass
```

The ignored Rust tests are upstream browser/device end-to-end cases that need
explicit external preconditions. The dedicated live parity harness above is
the M0 browser acceptance check.
