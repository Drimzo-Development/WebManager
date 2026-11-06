#!/usr/bin/env bash
# WebManager – controlled update with backup, integrity check, health check and rollback.
#
#   sudo ./update.sh                         update to the latest release of the update server
#   sudo ./update.sh --version 0.1.0         update to a specific version
#   sudo ./update.sh --file rel.tar.gz --sha256 <hash>      offline update from a local archive
#   sudo ./update.sh --check                 only show installed/available version
#
# Release source: https://updates.drimzo.cc/webmanager/stable (fixed in scripts/lib.sh, not configurable). The server carries
#   webmanager-<ver>.tar.gz, .tar.gz.sha256 and .tar.gz.asc plus a LATEST file. The authenticity of an update is guaranteed by the
#   SHA-256 and the GPG signature of keys/release.asc (UPDATE_KEYRING=<gpg key> in .env can be used instead of that key).
#
# Websites, domains, certificates, databases and stored files are not touched by the update.
set -Eeuo pipefail
IFS=$'\n\t'
umask 027

SELF="$(readlink -f -- "${BASH_SOURCE[0]}")"
INSTALL_DIR="${WM_INSTALL_DIR:-$(dirname -- "$SELF")}"
# shellcheck source=scripts/lib.sh
# WM_LIB_DIR: set when the update.sh of the new release takes over (see the hand-over below)
source "${WM_LIB_DIR:-$INSTALL_DIR/scripts}/lib.sh"

TARGET=""; FILE=""; SHA=""; EXPLICIT_SHA=0; CHECK=0; FORCE=0; ALLOW_DOWNGRADE=0; ASSUME_YES=0; NON_INTERACTIVE=0
usage() {
  cat <<'EOF'
Verwendung: update.sh [Optionen]
  --version X.Y.Z       target version (default: newest release in the GitHub repository)
  --file ARCHIVE        local release archive instead of download (requires --sha256)
  --sha256 HASH         expected SHA-256 sum (mandatory with --file, recommended otherwise)
  --check               only show versions
  --force               rebuild and restart even if the version is the same
  --allow-downgrade     allow a downgrade to an older version
  -y, --yes             answer questions with “yes”
  --non-interactive     no questions
EOF
}
while [[ $# -gt 0 ]]; do
  case "$1" in
    --version) TARGET="${2:?}"; shift ;;
    --file) FILE="${2:?}"; shift ;;
    --sha256) SHA="${2:?}"; EXPLICIT_SHA=1; shift ;;
    --check) CHECK=1 ;;
    --force) FORCE=1 ;;
    --allow-downgrade) ALLOW_DOWNGRADE=1 ;;
    -y|--yes) ASSUME_YES=1 ;;
    --non-interactive) NON_INTERACTIVE=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 1 ;;
  esac
  shift
done

require_root
[[ -f "$INSTALL_DIR/.env" ]] || die "No installation found in $INSTALL_DIR."
DATA_DIR="$(env_get DATA_DIR)"
LOG_DIR="$(env_get LOG_DIR || echo "$WM_DEFAULT_LOG_DIR")"
BACKUP_DIR="$(env_get BACKUP_DIR || echo "$DATA_DIR/backups")"
CONFIG_BACKUP_DIR="$WM_DEFAULT_BACKUP_DIR/config-before-update-$(date +%Y%m%d-%H%M%S)"
CURRENT="$(tr -d '[:space:]' <"$INSTALL_DIR/VERSION")"
BASE_URL="$WM_UPDATE_BASE_URL"
KEYRING="$(env_get UPDATE_KEYRING || true)"

if [[ $CHECK -eq 1 ]]; then
  echo "Installed version:    $CURRENT"
  echo "Source:               $BASE_URL"
  echo "Available:            $(update_latest || echo 'not reachable')"
  exit 0
fi

# After a hand-over the lock is still held by the predecessor: its log process (tee) was started after the lock was taken, inherited
# the lock's file descriptor and keeps it until this update has finished. A second flock would therefore always fail.
if [[ -z "${WM_UPDATE_HANDOFF:-}" ]]; then
  exec 9>/var/lock/webmanager-update.lock
  flock -n 9 || die "An update is already running."
fi
setup_logging update

WORK="$(mktemp -d /var/tmp/wm-update.XXXXXX)"
chmod 700 "$WORK"

# ----------------------------------------------------------------------- state for rollback
STAGE="init"           # init -> tree_replaced -> migrated -> started
APP_TREE_BACKUP=""
DB_DUMP=""
ENV_BEFORE=""

