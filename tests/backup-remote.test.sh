#!/usr/bin/env bash
# Unit test for scripts/backup-remote.sh and gfs_select: simulated rclone (a local directory), real gpg/tar, simulated docker.
set -Eeuo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
fail=0
check() { if [[ "$2" == "$3" ]]; then echo "  PASS  $1"; else echo "  FAIL  $1 (expected '$3', got '$2')"; fail=1; fi; }
jq_() { node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const v=process.argv[2].split(".").reduce((o,k)=>o&&o[k],j);console.log(v)' "$@"; }

# ------------------------------------------------------------------ gfs_select
# shellcheck source=../scripts/lib.sh
source "$ROOT/scripts/lib.sh"
names=$(printf '%s\n' webmanager-backup-20261012-033000-v1.tar.gz.gpg webmanager-backup-20261011-033000-v1.tar.gz.gpg webmanager-backup-20261011-010000-v1.tar.gz.gpg \
  webmanager-backup-20261005-033000-v1.tar.gz.gpg webmanager-backup-20260928-033000-v1.tar.gz.gpg webmanager-backup-20260801-033000-v1.tar.gz.gpg webmanager-backup-20260701-033000-v1.tar.gz.gpg)
check "Retention 2/2/2: newest day, week and month stay" "$(printf '%s\n' "$names" | gfs_select 2 2 2 | sed 's/webmanager-backup-//; s/-v1.*//' | tr '\n' ' ')" "20261012-033000 20261011-033000 20260928-033000 "
check "Several backups on the same day: only the newest counts" "$(printf '%s\n' "$names" | gfs_select 7 0 0 | grep -c 20261011)" "1"
check "Keep nothing without a match" "$(printf 'foo\n' | gfs_select 7 4 6 | wc -l | tr -d ' ')" "0"

# ------------------------------------------------------------------ environment
INST="$T/inst"; DATA="$T/data"; OUT="$T/data/backups"; BIN="$T/bin"; REMOTE_DIR="$T/remote"; LOGS="$T/logs"
mkdir -p "$INST/scripts" "$DATA/backups" "$BIN" "$REMOTE_DIR/bk" "$LOGS"
cp "$ROOT/scripts/lib.sh" "$ROOT/scripts/backup-remote.sh" "$INST/scripts/"
printf 'secret-passphrase-123\n' >"$T/pass"
printf 'DATA_DIR=%s\nLOG_DIR=%s\nBACKUP_DIR=%s\nBACKUP_REMOTE=fake:bk\nBACKUP_PASSPHRASE_FILE=%s\nBACKUP_REMOTE_KEEP_DAILY=2\nBACKUP_REMOTE_KEEP_WEEKLY=1\nBACKUP_REMOTE_KEEP_MONTHLY=1\n' "$DATA" "$LOGS" "$OUT" "$T/pass" >"$INST/.env"
echo 0.7.0 >"$INST/VERSION"

# simulated rclone: remote "fake:" is the directory $REMOTE_DIR
cat >"$BIN/rclone" <<EOS
#!/usr/bin/env bash
args=(); while [[ \$# -gt 0 ]]; do case "\$1" in --config) shift ;; *) args+=("\$1") ;; esac; shift; done
map() { case "\$1" in fake:*) printf '%s/%s' "$REMOTE_DIR" "\${1#fake:}" ;; *) printf '%s' "\$1" ;; esac; }
[[ "\${FAKE_RCLONE_FAIL:-0}" == "1" ]] && { echo "rclone: boom" >&2; exit 1; }
case "\${args[0]}" in
  copyto) mkdir -p "\$(dirname "\$(map "\${args[2]}")")"; cp "\$(map "\${args[1]}")" "\$(map "\${args[2]}")" ;;
  deletefile) rm -f "\$(map "\${args[1]}")" ;;
  mkdir) mkdir -p "\$(map "\${args[1]}")" ;;
  lsf) d="\$(map "\${args[\${#args[@]}-1]}")"; for f in "\$d"/*; do [[ -f "\$f" ]] && printf '%s;%s\n' "\$(stat -c %s "\$f")" "\$(basename "\$f")"; done; true ;;
esac
EOS
printf '#!/usr/bin/env bash\nexit 0\n' >"$BIN/flock"
# simulated docker for the import test: USERS_AFTER_IMPORT decides what the check query returns
cat >"$BIN/docker" <<'EOS'
#!/usr/bin/env bash
case "$1" in
  inspect) echo "mariadb:11.4.13" ;;
  run) echo "cid-throwaway" ;;
  logs) printf "ready for connections.\nVersion: x  socket: y  port: 3306\n" ;;
  exec) if [[ "$*" == *"-i"* ]]; then cat >/dev/null; elif [[ "$*" == *"COUNT(*)"* ]]; then echo "${USERS_AFTER_IMPORT:-1}"; fi ;;
  rm) : ;;
