// What a release has to prove before it counts as one, and what to do when it cannot.
// The check is made from outside the service that answers it: a version and a directory
// it reports, its own account of its ledger and its recovery barrier, the console it
// serves, and a window in which the same process has to go on answering. The gateway,
// the machines and a channel nobody configured are not asked about: a release that
// need not fail because they are unavailable; unfinished recovery is still unverified.
import { setTimeout as sleep } from 'node:timers/promises';
import { incompleteReleaseLine } from '../shared/labels.ts';
import type { LedgerPeek } from '../service/ledger-peek.ts';
import type { ReleaseFacts, Running, StartFailure } from './service-client.ts';
import { consoleAsset, consolePage, consoleSession, coreReads, instanceAt, releaseFacts, serviceState } from './service-client.ts';
import type { Timing } from './system.ts';

interface ReleaseTarget {
  version: string;
  // The version directory this release is, as the file system spells it.
  programDir: string;
  dataDir: string;
}

interface ReleaseCheck {
  ok: boolean;
  // External recovery can outlast the check without proving a candidate bad or healthy.
  pending?: string[];
  // What the pending steps are about. The two are finished differently and said differently:
  // a recovery inventory is answered by external machines, a candidate's own start by waiting
  // and then looking with `tycho status`.
  pendingFrom?: 'recovery' | 'start';
  // One line per thing tried, in the order they were: what passed, and what did not.
  lines: string[];
}

// What the page names that it expects to be served from the service itself.
const LOCAL_REF = /(?:src|href)\s*=\s*"([^"]+)"/g;

export function consoleAssets(html: string): string[] {
  const found = new Set<string>();
  for (const [, ref] of html.matchAll(LOCAL_REF)) if (ref.startsWith('/')) found.add(ref);
  return [...found];
}

const fold = (path: string): string => {
  const trimmed = path.replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? trimmed.toLowerCase() : trimmed;
};

export const samePath = (a: string, b: string): boolean => fold(a) === fold(b);

const seconds = (ms: number): string => `${(ms / 1000).toFixed(ms % 1000 === 0 ? 0 : 1)} 秒`;

// A candidate that has taken the data directory and has not answered: still on its way up, or
// in a state this machine cannot judge at all. The wait was the CLI's own patience, and neither
// end of it is a release that failed — one may answer in a moment, and the other is not known to
// be bad. Neither is a release that works, either, and neither may be taken back. What the
// command says about it is `releaseOutcomeLine`, which reads `pendingFrom`.
export function unfinishedStart(version: string, came: Extract<StartFailure, { state: 'starting' | 'unknown' }>): ReleaseCheck {
  const pending = came.state === 'starting'
    ? [`新版本还在启动（进程 ${came.pid}），还没有回答`]
    : [`查不出新版本是还在启动还是已经退出：${came.why}`];
  return { ok: false, pending, pendingFrom: 'start', lines: [`tycho ${version} 还没有核对完：${pending.join('；')}`] };
}

