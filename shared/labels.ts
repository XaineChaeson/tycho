// The words the service and the console both say: state labels, action names and the
// lines built from them. One copy, so a notification and a page never disagree.
import { getActiveLocale, localeMap, onLocaleChange, t, type Locale } from './i18n.ts';
import { NO_ROLE_LOST_TEXT } from './roles.ts';
import { formatTime } from './time.ts';
import { loginName, loginPage, parseLoginName } from './logins.ts';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

function fixedLocaleMap<K extends string>(keyMap: Record<K, string>, locale: Locale): Readonly<Record<K, string>> {
  return new Proxy(keyMap, {
    get(target, prop, receiver) {
      if (typeof prop === 'string' && Object.prototype.hasOwnProperty.call(target, prop)) {
        return t(target[prop as K], undefined, locale);
      }
      return Reflect.get(target, prop, receiver);
    },
    ownKeys(target) {
      return Reflect.ownKeys(target);
    },
    getOwnPropertyDescriptor(target, prop) {
      if (typeof prop === 'string' && Object.prototype.hasOwnProperty.call(target, prop)) {
        return {
          enumerable: true,
          configurable: true,
          value: t(target[prop as K], undefined, locale),
        };
      }
      return Reflect.getOwnPropertyDescriptor(target, prop);
    },
  });
}

// An unfinished request lists these on WeCom too.
export const ACTION_TEXT: Readonly<Record<string, string>> = localeMap({
  'outbox.confirm_received': 'sh.labels.action.outbox.confirm_received',
  'task.feedback': 'sh.labels.action.task.feedback',
  'project.create': 'sh.labels.action.project.create',
  'project.update': 'sh.labels.action.project.update',
  'project.rename': 'sh.labels.action.project.rename',
  'project.pause': 'sh.labels.action.project.pause',
  'project.resume': 'sh.labels.action.project.resume',
  'project.archive': 'sh.labels.action.project.archive',
  'project.unarchive': 'sh.labels.action.project.unarchive',
  'project.delete': 'sh.labels.action.project.delete',
  'machine.create': 'sh.labels.action.machine.create',
  'machine.update': 'sh.labels.action.machine.update',
  'machine.delete': 'sh.labels.action.machine.delete',
  // A machine's own login of one executor: its tiers and limits, kept on the machine.
  'machine_login.create': 'sh.labels.action.machine_login.create',
  'machine_login.update': 'sh.labels.action.machine_login.update',
  'machine_login.delete': 'sh.labels.action.machine_login.delete',
  // The ledger step that turned accounts with no login of their own into machines' own
  // logins: what it repointed, said on the Task and on the settings it touched.
  'login.migrate': 'sh.labels.action.login.migrate',
  'login.signed_in_again': 'sh.labels.action.login.signed_in_again',
  'run.lost_without_role': 'sh.labels.action.run.lost_without_role',
  'role.create': 'sh.labels.action.role.create',
  'role.update': 'sh.labels.action.role.update',
  'role.delete': 'sh.labels.action.role.delete',
  // A machine that came back by itself: the owner lets it in from the console, and what it
  // was let in as is written down with it (docs/design/nodes.md §1.1).
  'machine.join': 'sh.labels.action.machine.join',
  'machine.join_rejected': 'sh.labels.action.machine.join_rejected',
  // The host's own user joining this host from this host: nobody is asked (§1.1 step 2).
  'machine.join_local': 'sh.labels.action.machine.join_local',
  // A machine a task spawned (docs/design/nodes.md §1.3): the quota, the material handed to
  // a round, a machine coming in with one (nobody let it in), a machine reclaiming its own
  // registration, and the four endings.
  'machine.invite': 'sh.labels.action.machine.invite',
  'machine.invite_handed': 'sh.labels.action.machine.invite_handed',
  'machine.invite_revoked': 'sh.labels.action.machine.invite_revoked',
  'machine.join_spawned': 'sh.labels.action.machine.join_spawned',
  'machine.join_reclaimed': 'sh.labels.action.machine.join_reclaimed',
  'machine.drain': 'sh.labels.action.machine.drain',
  'machine.evidence': 'sh.labels.action.machine.evidence',
  'machine.leave': 'sh.labels.action.machine.leave',
  'machine.leave_destroyed': 'sh.labels.action.machine.leave_destroyed',
  'machine.revoke': 'sh.labels.action.machine.revoke',
  'machine.destroyed': 'sh.labels.action.machine.destroyed',
  'task.create': 'sh.labels.action.task.create',
  'task.update': 'sh.labels.action.task.update',
  // The owner picked the machine of a folder source the migration could not name (§8.8): the
  // unfinished Tasks pinned to it take the machine in the same transaction.
  'task.source_machine': 'sh.labels.action.task.source_machine',
  'task.queue': 'sh.labels.action.task.queue',
  'task.hold': 'sh.labels.action.task.hold',
  'task.resume': 'sh.labels.action.task.resume',
  'task.continue': 'sh.labels.action.task.continue',
  'task.accept': 'sh.labels.action.task.accept',
  'task.rework': 'sh.labels.action.task.rework',
  'task.integrate': 'sh.labels.action.task.integrate',
  'release.launch': 'sh.labels.action.release.launch',
  'task.abandon': 'sh.labels.action.task.abandon',
  'task.schedule_wake': 'sh.labels.action.task.schedule_wake',
  'ledger.restore': 'sh.labels.action.ledger.restore',
  'ledger.restore_confirm': 'sh.labels.action.ledger.restore_confirm',
  'run.stopping': 'sh.labels.action.run.stopping',
  'run.residue_stuck': 'sh.labels.action.run.residue_stuck',
  // What a finished work left on disk, cleared once its retention period passed
  // (service/retention.ts): the host's registered copies, and the code on each machine.
  'run.releases_drop': 'sh.labels.action.run.releases_drop',
  'run.code_drop': 'sh.labels.action.run.code_drop',
  'run.output_custody': 'sh.labels.action.run.output_custody',
  'run.output_retained': 'sh.labels.action.run.output_retained',
  'approval.open': 'sh.labels.action.approval.open',
  'input.add': 'sh.labels.action.input.add',
  'input.void': 'sh.labels.action.input.void',
  'decision.note': 'sh.labels.action.decision.note',
  'message.reply': 'sh.labels.action.message.reply',
  // A project's triggers (docs/design/triggers.md §7).
  'trigger.create': 'sh.labels.action.trigger.create',
  'trigger.update': 'sh.labels.action.trigger.update',
  'trigger.enable': 'sh.labels.action.trigger.enable',
  'trigger.disable': 'sh.labels.action.trigger.disable',
  'trigger.delete': 'sh.labels.action.trigger.delete',
  // Tycho-wide inbound sources (§2.2, step 4).
  'inbound.create': 'sh.labels.action.inbound.create',
  'inbound.update': 'sh.labels.action.inbound.update',
  'inbound.enable': 'sh.labels.action.inbound.enable',
  'inbound.disable': 'sh.labels.action.inbound.disable',
  'inbound.delete': 'sh.labels.action.inbound.delete',
  'inbound.key': 'sh.labels.action.inbound.key',
  'inbound.migrate': 'sh.labels.action.inbound.migrate',
  'front.current': 'sh.labels.action.front.current',
  'im.group_binding.create': 'sh.labels.action.im.group_binding.create',
  'im.group_binding.update': 'sh.labels.action.im.group_binding.update',
  'im.group_binding.delete': 'sh.labels.action.im.group_binding.delete',
  'im.group_broadcast': 'sh.labels.action.im.group_broadcast',
  'setting.update': 'sh.labels.action.setting.update',
  'console.device.approve': 'sh.labels.action.console.device.approve',
  'console.device.reject': 'sh.labels.action.console.device.reject',
});

