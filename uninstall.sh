#!/usr/bin/env bash
# WebManager – interactive uninstaller.
#
# Default behaviour never deletes website files, databases, certificates or backups.
# Only objects belonging to this installation are touched (fixed names / the label drimzo.managed=true);
# foreign containers, networks, images and volumes are never removed.
#
#   sudo ./uninstall.sh                                  interactive menu
#   sudo ./uninstall.sh --stop                           only stop the WebManager services
#   sudo ./uninstall.sh --remove-app [--keep-websites-running]
#   sudo ./uninstall.sh --purge-data --confirm "DELETE ALL DATA" [--purge-backups]
set -Eeuo pipefail
IFS=$'\n\t'

SELF="$(readlink -f -- "${BASH_SOURCE[0]}")"
INSTALL_DIR="${WM_INSTALL_DIR:-$(dirname -- "$SELF")}"
# shellcheck source=scripts/lib.sh
source "$INSTALL_DIR/scripts/lib.sh"

MODE=""; PURGE_BACKUPS=0; CONFIRM=""; STOP_SITES=1; ASSUME_YES=0; NON_INTERACTIVE=0
PHRASE="DELETE ALL DATA"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --stop) MODE=stop ;;
    --remove-app) MODE=remove ;;
    --purge-data) MODE=purge ;;
    --purge-backups) PURGE_BACKUPS=1 ;;
    --confirm) CONFIRM="${2:?}"; shift ;;
    --keep-websites-running) STOP_SITES=0 ;;
    -y|--yes) ASSUME_YES=1 ;;
    -h|--help) sed -n '2,13p' "$SELF" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
  shift
done

require_root
[[ -f "$INSTALL_DIR/.env" ]] || die "No installation found in $INSTALL_DIR (.env is missing)."
DATA_DIR="$(env_get DATA_DIR)"
LOG_DIR="$(env_get LOG_DIR || echo "$WM_DEFAULT_LOG_DIR")"
PREFIX="$(env_get WM_IMAGE_PREFIX || echo drimzo)"
setup_logging uninstall

menu() {
  cat <<EOF

${C_BLD}WebManager deinstallieren${C_RST}

  1) Stop only
       WebManager services (dashboard, worker, agent, proxy, database) are stopped, nothing is removed.
  2) Remove the WebManager application   ${C_GRN}[recommended]${C_RST}
       Containers and application files are removed. KEPT: database volume, all website files
       and containers, certificates and backups. The .env (keys) is kept safe.
  3) ${C_RED}Delete everything permanently${C_RST}
       In addition: database, websites (containers, networks, files), certificates. Cannot be undone.
  0) Cancel

EOF
}

if [[ -z "$MODE" ]]; then
  [[ -t 0 ]] || die "Without a terminal please specify --stop, --remove-app or --purge-data."
  menu
  read -r -p "Choice [0-3]: " choice
  case "$choice" in 1) MODE=stop ;; 2) MODE=remove ;; 3) MODE=purge ;; *) info "Cancelled."; exit 0 ;; esac
fi

