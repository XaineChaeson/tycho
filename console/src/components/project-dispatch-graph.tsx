// Lightweight visual dispatch topology for a project's works and derived child threads.
// Supports two switchable views with zero external graph dependencies:
// - `hud`: 45-degree chamfered PCB blueprint with copper traces, solder pads, and telemetry codes.
// - `trace`: Indented derivation tree paired with live glowing execution timeline bars.
import { Moon, Sun } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { taskLine, taskStateLabels } from '@shared/labels.ts';
import { parseLoginName } from '@shared/logins.ts';
import { toneOf, type Tone } from '@/components/bits';
import { useI18n, type TranslationParams } from '@/lib/i18n';
import type { Project, Task, TaskAssignment } from '@/lib/types';
import { cn } from '@/lib/utils';

type TranslateFn = (key: string, params?: TranslationParams) => string;

export type DispatchGraphMode = 'hud' | 'trace';

const CANVAS_TONE_KEY = 'tycho.dispatchGraphTone';
const FALLBACK_RECENT_DONE = 3;

interface DispatchNode {
  id: string;
  code: string;
  parentId: string | null;
  depth: number;
  kind: 'router' | 'work' | 'sub' | 'review' | 'cluster';
  title: string;
  state: string;
  stateLabel: string;
  tone: Tone;
  actor: string;
  detailLine: string;
  startMs: number | null;
  endMs: number | null;
  isLive: boolean;
  children: DispatchNode[];
}

interface PositionedNode {
  node: DispatchNode;
  x: number;
  y: number;
  w: number;
  h: number;
}

const DEEP_TONE_COLOR: Record<Tone, string> = {
  running: '#38bdf8',
  waiting: '#f59e0b',
  failed: '#f43f5e',
  success: '#10b981',
  ended: '#94a3b8',
};

const ADAPTIVE_TONE_COLOR: Record<Tone, string> = {
  running: 'var(--running)',
  waiting: 'var(--waiting)',
  failed: 'var(--failed)',
  success: 'var(--success)',
  ended: 'var(--ended)',
};

function loadDeepTone(): boolean {
  try {
    if (typeof localStorage === 'undefined') return false;
    const raw = localStorage.getItem(CANVAS_TONE_KEY);
    if (raw === 'deep') return true;
    return false;
  } catch {
    return false;
  }
}

function saveDeepTone(deep: boolean): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(CANVAS_TONE_KEY, deep ? 'deep' : 'adaptive');
  } catch {
    // Ignore storage errors in restricted environments.
  }
}

function parseIsoMs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? parsed : null;
}

function isTerminalState(state: string): boolean {
  return state === 'done' || state === 'abandoned';
}

function isBranchActive(task: Task, byParent: Map<string, Task[]>): boolean {
  if (!isTerminalState(task.state)) return true;
  const kids = byParent.get(task.id) ?? [];
  return kids.some((child) => isBranchActive(child, byParent));
}

function classifyChildKind(task: Task): 'review' | 'cluster' | 'sub' {
  if (task.review_gate || /审阅|review/i.test(task.title) || /审阅|review/i.test(task.assignment?.role_name ?? '')) { // i18n-ignore
    return 'review';
  }
  if (/集群|cluster|worker|验证|回归|dev|prod/i.test(task.title)) { // i18n-ignore
    return 'cluster';
  }
  return 'sub';
}

function formatCompactActor(assignment: TaskAssignment | null | undefined, fallbackLogin: string | null | undefined, t: TranslateFn): string {
  const role = assignment?.role_name?.trim() || null;
  const rawLogin = assignment?.login_name?.trim() || fallbackLogin?.trim() || null;
  const rawMachine = assignment?.machine_name?.trim() || null;

  let runner: string | null = null;
  if (rawLogin) {
    const parsed = parseLoginName(rawLogin);
    if (parsed.kind === 'machine') {
      const machine = rawMachine ?? parsed.machine;
      runner = machine ? `${parsed.executor}@${machine}` : parsed.executor;
    } else {
      runner = rawMachine ? `${parsed.account}@${rawMachine}` : parsed.account;
    }
  } else if (rawMachine) {
    runner = `@${rawMachine}`;
  }

  if (role && runner) return `${role} // ${runner}`;
  if (runner) return runner;
  if (role) return t('proj.graph.actorRolePending', { role });
  return t('proj.graph.actorPending');
}

