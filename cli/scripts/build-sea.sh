#!/usr/bin/env bash
# Build the skeptic SEA binary on Node 25.5+. Run from any cwd — paths are
# resolved relative to the script directory.
#
# Usage: scripts/build-sea.sh --out=path/to/skeptic [--node=/path/to/node]
#
# The script:
#   1. Generates dist/sea-config.absolute.json with absolute paths
#      (Node SEA resolves config paths relative to the build cwd, not the
#      config file, so we materialize a fresh config every run).
#   2. Invokes `node --build-sea` (Node 25.5+ single-step). The legacy
#      --experimental-sea-config + postject path is intentionally not
#      supported.
#   3. macOS only: strips Node's signature and applies an ad-hoc signature
#      so local smoke tests and unsigned release artifacts can run.
set -euo pipefail

OUT=""
for arg in "$@"; do
  case $arg in
    --out=*) OUT="${arg#--out=}" ;;
    --node=*) SKEPTIC_SEA_NODE="${arg#--node=}" ;;
  esac
done

if [[ -z "$OUT" ]]; then
  echo "build-sea.sh: --out=<path> is required" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLI_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
NODE_BIN="${SKEPTIC_SEA_NODE:-node}"
NODE_EXEC_PATH="$("$NODE_BIN" -p 'process.execPath')"
OUT_ABS="$(cd "$(dirname "$OUT")" 2>/dev/null && pwd || true)/$(basename "$OUT")"
if [[ -z "$(cd "$(dirname "$OUT")" 2>/dev/null && pwd || true)" ]]; then
  # The output directory doesn't exist yet — make it.
  mkdir -p "$(dirname "$OUT")"
  OUT_ABS="$(cd "$(dirname "$OUT")" && pwd)/$(basename "$OUT")"
fi

# Node 25.5+ check.
NODE_VERSION="$("$NODE_BIN" --version)"
NODE_MAJOR="$(echo "$NODE_VERSION" | sed -E 's/^v([0-9]+).*/\1/')"
NODE_MINOR="$(echo "$NODE_VERSION" | sed -E 's/^v[0-9]+\.([0-9]+).*/\1/')"
if (( NODE_MAJOR < 25 )) || { (( NODE_MAJOR == 25 )) && (( NODE_MINOR < 5 )); }; then
  echo "build-sea.sh: requires Node 25.5+ (have $NODE_VERSION)." >&2
  exit 1
fi

if ! "$NODE_BIN" -e '
  const fs = require("node:fs");
  const binary = fs.readFileSync(process.execPath);
  process.exit(binary.includes(Buffer.from("NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2")) ? 0 : 1);
'; then
  echo "build-sea.sh: Node executable lacks the SEA fuse string: $NODE_EXEC_PATH" >&2
  echo "Use an official static Node.js binary, or pass --node=/path/to/node / set SKEPTIC_SEA_NODE." >&2
  exit 1
fi

echo "→ Generating SEA config with absolute paths…"
CONFIG="$("$NODE_BIN" "$CLI_DIR/scripts/gen-sea-config.mjs" --base "$CLI_DIR" --output "$OUT_ABS" --executable "$NODE_EXEC_PATH")"
echo "  $CONFIG"

echo "→ Running node --build-sea (Node $NODE_VERSION)…"
"$NODE_BIN" --build-sea "$CONFIG"

if [[ "$(uname -s)" == "Darwin" ]]; then
  echo "→ Stripping inherited Node signature (macOS)…"
  codesign --remove-signature "$OUT_ABS" || true
  echo "→ Applying ad-hoc signature (macOS)…"
  codesign --force --sign - "$OUT_ABS"
fi

echo "→ Done: $OUT_ABS"
