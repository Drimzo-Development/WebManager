#!/usr/bin/env bash
# WebManager - go back to the version before the last update. Runs as root on the host.
#
#   rollback.sh [--yes] [--dry-run]
#
# Uses what update.sh left behind: the program files (app-tree-<version>-<time>.tar.gz) and the database dump taken right before that
# update (db-<time>-v<version>.sql.gz) plus the images of that version. Websites, their files, certificates and domains are not
# touched. DATABASE CHANGES SINCE THAT UPDATE ARE LOST (job history, audit log, settings, new users): the database is reset to the
# state before the update, because newer schema changes cannot be undone otherwise. A fresh dump of the current state is taken first
# and kept. If anything fails, the state from before the rollback is restored.
set -Eeuo pipefail
IFS=$'\n\t'
umask 027

SELF="$(readlink -f -- "${BASH_SOURCE[0]}")"
INSTALL_DIR="${WM_INSTALL_DIR:-$(dirname -- "$(dirname -- "$SELF")")}"
# shellcheck source=lib.sh
source "$INSTALL_DIR/scripts/lib.sh"

ASSUME_YES=0; NON_INTERACTIVE=0; DRY=0
STAGE="init"           # init -> tree_replaced -> db_restored -> started
WORK=""; CURRENT=""; TARGET=""; TREE=""; DUMP=""; SAFETY_DUMP=""; ENV_VERSION_BEFORE=""

verlt() { [[ "$1" != "$2" && "$(printf '%s\n%s\n' "$1" "$2" | sort -V | head -n1)" == "$1" ]]; }

# File names newest first by the timestamp in the name (not by mtime), one path per line
by_stamp() {
  local f
  for f in "$@"; do [[ -e "$f" ]] && printf '%s\n' "$f"; done \
    | sed -n 's/.*\([0-9]\{8\}-[0-9]\{6\}\)[^/]*$/\1 &/p' | sort -r | cut -d' ' -f2-
}

