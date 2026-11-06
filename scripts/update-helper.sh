#!/usr/bin/env bash
# Host-side helper for the dashboard's update notice and its "Update now" button.
# Runs as root through systemd; the dashboard/agent containers never execute anything on the host.
#
#   update-helper.sh install    systemd units (path watcher + check every 2 hours) and the status directory
#   update-helper.sh refresh    ask the update server for new versions -> DATA_DIR/update/latest.json, meta.json
#   update-helper.sh apply      process DATA_DIR/update/request ("check" or "update X.Y.Z")
#   update-helper.sh auto       hourly: install a new PATCH version (same major.minor) inside the configured time window, if enabled in the dashboard
#
# The request file is the only input from the containers. Its content is validated here again and the
# update itself is the normal update.sh (SHA-256/GPG check, backup, health check, automatic rollback);
# downgrades are never requested. .env: UPDATE_HELPER=off disables the helper.
set -Eeuo pipefail
IFS=$'\n\t'
umask 022

SELF="$(readlink -f -- "${BASH_SOURCE[0]}")"
INSTALL_DIR="${WM_INSTALL_DIR:-$(dirname -- "$(dirname -- "$SELF")")}"
# shellcheck source=lib.sh
source "$INSTALL_DIR/scripts/lib.sh"

VERSION_RE='^[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z.]+)?$'
UNITS=(webmanager-update.path webmanager-update.service webmanager-updatecheck.service webmanager-updatecheck.timer webmanager-updateauto.service webmanager-updateauto.timer)

# JSON-safe short text for the status files (no quotes, backslashes or control characters)
json_text() { printf '%s' "$1" | tr -d '"\\\000-\037' | cut -c1-200; }

write_atomic() { # write_atomic FILE  (content on stdin)
  local file="$1"
  cat >"$file.tmp" && mv -f "$file.tmp" "$file"
}

refresh() {
  local json="" error="" v apply=false min=""
  if v="$(update_latest)"; then
    json="[{\"tag_name\":\"$v\"}]"
    min="$(update_min_supported)"
  else
    min="$(json_get "$UPD/meta.json" minSupported)"   # server not reachable: keep what is known
    error="Update server not reachable"
  fi
  [[ -z "$json" ]] || printf '%s\n' "$json" | write_atomic "$UPD/latest.json"
  # The release notes live in releases.json of the update server. Optional: without it the dashboard just shows no notes. The agent
  # treats the file as untrusted and only reads version, notes and date from it.
  if [[ -n "$json" ]]; then
    if fetch --max-filesize 1048576 -o "$UPD/releases.json.tmp" "$WM_UPDATE_BASE_URL/releases.json" 2>/dev/null; then
      mv -f "$UPD/releases.json.tmp" "$UPD/releases.json"
    else
      rm -f "$UPD/releases.json.tmp"
    fi
  fi
  if have systemctl && systemctl is-active --quiet webmanager-update.path 2>/dev/null; then apply=true; fi
  printf '{"apply":%s,"checkedAt":"%s","error":"%s","minSupported":"%s"}\n' "$apply" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$(json_text "$error")" "$(json_text "$min")" | write_atomic "$UPD/meta.json"
  [[ -z "$error" ]] || warn "Check for new versions failed: $error"
}

AUTO_RUN=0; STATE_KIND=update
write_state() { # write_state STATE VERSION LOGNAME  (AUTO_RUN=1 marks an automatic update for the notification mail; STATE_KIND update|rollback)
  printf '{"state":"%s","version":"%s","at":"%s","log":"%s","auto":%s,"kind":"%s"}\n' "$1" "$2" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$3" "$([[ $AUTO_RUN -eq 1 ]] && echo true || echo false)" "$STATE_KIND" | write_atomic "$UPD/state.json"
}

