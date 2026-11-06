#!/usr/bin/env bash
# WebManager - external backup target (rclone), retention and restore test. Runs as root on the host.
#
#   backup-remote.sh setup --remote NAME:PATH     connect an rclone remote, create the encryption passphrase, test the connection
#   backup-remote.sh setup --provider s3|b2|sftp|hetzner ...   create the rclone remote for a common target first (no rclone knowledge needed):
#       s3       --name N --bucket B [--path P] [--endpoint URL] [--region R] [--s3-provider AWS|Wasabi|Other|...] --access-key ID   (secret key is asked)
#       b2       --name N --bucket B [--path P] --account KEYID                                                                    (application key is asked)
#       sftp     --name N --host H [--port 22] --user U [--path P] [--key-file F]                                                 (password is asked unless --key-file)
#       hetzner  --name N --user uXXXXXX [--path P]                                                                               (Storage Box: SFTP, port 23; password is asked)
#     Secrets are never arguments (they would show up in the process list): they are asked on the terminal, or read from stdin / BACKUP_REMOTE_SECRET.
#   backup-remote.sh upload [ARCHIVE]              copy the newest (or the given) backup to the target, then apply the retention
#   backup-remote.sh prune                        apply the retention on the target (daily/weekly/monthly)
#   backup-remote.sh verify [local|remote] [--quick]   restore test: decrypt, check checksums, import the dump into a throwaway database
#   backup-remote.sh fetch [--remote NAME:PATH] [FILE]   download the newest (or the given) backup, e.g. onto a fresh server before restore.sh
#   backup-remote.sh apply                        process a request from the dashboard (DATA_DIR/backup-ctl/request)
#   backup-remote.sh install                      systemd units (dashboard requests, weekly restore test) and status directory
#   backup-remote.sh status                       show the state
#
# The rclone configuration (credentials) stays on the host (default /etc/webmanager/rclone.conf, mode 0600): the dashboard
# never sees it and cannot change the target. Archives are only uploaded encrypted (gpg, see BACKUP_PASSPHRASE_FILE) because they
# contain secrets. .env: BACKUP_REMOTE, BACKUP_RCLONE_CONFIG, BACKUP_PASSPHRASE_FILE, BACKUP_REMOTE_KEEP_DAILY/WEEKLY/MONTHLY (7/4/6).
set -Eeuo pipefail
IFS=$'\n\t'
umask 077

SELF="$(readlink -f -- "${BASH_SOURCE[0]}")"
INSTALL_DIR="${WM_INSTALL_DIR:-$(dirname -- "$(dirname -- "$SELF")")}"
# shellcheck source=lib.sh
source "$INSTALL_DIR/scripts/lib.sh"

NAME_RE='^webmanager-backup-[0-9]{8}-[0-9]{6}-v[0-9][0-9A-Za-z.-]*\.tar\.gz(\.gpg)?$'
REMOTE_RE='^[A-Za-z0-9_.-]+:[A-Za-z0-9._/-]*$'
UNITS=(webmanager-backupreq.path webmanager-backupreq.service webmanager-backupverify.service webmanager-backupverify.timer)

# JSON-safe short text for the status files
json_text() { printf '%s' "$1" | tr -d '"\\\000-\037' | cut -c1-300; }
now_utc() { date -u +%Y-%m-%dT%H:%M:%SZ; }
write_atomic() { local f="$1"; cat >"$f.tmp" && mv -f "$f.tmp" "$f"; }

load_config() {
  DATA_DIR="$(env_get DATA_DIR)" || die "DATA_DIR is missing in $INSTALL_DIR/.env"
  LOG_DIR="$(env_get LOG_DIR || echo "$WM_DEFAULT_LOG_DIR")"
  OUTPUT="$(env_get BACKUP_DIR || echo "$DATA_DIR/backups")"
  REMOTE="$(env_get BACKUP_REMOTE || true)"
  RCLONE_CONF="$(env_get BACKUP_RCLONE_CONFIG || echo /etc/webmanager/rclone.conf)"
  PASSFILE="$(env_get BACKUP_PASSPHRASE_FILE || true)"
  KEEP_D="$(env_get BACKUP_REMOTE_KEEP_DAILY || echo 7)"
  KEEP_W="$(env_get BACKUP_REMOTE_KEEP_WEEKLY || echo 4)"
  KEEP_M="$(env_get BACKUP_REMOTE_KEEP_MONTHLY || echo 6)"
  CTL="$DATA_DIR/backup-ctl"
  [[ "$KEEP_D" =~ ^[0-9]+$ && "$KEEP_W" =~ ^[0-9]+$ && "$KEEP_M" =~ ^[0-9]+$ ]] || die "BACKUP_REMOTE_KEEP_* erwarten Zahlen."
  [[ -z "$REMOTE" || "$REMOTE" =~ $REMOTE_RE ]] || die "BACKUP_REMOTE has an invalid format (expected NAME:PATH)."
}

