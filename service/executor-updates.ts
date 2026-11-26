// Host-side Multi-Machine CLI Fleet Update coordinator:
//   Layer 1: Lightweight in-memory upstream latest-version cache (zero disk cache files).
//   Layer 2: Idle-safe remote upgrade queue over Host -> Node `update_executor` command,
//            with double-layered idle checks (Host active runs + Node releaseBusy) and
//            immediate post-update executor re-probe ingestion.
//   Layer 3: Optional scheduled auto-update policy (off by default, per-executor opt-in,
//            maintenance hour window, concise upgrade notifications).
import type { NodeExecutorReport, NodeRunSummary, NodeUpdateExecutorResult } from '../shared/node-protocol.ts';
import {
  EXECUTOR_UPDATE_HISTORY_MAX,
  EXECUTOR_UPDATE_OUTPUT_MAX_CHARS,
  highestSemver,
  inMaintenanceWindow,
  isVersionBehind,
  jobKey,
  normalizeExecutorAutoUpdatePolicy,
  type ExecutorAutoUpdatePolicy,
  type ExecutorFleetStatus,
  type ExecutorUpdateJobView,
  type ExecutorUpdateTrigger,
  type UpstreamVersionInfo,
} from '../shared/executor-updates.ts';
import { ulid } from './ids.ts';
import type { Ledger } from './ledger.ts';
import type { Machines } from './machines.ts';
import type { Nodes } from './nodes.ts';
import type { Notify } from './notify.ts';

const UPSTREAM_TTL_MS = 6 * 60 * 60 * 1000; // 6h in-memory TTL
const UPSTREAM_TIMEOUT_MS = 8_000;
const IDLE_POLL_MS = 10_000;
const AUTO_SCHEDULER_TICK_MS = 15 * 60 * 1000; // 15m check cadence
const UPDATE_COMMAND_TIMEOUT_MS = 210_000;
const UPDATE_NODE_TIMEOUT_MS = 180_000;

interface UpstreamSource {
  source: string;
  url: string;
  parse: (body: string) => string | null;
}

const npmLatest = (pkg: string): UpstreamSource => ({
  source: `npm:${pkg}`,
  url: `https://registry.npmjs.org/${encodeURIComponent(pkg)}/latest`,
  parse: (body) => {
    const parsed = JSON.parse(body) as { version?: unknown };
    return typeof parsed.version === 'string' && parsed.version.trim() !== '' ? parsed.version.trim() : null;
  },
});

const UPSTREAM_SOURCES: Record<string, UpstreamSource> = {
  codex: npmLatest('@openai/codex'),
  claude: npmLatest('@anthropic-ai/claude-code'),
};

export interface ExecutorUpdatesOptions {
  ledger: Pick<Ledger, 'executorAutoUpdatePolicy' | 'setExecutorAutoUpdatePolicy' | 'listActiveRuns'>;
  machines: Pick<Machines, 'list'>;
  nodes: Pick<Nodes, 'connected' | 'reportedExecutors' | 'reportedRuns' | 'send' | 'noteExecutors'>;
  notify?: Pick<Notify, 'executorUpdated'>;
  onChanged?: () => void;
  fetch?: typeof fetch;
  now?: () => number;
  log?: (line: string) => void;
  recovering?: () => boolean;
}

