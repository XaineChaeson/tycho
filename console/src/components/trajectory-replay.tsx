import { useEffect, useRef, useState } from 'react';
import { Details, Note, PRE, Problem } from '@/components/bits';
import { SiteRows } from '@/components/run-site';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent } from '@/components/ui/dialog';
import { Input, Textarea } from '@/components/ui/input';
import { Option, Select } from '@/components/ui/select';
import { api, messageOf, post } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
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
  const { t } = useI18n();
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
  const openerRef = useRef<HTMLElement | null>(null);
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
    if (typeof document !== 'undefined' && document.activeElement instanceof HTMLElement) {
      openerRef.current = document.activeElement;
    }
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
    catch { setFailure(t('tsk.replay.invalidJson')); return; }
    running.current = true; setLoading(true); setFailure(null); setResult(null);
    const generation = ++epoch.current;
    try {
      const value = await post<Simulation>('/api/replay/run', input);
      if (generation === epoch.current) setResult(value);
    } catch (error) { if (generation === epoch.current) setFailure(messageOf(error)); }
    finally { if (generation === epoch.current) { running.current = false; setLoading(false); } }
  }

  return <section aria-label={t('tsk.replay.title')} className="grid gap-2 rounded-xl border border-border p-3">
    <p className="text-sm font-medium">{t('tsk.replay.title')}</p>
    <Note>{t('tsk.replay.intro')}</Note>
    <div className="flex flex-wrap gap-2">
      <Button size="sm" variant="ghost" disabled={!currentRun} onClick={() => void open('playback')}>{t('tsk.replay.playbackBtn')}</Button>
      <Button size="sm" variant="ghost" onClick={() => void open('rerun')}>{t('tsk.replay.rerunBtn')}</Button>
    </div>
    <Sheet open={mode !== null} onOpenChange={value => { if (!value) close(); }}>
      {mode ? <SheetContent title={mode === 'playback' ? t('tsk.replay.playbackSheetTitle') : t('tsk.replay.rerunSheetTitle')} onCloseAutoFocus={(event) => {
        if (openerRef.current) {
          event.preventDefault();
          openerRef.current.focus();
          openerRef.current = null;
        }
      }}>
        <div className="grid min-w-0 grid-cols-1 gap-4">
          <Note>{mode === 'playback' ? t('tsk.replay.playbackNote') : t('tsk.replay.rerunNote')}</Note>
          {mode === 'playback' ? <>
            <label className="grid gap-1 text-sm">{t('tsk.replay.recordedRound')}<Select aria-label={t('tsk.replay.recordedRound')} value={currentRun} disabled={loading} onChange={event => {
              const id = event.target.value; setRunId(id); setPlaying(false); setPosition(0); setRecording(null);
              void read<RunEvents>(`/api/runs/${encodeURIComponent(id)}/events`, value => setRecording({ ...structuredClone(value), at: new Date().toISOString() }));
            }}>{runs.map((run, index) => <Option key={run.id} value={run.id}>{t('tsk.common.roundN', { n: index + 1 })}</Option>)}</Select></label>
            {recording ? <>
              <p>{t('tsk.replay.frozenCount', { count: recording.events.length })}</p>
              <Note>{t('tsk.replay.readAtInfo', { at: recording.at, firstIndex: recording.first_index ?? 0 })}</Note>
              {recording.reason ? <Problem>{recording.reason}</Problem> : null}
              <div className="flex flex-wrap gap-2">
                <Button size="sm" disabled={!recording.events.length || position >= recording.events.length} onClick={() => setPlaying(value => !value)}>{playing ? t('common.pause') : t('tsk.replay.play')}</Button>
                <Button size="sm" disabled={position >= recording.events.length} onClick={() => { setPlaying(false); setPosition(value => Math.min(value + 1, recording.events.length)); }}>{t('tsk.replay.nextStep')}</Button>
                <Button size="sm" variant="ghost" onClick={() => { setPlaying(false); setPosition(0); }}>{t('tsk.replay.restart')}</Button>
              </div>
              <label className="grid gap-1 text-sm">{t('tsk.replay.eventPosition', { pos: position, total: recording.events.length })}<Input type="range" aria-label={t('tsk.replay.eventPositionLabel')} min={0} max={recording.events.length} value={position} onChange={event => { setPlaying(false); setPosition(Number(event.target.value)); }} /></label>
              <div className="grid min-w-0 grid-cols-1 gap-2" aria-label={t('tsk.replay.playbackAria')}><SiteRows site={projectSite(recording.events.slice(0, position), position === recording.events.length)} id={`replay:${currentRun}`} /></div>
            </> : null}
          </> : <>
            {cases.length ? <>
              <label className="grid gap-1 text-sm">{t('tsk.replay.frozenCase')}<Select aria-label={t('tsk.replay.frozenCase')} value={caseId} disabled={loading} onChange={event => {
                const selected = cases.find(item => item.case_id === event.target.value);
                setCaseId(selected?.case_id ?? ''); setCaseText(selected ? JSON.stringify(selected, null, 2) : ''); setResult(null);
              }}>{cases.map(item => <Option key={item.case_id} value={item.case_id}>{`${item.case_id} · ${item.split === 'release' ? t('tsk.replay.splitRelease') : t('tsk.replay.splitTuning')}`}</Option>)}</Select></label>
              <label className="grid gap-1 text-sm">{t('tsk.replay.caseJsonLabel')}<Textarea aria-label={t('tsk.replay.caseJsonLabel')} value={caseText} maxLength={65536} rows={8} disabled={loading} onChange={event => { setCaseText(event.target.value); setResult(null); }} /></label>
              <Note>{t('tsk.replay.caseNote')}</Note>
              <Button disabled={loading || !caseText} onClick={() => void simulate()}>{t('tsk.replay.runRerunBtn')}</Button>
              <Button variant="ghost" disabled={loading || !currentRun} onClick={() => void read<unknown>(`/api/replay/runs/${encodeURIComponent(currentRun)}/draft?split=release`, setDraft)}>{t('tsk.replay.loadDraftBtn')}</Button>
            </> : null}
            {draft ? <Details id={`replay-draft:${currentRun}`} title={t('tsk.replay.draftTitle')} open><pre className={PRE}>{JSON.stringify(draft, null, 2)}</pre></Details> : null}
            {result ? <section aria-label={t('tsk.replay.resultLabel')} className="grid min-w-0 grid-cols-1 gap-2">
              <p className="font-medium">{result.result.failures.length === 0 && result.external_effects === 0 ? t('tsk.replay.passed') : t('tsk.replay.failed')}</p>
              <Note>{t('tsk.replay.externalEffects', { count: result.external_effects })}</Note>
              {result.result.baseline && result.result.candidate ? <Note>{t('tsk.replay.routerTurnsNote', { baseline: result.result.baseline.router_turns.length, candidate: result.result.candidate.router_turns.length })}</Note> : null}
              <Note>{t('tsk.replay.basisInfo', { version: result.basis.version, digest: result.basis.source_digest ?? t('tsk.replay.unreported') })}</Note>
              {result.result.failures.map((item, index) => <Problem key={index}>{item}</Problem>)}
              <Details id="replay-result" title={t('tsk.replay.resultDetailTitle')}><pre className={PRE}>{JSON.stringify(result, null, 2)}</pre></Details>
            </section> : null}
          </>}
          {loading ? <Note role="status">{running.current ? t('tsk.replay.rerunning') : t('tsk.common.readingEllipsis')}</Note> : null}
          {failure ? <Problem role="alert">{failure}</Problem> : null}
        </div>
      </SheetContent> : null}
    </Sheet>
  </section>;
}
