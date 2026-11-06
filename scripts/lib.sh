#!/usr/bin/env bash
# Shared helpers for install.sh, update.sh, backup.sh, restore.sh and uninstall.sh.
# Sourced, never executed. Requires bash >= 4.

WM_DEFAULT_INSTALL_DIR="/opt/webmanager"
WM_DEFAULT_DATA_DIR="/var/lib/webmanager"
WM_DEFAULT_LOG_DIR="/var/log/webmanager"
WM_DEFAULT_BACKUP_DIR="/var/backups/webmanager"

if [[ -t 1 ]]; then
  C_RED=$'\033[31m'; C_GRN=$'\033[32m'; C_YEL=$'\033[33m'; C_BLU=$'\033[34m'; C_BLD=$'\033[1m'; C_RST=$'\033[0m'
else
  C_RED=""; C_GRN=""; C_YEL=""; C_BLU=""; C_BLD=""; C_RST=""
fi

ts()    { date '+%Y-%m-%d %H:%M:%S'; }
info()  { printf '%s[%s]%s %s\n' "$C_BLU" "$(ts)" "$C_RST" "$*"; }
ok()    { printf '%s[%s] ✔%s %s\n' "$C_GRN" "$(ts)" "$C_RST" "$*"; }
warn()  { printf '%s[%s] ! %s%s\n' "$C_YEL" "$(ts)" "$*" "$C_RST" >&2; }
err()   { printf '%s[%s] ✘ %s%s\n' "$C_RED" "$(ts)" "$*" "$C_RST" >&2; }
die()   { err "$*"; exit "${DIE_CODE:-1}"; }
have()  { command -v "$1" >/dev/null 2>&1; }

require_root() {
  if [[ ${EUID:-$(id -u)} -ne 0 ]]; then
    if have sudo; then
      die "This script needs root privileges. Please run it with 'sudo $0 ...'."
    fi
    die "This script needs root privileges (neither root nor sudo available)."
  fi
}

# confirm "Frage?" [y|n]  -> returns 0 for yes. Non-interactive: --yes answers yes, otherwise the default.
confirm() {
  local question="$1" default="${2:-n}" reply prompt
  if [[ "${ASSUME_YES:-0}" == "1" ]]; then return 0; fi
  if [[ "${NON_INTERACTIVE:-0}" == "1" || ! -t 0 ]]; then
    [[ "$default" == "y" ]]; return
  fi
  [[ "$default" == "y" ]] && prompt="[Y/n]" || prompt="[y/N]"
  read -r -p "$question $prompt " reply || reply=""
  reply="${reply,,}"
  if [[ -z "$reply" ]]; then [[ "$default" == "y" ]]; return; fi
  [[ "$reply" == "y" || "$reply" == "yes" ]]
}

# Strong confirmation for destructive actions: user has to type a phrase. Never auto-confirmed by --yes.
confirm_phrase() {
  local phrase="$1" reply
  if [[ ! -t 0 ]]; then die "This action requires an interactive confirmation."; fi
  read -r -p "Type '$phrase' to confirm: " reply || reply=""
  [[ "$reply" == "$phrase" ]]
}

# Random hex secret of N bytes (2N hex chars), from the kernel CSPRNG.
gen_secret() { head -c "${1:-32}" /dev/urandom | od -An -tx1 | tr -d ' \n'; }

# --- .env handling (parsed, never sourced: no code execution from the file) ---------------------
env_file() { printf '%s/.env' "${INSTALL_DIR:?}"; }

env_get() { # env_get KEY [file]
  local key="$1" file="${2:-$(env_file)}"
  [[ -f "$file" ]] || return 1
  local line
  line="$(grep -E "^${key}=" "$file" | tail -n1)" || return 1
  printf '%s' "${line#*=}"
}

env_set() { # env_set KEY VALUE  (keeps file mode)
  local key="$1" value="$2" file
  file="$(env_file)"
  [[ "$value" =~ ^[A-Za-z0-9._:/@,+=-]*$ ]] || die "Invalid value for $key (forbidden characters)."
  if grep -qE "^${key}=" "$file" 2>/dev/null; then
    local tmp; tmp="$(mktemp "${file}.XXXXXX")"
    chmod 600 "$tmp"
    awk -v k="$key" -v v="$value" 'BEGIN{FS=OFS="="} $1==k {print k"="v; next} {print}' "$file" >"$tmp"
    mv -f "$tmp" "$file"
  else
    printf '%s=%s\n' "$key" "$value" >>"$file"
  fi
}

compose() {
  docker compose --project-directory "$INSTALL_DIR" -f "$INSTALL_DIR/docker-compose.yml" --env-file "$INSTALL_DIR/.env" "$@"
}

# Health/state of a compose service: healthy | running | starting | unhealthy | exited | ... | missing
svc_state() {
  local cid
  cid="$(compose ps -q "$1" 2>/dev/null || true)"
  [[ -n "$cid" ]] || { printf 'missing'; return; }
  docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$cid" 2>/dev/null || printf 'unknown'
}

