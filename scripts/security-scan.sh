#!/usr/bin/env bash
# Scans the container images of this installation for known vulnerabilities (Trivy, HIGH/CRITICAL, fixable only).
#
#   scripts/security-scan.sh                 all images used by the stack, the runtimes and the tools
#   scripts/security-scan.sh IMAGE [IMAGE…]  only the given images
#   --warn-third-party                       findings in images that are not built from this tree (not drimzo/…) are shown as a
#                                            warning and do not change the exit code (used by the CI: only upstream can fix them)
#
# Exit code 1 if any finding is reported. Needs Docker; Trivy runs in a throw-away container
# (the Docker socket is mounted read-only into that scanner container only for the duration of the scan).
set -Eeuo pipefail
TRIVY_IMAGE="aquasec/trivy:0.75.0"
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
export MSYS_NO_PATHCONV=1

WARN_THIRD=0
args=()
for a in "$@"; do
  case "$a" in
    --warn-third-party) WARN_THIRD=1 ;;
    *) args+=("$a") ;;
  esac
done

if [[ ${#args[@]} -gt 0 ]]; then
  images=("${args[@]}")
else
  mapfile -t images < <(
    {
      if [[ -f "$ROOT/.env" ]]; then docker compose --project-directory "$ROOT" -f "$ROOT/docker-compose.yml" --env-file "$ROOT/.env" config --images 2>/dev/null; fi
      grep -oE '"image": "[^"]+"' "$ROOT/templates/runtimes.json" | cut -d'"' -f4
    } | sort -u
  )
fi
[[ ${#images[@]} -gt 0 ]] || { echo "No images found." >&2; exit 2; }

# The official database images ship `gosu`, a Go binary that only drops root privileges while the container starts (it never
# listens or talks to the network). Its Go standard library findings can only be fixed upstream; the pinned versions are the
# newest ones. They are left out of the scan so that real findings stay visible; check again with every new database image.
skip_for() {
  case "$1" in
    mariadb:*|postgres:*|*/mariadb:*|*/postgres:*) printf '%s\n' --skip-files usr/local/bin/gosu --skip-files /usr/local/bin/gosu ;;
  esac
}

status=0
for img in "${images[@]}"; do
  docker image inspect "$img" >/dev/null 2>&1 || { echo "-- $img: not available locally (skipped)"; continue; }
  echo "== $img"
  mapfile -t skip < <(skip_for "$img")
  out="$(docker run --rm -v /var/run/docker.sock:/var/run/docker.sock:ro -v wm-trivy-cache:/root/.cache "$TRIVY_IMAGE" image --quiet --scanners vuln --severity HIGH,CRITICAL --ignore-unfixed "${skip[@]}" --format table "$img" 2>&1)" || true
  if grep -qE 'Total: [1-9]' <<<"$out"; then
    echo "$out"
    if [[ $WARN_THIRD -eq 1 && "$img" != drimzo/* ]]; then
      echo "   WARNING: findings in a third-party image ($img): only the image maintainers can fix them (bump the pinned version when a newer one exists)"
    else
      status=1
    fi
  else
    echo "   no fixable HIGH/CRITICAL findings"
  fi
done
exit "$status"
