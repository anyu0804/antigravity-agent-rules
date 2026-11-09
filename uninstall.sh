#!/usr/bin/env bash
# Antigravity Agent Rules - uninstaller for macOS / Linux (hook layer only).
# Equivalent of: powershell -File .\uninstall.ps1
# Usage: ./uninstall.sh [--force] [--target-home DIR]
# The actual logic lives in hooks/unix/hooks-installer.mjs (Node, no dependencies).
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# GUI apps and non-login shells may miss Homebrew's bin dir, so probe the common locations too.
NODE_BIN="${NODE:-}"
if [ -z "$NODE_BIN" ]; then
  for c in "$(command -v node 2>/dev/null || true)" /opt/homebrew/bin/node /usr/local/bin/node; do
    if [ -n "$c" ] && [ -x "$c" ]; then NODE_BIN="$c"; break; fi
  done
fi
if [ -z "$NODE_BIN" ]; then
  echo "ERROR: Node.js not found. Install it (e.g. brew install node) or set NODE=/path/to/node." >&2
  exit 1
fi
major="$("$NODE_BIN" -p 'process.versions.node.split(".")[0]')"
if [ "$major" -lt 18 ]; then
  echo "ERROR: Node.js >= 18 required, found $("$NODE_BIN" -v) at $NODE_BIN." >&2
  exit 1
fi
HOOKS_NODE="$NODE_BIN" exec "$NODE_BIN" "$HERE/hooks/unix/hooks-installer.mjs" uninstall "$@"