// Every step is answered by the candidate itself where the candidate is what is in
// question: a check that only read the files would call a service that cannot open its
// ledger healthy.
export async function checkRelease(timing: Timing, target: ReleaseTarget): Promise<ReleaseCheck> {
  const lines: string[] = [];
  const failed = (line: string): ReleaseCheck => ({ ok: false, lines: [...lines, line] });
  const passed = (line: string): void => {
    lines.push(line);
  };

  const state = await serviceState(target.dataDir);
  if (state.state !== 'running') {
    const why = state.state === 'held' ? `数据目录被进程 ${state.pid} 占着，但它没有回答` : '没有在运行';
    return failed(`服务${why}`);
  }
  passed(`服务在运行（进程 ${state.pid}，端口 ${state.port}）`);

  const first: Running = state;
  if (first.version !== target.version) return failed(`服务报的版本是 ${first.version || '（空）'}，要的是 ${target.version}`);
  if (!samePath(first.programDir, target.programDir)) return failed(`服务跑的程序目录是 ${first.programDir}，要的是 ${target.programDir}`);
  if (!samePath(first.dataDir, target.dataDir)) return failed(`服务用的数据目录是 ${first.dataDir}，要的是 ${target.dataDir}`);
  passed(`版本 ${target.version}，程序目录和数据目录都对`);

  let facts: ReleaseFacts;
  const refresh = async (): Promise<ReleaseCheck | null> => {
    try {
      facts = await releaseFacts(first);
    } catch (err) {
      return failed(`问不出服务自己的状态：${(err as Error).message}`);
    }
    if (facts.ledger !== 'ok') return failed(`账本读不了：${facts.ledger}`);
    if (facts.degraded) return failed('账本写不进去，服务在降级模式：新版本会一直不接活');
    return null;
  };
  const initialProblem = await refresh();
  if (initialProblem) return initialProblem;
  // Recovery asks external machines. Its timeout leaves verification incomplete;
  // a ledger failure during the wait is still a candidate failure.
  const waitUntil = Date.now() + facts!.recoveryWaitMs;
  while (facts!.recovering && Date.now() < waitUntil) {
    await sleep(Math.min(1_000, Math.max(1, waitUntil - Date.now())));
    const problem = await refresh();
    if (problem) return problem;
  }

  // The pages are read the way a browser reads them, through a real login: a check that
  // asked for them without one would pass on a service whose sign-in is broken.
  const session = await consoleSession(target.dataDir, first);
  if ('problem' in session) return failed(`控制台登录走不通：${session.problem}`);
  passed('登录换到了控制台会话');

  let page: { status: number; body: string };
  try {
    page = await consolePage(first.port, session.cookie);
  } catch (err) {
    return failed(`控制台页面取不到：${(err as Error).message}`);
  }
  if (page.status !== 200 || !/<html/i.test(page.body)) return failed(`登录后控制台页面不对（${page.status}）`);
  const assets = consoleAssets(page.body);
  if (assets.length === 0) return failed('控制台页面里没有指向任何资源的地址');
  for (const asset of assets) {
    try {
      const served = await consoleAsset(first.port, asset, session.cookie);
      if (served.status !== 200 || served.bytes === 0) return failed(`控制台资源 ${asset} 取不到（${served.status}）`);
    } catch (err) {
      return failed(`控制台资源 ${asset} 取不到：${(err as Error).message}`);
    }
  }
  passed(`控制台资源能加载（页面加 ${assets.length} 个资源）`);

  const unread = await coreReads(first.port, session.cookie);
  if (unread.length > 0) return failed(`控制台要读的接口读不了：${unread.join('；')}`);
  passed('核心接口能读（消息、任务、总览）');

  const windowMs = facts!.healthWindowMs;
  const until = Date.now() + windowMs;
  while (Date.now() < until) {
    await sleep(Math.min(timing.pollMs, Math.max(1, until - Date.now())));
    const now = await instanceAt(first.port, first.token);
    if (now === null) return failed(`观察期间服务不再回答（进程 ${first.pid}）`);
    if (now.pid !== first.pid || now.startedAt !== first.startedAt) return failed(`观察期间服务重启过（进程 ${first.pid} 变成了 ${now.pid}）`);
    const problem = await refresh();
    if (problem) return problem;
  }
  // The page and core reads can race a failed ledger write even with no window.
  const finalProblem = await refresh();
  if (finalProblem) return finalProblem;
  passed('账本能开');
  passed('账本没有处于降级模式');
  passed(windowMs <= 0 ? '没有设置观察时长，没有观察' : `观察 ${seconds(windowMs)}，没有重启`);
  if (facts!.recovering) {
    const pending = ['恢复清点尚未完成'];
    passed(`${incompleteReleaseLine(target.version, pending)}。没有因清点超时回退。`);
    return { ok: false, pending, pendingFrom: 'recovery', lines };
  }
  passed('恢复清点已完成');
  return { ok: true, lines };
}

// ---- Whether to put the previous version back ----

