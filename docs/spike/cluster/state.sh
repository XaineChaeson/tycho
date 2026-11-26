#!/bin/bash
# state.sh <run_id>  -- dump observable state of a run
run_id="$1"
dir="$HOME/.orchestrator-spike/runs/$run_id"
echo "## state of $run_id  ($(date +%T))"
echo "### ls -la $dir"
ls -la "$dir" 2>&1
echo "### ls -la $dir/started"
ls -la "$dir/started" 2>&1
echo "### pid file"
cat "$dir/started/pid" 2>&1
echo "### exit file"
cat "$dir/exit" 2>&1
echo "### pgrep -af orchestrator-run:$run_id"
pgrep -af "orchestrator-run:$run_id"; echo "(pgrep rc=$?)"
if [ -f "$dir/started/pid" ]; then
  pid=$(cat "$dir/started/pid")
  echo "### ps -o pid,ppid,pgid,sid,stat,etimes,cmd -p $pid"
  ps -o pid,ppid,pgid,sid,stat,etimes,cmd -p "$pid" 2>&1
  pgid=$(ps -o pgid= -p "$pid" 2>/dev/null | tr -d ' ')
  if [ -n "$pgid" ]; then
    echo "### members of pgid $pgid (pgrep -g)"
    pgrep -af -g "$pgid"
    echo "### ps --forest -o pid,ppid,pgid,sid,stat,cmd -g $pgid"
    ps --forest -o pid,ppid,pgid,sid,stat,cmd -g "$pgid"
  fi
fi
