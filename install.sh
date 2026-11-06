#!/usr/bin/env bash
# WebManager – installer for Debian 12/13 and Ubuntu 24.04 LTS.
#
#   sudo ./install.sh                      interactive installation
#   sudo ./install.sh --yes --domain panel.example.com --admin-email me@example.com \
#        --admin-password-file /root/admin.pw          unattended installation
#
# Re-running is safe: existing .env secrets, databases, websites and certificates are kept.
set -Eeuo pipefail
IFS=$'\n\t'
umask 027

ORIG_ARGS=("$@")
SCRIPT_PATH="$(readlink -f -- "${BASH_SOURCE[0]}")"
SCRIPT_DIR="$(dirname -- "$SCRIPT_PATH")"

# Exit codes: 1 error, 2 unsupported platform/resources, 3 docker problem, 4 health check failed
usage() {
  cat <<'EOF'
WebManager Installer

Verwendung: sudo ./install.sh [Optionen]

  -y, --yes                     answer all questions with "yes" (destructive actions stay protected)
      --non-interactive         no questions; use the default answers
      --install-dir DIR         application directory      (default: /opt/webmanager)
      --data-dir DIR            data directory             (default: /var/lib/webmanager)
      --domain DOMAIN           dashboard domain (optional; otherwise access by server IP)
      --bind-address IP         address for port 80/443     (default: 0.0.0.0, e.g. 127.0.0.1 for local only)
      --http-port N             host port for HTTP          (default: 80)
      --https-port N            host port for HTTPS         (default: 443)
      --admin-email MAIL        email of the first administrator
      --admin-password-file F   file with the password of the first administrator (mode 0600)
      --no-admin                do not create an administrator
      --registry PREFIX         pull images from a registry instead of building locally (e.g. registry.example.com/drimzo)
      --no-build                use existing images, build/pull nothing
      --configure-ufw           (opt-in) open ports 80/443 in an active UFW
      --enable-backup-timer     (opt-in) set up a daily backup timer (systemd)
      --harden-egress           (opt-in) websites may no longer reach the Docker host and the metadata service (iptables)
      --allow-unsupported       try an untested distribution anyway
      --skip-resource-check     treat the resource check as a warning only
      --release-url URL         (download mode) release archive .tar.gz
      --sha256 HASH             (download mode) expected SHA-256 sum of the archive
      --sig-url URL             (download mode) optional GPG signature (.asc/.sig)
      --keyring FILE            (download mode) GPG keyring for the signature check
  -h, --help                    this help

Environment variables: WM_INSTALL_DIR, WM_DATA_DIR, WM_DOMAIN, ADMIN_EMAIL, ADMIN_PASSWORD_FILE
EOF
}

# ------------------------------------------------------------------------------ options
ASSUME_YES=0; NON_INTERACTIVE=0
INSTALL_DIR="${WM_INSTALL_DIR:-/opt/webmanager}"
DATA_DIR="${WM_DATA_DIR:-/var/lib/webmanager}"
DOMAIN="${WM_DOMAIN:-}"
BIND_ADDRESS="${WM_BIND_ADDRESS:-0.0.0.0}"
HTTP_PORT="${WM_HTTP_PORT:-80}"; HTTPS_PORT="${WM_HTTPS_PORT:-443}"
ADMIN_EMAIL="${ADMIN_EMAIL:-}"; ADMIN_PASSWORD_FILE="${ADMIN_PASSWORD_FILE:-}"
NO_ADMIN=0; REGISTRY=""; NO_BUILD=0; CONFIGURE_UFW=0; BACKUP_TIMER=0; HARDEN_EGRESS=0; ALLOW_UNSUPPORTED=0; SKIP_RES=0
RELEASE_URL=""; RELEASE_SHA=""; SIG_URL=""; KEYRING=""

