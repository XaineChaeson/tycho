// The words the service and the console both say: state labels, action names and the
// lines built from them. One copy, so a notification and a page never disagree.
import { getActiveLocale, type Locale } from './i18n.ts';
import { NO_ROLE_LOST_TEXT } from './roles.ts';
import { formatTime } from './time.ts';
import { loginName, loginPage, parseLoginName } from './logins.ts';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

// An unfinished request lists these on WeCom too.
export const ACTION_TEXT: Record<string, string> = {
  'outbox.confirm_received': '主人确认通知已收到',
  'task.feedback': '记录任务反馈',
  'project.create': '创建项目',
  'project.update': '修改项目允许的登录',
  'project.rename': '项目改名',
  'project.pause': '暂停项目',
  'project.resume': '恢复项目',
  'project.archive': '归档项目',
  'project.unarchive': '恢复归档',
  'project.delete': '删除项目',
  'machine.create': '添加机器',
  'machine.update': '修改机器',
  'machine.delete': '删除机器',
  // A machine's own login of one executor: its tiers and limits, kept on the machine.
  'machine_login.create': '设置机器自己的登录',
  'machine_login.update': '修改机器自己的登录',
  'machine_login.delete': '删除机器自己的登录',
  // The ledger step that turned accounts with no login of their own into machines' own
  // logins: what it repointed, said on the Task and on the settings it touched.
  'login.migrate': '账号并成机器自己的登录',
  'login.signed_in_again': '机器报告重新登录了',
  'run.lost_without_role': '失联的一轮等任务选职能',
  'role.create': '添加职能',
  'role.update': '修改职能',
  'role.delete': '删除职能',
  // A machine that came back by itself: the owner lets it in from the console, and what it
  // was let in as is written down with it (docs/design/nodes.md §1.1).
  'machine.join': '放行新机器',
  'machine.join_rejected': '拒绝新机器',
  // The host's own user joining this host from this host: nobody is asked (§1.1 step 2).
  'machine.join_local': '本机接入，免放行',
  // A machine a task spawned (docs/design/nodes.md §1.3): the quota, the material handed to
  // a round, a machine coming in with one (nobody let it in), a machine reclaiming its own
  // registration, and the four endings.
  'machine.invite': '申请接入名额',
  'machine.invite_handed': '把接入材料交给一轮执行',
  'machine.invite_revoked': '撤销接入名额',
  'machine.join_spawned': '临时机器凭材料加入',
  'machine.join_reclaimed': '机器重新认领登记',
  'machine.drain': '机器停止接新活',
  'machine.evidence': '机器的证据已交付',
  'machine.leave': '机器自己注销',
  'machine.leave_destroyed': '实例已销毁，结束机器的登记',
  'machine.revoke': '撤销机器',
  'machine.destroyed': '报告实例已销毁',
  'task.create': '创建任务',
  'task.update': '修改任务',
  // The owner picked the machine of a folder source the migration could not name (§8.8): the
  // unfinished Tasks pinned to it take the machine in the same transaction.
  'task.source_machine': '确认代码来源的机器',
  'task.queue': '任务入队',
  'task.hold': '暂停任务',
  'task.resume': '继续任务',
  'task.continue': '执行中断后自动接续',
  'task.accept': '验收任务',
  'task.rework': '退回返工',
  'task.integrate': '并入主线',
  'release.launch': '上线',
  'task.abandon': '放弃任务',
  'task.schedule_wake': '预约任务',
  'ledger.restore': '从备份恢复',
  'ledger.restore_confirm': '确认恢复清点',
  'run.stopping': '中断执行',
  'run.residue_stuck': '报告清不掉的残留进程',
  // What a finished work left on disk, cleared once its retention period passed
  // (service/retention.ts): the host's registered copies, and the code on each machine.
  'run.releases_drop': '按保留期清理主机上的产物',
  'run.code_drop': '按保留期清理机器上的代码副本',
  'run.output_custody': '旧原始输出已确认处置',
  'run.output_retained': '旧原始输出继续保留',
  'approval.open': '发出问题',
  'input.add': '插话',
  'input.void': '作废插话',
  'decision.note': '记录裁定',
  'message.reply': '回复',
  // A project's triggers (docs/design/triggers.md §7).
  'trigger.create': '新建触发器',
  'trigger.update': '修改触发器',
  'trigger.enable': '启用触发器',
  'trigger.disable': '停用触发器',
  'trigger.delete': '删除触发器',
  // Tycho-wide inbound sources (§2.2, step 4).
  'inbound.create': '新建入站来源',
  'inbound.update': '修改入站来源',
  'inbound.enable': '启用入站来源',
  'inbound.disable': '停用入站来源',
  'inbound.delete': '删除入站来源',
  'inbound.key': '领取或更换入站来源的密钥',
  'inbound.migrate': '按项目的 Webhook 触发器换成入站来源',
  'front.current': '切换企微里的当前项目',
  'im.group_binding.create': '绑定群聊到项目',
  'im.group_binding.update': '修改群聊绑定',
  'im.group_binding.delete': '解绑群聊',
  'im.group_broadcast': '向绑定群播报',
  'setting.update': '修改设置',
  'console.device.approve': '放行新设备',
  'console.device.reject': '拒绝新设备',
};