# Explains why services are not ready: state, the last health check outputs and the end of the log.
diagnose_services() { # diagnose_services service...
  local svc cid st
  for svc in "$@"; do
    st="$(svc_state "$svc")"
    case "$st" in healthy|running) continue ;; esac
    warn "Service '$svc' is not ready (status: $st)"
    cid="$(compose ps -q "$svc" 2>/dev/null || true)"
    if [[ -n "$cid" ]]; then
      docker inspect -f '{{if .State.Health}}{{range .State.Health.Log}}  Health check: {{.Output}}{{end}}{{end}}' "$cid" 2>/dev/null | tail -n 3 >&2 || true
    fi
    compose logs --no-color --tail=25 "$svc" 2>&1 | sed 's/^/    /' >&2 || true
  done
}

# Wait until all given compose services report "healthy" (or running if they have no health check).
# A container that shows up as exited is only treated as failed if it stays that way for 45 s: while Docker recreates or
# restarts a container (restart policy), that state is briefly visible and must not abort an otherwise good update.
# On failure the reason is printed (see diagnose_services).
wait_healthy() { # wait_healthy TIMEOUT service...
  local timeout="$1"; shift
  local deadline=$(( $(date +%s) + timeout )) svc status all now
  local -A down_since=()
  while :; do
    all=1; now="$(date +%s)"
    for svc in "$@"; do
      status="$(svc_state "$svc")"
      case "$status" in
        healthy|running) unset "down_since[$svc]" ;;
        exited|dead)
          if [[ -z "${down_since[$svc]:-}" ]]; then down_since[$svc]="$now"; fi
          if (( now - down_since[$svc] > 45 )); then err "Service '$svc' has exited."; diagnose_services "$svc"; return 2; fi
          all=0 ;;
        *) unset "down_since[$svc]"; all=0 ;;
      esac
    done
    [[ $all -eq 1 ]] && return 0
    if (( $(date +%s) >= deadline )); then diagnose_services "$@"; return 1; fi
    sleep 3
  done
}

# True when the product images are built locally (prefix of a source install).
wm_local_images() { local p; p="$(env_get WM_IMAGE_PREFIX || true)"; [[ -z "$p" || "$p" == "drimzo" ]]; }