interface RollbackFacts {
  // What `current` named before this release was switched to.
  previous: string | null;
  // The candidate, as it stands after being asked to stop.
  candidate: { running: boolean; pid: number | null };
  // The Router driver the ledger recorded, as it was found: the processes still carrying
  // its marker, and its recorded pid when that one is alive. Null when none of it is left.
  // A pid written as gone does not say that: the marker is what ownership rests on.
  driver: { marker: string; pids: number[] } | null;
  ledger: { before: LedgerPeek; now: LedgerPeek };
}

type Rollback = { go: true } | { go: false; why: string };

// Only for a release the program itself can take back. The ledger is the reason for
// every condition: the old program may not be able to open what the new one wrote, and
// two writers on one ledger is the thing the whole design keeps out.
export function rollbackDecision({ previous, candidate, driver, ledger }: RollbackFacts): Rollback {
  if (previous === null) return { go: false, why: '这是第一次安装，没有上一版可退' };
  if (candidate.running) {
    return { go: false, why: `候选服务${candidate.pid === null ? '' : `（进程 ${candidate.pid}）`}没有停下来：它可能还在写账本，不能换成旧版程序` };
  }
  if (!ledger.before.known || !ledger.now.known) {
    const why = !ledger.before.known ? ledger.before.error : (ledger.now as { error: string }).error;
    return { go: false, why: `读不出账本现在的样子（${why}）：不能确认它没有变过` };
  }
  if (ledger.before.version !== ledger.now.version) {
    return {
      go: false,
      why: `账本已经从版本 ${ledger.before.version ?? '（没有账本）'} 变成 ${ledger.now.version ?? '（没有账本）'}，${previous} 可能打不开它`,
    };
  }
  if (driver !== null) {
    return { go: false, why: `负责人驱动者还有进程在跑（标记 ${driver.marker}，pid ${driver.pids.join('、')}）：它可能还在写账本，停掉它之后再上线` };
  }
  return { go: true };
}

const ROLLED_BACK = '已经退回';
const NOT_ROLLED_BACK = '没有退回原来的版本';

// What a release that went in but was never started is, in the command's output and in
// the record alike: a version in place is not a version that works, and only a service
// stopped and started again can say which one it is. `running` is true when a service of
// this installation is still running the version before it — there is something to
// restart, and that is what will use the new one.
export function unverifiedLine(version: string, running: boolean): string {
  return `装上了 tycho ${version}，但这一版还没有验证：这次没有把在跑的服务换到它上面，也就没有做健康检查，下次启动才生效。`
    + (running ? '在跑的服务还是原来那一版：停掉它（tycho stop）再重新启动，就会用上这一版。' : '');
}

// What is said after the switch, once everything that could not be done is listed.
export function releaseOutcomeLine(outcome: ReleaseOutcome, version: string, previous: string | null): string {
  const next = '用 tycho doctor 看现场，用 tycho service status 看服务。';
  if (outcome.check.pending?.length) {
    if (outcome.check.pendingFrom === 'start') {
      return `tycho ${version} 还没有核对完：${outcome.check.pending.join('；')}。没有回退，也没有判它坏：用 tycho status 看它现在怎么样。`;
    }
    return `${incompleteReleaseLine(version, outcome.check.pending)}。没有因清点超时回退。${next}`;
  }
  if (outcome.rollback === null) return `新版 ${version} 通过了健康检查，没有回退；上面的事要自己处理。${next}`;
  if (outcome.rollback.state === 'rolled-back') {
    return `${ROLLED_BACK} ${previous ?? ''}${outcome.rollback.why === '' ? '' : `（${outcome.rollback.why}）`}，账本没有动。${next}`;
  }
  return `${NOT_ROLLED_BACK}：${outcome.rollback.why}。${next}`;
}

export interface ReleaseOutcome {
  // The health check as it ended, and what was done about it. `rollback` is null when
  // the release passed or recovery left verification incomplete.
  check: ReleaseCheck;
  rollback: { state: 'rolled-back' | 'kept'; why: string } | null;
  from: string | null;
  to: string;
}