restore_db() {
  [[ -n "$DB_DUMP" && -f "$DB_DUMP" ]] || { warn "No database dump available to restore."; return 1; }
  info "Restoring database dump $DB_DUMP …"
  compose up -d db >/dev/null
  wait_healthy 120 db || return 1
  compose exec -T db sh -c 'MYSQL_PWD="$MARIADB_ROOT_PASSWORD" exec mariadb -uroot -e "DROP DATABASE IF EXISTS \`$MARIADB_DATABASE\`"'
  zcat "$DB_DUMP" | compose exec -T db sh -c 'MYSQL_PWD="$MARIADB_ROOT_PASSWORD" exec mariadb -uroot --default-character-set=utf8mb4'
}

rollback() {
  err "Update failed – restoring version $CURRENT (stage: $STAGE)."
  trap - ERR
  set +e
  if [[ "$STAGE" != "init" ]]; then
    if [[ -n "$APP_TREE_BACKUP" && -f "$APP_TREE_BACKUP" ]]; then
      info "Restoring application files from $APP_TREE_BACKUP …"
      tar -xzf "$APP_TREE_BACKUP" -C "$INSTALL_DIR" --exclude='./.env'
    fi
    [[ -n "$ENV_BEFORE" && -f "$ENV_BEFORE" ]] && { cp -a "$ENV_BEFORE" "$INSTALL_DIR/.env"; chmod 600 "$INSTALL_DIR/.env"; }
    if [[ "$STAGE" == "migrated" || "$STAGE" == "started" ]]; then
      restore_db || err "The database could not be restored automatically. Dump: $DB_DUMP"
    fi
    info "Starting the previous version $CURRENT (existing images, no rebuild) …"
    compose up -d --no-build --remove-orphans
    if wait_healthy 240 db agent worker webmanager proxy; then
      # websites that were removed for the name migration are created again by the old version
      compose exec -T webmanager php bin/console job:enqueue system.reconcile >/dev/null 2>&1 || true
      ok "Rollback successful: version $CURRENT is running again. Websites and data were never affected."
    else
      err "The previous version did not become healthy either. Manual check needed: docker compose -f $INSTALL_DIR/docker-compose.yml logs --tail=100"
      err "Backups: app files $APP_TREE_BACKUP, database $DB_DUMP, .env $ENV_BEFORE"
    fi
  else
    ok "No changes have been made yet."
  fi
  rm -rf "$WORK"
  exit 1
}
trap 'rollback' ERR
# WM_HANDOFF_WORK: download directory of the update.sh that handed over to this one
trap 'rm -rf "$WORK"; [[ "${WM_HANDOFF_WORK:-}" == /var/tmp/wm-update.* ]] && rm -rf "$WM_HANDOFF_WORK"' EXIT
# from here on every fatal error must go through the rollback logic
die() { err "$*"; trap - ERR; rollback; }

# ----------------------------------------------------------------------- 1. obtain the release
if [[ -n "$FILE" ]]; then
  [[ -f "$FILE" ]] || die "File not found: $FILE"
  [[ "$SHA" =~ ^[0-9a-fA-F]{64}$ ]] || die "--sha256 with a 64-character sum is mandatory with --file."
  cp -- "$FILE" "$WORK/release.tar.gz"
else
  if [[ -z "$TARGET" ]]; then TARGET="$(update_latest)" || die "The update server $BASE_URL is not reachable or returned an invalid version."; fi
  [[ "$TARGET" =~ ^[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z.]+)?$ ]] || die "Invalid target version: '$TARGET'"
  TARGET="${TARGET#v}"
  info "Downloading version $TARGET from $BASE_URL …"
  name="webmanager-$TARGET.tar.gz"
  fetch -o "$WORK/release.tar.gz" "$BASE_URL/$name" || die "Release archive $name is missing on the update server."
  fetch -o "$WORK/release.sha256" "$BASE_URL/$name.sha256" || die "The checksum file is missing on the update server."
  fetch_sig() { fetch -o "$WORK/release.asc" "$BASE_URL/$name.asc"; }
  remote_sha="$(awk '{print $1; exit}' "$WORK/release.sha256")"
  [[ "$remote_sha" =~ ^[0-9a-fA-F]{64}$ ]] || die "The checksum file is invalid."
  if [[ -n "$SHA" && "${SHA,,}" != "${remote_sha,,}" ]]; then die "The given --sha256 does not match the checksum of the server."; fi
  SHA="${SHA:-$remote_sha}"
  # The release key of the INSTALLED version (never the one from the downloaded archive) makes the signature mandatory.
  if [[ -z "$KEYRING" && -f "$INSTALL_DIR/keys/release.asc" ]]; then
    have gpg || die "gpg is required for the signature check."
    KEYRING="$WORK/release-key.gpg"
    gpg --batch --dearmor <"$INSTALL_DIR/keys/release.asc" >"$KEYRING" || die "keys/release.asc could not be read."
  fi
  if [[ -n "$KEYRING" ]]; then
    [[ -f "$KEYRING" ]] || die "UPDATE_KEYRING $KEYRING does not exist."
    have gpg || die "gpg is required for the signature check."
    fetch_sig || die "Signature file missing – the update is not installed."
    gpg --no-default-keyring --keyring "$KEYRING" --verify "$WORK/release.asc" "$WORK/release.tar.gz" \
      || die "GPG signature invalid – the update is not installed."
    ok "GPG signature verified"
  else
    warn "No release key (keys/release.asc or UPDATE_KEYRING): only the SHA-256 from the release source is checked, the origin is not verified."
  fi
