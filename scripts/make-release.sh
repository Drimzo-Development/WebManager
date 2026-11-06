#!/usr/bin/env bash
# Builds a release archive + checksum (+ optional detached GPG signature) from the source tree.
#   scripts/make-release.sh [--out DIR] [--sign GPG-KEY-ID]
# Publish with:  ../updates.drimzo.cc/bin/add-release.sh webmanager stable dist/webmanager-<version>.tar.gz   (then upload data/).
set -Eeuo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
OUT="$ROOT/dist"; KEY=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --out) OUT="${2:?}"; shift ;;
    --sign) KEY="${2:?}"; shift ;;
    *) echo "Unknown option $1" >&2; exit 1 ;;
  esac
  shift
done
VERSION="$(tr -d '[:space:]' <"$ROOT/VERSION")"
NAME="webmanager-$VERSION"
mkdir -p "$OUT"
STAGE="$(mktemp -d)"; trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$STAGE/$NAME"
tar -C "$ROOT" --exclude='./.git' --exclude='./.env' --exclude='./dist' --exclude='./.idea' --exclude='node_modules' --exclude='./public/assets/app' --exclude='./backups' -cf - . | tar -C "$STAGE/$NAME" -xf -
tar -C "$STAGE" --sort=name --owner=0 --group=0 --numeric-owner -czf "$OUT/$NAME.tar.gz" "$NAME"
( cd "$OUT" && sha256sum "$NAME.tar.gz" >"$NAME.tar.gz.sha256" )
printf '%s\n' "$VERSION" >"$OUT/LATEST"
if [[ -n "$KEY" ]]; then
  pin=(); [[ -n "${SIGN_PASSFILE:-}" ]] && pin=(--pinentry-mode loopback --passphrase-file "$SIGN_PASSFILE")   # CI: key with passphrase
  gpg --batch --yes "${pin[@]}" --armor --detach-sign --local-user "$KEY" -o "$OUT/$NAME.tar.gz.asc" "$OUT/$NAME.tar.gz"
fi
echo "Release created in $OUT:"; ls -l "$OUT"