stop_sites() {
  mapfile -t ids < <(docker ps -q --filter 'label=drimzo.managed=true' --filter 'name=^wm-site-')
  if [[ ${#ids[@]} -gt 0 && -n "${ids[0]}" ]]; then
    info "Stopping ${#ids[@]} website containers (they are not deleted) …"
    docker stop "${ids[@]}" >/dev/null
  fi
}

managed_containers() { docker ps -aq --filter 'label=drimzo.managed=true'; }

# ------------------------------------------------------------------------------ 1) stop
if [[ "$MODE" == "stop" ]]; then
  confirm "Stop the WebManager services now?" y || { info "Cancelled."; exit 0; }
  compose stop
  ok "Services stopped. Start them again with 'docker compose -f $INSTALL_DIR/docker-compose.yml start'."
  exit 0
fi

# ------------------------------------------------------------------------------ 2) remove app
if [[ "$MODE" == "remove" || "$MODE" == "purge" ]]; then
  if [[ "$MODE" == "remove" ]]; then
    echo
    echo "The following will be ${C_BLD}removed${C_RST}: WebManager containers (webmanager, wm-worker, wm-agent, wm-proxy, wm-db),"
    echo "  the networks wm-frontend/wm-db/wm-mgmt/wm-egress, application files in $INSTALL_DIR."
    echo "The following is ${C_BLD}kept${C_RST}: database volume wm_db_data, $DATA_DIR (websites, certificates, backups),"
    echo "  website containers (only stopped), Docker itself, firewall rules."
    confirm "Continue?" n || { info "Cancelled."; exit 0; }
  fi
fi

if [[ "$MODE" == "purge" ]]; then
  echo
  echo "${C_RED}${C_BLD}WARNING – PERMANENT DATA LOSS${C_RST}"
  echo "The following will be deleted irrevocably:"
  echo "  • database volume wm_db_data (users, website definitions, tasks, log)"
  echo "  • all managed website containers and networks (wm-site-*, wm-net-*)"
  echo "  • $DATA_DIR/sites  (all website files, configurations and logs)"
  echo "  • $DATA_DIR/trash, $DATA_DIR/letsencrypt (certificates and account keys), $DATA_DIR/runtime"
  echo "  • $INSTALL_DIR including .env"
  if [[ $PURGE_BACKUPS -eq 1 ]]; then echo "  • ${C_RED}Backups${C_RST} in $DATA_DIR/backups and $DATA_DIR/database-backups"
  else echo "  Backups ($DATA_DIR/backups, $DATA_DIR/database-backups) are kept."; fi
  echo "Foreign Docker objects are not touched."
  echo
  if [[ -n "$CONFIRM" ]]; then
    [[ "$CONFIRM" == "$PHRASE" ]] || die "--confirm must be exactly '$PHRASE'."
  else
    [[ -t 0 ]] || die "Deleting requires an interactive confirmation or --confirm '$PHRASE'."
    confirm_phrase "$PHRASE" || { info "Cancelled. Nothing was deleted."; exit 0; }
    if [[ $PURGE_BACKUPS -eq 0 && -d "$DATA_DIR/backups" ]]; then
      confirm "Delete the backups as well?" n && PURGE_BACKUPS=1
    fi
  fi
fi

# keep the key material: without APP_KEY encrypted environment variables in a retained database are unreadable
if [[ "$MODE" == "remove" ]]; then
  install -d -m 0700 "$DATA_DIR/config-retained"
  cp -a "$INSTALL_DIR/.env" "$DATA_DIR/config-retained/env-$(date +%Y%m%d-%H%M%S)"
  chmod 600 "$DATA_DIR"/config-retained/env-*
  ok "Configuration (incl. keys) saved in $DATA_DIR/config-retained/"
fi

[[ $STOP_SITES -eq 1 || "$MODE" == "purge" ]] && stop_sites

if [[ "$MODE" == "purge" ]]; then
  info "Removing website containers and networks …"
  mapfile -t cs < <(managed_containers)
  [[ ${#cs[@]} -gt 0 && -n "${cs[0]}" ]] && docker rm -f "${cs[@]}" >/dev/null || true
fi

info "Removing WebManager containers and networks …"
if [[ "$MODE" == "purge" ]]; then
  compose down --remove-orphans --volumes
else
  compose down --remove-orphans
fi

if [[ "$MODE" == "purge" ]]; then
  mapfile -t nets < <(docker network ls -q --filter 'label=drimzo.managed=true')
  [[ ${#nets[@]} -gt 0 && -n "${nets[0]}" ]] && docker network rm "${nets[@]}" >/dev/null 2>&1 || true
  docker volume rm wm_db_data >/dev/null 2>&1 || true
  info "Removing the self-built images …"
  for img in webmanager worker agent proxy; do
    mapfile -t ids < <(docker images -q "$PREFIX/$img")
    [[ ${#ids[@]} -gt 0 && -n "${ids[0]}" ]] && docker rmi -f "${ids[@]}" >/dev/null 2>&1 || true
  done
  mapfile -t ids < <(docker images -q "drimzo/runtime-php")
  [[ ${#ids[@]} -gt 0 && -n "${ids[0]}" ]] && docker rmi -f "${ids[@]}" >/dev/null 2>&1 || true
fi

if have systemctl; then
  for u in webmanager-backup.timer webmanager-backup.service \
    webmanager-update.path webmanager-update.service \
    webmanager-updatecheck.timer webmanager-updatecheck.service \
    webmanager-updateauto.timer webmanager-updateauto.service \
    webmanager-backupreq.path webmanager-backupreq.service \
    webmanager-backupverify.timer webmanager-backupverify.service \
    webmanager-egress.service; do
    if [[ -f "/etc/systemd/system/$u" ]]; then
      systemctl disable --now "$u" >/dev/null 2>&1 || true
      rm -f "/etc/systemd/system/$u"
    fi
  done
  systemctl daemon-reload || true
fi

if [[ "$MODE" == "purge" ]]; then
  info "Deleting data …"
  case "$DATA_DIR" in /|/var|/var/lib|/opt|/usr|/etc|/home|/root|"") die "Unsafe data path '$DATA_DIR' – aborting." ;; esac
  rm -rf -- "$DATA_DIR/sites" "$DATA_DIR/trash" "$DATA_DIR/letsencrypt" "$DATA_DIR/runtime" "$DATA_DIR/config-retained"
  rm -rf -- "$DATA_DIR"/*.pre-restore-* 2>/dev/null || true
  if [[ $PURGE_BACKUPS -eq 1 ]]; then rm -rf -- "$DATA_DIR/backups" "$DATA_DIR/database-backups"; fi
  rmdir "$DATA_DIR" 2>/dev/null || true
fi

# remove application files last (this script lives there)
info "Entferne Anwendungsdateien in $INSTALL_DIR …"
case "$INSTALL_DIR" in /|/opt|/usr|/etc|/home|/root|"") die "Unsafe installation path '$INSTALL_DIR' – aborting." ;; esac
find "$INSTALL_DIR" -mindepth 1 -maxdepth 1 ! -name '.env' -exec rm -rf -- {} +
if [[ "$MODE" == "purge" ]]; then rm -f -- "$INSTALL_DIR/.env"; rmdir "$INSTALL_DIR" 2>/dev/null || true; fi

echo
ok "Uninstallation completed."
if [[ "$MODE" == "remove" ]]; then
  echo "  Kept: $DATA_DIR (websites, certificates, backups), volume wm_db_data, keys in $DATA_DIR/config-retained/"
  echo "  Reinstall: run install.sh again and copy the saved .env to $INSTALL_DIR/.env (mode 0600)."
fi
echo "  Docker and firewall rules were not changed."
