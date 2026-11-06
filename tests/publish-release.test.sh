#!/usr/bin/env bash
# Tests scripts/publish-release.sh against a simulated GitHub (fake curl, no network):
#   new release, resuming a release without archive, refusing a complete release, failing uploads are reported.
set -Eeuo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
PASS=0; FAIL=0
ok() { PASS=$((PASS + 1)); echo "ok   $1"; }
bad() { FAIL=$((FAIL + 1)); echo "FAIL $1"; }
expect() { # expect NAME PATTERN FILE
  if grep -Eq -- "$2" "$3"; then ok "$1"; else bad "$1 (pattern '$2' not found)"; sed 's/^/     | /' "$3" | head -20; fi
}
absent() { if grep -Eq -- "$2" "$3"; then bad "$1 (unexpected '$2')"; else ok "$1"; fi; }

# a throw-away clone: the script wants a clean, pushed work tree
git clone -q --bare "$ROOT" "$TMP/origin.git"
git clone -q "$TMP/origin.git" "$TMP/repo"
git -C "$TMP/repo" config user.email t@example.com; git -C "$TMP/repo" config user.name t
# CI checks out a detached HEAD: the clone needs a real branch to commit and push
git -C "$TMP/repo" checkout -q -B testbranch
# test the script as it is in the work tree (it may not be committed yet), committed and pushed inside the clone
cp "$ROOT/scripts/publish-release.sh" "$TMP/repo/scripts/publish-release.sh"
git -C "$TMP/repo" commit -q -am "test copy" 2>/dev/null || true
git -C "$TMP/repo" push -q origin testbranch 2>/dev/null
VERSION="$(tr -d '[:space:]' <"$TMP/repo/VERSION")"
NAME="webmanager-$VERSION"

# fake curl: behaviour is chosen by $FAKE_MODE; every call is logged to $TMP/calls
mkdir -p "$TMP/bin"
cat >"$TMP/bin/curl" <<'EOF'
#!/usr/bin/env bash
cfg="$(cat)"   # the script passes the auth header through stdin (-K -)
method=GET; url=""; out=""; wfmt=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    -X) method="$2"; shift ;;
    -o) out="$2"; shift ;;
    -w) wfmt="$2"; shift ;;
    http*) url="$1" ;;
  esac
  shift
done
echo "$method $url" >>"$FAKE_CALLS"
body=""; code=200
case "$method $url" in
  "GET "*"/releases/tags/"*)
    case "$FAKE_MODE" in
      new) code=404; body='{"message":"not found"}' ;;
      noassets) code=200; body='{"id":77,"tag_name":"x","assets":[]}' ;;
      complete) code=200; body="{\"id\":78,\"assets\":[{\"name\":\"$FAKE_NAME.tar.gz\"},{\"name\":\"$FAKE_NAME.tar.gz.sha256\"}]}" ;;
      half) code=200; body="{\"id\":79,\"assets\":[{\"name\":\"$FAKE_NAME.tar.gz\"}]}" ;;
      error) code=500; body='{}' ;;
    esac ;;
  "POST "*"/releases") code=201; body='{"id":88}' ;;
  "POST "*"/assets?name="*)
    if [[ "$FAKE_UPLOAD" == "fail" ]]; then echo "curl: (56) simulated failure" >&2; exit 56; fi
    code=201 ;;
esac
[[ -n "$out" && "$out" != /dev/null ]] && printf '%s' "$body" >"$out"
if [[ -z "$out" ]]; then printf '%s' "$body"; fi
[[ -n "$wfmt" ]] && printf '%s' "$code"
exit 0
EOF
chmod +x "$TMP/bin/curl"

run() { # run MODE [UPLOAD]  -> output in $TMP/out, calls in $TMP/calls
  : >"$TMP/calls"
  PATH="$TMP/bin:$PATH" FAKE_MODE="$1" FAKE_UPLOAD="${2:-ok}" FAKE_CALLS="$TMP/calls" FAKE_NAME="$NAME" GITHUB_TOKEN="abcdefghijklmnopqrstuvwxyz0123" \
    bash "$TMP/repo/scripts/publish-release.sh" --notes "Test ä ö" >"$TMP/out" 2>&1 && echo 0 >"$TMP/rc" || echo $? >"$TMP/rc"
}

run new
expect "new release: created and published" "published" "$TMP/out"
expect "new release: release created" "POST .*/releases$" "$TMP/calls"
expect "new release: both files uploaded" "assets\\?name=$NAME.tar.gz.sha256" "$TMP/calls"

run noassets
expect "incomplete release: announced" "without an archive" "$TMP/out"
absent "incomplete release: not created a second time" "POST .*/releases$" "$TMP/calls"
expect "incomplete release: archive uploaded to the existing id" "POST .*/releases/77/assets\\?name=$NAME.tar.gz$" "$TMP/calls"
expect "incomplete release: checksum uploaded" "POST .*/releases/77/assets\\?name=$NAME.tar.gz.sha256$" "$TMP/calls"
expect "incomplete release: success message" "published" "$TMP/out"

run half
absent "half-complete release: existing archive is not uploaded again" "assets\\?name=$NAME.tar.gz$" "$TMP/calls"
expect "half-complete release: missing checksum is uploaded" "releases/79/assets\\?name=$NAME.tar.gz.sha256" "$TMP/calls"

run complete
expect "complete release: refused" "already exists and is complete" "$TMP/out"
[[ "$(cat "$TMP/rc")" != 0 ]] && ok "complete release: non-zero exit" || bad "complete release: non-zero exit"

run error
expect "server error on lookup: reported" "Querying release .* failed \\(HTTP 500\\)" "$TMP/out"

run new fail
expect "failing upload is reported, not silent" "Upload of .* failed" "$TMP/out"
[[ "$(cat "$TMP/rc")" != 0 ]] && ok "failing upload: non-zero exit" || bad "failing upload: non-zero exit"

echo "$PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]