export const LOGIN_METHOD_LABELS: Record<'link' | 'device' | 'wecom' | 'weixin' | 'passphrase', string> = {
  link: '登录链接',
  device: '控制台放行',
  wecom: '企业微信放行',
  weixin: '微信放行',
  passphrase: '主人口令',
};

// Who wrote a change, as the ledger names it. People on WeCom are their accounts there,
// which have no other name. No more imports happen, but old ledgers keep their rows.
const ACTOR_TEXT: Record<string, string> = {
  console: '由网页',
  router: '由负责人',
  'session-host': '由负责人会话',
  service: '由服务',
  runner: '由执行器',
  dispatcher: '由派发',
  timer: '由定时器',
  import: '导入旧配置时',
};

export const changedByText = (actor: string): string => `${ACTOR_TEXT[actor] ?? `由${actor}`}修改`;

export const restoreHeadline = (backupTime: string): string => `已从 ${backupTime} 的备份恢复，以下项目等你确认`;

export const taskStateLabels: Record<string, string> = {
  draft: '草稿', queued: '排队中', running: '执行中', stopping: '正在停止',
  ready: '待验收', done: '已完成', held: '已停住', waiting_person: '等你决定',
  waiting_timer: '等预约时间', needs_verification: '执行机器失联', abandoned: '已放弃',
};
export const taskStateLabelsEn: Record<string, string> = {
  draft: 'Draft', queued: 'Queued', running: 'Running', stopping: 'Stopping',
  ready: 'Ready for review', done: 'Done', held: 'Paused', waiting_person: 'Needs decision',
  waiting_timer: 'Scheduled', needs_verification: 'Machine offline', abandoned: 'Abandoned',
};
export const taskStateLabel = (state: string, locale: Locale = getActiveLocale()): string =>
  (locale === 'en' ? taskStateLabelsEn[state] : taskStateLabels[state]) ?? state;
// How a Run ended.
export const exitKindLabels: Record<string, string> = { completed: '完成', failed: '失败', interrupted: '已中断', lost: '执行丢失', quota: '额度用完', auth: '登录失效' };
export const exitKindLabelsEn: Record<string, string> = { completed: 'Completed', failed: 'Failed', interrupted: 'Interrupted', lost: 'Lost', quota: 'Quota exhausted', auth: 'Auth expired' };
export const exitKindLabel = (kind: string, locale: Locale = getActiveLocale()): string =>
  (locale === 'en' ? exitKindLabelsEn[kind] : exitKindLabels[kind]) ?? kind;
export const runStateLabels: Record<string, string> = { launching: '启动中', running: '执行中', stopping: '正在停止', unknown: '执行情况未知', ended: '已结束' };
export const runStateLabelsEn: Record<string, string> = { launching: 'Launching', running: 'Running', stopping: 'Stopping', unknown: 'Unknown', ended: 'Ended' };
export const runStateLabel = (state: string, locale: Locale = getActiveLocale()): string =>
  (locale === 'en' ? runStateLabelsEn[state] : runStateLabels[state]) ?? state;
// Which group of logins a Run was placed from (roles-and-tiers.md §11.3), in the owner's words.
export const placedByLabels: Record<string, string> = {
  prefer: '按负责人的优先', spread: '审阅分散', order: '按顺序', pinned: '指定登录', same_executor: '降级审阅（未换执行器）',
};
export const placedByLabelsEn: Record<string, string> = {
  prefer: 'Router preference', spread: 'Cross-executor review', order: 'Priority order', pinned: 'Pinned account', same_executor: 'Fallback review (same executor)',
};
export const placedByLabel = (by: string, locale: Locale = getActiveLocale()): string =>
  (locale === 'en' ? placedByLabelsEn[by] : placedByLabels[by]) ?? by;
