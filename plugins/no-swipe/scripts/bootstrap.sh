#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="$(sed -n 's/.*"version": "\([^"]*\)".*/\1/p' "$ROOT/config/cli-version.json" | head -1)"
ARCH="$(uname -m)"
OS="$(uname -s)"
case "$OS-$ARCH" in
  Darwin-arm64) TARGET="darwin-arm64" ;;
  Darwin-x86_64) TARGET="darwin-x64" ;;
  *) echo "unsupported platform $OS $ARCH" >&2; exit 1 ;;
esac
DEST="$HOME/.config/no-swipe/bin/$VERSION"
BIN="$DEST/no-swipe"
mkdir -p "$HOME/.config/no-swipe"
chmod 700 "$HOME/.config/no-swipe"
cp "$ROOT/config/supabase.json" "$HOME/.config/no-swipe/supabase.json"
if [[ -x "$BIN" ]]; then
  echo "{\"ok\":true,\"path\":\"$BIN\",\"skipped\":true}"
  exit 0
fi
CONFIG="$ROOT/config/supabase.json"
BASE="$(sed -n 's/.*"releases_base_url": "\([^"]*\)".*/\1/p' "$CONFIG" | head -1)"
ARTIFACT="no-swipe-$TARGET.gz"
URL="$BASE/$VERSION/$ARTIFACT"
SUM_URL="$BASE/$VERSION/manifest.json"
mkdir -p "$DEST"
TMP="$(mktemp)"
curl -fsSL "$URL" -o "$TMP"
EXPECTED="$(curl -fsSL "$SUM_URL" | sed -n "s/.*\"$ARTIFACT\": \"\\([^\"]*\\)\".*/\\1/p" | head -1)"
ACTUAL="$(shasum -a 256 "$TMP" | awk '{print $1}')"
if [[ -z "$EXPECTED" || "$EXPECTED" != "$ACTUAL" ]]; then
  echo "sha256 mismatch" >&2
  exit 1
fi
gzip -dc "$TMP" > "$BIN"
rm -f "$TMP"
chmod 755 "$BIN"
echo "{\"ok\":true,\"path\":\"$BIN\",\"version\":\"$VERSION\",\"target\":\"$TARGET\"}"
