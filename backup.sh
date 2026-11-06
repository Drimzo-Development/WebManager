#!/usr/bin/env bash
# WebManager – consistent backup of configuration, database, websites and certificates.
#
#   sudo ./backup.sh                          full backup into BACKUP_DIR (default: <DATA_DIR>/backups)
#   sudo ./backup.sh --db-only                only a database dump (database-backups/)
#   sudo ./backup.sh --passphrase-file F      additionally encrypt the archive with gpg (AES-256)
#
# The archive contains secrets (.env, TLS private keys). It is created with mode 0600 in a 0700 directory.
set -Eeuo pipefail
IFS=$'\n\t'
umask 077

SELF="$(readlink -f -- "${BASH_SOURCE[0]}")"
INSTALL_DIR="${WM_INSTALL_DIR:-$(dirname -- "$SELF")}"
# shellcheck source=scripts/lib.sh
source "$INSTALL_DIR/scripts/lib.sh"

OUTPUT=""; KEEP_LAST=""; RETENTION_DAYS=""; WITH_SITES=1; CONSISTENT=0; PASSFILE=""; DB_ONLY=0; NO_NODE_MODULES=0; NO_REMOTE=0
ASSUME_YES=0; NON_INTERACTIVE=0

usage() {
  cat <<'EOF'
Verwendung: backup.sh [Optionen]

  --output DIR            target directory (default: BACKUP_DIR from .env)
  --retention-days N      delete backups older than N days (default: 14)
  --keep-last N           always keep at least the N newest backups (default: 3)
  --no-sites              do not back up website files (only configuration, database, certificates)
  --exclude-node-modules  node_modules-Verzeichnisse auslassen (per npm ci wiederherstellbar)
  --consistent            briefly freeze website containers during the file backup (docker pause)
  --db-only               only write a database dump to <DATA_DIR>/database-backups
  --passphrase-file FILE  additionally encrypt the archive with gpg (AES-256, symmetric)
  --no-remote             do not upload the backup to the external target (BACKUP_REMOTE, see scripts/backup-remote.sh)
  --non-interactive       no questions (e.g. for the systemd timer)
  -h, --help
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --output) OUTPUT="${2:?}"; shift ;;
    --retention-days) RETENTION_DAYS="${2:?}"; shift ;;
    --keep-last) KEEP_LAST="${2:?}"; shift ;;
    --no-sites) WITH_SITES=0 ;;
    --exclude-node-modules) NO_NODE_MODULES=1 ;;
    --consistent) CONSISTENT=1 ;;
    --db-only) DB_ONLY=1 ;;
    --passphrase-file) PASSFILE="${2:?}"; shift ;;
    --no-remote) NO_REMOTE=1 ;;
    --non-interactive) NON_INTERACTIVE=1 ;;
    -y|--yes) ASSUME_YES=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 1 ;;
  esac
  shift
done

require_root
[[ -f "$INSTALL_DIR/.env" ]] || die "No installation found in $INSTALL_DIR."
DATA_DIR="$(env_get DATA_DIR)"
LOG_DIR="$(env_get LOG_DIR || echo "$WM_DEFAULT_LOG_DIR")"
OUTPUT="${OUTPUT:-$(env_get BACKUP_DIR || echo "$DATA_DIR/backups")}"
RETENTION_DAYS="${RETENTION_DAYS:-$(env_get BACKUP_RETENTION_DAYS || echo 14)}"
KEEP_LAST="${KEEP_LAST:-$(env_get BACKUP_KEEP_LAST || echo 3)}"
[[ "$RETENTION_DAYS" =~ ^[0-9]+$ && "$KEEP_LAST" =~ ^[0-9]+$ ]] || die "--retention-days and --keep-last expect numbers."
# default passphrase for encrypted backups (also required for the upload to an external target)
if [[ -z "$PASSFILE" ]]; then pf_env="$(env_get BACKUP_PASSPHRASE_FILE || true)"; [[ -n "$pf_env" && -f "$pf_env" ]] && PASSFILE="$pf_env"; fi
[[ -z "$PASSFILE" || -f "$PASSFILE" ]] || die "Passphrase file not found: $PASSFILE"
if [[ -n "$PASSFILE" ]]; then have gpg || die "gpg is required for encryption (apt-get install gnupg)."; fi

exec 9>/var/lock/webmanager-backup.lock
flock -n 9 || die "A backup is already running."

setup_logging backup
install -d -m 0700 "$OUTPUT" "$DATA_DIR/database-backups"
STAMP="$(date +%Y%m%d-%H%M%S)"
VERSION="$(tr -d '[:space:]' <"$INSTALL_DIR/VERSION")"
STAGE="$(mktemp -d "$OUTPUT/.stage-$STAMP.XXXXXX")"
PAUSED=()

