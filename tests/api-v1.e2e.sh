#!/usr/bin/env bash
# End-to-end test of API tokens and /api/v1 against the real dashboard image and a real MariaDB (needs Docker, curl, python3-free).
#   tests/api-v1.e2e.sh [image]      default image: wm-e2e (built from docker/webmanager/Dockerfile when missing)
# No agent is started: calls that need it answer with agent_error, which is fine for authentication and permission checks.
set -u
cd "$(dirname "$0")/.."

IMAGE="${1:-wm-e2e}"
NET="wm-e2e-net-$$"
DB="wm-e2e-db-$$"
WEB="wm-e2e-web-$$"
PORT="${E2E_PORT:-18080}"
BASE="http://127.0.0.1:$PORT"
TMP="$(mktemp -d)"
FAIL=0
PASS=0

cleanup() {
  docker rm -f "$WEB" "$DB" >/dev/null 2>&1
  docker network rm "$NET" >/dev/null 2>&1
  rm -rf "$TMP"
}
trap cleanup EXIT

check() { # check <label> <command...>: passes when the command succeeds
  local label="$1"; shift
  if "$@" >/dev/null 2>&1; then PASS=$((PASS + 1)); echo "  PASS  $label"; else FAIL=$((FAIL + 1)); echo "  FAIL  $label"; fi
}
eq() { [ "$1" = "$2" ]; }
has() { case "$1" in *"$2"*) return 0 ;; *) return 1 ;; esac; }
hasnt() { ! has "$1" "$2"; }

# http <cookiejar|-> <method> <path> [data] [extra curl args...] -> sets CODE, BODY, HDR
http() {
  local jar="$1" method="$2" path="$3" data="${4:-}"; shift 4 2>/dev/null || shift $#
  local args=(-s -o "$TMP/body" -D "$TMP/hdr" -w '%{http_code}' -X "$method")
  [ "$jar" != "-" ] && args+=(-b "$jar" -c "$jar")
  [ -n "$data" ] && args+=(-H 'Content-Type: application/json' --data "$data")
  CODE="$(curl "${args[@]}" "$@" "$BASE$path")"
  BODY="$(cat "$TMP/body")"
  HDR="$(cat "$TMP/hdr")"
}
json() { # json <field> from BODY (flat, string or number values)
  printf '%s' "$BODY" | sed -n "s/.*\"$1\":\"\{0,1\}\([^\",}]*\).*/\1/p" | head -1
}
sql() { docker exec -i "$DB" mariadb -uwm -ppw wm -N -e "$1" 2>/dev/null; }

