#!/usr/bin/env bash
# Builds the release for the version in ./VERSION and publishes it as a GitHub release
# (tag = version, assets: tar.gz + .sha256 [+ .asc]). Runs on the DEVELOPMENT machine.
#
#   export GITHUB_TOKEN=...   (token with "Contents: read and write" on the repository; never commit it)
#   scripts/publish-release.sh [--repo Owner/name] [--notes "Text"] [--sign GPG-KEY-ID] [--draft]
#
# The commit must be pushed first: GitHub creates the tag from the pushed commit.
set -Eeuo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
REPO="drimzo/webmanager"; NOTES=""; SIGN=""; DRAFT=false; TOKEN_FILE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo) REPO="${2:?}"; shift ;;
    --notes) NOTES="${2:?}"; shift ;;
    --sign) SIGN="${2:?}"; shift ;;
    --token-file) TOKEN_FILE="${2:?}"; shift ;;
    --draft) DRAFT=true ;;
    -h|--help) sed -n '2,10p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
  shift
done

die() { echo "✘ $*" >&2; exit 1; }
[[ "$REPO" =~ ^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$ ]] || die "The repo must have the form owner/name."
if [[ -n "$TOKEN_FILE" ]]; then GITHUB_TOKEN="$(head -n1 "$TOKEN_FILE" | tr -d '[:space:]')"; fi
[[ -n "${GITHUB_TOKEN:-}" ]] || die "GITHUB_TOKEN (or --token-file) is missing."
[[ "$GITHUB_TOKEN" =~ ^[A-Za-z0-9_.-]{20,}$ ]] || die "GITHUB_TOKEN has no valid format."

VERSION="$(tr -d '[:space:]' <"$ROOT/VERSION")"
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z.]+)?$ ]] || die "Invalid version in VERSION: $VERSION"
NAME="webmanager-$VERSION"

# the token goes to curl through stdin so it does not appear in the process list
api() { # api METHOD PATH [curl args...]   (PATH relative to the repository; a full https:// URL is used as it is)
  local method="$1" path="$2"; shift 2
  [[ "$path" == https://* ]] || path="https://api.github.com/repos/$REPO/$path"
  printf 'header = "Authorization: Bearer %s"\n' "$GITHUB_TOKEN" | curl -sS --proto '=https' --tlsv1.2 -K - -X "$method" -H 'Accept: application/vnd.github+json' -H 'X-GitHub-Api-Version: 2022-11-28' "$path" "$@"
}

cd "$ROOT"
if command -v git >/dev/null && [[ -d .git ]]; then
  [[ -z "$(git status --porcelain)" ]] || die "The working directory has uncommitted changes. Commit and push first."
  SHA="$(git rev-parse HEAD)"
  git fetch --quiet origin || die "git fetch failed."
  [[ -n "$(git branch -r --contains "$SHA" 2>/dev/null)" ]] || die "The current commit is not pushed. Run 'git push' first."
else
  die "No Git repository found."
fi

OUT="$(mktemp -d)"; trap 'rm -rf "$OUT"' EXIT
# A release that exists but misses its archive (an earlier run stopped during the upload) is completed instead of refused.
RESUME_ID=""
code="$(api GET "releases/tags/$VERSION" -o "$OUT/existing.json" -w '%{http_code}')" || die "GitHub not reachable (curl error while querying release $VERSION)."
if [[ "$code" == "200" ]]; then
  if grep -Eq "\"name\": *\"$NAME.tar.gz\"" "$OUT/existing.json" && grep -Eq "\"name\": *\"$NAME.tar.gz.sha256\"" "$OUT/existing.json"; then
    die "Release/tag $VERSION already exists and is complete. Increase the version in VERSION."
  fi
  RESUME_ID="$(grep -o '"id": *[0-9]*' "$OUT/existing.json" | head -n1 | cut -d: -f2 | tr -d ' ' || true)"
  [[ -n "$RESUME_ID" ]] || die "Release $VERSION exists, but its ID could not be read."
  echo "Release $VERSION already exists but without an archive – the files are uploaded now."
elif [[ "$code" != "404" ]]; then
  die "Querying release $VERSION failed (HTTP $code). Check the token and address."
fi

echo "Baue Release $VERSION …"
if [[ -n "$SIGN" ]]; then bash scripts/make-release.sh --out "$OUT" --sign "$SIGN" >/dev/null; else bash scripts/make-release.sh --out "$OUT" >/dev/null; fi
[[ -f "$OUT/$NAME.tar.gz" && -f "$OUT/$NAME.tar.gz.sha256" ]] || die "The release files were not created."

if [[ -z "$RESUME_ID" ]]; then
body="${NOTES:-WebManager $VERSION}"
# Non-ASCII characters are written as \uXXXX and the body is sent from a file: Windows shells hand curl its arguments
# in the ANSI code page, which corrupts UTF-8 (umlauts, typographic quotes) in the release notes.
node -e 'process.stdout.write(JSON.stringify({tag_name:process.argv[1],target_commitish:process.argv[2],name:process.argv[1],body:process.argv[3],draft:process.argv[4]==="true",prerelease:false}).replace(/[^\x00-\x7f]/g,(c)=>"\\u"+c.charCodeAt(0).toString(16).padStart(4,"0")))' "$VERSION" "$SHA" "$body" "$DRAFT" >"$OUT/payload.json" 2>/dev/null \
  || printf '{"tag_name":"%s","target_commitish":"%s","name":"%s","body":"WebManager %s","draft":%s,"prerelease":false}' "$VERSION" "$SHA" "$VERSION" "$VERSION" "$DRAFT" >"$OUT/payload.json"
resp="$(api POST releases -H 'Content-Type: application/json' --data-binary "@$OUT/payload.json")"
id="$(printf '%s' "$resp" | grep -o '"id": *[0-9]*' | head -n1 | cut -d: -f2 | tr -d ' ' || true)"
[[ -n "$id" ]] || die "The release could not be created: $(printf '%s' "$resp" | head -c 300)"
else
  id="$RESUME_ID"
fi

# a failing curl must not end the script silently (set -e): report it with the release state
up() { api POST "https://uploads.github.com/repos/$REPO/releases/$id/assets?name=$(basename "$1")" -H 'Content-Type: application/octet-stream' --data-binary "@$1" -o /dev/null -w '%{http_code}' || printf 'curl-Fehler'; }
for f in "$OUT/$NAME.tar.gz" "$OUT/$NAME.tar.gz.sha256" ${SIGN:+"$OUT/$NAME.tar.gz.asc"}; do
  if [[ -n "$RESUME_ID" ]] && grep -Eq "\"name\": *\"$(basename "$f")\"" "$OUT/existing.json"; then echo "  ✔ $(basename "$f") (already present)"; continue; fi
  c="$(up "$f")"
  [[ "$c" == 201 || "$c" == 200 ]] || die "Upload of $(basename "$f") failed (HTTP $c). Release $VERSION is created but incomplete – just run the script again, it uploads the missing files."
  echo "  ✔ $(basename "$f")"
done
echo "SHA-256: $(awk '{print $1}' "$OUT/$NAME.tar.gz.sha256")"
echo "✔ Release $VERSION published: https://github.com/$REPO/releases/tag/$VERSION"
