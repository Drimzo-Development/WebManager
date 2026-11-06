#!/usr/bin/env bash
# Unit test for scripts/rollback.sh with a simulated Docker/compose: target selection, refusals, success path, restore after a failure.
set -Eeuo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
fail=0
check() { if [[ "$2" == "$3" ]]; then echo "  PASS  $1"; else echo "  FAIL  $1 (expected '$3', got '$2')"; fail=1; fi; }

INST="$T/inst"; DATA="$T/data"; BIN="$T/bin"; LOGS="$T/logs"; CALLS="$T/docker.calls"
export TMPDIR="$T" PATH="$BIN:$PATH" WM_INSTALL_DIR="$INST" WM_ROLLBACK_TEST=1 WM_UPDATE_LOCK="$T/lock"
mkdir -p "$INST/scripts" "$DATA/backups" "$DATA/database-backups" "$DATA/update" "$BIN" "$LOGS"
cp "$ROOT/scripts/lib.sh" "$ROOT/scripts/rollback.sh" "$INST/scripts/"
chmod +x "$INST/scripts/rollback.sh"

# --- simulated tools
printf '#!/usr/bin/env bash\nexit 0\n' >"$BIN/flock"; cp "$BIN/flock" "$BIN/sleep"; chmod +x "$BIN/flock" "$BIN/sleep"
cat >"$BIN/docker" <<EOS
#!/usr/bin/env bash
# strips "compose --project-directory X -f Y --env-file Z"
if [[ "\$1" == "compose" ]]; then
  shift; while [[ \$# -gt 0 ]]; do case "\$1" in --project-directory|-f|--env-file) shift 2 ;; *) break ;; esac; done
  echo "compose \$*" >>"$CALLS"
  case "\$1" in
    ps) echo "cid-\${*: -1}" ;;
    up) n=\$(grep -c '^compose up' "$CALLS"); if [[ -f "$T/fail-up-at" && "\$n" == "\$(cat "$T/fail-up-at")" ]]; then rm -f "$T/fail-up-at"; echo "boom" >&2; exit 1; fi ;;
    build|pull) : ;;
    exec)
      if [[ "\$*" == *"MARIADB_ROOT_PASSWORD"* && "\$*" != *"DROP DATABASE"* ]]; then md5sum | cut -c1-8 >>"$T/imports"; exit 0; fi
      if [[ "\$*" == *"bin/console version"* ]]; then sed -n 's/^WM_VERSION=//p' "$INST/.env"; exit 0; fi
      if [[ "\$*" == *"wget"* ]]; then echo ok; exit 0; fi
      if [[ "\$*" == *"job:enqueue"* ]]; then echo "job 1"; exit 0; fi ;;
    logs) echo "log" ;;
  esac
  exit 0
fi
case "\$1" in
  info) exit 0 ;;
  inspect) echo healthy ;;
  image) [[ -f "$T/no-images" ]] && exit 1 || exit 0 ;;
esac
exit 0
EOS
chmod +x "$BIN/docker"
# the safety dump taken by backup.sh --db-only
cat >"$INST/backup.sh" <<EOS
#!/usr/bin/env bash
echo "backup.sh \$*" >>"$CALLS"
printf 'CREATE TABLE safety (id int);\n' | gzip >"$DATA/database-backups/db-20261012-120000-v0.11.0.sql.gz"
EOS
chmod +x "$INST/backup.sh"

# --- installed state: version 0.11.0, left behind by the update 0.10.0 -> 0.11.0
printf 'DATA_DIR=%s\nLOG_DIR=%s\nWM_VERSION=0.11.0\nWM_IMAGE_PREFIX=drimzo\nDASHBOARD_DOMAIN=panel.example.com\nSECRET=geheim\n' "$DATA" "$LOGS" >"$INST/.env"
echo 0.11.0 >"$INST/VERSION"; echo "new" >"$INST/new-file-0.11"; echo "x" >"$INST/docker-compose.yml"
mk_tree() { # mk_tree VERSION STAMP
  rm -rf "$T/tree"; mkdir -p "$T/tree/scripts"; echo "$1" >"$T/tree/VERSION"; echo "old" >"$T/tree/old-file"; echo "x" >"$T/tree/docker-compose.yml"
  tar -C "$T/tree" -czf "$DATA/backups/app-tree-$1-$2.tar.gz" .
}
mk_dump() { printf 'CREATE TABLE users (id int);\n-- %s\n' "$2" | gzip >"$DATA/database-backups/db-$1-v$2.sql.gz"; }
mk_tree 0.10.0 20261012-100000
mk_dump 20261012-095950 0.10.0     # the right one: directly before the update
mk_dump 20261001-100000 0.10.0     # older dump of the same version
mk_dump 20261012-110000 0.10.0     # taken AFTER the app backup: must not be used
mk_dump 20261012-095955 0.9.0      # other version
R="$INST/scripts/rollback.sh"
want="$(zcat "$DATA/database-backups/db-20261012-095950-v0.10.0.sql.gz" | md5sum | cut -c1-8)"
: >"$CALLS"; rm -f "$T/imports"

