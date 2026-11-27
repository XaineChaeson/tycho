// A project's triggers (docs/design/triggers.md §1, §7): a 24h telemetry schedule timeline synced
// with a Master-Detail split workbench — compact left schedule rail, full right rule & instruction
// inspector, recent occurrences below, and the sheet form that makes or changes one. The service
// parses every definition; this only carries it. Inbound sources live on their own page.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Bell, Check, Clock, Copy, CopyPlus, Pencil, Plus, Radio, Trash2, Zap } from 'lucide-react';
import { Fragment, useEffect, useMemo, useState } from 'react';
import { MISSED_LABELS, MISSED_POLICIES, SCHEDULE_KINDS, SCHEDULE_LABELS, SOURCE_LABELS, TRIGGER_SOURCES, type MissedPolicy, type ScheduleKind } from '@shared/triggers.ts';
import { INTERNAL_EVENT_KINDS, INTERNAL_EVENT_LABELS, INTERNAL_EVENT_WHEN, type InternalEventKind } from '@shared/internal-events.ts';
import { Empty, Field, Problem, Rows, SectionTitle, Time } from '@/components/bits';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox, Choice } from '@/components/ui/checkbox';
import { Confirm, Sheet, SheetContent } from '@/components/ui/dialog';
import { Input, Textarea } from '@/components/ui/input';
import { Option, Select } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { del, messageOf, post, put } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { tasksQuery, triggersQuery } from '@/lib/queries';
import { buildScheduleTimeline, cloneDraftOf, draftOf, emptyDraft, fireLine, isTriggerActive, isTriggerEnded, nextLine, triggerBody, triggerClockMeta, type ScheduleTimeline, type TriggerDraft, type TriggerSource } from '@/lib/triggers';
import type { BroadcastGroupChoice, Task, Trigger, TriggerFire } from '@/lib/types';
import { cn } from '@/lib/utils';

const RECENT_SHOWN = 10;
const TRIGGER_RECENT_SHOWN = 5;
const MINUTE_MS = 60_000;
const MANUAL_TASK = '__manual__';
const AXIS_HOURS = [0, 3, 6, 9, 12, 15, 18, 21, 24] as const;

const SOURCES: readonly TriggerSource[] = TRIGGER_SOURCES;

type TriggerFilter = 'active' | 'schedule' | 'event' | 'disabled' | 'ended';

