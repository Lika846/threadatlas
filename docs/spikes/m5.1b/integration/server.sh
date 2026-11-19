#!/bin/bash
# server.sh <name> <dev|start> <port> [VAR=value ...]
# Starts `npm run dev|start` in its own process group with the spike's environment and
# waits until the spike route answers. Requires (exported by the caller):
#   SPIKE_OUT               output directory for <name>.log, <name>.events, <name>.pid
#   SPIKE_DB                absolute path of a migrated synthetic database in the system temp dir
#   THREADATLAS_MODEL_DIR   absolute path of the verified model directory
# SPIKE_SANDBOX=1 runs the server under the network-denying sandbox profile.
set -u
name=$1; cmd=$2; port=$3; shift 3
cd "$(dirname "$0")/../../../.."
: > "$SPIKE_OUT/$name.events"
env DATABASE_URL="file:$SPIKE_DB" THREADATLAS_TEST=1 THREADATLAS_SPIKE_LOG="$SPIKE_OUT/$name.events" "$@" \
  ${SPIKE_SANDBOX:+sandbox-exec -f docs/spikes/m5.0/experiment-2/bench/nonet.sb} \
  perl -e 'setpgrp(0,0); exec @ARGV' npm run "$cmd" -- --port "$port" > "$SPIKE_OUT/$name.log" 2>&1 &
echo $! > "$SPIKE_OUT/$name.pid"
for i in $(seq 1 120); do curl -s -o /dev/null "http://127.0.0.1:$port/api/spike-embed?op=status" && break; sleep 0.5; done
echo "process group $(cat "$SPIKE_OUT/$name.pid") ready"