export const LOGIN_METHOD_LABELS: Readonly<Record<'link' | 'device' | 'wecom' | 'weixin' | 'passphrase', string>> = localeMap({
  link: 'sh.labels.loginMethod.link',
  device: 'sh.labels.loginMethod.device',
  wecom: 'sh.labels.loginMethod.wecom',
  weixin: 'sh.labels.loginMethod.weixin',
  passphrase: 'sh.labels.loginMethod.passphrase',
});

// Who wrote a change, as the ledger names it. People on WeCom are their accounts there,
// which have no other name. No more imports happen, but old ledgers keep their rows.
const CHANGED_BY_KEYS: Record<string, string> = {
  console: 'sh.labels.changedBy.console',
  router: 'sh.labels.changedBy.router',
  'session-host': 'sh.labels.changedBy.sessionHost',
  service: 'sh.labels.changedBy.service',
  runner: 'sh.labels.changedBy.runner',
  dispatcher: 'sh.labels.changedBy.dispatcher',
  timer: 'sh.labels.changedBy.timer',
  import: 'sh.labels.changedBy.import',
};

export const changedByText = (actor: string): string =>
  Object.hasOwn(CHANGED_BY_KEYS, actor)
    ? t(CHANGED_BY_KEYS[actor]!)
    : t('sh.labels.changedBy.other', { actor });

export const restoreHeadline = (backupTime: string): string => t('sh.labels.restoreHeadline', { backupTime });

const TASK_STATE_KEYS = {
  draft: 'sh.labels.taskState.draft',
  queued: 'sh.labels.taskState.queued',
  running: 'sh.labels.taskState.running',
  stopping: 'sh.labels.taskState.stopping',
  ready: 'sh.labels.taskState.ready',
  done: 'sh.labels.taskState.done',
  held: 'sh.labels.taskState.held',
  waiting_person: 'sh.labels.taskState.waiting_person',
  waiting_timer: 'sh.labels.taskState.waiting_timer',
  needs_verification: 'sh.labels.taskState.needs_verification',
  abandoned: 'sh.labels.taskState.abandoned',
} as const;
export const taskStateLabels: Readonly<Record<string, string>> = localeMap(TASK_STATE_KEYS);
export const taskStateLabelsEn: Readonly<Record<string, string>> = fixedLocaleMap(TASK_STATE_KEYS, 'en');
export const taskStateLabel = (state: string, locale: Locale = getActiveLocale()): string =>
  Object.hasOwn(TASK_STATE_KEYS, state) ? t(TASK_STATE_KEYS[state as keyof typeof TASK_STATE_KEYS], undefined, locale) : state;

// How a Run ended.
const EXIT_KIND_KEYS = {
  completed: 'sh.labels.exitKind.completed',
  failed: 'sh.labels.exitKind.failed',
  interrupted: 'sh.labels.exitKind.interrupted',
  lost: 'sh.labels.exitKind.lost',
  quota: 'sh.labels.exitKind.quota',
  auth: 'sh.labels.exitKind.auth',
} as const;
export const exitKindLabels: Readonly<Record<string, string>> = localeMap(EXIT_KIND_KEYS);
export const exitKindLabelsEn: Readonly<Record<string, string>> = fixedLocaleMap(EXIT_KIND_KEYS, 'en');
export const exitKindLabel = (kind: string, locale: Locale = getActiveLocale()): string =>
  Object.hasOwn(EXIT_KIND_KEYS, kind) ? t(EXIT_KIND_KEYS[kind as keyof typeof EXIT_KIND_KEYS], undefined, locale) : kind;

const RUN_STATE_KEYS = {
  launching: 'sh.labels.runState.launching',
  running: 'sh.labels.runState.running',
  stopping: 'sh.labels.runState.stopping',
  unknown: 'sh.labels.runState.unknown',
  ended: 'sh.labels.runState.ended',
} as const;
export const runStateLabels: Readonly<Record<string, string>> = localeMap(RUN_STATE_KEYS);
export const runStateLabelsEn: Readonly<Record<string, string>> = fixedLocaleMap(RUN_STATE_KEYS, 'en');
export const runStateLabel = (state: string, locale: Locale = getActiveLocale()): string =>
  Object.hasOwn(RUN_STATE_KEYS, state) ? t(RUN_STATE_KEYS[state as keyof typeof RUN_STATE_KEYS], undefined, locale) : state;

// Which group of logins a Run was placed from (roles-and-tiers.md §11.3), in the owner's words.
const PLACED_BY_KEYS = {
  prefer: 'sh.labels.placedBy.prefer',
  spread: 'sh.labels.placedBy.spread',
  order: 'sh.labels.placedBy.order',
  pinned: 'sh.labels.placedBy.pinned',
  same_executor: 'sh.labels.placedBy.same_executor',
} as const;
export const placedByLabels: Readonly<Record<string, string>> = localeMap(PLACED_BY_KEYS);
export const placedByLabelsEn: Readonly<Record<string, string>> = fixedLocaleMap(PLACED_BY_KEYS, 'en');
export const placedByLabel = (by: string, locale: Locale = getActiveLocale()): string =>
  Object.hasOwn(PLACED_BY_KEYS, by) ? t(PLACED_BY_KEYS[by as keyof typeof PLACED_BY_KEYS], undefined, locale) : by;

export const tierDisplayLabel = (tierId: string, locale: Locale = getActiveLocale()): string => {
  if (tierId === 'operate') return t('sh.tiers.operate.label', undefined, locale);
  if (tierId === 'execute') return t('sh.tiers.execute.label', undefined, locale);
  if (tierId === 'decide') return t('sh.tiers.decide.label', undefined, locale);
  return tierId;
};
export const taskDotClasses: Record<string, string> = {
  draft: 'running', queued: 'running', running: 'running', stopping: 'running', waiting_timer: 'running', needs_verification: 'running',
  ready: 'waiting', waiting_person: 'waiting', held: 'failed', done: 'finished', abandoned: 'finished',
};
export function displayStateText(text: string): string {
  return String(text).replace(/(任务(?:进入|转为)\s+|Run\s+)([a-z][a-z_]*)(?![\w.])/g, // i18n-ignore
    (_match, prefix: string, state: string) => prefix + (taskStateLabels[state] ?? runStateLabels[state] ?? state));
}
// The first line of an internal event is its sentence; the rest is the payload for the router.
export const eventHeadline = (text: string): string => displayStateText(String(text).split('\n')[0]!);

