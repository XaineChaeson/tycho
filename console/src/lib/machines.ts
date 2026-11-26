// What the machines page says about a machine that came back to the service by itself, and
// about the machines asking to be let in (docs/design/nodes.md §1.1, §1.2, §5.4). The service
// reports facts — a connection state, a source, a count, what the machine read on itself —
// and the owner's words for them are the console's own: it is the only place they are read.
// What a spawned machine's source, scope and endings are called is shared with the service,
// in shared/labels.ts.
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
  if (node.connected) return '已连回来';
  if (!node.last_seen_at) return '没连回来：还没收到过它的消息';
  return `没连回来：上次往来 ${formatTime(node.last_seen_at, new Date(now))}`;
}

// Where a machine's own login stands for new work, in the order dispatch asks: set up at
// all, refused by its executor, let work there by its machine's word, then resting or full.
// One reading, used by both pages that show a machine's own login.
export function machineLoginStanding(login: MachineLogin): { text: string; tone: 'failed' | 'waiting' | 'success' } {
  const { status } = login;
  if (login.retired_tiers?.length) return { text: RETIRED_TIER_STANDING, tone: 'failed' };
  if (!login.configured) return { text: '还没填档位', tone: 'waiting' };
  if (login.refused) return { text: '登录失效', tone: 'failed' };
  if (!login.usable_here) return { text: login.signed_in === false ? '机器说没登录' : '等机器报告', tone: 'waiting' };
  if (status.rest) return { text: '歇着', tone: 'waiting' };
  if (loginFull(status)) return { text: '到上限', tone: 'waiting' };
  return { text: '可用', tone: 'success' };
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
  const base = count === 0 ? '空闲' : `在跑 ${count} 轮`;
  return unknown > 0 ? `${base}，另有 ${unknown} 轮待核实` : base;
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
  if (!reported) return '没有报告';
  if (!reported.installed) return '没装';
  return reported.version === null ? '装了' : `装了 · ${reported.version}`;
}

// Where the machine found its command, or — when it found none — every place it looked in
// (node/locate.ts). Nothing when the machine did not say: an older client, or no report.
export function executorWhereText({ reported }: MachineExecutorRow): string | null {
  if (!reported) return null;
  if (reported.installed) return reported.path ? `在 ${reported.path}` : null;
  return reported.error ?? null;
}

// What the machine said of being signed in there. Not installed, and a version the service
// cannot run, are not asked at all: that cell says nothing rather than a login state.
export function executorLoginText({ reported, login }: MachineExecutorRow): string {
  if (!reported) {
    if (!login) return '没有报告';
    return login.signed_in === true ? '已登录' : login.signed_in === false ? '机器说没登录' : '没有报告';
  }
  if (!reported.installed || reported.unusable) return NOT_ASKED;
  if (reported.logged_in === true) return '已登录';
  if (reported.logged_in === false) return '没登录';
  return reported.error ? `说不清（${reported.error}）` : '说不清';
}

// Said of an executor that has no read-only way of its own (dsh): its read-only work goes
// elsewhere. The same words the machine page has always used for it.
const NO_READ_ONLY_TEXT = '这个执行器不提供只读';

// Whether its read-only way started on this machine, as the machine found out itself: only
// then does a read-only Task go here. An executor that offers none says so, rather than
// nothing; one that was not asked says nothing, and the two are not the same.
export function executorReadOnlyText({ reported }: MachineExecutorRow): string {
  if (!reported) return '没有报告';
  if (!reported.installed || reported.unusable) return NOT_ASKED;
  if (reported.read_only_offered === false) return NO_READ_ONLY_TEXT;
  if (!reported.read_only) return '没有报告';
  const layer = READ_ONLY_LAYERS[reported.read_only.layer] ?? reported.read_only.layer;
  if (!reported.read_only.available) return `不可用（${reported.read_only.error ?? '没说原因'}）`;
  // A client that does not check a read-only round's code afterwards takes none (§5).
  return reported.read_only.checks_code ? `可用（${layer}）` : `不可用（${CHECK_MISSING_TEXT}）`;
}

// What the machine's own report is headed by: the moment it asked its executors, so a
// report that is hours old never reads as one just read.
// The global entry's own moment rides beside it when the machine has said what it wrote: the
// two are asked at different times.
export const executorsCaption = (report: MachineExecutors | null, now: number = Date.now(), _entry?: EntryReport | null): string =>
  report ? `机器上的执行器（${readMomentText(report.at, now)}）` : '机器上的执行器';

// What became of the global entry (knowledge-and-skills.md §4.3) for one executor of a machine:
// where it is and — when it is not read, or not known to be — why, in the machine's words.
// Nothing said by the machine is "没有报告", never "nothing written"; a report that has no line
// for this executor wrote nothing for it.
export function executorEntryText({ executor }: Pick<MachineExecutorRow, 'executor'>, entry: EntryReport | null | undefined): string {
  if (!entry) return '没有报告';
  const status = entry.executors.find((each) => each.executor === executor);
  return status === undefined ? NOT_ASKED : entryStateText(status);
}

// The same for the host's own executors, as one line at the head of the machines page.
export function entryLine(report: EntryReport | null | undefined, now: number = Date.now(), where = '机器上'): string {
  if (!report) return `${where}执行器的全局知识入口：还没报告`;
  const each = report.executors.map((one) => `${one.executor} ${entryStateText(one)}`);
  return `${where}执行器的全局知识入口（${momentText(report.at, now, '写')}）：${each.length > 0 ? each.join(' · ') : '没有要写的执行器'}`;
}

