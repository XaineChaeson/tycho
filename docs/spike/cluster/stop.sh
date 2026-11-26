#!/bin/bash
# stop.sh <run_id> [grace_sec=10] -- SIGINT the process group, wait, SIGKILL if needed
run_id="$1"; grace="${2:-10}"
dir="$HOME/.orchestrator-spike/runs/$run_id"
pid=$(cat "$dir/started/pid") || { echo "no pid"; exit 2; }
pgid=$(ps -o pgid= -p "$pid" | tr -d " "); [ -n "$pgid" ] || { echo "pid $pid not running (no pgid)"; ls -la "$dir"; cat "$dir/exit" 2>&1; exit 4; }
echo "pid=$pid pgid=$pgid"
echo "### group before (ps --forest -g $pgid)"
ps --forest -o pid,ppid,pgid,sid,stat,etimes,cmd -g "$pgid"
t0=$(date +%s%N)
kill -INT -- "-$pgid"; echo "kill -INT -- -$pgid rc=$?"
killed_hard=no
for i in $(seq 1 $((grace*10))); do
  if ! pgrep -g "$pgid" >/dev/null; then break; fi
  sleep 0.1
done
if pgrep -g "$pgid" >/dev/null; then
  echo "### still alive after ${grace}s, sending SIGKILL"
  ps --forest -o pid,ppid,pgid,sid,stat,cmd -g "$pgid"
  kill -KILL -- "-$pgid"; echo "kill -KILL -- -$pgid rc=$?"; killed_hard=yes
  sleep 0.5
fi
t1=$(date +%s%N)
echo "group gone after $(( (t1 - t0) / 1000000 )) ms; sigkill_used=$killed_hard"
echo "### group after: pgrep -g $pgid"
pgrep -af -g "$pgid"; echo "(rc=$?)"
echo "### pgrep -af orchestrator-run:$run_id"
pgrep -af "orchestrator-run:$run_id"; echo "(rc=$?)"
echo "### pgrep -af codex exec (any codex left?)"
pgrep -af "codex exec" ; echo "(rc=$?)"
echo "### exit file (sleep 1 first)"; sleep 1
ls -la "$dir"; cat "$dir/exit" 2>&1
echo "### stderr tail"; tail -c 600 "$dir/stderr.log"