parse_args() {
  while [[ $# -gt 0 ]]; do
    local a="$1" v=""
    if [[ "$a" == --*=* ]]; then v="${a#*=}"; a="${a%%=*}"; set -- "$a" "$v" "${@:2}"; fi
    case "$a" in
      -y|--yes) ASSUME_YES=1 ;;
      --non-interactive) NON_INTERACTIVE=1 ;;
      --install-dir) INSTALL_DIR="${2:?}"; shift ;;
      --data-dir) DATA_DIR="${2:?}"; shift ;;
      --domain) DOMAIN="${2:?}"; shift ;;
      --bind-address) BIND_ADDRESS="${2:?}"; shift ;;
      --http-port) HTTP_PORT="${2:?}"; shift ;;
      --https-port) HTTPS_PORT="${2:?}"; shift ;;
      --admin-email) ADMIN_EMAIL="${2:?}"; shift ;;
      --admin-password-file) ADMIN_PASSWORD_FILE="${2:?}"; shift ;;
      --no-admin) NO_ADMIN=1 ;;
      --registry) REGISTRY="${2:?}"; shift ;;
      --no-build) NO_BUILD=1 ;;
      --configure-ufw) CONFIGURE_UFW=1 ;;
      --enable-backup-timer) BACKUP_TIMER=1 ;;
      --harden-egress) HARDEN_EGRESS=1 ;;
      --allow-unsupported) ALLOW_UNSUPPORTED=1 ;;
      --skip-resource-check) SKIP_RES=1 ;;
      --release-url) RELEASE_URL="${2:?}"; shift ;;
      --sha256) RELEASE_SHA="${2:?}"; shift ;;
      --sig-url) SIG_URL="${2:?}"; shift ;;
      --keyring) KEYRING="${2:?}"; shift ;;
      -h|--help) usage; exit 0 ;;
      *) echo "Unknown option: $a" >&2; usage >&2; exit 1 ;;
    esac
    shift
  done
}

# ------------------------------------------------------------------------------ download mode
# When only install.sh was downloaded, fetch the release archive, verify it and continue with the
# install.sh inside it. The SHA-256 sum is mandatory; a GPG signature is verified when provided.
bootstrap_download() {
  local msg_die
  msg_die() { printf '✘ %s\n' "$*" >&2; exit 1; }
  [[ ${EUID:-$(id -u)} -eq 0 ]] || msg_die "Please run with sudo/root."
  [[ -n "$RELEASE_URL" ]] || msg_die "No application found next to install.sh. Load the release with --release-url URL --sha256 HASH (see README)."
  [[ "$RELEASE_URL" == https://* ]] || msg_die "The release URL must use https://."
  [[ "$RELEASE_SHA" =~ ^[0-9a-fA-F]{64}$ ]] || msg_die "--sha256 with a 64-character SHA-256 sum is required."
  command -v curl >/dev/null || msg_die "curl is required for the download (apt-get install curl)."
  local tmp; tmp="$(mktemp -d /tmp/wm-bootstrap.XXXXXX)"
  chmod 700 "$tmp"
  echo "Lade $RELEASE_URL …"
  curl -fsSL --proto '=https' --tlsv1.2 -o "$tmp/release.tar.gz" "$RELEASE_URL" || msg_die "Download failed."
  local got; got="$(sha256sum "$tmp/release.tar.gz" | awk '{print $1}')"
  [[ "${got,,}" == "${RELEASE_SHA,,}" ]] || msg_die "SHA-256 does not match (expected ${RELEASE_SHA,,}, got $got). Aborting."
  echo "✔ SHA-256 verified."
  if [[ -n "$SIG_URL" ]]; then
    command -v gpg >/dev/null || msg_die "gpg is required for the signature check."
    [[ -n "$KEYRING" && -f "$KEYRING" ]] || msg_die "--keyring with the release key is required for the signature check."
    curl -fsSL --proto '=https' --tlsv1.2 -o "$tmp/release.sig" "$SIG_URL" || msg_die "The signature could not be downloaded."
    gpg --no-default-keyring --keyring "$KEYRING" --verify "$tmp/release.sig" "$tmp/release.tar.gz" || msg_die "Signature check failed."
    echo "✔ GPG signature verified."
  fi
  # refuse archives with absolute paths or path traversal
  if tar -tzf "$tmp/release.tar.gz" | grep -Eq '(^/|(^|/)\.\.(/|$))'; then msg_die "The archive contains invalid paths."; fi
  mkdir -p "$tmp/src"
  tar -xzf "$tmp/release.tar.gz" -C "$tmp/src" --no-same-owner
  local top; top="$(find "$tmp/src" -mindepth 1 -maxdepth 1 -type d | head -n1)"
  [[ -n "$top" && -f "$top/install.sh" && -f "$top/docker-compose.yml" ]] || msg_die "The archive does not have the expected structure."
  local args=() skip=0 x
  for x in "${ORIG_ARGS[@]}"; do   # strip download-only options
    if [[ $skip -eq 1 ]]; then skip=0; continue; fi
    case "$x" in
      --release-url|--sha256|--sig-url|--keyring) skip=1 ;;
      --release-url=*|--sha256=*|--sig-url=*|--keyring=*) ;;
      *) args+=("$x") ;;
    esac
  done
  exec bash "$top/install.sh" "${args[@]}"
}

