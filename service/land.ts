// Landing an accepted Task's code on the main line, when its round opened a pull request: the
// merge is the executor's own act with the platform's own command, on a machine that holds the
// git sign-in. What the service adds is what no executor knows: which commit was reviewed, and
// that only that commit may go in. The platform's branch protection (required checks, required
// reviews) stays the platform's; a merge it refuses is reported as it is.
import { VERIFY_ROLE_ID, type RoleConfig } from '../shared/roles.ts';
import type { Ctx } from './db.ts';
import { InputError } from './errors.ts';
import type { Ledger, RunRow, TaskRow } from './ledger.ts';
import { deliveryOf, sourceHeadOf } from './review.ts';

// Basic PR/MR URL hygiene validated at merge time: http(s) URL with no whitespace or control
// characters (so it cannot inject CLI flags or newlines into the merge brief).
const PR_URL_HYGIENE = /^https?:\/\/[^\s\u0000-\u001f\u007f]+$/;

function checkPrUrl(url: string): string {
  const trimmed = url.trim();
  if (!PR_URL_HYGIENE.test(trimmed)) {
    throw new InputError('PR 地址格式无效：只接受不含空白和控制字符的 http:// 或 https:// 网址');
  }
  return trimmed;
}

// What the ledger keeps of a merge round (task.landing_json), written when the Task is made and
// by nothing else: the Task it lands, the pull request, and the commit that was reviewed.
export interface Landing {
  of: string;
  pr: string;
  commit: string;
}

export function landingJson(landing: Landing): string {
  return JSON.stringify({ of: landing.of, pr: landing.pr, commit: landing.commit });
}

// The landing a Task was made for, or null when it was made for none (or the column cannot be
// read, which no write of this program produces).
export function parseLanding(json: string | null): Landing | null {
  if (json === null) return null;
  try {
    const value = JSON.parse(json) as Partial<Landing> | null;
    if (value === null || typeof value !== 'object') return null;
    const { of, pr, commit } = value;
    return typeof of === 'string' && typeof pr === 'string' && typeof commit === 'string' && of !== '' && pr !== '' && commit !== ''
      ? { of, pr, commit }
      : null;
  } catch {
    return null;
  }
}

// The pull request to land: uses an explicitly requested PR URL when given, otherwise the
// last PR in the receipt's artifacts (multiple PRs are allowed cleanly). URL hygiene is checked
// here at merge time.
export function pullRequestOf(receipt: unknown, requestedPr?: string): string | null {
  if (typeof requestedPr === 'string' && requestedPr.trim() !== '') {
    return checkPrUrl(requestedPr);
  }
  const pr = deliveryOf(receipt).pr;
  if (pr === undefined) return null;
  return checkPrUrl(pr);
}


// The merge round already made for this Task and commit, while it is still running or waiting to
// be accepted: asking again answers with it rather than a second round merging the same pull
// request; once it ended, merged or refused, a new one may be asked for. Recognised by what the
// ledger wrote into landing_json when it was made, which no edit can change.
export function landingOf<T extends { landing_json: string | null; state: string }>(tasks: readonly T[], parentId: string, commit: string): T | undefined {
  return tasks.find((task) => {
    if (task.state === 'abandoned' || task.state === 'done') return false;
    const landing = parseLanding(task.landing_json);
    return landing !== null && landing.of === parentId && landing.commit === commit;
  });
}

// The role the merge round is made with is an object the owner may change: one deleted, or made
// read-only, cannot merge anything, and is said before a Task is made of it.
export function landingRoleRefusal(role: { name: string; permission: string; deliverable: string } | undefined): string | null {
  if (role === undefined) return '合 PR 的子任务需要一个可写且交报告的职能，当前没有这样的职能：请主人在职能页添加一个可写、交报告的职能，或者自己在 PR 页面合';
  if (role.permission !== 'write') return `合 PR 的子任务用“${role.name}”职能，它现在是只读的，合不了：请主人把它改回可写，或者自己在 PR 页面合`;
  return role.deliverable === 'report' ? null : `合 PR 的子任务用“${role.name}”职能，它现在不交报告，合入的结果交不回来：请主人把交付物改回报告，或者自己在 PR 页面合`;
}

// Resolve a role capable of merging a PR by its properties (writable + report deliverable),
// preferring the preset `verify` role when it satisfies those properties so custom/renamed
// role setups never break PR landing.
export function resolveLandingRole(roles: readonly RoleConfig[]): { role: RoleConfig } | { refusal: string } {
  const usable = (role: RoleConfig): boolean => role.permission === 'write' && role.deliverable === 'report';
  const preset = roles.find((role) => role.id === VERIFY_ROLE_ID);
  if (preset && usable(preset)) return { role: preset };
  const fallback = roles.find((role) => usable(role) && !role.needs_review) ?? roles.find(usable);
  if (fallback) return { role: fallback };
  return { refusal: landingRoleRefusal(preset)! };
}