// A Run whose login the ledger never held, as after restoring a backup from before accounts
// were kept in it. Said in the same words wherever it shows.
export const missingLoginText = (name: string): string => t('sh.labels.missingLogin', { login: loginName(name) });
// A machine that answers and cannot tell what became of a round, in its own words. No time
// ends this wait: the machine being able to say again does, or it going away.
export const unverifiableText = (said: string): string => t('sh.labels.unverifiable', { said });

// A round whose registered product the retention rule cleared (service/retention.ts): said the
// same way on the task page and in every refusal that meets one.
// The period is not named: the setting may have changed since, and the change line keeps the one applied.
export function artifactsDroppedText({ at }: { at: string }, now: Date = new Date()): string {
  return t('sh.labels.artifactsDropped', { at: formatTime(at, now) });
}

export interface Summary { dot: string; text?: string; leaf?: boolean }

// Why none of the logins a Task may run on can take it now: the resting one that comes
// back first and when, the ones at their ceiling, the ones with no machine that answers.
// Each ends by itself, so a Task that waits for them is moving, not waiting for the owner.
export interface Wait {
  rest: { login: string; until: string } | null;
  full: string[];
  no_machine: string[];
  rejected?: string[];
  missing_credentials?: string[];
  no_candidate?: boolean;
  // A folder source's machine is not here (its registration is gone, or it has not connected
  // yet): the Task waits for that machine and nothing else, whatever its logins could do.
  source_offline?: string;
  // Machines whose client speaks another node protocol. Their work waits for the upgrade;
  // none of it is dispatched to them (shared/node-protocol.ts).
  outdated?: string[];
  output_waiting?: string[];
}

// A Task whose code is a folder on one machine waits for that machine alone
// (docs/design/code-sources.md §2).
export const sourceOfflineText = (machine: string): string => t('sh.labels.sourceOffline', { machine });

// A machine whose client is older than this host: the round would start in the wrong place,
// so none is sent until the client is upgraded.
export const outdatedClientText = (machines: readonly string[]): string =>
  machines.length === 1
    ? t('sh.labels.outdatedClientOne', { machine: machines[0]! })
    : t('sh.labels.outdatedClientMany', { machines: machines.join(t('sh.listSep')) });

// What a refused login waits for, by where it comes from: an account for the owner to sign
// it in again or give it a new key (ACCOUNT_LOGIN_FIX), a machine's own login for its machine
// to say it is signed in again.
function refusedLines(ids: readonly string[]): string[] {
  const sep = t('sh.listSep');
  const accounts = ids.filter((id) => parseLoginName(id).kind === 'account');
  const own = ids.filter((id) => parseLoginName(id).kind === 'machine');
  return [
    ...(accounts.length ? [t('sh.labels.wait.refusedAccounts', { logins: accounts.map(loginName).join(sep), fix: ACCOUNT_LOGIN_FIX })] : []),
    ...(own.length ? [t('sh.labels.wait.refusedMachine', { logins: own.map(loginName).join(sep) })] : []),
  ];
}

// The owner told once that a machine's own login was refused: where to put it right.
export const machineLoginRefusedText = (loginId: string): string =>
  t('sh.labels.machineLoginRefused', { login: loginName(loginId) });

// What such a Task waits for, and about when. The time is the earliest any resting
// login comes back, not a promise that the Task starts then.
export function waitLine(wait: Wait | null | undefined, now: number = Date.now()): string | null {
  if (!wait) return null;
  const sep = t('sh.listSep');
  const parts = [
    wait.no_candidate ? t('sh.labels.wait.noCandidate') : null,
    wait.source_offline ? sourceOfflineText(wait.source_offline) : null,
    wait.outdated?.length ? outdatedClientText(wait.outdated) : null,
    wait.output_waiting?.length ? t('sh.labels.wait.outputWaiting', { machines: wait.output_waiting.join(sep) }) : null,
    wait.full.length ? t('sh.labels.wait.full', { logins: wait.full.map(loginName).join(sep) }) : null,
    wait.rest ? t('sh.labels.wait.rest', { until: formatTime(wait.rest.until, new Date(now)) }) : null,
    wait.no_machine.length ? t('sh.labels.noMachine') : null,
    wait.missing_credentials?.length ? t('sh.labels.wait.missingCredentials', { logins: wait.missing_credentials.map(loginName).join(sep), fix: ACCOUNT_LOGIN_FIX }) : null,
    ...refusedLines(wait.rejected ?? []),
  ].filter(Boolean);
  return parts.length ? parts.join(t('sh.labels.wait.orJoiner')) : null;
}

// A project the owner paused (docs/design/project-sessions.md §5): the console, the server and
// WeCom say it the same way.
export let PROJECT_PAUSED_LABEL: string = t('sh.labels.projectPausedLabel');
export let PROJECT_PAUSED_TEXT: string = t('sh.labels.projectPausedText');
export let PROJECT_PAUSED_NOTE: string = t('sh.labels.projectPausedNote');

// A project the owner put away (project-sessions, "项目的生命周期"). It holds back what a
// pause holds back, and says so in its own words.
export let PROJECT_ARCHIVED_LABEL: string = t('sh.labels.projectArchivedLabel');
export let PROJECT_ARCHIVED_TEXT: string = t('sh.labels.projectArchivedText');
// Says the same as the console's empty list when every project is put away: what WeCom's
// 项目 and 进入 answer is not that there are none.
export let PROJECT_ARCHIVED_NOTE: string = t('sh.labels.projectArchivedNote');
export let ALL_PROJECTS_ARCHIVED_TEXT: string = t('sh.labels.allProjectsArchived');

// The server's reading of a Run nobody can speak for: from when its Task may go on,
// whether it is a stop that is waiting, and what keeps a continuation back right now.
// `missing_login` names the Run's login when the ledger never held it: nothing else applies then.
// `unverifiable` is what a machine that answers said about why it cannot tell: no time applies.
export interface Lost {
  eligible_at: string | null;
  stopping: boolean;
  blocked: 'paused' | 'project_paused' | 'project_archived' | 'recovering' | 'no_role' | 'no_machine' | 'limit' | null;
  missing_login?: string | null;
  unverifiable?: string | null;
  // With `no_machine`: what exactly no login of the Task can take the continuation for.
  waiting?: Wait | null;
}