# ---- rclone remotes for common providers (written into the host-only rclone.conf, mode 0600)
RE_NAME='^[A-Za-z0-9_-]{1,40}$'
RE_HOST='^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$'
RE_USER='^[A-Za-z0-9._@-]{1,100}$'
RE_KEY='^[A-Za-z0-9/+=._-]{1,200}$'
RE_PATH='^[A-Za-z0-9._/-]*$'
RE_URL='^https?://[A-Za-z0-9._:/-]+$'

# secret from BACKUP_REMOTE_SECRET, the terminal (hidden) or the first line of stdin
read_secret() {
  local prompt="$1" v=""
  if [[ -n "${BACKUP_REMOTE_SECRET:-}" ]]; then v="$BACKUP_REMOTE_SECRET"
  elif [[ -t 0 ]]; then read -rsp "$prompt: " v </dev/tty; echo >&2
  else IFS= read -r v || true; fi
  [[ -n "$v" ]] || die "No secret given ($prompt)."
  [[ "$v" != *$'\n'* && "$v" != *$'\r'* ]] || die "The secret must not contain a line break."
  printf '%s' "$v"
}

# replace (or add) the [name] section of the rclone configuration; the section text comes on stdin
write_remote_section() {
  local name="$1" tmp
  install -d -m 0700 "$(dirname "$RCLONE_CONF")"
  tmp="$(mktemp "${TMPDIR:-/var/tmp}/wm-rclone.XXXXXX")"
  if [[ -f "$RCLONE_CONF" ]]; then
    awk -v n="[$name]" '/^\[/ { skip = ($0 == n) } !skip { print }' "$RCLONE_CONF" >"$tmp"
  fi
  { [[ ! -s "$tmp" ]] || echo; cat; } >>"$tmp"
  chmod 600 "$tmp"; mv -f "$tmp" "$RCLONE_CONF"
}