// The child Task that merges it: a writable report-delivering round.
export function landingTask(task: { id: string; title: string }, pr: string, commit: string, roleId = VERIFY_ROLE_ID) {
  return {
    parentId: task.id,
    roleId,
    landing: { of: task.id, pr, commit } satisfies Landing,
    title: `合入：${task.title}`,
    goal: [
      `把任务 ${task.id} 审过的提交合进它的 PR 的基准分支。PR：${pr}`,
      `只合这个提交：${commit}。用机器上已登录的 gh 或 glab，并让平台核对提交号：`,
      `- GitHub：gh pr merge ${pr} --match-head-commit ${commit}`,
      `- GitLab：glab mr merge ${pr} --sha ${commit}`,
      '合并方式用仓库的默认设置。不要加 --admin 之类绕过分支保护的参数，不要强推，不要改 PR 上的提交。',
      '平台拒绝（要求的检查没过、要求的审阅没有、PR 的提交已经不是上面那个、有冲突）就停下，照原话报告，不要设法让它合进去。',
    ].join('\n'),
    acceptance: '合进去了：回执的 artifacts 里写 {"kind":"commit","ref":"<合入后基准分支上的提交号>"}，报告里写合并方式和基准分支。没合进去：报告里写平台的原话。',
  };
}

export interface LandableInfo {
  landable: boolean;
  pr: string | null;
  commit: string | null;
  already_integrated: boolean;
  active_landing_task_id: string | null;
  active_landing_task_state?: string | null;
  active_landing_task_title?: string | null;
  reason: string | null;
}

export interface CreateLandingResult {
  made: boolean;
  child: TaskRow;
  pr: string;
  commit: string;
}

type LandingReadLedger = Pick<
  Ledger,
  'getTask' | 'currentProduct' | 'getRun' | 'currentPass' | 'acceptedWithoutReview' | 'listTasks' | 'listChanges'
> & Partial<Pick<Ledger, 'listRuns' | 'projectSources'>>;

type LandingWriteLedger = LandingReadLedger & Pick<
  Ledger,
  'requireLandable' | 'listRoles' | 'transaction' | 'createTask' | 'queueTask'
>;