const CONTINUATION_BLOCKS: Readonly<Record<string, string>> = localeMap({
  paused: 'sh.labels.lost.blockedPaused',
  project_paused: 'sh.labels.lost.blockedProjectPaused',
  project_archived: 'sh.labels.lost.blockedProjectArchived',
  recovering: 'sh.labels.lost.blockedRecovering',
  no_machine: 'sh.labels.noMachine',
  limit: 'sh.labels.lost.blockedLimit',
});

// A machine out of contact asks nothing of the owner, so the line says what the rules
// do next and what they wait for: `lost` is the server's reading of the Run nobody can
// speak for. The time is when the Task may go on, not a promise that it will by then:
// past it, the line names what still stands in the way. A stop needs no machine and no
// dispatch, so it only waits for the time.
export function lostLine(lost: Lost | null | undefined, now: number = Date.now()): string | null {
  if (!lost?.eligible_at) return null;
  const time = formatTime(lost.eligible_at, new Date(now));
  if (lost.stopping) return t('sh.labels.lost.settleInterruptedAt', { time });
  if (Date.parse(lost.eligible_at) > now) return t('sh.labels.lost.autoContinueAfter', { time });
  if (lost.blocked === 'no_machine' && lost.waiting) return waitLine(lost.waiting, now) ?? t('sh.labels.noMachine');
  if (lost.blocked === 'no_role') return NO_ROLE_LOST_TEXT;
  return (lost.blocked && CONTINUATION_BLOCKS[lost.blocked]) ?? t('sh.labels.lost.waitingContinuation');
}

// A task that is its own work reads as itself. Only a work with children reads as counts,
// except when a leaf ready task is currently gated by an active review (`审阅中` / `审阅停住`).
export function taskLine(
  { state, reason, summary, lost, waiting }: { state: string; reason?: string | null; summary?: Summary; lost?: Lost | null; waiting?: Wait | null },
  now: number = Date.now(),
): string {
  if (summary && !summary.leaf) return summary.text ?? '';
  if (summary?.leaf && state === 'ready' && summary.dot !== 'ready' && summary.dot !== 'waiting_person' && summary.text) {
    return summary.text;
  }
  const shown = summary?.dot === 'waiting_person' ? 'waiting_person' : state;
  // No machine is out of contact here: nobody knows which machine to ask, and no time ends that.
  if (shown === 'needs_verification' && lost?.missing_login) return missingLoginText(lost.missing_login);
  // Nor here: the machine answers, and says why it cannot tell.
  if (shown === 'needs_verification' && lost?.unverifiable) return unverifiableText(lost.unverifiable);
  const label = taskStateLabels[shown] ?? shown;
  const detail = shown === 'needs_verification' ? lostLine(lost, now)
    : shown !== state ? null : state === 'queued' ? waitLine(waiting, now) ?? reason : reason;
  return detail ? t('sh.labels.colonPair', { label, detail }) : label;
}

// What a Worker's receipt says of its round, and the words a page shows for it. Declared
// once: the brief lists the same ids, and the ledger settles by them.
export const RECEIPT_STATUS_LABELS = localeMap({
  done: 'sh.labels.receiptStatus.done',
  failed: 'sh.labels.receiptStatus.failed',
  waiting: 'sh.labels.receiptStatus.waiting',
});
export type ReceiptStatus = keyof typeof RECEIPT_STATUS_LABELS;
export const RECEIPT_STATUSES = Object.keys(RECEIPT_STATUS_LABELS) as ReceiptStatus[];

// The groups a piece of work falls in, in the order the pages show them. Declared once: the
// sidebar lists them, and the service counts a project's work by them.
export const WORK_GROUPS = localeMap({
  waiting: 'sh.labels.workGroup.waiting',
  moving: 'sh.labels.workGroup.moving',
  ready: 'sh.labels.workGroup.ready',
  ended: 'sh.labels.workGroup.ended',
});
export type WorkGroup = (typeof WORK_GROUPS)[keyof typeof WORK_GROUPS];
const workGroupOrderValues = (): WorkGroup[] => [WORK_GROUPS.waiting, WORK_GROUPS.moving, WORK_GROUPS.ready, WORK_GROUPS.ended];
const workGroupOrderList: WorkGroup[] = workGroupOrderValues();
export const WORK_GROUP_ORDER: readonly WorkGroup[] = workGroupOrderList;
// How many ended works the side column and the overview carry, the most recently ended first.
// The rest stay in the ledger and are read a page at a time from the list of ended work.
export const RECENT_ENDED = 8;

// Stopped work moves only when the owner or the router says so: it waits, it has not ended.
// Work whose machine is out of contact moves by itself: it is judged and continued.
export function workGroup(task: { state: string; summary?: Summary }): WorkGroup {
  const status = task.summary?.dot ?? task.state;
  if (['waiting_person', 'held'].includes(status)) return WORK_GROUPS.waiting;
  if (status === 'ready') return WORK_GROUPS.ready;
  return ['done', 'abandoned'].includes(status) ? WORK_GROUPS.ended : WORK_GROUPS.moving;
}

export function runTime(
  run: { state: string; created_at: string; started_at?: string | null; ended_at?: string | null } | null | undefined,
  now: number = Date.now(),
): string {
  if (!run) return t('sh.labels.runTime.notStarted');
  if (run.ended_at) return formatTime(run.ended_at);
  if (run.state === 'unknown') return runStateLabels.unknown!;
  return t('sh.labels.runTime.runningMinutes', {
    minutes: Math.max(0, Math.floor((now - Date.parse(run.started_at ?? run.created_at)) / 60_000)),
  });
}

export const loginLine = (parts: readonly (string | null | undefined)[]): string =>
  parts.filter(Boolean).join(' · ') || t('sh.labels.unspecified');

// What the host knows of an account credential: present, rejected, or missing from disk.
export type CredentialState = 'set' | 'rejected' | 'missing';
// What the owner does about an account whose executor refused its login: nothing is typed
// into a page for a login made on the executor's own page, so the one sentence covers both.
export let ACCOUNT_LOGIN_FIX: string = t('sh.labels.accountLoginFix');
// An account's kept login as its card says it, by how it was obtained: a login made on the
// executor's own page is signed in to again there and is never typed (`signedIn`); a secret
// the owner typed — an API key, a line's key — is replaced by typing a new one (`typed`).
export const credentialText = {
  signedIn: {
    get label(): string { return t('sh.labels.cred.signedIn.label'); },
    states: localeMap<CredentialState>({
      set: 'sh.labels.cred.signedIn.set',
      rejected: 'sh.labels.cred.signedIn.rejected',
      missing: 'sh.labels.cred.signedIn.missing',
    }) as Record<CredentialState, string>,
  },
  typed: {
    get label(): string { return t('sh.labels.cred.typed.label'); },
    get help(): string { return t('sh.labels.cred.typed.help'); },
    get change(): string { return t('sh.labels.cred.typed.change'); },
    get save(): string { return t('sh.labels.cred.typed.save'); },
    get saving(): string { return t('sh.labels.cred.typed.saving'); },
    states: localeMap<CredentialState>({
      set: 'sh.labels.cred.typed.set',
      rejected: 'sh.labels.cred.typed.rejected',
      missing: 'sh.labels.cred.typed.missing',
    }) as Record<CredentialState, string>,
  },
};

