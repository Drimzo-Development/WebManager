#!/usr/bin/env bash
# WebManager – restore from a backup created by backup.sh (also onto a fresh server).
#
#   1. fresh server:  sudo ./install.sh --no-admin
#   2. then:          sudo ./restore.sh /path/to/webmanager-backup-....tar.gz[.gpg]
#
# Existing data is not deleted: databases are dumped first, and data directories are renamed to
# "<name>.pre-restore-<timestamp>" so you can inspect or remove them later.
set -Eeuo pipefail
IFS=$'\n\t'
umask 077

SELF="$(readlink -f -- "${BASH_SOURCE[0]}")"
INSTALL_DIR="${WM_INSTALL_DIR:-$(dirname -- "$SELF")}"
# shellcheck source=scripts/lib.sh
source "$INSTALL_DIR/scripts/lib.sh"

ARCHIVE=""; PASSFILE=""; FORCE=0; ASSUME_YES=0; NON_INTERACTIVE=0
usage() {
  cat <<'EOF'
Usage: restore.sh [options] BACKUP-ARCHIVE

  --passphrase-file FILE   passphrase file for .gpg archives
  --force                  run without interactive confirmation (e.g. for automation)
  -h, --help
EOF
}
while [[ $# -gt 0 ]]; do
  case "$1" in
    --passphrase-file) PASSFILE="${2:?}"; shift ;;
    --force) FORCE=1 ;;
    -h|--help) usage; exit 0 ;;
    -*) echo "Unknown option: $1" >&2; usage >&2; exit 1 ;;
    *) ARCHIVE="$1" ;;
  esac
  shift
done

require_root
[[ -n "$ARCHIVE" && -f "$ARCHIVE" ]] || { usage >&2; die "Specify the backup archive."; }
[[ -f "$INSTALL_DIR/.env" ]] || die "No installation in $INSTALL_DIR. Run 'install.sh --no-admin' first."
DATA_DIR="$(env_get DATA_DIR)"
LOG_DIR="$(env_get LOG_DIR || echo "$WM_DEFAULT_LOG_DIR")"
CONFIG_BACKUP_DIR="$WM_DEFAULT_BACKUP_DIR/config-before-restore-$(date +%Y%m%d-%H%M%S)"
setup_logging restore

WORK="$(mktemp -d /var/tmp/wm-restore.XXXXXX)"
trap 'rm -rf "$WORK"' EXIT
trap 'err "Restore failed (line $LINENO). Existing data was renamed, not deleted (*.pre-restore-*)."' ERR

# ---- decrypt + verify
SRC="$ARCHIVE"
if [[ "$ARCHIVE" == *.gpg ]]; then
  [[ -n "$PASSFILE" && -f "$PASSFILE" ]] || die "--passphrase-file is required for .gpg archives."
  info "Decrypting archive …"
  gpg --batch --yes --pinentry-mode loopback --passphrase-file "$PASSFILE" -d -o "$WORK/backup.tar.gz" "$ARCHIVE"
  SRC="$WORK/backup.tar.gz"
fi
if [[ -f "$ARCHIVE.sha256" && "$SRC" == "$ARCHIVE" ]]; then
  ( cd "$(dirname "$ARCHIVE")" && sha256sum -c "$(basename "$ARCHIVE").sha256" ) || die "The checksum of the archive does not match."
