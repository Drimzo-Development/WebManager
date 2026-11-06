#!/usr/bin/env bash
# Optional host firewall hardening: website containers may no longer reach the Docker host itself, the cloud metadata
# service or other link-local addresses (and, on request, private networks). Internet access (npm, APIs, e-mail) stays.
#
#   egress-guard.sh install     rules + systemd unit (re-applied after every Docker start)
#   egress-guard.sh apply       (re)create the rules now
#   egress-guard.sh remove      take the rules out again
#   egress-guard.sh uninstall   remove rules and unit
#   egress-guard.sh status      show the rules
#
# Only traffic whose source is the website network pool (SITE_NET_POOL, default 10.210.0.0/16) is matched; everything else on
# the host is untouched. .env: EGRESS_BLOCK_PRIVATE=1 additionally blocks RFC 1918 networks (LAN) for websites.
# EGRESS_DRY_RUN=1 prints the commands instead of running them.
set -Eeuo pipefail
IFS=$'\n\t'

SELF="$(readlink -f -- "${BASH_SOURCE[0]}")"
INSTALL_DIR="${WM_INSTALL_DIR:-$(dirname -- "$(dirname -- "$SELF")")}"
# shellcheck source=lib.sh
source "$INSTALL_DIR/scripts/lib.sh"

UNIT=webmanager-egress.service
IN_CHAIN=WM-EGRESS-IN
FWD_CHAIN=WM-EGRESS-FWD

ipt() {
  local IFS=" "
  if [[ "${EGRESS_DRY_RUN:-0}" == "1" ]]; then printf 'iptables %s\n' "$*"; else iptables -w 5 "$@"; fi
}

pool_cidr() {
  local pool; pool="$(env_get SITE_NET_POOL 2>/dev/null || true)"; pool="${pool:-10.210}"
  [[ "$pool" =~ ^[0-9]{1,3}\.[0-9]{1,3}$ ]] || die "SITE_NET_POOL '$pool' is invalid (expected e.g. 10.210)."
  printf '%s.0.0/16' "$pool"
}

flush_chain() { # flush_chain TABLE-CHAIN PARENT  (removes the jump, empties and deletes the chain; idempotent)
  local chain="$1" parent="$2"
  [[ "${EGRESS_DRY_RUN:-0}" == "1" ]] || { iptables -w 5 -S "$chain" >/dev/null 2>&1 || return 0; }
  while [[ "${EGRESS_DRY_RUN:-0}" != "1" ]] && iptables -w 5 -C "$parent" -s "${POOL:?}" -j "$chain" 2>/dev/null; do ipt -D "$parent" -s "$POOL" -j "$chain"; done
  ipt -F "$chain"
  ipt -X "$chain"
}

remove_rules() {
  POOL="$(pool_cidr)"
  flush_chain "$IN_CHAIN" INPUT
  flush_chain "$FWD_CHAIN" DOCKER-USER
}

apply_rules() {
  have iptables || [[ "${EGRESS_DRY_RUN:-0}" == "1" ]] || die "iptables is required (Debian/Ubuntu: apt-get install iptables)."
  POOL="$(pool_cidr)"
  remove_rules

  # website -> the host itself (gateway address, public IP, local services such as SSH or the dashboard ports)
  ipt -N "$IN_CHAIN"
  ipt -A "$IN_CHAIN" -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
  ipt -A "$IN_CHAIN" -j DROP
  ipt -I INPUT 1 -s "$POOL" -j "$IN_CHAIN"

  # website -> metadata service / link-local (and optionally the local network), forwarded traffic
  [[ "${EGRESS_DRY_RUN:-0}" == "1" ]] || iptables -w 5 -S DOCKER-USER >/dev/null 2>&1 || die "The DOCKER-USER chain is missing – is Docker running?"
  ipt -N "$FWD_CHAIN"
  ipt -A "$FWD_CHAIN" -d 169.254.0.0/16 -j DROP
  if [[ "$(env_get EGRESS_BLOCK_PRIVATE 2>/dev/null || true)" == "1" ]]; then
    ipt -A "$FWD_CHAIN" -d "$POOL" -j RETURN
    ipt -A "$FWD_CHAIN" -d 10.0.0.0/8 -j DROP
    ipt -A "$FWD_CHAIN" -d 172.16.0.0/12 -j DROP
    ipt -A "$FWD_CHAIN" -d 192.168.0.0/16 -j DROP
  fi
  ipt -A "$FWD_CHAIN" -j RETURN
  ipt -I DOCKER-USER 1 -s "$POOL" -j "$FWD_CHAIN"
  ok "Egress guard active for $POOL (host, metadata service${EGRESS_DRY_RUN:+, dry run})"
}

install_unit() {
  require_root
  have systemctl && [[ -d /run/systemd/system ]] || die "systemd is required so that the rules are set again after every Docker start."
  sed "s#@INSTALL_DIR@#$INSTALL_DIR#g" "$INSTALL_DIR/scripts/systemd/$UNIT" >"/etc/systemd/system/$UNIT"
  systemctl daemon-reload
  systemctl enable "$UNIT" >/dev/null
  systemctl restart "$UNIT"
  ok "Egress guard set up (systemctl status $UNIT)"
}

main() {
  case "${1:-}" in
    apply) [[ "${EGRESS_DRY_RUN:-0}" == "1" ]] || require_root; apply_rules ;;
    remove) require_root; remove_rules; ok "Egress guard removed" ;;
    install) install_unit ;;
    uninstall)
      require_root
      if have systemctl; then systemctl disable --now "$UNIT" >/dev/null 2>&1 || true; rm -f "/etc/systemd/system/$UNIT"; systemctl daemon-reload || true; fi
      remove_rules; ok "Egress guard and service removed" ;;
    status) iptables -w 5 -S "$IN_CHAIN" 2>/dev/null || echo "inaktiv"; iptables -w 5 -S "$FWD_CHAIN" 2>/dev/null || true ;;
    *) die "Verwendung: egress-guard.sh install|apply|remove|uninstall|status" ;;
  esac
}
main "$@"