// A Task that names no login: the service picks one of the project's at each round.
export let ANY_LOGIN_TEXT: string = t('sh.labels.anyLogin');

// A tier's form: what the owner fills, and the raw text only for what the form cannot hold.
// The values it edits are the executor's own; which of them there are comes from the
// executor's declaration, and so do the strengths it offers. Which tiers there are is not
// the executor's to decide: it is the names in shared/tiers.ts, and an account either
// holds one or is left blank for it.
export const tierText = {
  get legend(): string { return t('sh.labels.tierText.legend'); },
  get note(): string { return t('sh.labels.tierText.note'); },
  get model(): string { return t('sh.labels.tierText.model'); },
  get effort(): string { return t('sh.labels.tierText.effort'); },
  get provider(): string { return t('sh.labels.tierText.provider'); },
  get effortAny(): string { return t('sh.labels.tierText.effortAny'); },

  get advanced(): string { return t('sh.labels.tierText.advanced'); },
  advancedNote: (count: number): string => t('sh.labels.tierText.advancedNote', { count }),
  get unreadable(): string { return t('sh.labels.tierText.unreadable'); },
  // An account that does not take this tier: said on the row itself.
  get blank(): string { return t('sh.labels.tierText.blank'); },
  get blankHeld(): string { return t('sh.labels.tierText.blankHeld'); },
  // The operate tier is the one tier a login need not fill: its work runs on the login's
  // execute content when it holds none (roles-and-tiers.md §10.3).
  get blankOperate(): string { return t('sh.labels.tierText.blankOperate'); },
  // A tier name the system no longer uses, kept from an older layout
  // (docs/design/roles-and-tiers.md §8): what the row is called, and the action that
  // settles it. A name mapped to a row that already holds something says so first.
  get stale(): string { return t('sh.labels.tierText.stale'); },
  get staleNote(): string { return t('sh.labels.tierText.staleNote'); },
  moveTo: (label: string): string => t('sh.labels.tierText.moveTo', { label }),
  get remove(): string { return t('sh.labels.tierText.remove'); },
  overwrite: (label: string): string => t('sh.labels.tierText.overwrite', { label }),
};

// A tier's model and strength, and what the account's executor reported about them. A model
// outside that list is not an error: an alias the executor still accepts is the owner's own
// choice, so it stays as it was written and can be typed by hand.
export const modelText = {
  get label(): string { return t('sh.labels.modelText.label'); },
  get notRead(): string { return t('sh.labels.modelText.notRead'); },
  get ask(): string { return t('sh.labels.modelText.ask'); },
  get refreshing(): string { return t('sh.labels.modelText.refreshing'); },
  count: (count: number): string => t('sh.labels.modelText.count', { count }),
  readAt: (at: string): string => t('sh.labels.modelText.readAt', { at }),
  hidden: (count: number): string => t('sh.labels.modelText.hidden', { count }),
  get missing(): string { return t('sh.labels.modelText.missing'); },
  get pick(): string { return t('sh.labels.modelText.pick'); },
  get handWritten(): string { return t('sh.labels.modelText.handWritten'); },
  // The way out of the list, for a model it does not hold: an alias, or one not reported yet.
  get typeByHand(): string { return t('sh.labels.modelText.typeByHand'); },
  get none(): string { return t('sh.labels.modelText.none'); },
  defaultEffort: (effort: string): string => t('sh.labels.modelText.defaultEffort', { effort }),
  get goneFromList(): string { return t('sh.labels.modelText.goneFromList'); },
  queryFailed: (reason: string): string => t('sh.labels.modelText.queryFailed', { reason }),
  // A machine's own login: its list is what that machine reports of its executor, and these
  // are why the machine has none to show. What the machine itself said went wrong is its words.
  get machineOffline(): string { return t('sh.labels.modelText.machineOffline'); },
  get machineSilent(): string { return t('sh.labels.modelText.machineSilent'); },
  get machineNoExecutor(): string { return t('sh.labels.modelText.machineNoExecutor'); },
  get machineNotInstalled(): string { return t('sh.labels.modelText.machineNotInstalled'); },
  listMissing: (reason: string): string => t('sh.labels.modelText.listMissing', { reason }),
};

// A model an account's executor reports that the list did not have, and one a tier uses
// that it no longer reports. Said once per account and model; neither switches anything by
// itself, because which model a tier runs on is the owner's decision.
export const modelsAddedText = (login: string, model: string): string =>
  t('sh.labels.modelsAdded', { login: loginName(login), model, page: loginPage(login).name });
export const modelsGoneText = (login: string, model: string): string =>
  t('sh.labels.modelsGone', { login: loginName(login), model, page: loginPage(login).name });

// A figure an executor gave for one quota window of its account, and when it last said so.
interface UsageFigure { window: string; used: number; resets_at: string | null; at: string }

// Adapters normalize executor window names; unfamiliar identifiers remain visible.
const WINDOW_TEXT: Readonly<Record<string, string>> = localeMap({
  five_hour: 'sh.labels.window.five_hour',
  seven_day: 'sh.labels.window.seven_day',
  five_hour_3p: 'sh.labels.window.five_hour_3p',
  seven_day_3p: 'sh.labels.window.seven_day_3p',
  seven_day_fable: 'sh.labels.window.seven_day_fable',
  overage: 'sh.labels.window.overage',
});

// Remaining quota percentage [0..100] from a reported used fraction [0..1].
export function remainingPercent(used: number): number {
  if (!Number.isFinite(used)) return 0;
  return Math.max(0, Math.min(100, Math.round((1 - used) * 100)));
}