parse_args "$@"
if [[ ! -f "$SCRIPT_DIR/docker-compose.yml" || ! -f "$SCRIPT_DIR/scripts/lib.sh" ]]; then
  bootstrap_download
fi

# shellcheck source=scripts/lib.sh
source "$SCRIPT_DIR/scripts/lib.sh"

SRC_DIR="$SCRIPT_DIR"
WM_VERSION="$(tr -d '[:space:]' <"$SRC_DIR/VERSION")"
LOG_DIR="${WM_LOG_DIR:-$WM_DEFAULT_LOG_DIR}"
CONFIG_BACKUP_DIR="$WM_DEFAULT_BACKUP_DIR/config-before-install-$(date +%Y%m%d-%H%M%S)"
export ASSUME_YES NON_INTERACTIVE

on_error() {
  local code=$? line=${1:-?}
  err "Installation failed (line $line, exit code $code)."
  [[ -n "${LOG_FILE:-}" ]] && err "Details in the log: $LOG_FILE"
  err "Existing data (database, websites, certificates) was not changed. You can run install.sh again after fixing the problem."
  exit "$code"
}
trap 'on_error $LINENO' ERR

# ------------------------------------------------------------------------------ checks
OS_ID=""; OS_VERSION=""; OS_CODENAME=""; OS_PRETTY=""
detect_os() {
  [[ -r /etc/os-release ]] || { DIE_CODE=2 die "/etc/os-release is missing – operating system not recognisable."; }
  # shellcheck disable=SC1091
  OS_ID="$(. /etc/os-release; echo "${ID:-}")"
  OS_VERSION="$(. /etc/os-release; echo "${VERSION_ID:-}")"
  OS_PRETTY="$(. /etc/os-release; echo "${PRETTY_NAME:-$OS_ID $OS_VERSION}")"
  if [[ "$OS_ID" == "ubuntu" ]]; then
    OS_CODENAME="$(. /etc/os-release; echo "${UBUNTU_CODENAME:-${VERSION_CODENAME:-}}")"
  else
    OS_CODENAME="$(. /etc/os-release; echo "${VERSION_CODENAME:-}")"
  fi
  local supported=0
  case "$OS_ID:$OS_VERSION" in
    debian:13|debian:12|ubuntu:24.04) supported=1 ;;
  esac
  if [[ $supported -eq 1 ]]; then
    ok "Operating system: $OS_PRETTY (supported)"
  elif [[ $ALLOW_UNSUPPORTED -eq 1 && ( "$OS_ID" == "debian" || "$OS_ID" == "ubuntu" ) ]]; then
    warn "Operating system $OS_PRETTY is untested. Continuing at your own risk (--allow-unsupported)."
  else
    DIE_CODE=2 die "Unsupported operating system: $OS_PRETTY. Supported: Debian 13, Debian 12, Ubuntu 24.04 LTS."
  fi
  [[ -n "$OS_CODENAME" ]] || DIE_CODE=2 die "The distribution codename could not be determined."
  have apt-get || DIE_CODE=2 die "apt-get not found."
}

check_arch() {
  local m; m="$(uname -m)"
  case "$m" in
    x86_64|aarch64) ok "Architektur: $m" ;;
    *) DIE_CODE=2 die "Unsupported architecture: $m (supported: x86_64, aarch64)." ;;
  esac
}

check_resources() {
  local cpus mem_kb mem_mb free_kb free_mb path
  cpus="$(nproc 2>/dev/null || echo 1)"
  mem_kb="$(awk '/^MemTotal:/ {print $2}' /proc/meminfo)"; mem_mb=$(( mem_kb / 1024 ))
  info "Ressourcen: $cpus CPU-Kern(e), ${mem_mb} MB RAM"
  local problems=0
  if (( mem_mb < 1000 )); then err "Not enough memory (${mem_mb} MB, at least 1 GB, 2 GB recommended)."; problems=1
  elif (( mem_mb < 1900 )); then warn "Little memory (${mem_mb} MB). At least 2 GB are recommended."; fi
  for path in "$DATA_DIR" /var/lib/docker; do
    while [[ ! -d "$path" && "$path" != "/" ]]; do path="$(dirname "$path")"; done
    free_kb="$(df -Pk "$path" | awk 'NR==2 {print $4}')"; free_mb=$(( free_kb / 1024 ))
    info "Free disk space at $path: ${free_mb} MB"
    if (( free_mb < 5000 )); then err "Not enough free disk space at $path (${free_mb} MB, at least 5 GB)."; problems=1
    elif (( free_mb < 10000 )); then warn "Little free disk space at $path (${free_mb} MB, 10 GB recommended)."; fi
  done
  if (( problems )); then
    if [[ $SKIP_RES -eq 1 ]]; then warn "Resource problems are ignored because of --skip-resource-check."
    else DIE_CODE=2 die "System requirements not met (continue at your own risk with --skip-resource-check)."; fi
  fi
}