function TriggerForm({ id, draft, made, minIntervalMs, groups = [], tasks = [], busy, error, onChange, onSave }: {
  id: string;
  draft: TriggerDraft;
  // An existing trigger keeps its source.
  made: boolean;
  minIntervalMs: number;
  groups?: BroadcastGroupChoice[];
  tasks?: readonly Task[];
  busy: boolean;
  error: string | null;
  onChange: (draft: TriggerDraft) => void;
  onSave: () => void;
}) {
  const { t } = useI18n();
  const [manualTask, setManualTask] = useState(false);
  const set = (patch: Partial<TriggerDraft>) => onChange({ ...draft, ...patch });
  const matchesKnownTask = tasks.some((task) => task.id === draft.eventTask);
  const showManualTask = tasks.length === 0 || manualTask || (draft.eventTask.trim() !== '' && !matchesKnownTask);
  const taskSelectValue = showManualTask ? MANUAL_TASK : draft.eventTask;
  const toggleGroup = (groupId: string): void => set({
    broadcastGroupIds: draft.broadcastGroupIds.includes(groupId)
      ? draft.broadcastGroupIds.filter((each) => each !== groupId)
      : [...draft.broadcastGroupIds, groupId],
  });
  const minIntervalMinutes = Math.round(minIntervalMs / MINUTE_MS);
  const scheduleHint = draft.kind === 'cron'
    ? t('proj.trig.scheduleHintCron', { minutes: minIntervalMinutes })
    : draft.kind === 'once'
      ? t('proj.trig.scheduleHintOnce')
      : t('proj.trig.scheduleHintEvery', { minutes: minIntervalMinutes });
  return (
    <form id={id} className="grid gap-4" onSubmit={(event) => { event.preventDefault(); onSave(); }}>
      <Field label={t('proj.trig.fieldName')}>
        <Input aria-label={t('proj.trig.fieldNameAria')} placeholder={t('proj.trig.fieldNamePlaceholder')} value={draft.name} disabled={busy} onChange={(event) => set({ name: event.target.value })} />
      </Field>
      <Field label={t('proj.trig.fieldInstruction')} hint={t('proj.trig.fieldInstructionHint')}>
        <Textarea aria-label={t('proj.trig.fieldInstruction')} rows={4} className="max-h-[40vh] overflow-y-auto" value={draft.instruction} disabled={busy} onChange={(event) => set({ instruction: event.target.value })} />
      </Field>
      <Field label={t('proj.trig.fieldSource')} hint={made ? t('proj.trig.fieldSourceHintLocked') : t('proj.trig.fieldSourceHintNew')}>
        <Select aria-label={t('proj.trig.fieldSource')} value={draft.source} disabled={busy || made} onChange={(event) => set({ source: event.target.value as TriggerSource })}>
          {SOURCES.map((source) => <Option key={source} value={source}>{SOURCE_LABELS[source]}</Option>)}
        </Select>
      </Field>
      {draft.source === 'event' ? (
        <Field label={t('proj.trig.fieldEvent')} hint={t('proj.trig.fieldEventHint', { when: INTERNAL_EVENT_WHEN[draft.eventKind] })}>
          <div className="grid gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <Select aria-label={t('proj.trig.eventLabel')} value={draft.eventKind} disabled={busy} onChange={(event) => set({ eventKind: event.target.value as InternalEventKind })}>
                {INTERNAL_EVENT_KINDS.map((kind) => <Option key={kind} value={kind}>{INTERNAL_EVENT_LABELS[kind]}</Option>)}
              </Select>
              {tasks.length > 0 ? (
                <Select
                  aria-label={t('proj.trig.selectTaskAria')}
                  wrapperClassName="min-w-48 flex-1"
                  className="w-full"
                  value={taskSelectValue}
                  disabled={busy}
                  onChange={(event) => {
                    const value = event.target.value;
                    if (value === MANUAL_TASK) {
                      setManualTask(true);
                    } else {
                      setManualTask(false);
                      set({ eventTask: value });
                    }
                  }}
                >
                  <Option value="">{t('proj.trig.allProjectTasks')}</Option>
                  {tasks.map((task) => (
                    <Option key={task.id} value={task.id}>
                      {t('proj.trig.taskOption', {
                        prefix: task.parent_id ? '↳ ' : '',
                        title: task.title,
                        shortId: task.id.slice(0, 8),
                      })}
                    </Option>
                  ))}
                  <Option value={MANUAL_TASK}>{t('proj.trig.manualTaskOption')}</Option>
                </Select>
              ) : null}
            </div>
            {showManualTask ? (
              <Input aria-label={t('proj.trig.manualTaskAria')} placeholder={t('proj.trig.manualTaskPlaceholder')} className="min-w-52 flex-1 font-mono text-xs" value={draft.eventTask} disabled={busy} onChange={(event) => set({ eventTask: event.target.value })} />
            ) : null}
          </div>
        </Field>
      ) : (
        <Field
          label={t('proj.trig.fieldSchedule')}
          hint={scheduleHint}
        >
          <div className="flex flex-wrap items-center gap-2">
            <Select aria-label={t('proj.trig.fieldSchedule')} value={draft.kind} disabled={busy} onChange={(event) => set({ kind: event.target.value as ScheduleKind })}>
              {SCHEDULE_KINDS.map((kind) => <Option key={kind} value={kind}>{SCHEDULE_LABELS[kind]}</Option>)}
            </Select>
            {draft.kind === 'once' ? (
              <Input aria-label={t('proj.trig.atAria')} type="datetime-local" className="w-auto" value={draft.at} disabled={busy} onChange={(event) => set({ at: event.target.value })} />
            ) : draft.kind === 'every' ? (
              <>
                <Input aria-label={t('proj.trig.everyMinutesAria')} type="number" min={1} className="w-20" value={draft.everyMinutes} disabled={busy} onChange={(event) => set({ everyMinutes: event.target.value })} />
                <span className="text-sm text-muted-foreground">{t('proj.trig.minutesFrom')}</span>
                <Input aria-label={t('proj.trig.startAtAria')} type="datetime-local" className="w-auto" value={draft.startAt} disabled={busy} onChange={(event) => set({ startAt: event.target.value })} />
              </>
            ) : (
              <>
                <Input aria-label={t('proj.trig.cronAria')} className="w-36 font-mono text-xs" value={draft.cron} disabled={busy} onChange={(event) => set({ cron: event.target.value })} />
                <Input aria-label={t('proj.trig.zoneAria')} className="w-44 font-mono text-xs" value={draft.zone} disabled={busy} onChange={(event) => set({ zone: event.target.value })} />
              </>
            )}
          </div>
        </Field>
      )}
      <div className="flex flex-wrap items-end gap-4">
        {draft.source === 'schedule' ? (
          <Field label={t('proj.trig.fieldMissed')}>
            <Select aria-label={t('proj.trig.fieldMissedAria')} value={draft.missed} disabled={busy} onChange={(event) => set({ missed: event.target.value as MissedPolicy })}>
              {MISSED_POLICIES.map((policy) => <Option key={policy} value={policy}>{MISSED_LABELS[policy]}</Option>)}
            </Select>
          </Field>
        ) : null}
        <Field label={t('proj.trig.fieldExpires')}>
          <Input aria-label={t('proj.trig.fieldExpiresAria')} type="datetime-local" className="w-auto" value={draft.expires} disabled={busy} onChange={(event) => set({ expires: event.target.value })} />
        </Field>
      </div>
      <Choice className="items-start">
        <Switch aria-label={t('proj.trig.pushFinalLabel')} className="mt-1.5" checked={draft.pushFinal} disabled={busy} onCheckedChange={(on) => set({ pushFinal: on })} />
        <span className="py-1.5">{t('proj.trig.pushFinalText')}</span>
      </Choice>
      <div className="grid gap-2">
        <Choice className="items-start">
          <Switch aria-label={t('proj.trig.broadcastGroupsLabel')} className="mt-1.5" checked={draft.broadcastGroups} disabled={busy} onCheckedChange={(on) => set({ broadcastGroups: on })} />
          <span className="py-1.5">
            {t('proj.trig.broadcastGroupsLabel')}
            <span className="mt-0.5 block text-xs text-muted-foreground">
              {t('proj.trig.broadcastGroupsHint')}
            </span>
          </span>
        </Choice>
        {draft.broadcastGroups && groups.length > 0 ? (
          <div className="ml-11 grid gap-1 rounded-lg border border-border bg-muted/60 p-3">
            <span className="mb-0.5 text-xs font-medium text-muted-foreground">{t('proj.trig.limitGroupsHint')}</span>
            {groups.map((group) => (
              <Choice key={group.id} className="min-h-8">
                <Checkbox
                  aria-label={group.chat_name || group.chat_id}
                  checked={draft.broadcastGroupIds.includes(group.id)}
                  disabled={busy}
                  onChange={() => toggleGroup(group.id)}
                />
                <span className="min-w-0 truncate text-sm">{group.chat_name || group.chat_id}</span>
                <Badge tone="plain" className="text-2xs">{group.channel === 'wecom' ? t('proj.trig.channelWecom') : t('proj.trig.channelWeixin')}</Badge>
                {(!group.enabled || !group.notify_events) ? (
                  <Badge tone="waiting" className="ml-auto text-2xs">{!group.enabled ? t('common.disabled') : t('proj.trig.groupNotifyOff')}</Badge>
                ) : null}
              </Choice>
            ))}
          </div>
        ) : null}
      </div>
      {error ? <Problem role="alert">{error}</Problem> : null}
    </form>
  );
}