BACKUP_OK=0
write_status() { # write_status true|false – read by the agent so the dashboard can alert on failed or missing backups
  local kind=full
  [[ $DB_ONLY -eq 1 ]] && kind=db
  { printf '{"ok":%s,"at":"%s","version":"%s","kind":"%s"}\n' "$1" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$VERSION" "$kind" >"$DATA_DIR/backup-status.json.tmp" \
    && mv -f "$DATA_DIR/backup-status.json.tmp" "$DATA_DIR/backup-status.json"; } 2>/dev/null || true
}

cleanup() {
  local c
  [[ $BACKUP_OK -eq 1 ]] || write_status false
  for c in "${PAUSED[@]:-}"; do [[ -n "$c" ]] && docker unpause "$c" >/dev/null 2>&1 || true; done
  [[ -n "${ARCHIVE:-}" ]] && rm -f "$ARCHIVE.part"
  rm -rf "$STAGE"
}
trap cleanup EXIT
trap 'err "Backup failed (line $LINENO). Incomplete files are removed."; ' ERR

# Website databases (optional per-site containers): a copy of live database files would be inconsistent, so running ones are
# dumped logically instead; databases whose container is stopped are consistent on disk and stay in sites.tar.
RUNNING_DB_SITES=()
dump_site_dbs() {
  local c site eng out
  local -a ids
  mapfile -t ids < <(docker ps -q --filter 'label=drimzo.db=1')
  [[ -n "${ids[0]:-}" ]] || return 0
  mkdir -p "$STAGE/data/dbs"
  for c in "${ids[@]}"; do
    site="$(printf 'site-%03d' "$(docker inspect -f '{{index .Config.Labels "drimzo.site"}}' "$c")")"
    eng="$(docker inspect -f '{{index .Config.Labels "drimzo.dbengine"}}' "$c")"
    out="$STAGE/data/dbs/$site.sql.gz"
    info "Backing up the database of $site ($eng) …"
    case "$eng" in
      postgres) docker exec "$c" sh -c 'exec pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner --clean --if-exists' | gzip -6 >"$out" ;;
      *) docker exec "$c" sh -c 'MYSQL_PWD="$MARIADB_ROOT_PASSWORD" exec mariadb-dump -uroot --single-transaction --routines --triggers --events --hex-blob --default-character-set=utf8mb4 "$MARIADB_DATABASE"' | gzip -6 >"$out" ;;
    esac
    gzip -t "$out" || die "Database dump of $site is corrupt."
    chmod 600 "$out"
    RUNNING_DB_SITES+=("$site")
  done
}

dump_db() { # dump_db OUTFILE
  local out="$1"
  [[ "$(service_status db)" == "healthy" ]] || die "The database is not running – dump not possible."
  info "Creating a consistent database dump (single-transaction) …"
  # the root password stays inside the container environment; it never appears in argv or logs
  compose exec -T db sh -c 'MYSQL_PWD="$MARIADB_ROOT_PASSWORD" exec mariadb-dump -uroot --single-transaction --routines --triggers --events --hex-blob --default-character-set=utf8mb4 --databases "$MARIADB_DATABASE"' \
    | gzip -9 >"$out"
  gzip -t "$out" || die "Database dump is corrupt."
  [[ $(stat -c %s "$out") -gt 500 ]] || die "Database dump is suspiciously small."
  # grep -c reads the whole stream: `grep -q` would exit early and pipefail would report SIGPIPE of zcat as "no tables"
  (( $(zcat "$out" | grep -c 'CREATE TABLE' || true) > 0 )) || die "Database dump contains no tables."
  chmod 600 "$out"
}

if [[ $DB_ONLY -eq 1 ]]; then
  f="$DATA_DIR/database-backups/db-$STAMP-v$VERSION.sql.gz"
  dump_db "$f"
  BACKUP_OK=1; write_status true
  ok "Database dump: $f ($(human_bytes "$(stat -c %s "$f")"))"
  # keep the 14 newest standalone dumps
  mapfile -t old < <(ls -1t "$DATA_DIR"/database-backups/db-*.sql.gz 2>/dev/null | tail -n +15)
  for f in "${old[@]:-}"; do [[ -n "$f" ]] && { info "Removing old dump $(basename "$f")"; rm -f -- "$f"; }; done
  exit 0
fi

mkdir -p "$STAGE/config" "$STAGE/data"

info "Backing up configuration …"
cp -a "$INSTALL_DIR/.env" "$INSTALL_DIR/docker-compose.yml" "$INSTALL_DIR/VERSION" "$STAGE/config/"
mkdir -p "$STAGE/config/templates"
cp -a "$INSTALL_DIR/templates/runtimes.json" "$STAGE/config/templates/"

dump_db "$STAGE/db.sql.gz"
# standalone copy for quick restores / update.sh
cp -a "$STAGE/db.sql.gz" "$DATA_DIR/database-backups/db-$STAMP-v$VERSION.sql.gz"

if [[ $CONSISTENT -eq 1 ]]; then
  info "Briefly freezing website containers for the file backup (docker pause) …"
  mapfile -t cids < <(docker ps -q --filter 'label=drimzo.managed=true' --filter 'name=^wm-site-')
  for c in "${cids[@]:-}"; do [[ -n "$c" ]] && docker pause "$c" >/dev/null && PAUSED+=("$c"); done
fi