export const tierDisplayLabel = (tierId: string, locale: Locale = getActiveLocale()): string => {
  if (locale === 'en') {
    if (tierId === 'operate') return 'Operate';
    if (tierId === 'execute') return 'Execute';
    if (tierId === 'decide') return 'Decide';
  }
  if (tierId === 'operate') return '操作档';
  if (tierId === 'execute') return '执行档';
  if (tierId === 'decide') return '决策档';
  return tierId;
};
export const taskDotClasses: Record<string, string> = {
  draft: 'running', queued: 'running', running: 'running', stopping: 'running', waiting_timer: 'running', needs_verification: 'running',
  ready: 'waiting', waiting_person: 'waiting', held: 'failed', done: 'finished', abandoned: 'finished',
};
export function displayStateText(text: string): string {
  return String(text).replace(/(任务(?:进入|转为)\s+|Run\s+)([a-z][a-z_]*)(?![\w.])/g,
    (_match, prefix: string, state: string) => prefix + (taskStateLabels[state] ?? runStateLabels[state] ?? state));
}
// The first line of an internal event is its sentence; the rest is the payload for the router.
export const eventHeadline = (text: string): string => displayStateText(String(text).split('\n')[0]!);

// A Run whose login the ledger never held, as after restoring a backup from before accounts
// were kept in it. Said in the same words wherever it shows.
export const missingLoginText = (name: string): string => `账本里没有${loginName(name)} 的配置：需要重新选择登录，同名新建的账号或机器登录不会接续这份引用`;
// A machine that answers and cannot tell what became of a round, in its own words. No time
// ends this wait: the machine being able to say again does, or it going away.
export const unverifiableText = (said: string): string => `机器在线，但核实不了这一轮，等它能核实：${said}`;

// A round whose registered product the retention rule cleared (service/retention.ts): said the
// same way on the task page and in every refusal that meets one.
// The period is not named: the setting may have changed since, and the change line keeps the one applied.
export function artifactsDroppedText({ at }: { at: string }, now: Date = new Date()): string {
  return `这一轮的产物已在 ${formatTime(at, now)} 按保留期清理（工作结束后过了保留期），要用就让任务重做一轮`;
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
  output_waiting?:string[];
}

const NO_MACHINE_TEXT = '等可用的机器';

// A Task whose code is a folder on one machine waits for that machine alone
// (docs/design/code-sources.md §2).
export const sourceOfflineText = (machine: string): string => `等 ${machine} 上线`;

// A machine whose client is older than this host: the round would start in the wrong place,
// so none is sent until the client is upgraded.
export const outdatedClientText = (machines: readonly string[]): string =>
  `等把${machines.length === 1 ? '机器' : ''} ${machines.join('、')} 上的 tycho 升级到与主机同一版`;

// What a refused login waits for, by where it comes from: an account for the owner to sign
// it in again or give it a new key (ACCOUNT_LOGIN_FIX), a machine's own login for its machine
// to say it is signed in again.
function refusedLines(ids: readonly string[]): string[] {
  const accounts = ids.filter((id) => parseLoginName(id).kind === 'account');
  const own = ids.filter((id) => parseLoginName(id).kind === 'machine');
  return [
    ...(accounts.length ? [`${accounts.map(loginName).join('、')}：登录失效，${ACCOUNT_LOGIN_FIX}`] : []),
    ...(own.length ? [`${own.map(loginName).join('、')}：登录失效，等那台机器重新登录`] : []),
  ];
}

// The owner told once that a machine's own login was refused: where to put it right.
export const machineLoginRefusedText = (loginId: string): string =>
  `${loginName(loginId)} 登录失效了：到那台机器上重新登录这个执行器。机器报告已登录后自动接着派`;

// What such a Task waits for, and about when. The time is the earliest any resting
// login comes back, not a promise that the Task starts then.
export function waitLine(wait: Wait | null | undefined, now: number = Date.now()): string | null {
  if (!wait) return null;
  const parts = [
    wait.no_candidate ? '没有符合任务条件的登录，请检查项目允许的登录和账号档位' : null,
    wait.source_offline ? sourceOfflineText(wait.source_offline) : null,
    wait.outdated?.length ? outdatedClientText(wait.outdated) : null,
    wait.output_waiting?.length ? `等 ${wait.output_waiting.join('、')} 提供可用的待传输出容量；到机器页检查版本、存储状态和占用` : null,
    wait.full.length ? `等 ${wait.full.map(loginName).join('、')} 空出来` : null,
    wait.rest ? `等额度恢复，约 ${formatTime(wait.rest.until, new Date(now))}` : null,
    wait.no_machine.length ? NO_MACHINE_TEXT : null,
    wait.missing_credentials?.length ? `${wait.missing_credentials.map(loginName).join('、')}：凭据缺失，${ACCOUNT_LOGIN_FIX}` : null,
    ...refusedLines(wait.rejected ?? []),
  ].filter(Boolean);
  return parts.length ? parts.join('；或') : null;
}

// A project the owner paused (docs/design/project-sessions.md §5): the console, the server and
// WeCom say it the same way.
export const PROJECT_PAUSED_LABEL = '已暂停';
export const PROJECT_PAUSED_TEXT = '项目已暂停';
export const PROJECT_PAUSED_NOTE = '这个项目已暂停：负责人不接新消息，也不派新任务；在跑的那一轮会做完。消息照常记下，恢复后接着处理。';

