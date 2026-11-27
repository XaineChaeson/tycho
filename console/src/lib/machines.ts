// What the machines page says about a machine that came back to the service by itself, and
// about the machines asking to be let in (docs/design/nodes.md §1.1, §1.2, §5.4). The service
// reports facts — a connection state, a source, a count, what the machine read on itself —
// and the owner's words for them are the console's own: it is the only place they are read.
// What a spawned machine's source, scope and endings are called is shared with the service,
// in shared/labels.ts.
import { t } from '@shared/i18n.ts';
import { loginFull, materialText } from '@shared/labels.ts';
import { RETIRED_TIER_STANDING } from '@shared/logins.ts';
import { CHECK_MISSING_TEXT, READ_ONLY_LAYERS } from '@shared/roles.ts';
import { formatTime } from '@shared/time.ts';
import type { EntryReport, EntryStatus, Invite, Machine, MachineExecutor, MachineExecutors, MachineLogin, MachineNode } from './types.ts';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

// Whether the machine is here now, and when it was last heard from. A machine that is away
// is not a fault: its client reconnects by itself, so this is a state and not a problem.
export function nodeStateLine(node: Pick<MachineNode, 'connected' | 'last_seen_at'>, now: number = Date.now()): string {
  if (node.connected) return t('mach.state.connected');
  if (!node.last_seen_at) return t('mach.state.neverSeen');
  return t('mach.state.lastSeen', { at: formatTime(node.last_seen_at, new Date(now)) });
}

// Where a machine's own login stands for new work, in the order dispatch asks: set up at
// all, refused by its executor, let work there by its machine's word, then resting or full.
// One reading, used by both pages that show a machine's own login.
export function machineLoginStanding(login: MachineLogin): { text: string; tone: 'failed' | 'waiting' | 'success' } {
  const { status } = login;
  if (login.retired_tiers?.length) return { text: RETIRED_TIER_STANDING, tone: 'failed' };
  if (!login.configured) return { text: t('mach.standing.unconfigured'), tone: 'waiting' };
  if (login.refused) return { text: t('mach.standing.refused'), tone: 'failed' };
  if (!login.usable_here) return { text: login.signed_in === false ? t('mach.standing.signedOut') : t('mach.standing.awaitingReport'), tone: 'waiting' };
  if (status.rest) return { text: t('mach.standing.resting'), tone: 'waiting' };
  if (loginFull(status)) return { text: t('mach.standing.full'), tone: 'waiting' };
  return { text: t('mach.standing.usable'), tone: 'success' };
}

// The one address a machine's own login is written at: its settings by login id once it
// exists, and by machine and executor before that (service/http.ts).
export const machineLoginPath = (machine: Pick<Machine, 'uid'>, login: Pick<MachineLogin, 'id' | 'executor'>): string =>
  login.id === null
    ? '/api/machines/' + encodeURIComponent(machine.uid) + '/logins/' + encodeURIComponent(login.executor)
    : '/api/logins/' + encodeURIComponent(login.id);

// What the machine last reported as running on it. The service keeps this from the
// machine's own polls, so it stands only while the machine is connected. What the machine
// could not read is said as such: it is not the same as nothing running.
export const nodeRunsText = (count: number, unknown = 0): string => {
  const base = count === 0 ? t('mach.runs.idle') : t('mach.runs.running', { count });
  return unknown > 0 ? t('mach.runs.withUnknown', { base, unknown }) : base;
};

// One row of a machine's executor table: what the machine itself read of that executor
// there, when it has reported it, and the login tycho keeps for it there, if any
// (docs/design/accounts-machines-decoupled.md: the machine's own login belongs to the
// machine). Both are null-able on their own: an executor the owner set up and the machine
// no longer reports is still a row — what was set up for it is the owner's, whatever the
// machine now says — and an executor the machine reports and nobody has set up is a row
// with nothing to edit.
export interface MachineExecutorRow {
  executor: string;
  reported: MachineExecutor | null;
  login: MachineLogin | null;
}

export function machineExecutorRows({ node, logins }: Pick<Machine, 'node' | 'logins'>): MachineExecutorRow[] {
  const own = logins ?? [];
  const rows: MachineExecutorRow[] = (node.executors?.executors ?? []).map((reported) => ({
    executor: reported.executor,
    reported,
    login: own.find((login) => login.executor === reported.executor) ?? null,
  }));
  for (const login of own) {
    if (!rows.some((row) => row.executor === login.executor)) rows.push({ executor: login.executor, reported: null, login });
  }
  return rows;
}

// Nothing to say in a cell: the executor was not there to be asked, or its version is one
// this host's commands cannot run at all.
const NOT_ASKED = '—';

// Whether its command is on that machine at all, and the line it printed when asked.
export function executorInstalledText({ reported }: MachineExecutorRow): string {
  if (!reported) return t('mach.exec.notReported');
  if (!reported.installed) return t('mach.exec.notInstalled');
  return reported.version === null ? t('mach.exec.installed') : t('mach.exec.installedVersion', { version: reported.version });
}