esac
EOS
chmod +x "$BIN/rclone" "$BIN/flock" "$BIN/docker" "$INST/scripts/backup-remote.sh"
export TMPDIR="$T" PATH="$BIN:$PATH" WM_INSTALL_DIR="$INST" WM_LOCK_FILE="$T/lock" FAKE_RCLONE_FAIL=0
H="$INST/scripts/backup-remote.sh"

# a backup archive with the structure backup.sh writes
make_backup() { # make_backup STAMP [plain]
  local stamp="$1" st="$T/stage-$1"
  rm -rf "$st"; mkdir -p "$st/config" "$st/data"
  printf 'DB_NAME=webmanager\nAPP_KEY=x\n' >"$st/config/.env"
  printf 'CREATE TABLE users (id int);\nCREATE TABLE sites (id int);\nINSERT INTO users VALUES (1);\n' | gzip >"$st/db.sql.gz"
  for n in letsencrypt runtime sites; do mkdir -p "$T/p/$n"; echo x >"$T/p/$n/f"; tar -C "$T/p" -cf "$st/data/$n.tar" "$n"; done
  printf '{\n  "format": 1,\n  "product": "webmanager",\n  "version": "0.7.0"\n}\n' >"$st/MANIFEST.json"
  ( cd "$st" && find . -type f ! -name SHA256SUMS ! -name MANIFEST.json -print0 | sort -z | xargs -0 sha256sum >SHA256SUMS )
  local base="webmanager-backup-$stamp-v0.7.0.tar.gz"
  tar -C "$st" -cf - . | gzip >"$OUT/$base"
  if [[ "${2:-}" != "plain" ]]; then
    gpg --batch --yes --pinentry-mode loopback --passphrase-file "$T/pass" --symmetric --cipher-algo AES256 -o "$OUT/$base.gpg" "$OUT/$base" 2>/dev/null
    rm -f "$OUT/$base"; base="$base.gpg"
  fi
  ( cd "$OUT" && sha256sum "$base" >"$base.sha256" )
  printf '%s' "$base"
}

# ------------------------------------------------------------------ upload
b1="$(make_backup 20261012-033000)"
"$H" upload "$OUT/$b1" >/dev/null 2>&1 || true
check "Upload: archive is on the target" "$([[ -f "$REMOTE_DIR/bk/$b1" ]] && echo yes || echo no)" "yes"
check "Upload: checksum file is on the target" "$([[ -f "$REMOTE_DIR/bk/$b1.sha256" ]] && echo yes || echo no)" "yes"
check "Upload: Status ok" "$(jq_ "$DATA/backup-ctl/upload.json" ok)" "true"
check "Upload: target overview counts 1 backup" "$(jq_ "$DATA/backup-ctl/remote.json" count)" "1"

p="$(make_backup 20261012-040000 plain)"
rc_=0; "$H" upload "$OUT/$p" >/dev/null 2>&1 || rc_=$?
check "Unencrypted archive is not uploaded" "$([[ -f "$REMOTE_DIR/bk/$p" ]] && echo uploaded || echo rejected)" "rejected"
check "… and reported as an error" "$rc_:$(jq_ "$DATA/backup-ctl/upload.json" ok)" "1:false"
rm -f "$OUT/$p" "$OUT/$p.sha256"

FAKE_RCLONE_FAIL=1 "$H" upload "$OUT/$b1" >/dev/null 2>&1 || true
check "Failed upload is shown in the status" "$(jq_ "$DATA/backup-ctl/upload.json" ok)" "false"

