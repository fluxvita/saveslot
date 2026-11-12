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
# Background jobs below start node directly (not through a shell function), so `$!` is node's pid
# and not a subshell's: the tracer must attach to the writer itself, and the observer must be the
# process that gets killed.
node_run=(node --conditions=source --no-warnings)

tenant="$(mktemp -d)/tenant"
observer=""
tracer_pid=""
# INT lets fs_usage flush its output; a background job may have INT ignored, so fall back to TERM.
# Liveness via ps: the tracer runs as root, and `kill -0` from this user fails with EPERM.
alive() { ps -p "$1" > /dev/null 2>&1; }
stop_tracer() {
  sudo kill -INT "$tracer_pid" 2>/dev/null || true
  for _ in $(seq 50); do alive "$tracer_pid" || break; sleep 0.1; done
  if alive "$tracer_pid"; then sudo kill -TERM "$tracer_pid" 2>/dev/null || true; fi
  wait "$tracer_pid" 2>/dev/null || true
  tracer_pid=""
}
cleanup() {
  [ -n "$tracer_pid" ] && stop_tracer
  [ -n "$observer" ] && kill "$observer" 2>/dev/null || true
}
trap cleanup EXIT

# Port 0: the observer picks a free port and reports it, so a leftover observer cannot collide.
"${node_run[@]}" "$here/experiments/exp1/observer.ts" --port 0 > "$out/observer.jsonl" &
observer=$!
until grep -q '"listening"' "$out/observer.jsonl" 2>/dev/null; do
  kill -0 "$observer" 2>/dev/null || { echo "observer exited before listening" >&2; exit 1; }
  sleep 0.1
done
port="$(sed -n 's/.*"port":\([0-9]*\).*/\1/p' "$out/observer.jsonl" | head -n 1)"

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
  "${node_run[@]}" "$here/experiments/exp1/writer.ts" --dir "$tenant" --durability "$durability" \
    --observer "127.0.0.1:$port" --max 100 --trace --delay 5000 > "$out/writer.jsonl" &
  writer=$!
  until grep -q '"ready"' "$out/writer.jsonl" 2>/dev/null; do
    kill -0 "$writer" 2>/dev/null || { echo "writer exited before ready" >&2; exit 1; }
    sleep 0.2
  done
  # Attach to the pid the writer reports about itself, and refuse if it is not the job we started.
  ready_pid="$(sed -n 's/.*"ready":true,"pid":\([0-9]*\).*/\1/p' "$out/writer.jsonl" | head -n 1)"
  if [ "$ready_pid" != "$writer" ]; then
    echo "writer reports pid '$ready_pid' but the background job is $writer; not tracing" >&2
    exit 1
  fi
  sudo fs_usage -w -f filesys "$ready_pid" > "$out/trace.txt" &
  tracer_pid=$!
  wait "$writer"
  sleep 1
  stop_tracer
  tracer=macos-fs_usage
fi
kill "$observer" || true
observer=""

"${node_run[@]}" "$here/experiments/exp1/step1-analyze.ts" --tracer "$tracer" --trace "$out/trace.txt" --writer "$out/writer.jsonl" \
  | tee "$out/analysis.json"
echo "raw trace: $out/trace.txt"