// A project the owner put away (project-sessions, "项目的生命周期"). It holds back what a
// pause holds back, and says so in its own words.
export const PROJECT_ARCHIVED_LABEL = '已归档';
export const PROJECT_ARCHIVED_TEXT = '项目已归档';
// Says the same as the console's empty list when every project is put away: what WeCom's
// 项目 and 进入 answer is not that there are none.
export const PROJECT_ARCHIVED_NOTE = '这个项目已归档：负责人不接新消息，也不派新任务；在跑的那一轮会做完。消息照常记下，恢复后接着处理。';
export const ALL_PROJECTS_ARCHIVED_TEXT = '项目都归档了：到控制台恢复一个，或者新建一个';

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

const CONTINUATION_BLOCKS: Record<string, string> = {
  paused: '派发已暂停，恢复派发后接续',
  project_paused: `${PROJECT_PAUSED_TEXT}，恢复后接续`,
  project_archived: `${PROJECT_ARCHIVED_TEXT}，恢复后接续`,
  recovering: '恢复清点中',
  no_role: NO_ROLE_LOST_TEXT,
  no_machine: NO_MACHINE_TEXT,
  limit: '已到连续丢失上限',
};

// A machine out of contact asks nothing of the owner, so the line says what the rules
// do next and what they wait for: `lost` is the server's reading of the Run nobody can
// speak for. The time is when the Task may go on, not a promise that it will by then:
// past it, the line names what still stands in the way. A stop needs no machine and no
// dispatch, so it only waits for the time.
export function lostLine(lost: Lost | null | undefined, now: number = Date.now()): string | null {
  if (!lost?.eligible_at) return null;
  const time = formatTime(lost.eligible_at, new Date(now));
  if (lost.stopping) return `${time} 后按已中断结算`;
  if (Date.parse(lost.eligible_at) > now) return `${time} 后可自动接续`;
  if (lost.blocked === 'no_machine' && lost.waiting) return waitLine(lost.waiting, now) ?? NO_MACHINE_TEXT;
  return (lost.blocked && CONTINUATION_BLOCKS[lost.blocked]) ?? '等待接续';
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
  return detail ? `${label}：${detail}` : label;
}

// What a Worker's receipt says of its round, and the words a page shows for it. Declared
// once: the brief lists the same ids, and the ledger settles by them.
export const RECEIPT_STATUS_LABELS = { done: '已完成', failed: '失败', waiting: '等待后续安排' } as const;
export type ReceiptStatus = keyof typeof RECEIPT_STATUS_LABELS;
export const RECEIPT_STATUSES = Object.keys(RECEIPT_STATUS_LABELS) as ReceiptStatus[];

// The groups a piece of work falls in, in the order the pages show them. Declared once: the
// sidebar lists them, and the service counts a project's work by them.
export const WORK_GROUPS = { waiting: '等你', moving: '在推进', ready: '待验收', ended: '最近结束' } as const;
export type WorkGroup = (typeof WORK_GROUPS)[keyof typeof WORK_GROUPS];
export const WORK_GROUP_ORDER: readonly WorkGroup[] = [WORK_GROUPS.waiting, WORK_GROUPS.moving, WORK_GROUPS.ready, WORK_GROUPS.ended];
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
  if (!run) return '尚未执行';
  if (run.ended_at) return formatTime(run.ended_at);
  if (run.state === 'unknown') return runStateLabels.unknown!;
  return `进行中 ${Math.max(0, Math.floor((now - Date.parse(run.started_at ?? run.created_at)) / 60_000))} 分钟`;
}

export const loginLine = (parts: readonly (string | null | undefined)[]): string => parts.filter(Boolean).join(' · ') || '未指定';

// What the host knows of an account credential: present, rejected, or missing from disk.
export type CredentialState = 'set' | 'rejected' | 'missing';
// What the owner does about an account whose executor refused its login: nothing is typed
// into a page for a login made on the executor's own page, so the one sentence covers both.
export const ACCOUNT_LOGIN_FIX = '要到账号页重新登录或换密钥';
// An account's kept login as its card says it, by how it was obtained: a login made on the
// executor's own page is signed in to again there and is never typed (`signedIn`); a secret
// the owner typed — an API key, a line's key — is replaced by typing a new one (`typed`).
export const credentialText = {
  signedIn: { label: '登录', states: { set: '已登录', rejected: '已失效，要重新登录', missing: '登录凭据缺失，要重新登录' } as Record<CredentialState, string> },
  typed: {
    label: 'API 密钥',
    help: '只进不出：保存后页面上不再显示。每一轮只交给那一轮的进程，机器上不留。',
    change: '更换 API 密钥',
    save: '保存密钥', saving: '保存密钥中',
    states: { set: '已设置', rejected: '已失效，要重新填', missing: '密钥缺失，要重新填' } as Record<CredentialState, string>,
  },
};