# ------------------------------------------------------------------ retention (daily 2, weekly 1, monthly 1)
for d in 20261011 20261010 20261009 20260920 20260810; do printf 'x' >"$REMOTE_DIR/bk/webmanager-backup-$d-033000-v0.7.0.tar.gz.gpg"; printf 'x' >"$REMOTE_DIR/bk/webmanager-backup-$d-033000-v0.7.0.tar.gz.gpg.sha256"; done
"$H" prune >/dev/null 2>&1
left="$(ls "$REMOTE_DIR/bk" | grep -c '\.gpg$')"
check "Retention on the target: expired backups are removed" "$left" "2"
check "… the newest always stays" "$([[ -f "$REMOTE_DIR/bk/$b1" ]] && echo yes || echo no)" "yes"
check "… its checksum file is deleted too" "$(ls "$REMOTE_DIR/bk" | grep -c 20261010)" "0"

# ------------------------------------------------------------------ restore test
"$H" verify local --quick || true; check "Restore test (local, quick) passes" "$(jq_ "$DATA/backup-ctl/verify.json" ok)" "true"
"$H" verify remote >/dev/null 2>&1 || true; check "Restore test (target, with import) passes" "$(jq_ "$DATA/backup-ctl/verify.json" scope):$(jq_ "$DATA/backup-ctl/verify.json" ok)" "remote:true"
check "… reports tables and users" "$(jq_ "$DATA/backup-ctl/verify.json" detail | grep -c '2 tables, 1 users')" "1"

rc_=0; USERS_AFTER_IMPORT=0 "$H" verify local >/dev/null 2>&1 || rc_=$?
check "Empty user table after the import = failed" "$rc_:$(jq_ "$DATA/backup-ctl/verify.json" ok)" "1:false"

cp "$OUT/$b1" "$T/good.gpg"; printf 'kaputt' | dd of="$OUT/$b1" bs=1 seek=200 conv=notrunc 2>/dev/null
rc_=0; "$H" verify local --quick >/dev/null 2>&1 || rc_=$?
check "Damaged archive is detected" "$rc_:$(jq_ "$DATA/backup-ctl/verify.json" ok)" "1:false"
cp "$T/good.gpg" "$OUT/$b1"
printf 'falsche-passphrase\n' >"$T/pass2"; cp "$T/pass" "$T/pass.bak"; cp "$T/pass2" "$T/pass"
rc_=0; "$H" verify local --quick >/dev/null 2>&1 || rc_=$?
check "Wrong passphrase is detected" "$rc_:$(jq_ "$DATA/backup-ctl/verify.json" detail | grep -c Decryption)" "1:1"
cp "$T/pass.bak" "$T/pass"

# ------------------------------------------------------------------ disaster recovery download
rm -f "$OUT/$b1" "$OUT/$b1.sha256"
"$H" fetch >/dev/null 2>&1 || true
check "fetch downloads the newest backup with its checksum" "$([[ -f "$OUT/$b1" && -f "$OUT/$b1.sha256" ]] && echo yes || echo no)" "yes"
printf 'verfaelscht' >>"$REMOTE_DIR/bk/$b1"; rm -f "$OUT/$b1" "$OUT/$b1.sha256"
rc_=0; "$H" fetch >/dev/null 2>&1 || rc_=$?
check "fetch detects a tampered archive on the target" "$rc_" "1"
rc_=0; "$H" fetch ../../etc/passwd >/dev/null 2>&1 || rc_=$?
check "fetch rejects invalid file names" "$rc_" "1"
cp "$T/good.gpg" "$OUT/$b1"; ( cd "$OUT" && sha256sum "$b1" >"$b1.sha256" )

# ------------------------------------------------------------------ requests from the dashboard
mkdir -p "$DATA/backup-ctl"
printf 'verify\n' >"$DATA/backup-ctl/request"; "$H" apply >/dev/null 2>&1
check "Request 'verify' is processed (no lock deadlock)" "$(jq_ "$DATA/backup-ctl/state.json" state):$(jq_ "$DATA/backup-ctl/state.json" action)" "ok:verify"
check "Request is consumed" "$([[ -e "$DATA/backup-ctl/request" ]] && echo there || echo gone)" "gone"
printf 'rm -rf /\n' >"$DATA/backup-ctl/request"; "$H" apply >/dev/null 2>&1
check "Invalid request is ignored" "$(jq_ "$DATA/backup-ctl/state.json" action)" "verify"
exit "$fail"
