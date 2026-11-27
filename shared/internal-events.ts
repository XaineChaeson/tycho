// The ledger's own events a trigger may subscribe to (docs/design/triggers.md §2.3), declared once:
// when each happens, its stable id, its payload, and how its project follows. The same fact feeds
// the owner's push (service/pushes.ts) and the triggers; neither judges it again. The project is
// always the one of the event's Task, so the payload names it and nothing else.

import { localeMap, t } from './i18n.ts';

export const INTERNAL_EVENT_KINDS = ['work_ready', 'accepted', 'merged', 'released'] as const;
export type InternalEventKind = (typeof INTERNAL_EVENT_KINDS)[number];

export const INTERNAL_EVENT_LABELS: Readonly<Record<InternalEventKind, string>> = localeMap({
  work_ready: 'sh.internalEvents.label.work_ready',
  accepted: 'sh.internalEvents.label.accepted',
  merged: 'sh.internalEvents.label.merged',
  released: 'sh.internalEvents.label.released',
});

// When each happens, in the owner's words: what the console and the Router's tools say.
export const INTERNAL_EVENT_WHEN: Readonly<Record<InternalEventKind, string>> = localeMap({
  work_ready: 'sh.internalEvents.when.work_ready',
  accepted: 'sh.internalEvents.when.accepted',
  merged: 'sh.internalEvents.when.merged',
  released: 'sh.internalEvents.when.released',
});

// One occurrence. `id` is made at the transition and never again: the identity a trigger keeps
// it by, and the key its push goes out once by. `task_id` is the Task it is about; its project is
// the event's. Null only for a release no Task's round produced: no project, no trigger.
export interface InternalEvent {
  kind: InternalEventKind;
  id: string;
  task_id: string | null;
  data: Record<string, unknown>;
}

// The events, as the transitions that commit them make them. `work` is the top-level Task; whether
// a work is ready is the ledger's to judge over the whole tree (workReady). A return to ready after
// rework is a new round: so is its id.
export const internalEvents = {
  workReady: (work: string, runId: string): InternalEvent =>
    ({ kind: 'work_ready', id: `work-ready:${runId}`, task_id: work, data: { task_id: work, run_id: runId } }),
  // `nth`: which acceptance of this Task, counted from its audit lines: one Task reopened by rework
  // and accepted again is accepted twice.
  accepted: (taskId: string, nth: number, basis: string): InternalEvent =>
    ({ kind: 'accepted', id: `accepted:${taskId}:${nth}`, task_id: taskId, data: { task_id: taskId, basis } }),
  // A merge into the main line is the one landing there is (docs/design/code-sources.md §2):
  // the commit that went in is the occurrence, and two Tasks with the same commit are two events.
  merged: (taskId: string, branch: string | null, commit: string | null, at: string): InternalEvent =>
    ({ kind: 'merged', id: `task.integrate:${taskId}:${commit ?? at}`, task_id: taskId, data: { task_id: taskId, branch, commit } }),
  released: (key: string, taskId: string | null, version: string): InternalEvent =>
    ({ kind: 'released', id: `released:${key}`, task_id: taskId, data: { task_id: taskId, version } }),
};

// What a subscription asks for: one kind, and optionally one Task of the project (it and the Tasks
// under it).
export interface EventFilter {
  kind: InternalEventKind;
  task_id: string | null;
}

export function describeEventFilter(filter: EventFilter): string {
  const label = INTERNAL_EVENT_LABELS[filter.kind];
  return filter.task_id === null
    ? t('sh.internalEvents.filterAll', { label })
    : t('sh.internalEvents.filterTask', { label, taskId: filter.task_id });
}
