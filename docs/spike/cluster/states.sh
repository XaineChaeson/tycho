#!/bin/bash
# states.sh -- produce the six observable states of the judgment table
B=~/.orchestrator-spike/bin; R=~/.orchestrator-spike/runs
echo "################ (i) no started/"
mkdir -p $R/S1; bash $B/state.sh S1
echo "################ (ii) started/ present, no pid, launcher still running (ORCH_LAUNCH_DELAY=20)"
ORCH_LAUNCH_DELAY=20 setsid bash $B/start.sh S2 sleep 300 >$R/S2.launcher.out 2>&1 </dev/null & L2=$!
sleep 2; echo "launcher pid $L2:"; ps --forest -o pid,ppid,pgid,sid,stat,cmd -g $L2; bash $B/state.sh S2
echo "################ (iii) started/ present, no pid, nothing running (launcher killed during its sleep)"
ORCH_LAUNCH_DELAY=20 setsid bash $B/start.sh S3 sleep 300 >$R/S3.launcher.out 2>&1 </dev/null & L3=$!
sleep 2; kill -KILL $L3; echo "kill -KILL launcher $L3 rc=$?"; sleep 0.5
echo "--- after killing the launcher only:"; bash $B/state.sh S3
pkill -KILL -f 'orchestrator-run:S3 '; echo "pkill orphaned worker rc=$?"; sleep 0.5
echo "--- after also killing the orphaned worker (found only via marker):"; bash $B/state.sh S3
echo "################ (iv) started/pid present, process alive, no exit"
bash $B/start.sh S4 sleep 300; sleep 0.5; bash $B/state.sh S4
echo "################ (v) exit present (worker: true)"
bash $B/start.sh S5 true; sleep 1; bash $B/state.sh S5; echo "wrapper.log:"; cat $R/S5/wrapper.log
echo "################ (vi) started/pid present, process gone, no exit (kill -9 whole group)"
bash $B/start.sh S6 sleep 300; sleep 0.5; pid=$(cat $R/S6/started/pid); kill -KILL -- -$pid; echo "kill -KILL -- -$pid rc=$?"; sleep 0.5; bash $B/state.sh S6
echo "################ (ii) follow-up: S2 after launcher finished its delay"
sleep 19; bash $B/state.sh S2; echo "launcher out:"; cat $R/S2.launcher.out
echo "################ A3a redo with v2 launcher: stop.sh S4 (sleep worker, SIGINT)"
bash $B/stop.sh S4
echo "################ stop S2 too"
bash $B/stop.sh S2
