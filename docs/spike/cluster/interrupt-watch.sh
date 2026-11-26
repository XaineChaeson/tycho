#!/bin/bash
# interrupt-watch.sh <run_id> [delay=3] [fallback=15]
# wait for first item.*/delta event, then <delay>s, then stop.sh;
# if no such event within <fallback>s after turn.started, stop at turn.started+<fallback>s.
run_id="$1"; delay="${2:-3}"; fb="${3:-15}"
dir="$HOME/.orchestrator-spike/runs/$run_id"
ts_turn=""
for i in $(seq 1 1200); do
  if grep -qE '"type":"(item\.|[a-z_.]*delta)' "$dir/stdout.ndjson" 2>/dev/null; then
    echo "first item/delta event seen at $(date +%T.%N): $(grep -m1 -E '"type":"(item\.|[a-z_.]*delta)' "$dir/stdout.ndjson" | cut -c1-200)"
    sleep "$delay"; break
  fi
  if [ -z "$ts_turn" ] && grep -q '"type":"turn.started"' "$dir/stdout.ndjson" 2>/dev/null; then
    ts_turn=$(date +%s); echo "turn.started seen at $(date +%T)"
  fi
  if [ -n "$ts_turn" ] && [ $(( $(date +%s) - ts_turn )) -ge "$fb" ]; then
    echo "no item/delta event within ${fb}s of turn.started; stopping now ($(date +%T))"; break
  fi
  [ -f "$dir/exit" ] && { echo "worker exited before trigger"; exit 1; }
  sleep 0.5
done
echo "lines in stdout before stop: $(wc -l < "$dir/stdout.ndjson")"; cat "$dir/stdout.ndjson"
exec bash "$HOME/.orchestrator-spike/bin/stop.sh" "$run_id"