port_in_use() { ss -ltnH "sport = :$1" 2>/dev/null | grep -q .; }

check_ports() {
  have ss || { warn "ss not available – port check skipped."; return 0; }
  local mine=0
  if have docker && docker ps --format '{{.Names}}' 2>/dev/null | grep -qx 'wm-proxy'; then mine=1; fi
  local p
  for p in "$HTTP_PORT" "$HTTPS_PORT"; do
    if port_in_use "$p" && [[ $mine -eq 0 ]]; then
      err "Port $p is already in use by:"
      ss -ltnpH "sport = :$p" 2>/dev/null | sed 's/^/    /' >&2 || true
      DIE_CODE=2 die "Port $p is already in use. Stop the other service or use --http-port/--https-port or --bind-address."
    fi
  done
  ok "Ports $HTTP_PORT/$HTTPS_PORT are available (or belong to this installation)."
}

# ------------------------------------------------------------------------------ docker
DOCKER_FPR="9DC858229FC7DD38854AE2D88D81803C0EBFCD88"   # official Docker apt signing key

install_docker_repo_and_packages() { # install_docker_repo_and_packages pkg...
  export DEBIAN_FRONTEND=noninteractive
  info "Installing Docker repository and packages (ca-certificates, curl, gnupg) …"
  apt-get update -qq
  apt-get install -y -qq ca-certificates curl gnupg >/dev/null
  install -m 0755 -d /etc/apt/keyrings
  local tmpkey; tmpkey="$(mktemp)"
  curl -fsSL --proto '=https' --tlsv1.2 "https://download.docker.com/linux/${OS_ID}/gpg" -o "$tmpkey"
  local fpr
  fpr="$(gpg --show-keys --with-colons "$tmpkey" 2>/dev/null | awk -F: '$1=="fpr" {print $10; exit}')"
  if [[ "$fpr" != "$DOCKER_FPR" ]]; then
    rm -f "$tmpkey"
    DIE_CODE=3 die "Fingerprint of the Docker repository key does not match (expected $DOCKER_FPR, got ${fpr:-empty}). Aborting."
  fi
  ok "Docker repository key verified ($fpr)"
  backup_path /etc/apt/keyrings/docker.asc
  install -m 0644 "$tmpkey" /etc/apt/keyrings/docker.asc
  rm -f "$tmpkey"
  backup_path /etc/apt/sources.list.d/docker.sources
  cat >/etc/apt/sources.list.d/docker.sources <<EOF
Types: deb
URIs: https://download.docker.com/linux/${OS_ID}
Suites: ${OS_CODENAME}
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
EOF
  apt-get update -qq
  info "Installing: $*"
  apt-get install -y -qq "$@" >/dev/null
}

ensure_docker() {
  local need_engine=1 need_compose=1
  if have docker && docker info >/dev/null 2>&1; then
    need_engine=0
    ok "Existing Docker installation is kept: $(docker version --format '{{.Server.Version}}' 2>/dev/null || echo '?')"
  elif have docker; then
    info "Docker is installed but the daemon does not answer – trying to start it …"
    systemctl enable --now docker >/dev/null 2>&1 || true
    sleep 3
    if docker info >/dev/null 2>&1; then need_engine=0; fi
  fi
  if docker compose version >/dev/null 2>&1; then need_compose=0; fi

  if (( need_engine )); then
    install_docker_repo_and_packages docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  elif (( need_compose )); then
    info "Docker Compose v2 is missing – installing docker-compose-plugin."
    install_docker_repo_and_packages docker-compose-plugin
  fi
  systemctl enable --now docker >/dev/null 2>&1 || true
  local i
  for i in $(seq 1 20); do docker info >/dev/null 2>&1 && break; sleep 2; done
  docker info >/dev/null 2>&1 || DIE_CODE=3 die "The Docker daemon is not running. Check with: systemctl status docker"
  docker compose version >/dev/null 2>&1 || DIE_CODE=3 die "Docker Compose v2 is not available."
  local cv; cv="$(docker compose version --short 2>/dev/null || true)"
  [[ "${cv#v}" =~ ^([0-9]+)\. && "${BASH_REMATCH[1]}" -ge 2 ]] || DIE_CODE=3 die "Docker Compose v2 required (found: ${cv:-unknown})."
  ok "Docker $(docker version --format '{{.Server.Version}}'), Compose $cv"
  # the daemon socket must never be published on TCP by us; warn if somebody else did
  if docker info --format '{{json .}}' 2>/dev/null | grep -q '"tcp://'; then
    warn "The Docker daemon seems to listen on TCP. This is strongly discouraged."
  fi
}