function formatDuration(ms: number): string {
  const secs = Math.max(0, Math.floor(ms / 1000));
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) {
    const rem = secs % 60;
    return rem > 0 ? `${mins}m ${String(rem).padStart(2, '0')}s` : `${mins}m`;
  }
  const hrs = Math.floor(mins / 60);
  const remMins = mins % 60;
  return remMins > 0 ? `${hrs}h ${remMins}m` : `${hrs}h`;
}

function formatClock(ms: number): string {
  const date = new Date(ms);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function elapsedLabel(node: DispatchNode, nowMs: number, t: TranslateFn): string {
  if (node.kind === 'router') return t('proj.graph.elapsedContinuous');
  if (node.state === 'held' || node.state === 'waiting_person' || node.state === 'needs_verification') {
    return t('proj.graph.elapsedNeedsAttention');
  }
  if (node.state === 'queued' || node.state === 'waiting_timer') {
    return taskStateLabels[node.state] ?? t('cli.queuing');
  }
  if (node.startMs !== null) {
    const end = node.isLive ? nowMs : (node.endMs ?? nowMs);
    return formatDuration(Math.max(0, end - node.startMs));
  }
  return node.stateLabel;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function buildDispatchTree(
  project: Project | undefined,
  works: readonly Task[],
  allChildren: readonly Task[],
  includeEnded: boolean,
  t: TranslateFn,
): { root: DispatchNode; totalCount: number; hiddenEndedCount: number; hasRunning: boolean } {
  const byParent = new Map<string, Task[]>();
  for (const child of allChildren) {
    if (!child.parent_id) continue;
    const bucket = byParent.get(child.parent_id);
    if (bucket) bucket.push(child);
    else byParent.set(child.parent_id, [child]);
  }
  for (const list of byParent.values()) {
    list.sort((a, b) => (parseIsoMs(a.created_at) ?? 0) - (parseIsoMs(b.created_at) ?? 0));
  }

  const activeWorks = works.filter((w) => isBranchActive(w, byParent));
  const visibleWorks = includeEnded
    ? [...works]
    : activeWorks.length > 0
      ? activeWorks
      : works.slice(0, FALLBACK_RECENT_DONE);
  const hiddenEndedCount = works.length - visibleWorks.length;

  let totalCount = 0;
  let hasRunning = false;

  function toNode(task: Task, parentId: string, depth: number, code: string, kind: DispatchNode['kind']): DispatchNode {
    totalCount += 1;
    const isLive = task.state === 'running' || task.state === 'stopping';
    if (isLive) hasRunning = true;
    const rawKids = byParent.get(task.id) ?? [];
    const childNodes = rawKids.map((child, idx) => {
      const childKind = classifyChildKind(child);
      const prefix = childKind === 'review' ? 'REV' : childKind === 'cluster' ? 'CLU' : 'SUB';
      const parentSuffix = code.split('.')[1] ?? pad2(depth);
      const childCode = `${prefix}.${parentSuffix}${idx + 1}`;
      return toNode(child, task.id, depth + 1, childCode, childKind);
    });
    const effectiveState = task.summary?.dot ?? task.state;
    const startMs = parseIsoMs(task.created_at);
    const endMs = parseIsoMs(task.finished_at ?? task.updated_at);
    return {
      id: task.id,
      code,
      parentId,
      depth,
      kind,
      title: task.title,
      state: task.state,
      stateLabel: taskStateLabels[task.state] ?? task.state,
      tone: toneOf(effectiveState),
      actor: formatCompactActor(task.assignment, task.login_name, t),
      detailLine: taskLine(task),
      startMs,
      endMs,
      isLive,
      children: childNodes,
    };
  }

  const workNodes = visibleWorks.map((work, index) => toNode(work, '__router__', 1, `WRK.${pad2(index + 1)}`, 'work'));

  const anyRunning = workNodes.some((n) => n.tone === 'running') || hasRunning;
  const anyWaiting = workNodes.some((n) => n.tone === 'waiting' || n.tone === 'failed');
  const routerTone: Tone = anyRunning ? 'running' : anyWaiting ? 'waiting' : 'success';
  const routerAccount = project?.router?.account?.trim() || null;
  const routerActor = routerAccount
    ? t('proj.graph.routerActorAccount', { account: routerAccount })
    : t('proj.graph.routerActorDefault');

  const root: DispatchNode = {
    id: '__router__',
    code: 'SYS.00',
    parentId: null,
    depth: 0,
    kind: 'router',
    title: project?.name ? t('proj.graph.routerTitleNamed', { name: project.name }) : t('proj.graph.routerTitleDefault'),
    state: anyRunning ? 'running' : anyWaiting ? 'waiting_person' : 'done',
    stateLabel: anyRunning
      ? t('proj.graph.routerStateRunning')
      : anyWaiting
        ? t('proj.graph.routerStateWaiting')
        : t('proj.graph.routerStateReady'),
    tone: routerTone,
    actor: routerActor,
    detailLine: t('proj.graph.routerDetailLine', { count: workNodes.length }),
    startMs: null,
    endMs: null,
    isLive: anyRunning,
    children: workNodes,
  };

  return { root, totalCount, hiddenEndedCount, hasRunning };
}

function layoutHudTree(root: DispatchNode): {
  nodes: PositionedNode[];
  edges: { from: PositionedNode; to: PositionedNode }[];
  width: number;
  height: number;
} {
  const COL_W = [192, 236, 252];
  const NODE_H = [74, 74, 68];
  const COL_GAP = 66;
  const ROW_GAP = 16;
  const PAD_X = 20;
  const PAD_Y = 20;

  const colX = (depth: number): number => {
    let x = PAD_X;
    for (let d = 0; d < depth; d++) {
      x += (COL_W[Math.min(d, COL_W.length - 1)] ?? 252) + COL_GAP;
    }
    return x;
  };
  const nodeW = (depth: number): number => COL_W[Math.min(depth, COL_W.length - 1)] ?? 252;
  const nodeH = (depth: number): number => NODE_H[Math.min(depth, NODE_H.length - 1)] ?? 68;

  const positioned = new Map<string, PositionedNode>();
  const ordered: PositionedNode[] = [];

  function place(node: DispatchNode, topY: number): { centerY: number; bottomY: number } {
    const w = nodeW(node.depth);
    const h = nodeH(node.depth);
    const x = colX(node.depth);

    if (node.children.length === 0) {
      const item: PositionedNode = { node, x, y: topY, w, h };
      positioned.set(node.id, item);
      ordered.push(item);
      return { centerY: topY + h / 2, bottomY: topY + h };
    }

    let cursorY = topY;
    const childCenters: number[] = [];
    for (let i = 0; i < node.children.length; i++) {
      if (i > 0) cursorY += ROW_GAP;
      const res = place(node.children[i], cursorY);
      childCenters.push(res.centerY);
      cursorY = res.bottomY;
    }
    const midCenterY = (childCenters[0] + childCenters[childCenters.length - 1]) / 2;
    const y = Math.max(PAD_Y, Math.round(midCenterY - h / 2));
    const item: PositionedNode = { node, x, y, w, h };
    positioned.set(node.id, item);
    ordered.push(item);
    return { centerY: y + h / 2, bottomY: Math.max(cursorY, y + h) };
  }

  const placed = place(root, PAD_Y);
  let maxRight = 0;
  let maxBottom = placed.bottomY;
  for (const p of ordered) {
    if (p.x + p.w > maxRight) maxRight = p.x + p.w;
    if (p.y + p.h > maxBottom) maxBottom = p.y + p.h;
  }

  const edges: { from: PositionedNode; to: PositionedNode }[] = [];
  for (const p of ordered) {
    if (!p.node.parentId) continue;
    const parent = positioned.get(p.node.parentId);
    if (parent) edges.push({ from: parent, to: p });
  }

  return {
    nodes: ordered,
    edges,
    width: Math.max(720, maxRight + PAD_X),
    height: Math.max(220, maxBottom + PAD_Y),
  };
}

function collectLineage(root: DispatchNode, targetId: string | null): Set<string> | null {
  if (!targetId) return null;
  const parentMap = new Map<string, string | null>();
  const childrenMap = new Map<string, string[]>();

  function walk(node: DispatchNode): void {
    parentMap.set(node.id, node.parentId);
    childrenMap.set(node.id, node.children.map((c) => c.id));
    for (const c of node.children) walk(c);
  }
  walk(root);

  if (!parentMap.has(targetId)) return null;
  const keep = new Set<string>([targetId]);

  let cur = parentMap.get(targetId) ?? null;
  while (cur) {
    keep.add(cur);
    cur = parentMap.get(cur) ?? null;
  }

  const stack = [...(childrenMap.get(targetId) ?? [])];
  while (stack.length > 0) {
    const next = stack.pop()!;
    keep.add(next);
    for (const c of childrenMap.get(next) ?? []) stack.push(c);
  }
  return keep;
}

function flattenPreOrder(root: DispatchNode): DispatchNode[] {
  const rows: DispatchNode[] = [];
  function walk(node: DispatchNode): void {
    rows.push(node);
    for (const child of node.children) walk(child);
  }
  walk(root);
  return rows;
}

function pcbPath(x1: number, y1: number, x2: number, y2: number): string {
  const dy = y2 - y1;
  if (Math.abs(dy) < 2) return `M ${x1} ${y1} L ${x2} ${y2}`;
  const sign = Math.sign(dy);
  const absDy = Math.abs(dy);
  const availX = Math.max(12, x2 - x1);
  const bend1 = Math.min(22, absDy * 0.5, availX * 0.35);
  const bend2 = Math.min(10, Math.max(0, absDy - bend1));
  const midX = x1 + Math.round((availX - bend1 - bend2) * 0.44);
  return [
    `M ${x1} ${y1}`,
    `L ${midX} ${y1}`,
    `L ${midX + bend1} ${y1 + sign * bend1}`,
    `L ${midX + bend1} ${y2 - sign * bend2}`,
    `L ${midX + bend1 + bend2} ${y2}`,
    `L ${x2} ${y2}`,
  ].join(' ');
}

export function ProjectDispatchGraph({
  project,
  works,
  children,
  mode,
  onSelectTask,
  onOpenConversation,
}: {
  project: Project | undefined;
  works: readonly Task[];
  children: readonly Task[];
  mode: DispatchGraphMode;
  onSelectTask: (taskId: string) => void;
  onOpenConversation?: () => void;
}) {
  const { t } = useI18n();
  const [deepCanvas, setDeepCanvas] = useState<boolean>(loadDeepTone);
  const [includeEnded, setIncludeEnded] = useState<boolean>(false);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState<number>(() => Date.now());

  const { root, totalCount, hiddenEndedCount, hasRunning } = useMemo(
    () => buildDispatchTree(project, works, children, includeEnded, t),
    [project, works, children, includeEnded, t],
  );

  useEffect(() => {
    if (!hasRunning) return undefined;
    const timer = window.setInterval(() => setNowMs(Date.now()), 15_000);
    return () => window.clearInterval(timer);
  }, [hasRunning]);

  const lineage = useMemo(() => collectLineage(root, hoveredId), [root, hoveredId]);
  const hud = useMemo(() => (mode === 'hud' ? layoutHudTree(root) : null), [mode, root]);
  const traceRows = useMemo(() => (mode === 'trace' ? flattenPreOrder(root) : []), [mode, root]);

  const timeWindow = useMemo(() => {
    let minStart = Infinity;
    let maxEnd = -Infinity;
    for (const row of traceRows) {
      if (row.kind === 'router') continue;
      if (row.startMs !== null && row.startMs < minStart) minStart = row.startMs;
      const end = row.isLive ? nowMs : (row.endMs ?? row.startMs);
      if (end !== null && end > maxEnd) maxEnd = end;
    }
    if (!Number.isFinite(minStart) || !Number.isFinite(maxEnd) || maxEnd <= minStart) {
      return { minStart: nowMs - 15 * 60_000, maxEnd: nowMs, span: 15 * 60_000 };
    }
    const rawSpan = Math.max(60_000, maxEnd - minStart);
    return { minStart, maxEnd, span: rawSpan };
  }, [traceRows, nowMs]);

  const toneColor = (tone: Tone): string => (deepCanvas ? DEEP_TONE_COLOR[tone] : ADAPTIVE_TONE_COLOR[tone]);

  const toggleCanvas = (): void => {
    setDeepCanvas((prev) => {
      const next = !prev;
      saveDeepTone(next);
      return next;
    });
  };

  const handleNodeClick = (node: DispatchNode): void => {
    if (node.kind === 'router') {
      onOpenConversation?.();
      return;
    }
    onSelectTask(node.id);
  };

  return (
    <section
      aria-label={mode === 'hud' ? t('proj.graph.ariaHud') : t('proj.graph.ariaTrace')}
      data-slot="project-dispatch-graph"
      data-mode={mode}
      className={cn(
        'overflow-hidden rounded-xl border transition-colors',
        deepCanvas ? 'dispatch-stage-deep' : 'dispatch-stage-adaptive border-border text-foreground',
      )}
    >
      {/* Top telemetry bar */}
      <div
        className={cn(
          'flex flex-wrap items-center justify-between gap-2 border-b px-3.5 py-2 text-2xs',
          deepCanvas ? 'border-white/10 text-[#94a3b8]' : 'border-border text-muted-foreground',
        )}
      >
        <div className="flex flex-wrap items-center gap-3 font-mono">
          <span className={cn('font-semibold tracking-wider', deepCanvas ? 'text-[#e2e8f0]' : 'text-foreground')}>
            {mode === 'hud' ? t('proj.graph.headerHud') : t('proj.graph.headerTrace')}
          </span>
          <span>{t('proj.graph.nodeCount', { count: totalCount + 1 })}</span>
          <span className="inline-flex items-center gap-1">
            <span className="size-1.5 rounded-full" style={{ background: toneColor('running') }} />{t('proj.graph.legendRunning')}
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="size-1.5 rounded-full" style={{ background: toneColor('waiting') }} />{t('proj.graph.legendWaiting')}
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="size-1.5 rounded-full" style={{ background: toneColor('failed') }} />{t('proj.graph.legendBlocked')}
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="size-1.5 rounded-full" style={{ background: toneColor('success') }} />{t('proj.graph.legendDone')}
          </span>
        </div>

        <div className="flex items-center gap-2">
          {hiddenEndedCount > 0 || includeEnded ? (
            <button
              type="button"
              onClick={() => setIncludeEnded((v) => !v)}
              className={cn(
                'rounded-md border px-2 py-0.5 text-2xs font-medium transition-colors',
                deepCanvas
                  ? 'border-white/15 bg-white/5 text-[#cbd5e1] hover:border-white/30 hover:text-white'
                  : 'border-border bg-raised text-foreground hover:border-border-strong',
              )}
            >
              {includeEnded ? t('proj.graph.activeOnlyBtn') : t('proj.graph.includeEndedBtn', { count: hiddenEndedCount })}
            </button>
          ) : null}
          <button
            type="button"
            onClick={toggleCanvas}
            aria-label={deepCanvas ? t('proj.graph.switchAdaptiveAria') : t('proj.graph.switchDeepAria')}
            className={cn(
              'inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-2xs font-medium transition-colors',
              deepCanvas
                ? 'border-white/15 bg-white/5 text-[#cbd5e1] hover:border-white/30 hover:text-white'
                : 'border-border bg-raised text-foreground hover:border-border-strong',
            )}
          >
            {deepCanvas ? <Sun className="size-3" /> : <Moon className="size-3" />}
            {deepCanvas ? t('proj.graph.canvasDeep') : t('proj.graph.canvasAdaptive')}
          </button>
        </div>
      </div>

      {/* Main visualization stage */}
      {mode === 'hud' && hud ? (
        <div className="overflow-x-auto p-3 sm:p-4">
          <div
            className="relative mx-auto"
            style={{ width: `${hud.width}px`, height: `${hud.height}px` }}
            onMouseLeave={() => setHoveredId(null)}
          >
            <svg
              viewBox={`0 0 ${hud.width} ${hud.height}`}
              aria-hidden="true"
              className="pointer-events-none absolute inset-0 h-full w-full overflow-visible"
            >
              {hud.edges.map(({ from, to }) => {
                const x1 = from.x + from.w;
                const y1 = from.y + from.h / 2;
                const x2 = to.x;
                const y2 = to.y + to.h / 2;
                const col = toneColor(to.node.tone);
                const dimmed = lineage !== null && (!lineage.has(from.node.id) || !lineage.has(to.node.id));
                const d = pcbPath(x1, y1, x2, y2);
                const isRunning = to.node.isLive;
                const isReview = to.node.kind === 'review';
                return (
                  <g key={`${from.node.id}->${to.node.id}`} style={{ opacity: dimmed ? 0.16 : (to.node.tone === 'success' || to.node.tone === 'ended' ? 0.45 : 0.92), transition: 'opacity 150ms ease' }}>
                    <path
                      d={d}
                      fill="none"
                      stroke={col}
                      strokeWidth={isRunning ? 2 : 1.6}
                      strokeDasharray={!isRunning && isReview ? '5 4' : undefined}
                      className={isRunning ? 'dispatch-dash-flow' : undefined}
                    />
                    <circle cx={x1 + 1} cy={y1} r="3.4" fill={deepCanvas ? '#060913' : 'var(--background)'} stroke={col} strokeWidth="1.7" />
                    <circle cx={x2 - 1} cy={y2} r="3.4" fill={col} />
                  </g>
                );
              })}
            </svg>

            {hud.nodes.map(({ node, x, y, w, h }) => {
              const col = toneColor(node.tone);
              const dimmed = lineage !== null && !lineage.has(node.id);
              const highlighted = hoveredId === node.id;
              return (
                <button
                  key={node.id}
                  type="button"
                  data-dispatch-node={node.id}
                  title={`${node.code} · ${node.title}\n${node.actor}\n${node.detailLine}`}
                  onMouseEnter={() => setHoveredId(node.id)}
                  onFocus={() => setHoveredId(node.id)}
                  onBlur={() => setHoveredId((cur) => (cur === node.id ? null : cur))}
                  onClick={() => handleNodeClick(node)}
                  style={{
                    left: `${x}px`,
                    top: `${y}px`,
                    width: `${w}px`,
                    height: `${h}px`,
                    opacity: dimmed ? 0.28 : 1,
                    background: deepCanvas ? 'rgba(13, 21, 38, 0.86)' : 'color-mix(in oklab, var(--raised) 94%, transparent)',
                    borderColor: highlighted ? col : (deepCanvas ? 'rgba(148, 163, 184, 0.28)' : 'var(--border-strong)'),
                    boxShadow: highlighted ? `0 0 0 1px ${col}` : undefined,
                  }}
                  className={cn(
                    'dispatch-chamfer absolute flex flex-col justify-between border px-3 py-2 text-left transition-all duration-150',
                    deepCanvas ? 'text-[#f1f5f9] hover:brightness-110' : 'text-foreground hover:bg-hover/60',
                  )}
                >
                  <div className="flex items-center justify-between gap-2 font-mono text-2xs leading-none">
                    <span className="font-semibold tracking-wide" style={{ color: col }}>{node.code}</span>
                    <span className="inline-flex items-center gap-1" style={{ color: col }}>
                      <span
                        className={cn('size-1.5 rounded-full', node.isLive && 'animate-breathe')}
                        style={{ background: col }}
                      />
                      {node.stateLabel}
                    </span>
                  </div>
                  <div className="truncate text-xs font-semibold leading-tight">{node.title}</div>
                  <div
                    className="truncate font-mono text-2xs leading-none"
                    style={{ color: deepCanvas ? '#94a3b8' : 'var(--muted-foreground)' }}
                  >
                    {node.actor}
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      ) : (
        <div className="space-y-1.5 p-3 sm:p-4">
          <div
            className={cn(
              'hidden grid-cols-12 gap-3 px-3 pb-1 font-mono text-2xs sm:grid',
              deepCanvas ? 'text-[#8c9bb5]' : 'text-muted-foreground',
            )}
          >
            <div className="col-span-5">{t('proj.graph.traceColTree')}</div>
            <div className="col-span-3">{t('proj.graph.traceColExecutor')}</div>
            <div className="col-span-4 flex items-center justify-between">
              <span>{formatClock(timeWindow.minStart)}</span>
              <span>{formatClock(timeWindow.minStart + timeWindow.span / 2)}</span>
              <span>{hasRunning ? 'LIVE NOW ▍' : formatClock(timeWindow.maxEnd)}</span>
            </div>
          </div>

          {traceRows.map((node) => {
            const col = toneColor(node.tone);
            const indentPx = Math.min(node.depth, 4) * 20;
            const startPct = node.kind === 'router'
              ? 0
              : node.startMs !== null
                ? Math.max(0, Math.min(92, ((node.startMs - timeWindow.minStart) / timeWindow.span) * 100))
                : 0;
            const endTarget = node.isLive ? nowMs : (node.endMs ?? node.startMs ?? nowMs);
            const rawWidthPct = node.kind === 'router'
              ? 100
              : node.startMs !== null
                ? ((Math.max(node.startMs, endTarget) - node.startMs) / timeWindow.span) * 100
                : 12;
            const widthPct = Math.max(6, Math.min(100 - startPct, rawWidthPct));
            const elapsed = elapsedLabel(node, nowMs, t);

            return (
              <button
                key={node.id}
                type="button"
                data-dispatch-node={node.id}
                title={`${node.code} · ${node.title}\n${node.actor}\n${node.detailLine}`}
                onClick={() => handleNodeClick(node)}
                style={{
                  background: deepCanvas ? 'rgba(15, 23, 42, 0.72)' : 'color-mix(in oklab, var(--raised) 92%, transparent)',
                  borderColor: deepCanvas ? 'rgba(148, 163, 184, 0.2)' : 'var(--border)',
                }}
                className={cn(
                  'grid w-full grid-cols-1 items-center gap-2 rounded-lg border px-3 py-2 text-left transition-colors sm:grid-cols-12 sm:gap-3',
                  deepCanvas ? 'text-[#f1f5f9] hover:border-[#38bdf8]/60' : 'text-foreground hover:border-primary/60 hover:bg-hover/40',
                )}
              >
                <div className="flex min-w-0 items-center gap-2 sm:col-span-5" style={{ paddingLeft: `${indentPx}px` }}>
                  {node.depth > 0 ? (
                    <span
                      aria-hidden="true"
                      className="flex-none font-mono text-2xs"
                      style={{ color: deepCanvas ? '#64748b' : 'var(--faint)' }}
                    >
                      └─
                    </span>
                  ) : null}
                  {node.tone === 'failed' ? (
                    <span
                      aria-hidden="true"
                      className="size-2 flex-none rotate-45"
                      style={{ background: col }}
                    />
                  ) : (
                    <span
                      aria-hidden="true"
                      className={cn('size-2 flex-none rounded-full', node.isLive && 'animate-breathe')}
                      style={{ background: col }}
                    />
                  )}
                  <span className="flex-none font-mono text-2xs font-semibold" style={{ color: col }}>
                    {node.code}
                  </span>
                  <span className="min-w-0 truncate text-xs font-medium">{node.title}</span>
                </div>

                <div
                  className="truncate font-mono text-2xs sm:col-span-3"
                  style={{ color: deepCanvas ? '#94a3b8' : 'var(--muted-foreground)' }}
                >
                  {node.actor}
                </div>

                <div className="flex items-center gap-2 sm:col-span-4">
                  <div
                    className="relative h-4 flex-1 overflow-hidden rounded-xs"
                    style={{
                      background: deepCanvas
                        ? 'rgba(148, 163, 184, 0.12)'
                        : 'color-mix(in oklab, var(--foreground) 7%, transparent)',
                    }}
                  >
                    <div
                      className="relative h-full overflow-hidden rounded-xs"
                      style={{
                        marginLeft: `${startPct}%`,
                        width: `${widthPct}%`,
                        background: `color-mix(in srgb, ${col} 26%, transparent)`,
                        border: `1px solid ${col}`,
                      }}
                    >
                      {node.isLive ? (
                        <div
                          className="dispatch-scan-bar absolute inset-y-0 w-1/3"
                          style={{
                            background: `linear-gradient(90deg, transparent, ${col}, transparent)`,
                            opacity: 0.7,
                          }}
                        />
                      ) : null}
                    </div>
                  </div>
                  <span
                    className="w-14 flex-none text-right font-mono text-2xs tabular-nums"
                    style={{ color: col }}
                  >
                    {elapsed}
                  </span>
                </div>
              </button>
            );
          })}
        </div>
      )}

      {/* Footer legend */}
      <div
        className={cn(
          'flex flex-wrap items-center justify-between gap-2 border-t px-3.5 py-2 text-2xs',
          deepCanvas ? 'border-white/10 text-[#8c9bb5]' : 'border-border text-muted-foreground',
        )}
      >
        <span>
          {mode === 'hud'
            ? t('proj.graph.footerHud')
            : t('proj.graph.footerTrace')}
        </span>
        <span className="font-mono">SYS · WRK · SUB · REV · CLU</span>
      </div>
    </section>
  );
}
