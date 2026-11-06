#!/usr/bin/env bash
# Unit test for scripts/update-helper.sh (no network, no root, no systemd): mocked curl, flock and update.sh.
set -Eeuo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
fail=0
check() { if [[ "$2" == "$3" ]]; then echo "  PASS  $1"; else echo "  FAIL  $1 (expected '$3', got '$2')"; fail=1; fi; }

INST="$T/inst"; DATA="$T/data"; LOGS="$T/logs"; BIN="$T/bin"
mkdir -p "$INST/scripts" "$DATA/update" "$LOGS" "$BIN"
cp "$ROOT/scripts/lib.sh" "$ROOT/scripts/update-helper.sh" "$INST/scripts/"
printf 'DATA_DIR=%s\nLOG_DIR=%s\n' "$DATA" "$LOGS" >"$INST/.env"
# fake update.sh records its arguments; FAKE_UPDATE_EXIT decides the result
cat >"$INST/update.sh" <<EOS
#!/usr/bin/env bash
echo "\$*" >>"$T/update.calls"
exit "\${FAKE_UPDATE_EXIT:-0}"
EOS
printf '#!/usr/bin/env bash\nexit 0\n' >"$BIN/flock"
cat >"$BIN/curl" <<EOS
#!/usr/bin/env bash
if [[ "\${FAKE_CURL_FAIL:-0}" == "1" ]]; then echo "curl: (22) The requested URL returned error: 401" >&2; exit 22; fi
case "\$*" in
  *releases.json*)
    if [[ -z "\${FAKE_RELEASES_BODY:-}" ]]; then echo "curl: (22) The requested URL returned error: 404" >&2; exit 22; fi
    out=""; prev=""; for a in "\$@"; do [[ "\$prev" == "-o" ]] && out="\$a"; prev="\$a"; done
    if [[ -n "\$out" ]]; then printf '%s' "\$FAKE_RELEASES_BODY" >"\$out"; else printf '%s' "\$FAKE_RELEASES_BODY"; fi ;;
  *MIN_SUPPORTED*) if [[ -n "\${FAKE_MIN_BODY:-}" ]]; then printf '%s' "\$FAKE_MIN_BODY"; else echo "curl: (22) The requested URL returned error: 404" >&2; exit 22; fi ;;
  *) printf '%s' "\$FAKE_CURL_BODY" ;;
esac
EOS
chmod +x "$INST/update.sh" "$INST/scripts/update-helper.sh" "$BIN/flock" "$BIN/curl"
export PATH="$BIN:$PATH" WM_INSTALL_DIR="$INST" WM_LOCK_FILE="$T/lock"
H="$INST/scripts/update-helper.sh"
: >"$T/update.calls"

export FAKE_CURL_BODY='0.6.0'
printf 'check\n' >"$DATA/update/request"
"$H" apply >/dev/null 2>&1 || true
check "check writes the newest version of the update server" "$(cat "$DATA/update/latest.json")" '[{"tag_name":"0.6.0"}]'
check "meta.json has no minimum without a MIN_SUPPORTED file" "$(grep -c '"minSupported":""' "$DATA/update/meta.json")" "1"
check "Without releases.json on the server no file is left behind" "$(ls "$DATA/update" | grep -c '^releases.json')" "0"
FAKE_RELEASES_BODY='{"releases":[{"version":"0.6.0","notes":"Note","published":"2026-11-05T18:58:47Z"}]}' "$H" refresh >/dev/null 2>&1
check "releases.json of the server is stored for the dashboard" "$(grep -c '"notes":"Note"' "$DATA/update/releases.json")" "1"
check "No temporary file is left behind" "$(ls "$DATA/update" | grep -c 'releases.json.tmp')" "0"
FAKE_CURL_FAIL=1 "$H" refresh >/dev/null 2>&1
check "An error during the check keeps the stored releases.json" "$(grep -c '"notes":"Note"' "$DATA/update/releases.json")" "1"
FAKE_MIN_BODY=$'0.5.0\n' "$H" refresh >/dev/null 2>&1
check "MIN_SUPPORTED of the server ends up in meta.json" "$(grep -c '"minSupported":"0.5.0"' "$DATA/update/meta.json")" "1"
FAKE_MIN_BODY='<html>no</html>' "$H" refresh >/dev/null 2>&1
check "An invalid MIN_SUPPORTED is ignored" "$(grep -c '"minSupported":""' "$DATA/update/meta.json")" "1"
FAKE_MIN_BODY='0.5.0' "$H" refresh >/dev/null 2>&1
FAKE_CURL_FAIL=1 "$H" refresh >/dev/null 2>&1
check "Server not reachable: the known minimum is kept" "$(grep -c '"minSupported":"0.5.0"' "$DATA/update/meta.json")" "1"
"$H" refresh >/dev/null 2>&1
check "Request is consumed" "$([[ -e "$DATA/update/request" ]] && echo there || echo gone)" "gone"
check "meta.json without error" "$(grep -c '"error":""' "$DATA/update/meta.json")" "1"
check "check does not start an update" "$(wc -c <"$T/update.calls" | tr -d ' ')" "0"

