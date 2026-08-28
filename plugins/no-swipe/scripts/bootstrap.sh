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
HOME_ROOT="${NO_SWIPE_HOME:-$HOME}"
DEST="$HOME_ROOT/.config/no-swipe/bin/$VERSION"
BIN="$DEST/no-swipe"

json_list() {
  local first=1 item
  printf '['
  for item in "$@"; do
    [[ -n "$item" ]] || continue
    if (( first )); then first=0; else printf ','; fi
    printf '"%s"' "$item"
  done
  printf ']'
}

# 只删版本目录，不动 credentials / supabase.json / 当前正在用的包。
prune_old_packages() {
  local pruned_bins=() pruned_plugins=() dir name parent
  if [[ -d "$HOME_ROOT/.config/no-swipe/bin" ]]; then
    shopt -s nullglob
    for dir in "$HOME_ROOT/.config/no-swipe/bin"/*; do
      [[ -d "$dir" ]] || continue
      name="$(basename "$dir")"
      if [[ "$name" != "$VERSION" && "$name" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
        rm -rf "$dir"
        pruned_bins+=("$name")
      fi
    done
    shopt -u nullglob
  fi
  parent="$(dirname "$ROOT")"
  if [[ "$(basename "$parent")" == "no-swipe" && "$(basename "$(dirname "$parent")")" == "no-swipe-marketplace" ]]; then
    shopt -s nullglob
    for dir in "$parent"/*; do
      [[ -d "$dir" && "$dir" != "$ROOT" ]] || continue
      name="$(basename "$dir")"
      if [[ "$name" =~ ^[0-9]+\.[0-9]+\.[0-9]+\+codex\. ]]; then
        rm -rf "$dir"
        pruned_plugins+=("$name")
      fi
    done
    shopt -u nullglob
  fi
  PRUNED_BINS="$(json_list "${pruned_bins[@]+"${pruned_bins[@]}"}")"
  PRUNED_PLUGINS="$(json_list "${pruned_plugins[@]+"${pruned_plugins[@]}"}")"
}

mkdir -p "$HOME_ROOT/.config/no-swipe"
chmod 700 "$HOME_ROOT/.config/no-swipe"
cp "$ROOT/config/supabase.json" "$HOME_ROOT/.config/no-swipe/supabase.json"

if [[ -x "$BIN" ]]; then
  prune_old_packages
  printf '{"ok":true,"path":"%s","skipped":true,"pruned_bins":%s,"pruned_plugins":%s}\n' \
    "$BIN" "$PRUNED_BINS" "$PRUNED_PLUGINS"
  exec "$BIN" up
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
prune_old_packages
printf '{"ok":true,"path":"%s","version":"%s","target":"%s","pruned_bins":%s,"pruned_plugins":%s}\n' \
  "$BIN" "$VERSION" "$TARGET" "$PRUNED_BINS" "$PRUNED_PLUGINS"
exec "$BIN" up