# prune_stale INSTALL_DIR NEW_TREE: removes files of the installed tree that the new release no longer has (copying a release over the
# old tree leaves deleted files behind). Only the top-level entries of the release are looked at, so .env, tokens and other files
# that were put into the install directory by hand stay; public/assets/app (build output) is never touched.
prune_stale() {
  local dir="$1" new="$2" entry f rel n=0
  while IFS= read -r entry; do
    entry="${entry#"$new"/}"
    [[ -d "$dir/$entry" ]] || continue
    while IFS= read -r f; do
      rel="${f#"$dir"/}"
      case "$rel" in public/assets/app/*|*/node_modules/*) continue ;; esac
      if [[ ! -e "$new/$rel" && ! -L "$new/$rel" ]]; then rm -f -- "$f"; n=$((n + 1)); fi
    done < <(find "$dir/$entry" -type f -o -type l)
    find "$dir/$entry" -mindepth 1 -type d -empty -not -path "$dir/public/assets/app*" -delete 2>/dev/null || true
  done < <(find "$new" -mindepth 1 -maxdepth 1 -type d)
  [[ $n -eq 0 ]] || info "Removed $n files that no longer exist in the new version."
}

service_status() { svc_state "$1"; } # prints health/state of a compose service

# Backs up a file or directory into CONFIG_BACKUP_DIR before it is modified.
backup_path() {
  local src="$1"
  [[ -e "$src" ]] || return 0
  mkdir -p "${CONFIG_BACKUP_DIR:?}"
  chmod 700 "$CONFIG_BACKUP_DIR"
  cp -a "$src" "$CONFIG_BACKUP_DIR/$(basename "$src")" 2>/dev/null || warn "Backup of $src failed"
}

# Sets up logging to a file outside web-served directories; everything printed is also logged.
setup_logging() { # setup_logging name
  local name="$1"
  mkdir -p "${LOG_DIR:?}"
  chmod 750 "$LOG_DIR"
  LOG_FILE="$LOG_DIR/${name}-$(date +%Y%m%d-%H%M%S).log"
  : >"$LOG_FILE"
  chmod 600 "$LOG_FILE"
  exec > >(tee -a "$LOG_FILE") 2>&1
  info "Log: $LOG_FILE"
}

# Primary IPv4 address of this host (no external lookups).
primary_ip() {
  local ip=""
  if have ip; then ip="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src"){print $(i+1); exit}}')"; fi
  if [[ -z "$ip" ]] && have hostname; then ip="$(hostname -I 2>/dev/null | awk '{print $1}')"; fi
  printf '%s' "${ip:-}"
}

# Public (non-private) IPv4/IPv6 addresses present on local interfaces, comma separated.
public_ips() {
  have ip || return 0
  { ip -4 -o addr show scope global 2>/dev/null | awk '{split($4,a,"/"); print a[1]}' \
      | grep -Ev '^(10\.|127\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.|169\.254\.|100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.)' || true
    ip -6 -o addr show scope global 2>/dev/null | awk '{split($4,a,"/"); print a[1]}' | grep -Evi '^(fc|fd)' || true
  } | paste -sd, -
}

# Grandfather-father-son retention: prints the backup names to KEEP. Input (stdin): archive names webmanager-backup-YYYYmmdd-HHMMSS-*,
# one per line. Kept are the newest backup of each of the last DAILY days, WEEKLY ISO weeks and MONTHLY months that have backups.
gfs_select() { # gfs_select DAILY WEEKLY MONTHLY
  local nd="$1" nw="$2" nm="$3" name day wk mo cd=0 cw=0 cm=0
  local -A seen_d=() seen_w=() seen_m=() keep=()
  while read -r name; do
    [[ "$name" =~ webmanager-backup-([0-9]{8})-[0-9]{6} ]] || continue
    day="${BASH_REMATCH[1]}"
    wk="$(date -d "$day" +%G-%V 2>/dev/null || echo "$day")"
    mo="${day:0:6}"
    if [[ -z "${seen_d[$day]:-}" ]]; then seen_d[$day]=1; if (( cd < nd )); then keep[$name]=1; cd=$((cd + 1)); fi; fi
    if [[ -z "${seen_w[$wk]:-}" ]]; then seen_w[$wk]=1; if (( cw < nw )); then keep[$name]=1; cw=$((cw + 1)); fi; fi
    if [[ -z "${seen_m[$mo]:-}" ]]; then seen_m[$mo]=1; if (( cm < nm )); then keep[$name]=1; cm=$((cm + 1)); fi; fi
  done < <(sort -r)
  [[ ${#keep[@]} -eq 0 ]] || printf '%s\n' "${!keep[@]}" | sort -r
}

human_bytes() { numfmt --to=iec --suffix=B "$1" 2>/dev/null || printf '%s B' "$1"; }

# True if the dashboard answers /healthz from inside the proxy container, i.e. over the same Docker network path the
# reverse proxy uses (independent of host port bindings, DNS, the public IP or the TLS certificate). With a dashboard domain
# and HTTPS the proxy only redirects plain-http requests to https, so a probe through port 80 would leave the host and
# depend on hairpin NAT and DNS - the proxy itself is covered by its own health check.
dashboard_probe() {
  compose exec -T proxy wget -q -O- -T 5 http://webmanager:8080/healthz 2>/dev/null | grep -qx ok
}

# True if the running update.sh should hand the rest of the update over to the update.sh of the downloaded release, so that
# fixes to the update procedure apply to this very update. Never twice (WM_UPDATE_HANDOFF), only for a different, syntactically
# valid script that comes with its own lib.sh.
should_handoff() { # should_handoff NEW_TREE RUNNING_SCRIPT
  local top="$1" self="$2"
  [[ -z "${WM_UPDATE_HANDOFF:-}" ]] || return 1
  [[ -f "$top/update.sh" && -f "$top/scripts/lib.sh" ]] || return 1
  cmp -s "$top/update.sh" "$self" && cmp -s "$top/scripts/lib.sh" "${BASH_SOURCE[0]}" && return 1
  bash -n "$top/update.sh" 2>/dev/null && bash -n "$top/scripts/lib.sh" 2>/dev/null
}

# ---- release download helpers (used by update.sh and update-helper.sh) -------------------------------
# Releases come from the update server of the project. The address is part of the code and deliberately not configurable:
# the server only transports the archives, authenticity comes from the SHA-256 and the GPG signature (keys/release.asc).
WM_UPDATE_BASE_URL="https://updates.drimzo.cc/webmanager/stable"
fetch() { curl -fsSL --proto '=https' --tlsv1.2 --max-time 600 "$@"; }

# update_latest: prints the newest published version (without a leading v) or fails
update_latest() {
  local v
  v="$(fetch "$WM_UPDATE_BASE_URL/LATEST" 2>/dev/null | head -c 64 | tr -d '[:space:]')" || return 1
  v="${v#v}"
  [[ "$v" =~ ^[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z.]+)?$ ]] || return 1
  printf '%s' "$v"
}

# update_min_supported: oldest version the project still supports (file MIN_SUPPORTED on the update server); empty if none is set
update_min_supported() {
  local v
  v="$(fetch "$WM_UPDATE_BASE_URL/MIN_SUPPORTED" 2>/dev/null | head -c 64 | tr -d '[:space:]')" || return 0
  v="${v#v}"
  [[ "$v" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] && printf '%s' "$v"
  return 0
}
