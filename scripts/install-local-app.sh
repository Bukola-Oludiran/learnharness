#!/bin/bash
# Build the fork as a local macOS app and install it into /Applications.
# Personal-use build: ad-hoc signed, no auto-update (electron-builder.local.yml).
#
# Run from a checkout OUTSIDE iCloud Drive: iCloud attaches extended
# attributes to files it syncs, and codesign refuses bundles that carry them.
set -euo pipefail
cd "$(dirname "$0")/.."

APP_NAME="LearnHarness"
BUILT="dist/mac-arm64/${APP_NAME}.app"
INSTALLED="/Applications/${APP_NAME}.app"

if [[ "$(uname -sm)" != "Darwin arm64" ]]; then
	echo "This script builds the Apple Silicon macOS app only." >&2
	exit 1
fi
if pgrep -x "$APP_NAME" >/dev/null; then
	echo "${APP_NAME} is running. Quit it, then run this again." >&2
	exit 1
fi

rm -rf dist .next/standalone
export NEXT_TELEMETRY_DISABLED=1
npm run build
node scripts/smoke-provider-runtime.mjs
node scripts/build-server.mjs
# The ACP adapters (Claude, Codex) are child processes, not imports: installed
# beside the server from the pinned list in acp-agents/ (phase 6a).
node scripts/build-acp-payload.mjs
# The checkout's git folder must not be packaged: it is large, it is history,
# and its read-only files make codesign fail. Done here, not in
# next.config.ts, whose trace exclusions upstream pins exactly in a test.
rm -rf .next/standalone/.git .next/standalone/.github
node scripts/smoke-server.mjs
npx electron-builder --mac --arm64 --dir --config electron-builder.local.yml --publish never

codesign --verify --deep --strict "$BUILT"
if [[ -e "$BUILT/Contents/Resources/app-update.yml" ]]; then
	echo "The build carries an update feed; refusing to install it." >&2
	exit 1
fi

rm -rf "$INSTALLED"
ditto "$BUILT" "$INSTALLED"
echo "Installed ${INSTALLED}"
