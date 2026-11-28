import { createHash } from 'node:crypto';
import type { Login, LoginStore } from '../runner/snapshot.ts';
import { formatTaskProjectFilesScope, inRange } from '../runner/snapshot.ts';
import { ulid } from './ids.ts';
import {
  isPreviewableArtifactMime,
  isProjectFileKind,
  isTextFileMime,
  normalizeProjectFileMime,
  normalizeProjectFileName,
  PROJECT_FILE_KINDS,
  readProjectFileBytes,
  removeProjectFileBytes,
  toProjectFileSummary,
  writeProjectFileBytes,
  type ProjectFileKind,
} from './project-files.ts';
import type { Runner } from '../runner/runner.ts';
import { loginStatusLine, machineEndLines, machineScopeText, machineSourceText, nodeReleaseText } from '../shared/labels.ts';
import { loginName } from '../shared/logins.ts';
import { TIERS, TIER_IDS, tierLabel, tierValueFrom } from '../shared/tiers.ts';
import { deliverableLabel, OLD_NO_ROLE_TEXT, permissionLabel, TIER_SOURCE_TEXT } from '../shared/roles.ts';
import { VERDICT_LABELS, type VerdictRecord } from '../shared/review.ts';
import { parseReviewOf } from './review.ts';
import { JOIN_MATERIALS_ENV, HOST_URL_ENV } from '../shared/node-protocol.ts';
import type { NodeReleaseHeld } from '../shared/node-protocol.ts';
import type { Acceptor } from './accept.ts';
import type { TaskOperation } from './router-calls.ts';
import { redactWorkerDiagnosticText } from './router-call-text.ts';
import { createLandingTask } from './land.ts';
import { isPackageName, type ReleaseFile } from './releases.ts';
import { GRANT_IDS, GRANTS, grantsOf } from '../shared/grants.ts';
import { loginStatus } from './accounts.ts';
import { ConfirmationRequired, DegradedError, InputError } from './errors.ts';
import type { Ctx, Ledger, RunRow, TaskRow, TaskState } from './ledger.ts';
import type { TriggerView } from './triggers.ts';
import { INTERNAL_EVENT_KINDS, INTERNAL_EVENT_LABELS, INTERNAL_EVENT_WHEN } from '../shared/internal-events.ts';
import { TRIGGER_SOURCES } from '../shared/triggers.ts';
import { machineEnds } from './ledger.ts';
import { isDirectorySkillId } from '../shared/skill-catalog.ts';
import type { Machines } from './machines.ts';
import type { Nodes } from './nodes.ts';
import { candidateLogins } from './pick.ts';
import type { Reported } from './readonly.ts';
import { KNOWLEDGE_KINDS } from '../shared/knowledge.ts';
import { parseWikiCitation } from '../shared/wiki.ts';
import { parseTaskPrefer } from '../shared/tasks.ts';
import { createLibrary, PROPOSE_DESCRIPTION } from './library.ts';
import { historyEvidenceInputSchema } from './history-evidence.ts';
import { OPEN_REQUESTS_PAGE, requestView } from './router-material.ts';
import { readRunReport, reportFilesOf } from './reports.ts';
import { runErrorView } from './run-view.ts';
import { described, json, object, problem, STRING, type Args, type Schema, type ToolResult } from './tool-schema.ts';
import type { SourceView, TaskSource } from '../shared/sources.ts';
import { parseGitHubRepo, type GitHubService } from './github.ts';
import { IM_CHANNELS, type ImChannel } from '../shared/im.ts';

export type { ToolResult } from './tool-schema.ts';

// The project a call was bound to (project-sessions §4): by the service, from the process that
// made it, never from anything the model sends.
interface Scope {
  projectId: string;
}

// A Router's tool: its arguments may depend on the project, as a login's choices do.
interface RouterTool {
  name: string;
  description: string;
  inputSchema: Schema | ((here: Scope) => Schema);
  priorResult?(args: unknown, ctx: Ctx, here: Scope): string | undefined;
  run(args: Args, ctx: Ctx, here: Scope): string | Promise<string>;
}

// The `source` argument create_task and update_task take (docs/design/code-sources.md §3): the
// id of one of this project's sources, from get_project's list. Absent: the default, the first.
// A adds it to both schemas and their runs, checks the id against the project's list, and pins
// the Task to that item as it stands then; an update may move the pin.
export interface TaskSourceArgument {
  source?: string | null;
}

// The part of get_project's answer that tells the Router where the project's code can come from
// and what is already running where (docs/design/code-sources.md §3). Every source in the
// project's order, its default marked and labelled (shared/sources.ts SourceView), and for each
// source id the Tasks that have a live Run on it — the fact the Router arranges concurrency by.
// A renders it; D shows the same list on the project page, which is the only place it is edited.
export interface ProjectSourcesView {
  sources: SourceView[];
  running_by_source: Record<string, string[]>;
}


interface ToolOptions {
  readReport?: (run: RunRow, ref: string, range?: { offset?: number; limit?: number }) => ReturnType<typeof readRunReport>;
  ledger: Ledger;
  dataDir?: string;
  github?: Pick<GitHubService, 'listPullRequests' | 'getPullRequest'>;
  runner: Pick<Runner, 'interrupt' | 'events' | 'abandon'>;
  // Every login a round can run as: the accounts and the machines' own logins.
  logins: LoginStore;
  // The machines there are, for list_machines.
  machines: Pick<Machines, 'list'>;
  // What a machine last reported about one of its executors, for list_logins: whether a
  // machine's own login is signed in there now. Absent: nothing reported.
  reported?: Reported;
  // Accepting a Task, which is also when its Run's artifacts come back: one implementation
  // for this entrance and the page's, so a release is never made of half an acceptance.
  accept: Acceptor;
  // Putting a package in place: the console's own entry, which the Router reaches only for
  // what its project grants.
  release?: (runId: string, chosen: ReleaseFile, ctx: Ctx) => { started: boolean; version: string };
  // Whether a machine is connected now, for list_machines. Absent: not known.
  nodes?: Pick<Nodes, 'connected'>;
  // What a machine last said about the version it runs, and this host's own version, for
  // list_machines (docs/design/nodes.md §1.4). Absent in a test that does not ask about it.
  nodeRelease?: { host: string; reported: (machineId: string) => NodeReleaseHeld | null };
  serviceManager?: (machineId: string) => import('../shared/service-manager.ts').ServiceManagerReport | null;
  localSkills?: (machineId: string) => import('../shared/node-protocol.ts').NodeLocalSkillSummary[] | null | undefined;
  // What the owner's settings allow a quota for spawned machines to be (nodes.md §1.3),
  // read at each call: the most machines one may register, its default span and its longest,
  // and how long a material lasts.
  inviteLimits?: () => { maxMachines: number; ttlMs: number; maxTtlMs: number; materialTtlMs: number };
  // The executors the Router can be running on: what a knowledge gate of its proposals may not
  // run on (docs/design/knowledge-and-skills.md §3). Prefer `routerExecutorsFor(projectId)` so
  // only the actual executor backing that project's Router is excluded instead of every adapter
  // capable of routing.
  routerExecutors?: string[];
  routerExecutorsFor?: (projectId: string) => string[];
}

const DEFAULT_LOG_TAIL = 50;
const DEFAULT_READ_FILE_CHARS = 32_000;
const MAX_READ_FILE_CHARS = 65_536;
const MAX_ROUTER_WRITE_BYTES = 2 * 1024 * 1024;
const TASK_PROJECT_FILES_LIMIT = 20;
const TASK_PROJECT_FILES_BYTES_LIMIT = 10 * 1024 * 1024;
// list_tasks: one page, and what the Router reads without noticing more than this.
const LIST_TASKS_LIMIT = 50;
const LIST_TASKS_MAX = 200;
const TASK_STATES: TaskState[] = [
  'draft',
  'queued',
  'running',
  'stopping',
  'ready',
  'done',
  'held',
  'waiting_person',
  'waiting_timer',
  'needs_verification',
  'abandoned',
];

const QUESTION: Schema = {
  type: 'object',
  properties: { question: STRING, options: { type: 'array', items: STRING }, recommend: { type: 'integer' } },
  required: ['question'],
  additionalProperties: false,
};



// A trigger's time rule as the Router writes it; scheduleOf turns it into the ledger's.
const SCHEDULE: Schema = {
  ...object({
    kind: { type: 'string', enum: ['once', 'every', 'cron'], description: 'once 一次、every 固定间隔、cron' },
    at: described('once：带时区的时刻，ISO 8601'),
    every_minutes: { type: 'integer', description: 'every：隔多少分钟' },
    start_at: described('every：从哪个时刻起算（带时区），不填从现在起'),
    cron: described('cron：五个字段，分 时 日 月 星期，例如 0 8 * * 1-5'),
    zone: described('cron：IANA 时区，例如 Asia/Shanghai；不填用主机的时区'),
  }, ['kind']),
  description: '什么时候触发',
};
// What an internal-event trigger subscribes to (docs/design/triggers.md §2.3), from the one declaration.
const EVENT: Schema = {
  ...object({
    kind: { type: 'string', enum: [...INTERNAL_EVENT_KINDS], description: INTERNAL_EVENT_KINDS.map((kind) => `${kind}：${INTERNAL_EVENT_WHEN[kind]}`).join('；') },
    task_id: described('只看这个任务和它下面的任务；不填看本项目的全部任务'),
  }, ['kind']),
  description: '订阅哪种内部事件',
};
const MISSED: Schema = { type: 'string', enum: ['latest', 'skip'], description: '服务停着时错过的时刻：latest 补最近一次（默认），skip 跳过' };
const EXPIRES = described('截止时间，带时区；过了只记“过期”，不再投消息');
const PUSH_FINAL: Schema = { type: 'boolean', description: '处理完这条触发消息后，把你这一回合的最终回复推给主人' };
const RECENT_FIRES = 20;

function scheduleOf(given: Args): Record<string, unknown> {
  switch (given.kind) {
    case 'once':
      return { kind: 'once', at: given.at };
    case 'every':
      return { kind: 'every', every_ms: typeof given.every_minutes === 'number' ? given.every_minutes * 60_000 : undefined, anchor: given.start_at ?? new Date().toISOString() };
    default:
      return { kind: 'cron', expr: given.cron, zone: given.zone };
  }
}

function parsed(text: string | null): unknown {
  return text === null ? null : JSON.parse(text);
}

// What a Task is and what it runs on: its role by id and name, the tier it runs on now, and
// whether that is the role's default, an override, a review following its product, or an
// escalation — with its reason where it has one.
function roleFields(ledger: Pick<Ledger, 'getRole'>, { role_id, tier, tier_source, tier_reason }: TaskRow) {
  const role = role_id === null ? undefined : ledger.getRole(role_id);
  return {
    role_id,
    role: role_id === null ? OLD_NO_ROLE_TEXT : role?.name ?? `（已删除的职能 ${role_id}）`,
    tier,
    tier_source: tier_source === null ? null : TIER_SOURCE_TEXT[tier_source],
    ...(tier_source === 'override' || tier_source === 'escalated' ? { tier_reason } : {}),
  };
}