function parseReceiptJson(text: string | null): unknown {
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// Scan ended runs newest-first so multi-round fix commits never lose an earlier round's PR URL.
function latestPrOfRuns(ledger: LandingReadLedger, taskId: string, latestRun: RunRow): string | undefined {
  const latestPr = deliveryOf(parseReceiptJson(latestRun.receipt_json)).pr;
  if (latestPr !== undefined) return latestPr;
  const runs = ledger.listRuns?.(taskId) ?? [];
  for (let i = runs.length - 1; i >= 0; i -= 1) {
    const each = runs[i]!;
    if (each.id === latestRun.id || each.state !== 'ended') continue;
    const pr = deliveryOf(parseReceiptJson(each.receipt_json)).pr;
    if (pr !== undefined) return pr;
  }
  return undefined;
}

function commitOfRun(run: RunRow, bound?: string, reviewedCommit?: string): string | null {
  const delivery = deliveryOf(parseReceiptJson(run.receipt_json));
  const head = sourceHeadOf(run);
  const headCommit = head?.kind === 'repo'
    ? (head.remote_head ?? head.head ?? undefined)
    : head?.kind === 'folder'
      ? (head.head ?? undefined)
      : undefined;
  return bound ?? delivery.commit ?? reviewedCommit ?? headCommit ?? null;
}

function pinnedSourceIdOf(task: Pick<TaskRow, 'source_json'>): string | undefined {
  if (!task.source_json) return undefined;
  try {
    const parsed = JSON.parse(task.source_json) as { source_id?: unknown } | null;
    return typeof parsed?.source_id === 'string' && parsed.source_id.trim() !== '' ? parsed.source_id : undefined;
  } catch {
    return undefined;
  }
}

function alreadyIntegratedCommit(
  changes: readonly { action: string; detail_json: string | null }[],
  commit: string,
  pr: string,
): boolean {
  return changes.some((change) => {
    if (change.action !== 'task.integrate') return false;
    if (!change.detail_json) return true;
    try {
      const detail = JSON.parse(change.detail_json) as { source_commit?: string | null; pr?: string | null };
      if (detail.source_commit) return detail.source_commit === commit;
      if (detail.pr) return detail.pr === pr;
      return true;
    } catch {
      return true;
    }
  });
}

// Read-only assessment of whether an accepted Task can currently be integrated via a PR merge round.
export function landableOf(ledger: LandingReadLedger, taskOrId: string | TaskRow): LandableInfo {
  const task = typeof taskOrId === 'string' ? ledger.getTask(taskOrId) : taskOrId;
  if (task.state !== 'done') {
    return { landable: false, pr: null, commit: null, already_integrated: false, active_landing_task_id: null, reason: '任务尚未验收完成' };
  }
  const product = ledger.currentProduct(task.id);
  const run = product.runId === null ? undefined : ledger.getRun(product.runId);
  if (run === undefined) {
    return { landable: false, pr: null, commit: null, already_integrated: false, active_landing_task_id: null, reason: '任务没有跑过，没有可并的代码' };
  }
  const latestPr = latestPrOfRuns(ledger, task.id, run);
  if (latestPr === undefined) {
    return { landable: false, pr: null, commit: null, already_integrated: false, active_landing_task_id: null, reason: '这一轮没有 PR' };
  }
  if (!PR_URL_HYGIENE.test(latestPr)) {
    return { landable: false, pr: null, commit: null, already_integrated: false, active_landing_task_id: null, reason: 'PR 地址格式无效：只接受不含空白和控制字符的 http:// 或 https:// 网址' };
  }
  const pr = latestPr;
  const bound = ledger.currentPass(task.id)?.reviewed?.commit;
  const commit = commitOfRun(run, bound, product.reviewed?.commit);
  if (commit === null) {
    return { landable: false, pr, commit: null, already_integrated: false, active_landing_task_id: null, reason: '这一轮登记的产物里没有提交号' };
  }
  const alreadyIntegrated = alreadyIntegratedCommit(ledger.listChanges({ taskId: task.id }), commit, pr);
  const activeLanding = task.project_id === null
    ? undefined
    : landingOf(ledger.listTasks({ projectId: task.project_id }), task.id, commit);
  const activeLandingTaskId = activeLanding?.id ?? null;
  const landable = !alreadyIntegrated && activeLandingTaskId === null;
  const reason = alreadyIntegrated ? '已经并入主线' : activeLandingTaskId !== null ? '已有进行中的合入任务' : null;
  return {
    landable,
    pr,
    commit,
    already_integrated: alreadyIntegrated,
    active_landing_task_id: activeLandingTaskId,
    ...(activeLanding
      ? {
          active_landing_task_state: activeLanding.state,
          active_landing_task_title: activeLanding.title,
        }
      : {}),
    reason,
  };
}

// Validate and resolve the PR URL and commit for creating a landing child Task.
export function resolveLandingTarget(
  ledger: LandingWriteLedger,
  taskId: string,
  options?: { pr?: string },
): { task: TaskRow; pr: string; commit: string } {
  ledger.requireLandable(taskId);
  const task = ledger.getTask(taskId);
  const product = ledger.currentProduct(taskId);
  const run = product.runId === null ? undefined : ledger.getRun(product.runId);
  if (run === undefined) throw new InputError('任务 ' + taskId + ' 没有跑过，没有可并的代码');
  const explicitPr = typeof options?.pr === 'string' && options.pr.trim() !== '' ? checkPrUrl(options.pr) : null;
  const foundPr = explicitPr ?? (() => {
    const raw = latestPrOfRuns(ledger, taskId, run);
    return raw === undefined ? null : checkPrUrl(raw);
  })();
  const pr = foundPr;
  if (pr === null) {
    throw new InputError('这一轮没有 PR：tycho 不把代码并进主机上的检出。让执行器把分支推上去、开一个 PR，再合那个 PR');
  }
  const bound = ledger.currentPass(taskId)?.reviewed?.commit;
  const commit = commitOfRun(run, bound, product.reviewed?.commit);
  if (commit === null) throw new InputError('这一轮没有记录提交号：需要提交号以核对 --match-head-commit / --sha，不合 ' + pr);
  return { task, pr, commit };
}

// Shared creator for PR-landing child Tasks, used by both the Router's `integrate_task` tool and
// the Console's `POST /api/tasks/:id/integrate` endpoint.
export function createLandingTask(
  ledger: LandingWriteLedger,
  taskId: string,
  ctx: Ctx,
  options?: { beforeQueue?: (created: TaskRow) => void; pr?: string },
): CreateLandingResult {
  const { task, pr, commit } = resolveLandingTarget(ledger, taskId, options?.pr ? { pr: options.pr } : undefined);
  if (task.project_id === null) throw new InputError('无项目的任务不能并入主线');
  const projectId = task.project_id;
  if (alreadyIntegratedCommit(ledger.listChanges({ taskId }), commit, pr)) {
    throw new InputError(`任务 ${taskId} 的当前提交已经并入主线，不需要重复合入`);
  }
  return ledger.transaction(() => {
    const asked = landingOf(ledger.listTasks({ projectId }), taskId, commit);
    if (asked !== undefined) return { made: false, child: asked, pr, commit };
    const resolvedRole = resolveLandingRole(ledger.listRoles());
    if ('refusal' in resolvedRole) throw new InputError(resolvedRole.refusal);
    const parentSourceId = pinnedSourceIdOf(task);
    const sourceId = parentSourceId !== undefined && (!ledger.projectSources || ledger.projectSources(projectId).some((source) => source.id === parentSourceId))
      ? parentSourceId
      : undefined;
    const created = ledger.createTask({
      projectId,
      ...(sourceId === undefined ? {} : { sourceId }),
      ...landingTask(task, pr, commit, resolvedRole.role.id),
    }, ctx);
    options?.beforeQueue?.(created);
    ledger.queueTask(created.id, ctx);
    return { made: true, child: ledger.getTask(created.id), pr, commit };
  });
}
