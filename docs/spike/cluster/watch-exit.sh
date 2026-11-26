#!/bin/bash
# watch-exit.sh <run_id> [timeout_sec=540] -- block until exit file appears or timeout
run_id="$1"; to="${2:-540}"
dir="$HOME/.orchestrator-spike/runs/$run_id"
for i in $(seq 1 "$to"); do
  [ -f "$dir/exit" ] && { echo "exit=$(cat "$dir/exit") after ${i}s"; exit 0; }
  sleep 1
done
echo "timeout after ${to}s"; exit 1