# create_remote PROVIDER NAME KEY=VALUE... (validated values only); prints the remote path prefix "NAME:" on success
create_remote() {
  local provider="$1" name="$2"; shift 2
  local -A o=()
  local kv
  for kv in "$@"; do o["${kv%%=*}"]="${kv#*=}"; done
  [[ "$name" =~ $RE_NAME ]] || die "Invalid name (allowed: letters, digits, _ and -)."
  case "$provider" in
    s3)
      [[ -n "${o[access_key]:-}" && "${o[access_key]}" =~ $RE_KEY ]] || die "--access-key is missing or invalid."
      [[ -z "${o[endpoint]:-}" || "${o[endpoint]}" =~ $RE_URL ]] || die "--endpoint must be an http(s) address."
      [[ -z "${o[region]:-}" || "${o[region]}" =~ ^[A-Za-z0-9-]{1,40}$ ]] || die "--region is invalid."
      [[ "${o[s3provider]:-AWS}" =~ ^[A-Za-z0-9]{1,30}$ ]] || die "--s3-provider is invalid."
      local secret; secret="$(read_secret 'Secret Access Key')"
      [[ "$secret" =~ $RE_KEY ]] || die "The secret access key contains forbidden characters."
      { printf '[%s]\ntype = s3\nprovider = %s\nenv_auth = false\naccess_key_id = %s\nsecret_access_key = %s\n' "$name" "${o[s3provider]:-AWS}" "${o[access_key]}" "$secret"
        [[ -z "${o[region]:-}" ]] || printf 'region = %s\n' "${o[region]}"
        [[ -z "${o[endpoint]:-}" ]] || printf 'endpoint = %s\n' "${o[endpoint]}"
        printf 'acl = private\n'; } | write_remote_section "$name" ;;
    b2)
      [[ -n "${o[account]:-}" && "${o[account]}" =~ $RE_KEY ]] || die "--account (key ID) is missing or invalid."
      local appkey; appkey="$(read_secret 'Application Key')"
      [[ "$appkey" =~ $RE_KEY ]] || die "The application key contains forbidden characters."
      printf '[%s]\ntype = b2\naccount = %s\nkey = %s\nhard_delete = true\n' "$name" "${o[account]}" "$appkey" | write_remote_section "$name" ;;
    sftp|hetzner)
      local host="${o[host]:-}" port="${o[port]:-22}"
      if [[ "$provider" == "hetzner" ]]; then
        [[ "${o[user]:-}" =~ ^u[0-9]+(-sub[0-9]+)?$ ]] || die "--user: user name of the Storage Box (e.g. u123456 or u123456-sub1)."
        host="${o[user]%%-sub*}.your-storagebox.de"; port=23
      fi
      [[ "$host" =~ $RE_HOST ]] || die "--host is missing or invalid."
      [[ "$port" =~ ^[0-9]{1,5}$ && "$port" -ge 1 && "$port" -le 65535 ]] || die "--port is invalid."
      [[ "${o[user]:-}" =~ $RE_USER ]] || die "--user is missing or invalid."
      local sec=""
      if [[ -n "${o[key_file]:-}" ]]; then
        [[ -f "${o[key_file]}" ]] || die "Key file not found: ${o[key_file]}"
        sec="key_file = ${o[key_file]}"
      else
        have rclone || die "rclone wird benoetigt: apt-get install rclone"
        sec="pass = $(read_secret 'Password' | rclone obscure -)"
      fi
      printf '[%s]\ntype = sftp\nhost = %s\nport = %s\nuser = %s\n%s\n' "$name" "$host" "$port" "${o[user]}" "$sec" | write_remote_section "$name" ;;
    *) die "Unknown provider: $provider (s3, b2, sftp, hetzner)" ;;
  esac
  chmod 600 "$RCLONE_CONF"
}

rc() {
  if [[ -f "$RCLONE_CONF" ]]; then rclone --config "$RCLONE_CONF" "$@"; else rclone "$@"; fi
}

need_remote() {
  [[ -n "$REMOTE" ]] || die "No external target set up. First: backup-remote.sh setup --remote NAME:PATH"
  have rclone || die "rclone wird benoetigt (apt-get install rclone)."
}

latest_local() { ls -1t "$OUTPUT"/webmanager-backup-*.tar.gz "$OUTPUT"/webmanager-backup-*.tar.gz.gpg 2>/dev/null | head -n1 || true; }

# "size;name" lines of the archives on the target (archives only, no checksum files)
remote_list() { rc lsf --files-only --format sp --separator ';' "$REMOTE" 2>/dev/null | grep -E ";webmanager-backup-.*\.tar\.gz(\.gpg)?$" || true; }

write_remote_info() {
  local count=0 bytes=0 line
  while IFS=';' read -r size _; do [[ -n "$size" ]] || continue; count=$((count + 1)); bytes=$((bytes + size)); done < <(remote_list)
  printf '{"count":%s,"bytes":%s,"at":"%s"}\n' "$count" "$bytes" "$(now_utc)" | write_atomic "$CTL/remote.json"
}

write_meta() {
  local apply=false
  if have systemctl && systemctl is-active --quiet webmanager-backupreq.path 2>/dev/null; then apply=true; fi
  printf '{"apply":%s,"configured":%s,"remote":"%s","encrypted":%s,"keep":{"daily":%s,"weekly":%s,"monthly":%s},"at":"%s"}\n' \
    "$apply" "$([[ -n "$REMOTE" ]] && echo true || echo false)" "$(json_text "$REMOTE")" "$([[ -n "$PASSFILE" && -f "$PASSFILE" ]] && echo true || echo false)" \
    "$KEEP_D" "$KEEP_W" "$KEEP_M" "$(now_utc)" | write_atomic "$CTL/meta.json"
}

