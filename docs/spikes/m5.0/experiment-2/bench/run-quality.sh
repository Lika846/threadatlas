#!/bin/bash
# Runs all experiment 2 quality configurations sequentially, offline (sandbox + tripwire).
E=$1; P=$2; NODE=$3
cd $E/exp2/bench
RT=$E/exp2/rt-direct/node_modules; M=$E/exp1/models/Xenova/multilingual-e5-small; R=$E/exp2/results; EV=$E/exp2/eval
q() { sandbox-exec -f nonet.sb $NODE --import ./tripwire.mjs quality2.mjs $RT $M "$@"; }
q $P/docs/spikes/m5.0/eval/dataset.json $P/docs/spikes/m5.0/eval/dataset.json $P/docs/spikes/m5.0/eval/keyword-raw.json $R v0
q $EV/union.json $EV/union.json $R/keyword-raw-long.json $R long
q $EV/union-v0q.json $EV/union-v0q.json $R/keyword-raw-v0-union.json $R v0u message,turn,sent256,sent64,sent64title
q $EV/union.json $EV/union.json $R/keyword-raw-long.json $R long-b1 message,sent256,sent64 1
q $P/docs/spikes/m5.0/eval/dataset.json $P/docs/spikes/m5.0/eval/dataset.json $P/docs/spikes/m5.0/eval/keyword-raw.json $R v0-b1 message 1
M5_INT8=1 q $EV/union.json $EV/union.json $R/keyword-raw-long.json $R long-int8 sent256,sent64