// Where the machine found its command, or — when it found none — every place it looked in
// (node/locate.ts). Nothing when the machine did not say: an older client, or no report.
export function executorWhereText({ reported }: MachineExecutorRow): string | null {
  if (!reported) return null;
  if (reported.installed) return reported.path ? t('mach.exec.pathAt', { path: reported.path }) : null;
  return reported.error ?? null;
}

// What the machine said of being signed in there. Not installed, and a version the service
// cannot run, are not asked at all: that cell says nothing rather than a login state.
export function executorLoginText({ reported, login }: MachineExecutorRow): string {
  if (!reported) {
    if (!login) return t('mach.exec.notReported');
    return login.signed_in === true ? t('mach.exec.signedIn') : login.signed_in === false ? t('mach.standing.signedOut') : t('mach.exec.notReported');
  }
  if (!reported.installed || reported.unusable) return NOT_ASKED;
  if (reported.logged_in === true) return t('mach.exec.signedIn');
  if (reported.logged_in === false) return t('mach.exec.signedOut');
  return reported.error ? t('mach.exec.loginUnknownReason', { reason: reported.error }) : t('mach.exec.loginUnknown');
}

// Whether its read-only way started on this machine, as the machine found out itself: only
// then does a read-only Task go here. An executor that offers none says so, rather than
// nothing; one that was not asked says nothing, and the two are not the same.
export function executorReadOnlyText({ reported }: MachineExecutorRow): string {
  if (!reported) return t('mach.exec.notReported');
  if (!reported.installed || reported.unusable) return NOT_ASKED;
  if (reported.read_only_offered === false) return t('mach.exec.noReadOnly');
  if (!reported.read_only) return t('mach.exec.notReported');
  const layer = READ_ONLY_LAYERS[reported.read_only.layer] ?? reported.read_only.layer;
  if (!reported.read_only.available) return t('mach.exec.readOnlyUnavailable', { reason: reported.read_only.error ?? t('mach.exec.noReason') });
  // A client that does not check a read-only round's code afterwards takes none (§5).
  return reported.read_only.checks_code
    ? t('mach.exec.readOnlyAvailable', { layer })
    : t('mach.exec.readOnlyUnavailable', { reason: CHECK_MISSING_TEXT });
}

// What the machine's own report is headed by: the moment it asked its executors, so a
// report that is hours old never reads as one just read.
// The global entry's own moment rides beside it when the machine has said what it wrote: the
// two are asked at different times.
export const executorsCaption = (report: MachineExecutors | null, now: number = Date.now(), _entry?: EntryReport | null): string =>
  report ? t('mach.exec.captionAt', { when: readMomentText(report.at, now) }) : t('mach.exec.caption');

// What became of the global entry (knowledge-and-skills.md §4.3) for one executor of a machine:
// where it is and — when it is not read, or not known to be — why, in the machine's words.
// Nothing said by the machine is "没有报告", never "nothing written"; a report that has no line
// for this executor wrote nothing for it.
export function executorEntryText({ executor }: Pick<MachineExecutorRow, 'executor'>, entry: EntryReport | null | undefined): string {
  if (!entry) return t('mach.exec.notReported');
  const status = entry.executors.find((each) => each.executor === executor);
  return status === undefined ? NOT_ASKED : entryStateText(status);
}

// The same for the host's own executors, as one line at the head of the machines page.
export function entryLine(report: EntryReport | null | undefined, now: number = Date.now(), where: string = t('mach.entry.defaultWhere')): string {
  if (!report) return t('mach.entry.notReported', { where });
  const each = report.executors.map((one) => `${one.executor} ${entryStateText(one)}`);
  return t('mach.entry.line', {
    where,
    when: momentText(report.at, now, 'written'),
    items: each.length > 0 ? each.join(' · ') : t('mach.entry.noneToWrite'),
  });
}

function entryStateText({ path, state, note }: EntryStatus): string {
  switch (state) {
    case 'written': return t('mach.entry.written', { path });
    case 'covered': return t('mach.entry.covered', { path, note: note ?? t('mach.exec.noReason') });
    case 'unconfirmed': return t('mach.entry.unconfirmed', { path, note: note ?? t('mach.exec.noReason') });
    case 'occupied': return t('mach.entry.occupied', { path, note: note ?? t('mach.entry.occupiedDefault') });
    case 'failed': return t('mach.entry.failed', { note: note ?? t('mach.exec.noReason') });
    case 'cleared': return t('mach.entry.cleared', { note: note ?? t('mach.entry.clearedDefault') });
  }
}

// Why a machine's table has no row at all: it never reported, or it reported and there is
// nothing on it. Never the same fact.
export const executorsEmptyText = (report: MachineExecutors | null): string =>
  report ? t('mach.exec.emptyReported') : t('mach.exec.emptyUnreported');

