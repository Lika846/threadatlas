#!/bin/bash
E=$1; NODE=$2; P=$E/exp2/proto; cd $P
for c in direct-normal direct-exitcode direct-throw direct-reject direct-release-throw direct-exit-inflight worker-normal worker-throw worker-terminate-throw worker-shutdown-throw tfjs-normal tfjs-throw tfjs-dispose-throw; do
  res=""
  for i in 1 2 3 4 5; do
    sandbox-exec -f $E/exp2/bench/nonet.sb $NODE --import ../bench/tripwire.mjs exit-case.mjs $c $E/exp2/rt-direct/node_modules $E/exp1/models/Xenova/multilingual-e5-small $E/exp1/rt/node_modules $E/exp1/models > /dev/null 2> $P/exitcase.err
    code=$?
    if grep -q "mutex lock failed" $P/exitcase.err; then res="$res ${code}A"; else res="$res $code"; fi
  done
  echo "$c:$res"
done
rm -f $P/exitcase.err