echo "== Environment"
docker image inspect "$IMAGE" >/dev/null 2>&1 || docker build -q -f docker/webmanager/Dockerfile -t "$IMAGE" . >/dev/null || { echo "Image could not be built"; exit 2; }
docker network create "$NET" >/dev/null
docker run -d --name "$DB" --network "$NET" -e MARIADB_DATABASE=wm -e MARIADB_USER=wm -e MARIADB_PASSWORD=pw -e MARIADB_ROOT_PASSWORD=root mariadb:11.4.13 >/dev/null
for _ in $(seq 1 60); do sql 'SELECT 1' | grep -q 1 && break; sleep 2; done
ENVS=(-e DB_HOST="$DB" -e DB_NAME=wm -e DB_USER=wm -e DB_PASSWORD=pw -e APP_KEY="$(printf 'ab%.0s' $(seq 1 32))" -e AGENT_URL=http://127.0.0.1:1 -e AGENT_TOKEN_DASHBOARD=x)
docker run --rm --network "$NET" "${ENVS[@]}" "$IMAGE" php bin/console migrate >/dev/null || { echo "Migration failed"; exit 2; }
PWD1='Test-Password-2026!'
printf '%s' "$PWD1" | docker run --rm -i --network "$NET" "${ENVS[@]}" "$IMAGE" php bin/console admin:create admin@example.com >/dev/null || { echo "Creating the admin failed"; exit 2; }
HASH="$(docker run --rm "$IMAGE" php -r 'echo password_hash("Test-Password-2026!", PASSWORD_ARGON2ID);')"
sql "INSERT INTO users (email, name, password_hash, role) VALUES ('viewer@example.com','V','$HASH','viewer')"
docker run -d --name "$WEB" --network "$NET" -p "127.0.0.1:$PORT:8080" "${ENVS[@]}" "$IMAGE" >/dev/null
for _ in $(seq 1 40); do curl -sf "$BASE/healthz" >/dev/null && break; sleep 1; done
curl -sf "$BASE/healthz" >/dev/null || { echo "Dashboard does not start"; docker logs "$WEB" | tail; exit 2; }

login() { # login <jar> <email> : JSON sign-in (POST /api/auth/login) with the CSRF token of the session
  local jar="$1" email="$2" csrf
  csrf="$(curl -s -c "$jar" -b "$jar" "$BASE/api/auth/state" | sed -n 's/.*"csrf":"\([^"]*\)".*/\1/p' | head -1)"
  curl -s -o /dev/null -c "$jar" -b "$jar" -H 'Content-Type: application/json' -H "X-CSRF-Token: $csrf"     --data "{\"email\":\"$email\",\"password\":\"$PWD1\"}" "$BASE/api/auth/login"
}

echo "== Without sign-in"
http - GET /api/v1/me; check "GET /api/v1/me without sign-in -> 401" eq "$CODE" 401
http - GET /api/v1/me '' -H 'Authorization: Bearer wmt_00000000_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
check "Unknown token -> 401 with WWW-Authenticate" eq "$CODE" 401; check "  Header WWW-Authenticate: Bearer" has "$HDR" 'WWW-Authenticate: Bearer'
http - GET /api/v1/me '' -H 'Authorization: Bearer junk'; check "No valid token format -> 401" eq "$CODE" 401
http - GET /app; check "GET /app without sign-in -> 200 (the shell shows the sign-in itself)" eq "$CODE" 200; check "  contains no data, only #root" has "$BODY" '<div id="root">'

echo "== Start page and old sign-in URLs point to the app"
loc() { printf '%s' "$HDR" | grep -i '^location:' | tr -d '' | awk '{print $2}'; }
http - GET /; check "GET / without sign-in -> 302" eq "$CODE" 302; check "  target is /app (the shell shows the sign-in itself)" eq "$(loc)" "/app"
http - GET /login; check "GET /login -> 302 to /app" bash -c "[[ $CODE == 302 && '$(loc)' == '/app' ]]"
http - GET /login/2fa; check "GET /login/2fa -> 302 to /app" bash -c "[[ $CODE == 302 && '$(loc)' == '/app' ]]"
http - GET /classic; check "The old interface is gone -> 404" eq "$CODE" 404
check "Without sign-in every redirect ends on /app with 200 (no loop)" bash -c "[[ \$(curl -s -o /dev/null -L --max-redirs 5 -w '%{http_code} %{url_effective}' '$BASE/') == \"200 $BASE/app\" ]]"
KJ="$TMP/start.jar"; : >"$KJ"; login "$KJ" admin@example.com
http "$KJ" GET /api/v1/me; check "  signed in after the JSON sign-in" eq "$CODE" 200
http "$KJ" GET /; check "Signed in: GET / -> 302 to /app" bash -c "[[ $CODE == 302 && '$(loc)' == '/app' ]]"
http "$KJ" GET /api/auth/state; KCS="$(json csrf)"
http "$KJ" POST /logout '' --data-urlencode "_csrf=wrong"; check "Sign-out with an invalid CSRF token -> 403" eq "$CODE" 403
http "$KJ" POST /logout '' --data-urlencode "_csrf=$KCS"; check "Sign-out -> 302 to /app" bash -c "[[ $CODE == 302 && '$(loc)' == '/app' ]]"
http "$KJ" GET /api/v1/me; check "  afterwards no longer signed in -> 401" eq "$CODE" 401
http "$KJ" GET /app; check "  /app shows the sign-in again (shell, 200)" bash -c "[[ $CODE == 200 && '$BODY' == *'<div id=\"root\">'* ]]"
http "$KJ" GET /api/auth/state; check "  sign-in state: not signed in, fresh CSRF token" bash -c "[[ '$BODY' == *'\"authenticated\":false'* ]]"

echo "== Admin session"
JAR="$TMP/admin.jar"; login "$JAR" admin@example.com
http "$JAR" GET /api/v1/me; check "GET /api/v1/me with session -> 200" eq "$CODE" 200
check "  auth=session" has "$BODY" '"auth":"session"'; CSRF="$(json csrf)"; check "  csrf present (64 characters)" eq "${#CSRF}" 64
check "  brand.logo is a reachable address (default logo, no /brand/logo 404)" bash -c "[[ '$BODY' == *'\"logo\":\"/assets/logo.png\"'* ]]"
http "$JAR" GET /app; check "GET /app -> 200" eq "$CODE" 200
check "  Shell with #root and app.js" has "$BODY" 'src="/assets/app/app.js?v='; http - GET /assets/app/app.js; check "  /assets/app/app.js is delivered" eq "$CODE" 200
http "$JAR" POST /api/v1/sites/1/action '{"action":"restart"}'; check "POST with session without CSRF token -> 403" eq "$CODE" 403
http "$JAR" POST /api/account/tokens '{"name":"x"}' -H "X-CSRF-Token: wrong"; check "POST with a wrong CSRF token -> 403" eq "$CODE" 403

mk() { # mk <jar> <csrf> <json> -> TOKEN
  http "$1" POST /api/account/tokens "$3" -H "X-CSRF-Token: $2"; TOKEN="$(json token)"; MKCODE="$CODE"
}
echo "== Create and use a token"
mk "$JAR" "$CSRF" '{"name":"Admin-Token","role":"admin","expires_days":30}'
check "Token created -> 201" eq "$MKCODE" 201
check "  Format wmt_<8>_<43>" bash -c "[[ '$TOKEN' =~ ^wmt_[0-9a-f]{8}_[A-Za-z0-9_-]{43}\$ ]]"
SECRET="${TOKEN##*_}"
check "  Secret is not in the database" bash -c "! docker exec -i $DB mariadb -uwm -ppw wm -N -e 'SELECT CONCAT_WS(\" \",name,prefix,token_hash,ip_allow) FROM api_tokens' 2>/dev/null | grep -q '$SECRET'"
check "  Audit log without secret" bash -c "! docker exec -i $DB mariadb -uwm -ppw wm -N -e 'SELECT details FROM audit_log' 2>/dev/null | grep -q '$SECRET'"
AUTH=(-H "Authorization: Bearer $TOKEN")
http - GET /api/v1/me '' "${AUTH[@]}"; check "Bearer GET /api/v1/me -> 200" eq "$CODE" 200
check "  auth=token, csrf=null, role admin" bash -c "[[ '$BODY' == *'\"auth\":\"token\"'* && '$BODY' == *'\"csrf\":null'* && '$BODY' == *'\"role\":\"admin\"'* ]]"
check "  sets no cookie (no session)" hasnt "$HDR" 'Set-Cookie'
http - GET /api/v1/sites '' "${AUTH[@]}"; check "Bearer GET /api/v1/sites -> 200" eq "$CODE" 200; check "  Answer has sites[] (agent without connection -> agent_error)" has "$BODY" '"sites":[]'
http - POST /api/v1/sites/1/action '{"action":"restart"}' "${AUTH[@]}"; check "Bearer POST without CSRF token is not rejected as CSRF (-> 404 website missing)" eq "$CODE" 404
http - GET /api/v1/jobs '' "${AUTH[@]}"; check "Bearer GET /api/v1/jobs -> 200" eq "$CODE" 200

echo "== What a token may not do"
for p in "GET /api/v1/users" "GET /api/v1/audit" "GET /api/v1/account/tokens" "POST /api/v1/sites" "DELETE /api/v1/sites/1" "GET /api/v1/sites/1/env" "GET /api/v1/sites/1/files"; do
  http - "${p%% *}" "${p#* }" '' "${AUTH[@]}"; check "$p -> 404 (not in the allowlist)" eq "$CODE" 404
done
for p in "GET /api/users" "GET /api/sites/1" "GET /api/account/tokens" "GET /api/overview" "GET /"; do
  http - "${p%% *}" "${p#* }" '' "${AUTH[@]}"; check "Bearer is ignored outside /api/v1: $p -> 401/302" bash -c "[[ $CODE == 401 || $CODE == 302 ]]"
done
http - POST /api/account/tokens '{"name":"Kette","role":"viewer"}' "${AUTH[@]}"; check "A token cannot create a token -> 401" eq "$CODE" 401

echo "== Permission limit (token never more powerful than the role)"
mk "$JAR" "$CSRF" '{"name":"nur lesen","role":"viewer","expires_days":30}'; VTOKEN="$TOKEN"
http - POST /api/v1/sites/1/action '{"action":"restart"}' -H "Authorization: Bearer $VTOKEN"; check "viewer-Token: POST action -> 403" eq "$CODE" 403
http - GET /api/v1/sites '' -H "Authorization: Bearer $VTOKEN"; check "viewer-Token: GET sites -> 200" eq "$CODE" 200
VJAR="$TMP/viewer.jar"; login "$VJAR" viewer@example.com; http "$VJAR" GET /api/v1/me; VCSRF="$(json csrf)"
mk "$VJAR" "$VCSRF" '{"name":"zu viel","role":"admin","expires_days":30}'; check "Viewer requests an admin token -> 403" eq "$MKCODE" 403
mk "$VJAR" "$VCSRF" '{"name":"ok","role":"viewer","expires_days":30}'; check "Viewer creates a viewer token -> 201" eq "$MKCODE" 201
mk "$JAR" "$CSRF" '{"name":"","role":"viewer"}'; check "Empty name -> 422" eq "$MKCODE" 422
mk "$JAR" "$CSRF" '{"name":"x","role":"root"}'; check "Unknown role -> 422" eq "$MKCODE" 422
mk "$JAR" "$CSRF" '{"name":"x","role":"viewer","expires_days":366}'; check "366 days -> 422" eq "$MKCODE" 422
mk "$JAR" "$CSRF" '{"name":"x","role":"viewer","expires_days":0}'; check "0 days -> 422" eq "$MKCODE" 422
mk "$JAR" "$CSRF" '{"name":"x","role":"viewer","expires_days":30,"ip_allow":"10.0.0.0/33"}'; check "Invalid IP list -> 422" eq "$MKCODE" 422

echo "== IP restriction"
mk "$JAR" "$CSRF" '{"name":"falsche IP","role":"viewer","expires_days":30,"ip_allow":"203.0.113.7"}'
http - GET /api/v1/me '' -H "Authorization: Bearer $TOKEN"; check "Token with a foreign IP list -> 401" eq "$CODE" 401
http - GET /api/v1/me '' "${AUTH[@]}"; http "$JAR" GET /api/account/tokens; CLIENT_IP="$(printf '%s' "$BODY" | sed -n 's/.*"last_used_ip":"\([^"]*\)".*/\1/p' | head -1)"
check "Client IP determined from last_used_ip ($CLIENT_IP)" bash -c "[[ -n '$CLIENT_IP' ]]"
mk "$JAR" "$CSRF" "{\"name\":\"richtige IP\",\"role\":\"viewer\",\"expires_days\":30,\"ip_allow\":\"$CLIENT_IP/32\"}"
http - GET /api/v1/me '' -H "Authorization: Bearer $TOKEN"; check "Token mit passender IP -> 200" eq "$CODE" 200

echo "== Manipulation, Widerruf, Ablauf, Deaktivierung"
mk "$JAR" "$CSRF" '{"name":"zum Testen","role":"operator","expires_days":30}'; T2="$TOKEN"; PREFIX="${T2#wmt_}"; PREFIX="${PREFIX%%_*}"
BAD="${T2%?}X"; [ "$BAD" = "$T2" ] && BAD="${T2%?}Y"
http - GET /api/v1/me '' -H "Authorization: Bearer $BAD"; check "Last character changed -> 401" eq "$CODE" 401
http - GET /api/v1/me '' -H "Authorization: Bearer $T2"; check "Original still valid -> 200" eq "$CODE" 200
ID="$(sql "SELECT id FROM api_tokens WHERE prefix='$PREFIX'")"
http "$JAR" DELETE "/api/account/tokens/$ID" '' -H "X-CSRF-Token: $CSRF"; check "Revoke -> 200" eq "$CODE" 200
http - GET /api/v1/me '' -H "Authorization: Bearer $T2"; check "Revoked token -> 401" eq "$CODE" 401
http "$JAR" DELETE "/api/account/tokens/$ID" '' -H "X-CSRF-Token: $CSRF"; check "Second revoke -> 404" eq "$CODE" 404
mk "$JAR" "$CSRF" '{"name":"läuft ab","role":"viewer","expires_days":30}'; T3="$TOKEN"; P3="${T3#wmt_}"; P3="${P3%%_*}"
sql "UPDATE api_tokens SET expires_at = NOW() - INTERVAL 1 MINUTE WHERE prefix='$P3'"
http - GET /api/v1/me '' -H "Authorization: Bearer $T3"; check "Expired token -> 401" eq "$CODE" 401
mk "$VJAR" "$VCSRF" '{"name":"v2","role":"viewer","expires_days":30}'; T4="$TOKEN"
http - GET /api/v1/me '' -H "Authorization: Bearer $T4"; check "Token of an active user -> 200" eq "$CODE" 200
sql "UPDATE users SET active=0 WHERE email='viewer@example.com'"
http - GET /api/v1/me '' -H "Authorization: Bearer $T4"; check "Token of a disabled user -> 401" eq "$CODE" 401
sql "UPDATE users SET active=1, role='customer' WHERE email='viewer@example.com'"
http - GET /api/v1/me '' -H "Authorization: Bearer $T4"; check "Token of a user who has meanwhile become a customer -> 401" eq "$CODE" 401
sql "UPDATE users SET role='viewer' WHERE email='viewer@example.com'"
mk "$JAR" "$CSRF" '{"name":"fremd","role":"viewer","expires_days":30}'; VID="$(sql "SELECT id FROM api_tokens WHERE name='fremd'")"
http "$VJAR" DELETE "/api/account/tokens/$VID" '' -H "X-CSRF-Token: $VCSRF"; check "Revoke a foreign token -> 404 (belongs to the admin)" eq "$CODE" 404

echo "== JSON sign-in (app)"
totp() { docker run --rm "$IMAGE" php -r 'require "/srv/webmanager/app/bootstrap.php"; echo WebManager\Support\Totp::codeAt($argv[1], intdiv(time(), 30) + (int) $argv[2]);' "$1" "$2"; }
JJ="$TMP/json.jar"; : >"$JJ"
http "$JJ" GET /api/auth/state; check "state without sign-in: authenticated=false" has "$BODY" '"authenticated":false'
JC="$(json csrf)"; check "  CSRF token (64 characters)" eq "${#JC}" 64; check "  Passkeys over the IP address not possible" has "$BODY" '"passkeys_possible":false'
http "$JJ" POST /api/auth/login '{"email":"admin@example.com","password":"x"}'; check "Sign-in without CSRF token -> 403" eq "$CODE" 403
http "$JJ" POST /api/auth/login '{"email":"admin@example.com","password":"falsch"}' -H "X-CSRF-Token: $JC"; check "Wrong password -> 403 (never 401, otherwise a loop in the client)" eq "$CODE" 403; check "  Meldung ohne Hinweis, ob die E-Mail existiert" has "$BODY" 'E-Mail oder Passwort ist falsch'
http "$JJ" POST /api/auth/login '{"email":"unbekannt@example.com","password":"falsch"}' -H "X-CSRF-Token: $JC"; check "Unknown user: same answer" has "$BODY" 'E-Mail oder Passwort ist falsch'
http "$JJ" GET /api/v1/me; check "Still not signed in after a failed attempt -> 401" eq "$CODE" 401
http "$JJ" POST /api/auth/login "{\"email\":\"admin@example.com\",\"password\":\"$PWD1\"}" -H "X-CSRF-Token: $JC"; check "Correct password -> 200 (trotz vieler ungültiger API-Tokens derselben IP)" eq "$CODE" 200; check "  authenticated=true" has "$BODY" '"authenticated":true'
NC="$(json csrf)"; check "  Session renewed: new CSRF token" bash -c "[[ '$NC' != '$JC' && ${#NC} -eq 64 ]]"
http "$JJ" GET /api/v1/me; check "  /api/v1/me with the new session -> 200" eq "$CODE" 200
http "$JJ" POST /api/auth/logout; check "Sign-out without CSRF token -> 403" eq "$CODE" 403
http "$JJ" POST /api/auth/logout '' -H "X-CSRF-Token: $NC"; check "Sign-out -> 200, authenticated=false" has "$BODY" '"authenticated":false'
LC="$(json csrf)"; check "  fresh CSRF token after sign-out" bash -c "[[ ${#LC} -eq 64 && '$LC' != '$NC' ]]"
http "$JJ" GET /api/v1/me; check "  afterwards -> 401" eq "$CODE" 401

echo "== Two-factor sign-in via JSON"
sql "INSERT INTO users (email, name, password_hash, role) VALUES ('twofa@example.com','T','$HASH','operator')"
TJ="$TMP/2fa.jar"; login "$TJ" twofa@example.com; http "$TJ" GET /api/v1/me; TC="$(json csrf)"
http "$TJ" POST /api/account/2fa/setup "{\"password\":\"$PWD1\"}" -H "X-CSRF-Token: $TC"; TSEC="$(json secret)"; check "2FA setup returns a secret" bash -c "[[ -n '$TSEC' ]]"
http "$TJ" POST /api/account/2fa/enable "{\"code\":\"$(totp "$TSEC" 0)\"}" -H "X-CSRF-Token: $TC"; check "2FA enabled -> 200" eq "$CODE" 200
RECOVERY="$(printf '%s' "$BODY" | sed -n 's/.*"recovery_codes":\["\([^"]*\)".*/\1/p')"; check "  Recovery codes received" bash -c "[[ -n '$RECOVERY' ]]"
tfa_login() { # tfa_login <jar>: password step, leaves the jar waiting for the second factor
  : >"$1"; http "$1" GET /api/auth/state; local c; c="$(json csrf)"
  http "$1" POST /api/auth/login "{\"email\":\"twofa@example.com\",\"password\":\"$PWD1\"}" -H "X-CSRF-Token: $c"; T2C="$(json csrf)"
}
J2="$TMP/2fa-json.jar"; tfa_login "$J2"
check "Password alone is not enough: pending_2fa=totp" has "$BODY" '"pending_2fa":{"totp":true,"passkey":false}'; check "  authenticated=false" has "$BODY" '"authenticated":false'
http "$J2" GET /api/v1/me; check "  /api/v1/me -> 401 (half signed in does not count)" eq "$CODE" 401
http "$J2" POST /api/auth/2fa '{"code":"000000"}' -H "X-CSRF-Token: $T2C"; check "Falscher Code -> 403" eq "$CODE" 403
http "$J2" POST /api/auth/2fa "{\"code\":\"$(totp "$TSEC" 1)\"}"; check "Correct code without CSRF token -> 403" eq "$CODE" 403
GOOD="$(totp "$TSEC" 1)"
http "$J2" POST /api/auth/2fa "{\"code\":\"$GOOD\"}" -H "X-CSRF-Token: $T2C"; check "Richtiger Code -> 200, authenticated=true" has "$BODY" '"authenticated":true'
http "$J2" GET /api/v1/me; check "  /api/v1/me -> 200 (role operator)" has "$BODY" '"role":"operator"'
J3="$TMP/2fa-replay.jar"; tfa_login "$J3"
http "$J3" POST /api/auth/2fa "{\"code\":\"$GOOD\"}" -H "X-CSRF-Token: $T2C"; check "The same code a second time -> 403 (Replay)" eq "$CODE" 403
J4="$TMP/2fa-rec.jar"; tfa_login "$J4"
http "$J4" POST /api/auth/2fa "{\"code\":\"$RECOVERY\"}" -H "X-CSRF-Token: $T2C"; check "Recovery code -> signed in" has "$BODY" '"authenticated":true'
J5="$TMP/2fa-rec2.jar"; tfa_login "$J5"
http "$J5" POST /api/auth/2fa "{\"code\":\"$RECOVERY\"}" -H "X-CSRF-Token: $T2C"; check "Recovery code only once -> 403" eq "$CODE" 403
J6="$TMP/2fa-cancel.jar"; tfa_login "$J6"
http "$J6" POST /api/auth/cancel '' -H "X-CSRF-Token: $T2C"; check "Cancel -> pending_2fa=null" has "$BODY" '"pending_2fa":null'
http "$J6" POST /api/auth/2fa "{\"code\":\"$(totp "$TSEC" 1)\"}" -H "X-CSRF-Token: $T2C"; check "Code after cancelling -> 409" eq "$CODE" 409
J7="$TMP/2fa-lock.jar"; tfa_login "$J7"; for _ in 1 2 3 4 5; do http "$J7" POST /api/auth/2fa '{"code":"111111"}' -H "X-CSRF-Token: $T2C"; done
http "$J7" POST /api/auth/2fa "{\"code\":\"$(totp "$TSEC" 1)\"}" -H "X-CSRF-Token: $T2C"; check "Locked after 5 wrong codes -> 429 (even with the correct code)" eq "$CODE" 429
sql "DELETE FROM login_attempts"

echo "== Lockout after wrong passwords"
J8="$TMP/lock.jar"; : >"$J8"; http "$J8" GET /api/auth/state; LC8="$(json csrf)"
for _ in 1 2 3 4 5; do http "$J8" POST /api/auth/login '{"email":"opfer@example.com","password":"falsch"}' -H "X-CSRF-Token: $LC8"; done
http "$J8" POST /api/auth/login '{"email":"opfer@example.com","password":"falsch"}' -H "X-CSRF-Token: $LC8"; check "After 5 failed attempts for one email -> 429" eq "$CODE" 429
sql "DELETE FROM login_attempts"

echo "== Lockout after failed attempts"
for _ in $(seq 1 22); do curl -s -o /dev/null -H 'Authorization: Bearer wmt_deadbeef_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' "$BASE/api/v1/me"; done
http - GET /api/v1/me '' "${AUTH[@]}"; check "After 20 invalid tokens the IP is locked (even a valid token) -> 429" eq "$CODE" 429

echo "== Website sections of the app (forms against the real backend)"
sql "INSERT INTO sites (name, type, runtime, docroot, lifecycle, desired_state) VALUES ('Demo Site','php','php-8.5','public','ready','running')"
S=1; H=(-H "X-CSRF-Token: $CSRF")
put() { http "$JAR" PUT "/api/sites/$S/$1" "$2" "${H[@]}"; }
post() { http "$JAR" POST "/api/sites/$S/$1" "$2" "${H[@]}"; }
http "$JAR" GET "/api/v1/sites/$S"; check "GET /api/v1/sites/1 -> 200 with slug and lifecycle" bash -c "[[ $CODE == 200 && '$BODY' == *'\"slug\":\"site-001\"'* && '$BODY' == *'\"lifecycle\":\"ready\"'* ]]"

echo "-- Maintenance mode"
http "$JAR" GET "/api/sites/$S/maintenance"; check "GET maintenance -> enabled=false, your_ip" bash -c "[[ '$BODY' == *'\"enabled\":false'* && '$BODY' == *'\"your_ip\"'* ]]"
put maintenance '{"enabled":true,"title":"Bis gleich","message":"Wartung bis 18 Uhr","allow_ips":["203.0.113.7"]}'; check "PUT maintenance -> 200 with task" bash -c "[[ $CODE == 200 && '$BODY' == *'\"job\":'* ]]"
http "$JAR" GET "/api/sites/$S/maintenance"; check "  Values were saved" bash -c "[[ '$BODY' == *'\"enabled\":true'* && '$BODY' == *'Wartung bis 18 Uhr'* && '$BODY' == *'203.0.113.7'* ]]"
put maintenance '{"enabled":true,"allow_ips":["kein-ip"]}'; check "Invalid IP -> 422" eq "$CODE" 422
put maintenance "{\"enabled\":true,\"allow_ips\":[$(printf '"10.0.0.%s",' $(seq 1 21) | sed 's/,$//')]}"; check "More than 20 IPs -> 422" eq "$CODE" 422
put maintenance '{"enabled":false,"title":"","message":"","allow_ips":[]}'; check "Switch maintenance mode off -> 200" eq "$CODE" 200

echo "-- Password protection"
put gate '{"enabled":true,"ttl_minutes":480,"title":"","text":"","bypass_paths":[]}'; check "Enable protection without a password -> 422" eq "$CODE" 422
post gate/passwords '{"label":"kurz","password":"abc"}'; check "Password too short -> 422" eq "$CODE" 422
post gate/passwords '{"label":"Kunde","password":"Ein-langes-Passwort"}'; check "Create password -> 201" eq "$CODE" 201; GPID="$(json id)"
put gate '{"enabled":true,"ttl_minutes":4,"title":"","text":"","bypass_paths":[]}'; check "Validity under 5 minutes -> 422" eq "$CODE" 422
put gate '{"enabled":true,"ttl_minutes":480,"title":"Zutritt","text":"Bitte anmelden","bypass_paths":["/api/webhook","/hook"]}'; check "Enable protection -> 200" eq "$CODE" 200
put gate '{"enabled":true,"ttl_minutes":480,"title":"","text":"","bypass_paths":["/../etc"]}'; check "Path with .. -> 422" eq "$CODE" 422
put gate '{"enabled":true,"ttl_minutes":480,"title":"","text":"","bypass_paths":["kein-slash"]}'; check "Path without a leading / -> 422" eq "$CODE" 422
http "$JAR" GET "/api/sites/$S/gate"; check "GET gate: password without hash, paths, protection on" bash -c "[[ '$BODY' == *'\"enabled\":true'* && '$BODY' == *'/api/webhook'* && '$BODY' == *'\"label\":\"Kunde\"'* && '$BODY' != *'argon'* && '$BODY' != *'password_hash'* ]]"
http "$JAR" DELETE "/api/sites/$S/gate/passwords/$GPID" '' "${H[@]}"; check "Delete the last password while protection is on -> 409" eq "$CODE" 409
put gate '{"enabled":false,"ttl_minutes":480,"title":"","text":"","bypass_paths":[]}'
http "$JAR" DELETE "/api/sites/$S/gate/passwords/$GPID" '' "${H[@]}"; check "Delete after switching off -> 200" eq "$CODE" 200

echo "-- Access rules"
put rules '{"allow":["203.0.113.0/24"],"deny":["198.51.100.9"],"rate_rps":10,"rate_burst":50,"conn_limit":20,"geo_mode":"off","geo_countries":[]}'; check "Save rules -> 200" eq "$CODE" 200
http "$JAR" GET "/api/sites/$S/rules"; check "  Values read back" bash -c "[[ '$BODY' == *'203.0.113.0/24'* && '$BODY' == *'\"rate_rps\":10'* && '$BODY' == *'\"conn_limit\":20'* ]]"
put rules '{"allow":["203.0.113.0/33"],"deny":[],"rate_rps":0,"rate_burst":0,"conn_limit":0,"geo_mode":"off","geo_countries":[]}'; check "Invalid CIDR -> 422" eq "$CODE" 422
put rules '{"allow":[],"deny":[],"rate_rps":5000,"rate_burst":0,"conn_limit":0,"geo_mode":"off","geo_countries":[]}'; check "Rate outside the range -> 422" eq "$CODE" 422
put rules '{"allow":[],"deny":[],"rate_rps":0,"rate_burst":0,"conn_limit":0,"geo_mode":"block","geo_countries":["XX1"]}'; check "Invalid country code -> 422" eq "$CODE" 422
put rules '{"allow":[],"deny":[],"rate_rps":0,"rate_burst":0,"conn_limit":0,"geo_mode":"block","geo_countries":["CN"]}'; check "Country block without loaded data -> 409" eq "$CODE" 409

echo "-- Security and WAF"
put security '{"headers":{"hsts":true,"xfo":"sameorigin","nosniff":true,"referrer":"no-referrer","permissions":true,"csp":"default-src self","cspReportOnly":false},"waf_mode":"block","waf_categories":["sqli","xss"],"waf_exempt":["/admin/editor"]}'; check "Header und WAF speichern -> 200" eq "$CODE" 200
http "$JAR" GET "/api/sites/$S/security"; check "  Values read back (headers, mode, categories, labels)" bash -c "[[ '$BODY' == *'\"hsts\":true'* && '$BODY' == *'\"waf_mode\":\"block\"'* && '$BODY' == *'\"sqli\"'* && '$BODY' == *'waf_labels'* ]]"
put security '{"headers":{},"waf_mode":"block","waf_categories":[],"waf_exempt":[]}'; check "WAF active without category -> 422" eq "$CODE" 422
put security '{"headers":{"csp":"script-src $evil"},"waf_mode":"off","waf_categories":[],"waf_exempt":[]}'; check "CSP with invalid characters -> 422" eq "$CODE" 422
put security '{"headers":{},"waf_mode":"bogus","waf_categories":[],"waf_exempt":[]}'; check "Unknown WAF mode -> 422" eq "$CODE" 422

echo "-- Domains"
put domains '{"domains":["demo.example.com","www.demo.example.com"]}'; check "Save domains -> 200" bash -c "[[ $CODE == 200 && '$BODY' == *'demo.example.com'* ]]"
put domains '{"domains":["kein domain!"]}'; check "Invalid domain -> 422" eq "$CODE" 422
http "$JAR" GET "/api/v1/sites/$S"; check "  /api/v1/sites/1 shows the domains" has "$BODY" '"domains":["demo.example.com","www.demo.example.com"]'
post cert '{"email":"a@example.com","accept_tos":false}'; check "Certificate without consent -> 422" eq "$CODE" 422
post cert '{"email":"kaputt","accept_tos":true}'; check "Certificate with invalid email -> 422" eq "$CODE" 422
post cert '{"email":"a@example.com","accept_tos":true}'; check "Request certificate -> 200 with task" bash -c "[[ $CODE == 200 && '$BODY' == *'\"job\":'* ]]"

echo "-- Database"
http "$JAR" GET "/api/sites/$S/database"; check "GET database -> types, status not available without agent" bash -c "[[ $CODE == 200 && '$BODY' == *'\"available\":[{'* && '$BODY' == *'\"agent_unreachable\":true'* && '$BODY' == *'\"has_data\":false'* ]]"
put database '{"enabled":true,"engine":"bogus","memory_mb":256}'; check "Unknown type -> 422" eq "$CODE" 422
put database '{"enabled":true,"engine":"mariadb","memory_mb":64}'; check "Too little memory -> 422" eq "$CODE" 422
put database '{"enabled":true,"engine":"mariadb","memory_mb":256}'; check "Set up the database -> 200 with task" bash -c "[[ $CODE == 200 && '$BODY' == *'\"job\":'* ]]"
http "$JAR" GET "/api/sites/$S/database"; check "  has_data=true, host and user" bash -c "[[ '$BODY' == *'\"has_data\":true'* && '$BODY' == *'\"host\":\"wm-db-site-001\"'* && '$BODY' == *'\"user\":\"app\"'* ]]"
check "  Answer does not contain the password" hasnt "$BODY" 'password_enc'
http "$JAR" GET "/api/sites/$S/database/password"; DPW="$(json password)"; check "Show password (on request only) -> 32 characters" eq "${#DPW}" 32
check "  Viewing is logged" bash -c "[[ \$(docker exec -i $DB mariadb -uwm -ppw wm -N -e \"SELECT COUNT(*) FROM audit_log WHERE action='site.db_password_view'\" 2>/dev/null) -ge 1 ]]"
post database/purge '{"confirm":"falscher Name"}'; check "Delete with wrong confirmation -> 422" eq "$CODE" 422
put database/external '{"enabled":true,"allow":["0.0.0.0/0"]}'; check "Ganzes Internet freigeben -> 422" eq "$CODE" 422
put database/external '{"enabled":true,"allow":[]}'; check "Release without address -> 422" eq "$CODE" 422
put database/external '{"enabled":true,"allow":["203.0.113.7"]}'; check "Release for one address -> 200" eq "$CODE" 200
post database/restore '{"name":"../../etc/passwd","confirm":true}'; check "Restore with a manipulated dump name -> 422" eq "$CODE" 422
http "$JAR" GET "/api/sites/$S/database/dumps/..%2f..%2fetc%2fpasswd"; check "Download with a manipulated dump name -> 404" eq "$CODE" 404

echo "-- Files (without agent: clean error instead of crash)"
http "$JAR" GET "/api/sites/$S/files?path="; check "File list without agent -> error as JSON, not 200" bash -c "[[ $CODE != 200 && $CODE != 500 && '$BODY' == *'\"error\"'* ]]"
http "$JAR" GET "/api/sites/$S/files/content?path=$(printf 'a%.0s' $(seq 1 2100))"; check "Path over 2048 characters -> 422" eq "$CODE" 422
put files/content '{"nocontent":1}'; check "Writing without content -> 422" eq "$CODE" 422

echo "-- Permissions per role"
http "$VJAR" GET "/api/sites/$S/maintenance"; check "Viewer: maintenance -> 403" eq "$CODE" 403
http "$VJAR" GET "/api/sites/$S/files?path="; check "Viewer: Files -> 403" eq "$CODE" 403
http "$VJAR" GET "/api/sites/$S/jobs"; check "Viewer: tasks of the website -> 200" eq "$CODE" 200
http "$VJAR" PUT "/api/sites/$S/gate" '{"enabled":false}' -H "X-CSRF-Token: $VCSRF"; check "Viewer: Password protection change -> 403" eq "$CODE" 403

echo "== Deploy, operations, settings and new website (forms against the real backend)"
delj() { http "$JAR" DELETE "$1" "${2:-}" "${H[@]}"; }

echo "-- Environment variables"
put env '{"env":{"NODE_ENV":"production","API_URL":"https://x.example/?a=b"}}'; check "Save variables -> 200 with task" bash -c "[[ $CODE == 200 && '$BODY' == *'\"job\":'* ]]"
http "$JAR" GET "/api/sites/$S/env"; check "  read back" bash -c "[[ '$BODY' == *'\"NODE_ENV\":\"production\"'* && '$BODY' == *'a=b'* ]]"
check "  encrypted in the database (no clear text)" bash -c "! docker exec -i $DB mariadb -uwm -ppw wm -N -e 'SELECT value_enc FROM site_env' 2>/dev/null | grep -q production"
put env '{"env":{"PATH":"/evil"}}'; check "Reserved name PATH -> 422" eq "$CODE" 422
put env '{"env":{"LD_PRELOAD":"/x.so"}}'; check "Reserved name LD_PRELOAD -> 422" eq "$CODE" 422
put env '{"env":{"MIT LEERZEICHEN":"x"}}'; check "Invalid name -> 422" eq "$CODE" 422
put env '{"env":{"A":"zeile1\nzeile2"}}'; check "Value with line break -> 422" eq "$CODE" 422
put env "{\"env\":{\"A\":\"$(printf 'x%.0s' $(seq 1 4100))\"}}"; check "Value over 4096 characters -> 422" eq "$CODE" 422
put env "{\"env\":{$(printf '"V%s":"1",' $(seq 1 201) | sed 's/,$//')}}"; check "More than 200 variables -> 422" eq "$CODE" 422
http "$VJAR" GET "/api/sites/$S/env"; check "Viewer: Read variables -> 403" eq "$CODE" 403
put env '{"env":{}}'; check "Remove all variables -> 200" eq "$CODE" 200

echo "-- Commands"
post commands '{"kind":"gibt-es-nicht"}'; check "Unknown task -> 422" eq "$CODE" 422
post commands '{"kind":"npm_install"}'; check "npm install on a PHP runtime (contains Node/npm for Vite builds) -> 200" eq "$CODE" 200
post commands '{"kind":"npm_script","script":"build; rm -rf /"}'; check "npm script name with shell characters -> 422" eq "$CODE" 422
post commands '{"kind":"composer_install"}'; check "Laravel command on a PHP website -> 422" eq "$CODE" 422
post commands '{"kind":"git_sync"}'; check "Git without repository -> 422" eq "$CODE" 422
post commands '{"kind":"extract","archive":"../x.zip"}'; check "Archive name with .. -> 422" eq "$CODE" 422
post commands '{"kind":"extract","archive":"x.rar"}'; check "Archive with a wrong extension -> 422" eq "$CODE" 422
post commands '{"kind":"extract","archive":".wm-upload-1.zip","strip":true,"restart_after":true}'; check "Extract archive -> 200 with task" bash -c "[[ $CODE == 200 && '$BODY' == *'\"job\":'* ]]"
http "$VJAR" POST "/api/sites/$S/commands" '{"kind":"build"}' "${VH[@]}"; check "Viewer: Command -> 403" eq "$CODE" 403

echo "-- Cron jobs"
post cron '{"name":"Import","schedule":"0 3 * * *","command":"php import.php","timeout_sec":600,"enabled":true,"notify_fail":true}'; check "Create cron job -> 201" eq "$CODE" 201; CID="$(json id)"
http "$JAR" GET "/api/sites/$S/cron"; check "  List with time zone and limit" bash -c "[[ '$BODY' == *'\"name\":\"Import\"'* && '$BODY' == *'\"tz\"'* && '$BODY' == *'\"max\":20'* ]]"
post cron '{"name":"X","schedule":"61 * * * *","command":"x","timeout_sec":600}'; check "Invalid schedule -> 422" eq "$CODE" 422
post cron '{"name":"X","schedule":"* * * * *","command":"","timeout_sec":600}'; check "Empty command -> 422" eq "$CODE" 422
post cron '{"name":"","schedule":"* * * * *","command":"x","timeout_sec":600}'; check "Empty name -> 422" eq "$CODE" 422
post cron '{"name":"X","schedule":"* * * * *","command":"x","timeout_sec":5}'; check "Time limit under 10 s -> 422" eq "$CODE" 422
post cron '{"name":"X","schedule":"* * * * *","command":"x","timeout_sec":4000}'; check "Time limit over 3600 s -> 422" eq "$CODE" 422
put "cron/$CID" '{"name":"Import 2","schedule":"@daily","command":"php import.php","timeout_sec":300,"enabled":false,"notify_fail":false}'; check "Change and pause cron job -> 200" eq "$CODE" 200
http "$JAR" GET "/api/sites/$S/cron"; check "  Values adopted" bash -c "[[ '$BODY' == *'Import 2'* && '$BODY' == *'@daily'* && '$BODY' == *'\"enabled\":false'* ]]"
post "cron/$CID/run" '{}'; check "Run now -> 200 with task" bash -c "[[ $CODE == 200 && '$BODY' == *'\"job\":'* ]]"
post "cron/$CID/run" '{}'; check "Second run while the first is waiting -> 409" eq "$CODE" 409
http "$JAR" PUT "/api/sites/$S/cron/999999" '{"name":"x","schedule":"* * * * *","command":"x","timeout_sec":60}' "${H[@]}"; check "Unknown cron job -> 404" eq "$CODE" 404
http "$VJAR" GET "/api/sites/$S/cron"; check "Viewer: Cron jobs -> 403" eq "$CODE" 403
for n in $(seq 1 18); do post cron "{\"name\":\"Fuell $n\",\"schedule\":\"0 * * * *\",\"command\":\"x\",\"timeout_sec\":60}" >/dev/null; done
post cron '{"name":"Zu viel","schedule":"0 * * * *","command":"x","timeout_sec":60}'; check "More than 20 cron jobs per website -> 422" eq "$CODE" 422
delj "/api/sites/$S/cron/$CID"; check "Delete cron job -> 200" eq "$CODE" 200

echo "-- Weekly report"
http "$JAR" GET "/api/sites/$S/report"; check "GET report: defaults, SMTP not ready" bash -c "[[ '$BODY' == *'\"enabled\":false'* && '$BODY' == *'\"smtp_ready\":false'* && '$BODY' == *'\"weekday\":1'* ]]"
put report '{"enabled":true,"recipients":"","weekday":1,"hour":8}'; check "Enable without recipients -> 422" eq "$CODE" 422
put report '{"enabled":false,"recipients":"kaputt","weekday":1,"hour":8}'; check "Invalid address -> 422" eq "$CODE" 422
put report '{"enabled":false,"recipients":"a@example.com","weekday":7,"hour":8}'; check "Weekday 7 -> 422" eq "$CODE" 422
put report '{"enabled":false,"recipients":"a@example.com","weekday":1,"hour":24}'; check "Hour 24 -> 422" eq "$CODE" 422
put report "{\"enabled\":false,\"recipients\":\"$(printf 'u%s@example.com,' $(seq 1 11) | sed 's/,$//')\",\"weekday\":1,\"hour\":8}"; check "More than 10 recipients -> 422" eq "$CODE" 422
put report '{"enabled":true,"recipients":"A@Example.com, b@example.com","weekday":5,"hour":17}'; check "Save report -> 200" eq "$CODE" 200
http "$JAR" GET "/api/sites/$S/report"; check "  Addresses lower-cased and saved" bash -c "[[ '$BODY' == *'a@example.com'* && '$BODY' == *'b@example.com'* && '$BODY' == *'\"weekday\":5'* && '$BODY' == *'\"hour\":17'* ]]"
post report/send '{}'; check "Send without SMTP server -> 422" eq "$CODE" 422

echo "-- Statistics"
http "$JAR" GET "/api/v1/sites/$S/metrics?range=bogus"; check "Unknown period -> 422" eq "$CODE" 422

echo "-- Settings"
http "$JAR" GET "/api/v1/sites/$S"; check "Website details contain the runtimes" has "$BODY" '"runtimes":[{"key":"static"'
SB='"name":"Demo Site","description":"neu","type":"php","runtime":"php-8.5","internal_port":8080,"docroot":"public","cpus":1,"pids":256,"start_command":"","install_command":"","build_command":"","git_url":"","git_branch":"","git_username":"","autostart":true'
http "$JAR" PUT "/api/sites/$S" "{$SB,\"memory_mb\":768}" "${H[@]}"; check "Save settings -> 200 with task" bash -c "[[ $CODE == 200 && '$BODY' == *'\"job\":'* ]]"
http "$JAR" GET "/api/v1/sites/$S"; check "  adopted (memory, description)" bash -c "[[ '$BODY' == *'\"memory_mb\":768'* && '$BODY' == *'\"description\":\"neu\"'* ]]"
http "$JAR" PUT "/api/sites/$S" "{$SB,\"memory_mb\":10,\"cpus\":99}" "${H[@]}"; check "Invalid values -> 422 with field errors" bash -c "[[ $CODE == 422 && '$BODY' == *'\"fields\":{'* && '$BODY' == *'memory_mb'* && '$BODY' == *'cpus'* ]]"
http "$JAR" PUT "/api/sites/$S" "{${SB/\"type\":\"php\"/\"type\":\"static\"},\"memory_mb\":512}" "${H[@]}"; check "Change the type afterwards -> 422" eq "$CODE" 422
http "$JAR" PUT "/api/sites/$S" "{${SB/\"runtime\":\"php-8.5\"/\"runtime\":\"static\"},\"memory_mb\":512}" "${H[@]}"; check "Runtime that does not match the type -> 422" eq "$CODE" 422
http "$JAR" PUT "/api/sites/$S" "{${SB/\"docroot\":\"public\"/\"docroot\":\"../etc\"},\"memory_mb\":512}" "${H[@]}"; check "Document root with .. -> 422" eq "$CODE" 422
http "$JAR" PUT "/api/sites/$S" "{${SB/\"git_url\":\"\"/\"git_url\":\"http://unsicher.example/r.git\"},\"memory_mb\":512}" "${H[@]}"; check "Git URL without https -> 422" eq "$CODE" 422
http "$VJAR" PUT "/api/sites/$S" "{$SB,\"memory_mb\":512}" "${VH[@]}"; check "Viewer: Settings change -> 403" eq "$CODE" 403

echo "-- New website"
http "$JAR" GET /api/runtimes; check "GET /api/runtimes -> Templates mit Image, Typen, Port" bash -c "[[ $CODE == 200 && '$BODY' == *'\"key\":\"php-8.5\"'* && '$BODY' == *'\"image\"'* && '$BODY' == *'\"types\":[\"php\"'* ]]"
http "$VJAR" GET /api/runtimes; check "Viewer: Templates -> 403" eq "$CODE" 403
NS='"description":"","type":"php","runtime":"php-8.5","internal_port":3000,"docroot":"","memory_mb":512,"cpus":1,"pids":256,"git_url":"","git_branch":"","git_username":"","git_token":"","install_command":"","build_command":"","start_command":"","autostart":true'
http "$JAR" POST /api/sites "{\"name\":\"Zweite Site\",$NS,\"domains\":[\"zweite.example.com\"],\"env\":{\"APP_ENV\":\"prod\"}}" "${H[@]}"; check "Create website -> 201 with number and task" bash -c "[[ $CODE == 201 && '$BODY' == *'\"site\":'* && '$BODY' == *'\"job\":'* ]]"; NEWID="$(json site)"
check "  Row with lifecycle=creating, domain and encrypted variable" bash -c "[[ \$(docker exec -i $DB mariadb -uwm -ppw wm -N -e \"SELECT CONCAT(s.lifecycle,'|',(SELECT domain FROM site_domains WHERE site_id=s.id),'|',(SELECT COUNT(*) FROM site_env WHERE site_id=s.id)) FROM sites s WHERE s.id=$NEWID\" 2>/dev/null) == 'creating|zweite.example.com|1' ]]"
http "$JAR" POST /api/sites "{\"name\":\"Zweite Site\",$NS,\"domains\":[],\"env\":{}}" "${H[@]}"; check "Doppelter Name -> 422 mit Feld name" bash -c "[[ $CODE == 422 && '$BODY' == *'\"name\"'* ]]"
http "$JAR" POST /api/sites "{\"name\":\"Dritte\",$NS,\"domains\":[\"zweite.example.com\"],\"env\":{}}" "${H[@]}"; check "Domain of another website -> 422" eq "$CODE" 422
http "$JAR" POST /api/sites "{\"name\":\"Dritte\",$NS,\"domains\":[],\"env\":{\"PORT\":\"1\"}}" "${H[@]}"; check "Reserved variable -> 422" eq "$CODE" 422
http "$JAR" POST /api/sites "{\"name\":\"<script>\",$NS,\"domains\":[],\"env\":{}}" "${H[@]}"; check "Name with special characters -> 422" eq "$CODE" 422
http "$JAR" POST /api/sites "{\"name\":\"Vierte\",${NS/\"type\":\"php\"/\"type\":\"custom\"},\"domains\":[],\"env\":{}}" "${H[@]}"; check "Custom without start command -> 422 (Feld start_command)" bash -c "[[ $CODE == 422 && '$BODY' == *'start_command'* ]]"
http "$JAR" POST /api/sites "{\"name\":\"Fuenfte\",${NS/\"runtime\":\"php-8.5\"/\"runtime\":\"gibt-es-nicht\"},\"domains\":[],\"env\":{}}" "${H[@]}"; check "Runtime that is not approved -> 422" eq "$CODE" 422
http "$VJAR" POST /api/sites "{\"name\":\"Sechste\",$NS}" "${VH[@]}"; check "Viewer: create website -> 403" eq "$CODE" 403

echo "-- Duplicate and delete"
http "$JAR" POST "/api/sites/$S/duplicate" '{"name":"Zweite Site","copy_files":true,"copy_env":false}' "${H[@]}"; check "Copy with an existing name -> 422" eq "$CODE" 422
http "$JAR" POST "/api/sites/$S/duplicate" '{"name":"Demo Kopie","copy_files":true,"copy_env":true}' "${H[@]}"; check "Duplicate website -> 201 with number and task" bash -c "[[ $CODE == 201 && '$BODY' == *'\"site\":'* && '$BODY' == *'\"job\":'* ]]"; DUP="$(json site)"
check "  Copy has no domain and no password protection" bash -c "[[ \$(docker exec -i $DB mariadb -uwm -ppw wm -N -e \"SELECT (SELECT COUNT(*) FROM site_domains WHERE site_id=$DUP) + (SELECT gate_enabled FROM sites WHERE id=$DUP)\" 2>/dev/null) == 0 ]]"
delj "/api/sites/$DUP" '{"confirm":"falsch"}'; check "Delete with wrong confirmation -> 422" eq "$CODE" 422
delj "/api/sites/$DUP" '{"confirm":"Demo Kopie","purge":false}'; check "Delete with name -> 200 with task" bash -c "[[ $CODE == 200 && '$BODY' == *'\"job\":'* ]]"
check "  Website is at lifecycle=deleting" bash -c "[[ \$(docker exec -i $DB mariadb -uwm -ppw wm -N -e \"SELECT lifecycle FROM sites WHERE id=$DUP\" 2>/dev/null) == deleting ]]"
delj "/api/sites/$DUP" '{"confirm":"Demo Kopie"}'; check "Second delete -> 409" eq "$CODE" 409
http "$VJAR" DELETE "/api/sites/$S" '{"confirm":"Demo Site"}' "${VH[@]}"; check "Viewer: delete -> 403" eq "$CODE" 403

echo "== Users, account, system, tasks and audit log (app)"
adm() { http "$JAR" "$1" "$2" "${3:-}" "${H[@]}"; }

echo "-- User"
adm POST /api/users '{"email":"neu@example.com","name":"Neu","password":"Neues-Passwort-2026!","role":"operator"}'; check "Create user -> 201" eq "$CODE" 201; UID1="$(json id)"
adm POST /api/users '{"email":"neu@example.com","password":"Neues-Passwort-2026!","role":"viewer"}'; check "Duplicate email -> 422" eq "$CODE" 422
adm POST /api/users '{"email":"kaputt","password":"Neues-Passwort-2026!","role":"viewer"}'; check "Invalid email -> 422" eq "$CODE" 422
adm POST /api/users '{"email":"schwach@example.com","password":"kurz","role":"viewer"}'; check "Password too short -> 422" eq "$CODE" 422
adm POST /api/users '{"email":"schwach@example.com","password":"nurkleinbuchstaben","role":"viewer"}'; check "Password with too few character classes -> 422" eq "$CODE" 422
adm POST /api/users '{"email":"rolle@example.com","password":"Neues-Passwort-2026!","role":"root"}'; check "Unknown role -> 422" eq "$CODE" 422
adm GET /api/users; check "List contains users, never password hashes" bash -c "[[ $CODE == 200 && '$BODY' == *'neu@example.com'* && '$BODY' != *'password_hash'* && '$BODY' != *'argon2'* ]]"
check "  own account is marked (self)" has "$BODY" '"self":true'
adm PUT "/api/users/$UID1" '{"name":"Neu 2","role":"viewer","active":true}'; check "Edit user -> 200" eq "$CODE" 200
check "  Role adopted" has "$BODY" '"role":"viewer"'
ADMINID="$(sql "SELECT id FROM users WHERE email='admin@example.com'")"
adm PUT "/api/users/$ADMINID" '{"active":false}'; check "Disable own account -> 409" eq "$CODE" 409
adm PUT "/api/users/$ADMINID" '{"role":"viewer"}'; check "Demote the last administrator -> 409" eq "$CODE" 409
adm DELETE "/api/users/$ADMINID"; check "Delete own account -> 409" eq "$CODE" 409
adm POST "/api/users/$UID1/password" '{"password":"schwach"}'; check "Set password: policy -> 422" eq "$CODE" 422
adm POST "/api/users/$UID1/password" '{"password":"Anderes-Passwort-2026!"}'; check "Set password -> 200" eq "$CODE" 200
adm POST "/api/users/$UID1/2fa/reset"; check "Reset 2FA -> 200" eq "$CODE" 200
adm DELETE "/api/users/$UID1"; check "Delete user -> 200" eq "$CODE" 200
adm DELETE "/api/users/$UID1"; check "Delete again -> 404" eq "$CODE" 404
for p in "GET /api/users" "GET /api/audit" "GET /api/settings/login" "GET /api/settings/notifications" "GET /api/protection" "GET /api/branding" "GET /api/backup" "GET /api/update" "GET /api/storage" "POST /api/system/reconcile"; do
  http "$VJAR" "${p%% *}" "${p#* }" '{}' "${VH[@]}"; check "Viewer: $p -> 403" eq "$CODE" 403
done
OJAR="$TMP/operator.jar"; : >"$OJAR"; sql "INSERT INTO users (email, name, password_hash, role) VALUES ('op@example.com','O','$HASH','operator')"; login "$OJAR" op@example.com; http "$OJAR" GET /api/v1/me; OCSRF="$(json csrf)"
http "$OJAR" GET /api/users; check "Operator: Userliste -> 403" eq "$CODE" 403
http "$OJAR" GET /api/audit; check "Operator: audit log -> 403" eq "$CODE" 403

echo "-- My account"
PJAR="$TMP/pw.jar"; sql "INSERT INTO users (email, name, password_hash, role) VALUES ('pw@example.com','P','$HASH','operator')"; login "$PJAR" pw@example.com; http "$PJAR" GET /api/v1/me; PCSRF="$(json csrf)"; PH=(-H "X-CSRF-Token: $PCSRF")
http "$PJAR" GET /api/account; check "GET /api/account -> email, role, 2FA state, passkeys" bash -c "[[ $CODE == 200 && '$BODY' == *'pw@example.com'* && '$BODY' == *'\"totp\":false'* && '$BODY' == *'\"passkeys\":[]'* && '$BODY' == *'\"passkeys_possible\":false'* ]]"
http "$PJAR" POST /api/account/password '{"current":"falsch","new":"Neues-Passwort-2026!"}' "${PH[@]}"; check "Password change: wrong current -> 403" eq "$CODE" 403
http "$PJAR" POST /api/account/password "{\"current\":\"$PWD1\",\"new\":\"zu-einfach\"}" "${PH[@]}"; check "Password change: policy -> 422" eq "$CODE" 422
http "$PJAR" POST /api/account/password "{\"current\":\"$PWD1\",\"new\":\"Neues-Passwort-2026!\"}" "${PH[@]}"; check "Password change -> 200" eq "$CODE" 200
http "$PJAR" GET /api/v1/me; check "  Session stays valid (new fingerprint)" eq "$CODE" 200
PJ2="$TMP/pw2.jar"; : >"$PJ2"; http "$PJ2" GET /api/auth/state; PC2="$(json csrf)"
http "$PJ2" POST /api/auth/login "{\"email\":\"pw@example.com\",\"password\":\"$PWD1\"}" -H "X-CSRF-Token: $PC2"; check "  old password no longer works -> 403" eq "$CODE" 403
http "$PJ2" POST /api/auth/login '{"email":"pw@example.com","password":"Neues-Passwort-2026!"}' -H "X-CSRF-Token: $PC2"; check "  new password works" has "$BODY" '"authenticated":true'
http "$PJAR" POST /api/account/passkeys/options '{"password":"falsch"}' "${PH[@]}"; check "Passkey options with a wrong password -> 403" eq "$CODE" 403
http "$PJAR" POST /api/account/passkeys/options '{"password":"Neues-Passwort-2026!"}' "${PH[@]}"; check "Passkey over the IP address -> 422 with explanation" bash -c "[[ $CODE == 422 && '$BODY' == *'Domain mit HTTPS'* ]]"
http "$PJAR" POST /api/account/2fa/recovery '{"password":"Neues-Passwort-2026!"}' "${PH[@]}"; check "Recovery codes without active 2FA -> 409" eq "$CODE" 409
http "$PJAR" POST /api/account/2fa/setup '{"password":"falsch"}' "${PH[@]}"; check "Set up 2FA with a wrong password -> 403" eq "$CODE" 403
http "$PJAR" POST /api/account/2fa/setup '{"password":"Neues-Passwort-2026!"}' "${PH[@]}"; PSEC="$(json secret)"
check "  Setup returns key and otpauth address" bash -c "[[ -n '$PSEC' && '$BODY' == *'otpauth://totp/'* ]]"
http "$PJAR" POST /api/account/2fa/enable '{"code":"000000"}' "${PH[@]}"; check "Enable 2FA with a wrong code -> 422" eq "$CODE" 422
http "$PJAR" POST /api/account/2fa/enable "{\"code\":\"$(totp "$PSEC" 0)\"}" "${PH[@]}"; check "Enable 2FA -> 200 with 10 recovery codes" bash -c "[[ $CODE == 200 && \$(printf '%s' '$BODY' | grep -o '\"[0-9a-z]\{4\}-[0-9a-z]\{4\}-[0-9a-z]\{4\}-[0-9a-z]\{4\}\"' | wc -l) -eq 10 ]]"
http "$PJAR" POST /api/account/2fa/disable '{"password":"falsch"}' "${PH[@]}"; check "Disable 2FA with a wrong password -> 403" eq "$CODE" 403
http "$PJAR" POST /api/account/2fa/disable '{"password":"Neues-Passwort-2026!"}' "${PH[@]}"; check "Disable 2FA -> 200" eq "$CODE" 200
http "$PJAR" POST /api/account/passkeys/9999/remove '{"password":"Neues-Passwort-2026!"}' "${PH[@]}"; check "Remove an unknown passkey -> 404" eq "$CODE" 404

echo "-- Tasks"
http "$JAR" GET "/api/v1/jobs?limit=5"; check "Tasksliste mit Begrenzung -> 200" bash -c "[[ $CODE == 200 && '$BODY' == *'\"jobs\":['* && '$BODY' == *'\"title\"'* ]]"
JOBID="$(sql "SELECT id FROM jobs ORDER BY id DESC LIMIT 1")"
http "$JAR" GET "/api/v1/jobs/$JOBID"; check "Single task -> 200 with status" has "$BODY" '"status":"queued"'
http "$JAR" GET "/api/v1/jobs/$JOBID/logs?after=0"; check "Log with after=0 -> lines, finished, job" bash -c "[[ $CODE == 200 && '$BODY' == *'\"lines\"'* && '$BODY' == *'\"finished\":false'* ]]"
http "$JAR" GET "/api/v1/jobs/999999"; check "Unknown task -> 404" eq "$CODE" 404
http "$JAR" POST "/api/v1/jobs/$JOBID/cancel" '{}' "${H[@]}"; check "Cancel a queued task -> 200 cancelled" has "$BODY" '"status":"cancelled"'
http "$VJAR" GET "/api/v1/jobs"; check "Viewer: Read tasks -> 200" eq "$CODE" 200

echo "-- Audit log"
adm GET "/api/audit?limit=500"; check "Audit log -> entries with action, target, IP, details" bash -c "[[ $CODE == 200 && '$BODY' == *'\"action\":\"user.create\"'* && '$BODY' == *'\"ip\"'* && '$BODY' == *'\"details\"'* ]]"
printf '%s' "$BODY" >"$TMP/audit.json"
check "  no passwords in the audit log" bash -c "! grep -Eq 'Neues-Passwort|Anderes-Passwort|geheim-xyz|$PWD1' '$TMP/audit.json'"
check "  no complete API tokens in the audit log (prefix only)" bash -c "! grep -Eq 'wmt_[0-9a-f]{8}_[A-Za-z0-9_-]{43}' '$TMP/audit.json'"
adm GET "/api/audit?limit=1"; check "  limit=1 returns exactly one entry" bash -c "[[ \$(printf '%s' '$BODY' | grep -o '\"id\":' | wc -l) -eq 1 ]]"

echo "-- System: sign-in, address, protection, notifications, appearance"
adm GET /api/settings/login; check "GET login -> require_2fa, without_2fa, public_url" bash -c "[[ $CODE == 200 && '$BODY' == *'\"require_2fa\":\"off\"'* && '$BODY' == *'\"without_2fa\"'* ]]"
adm PUT /api/settings/login '{"require_2fa":"bogus"}'; check "Invalid mandatory 2FA -> 422" eq "$CODE" 422
adm PUT /api/settings/login '{"require_2fa":"admins"}'; check "Mandatory for admins without an own second factor -> 422 (self-lockout)" eq "$CODE" 422
adm PUT /api/settings/public-url '{"public_url":"http://evil.example"}'; check "Public address without https -> 422" eq "$CODE" 422
adm PUT /api/settings/public-url '{"public_url":"https://panel.example.com/pfad"}'; check "Public address with path -> 422" eq "$CODE" 422
adm PUT /api/settings/public-url '{"public_url":"https://panel.example.com"}'; check "Save public address -> 200" has "$BODY" 'panel.example.com'
adm PUT /api/settings/public-url '{"public_url":""}'
adm PUT /api/settings/dashboard-domain '{"domain":"kein domain!"}'; check "Dashboard domain invalid -> 422" eq "$CODE" 422
adm PUT /api/settings/dashboard-domain '{"domain":"panel.example.com","issue_certificate":true,"accept_tos":false,"email":"a@example.com"}'; check "Certificate without consent -> 422" eq "$CODE" 422
adm PUT /api/settings/dashboard-domain '{"domain":"demo.example.com"}'; check "Domain of a website as dashboard domain -> 422" eq "$CODE" 422
adm GET /api/protection; check "GET protection -> configuration and own IP" bash -c "[[ $CODE == 200 && '$BODY' == *'\"autoBan\"'* && '$BODY' == *'\"your_ip\"'* ]]"; MYIP="$(json your_ip)"
adm PUT /api/protection '{"autoBan":{"enabled":true,"maxRequests":10,"maxErrors":150,"windowSec":60,"banMinutes":60},"whitelist":[],"manual":[]}'; check "Attack protection: Grenze unter dem Minimum -> 422" eq "$CODE" 422
adm PUT /api/protection "{\"autoBan\":{\"enabled\":true,\"maxRequests\":600,\"maxErrors\":150,\"windowSec\":60,\"banMinutes\":60},\"whitelist\":[],\"manual\":[\"$MYIP\"]}"; check "Eigene Adresse dauerhaft sperren -> 422" eq "$CODE" 422
adm PUT /api/protection '{"autoBan":{"enabled":true,"maxRequests":600,"maxErrors":150,"windowSec":60,"banMinutes":60},"whitelist":["203.0.113.0/24"],"manual":["198.51.100.9"]}'; check "Attack protection speichern -> 200 with task" bash -c "[[ $CODE == 200 && '$BODY' == *'\"job\":'* ]]"
adm POST /api/protection/unban '{"ip":"kein-ip"}'; check "Unblock with an invalid address -> 422" eq "$CODE" 422
adm POST /api/protection/unban '{"ip":"198.51.100.9"}'; check "Unblock -> 200 with task" has "$BODY" '"job":'
adm GET /api/settings/notifications; check "GET notifications: password never in clear text" bash -c "[[ $CODE == 200 && '$BODY' == *'\"has_password\":false'* && '$BODY' != *'smtp_password'* ]]"
adm PUT /api/settings/notifications '{"smtp_host":"kein host!","smtp_port":587}'; check "SMTP server invalid -> 422" eq "$CODE" 422
adm PUT /api/settings/notifications '{"smtp_host":"smtp.example.com","smtp_port":70000}'; check "SMTP port out of range -> 422" eq "$CODE" 422
adm PUT /api/settings/notifications '{"smtp_host":"smtp.example.com","smtp_port":587,"smtp_security":"plain"}'; check "Unknown encryption -> 422" eq "$CODE" 422
adm PUT /api/settings/notifications '{"smtp_host":"smtp.example.com","smtp_port":587,"smtp_security":"starttls","enabled":true}'; check "Enable without sender and recipients -> 422" eq "$CODE" 422
adm PUT /api/settings/notifications '{"smtp_host":"smtp.example.com","smtp_port":587,"smtp_security":"starttls","smtp_user":"u","smtp_password":"geheim-xyz","smtp_from":"wm@example.com","recipients":"a@example.com\nb@example.com","enabled":true,"site_down":true,"cert":true,"cert_days":14,"jobs":true,"backup":true,"disk":true,"disk_percent":90,"update_notice":true}'; check "Benachrichtigungen speichern -> 200" eq "$CODE" 200
adm GET /api/settings/notifications; check "  Password encrypted: has_password=true, no clear text" bash -c "[[ '$BODY' == *'\"has_password\":true'* && '$BODY' != *'geheim-xyz'* ]]"
check "  not in clear text in the database" bash -c "! docker exec -i $DB mariadb -uwm -ppw wm -N -e \"SELECT v FROM settings WHERE k='smtp_pass_enc'\" 2>/dev/null | grep -q geheim-xyz"
adm POST /api/settings/notifications/test '{}'; check "Trigger test email -> Task" has "$BODY" '"job":'
adm GET /api/branding; check "GET branding -> name, default name, logo address" bash -c "[[ $CODE == 200 && '$BODY' == *'\"defaultName\"'* && '$BODY' == *'\"logoUrl\"'* ]]"
adm PUT /api/branding '{"name":"","color":""}'; check "Empty name -> 422" eq "$CODE" 422
adm PUT /api/branding '{"name":"Meine Firma","color":"#ffff00"}'; check "Accent colour too light -> 422" eq "$CODE" 422
adm PUT /api/branding '{"name":"Meine Firma","color":"kein-farbwert"}'; check "Invalid colour value -> 422" eq "$CODE" 422
adm PUT /api/branding '{"name":"Meine Firma","color":"#0a63d8"}'; check "Save name and colour -> 200" has "$BODY" '"name":"Meine Firma"'
http "$JAR" GET /api/v1/me; check "  /api/v1/me shows the new name (the shell reloads it)" has "$BODY" '"name":"Meine Firma"'
adm DELETE /api/branding; check "Reset appearance -> default name" has "$BODY" '"name":"Drimzo Development"'

echo "-- System: maintenance without agent and mandatory fields"
adm POST /api/storage/cleanup '{"categories":[]}'; check "Cleanup without category -> 422" eq "$CODE" 422
adm POST /api/storage/cleanup '{"categories":["etc"]}'; check "Cleanup with an unknown category -> 422" eq "$CODE" 422
adm POST /api/storage/cleanup '{"categories":["logs","logs","dumps"]}'; check "Cleanup with valid categories -> task" has "$BODY" '"job":'
adm GET /api/storage; check "Storage without agent -> error as JSON, no crash" bash -c "[[ $CODE != 200 && $CODE != 500 && '$BODY' == *'\"error\"'* ]]"
adm GET /api/backup; check "Backup status without agent -> error as JSON, no crash" bash -c "[[ $CODE != 200 && $CODE != 500 && '$BODY' == *'\"error\"'* ]]"
adm GET /api/update; check "Update status without agent -> error as JSON, no crash" bash -c "[[ $CODE != 200 && $CODE != 500 && '$BODY' == *'\"error\"'* ]]"
adm POST /api/backup/run '{"action":"gibt-es-nicht"}'; check "Backup with an unknown action -> 422" eq "$CODE" 422
adm POST /api/update/rollback '{"confirm":"nein"}'; check "Roll back without agent -> error as JSON" bash -c "[[ $CODE != 200 && $CODE != 500 ]]"
adm POST /api/update/auto '{"mode":"alle","from":2,"to":5}'; check "Automatic updates: unknown mode -> 422" eq "$CODE" 422
adm POST /api/update/auto '{"mode":"patch","from":25,"to":5}'; check "Automatic updates: hour 25 -> 422" eq "$CODE" 422
adm GET /api/system; check "System without agent: database ok, agent not" bash -c "[[ $CODE == 200 && '$BODY' == *'\"database\":{\"ok\":true}'* && '$BODY' == *'\"agent\":{\"ok\":false'* ]]"
adm POST /api/system/renew-certificates '{}'; check "Trigger certificate check -> task" has "$BODY" '"job":'

echo "== Sign-in warning by email and emergency access (console)"
# SMTP is configured further up (smtp.example.com): signing in queues one mail.login job for the person who signed in
adm GET /api/settings/notifications; check "Notifications: login_alert is on by default" has "$BODY" '"login_alert":true'
jobs_login() { sql "SELECT COUNT(*) FROM jobs WHERE type='mail.login'"; }
signin() { # signin <email> <password> -> sets CODE (fresh session each time)
  local jar="$TMP/alert-$RANDOM.jar"; : >"$jar"
  http "$jar" GET /api/auth/state; local c; c="$(json csrf)"
  http "$jar" POST /api/auth/login "{\"email\":\"$1\",\"password\":\"$2\"}" -H "X-CSRF-Token: $c"
}
J0="$(jobs_login)"
signin viewer@example.com "$PWD1"; check "Sign-in ok" eq "$CODE" 200
check "  exactly one warning job mail.login queued" eq "$(( $(jobs_login) - J0 ))" 1
check "  Recipient is the signed-in person, the password is not in the job" bash -c "[[ \$(docker exec -i $DB mariadb -uwm -ppw wm -N -e \"SELECT payload FROM jobs WHERE type='mail.login' ORDER BY id DESC LIMIT 1\" 2>/dev/null) == *'\"to\":\"viewer@example.com\"'* && \$(docker exec -i $DB mariadb -uwm -ppw wm -N -e \"SELECT payload FROM jobs WHERE type='mail.login' ORDER BY id DESC LIMIT 1\" 2>/dev/null) != *'Test-Passwort'* ]]"
J1="$(jobs_login)"
signin viewer@example.com "falsch"; check "Wrong password -> no warning job" bash -c "[[ $CODE == 403 && $(jobs_login) == $J1 ]]"
adm PUT /api/settings/notifications '{"smtp_host":"smtp.example.com","smtp_port":587,"smtp_security":"starttls","smtp_user":"u","smtp_from":"wm@example.com","recipients":"a@example.com","enabled":true,"login_alert":false}'; check "Anmelde-Warnung ausschalten -> 200" eq "$CODE" 200
adm GET /api/settings/notifications; check "  login_alert=false saved" has "$BODY" '"login_alert":false'
signin viewer@example.com "$PWD1"; check "Sign-in without warning -> no new job" bash -c "[[ $CODE == 200 && $(jobs_login) == $J1 ]]"
adm PUT /api/settings/notifications '{"smtp_host":"smtp.example.com","smtp_port":587,"smtp_security":"starttls","smtp_user":"u","smtp_from":"wm@example.com","recipients":"a@example.com","enabled":true}'; check "Ohne Angabe von login_alert bleibt die Warnung an" bash -c "[[ $CODE == 200 ]]"
adm GET /api/settings/notifications; check "  login_alert true again" has "$BODY" '"login_alert":true'

console() { docker run --rm -i --network "$NET" "${ENVS[@]}" "$IMAGE" php bin/console "$@"; }
OUT="$(console user:list)"; check "user:list shows accounts with role and 2FA" bash -c "[[ '$OUT' == *'viewer@example.com'* && '$OUT' == *'admin@example.com'* && '$OUT' == *'2FA:aus'* ]]"
VID2="$(sql "SELECT id FROM users WHERE email='viewer@example.com'")"
sql "UPDATE users SET totp_enabled=1, totp_secret_enc='x', totp_last_step=5 WHERE id=$VID2"
sql "INSERT INTO user_recovery_codes (user_id, code_hash) VALUES ($VID2, REPEAT('a', 64))"
sql "INSERT INTO user_passkeys (user_id, credential_id, public_key, alg, name) VALUES ($VID2, 'cred-notfall-1', 'k', -7, 'Notfall-Test')"
sql "INSERT INTO login_attempts (ip, email, success) VALUES ('2fa-test', '2fa:$VID2', 0)"
console user:list >"$TMP/list"; check "  before: 2FA on, 1 passkey" bash -c "grep -q 'viewer@example.com.*2FA:on.*Passkeys:1' '$TMP/list'"
console user:reset-2fa viewer@example.com --keep-passkeys >"$TMP/o1" 2>&1; check "user:reset-2fa --keep-passkeys -> success" bash -c "grep -q 'passkeys kept' '$TMP/o1'"
check "  Authenticator and codes gone, passkey stays" bash -c "[[ \$(docker exec -i $DB mariadb -uwm -ppw wm -N -e \"SELECT CONCAT(totp_enabled, ':', (SELECT COUNT(*) FROM user_recovery_codes WHERE user_id=$VID2), ':', (SELECT COUNT(*) FROM user_passkeys WHERE user_id=$VID2)) FROM users WHERE id=$VID2\" 2>/dev/null) == 0:0:1 ]]"
console user:reset-2fa viewer@example.com >"$TMP/o2" 2>&1; check "user:reset-2fa without option also removes the passkeys" bash -c "[[ \$(docker exec -i $DB mariadb -uwm -ppw wm -N -e \"SELECT COUNT(*) FROM user_passkeys WHERE user_id=$VID2\" 2>/dev/null) == 0 ]]"
console user:reset-2fa gibt-es-nicht@example.com >"$TMP/o3" 2>&1; check "user:reset-2fa unknown address -> error" bash -c "! docker run --rm --network $NET ${ENVS[*]} $IMAGE php bin/console user:reset-2fa gibt-es-nicht@example.com >/dev/null 2>&1"
check "  Operations are in the audit log (admin.reset_2fa_cli)" bash -c "[[ \$(docker exec -i $DB mariadb -uwm -ppw wm -N -e \"SELECT COUNT(*) FROM audit_log WHERE action='admin.reset_2fa_cli'\" 2>/dev/null) -ge 2 ]]"
console login:unlock >"$TMP/o5" 2>&1; check "login:unlock without argument lifts all lockouts" bash -c "grep -q 'All blocks' '$TMP/o5' && [[ \$(docker exec -i $DB mariadb -uwm -ppw wm -N -e \"SELECT COUNT(*) FROM login_attempts WHERE success=0\" 2>/dev/null) == 0 ]]"
for _ in 1 2 3 4 5; do signin viewer@example.com "falsch"; done
signin viewer@example.com "$PWD1"; check "After 5 failed attempts: even the correct password is locked" bash -c "[[ $CODE == 429 || $CODE == 403 ]]"
console login:unlock viewer@example.com >"$TMP/o4" 2>&1; check "login:unlock <E-Mail> -> Lockout lifted" bash -c "grep -q 'lifted' '$TMP/o4'"
signin viewer@example.com "$PWD1"; check "  afterwards sign-in possible again" eq "$CODE" 200
for n in 1 2 3 4 5 6 7 8 9 10 11; do signin "fremd$n@example.com" "falsch"; done
signin viewer@example.com "$PWD1"; check "Lockout by IP (many failed attempts): even the correct password is locked" bash -c "[[ $CODE == 429 || $CODE == 403 ]]"
BANIP="$(sql "SELECT ip FROM login_attempts WHERE success=0 ORDER BY id DESC LIMIT 1")"
console login:unlock "$BANIP" >"$TMP/o7" 2>&1; signin viewer@example.com "$PWD1"; check "login:unlock <IP> lifts the lockout" eq "$CODE" 200
console help >"$TMP/o6" 2>&1; check "Console help names the emergency access" bash -c "grep -q 'user:reset-2fa' '$TMP/o6' && grep -q 'login:unlock' '$TMP/o6'"

echo "== Audit"
check "token.create and token.revoke are logged" bash -c "[[ \$(docker exec -i $DB mariadb -uwm -ppw wm -N -e \"SELECT COUNT(DISTINCT action) FROM audit_log WHERE action IN ('token.create','token.revoke')\" 2>/dev/null) == 2 ]]"

echo
echo "Result: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
