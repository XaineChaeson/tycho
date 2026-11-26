import { setTimeout as sleep } from 'node:timers/promises';
import type { Executors } from '../adapters/types.ts';
import { noReviewerText, otherOutText, sameExecutorText, type SameExecutor } from '../shared/review.ts';
import { bindingKey, snapshotSourceOf, sourceLabel, type SnapshotSource, type TaskSource } from '../shared/sources.ts';
import { parseReviewOf } from './review.ts';
import type { Runner } from '../runner/runner.ts';
import type { CheckSite, Snapshot, SnapshotProjectFileInput, Login, LoginStore, Machine, MachineStore } from '../runner/snapshot.ts';
import {
  prepareSnapshot,
  eligibleMachines,
  extractProjectFileIds,
  machineAllowed,
  runOnMachine,
} from '../runner/snapshot.ts';
import { isTextFileMime, readProjectFileBytes } from './project-files.ts';
import { InputError } from './errors.ts';
import type { Ctx, Ledger, RunRow, TaskRow } from './ledger.ts';
import { loginRefused, namedSkillsOf, neverStarted, restingUntil, usageNow, workerNeverRan } from './ledger.ts';
import type { Candidate, Wait } from './pick.ts';
import { candidateLogins, excludedExecutors, needsRoleToPlace, outReason, pickLogin, placementGroups, sameExecutorReviewers, usable } from './pick.ts';
import type { PlacementGroup } from './pick.ts';
import { knowledgeRoleRefusal } from './roles.ts';
import { fitsHere, ownLoginHere, readOnlyRefusal, type Reported } from './readonly.ts';
import { knowledgeTaskMaterial } from './knowledge-brief.ts';
import { noGateKeeperText } from '../shared/knowledge.ts';
import { parseKnowledgeTask, type KnowledgeLimits } from './knowledge.ts';
import { isDirectorySkillId } from '../shared/skill-catalog.ts';
import { effectiveRouteOfLogin, slotForLogin, type TierDispatchSlots } from '../shared/dispatch-slots.ts';
import { isTierId, type TierId } from '../shared/tiers.ts';
import type { PlacedBy } from '../shared/tasks.ts';
import type { NodeEntryReport } from '../shared/node-protocol.ts';

const TASK_PROJECT_FILES_LIMIT = 20;
const TASK_PROJECT_FILES_BYTES_LIMIT = 10 * 1024 * 1024;

const DISPATCHER: Ctx = { actor: 'dispatcher' };
// How long before an ephemeral machine that was told to leave, and is still here, is told
// again: long enough for one that answered to have left, short enough for one that died
// before leaving and came back.
const RETIRE_AGAIN_MS = 60_000;
const RESUMABLE_EXIT = ['completed', 'interrupted', 'auth', 'quota', 'failed'];

export interface DispatcherOptions {
  ledger: Ledger;
  dataDir?: string;
  runner: Pick<Runner, 'launch' | 'watch' | 'findMachine' | 'lostCandidates' | 'presume' | 'sweep'>;
  logins: LoginStore;
  machines: MachineStore;
  // The executors that have an adapter, by name, with what each declares about continuing
  // a session. Read at each dispatch: an executor that cannot take one back is started
  // fresh, whatever the previous round left.
  executors: Executors;
  // How much knowledge a round may carry (docs/design/knowledge-and-skills.md §4.1). Read at
  // each dispatch.
  knowledgeLimits: () => KnowledgeLimits;
  // Each Run keeps the limit it started with, so it goes into the snapshot.
  runTimeoutMs: () => number;
  modelIdleTimeoutMs?: () => number;
  // Whether a machine's client is here now, and whether it speaks another node protocol.
  // A folder source waits for its one machine, and an older client takes no work until it is
  // upgraded; both are said on the Task page (docs/design/code-sources.md §2).
  connected?: (machineId: string) => boolean;
  outputReady?: (machineId:string)=>boolean;
  refusedProtocol?: (machineId: string) => boolean;
  intervalMs?: number;
  watchIntervalMs?: number;
  // The same grace period the Runner judges lost Runs by. Read when used.
  lostGraceMs: () => number;
  // How many more Runs a login may hold than the ones after it in the tier's order,
  // and the share of its quota from which a login is kept for last. Read at each pick.
  frontLead: () => number;
  usageWarnAt: () => number;
  now?: () => number;
  // A login has had no machine to offer for a whole grace period: only the owner can
  // add one. `since` is when this stretch began.
  onNoMachine?: (loginId: string, since: string) => void;
  // Whether a machine a task spawned can run this executor, by what it reported about
  // itself (docs/design/nodes.md §1.3, the fourth part of the intersection). Absent, or
  // nothing reported yet, counts as "not known to be missing".
  capable?: (machineId: string, executor: string) => boolean;
  // What a machine last reported about one of its executors, or null when it has said
  // nothing yet. Read where new work is placed: a machine whose
  // executor cannot run this program's commands takes none of its work, and a read-only Task
  // goes only where that executor's read-only way was found to start (service/readonly.ts).
  // Absent: nothing reported anywhere, and no read-only Task is placed.
  reported?: Reported;
  reportedEntry?: (machineId: string) => NodeEntryReport | null;
  externalEntryEnabled?: () => boolean;
  // Whether a machine's own login of this executor is being made on it right now (service/
  // sign-ins.ts): that login takes no new work until the sign-in is over. Not a refusal of the
  // login and not a failure: the Task waits as for any machine. Absent: none ever is.
  signingIn?: (machineId: string, executor: string) => boolean;
  // Tell an ephemeral machine its work here is over, so that it leaves by itself. Only
  // sent once its quota's task has ended and nothing runs on it. False: it is not connected
  // now, and nothing was sent.
  retire?: (machineId: string) => Promise<boolean>;
  log?: (line: string) => void;
}

// A login with work waiting and no machine that answers.
export interface WaitingLogin {
  login_id: string;
  login_name: string;
  since: string;
  // Past the grace period, which is when the owner is told.
  overdue: boolean;
}

function failedResumeRefsOf(runs: readonly RunRow[]): Set<string> {
  const failed = new Set<string>();
  for (const run of runs) {
    let snap: { session_ref?: unknown } | null = null;
    try {
      snap = JSON.parse(run.snapshot_json) as { session_ref?: unknown } | null;
    } catch {
      snap = null;
    }
    const triedRef = typeof snap?.session_ref === 'string' && snap.session_ref.trim() !== '' ? snap.session_ref.trim() : null;
    if (!triedRef) continue;
    let err: { resume_failed?: unknown } | null = null;
    try {
      err = run.error_json ? (JSON.parse(run.error_json) as { resume_failed?: unknown } | null) : null;
    } catch {
      err = null;
    }
    if (err?.resume_failed === true || (run.exit_kind === 'failed' && run.receipt_json === null)) {
      failed.add(triedRef);
    }
  }
  return failed;
}