// A Task that names no login: the service picks one of the project's at each round.
export const ANY_LOGIN_TEXT = '不指定，由服务挑';

// A tier's form: what the owner fills, and the raw text only for what the form cannot hold.
// The values it edits are the executor's own; which of them there are comes from the
// executor's declaration, and so do the strengths it offers. Which tiers there are is not
// the executor's to decide: it is the names in shared/tiers.ts, and an account either
// holds one or is left blank for it.
export const tierText = {
  legend: '档位',
  note: '不接哪一档就留空；只改模型和推理强度不会动到高级设置。',
  model: '模型',
  effort: '推理强度',
  provider: '服务方',
  effortAny: '不指定',

  advanced: '高级',
  advancedNote: (count: number): string => `还有 ${count} 项高级设置`,
  unreadable: '这一段现在读不出来：在“高级”里按执行器自己的写法改，或者把这一行删掉',
  // An account that does not take this tier: said on the row itself.
  blank: '留空表示这个账号不接这一档的活',
  blankHeld: '不改这台机器上执行器自己的配置',
  // The operate tier is the one tier a login need not fill: its work runs on the login's
  // execute content when it holds none (roles-and-tiers.md §10.3).
  blankOperate: '留空就用执行档的内容',
  // A tier name the system no longer uses, kept from an older layout
  // (docs/design/roles-and-tiers.md §8): what the row is called, and the action that
  // settles it. A name mapped to a row that already holds something says so first.
  stale: '系统不再用这个名字',
  staleNote: '保存前要把它改成其中一个档位，或者删掉这一行',
  moveTo: (label: string): string => `改成${label}`,
  remove: '删掉这一行',
  overwrite: (label: string): string => `${label}已经有内容：再点一次就把它换成这一行的内容`,
};

// A tier's model and strength, and what the account's executor reported about them. A model
// outside that list is not an error: an alias the executor still accepts is the owner's own
// choice, so it stays as it was written and can be typed by hand.
export const modelText = {
  label: '模型',
  notRead: '还没读到',
  ask: '点“测试连接”去问一次',
  refreshing: '正在查询…',
  count: (count: number): string => `${count} 个，`,
  readAt: (at: string): string => `最后读到 ${at}`,
  hidden: (count: number): string => `另有 ${count} 个执行器自己藏起来的`,
  missing: '这个模型不在执行器报告的列表里：可能它已经不提供了，也可能是一个执行器仍接受的别名。要换就从下面选一个，不换就照原样留着。',
  pick: '从列表里选一个',
  handWritten: '不在列表里',
  // The way out of the list, for a model it does not hold: an alias, or one not reported yet.
  typeByHand: '手填模型名…',
  none: '留空',
  defaultEffort: (effort: string): string => `不指定（默认 ${effort}）`,
  goneFromList: '它不在这个模型的列表里：留着照原样用',
  queryFailed: (reason: string): string => `模型列表没读到：${reason}。还用上次读到的`,
  // A machine's own login: its list is what that machine reports of its executor, and these
  // are why the machine has none to show. What the machine itself said went wrong is its words.
  machineOffline: '机器不在线，读不到它的执行器能用哪些模型',
  machineSilent: '这台机器没有报告可用模型：机器上的 tycho 客户端可能还是旧版，升级并重启它之后再看',
  machineNoExecutor: '这台机器还没有报告这个执行器',
  machineNotInstalled: '这台机器上没有装这个执行器',
  listMissing: (reason: string): string => `可选模型没读到：${reason}。可以先手填模型名。`,
};

// A model an account's executor reports that the list did not have, and one a tier uses
// that it no longer reports. Said once per account and model; neither switches anything by
// itself, because which model a tier runs on is the owner's decision.
export const modelsAddedText = (login: string, model: string): string =>
  `${loginName(login)} 的执行器多了一个模型：${model}。要用它，到“${loginPage(login).name}”页里把这个档位的模型改过去；tycho 不会替你换。`;
export const modelsGoneText = (login: string, model: string): string =>
  `${loginName(login)} 的档位在用的模型 ${model} 已经不在执行器报告的列表里了。这个档位要换一个模型才能接着用，到“${loginPage(login).name}”页里改；tycho 不会替你换。`;

// A figure an executor gave for one quota window of its account, and when it last said so.
interface UsageFigure { window: string; used: number; resets_at: string | null; at: string }

// Adapters normalize executor window names; unfamiliar identifiers remain visible.
const WINDOW_TEXT: Record<string, string> = {
  five_hour: '5 小时窗口',
  seven_day: '7 天窗口',
  five_hour_3p: '5 小时窗口（Claude/GPT）',
  seven_day_3p: '7 天窗口（Claude/GPT）',
  seven_day_fable: '7 天窗口（Fable）',
  overage: '额外用量',
};