// What a review is bound to and what it concluded; for a reviewed Task, its reviews and
// whether acceptance is open. Read for the Router as the ledger holds it, never rebuilt.
function reviewFields(ledger: Pick<Ledger, 'reviewsOf' | 'reviewGate'>, task: TaskRow) {
  const verdictOf = (row: TaskRow) => {
    const verdict = row.verdict_json === null ? null : (JSON.parse(row.verdict_json) as VerdictRecord);
    return verdict === null ? null : { ...verdict, result: `${VERDICT_LABELS[verdict.result]}（${verdict.result}）` };
  };
  const binding = parseReviewOf(task.review_of_json);
  if (binding !== null) {
    const { task_id, run_id, revision, reviewed, files, writers } = binding;
    return {
      review_of: {
        task_id, run_id, revision, ...(reviewed === undefined ? {} : { reviewed }), files, excluded_executors: writers,
      },
      verdict: verdictOf(task),
    };
  }
  const reviews = ledger.reviewsOf(task.id).map((review) => ({ task_id: review.id, state: review.state, verdict: verdictOf(review) }));
  const gate = task.state === 'ready' ? ledger.reviewGate(task.id) : null;
  return reviews.length === 0 && gate === null ? {} : { reviews, ...(gate === null ? {} : { accept_blocked: gate }) };
}

// The snapshot is the whole brief and the skills: too much for a status answer.
function runView({ snapshot_json, receipt_json, error_json, ...run }: RunRow, currentName: (id: string) => string | undefined) {
  return { ...run, receipt: parsed(receipt_json), error: runErrorView({ ...run, error_json }, currentName) };
}

function latestSettlement(runs: RunRow[]) {
  const last = runs.findLast((run) => run.state === 'ended');
  return last
    ? { run_id: last.id, exit_kind: last.exit_kind, exit_code: last.exit_code, receipt: parsed(last.receipt_json), ended_at: last.ended_at }
    : null;
}

function taskOperation(value: unknown, ctx: Ctx): TaskOperation | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const { operation_key, ...args } = value as Record<string, unknown>;
  if (operation_key === undefined) return undefined;
  if (typeof operation_key !== 'string' || !/^[a-zA-Z0-9_.:-]{1,128}$/.test(operation_key)) {
    throw new InputError('操作编号限 1 至 128 位字母、数字、点、下划线、冒号或连字符');
  }
  if (ctx.toolCallId === undefined) throw new InputError('操作编号需要从负责人工具入口传入');
  return {
    key: createHash('sha256').update(operation_key).digest('hex'),
    hash: createHash('sha256').update(stableArgs(args)).digest('hex'),
  };
}

function stableArgs(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(stableArgs).join(',') + ']';
  if (value !== null && typeof value === 'object') {
    return '{' + Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, item]) => JSON.stringify(key) + ':' + stableArgs(item)).join(',') + '}';
  }
  return JSON.stringify(value);
}