run_update() { # run_update VERSION
  local version="$1" name
  name="update-request-$(date +%Y%m%d-%H%M%S).log"
  mkdir -p "$LOG_DIR"
  : >"$LOG_DIR/$name"
  chmod 640 "$LOG_DIR/$name"
  write_state running "$version" "$name"
  info "Update to $version requested (log: $LOG_DIR/$name)"
  LAST_UPDATE_OK=0
  if "$INSTALL_DIR/update.sh" --non-interactive --yes --version "$version" >"$LOG_DIR/$name" 2>&1; then
    LAST_UPDATE_OK=1
    write_state ok "$version" "$name"
    ok "Update to $version completed."
  else
    write_state failed "$version" "$name"
    err "Update to $version failed (see $LOG_DIR/$name)."
  fi
  refresh || true
}

# Go back to the version before the last update (scripts/rollback.sh decides what to restore from the update's own backups; the
# request carries no parameters).
run_rollback() {
  local name
  name="update-request-$(date +%Y%m%d-%H%M%S).log"
  mkdir -p "$LOG_DIR"
  : >"$LOG_DIR/$name"
  chmod 640 "$LOG_DIR/$name"
  STATE_KIND=rollback
  write_state running "$(tr -d '[:space:]' <"$INSTALL_DIR/VERSION")" "$name"
  info "Roll back to the previous version requested (log: $LOG_DIR/$name)"
  if [[ -x "$INSTALL_DIR/scripts/rollback.sh" ]] && "$INSTALL_DIR/scripts/rollback.sh" --yes --non-interactive >"$LOG_DIR/$name" 2>&1; then
    write_state ok "$(tr -d '[:space:]' <"$INSTALL_DIR/VERSION")" "$name"
    ok "Roll back completed."
  else
    write_state failed "$(tr -d '[:space:]' <"$INSTALL_DIR/VERSION")" "$name"
    err "Roll back failed (see $LOG_DIR/$name)."
  fi
  STATE_KIND=update
  refresh || true
}

# ---------------------------------------------------------------- automatic updates of patch versions
# Safety rules: only the same major.minor as installed (a new feature release always needs a click), only inside the configured
# window (server time), at most one attempt per 20 hours, and after a failed automatic attempt for a version no further automatic
# attempt for THAT version until the settings are saved again in the dashboard (the agent removes auto-state.json then).
json_get() { # json_get FILE KEY  (flat JSON written by this host: strings without quotes or numbers)
  sed -n "s/.*\"$2\":\"\{0,1\}\([^,\"}]*\).*/\1/p" "$1" 2>/dev/null | head -n1
}

in_window() { # in_window HOUR FROM TO  (FROM > TO wraps around midnight; FROM = TO means the whole day)
  local h=$1 f=$2 t=$3
  if (( f == t )); then return 0; fi
  if (( f < t )); then (( h >= f && h < t )); else (( h >= f || h < t )); fi
}