fi
mkdir -p "$WORK/x"
if tar -tzf "$SRC" | grep -Eq '(^/|(^|/)\.\.(/|$))'; then die "The archive contains invalid paths."; fi
tar -xzf "$SRC" -C "$WORK/x" --numeric-owner
( cd "$WORK/x" && sha256sum -c --quiet SHA256SUMS ) || die "Content checksums do not match – the archive is corrupt."
grep -q '"product": "webmanager"' "$WORK/x/MANIFEST.json" || die "Not a WebManager backup."
B_VERSION="$(sed -n 's/.*"version": "\([^"]*\)".*/\1/p' "$WORK/x/MANIFEST.json" | head -n1)"
I_VERSION="$(tr -d '[:space:]' <"$INSTALL_DIR/VERSION")"
ok "Backup verified: version $B_VERSION, created $(sed -n 's/.*"created": "\([^"]*\)".*/\1/p' "$WORK/x/MANIFEST.json")"
newest="$(printf '%s\n%s\n' "$B_VERSION" "$I_VERSION" | sort -V | tail -n1)"
if [[ "$B_VERSION" != "$I_VERSION" && "$newest" == "$B_VERSION" ]]; then
  die "The backup comes from a newer version ($B_VERSION) than the installed one ($I_VERSION). Install the newer version first."
fi

HAS_SITES=0; [[ -f "$WORK/x/data/sites.tar" ]] && HAS_SITES=1
RESTORED_DBS=()

# ---- confirmation
echo
warn "WARNING: Database, certificates$([[ $HAS_SITES -eq 1 ]] && echo ' and website files') of this installation will be replaced by the state of the backup."
echo "  Existing directories are renamed (*.pre-restore-*), the database state is backed up first."
if [[ $FORCE -ne 1 ]]; then
  confirm_phrase "RESTORE" || die "Cancelled."
fi

STAMP="$(date +%Y%m%d-%H%M%S)"
setaside() { # rename a directory instead of deleting it
  local p="$1"
  [[ -e "$p" ]] || return 0
  mv -- "$p" "$p.pre-restore-$STAMP"
  info "Existing directory saved as $(basename "$p").pre-restore-$STAMP"
}

# ---- 1. safety dump of the current database (if available)
if [[ "$(service_status db)" == "healthy" ]]; then
  info "Backing up the current database state …"
  "$INSTALL_DIR/backup.sh" --db-only --non-interactive || warn "Backing up the current database state failed (continuing)."
else
  info "Starting database …"
  compose up -d db
  wait_healthy 180 db || die "The database does not become healthy."
fi

# ---- 2. stop everything that uses the data
info "Stopping dashboard, worker and website containers …"
compose stop webmanager worker proxy || true
mapfile -t sites < <(docker ps -aq --filter 'label=drimzo.managed=true' --filter 'name=^wm-site-')
for c in "${sites[@]:-}"; do [[ -n "$c" ]] && docker rm -f "$c" >/dev/null; done

# ---- 3. secrets: encrypted environment variables need the original APP_KEY
backup_path "$INSTALL_DIR/.env"
OLD_KEY="$(env_get APP_KEY "$WORK/x/config/.env")" || die "APP_KEY not found in the backup."
[[ "$OLD_KEY" =~ ^[0-9a-f]{64}$ ]] || die "APP_KEY in the backup is invalid."
env_set APP_KEY "$OLD_KEY"
if [[ -z "$(env_get DASHBOARD_DOMAIN || true)" ]]; then
  d="$(env_get DASHBOARD_DOMAIN "$WORK/x/config/.env" || true)"; [[ -n "$d" ]] && env_set DASHBOARD_DOMAIN "$d"
fi
ok "Key for encrypted environment variables adopted (database credentials of this server stay unchanged)."

# ---- 4. database
info "Restoring the database …"
compose exec -T db sh -c 'MYSQL_PWD="$MARIADB_ROOT_PASSWORD" exec mariadb -uroot -e "DROP DATABASE IF EXISTS \`$MARIADB_DATABASE\`"'
zcat "$WORK/x/db.sql.gz" | compose exec -T db sh -c 'MYSQL_PWD="$MARIADB_ROOT_PASSWORD" exec mariadb -uroot --default-character-set=utf8mb4'
ok "Database restored"

# ---- 5. files
info "Restoring certificates and runtime data …"
setaside "$DATA_DIR/letsencrypt"
setaside "$DATA_DIR/runtime"
tar --numeric-owner -C "$DATA_DIR" -xf "$WORK/x/data/letsencrypt.tar"
tar --numeric-owner -C "$DATA_DIR" -xf "$WORK/x/data/runtime.tar"
install -d -m 0755 "$DATA_DIR/runtime/proxy/conf.d" "$DATA_DIR/runtime/acme"
if [[ $HAS_SITES -eq 1 ]]; then
  info "Restoring website files …"
  setaside "$DATA_DIR/sites"
  tar --numeric-owner -C "$DATA_DIR" -xf "$WORK/x/data/sites.tar"
else
  warn "The backup contains no website files (--no-sites)."
fi

# ---- 5b. website databases: the dumps become ordinary entries of each website's dump list
if [[ $HAS_SITES -eq 1 && -d "$WORK/x/data/dbs" ]]; then
  B_CREATED="$(sed -n 's/.*"created": "\([^"]*\)".*/\1/p' "$WORK/x/MANIFEST.json" | head -n1)"
  DUMP_STAMP="$(date -u -d "$B_CREATED" +%Y%m%d-%H%M%S 2>/dev/null || date -u +%Y%m%d-%H%M%S)"
  for f in "$WORK"/x/data/dbs/site-*.sql.gz; do
    [[ -f "$f" ]] || continue
    s="$(basename "$f" .sql.gz)"
    [[ -d "$DATA_DIR/sites/$s" ]] || { warn "Database dump $s.sql.gz has no matching website – skipped."; continue; }
    install -d -m 0700 "$DATA_DIR/sites/$s/dumps"
    install -m 0600 "$f" "$DATA_DIR/sites/$s/dumps/db-$DUMP_STAMP.sql.gz"
    RESTORED_DBS+=("$s")
  done
fi

# ---- 6. migrate, start, reconcile
info "Running migrations and starting the services …"
compose run --rm --no-deps -T webmanager php bin/console migrate
compose up -d
wait_healthy 240 db agent worker webmanager proxy || warn "Not all services became healthy."

info "Reconciling websites, containers and proxy routes …"
out="$(compose exec -T webmanager php bin/console job:enqueue system.reconcile)"
jid="$(grep -oE '[0-9]+' <<<"$out" | head -n1)"
for _ in $(seq 1 200); do
  st="$(compose exec -T webmanager php bin/console job:status "$jid" 2>/dev/null || true)"
  grep -q '"status":"succeeded"' <<<"$st" && { ok "Reconcile completed"; break; }
  grep -q '"status":"failed"' <<<"$st" && { warn "Reconcile reports an error: $st (details in the dashboard under Tasks)"; break; }
  sleep 3
done

echo
if [[ -n "${RESTORED_DBS[*]:-}" ]]; then
  echo
  warn "Databases of websites: ${RESTORED_DBS[*]}"
  echo "  The database containers start empty. Restore the state: Dashboard → Website → Database → Backups → “Restore”"
  echo "  (the dump carries the date of the backup: db-$DUMP_STAMP.sql.gz)."
fi
ok "Restore finished. Sign in to the dashboard with the credentials from the backup."
echo "  Certificates: domains must point to this server via DNS; renewal runs automatically."
echo "  Clean up (optional): ls -d $DATA_DIR/*.pre-restore-$STAMP"