// How long ago the machine asked its executors, in the owner's words. A moment that cannot
// be measured — an unreadable time, or one ahead of this host's clock — is said as such
// rather than counted as just now.
function momentText(at: string, now: number, kind: 'read' | 'written'): string {
  const ago = now - Date.parse(at);
  if (!Number.isFinite(ago) || ago < 0) return t(kind === 'read' ? 'mach.moment.readUnknown' : 'mach.moment.writtenUnknown');
  if (ago < MINUTE_MS) return t(kind === 'read' ? 'mach.moment.readJustNow' : 'mach.moment.writtenJustNow');
  if (ago < HOUR_MS) return t(kind === 'read' ? 'mach.moment.readMinAgo' : 'mach.moment.writtenMinAgo', { count: Math.floor(ago / MINUTE_MS) });
  if (ago < DAY_MS) return t(kind === 'read' ? 'mach.moment.readHourAgo' : 'mach.moment.writtenHourAgo', { count: Math.floor(ago / HOUR_MS) });
  return t(kind === 'read' ? 'mach.moment.readDayAgo' : 'mach.moment.writtenDayAgo', { count: Math.floor(ago / DAY_MS) });
}
const readMomentText = (at: string, now: number): string => momentText(at, now, 'read');

// How long a request to join has left. The service's list holds no expired request, but one
// can run out while it is on the page.
export function joinExpiryText(expiresAt: string, now: number = Date.now()): string {
  const left = Date.parse(expiresAt) - now;
  if (!Number.isFinite(left) || left <= 0) return t('mach.join.expired');
  if (left < MINUTE_MS) return t('mach.join.expiresUnderMin');
  if (left < HOUR_MS) return t('mach.join.expiresMins', { minutes: Math.floor(left / MINUTE_MS) });
  const hours = Math.floor(left / HOUR_MS);
  const minutes = Math.floor((left - hours * HOUR_MS) / MINUTE_MS);
  return minutes === 0
    ? t('mach.join.expiresHours', { hours })
    : t('mach.join.expiresHoursMins', { hours, minutes });
}


// How a machine is brought in (nodes.md §1.1): the command run on that machine, at the address
// it joins at — the one the owner gave as this service's own, or else the one this page is
// open at, which only a machine that can open this very address can use. `unreachable` says so.
export interface JoinGuide { address: string; command: string; unreachable: string | null }
export function joinGuide(publicUrl: string | null | undefined, origin: string): JoinGuide {
  const address = (publicUrl || origin).replace(/\/$/, '');
  return {
    address,
    command: `tycho node join --to ${address}`,
    unreachable: publicUrl ? null : t('mach.join.unreachable', { address }),
  };
}
// A machine's name is its identity, said by its own client when it joined.
export const MACHINE_NAME_FIXED = t('mach.nameFixed');

// What removing a machine is. A spawned machine still registered is revoked: its token dies
// and its row stays, with how it ended. Once its registration has ended, what is left to
// remove is the record. Any other machine is deleted, as it always was.
interface MachineRemoval { action: string; confirm: string; sending: string; back: string; keeps: boolean }
export function machineRemoval(machine: Machine): MachineRemoval {
  const node = machine.node;
  if (!node.ephemeral) {
    return {
      action: t('common.delete'),
      confirm: t('mach.removal.confirmDelete'),
      sending: t('mach.removal.deleting'),
      back: t('mach.removal.keepDelete'),
      keeps: false,
    };
  }
  return node.ends?.left_at == null
    ? {
      action: t('mach.removal.revokeAction'),
      confirm: t('mach.removal.confirmRevoke'),
      sending: t('mach.removal.revoking'),
      back: t('mach.removal.keepRevoke'),
      keeps: true,
    }
    : {
      action: t('mach.removal.deleteRecordAction'),
      confirm: t('mach.removal.confirmDelete'),
      sending: t('mach.removal.deleting'),
      back: t('mach.removal.keepDelete'),
      keeps: false,
    };
}

// --- join quotas (nodes.md §1.3) ---------------------------------------------------------

export const inviteExecutorsText = (executors: string[] | null): string =>
  (executors === null ? t('mach.invite.anyExecutor') : executors.join(t('mach.listSep')));
export const inviteUsedText = ({ used, max_machines }: Pick<Invite, 'used' | 'max_machines'>): string =>
  t('mach.invite.used', { used, max: max_machines });

// Until when it lets machines in, or since when it does not: revoked comes first, since that
// ends it whatever time it had left.
export function inviteValidText({ revoked_at, expires_at }: Pick<Invite, 'revoked_at' | 'expires_at'>, now: number = Date.now()): string {
  const at = (value: string): string => formatTime(value, new Date(now));
  if (revoked_at !== null) return t('mach.invite.revokedAt', { at: at(revoked_at) });
  return Date.parse(expires_at) > now
    ? t('mach.invite.validUntil', { at: at(expires_at) })
    : t('mach.invite.expiredAt', { at: at(expires_at) });
}

// The materials it handed, in the words a machine it let in uses for its first ending: the
// same fact, so it is said one way.
export const inviteMaterialText = (material: Invite['material'], now: number = Date.now()): string => materialText(material, new Date(now));

// Whether revoking it would stop anything: it can still hand a material, or one it handed
// still works.
export const inviteRevocable = (invite: Invite, now: number = Date.now()): boolean =>
  invite.revoked_at === null && ((Date.parse(invite.expires_at) > now && invite.used < invite.max_machines) || invite.material.live > 0);
