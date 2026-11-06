#!/usr/bin/env bash
# Unit test for "backup-remote.sh setup --provider ...": writes the rclone remote for S3, Backblaze B2, SFTP and Hetzner Storage Box.
# Needs root (setup refuses otherwise), e.g.:  docker run --rm -v "$PWD":/w -w /w debian:13 bash tests/backup-remote-provider.test.sh
set -Eeuo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
fail=0
check() { if [[ "$2" == "$3" ]]; then echo "  PASS  $1"; else echo "  FAIL  $1 (expected '$3', got '$2')"; fail=1; fi; }
has() { grep -qxF -- "$2" "$CONF" && echo yes || echo no; }

INST="$T/inst"; DATA="$T/data"; BIN="$T/bin"; CONF="$T/etc/rclone.conf"; REMOTE_DIR="$T/remote"
mkdir -p "$INST/scripts" "$DATA/backups" "$BIN" "$REMOTE_DIR" "$T/logs"
cp "$ROOT/scripts/lib.sh" "$ROOT/scripts/backup-remote.sh" "$INST/scripts/"
printf 'DATA_DIR=%s\nLOG_DIR=%s\nBACKUP_RCLONE_CONFIG=%s\nBACKUP_PASSPHRASE_FILE=%s\n' "$DATA" "$T/logs" "$CONF" "$T/pass" >"$INST/.env"
echo 0.7.0 >"$INST/VERSION"; printf 'secret-passphrase-123\n' >"$T/pass"

# simulated rclone: every remote is a directory below $REMOTE_DIR; "obscure" just marks the value
cat >"$BIN/rclone" <<EOS
#!/usr/bin/env bash
args=(); while [[ \$# -gt 0 ]]; do case "\$1" in --config) shift ;; *) args+=("\$1") ;; esac; shift; done
map() { printf '%s/%s' "$REMOTE_DIR" "\${1/:/_}"; }
case "\${args[0]}" in
  obscure) printf 'OBSCURED:'; cat ;;
  mkdir) mkdir -p "\$(map "\${args[1]}")" ;;
  copyto) mkdir -p "\$(dirname "\$(map "\${args[2]}")")"; cp "\${args[1]}" "\$(map "\${args[2]}")" ;;
  deletefile) rm -f "\$(map "\${args[1]}")" ;;
esac
EOS
chmod +x "$BIN/rclone"
export TMPDIR="$T" PATH="$BIN:$PATH" WM_INSTALL_DIR="$INST"
H="$INST/scripts/backup-remote.sh"
run() { "$H" setup "$@" >"$T/out" 2>&1; }
code() { local rc=0; "$@" >"$T/out" 2>&1 || rc=$?; echo "$rc"; }

# ---- S3
BACKUP_REMOTE_SECRET='s3-secret/KEY+1' run --provider s3 --name wms3 --bucket my-bucket --path wm --endpoint https://s3.example.com --region eu-1 --s3-provider Other --access-key AKIA123
check "S3: remote path is in the .env" "$(grep '^BACKUP_REMOTE=' "$INST/.env")" "BACKUP_REMOTE=wms3:my-bucket/wm"
check "S3: section and type" "$(has x '[wms3]'):$(has x 'type = s3')" "yes:yes"
check "S3: key, secret, endpoint, region" "$(has x 'access_key_id = AKIA123'):$(has x 'secret_access_key = s3-secret/KEY+1'):$(has x 'endpoint = https://s3.example.com'):$(has x 'region = eu-1')" "yes:yes:yes:yes"
check "Configuration readable by root only (0600)" "$(stat -c %a "$CONF")" "600"
check "The secret does not appear in the output" "$(grep -c 's3-secret' "$T/out" || true)" "0"

# ---- Backblaze B2 (second remote keeps the first)
BACKUP_REMOTE_SECRET='appkey-xyz' run --provider b2 --name wmb2 --bucket b2-bucket --account 0012345abc
check "B2: remote path" "$(grep '^BACKUP_REMOTE=' "$INST/.env")" "BACKUP_REMOTE=wmb2:b2-bucket"
check "B2: section with key ID and application key" "$(has x '[wmb2]'):$(has x 'account = 0012345abc'):$(has x 'key = appkey-xyz')" "yes:yes:yes"
check "S3 section is kept" "$(has x '[wms3]')" "yes"

# ---- Hetzner Storage Box: SFTP on port 23
BACKUP_REMOTE_SECRET='box-pass' run --provider hetzner --name hetzner --user u123456
check "Hetzner: host and port" "$(has x 'host = u123456.your-storagebox.de'):$(has x 'port = 23'):$(has x 'user = u123456')" "yes:yes:yes"
check "Hetzner: password is stored obscured" "$(has x 'pass = OBSCURED:box-pass')" "yes"
check "Hetzner: Standardpfad" "$(grep '^BACKUP_REMOTE=' "$INST/.env")" "BACKUP_REMOTE=hetzner:webmanager-backups"
BACKUP_REMOTE_SECRET='x' run --provider hetzner --name hsub --user u123456-sub1
check "Hetzner sub-account: host of the main account" "$(has x 'host = u123456.your-storagebox.de'):$(has x 'user = u123456-sub1')" "yes:yes"

# ---- generic SFTP with key file, run twice: the section is replaced, not duplicated
printf 'KEY\n' >"$T/id"
run --provider sftp --name wmsftp --host backup.example.com --port 2222 --user bk --key-file "$T/id" --path /srv/backups
run --provider sftp --name wmsftp --host backup2.example.com --user bk --key-file "$T/id" --path /srv/backups
check "SFTP: section is replaced (exactly once)" "$(grep -c '^\[wmsftp\]' "$CONF")" "1"
check "SFTP: new host, key file, no password" "$(has x 'host = backup2.example.com'):$(has x "key_file = $T/id"):$(grep -c '^pass' "$CONF" | tr -d '\n')" "yes:yes:2"

# ---- rejects
check "Unknown provider" "$(code env BACKUP_REMOTE_SECRET=x "$H" setup --provider ftp --name a)" "1"
check "Host with line break/extra text is rejected" "$(code env BACKUP_REMOTE_SECRET=x "$H" setup --provider sftp --name a --host $'evil.example.com\nexec = x' --user bk)" "1"
check "Invalid bucket name" "$(code env BACKUP_REMOTE_SECRET=x "$H" setup --provider s3 --name a --bucket 'a b' --access-key K)" "1"
check "Secret with line break is rejected" "$(code env BACKUP_REMOTE_SECRET=$'a\nb' "$H" setup --provider b2 --name a --bucket bkt-1 --account K)" "1"
check "Path with forbidden characters" "$(code env BACKUP_REMOTE_SECRET=x "$H" setup --provider b2 --name a --bucket bkt-1 --account K --path 'a;b')" "1"
check "Invalid port" "$(code env BACKUP_REMOTE_SECRET=x "$H" setup --provider sftp --name a --host h.example.com --port 99999 --user bk)" "1"
check "--remote and --provider together" "$(code env BACKUP_REMOTE_SECRET=x "$H" setup --provider s3 --remote a:b)" "1"
check "Hetzner without a valid user" "$(code env BACKUP_REMOTE_SECRET=x "$H" setup --provider hetzner --name a --user root)" "1"
exit "$fail"
