# Vendored Deno crates

Skeptic vendors `deno_core` 0.408.0, `deno_crypto` 0.269.0, and `serde_v8`
0.317.0 from their crates.io source archives. The core crates pin rusty_v8
149.4.0, which has no Linux musl prebuilt archives. The crypto crate is the
release matched to deno_core 0.408.0 and provides the runner's Web Crypto API.

The dependency pin and three runtime changes are taken from Deno commit
`7e036ea12e23b4908f854730179ccf50f72041a8` (`feat: upgrade V8 to 150.2.0`,
PR #36098). That commit keeps these Deno package versions unchanged and makes
the following compatibility changes:

- pins both crates to rusty_v8 150.2.0 with the `simdutf` feature;
- gives fast-call overload storage the lifetime required by V8 150; and
- detaches transferred ArrayBuffers after, rather than before, serialization.

The published `deno_crypto` crate uses four unstable `if let` match guards.
Skeptic translates those guards to stable boolean guards without changing the
selected SLH-DSA variants or behavior. Its crates.io archive records Deno
commit `f39575ecd50602a5b42b1ba8e93849460de9fcf4` and upstream path
`ext/crypto`.

No other Deno source changes are applied. Update this ledger whenever a
vendored crate changes. The upstream license is in `LICENSES/deno-LICENSE.md`.

Sources:

- https://crates.io/crates/deno_core/0.408.0
- https://crates.io/crates/deno_crypto/0.269.0
- https://crates.io/crates/serde_v8/0.317.0
- https://github.com/denoland/deno/commit/7e036ea12e23b4908f854730179ccf50f72041a8
- https://github.com/denoland/rusty_v8/releases/tag/v150.2.0
