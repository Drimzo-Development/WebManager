#!/usr/bin/env bash
# Tests prune_stale (scripts/lib.sh): files of an old release disappear, hand-made files and build output stay.
set -Eeuo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
source "$ROOT/scripts/lib.sh"   # first: it defines ok(), which the helpers below replace
PASS=0; FAIL=0
ok() { PASS=$((PASS + 1)); echo "ok   $1"; }
bad() { FAIL=$((FAIL + 1)); echo "FAIL $1"; }
check() { if eval "$2"; then ok "$1"; else bad "$1"; fi; }

mkdir -p "$TMP/inst/frontend/src/pages" "$TMP/inst/app/Support" "$TMP/inst/public/assets/app" "$TMP/inst/docs" \
         "$TMP/new/frontend/src/pages" "$TMP/new/app/Support" "$TMP/new/docs"
touch "$TMP/inst/frontend/src/pages/License.tsx" "$TMP/inst/frontend/src/pages/Keep.tsx" "$TMP/inst/app/Support/License.php" \
      "$TMP/inst/.env" "$TMP/inst/gitea.token" "$TMP/inst/custom.sh" "$TMP/inst/public/assets/app/app.js" "$TMP/inst/docs/Old.md"
touch "$TMP/new/frontend/src/pages/Keep.tsx" "$TMP/new/app/Support/Other.php" "$TMP/new/docs/New.md"
mkdir -p "$TMP/new/public"; touch "$TMP/new/public/index.php"

prune_stale "$TMP/inst" "$TMP/new" >/dev/null
check "file removed in the release is gone" "[[ ! -e $TMP/inst/frontend/src/pages/License.tsx && ! -e $TMP/inst/app/Support/License.php && ! -e $TMP/inst/docs/Old.md ]]"
check "file that still exists is kept" "[[ -e $TMP/inst/frontend/src/pages/Keep.tsx ]]"
check "files outside the release directories stay" "[[ -e $TMP/inst/.env && -e $TMP/inst/gitea.token && -e $TMP/inst/custom.sh ]]"
check "build output stays" "[[ -e $TMP/inst/public/assets/app/app.js ]]"
echo "$PASS passed, $FAIL failed"; [[ $FAIL -eq 0 ]]
