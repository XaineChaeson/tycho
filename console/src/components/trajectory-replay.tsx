import { useEffect, useRef, useState } from 'react';
import { Details, Note, PRE, Problem } from '@/components/bits';
import { SiteRows } from '@/components/run-site';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent } from '@/components/ui/dialog';
import { Input, Textarea } from '@/components/ui/input';
import { Option, Select } from '@/components/ui/select';
import { api, messageOf, post } from '@/lib/api';
import { projectSite } from '@/lib/timeline';
import type { RunEvents } from '@/lib/types';

type Mode = 'playback' | 'rerun';
interface FrozenCase { case_id: string; split: string; [key: string]: unknown }
interface Simulation {
  basis: { version: string; source_digest?: string };
  external_effects: number;
  result: { failures: string[]; external_effects: number; baseline?: { router_turns: unknown[] }; candidate?: { router_turns: unknown[] }; [key: string]: unknown };
  [key: string]: unknown;
}

export function TrajectoryReplay({ runs }: { runs: { id: string; state: string }[] }) {
  const [mode, setMode] = useState<Mode | null>(null);
  const [runId, setRunId] = useState(runs.at(-1)?.id ?? '');
  const [recording, setRecording] = useState<(RunEvents & { at: string }) | null>(null);
  const [position, setPosition] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [cases, setCases] = useState<FrozenCase[]>([]);
  const [caseId, setCaseId] = useState('');
  const [caseText, setCaseText] = useState('');
  const [draft, setDraft] = useState<unknown>();
  const [result, setResult] = useState<Simulation | null>(null);
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const active = useRef<AbortController | null>(null);
  const epoch = useRef(0);
  const running = useRef(false);
  const currentRun = runs.some(run => run.id === runId) ? runId : runs.at(-1)?.id ?? '';

  useEffect(() => () => { epoch.current++; active.current?.abort(); }, []);
  useEffect(() => {
    if (!playing || mode !== 'playback' || !recording) return;
    const timer = setInterval(() => setPosition(old => {
      const next = Math.min(old + 1, recording.events.length);
      if (next === recording.events.length) setPlaying(false);
      return next;
    }), 500);
    return () => clearInterval(timer);
  }, [playing, mode, recording]);

  function close(): void {
    epoch.current++; active.current?.abort(); setPlaying(false); setMode(null); running.current = false;
  }
  async function read<T>(path: string, accept: (value: T) => void): Promise<void> {
    active.current?.abort();
    const aborter = new AbortController(); active.current = aborter;
    const generation = ++epoch.current;
    setLoading(true); setFailure(null);
    try {
      const value = await api<T>(path, { signal: aborter.signal });
      if (generation === epoch.current) accept(value);
    } catch (error) { if (generation === epoch.current && !aborter.signal.aborted) setFailure(messageOf(error)); }
    finally { if (generation === epoch.current) setLoading(false); }
  }
  async function open(next: Mode): Promise<void> {
    setMode(next); setPlaying(false); setPosition(0); setResult(null); setDraft(undefined);
    if (next === 'playback') {
      setRecording(null);
      if (currentRun) await read<RunEvents>(`/api/runs/${encodeURIComponent(currentRun)}/events`, value => setRecording({ ...structuredClone(value), at: new Date().toISOString() }));
    } else {
      await read<{ cases: FrozenCase[] }>('/api/replay/cases', value => {
        setCases(value.cases);
        const first = value.cases.find(item => item.split === 'release') ?? value.cases[0];
        setCaseId(first?.case_id ?? ''); setCaseText(first ? JSON.stringify(first, null, 2) : '');
      });
    }
  }
  async function simulate(): Promise<void> {
    if (running.current || loading) return;
    let input: unknown;
    try { input = JSON.parse(caseText); }
    catch { setFailure('案例不是有效 JSON，请先修正。'); return; }
    running.current = true; setLoading(true); setFailure(null); setResult(null);
    const generation = ++epoch.current;
    try {
      const value = await post<Simulation>('/api/replay/run', input);
      if (generation === epoch.current) setResult(value);
    } catch (error) { if (generation === epoch.current) setFailure(messageOf(error)); }
    finally { if (generation === epoch.current) { running.current = false; setLoading(false); } }
  }

  return <section aria-label="轨迹用途" className="grid gap-2 rounded-xl border border-border p-3">
    <p className="text-sm font-medium">轨迹用途</p>
    <Note>当前页面查阅已保存的事实。回放只演示录制事件，隔离重跑用冻结案例检查规则。</Note>
    <div className="flex flex-wrap gap-2">
      <Button size="sm" variant="ghost" disabled={!currentRun} onClick={() => void open('playback')}>离线回放</Button>
      <Button size="sm" variant="ghost" onClick={() => void open('rerun')}>隔离重跑</Button>
    </div>
    <Sheet open={mode !== null} onOpenChange={value => { if (!value) close(); }}>
      {mode ? <SheetContent title={mode === 'playback' ? '离线回放录制事件' : '隔离重跑冻结案例'}>
        <div className="grid min-w-0 grid-cols-1 gap-4">
          <Note>{mode === 'playback' ? '只在当前页面播放保存的事件，不重新执行命令，也不改变任务。缺失的原文不能通过回放补回。' : '在临时账本重跑待验收通知规则，使用固定输入、替身通知和独立预期。不会调用真实模型、Worker 或 IM，也不会改变当前任务。'}</Note>
          {mode === 'playback' ? <>
            <label className="grid gap-1 text-sm">录制轮次<Select aria-label="录制轮次" value={currentRun} disabled={loading} onChange={event => {
              const id = event.target.value; setRunId(id); setPlaying(false); setPosition(0); setRecording(null);
              void read<RunEvents>(`/api/runs/${encodeURIComponent(id)}/events`, value => setRecording({ ...structuredClone(value), at: new Date().toISOString() }));
            }}>{runs.map((run, index) => <Option key={run.id} value={run.id}>{`第 ${index + 1} 轮`}</Option>)}</Select></label>
            {recording ? <>
              <p>{`已冻结 ${recording.events.length} 条录制事件`}</p>
              <Note>{`读取于 ${recording.at}。从原事件位置 ${recording.first_index ?? 0} 开始。`}</Note>
              {recording.reason ? <Problem>{recording.reason}</Problem> : null}
              <div className="flex flex-wrap gap-2">
                <Button size="sm" disabled={!recording.events.length || position >= recording.events.length} onClick={() => setPlaying(value => !value)}>{playing ? '暂停' : '播放'}</Button>
                <Button size="sm" disabled={position >= recording.events.length} onClick={() => { setPlaying(false); setPosition(value => Math.min(value + 1, recording.events.length)); }}>下一步</Button>
                <Button size="sm" variant="ghost" onClick={() => { setPlaying(false); setPosition(0); }}>从头回放</Button>
              </div>
              <label className="grid gap-1 text-sm">{`事件位置 ${position}/${recording.events.length}`}<Input type="range" aria-label="事件位置" min={0} max={recording.events.length} value={position} onChange={event => { setPlaying(false); setPosition(Number(event.target.value)); }} /></label>
              <div className="grid min-w-0 grid-cols-1 gap-2" aria-label="录制事件回放"><SiteRows site={projectSite(recording.events.slice(0, position), position === recording.events.length)} id={`replay:${currentRun}`} /></div>
            </> : null}
          </> : <>
            {cases.length ? <>
              <label className="grid gap-1 text-sm">冻结案例<Select aria-label="冻结案例" value={caseId} disabled={loading} onChange={event => {
                const selected = cases.find(item => item.case_id === event.target.value);
                setCaseId(selected?.case_id ?? ''); setCaseText(selected ? JSON.stringify(selected, null, 2) : ''); setResult(null);
              }}>{cases.map(item => <Option key={item.case_id} value={item.case_id}>{`${item.case_id} · ${item.split === 'release' ? '发布验证集' : '调优集'}`}</Option>)}</Select></label>
              <label className="grid gap-1 text-sm">已定稿案例 JSON<Textarea aria-label="已定稿案例 JSON" value={caseText} maxLength={65536} rows={8} disabled={loading} onChange={event => { setCaseText(event.target.value); setResult(null); }} /></label>
              <Note>输入与预期一起冻结。草稿需要补齐前提和独立判定，不能直接当成已通过案例。</Note>
              <Button disabled={loading || !caseText} onClick={() => void simulate()}>执行隔离重跑</Button>
              <Button variant="ghost" disabled={loading || !currentRun} onClick={() => void read<unknown>(`/api/replay/runs/${encodeURIComponent(currentRun)}/draft?split=release`, setDraft)}>读取本轮案例草稿</Button>
            </> : null}
            {draft ? <Details id={`replay-draft:${currentRun}`} title="本轮结构草稿 · 尚未定稿" open><pre className={PRE}>{JSON.stringify(draft, null, 2)}</pre></Details> : null}
            {result ? <section aria-label="隔离判定结果" className="grid min-w-0 grid-cols-1 gap-2">
              <p className="font-medium">{result.result.failures.length === 0 && result.external_effects === 0 ? '隔离判定通过' : '隔离判定未通过'}</p>
              <Note>{`外部副作用 ${result.external_effects}`}</Note>
              {result.result.baseline && result.result.candidate ? <Note>{`规则交给负责人的回合：基线 ${result.result.baseline.router_turns.length}，候选 ${result.result.candidate.router_turns.length}。这是隔离规则判定，不是实际模型调用次数。`}</Note> : null}
              <Note>{`程序版本 ${result.basis.version} · 源码 ${result.basis.source_digest ?? '未报告'}`}</Note>
              {result.result.failures.map((item, index) => <Problem key={index}>{item}</Problem>)}
              <Details id="replay-result" title="冻结输入、两版输出与判定"><pre className={PRE}>{JSON.stringify(result, null, 2)}</pre></Details>
            </section> : null}
          </>}
          {loading ? <Note role="status">{running.current ? '正在隔离重跑…' : '正在读取…'}</Note> : null}
          {failure ? <Problem role="alert">{failure}</Problem> : null}
        </div>
      </SheetContent> : null}
    </Sheet>
  </section>;
}