export function createExecutorUpdates({
  ledger,
  machines,
  nodes,
  notify,
  onChanged,
  fetch: doFetch = fetch,
  now = Date.now,
  log = (line) => console.error(line),
  recovering = () => false,
}: ExecutorUpdatesOptions) {
  const upstream = new Map<string, UpstreamVersionInfo>();
  const activeByKey = new Map<string, ExecutorUpdateJobView>();
  const history: ExecutorUpdateJobView[] = [];
  const inFlightKeys = new Set<string>();
  let upstreamInFlight: Promise<void> | null = null;
  let lastAutoCheckAt = 0;
  let idleTimer: NodeJS.Timeout | undefined;
  let schedulerTimer: NodeJS.Timeout | undefined;
  let started = false;
  let stopped = false;

  const isoNow = (): string => new Date(now()).toISOString();

  function recordJob(job: ExecutorUpdateJobView): void {
    activeByKey.set(jobKey(job.machine_id, job.executor), job);
    const idx = history.findIndex((item) => item.id === job.id);
    if (idx >= 0) history[idx] = job;
    else history.unshift(job);
    if (history.length > EXECUTOR_UPDATE_HISTORY_MAX) {
      history.length = EXECUTOR_UPDATE_HISTORY_MAX;
    }
    onChanged?.();
  }

  function isMachineBusy(machineId: string): boolean {
    const reported: NodeRunSummary[] | null = nodes.reportedRuns(machineId);
    if (reported && reported.some((run) => run.alive !== false)) return true;
    try {
      const runs = ledger.listActiveRuns();
      return runs.some((run) =>
        run.machine_id === machineId
        && (run.state === 'launching' || run.state === 'running' || run.state === 'stopping'),
      );
    } catch {
      return false;
    }
  }

  function trimOutput(text: string | undefined): string | null {
    if (!text) return null;
    const trimmed = text.trim();
    if (!trimmed) return null;
    if (trimmed.length <= EXECUTOR_UPDATE_OUTPUT_MAX_CHARS) return trimmed;
    return `…${trimmed.slice(-EXECUTOR_UPDATE_OUTPUT_MAX_CHARS)}`;
  }

  async function refreshUpstream(force = false): Promise<Record<string, UpstreamVersionInfo>> {
    const nowMs = now();
    const stale = force || Object.keys(UPSTREAM_SOURCES).some((exec) => {
      const cached = upstream.get(exec);
      return !cached || (nowMs - Date.parse(cached.checked_at)) > UPSTREAM_TTL_MS;
    });
    if (!stale) return Object.fromEntries(upstream.entries());

    if (upstreamInFlight) {
      await upstreamInFlight;
      return Object.fromEntries(upstream.entries());
    }

    upstreamInFlight = (async () => {
      await Promise.all(Object.entries(UPSTREAM_SOURCES).map(async ([executor, spec]) => {
        const checkedAt = isoNow();
        try {
          const response = await doFetch(spec.url, {
            headers: { accept: 'application/json' },
            signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
          });
          if (!response.ok) {
            const prev = upstream.get(executor);
            upstream.set(executor, {
              executor,
              latest: prev?.latest ?? null,
              source: spec.source,
              checked_at: checkedAt,
              error: `查询上游版本失败（HTTP ${response.status}）`,
            });
            return;
          }
          const latest = spec.parse(await response.text());
          upstream.set(executor, {
            executor,
            latest,
            source: spec.source,
            checked_at: checkedAt,
            error: latest ? null : '上游返回中未找到版本号',
          });
        } catch (err) {
          const prev = upstream.get(executor);
          upstream.set(executor, {
            executor,
            latest: prev?.latest ?? null,
            source: spec.source,
            checked_at: checkedAt,
            error: `无法访问上游源（${err instanceof Error ? err.message : String(err)}）`,
          });
        }
      }));
      onChanged?.();
    })().finally(() => {
      upstreamInFlight = null;
    });

    await upstreamInFlight;
    return Object.fromEntries(upstream.entries());
  }

  function ensureIdleTimer(): void {
    if (idleTimer || stopped) return;
    const hasWaiting = [...activeByKey.values()].some((job) => job.state === 'waiting_idle');
    if (!hasWaiting) return;
    idleTimer = setTimeout(() => {
      idleTimer = undefined;
      void pumpWaitingJobs();
    }, IDLE_POLL_MS);
    idleTimer.unref();
  }

  async function executeJob(job: ExecutorUpdateJobView): Promise<void> {
    const key = jobKey(job.machine_id, job.executor);
    if (inFlightKeys.has(key) || stopped) return;
    if (!nodes.connected(job.machine_id)) {
      recordJob({
        ...job,
        state: 'failed',
        error: '机器当前离线，无法执行更新',
        finished_at: isoNow(),
      });
      return;
    }
    if (isMachineBusy(job.machine_id)) {
      if (job.state !== 'waiting_idle') {
        recordJob({ ...job, state: 'waiting_idle', error: null });
      }
      ensureIdleTimer();
      return;
    }

    inFlightKeys.add(key);
    const running: ExecutorUpdateJobView = { ...job, state: 'updating', error: null };
    recordJob(running);

    try {
      const raw = await nodes.send(
        job.machine_id,
        { kind: 'update_executor', executor: job.executor, timeout_ms: UPDATE_NODE_TIMEOUT_MS },
        UPDATE_COMMAND_TIMEOUT_MS,
      ) as NodeUpdateExecutorResult | undefined;

      if (!raw || typeof raw !== 'object') {
        recordJob({
          ...running,
          state: 'failed',
          error: '节点未返回有效的更新结果',
          finished_at: isoNow(),
        });
        return;
      }
      if (raw.busy) {
        recordJob({
          ...running,
          state: 'waiting_idle',
          method: raw.method || null,
          before_version: raw.before_version ?? running.before_version,
          error: null,
        });
        ensureIdleTimer();
        return;
      }
      if (raw.report) {
        nodes.noteExecutors(job.machine_id, raw.report);
      }
      if (!raw.ok) {
        recordJob({
          ...running,
          state: 'failed',
          method: raw.method || null,
          before_version: raw.before_version ?? running.before_version,
          after_version: raw.after_version ?? running.before_version,
          updated: false,
          error: raw.error ?? '更新失败',
          output: trimOutput(raw.output),
          finished_at: isoNow(),
        });
        return;
      }
      const done: ExecutorUpdateJobView = {
        ...running,
        state: 'succeeded',
        method: raw.method || null,
        before_version: raw.before_version ?? running.before_version,
        after_version: raw.after_version ?? raw.before_version ?? null,
        updated: raw.updated === true,
        error: null,
        output: trimOutput(raw.output),
        finished_at: isoNow(),
      };
      recordJob(done);
      if (done.updated && job.trigger === 'auto') {
        notify?.executorUpdated(done.machine_id, done.executor, done.before_version, done.after_version);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const friendly = msg.includes('不认识的命令')
        ? '该机器上的 tycho 节点客户端还是旧版本，等它空闲自动升到新版后即可支持远程 CLI 更新'
        : msg;
      recordJob({
        ...running,
        state: 'failed',
        error: friendly,
        finished_at: isoNow(),
      });
    } finally {
      inFlightKeys.delete(key);
      ensureIdleTimer();
    }
  }

  async function pumpWaitingJobs(): Promise<void> {
    if (stopped || recovering()) return;
    const waiting = [...activeByKey.values()].filter((job) => job.state === 'waiting_idle');
    for (const job of waiting) {
      if (stopped) return;
      if (!nodes.connected(job.machine_id)) {
        recordJob({
          ...job,
          state: 'failed',
          error: '等待空闲期间机器离线，已中止本次更新',
          finished_at: isoNow(),
        });
        continue;
      }
      if (!isMachineBusy(job.machine_id)) {
        void executeJob(job);
      }
    }
    ensureIdleTimer();
  }

  function triggerUpdate(input: {
    executor: string;
    machineIds?: string[];
    trigger?: ExecutorUpdateTrigger;
  }): ExecutorUpdateJobView[] {
    const executor = input.executor.trim();
    if (!executor) return [];
    const trigger: ExecutorUpdateTrigger = input.trigger ?? 'manual';
    const allMachines = machines.list();
    const targetIds = input.machineIds && input.machineIds.length > 0
      ? input.machineIds.filter((id) => allMachines.some((m) => m.id === id))
      : allMachines
        .filter((m) => {
          if (!nodes.connected(m.id)) return false;
          const status = nodes.reportedExecutors(m.id)?.executors.find((e) => e.executor === executor);
          return status?.installed === true;
        })
        .map((m) => m.id);

    const queued: ExecutorUpdateJobView[] = [];
    for (const machineId of targetIds) {
      const key = jobKey(machineId, executor);
      const existing = activeByKey.get(key);
      if (existing && (existing.state === 'waiting_idle' || existing.state === 'updating')) {
        queued.push(existing);
        continue;
      }
      const status = nodes.reportedExecutors(machineId)?.executors.find((e) => e.executor === executor);
      const job: ExecutorUpdateJobView = {
        id: ulid(),
        machine_id: machineId,
        executor,
        trigger,
        state: 'waiting_idle',
        method: null,
        before_version: status?.version ?? null,
        after_version: null,
        updated: false,
        error: null,
        output: null,
        started_at: isoNow(),
        finished_at: null,
      };
      recordJob(job);
      queued.push(job);
      void executeJob(job);
    }
    return queued;
  }

  async function runScheduledPass(): Promise<void> {
    if (stopped || recovering()) return;
    const policy = ledger.executorAutoUpdatePolicy();
    if (!policy.enabled) return;
    if (!inMaintenanceWindow(policy, new Date(now()))) return;
    const intervalMs = policy.intervalHours * 60 * 60 * 1000;
    if (lastAutoCheckAt > 0 && (now() - lastAutoCheckAt) < intervalMs) return;
    lastAutoCheckAt = now();

    const enabledExecutors = Object.entries(policy.executors)
      .filter(([, on]) => on)
      .map(([exec]) => exec);
    if (enabledExecutors.length === 0) return;

    await refreshUpstream(true);

    const allMachines = machines.list();
    for (const executor of enabledExecutors) {
      const installedVersions: (string | null)[] = [];
      for (const m of allMachines) {
        const status = nodes.reportedExecutors(m.id)?.executors.find((e) => e.executor === executor);
        if (status?.installed) installedVersions.push(status.version);
      }
      const upstreamLatest = upstream.get(executor)?.latest ?? null;
      const reference = upstreamLatest ?? highestSemver(installedVersions);
      if (!reference) continue;

      const outdatedMachines = allMachines
        .filter((m) => {
          if (!nodes.connected(m.id)) return false;
          const status = nodes.reportedExecutors(m.id)?.executors.find((e) => e.executor === executor);
          return status?.installed === true && isVersionBehind(status.version, reference);
        })
        .map((m) => m.id);

      if (outdatedMachines.length > 0) {
        log(`定时 CLI 更新：为 ${executor} 排队更新 ${outdatedMachines.length} 台落后机器（目标版本 ${reference}）`);
        triggerUpdate({ executor, machineIds: outdatedMachines, trigger: 'auto' });
      }
    }
  }

  function status(): ExecutorFleetStatus {
    return {
      policy: ledger.executorAutoUpdatePolicy(),
      upstream: Object.fromEntries(upstream.entries()),
      jobs: [...history],
      active_by_key: Object.fromEntries(activeByKey.entries()),
    };
  }

  function setPolicy(raw: unknown): ExecutorAutoUpdatePolicy {
    const normalized = normalizeExecutorAutoUpdatePolicy(raw);
    const saved = ledger.setExecutorAutoUpdatePolicy(normalized);
    onChanged?.();
    return saved;
  }

  function start(): void {
    if (started) return;
    started = true;
    stopped = false;
    // Warm up upstream version cache asynchronously once on startup (best-effort, non-blocking).
    void refreshUpstream(false).catch(() => {});
    schedulerTimer = setInterval(() => {
      void runScheduledPass().catch((err: unknown) => log(`定时检查 CLI 更新失败：${String(err)}`));
    }, AUTO_SCHEDULER_TICK_MS);
    schedulerTimer.unref();
  }

  function stop(): void {
    stopped = true;
    started = false;
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = undefined;
    }
    if (schedulerTimer) {
      clearInterval(schedulerTimer);
      schedulerTimer = undefined;
    }
  }

  return {
    status,
    refreshUpstream,
    triggerUpdate,
    setPolicy,
    pumpWaitingJobs,
    runScheduledPass,
    start,
    stop,
  };
}

export type ExecutorUpdates = ReturnType<typeof createExecutorUpdates>;
