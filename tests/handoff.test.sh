#!/usr/bin/env bash
# Unit test for should_handoff (scripts/lib.sh): when update.sh hands over to the update.sh of the downloaded release.
set -Eeuo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
fail=0
check() { if [[ "$2" == "$3" ]]; then echo "  PASS  $1"; else echo "  FAIL  $1 (expected '$3', got '$2')"; fail=1; fi; }

# the "installed" lib.sh is a copy, so that BASH_SOURCE points at it
mkdir -p "$T/inst/scripts" "$T/new/scripts"
cp "$ROOT/scripts/lib.sh" "$T/inst/scripts/lib.sh"
# shellcheck disable=SC1091
source "$T/inst/scripts/lib.sh"
printf '#!/usr/bin/env bash\necho alt\n' >"$T/inst/update.sh"
try() { should_handoff "$T/new" "$T/inst/update.sh" && echo yes || echo no; }

check "no files in the new release: no handoff" "$(try)" "no"

cp "$T/inst/update.sh" "$T/new/update.sh"; cp "$T/inst/scripts/lib.sh" "$T/new/scripts/lib.sh"
check "identical scripts: no handoff needed" "$(try)" "no"

printf '#!/usr/bin/env bash\necho new\n' >"$T/new/update.sh"
check "different update.sh: handoff" "$(try)" "yes"

cp "$T/inst/update.sh" "$T/new/update.sh"; echo '# changed' >>"$T/new/scripts/lib.sh"
check "only lib.sh changed: handoff" "$(try)" "yes"

echo 'if then fi (' >>"$T/new/scripts/lib.sh"
check "syntax error in the new lib.sh: no handoff" "$(try)" "no"

cp "$T/inst/scripts/lib.sh" "$T/new/scripts/lib.sh"; printf 'echo (\n' >"$T/new/update.sh"
check "syntax error in the new update.sh: no handoff" "$(try)" "no"

printf '#!/usr/bin/env bash\necho new\n' >"$T/new/update.sh"
check "already handed over (WM_UPDATE_HANDOFF): no second handoff" "$(WM_UPDATE_HANDOFF=1 try)" "no"

# update.sh wiring: lib comes from the release tree after a hand-over, the lock is released, no hand-over loop
grep -q 'source "${WM_LIB_DIR:-$INSTALL_DIR/scripts}/lib.sh"' "$ROOT/update.sh" && r=yes || r=no; check "update.sh loads lib.sh from WM_LIB_DIR" "$r" "yes"
# the log process inherits the lock; after a hand-over the new script must not try to take it a second time
grep -q 'if \[\[ -z "\${WM_UPDATE_HANDOFF:-}" \]\]; then' "$ROOT/update.sh" && r=yes || r=no; check "update.sh does not take the lock again after a handoff" "$r" "yes"
awk '/flock -n 9/ { n++ } END { print n }' "$ROOT/update.sh" | grep -qx 1 && r=yes || r=no; check "update.sh has exactly one place that takes the lock" "$r" "yes"
grep -q 'WM_UPDATE_HANDOFF=1' "$ROOT/update.sh" && r=yes || r=no; check "update.sh marks the handoff" "$r" "yes"
# update.sh runs BEFORE the files are replaced and calls the installed (old) helper scripts: new options must be guarded
grep -q 'grep -q -- .--no-remote. "\$INSTALL_DIR/backup.sh"' "$ROOT/update.sh" && r=yes || r=no; check "update.sh passes --no-remote only if the installed backup.sh knows it" "$r" "yes"
unguarded="$(grep -E '^"\$INSTALL_DIR/backup.sh" ' "$ROOT/update.sh" | grep -vc backup_args || true)"; [[ "$unguarded" == "0" ]] && r=yes || r=no; check "update.sh calls backup.sh only with checked options" "$r" "yes"
exit "$fail"