fi
got="$(sha256sum "$WORK/release.tar.gz" | awk '{print $1}')"
[[ "${got,,}" == "${SHA,,}" ]] || die "SHA-256 does not match (expected ${SHA,,}, got $got)."
ok "SHA-256 verified"

if tar -tzf "$WORK/release.tar.gz" | grep -Eq '(^/|(^|/)\.\.(/|$))'; then die "The archive contains invalid paths."; fi
mkdir -p "$WORK/new"
tar -xzf "$WORK/release.tar.gz" -C "$WORK/new" --no-same-owner
TOP="$(find "$WORK/new" -mindepth 1 -maxdepth 1 -type d | head -n1)"
[[ -f "$TOP/docker-compose.yml" && -f "$TOP/VERSION" && -f "$TOP/update.sh" ]] || die "The release archive does not have the expected structure."
NEW="$(tr -d '[:space:]' <"$TOP/VERSION")"
[[ -z "$TARGET" || "$TARGET" == "$NEW" ]] || die "The archive contains version $NEW, expected $TARGET."

newest="$(printf '%s\n%s\n' "$CURRENT" "$NEW" | sort -V | tail -n1)"
if [[ "$NEW" == "$CURRENT" && $FORCE -eq 0 ]]; then ok "Version $CURRENT is already installed."; trap - ERR; exit 0; fi
if [[ "$newest" == "$CURRENT" && "$NEW" != "$CURRENT" && $ALLOW_DOWNGRADE -eq 0 ]]; then die "Version $NEW is older than $CURRENT (--allow-downgrade if intended)."; fi
info "Update: $CURRENT → $NEW"

# Hand over to the update.sh of the NEW release (the archive is already verified): this way fixes to the update procedure
# (health checks, backup, migrations ...) take effect for this update and not only for the next one. The new script
# re-checks the SHA-256 and takes its own lib.sh from the release tree.
if should_handoff "$TOP" "$SELF"; then
  info "Handing over to the update script of version $NEW …"
  fwd=()
  [[ $FORCE -eq 1 ]] && fwd+=(--force)
  [[ $ALLOW_DOWNGRADE -eq 1 ]] && fwd+=(--allow-downgrade)
  [[ $ASSUME_YES -eq 1 ]] && fwd+=(--yes)
  [[ $NON_INTERACTIVE -eq 1 ]] && fwd+=(--non-interactive)
  # the update lock stays held (by this process and its log process) until the new update.sh has finished
  trap - ERR EXIT
  WM_UPDATE_HANDOFF=1 WM_INSTALL_DIR="$INSTALL_DIR" WM_LIB_DIR="$TOP/scripts" WM_HANDOFF_WORK="$WORK" \
    exec bash "$TOP/update.sh" --file "$WORK/release.tar.gz" --sha256 "$SHA" "${fwd[@]}"
fi

# ----------------------------------------------------------------------- 2. pre-flight + backup
docker info >/dev/null 2>&1 || die "Docker daemon not reachable."
if [[ "$(service_status db)" != "healthy" ]]; then die "The database is not healthy – update aborted before anything was changed."; fi
free_mb=$(( $(df -Pk "$DATA_DIR" | awk 'NR==2 {print $4}') / 1024 ))
(( free_mb > 2000 )) || die "Not enough free disk space ($free_mb MB) for backup and rebuild."

info "Creating a backup of configuration and database …"
# The backup.sh that is still installed (the old release) is used here: pass only options it knows. --no-remote exists since 0.7.0;
# older versions have no external target, so there is nothing to suppress.
backup_args=(--non-interactive --no-sites)
if grep -q -- '--no-remote' "$INSTALL_DIR/backup.sh"; then backup_args+=(--no-remote); fi
"$INSTALL_DIR/backup.sh" "${backup_args[@]}"
DB_DUMP="$(ls -1t "$DATA_DIR"/database-backups/db-*.sql.gz | head -n1)"
[[ -f "$DB_DUMP" ]] || die "Database dump not found."
ok "Database dump: $DB_DUMP"