// Format special balance/budget quota windows emitted by DeepSeek / New-API / One-API gateways.
export function formatSpecialQuotaWindow(window: string, used: number): string | null {
  for (const [prefix, title] of [
    ['balance:', '官网余额'],
    ['bonus_balance:', '官网赠金'],
    ['api_balance:', 'API 余额'],
  ] as const) {
    if (window.startsWith(prefix)) {
      const parts = window.split(':');
      if (parts.length >= 3) {
        const currency = parts[1]!;
        const amount = parts.slice(2).join(':');
        const symbol = currency === 'CNY' ? '¥' : currency === 'USD' ? '$' : `${currency} `;
        return `${title} ${symbol}${amount}`;
      }
      return `${title}可用`;
    }
  }
  if (window.startsWith('gateway_unlimited:')) {
    const rest = window.slice('gateway_unlimited:'.length);
    const sep = rest.indexOf(':');
    if (sep > 0) {
      const route = rest.slice(0, sep);
      const spent = rest.slice(sep + 1);
      return `网关 ${route} 无限额 · 近 30 天已用 ${spent}`;
    }
    return `网关无限额 · 近 30 天已用 ${rest}`;
  }
  if (window.startsWith('gateway_budget:')) {
    const rest = window.slice('gateway_budget:'.length);
    const sep = rest.indexOf(':');
    const pct = `${Math.round(used * 100)}%`;
    if (sep > 0 && !rest.startsWith('$')) {
      const route = rest.slice(0, sep);
      const budget = rest.slice(sep + 1);
      return `网关 ${route} 剩 ${budget}（已用 ${pct}）`;
    }
    return `网关余额 ${rest}（已用 ${pct}）`;
  }
  return null;
}

export function usageLine({ window, used, resets_at: resets }: UsageFigure, now: number = Date.now()): string {
  const special = formatSpecialQuotaWindow(window, used);
  if (special !== null) return special;
  const label = Object.hasOwn(WINDOW_TEXT, window) ? WINDOW_TEXT[window]
    : window.startsWith('seven_day_') && window.length > 'seven_day_'.length ? `7 天窗口（${window.slice('seven_day_'.length)}）` : window;
  return `${label} ${Math.round(used * 100)}%${resets ? `，${formatTime(resets, new Date(now))} 重置` : ''}`;
}