// §8: same login, same machine, same executor, same source binding, and a previous Run that left
// a session worth continuing (skipping any session_ref whose resume just failed immediately).
function resumableSession(
  rounds: RunRow[],
  login: Login,
  machine: Machine,
  executors: Executors,
  tier?: string,
  permission: string = 'write',
  sourceBindingKey?: string,
  allRuns: readonly RunRow[] = rounds,
): string | undefined {
  const last = rounds.findLast((run) => typeof run.session_ref === 'string' && run.session_ref !== '');
  if (!last?.session_ref || !RESUMABLE_EXIT.includes(last.exit_kind ?? '')) return undefined;
  const failedRefs = failedResumeRefsOf(allRuns);
  if (failedRefs.has(last.session_ref)) return undefined;
  const previous = JSON.parse(last.snapshot_json) as Snapshot;
  const { executor } = previous;
  if (executor !== login.executor) return undefined;
  if (previous.source?.binding_key !== sourceBindingKey) return undefined;
  // A session belongs to the tier it ran on: a round on another one — after a review's
  // rejection moved the Task up, or after the owner changed it — starts fresh (§6).
  if (tier !== undefined && previous.tier !== tier) return undefined;
  // And to the permission it ran with: a session that wrote is not continued read-only, nor
  // the other way round, after the Task's role changed.
  if ((previous.access?.permission ?? 'write') !== permission) return undefined;
  // And to the line it ran on: a session continued on another endpoint would send the whole of
  // its history there.
  const line = login.provider === undefined ? undefined : executors[login.executor]?.provider?.config(login.provider).text;
  if (previous.line?.text !== line) return undefined;
  if (executors[login.executor]?.resumable !== true || executors[executor ?? '']?.resumable !== true) return undefined;
  // A session is kept on the machine it ran on: the same node identity, not only the name.
  return last.login_id === login.id && runOnMachine(last, machine) ? last.session_ref : undefined;
}

// §5.4: someone let this Task go on after a Run, and may have touched things since. Sending
// one back to work is the same situation from the other side: a person looked at what came
// back and would not take it, so the round that follows is told to check the site first
// rather than assume the round before it still holds.
function resumedAfterRun(changes: { action: string }[]): boolean {
  const lastRun = changes.findLastIndex(({ action }) => action === 'run.create');
  return lastRun >= 0 && changes.findLastIndex(({ action }) => action === 'task.resume' || action === 'task.rework') > lastRun;
}

// A lost round's bound inputs are never sent again (§4), so the next round is told
// what they were and that nobody knows whether they were acted on. So is the next round
// after one the quota ended halfway. A round no machine took is different: nothing of
// it ran, its inputs were not delivered and come again as pending, and the history says
// so instead of leaving it open.
function historyEntry(run: RunRow): unknown {
  const { inputs } = JSON.parse(run.snapshot_json) as Pick<Snapshot, 'inputs'>;
  const lost = workerNeverRan(run)
    ? { not_started: true, undelivered_inputs: inputs ?? [] }
    : run.exit_kind !== 'lost' && run.exit_kind !== 'quota' && run.exit_kind !== 'auth'
      && !(run.exit_kind === 'failed' && run.receipt_json === null)
    ? {}
    : neverStarted(run) ? { not_started: true, undelivered_inputs: inputs ?? [] } : { unconfirmed_inputs: inputs ?? [] };
  return {
    run_id: run.id,
    exit_kind: run.exit_kind,
    receipt: run.receipt_json === null ? null : (JSON.parse(run.receipt_json) as unknown),
    ended_at: run.ended_at,
    ...lost,
  };
}