# ------------------------------------------------------------------------------ files
create_dirs() {
  info "Creating directories …"
  install -d -m 0755 -o root -g root "$INSTALL_DIR" "$DATA_DIR" "$DATA_DIR/sites" "$DATA_DIR/runtime" \
    "$DATA_DIR/runtime/proxy" "$DATA_DIR/runtime/proxy/conf.d" "$DATA_DIR/runtime/acme"
  install -d -m 0700 -o root -g root "$DATA_DIR/backups" "$DATA_DIR/database-backups" "$DATA_DIR/letsencrypt" "$DATA_DIR/trash"
  install -d -m 0750 -o root -g root "$LOG_DIR"
  install -d -m 0700 -o root -g root "$WM_DEFAULT_BACKUP_DIR"
  ok "Directories ready ($INSTALL_DIR, $DATA_DIR)"
}

sync_sources() {
  if [[ "$(readlink -f "$SRC_DIR")" == "$(readlink -f "$INSTALL_DIR")" ]]; then
    info "Sources are already in $INSTALL_DIR."
  else
    info "Copying the application to $INSTALL_DIR …"
    if [[ -f "$INSTALL_DIR/docker-compose.yml" ]]; then
      backup_path "$INSTALL_DIR/docker-compose.yml"
      backup_path "$INSTALL_DIR/templates/runtimes.json"
    fi
    # never touch .env, the data directory or VCS metadata
    tar -C "$SRC_DIR" --exclude='./.git' --exclude='./.env' --exclude='node_modules' --exclude='./backups' -cf - . \
      | tar -C "$INSTALL_DIR" --no-same-owner -xf -
  fi
  chown -R root:root "$INSTALL_DIR"
  chmod 0755 "$INSTALL_DIR"/*.sh "$INSTALL_DIR"/scripts/*.sh "$INSTALL_DIR"/scripts/webmanager 2>/dev/null || true
  [[ -f "$INSTALL_DIR/.env" ]] && chmod 600 "$INSTALL_DIR/.env"
  return 0
}

write_env() {
  local envf="$INSTALL_DIR/.env"
  if [[ -f "$envf" ]]; then
    info "Existing .env is kept (secrets stay unchanged)."
    backup_path "$envf"
    chmod 600 "$envf"
    # add keys introduced by newer versions without touching existing values
    local k v
    for k in INSTALL_DIR DATA_DIR LOG_DIR BACKUP_DIR BIND_ADDRESS HTTP_PORT HTTPS_PORT DASHBOARD_DOMAIN PUBLIC_IPS TRUSTED_PROXIES ACME_STAGING SITE_NET_POOL TZ; do
      grep -qE "^${k}=" "$envf" && continue
      case "$k" in
        INSTALL_DIR) v="$INSTALL_DIR" ;; DATA_DIR) v="$DATA_DIR" ;; LOG_DIR) v="$LOG_DIR" ;; BACKUP_DIR) v="$DATA_DIR/backups" ;;
        BIND_ADDRESS) v="$BIND_ADDRESS" ;; HTTP_PORT) v="$HTTP_PORT" ;; HTTPS_PORT) v="$HTTPS_PORT" ;;
        DASHBOARD_DOMAIN) v="$DOMAIN" ;; PUBLIC_IPS) v="$(public_ips)" ;; TRUSTED_PROXIES) v="" ;; ACME_STAGING) v="false" ;; SITE_NET_POOL) v="10.210" ;;
        TZ) v="$(cat /etc/timezone 2>/dev/null || echo UTC)" ;;
      esac
      printf '%s=%s\n' "$k" "$v" >>"$envf"
    done
    # explicit command line choices override stored values
    [[ -n "$DOMAIN" ]] && env_set DASHBOARD_DOMAIN "$DOMAIN"
    env_set WM_VERSION "$WM_VERSION"
    return 0
  fi
  info "Creating .env with random secrets (mode 0600) …"
  local tz; tz="$(cat /etc/timezone 2>/dev/null || echo UTC)"
  ( umask 077
    cat >"$envf" <<EOF
# Generated by install.sh on $(date -u +%Y-%m-%dT%H:%M:%SZ). Contains secrets – keep mode 0600.
WM_VERSION=$WM_VERSION
WM_IMAGE_PREFIX=${REGISTRY:-drimzo}
INSTALL_DIR=$INSTALL_DIR
DATA_DIR=$DATA_DIR
LOG_DIR=$LOG_DIR
BACKUP_DIR=$DATA_DIR/backups
BIND_ADDRESS=$BIND_ADDRESS
HTTP_PORT=$HTTP_PORT
HTTPS_PORT=$HTTPS_PORT
DASHBOARD_DOMAIN=$DOMAIN
PUBLIC_IPS=$(public_ips)
# Addresses of a reverse proxy in front of WebManager (see .env.example); empty = none
TRUSTED_PROXIES=
ACME_STAGING=false
SITE_NET_POOL=10.210
TZ=$tz
DB_NAME=webmanager
DB_USER=webmanager
DB_PASSWORD=$(gen_secret 24)
DB_ROOT_PASSWORD=$(gen_secret 24)
APP_KEY=$(gen_secret 32)
AGENT_TOKEN_DASHBOARD=$(gen_secret 32)
AGENT_TOKEN_WORKER=$(gen_secret 32)
EOF
  )
  chmod 600 "$envf"
  ok ".env created (secrets are neither shown nor logged)"
}

# ------------------------------------------------------------------------------ stack
build_or_pull() {
  if [[ $NO_BUILD -eq 1 ]]; then info "Skipping build/pull (--no-build)."; return 0; fi
  if [[ -n "$REGISTRY" ]] || ! wm_local_images; then
    info "Pulling images from the registry $(env_get WM_IMAGE_PREFIX) (version $WM_VERSION) …"
    compose pull --quiet agent worker webmanager proxy db
  else
    info "Building images (may take a few minutes) …"
    compose build --pull
    compose pull --quiet db
  fi
  ok "Images ready"
}

run_migrations() {
  info "Starting database …"
  compose up -d db
  wait_healthy 180 db || { DIE_CODE=4 die "The database did not become healthy in time. Logs: docker compose -f $INSTALL_DIR/docker-compose.yml logs db"; }
  info "Running database migrations …"
  compose run --rm --no-deps -T webmanager php bin/console migrate
}

start_stack() {
  info "Starting WebManager services …"
  compose up -d --remove-orphans
}

prebuild_php_runtime() {
  local rt
  for rt in static php-8.3; do
    info "Preparing runtime image '$rt' (once, may take a while) …"
    if compose exec -T agent sh -c "wget -q -T 2400 -O /dev/null --header \"Authorization: Bearer \$AGENT_TOKEN_WORKER\" --header 'Content-Type: application/json' --post-data '{\"runtime\":\"$rt\"}' http://127.0.0.1:9000/v1/images/ensure" >/dev/null 2>&1; then
      ok "Runtime image $rt ready"
    else
      warn "Runtime image $rt could not be prepared; it will be built when the first matching website is created (progress in the task log)."
    fi
  done
}

# ------------------------------------------------------------------------------ admin
valid_email() { [[ "$1" =~ ^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$ ]]; }

create_admin() {
  [[ $NO_ADMIN -eq 1 ]] && { info "Administrator creation skipped (--no-admin)."; return 0; }
  local count
  count="$(compose exec -T webmanager php bin/console admin:count 2>/dev/null | tr -d '[:space:]')" || count=""
  if [[ "$count" =~ ^[0-9]+$ && "$count" -gt 0 ]]; then
    ok "An administrator already exists – nothing to do."
    ADMIN_STATE="existing"
    return 0
  fi
  local email="$ADMIN_EMAIL" pw=""
  if [[ -n "$ADMIN_PASSWORD_FILE" ]]; then
    [[ -f "$ADMIN_PASSWORD_FILE" ]] || die "Password file not found: $ADMIN_PASSWORD_FILE"
    local mode; mode="$(stat -c '%a' "$ADMIN_PASSWORD_FILE")"
    [[ "$mode" =~ ^[0-7]00$ ]] || die "Password file $ADMIN_PASSWORD_FILE must have mode 0600 (or stricter) but has $mode."
    pw="$(head -n1 "$ADMIN_PASSWORD_FILE")"
  fi
  if [[ -t 0 && "$NON_INTERACTIVE" -eq 0 ]]; then
    info "Set up the first administrator:"
    local tries=0
    while :; do
      if [[ -z "$email" ]] || ! valid_email "$email"; then
        read -r -p "  Email address: " email || true
        valid_email "$email" || { warn "Invalid email address."; email=""; continue; }
      fi
      if [[ -z "$pw" ]]; then
        local pw2=""
        read -r -s -p "  Password (min. 12 characters, 3 character classes): " pw; echo
        read -r -s -p "  Repeat password: " pw2; echo
        [[ "$pw" == "$pw2" ]] || { warn "Passwords do not match."; pw=""; continue; }
      fi
      if printf '%s' "$pw" | compose exec -T webmanager php bin/console admin:create "$email"; then
        ADMIN_STATE="created ($email)"; break
      fi
      pw=""; tries=$((tries + 1))
      (( tries >= 5 )) && { warn "Too many failed attempts – no administrator will be created."; break; }
    done
  elif [[ -n "$email" && -n "$pw" ]]; then
    valid_email "$email" || die "Invalid administrator email: $email"
    printf '%s' "$pw" | compose exec -T webmanager php bin/console admin:create "$email"
    ADMIN_STATE="created ($email)"
  else
    warn "No administrator created (non-interactive without --admin-email and --admin-password-file)."
    ADMIN_STATE="not created – add one later with 'sudo $INSTALL_DIR/scripts/webmanager admin:create EMAIL'"
  fi
  pw=""
}

# ------------------------------------------------------------------------------ verification
HEALTH_FAIL=0
check_health() {
  info "Checking the health of all components …"
  if ! wait_healthy 240 db agent worker webmanager proxy; then
    HEALTH_FAIL=1
    err "Not all services became healthy in time."
  fi
  local s
  for s in db agent worker webmanager proxy; do
    local st; st="$(service_status "$s")"
    if [[ "$st" == "healthy" || "$st" == "running" ]]; then ok "$s: $st"; else err "$s: $st"; HEALTH_FAIL=1; fi
  done
  local i
  for i in 1 2 3 4 5 6 7 8 9 10; do
    if dashboard_probe; then
      ok "Dashboard answers through the reverse proxy"; return 0
    fi
    sleep 3
  done
  err "The dashboard does not answer through the reverse proxy."
  HEALTH_FAIL=1
}

configure_ufw() {
  [[ $CONFIGURE_UFW -eq 1 ]] || return 0
  have ufw || { warn "ufw not installed – firewall stays unchanged."; return 0; }
  if ufw status 2>/dev/null | grep -q '^Status: active'; then
    confirm "UFW is active. Open ports $HTTP_PORT/tcp and $HTTPS_PORT/tcp?" y || return 0
    ufw allow "$HTTP_PORT/tcp" comment 'WebManager HTTP' >/dev/null
    ufw allow "$HTTPS_PORT/tcp" comment 'WebManager HTTPS' >/dev/null
    ok "UFW rules added for $HTTP_PORT/tcp and $HTTPS_PORT/tcp (no other changes)."
  else
    info "UFW is not active – no change."
  fi
}

setup_backup_timer() {
  [[ $BACKUP_TIMER -eq 1 ]] || return 0
  have systemctl || { warn "systemd not available – backup timer skipped."; return 0; }
  local f
  for f in webmanager-backup.service webmanager-backup.timer; do
    backup_path "/etc/systemd/system/$f"
    sed "s#@INSTALL_DIR@#$INSTALL_DIR#g" "$INSTALL_DIR/scripts/systemd/$f" >"/etc/systemd/system/$f"
  done
  systemctl daemon-reload
  systemctl enable --now webmanager-backup.timer >/dev/null
  ok "Daily backup timer set up (systemctl list-timers webmanager-backup.timer)"
}

summary() {
  local ip scheme="http" dash https_state docker_state db_state proxy_state host
  ip="$(primary_ip)"
  local domain; domain="$(env_get DASHBOARD_DOMAIN || true)"
  local port; port="$(env_get HTTP_PORT)"
  host="${domain:-${ip:-SERVER-IP}}"
  [[ "$BIND_ADDRESS" == "127.0.0.1" ]] && host="127.0.0.1"
  dash="http://${host}"
  [[ "$port" != "80" ]] && dash="${dash}:${port}"
  if [[ -n "$domain" && -f "$DATA_DIR/letsencrypt/live/dashboard/fullchain.pem" ]]; then https_state="Certificate present (check the status in the dashboard)"
  else https_state="Not configured yet"; fi
  docker_state="$(docker version --format 'Active ({{.Server.Version}})' 2>/dev/null || echo 'Not reachable')"
  case "$(service_status db)" in healthy) db_state="Active" ;; *) db_state="Problem: $(service_status db)" ;; esac
  case "$(service_status proxy)" in healthy) proxy_state="Active" ;; *) proxy_state="Problem: $(service_status proxy)" ;; esac
  : "$scheme"
  echo
  echo "${C_BLD}══════════════════════════════════════════════════════════════${C_RST}"
  if [[ $HEALTH_FAIL -eq 0 ]]; then echo "${C_BLD}WebManager was installed.${C_RST}"
  else echo "${C_RED}${C_BLD}WebManager was installed, but not all checks were successful.${C_RST}"; fi
  echo
  echo "Version:        $WM_VERSION"
  echo "Dashboard:      $dash/"
  echo "HTTPS:          $https_state"
  echo "Docker:         $docker_state"
  echo "Database:       $db_state"
  echo "Reverse Proxy:  $proxy_state"
  echo "Administrator:  ${ADMIN_STATE:-unchanged}"
  echo
  echo "Application:    $INSTALL_DIR"
  echo "Data:           $DATA_DIR  (websites, certificates, backups)"
  echo "Log:            ${LOG_FILE:-$LOG_DIR}"
  echo
  if [[ -z "$domain" ]]; then
    echo "${C_YEL}The dashboard is currently reachable unencrypted by IP. Sign in,${C_RST}"
    echo "${C_YEL}set up a domain with HTTPS under “System & settings” and secure${C_RST}"
    echo "${C_YEL}the dashboard before it is used publicly.${C_RST}"
  fi
  if have ufw && ufw status 2>/dev/null | grep -q '^Status: active'; then
    echo "Note: UFW is active. Ports ${HTTP_PORT}/${HTTPS_PORT} must be open (see --configure-ufw; Docker bypasses UFW for published ports)."
  fi
  echo "${C_BLD}══════════════════════════════════════════════════════════════${C_RST}"
}

# ------------------------------------------------------------------------------ main
ADMIN_STATE=""
main() {
  require_root
  setup_logging install
  info "WebManager $WM_VERSION – Installation"
  [[ "$HTTP_PORT" =~ ^[0-9]+$ && "$HTTPS_PORT" =~ ^[0-9]+$ ]] || die "Invalid ports."
  [[ "$BIND_ADDRESS" =~ ^[0-9a-fA-F:.]+$ ]] || die "Invalid bind address."
  if [[ -n "$DOMAIN" ]]; then
    DOMAIN="${DOMAIN,,}"
    [[ "$DOMAIN" =~ ^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}$ ]] || die "Invalid domain: $DOMAIN"
  fi
  [[ "$INSTALL_DIR" == /* && "$DATA_DIR" == /* ]] || die "Installation and data directory must be absolute paths."
  [[ "$INSTALL_DIR" =~ ^[A-Za-z0-9._/-]+$ && "$DATA_DIR" =~ ^[A-Za-z0-9._/-]+$ ]] || die "Paths may only contain A-Z a-z 0-9 . _ / -"

  if [[ -f "$INSTALL_DIR/.env" ]]; then
    info "Existing installation found – data and secrets are kept."
    # use the stored layout so repeated runs without options cannot move data around
    DATA_DIR="$(env_get DATA_DIR || echo "$DATA_DIR")"
    LOG_DIR="$(env_get LOG_DIR || echo "$LOG_DIR")"
    HTTP_PORT="$(env_get HTTP_PORT || echo "$HTTP_PORT")"
    HTTPS_PORT="$(env_get HTTPS_PORT || echo "$HTTPS_PORT")"
    BIND_ADDRESS="$(env_get BIND_ADDRESS || echo "$BIND_ADDRESS")"
  fi

  detect_os
  check_arch
  check_resources
  ensure_docker
  check_ports
  create_dirs
  sync_sources
  write_env
  build_or_pull
  run_migrations
  start_stack
  check_health
  prebuild_php_runtime
  create_admin
  configure_ufw
  setup_backup_timer
  if [[ $HARDEN_EGRESS -eq 1 ]]; then "$INSTALL_DIR/scripts/egress-guard.sh" install || warn "The egress guard could not be set up."; fi
  "$INSTALL_DIR/scripts/backup-remote.sh" install || warn "The backup helper could not be set up."
  "$INSTALL_DIR/scripts/update-helper.sh" install || warn "The update helper could not be set up (updates still work with update.sh)."
  summary
  if [[ $HEALTH_FAIL -ne 0 ]]; then
    err "At least one component is not healthy. Logs: docker compose -f $INSTALL_DIR/docker-compose.yml logs --tail=100"
    exit 4
  fi
}

main
