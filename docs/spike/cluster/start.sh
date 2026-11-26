#!/bin/bash
# start.sh <run_id> <cmd...>   -- orchestrator launch protocol (spike)
# env: ORCH_LAUNCH_DELAY=<sec> sleeps between spawning the worker and writing started/pid (simulates slow launcher)
#      ORCH_CWD=<dir>          worker working directory
run_id="$1"; shift
dir="$HOME/.orchestrator-spike/runs/$run_id"
mkdir -p "$dir"
mkdir "$dir/started" 2>/dev/null || exit 3            # one-shot launch eligibility
setsid env --default-signal bash -c 'dir="$1"; shift; [ -n "$ORCH_CWD" ] && cd "$ORCH_CWD"; "$@" > "$dir/stdout.ndjson" 2> "$dir/stderr.log"; echo $? > "$dir/exit.tmp"; mv "$dir/exit.tmp" "$dir/exit"' "orchestrator-run:$run_id" "$dir" "$@" </dev/null >"$dir/wrapper.log" 2>&1 &
pid=$!
[ -n "$ORCH_LAUNCH_DELAY" ] && sleep "$ORCH_LAUNCH_DELAY"
echo "$pid" > "$dir/started/pid"
echo started
