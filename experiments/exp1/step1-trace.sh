#!/usr/bin/env bash
# Experiment 1, step 1 (pre-dev-w0-experiments 实验 1 步骤一): trace the writer's system calls while it
# commits 100 transactions, then match every commit to the sync calls issued before its ack.
# Needs root for the tracer. Run from the repository root after `pnpm install`:
#
#   experiments/exp1/step1-trace.sh <group: A|B> <output directory>
#
# Group A = durability "pglite-default" (PGlite's -F; expected: no sync calls).
# Group B = durability "host-fsync" (expected: a sync call on a pg_wal file before every ack).
# Linux: strace (fsync, fdatasync, sync_file_range, msync, open/openat with flags, fcntl).
# macOS: fs_usage (works with System Integrity Protection on; dtruss needs it off). F_FULLFSYNC is
# fcntl command 51 and F_BARRIERFSYNC 85 in <sys/fcntl.h>; fs_usage prints the fcntl command by name
# or number depending on the release, so the raw output is kept for reading by hand.
set -euo pipefail

group="${1:?group A or B}"
out="${2:?output directory}"
case "$group" in
  A) durability=pglite-default ;;
  B) durability=host-fsync ;;
  *) echo "group must be A or B" >&2; exit 2 ;;
esac
mkdir -p "$out"
out="$(cd "$out" && pwd)"
here="$(cd "$(dirname "$0")/../.." && pwd)"
run() { node --conditions=source --no-warnings "$here/experiments/$1" "${@:2}"; }

tenant="$(mktemp -d)/tenant"
port=47801
run exp1/observer.ts --port "$port" > "$out/observer.jsonl" &
observer=$!
sleep 1

{
  echo "date: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "uname: $(uname -a)"
  echo "node: $(node --version)"
  echo "group: $group ($durability)"
  [ "$(uname)" = Darwin ] && sw_vers
} > "$out/environment.txt"

if [ "$(uname)" = Linux ]; then
  # Run the writer under strace from the start; -f follows the DB Worker thread.
  strace -f -ttt -y -o "$out/trace.txt" \
    -e trace=fsync,fdatasync,sync_file_range,msync,open,openat,fcntl \
    node --conditions=source --no-warnings "$here/experiments/exp1/writer.ts" \
    --dir "$tenant" --durability "$durability" --observer "127.0.0.1:$port" --max 100 --trace \
    > "$out/writer.jsonl"
  tracer=linux-strace
else
  # Start the writer, attach fs_usage to its pid during the writer's start-up delay.
  run exp1/writer.ts --dir "$tenant" --durability "$durability" --observer "127.0.0.1:$port" \
    --max 100 --trace --delay 5000 > "$out/writer.jsonl" &
  writer=$!
  until grep -q '"ready"' "$out/writer.jsonl" 2>/dev/null; do sleep 0.2; done
  sudo fs_usage -w -f filesys "$writer" > "$out/trace.txt" &
  tracer_pid=$!
  wait "$writer"
  sleep 1
  sudo kill -INT "$tracer_pid" || true
  wait "$tracer_pid" || true
  tracer=macos-fs_usage
fi
kill "$observer" || true

run exp1/step1-analyze.ts --tracer "$tracer" --trace "$out/trace.txt" --writer "$out/writer.jsonl" \
  | tee "$out/analysis.json"
echo "raw trace: $out/trace.txt"