export function createTools({ ledger, dataDir, github, runner, readReport, logins, machines, accept, release, nodes, nodeRelease, serviceManager, localSkills, inviteLimits, reported, routerExecutors = [], routerExecutorsFor }: ToolOptions) {
  const requireProjectScope = (here: Scope): string => {
    if (!here.projectId || here.projectId.trim() === '') {
      throw new InputError('项目文件工具只能在项目上下文中使用');
    }
    return here.projectId;
  };
  const requireFilesDataDir = (): string => {
    if (!dataDir) throw new InputError('服务未配置文件存储目录，暂不支持读写项目文件');
    return dataDir;
  };
  const resolveGitHubRepo = (here: Scope, explicitRepo?: string): string => {
    const sources = ledger.projectSources(here.projectId);
    const authorized = new Map<string, string>();
    let firstSourceUrl: string | undefined;
    for (const source of sources) {
      if (source.kind !== 'repo') continue;
      const parsed = parseGitHubRepo(source.url);
      if (parsed === null) continue;
      const normalized = `${parsed.owner}/${parsed.repo}`.toLowerCase();
      if (!authorized.has(normalized)) authorized.set(normalized, source.url);
      if (firstSourceUrl === undefined) firstSourceUrl = source.url;
    }
    if (typeof explicitRepo === 'string' && explicitRepo.trim() !== '') {
      const trimmed = explicitRepo.trim();
      const parsed = parseGitHubRepo(trimmed);
      if (parsed === null) {
        throw new InputError(`无效的 GitHub 仓库标识：${trimmed}（应为 owner/repo 或 GitHub 仓库 URL）`);
      }
      const normalized = `${parsed.owner}/${parsed.repo}`.toLowerCase();
      const boundSourceUrl = authorized.get(normalized);
      if (boundSourceUrl === undefined) {
        throw new InputError(`当前项目未绑定 GitHub 仓库 ${parsed.owner}/${parsed.repo}，仅允许访问本项目已配置的 GitHub 仓库来源`);
      }
      return boundSourceUrl;
    }
    if (firstSourceUrl !== undefined) return firstSourceUrl;
    throw new InputError('当前项目尚未配置 GitHub 仓库来源，请先在项目设置中添加 GitHub 仓库来源');
  };
  const nameOf = (id: string | null): string | null => id === null ? null : logins.get(id)?.name ?? '（已删除的登录）';
  const idOf = (name: string): string => {
    const login = logins.list().find((login) => login.name === name);
    if (!login) throw new InputError(`没有这个登录：${name}（名字可能已改，请重新 list_logins）`);
    return login.id;
  };
  const taskLine = (task: TaskRow) => {
    const { id, project_id, title, state, reason, priority, login_id, machine_id, revision } = task;
    return {
      id, project_id, title, state, reason, priority,
      login_id: nameOf(login_id),
      ...(machine_id === null ? {} : { machine_id }),
      prefer: preferView(task),
      ...roleFields(ledger, task),
      ...sourceFields(task),
      resumable: ledger.isTaskResumable(task.id),
      revision,
    };
  };
  // The Router's preference, with the names it knows (roles-and-tiers.md §11).
  const preferView = (task: TaskRow) => {
    const prefer = parseTaskPrefer(task.prefer_json);
    return prefer === null ? null : { login_ids: prefer.login_ids.map((id) => nameOf(id) ?? '（已删除的登录）'), reason: prefer.reason };
  };

  // What a Task works on, as a page shows it: the source it is pinned to (shared/sources.ts
  // TaskSourceView — the pin, which update_task's source moves, how it stands against the
  // project's list now, and the owner's label), and nothing for a Task of a project with no
  // source. The same projection the Task page uses (ledger.taskSourceView).
  const sourceFields = (task: TaskRow) => ledger.taskSourceView(task);

  // The Sources the project names and the Tasks running on each of them: what the Router
  // arranges concurrency by (docs/design/code-sources.md §3). Only a live Run counts; a Task
  // whose pin is gone from the list is running nowhere the project names.
  function runningBySource(projectId: string): Record<string, string[]> {
    const running = Object.fromEntries(ledger.projectSources(projectId).map((source) => [source.id, [] as string[]]));
    const tasks = new Map(ledger.listTasks({ projectId }).map((task) => [task.id, task]));
    for (const run of ledger.listActiveRuns()) {
      const task = tasks.get(run.task_id);
      if (task === undefined || task.source_json === null) continue;
      const pinned = JSON.parse(task.source_json) as TaskSource;
      const list = running[pinned.source_id];
      if (list !== undefined && !list.includes(task.id)) list.push(task.id);
    }
    return running;
  }

  // ---- Which project an object belongs to: one answer for every tool (project-sessions §4) ----
  // Asked before anything is done, the review's taking-over of files included. A Task of
  // another project, or of none, is not this Router's: it reads as one that is not there.
  function ownTask(scope: Scope, taskId: string): TaskRow {
    const task = ledger.hasTask(taskId) ? ledger.getTask(taskId) : undefined;
    if (!task || task.project_id !== scope.projectId) throw new InputError(`任务不存在：${taskId}（只看得到本项目的任务）`);
    return task;
  }
  function ownRun(scope: Scope, runId: string): RunRow {
    const run = ledger.hasRun(runId) ? ledger.getRun(runId) : undefined;
    const task = run && ledger.hasTask(run.task_id) ? ledger.getTask(run.task_id) : undefined;
    if (!run || task?.project_id !== scope.projectId) throw new InputError('Run 不存在（只看得到本项目的 Run）');
    return run;
  }
  // A knowledge entry this project's Router may read: a global one or one of this project's.
  // One of another project reads as one that is not there.
  function ownEntry(scope: Scope, id: string, allowDirectory = false): void {
    if (isDirectorySkillId(id)) {
      if (!allowDirectory) throw new InputError(`目录技能 ${id} 由技能目录维护，不能通过账本提议修改或退役`);
      const dirEntry = ledger.getDirectorySkillEntry(id);
      if (!dirEntry || (dirEntry.project_ids !== null && !dirEntry.project_ids.includes(scope.projectId))) {
        throw new InputError(`没有这个条目：${id}`);
      }
      return;
    }
    const entry = ledger.getEntry(id);
    if (!entry || (entry.project_ids !== null && !entry.project_ids.includes(scope.projectId))) throw new InputError(`没有这个条目：${id}`);
  }
  // A trigger of this project (docs/design/triggers.md §7); another project's reads as one that is not there.
  function ownTrigger(scope: Scope, id: string): TriggerView {
    const trigger = ledger.getTrigger(id);
    if (!trigger || trigger.project_id !== scope.projectId) throw new InputError(`触发器不存在：${id}（只看得到本项目的触发器）`);
    return trigger;
  }
  // The logins this project may run as now: the ledger's one derivation (§5).
  const poolOf = (scope: Scope): string[] => ledger.loginPool({ project_id: scope.projectId }).ids;
  const projectPage = (scope: Scope): string => `控制台“项目”页里的项目 ${ledger.getProject(scope.projectId).name}（#/projects/${scope.projectId}/settings）`;

  function requireRole(roleId: string) {
    const role = ledger.getRole(roleId);
    if (!role) throw new InputError(`职能不存在：${roleId}，可选：${ledger.listRoles().map(({ id }) => id).join('、')}`);
    return role;
  }

  function overrideOf(override: { tier: string; reason?: string } | null | undefined) {
    if (override === undefined || override === null) return override;
    return { tier: override.tier, ...(typeof override.reason === 'string' && override.reason.trim() !== '' ? { reason: override.reason.trim() } : {}) };
  }

  function requireAllowed(scope: Scope, loginId: string): void {
    const refused = ledger.loginRefusal({ project_id: scope.projectId }, loginId) ?? (logins.get(loginId) ? undefined : `${loginName(loginId)} 不存在`);
    if (refused !== undefined) throw new InputError(refused);
  }

  function tierWarning(loginId: string, tier: string): string | undefined {
    const login = logins.get(loginId);
    if (login === undefined || tierValueFrom(login.tiers, tier) === undefined) {
      return `${loginName(login ?? loginId)} 没有档位 ${tier}，可选：${Object.keys(login?.tiers ?? {}).join('、')}`;
    }
    return undefined;
  }

  const allowedMachinesOf = (scope: Scope) => {
    const range = ledger.projectMachines(scope.projectId);
    const names = range.machines.map(({ name }) => name);
    const allows = (id: string): boolean => (names.length === 0 && range.gone > 0 ? false : inRange(names, id));
    return machines.list().filter((machine) => (machine.scope === undefined ? allows(machine.id) : machine.scope.project_id === scope.projectId));
  };

  function candidateWarning(scope: Scope, tier: string, fixedMachine?: string | null): string | undefined {
    const allowed = poolOf(scope);
    const matching = candidateLogins({ login_id: null, tier }, allowed, logins, undefined, ledger.loginOrder(tier, scope.projectId));
    if (fixedMachine) {
      if (matching.some((login) => login.machine === undefined || login.machine === fixedMachine)) return undefined;
      if (matching.length > 0) {
        return `项目 ${ledger.getProject(scope.projectId).name} 允许的登录里没有能在机器 ${fixedMachine} 上跑的 ${tier} 档位登录（需托管账号或 ${fixedMachine} 本机登录）`;
      }
    }
    if (matching.length > 0) return undefined;
    const project = ledger.getProject(scope.projectId);
    if (allowed.length === 0) return `项目 ${project.name} 暂无可用登录（请主人在${projectPage(scope)}配置）`;
    const offered = allowed.map((id) => `${nameOf(id)}（${Object.keys(logins.get(id)?.tiers ?? {}).join('、') || '已不存在'}）`).join('，');
    return `项目 ${project.name} 当前登录里没有档位 ${tier}：${offered}`;
  }

  // Advisory placement check: returns a warning instead of rolling back task creation/update.
  function placeWarning(scope: Scope, task: TaskRow): string | undefined {
    const source = ledger.sourceRefusal(task);
    if (source !== undefined) return source;
    if (task.tier === null) return undefined;
    const pinned = task.source_json === null ? null : (JSON.parse(task.source_json) as TaskSource);
    const folderUid = pinned?.pinned.kind === 'folder' ? pinned.pinned.machine_uid : undefined;
    const folderMachine = folderUid === undefined
      ? undefined
      : machines.list().find((each) => each.uid === folderUid)?.id;
    const fixedMachine = task.machine_id ?? folderMachine ?? null;
    return task.login_id !== null ? tierWarning(task.login_id, task.tier) : candidateWarning(scope, task.tier, fixedMachine);
  }

  // The values a login argument takes for this project, read when the tools are listed or a
  // call is checked: the same pool the checks above use. An empty enum is not a valid schema,
  // and a project with no login is allowed. `extra` are values that are not a login's id and
  // mean something of their own.
  const knownLogin = (scope: Scope, schema: Schema, extra: string[] = []): Schema => {
    const ids = poolOf(scope).flatMap((id) => { const login = logins.get(id); return login && login.name.length > 0 ? [login.name] : []; });
    const values = [...ids, ...extra.filter((value) => value.length > 0)];
    return values.length > 0 ? { ...schema, enum: values } : schema;
  };
  const LOGIN_ID_DESC = '可选：仅当主人明确点名指定某个账号/模型时才填，否则务必留空交由项目/全局优先级自动派发';
  const loginId = (scope: Scope): Schema => knownLogin(scope, described(LOGIN_ID_DESC));
  // Null clears the pinned login (Gemini API rejects empty strings inside JSON Schema enums).
  const loginIdOrNone = (scope: Scope): Schema => ({
    ...knownLogin(scope, described(`${LOGIN_ID_DESC}；填 null 取消固定`)),
    nullable: true,
  });

  const MACHINE_ID_DESC = '可选：指定任务在某台机器上执行（见 list_machines），不填则自动分配；无需绑定本机目录或额外登录，托管账号或该机自有登录均可直接跑';
  const machineId = (scope: Scope): Schema => {
    const ids = allowedMachinesOf(scope).map((machine) => machine.id);
    return ids.length > 0 ? { ...described(MACHINE_ID_DESC), enum: ids } : described(MACHINE_ID_DESC);
  };
  const machineIdOrNone = (scope: Scope): Schema => ({
    ...machineId(scope),
    description: `${MACHINE_ID_DESC}；填 null 取消固定机器`,
    nullable: true,
  });

  const SOURCE_TEXT = '代码来源 id（见 get_project.sources）；不填默认取项目首个来源（若指定了 machine_id 且首个来源是另一台机器的本机目录，则自动改用目标机器默认空任务目录）；填 null 显式使用目标机器默认空任务目录，无需绑定代码文件夹';
  const sourceId = (scope: Scope): Schema => {
    const ids = ledger.projectSources(scope.projectId).map((source) => source.id);
    return ids.length === 0
      ? { ...described(`${SOURCE_TEXT}（当前项目无代码来源）`), nullable: true }
      : { ...described(SOURCE_TEXT), enum: ids, nullable: true };
  };

  const TIER = {
    type: 'string' as const,
    enum: [...TIER_IDS],
    description: TIERS.map((tier) => `${tier.id}（${tier.label}）`).join(' / '),
  };
  const ROLE_ID = described('可选：职能 id（见 list_roles，默认 implement）');
  const SKILL_IDS: Schema = { type: 'array', items: STRING, description: '可选：点名本任务必须遵循的技能编号列表（已同步至目标机的技能只附轻量调用提示，不重复贴全文；空数组清空）' };
  const TIER_OVERRIDE: Schema = {
    ...object({ tier: TIER, reason: described('可选：覆盖原因') }, ['tier']),
    description: '可选：覆盖职能默认档位',
  };

  // The knowledge tools the knowledge MCP offers, held to this project for its Router: what it
  // reads is global or this project's, and what it proposes is for one of the two (§4).
  const library = new Map(createLibrary(ledger).map((tool) => [tool.name, tool]));
  const caller = (ctx: Ctx, here: Scope) => ({ ctx, proposer: { source: 'router' as const, by: 'router', client: 'router', writers: routerExecutorsFor ? routerExecutorsFor(here.projectId) : routerExecutors, projectId: here.projectId } });
  const libraryTool = (name: string) => library.get(name)!;

  const tools: RouterTool[] = [
    {
      name: 'invite_machine',
      description:
        `为任务申请临时机器接入名额（需项目开启“允许派生机器”）。一次性材料在下一轮启动时通过环境变量 ${JOIN_MATERIALS_ENV} 传给执行者，主机地址在 ${HOST_URL_ENV}；任务结束后机器自动注销。`,
      inputSchema: object(
        {
          task_id: STRING,
          executors: { type: 'array', items: STRING, description: '可选：限定可执行器列表' },
          max_machines: { type: 'integer', description: '可选：最多登记台数，默认 1' },
          valid_for_minutes: { type: 'integer', description: '可选：名额有效期（分钟）' },
        },
        ['task_id'],
      ),
      run({ task_id, executors, max_machines, valid_for_minutes }, ctx, here) {
        const task = ownTask(here, task_id);
        const limits = inviteLimits?.();
        if (!limits) throw new InputError('这台主机没有开放派生机器');
        const project = ledger.getProject(here.projectId);
        const most = limits.maxMachines;
        const count = max_machines ?? 1;
        if (count < 1) throw new InputError('max_machines 至少是 1');
        if (count > most) throw new InputError(`一条名额最多登记 ${most} 台（设置“一条接入名额最多登记几台”），申请的是 ${count} 台`);
        const ttlMs = valid_for_minutes === undefined ? limits.ttlMs : valid_for_minutes * 60_000;
        if (ttlMs <= 0) throw new InputError('valid_for_minutes 要是正数');
        if (ttlMs > limits.maxTtlMs) throw new InputError(`名额最长 ${Math.floor(limits.maxTtlMs / 60_000)} 分钟有效`);
        // The quota cannot name what the project could never run on such a machine: an
        // executor none of its accounts has, or a project that allows no account at all — a
        // machine's own login runs on its machine, and a spawned machine is a new one.
        const allowedAccounts = poolOf(here).flatMap((id) => { const login = logins.get(id); return login && login.machine === undefined ? [login] : []; });
        const executorsHad = new Set(allowedAccounts.map(({ executor }) => executor));
        const unknown = ((executors ?? []) as string[]).filter((each) => !executorsHad.has(each));
        const usable = allowedAccounts.filter((account) => executors === undefined || (executors as string[]).includes(account.executor));
        // The ledger decides first whether the project allows it at all; these checks are
        // in the same transaction, so a refusal leaves nothing written.
        const invite = ledger.transaction(() => {
          const made = ledger.createInvite({ taskId: task.id, executors: executors ?? null, ttlMs, maxMachines: count }, ctx);
          if (unknown.length > 0) throw new InputError(`项目 ${project.name} 的账号里没有这些执行器：${unknown.join('、')}（有的是：${[...executorsHad].join('、') || '没有'}）`);
          if (usable.length === 0) throw new InputError(`项目 ${project.name} 允许的登录里没有能用派生机器的账号：机器自己的登录只在它那台机器上跑，派生的机器要用 tycho 保管登录的账号`);
          return made;
        });
        return [
          `接入名额已申请：${invite.id}，任务 ${task.id}，最多 ${count} 台，到 ${invite.expires_at} 为止开始的轮次能拿到材料`,
          `派生的机器只接项目 ${project.name} 的活，能用它的账号：${usable.map(({ name }) => name).join('、')}`,
          task.state === 'running' || task.state === 'stopping'
            ? `这个任务的这一轮已经在跑，拿不到材料：材料在下一轮启动时交给执行者（环境变量 ${JOIN_MATERIALS_ENV}）`
            : `材料在这个任务下一轮启动时交给执行者（环境变量 ${JOIN_MATERIALS_ENV}），不经过你`,
          `每份材料从发出起 ${Math.round(limits.materialTtlMs / 60_000)} 分钟内有效（设置“接入材料的有效期”）`,
        ].join('\n');
      },
    },
    {
      name: 'list_logins',
      description:
        '列出本项目可用的登录（托管账号 account 和机器自有登录 machine），含名称 id、执行器、支持档位与顺序、当前并发和额度状态。',
      inputSchema: object({}),
      run: (_args, _ctx, here) =>
        json(
          poolOf(here).flatMap((id) => { const login = logins.get(id); return login ? [login] : []; }).map((login: Login) => {
            const own = login.machine !== undefined;
            const status = own && login.machine !== undefined ? reported?.(login.machine, login.executor) ?? null : null;
            const learned = loginStatus(ledger, login);
            // The tiers this login can take, by the one substitution rule (shared/tiers.ts):
            // a login with no operate content takes an operate round on its execute content.
            // Each one's position is that tier's own global order — an operate round is
            // placed by the operate order whether its content is the login's own or not —
            // and one that substitutes says which tier its content is.
            const takes = TIER_IDS.flatMap((tier) => {
              const held = tierValueFrom(login.tiers, tier);
              if (held === undefined) return [];
              const position = ledger.loginOrder(tier, here.projectId).indexOf(login.id);
              return position < 0 ? [] : [{ tier, from: held.from, order: position + 1 }];
            });
            const substitutes = takes.filter(({ tier, from }) => tier !== from);
            return {
              id: login.name,
              kind: own ? 'machine' : 'account',
              executor: login.executor,
              ...(own ? { machine: login.machine, signed_in: status === null ? null : status.installed && status.logged_in !== false } : {}),
              tiers: takes.map(({ tier }) => tier),
              ...(substitutes.length === 0 ? {} : { tier_from: Object.fromEntries(substitutes.map(({ tier, from }) => [tier, from] as const)) }),
              order: Object.fromEntries(takes.map(({ tier, order }) => [tier, order] as const)),
              active_runs: learned.active_runs,
              max_runs: learned.max_runs,
              ...(learned.usage.length === 0 ? {} : { usage: learned.usage }),
              status: loginStatusLine(learned),
            };
          }),
        ),
    },
    {
      name: 'create_task',
      description: '在当前项目创建任务并排队派发。只需 title 与 goal（acceptance、role_id 均可选，role_id 默认 implement）；定向派到某台机器直接传 machine_id（可用 source: null 在目标机器默认空任务目录运行，无需给项目绑定目录或登录）；绑定独立审阅时传 role_id="review" 与 review_of。',
      inputSchema: (here) => object(
        {
          title: STRING, goal: STRING, acceptance: STRING, scope: STRING, operation_key: described('可选：幂等操作编号'), parent_id: described('可选：本项目父任务 id'), login_id: loginId(here), machine_id: machineId(here), source: sourceId(here), role_id: ROLE_ID, tier_override: TIER_OVERRIDE, skill_ids: SKILL_IDS,
          file_ids: { type: 'array', items: STRING, description: `可选：附带本项目文件（含文本、图片、PDF、数据集，最多 ${TASK_PROJECT_FILES_LIMIT} 个、总计 ${Math.floor(TASK_PROJECT_FILES_BYTES_LIMIT / (1024 * 1024))} MiB）写入快照 project-files/ 目录` },
          on_ready: { type: 'string', enum: ['notify_owner'], description: '可选：notify_owner 表示任务就绪时直接通知主人' },
          review_of: described('可选：审阅任务绑定的被审任务 id（本项目已结束过轮次的任务）'),
        },
        ['title', 'goal'],
      ),
      priorResult(args, ctx, here) {
        const operation = taskOperation(args, ctx);
        return operation === undefined ? undefined : ledger.taskOperation(here.projectId, operation);
      },
      async run(args, ctx, here) {
        const operation = taskOperation(args, ctx);
        const { title, goal, acceptance, scope, parent_id, machine_id, source, role_id, tier_override, review_of, skill_ids, file_ids, on_ready } = args;
        let { login_id } = args;
        if (login_id !== undefined) login_id = idOf(login_id);
        const override = overrideOf(tier_override);
        const resolvedRoleId = typeof role_id === 'string' && role_id.trim() !== '' ? role_id.trim() : 'implement';
        requireRole(resolvedRoleId);
        if (login_id !== undefined) requireAllowed(here, login_id);
        if (parent_id !== undefined) ownTask(here, parent_id);
        // Whose the reviewed Task is, before anything of it is taken over.
        if (review_of !== undefined) {
          ownTask(here, review_of);
          const existingReview = ledger.activeReview(review_of);
          if (existingReview !== null) {
            return ledger.transaction(() => {
              if (operation) {
                const prior = ledger.taskOperation(here.projectId, operation);
                if (prior !== undefined) return prior;
              }
              const result = `任务 ${review_of} 当前产物已有进行中的审阅任务：${existingReview.id}（${existingReview.state}），没有重复创建`;
              if (operation) ledger.saveTaskOperation(ctx.toolCallId!, operation, result);
              return result;
            });
          }
        }
        let effectiveScope: string | undefined = scope;
        if (file_ids !== undefined && file_ids.length > 0) {
          const projectId = requireProjectScope(here);
          const uniqueIds = [...new Set(file_ids as string[])];
          if (uniqueIds.length > TASK_PROJECT_FILES_LIMIT) {
            throw new InputError(`一次最多附带 ${TASK_PROJECT_FILES_LIMIT} 个项目文件给执行者`);
          }
          const dir = requireFilesDataDir();
          const resolvedFiles: { id: string; name: string }[] = [];
          let totalBytes = 0;
          for (const fileId of uniqueIds) {
            const file = ledger.getProjectFile(projectId, fileId);
            if (!file) throw new InputError(`项目里没有这个文件：${fileId}`);
            const bytes = readProjectFileBytes(dir, projectId, file.id);
            if (bytes === null) throw new InputError(`文件 ${file.name}（${file.id}）在磁盘上不存在`);
            totalBytes += bytes.length;
            if (totalBytes > TASK_PROJECT_FILES_BYTES_LIMIT) {
              throw new InputError(`附带的项目文件总大小超过 ${Math.floor(TASK_PROJECT_FILES_BYTES_LIMIT / (1024 * 1024))} MiB 上限，请精简后再传给执行者`);
            }
            resolvedFiles.push({ id: file.id, name: file.name });
          }
          effectiveScope = formatTaskProjectFilesScope(scope, resolvedFiles);
        }
        // What the review is bound to is what the host takes over now from the reviewed
        // round; the ledger makes the binding from it and from the round it holds.
        const registered = review_of === undefined ? undefined : await accept.register(review_of);
        return ledger.transaction(() => {
          if (operation) {
            const existing = ledger.taskOperation(here.projectId, operation);
            if (existing !== undefined) return existing;
          }
          if (review_of !== undefined) {
            const existingReview = ledger.activeReview(review_of);
            if (existingReview !== null) {
              const result = `任务 ${review_of} 当前产物已有进行中的审阅任务：${existingReview.id}（${existingReview.state}），没有重复创建`;
              if (operation) ledger.saveTaskOperation(ctx.toolCallId!, operation, result);
              return result;
            }
          }
          const created = ledger.createTask(
            {
              projectId: here.projectId, title, goal, acceptance, scope: effectiveScope, loginId: login_id, roleId: resolvedRoleId, tierOverride: override,
              ...(parent_id === undefined ? {} : { parentId: parent_id }),
              ...(machine_id === undefined ? {} : { machineId: machine_id }),
              ...(source === undefined ? {} : { sourceId: source }),
              ...(skill_ids === undefined ? {} : { skillIds: skill_ids }),
              ...(on_ready === 'notify_owner' ? { onReady: on_ready } : {}),
              ...(review_of === undefined ? {} : { reviewOf: { taskId: review_of, ...registered } }),
            },
            ctx,
          );
          const warning = created.review_of_json === null ? placeWarning(here, created) : undefined;
          ledger.queueTask(created.id, ctx);
          const base = review_of === undefined ? `任务已创建并排队：${created.id}` : `审阅任务已创建并排队：${created.id}，审的是任务 ${review_of} 最近一轮的产物`;
          const result = warning === undefined ? base : `${base}\n注意：${warning}`;
          if (operation) ledger.saveTaskOperation(ctx.toolCallId!, operation, result);
          return result;
        });
      },
    },
    {
      name: 'update_task',
      description:
        '更新本项目任务的目标、范围、验收标准、目标机器、代码来源、登录、职能或档位覆盖；改内容字段递增修订，传 requeue=true 可将 ready 任务立即重新排队。任务有在跑轮次时不要改目标/范围/验收标准，请改用 continue_task。',
      inputSchema: (here) => object(
        { task_id: STRING, goal: STRING, acceptance: STRING, scope: STRING, login_id: loginIdOrNone(here), machine_id: machineIdOrNone(here), source: sourceId(here), role_id: ROLE_ID, tier_override: { ...TIER_OVERRIDE, nullable: true }, skill_ids: SKILL_IDS, requeue: { type: 'boolean', description: '可选：true 时若任务在 ready 状态则立即重新排队' } },
        ['task_id'],
      ),
      run({ task_id, goal, acceptance, scope, login_id, machine_id, source, role_id, tier_override, skill_ids, requeue }, ctx, here) {
        const clearingLogin = login_id === null || login_id === '';
        if (login_id !== undefined && !clearingLogin) login_id = idOf(login_id);
        const clearingMachine = machine_id === null || machine_id === '';
        ownTask(here, task_id);
        if (
          (goal !== undefined || acceptance !== undefined || scope !== undefined)
          && ledger.listActiveRuns().some((active) => active.task_id === task_id)
        ) {
          throw new InputError(`任务 ${task_id} 当前有运行中的轮次，不能直接修改目标/范围/验收标准（否则会令在跑轮次因修订过期而作废）；请改用 continue_task 发送后续指令`);
        }
        const override = overrideOf(tier_override);
        if (role_id !== undefined) requireRole(role_id);
        if (login_id && !clearingLogin) requireAllowed(here, login_id);
        const patch = Object.fromEntries(
          Object.entries({ goal, acceptance, scope, loginId: clearingLogin ? null : login_id, machineId: clearingMachine ? null : machine_id, sourceId: source, roleId: role_id, tierOverride: override, skillIds: skill_ids, requeue }).filter(
            ([, value]) => value !== undefined,
          ),
        );
        if (Object.keys(patch).length === 0) throw new InputError('没有要改的字段');
        const { updated, warning } = ledger.transaction(() => {
          const next = ledger.updateTask(task_id, patch, ctx);
          const warn = next.login_id !== null || clearingLogin || machine_id !== undefined || source !== undefined || role_id !== undefined || override !== undefined ? placeWarning(here, next) : undefined;
          return { updated: next, warning: warn };
        });
        const base = `任务已更新：${updated.id}，修订 ${updated.revision}，状态 ${updated.state}`;
        return warning === undefined ? base : `${base}\n注意：${warning}`;
      },
    },
    {
      name: 'interrupt_task',
      description: '中断本项目一个任务当前的 Run。结算后任务进入 held，会收到内部事件。',
      inputSchema: object({ task_id: STRING }, ['task_id']),
      async run({ task_id }, ctx, here) {
        ownTask(here, task_id);
        const run = ledger.listActiveRuns().find((active) => active.task_id === task_id);
        if (!run) throw new InputError(`任务 ${task_id} 没有未结束的 Run`);
        const verdict = await runner.interrupt(run, ctx);
        return verdict === 'ended'
          ? `Run ${run.id} 已停止并结算`
          : `Run ${run.id} 已记下停止要求，当前核实结果是 ${verdict}，结算后会收到内部事件`;
      },
    },
    {
      name: 'list_roles',
      description: '列出所有职能的 id、名称、默认档位、权限、交付物和是否默认独立审阅。',
      inputSchema: object({}),
      run: () => json(ledger.listRoles().map(({ id, name, description, default_tier, permission, deliverable, needs_review }) => ({
        id, name, description,
        default_tier: `${tierLabel(default_tier)}（${default_tier}）`,
        permission: permissionLabel(permission),
        deliverable: deliverableLabel(deliverable),
        needs_review,
      }))),
    },
    {
      name: 'get_project',
      description: '读取当前项目配置：名称、代码来源及各来源运行中任务、允许的登录/机器、派生机器开关与已授予权限（grants）。',
      inputSchema: object({}),
      run: async (_args, _ctx, here) => {
        const { id, name, spawn_machines, login_mode, grants_json } = ledger.getProject(here.projectId);
        const { machines: held, gone } = ledger.projectMachines(here.projectId);
        const names = held.map(({ name }) => name);
        const sources = ledger.projectSourceViews(here.projectId);
        return json({
          id, name,
          sources: sources.sources,
          ...(sources.pending.length === 0 ? {} : { sources_pending_machine: `清单里有 ${sources.pending.length} 个来源还在等主人选机器：主人在项目页选好之前，这些来源上的活做不了` }),
          running_by_source: runningBySource(here.projectId),
          spawn_machines: spawn_machines === 1,
          grants: Object.fromEntries(GRANT_IDS.map((grant) => [GRANTS[grant].label, grantsOf(grants_json).includes(grant)])),
          login_mode: login_mode === 'all' ? '全部登录' : '只用所选',
          logins: poolOf(here).map(nameOf),
          machines: names,
          ...(gone === 0 ? {} : { machines_deleted: `清单里还有 ${gone} 台已经删掉的机器，它们不匹配任何机器${names.length === 0 ? '：这个项目现在哪台机器都不能用，要主人在项目页重新选' : ''}` }),
          page: `#/projects/${id}`,
        });
      },
    },
    {
      name: 'list_machines',
      description:
        '列出本项目可用的机器，含在线状态、主机名、环境备注、节点本地技能摘要及临时机器状态。',
      inputSchema: object({}),
      run: (_args, _ctx, here) => {
        return json(allowedMachinesOf(here).map((machine) => {
          const ends = machine.ephemeral === true ? machineEnds(machine, machine.inviteId === undefined ? undefined : ledger.getInvite(machine.inviteId), ledger.roundsOn(machine.id).unread) : undefined;
          const nodeLocalSkills = localSkills?.(machine.id);
          return {
            id: machine.id, host: machine.host,
            ...(machine.note ? { note: machine.note } : {}),
            connected: nodes?.connected(machine.id) ?? null,
            service_manager: serviceManager?.(machine.id) ?? null,
            ...(nodeRelease === undefined ? {} : { tycho: nodeReleaseText(nodeRelease.reported(machine.id), nodeRelease.host) }),
            ...(nodeLocalSkills != null ? { local_skills: nodeLocalSkills } : {}),
            source: machineSourceText(machine.source),
            ephemeral: machine.ephemeral === true,
            ...(ends === undefined ? {} : {
              scope: machineScopeText(machine.scope),
              ends: Object.fromEntries(machineEndLines(ends).map(({ label, text }) => [label, text])),
            }),
          };
        }));
      },
    },
    {
      name: 'list_tasks',
      description: `分页列出本项目任务；不传 states 时仅返回未结束任务（不含 done / abandoned），传 after 翻下一页。`,
      inputSchema: object({
        states: { type: 'array', items: { ...STRING, enum: TASK_STATES } },
        limit: { type: 'integer', description: `每页条数（1–${LIST_TASKS_MAX}，默认 ${LIST_TASKS_LIMIT}）` },
        after: described('上一页返回的 next 任务 id'),
      }),
      run({ states, limit, after }, _ctx, here) {
        const size = typeof limit === 'number' ? limit : LIST_TASKS_LIMIT;
        if (size < 1) throw new InputError('limit 至少是 1');
        const pageSize = Math.min(size, LIST_TASKS_MAX);
        const cursor = typeof after === 'string' && after !== '' ? after : undefined;
        if (cursor !== undefined && !(ledger.hasTask(cursor) && ledger.getTask(cursor).project_id === here.projectId)) {
          throw new InputError(`没有这个任务：${cursor}（after 要填本项目上一页最后一条的 id）`);
        }
        const rows = ledger.listTasks({
          projectId: here.projectId,
          states,
          openOnly: !states?.length,
          after: cursor,
          limit: pageSize + 1,
        });
        const page = rows.slice(0, pageSize);
        const recentResumable = !states?.length && cursor === undefined
          ? (ledger.listRecentResumableTasks?.(here.projectId, 5) ?? [])
          : [];
        const shown = {
          tasks: page.map(taskLine),
          ...(rows.length > page.length ? { next: page.at(-1)!.id } : {}),
          ...(recentResumable.length > 0 ? { recent_resumable: recentResumable } : {}),
        };
        const tasks = json(shown);
        return ledger.dispatchConditions().paused ? `派发已暂停\n${tasks}` : tasks;
      },
    },
    {
      name: 'get_task',
      description: '查询本项目单个任务的完整账本详情：各轮 Run 及 report_files、补充输入、提问审批、反馈、交付文件（deliverables）与最近结算。',
      inputSchema: object({ task_id: STRING }, ['task_id']),
      run({ task_id }, _ctx, here) {
        const task = ownTask(here, task_id);
        const runs = ledger.listRuns(task_id);
        const { prefer_json: _preference, ...shownTask } = task;
        const taskTag = `[task:${task.id}]`;
        const runTags = runs.map((run) => `[run:${run.id}]`);
        const deliverables = task.project_id
          ? ledger
              .listProjectFiles(task.project_id)
              .filter(
                (row) =>
                  row.origin === 'worker' &&
                  row.summary !== null &&
                  (row.summary.includes(taskTag) || runTags.some((tag) => row.summary!.includes(tag))),
              )
              .map((row) => {
                const f = toProjectFileSummary(row);
                return {
                  id: f.id,
                  name: f.name,
                  mime: f.mime,
                  size: f.size,
                  kind: f.kind,
                  previewable: f.previewable,
                  is_image: f.is_image,
                  ref: `tycho-file://${f.id}`,
                  ...(f.is_image ? { image_markdown: `![${f.name}](/api/projects/${task.project_id}/files/${f.id}/raw)` } : {}),
                };
              })
          : undefined;
        return json({
          task: { ...shownTask, login_id: nameOf(task.login_id), prefer: preferView(task), ...roleFields(ledger, task), ...sourceFields(task), ...reviewFields(ledger, task) },
          runs: runs.map((run) => ({ ...runView(run, (id) => logins.get(id)?.name), report_files: reportFilesOf(run, ledger.runReport(run.id)), placed_by: ledger.placementOf(run.id) ?? null, login_id: run.login_id === null ? run.login_name : nameOf(run.login_id) })),
          owner_requests: ledger.taskOwnerRequests(task_id).map(requestView),
          inputs: ledger.listInputs(task_id),
          feedback: ledger.listTaskFeedback(task_id),
          approvals: ledger.listApprovals(task_id).map(({ questions_json, answers_json, ...approval }) => ({
            ...approval,
            questions: parsed(questions_json),
            answers: parsed(answers_json),
          })),
          ...(deliverables !== undefined ? { deliverables } : {}),
          latest_settlement: latestSettlement(runs),
        });
      },
    },
    {
      name: 'get_run_report',
      description: '读取本项目已结束 Run 的交付报告或产物文本（ref 取自 get_task 的 report_files 或产物相对路径），支持 offset / limit 分片读取。',
      inputSchema: object({
        run_id: STRING,
        ref: STRING,
        offset: { type: 'integer', description: '可选：起始字节偏移（默认 0）' },
        limit: { type: 'integer', description: '可选：最多读取字节数' },
      }, ['run_id', 'ref']),
      async run({ run_id, ref, offset, limit }, _ctx, here) {
        const run = ownRun(here, run_id);
        if (!readReport) throw new InputError('报告读取服务不可用');
        const range = offset !== undefined || limit !== undefined
          ? { ...(offset === undefined ? {} : { offset }), ...(limit === undefined ? {} : { limit }) }
          : undefined;
        return json(await readReport(run, ref, range));
      },
    },
    {
      name: 'get_run_log',
      description: '查看本项目某个 Run 最近保留的进度诊断事件（非交付报告）。',
      inputSchema: object({ run_id: STRING, tail: { type: 'integer', description: '最多返回条数，默认 50' } }, ['run_id']),
      run({ run_id, tail }, _ctx, here) {
        ownRun(here, run_id);
        return json(runner.events(run_id).slice(-(tail ?? DEFAULT_LOG_TAIL)));
      },
    },
    {
      name: 'accept_task',
      description: '验收通过（ready → done）并取回非代码产物（需项目授予验收权限；如需跳过独立审阅门禁须由主人在控制台操作）。',
      inputSchema: object({
        task_id: STRING,
        basis: described('可选：验收依据'),
      }, ['task_id']),
      async run({ task_id, basis }, ctx, here) {
        ownTask(here, task_id);
        const { stored, problem } = await accept.accept(task_id, basis ?? '', ctx, {});
        const said = stored.length === 0 ? '没有取到产物' : `取回了 ${stored.join('、')}`;
        return `任务已验收：${task_id}。${said}${problem === null ? '' : `；${problem}`}`;
      },
    },
    {
      name: 'integrate_task',
      description: '为已验收任务创建 PR 合入子任务（需项目授予并入主线权限），按核对提交号由执行器调用 gh/glab 合并。',
      inputSchema: object({
        task_id: STRING,
        pr: described('可选：指定要合入的 PR/MR 网址；不填取本轮回执中的 PR'),
      }, ['task_id']),
      async run({ task_id, pr }, ctx, here) {
        ownTask(here, task_id);
        ledger.requireGrant(task_id, 'integrate', ctx);
        let warning: string | undefined;
        const { made, child, pr: targetPr, commit } = createLandingTask(ledger, task_id, ctx, {
          beforeQueue: (created) => { warning = placeWarning(here, created); },
          ...(pr === undefined ? {} : { pr }),
        });
        const base = made
          ? `合入任务已创建并排队：${child.id}，合 ${targetPr} 里审过的提交 ${commit}`
          : `这个提交的合入任务还没结束：${child.id}（${child.state}），没有再建`;
        return warning === undefined ? base : `${base}\n注意：${warning}`;
      },
    },
    {
      name: 'release_task',
      description: '将已验收任务产出的发布包（tycho-<版本>.tar.gz）上线升级（需项目授予上线权限）。',
      inputSchema: object({ task_id: STRING, name: described('可选：发布包文件名，仅一个时可不填') }, ['task_id']),
      run({ task_id, name }, ctx, here) {
        ownTask(here, task_id);
        ledger.requireGrant(task_id, 'release', ctx);
        const product = ledger.currentProduct(task_id);
        const packages = (product.files ?? []).filter((file) => isPackageName(file.name) && (name === undefined || file.name === name));
        if (product.runId === null || packages.length === 0) throw new InputError(name === undefined ? '这个任务的当前产物里没有发布包' : '这个任务的当前产物里没有 ' + name);
        if (packages.length > 1) throw new InputError('有 ' + packages.length + ' 个发布包：用 name 说上哪一个（' + packages.map((file) => file.name).join('、') + '）');
        if (release === undefined) throw new InputError('这个服务不能上线');
        const [chosen] = packages;
        const { started, version } = release(product.runId, { name: chosen!.name, sha256: chosen!.sha256, bytes: chosen!.bytes }, ctx);
        return started ? `开始上线 ${version}：这一回合结束后服务会停下换版本` : `已经有一次上线在进行（${version}），没有再起一次`;
      },
    },
    {
      name: 'continue_task',
      description: '向已有任务线程发送后续指令并续接原会话（ready / held / done 立即重排续跑；running / queued 排队待本轮结束后自动续跑）。支持附带新 file_ids 与更新 title；同主题串行推进（排查→开发→预检→上线）优先使用。',
      inputSchema: object(
        {
          task_id: STRING,
          note: described('发给该任务线程的增量后续指令（执行者已保留原会话与通用约束，只写本轮新决策、改动点或验收差异，勿重复首轮背景与环境规范）'),
          title: described('可选：阶段推进时更新任务标题（保留原会话不重置上下文）'),
          file_ids: { type: 'array', items: STRING, description: `可选：追加附带本项目文件（含新上传的截图/文档，最多 ${TASK_PROJECT_FILES_LIMIT} 个、总计 ${Math.floor(TASK_PROJECT_FILES_BYTES_LIMIT / (1024 * 1024))} MiB）写入续接快照 project-files/ 目录` },
          expected_revision: { type: 'integer', description: '可选：乐观锁修订号' },
        },
        ['task_id', 'note'],
      ),
      run({ task_id, note, title, file_ids, expected_revision }, ctx, here) {
        const existing = ownTask(here, task_id);
        let nextScope: string | undefined;
        if (file_ids !== undefined && file_ids.length > 0) {
          const projectId = requireProjectScope(here);
          const uniqueIds = [...new Set(file_ids as string[])];
          if (uniqueIds.length > TASK_PROJECT_FILES_LIMIT) {
            throw new InputError(`一次最多附带 ${TASK_PROJECT_FILES_LIMIT} 个项目文件给执行者`);
          }
          const dir = requireFilesDataDir();
          const resolvedFiles: { id: string; name: string }[] = [];
          let totalBytes = 0;
          for (const fileId of uniqueIds) {
            const file = ledger.getProjectFile(projectId, fileId);
            if (!file) throw new InputError(`项目里没有这个文件：${fileId}`);
            const bytes = readProjectFileBytes(dir, projectId, file.id);
            if (bytes === null) throw new InputError(`文件 ${file.name}（${file.id}）在磁盘上不存在`);
            totalBytes += bytes.length;
            if (totalBytes > TASK_PROJECT_FILES_BYTES_LIMIT) {
              throw new InputError(`附带的项目文件总大小超过 ${Math.floor(TASK_PROJECT_FILES_BYTES_LIMIT / (1024 * 1024))} MiB 上限，请精简后再传给执行者`);
            }
            resolvedFiles.push({ id: file.id, name: file.name });
          }
          nextScope = formatTaskProjectFilesScope(existing.scope ?? undefined, resolvedFiles);
        }
        const res = ledger.continueTask(task_id, note, expected_revision, ctx, {
          ...(typeof title === 'string' && title.trim() !== '' ? { title: title.trim() } : {}),
          ...(nextScope !== undefined ? { scope: nextScope } : {}),
        });
        return res.active
          ? `后续指令已排队：${task_id}，当前轮次结束后自动续接原会话执行`
          : `任务已续接重排：${task_id}，后续指令将直接送入原会话`;
      },
    },
    {
      name: 'rework_task',
      description: '将 ready / held / done 状态的任务退回重新排队执行，附带新一轮要求（note）。',
      inputSchema: object(
        {
          task_id: STRING,
          note: described('写给下一轮执行者的返工说明'),
          expected_revision: { type: 'integer', description: '可选：乐观锁修订号' },
        },
        ['task_id', 'note'],
      ),
      run({ task_id, note, expected_revision }, ctx, here) {
        ownTask(here, task_id);
        ledger.reworkTask(task_id, note, expected_revision, ctx);
        return `任务已退回接着做：${task_id}，说明会在下一轮送到机器上`;
      },
    },
    {
      name: 'resume_task',
      description: '将 held 状态（或无待答问题的 waiting_person）任务重新排队。',
      inputSchema: object({ task_id: STRING }, ['task_id']),
      run({ task_id }, ctx, here) {
        ownTask(here, task_id);
        ledger.resumeTask(task_id, ctx);
        return `任务已重新排队：${task_id}`;
      },
    },
    {
      name: 'hold_task',
      description: '暂停排队中或等待中的任务（移至 held），后续可用 resume_task 恢复。',
      inputSchema: object({ task_id: STRING, reason: described('暂停原因') }, ['task_id', 'reason']),
      run({ task_id, reason }, ctx, here) {
        ownTask(here, task_id);
        ledger.holdTask(task_id, reason, ctx);
        return `任务已暂停：${task_id}`;
      },
    },
    {
      name: 'abandon_task',
      description: '放弃任务（运行中的需先 interrupt_task；失联任务可直接放弃）。',
      inputSchema: object({ task_id: STRING, reason: described('可选：放弃原因') }, ['task_id']),
      async run({ task_id, reason }, ctx, here) {
        ownTask(here, task_id);
        await runner.abandon(task_id, reason ?? '', ctx);
        return `任务已放弃：${task_id}`;
      },
    },
    {
      name: 'ask_user',
      description: '就本项目的一个任务向用户提一组问题，任务转入 waiting_person，答复后重新排队。',
      inputSchema: object({ task_id: STRING, questions: { type: 'array', items: QUESTION } }, ['task_id', 'questions']),
      run({ task_id, questions }, ctx, here) {
        ownTask(here, task_id);
        return `问题已发出：${ledger.openApproval(task_id, questions, ctx)}`;
      },
    },
    {
      name: 'schedule_wake',
      description: '预约到时重新排队，替换当前预约。',
      inputSchema: object({ task_id: STRING, at: described('ISO 8601，必须带时区') }, ['task_id', 'at']),
      run({ task_id, at }, ctx, here) {
        ownTask(here, task_id);
        ledger.scheduleWake(task_id, at, ctx);
        return `已预约：${task_id} 于 ${at}`;
      },
    },
    // Triggers (docs/design/triggers.md §7): this project's scheduled and internal-event ones.
    // Deleting one is the owner's, in the console. Inbound sources are tycho-wide and the owner's
    // alone: no tool here reaches them, and no key or secret is in any answer.
    {
      name: 'list_triggers',
      description: '列出本项目的定时/事件触发器、下次触发时间与最近触发记录。',
      inputSchema: object({}),
      run: (_args, _ctx, here) => json({
        triggers: ledger.listTriggers(here.projectId).map(({ id, name, enabled, source, event, schedule_text, instruction, missed, expires_at, push_final, revision, next_at, next_local, next_error, zone, ended, rejected, problem }) =>
          ({ id, name, enabled, source, schedule: schedule_text, event, instruction, missed, expires_at, push_final, revision, next_at, next_local, next_error, zone, ended, rejected, problem })),
        recent: ledger.listTriggerFires({ projectId: here.projectId, ruleOnly: true, limit: RECENT_FIRES }).map(({ trigger_id, trigger_name, event_id, scheduled_at, outcome, merged_count, merged_capped, message_id, message_state, created_at }) =>
          ({ trigger_id, trigger_name, event_id, scheduled_at, accepted_at: created_at, outcome, moments: merged_count, moments_at_least: merged_capped, message_id, message_state })),
      }),
    },
    {
      name: 'create_trigger',
      description: `创建本项目触发器：按定时（source="schedule"，支持 once/every/cron）或内部事件（source="event"，kind 可选 ${INTERNAL_EVENT_KINDS.map((kind) => `${kind}（${INTERNAL_EVENT_LABELS[kind]}）`).join('、')}）向负责人投递固定指令；push_final=true 时将回合最终回复推给主人。`,
      inputSchema: object({
        name: STRING,
        instruction: described('触发时投递的固定指令，可用 {{task_id}} 等事件占位符'),
        source: { type: 'string', enum: [...TRIGGER_SOURCES], description: 'schedule（默认）或 event' },
        schedule: SCHEDULE,
        event: EVENT,
        missed: MISSED,
        expires_at: EXPIRES,
        push_final: PUSH_FINAL,
      }, ['name', 'instruction']),
      run({ name, instruction, source, schedule, event, missed, expires_at, push_final }, ctx, here) {
        const made = ledger.createTrigger(here.projectId, {
          name, instruction, source, ...(schedule === undefined ? {} : { schedule: scheduleOf(schedule) }), event, missed, expires_at, push_final,
        }, ctx);
        return made.source === 'event'
          ? `触发器已建：${made.id}，${made.schedule_text}`
          : `触发器已建：${made.id}，${made.schedule_text}，下一次 ${made.next_local ?? '无'}（${made.zone}）`;
      },
    },
    {
      name: 'update_trigger',
      description: '更新本项目触发器的名称、指令、定时/事件规则或截止时间（expires_at 传空串清除）。',
      inputSchema: object({ trigger_id: STRING, name: STRING, instruction: STRING, schedule: SCHEDULE, event: EVENT, missed: MISSED, expires_at: EXPIRES, push_final: PUSH_FINAL }, ['trigger_id']),
      run({ trigger_id, schedule, ...rest }, ctx, here) {
        ownTrigger(here, trigger_id);
        const changed = ledger.updateTrigger(trigger_id, { ...rest, ...(schedule === undefined ? {} : { schedule: scheduleOf(schedule) }) }, ctx);
        return changed.source !== 'schedule'
          ? `触发器已改：${changed.id}，修订 ${changed.revision}，${changed.schedule_text}`
          : `触发器已改：${changed.id}，修订 ${changed.revision}，下一次 ${changed.next_local ?? '无'}（${changed.zone}）`;
      },
    },
    {
      name: 'set_trigger_enabled',
      description: '停用或重新启用本项目的一个触发器。',
      inputSchema: object({ trigger_id: STRING, enabled: { type: 'boolean', description: 'false 停用，true 启用' } }, ['trigger_id', 'enabled']),
      run({ trigger_id, enabled }, ctx, here) {
        ownTrigger(here, trigger_id);
        const changed = ledger.setTriggerEnabled(trigger_id, enabled, ctx);
        if (!changed.enabled) return `触发器已停用：${changed.id}`;
        return changed.source !== 'schedule' ? `触发器已启用：${changed.id}，${changed.schedule_text}` : `触发器已启用：${changed.id}，下一次 ${changed.next_local ?? '无'}（${changed.zone}）`;
      },
    },
    {
      name: 'list_open_requests',
      description: `分页列出本项目尚未关联任务/操作的主人消息（每页最多 ${OPEN_REQUESTS_PAGE} 条，传 after 翻下一页）。`,
      inputSchema: object({ after: described('上一页最后一条的消息编号') }),
      run({ after }, _ctx, here) {
        const page = ledger.openRequests(here.projectId, { ...(after === undefined ? {} : { after }), limit: OPEN_REQUESTS_PAGE });
        return json({ requests: page.map(requestView), next_after: page.length === OPEN_REQUESTS_PAGE ? page.at(-1)!.id : null });
      },
    },

    {
      name: 'list_unverified_requests',
      description: `分页列出本项目上次回合异常中断、待核实的主人消息及已提交操作（每页最多 ${OPEN_REQUESTS_PAGE} 条）。`,
      inputSchema: object({ after: described('上一页最后一条的消息编号') }),
      run({ after }, _ctx, here) {
        const page = ledger.unverifiedRequests(here.projectId, { ...(after === undefined ? {} : { after }), limit: OPEN_REQUESTS_PAGE });
        return json({
          requests: page.map((row) => ({ ...requestView(row), committed: ledger.listChanges({ messageId: row.id }).filter(({ action }) => !action.startsWith('message.')).map(({ action, task_id, at }) => ({ action, task_id, at })) })),
          next_after: page.length === OPEN_REQUESTS_PAGE ? page.at(-1)!.id : null,
        });
      },
    },

    // Reading and proposing knowledge: the same tools the knowledge MCP offers, held to the global
    // entries and this project's (§4). The Router proposes as itself; publishing is the owner's
    // (docs/design/knowledge-and-skills.md §4.2).
    {
      name: 'reply_to_inbound_source',
      description: '仅当本轮入站消息明确说主人已允许回读时，提交一条适合来源读者的结果。只写本次请求可公开的结果状态，正文最多 2000 字节，不发送给其他来源，也不代替给主人的答复。',
      inputSchema: object({ text: described('可给本次请求来源看的纯文本结果') }, ['text']),
      run({ text }, ctx, here) {
        const reply = redactWorkerDiagnosticText(text.trim(), (body) => body);
        if (reply === '' || Buffer.byteLength(reply) > 2000) throw new InputError('回读答复需为 1 至 2000 字节');
        if (!ctx.messageId) throw new InputError('当前没有入站消息');
        ledger.publishInboundReply(here.projectId, ctx.messageId, reply, ctx);
        return '已登记。入站来源可凭原回执读取。';
      },
    },
    {
      name: 'search_history_evidence',
      description: '查本项目已结束轮次的当时报告、提交和知识版本。可按关键词、职能、时间和提交前缀筛选；给出实际记录，未留下的字段标明未知。next_cursor 非空时，沿用搜索条件并把它填入 after 继续查。',
      inputSchema: historyEvidenceInputSchema,
      run: (args, _ctx, here) => json(ledger.searchHistoryEvidence(here.projectId, args)),
    },
    {
      name: 'get_working_context',
      description: '读这个项目现在适用的知识和技能：全局的和这个项目的（不限职能的在前，再是 role_id 这个职能的）。常驻知识给全文，按需知识和技能只给标题和什么时候用，用到时用 read_library 读正文；建任务时可以用 skill_ids 点名技能，执行者就照它做。每条带修订号（编号@修订号），引用时照写。',
      inputSchema: object({ role_id: described('职能编号；不填只给不限职能的') }),
      run: ({ role_id }, ctx, here) => libraryTool('get_working_context').run({ project_id: here.projectId, ...(role_id === undefined ? {} : { role_id }) }, caller(ctx, here)),
    },
    {
      name: 'search_library',
      description: '按文字查知识和技能：scope 填 global（全局）或 project（这个项目）；kind 填 knowledge 或 skill 只查一种。只返回标题和“什么时候用”，全文用 read_library 读。结果分页：next_cursor 不是 null 时还有下一页，把它填进 cursor 再查。',
      inputSchema: object({
        query: described('要找的文字'),
        scope: { type: 'string', enum: ['global', 'project'], description: 'global 全局，project 这个项目' },
        role_id: described('只看不限职能的和这个职能的'),
        kind: { type: 'string', enum: [...KNOWLEDGE_KINDS], description: 'knowledge 只查知识，skill 只查技能；不填两种都查' },
        include_retired: { type: 'boolean', description: '连已退役的一起查' },
        cursor: described('上一页给的 next_cursor'),
        limit: { type: 'integer', description: '每页几条，默认 20，最多 100' },
      }, ['query', 'scope']),
      run: ({ scope, ...rest }, ctx, here) => libraryTool('search_library').run({ ...rest, scope: scope === 'project' ? here.projectId : 'global' }, caller(ctx, here)),
    },
    {
      name: 'read_library',
      description: '读一条全局或这个项目的知识或技能的一个修订，或读已授权 Git LLM Wiki 页面（id 填 wiki:<vault_id>/<page_id>[@commit]）：不填 revision 读现在的修订。返回正文、作用域、来源和证据。',
      inputSchema: libraryTool('read_library').inputSchema,
      run(args, ctx, here) {
        if (!parseWikiCitation(args.id)) ownEntry(here, args.id, true);
        return libraryTool('read_library').run({ ...args, project_id: here.projectId }, caller(ctx, here));
      },
    },
    {
      name: 'propose_learning',
      description: `${PROPOSE_DESCRIPTION}作用域限本项目（默认）或全局（project_ids 填 null）。`,
      inputSchema: libraryTool('propose_learning').inputSchema,
      run(args, ctx, here) {
        for (const output of (args.outputs ?? []) as { project_ids?: unknown }[]) {
          const ids = output.project_ids;
          if (ids !== null && ids !== undefined && (!Array.isArray(ids) || ids.some((id) => id !== here.projectId))) {
            throw new InputError(`作用域只能是全局（null）或这个项目（["${here.projectId}"]）`);
          }
        }
        for (const input of (args.inputs ?? []) as { knowledge_id?: unknown }[]) if (typeof input.knowledge_id === 'string') ownEntry(here, input.knowledge_id);
        return libraryTool('propose_learning').run(args, caller(ctx, here));
      },
    },
    {
      name: 'list_wiki_vaults',
      description: '列出本项目已获授权的 Git LLM Wiki 知识库（名称、固定发布提交号、页数及是否允许提交修订提议）。',
      inputSchema: object({}),
      run(_args, _ctx, here) {
        const vaults = ledger.wiki.listProjectVaults(here.projectId);
        return json({
          vaults: vaults.map((v) => ({
            id: v.id,
            name: v.name,
            description: v.description,
            commit: v.effective_commit,
            page_count: v.page_count,
            can_propose: v.grant.can_propose,
          })),
        });
      },
    },
    {
      name: 'propose_wiki_update',
      description: '向本项目有提议权限的 Git LLM Wiki 提交页面修订提议（CAS 防覆盖，且硬性保护人类锁定区块）。',
      inputSchema: object({
        vault_id: described('Wiki 知识库编号'),
        path: described('仓库内相对 Markdown 路径，例如 topics/dmob-10.md'),
        new_content: described('完整的修订后 Markdown 正文'),
        rationale: described('修订理由与依据'),
        base_commit: described('可选：读取页面时的提交号'),
        base_mutation_version: { type: 'integer', description: '可选：读取页面时的 mutation_version' },
      }, ['vault_id', 'path', 'new_content']),
      run(args, ctx, here) {
        return libraryTool('propose_wiki_update').run({ ...args, project_id: here.projectId }, caller(ctx, here));
      },
    },
    {
      name: 'list_project_refs',
      description: '列出其他项目显式授权给本项目的固定版本跨项目只读引用（不含未授权项目的对话与仓库）。',
      inputSchema: object({}),
      run(_args, _ctx, here) {
        const refs = ledger.collaboration.listCrossProjectRefs({ projectId: here.projectId, direction: 'incoming' });
        return json({ refs });
      },
    },
    {
      name: 'read_project_ref',
      description: '读取一条显式授权给本项目的跨项目只读引用（冻结版本，不递归展开）。',
      inputSchema: object({ ref_id: described('跨项目引用编号') }, ['ref_id']),
      run({ ref_id }, _ctx, here) {
        return json(ledger.collaboration.readCrossProjectRef(here.projectId, ref_id));
      },
    },
    {
      name: 'create_task_contract',
      description: '在本项目内两个任务之间登记一条交付契约（生产方 → 消费方 + 产物路径），用于结构化交接与阻塞澄清（不允许跨项目）。',
      inputSchema: object({
        producer_task_id: described('生产方任务编号'),
        consumer_task_id: described('消费方任务编号'),
        contract_name: described('契约名称，例如 api-schema-v2'),
        artifact_path: described('可选：契约产物路径或引用'),
      }, ['producer_task_id', 'consumer_task_id', 'contract_name']),
      run(args, ctx, here) {
        return json(ledger.collaboration.createTaskContract({
          project_id: here.projectId,
          producer_task_id: args.producer_task_id,
          consumer_task_id: args.consumer_task_id,
          contract_name: args.contract_name,
          artifact_path: args.artifact_path,
        }, ctx));
      },
    },
    {
      name: 'list_task_contracts',
      description: '列出本项目内（或指定任务相关的）交付契约、已登记版本号及阻塞澄清记录。',
      inputSchema: object({ task_id: described('可选：只看涉及该任务的契约') }),
      run({ task_id }, _ctx, here) {
        return json({ contracts: ledger.collaboration.listTaskContracts({ projectId: here.projectId, ...(task_id ? { taskId: task_id } : {}) }) });
      },
    },
    {
      name: 'deliver_task_contract',
      description: '登记某条任务交付契约的新版本产物（账本自动合并状态变更，避免唤醒扇出雪崩）。',
      inputSchema: object({
        contract_id: described('契约编号'),
        artifact_path: described('可选：更新后的产物路径'),
        delivery_summary: described('本版交付摘要与变更说明'),
        run_id: described('可选：产出该版本的 Run 编号'),
      }, ['contract_id']),
      run({ contract_id, artifact_path, delivery_summary, run_id }, ctx, here) {
        return json(ledger.collaboration.deliverTaskContract(contract_id, {
          artifact_path,
          delivery_summary,
          run_id: run_id ?? null,
          expected_project_id: here.projectId,
        }, ctx));
      },
    },
    {
      name: 'block_task_contract',
      description: '消费方标记契约阻塞并提交一条有界澄清问题（绑定生产方任务修订号与契约版本）。',
      inputSchema: object({
        contract_id: described('契约编号'),
        question: described('结构化阻塞澄清问题'),
      }, ['contract_id', 'question']),
      run({ contract_id, question }, ctx, here) {
        return json(ledger.collaboration.blockTaskContract(contract_id, { question, expected_project_id: here.projectId }, ctx));
      },
    },
    {
      name: 'clarify_task_contract',
      description: '答复交付契约中的阻塞澄清项并推进契约状态。',
      inputSchema: object({
        contract_id: described('契约编号'),
        clarification_id: described('可选：指定某条澄清编号，不填默认回复最新未答复项'),
        answer: described('澄清结论'),
      }, ['contract_id', 'answer']),
      run({ contract_id, clarification_id, answer }, ctx, here) {
        return json(ledger.collaboration.clarifyTaskContract(contract_id, { clarification_id, answer, expected_project_id: here.projectId }, ctx));
      },
    },
    {
      name: 'list_project_files',
      description: '列出本项目里的全部文件与可视化产物（图片、文档、HTML/SVG 交互产物），返回 id、文件名、MIME、大小、摘要与是否支持预览。',
      inputSchema: object({}),
      run(_args, _ctx, here) {
        const projectId = requireProjectScope(here);
        const rows = ledger.listProjectFiles(projectId);
        return json({ files: rows.map(toProjectFileSummary) });
      },
    },
    {
      name: 'read_project_file',
      description: '读取本项目里的一个文本类文件内容（文档、代码、JSON、CSV、Markdown、HTML、SVG 等）。二进制或位图图片不支持文本读取；用户发来的图片在消息回合里已直接作为视觉上下文提供。',
      inputSchema: object({
        file_id: described('文件编号（从 list_project_files 或消息附件说明获取）'),
        max_chars: { type: 'integer', description: `最多返回字符数，默认 ${DEFAULT_READ_FILE_CHARS}，上限 ${MAX_READ_FILE_CHARS}` },
      }, ['file_id']),
      run({ file_id, max_chars }, _ctx, here) {
        const projectId = requireProjectScope(here);
        if (max_chars !== undefined && (!Number.isSafeInteger(max_chars) || max_chars < 1)) {
          throw new InputError('max_chars 必须是正整数');
        }
        const limit = Math.min(max_chars ?? DEFAULT_READ_FILE_CHARS, MAX_READ_FILE_CHARS);
        const file = ledger.getProjectFile(projectId, file_id);
        if (!file) throw new InputError('项目里没有这个文件');
        const summary = toProjectFileSummary(file);
        if (!isTextFileMime(file.mime)) {
          return json({
            file: summary,
            readable_as_text: false,
            note: '二进制或图片文件不支持文本读取；图片会在用户发送消息时直接作为视觉上下文提供。',
          });
        }
        const dir = requireFilesDataDir();
        const bytes = readProjectFileBytes(dir, projectId, file.id);
        if (bytes === null) throw new InputError('文件在磁盘上不存在或已被清理');
        const text = bytes.toString('utf8');
        const truncated = text.length > limit;
        const content = truncated ? text.slice(0, limit) : text;
        return json({ file: summary, content, truncated });
      },
    },
    {
      name: 'write_project_file',
      description: '写入或更新本项目文本/可视化文件（HTML、SVG、Markdown、CSV/JSON 等，上限 2 MiB）。返回的 tycho-file://<id> 可写成 [标题](tycho-file://<id>) 在对话中直接渲染交互预览卡片。',
      inputSchema: object({
        name: described('文件名（例如 dashboard.html、diagram.svg、notes.md）'),
        content: described('UTF-8 文本内容（上限 2 MiB）。HTML/SVG 运行在离线沙箱（connect-src \'none\'），须内联 CSS/JS 且不引用外部 CDN；可直接使用控制台注入的主题 CSS 变量 --canvas、--background、--raised、--muted、--border、--foreground、--muted-foreground、--primary 及图表色 --series-1 至 --series-5（自动随浅/深色切换）'),
        mime: described('可选 MIME 类型；不填按扩展名推断'),
        kind: { type: 'string', enum: [...PROJECT_FILE_KINDS], description: '可选：artifact（预览产物）、doc（文档）、upload' },
        summary: described('可选一句话摘要'),
      }, ['name', 'content']),
      run({ name, content, mime, kind, summary }, _ctx, here) {
        const projectId = requireProjectScope(here);
        const dir = requireFilesDataDir();
        const normalizedName = normalizeProjectFileName(name);
        const normalizedMime = normalizeProjectFileMime(mime, normalizedName);
        if (!isTextFileMime(normalizedMime)) {
          throw new InputError('write_project_file 仅支持写入文本、HTML、SVG 或文档类文件');
        }
        if (kind !== undefined && !isProjectFileKind(kind)) {
          throw new InputError(`不支持的文件类型：${String(kind)}`);
        }
        const resolvedKind: ProjectFileKind = kind ?? (isPreviewableArtifactMime(normalizedMime) ? 'artifact' : 'doc');
        const bytes = Buffer.from(content, 'utf8');
        if (bytes.length > MAX_ROUTER_WRITE_BYTES) {
          throw new InputError('写入内容超过 2 MiB 上限，请精简后再写');
        }
        const normalizedSummary = typeof summary === 'string'
          ? (summary.trim() === '' ? null : summary.trim().slice(0, 500))
          : undefined;

        const existing = ledger.findProjectFileByName(projectId, normalizedName);
        let row;
        if (existing && existing.origin === 'router') {
          const previousBytes = readProjectFileBytes(dir, projectId, existing.id);
          const written = writeProjectFileBytes(dir, projectId, existing.id, bytes);
          try {
            row = ledger.updateProjectFile(projectId, existing.id, {
              name: normalizedName,
              mime: normalizedMime,
              size: written.size,
              sha256: written.sha256,
              kind: resolvedKind,
              ...(normalizedSummary === undefined ? {} : { summary: normalizedSummary }),
            });
          } catch (err) {
            try {
              if (previousBytes !== null) writeProjectFileBytes(dir, projectId, existing.id, previousBytes);
            } catch {
              // Best-effort restore on ledger update failure.
            }
            throw err;
          }
        } else {
          const fileId = ulid();
          const written = writeProjectFileBytes(dir, projectId, fileId, bytes);
          try {
            row = ledger.createProjectFile({
              id: fileId,
              projectId,
              name: normalizedName,
              mime: normalizedMime,
              size: written.size,
              sha256: written.sha256,
              kind: resolvedKind,
              origin: 'router',
              summary: normalizedSummary ?? null,
            });
          } catch (err) {
            try {
              removeProjectFileBytes(dir, projectId, fileId);
            } catch {
              // Ignore cleanup error while propagating ledger error.
            }
            throw err;
          }
        }

        const fileSummary = toProjectFileSummary(row);
        return json({
          file: fileSummary,
          ref: `tycho-file://${row.id}`,
          previewable: fileSummary.previewable,
          tip: fileSummary.previewable
            ? `回复主人时可用 [标题](tycho-file://${row.id}) 直接在对话中渲染交互预览卡片`
            : '文件已保存到项目文件区，可在“项目文件”抽屉查看或下载。',
        });
      },
    },
    {
      name: 'github_list_prs',
      description: '列出本项目已绑定 GitHub 仓库的 Pull Request 列表（只读）。不填 repo 时自动使用本项目的第一个 GitHub 仓库来源。需先在控制台“设置 › GitHub”连接 GitHub。',
      inputSchema: object({
        repo: described('可选：本项目已绑定的 GitHub 仓库（owner/repo 或 GitHub 仓库 URL）；不填时自动从本项目的代码来源推断'),
        state: { type: 'string', enum: ['open', 'closed', 'all'], description: 'PR 状态：open（默认）、closed 或 all' },
        limit: { type: 'integer', description: '最多返回条数，默认 20，上限 100' },
      }),
      async run({ repo, state, limit }, _ctx, here) {
        if (!github) throw new InputError('尚未连接 GitHub，请先在控制台“设置 › GitHub”中完成连接');
        if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
          throw new InputError('limit 必须是正整数');
        }
        const targetRepo = resolveGitHubRepo(here, repo);
        const pulls = await github.listPullRequests(targetRepo, (state as 'open' | 'closed' | 'all' | undefined) ?? 'open', limit ?? 20);
        return json({ repo: targetRepo, pulls });
      },
    },
    {
      name: 'github_get_pr',
      description: '查看本项目已绑定 GitHub 仓库指定编号的 Pull Request 详情与 CI 检查结果（只读）。不填 repo 时自动使用本项目的第一个 GitHub 仓库来源。需先在控制台“设置 › GitHub”连接 GitHub。',
      inputSchema: object({
        repo: described('可选：本项目已绑定的 GitHub 仓库（owner/repo 或 GitHub 仓库 URL）；不填时自动从本项目的代码来源推断'),
        number: { type: 'integer', description: 'PR 编号（正整数）' },
      }, ['number']),
      async run({ repo, number }, _ctx, here) {
        if (!github) throw new InputError('尚未连接 GitHub，请先在控制台“设置 › GitHub”中完成连接');
        const targetRepo = resolveGitHubRepo(here, repo);
        const detail = await github.getPullRequest(targetRepo, number);
        return json(detail);
      },
    },
    {
      name: 'curate_knowledge',
      description: '为一组全局或这个项目的知识或技能条目建一个整理任务（docs §5.3）：执行者或审阅指出某条修订不成立、两条互相冲突时用。整理任务是只读的分析，候选变更经回执交回，由服务按规则发布；同一组条目已有没结束的整理任务就并进去，不另建。只提要整理的条目和原因，不写怎么改。',
      inputSchema: object({
        knowledge_ids: { type: 'array', items: STRING, description: '要整理的条目编号：出问题的那条和同主题的' },
        reason: described('为什么整理：哪条修订在哪里不成立，或者哪两条冲突'),
      }, ['knowledge_ids', 'reason']),
      run({ knowledge_ids, reason }, ctx, here) {
        for (const id of knowledge_ids as string[]) ownEntry(here, id);
        const id = ledger.curate({ entries: knowledge_ids, reason }, ctx);
        return `整理任务：${id}`;
      },
    },
    {
      name: 'read_group_context',
      description: '按需读取绑定到本项目的群聊近期消息历史与引用链（严格隔离到本项目已绑定的群聊）。返回按时间正序排列的群聊记录、每条关联的 linked_task_ids，以及向上翻页游标 next_before_id。',
      inputSchema: object({
        chat_id: described('可选：群聊 ID；本项目仅绑定一个群时可不填'),
        channel: { type: 'string', enum: [...IM_CHANNELS], description: '可选：消息通道（wecom 或 weixin）' },
        before_id: described('可选：向上翻页游标，填上次返回的 next_before_id'),
        reply_to_external_id: described('可选：按被引用消息的 external_id 回溯该消息及之前上下文'),
        limit: { type: 'integer', description: '返回条数（1 到 50 之间，默认 20）' },
      }),
      run({ chat_id, channel, before_id, reply_to_external_id, limit }, _ctx, here) {
        if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 50)) {
          throw new InputError('limit 必须是 1 到 50 之间的整数');
        }
        return json(
          ledger.readGroupContextForProject(here.projectId, {
            ...(channel !== undefined ? { channel: channel as ImChannel } : {}),
            ...(chat_id !== undefined ? { chatId: chat_id } : {}),
            ...(before_id !== undefined ? { beforeId: before_id } : {}),
            ...(reply_to_external_id !== undefined ? { replyToExternalId: reply_to_external_id } : {}),
            ...(limit !== undefined ? { limit } : {}),
          }),
        );
      },
    },
    {
      name: 'post_group_update',
      description: '向本项目绑定且开启播报的群聊发送阶段结论或最终结果（自动不含私有控制台链接）。',
      inputSchema: object({
        content: described('面向群内同事的简明结论（中文 Markdown，不含凭据或控制台地址）'),
        chat_id: described('可选：指定群聊 ID；省略则播报到全部已开启播报的绑定群'),
        channel: { type: 'string', enum: [...IM_CHANNELS], description: '可选：wecom 或 weixin' },
        task_id: described('可选：关联任务编号'),
      }, ['content']),
      run({ content, chat_id, channel, task_id }, ctx, here) {
        if (task_id !== undefined) ownTask(here, task_id);
        const result = ledger.postGroupUpdate(
          here.projectId,
          {
            content,
            ...(chat_id !== undefined ? { chatId: chat_id } : {}),
            ...(channel !== undefined ? { channel: channel as ImChannel } : {}),
            ...(task_id !== undefined ? { taskId: task_id } : {}),
          },
          ctx,
        );
        return json(result);
      },
    },
  ];

  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const refused = (text: string): ToolResult => ({ content: [{ type: 'text', text }], isError: true });
  const schemaOf = (tool: RouterTool, here: Scope): Schema => (typeof tool.inputSchema === 'function' ? tool.inputSchema(here) : tool.inputSchema);

  return {
    names: tools.map(({ name }) => name),
    // As a project's Router sees them: an argument's choices are that project's.
    list: (here: Scope) => tools.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: schemaOf(tool, here) })),

    // A refusal is an answer: the Router reads the ledger's own words and adapts. `here` is the
    // project the call was bound to before it was read (§4); nothing the model sends changes it.
    async call(name: string, args: unknown, ctx: Ctx, here: Scope): Promise<ToolResult> {
      const tool = byName.get(name);
      if (!tool) return refused(`没有这个工具：${name}`);
      try {
        // An operation already committed under this project can be read even if its
        // original login, role or source is no longer offered by the current schema.
        const held = tool.priorResult?.(args, ctx, here);
        if (held !== undefined) return { content: [{ type: 'text', text: held }] };
        const invalid = problem(schemaOf(tool, here), args ?? {}, 'arguments');
        if (invalid) return refused(invalid);
        return { content: [{ type: 'text', text: await tool.run((args ?? {}) as Args, ctx, here) }] };
      } catch (err) {
        if (err instanceof InputError || err instanceof DegradedError) return refused(err.message);
        // The ledger refused to do something the owner has not agreed to yet. The Router
        // reads what it would cost and asks; the same call with the consent goes through.
        if (err instanceof ConfirmationRequired) return refused(`${err.message}\n${json(err.detail)}`);
        throw err;
      }
    },
  };
}

export type Tools = ReturnType<typeof createTools>;
