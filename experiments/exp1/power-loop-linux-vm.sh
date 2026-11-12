#!/usr/bin/env bash
# Experiment 1, step 3 on Linux (pre-dev-w0-experiments 实验 1 步骤三): the writer runs in a VM,
# the observer on the host; every round hard-stops the VM at a random moment (the VM process is
# killed, the guest is not shut down), boots it again and runs the checks inside it.
#
# Run on the HOST, from the repository root. Prerequisites (see the experiment 1 report):
#   - a libvirt domain $VM (Linux, ext4) whose disk uses cache mode $DISK_CACHE (record it); the
#     repository is checked out in the guest at $GUEST_REPO with `pnpm install` done;
#   - passwordless ssh from the host to the guest as $GUEST_SSH; the guest reaches the host at
#     $HOST_ADDR;
#   - this repository with `pnpm install` done on the host as well (observer).
#
#   VM=exp1 GUEST_SSH=user@guest GUEST_REPO=/home/user/saveslot HOST_ADDR=192.168.122.1 \
#   DISK_CACHE=none experiments/exp1/power-loop-linux-vm.sh <A|B> <rounds> <output directory>
set -euo pipefail

group="${1:?A or B}"; rounds="${2:?rounds}"; out="${3:?output directory}"
case "$group" in A) durability=pglite-default ;; B) durability=host-fsync ;; *) exit 2 ;; esac
: "${VM:?}" "${GUEST_SSH:?}" "${GUEST_REPO:?}" "${HOST_ADDR:?}" "${DISK_CACHE:?}"
port="${PORT:-47802}"
mkdir -p "$out"
run() { node --conditions=source --no-warnings "experiments/$1" "${@:2}"; }
guest() { ssh -o ConnectTimeout=5 "$GUEST_SSH" "$@"; }
tenant="/var/tmp/saveslot-exp1-$group/tenant"

echo "vm=$VM disk_cache=$DISK_CACHE group=$group durability=$durability $(date -u +%FT%TZ)" > "$out/environment.txt"
virsh dumpxml "$VM" > "$out/domain.xml"

run exp1/observer.ts --host 0.0.0.0 --port "$port" --log "$out/observer-acks.log" > "$out/observer.jsonl" &
observer=$!
trap 'kill $observer 2>/dev/null || true' EXIT

for r in $(seq 1 "$rounds"); do
  virsh domstate "$VM" | grep -q running || virsh start "$VM" > /dev/null
  until guest true 2> /dev/null; do sleep 1; done
  guest "cd $GUEST_REPO && nohup node --conditions=source --no-warnings experiments/exp1/writer.ts \
    --dir $tenant --durability $durability --observer $HOST_ADDR:$port > /var/tmp/writer.log 2>&1 &"
  # Random moment: 3–30 s after the writer was started (its start-up takes about a second).
  sleep "$(awk -v s="$RANDOM" 'BEGIN { srand(s); printf "%.2f", 3 + rand() * 27 }')"
  virsh destroy "$VM" > /dev/null   # kills the VM process: the guest's page cache is lost
  confirmed="$(run exp1/observer-max.ts --port "$port")"
  virsh start "$VM" > /dev/null
  until guest true 2> /dev/null; do sleep 1; done
  result="$(guest "cd $GUEST_REPO && node --conditions=source --no-warnings experiments/exp1/check.ts \
    --dir $tenant --durability $durability --confirmed $confirmed" || true)"
  echo "{\"round\":$r,\"confirmed\":$confirmed,\"check\":$result}" | tee -a "$out/rounds.jsonl"
done