# newest release with the same major.minor as installed and a higher patch number (empty if none)
latest_patch() { # latest_patch CURRENT RELEASES_JSON_FILE
  local cur="$1" minor best
  minor="${cur%.*}"
  [[ "$cur" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || return 0
  best="$(grep -o '"tag_name":"[^"]*"' "$2" 2>/dev/null | cut -d'"' -f4 | sed 's/^v//' | grep -E "^${minor//./\\.}\.[0-9]+$" | sort -V | tail -n1 || true)"
  [[ -n "$best" && "$best" != "$cur" && "$(printf '%s\n%s\n' "$cur" "$best" | sort -V | tail -n1)" == "$best" ]] && printf '%s' "$best"
  return 0
}

write_auto_state() { # write_auto_state VERSION STATE
  printf '{"version":"%s","state":"%s","at":"%s","epoch":%s}\n' "$1" "$2" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$(date +%s)" | write_atomic "$UPD/auto-state.json"
}

auto_update() {
  local cfg="$UPD/auto.json" cur cand from to hour st_ver st_state st_epoch
  [[ -f "$cfg" && "$(json_get "$cfg" mode)" == "patch" ]] || return 0
  from="$(json_get "$cfg" from)"; to="$(json_get "$cfg" to)"
  [[ "$from" =~ ^[0-9]+$ && "$to" =~ ^[0-9]+$ ]] || return 0
  hour=$((10#$(date +%H)))
  in_window "$hour" "$from" "$to" || return 0
  # a manual update or another automatic one may be running: the lock of main() already serialises, but never start over a running state
  [[ "$(json_get "$UPD/state.json" state)" != "running" ]] || return 0
  if [[ ! -f "$UPD/latest.json" || -n "$(find "$UPD/latest.json" -mmin +150 2>/dev/null)" ]]; then refresh || true; fi
  cur="$(tr -d '[:space:]' <"$INSTALL_DIR/VERSION")"
  cand="$(latest_patch "$cur" "$UPD/latest.json")"
  [[ -n "$cand" ]] || return 0
  if [[ -f "$UPD/auto-state.json" ]]; then
    st_ver="$(json_get "$UPD/auto-state.json" version)"; st_state="$(json_get "$UPD/auto-state.json" state)"; st_epoch="$(json_get "$UPD/auto-state.json" epoch)"
    if [[ "$st_state" == "failed" && "$st_ver" == "$cand" ]]; then info "Automatic update to $cand is paused after a failure."; return 0; fi
    if [[ "$st_epoch" =~ ^[0-9]+$ ]] && (( $(date +%s) - st_epoch < 72000 )); then return 0; fi
  fi
  info "Automatic update from $cur to $cand (patch version, time window $from-$to)"
  write_auto_state "$cand" running
  AUTO_RUN=1
  run_update "$cand"
  AUTO_RUN=0
  if [[ $LAST_UPDATE_OK -eq 1 ]]; then write_auto_state "$cand" ok; else write_auto_state "$cand" failed; fi
}

apply() {
  local req="$UPD/request" line
  [[ -f "$req" ]] || return 0
  line="$(head -c 200 "$req" | head -n1 || true)"
  rm -f "$req"
  case "$line" in
    check) refresh ;;
    rollback) run_rollback ;;
    "update "*)
      local version="${line#update }"
      if [[ "$version" =~ $VERSION_RE ]]; then run_update "$version"; else warn "Invalid version in the request – ignored."; fi
      ;;
    *) warn "Unknown request – ignored." ;;
  esac
}

install_units() {
  require_root
  have systemctl && [[ -d /run/systemd/system ]] || { warn "systemd not available – update helper skipped."; return 0; }
  if [[ "$(env_get UPDATE_HELPER || true)" == "off" ]]; then info "UPDATE_HELPER=off – the update helper is not set up."; return 0; fi
  install -d -m 0755 "$UPD"
  local f
  for f in "${UNITS[@]}"; do
    sed "s#@INSTALL_DIR@#$INSTALL_DIR#g; s#@DATA_DIR@#$DATA_DIR#g" "$INSTALL_DIR/scripts/systemd/$f" >"/etc/systemd/system/$f"
  done
  systemctl daemon-reload
  systemctl enable --now webmanager-update.path webmanager-updatecheck.timer webmanager-updateauto.timer >/dev/null
  systemctl start --no-block webmanager-updatecheck.service || true
  ok "Update helper set up (check every 2 hours, “Update now” button in the dashboard)"
}

main() {
  DATA_DIR="$(env_get DATA_DIR)" || die "DATA_DIR is missing in $INSTALL_DIR/.env"
  LOG_DIR="$(env_get LOG_DIR || echo "$WM_DEFAULT_LOG_DIR")"
  UPD="$DATA_DIR/update"

  case "${1:-}" in
    install) install_units ;;
    refresh|apply|auto)
      [[ -d "$UPD" ]] || die "Status directory $UPD is missing – please run 'update-helper.sh install'."
      [[ "$(env_get UPDATE_HELPER || true)" != "off" ]] || exit 0
      exec 8>"${WM_LOCK_FILE:-/var/lock/webmanager-update-helper.lock}"
      flock 8
      case "$1" in auto) auto_update ;; *) "$1" ;; esac
      ;;
    *) die "Verwendung: update-helper.sh install|refresh|apply|auto" ;;
  esac
}

# The whole script is parsed before it runs: update.sh replaces this file while an update is running.
main "$@"
exit
