#!/usr/bin/env bash
# AtomNano — run from source on a Mac (with DevTools). Installs dependencies on first use.
set -euo pipefail
cd "$(dirname "$0")/.."
command -v node >/dev/null 2>&1 || { echo "Node.js 20+ is required:  brew install node"; exit 1; }
[ -d node_modules ] || npm ci
[ -f build/icon.icns ] || npm run icon
npm run dev