# --- dry run
out="$("$R" --dry-run 2>&1)"
check "Dry run names the target and the matching dump" "$(grep -c '0.11.0 -> 0.10.0' <<<"$out"):$(grep -c 'db-20261012-095950-v0.10.0' <<<"$out")" "1:1"
check "Dry run changes nothing" "$(cat "$INST/VERSION"):$(grep -c WM_VERSION=0.11.0 "$INST/.env"):$(wc -c <"$CALLS" | tr -d ' ')" "0.11.0:1:0"

# --- refusals change nothing
mv "$DATA/database-backups/db-20261012-095950-v0.10.0.sql.gz" "$T/keep.gz"; rm -f "$DATA/database-backups/db-20261001-100000-v0.10.0.sql.gz"
rc=0; "$R" --yes >/dev/null 2>&1 || rc=$?
check "Without a matching database dump: abort before any change" "$rc:$(cat "$INST/VERSION"):$([[ -f "$INST/new-file-0.11" ]] && echo there || echo gone)" "1:0.11.0:there"
mv "$T/keep.gz" "$DATA/database-backups/db-20261012-095950-v0.10.0.sql.gz"
printf 'not gzip' >"$DATA/database-backups/db-20261012-095950-v0.10.0.sql.gz.bad"; cp "$DATA/database-backups/db-20261012-095950-v0.10.0.sql.gz" "$T/good.gz"
printf 'not gzip' >"$DATA/database-backups/db-20261012-095950-v0.10.0.sql.gz"
rc=0; "$R" --yes >/dev/null 2>&1 || rc=$?
check "Damaged dump: abort before any change" "$rc:$(cat "$INST/VERSION")" "1:0.11.0"
cp "$T/good.gz" "$DATA/database-backups/db-20261012-095950-v0.10.0.sql.gz"; rm -f "$DATA/database-backups/db-20261012-095950-v0.10.0.sql.gz.bad"

# --- success
: >"$CALLS"; rm -f "$T/imports"
"$R" --yes >/dev/null 2>&1 || true
check "Version and .env are back at 0.10.0" "$(cat "$INST/VERSION"):$(sed -n 's/^WM_VERSION=//p' "$INST/.env")" "0.10.0:0.10.0"
check ".env was not touched otherwise" "$(grep -c 'SECRET=geheim' "$INST/.env"):$(grep -c 'DASHBOARD_DOMAIN=panel.example.com' "$INST/.env")" "1:1"
check "Program files from the backup are back" "$(cat "$INST/old-file" 2>/dev/null)" "old"
check "Backup dump of the current state was created first (backup.sh --db-only)" "$(grep -c 'backup.sh --db-only' "$CALLS")" "1"
check "The dump directly before the update was restored (not the one after, not the old one)" "$(cat "$T/imports")" "$want"
check "Start without rebuild, then reconcile" "$(grep -c 'up -d --no-build' "$CALLS"):$(grep -c 'job:enqueue system.reconcile' "$CALLS")" "1:1"
check "Auto update paused for the abandoned version" "$(grep -c '"version":"0.11.0","state":"failed"' "$DATA/update/auto-state.json")" "1"

# --- nothing left to roll back to
rc=0; "$R" --yes >/dev/null 2>&1 || rc=$?
check "After that there is nothing left to roll back (same version)" "$rc" "1"

# --- failure after the files were replaced: the state from before is restored
echo 0.11.0 >"$INST/VERSION"; sed -i 's/^WM_VERSION=.*/WM_VERSION=0.11.0/' "$INST/.env"; echo "new" >"$INST/new-file-0.11"; rm -f "$INST/old-file"
: >"$CALLS"; rm -f "$T/imports"; echo 2 >"$T/fail-up-at"   # 1st up = database, 2nd up = the new version's services
rc=0; "$R" --yes >/dev/null 2>&1 || rc=$?
check "Error on start: original state is restored" "$rc:$(cat "$INST/VERSION"):$(sed -n 's/^WM_VERSION=//p' "$INST/.env"):$([[ -f "$INST/new-file-0.11" ]] && echo there || echo gone)" "1:0.11.0:0.11.0:there"
safety="$(zcat "$DATA/database-backups/db-20261012-120000-v0.11.0.sql.gz" | md5sum | cut -c1-8)"
check "… including the database (the backup dump of the original state is restored last)" "$(wc -l <"$T/imports" | tr -d ' '):$(tail -n1 "$T/imports")" "2:$safety"
exit "$fail"
