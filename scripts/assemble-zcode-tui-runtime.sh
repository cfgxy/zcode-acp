#!/usr/bin/env bash
# Assemble the zcode CLI TUI runtime for the desktop-attached agent layout.
#
# The desktop-attached runtime (~/.zcode/server/agents/glm/) ships no TUI:
# bare `zcode` dies with "Cannot find package '@zcode/tui'" because
# loadTuiRuntime() does a bare import("@zcode/tui") outside a SEA build and
# @zcode/tui is an internal package that is never published to npm.
#
# Workaround: extract the official @zcode/tui entry vendored inside the
# community repack `zcode-app-cli` (npm, MIT) and install its public npm
# dependencies next to it. The tui dist also lazily requires ./html_renderer,
# ./elk-api.js and ./elk-worker.min.js which NO public source ships — those
# features (HTML export, graph layout) will error if triggered; core chat
# does not use them.
#
# Re-apply after every zcode update (version pinning below must match the
# installed desktop app version, see ZCODE_APP_VERSION in the desktop profile).
set -euo pipefail

GLM_DIR="$HOME/.zcode/server/agents/glm"
NM="$GLM_DIR/node_modules"
APP_VERSION="${1:-3.14.1}"          # zcode-app-cli tracks the desktop app version
PI_TUI_VERSION="${2:-0.85.1}"       # @zcode/tui declares ^0.85.1

command -v npm >/dev/null || { echo "npm required" >&2; exit 1; }

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

echo ">> fetching zcode-app-cli@$APP_VERSION (vendored @zcode/tui)"
curl -sL "https://registry.npmmirror.com/zcode-app-cli/-/zcode-app-cli-$APP_VERSION.tgz" -o "$work/cli.tgz"
tar -xzOf "$work/cli.tgz" package/vendor/node_modules/@zcode/tui/dist/index.js \
  | install -D -m 644 /dev/stdin "$NM/@zcode/tui/dist/index.js"
tar -xzOf "$work/cli.tgz" package/vendor/node_modules/@zcode/tui/package.json \
  | install -D -m 644 /dev/stdin "$NM/@zcode/tui/package.json"

echo ">> installing public deps (@earendil-works/pi-tui@$PI_TUI_VERSION, web-worker, marked)"
mkdir -p "$work/deps" && cd "$work/deps"
npm init -y >/dev/null
npm i --silent "@earendil-works/pi-tui@$PI_TUI_VERSION" web-worker marked
cp -rn "$work/deps/node_modules/." "$NM/"

echo ">> load smoke test"
node --input-type=module -e '
const m = await import(process.env.HOME + "/.zcode/server/agents/glm/node_modules/@zcode/tui/dist/index.js");
if (typeof m.runTui !== "function") throw new Error("runTui export missing");
console.log("OK: @zcode/tui loads, runTui present");
'
echo ">> done. Run 'zcode' in an interactive terminal (needs a real TTY)."
