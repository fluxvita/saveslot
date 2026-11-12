#!/usr/bin/env bash
# Experiment 1, step 3 on a desktop Mac (pre-dev-w0-experiments 实验 1 步骤三): one round per real
# power pull. The observer runs on ANOTHER machine; this script runs on the Mac under test, once
# after every boot, from the repository root:
#
#   OBSERVER=<host>:<port> experiments/exp1/power-round-macos.sh <A|B> <output directory>
#
# It checks the data left by the previous round against the observer's confirmed number, then
# starts the writer again and returns. Then pull the power cord at a moment of your choosing
# (at least 3 s later), wait 10 s, restore power, boot, and run this script again.
set -euo pipefail

group="${1:?A or B}"; out="${2:?output directory}"
case "$group" in A) durability=pglite-default ;; B) durability=host-fsync ;; *) exit 2 ;; esac
: "${OBSERVER:?host:port of the observer on the other machine}"
mkdir -p "$out"
run() { node --conditions=source --no-warnings "experiments/$1" "${@:2}"; }
tenant="$HOME/saveslot-exp1-$group/tenant"
host="${OBSERVER%:*}"; port="${OBSERVER##*:}"

if [ -d "$tenant" ]; then
  confirmed="$(run exp1/observer-max.ts --host "$host" --port "$port")"
  result="$(run exp1/check.ts --dir "$tenant" --durability "$durability" --confirmed "$confirmed" || true)"
  echo "{\"at\":\"$(date -u +%FT%TZ)\",\"confirmed\":$confirmed,\"check\":$result}" | tee -a "$out/rounds.jsonl"
fi
nohup node --conditions=source --no-warnings experiments/exp1/writer.ts --dir "$tenant" \
  --durability "$durability" --observer "$OBSERVER" > "$out/writer-$(date +%s).log" 2>&1 &
echo "writer started (pid $!); pull the power cord when ready"
