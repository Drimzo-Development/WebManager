#!/usr/bin/env bash
# Smoke test of the newer features against a running WebManager (a test server, not production):
# language files, metrics endpoint, application templates, maintenance windows and the DNS provider settings.
#
#   WM_EMAIL=admin@example.com WM_PASSWORD=... [WM_TOKEN=wmt_...] tests/server-smoke.sh https://panel.example.com
#
#   WM_EMAIL / WM_PASSWORD   administrator without two-factor sign-in (a test account); without them the session checks are skipped
#   WM_TOKEN                 API token (viewer is enough) for the metrics checks; without it only "no token -> 401" is tested
#   WM_INSECURE=1            accept a self-signed certificate (curl -k)
#   WM_DNS_PROVIDER, WM_DNS_TOKEN   (cloudflare|hetzner) also connects the DNS provider and tests the token; this CHANGES the setting
#
# Needs curl. What it creates (a maintenance window) it deletes again; nothing else is changed unless WM_DNS_* is set.
set -u

BASE="${1:-}"
[ -n "$BASE" ] || { echo "usage: $0 <https://panel.example.com>"; exit 2; }
BASE="${BASE%/}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
PASS=0; FAIL=0; SKIP=0
CURL=(curl -s --max-time 30)
[ "${WM_INSECURE:-}" = "1" ] && CURL+=(-k)

check() { # check <label> <command...>
  local label="$1"; shift
  if "$@" >/dev/null 2>&1; then PASS=$((PASS + 1)); echo "  PASS  $label"; else FAIL=$((FAIL + 1)); echo "  FAIL  $label"; fi
}
skip() { SKIP=$((SKIP + 1)); echo "  SKIP  $1"; }
eq() { [ "$1" = "$2" ]; }
has() { case "$1" in *"$2"*) return 0 ;; *) return 1 ;; esac; }
hasnt() { ! has "$1" "$2"; }

# http <jar|-> <method> <path> [json] [extra curl args...] -> CODE, BODY, HDR
http() {
  local jar="$1" method="$2" path="$3" data="${4:-}"; shift 4 2>/dev/null || shift $#
  local args=(-o "$TMP/body" -D "$TMP/hdr" -w '%{http_code}' -X "$method")
  [ "$jar" != "-" ] && args+=(-b "$jar" -c "$jar" -H "X-CSRF-Token: ${CSRF:-}")
  [ -n "$data" ] && args+=(-H 'Content-Type: application/json' --data "$data")
  CODE="$("${CURL[@]}" "${args[@]}" "$@" "$BASE$path")"
  BODY="$(cat "$TMP/body")"; HDR="$(cat "$TMP/hdr")"
}
field() { printf '%s' "$BODY" | sed -n "s/.*\"$1\":\"\{0,1\}\([^\",}]*\).*/\1/p" | head -1; }

echo "== Reachability"
http - GET /healthz; check "GET /healthz -> 200" eq "$CODE" 200
http - GET /api/auth/state; check "GET /api/auth/state -> 200" eq "$CODE" 200

echo "== Languages (public)"
http - GET /api/lang; check "GET /api/lang -> 200" eq "$CODE" 200
check "  offers German" has "$BODY" '"code":"de"'
http - GET /api/lang/de; check "GET /api/lang/de -> 200" eq "$CODE" 200
check "  contains translations" has "$BODY" '"Save":"Speichern"'
check "  locale de-DE" has "$BODY" '"locale":"de-DE"'
for bad in 'DE' 'xx' '..%2fde' 'de.json' '%2e%2e%2f%2e%2e%2fetc%2fpasswd'; do
  http - GET "/api/lang/$bad"; check "GET /api/lang/$bad is refused (404)" eq "$CODE" 404
done
http - GET /lang/de.json; check "No other path serves the files (/lang/de.json is not public)" bash -c "[[ $CODE != 200 ]]"

echo "== Metrics"
http - GET /api/v1/metrics; check "Without a token -> 401" eq "$CODE" 401
if [ -n "${WM_TOKEN:-}" ]; then
  http - GET /api/v1/metrics '' -H "Authorization: Bearer $WM_TOKEN"
  check "With a token -> 200" eq "$CODE" 200
  check "  text/plain (Prometheus format)" has "$HDR" 'text/plain; version=0.0.4'
  check "  webmanager_info and webmanager_agent_up" bash -c "[[ '$BODY' == *'# TYPE webmanager_info gauge'* && '$BODY' == *'webmanager_agent_up '* ]]"
  check "  the agent is reachable (webmanager_agent_up 1)" has "$BODY" 'webmanager_agent_up 1'
  BAD="$(printf '%s\n' "$BODY" | grep -v '^#' | grep -v '^$' | grep -Ev '^[a-zA-Z_:][a-zA-Z0-9_:]*(\{([a-zA-Z_][a-zA-Z0-9_]*="([^"\\]|\\.)*",?)*\})? -?[0-9][0-9.eE+-]*$' | head -3)"
  check "  every sample line is valid exposition format" eq "$BAD" ""
  echo "$BODY" > "$TMP/metrics.txt"
  echo "        $(grep -c '^webmanager_site_info' "$TMP/metrics.txt") website(s) in the metrics; sample:"; grep -m3 '^webmanager_site_' "$TMP/metrics.txt" | sed 's/^/        /'
  http - POST /api/v1/metrics '' -H "Authorization: Bearer $WM_TOKEN"; check "POST /api/v1/metrics is not allowed" bash -c "[[ $CODE == 404 || $CODE == 405 ]]"
else
  skip "metrics with a token (set WM_TOKEN)"
fi

if [ -z "${WM_EMAIL:-}" ] || [ -z "${WM_PASSWORD:-}" ]; then
  echo "== Session checks"
  skip "application templates, maintenance windows, DNS provider (set WM_EMAIL and WM_PASSWORD of a test administrator)"
