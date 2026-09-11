#!/usr/bin/env bash
# AtomNano — build the macOS app (DMG + zip) ON a Mac. Unsigned dev build: no Apple account.
#   mac/build.sh            → dist/AtomNano-<version>-mac-<arch>.dmg for THIS Mac's architecture
#   mac/build.sh --both     → also the other architecture (native modules are only rebuilt for the
#                             host, so the cross-arch app runs with the terminal in pipe mode)
set -euo pipefail
cd "$(dirname "$0")/.."

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 20+ is required:  brew install node   (or https://nodejs.org)"; exit 1
fi
if ! xcode-select -p >/dev/null 2>&1; then
  echo "Xcode Command Line Tools are required for the native modules:  xcode-select --install"; exit 1
fi

[ -d node_modules ] || npm ci            # runs scripts/rebuild-pty.js → node-pty + better-sqlite3 for Electron
npm run icon
npm run build:cm
npm run build:term

HOST_ARCH=$([ "$(uname -m)" = "arm64" ] && echo arm64 || echo x64)
ARCHES=("--$HOST_ARCH")
[ "${1:-}" = "--both" ] && ARCHES=("--arm64" "--x64")

# CSC_IDENTITY_AUTO_DISCOVERY=false: never look for a signing certificate (dev build, identity: null).
CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --mac dmg zip "${ARCHES[@]}" --publish never

echo
echo "Done. Installers:"
ls -1 dist/*.dmg dist/*.zip 2>/dev/null || true
echo
echo "First launch of an unsigned app: right-click AtomNano.app → Open (once), or:"
echo "  xattr -dr com.apple.quarantine /Applications/AtomNano.app"