// Render inline `code` segments cleanly without dangerouslySetInnerHTML.
function InlineFormatted({ text }: { text: string }) {
  const segments = text.split(/(`[^`\n]+`)/g);
  return (
    <>
      {segments.map((segment, index) => (
        segment.startsWith('`') && segment.endsWith('`') && segment.length > 2
          ? <code key={index} className="rounded bg-code px-1 py-0.5 font-mono text-xs text-foreground">{segment.slice(1, -1)}</code>
          : <Fragment key={index}>{segment}</Fragment>
      ))}
    </>
  );
}

function InstructionBlock({ text }: { text: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const lines = useMemo(() => text.split(/\r?\n/), [text]);

  async function copyText(): Promise<void> {
    try {
      await navigator.clipboard?.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      /* clipboard may be unavailable in restricted contexts */
    }
  }

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <span className="font-medium">{t('proj.trig.instructionHeading')}</span>
        <div className="flex items-center gap-2">
          <span className="font-mono tabular-nums text-faint">{t('proj.trig.charCount', { count: text.length })}</span>
          <button
            type="button"
            onClick={() => void copyText()}
            className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-hover hover:text-foreground"
          >
            {copied ? <Check className="size-3 text-success" /> : <Copy className="size-3" />}
            {copied ? t('common.copied') : t('common.copy')}
          </button>
        </div>
      </div>
      <div className="max-h-[420px] space-y-1.5 overflow-y-auto rounded-lg border border-border bg-muted/55 px-3.5 py-3 text-xs leading-relaxed text-foreground wrap-anywhere">
        {lines.map((line, index) => (
          line.trim() === ''
            ? <div key={index} className="h-1.5" />
            : <p key={index} className="whitespace-pre-wrap"><InlineFormatted text={line} /></p>
        ))}
      </div>
    </div>
  );
}

function ScheduleTimelineBar({ timeline, selectedId, onSelect }: {
  timeline: ScheduleTimeline;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const { t } = useI18n();
  if (!timeline.visible) return null;
  return (
    <div
      aria-label={t('proj.trig.timelineAria')}
      className="rounded-xl border border-border bg-raised px-4 py-3"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
        <div className="flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-1.5 font-semibold text-foreground">
            <Clock className="size-3.5 text-primary" />
            {t('proj.trig.timelineTitle')}
          </span>
          <span className="font-mono tabular-nums text-muted-foreground">
            {timeline.dateLabel} · {timeline.zone}
          </span>
          {timeline.laterCount > 0 ? (
            <span className="rounded-full border border-border bg-muted px-2 py-0.5 text-xs tabular-nums text-muted-foreground">
              {t('proj.trig.laterScheduled', { count: timeline.laterCount })}
            </span>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
          {timeline.pastFires.length > 0 ? (
            <span className="inline-flex items-center gap-1.5">
              <span className="size-1.5 rounded-full bg-success" />{t('proj.trig.legendFired')}
            </span>
          ) : null}
          <span className="inline-flex items-center gap-1.5">
            <span className="size-2 rounded-full bg-primary" />{t('proj.trig.legendUpcoming')}
          </span>
          {timeline.nowLabel ? (
            <span className="inline-flex items-center gap-1.5 font-mono tabular-nums">
              <span className="size-1.5 rounded-full bg-waiting" />{t('proj.trig.legendNow', { time: timeline.nowLabel })}
            </span>
          ) : null}
        </div>
      </div>

      <div className="relative mt-2 h-[74px] select-none">
        {/* Base 24h track */}
        <div className="absolute right-2 left-2 top-[38px] h-[2px] rounded-full bg-border" />
        {/* Elapsed bar */}
        {timeline.nowPct !== null ? (
          <div
            className="absolute left-2 top-[38px] h-[2px] rounded-full bg-primary/45"
            style={{ width: `calc((100% - 16px) * ${timeline.nowPct / 100})` }}
          />
        ) : null}

        <div className="absolute inset-x-2 top-[38px]">
          {/* 3-hour ticks */}
          {AXIS_HOURS.map((hour) => {
            const left = `${(hour / 24) * 100}%`;
            const label = `${String(hour).padStart(2, '0')}:00`;
            const align = hour === 0 ? 'translateX(0)' : hour === 24 ? 'translateX(-100%)' : 'translateX(-50%)';
            return (
              <div key={hour} className="absolute top-0" style={{ left }}>
                <div className="h-2 w-px -translate-y-0.5 bg-border" />
                <div
                  className="mt-1.5 font-mono text-2xs tabular-nums text-faint"
                  style={{ transform: align }}
                >
                  {label}
                </div>
              </div>
            );
          })}

          {/* Current time cursor */}
          {timeline.nowPct !== null && timeline.nowLabel ? (
            <div
              className="pointer-events-none absolute -top-3.5"
              style={{ left: `${timeline.nowPct}%`, transform: 'translateX(-50%)' }}
              title={t('proj.trig.cursorNowTitle', { time: timeline.nowLabel })}
            >
              <div className="mx-auto h-7 w-[2px] rounded-full bg-waiting" />
            </div>
          ) : null}

          {/* Past fired dots */}
          {timeline.pastFires.map((dot) => {
            const bad = dot.outcome === 'missed' || dot.outcome === 'expired';
            return (
              <div
                key={dot.id}
                className={cn(
                  'absolute top-[1px] size-2 -translate-x-1/2 -translate-y-1/2 rounded-full opacity-75',
                  bad ? 'bg-failed' : 'bg-success',
                )}
                style={{ left: `${dot.pct}%` }}
                title={`${dot.timeLabel} · ${dot.name}`}
              />
            );
          })}

          {/* Interactive upcoming schedule nodes */}
          {timeline.nodes.map((node) => {
            const active = node.id === selectedId;
            const isTop = node.row === 'top';
            return (
              <button
                key={node.id}
                type="button"
                aria-label={t('proj.trig.nodeAria', { time: node.timeLabel, name: node.name })}
                aria-pressed={active}
                onClick={() => onSelect(node.id)}
                className="group absolute top-[1px] cursor-pointer focus-visible:outline-none"
                style={{ left: `${node.pct}%` }}
                title={t('proj.trig.nodeTitle', { time: node.timeLabel, countdown: node.countdown, name: node.name })}
              >
                <span
                  className={cn(
                    'block size-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-raised transition-transform',
                    active
                      ? 'scale-125 bg-primary ring-4 ring-primary/25'
                      : 'bg-primary/80 group-hover:scale-115 group-hover:bg-primary',
                  )}
                />
                <span
                  className={cn(
                    'absolute left-0 -translate-x-1/2 whitespace-nowrap rounded px-1.5 py-0.5 font-mono text-2xs tabular-nums transition-colors',
                    active
                      ? 'bg-primary font-semibold text-primary-foreground shadow-xs'
                      : 'border border-border bg-background text-foreground group-hover:border-primary',
                  )}
                  style={isTop ? { bottom: '12px' } : { top: '10px' }}
                >
                  {node.timeLabel}
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function MasterRow({ trigger, zone, nowMs, selected, busy, onSelect, onToggle }: {
  trigger: Trigger;
  zone: string;
  nowMs: number;
  selected: boolean;
  busy: boolean;
  onSelect: () => void;
  onToggle: () => void;
}) {
  const { t } = useI18n();
  const meta = triggerClockMeta(trigger, zone, nowMs);
  const hasIssue = Boolean(trigger.problem || trigger.next_error || trigger.rejected);
  return (
    <li
      aria-label={t('proj.trig.rowAria', { name: trigger.name })}
      aria-current={selected ? 'true' : undefined}
      className={cn(
        'relative flex items-center gap-2.5 border-l-2 px-3 py-2.5 transition-colors',
        selected
          ? 'border-l-primary bg-muted/80'
          : 'border-l-transparent hover:bg-hover/45',
        !trigger.enabled && 'opacity-65',
      )}
    >
      <button
        type="button"
        onClick={onSelect}
        className="flex min-w-0 flex-1 cursor-pointer items-center gap-2.5 text-left focus-visible:outline-none"
      >
        <div
          className={cn(
            'flex w-14 flex-none flex-col items-center justify-center rounded-md border px-1 py-1 text-center',
            selected
              ? 'border-brand-border bg-brand-soft'
              : 'border-border bg-background',
          )}
        >
          <span className={cn(
            'inline-flex items-center gap-0.5 font-mono text-xs font-bold tabular-nums leading-tight',
            selected ? 'text-brand-foreground' : 'text-foreground',
          )}>
            {meta.isEvent ? <Zap className="size-3" /> : null}
            {meta.clock}
          </span>
          <span className="mt-0.5 max-w-full truncate text-2xs leading-tight text-muted-foreground">
            {meta.dateTag}
          </span>
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className={cn(
              'min-w-0 truncate text-sm leading-snug',
              selected ? 'font-semibold text-foreground' : 'font-medium text-foreground',
            )}>
              {trigger.name}
            </span>
            {hasIssue ? (
              <span
                className="size-2 flex-none rounded-full bg-failed"
                title={trigger.problem?.text ?? trigger.next_error ?? trigger.rejected?.text ?? t('proj.trig.issueFallback')}
              />
            ) : null}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-muted-foreground">
            <span className={cn(
              'tabular-nums',
              meta.urgent && trigger.enabled && 'font-medium text-waiting-foreground',
            )}>
              {meta.countdown}
            </span>
            {trigger.push_final ? <span className="text-faint">{t('proj.trig.rowPushFinal')}</span> : null}
            {trigger.broadcast_groups ? <span className="text-faint">{t('proj.trig.rowBroadcast')}</span> : null}
          </div>
        </div>
      </button>

      <div className="flex-none" onClick={(event) => event.stopPropagation()}>
        {isTriggerEnded(trigger) ? (
          <Badge tone="ended" className="text-2xs">{trigger.ended === 'done' ? t('proj.trig.endedDone') : t('proj.trig.endedExpired')}</Badge>
        ) : (
          <Switch
            aria-label={trigger.enabled ? t('proj.trig.disableNamedAria', { name: trigger.name }) : t('proj.trig.enableNamedAria', { name: trigger.name })}
            checked={trigger.enabled}
            disabled={busy}
            onCheckedChange={() => onToggle()}
          />
        )}
      </div>
    </li>
  );
}

function TriggerInspector({ trigger, zone, nowMs, groups, fires, busy, onEdit, onClone, onToggle, onDelete }: {
  trigger: Trigger;
  zone: string;
  nowMs: number;
  groups: readonly BroadcastGroupChoice[];
  fires: readonly TriggerFire[];
  busy: boolean;
  onEdit: () => void;
  onClone: () => void;
  onToggle: () => void;
  onDelete: () => void;
}) {
  const { t } = useI18n();
  const meta = triggerClockMeta(trigger, zone, nowMs);
  const ended = isTriggerEnded(trigger);
  const pinnedGroups = useMemo(() => {
    const ids = trigger.broadcast_group_ids ?? [];
    if (ids.length === 0) return [];
    const byId = new Map(groups.map((g) => [g.id, g]));
    return ids.map((id) => byId.get(id)?.chat_name || byId.get(id)?.chat_id || id.slice(0, 8));
  }, [trigger.broadcast_group_ids, groups]);

  return (
    <article
      aria-label={t('proj.trig.inspectorAria', { name: trigger.name })}
      className="overflow-hidden rounded-xl border border-border bg-raised"
    >
      {/* Inspector Header */}
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border bg-muted/45 px-5 py-4">
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge tone={ended ? 'ended' : trigger.enabled ? 'success' : 'ended'}>
              {ended
                ? (trigger.ended === 'done' ? t('proj.trig.statusFiredEnded') : t('proj.trig.endedExpired'))
                : trigger.enabled
                  ? t('proj.trig.statusEnabled')
                  : t('common.disabled')}
            </Badge>
            <Badge tone={meta.isEvent ? 'running' : meta.urgent && trigger.enabled && !ended ? 'waiting' : 'plain'} className="font-mono tabular-nums">
              {meta.isEvent ? meta.dateTag : `${meta.dateTag} ${meta.clock}`} · {meta.countdown}
            </Badge>
            {trigger.push_final ? <Badge tone="plain">{t('proj.trig.badgePushFinal')}</Badge> : null}
            {trigger.broadcast_groups ? <Badge tone="plain">{t('proj.trig.badgeBroadcast')}</Badge> : null}
          </div>
          <h2 className="text-base font-semibold leading-snug text-foreground wrap-anywhere">
            {trigger.name}
          </h2>
        </div>

        <div className="flex flex-none flex-wrap items-center gap-1.5">
          {ended ? (
            <Button size="sm" variant="primary" disabled={busy} onClick={onClone}>
              <CopyPlus className="size-3.5" />{t('proj.trig.cloneBtn')}
            </Button>
          ) : null}
          <Button size="sm" variant="secondary" disabled={busy} onClick={onEdit}>
            <Pencil className="size-3.5" />{t('common.edit')}
          </Button>
          {!ended ? (
            <Button size="sm" variant="ghost" disabled={busy} onClick={onToggle}>
              {trigger.enabled ? t('proj.trig.disableBtn') : t('proj.trig.enableBtn')}
            </Button>
          ) : null}
          <Button size="sm" variant="danger" disabled={busy} onClick={onDelete}>
            <Trash2 className="size-3.5" />{t('common.delete')}
          </Button>
        </div>
      </div>

      <div className="space-y-4 p-5">
        {/* Problem & Rejection Alerts */}
        {trigger.problem ? (
          <div role="alert" className="flex items-start gap-2 rounded-lg border border-failed-border bg-failed-soft px-3.5 py-2.5 text-xs text-failed-foreground wrap-anywhere">
            <AlertTriangle className="mt-0.5 size-3.5 flex-none" />
            <span>
              {t('proj.trig.problemPrefix', { text: trigger.problem.text })}
              {t('proj.trig.parenOpen')}
              <Time at={trigger.problem.since} prefix={t('proj.trig.timeSincePrefix')} />
              {t('proj.trig.parenClose')}
            </span>
          </div>
        ) : null}

        {trigger.rejected ? (
          <div className="flex items-start gap-2 rounded-lg border border-waiting-border bg-waiting-soft px-3.5 py-2.5 text-xs text-waiting-foreground wrap-anywhere">
            <AlertTriangle className="mt-0.5 size-3.5 flex-none" />
            <span>
              {t('proj.trig.rejectedPrefix', { count: trigger.rejected.count, text: trigger.rejected.text })}
              {t('proj.trig.parenOpen')}
              <Time at={trigger.rejected.at} />
              {t('proj.trig.parenClose')}
            </span>
          </div>
        ) : null}

        {/* Structured Spec Grid */}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="space-y-1 rounded-lg border border-border bg-background px-3.5 py-3 text-xs">
            <div className="font-medium text-muted-foreground">{t('proj.trig.ruleAndNextHeading')}</div>
            <div className="font-medium text-foreground wrap-anywhere">
              {trigger.schedule_text}
              {trigger.source === 'schedule' ? t('proj.trig.missedSummary', { policy: MISSED_LABELS[trigger.missed] }) : ''}
            </div>
            <div className="text-muted-foreground wrap-anywhere">{nextLine(trigger)}</div>
            {trigger.expires_at ? (
              <div className="text-muted-foreground">
                <Time at={trigger.expires_at} prefix={t('proj.trig.expiresPrefix')} />
              </div>
            ) : null}
          </div>

          <div className="space-y-1.5 rounded-lg border border-border bg-background px-3.5 py-3 text-xs">
            <div className="font-medium text-muted-foreground">{t('proj.trig.deliveryHeading')}</div>
            <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
              <span className={cn(
                'inline-flex items-center gap-1 rounded-md border px-2 py-0.5',
                trigger.push_final
                  ? 'border-brand-border bg-brand-soft text-brand-foreground'
                  : 'border-border bg-muted/60 text-muted-foreground',
              )}>
                <Bell className="size-3" />
                {trigger.push_final ? t('proj.trig.pushFinalLabel') : t('proj.trig.noPushFinal')}
              </span>
              <span className={cn(
                'inline-flex items-center gap-1 rounded-md border px-2 py-0.5',
                trigger.broadcast_groups
                  ? 'border-success-border bg-success-soft text-success-foreground'
                  : 'border-border bg-muted/60 text-muted-foreground',
              )}>
                <Radio className="size-3" />
                {trigger.broadcast_groups
                  ? (pinnedGroups.length > 0
                    ? t('proj.trig.broadcastPinned', { groups: pinnedGroups.join(t('proj.delete.listSep')) })
                    : t('proj.trig.broadcastAll'))
                  : t('proj.trig.noBroadcast')}
              </span>
            </div>
          </div>
        </div>

        {/* Full Instruction */}
        <InstructionBlock text={trigger.instruction} />

        {/* Per-Trigger Fire History */}
        <div className="space-y-2 pt-1">
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span className="font-medium">{t('proj.trig.perTriggerHistory')}</span>
            {fires.length > 0 ? <span className="tabular-nums">{t('proj.trig.historyTotal', { count: fires.length })}</span> : null}
          </div>
          {fires.length > 0 ? (
            <ul className="divide-y divide-border rounded-lg border border-border bg-background">
              {fires.slice(0, TRIGGER_RECENT_SHOWN).map((fire) => {
                const bad = fire.outcome === 'missed' || fire.outcome === 'expired';
                return (
                  <li key={fire.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-xs">
                    <span className="inline-flex items-center gap-2">
                      <span className={cn('size-1.5 rounded-full', bad ? 'bg-failed' : 'bg-success')} />
                      <Time at={fire.scheduled_at ?? fire.created_at} className="font-mono text-muted-foreground tabular-nums" />
                    </span>
                    <span className="text-muted-foreground">{fireLine(fire)}</span>
                  </li>
                );
              })}
            </ul>
          ) : (
            <div className="rounded-lg border border-dashed border-border px-3.5 py-2.5 text-xs text-muted-foreground">
              {trigger.enabled && trigger.next_local
                ? <>{t('proj.trig.firstFirePrefix')}<span className="font-mono text-foreground">{trigger.next_local}</span>{t('proj.trig.firstFireSuffix')}</>
                : t('proj.trig.noFiresYet')}
            </div>
          )}
        </div>
      </div>
    </article>
  );
}

export function ProjectTriggers({ projectId, projectName }: { projectId: string; projectName: string }) {
  const { t } = useI18n();
  const query = triggersQuery(projectId);
  const { data, error: unread, isPending } = useQuery(query);
  const { data: taskListing } = useQuery(tasksQuery);
  const client = useQueryClient();

  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), MINUTE_MS);
    return () => window.clearInterval(timer);
  }, []);

  const projectTasks = useMemo(() => {
    const top = (taskListing?.tasks ?? []).filter((task) => task.project_id === projectId);
    const topIds = new Set(top.map((task) => task.id));
    const subs = (taskListing?.children ?? []).filter(
      (task) => task.project_id === projectId || (task.parent_id != null && topIds.has(task.parent_id)),
    );
    return [...top, ...subs];
  }, [taskListing, projectId]);

  const [filter, setFilter] = useState<TriggerFilter>('active');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: string | null; draft: TriggerDraft } | null>(null);
  const [confirming, setConfirming] = useState<Trigger | null>(null);
  const [clearingEnded, setClearingEnded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const triggers = data?.triggers ?? [];
  const recent = data?.recent ?? [];
  const zone = data?.zone ?? 'UTC';

  const endedTriggers = useMemo(() => triggers.filter(isTriggerEnded), [triggers]);

  const counts = useMemo(() => ({
    active: triggers.filter(isTriggerActive).length,
    schedule: triggers.filter((t) => isTriggerActive(t) && t.source === 'schedule').length,
    event: triggers.filter((t) => isTriggerActive(t) && t.source === 'event').length,
    disabled: triggers.filter((t) => !t.enabled && !isTriggerEnded(t)).length,
    ended: endedTriggers.length,
    issues: triggers.filter((t) => isTriggerActive(t) && Boolean(t.problem || t.next_error || t.rejected)).length,
  }), [triggers, endedTriggers.length]);

  const visibleTriggers = useMemo(() => {
    return triggers.filter((t) => {
      if (filter === 'active') return isTriggerActive(t);
      if (filter === 'schedule') return isTriggerActive(t) && t.source === 'schedule';
      if (filter === 'event') return isTriggerActive(t) && t.source === 'event';
      if (filter === 'disabled') return !t.enabled && !isTriggerEnded(t);
      if (filter === 'ended') return isTriggerEnded(t);
      return true;
    });
  }, [triggers, filter]);

  const timeline = useMemo(
    () => buildScheduleTimeline(triggers, recent, zone, nowMs),
    [triggers, recent, zone, nowMs],
  );

  const selected = useMemo(() => {
    if (visibleTriggers.length === 0) return null;
    return visibleTriggers.find((t) => t.id === selectedId) ?? visibleTriggers[0] ?? null;
  }, [visibleTriggers, selectedId]);

  const selectedFires = useMemo(() => {
    if (!selected) return [];
    return recent.filter((fire) => fire.trigger_id === selected.id);
  }, [recent, selected]);

  function selectFromTimeline(id: string): void {
    if (!visibleTriggers.some((t) => t.id === id)) setFilter('active');
    setSelectedId(id);
  }

  async function act(send: () => Promise<unknown>): Promise<boolean> {
    setBusy(true);
    setError(null);
    try {
      await send();
      await client.invalidateQueries({ queryKey: query.queryKey });
      return true;
    } catch (refused) {
      setError(messageOf(refused));
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function save(): Promise<void> {
    if (!editing) return;
    const body = triggerBody(editing.draft);
    const done = await act(() => (editing.id === null
      ? post(`/api/projects/${encodeURIComponent(projectId)}/triggers`, body)
      : put(`/api/triggers/${encodeURIComponent(editing.id)}`, body)));
    if (done) setEditing(null);
  }

  async function clearAllEnded(): Promise<void> {
    if (endedTriggers.length === 0) {
      setClearingEnded(false);
      return;
    }
    const done = await act(async () => {
      for (const item of endedTriggers) {
        await del(`/api/triggers/${encodeURIComponent(item.id)}`);
      }
    });
    if (done) {
      setClearingEnded(false);
      setFilter('active');
    }
  }

  const begin = (): void => { if (data) { setEditing({ id: null, draft: emptyDraft(data.zone) }); setError(null); } };

  const filterTabs: readonly { id: TriggerFilter; label: string; count: number }[] = [
    { id: 'active', label: t('proj.trig.filterActive'), count: counts.active },
    { id: 'schedule', label: t('proj.trig.filterSchedule'), count: counts.schedule },
    { id: 'event', label: t('proj.trig.filterEvent'), count: counts.event },
    { id: 'disabled', label: t('common.disabled'), count: counts.disabled },
    ...(counts.ended > 0 ? [{ id: 'ended' as const, label: t('proj.trig.endedDone'), count: counts.ended }] : []),
  ];

  return (
    <section aria-label={t('proj.trig.sectionAria', { name: projectName })} className="space-y-4">
      {/* Top Telemetry Header & Actions */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          {data && triggers.length > 0 ? (
            <>
              <span className="inline-flex items-center gap-1.5 rounded-md border border-border bg-raised px-2.5 py-1">
                <span className="size-2 rounded-full bg-success" />
                <span className="font-mono font-semibold tabular-nums text-foreground">{counts.active}</span>
                <span className="text-muted-foreground">{t('proj.trig.statActiveSuffix')}</span>
              </span>
              {timeline.nextTrigger ? (
                <button
                  type="button"
                  onClick={() => selectFromTimeline(timeline.nextTrigger!.id)}
                  className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-border bg-raised px-2.5 py-1 transition-colors hover:border-primary"
                >
                  <span className="text-muted-foreground">{t('proj.trig.statNext')}</span>
                  <span className="font-mono font-semibold tabular-nums text-primary">{timeline.nextTrigger.timeLabel}</span>
                  <span className="text-muted-foreground tabular-nums">({timeline.nextTrigger.countdown})</span>
                </button>
              ) : null}
              {counts.issues > 0 ? (
                <span className="inline-flex items-center gap-1 rounded-md border border-failed-border bg-failed-soft px-2.5 py-1 text-failed-foreground tabular-nums">
                  <AlertTriangle className="size-3" />{t('proj.trig.statIssues', { count: counts.issues })}
                </span>
              ) : null}
            </>
          ) : (
            <p className="text-sm text-muted-foreground">
              {t('proj.trig.introLead')}
            </p>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {data && triggers.length > 0 ? (
            <div role="tablist" aria-label={t('proj.trig.filterGroupAria')} className="inline-flex items-center rounded-lg border border-border bg-muted/70 p-0.5 text-xs">
              {filterTabs.map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  role="tab"
                  aria-selected={filter === tab.id}
                  onClick={() => setFilter(tab.id)}
                  className={cn(
                    'cursor-pointer rounded-md px-2.5 py-1 tabular-nums transition-colors',
                    filter === tab.id
                      ? 'bg-raised font-medium text-foreground shadow-xs'
                      : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  {tab.label} {tab.count}
                </button>
              ))}
            </div>
          ) : null}
          {filter === 'ended' && counts.ended > 0 ? (
            <Button variant="danger" size="sm" disabled={busy} onClick={() => { setClearingEnded(true); setError(null); }}>
              <Trash2 className="size-3.5" />{t('proj.trig.clearEndedBtn', { count: counts.ended })}
            </Button>
          ) : null}
          <Button variant="primary" disabled={busy || !data} onClick={begin}><Plus />{t('proj.trig.createBtn')}</Button>
        </div>
      </div>

      {unread ? <Problem>{t('proj.trig.loadFailed', { reason: unread.message })}</Problem> : null}
      {isPending ? <Skeleton className="h-32" /> : null}

      {data ? (
        <>
          {triggers.length > 0 ? (
            <>
              {/* Synced 24h Telemetry Schedule Timeline */}
              <ScheduleTimelineBar
                timeline={timeline}
                selectedId={selected?.id ?? null}
                onSelect={selectFromTimeline}
              />

              {/* Scheme B Master-Detail Split Workbench */}
              {visibleTriggers.length > 0 && selected ? (
                <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(300px,380px)_minmax(0,1fr)] lg:items-start">
                  <div className="overflow-hidden rounded-xl border border-border bg-raised">
                    <ul aria-label={t('project.tabTriggers')} className="divide-y divide-border">
                      {visibleTriggers.map((trigger) => (
                        <MasterRow
                          key={trigger.id}
                          trigger={trigger}
                          zone={zone}
                          nowMs={nowMs}
                          selected={trigger.id === selected.id}
                          busy={busy}
                          onSelect={() => setSelectedId(trigger.id)}
                          onToggle={() => void act(() => post(`/api/triggers/${encodeURIComponent(trigger.id)}/enabled`, { enabled: !trigger.enabled }))}
                        />
                      ))}
                    </ul>
                  </div>

                  <TriggerInspector
                    trigger={selected}
                    zone={zone}
                    nowMs={nowMs}
                    groups={data.groups ?? []}
                    fires={selectedFires}
                    busy={busy}
                    onEdit={() => { setEditing({ id: selected.id, draft: draftOf(selected) }); setError(null); }}
                    onClone={() => { setEditing({ id: null, draft: cloneDraftOf(selected, zone) }); setError(null); }}
                    onToggle={() => void act(() => post(`/api/triggers/${encodeURIComponent(selected.id)}/enabled`, { enabled: !selected.enabled }))}
                    onDelete={() => { setConfirming(selected); setError(null); }}
                  />
                </div>
              ) : (
                <div className="space-y-2 rounded-xl border border-dashed border-border bg-raised py-10 text-center text-sm text-muted-foreground">
                  <p>{filter === 'active' ? t('proj.trig.noActiveTriggers') : t('proj.trig.noFilteredTriggers')}</p>
                  {filter === 'active' && (counts.ended > 0 || counts.disabled > 0) ? (
                    <div className="flex items-center justify-center gap-2 text-xs">
                      {counts.ended > 0 ? (
                        <button type="button" onClick={() => setFilter('ended')} className="cursor-pointer text-link hover:underline">
                          {t('proj.trig.viewEndedLink', { count: counts.ended })}
                        </button>
                      ) : null}
                      {counts.disabled > 0 ? (
                        <button type="button" onClick={() => setFilter('disabled')} className="cursor-pointer text-link hover:underline">
                          {t('proj.trig.viewDisabledLink', { count: counts.disabled })}
                        </button>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              )}
            </>
          ) : (
            <Empty icon={<Zap />} title={t('proj.trig.emptyTitle')}>
              {t('proj.trig.emptyDesc')}
            </Empty>
          )}

          {!editing && !confirming && error ? <Problem role="alert" className="mt-2">{error}</Problem> : null}

          {recent.length > 0 ? (
            <div className="pt-2">
              <SectionTitle>{t('proj.trig.recentHeading')}</SectionTitle>
              <Rows>
                <ul aria-label={t('proj.trig.recentHeading')} className="divide-y divide-border">
                  {recent.slice(0, RECENT_SHOWN).map((fire) => {
                    const bad = fire.outcome === 'missed' || fire.outcome === 'expired';
                    return (
                      <li key={fire.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3.5 py-2 text-sm">
                        <span className={cn('size-1.5 flex-none rounded-full', bad ? 'bg-failed' : 'bg-success')} />
                        <Time at={fire.scheduled_at ?? fire.created_at} className="w-24 flex-none font-mono text-xs text-faint tabular-nums" />
                        <span className="min-w-0 flex-1 wrap-anywhere">{fire.trigger_name}</span>
                        <span className="text-xs text-muted-foreground">{fireLine(fire)}</span>
                      </li>
                    );
                  })}
                </ul>
              </Rows>
            </div>
          ) : null}

          <Sheet open={editing !== null} onOpenChange={(open) => { if (!open && !busy) { setEditing(null); setError(null); } }}>
            {editing ? (
              <SheetContent
                title={editing.id === null ? t('proj.trig.createBtn') : t('proj.trig.editTitle')}
                footer={(
                  <>
                    <Button type="submit" form="trigger-form" variant="primary" disabled={busy}>{busy ? t('proj.settings.saving') : t('proj.trig.saveBtn')}</Button>
                    <Button variant="ghost" disabled={busy} onClick={() => { setEditing(null); setError(null); }}>{t('common.cancel')}</Button>
                  </>
                )}
              >
                <TriggerForm
                  id="trigger-form"
                  draft={editing.draft}
                  made={editing.id !== null}
                  minIntervalMs={data.min_interval_ms}
                  groups={data.groups}
                  tasks={projectTasks}
                  busy={busy}
                  error={error}
                  onChange={(draft) => setEditing({ ...editing, draft })}
                  onSave={() => void save()}
                />
              </SheetContent>
            ) : null}
          </Sheet>

          <Confirm
            open={confirming !== null}
            title={t('proj.trig.deleteTitle', { name: confirming?.name ?? '' })}
            description={t('proj.trig.deleteDesc')}
            confirm={t('proj.delete.confirm', { name: confirming?.name ?? '' })}
            busy={busy}
            error={confirming ? error : null}
            onConfirm={() => { if (confirming) void act(() => del(`/api/triggers/${encodeURIComponent(confirming.id)}`)).then((done) => { if (done) setConfirming(null); }); }}
            onCancel={() => { setConfirming(null); setError(null); }}
          />

          <Confirm
            open={clearingEnded}
            title={t('proj.trig.clearEndedTitle', { count: counts.ended })}
            description={t('proj.trig.clearEndedDesc')}
            confirm={t('proj.trig.clearEndedConfirm', { count: counts.ended })}
            busy={busy}
            error={clearingEnded ? error : null}
            onConfirm={() => void clearAllEnded()}
            onCancel={() => { setClearingEnded(false); setError(null); }}
          />
        </>
      ) : null}
    </section>
  );
}