export function createDispatcher(options: DispatcherOptions) {
  const { ledger, runner, logins, machines, executors } = options;
  const intervalMs = options.intervalMs ?? 5000;
  const graceMs = options.lostGraceMs;
  const now = options.now ?? Date.now;
  const log = options.log ?? ((line: string) => console.error(line));
  const stopping = new AbortController();
  const watchers = new Map<string, Promise<void>>();
  // Login id to when it was first found without a machine that takes work. In memory: a
  // restart starts the count again, as it does for everything it has not seen itself, so
  // one stretch that spans a restart can be told twice.
  const starved = new Map<string, { since: number; told: boolean; projects: Set<string | null> }>();
  // Runs that came away from a judgment still unknown, with the turn it happened at:
  // they go behind the candidates that have not had theirs.
  const passed = new Map<string, number>();
  let turns = 0;
  let loop: Promise<void> | undefined;
  let sweeping: Promise<void> | undefined;

  function follow(run: RunRow): void {
    if (watchers.has(run.id)) return;
    const { watchIntervalMs: pollMs } = options;
    const watching = runner
      .watch(run, { signal: stopping.signal, ...(pollMs === undefined ? {} : { intervalMs: pollMs }) })
      .catch((err: unknown) => log(`Run ${run.id} 跟踪中止：${String(err)}`))
      .finally(() => watchers.delete(run.id));
    watchers.set(run.id, watching);
  }

  // `task` is the Task as this dispatch read it, once: its permission chose the machine and
  // chooses the session and the snapshot's access here, and is never read again in between —
  // the role may change while a machine is being asked. createRun checks it still holds and
  // refuses the round otherwise; the Task stays queued and the next round places it afresh.
  function prepare(task: TaskRow, login: Login, machine: Machine, runs: RunRow[], source: SnapshotSource | undefined): Snapshot {
    const permission = task.permission ?? 'write';
    // What the previous round left is what the last round that ran left.
    const rounds = runs.filter((run) => !neverStarted(run) && !workerNeverRan(run));
    const knowledge = [...ledger.applicable(task.project_id, task.role_id, undefined, machine.id)];
    const named = namedSkillsOf(task);
    for (const id of named) {
      if (knowledge.some((entry) => entry.id === id)) continue;
      const entry = isDirectorySkillId(id) ? ledger.getDirectorySkillEntry(id) : ledger.getEntry(id);
      if (entry && entry.kind === 'skill' && entry.state === 'active'
        && (entry.project_ids === null || (task.project_id !== null && entry.project_ids.includes(task.project_id)))) {
        knowledge.push(entry);
      }
    }
    const independent = task.review_of_json !== null || task.knowledge_json !== null;
    const sessionRef = independent
      ? undefined
      : resumableSession(rounds, login, machine, executors, task.tier ?? undefined, permission, source?.binding_key, runs);
    const role = task.role_id === null ? undefined : ledger.getRole(task.role_id);
    const project = task.project_id === null ? null : ledger.getProject(task.project_id);
    const job = parseKnowledgeTask(task.knowledge_json);
    const last = rounds.at(-1);
    const resumedDefinitionChanged = sessionRef !== undefined && last !== undefined && last.task_revision !== task.revision;
    const left = last?.exit_kind;
    const checkSite: CheckSite | undefined = left === 'lost' || left === 'quota' || left === 'auth'
      ? left
      : resumedAfterRun(ledger.listChanges({ taskId: task.id })) ? 'resumed' : undefined;
    const projectFiles: SnapshotProjectFileInput[] = [];
    if (task.project_id !== null && options.dataDir) {
      const fileIds = extractProjectFileIds(task.scope).slice(0, TASK_PROJECT_FILES_LIMIT);
      if (fileIds.length > 0) {
        const rowsById = new Map(
          ledger.listProjectFilesByIds(task.project_id, fileIds).map((row) => [row.id, row]),
        );
        let totalBytes = 0;
        for (const fileId of fileIds) {
          const file = rowsById.get(fileId);
          if (!file) {
            log(`任务 ${task.id} 引用的项目文件 ${fileId} 已不存在，跳过写入快照`);
            continue;
          }
          let bytes: Buffer | null = null;
          try {
            bytes = readProjectFileBytes(options.dataDir, task.project_id, file.id);
          } catch (err) {
            log(`任务 ${task.id} 读取项目文件 ${file.id} 失败，跳过：${String(err)}`);
            continue;
          }
          if (bytes === null) {
            log(`任务 ${task.id} 引用的项目文件 ${file.id} 磁盘缺失，跳过写入快照`);
            continue;
          }
          if (totalBytes + bytes.length > TASK_PROJECT_FILES_BYTES_LIMIT) {
            log(`任务 ${task.id} 附带的项目文件超出 ${TASK_PROJECT_FILES_BYTES_LIMIT} 字节上限，跳过 ${file.name}`);
            continue;
          }
          totalBytes += bytes.length;
          projectFiles.push(
            isTextFileMime(file.mime)
              ? { id: file.id, name: file.name, mime: file.mime, text: bytes.toString('utf8'), bytes: bytes.length }
              : { id: file.id, name: file.name, mime: file.mime, data: bytes, bytes: bytes.length },
          );
        }
      }
    }
    return prepareSnapshot(task, login, executors, {
      history: runs.map(historyEntry),
      ...(sessionRef ? { sessionRef } : {}),
      ...(resumedDefinitionChanged ? { resumedDefinitionChanged: true } : {}),
      timeoutMs: ledger.taskTimeoutMs(task.id) ?? login.timeoutMs ?? options.runTimeoutMs(),
      ...(options.modelIdleTimeoutMs ? { modelIdleTimeoutMs: options.modelIdleTimeoutMs() } : {}),
      ...(checkSite ? { checkSite } : {}),
      ...(source ? { source } : {}),
      ...(role ? { role } : {}),
      permission,
      // What the machine said of the executor: its version, which what a round is promised turns
      // on, and its own configuration there, which the snapshot records.
      executorReport: reportOf(machine, login.executor),
      entryReport: options.reportedEntry?.(machine.id),
      knowledge: { entries: knowledge, projectName: project?.name ?? '', limits: options.knowledgeLimits(), named: namedSkillsOf(task) },
      // The platform's way of spawning a machine, to a Task that has had a quota for one.
      spawn: ledger.hadInvite(task.id),
      // A gate or curation round is handed its material as files of its snapshot (§3, §5.3).
      ...(job === null ? {} : { knowledgeTask: knowledgeTaskMaterial(ledger, job) }),
      ...(projectFiles.length > 0 ? { projectFiles } : {}),
    });
  }

  // The login has no machine that takes work: it joins, or stays in, the record of
  // logins short of machines, and the owner is told once that has lasted a whole grace
  // period. That is waiting for capacity, not an error to retry.
  function shortOfMachines(login: Login, task: TaskRow): void {
    const waiting = starved.get(login.id) ?? { since: now(), told: false, projects: new Set<string | null>() };
    waiting.projects.add(task.project_id);
    starved.set(login.id, waiting);
    if (!waiting.told && now() - waiting.since >= graceMs()) {
      options.onNoMachine?.(login.id, new Date(waiting.since).toISOString());
      waiting.told = true;
    }
  }

  // The machines a login's new work may go to: an account's, any the project allows; a
  // machine's own login, its machine. The project's own identity narrows a spawned machine
  // to its quota's project; and one that is draining, or says it cannot run this executor,
  // is not offered new work. Both are about where new work goes, never about
  // where a Run already is: the Runner judges a Run on a draining machine by the same rules
  // as any other.
  function offeredMachines(login: Login, task: TaskRow,requireOutput=true): Machine[] {
    const range = ledger.machineRange(task);
    if ('conflict' in range) return [];
    const pin = pinOf(task);
    const fix = fixOf(task, pin);
    if (fix.kind === 'gone') return [];
    // A folder source names its machine outright: the project's allowed machines do not
    // narrow it (docs/design/code-sources.md §2). A repository source prefers the machine its
    // first round ran on so its checkout is reused when available, and falls back to any other
    // eligible machine if the original machine is offline or gone.
    const candidates = (() => {
      if (fix.kind === 'machine') {
        const allowed = fix.from === 'folder' ? [] : range.allowed;
        const scopeProject = fix.from === 'folder' ? (task.project_id ?? undefined) : range.projectId;
        return [fix.machine].filter((machine) => machineAllowed(machine, login, allowed, scopeProject));
      }
      const all = eligibleMachines(login, range.allowed, machines, range.projectId);
      if (fix.kind === 'prefer') {
        const idx = all.findIndex((machine) => machine.id === fix.machine.id && machine.uid === fix.machine.uid);
        if (idx > 0) return [all[idx]!, ...all.slice(0, idx), ...all.slice(idx + 1)];
      }
      return all;
    })();
    const named = namedSkillsOf(task);
    let scoped = candidates;
    if (named.length > 0 && candidates.length > 0) {
      const hasNamedOn = (machineId: string): boolean => {
        const available = ledger.applicable(task.project_id, task.role_id, undefined, machineId);
        return named.every((id) => available.some((entry) => entry.id === id && entry.kind === 'skill'));
      };
      // Only narrow by machine scope when at least one registered machine can satisfy the named
      // skills; if a named skill is retired or out of project/role scope everywhere, leave
      // candidates intact so prepare() raises a clear hold reason instead of stalling in queue.
      if (machines.list().some((machine) => hasNamedOn(machine.id))) {
        scoped = candidates.filter((machine) => hasNamedOn(machine.id));
      }
    }
    return scoped
      .filter(machine=>!requireOutput||options.outputReady?.(machine.id)===true)
      .filter((machine) => !machine.ephemeral || (machine.drainAt === undefined && (options.capable?.(machine.id, login.executor) ?? true)));
  }

  // What a machine said of an executor, or null when it has said nothing yet.
  const reportOf = (machine: Machine, executor: string) => options.reported?.(machine.id, executor) ?? null;

  // The source a Task's rounds are pinned to (docs/design/code-sources.md §1): its own pin. A
  // review inherited the pin of the Task it reviews when it was made, and it is frozen with the
  // binding (the reviewed commit) from then on. Reading the reviewed Task's pin here instead —
  // as this once did — would move an old review to wherever the author Task was repinned
  // afterwards, while its binding still names the commit of the old place: a round that runs
  // wrong cannot be corrected by a later settlement (§8.11).
  const pinOf = (task: TaskRow): TaskSource | null => ledger.taskSource(task.id);
  const machineOfUid = (uid: string): Machine | undefined => machines.list().find((each) => each.uid === uid);
  // A source as the owner reads it, for a stop reason.
  const pinText = (pin: TaskSource): string => sourceLabel(pin.pinned, pin.pinned.kind === 'folder' ? machineOfUid(pin.pinned.machine_uid)?.id : undefined);
  // The source one round's snapshot was told to use (docs/design/code-sources.md §8.11).
  const sourceOfRun = (run: RunRow): SnapshotSource | undefined => {
    try {
      return (JSON.parse(run.snapshot_json) as { source?: SnapshotSource }).source;
    } catch {
      return undefined;
    }
  };
  // Whether a round worked on the very source binding the Task is pinned to now (shared/sources.ts
  // bindingKey): the id plus what it held when the Task was pinned. The commit a review round
  // names is not part of that. A round of another binding — the Task was repinned since, or the
  // source of that id was re-pointed elsewhere — is another binding's work, and holds nothing for
  // this one.
  const onPinnedSource = (run: RunRow, pin: TaskSource): boolean => {
    const held = sourceOfRun(run);
    return held !== undefined && held.binding_key === bindingKey(pin.pinned);
  };
  // Where a Task's rounds are fixed or preferred: a folder source or task.machine_id requires
  // its own machine; a repository source prefers the machine its first round ran on and falls
  // back cleanly to any eligible machine if the original machine is gone.
  type Fix =
    | { kind: 'none' }
    | { kind: 'machine'; machine: Machine; from: 'folder' | 'task' }
    | { kind: 'prefer'; machine: Machine }
    | { kind: 'gone'; why: string };
  const fixOf = (task: TaskRow, pin: TaskSource | null): Fix => {
    let folderMachine: Machine | undefined;
    if (pin?.pinned.kind === 'folder') {
      folderMachine = machineOfUid(pin.pinned.machine_uid);
      if (folderMachine === undefined || folderMachine.leftAt !== undefined) {
        return { kind: 'gone', why: `任务钉的来源里那台机器已经不在了：${pinText(pin)}。改派到别的来源，或者放弃这个任务` };
      }
    }
    if (task.machine_id !== null) {
      const target = machines.list().find((each) => each.id === task.machine_id && each.leftAt === undefined);
      if (target === undefined) {
        return { kind: 'gone', why: `任务指定的目标机器 ${task.machine_id} 已不存在或已注销：改派到别的机器，或者取消指定机器` };
      }
      if (folderMachine !== undefined && folderMachine.uid !== target.uid) {
        return { kind: 'gone', why: `任务指定的目标机器 ${target.id} 与代码来源 ${pinText(pin!)} 所在机器 ${folderMachine.id} 冲突：传 source: null 使用默认任务目录，或改派目标机器` };
      }
      return { kind: 'machine', machine: target, from: folderMachine ? 'folder' : 'task' };
    }
    if (folderMachine !== undefined) return { kind: 'machine', machine: folderMachine, from: 'folder' };
    if (pin === null) return { kind: 'none' };
    const first = ledger.listRuns(task.id).find((run) => run.machine_id !== null && !neverStarted(run) && !workerNeverRan(run) && onPinnedSource(run, pin));
    if (first === undefined) return { kind: 'none' };
    const machine = machines.list().find((each) => runOnMachine(first, each));
    return machine === undefined || machine.leftAt !== undefined
      ? { kind: 'none' }
      : { kind: 'prefer', machine };
  };
  // Why a Task's pinned source or target machine stops it before any machine is asked: its source
  // is no longer in the project's list, the migration left it waiting for a machine, the pinned
  // machine is gone/disallowed, or the pinned login belongs to a different machine.
  const sourceStop = (task: TaskRow, pin: TaskSource | null, range: ReturnType<Ledger['machineRange']>): string | undefined => {
    if (pin !== null) {
      const refused = ledger.sourceRefusal({ id: task.id, project_id: task.project_id, source_json: JSON.stringify(pin) });
      if (refused !== undefined) return refused;
    }
    const fix = fixOf(task, pin);
    if (fix.kind === 'gone') return fix.why;
    if (fix.kind === 'machine') {
      if (fix.from === 'task' && !('conflict' in range)) {
        const allowed = range.allowed.length === 0 || range.allowed.includes(fix.machine.id);
        const scopedOk = fix.machine.scope === undefined || fix.machine.scope.project_id === range.projectId;
        if (!allowed || !scopedOk) {
          return `任务指定的目标机器 ${fix.machine.id} 不在项目允许的机器范围内：改派到允许的机器，或调整项目允许的机器`;
        }
      }
      if (task.login_id !== null) {
        const pinnedLogin = logins.get(task.login_id);
        if (pinnedLogin?.machine !== undefined && pinnedLogin.machine !== fix.machine.id) {
          return `指定的登录 ${pinnedLogin.name} 只能在机器 ${pinnedLogin.machine} 上跑，与任务固定机器 ${fix.machine.id} 冲突：改钉托管账号 / ${fix.machine.id} 上的登录，或改派目标机器/代码来源`;
        }
      }
    }
    return undefined;
  };
  // The source one round is told about: the pin as it stands, and the commit a review is
  // checked out at (the reviewed round's own). A first repository round names no commit: the
  // machine clones and works on the branch as it is.
  const snapshotSourceFor = (task: TaskRow, pin: TaskSource | null): SnapshotSource | undefined => {
    if (pin === null) return undefined;
    const source = snapshotSourceOf(pin.pinned);
    if (source.kind !== 'repo') return source;
    const commit = parseReviewOf(task.review_of_json ?? null)?.reviewed?.commit;
    return commit === undefined ? source : { ...source, commit };
  };

  // A machine for the login that answers now, or nothing, in which case the Task stays
  // where it is and later rounds ask again. A machine's own login goes only where that
  // machine still reports itself signed in; an account's token goes with the round.
  function fittingMachines(login: Login, task: TaskRow, requireOutput = true): Machine[] {
    const declarations = executors[login.executor];
    return offeredMachines(login, task, requireOutput)
      .filter((machine) => fitsHere(reportOf(machine, login.executor), {
        readOnly: task.permission === 'read',
        ...(login.machine === undefined ? { account: true } : {}),
      }, declarations))
      .filter((machine) => login.machine === undefined || (ownLoginHere(reportOf(machine, login.executor)) && !options.signingIn?.(machine.id, login.executor)));
  }

  async function machineFor(login: Login, task: TaskRow, forContinuation = false): Promise<Machine | undefined> {
    const offered = fittingMachines(login, task);
    const fix = fixOf(task, pinOf(task));
    const machine = fix.kind === 'prefer'
      ? await runner.findMachine(login, offered, forContinuation, undefined, undefined, true)
      : await runner.findMachine(login, offered, forContinuation);
    // A Task fixed to one machine (a folder source, or a repository's later rounds) waits for
    // that machine; the owner already knows which one it is, so no login is reported short.
    if (!machine && fix.kind !== 'machine') shortOfMachines(login, task);
    return machine;
  }

  // §1.3: a spawned machine's ending, one fact at a time. Its quota's task ended, or its
  // instance was reported destroyed: it stops taking new work. Nothing of its runs any more
  // and none of its rounds ended unread: its evidence is all in. Idle and drained: told to
  // go, it leaves by itself; or, when its instance is already reported gone, its
  // registration ends here — there is nobody left to tell. Revoking the quota is not one of
  // these: that stops materials, not machines (nodes.md §9). What became of the instance is
  // never decided here — only the creating skill can say.
  const told = new Map<string, number>();
  function retireEphemeral(): void {
    const registered = ledger.ephemeralMachines();
    for (const id of told.keys()) if (!registered.some(({ machine }) => machine.id === id)) told.delete(id);
    for (const { machine, invite } of registered) {
      const task = invite === undefined ? undefined : ledger.getTask(invite.task_id);
      const over = task === undefined || task.state === 'done' || task.state === 'abandoned' || machine.destroyedAt !== undefined;
      if (machine.drainAt === undefined) {
        if (!over) continue;
        ledger.drainMachine(machine.id, DISPATCHER);
      }
      const rounds = ledger.roundsOn(machine.id);
      if (rounds.active > 0) continue;
      if (rounds.unread === 0 && machine.evidenceAt === undefined) ledger.confirmMachineEvidence(machine.id, DISPATCHER);
      // A registration that already ended (revoked, or left) had only its evidence to come.
      if (machine.leftAt !== undefined) continue;
      if (machine.destroyedAt !== undefined) {
        ledger.leaveMachine(machine.id, 'destroyed', DISPATCHER);
        continue;
      }
      // Told once, and again only after a while: the client leaves right after it answers,
      // and one that died before leaving is told again when it is back.
      const last = told.get(machine.id);
      if (options.retire === undefined || (last !== undefined && now() - last < RETIRE_AGAIN_MS)) continue;
      told.set(machine.id, now());
      options.retire(machine.id)
        .then((sent) => { if (!sent) told.delete(machine.id); })
        .catch((err: unknown) => {
          told.delete(machine.id);
          log(`让临时机器 ${machine.id} 自己注销没成（它不在，或没答）：${String(err)}`);
        });
    }
  }

  // Whether a Run may still be created or judged gone. Asked again after every wait on a
  // machine: a stop, a pause, degraded mode or an inventory may have begun meanwhile.
  const sending = (): boolean => !stopping.signal.aborted && ledger.dispatchConditions().canDispatch;

  const picking = () => ({
    now: now(),
    lead: options.frontLead(),
    warnAt: options.usageWarnAt(),
  });

  // Logical-account priority slots for this task's tier: project-level slot override first,
  // legacy linear project dispatch_order falls back to linear mode, otherwise global slots.
  function tierSlotsFor(task: Pick<TaskRow, 'tier' | 'project_id'>): TierDispatchSlots | undefined {
    if (task.tier === null || !isTierId(task.tier)) return undefined;
    if (task.project_id !== null) {
      if (typeof ledger.projectDispatchSlots === 'function') {
        const projSlots = ledger.projectDispatchSlots(task.project_id);
        if (projSlots?.[task.tier]) return projSlots[task.tier];
      }
      if (typeof ledger.projectDispatchOrder === 'function') {
        const projOrder = ledger.projectDispatchOrder(task.project_id);
        if (projOrder?.[task.tier] && projOrder[task.tier]!.length > 0) return undefined;
      }
    }
    return typeof ledger.dispatchSlots === 'function' ? ledger.dispatchSlots()?.[task.tier] : undefined;
  }

  function coveringAccountIdsFor(
    login: Login,
    states?: ReadonlyMap<string, { identity?: { organizationId?: string | null; quotaOwner?: string | null; accountLabel?: string | null } }>,
  ): string[] {
    if (!login.machine || !states) return [];
    const ownId = states.get(login.id)?.identity;
    const ownOrg = ownId?.organizationId?.trim() || null;
    const ownOwner = ownId?.quotaOwner?.trim() || null;
    if (!ownOrg && !ownOwner) return [];
    const coveredBy: string[] = [];
    for (const candidate of logins.list()) {
      if (candidate.machine !== undefined || candidate.executor !== login.executor) continue;
      const acctId = states.get(candidate.id)?.identity;
      if (!acctId) continue;
      const sameOrg = Boolean(ownOrg && acctId.organizationId?.trim() === ownOrg);
      const sameOwner = Boolean(ownOwner && acctId.quotaOwner?.trim() === ownOwner);
      if (sameOrg || sameOwner) coveredBy.push(candidate.id);
    }
    return coveredBy;
  }

  function slotOf(
    login: Login,
    tierSlots: TierDispatchSlots | undefined,
    states?: ReadonlyMap<string, { identity?: { routeLabel?: string | null; organizationId?: string | null; quotaOwner?: string | null; accountLabel?: string | null } }>,
    tier?: TierId | null,
  ): 1 | 2 | 'off' | undefined {
    if (!tierSlots) return undefined;
    const routeLabel = login.machine
      ? (states?.get(login.id)?.identity?.routeLabel ?? (typeof ledger.loginState === 'function' ? ledger.loginState(login.id)?.identity?.routeLabel : null))
      : null;
    const route = login.machine ? effectiveRouteOfLogin({ routeLabel, tiers: login.tiers }, tier) : null;
    const covering = coveringAccountIdsFor(login, states);
    return slotForLogin({ id: login.id, executor: login.executor, machine: login.machine, route }, tierSlots, covering, tier);
  }

  // The logins a Task may run as, in the tier's order (project override -> global default).
  // When a Task is fixed to one machine (folder source or task.machine_id), machine-local logins
  // belonging to other machines can never run it and are excluded up front.
  const allowedOf = (task: TaskRow): string[] => ledger.loginPool(task).ids;
  function compatibleWithFix(task: TaskRow, list: Login[]): Login[] {
    const fix = fixOf(task, pinOf(task));
    if (fix.kind !== 'machine') return list;
    return list.filter((login) => login.machine === undefined || login.machine === fix.machine.id);
  }
  function candidatesOf(task: TaskRow): Login[] {
    const raw = compatibleWithFix(task, candidateLogins(task, allowedOf(task), logins, executors, ledger.loginOrder(task.tier, task.project_id)));
    if (task.login_id !== null) return raw;
    const slots = tierSlotsFor(task);
    if (!slots) return raw;
    const tier = task.tier !== null && isTierId(task.tier) ? task.tier : null;
    const states = typeof ledger.loginStates === 'function' ? ledger.loginStates() : undefined;
    return raw.filter((login) => slotOf(login, slots, states, tier) !== 'off');
  }
  // A review's fallback: logins of the executors that wrote its product (including a pinned
  // writer login when explicitly requested).
  function fallbackOf(task: TaskRow): Login[] {
    if (task.login_id !== null) {
      const writers = excludedExecutors(task);
      const pinned = logins.get(task.login_id);
      if (pinned && writers.includes(pinned.executor) && (task.permission !== 'read' || readOnlyRefusal(pinned, executors) === undefined)) {
        return compatibleWithFix(task, [pinned]);
      }
      return [];
    }
    const raw = compatibleWithFix(task, sameExecutorReviewers(task, allowedOf(task), logins, executors, ledger.loginOrder(task.tier, task.project_id)));
    const slots = tierSlotsFor(task);
    if (!slots) return raw;
    const tier = task.tier !== null && isTierId(task.tier) ? task.tier : null;
    const states = typeof ledger.loginStates === 'function' ? ledger.loginStates() : undefined;
    return raw.filter((login) => slotOf(login, slots, states, tier) !== 'off');
  }

  // Those logins as they stand now: what runs on each, whether it rests, how much of
  // its quota is used. `without` are logins known to have no machine that answers;
  // `except` is a Run not to count, for the Task that waits to go on in its place.
  function standing(candidates: readonly Login[], without: ReadonlySet<string>, except?: string, tierSlots?: TierDispatchSlots, tier?: TierId | null): Candidate[] {
    const at = now();
    const active = ledger.listActiveRuns().filter((run) => run.id !== except);
    const states = ledger.loginStates();
    return candidates.map((login) => {
      const state = states.get(login.id);
      const rest = restingUntil(state, at);
      const used = usageNow(state, at).map((figure) => figure.used);
      const slot = slotOf(login, tierSlots, states, tier);
      return {
        id: login.id,
        active: active.filter((run) => run.login_id === login.id).length,
        ...(login.maxRuns === undefined ? {} : { maxRuns: login.maxRuns }),
        ...(rest === undefined ? {} : { restUntil: rest }),
        ...(used.length === 0 ? {} : { usage: Math.max(...used) }),
        noMachine: without.has(login.id),
        credentialMissing: logins.get(login.id)?.credential === 'missing',
        credentialRejected: loginRefused(state, ledger.accountCredentialRef(login.id)),
        ...(slot === 1 || slot === 2 ? { slot } : {}),
      };
    });
  }

  // The groups a Task's next Run is tried in, in order (roles-and-tiers.md §11.3). A review's
  // group order asks the ledger which executors have already reviewed this product; a pin has
  // one group, its login, so no preference or spread narrows it.
  function groupsOf(task: TaskRow, candidates: readonly Login[]): PlacementGroup[] {
    const reviewed = task.login_id !== null || task.review_of_json === null ? [] : ledger.spreadExecutorsOf(task);
    return placementGroups(task, candidates, reviewed);
  }

  function resumableAffinity(task: TaskRow, candidates: readonly Login[]): { login: Login; machine: Machine } | undefined {
    if (task.review_of_json !== null || task.knowledge_json !== null) return undefined;
    const runs = ledger.listRuns(task.id);
    if (runs.length === 0) return undefined;
    const rounds = runs.filter((run) => !neverStarted(run) && !workerNeverRan(run));
    const last = rounds.findLast((run) => typeof run.session_ref === 'string' && run.session_ref !== '');
    if (!last?.login_id) return undefined;
    const login = candidates.find((candidate) => candidate.id === last.login_id);
    if (!login) return undefined;
    const machine = machines.list().find((each) => runOnMachine(last, each));
    if (!machine) return undefined;
    const pin = pinOf(task);
    const sourceKey = pin ? bindingKey(pin.pinned) : undefined;
    const permission = task.permission ?? 'write';
    const ref = resumableSession(rounds, login, machine, executors, task.tier ?? undefined, permission, sourceKey, runs);
    return ref ? { login, machine } : undefined;
  }

  // The login and machine a Task's next Run goes to, or nothing when it has to wait:
  // every login of its is resting, at its ceiling or without a machine. For continuations
  // with a resumable session, first-try affinity goes to the previous round's (login, machine)
  // when usable so session context is preserved. Otherwise groups are tried in order.
  async function placeFor(
    task: TaskRow, candidates: readonly Login[], without: Set<string>, forContinuation = false, except?: string, grouped = true,
  ): Promise<{ login: Login; machine: Machine; placedBy: PlacedBy } | undefined> {
    if (grouped) {
      const affinity = resumableAffinity(task, candidates);
      if (affinity) {
        const currentStanding = standing([affinity.login], without, except)[0]!;
        if (usable(currentStanding, now())) {
          const fitting = fittingMachines(affinity.login, task);
          const matchingMachine = fitting.find((each) => each.id === affinity.machine.id && each.uid === affinity.machine.uid);
          if (matchingMachine) {
            const probed = await runner.findMachine(
              affinity.login,
              [matchingMachine],
              forContinuation,
              undefined,
              undefined,
              true,
            );
            if (probed) {
              const after = standing([affinity.login], without, except)[0]!;
              if (usable(after, now())) {
                return { login: affinity.login, machine: probed, placedBy: task.login_id !== null ? 'pinned' : 'order' };
              }
            }
          }
        }
      }
    }
    const groups: PlacementGroup[] = grouped ? groupsOf(task, candidates) : [{ logins: [...candidates], placedBy: 'order' }];
    const slots = task.login_id === null ? tierSlotsFor(task) : undefined;
    const tier = task.tier !== null && isTierId(task.tier) ? task.tier : null;
    for (const { logins: group, placedBy } of groups) {
      for (;;) {
        const choice = pickLogin(standing(group, without, except, slots, tier), picking());
        if ('wait' in choice) break;
        const login = group.find(({ id }) => id === choice.pick)!;
        const machine = await machineFor(login, task, forContinuation);
        if (!machine) {
          without.add(login.id);
          continue;
        }
        const after = standing([login], without, except)[0]!;
        if (usable(after, now())) return { login, machine, placedBy };
      }
    }
    return undefined;
  }

  // Every non-writer reviewer must be genuinely unavailable (offline/resting/missing_credential/rejected)
  // before falling back to sameExecutorReviewers. If any non-writer reviewer is merely busy
  // (outReason === undefined), return undefined so the review waits for an independent reviewer.
  function othersOut(candidates: readonly Login[], without: ReadonlySet<string>, except?: string): string[] | undefined {
    const at = now();
    const statuses = standing(candidates, without, except);
    const reasons: string[] = [];
    for (const candidate of statuses) {
      const reason = outReason(candidate, at);
      if (reason === undefined) return undefined;
      const name = logins.get(candidate.id)?.name ?? candidate.id;
      reasons.push(otherOutText(
        name, reason,
        candidate.restUntil === undefined ? undefined : new Date(candidate.restUntil).toISOString(), new Date(at),
      ));
    }
    return reasons;
  }

  // The logins a Task's next Run is picked from: its own, and for a review whose other
  // executors have no usable/busy login left, those of the executors that wrote its product as well.
  function poolOf(task: TaskRow, without: ReadonlySet<string>, except?: string): Login[] {
    const candidates = candidatesOf(task);
    const fallback = fallbackOf(task);
    return fallback.length > 0 && othersOut(candidates, without, except) !== undefined ? [...candidates, ...fallback] : candidates;
  }

  // Where a Task's next Run goes. Prefers non-writer logins; falls back to same-executor reviewers
  // ONLY when every non-writer reviewer is genuinely unavailable (never when merely busy).
  async function placeTask(
    task: TaskRow, candidates: readonly Login[], without: Set<string>, forContinuation = false, except?: string,
  ): Promise<{ login: Login; machine: Machine; placedBy: PlacedBy; sameExecutor?: SameExecutor } | undefined> {
    const place = candidates.length === 0 ? undefined : await placeFor(task, candidates, without, forContinuation, except);
    if (place) return place;
    const fallback = fallbackOf(task);
    if (fallback.length === 0) return undefined;
    const out = othersOut(candidates, without, except);
    if (out === undefined) return undefined;
    const second = await placeFor(task, fallback, without, forContinuation, except, false);
    if (!second) return undefined;
    return { ...second, placedBy: 'same_executor', sameExecutor: { executor: second.login.executor, reason: sameExecutorText(second.login.executor, out) } };
  }

  // §4: a Run out of contact past the grace period is judged at the moment its
  // continuation could be sent, so only when a machine is there to send it to. One a
  // round: the judgment is a last probe of a machine that has not been answering. A
  // candidate still unknown after its turn goes behind the others, so that one Run
  // nothing can be said about does not keep the rest from theirs.
  async function continueLost(): Promise<void> {
    const candidates = runner.lostCandidates();
    for (const id of passed.keys()) if (!candidates.some((run) => run.id === id)) passed.delete(id);
    candidates.sort((a, b) => (passed.get(a.id) ?? 0) - (passed.get(b.id) ?? 0));
    for (const run of candidates) {
      // Somewhere the continuation could go: a login of the Task that can take a Run,
      // not counting the one being judged, with a machine that answers now. Asked for
      // each candidate afresh: the judgment is final, and so is what it is made on.
      const task = ledger.getTask(run.task_id);
      // No role and no login: no candidate could ever be found. The old round is left as
      // it is, not judged gone, and the Router is told once what would let it go on.
      if (needsRoleToPlace(task)) {
        ledger.reportLostWithoutRole(run.id);
        continue;
      }
      // A paused project starts nothing new (project-sessions §5): the old round is left as it
      // is, judged and continued once the project resumes.
      if (ledger.projectPaused(task.project_id)) continue;
      if (!(await placeTask(task, candidatesOf(task), new Set(), true, run.id))) continue;
      if (!sending()) return;
      try {
        const verdict = await runner.presume(run, sending);
        log(`Run ${run.id} 失联超过宽限期，接续前再核实一次：${verdict}`);
      } catch (err) {
        log(`Run ${run.id} 接续前的核实出错：${String(err)}`);
      }
      if (ledger.getRun(run.id).state === 'unknown') passed.set(run.id, (turns += 1));
      return;
    }
  }

  // The logins known to have no machine that answers for this Task's project.
  const starvedFor = (task: TaskRow): Set<string> =>
    new Set([...starved].filter(([, wait]) => wait.projects.has(task.project_id)).map(([id]) => id));

  // Logins with work that needs a machine: a queued Task, or a Run waiting to be
  // judged so that its Task can go on.
  function loginsWithWork(): Map<string, Set<string | null>> {
    const waiting = runner.lostCandidates().map((run) => ledger.getTask(run.task_id));
    const wanted = new Map<string, Set<string | null>>();
    for (const task of [...ledger.queuedTasks(), ...waiting]) for (const {id} of poolOf(task, starvedFor(task))) {
      const projects = wanted.get(id) ?? new Set<string | null>();
      projects.add(task.project_id);
      wanted.set(id, projects);
    }
    return wanted;
  }

  // Creates the Run a prepared Round goes into, and starts it. Whatever launch did, the
  // Run exists from here on and only the watcher can resolve it.
  async function createAndLaunch(
    task: TaskRow, login: Login, machine: Machine, snapshot: Snapshot, sameExecutor: SameExecutor | undefined, placedBy: PlacedBy,
  ): Promise<void> {
    let run: RunRow;
    try {
      run = ledger.createRun(task.id, { login, machine, snapshot, expectedRevision: task.revision, placedBy, ...(sameExecutor ? { sameExecutor } : {}) }, DISPATCHER);
    } catch (err) {
      // Pause, a new revision, a move out of queued or a change to the login arrived
      // since the reads above: the Task stays queued and the next round picks again.
      if (!(err instanceof InputError)) throw err;
      log(`任务 ${task.id} 本轮未派发：${err.message}`);
      return;
    }
    try {
      await runner.launch(run);
    } catch (err) {
      log(`Run ${run.id} 启动出错：${String(err)}`);
    }
    follow(run);
    // A machine that answers the probe and takes no upload is no machine to work on:
    // the login stays short of them until a start gets past its upload.
    if (neverStarted(ledger.getRun(run.id))) shortOfMachines(login, task);
    else {
      const waiting = starved.get(login.id);
      waiting?.projects.delete(task.project_id);
      if (waiting?.projects.size === 0) starved.delete(login.id);
    }
  }

  async function dispatchOne(): Promise<void> {
    for (const task of ledger.queuedTasks()) {
      const without = new Set<string>();
      const candidates = candidatesOf(task);
      // Waiting will not fix a Task that cannot be prepared, and left queued it would
      // block the queue.
      const hold = (reason: string): void => ledger.holdTask(task.id, `派发失败：${reason}`, DISPATCHER);
      // A knowledge Task is read-only by structure and goes only where every project of its
      // material allows (knowledge §3): on a role turned writable, or with projects that share
      // no machine, it stops and says so rather than wait for what cannot come.
      // A pin outside the Task's logins (the list narrowed after it was made) stops it the same way.
      const writable = task.knowledge_json === null || task.role_id === null ? undefined : knowledgeRoleRefusal(ledger.getRole(task.role_id));
      const range = ledger.machineRange(task);
      const unpinned = task.login_id === null ? undefined : ledger.loginRefusal(task, task.login_id);
      // The source the Task is pinned to, as the project holds it now: a source taken out of
      // the list, or a machine that registration has left, stops the Task with the reason.
      const pin = pinOf(task);
      const stuck = writable ?? ('conflict' in range ? range.conflict : undefined) ?? (unpinned === undefined ? undefined : `${unpinned}：改钉别的登录，或者取消钉住`) ?? sourceStop(task, pin, range);
      if (stuck !== undefined) {
        ledger.holdTask(task.id, stuck, DISPATCHER);
        return;
      }
      const binding = parseReviewOf(task.review_of_json);
      // A review no login of another executor can take falls back to the executors that wrote
      // its product, in a new session (§4 ②): only with neither does it stop.
      const fallback = fallbackOf(task);
      // A review with nobody eligible stops and says who wrote the product: the Router
      // cannot widen that, only the owner can accept without review (§4 ②). Asked of the
      // logins before the read-only cut, so that the reason is the one that holds.
      const readOnly = task.permission === 'read';
      const reviewers = readOnly ? candidateLogins({ ...task, permission: 'write' }, allowedOf(task), logins, executors, ledger.loginOrder(task.tier, task.project_id)) : candidates;
      if (reviewers.length === 0 && binding !== null && fallback.length === 0) {
        ledger.holdTask(task.id, noReviewerText(binding.writers, task.tier), DISPATCHER);
        return;
      }
      // A knowledge gate prefers another executor, and falls back to a fresh independent session
      // on the writer's executor when no other eligible executor exists (matching code review).
      const gateWriters = binding === null ? excludedExecutors(task) : [];
      if (reviewers.length === 0 && gateWriters.length > 0 && fallback.length === 0) {
        ledger.holdTask(task.id, noGateKeeperText(gateWriters), DISPATCHER);
        return;
      }
      const readers = [...candidates, ...fallback];
      if (readers.length === 0) {
        const fix = fixOf(task, pin);
        hold(task.login_id === null
          ? (fix.kind === 'machine'
            ? `没有能在机器 ${fix.machine.id} 上跑的可用登录：项目允许的登录里既没有带档位 ${task.tier ?? '（未选）'} 的托管账号，也没有 ${fix.machine.id} 本机登录`
            : `没有可用的登录：项目允许的登录里没有带档位 ${task.tier ?? '（未选）'} 的`)
          : `没有可用的登录：${logins.get(task.login_id)?.name ?? '指定的登录已删除，请重新选择'}`);
        return;
      }
      const place = await placeTask(task, candidates, without);
      // The probes took as long as the machines liked.
      if (!sending()) return;
      // Its logins rest, are at their ceiling or have no machine: it waits in the queue,
      // and Tasks behind it that can go elsewhere still go.
      if (!place) continue;
      const { login, machine, sameExecutor, placedBy } = place;
      const runs = ledger.listRuns(task.id);
      // The snapshot is made before the Run exists: a source the round cannot be told about
      // — a value the executor would drop — is a Task held with the reason, never a Round
      // that starts without the code it was promised.
      let snapshot: Snapshot;
      try {
        snapshot = prepare(task, login, machine, runs, snapshotSourceFor(task, pin));
      } catch (err) {
        hold((err as Error).message);
        return;
      }
      await createAndLaunch(task, login, machine, snapshot, sameExecutor, placedBy);
      return;
    }
  }

  // Also repairs a watcher that died on a failed write. A Run whose login was removed
  // is followed too: its watcher is what settles it as lost.
  function watchActive(): void {
    for (const run of ledger.listActiveRuns()) follow(run);
  }

  async function tick(): Promise<void> {
    const { degraded, recovering } = ledger.dispatchConditions();
    if (degraded || recovering) return;
    ledger.fireDueWakes();
    watchActive();
    // Not awaited: a sweep takes as long as the stops it sends.
    sweeping ??= runner
      .sweep()
      .catch((err: unknown) => log(`重连清理出错：${String(err)}`))
      .finally(() => {
        sweeping = undefined;
      });
    if (!ledger.dispatchConditions().canDispatch) return;
    retireEphemeral();
    await continueLost();
    if (sending()) await dispatchOne();
    // A login stays in the record for as long as work waits on it, whether or not this
    // round got as far as asking about it: a round dispatches one Task and stops.
    const wanted = loginsWithWork();
    for (const [id, waiting] of starved) {
      if (logins.get(id)?.credential === 'missing' || loginRefused(ledger.loginState(id), ledger.accountCredentialRef(id))) { starved.delete(id); continue; }
      for (const project of waiting.projects) if (!wanted.get(id)?.has(project)) waiting.projects.delete(project);
      if (waiting.projects.size === 0) starved.delete(id);
    }
  }

  async function runLoop(): Promise<void> {
    while (!stopping.signal.aborted) {
      try {
        await tick();
      } catch (err) {
        log(`派发循环出错：${String(err)}`);
      }
      await sleep(intervalMs, undefined, { signal: stopping.signal }).catch(() => {});
    }
  }

  return {
    tick,
    watchActive,

    waitingLogins: (): WaitingLogin[] =>
      [...starved].map(([id, { since }]) => ({
        login_id: id,
        login_name: logins.get(id)?.name ?? '已删除的登录',
        since: new Date(since).toISOString(),
        overdue: now() - since >= graceMs(),
      })),

    // What a Task in the queue, or one whose Run is out of contact, is waiting for when
    // none of its logins can take it now; null when one can, and the next rounds take it up.
    waitOf(task: TaskRow): Wait | null {
      if (task.state !== 'queued' && task.state !== 'needs_verification') return null;
      // A paused project's Task waits for the resume, not for a login: no login's state is its reason.
      if (ledger.projectPaused(task.project_id)) return null;
      const held = task.state === 'queued' ? undefined : ledger.listActiveRuns().find((run) => run.task_id === task.id)?.id;
      const without = starvedFor(task);
      const pool = poolOf(task, without, held);
      if (pool.length === 0) return { rest: null, full: [], no_machine: [], no_candidate: true };
      // A Task fixed to one machine waits for that machine alone: a folder source's machine
      // named by the owner, or the machine a repository round's checkout is on. And work
      // waits while the machines it could go to speak another protocol (shared/node-protocol.ts).
      const fix = fixOf(task, pinOf(task));
      const offline = fix.kind === 'machine' && options.connected !== undefined && !options.connected(fix.machine.id) ? fix.machine.id : undefined;
      const outdated = [...new Set(pool.flatMap((login) => offeredMachines(login, task)
        .filter((machine) => options.refusedProtocol?.(machine.id) ?? false).map((machine) => machine.id)))];
      const statuses = standing(pool, without, held);
      const pick = picking();
      // A remembered machine shortage may itself be output admission. Keep every other
      // login restriction when comparing paths; choice still keeps its no_machine reason.
      const open = new Set(statuses.filter(candidate => usable({ ...candidate, noMachine: false }, pick.now)).map(candidate => candidate.id));
      const paths = pool.filter(login => open.has(login.id)).flatMap(login => fittingMachines(login, task, false))
        .filter(machine => options.connected?.(machine.id) !== false && options.refusedProtocol?.(machine.id) !== true);
      const outputWaiting = paths.length > 0 && paths.every(machine => options.outputReady?.(machine.id) !== true)
        ? [...new Set(paths.map(machine => machine.id))] : [];
      const choice = pickLogin(statuses, pick);
      if (!('wait' in choice)) {
        return offline === undefined && outdated.length === 0 && outputWaiting.length === 0
          ? null
          : { rest: null, full: [], no_machine: [], ...(outputWaiting.length ? { output_waiting: outputWaiting } : {}), ...(offline === undefined ? {} : { source_offline: offline }), ...(outdated.length === 0 ? {} : { outdated }) };
      }
      const name = (id: string): string => logins.get(id)?.name ?? '已删除的登录';
      const wait = choice.wait;
      return { ...wait, ...(outputWaiting.length?{output_waiting:outputWaiting}:{}), full: wait.full.map(name), no_machine: wait.no_machine.map(name),
        ...(wait.rejected ? { rejected: wait.rejected.map(name) } : {}),
        ...(wait.missing_credentials ? { missing_credentials: wait.missing_credentials.map(name) } : {}),
        ...(offline === undefined ? {} : { source_offline: offline }),
        ...(outdated.length === 0 ? {} : { outdated }),
        rest: wait.rest ? { ...wait.rest, login: name(wait.rest.login) } : null };
    },

    start(): void {
      loop = runLoop();
    },

    async stop(): Promise<void> {
      stopping.abort();
      await loop;
      await Promise.allSettled([...watchers.values(), sweeping]);
    },
  };
}