function entryStateText({ path, state, note }: EntryStatus): string {
  switch (state) {
    case 'written': return `已写入 ${path}`;
    case 'covered': return `已写入 ${path}，但执行器不会读到：${note ?? '没说原因'}`;
    case 'unconfirmed': return `已写入 ${path}，读不读确认不了：${note ?? '没说原因'}`;
    case 'occupied': return `没写：${path} ${note ?? '已有别的内容'}`;
    case 'failed': return `没写进去：${note ?? '没说原因'}`;
    case 'cleared': return `没有写：${note ?? '没有要写的'}`;
  }
}

// Why a machine's table has no row at all: it never reported, or it reported and there is
// nothing on it. Never the same fact.
export const executorsEmptyText = (report: MachineExecutors | null): string =>
  report ? '机器上一个执行器也没有' : '还没读到机器上有哪些执行器';

// How long ago the machine asked its executors, in the owner's words. A moment that cannot
// be measured — an unreadable time, or one ahead of this host's clock — is said as such
// rather than counted as just now.
function momentText(at: string, now: number, done: string): string {
  const ago = now - Date.parse(at);
  if (!Number.isFinite(ago) || ago < 0) return `不知道是什么时候${done}的`;
  if (ago < MINUTE_MS) return `刚刚${done}`;
  if (ago < HOUR_MS) return `${Math.floor(ago / MINUTE_MS)} 分钟前${done}`;
  if (ago < DAY_MS) return `${Math.floor(ago / HOUR_MS)} 小时前${done}`;
  return `${Math.floor(ago / DAY_MS)} 天前${done}`;
}
const readMomentText = (at: string, now: number): string => momentText(at, now, '读到');

// How long a request to join has left. The service's list holds no expired request, but one
// can run out while it is on the page.
export function joinExpiryText(expiresAt: string, now: number = Date.now()): string {
  const left = Date.parse(expiresAt) - now;
  if (!Number.isFinite(left) || left <= 0) return '已经过期';
  if (left < MINUTE_MS) return '还有不到 1 分钟过期';
  if (left < HOUR_MS) return `还有 ${Math.floor(left / MINUTE_MS)} 分钟过期`;
  const hours = Math.floor(left / HOUR_MS);
  const minutes = Math.floor((left - hours * HOUR_MS) / MINUTE_MS);
  return minutes === 0 ? `还有 ${hours} 小时过期` : `还有 ${hours} 小时 ${minutes} 分钟过期`;
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
    unreachable: publicUrl ? null : `还没有填对外地址，这里用的是这个页面现在的地址 ${address}：只有能打开这个地址的机器（一般只有这台电脑）能用它加入。要接别的机器，先到设置里填“对外地址”。`,
  };
}
// A machine's name is its identity, said by its own client when it joined.
export const MACHINE_NAME_FIXED = '机器名是加入时那台机器上的客户端报上来的，改不了；要换名字，先在这里删掉这台机器，再在那台机器上带 --name <新名字> 重新加入。';

// What removing a machine is. A spawned machine still registered is revoked: its token dies
// and its row stays, with how it ended. Once its registration has ended, what is left to
// remove is the record. Any other machine is deleted, as it always was.
interface MachineRemoval { action: string; confirm: string; sending: string; back: string; keeps: boolean }
const REVOKE: MachineRemoval = { action: '撤销这台机器', confirm: '确认撤销', sending: '撤销中', back: '不撤了', keeps: true };
const DELETE_RECORD: MachineRemoval = { action: '删除记录', confirm: '确认删除', sending: '删除中', back: '不删了', keeps: false };
const DELETE: MachineRemoval = { action: '删除', confirm: '确认删除', sending: '删除中', back: '不删了', keeps: false };
export function machineRemoval(machine: Machine): MachineRemoval {
  const node = machine.node;
  if (!node.ephemeral) return DELETE;
  return node.ends?.left_at == null ? REVOKE : DELETE_RECORD;
}

// --- join quotas (nodes.md §1.3) ---------------------------------------------------------

export const inviteExecutorsText = (executors: string[] | null): string => (executors === null ? '不限' : executors.join('、'));
export const inviteUsedText = ({ used, max_machines }: Pick<Invite, 'used' | 'max_machines'>): string => `已登记 ${used}/${max_machines}`;

// Until when it lets machines in, or since when it does not: revoked comes first, since that
// ends it whatever time it had left.
export function inviteValidText({ revoked_at, expires_at }: Pick<Invite, 'revoked_at' | 'expires_at'>, now: number = Date.now()): string {
  const at = (value: string): string => formatTime(value, new Date(now));
  if (revoked_at !== null) return `${at(revoked_at)} 已撤销`;
  return Date.parse(expires_at) > now ? `有效到 ${at(expires_at)}` : `${at(expires_at)} 已过期`;
}

// The materials it handed, in the words a machine it let in uses for its first ending: the
// same fact, so it is said one way.
export const inviteMaterialText = (material: Invite['material'], now: number = Date.now()): string => materialText(material, new Date(now));

// Whether revoking it would stop anything: it can still hand a material, or one it handed
// still works.
export const inviteRevocable = (invite: Invite, now: number = Date.now()): boolean =>
  invite.revoked_at === null && ((Date.parse(invite.expires_at) > now && invite.used < invite.max_machines) || invite.material.live > 0);
