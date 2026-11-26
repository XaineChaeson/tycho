#!/bin/bash
# codex-case.sh <case> [thread_id]  -- launch one codex fixture case via start.sh (detached), run_id = case
case_="$1"; tid="$2"
B="$HOME/.orchestrator-spike/bin"
export ORCH_CWD="$HOME/.orchestrator-spike/codex"
rdir="$HOME/.orchestrator-spike/runs/$case_"
COMMON=(--skip-git-repo-check --json)
LONG='从 1 数到 2000，每行一个数字，不要调用工具'
case "$case_" in
  normal)
    bash "$B/start.sh" normal codex exec --profile cheap --sandbox read-only "${COMMON[@]}" -o "$rdir/last.txt" '记住暗号：青松-7429。只回复“好的”。' ;;
  resume)   # NOTE: `codex exec resume` has no --profile; -c profile=cheap is rejected (see fixtures)
    [ -n "$tid" ] || { echo need thread id; exit 2; }
    bash "$B/start.sh" resume codex exec resume "$tid" -c profile=cheap "${COMMON[@]}" -o "$rdir/last.txt" '刚才的暗号是什么？只回复暗号。' ;;
  resume-plain)
    [ -n "$tid" ] || { echo need thread id; exit 2; }
    bash "$B/start.sh" resume-plain codex exec resume "$tid" "${COMMON[@]}" -o "$rdir/last.txt" '刚才的暗号是什么？只回复暗号。' ;;
  interrupt|interrupt2)
    bash "$B/start.sh" "$case_" codex exec --profile cheap --sandbox read-only "${COMMON[@]}" -o "$rdir/last.txt" "$LONG" ;;
  fail-url)      # OPENAI_BASE_URL had no effect in 0.163.0 with the cheap profile (completed normally)
    bash "$B/start.sh" fail-url env OPENAI_BASE_URL=http://127.0.0.1:9/v1 codex exec --profile cheap --sandbox read-only "${COMMON[@]}" -o "$rdir/last.txt" '只回复“好的”。' ;;
  fail-profile)  # --profile nonexistent was silently accepted in 0.163.0 (completed normally)
    bash "$B/start.sh" fail-profile codex exec --profile nonexistent --sandbox read-only "${COMMON[@]}" -o "$rdir/last.txt" '只回复“好的”。' ;;
  fail-provider) # custom provider pointing at a closed port -> real API failure
    bash "$B/start.sh" fail-provider codex exec --profile cheap --sandbox read-only "${COMMON[@]}" \
      -c model_provider=spikefail -c model_providers.spikefail.name=spikefail \
      -c model_providers.spikefail.base_url=http://127.0.0.1:9/v1 -c model_providers.spikefail.wire_api=responses \
      -o "$rdir/last.txt" '只回复“好的”。' ;;
  *) echo unknown case; exit 2 ;;
esac
echo "launch rc=$?"
