#!/bin/sh
# Builds the server mode's container image from the repository root, tagged with the entry package's
# version: deploy/build-image.sh [<tag>] (default saveslot:<version>). Any other argument after the
# tag goes to `docker build` as it is (`--platform linux/arm64`, `--push`, …).
set -eu
root=$(cd "$(dirname "$0")/.." && pwd)
version=$(node -p "require('$root/packages/saveslot/package.json').version")
tag=${1:-saveslot:$version}
[ $# -gt 0 ] && shift
exec docker build -f "$root/deploy/Dockerfile" -t "$tag" "$@" "$root"