mkdir -p "$CONFIG_BACKUP_DIR"; chmod 700 "$CONFIG_BACKUP_DIR"
ENV_BEFORE="$CONFIG_BACKUP_DIR/.env"
cp -a "$INSTALL_DIR/.env" "$ENV_BEFORE"
APP_TREE_BACKUP="$BACKUP_DIR/app-tree-$CURRENT-$(date +%Y%m%d-%H%M%S).tar.gz"
install -d -m 0700 "$BACKUP_DIR"
tar -C "$INSTALL_DIR" --exclude='./.env' -czf "$APP_TREE_BACKUP" .
chmod 600 "$APP_TREE_BACKUP"
ok "Application state saved: $APP_TREE_BACKUP"
for img in webmanager worker agent proxy; do
  docker image inspect "$(env_get WM_IMAGE_PREFIX)/$img:$CURRENT" >/dev/null 2>&1 || warn "Image $img:$CURRENT is not available locally – a rollback would rebuild it."
done

# ----------------------------------------------------------------------- 3. replace files, build, migrate, start
STAGE="tree_replaced"
info "Ersetze Anwendungsdateien …"
prune_stale "$INSTALL_DIR" "$TOP"
tar -C "$TOP" --exclude='./.env' --exclude='./.git' -cf - . | tar -C "$INSTALL_DIR" --no-same-owner -xf -
chown -R root:root "$INSTALL_DIR"
chmod 0755 "$INSTALL_DIR"/*.sh "$INSTALL_DIR"/scripts/*.sh "$INSTALL_DIR"/scripts/webmanager 2>/dev/null || true
chmod 600 "$INSTALL_DIR/.env"
env_set WM_VERSION "$NEW"

if wm_local_images; then
  info "Building new images (running services stay unchanged until the switch) …"
  compose build --pull
else
  info "Pulling images for version $NEW …"
  compose pull --quiet agent worker webmanager proxy
fi

info "Running database migrations …"
STAGE="migrated"
compose run --rm --no-deps -T webmanager php bin/console migrate

info "Switching to the new containers …"
STAGE="started"
compose up -d --remove-orphans

# ----------------------------------------------------------------------- 4. verification
info "Checking health …"
wait_healthy 240 db agent worker webmanager proxy || die "Not all services became healthy."
running="$(compose exec -T webmanager php bin/console version | tr -d '[:space:]')"
[[ "$running" == "$NEW" ]] || die "The running version ($running) does not match the expected one ($NEW)."
ok_http=0
for _ in $(seq 1 20); do
  dashboard_probe && { ok_http=1; break; }
  sleep 3
done
if [[ $ok_http -ne 1 ]]; then diagnose_services webmanager proxy; die "The dashboard does not answer from the proxy container (http://webmanager:8080/healthz)."; fi

# Refresh the egress guard (only if set up earlier) with the files of the new version
if [[ -f /etc/systemd/system/webmanager-egress.service && -x "$INSTALL_DIR/scripts/egress-guard.sh" ]]; then
  "$INSTALL_DIR/scripts/egress-guard.sh" install || warn "The egress guard could not be refreshed."
fi
# Set up or refresh the backup helper (dashboard Backups page, weekly restore test) with the files of the new version
if [[ -x "$INSTALL_DIR/scripts/backup-remote.sh" ]]; then
  "$INSTALL_DIR/scripts/backup-remote.sh" install || warn "The backup helper could not be set up."
fi
# Set up or refresh the update helper (notice and button in the dashboard) with the files of the new version
if [[ -x "$INSTALL_DIR/scripts/update-helper.sh" ]]; then
  "$INSTALL_DIR/scripts/update-helper.sh" install || warn "The update helper could not be set up."
fi
compose exec -T webmanager php bin/console job:enqueue system.reconcile >/dev/null || true
# Runtime images (PHP/Node) take several minutes to build the first time: as a task with visible progress instead of silent waiting in the update
compose exec -T webmanager php bin/console job:enqueue images.prepare >/dev/null || true
trap - ERR
ok "Update to version $NEW successful."
echo "  Note: Runtime images are prepared in the background (Dashboard → Tasks → “Prepare runtime images”)."
echo "  Previous version:    $CURRENT (images and app backup are kept)"
echo "  App backup:          $APP_TREE_BACKUP"
echo "  Database dump:      $DB_DUMP"
echo "  Delete old images (optional, only after a successful check):"
echo "    docker image rm $(env_get WM_IMAGE_PREFIX)/{webmanager,worker,agent,proxy}:$CURRENT"