# Newest program backup of an update and the database dump that belongs to it (same version, taken before it).
find_target() {
  local f base ver stamp d dstamp best_tree="" best_dump="" best_ver=""
  while IFS= read -r f; do
    base="$(basename "$f")"
    [[ "$base" =~ ^app-tree-([0-9]+\.[0-9]+\.[0-9]+)-([0-9]{8}-[0-9]{6})\.tar\.gz$ ]] || continue
    ver="${BASH_REMATCH[1]}"; stamp="${BASH_REMATCH[2]}"
    [[ "$ver" != "$CURRENT" ]] || continue
    verlt "$ver" "$CURRENT" || continue
    best_tree="$f"; best_ver="$ver"
    best_dump=""
    while IFS= read -r d; do
      [[ "$(basename "$d")" =~ ^db-([0-9]{8}-[0-9]{6})-v${ver//./\\.}\.sql\.gz$ ]] || continue
      dstamp="${BASH_REMATCH[1]}"
      [[ "$dstamp" < "$stamp" || "$dstamp" == "$stamp" ]] && { best_dump="$d"; break; }
    done < <(by_stamp "$DATA_DIR"/database-backups/db-*-v*.sql.gz)
    break      # newest tree only (ls -t order): the last update
  done < <(by_stamp "$BACKUP_DIR"/app-tree-*.tar.gz)
  TREE="$best_tree"; DUMP="$best_dump"; TARGET="$best_ver"
}

restore_db() { # restore_db DUMPFILE
  compose up -d db >/dev/null
  wait_healthy 120 db || return 1
  compose exec -T db sh -c 'MYSQL_PWD="$MARIADB_ROOT_PASSWORD" exec mariadb -uroot -e "DROP DATABASE IF EXISTS \`$MARIADB_DATABASE\`"'
  zcat "$1" | compose exec -T db sh -c 'MYSQL_PWD="$MARIADB_ROOT_PASSWORD" exec mariadb -uroot --default-character-set=utf8mb4'
}

restore_previous_state() {
  err "Roll back failed (stage: $STAGE) - restoring the state from before the roll back (version $CURRENT)."
  trap - ERR
  set +e
  if [[ "$STAGE" != "init" ]]; then
    [[ -f "$WORK/current-tree.tar.gz" ]] && tar -xzf "$WORK/current-tree.tar.gz" -C "$INSTALL_DIR" --exclude='./.env'
    [[ -n "$ENV_VERSION_BEFORE" ]] && env_set WM_VERSION "$ENV_VERSION_BEFORE"
    if [[ "$STAGE" == "db_restored" || "$STAGE" == "started" ]]; then
      [[ -n "$SAFETY_DUMP" && -f "$SAFETY_DUMP" ]] && restore_db "$SAFETY_DUMP" || err "The database could not be restored automatically. Backup: $SAFETY_DUMP"
    fi
    compose up -d --no-build --remove-orphans
    if wait_healthy 240 db agent worker webmanager proxy; then ok "Original state (version $CURRENT) is running again."; else
      err "The original state did not become healthy either. Manual check needed: docker compose -f $INSTALL_DIR/docker-compose.yml logs --tail=100"
      err "Backups: database $SAFETY_DUMP, program files $TARGET: $TREE"
    fi
  else
    ok "No changes have been made yet."
  fi
  rm -rf "$WORK"
  exit 1
}

main() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      -y|--yes) ASSUME_YES=1 ;;
      --non-interactive) NON_INTERACTIVE=1 ;;
      --dry-run) DRY=1 ;;
      -h|--help) sed -n '2,12p' "$SELF" | sed 's/^# \{0,1\}//'; exit 0 ;;
      *) die "Unknown option: $1" ;;
    esac
    shift
  done
  [[ "${WM_ROLLBACK_TEST:-}" == 1 ]] || require_root   # WM_ROLLBACK_TEST=1: only for tests/rollback.test.sh (no root, no chown)
  [[ -f "$INSTALL_DIR/.env" ]] || die "No installation found in $INSTALL_DIR."
  DATA_DIR="$(env_get DATA_DIR)"
  LOG_DIR="$(env_get LOG_DIR || echo "$WM_DEFAULT_LOG_DIR")"
  BACKUP_DIR="$(env_get BACKUP_DIR || echo "$DATA_DIR/backups")"
  CURRENT="$(tr -d '[:space:]' <"$INSTALL_DIR/VERSION")"

  find_target
  [[ -n "$TARGET" ]] || die "There is no program backup of an older version (app-tree-*.tar.gz in $BACKUP_DIR). Rolling back is only possible right after an update."
  [[ -n "$DUMP" ]] || die "The matching database dump is missing for the program backup of version $TARGET (db-*-v$TARGET.sql.gz in $DATA_DIR/database-backups)."
  tar -tzf "$TREE" >/dev/null 2>&1 || die "The program backup $TREE is not readable."
  gzip -t "$DUMP" || die "The database dump $DUMP is corrupt."
  (( $(zcat "$DUMP" | grep -c 'CREATE TABLE' || true) > 0 )) || die "The database dump $DUMP contains no tables."
  if tar -tzf "$TREE" | grep -Eq '(^/|(^|/)\.\.(/|$))'; then die "The program backup contains invalid paths."; fi
  tar -xzOf "$TREE" ./VERSION 2>/dev/null | tr -d '[:space:]' | grep -qx "$TARGET" || die "The program backup does not contain version $TARGET."

  info "Roll back: $CURRENT -> $TARGET"
  info "  Program files:   $(basename "$TREE")"
  info "  Database:        $(basename "$DUMP") (state before the update)"
  warn "Database changes since this dump are lost (task history, audit log, settings, new users, cron job history). Websites, files, certificates and domains are not touched."
  [[ $DRY -eq 0 ]] || { ok "Dry run: nothing was changed."; return 0; }
  if [[ $ASSUME_YES -ne 1 ]]; then confirm_phrase "ROLL BACK" || die "Cancelled."; fi

  exec 9>"${WM_UPDATE_LOCK:-/var/lock/webmanager-update.lock}"
  flock -n 9 || die "An update or rollback is already running."
  setup_logging rollback
  docker info >/dev/null 2>&1 || die "Docker daemon not reachable."
  [[ "$(service_status db)" == "healthy" ]] || die "The database is not healthy - roll back aborted before anything was changed."

  WORK="$(mktemp -d "${TMPDIR:-/var/tmp}/wm-rollback.XXXXXX")"; chmod 700 "$WORK"
  trap 'rm -rf "$WORK"' EXIT
  trap 'restore_previous_state' ERR
  # from here on every fatal error must restore the state from before the rollback
  die() { err "$*"; restore_previous_state; }

  info "Backing up the current state (database dump and program files) ..."
  "$INSTALL_DIR/backup.sh" --db-only --non-interactive
  SAFETY_DUMP="$(by_stamp "$DATA_DIR"/database-backups/db-*.sql.gz | head -n1)"
  [[ -f "$SAFETY_DUMP" ]] || die "Backup dump not found."
  tar -C "$INSTALL_DIR" --exclude='./.env' -czf "$WORK/current-tree.tar.gz" .
  ENV_VERSION_BEFORE="$(env_get WM_VERSION || true)"
  ok "Backup dump of the current state: $SAFETY_DUMP"

  STAGE="tree_replaced"
  info "Restoring the program files of version $TARGET ..."
  tar -xzf "$TREE" -C "$INSTALL_DIR" --exclude='./.env'
  [[ "${WM_ROLLBACK_TEST:-}" == 1 ]] || chown -R root:root "$INSTALL_DIR"
  chmod 0755 "$INSTALL_DIR"/*.sh "$INSTALL_DIR"/scripts/*.sh "$INSTALL_DIR"/scripts/webmanager 2>/dev/null || true
  chmod 600 "$INSTALL_DIR/.env"
  env_set WM_VERSION "$TARGET"

  STAGE="db_restored"
  info "Restoring the database state from before the update ..."
  restore_db "$DUMP"
  ok "Database rolled back"

  local prefix; prefix="$(env_get WM_IMAGE_PREFIX || echo drimzo)"
  local missing=0 img
  for img in agent worker webmanager proxy; do docker image inspect "$prefix/$img:$TARGET" >/dev/null 2>&1 || missing=1; done
  if [[ $missing -eq 1 ]]; then
    if wm_local_images; then info "Images of version $TARGET are missing locally - rebuilding them (from the restored files) ..."; compose build; else compose pull --quiet agent worker webmanager proxy; fi
  fi

  STAGE="started"
  info "Starte Version $TARGET ..."
  compose up -d --no-build --remove-orphans
  wait_healthy 240 db agent worker webmanager proxy || die "Not all services became healthy."
  [[ "$(compose exec -T webmanager php bin/console version | tr -d '[:space:]')" == "$TARGET" ]] || die "The running version does not match the expected one ($TARGET)."
  local ok_http=0 i
  for i in $(seq 1 20); do dashboard_probe && { ok_http=1; break; }; sleep 3; done
  [[ $ok_http -eq 1 ]] || { diagnose_services webmanager proxy; die "The dashboard does not answer from the proxy container."; }

  trap - ERR
  compose exec -T webmanager php bin/console job:enqueue system.reconcile >/dev/null || true
  # no automatic update to the version we just left (it was the reason for the rollback) until the settings are saved again
  if [[ -d "$DATA_DIR/update" ]]; then
    printf '{"version":"%s","state":"failed","at":"%s","epoch":%s}\n' "$CURRENT" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$(date +%s)" >"$DATA_DIR/update/auto-state.json" || true
  fi
  ok "Version $TARGET is running again (rolled back from $CURRENT)."
  echo "  Database backup of the state before the roll back: $SAFETY_DUMP"
  echo "  Update again: Dashboard -> Updates (or update.sh). Version $CURRENT stays paused for automatic updates until then."
}

# The whole script is parsed before it runs: the rollback replaces this file.
main "$@"
exit