else
  echo "== Sign-in"
  JAR="$TMP/jar"; : >"$JAR"; CSRF=""
  CSRF="$("${CURL[@]}" -c "$JAR" -b "$JAR" "$BASE/api/auth/state" | sed -n 's/.*"csrf":"\([^"]*\)".*/\1/p' | head -1)"
  LOGIN="$(printf '{"email":"%s","password":"%s"}' "$WM_EMAIL" "$WM_PASSWORD")"
  http "$JAR" POST /api/auth/login "$LOGIN"
  if has "$BODY" '"pending_2fa":{' ; then
    skip "this account has two-factor sign-in; use a test administrator without it"
  else
    check "Sign-in works" has "$BODY" '"authenticated":true'
    http "$JAR" GET /api/v1/me; CSRF="$(field csrf)"
    check "  role administrator" has "$BODY" '"role":"admin"'

    echo "== Application templates"
    http "$JAR" GET /api/apps; check "GET /api/apps -> 200" eq "$CODE" 200
    for a in wordpress joomla nextcloud matomo grav; do check "  template $a is offered" has "$BODY" "\"key\":\"$a\""; done

    echo "== Maintenance windows"
    http "$JAR" GET /api/maintenance; check "GET /api/maintenance -> 200" eq "$CODE" 200
    NOW=$(date -u +%s)
    iso() { date -u -d "@$1" +%Y-%m-%dT%H:%M:%SZ; }
    # a window for all websites that runs from 1 minute ago to 3 minutes ahead (mutes notifications for that time)
    http "$JAR" POST /api/maintenance "{\"title\":\"smoke test\",\"site_id\":null,\"starts_at\":\"$(iso $((NOW - 60)))\",\"ends_at\":\"$(iso $((NOW + 180)))\",\"repeat\":\"none\"}"
    check "Creating a window -> 201" eq "$CODE" 201
    WID="$(field id)"
    http "$JAR" GET /api/maintenance
    check "  it is listed and running" bash -c "[[ '$BODY' == *'\"title\":\"smoke test\"'* && '$BODY' == *'\"active\":true'* ]]"
    http "$JAR" POST /api/maintenance "{\"title\":\"x\",\"starts_at\":\"$(iso $((NOW + 600)))\",\"ends_at\":\"$(iso $((NOW + 300)))\",\"repeat\":\"none\"}"
    check "An end before the start -> 422" eq "$CODE" 422
    http "$JAR" POST /api/maintenance "{\"title\":\"x\",\"starts_at\":\"$(iso $((NOW + 60)))\",\"ends_at\":\"$(iso $((NOW + 90000)))\",\"repeat\":\"daily\"}"
    check "A repeating window longer than its repetition -> 422" eq "$CODE" 422
    http "$JAR" POST /api/maintenance "{\"title\":\"x\",\"site_id\":99999,\"starts_at\":\"$(iso $((NOW + 60)))\",\"ends_at\":\"$(iso $((NOW + 600)))\",\"repeat\":\"none\"}"
    check "An unknown website -> 404 or 422" bash -c "[[ $CODE == 404 || $CODE == 422 ]]"
    if [ -n "$WID" ]; then
      http "$JAR" DELETE "/api/maintenance/$WID"; check "Deleting the window -> 200" eq "$CODE" 200
      http "$JAR" GET /api/maintenance; check "  it is gone" hasnt "$BODY" '"title":"smoke test"'
    else
      skip "delete (no id returned)"
    fi

    echo "== DNS provider"
    http "$JAR" GET /api/dns; check "GET /api/dns -> 200" eq "$CODE" 200
    check "  lists Cloudflare and Hetzner" bash -c "[[ '$BODY' == *'cloudflare'* && '$BODY' == *'hetzner'* ]]"
    check "  never contains a token" hasnt "$BODY" '"token"'
    http "$JAR" PUT /api/dns '{"provider":"route53","token":"abcdefgh12345678"}'; check "An unknown provider -> 422" eq "$CODE" 422
    http "$JAR" PUT /api/dns '{"provider":"cloudflare","token":"short"}'; check "A too short token -> 422" eq "$CODE" 422
    if [ -n "${WM_DNS_PROVIDER:-}" ] && [ -n "${WM_DNS_TOKEN:-}" ]; then
      http "$JAR" PUT /api/dns "$(printf '{"provider":"%s","token":"%s"}' "$WM_DNS_PROVIDER" "$WM_DNS_TOKEN")"
      check "Connecting the provider -> a task is queued" has "$BODY" '"job"'
      JOB="$(field job)"; STATUS=""
      for _ in $(seq 1 45); do
        http "$JAR" GET "/api/jobs/$JOB"; STATUS="$(printf '%s' "$BODY" | sed -n 's/.*"status":"\([a-z]*\)".*/\1/p' | head -1)"
        case "$STATUS" in succeeded|failed|cancelled) break ;; esac; sleep 2
      done
      check "  the token test task succeeded (status: $STATUS)" eq "$STATUS" succeeded
      http "$JAR" GET "/api/jobs/$JOB/logs?after=0"; echo "$BODY" | sed 's/\\n/\n/g' | grep -i "zone" | head -3 | sed 's/^/        /'
      http "$JAR" GET /api/dns; check "  /api/dns reports the provider as connected" has "$BODY" '"configured":true'
    else
      skip "connecting a real provider (set WM_DNS_PROVIDER and WM_DNS_TOKEN)"
    fi
    http "$JAR" POST /api/auth/logout; 
  fi
fi

echo
echo "Result: $PASS passed, $FAIL failed, $SKIP skipped"
[ "$FAIL" -eq 0 ]
