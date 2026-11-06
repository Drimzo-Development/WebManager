#!/usr/bin/env bash
# Unit test for wait_healthy/diagnose_services/dashboard_probe in scripts/lib.sh with a simulated Docker (no Docker, no waiting).
set -Eeuo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
# shellcheck source=../scripts/lib.sh
source "$ROOT/scripts/lib.sh"
INSTALL_DIR="/opt/x"
fail=0
check() { if [[ "$2" == "$3" ]]; then echo "  PASS  $1"; else echo "  FAIL  $1 (expected '$3', got '$2')"; fail=1; fi; }

# State lives in files: the functions under test run inside command substitutions (subshells).
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
echo 1000000 >"$T/now"
# simulated clock: every date +%s call advances 10 s; sleep does nothing
date() { if [[ "$*" == "+%s" ]]; then local n; n=$(( $(<"$T/now") + 10 )); echo "$n" >"$T/now"; echo "$n"; else command date "$@"; fi; }
sleep() { :; }
# simulated compose/docker: SEQ[service]="state,state,..." is consumed one entry per query, the last one repeats
declare -A SEQ
compose() {
  case "$1" in
    ps) echo "cid-${*: -1}" ;;
    logs) echo "log-of-$*" ;;
    exec) if [[ "${PROBE:-ok}" == "ok" ]]; then echo ok; else echo broken; fi ;;
  esac
}
docker() {
  [[ "$1" == "inspect" ]] || return 0
  local svc="${*: -1}"; svc="${svc#cid-}"
  if [[ "$*" == *Health.Log* ]]; then echo "  Health check: wget: timeout"; return; fi
  IFS=, read -ra seq <<<"${SEQ[$svc]}"
  local i=0; [[ -f "$T/pos-$svc" ]] && i="$(<"$T/pos-$svc")"
  if (( i < ${#seq[@]} )); then echo "${seq[$i]}"; else echo "${seq[-1]}"; fi
  echo $((i + 1)) >"$T/pos-$svc"
}
reset() { rm -f "$T"/pos-*; }

SEQ=([db]="healthy" [agent]="starting,starting,healthy"); reset
wait_healthy 240 db agent >/dev/null 2>&1; check "Start across 'starting' is waited for" "$?" "0"

SEQ=([db]="healthy" [worker]="exited,exited,restarting,running"); reset
wait_healthy 240 db worker >/dev/null 2>&1; check "Briefly 'exited' (restart by Docker) does not abort" "$?" "0"

SEQ=([worker]="exited"); reset
rc=0; out="$(wait_healthy 240 worker 2>&1)" || rc=$?
check "Permanently exited service → return value 2" "$rc" "2"
check "… with diagnosis (status, health output, log)" "$(grep -c 'not ready\|Health check\|log-of' <<<"$out")" "3"

SEQ=([agent]="unhealthy"); reset
rc=0; out="$(wait_healthy 60 agent 2>&1)" || rc=$?
check "Permanently 'unhealthy' → timeout (1) with diagnosis" "$rc:$(grep -c 'unhealthy' <<<"$out")" "1:1"

PROBE=ok; dashboard_probe && r=yes || r=no; check "Dashboard probe successful" "$r" "yes"
PROBE=bad; dashboard_probe && r=yes || r=no; check "Dashboard probe fails on a wrong answer" "$r" "no"
grep -q 'http://webmanager:8080/healthz' "$ROOT/scripts/lib.sh" && r=yes || r=no
check "Probe goes directly to the dashboard container (no detour via domain/HTTPS)" "$r" "yes"
exit "$fail"
