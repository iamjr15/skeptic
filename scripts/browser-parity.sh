#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
agent_browser_bin="${AGENT_BROWSER_BIN:-}"
skeptic_bin="${SKEPTIC_BIN:-$repo_root/target/debug/skeptic}"

if [[ -z "$agent_browser_bin" ]]; then
  echo "AGENT_BROWSER_BIN must point to stock Agent Browser v0.32.2" >&2
  exit 2
fi

if [[ ! -x "$agent_browser_bin" ]]; then
  echo "Agent Browser binary is not executable: $agent_browser_bin" >&2
  exit 2
fi

if [[ ! -x "$skeptic_bin" ]]; then
  cargo build --manifest-path "$repo_root/Cargo.toml" -p skeptic-cli
fi

work_dir="$(mktemp -d)"
port="$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()')"
fixture_url="http://127.0.0.1:$port/browser-parity.html"
session="skeptic-parity-$$"
connect_args=()

if [[ "${PARITY_AUTO_CONNECT:-0}" == "1" ]]; then
  connect_args+=(--auto-connect)
fi

cleanup() {
  "$agent_browser_bin" "${connect_args[@]}" --session "$session" close >/dev/null 2>&1 || true
  "$skeptic_bin" "${connect_args[@]}" --session "$session" close >/dev/null 2>&1 || true
  kill "$server_pid" >/dev/null 2>&1 || true
  wait "$server_pid" >/dev/null 2>&1 || true
  rm -r "$work_dir"
}
trap cleanup EXIT

python3 -m http.server "$port" --bind 127.0.0.1 \
  --directory "$repo_root/crates/skeptic-cli/tests/fixtures" \
  >"$work_dir/server.log" 2>&1 &
server_pid=$!

for _ in {1..50}; do
  if curl --fail --silent "$fixture_url" >/dev/null; then break; fi
  sleep 0.1
done
curl --fail --silent "$fixture_url" >/dev/null

run_case() {
  local binary="$1"
  local prefix="$2"

  "$binary" "${connect_args[@]}" --session "$session" open "$fixture_url" >/dev/null
  "$binary" "${connect_args[@]}" --session "$session" snapshot -i -c >"$work_dir/$prefix-before.txt"

  local ref
  ref="$(sed -n '/button "Increment"/s/.*ref=\(e[0-9][0-9]*\).*/@\1/p' "$work_dir/$prefix-before.txt" | head -1)"
  if [[ -z "$ref" ]]; then
    echo "$prefix snapshot did not expose the Increment button ref" >&2
    exit 1
  fi

  "$binary" "${connect_args[@]}" --session "$session" click "$ref" >/dev/null
  "$binary" "${connect_args[@]}" --session "$session" snapshot -i -c >"$work_dir/$prefix-after.txt"
  "$binary" "${connect_args[@]}" --session "$session" get text "#count" >"$work_dir/$prefix-state.txt"
  "$binary" "${connect_args[@]}" --session "$session" close >/dev/null
}

run_case "$agent_browser_bin" upstream
run_case "$skeptic_bin" skeptic

diff -u "$work_dir/upstream-before.txt" "$work_dir/skeptic-before.txt"
diff -u "$work_dir/upstream-after.txt" "$work_dir/skeptic-after.txt"
diff -u "$work_dir/upstream-state.txt" "$work_dir/skeptic-state.txt"
grep -Fxq "Count: 1" "$work_dir/skeptic-state.txt"

echo "Agent Browser v0.32.2 hot-loop parity: ok"