// Format special balance/budget quota windows emitted by DeepSeek / New-API / One-API gateways.
export function formatSpecialQuotaWindow(window: string, used: number): string | null {
  for (const [prefix, titleKey] of [
    ['balance:', 'sh.labels.quota.title.balance'],
    ['bonus_balance:', 'sh.labels.quota.title.bonusBalance'],
    ['api_balance:', 'sh.labels.quota.title.apiBalance'],
  ] as const) {
    if (window.startsWith(prefix)) {
      const title = t(titleKey);
      const parts = window.split(':');
      if (parts.length >= 3) {
        const currency = parts[1]!;
        const amount = parts.slice(2).join(':');
        const symbol = currency === 'CNY' ? '¥' : currency === 'USD' ? '$' : `${currency} `;
        return `${title} ${symbol}${amount}`;
      }
      return t('sh.labels.quota.balanceAvailable', { title });
    }
  }
  if (window.startsWith('gateway_unlimited:')) {
    const rest = window.slice('gateway_unlimited:'.length);
    const sep = rest.indexOf(':');
    if (sep > 0) {
      const route = rest.slice(0, sep);
      const spent = rest.slice(sep + 1);
      return t('sh.labels.quota.gatewayUnlimitedRoute', { route, spent });
    }
    return t('sh.labels.quota.gatewayUnlimited', { spent: rest });
  }
  if (window.startsWith('gateway_budget:')) {
    const rest = window.slice('gateway_budget:'.length);
    const sep = rest.indexOf(':');
    const pct = `${remainingPercent(used)}%`;
    if (sep > 0 && !rest.startsWith('$')) {
      const route = rest.slice(0, sep);
      const budget = rest.slice(sep + 1);
      return t('sh.labels.quota.gatewayBudgetRoute', { route, budget, pct });
    }
    return t('sh.labels.quota.gatewayBudget', { budget: rest, pct });
  }
  return null;
}

export function usageLine({ window, used, resets_at: resets }: UsageFigure, now: number = Date.now()): string {
  const special = formatSpecialQuotaWindow(window, used);
  if (special !== null) return special;
  const label = Object.hasOwn(WINDOW_TEXT, window)
    ? WINDOW_TEXT[window]!
    : window.startsWith('seven_day_') && window.length > 'seven_day_'.length
      ? t('sh.labels.quota.sevenDayNamed', { name: window.slice('seven_day_'.length) })
      : window;
  const pct = remainingPercent(used);
  return resets
    ? t('sh.labels.quota.usageWithReset', { label, pct, resets: formatTime(resets, new Date(now)) })
    : t('sh.labels.quota.usagePlain', { label, pct });
}

// How old the figures are: what was spent since, in tycho or elsewhere, is not in them. Said
// with the oldest moment, never shown as this moment's. Undefined when there are none.
export function usageReadLine(usage: readonly UsageFigure[], now: number = Date.now()): string | undefined {
  const oldest = usage.map(({ at }) => at).sort()[0];
  return oldest === undefined ? undefined : t('sh.labels.quota.readAt', { at: formatTime(oldest, new Date(now)) });
}

// What the service knows of a login from using it: what runs on it, the owner's ceiling,
// the rest after a used-up quota and the usage figures that still hold.
export interface LoginStatus {
  active_runs: number;
  max_runs: number | null;
  rest: { until: string; reason: string | null } | null;
  usage: UsageFigure[];
  // The executor refused the credential this login holds now (or a machine reported its own
  // login refused): the owner has to sign in again. Optional so that a caller which never
  // had to say it (an older page, a test fixture) still reads as not rejected.
  rejected?: boolean;
}

export const loginFull = ({ active_runs: active, max_runs: most }: LoginStatus): boolean => most !== null && active >= most;

// The windows that mean a general subscription limit rather than one model's share:
// `five_hour` and `seven_day` exactly. A per-model seven-day window does not say this.
const GENERAL_WINDOWS = new Set(['five_hour', 'seven_day']);

// Whether one of the general windows is fully used, as the executor itself reported it. The
// page says "额度已用完" from this: a 429 that still carried windows is a successful read, and
// the figure is what says the account is out until the window resets.
export const quotaUsedUp = (usage: readonly { window: string; used: number }[]): boolean =>
  usage.some(({ window, used }) => GENERAL_WINDOWS.has(window) && used >= 1);

// The words for a login the executor refused, wherever a status line is shown.
export let NEEDS_LOGIN_TEXT: string = t('sh.labels.needsLogin');

// Whether a login can be given work now, and when not, why and until when.
export function loginStatusLine(status: LoginStatus, now: number = Date.now()): string {
  // A refused credential is the owner's to fix: never "可用" while it stands.
  if (status.rejected) return NEEDS_LOGIN_TEXT;
  if (status.rest) return t('sh.labels.loginStatus.resting', { until: formatTime(status.rest.until, new Date(now)) });
  // A read that found the general window full, without a Run having rested it yet.
  if (quotaUsedUp(status.usage)) return t('sh.labels.loginStatus.quotaUsedUp');
  if (loginFull(status)) return t('sh.labels.loginStatus.full', { active: status.active_runs, max: status.max_runs });
  return status.active_runs
    ? t('sh.labels.loginStatus.availableBusy', { active: status.active_runs })
    : t('sh.labels.loginStatus.available');
}

// How a Run the quota cut short reads on its Task's page: where it ran, until when that
// account rests, and that nothing is asked of the owner.
export function quotaEndLine(quota: { login_id?: string | null; login_name?: string | null; account_id?: string; target_id?: string; rest_until?: string | null } | null | undefined, now: number = Date.now()): string {
  if (!quota) return t('sh.labels.quotaEnd.generic');
  const login = loginName(quota.login_name ?? quota.login_id ?? quota.account_id ?? quota.target_id ?? '');
  return quota.rest_until
    ? t('sh.labels.quotaEnd.withRest', { login, until: formatTime(quota.rest_until, new Date(now)) })
    : t('sh.labels.quotaEnd.withoutRest', { login });
}

export interface ProjectRouterState {
  project_id: string;
  alive: boolean;
  error: string | null;
  resting_until?: string | null;
  turn?: string | null;
}

// What the service says of the Router process: `error` is why it is stopped, `turn` the
// message it is working on, which a restart waits for, `waiting` the barrier an accepted
// restart waits out before it starts the new process.
export interface RouterState {
  alive: boolean;
  error: string | null;
  host_error?: string | null;
  restarting: boolean;
  turn: string | null;
  waiting?: 'degraded' | 'recovering' | null;
  projects?: readonly ProjectRouterState[];
}

export const projectRouterErrors = (router: RouterState): readonly ProjectRouterState[] =>
  (router.projects ?? []).filter((each) => Boolean(each.error));

// What an accepted restart waits out before it starts the new process: `waiting` names it.
const RESTART_WAITS: Readonly<Record<string, string>> = localeMap({
  degraded: 'sh.labels.router.restartWaitDegraded',
  recovering: 'sh.labels.router.restartWaitRecovering',
});

// A restart asked for waits for the turn under way; until that ends it has not begun.
const restartLine = ({ turn, waiting }: RouterState): string => (waiting && RESTART_WAITS[waiting])
  || (turn ? t('sh.labels.router.restartAfterTurn') : t('sh.labels.router.restarting'));

