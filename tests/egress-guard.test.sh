#!/usr/bin/env bash
# Unit test for scripts/egress-guard.sh in dry-run mode (prints the iptables commands; needs neither root nor iptables).
set -Eeuo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
fail=0
check() { if [[ "$2" == "$3" ]]; then echo "  PASS  $1"; else echo "  FAIL  $1 (expected '$3', got '$2')"; fail=1; fi; }
has() { printf '%s\n' "$OUT" | grep -Fxq -- "$1" && echo yes || echo no; }

mkdir -p "$T/inst/scripts"
cp "$ROOT/scripts/lib.sh" "$ROOT/scripts/egress-guard.sh" "$T/inst/scripts/"
export WM_INSTALL_DIR="$T/inst" EGRESS_DRY_RUN=1
run() { OUT="$(bash "$T/inst/scripts/egress-guard.sh" apply 2>&1)"; }

printf 'SITE_NET_POOL=10.77\n' >"$T/inst/.env"; run
check "Pool from the .env is used" "$(has 'iptables -I INPUT 1 -s 10.77.0.0/16 -j WM-EGRESS-IN')" "yes"
check "Answers to existing connections stay allowed" "$(has 'iptables -A WM-EGRESS-IN -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN')" "yes"
check "New connections to the host are dropped" "$(has 'iptables -A WM-EGRESS-IN -j DROP')" "yes"
check "Metadata/link-local addresses are blocked" "$(has 'iptables -A WM-EGRESS-FWD -d 169.254.0.0/16 -j DROP')" "yes"
check "Internet stays reachable (chain ends with RETURN)" "$(has 'iptables -A WM-EGRESS-FWD -j RETURN')" "yes"
check "By default no blocking of private networks" "$(has 'iptables -A WM-EGRESS-FWD -d 192.168.0.0/16 -j DROP')" "no"
check "Rules are removed before being rebuilt (idempotent)" "$(has 'iptables -X WM-EGRESS-IN')" "yes"

printf 'SITE_NET_POOL=10.77\nEGRESS_BLOCK_PRIVATE=1\n' >"$T/inst/.env"; run
check "Optional: private networks blocked" "$(has 'iptables -A WM-EGRESS-FWD -d 192.168.0.0/16 -j DROP')" "yes"
check "Optional: the own website network stays allowed" "$(has 'iptables -A WM-EGRESS-FWD -d 10.77.0.0/16 -j RETURN')" "yes"

printf 'SITE_NET_POOL=10.77;reboot\n' >"$T/inst/.env"
check "Invalid pool is rejected" "$(bash "$T/inst/scripts/egress-guard.sh" apply >/dev/null 2>&1 && echo ok || echo rejected)" "rejected"
exit "$fail"