// How old the figures are: what was spent since, in tycho or elsewhere, is not in them. Said
// with the oldest moment, never shown as this moment's. Undefined when there are none.
export function usageReadLine(usage: readonly UsageFigure[], now: number = Date.now()): string | undefined {
  const oldest = usage.map(({ at }) => at).sort()[0];
  return oldest === undefined ? undefined : `读于 ${formatTime(oldest, new Date(now))}`;
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
export const NEEDS_LOGIN_TEXT = '需要重新登录';

// Whether a login can be given work now, and when not, why and until when.
export function loginStatusLine(status: LoginStatus, now: number = Date.now()): string {
  // A refused credential is the owner's to fix: never "可用" while it stands.
  if (status.rejected) return NEEDS_LOGIN_TEXT;
  if (status.rest) return `歇着：额度用完，约 ${formatTime(status.rest.until, new Date(now))} 再试`;
  // A read that found the general window full, without a Run having rested it yet.
  if (quotaUsedUp(status.usage)) return '额度已用完，等窗口重置';
  if (loginFull(status)) return `已到并发上限：在跑 ${status.active_runs} 轮，最多 ${status.max_runs} 轮`;
  return status.active_runs ? `可用，在跑 ${status.active_runs} 轮` : '可用';
}

// How a Run the quota cut short reads on its Task's page: where it ran, until when that
// account rests, and that nothing is asked of the owner.
export function quotaEndLine(quota: { login_id?: string | null; login_name?: string | null; account_id?: string; target_id?: string; rest_until?: string | null } | null | undefined, now: number = Date.now()): string {
  if (!quota) return '执行器的额度用完，任务已回到队列，自动接续';
  const rest = quota.rest_until ? `，它歇到 ${formatTime(quota.rest_until, new Date(now))}` : '';
  return `${loginName(quota.login_name ?? quota.login_id ?? quota.account_id ?? quota.target_id ?? '')} 的额度用完${rest}。任务已回到队列：额度恢复后，或换到项目里别的登录上，自动接续`;
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
const RESTART_WAITS: Record<string, string> = {
  degraded: '已受理重启负责人：等账本恢复写入后启动',
  recovering: '已受理重启负责人：等恢复清点结束后启动',
};

// A restart asked for waits for the turn under way; until that ends it has not begun.
const restartLine = ({ turn, waiting }: RouterState): string => (waiting && RESTART_WAITS[waiting])
  || (turn ? '负责人会在当前这一回合结束后重启，想快一点就到对话里点“打断”' : '负责人正在重启');

// A restart comes before why the Router is stopped: that reason is about to be tried again.
export function routerLine(router: RouterState): string {
  if (router.restarting) return restartLine(router);
  if (router.error) return `负责人已停摆：${router.error}`;
  const failed = projectRouterErrors(router);
  if (failed.length > 0) {
    return failed.length === 1
      ? `项目负责人已停摆：${failed[0]!.error}`
      : `${failed.length} 个项目的负责人已停摆：${failed[0]!.error}`;
  }
  return router.alive ? '负责人在运行' : '负责人现在没有在运行，有消息来时会自动启动';
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
  if (dispatch.degraded) notes.push({ text: '账本写入失败，派发已停止' });
  if (dispatch.recovering) notes.push({ text: '正在恢复清点，暂不派发、不处理消息、不发通知' });
  if (dispatch.paused) notes.push({ text: '派发已暂停' });
  if (router.error) {
    notes.push({ text: `负责人已停摆：${router.error}`, href: '#/settings/router.cli', label: '去设置' });
  } else {
    const failed = projectRouterErrors(router);
    if (failed.length > 0) {
      notes.push({
        text: failed.length === 1
          ? `项目负责人已停摆：${failed[0]!.error}`
          : `${failed.length} 个项目的负责人已停摆：${failed[0]!.error}`,
        href: `#/projects/${encodeURIComponent(failed[0]!.project_id)}/settings`,
        label: '去检查',
      });
    }
  }
  if (router.restarting) notes.push({ text: restartLine(router) });
  if (channels?.wecom?.error) notes.push({ text: `企微已停止：${channels.wecom.error}` });
  return notes;
}

export interface GatewayNote extends BannerNote { failed: boolean }

// What the service says of its connection to the gateway; null when it has none to speak
// of. `error` is ssh's own words, which run over several lines.
export function gatewayNote(
  { state, since, error }: { state: string; since: string | null; error: string | null },
  now: number = Date.now(),
): GatewayNote | null {
  const said = (error ?? '').trim().replace(/\s*\n\s*/g, '；');
  if (state === 'connecting') return { text: `门牌：连接中${said && `，上一次没连上：${said}`}`, failed: false };
  if (state === 'connected') return { text: `门牌：已连接${since ? `（${formatTime(since, new Date(now))} 起）` : ''}`, failed: false };
  if (state === 'down') return { text: `门牌：连不上，正在重试${said && `：${said}`}`, failed: true, href: '#/settings/gateway.ssh', label: '去设置' };
  return null;
}

export const deviceLoginMissingText = '没有这个号码，或者它已经过期';
export function loginDurationText(milliseconds: number): string {
  const days = milliseconds / 86_400_000;
  return Number.isInteger(days) ? days + ' 天' : milliseconds / 3_600_000 + ' 小时';
}

// A machine's join, answered from the console's one entry or from a card on the phone
// (docs/design/nodes.md §1.1 step 2): the same words wherever it was answered.
export const joinDecisionText = (approve: boolean, name: string): string => approve
  ? `已放行 ${name}，它连回来后会出现在“机器”页的列表里`
  : `已拒绝 ${name}，那台机器上的加入命令已经退出`;
export const joinMissingText = '这台机器的加入请求已经过期或已经处理过；要接它进来，在那台机器上重新运行加入命令';
export const joinExpiredText = '这个请求已经过期；要接这台机器进来，在那台机器上重新运行加入命令';
export const joinHandledText = '这个请求已经处理过了';

export const deviceLoginDecisionText = (approve: boolean, device: string, durationMs?: number): string =>
  `${approve ? '已放行' : '已拒绝'}：${device}${approve && durationMs !== undefined ? '，保持 ' + loginDurationText(durationMs) : ''}`;

export function incompleteReleaseLine(version: string, pending: readonly string[]): string {
  return `tycho ${version} 版本已在跑、核对没做完：${pending.join('；')}`;
}

// --- machines a task spawned (docs/design/nodes.md §1.3) ------------------------------

// Where a machine came from: the owner let it in, or a round of a task spawned it.
export interface MachineSourceView { task_id: string; run_id: string; round: number }
export const machineSourceText = (source: MachineSourceView | null | undefined): string =>
  source == null ? '手动加入' : `由任务 ${source.task_id} 第 ${source.round} 轮派生`;

// What a spawned machine's quota allows it, in one line.
export const machineScopeText = (scope: { project_id: string; executors: string[] | null } | null | undefined): string | null =>
  scope == null ? null : `只接项目 ${scope.project_id} 的活${scope.executors === null ? '' : `，只用 ${scope.executors.join('、')}`}`;

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

const MATERIAL_ENDED: Record<'used' | 'expired' | 'revoked', string> = { used: '名额用完', expired: '过期', revoked: '名额被撤销' };
const LEFT_TEXT: Record<'leave' | 'revoked' | 'destroyed', string> = { leave: '机器自己注销', revoked: '被撤销', destroyed: '实例销毁后结束' };

// Whether a quota's materials could still let a machine in: said the same on the quota and
// on each machine that came in under it. None live and no ending: no round has been handed
// one yet, which is not a material that lapsed.
const neverHanded = (material: MachineEnds['material']): boolean => material.live === 0 && material.ended_at === null;
export function materialText(material: MachineEnds['material'], now: Date = new Date()): string {
  if (material.live > 0) return `还有 ${material.live} 份有效，到 ${formatTime(material.live_until, now)}`;
  return neverHanded(material) ? '还没有发过材料' : `已失效（${MATERIAL_ENDED[material.ended_why ?? 'expired']}，${formatTime(material.ended_at, now)}）`;
}

function evidenceText(ends: MachineEnds, at: (value: string | null) => string): string {
  if (ends.evidence_at !== null) return `${at(ends.evidence_at)} 确认全部交回`;
  if (ends.lost_rounds > 0) return `有${ends.lost_rounds === 1 ? '一' : ` ${ends.lost_rounds} `}轮按失联结束，结果没交回`;
  return '还没确认全部交回';
}

// One line per fact, in the order they normally come. A fact not reached says so in its own
// words: in particular an ended registration is never read as a released instance — only a
// report from the skill that made it says that.
export function machineEndLines(ends: MachineEnds, now: Date = new Date()): MachineEndLine[] {
  const at = (value: string | null): string => formatTime(value, now);
  const { material } = ends;
  return [
    { key: 'material', label: '接入材料', done: material.live === 0 && !neverHanded(material), text: materialText(material, now) },
    { key: 'drain', label: '接新活', done: ends.drain_at !== null, text: ends.drain_at === null ? '还在接' : `${at(ends.drain_at)} 起不再接` },
    { key: 'evidence', label: '结果和日志', done: ends.evidence_at !== null, text: evidenceText(ends, at) },
    {
      key: 'left', label: '登记', done: ends.left_at !== null,
      text: ends.left_at === null ? '还在登记里' : `${at(ends.left_at)} 结束（${LEFT_TEXT[ends.left_reason ?? 'leave']}）`,
    },
    {
      key: 'destroyed', label: '实例', done: ends.destroyed_at !== null,
      text: ends.destroyed_at === null ? '实例销毁未确认' : `${at(ends.destroyed_at)} 由执行 ${ends.destroyed_by ?? '—'} 报告已销毁`,
    },
  ];
}

// What a machine's client says about the version it runs against the host's (nodes.md §1.4).
// The host's own version and the machine's report are the whole of it: a client that never
// reported is an old one, not a machine with nothing to say. A machine behind the host says
// what it is doing about it, and a failure says how long ago it was reported.
export function nodeReleaseText(held: { version: string; at: string; upgrade: { state: 'waiting' | 'failed'; target: string; detail: string } | null } | null | undefined, hostVersion: string | null | undefined, now: number = Date.now()): string {
  if (!held) return '没报版本（客户端太旧，重启一次它就会跟上）';
  if (hostVersion == null || held.version === hostVersion) return `tycho ${held.version}`;
  const behind = `tycho ${held.version}，主机 ${hostVersion}`;
  if (held.upgrade === null) return behind;
  if (held.upgrade.state === 'waiting') return `${behind}，${held.upgrade.detail}`;
  return `${behind}，换版没成功：${held.upgrade.detail}（${agoText(held.at, now)}）`;
}

// How long ago something was said. A moment that cannot be measured — unreadable, or ahead
// of this host's clock — is said as such instead of being counted as just now.
export function agoText(at: string, now: number = Date.now()): string {
  const ago = now - Date.parse(at);
  if (!Number.isFinite(ago) || ago < 0) return '不知道是什么时候';
  if (ago < MINUTE_MS) return '刚刚';
  if (ago < HOUR_MS) return `${Math.floor(ago / MINUTE_MS)} 分钟前`;
  if (ago < DAY_MS) return `${Math.floor(ago / HOUR_MS)} 小时前`;
  return `${Math.floor(ago / DAY_MS)} 天前`;
}

// What every WeCom message starts with (docs/design/project-sessions.md §2): the project it is
// about, or 【系统】 for what belongs to none.
export const projectMark = (name: string | null): string => `【${name ?? '系统'}】`;

// Why the front desk put a message to the owner instead of placing it (§2).
export const CANDIDATE_REASON_TEXT: Record<string, string> = {
  none: '这个聊天还没有当前项目',
  conflict: '你写的项目和提到的任务不在同一个项目',
  objects: '提到的任务分属几个项目',
  name: '有几个项目叫这个名字',
};