// A restart comes before why the Router is stopped: that reason is about to be tried again.
export function routerLine(router: RouterState): string {
  if (router.restarting) return restartLine(router);
  if (router.error) return t('sh.labels.router.stopped', { error: router.error });
  const failed = projectRouterErrors(router);
  if (failed.length > 0) {
    return failed.length === 1
      ? t('sh.labels.router.projectStoppedOne', { error: failed[0]!.error })
      : t('sh.labels.router.projectStoppedMany', { count: failed.length, error: failed[0]!.error });
  }
  return router.alive ? t('sh.labels.router.alive') : t('sh.labels.router.idle');
}

// A note with `href` ends in a link named `label`: where the owner puts that one right.
export interface BannerNote { text: string; href?: string; label?: string }

// The top banner, in the order shown. The restart button is beside the Router's settings.
export function bannerNotes({ dispatch, router, channels }: {
  dispatch: { degraded: boolean; recovering: boolean; paused: boolean | null };
  router: RouterState;
  channels?: { wecom?: { error?: string | null } | null } | null;
}): BannerNote[] {
  const notes: BannerNote[] = [];
  if (dispatch.degraded) notes.push({ text: t('sh.labels.banner.degraded') });
  if (dispatch.recovering) notes.push({ text: t('sh.labels.banner.recovering') });
  if (dispatch.paused) notes.push({ text: t('sh.labels.banner.paused') });
  if (router.error) {
    notes.push({ text: t('sh.labels.router.stopped', { error: router.error }), href: '#/settings/router.cli', label: t('sh.labels.goSettings') });
  } else {
    const failed = projectRouterErrors(router);
    if (failed.length > 0) {
      notes.push({
        text: failed.length === 1
          ? t('sh.labels.router.projectStoppedOne', { error: failed[0]!.error })
          : t('sh.labels.router.projectStoppedMany', { count: failed.length, error: failed[0]!.error }),
        href: `#/projects/${encodeURIComponent(failed[0]!.project_id)}/settings`,
        label: t('sh.labels.goCheck'),
      });
    }
  }
  if (router.restarting) notes.push({ text: restartLine(router) });
  if (channels?.wecom?.error) notes.push({ text: t('sh.labels.banner.wecomStopped', { error: channels.wecom.error }) });
  return notes;
}

export interface GatewayNote extends BannerNote { failed: boolean }

// What the service says of its connection to the gateway; null when it has none to speak
// of. `error` is ssh's own words, which run over several lines.
export function gatewayNote(
  { state, since, error }: { state: string; since: string | null; error: string | null },
  now: number = Date.now(),
): GatewayNote | null {
  const said = (error ?? '').trim().replace(/\s*\n\s*/g, t('sh.semicolonSep'));
  if (state === 'connecting') {
    return {
      text: said ? t('sh.labels.gateway.connectingError', { said }) : t('sh.labels.gateway.connecting'),
      failed: false,
    };
  }
  if (state === 'connected') {
    return {
      text: since ? t('sh.labels.gateway.connectedSince', { since: formatTime(since, new Date(now)) }) : t('sh.labels.gateway.connected'),
      failed: false,
    };
  }
  if (state === 'down') {
    return {
      text: said ? t('sh.labels.gateway.downError', { said }) : t('sh.labels.gateway.down'),
      failed: true,
      href: '#/settings/gateway.ssh',
      label: t('sh.labels.goSettings'),
    };
  }
  return null;
}

export let deviceLoginMissingText: string = t('sh.labels.deviceLoginMissing');
export function loginDurationText(milliseconds: number): string {
  const days = milliseconds / 86_400_000;
  if (Number.isInteger(days)) {
    return days === 1 ? t('sh.labels.duration.oneDay') : t('sh.labels.duration.days', { count: days });
  }
  const hours = milliseconds / 3_600_000;
  return hours === 1 ? t('sh.labels.duration.oneHour') : t('sh.labels.duration.hours', { count: hours });
}

// A machine's join, answered from the console's one entry or from a card on the phone
// (docs/design/nodes.md §1.1 step 2): the same words wherever it was answered.
export const joinDecisionText = (approve: boolean, name: string): string => approve
  ? t('sh.labels.joinApproved', { name })
  : t('sh.labels.joinRejected', { name });
export let joinMissingText: string = t('sh.labels.joinMissing');
export let joinExpiredText: string = t('sh.labels.joinExpired');
export let joinHandledText: string = t('sh.labels.joinHandled');

export const deviceLoginDecisionText = (approve: boolean, device: string, durationMs?: number): string => {
  if (!approve) return t('sh.labels.deviceLoginRejected', { device });
  return durationMs !== undefined
    ? t('sh.labels.deviceLoginApprovedWithDuration', { device, duration: loginDurationText(durationMs) })
    : t('sh.labels.deviceLoginApproved', { device });
};

export function incompleteReleaseLine(version: string, pending: readonly string[]): string {
  return t('sh.labels.incompleteRelease', { version, pending: pending.join(t('sh.semicolonSep')) });
}

// --- machines a task spawned (docs/design/nodes.md §1.3) ------------------------------

// Where a machine came from: the owner let it in, or a round of a task spawned it.
export interface MachineSourceView { task_id: string; run_id: string; round: number }
export const machineSourceText = (source: MachineSourceView | null | undefined): string =>
  source == null
    ? t('sh.labels.machineSource.manual')
    : t('sh.labels.machineSource.spawned', { taskId: source.task_id, round: source.round });

// What a spawned machine's quota allows it, in one line.
export const machineScopeText = (scope: { project_id: string; executors: string[] | null } | null | undefined): string | null =>
  scope == null
    ? null
    : scope.executors === null
      ? t('sh.labels.machineScope.projectOnly', { projectId: scope.project_id })
      : t('sh.labels.machineScope.projectExecutors', { projectId: scope.project_id, executors: scope.executors.join(t('sh.listSep')) });

// The endings of a spawned machine, each its own fact (§1.3). `material` is about the quota
// it came in under: whether any material that could still let a machine in is out there.
export interface MachineEnds {
  material: { live: number; live_until: string | null; ended_at: string | null; ended_why: 'used' | 'expired' | 'revoked' | null };
  drain_at: string | null;
  evidence_at: string | null;
  left_at: string | null;
  left_reason: 'leave' | 'revoked' | 'destroyed' | null;
  destroyed_at: string | null;
  destroyed_by: string | null;
  // Its rounds that ended judged gone: their output never comes back, so its evidence is
  // never confirmed, and that is not something still to wait for.
  lost_rounds: number;
}

interface MachineEndLine { key: 'material' | 'drain' | 'evidence' | 'left' | 'destroyed'; label: string; done: boolean; text: string }

const MATERIAL_ENDED: Readonly<Record<'used' | 'expired' | 'revoked', string>> = localeMap({
  used: 'sh.labels.materialEnded.used',
  expired: 'sh.labels.materialEnded.expired',
  revoked: 'sh.labels.materialEnded.revoked',
});
const LEFT_TEXT: Readonly<Record<'leave' | 'revoked' | 'destroyed', string>> = localeMap({
  leave: 'sh.labels.leftReason.leave',
  revoked: 'sh.labels.leftReason.revoked',
  destroyed: 'sh.labels.leftReason.destroyed',
});