info "Backing up certificates and runtime data …"
tar --numeric-owner -C "$DATA_DIR" -cf "$STAGE/data/letsencrypt.tar" letsencrypt
tar --numeric-owner -C "$DATA_DIR" -cf "$STAGE/data/runtime.tar" runtime

if [[ $WITH_SITES -eq 1 ]]; then
  info "Backing up website files and configurations …"
  excl=()
  [[ $NO_NODE_MODULES -eq 1 ]] && excl+=(--exclude='node_modules')
  dump_site_dbs
  for s in "${RUNNING_DB_SITES[@]:-}"; do [[ -n "$s" ]] && excl+=(--exclude="sites/$s/db"); done
  tar --numeric-owner "${excl[@]}" -C "$DATA_DIR" -cf "$STAGE/data/sites.tar" sites
fi

if [[ ${#PAUSED[@]} -gt 0 ]]; then
  for c in "${PAUSED[@]}"; do docker unpause "$c" >/dev/null 2>&1 || true; done
  PAUSED=()
fi

info "Schreibe Manifest …"
(
  cd "$STAGE"
  find . -type f ! -name SHA256SUMS ! -name MANIFEST.json -print0 | sort -z | xargs -0 sha256sum >SHA256SUMS
)
cat >"$STAGE/MANIFEST.json" <<EOF
{
  "format": 1,
  "product": "webmanager",
  "version": "$VERSION",
  "created": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "hostname": "$(hostname)",
  "dataDir": "$DATA_DIR",
  "installDir": "$INSTALL_DIR",
  "includes": { "sites": $([[ $WITH_SITES -eq 1 ]] && echo true || echo false), "database": true, "certificates": true, "config": true },
  "consistent": $([[ $CONSISTENT -eq 1 ]] && echo true || echo false)
}
EOF

ARCHIVE="$OUTPUT/webmanager-backup-$STAMP-v$VERSION.tar.gz"
info "Creating archive …"
tar -C "$STAGE" -cf - . | gzip -6 >"$ARCHIVE.part"
tar -tzf "$ARCHIVE.part" >/dev/null || die "The archive is not readable."
mv -f "$ARCHIVE.part" "$ARCHIVE"
chmod 600 "$ARCHIVE"

if [[ -n "$PASSFILE" ]]; then
  info "Encrypting the archive with gpg (AES-256) …"
  gpg --batch --yes --pinentry-mode loopback --passphrase-file "$PASSFILE" --symmetric --cipher-algo AES256 -o "$ARCHIVE.gpg" "$ARCHIVE"
  chmod 600 "$ARCHIVE.gpg"
  shred -u "$ARCHIVE" 2>/dev/null || rm -f "$ARCHIVE"
  ARCHIVE="$ARCHIVE.gpg"
else
  warn "The archive is NOT encrypted and contains secrets (.env, private TLS keys). Encrypt it with --passphrase-file or store it safely outside the server."
fi
( cd "$OUTPUT" && sha256sum "$(basename "$ARCHIVE")" >"$(basename "$ARCHIVE").sha256" && chmod 600 "$(basename "$ARCHIVE").sha256" )
ok "Backup created: $ARCHIVE ($(human_bytes "$(stat -c %s "$ARCHIVE")"))"

# ---------------------------------------------------------------- retention
info "Retention: ${RETENTION_DAYS} days, at least ${KEEP_LAST} backups are kept."
mapfile -t all < <(ls -1t "$OUTPUT"/webmanager-backup-*.tar.gz "$OUTPUT"/webmanager-backup-*.tar.gz.gpg 2>/dev/null || true)
idx=0
for f in "${all[@]:-}"; do
  [[ -n "$f" ]] || continue
  idx=$((idx + 1))
  (( idx <= KEEP_LAST )) && continue
  if [[ -n "$(find "$f" -mtime +"$RETENTION_DAYS" -print 2>/dev/null)" ]]; then
    info "Removing expired backup $(basename "$f")"
    rm -f -- "$f" "$f.sha256"
  fi
done
# old standalone dumps follow the same age rule (but keep the 3 newest)
mapfile -t dumps < <(ls -1t "$DATA_DIR"/database-backups/db-*.sql.gz 2>/dev/null || true)
idx=0
for f in "${dumps[@]:-}"; do
  [[ -n "$f" ]] || continue
  idx=$((idx + 1)); (( idx <= 3 )) && continue
  [[ -n "$(find "$f" -mtime +"$RETENTION_DAYS" -print 2>/dev/null)" ]] && rm -f -- "$f"
done
echo "$ARCHIVE" >"$OUTPUT/.last-backup"
BACKUP_OK=1; write_status true
# external target (only complete backups; a failed upload does not make the local backup fail, it is reported in the dashboard)
if [[ $NO_REMOTE -eq 0 && $WITH_SITES -eq 1 && -n "$(env_get BACKUP_REMOTE || true)" ]]; then
  "$INSTALL_DIR/scripts/backup-remote.sh" upload "$ARCHIVE" || warn "The upload to the external target failed (the local backup exists)."
fi
ok "Done."