prune() {
  need_remote
  local -a names keep drop
  mapfile -t names < <(remote_list | cut -d';' -f2- | sort -r)
  [[ ${#names[@]} -gt 0 ]] || return 0
  mapfile -t keep < <(printf '%s\n' "${names[@]}" | gfs_select "$KEEP_D" "$KEEP_W" "$KEEP_M")
  # never delete everything: the newest backup always stays
  local n k found removed=0
  for n in "${names[@]}"; do
    found=0; for k in "${keep[@]:-}"; do [[ "$k" == "$n" ]] && { found=1; break; }; done
    [[ "$n" == "${names[0]}" ]] && found=1
    if [[ $found -eq 0 ]]; then
      info "Removing expired backup on the target: $n"
      rc deletefile "$REMOTE/$n" || warn "Could not delete $n."
      rc deletefile "$REMOTE/$n.sha256" >/dev/null 2>&1 || true
      removed=$((removed + 1))
    fi
  done
  ok "Retention on the target: ${#keep[@]} backup(s) kept, $removed removed (daily $KEEP_D, weekly $KEEP_W, monthly $KEEP_M)."
}

upload() {
  need_remote
  local archive="${1:-}" base size rsize at
  [[ -n "$archive" ]] || archive="$(latest_local)"
  [[ -n "$archive" && -f "$archive" ]] || die "No local backup found. Run backup.sh first."
  base="$(basename "$archive")"
  [[ "$base" =~ $NAME_RE ]] || die "Invalid backup file name: $base"
  if [[ "$base" != *.gpg && "$(env_get BACKUP_REMOTE_ALLOW_PLAIN || true)" != "1" ]]; then
    json_upload false "$base" 0 "The archive is not encrypted and is not uploaded (set up a passphrase file: backup-remote.sh setup)."
    die "The archive is not encrypted (contains .env and private keys) - no upload. Set up a passphrase: backup-remote.sh setup"
  fi
  size="$(stat -c %s "$archive")"
  info "Uploading $base ($(human_bytes "$size")) to $REMOTE ..."
  if ! rc copyto "$archive" "$REMOTE/$base"; then
    json_upload false "$base" "$size" "Upload failed (check the connection, credentials or storage space on the target)."
    die "Upload failed."
  fi
  [[ ! -f "$archive.sha256" ]] || rc copyto "$archive.sha256" "$REMOTE/$base.sha256" || warn "The checksum file could not be uploaded."
  rsize="$(remote_list | awk -F';' -v b="$base" '$2 == b { print $1; exit }')"
  if [[ "$rsize" != "$size" ]]; then
    json_upload false "$base" "$size" "The size on the target (${rsize:-?}) differs from the local one ($size)."
    die "Upload incomplete: size on the target ${rsize:-?} instead of $size."
  fi
  json_upload true "$base" "$size" ""
  ok "Backup is on the external target."
  prune || warn "Retention on the target could not be applied."
  write_remote_info
}

json_upload() { # json_upload OK FILE SIZE ERROR
  [[ -d "$CTL" ]] || return 0
  printf '{"ok":%s,"at":"%s","file":"%s","size":%s,"error":"%s"}\n' "$1" "$(now_utc)" "$(json_text "$2")" "${3:-0}" "$(json_text "$4")" | write_atomic "$CTL/upload.json"
}

json_verify() { # json_verify OK FILE SCOPE DETAIL SECONDS
  [[ -d "$CTL" ]] || return 0
  printf '{"ok":%s,"at":"%s","file":"%s","scope":"%s","detail":"%s","seconds":%s}\n' "$1" "$(now_utc)" "$(json_text "$2")" "$3" "$(json_text "$4")" "${5:-0}" | write_atomic "$CTL/verify.json"
}

# ---------------------------------------------------------------- restore test
VERIFY_WORK=""; VERIFY_CID=""
verify_cleanup() {
  [[ -z "$VERIFY_CID" ]] || docker rm -f "$VERIFY_CID" >/dev/null 2>&1 || true
  [[ -z "$VERIFY_WORK" ]] || rm -rf "$VERIFY_WORK"
}

verify_fail() { # verify_fail FILE SCOPE MESSAGE START
  json_verify false "$1" "$2" "$3" "$(( $(date +%s) - $4 ))"
  verify_cleanup; trap - EXIT
  die "Restore test failed: $3"
}

verify() {
  local scope="local" quick=0 file="" src start name tables users db pw image i
  while [[ $# -gt 0 ]]; do case "$1" in local|remote|auto) scope="$1" ;; --quick) quick=1 ;; *) die "Unknown option: $1" ;; esac; shift; done
  start="$(date +%s)"
  if [[ "$scope" == "auto" ]]; then if [[ -n "$REMOTE" ]]; then scope="remote"; else scope="local"; fi; fi
  VERIFY_WORK="$(mktemp -d "${TMPDIR:-/var/tmp}/wm-verify.XXXXXX")"; trap verify_cleanup EXIT

  if [[ "$scope" == "remote" ]]; then
    need_remote
    name="$(remote_list | cut -d';' -f2- | sort -r | head -n1)"
    [[ -n "$name" ]] || verify_fail "" remote "There is no backup on the external target." "$start"
    [[ "$name" =~ $NAME_RE ]] || verify_fail "$name" remote "Invalid file name on the target." "$start"
    info "Downloading $name from the external target ..."
    rc copyto "$REMOTE/$name" "$VERIFY_WORK/$name" || verify_fail "$name" remote "Download from the target failed." "$start"
    if rc copyto "$REMOTE/$name.sha256" "$VERIFY_WORK/$name.sha256" >/dev/null 2>&1; then
      ( cd "$VERIFY_WORK" && sha256sum -c --quiet "$name.sha256" ) || verify_fail "$name" remote "The checksum of the downloaded archive does not match." "$start"
    fi
    file="$VERIFY_WORK/$name"
  else
    file="$(latest_local)"
    [[ -n "$file" ]] || verify_fail "" local "No local backup available." "$start"
    name="$(basename "$file")"
    if [[ -f "$file.sha256" ]]; then
      ( cd "$OUTPUT" && sha256sum -c --quiet "$name.sha256" ) || verify_fail "$name" local "The checksum of the archive does not match." "$start"
    fi
  fi

  src="$file"
  if [[ "$name" == *.gpg ]]; then
    [[ -n "$PASSFILE" && -f "$PASSFILE" ]] || verify_fail "$name" "$scope" "Passphrase file missing (BACKUP_PASSPHRASE_FILE)." "$start"
    have gpg || verify_fail "$name" "$scope" "gpg is missing." "$start"
    gpg --batch --yes --pinentry-mode loopback --passphrase-file "$PASSFILE" -d -o "$VERIFY_WORK/backup.tar.gz" "$file" 2>/dev/null \
      || verify_fail "$name" "$scope" "Decryption failed (wrong passphrase or damaged archive)." "$start"
    src="$VERIFY_WORK/backup.tar.gz"
  fi
  tar -tzf "$src" >"$VERIFY_WORK/list" 2>/dev/null || verify_fail "$name" "$scope" "The archive is not readable." "$start"
  if grep -Eq '(^/|(^|/)\.\.(/|$))' "$VERIFY_WORK/list"; then verify_fail "$name" "$scope" "The archive contains invalid paths." "$start"; fi
  mkdir -p "$VERIFY_WORK/x"
  tar -xzf "$src" -C "$VERIFY_WORK/x" --numeric-owner
  ( cd "$VERIFY_WORK/x" && sha256sum -c --quiet SHA256SUMS ) || verify_fail "$name" "$scope" "Content checksums do not match - the archive is damaged." "$start"
  grep -q '"product": "webmanager"' "$VERIFY_WORK/x/MANIFEST.json" || verify_fail "$name" "$scope" "Not a WebManager backup (manifest missing)." "$start"
  for t in letsencrypt runtime; do tar -tf "$VERIFY_WORK/x/data/$t.tar" >/dev/null 2>&1 || verify_fail "$name" "$scope" "data/$t.tar is not readable." "$start"; done
  [[ ! -f "$VERIFY_WORK/x/data/sites.tar" ]] || tar -tf "$VERIFY_WORK/x/data/sites.tar" >/dev/null 2>&1 || verify_fail "$name" "$scope" "data/sites.tar is not readable." "$start"
  gzip -t "$VERIFY_WORK/x/db.sql.gz" || verify_fail "$name" "$scope" "Database dump is damaged." "$start"
  tables="$(zcat "$VERIFY_WORK/x/db.sql.gz" | grep -c 'CREATE TABLE' || true)"
  (( tables > 0 )) || verify_fail "$name" "$scope" "The database dump contains no tables." "$start"

  local detail="Archive, checksums and dump verified ($tables tables)"
  if [[ $quick -eq 0 ]]; then
    have docker || verify_fail "$name" "$scope" "docker is missing for the import test." "$start"
    db="$(env_get DB_NAME "$VERIFY_WORK/x/config/.env" || true)"
    [[ "$db" =~ ^[A-Za-z0-9_]+$ ]] || verify_fail "$name" "$scope" "Datenbankname im Backup ungueltig." "$start"
    image="$(docker inspect -f '{{.Config.Image}}' wm-db 2>/dev/null || true)"; image="${image:-mariadb:11.4}"
    pw="$(gen_secret 16)"
    info "Starting a throw-away database ($image, without network) for the import test ..."
    VERIFY_CID="$(docker run -d --rm --network none --memory 768m --pids-limit 256 --tmpfs /var/lib/mysql:rw,size=1g \
      -e MARIADB_ROOT_PASSWORD="$pw" "$image" --character-set-server=utf8mb4 --collation-server=utf8mb4_unicode_ci 2>/dev/null)" || verify_fail "$name" "$scope" "The throw-away database could not be started." "$start"
    # the image first runs a temporary server (port 0) for its initialisation and then restarts it: only the final one counts
    for i in $(seq 1 60); do
      # MariaDB 11.4 prints "ready for connections." and "Version: ... port: 3306" on two lines: join the lines before matching
      docker logs "$VERIFY_CID" 2>&1 | tr '\n' ' ' | grep -q 'ready for connections.*port: 3306' && break
      sleep 3
      [[ $i -lt 60 ]] || verify_fail "$name" "$scope" "The throw-away database did not become ready." "$start"
    done
    zcat "$VERIFY_WORK/x/db.sql.gz" | MYSQL_PWD="$pw" docker exec -i -e MYSQL_PWD "$VERIFY_CID" mariadb -uroot --default-character-set=utf8mb4 >/dev/null 2>"$VERIFY_WORK/import.err" \
      || verify_fail "$name" "$scope" "Import of the dump failed: $(tail -n1 "$VERIFY_WORK/import.err")" "$start"
    users="$(MYSQL_PWD="$pw" docker exec -e MYSQL_PWD "$VERIFY_CID" mariadb -uroot -N -e "SELECT COUNT(*) FROM \`$db\`.users" 2>/dev/null || echo 0)"
    [[ "$users" =~ ^[0-9]+$ ]] && (( users > 0 )) || verify_fail "$name" "$scope" "After the import there are no users in the database (table users empty or missing)." "$start"
    detail="Archive, checksums and dump verified, import into the throw-away database successful ($tables tables, $users users)"
  fi
  json_verify true "$name" "$scope" "$detail" "$(( $(date +%s) - start ))"
  verify_cleanup; trap - EXIT
  ok "Restore-Test bestanden ($scope): $name - $detail"
}

# ---------------------------------------------------------------- dashboard requests
write_state() { # write_state STATE ACTION LOGNAME
  printf '{"state":"%s","action":"%s","at":"%s","log":"%s"}\n' "$1" "$2" "$(now_utc)" "$3" | write_atomic "$CTL/state.json"
}

apply_request() {
  local req="$CTL/request" line action log
  [[ -f "$req" ]] || return 0
  line="$(head -c 64 "$req" | head -n1 || true)"
  rm -f "$req"
  case "$line" in
    backup|upload|verify|verify-remote) action="$line" ;;
    *) warn "Unknown request - ignored."; return 0 ;;
  esac
  mkdir -p "$LOG_DIR"
  log="backup-request-$(date +%Y%m%d-%H%M%S).log"
  : >"$LOG_DIR/$log"; chmod 640 "$LOG_DIR/$log"
  write_state running "$action" "$log"
  local rc_=0
  case "$action" in
    backup) "$INSTALL_DIR/backup.sh" --non-interactive >"$LOG_DIR/$log" 2>&1 || rc_=$? ;;
    upload) "$SELF" upload >"$LOG_DIR/$log" 2>&1 || rc_=$? ;;
    verify) "$SELF" verify local >"$LOG_DIR/$log" 2>&1 || rc_=$? ;;
    verify-remote) "$SELF" verify remote >"$LOG_DIR/$log" 2>&1 || rc_=$? ;;
  esac
  if [[ $rc_ -eq 0 ]]; then write_state ok "$action" "$log"; else write_state failed "$action" "$log"; fi
  write_meta; [[ -z "$REMOTE" ]] || write_remote_info || true
}

# ---------------------------------------------------------------- setup / install
setup() {
  require_root
  local remote="" pf="" provider="" rname="" rpath="" bucket=""
  local -a ropts=()
  while [[ $# -gt 0 ]]; do case "$1" in
    --remote) remote="${2:?}"; shift ;;
    --passphrase-file) pf="${2:?}"; shift ;;
    --provider) provider="${2:?}"; shift ;;
    --name) rname="${2:?}"; shift ;;
    --path) rpath="${2:?}"; shift ;;
    --bucket) bucket="${2:?}"; shift ;;
    --host) ropts+=("host=${2:?}"); shift ;;
    --port) ropts+=("port=${2:?}"); shift ;;
    --user) ropts+=("user=${2:?}"); shift ;;
    --key-file) ropts+=("key_file=${2:?}"); shift ;;
    --endpoint) ropts+=("endpoint=${2:?}"); shift ;;
    --region) ropts+=("region=${2:?}"); shift ;;
    --s3-provider) ropts+=("s3provider=${2:?}"); shift ;;
    --access-key) ropts+=("access_key=${2:?}"); shift ;;
    --account) ropts+=("account=${2:?}"); shift ;;
    *) die "Unknown option: $1" ;; esac; shift; done
  if [[ -n "$provider" ]]; then
    [[ -z "$remote" ]] || die "--remote and --provider exclude each other."
    [[ -n "$rname" ]] || rname="wmbackup"
    [[ "$rpath" =~ $RE_PATH ]] || die "--path contains forbidden characters."
    case "$provider" in
      s3|b2) [[ "$bucket" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{1,62}$ ]] || die "--bucket is missing or invalid."; remote="$rname:$bucket${rpath:+/${rpath#/}}" ;;
      sftp|hetzner) remote="$rname:${rpath:-webmanager-backups}" ;;
    esac
    have rclone || die "rclone wird benoetigt: apt-get install rclone"
    create_remote "$provider" "$rname" ${ropts[@]+"${ropts[@]}"}
    info "Remote '$rname' created in $RCLONE_CONF."
  fi
  [[ "$remote" =~ $REMOTE_RE ]] || die "Usage: setup --remote NAME:PATH (NAME = remote created in 'rclone config', e.g. hetzner:webmanager-backups)"
  have rclone || die "rclone wird benoetigt: apt-get install rclone"
  REMOTE="$remote"
  info "Checking the connection to $REMOTE ..."
  rc mkdir "$REMOTE" || die "Connection to $REMOTE failed. Set up the remote with 'rclone config --config $RCLONE_CONF' and check the credentials."
  local t; t="$(mktemp "${TMPDIR:-/var/tmp}/wm-remote-test.XXXXXX")"
  printf 'Test file of the WebManager\n' >"$t"
  if ! { rc copyto "$t" "$REMOTE/.wm-test" && rc deletefile "$REMOTE/.wm-test"; }; then rm -f "$t"; die "Writing to $REMOTE is not possible."; fi
  rm -f "$t"
  if [[ -z "$pf" ]]; then pf="${PASSFILE:-/etc/webmanager/backup.pass}"; fi
  if [[ ! -f "$pf" ]]; then
    install -d -m 0700 "$(dirname "$pf")"
    gen_secret 32 >"$pf"; chmod 600 "$pf"
    warn "New backup passphrase created: $pf"
    warn "BACK UP THIS FILE NOW OUTSIDE THE SERVER (password manager). Without it the external backups cannot be read - not even after a total failure of the server."
  fi
  env_set BACKUP_REMOTE "$remote"
  env_set BACKUP_PASSPHRASE_FILE "$pf"
  PASSFILE="$pf"
  [[ -d "$CTL" ]] && write_meta || true
  ok "External target set up: $REMOTE. From now on backup.sh uploads every full backup encrypted (timer: install.sh --enable-backup-timer)."
}

install_units() {
  require_root
  have systemctl && [[ -d /run/systemd/system ]] || { warn "systemd not available - backup helper skipped."; return 0; }
  install -d -m 0755 "$CTL"
  local f
  for f in "${UNITS[@]}"; do
    sed "s#@INSTALL_DIR@#$INSTALL_DIR#g; s#@DATA_DIR@#$DATA_DIR#g" "$INSTALL_DIR/scripts/systemd/$f" >"/etc/systemd/system/$f"
  done
  systemctl daemon-reload
  systemctl enable --now webmanager-backupreq.path webmanager-backupverify.timer >/dev/null
  write_meta
  ok "Backup helper set up (dashboard: System & settings -> Backups; weekly restore test)"
}

# Disaster recovery: on a fresh server install rclone, put rclone.conf and the passphrase back (from your password manager), then
#   backup-remote.sh fetch --remote NAME:PATH   and   restore.sh --passphrase-file <passphrase> <downloaded file>
fetch() {
  local name="" r=""
  while [[ $# -gt 0 ]]; do case "$1" in --remote) r="${2:?}"; shift ;; *) name="$1" ;; esac; shift; done
  if [[ -n "$r" ]]; then [[ "$r" =~ $REMOTE_RE ]] || die "Invalid target (expected NAME:PATH)."; REMOTE="$r"; fi
  need_remote
  [[ -n "$name" ]] || name="$(remote_list | cut -d';' -f2- | sort -r | head -n1)"
  [[ -n "$name" && "$name" =~ $NAME_RE ]] || die "No matching backup found on the target."
  mkdir -p "$OUTPUT"   # umask 077: a new directory is private
  info "Downloading $name from $REMOTE ..."
  rc copyto "$REMOTE/$name" "$OUTPUT/$name" || die "Download failed."
  if rc copyto "$REMOTE/$name.sha256" "$OUTPUT/$name.sha256" >/dev/null 2>&1; then
    ( cd "$OUTPUT" && sha256sum -c --quiet "$name.sha256" ) || die "Checksum does not match - archive damaged."
  else
    warn "No checksum file on the target - integrity not verified."
  fi
  chmod 600 "$OUTPUT/$name"
  ok "Heruntergeladen: $OUTPUT/$name"
  echo "  Restore: sudo $INSTALL_DIR/restore.sh --passphrase-file <PASSPHRASE-FILE> $OUTPUT/$name"
}

status() {
  load_config
  echo "Target:      ${REMOTE:-not set up}"
  for f in upload verify remote state; do [[ -f "$CTL/$f.json" ]] && { printf '%-8s ' "$f"; cat "$CTL/$f.json"; }; done
  true
}

main() {
  load_config
  case "${1:-}" in
    setup) shift; setup "$@" ;;
    install) install_units ;;
    status) status ;;
    fetch) shift; fetch "$@" ;;
    upload|prune|verify|apply)
      if [[ ! -d "$CTL" ]]; then
        [[ "$1" != "apply" ]] || die "Status directory $CTL is missing - please run 'backup-remote.sh install'."
        mkdir -p "$CTL"
      fi
      # one run at a time; children started by "apply" inherit WM_BR_LOCKED and must not wait for the lock their parent holds
      if [[ -z "${WM_BR_LOCKED:-}" ]]; then
        exec 8>"${WM_LOCK_FILE:-/var/lock/webmanager-backup-remote.lock}"
        flock 8
        export WM_BR_LOCKED=1
      fi
      local cmd="$1"; shift
      case "$cmd" in
        upload) upload "$@" ;;
        prune) prune ;;
        verify) verify "$@" ;;
        apply) apply_request ;;
      esac
      ;;
    *) die "Verwendung: backup-remote.sh setup|install|upload|prune|verify|fetch|apply|status" ;;
  esac
}

# The whole script is parsed before it runs: update.sh replaces this file while an update is running.
main "$@"
exit