printf 'update 0.6.0\n' >"$DATA/update/request"
"$H" apply >/dev/null 2>&1 || true
check "update calls update.sh with a fixed version" "$(cat "$T/update.calls")" "--non-interactive --yes --version 0.6.0"
check "Status ok" "$(grep -c '"state":"ok","version":"0.6.0"' "$DATA/update/state.json")" "1"
logname="$(sed -n 's/.*"log":"\([^"]*\)".*/\1/p' "$DATA/update/state.json")"
check "Log name matches the pattern of the agent" "$([[ "$logname" =~ ^update-request-[0-9]{8}-[0-9]{6}\.log$ ]] && echo yes || echo no)" "yes"

: >"$T/update.calls"
for bad in 'update 1.0; rm -rf /' 'update ../../x' 'update' 'format' 'update 0.6.0 --allow-downgrade'; do
  printf '%s\n' "$bad" >"$DATA/update/request"
  "$H" apply >/dev/null 2>&1 || true
done
check "invalid requests start nothing" "$(wc -c <"$T/update.calls" | tr -d ' ')" "0"

FAKE_UPDATE_EXIT=1 bash -c 'printf "update 0.7.0\n" >"$0/update/request"; "$1" apply' "$DATA" "$H" >/dev/null 2>&1
check "fehlgeschlagenes Update wird als failed vermerkt" "$(grep -c '"state":"failed","version":"0.7.0"' "$DATA/update/state.json")" "1"

cp "$DATA/update/latest.json" "$T/latest.keep"
FAKE_CURL_FAIL=1 "$H" refresh >/dev/null 2>&1
check "An error during the check leaves the old list unchanged" "$(cmp -s "$DATA/update/latest.json" "$T/latest.keep" && echo same || echo different)" "same"
check "Error ends up in meta.json" "$(grep -c 'Update server not reachable' "$DATA/update/meta.json")" "1"
check "meta.json stays valid JSON" "$(node -e 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log("ok")' "$DATA/update/meta.json" 2>/dev/null || echo kaputt)" "ok"

# ------------------------------------------------------------------ automatic updates of patch versions
echo 0.7.1 >"$INST/VERSION"
: >"$T/update.calls"; rm -f "$DATA/update/state.json"
hour=$((10#$(date +%H)))
cfg() { printf '{"mode":"%s","from":%s,"to":%s}\n' "$1" "$2" "$3" >"$DATA/update/auto.json"; }
releases='[{"tag_name":"0.8.0"},{"tag_name":"0.7.3"},{"tag_name":"v0.7.2"},{"tag_name":"0.7.1"},{"tag_name":"0.6.9"}]'
printf '%s\n' "$releases" >"$DATA/update/latest.json"
calls() { wc -l <"$T/update.calls" | tr -d ' '; }

cfg off 0 0; rm -f "$DATA/update/auto-state.json"; "$H" auto >/dev/null 2>&1 || true
check "Auto update off: nothing happens" "$(calls)" "0"

cfg patch $(( (hour + 1) % 24 )) $(( (hour + 2) % 24 )); "$H" auto >/dev/null 2>&1 || true
check "Outside the time window: nothing happens" "$(calls)" "0"

cfg patch "$hour" "$hour"; rm -f "$DATA/update/auto-state.json"; "$H" auto >/dev/null 2>&1 || true
check "In the window: newest patch version of the same minor version (0.7.3, not 0.8.0)" "$(cat "$T/update.calls")" "--non-interactive --yes --version 0.7.3"
check "Automatic updates are marked in the status" "$(grep -c '"auto":true' "$DATA/update/state.json")" "1"
check "Auto state: ok" "$(grep -c '"state":"ok"' "$DATA/update/auto-state.json")" "1"

: >"$T/update.calls"; "$H" auto >/dev/null 2>&1 || true
check "At most one attempt in 20 hours" "$(calls)" "0"

printf '{"version":"0.7.3","state":"failed","at":"t","epoch":1}\n' >"$DATA/update/auto-state.json"; "$H" auto >/dev/null 2>&1 || true
check "Paused for this version after a failure (even after days)" "$(calls)" "0"

printf '[{"tag_name":"0.7.4"}]\n' >"$DATA/update/latest.json"; "$H" auto >/dev/null 2>&1 || true
check "An even newer patch version is tried again" "$(cat "$T/update.calls")" "--non-interactive --yes --version 0.7.4"

: >"$T/update.calls"; rm -f "$DATA/update/auto-state.json"; printf '[{"tag_name":"0.7.1"},{"tag_name":"0.7.0"}]\n' >"$DATA/update/latest.json"; "$H" auto >/dev/null 2>&1 || true
check "No newer version: nothing happens" "$(calls)" "0"

printf '[{"tag_name":"0.7.9"}]\n' >"$DATA/update/latest.json"; rm -f "$DATA/update/auto-state.json"; touch "$DATA/update/latest.json"
FAKE_UPDATE_EXIT=1 "$H" auto >/dev/null 2>&1 || true
check "Failed auto update: state failed and state.json failed" "$(grep -c '"state":"failed"' "$DATA/update/auto-state.json"):$(grep -c '"state":"failed"' "$DATA/update/state.json")" "1:1"

# the window may wrap around midnight (fake clock: only "date +%H" is replaced)
REAL_DATE="$(command -v date)"
cat >"$BIN/date" <<EOS
#!/usr/bin/env bash
if [[ "\$*" == "+%H" && -n "\${FAKE_HOUR:-}" ]]; then echo "\$FAKE_HOUR"; else exec "$REAL_DATE" "\$@"; fi
EOS
chmod +x "$BIN/date"
wrap() { # wrap FAKE_HOUR FROM TO -> number of update runs
  printf '[{"tag_name":"0.7.9"}]\n' >"$DATA/update/latest.json"; touch "$DATA/update/latest.json"
  : >"$T/update.calls"; rm -f "$DATA/update/auto-state.json"; cfg patch "$2" "$3"
  FAKE_HOUR="$1" "$H" auto >/dev/null 2>&1 || true; calls
}
check "Window 22-03: 01:00 is in the window" "$(wrap 01 22 3)" "1"
check "Window 22-03: 23:00 is in the window" "$(wrap 23 22 3)" "1"
check "Window 22-03: 03:00 is no longer in the window (end exclusive)" "$(wrap 03 22 3)" "0"
check "Window 22-03: 12:00 is outside" "$(wrap 12 22 3)" "0"
check "Window 2-5: 02:00 is in the window" "$(wrap 02 2 5)" "1"

# ------------------------------------------------------------------ rollback request from the dashboard
printf '#!/usr/bin/env bash\necho "rollback.sh $*" >>"%s/update.calls"\nexit "${FAKE_ROLLBACK_EXIT:-0}"\n' "$T" >"$INST/scripts/rollback.sh"; chmod +x "$INST/scripts/rollback.sh"
: >"$T/update.calls"; printf 'rollback\n' >"$DATA/update/request"; "$H" apply >/dev/null 2>&1 || true
check "Request 'rollback' calls rollback.sh without parameters except --yes" "$(cat "$T/update.calls")" "rollback.sh --yes --non-interactive"
check "State: ok with kind rollback" "$(grep -c '"state":"ok"' "$DATA/update/state.json"):$(grep -c '"kind":"rollback"' "$DATA/update/state.json")" "1:1"
printf 'rollback\n' >"$DATA/update/request"; FAKE_ROLLBACK_EXIT=1 "$H" apply >/dev/null 2>&1 || true
check "Failed roll back: state failed" "$(grep -c '"state":"failed"' "$DATA/update/state.json")" "1"
printf 'update 0.7.9\n' >"$DATA/update/request"; "$H" apply >/dev/null 2>&1 || true
check "After that the state is 'update' again" "$(grep -c '"kind":"update"' "$DATA/update/state.json")" "1"
printf 'rollback; reboot\n' >"$DATA/update/request"; : >"$T/update.calls"; "$H" apply >/dev/null 2>&1 || true
check "Manipulated request is ignored" "$(wc -c <"$T/update.calls" | tr -d ' ')" "0"
exit "$fail"