// Whether a quota's materials could still let a machine in: said the same on the quota and
// on each machine that came in under it. None live and no ending: no round has been handed
// one yet, which is not a material that lapsed.
const neverHanded = (material: MachineEnds['material']): boolean => material.live === 0 && material.ended_at === null;
export function materialText(material: MachineEnds['material'], now: Date = new Date()): string {
  if (material.live > 0) return t('sh.labels.material.live', { count: material.live, until: formatTime(material.live_until, now) });
  return neverHanded(material)
    ? t('sh.labels.material.neverHanded')
    : t('sh.labels.material.ended', { why: MATERIAL_ENDED[material.ended_why ?? 'expired'], at: formatTime(material.ended_at, now) });
}

function evidenceText(ends: MachineEnds, at: (value: string | null) => string): string {
  if (ends.evidence_at !== null) return t('sh.labels.evidence.confirmed', { at: at(ends.evidence_at) });
  if (ends.lost_rounds > 0) {
    return ends.lost_rounds === 1
      ? t('sh.labels.evidence.lostOne')
      : t('sh.labels.evidence.lostMany', { count: ends.lost_rounds });
  }
  return t('sh.labels.evidence.pending');
}

// One line per fact, in the order they normally come. A fact not reached says so in its own
// words: in particular an ended registration is never read as a released instance — only a
// report from the skill that made it says that.
export function machineEndLines(ends: MachineEnds, now: Date = new Date()): MachineEndLine[] {
  const at = (value: string | null): string => formatTime(value, now);
  const { material } = ends;
  return [
    { key: 'material', label: t('sh.labels.machineEnd.material.label'), done: material.live === 0 && !neverHanded(material), text: materialText(material, now) },
    {
      key: 'drain',
      label: t('sh.labels.machineEnd.drain.label'),
      done: ends.drain_at !== null,
      text: ends.drain_at === null ? t('sh.labels.machineEnd.drain.active') : t('sh.labels.machineEnd.drain.stopped', { at: at(ends.drain_at) }),
    },
    { key: 'evidence', label: t('sh.labels.machineEnd.evidence.label'), done: ends.evidence_at !== null, text: evidenceText(ends, at) },
    {
      key: 'left',
      label: t('sh.labels.machineEnd.left.label'),
      done: ends.left_at !== null,
      text: ends.left_at === null
        ? t('sh.labels.machineEnd.left.active')
        : t('sh.labels.machineEnd.left.ended', { at: at(ends.left_at), reason: LEFT_TEXT[ends.left_reason ?? 'leave'] }),
    },
    {
      key: 'destroyed',
      label: t('sh.labels.machineEnd.destroyed.label'),
      done: ends.destroyed_at !== null,
      text: ends.destroyed_at === null
        ? t('sh.labels.machineEnd.destroyed.pending')
        : t('sh.labels.machineEnd.destroyed.confirmed', { at: at(ends.destroyed_at), by: ends.destroyed_by ?? '—' }),
    },
  ];
}

// What a machine's client says about the version it runs against the host's (nodes.md §1.4).
// The host's own version and the machine's report are the whole of it: a client that never
// reported is an old one, not a machine with nothing to say. A machine behind the host says
// what it is doing about it, and a failure says how long ago it was reported.
export function nodeReleaseText(held: { version: string; at: string; upgrade: { state: 'waiting' | 'failed'; target: string; detail: string } | null } | null | undefined, hostVersion: string | null | undefined, now: number = Date.now()): string {
  if (!held) return t('sh.labels.nodeRelease.unreported');
  if (hostVersion == null || held.version === hostVersion) return `tycho ${held.version}`;
  const behind = t('sh.labels.nodeRelease.behind', { version: held.version, hostVersion });
  if (held.upgrade === null) return behind;
  if (held.upgrade.state === 'waiting') return t('sh.labels.nodeRelease.waiting', { behind, detail: held.upgrade.detail });
  return t('sh.labels.nodeRelease.failed', { behind, detail: held.upgrade.detail, ago: agoText(held.at, now) });
}

// How long ago something was said. A moment that cannot be measured — unreadable, or ahead
// of this host's clock — is said as such instead of being counted as just now.
export function agoText(at: string, now: number = Date.now()): string {
  const ago = now - Date.parse(at);
  if (!Number.isFinite(ago) || ago < 0) return t('sh.labels.ago.unknown');
  if (ago < MINUTE_MS) return t('sh.labels.ago.justNow');
  if (ago < HOUR_MS) return t('sh.labels.ago.minutes', { count: Math.floor(ago / MINUTE_MS) });
  if (ago < DAY_MS) return t('sh.labels.ago.hours', { count: Math.floor(ago / HOUR_MS) });
  return t('sh.labels.ago.days', { count: Math.floor(ago / DAY_MS) });
}

// What every WeCom message starts with (docs/design/project-sessions.md §2): the project it is
// about, or 【系统】 for what belongs to none.
export const projectMark = (name: string | null): string =>
  t('sh.labels.projectMark', { name: name ?? t('sh.labels.systemMark') });

// Why the front desk put a message to the owner instead of placing it (§2).
export const CANDIDATE_REASON_TEXT: Readonly<Record<string, string>> = localeMap({
  none: 'sh.labels.candidateReason.none',
  conflict: 'sh.labels.candidateReason.conflict',
  objects: 'sh.labels.candidateReason.objects',
  name: 'sh.labels.candidateReason.name',
});

onLocaleChange(() => {
  PROJECT_PAUSED_LABEL = t('sh.labels.projectPausedLabel');
  PROJECT_PAUSED_TEXT = t('sh.labels.projectPausedText');
  PROJECT_PAUSED_NOTE = t('sh.labels.projectPausedNote');
  PROJECT_ARCHIVED_LABEL = t('sh.labels.projectArchivedLabel');
  PROJECT_ARCHIVED_TEXT = t('sh.labels.projectArchivedText');
  PROJECT_ARCHIVED_NOTE = t('sh.labels.projectArchivedNote');
  ALL_PROJECTS_ARCHIVED_TEXT = t('sh.labels.allProjectsArchived');
  ACCOUNT_LOGIN_FIX = t('sh.labels.accountLoginFix');
  ANY_LOGIN_TEXT = t('sh.labels.anyLogin');
  NEEDS_LOGIN_TEXT = t('sh.labels.needsLogin');
  deviceLoginMissingText = t('sh.labels.deviceLoginMissing');
  joinMissingText = t('sh.labels.joinMissing');
  joinExpiredText = t('sh.labels.joinExpired');
  joinHandledText = t('sh.labels.joinHandled');
  workGroupOrderList.splice(0, workGroupOrderList.length, ...workGroupOrderValues());
});
