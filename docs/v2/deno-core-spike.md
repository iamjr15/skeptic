# deno_core M0 target spike

Status: archive blocker resolved; native round-trip passes on rusty_v8 150.2.0
and the required simdutf archive exists for all seven release targets. The
seven-target build matrix now runs for every pull request and main-branch push.

## Implemented proof

`crates/skeptic-runner` embeds V8, registers one `#[op2(fast)]` Rust function,
calls it from JavaScript, and fails if the result is not 42. Both the unit test
and the runnable smoke pass on macOS arm64.

```text
skeptic-runner deno_core spike: ok
```

`.github/workflows/deno-spike.yml` builds the V8-backed runner for all seven
release triples and repeats the runtime smoke on native Linux x64, macOS arm64,
and Windows x64 MSVC. Its archive gate inspects the exact `v8` version in
`Cargo.lock` and requires the matching simdutf archive for every target.

Local verification built the two macOS and four Linux targets, including
statically linked x64 and arm64 musl executables. The arm64 macOS smoke and the
x64 macOS smoke under Rosetta both pass. The representative MSVC link and smoke
remain intentionally assigned to the hosted Windows runner; its target check
and exact archive resolution pass locally.

## Target decision

Windows is `x86_64-pc-windows-msvc`, not GNU. Current rusty_v8 releases publish
MSVC archives, and Agent Browser already runs its Windows CI against MSVC. This
keeps the same user-facing seven binaries plus the Windows ARM64→x64 emulation
path.

## Resolved blocker

Released `deno_core` 0.408.0 pins rusty_v8 149.4.0, whose release lacks both
Linux musl archives. Deno's upstream V8 150.2.0 compatibility commit keeps the
same `deno_core` and `serde_v8` package versions, advances rusty_v8 to 150.2.0,
and adapts fast-call lifetimes and transferred ArrayBuffer behavior.

Skeptic vendors those two released crate sources and applies only that exact
upstream compatibility delta. This avoids a Deno monorepo git dependency (and
its large test-data submodules), avoids hosting private V8 binaries, and leaves
Cargo.lock transparently resolved to `v8` 150.2.0. The v150.2.0 release has the
simdutf prebuilt archive for every Skeptic release triple, including both musl
targets. Provenance is recorded in `vendor/README.md` and `NOTICE`.

Primary references:

- https://github.com/denoland/rusty_v8/releases/tag/v149.4.0
- https://github.com/denoland/rusty_v8/releases/tag/v150.2.0
- https://github.com/denoland/rusty_v8#binary-build
- https://github.com/denoland/deno/commit/7e036ea12e23b4908f854730179ccf50f72041a8
