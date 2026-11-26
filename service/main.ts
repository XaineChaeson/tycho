import type {OutputCapacity} from '../shared/node-output.ts';
import { globalEntryPublisher } from './global-entry-publisher.ts';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, hostname, tmpdir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { ADAPTERS } from '../adapters/all.ts';
import { compareVersions, versionOf } from '../adapters/version.ts';
import { codexAccessExpiryMs, codexIdentityFromTokens, decodeCodexOAuthLease } from '../adapters/codex-auth.ts';
import { codexSettings, ownLoginTiersOf } from '../adapters/tier.ts';
import { claudeAdapter } from '../adapters/claude.ts';
import { geminiAdapter } from '../adapters/gemini.ts';
import { geminiBaseUrl } from '../adapters/gemini-provider.ts';
import { launchOf } from '../node/launch.ts';
import type { Adapter, Tier } from '../adapters/types.ts';
import type { Wecom } from '../channels/wecom.ts';
import { createWecom } from '../channels/wecom.ts';
import { createImGateway, downloadWecomMedia } from './im-gateway.ts';
import type { ImChannel, ImChannelPermissions } from '../shared/im.ts';
import { createWeixin, type Weixin } from './weixin.ts';
import { createGitHubService } from './github.ts';
import { createReplayConsole } from './replay-console.ts';
import { joinCard } from '../channels/wecom-cards.ts';
import { latestMoment } from './pushes.ts';
import { artifactsDroppedText } from '../shared/labels.ts';
import type { StreamTiming } from '../channels/wecom-stream.ts';
import type { OrphanReport, Runner, RunnerOptions } from '../runner/runner.ts';
import { CHECK_TIMEOUT_MS, createRunner } from '../runner/runner.ts';
import { executorCheckTimeoutMs } from '../node/executors.ts';
import { createNodeChannel } from '../runner/node-channel.ts';
import { snapshotFiles } from '../runner/snapshot.ts';
import type { Machine, Snapshot } from '../runner/snapshot.ts';
import type { RemoteHost } from '../runner/host.ts';
import { runDirOf } from '../runner/host.ts';
import { createAuth } from './auth.ts';
import { createAcceptor, reviewArtifactSnapshot } from './accept.ts';
import { createRetention } from './retention.ts';
import type { BackupClock, BackupHooks, Backups } from './backup.ts';
import { createBackups } from './backup.ts';
import type { ClaudeInspection } from './claude-cli.ts';
import { claudePath, inspectClaude, loginState, missingClaudeSetting } from './claude-cli.ts';
import type { Instance } from './config.ts';
import { dataDirFromEnv, lockFile, loginTokenFile, loginUrl, prepareDataDir, serviceFile } from './config.ts';
import { createDispatcher } from './dispatcher.ts';
import { createExecutorUpdates } from './executor-updates.ts';
import { combineQuotaReaders, createDshQuotaReader } from './dsh-quota.ts';
import { isEntry } from './entry.ts';
import type { DoctorCheck, RouterSetup } from './doctor.ts';
import { deploymentFacts, doctor } from './doctor.ts';
import { InputError } from './errors.ts';
import { createGateway, gatewayMarker } from './gateway.ts';
import { loginLinkPath, createHttp, createStream, hydrateMessageEvent } from './http.ts';
import { launcherPath } from '../cli/launcher.ts';
import { autostartManages } from '../cli/install.ts';
import { appVersion, prefixOf } from '../cli/paths.ts';
import type { UpgradeStarter } from '../cli/upgrade.ts';
import { upgradeRunning, upgradeStarter } from '../cli/upgrade.ts';
import { realSystem } from '../cli/system.ts';
import type { Ctx, Ledger, LedgerOptions, RunRow } from './ledger.ts';
import { openLedger, loginMissing } from './ledger.ts';
import { ulid } from './ids.ts';
import type { RunAccess } from '../shared/roles.ts';
import {
  isPreviewableArtifactMime,
  isRasterImageMime,
  MAX_PROJECT_FILE_BYTES,
  normalizeProjectFileMime,
  normalizeProjectFileName,
  removeProjectFileBytes,
  toProjectFileSummary,
  writeProjectFileBytes,
  type ProjectFileSummary,
} from './project-files.ts';
import { openProjectHome, projectHomeEnabled } from './project-home.ts';
import { createProjectDirectory, projectDirectoryFeed } from './project-directory.ts';
import { acquireLock } from './lock.ts';
import { createNotify } from './notify.ts';
import type { OutboxSender } from './outbox-sender.ts';
import { createOutboxSender } from './outbox-sender.ts';
import { nameIsSafe, readReleaseIntent, readReleaseResult, registeredPackage, writeReleaseIntent, type ReleaseFile } from './releases.ts';
import { createInbounds } from './inbound.ts';
import { discardSecret, knowledgeTokenStore, passphraseSecretFile, readSecret, replaceSecret, wecomSecretFile, writeOwnerOnly } from './secrets.ts';
import { knowledgeLimits, serviceSettings } from './service-settings.ts';
import { globalEntryContent, routerKnowledge } from './knowledge-brief.ts';
import { executorDirOf } from './home-paths.ts';
import { applyEntry, entryTargets, envHome, repairEntry } from '../node/global-entry.ts';
import type { EntryRepairAction, NodeEntryContent, NodeEntryReport, NodeRepairEntryResult } from '../shared/node-protocol.ts';
import { routerMaterial } from './router-material.ts';
import type { Processes, RouterLaunch, TurnObserver } from './session-host.ts';
import { createSessionHost, routerEnv, RouterUnavailable } from './session-host.ts';
import { backupConfig, SETTINGS } from './settings.ts';
import { createAccounts } from './accounts.ts';
import { createClaudeLogin, type ClaudeLoginOptions } from './claude-login.ts';
import { createCodexAuthBroker } from './codex-auth.ts';
import { createCodexLogin, type CodexLoginOptions } from './codex-login.ts';
import { createLogins } from './logins.ts';
import { createMachines } from './machines.ts';
import { createModels } from './models.ts';
import { createQuotaReads } from './quota-read.ts';
import { createNodes } from './nodes.ts';
import { createNodeReleases } from './node-release.ts';
import { createSignIns } from './sign-ins.ts';
import { fitsHere } from './readonly.ts';
import type { NodeExecutorReport, ReportedStatus } from '../shared/node-protocol.ts';
import { readRunReport } from './reports.ts';
import { createTools } from './tools.ts';
import { turnFirsts } from './messages.ts';
import { isTierId, tierOnlyText, tierValueFrom } from '../shared/tiers.ts';
import { foldedRouterText } from '../shared/logins.ts';

const SERVICE: Ctx = { actor: 'service' };
// How long a stop waits for the parts to close, and how often a degraded ledger is tried
// again. Constants: the service's own housekeeping, not behaviour the owner tunes.
const STOP_WAIT_MS = 20_000;
const DEGRADED_RECOVERY_MS = 30_000;
const PUSH_INTERVAL_MS = 60_000;
// How finely the host's look at its own global entry follows its setting (knowledge §4.3): the
// setting's shortest interval.
const ENTRY_TICK_MS = 1_000;
// How often what is due is looked at: the wakes and the scheduled triggers (docs/design/triggers.md
// §5). Far inside the grace period, so a normal scan is never taken for a miss.
const DUE_INTERVAL_MS = 5_000;
// How often a finished work's copies are looked at for their retention period
// (docs/design/phase1-design.md "已结束的工作"): once when the service starts, then hourly.
const RETENTION_INTERVAL_MS = 60 * 60 * 1000;
const NO_REPLY = '处理完了，没有要回复的内容';
// Asking the CLI who is signed in starts a process; the pages ask every few seconds.
const CLI_FACTS_FRESH_MS = 60_000;
const ROUTER_FIX = '到“设置 › 负责人”改好后点“重启负责人”';
const MAX_PORT = 65_535;
const KIB = 1024;
const MIB = 1024 * KIB;

// The words the owner knows this service by. The installed command says so when it
// starts the service; without that, this is a checkout run through npm.
const BY_COMMAND = process.env.TYCHO_STARTED_BY === 'tycho';
const LOGIN_HINT = BY_COMMAND ? '运行 tycho open 打开控制台' : '运行 npm run login-link 获取登录链接';
const OTHER_PORT = BY_COMMAND ? 'tycho run --port <端口>' : 'TYCHO_PORT=<端口> npm start';

// As the file system spells it: what an installer compares its own directories with.
const PROGRAM_DIR = realpathSync.native(join(import.meta.dirname, '..'));

function programVersion(): string {
  try {
    return appVersion(PROGRAM_DIR);
  } catch {
    return '';
  }
}

const log = (line: string): void => console.error(`${new Date().toISOString()} ${line}`);

// The data directory is all a start needs: everything else is a setting or an object in
// the ledger, read where it is used. The rest are for tests.
export interface ServiceOptions {
  dataDir: string;
  adapters?: Record<string, Adapter>;
  dispatchIntervalMs?: number;
  watchIntervalMs?: number;
  // In place of the CLI the settings name: one with leading arguments, which a setting cannot hold.
  claude?: string[];
  // In place of the port the settings name, for this run only: `tycho run --port`, and
  // a test that listens wherever is free. The inside listener's: the outside one, for the
  // gateway, is where the settings say.
  port?: number;
  // In place of the ssh that keeps the connection to the gateway.
  ssh?: string[];
  // Aborted to stop the service, from the first moment of its start on.
  stopSignal?: AbortSignal;
  stopWaitMs?: number;
  routerTurnTimeoutMs?: number;
  routerIdleMs?: number;
  outboxIntervalMs?: number;
  degradedRecoveryMs?: number;
  wecomStreamTiming?: Partial<StreamTiming>;
  // How often reminders, result windows and the daily brief are looked at (project-sessions §2.1).
  pushIntervalMs?: number;
  dueIntervalMs?: number;
  // How often finished work's copies are looked at for their retention period. Absent means
  // the hourly housekeeping.
  retentionIntervalMs?: number;
  connect?: RunnerOptions['connect'];
  // In place of what the machines' clients reported of their executors, for a test whose
  // machines are stand-ins with no client to report (beside `connect`).
  reportedOutput?: (machineId:string)=>{bounded_output:1;capacity:OutputCapacity}|null;
  reportedExecutors?: (machineId: string) => NodeExecutorReport | null;
  checkTimeoutMs?: number;
  processes?: Processes;
  ledgerHooks?: LedgerOptions['testHooks'];
  backupClock?: BackupClock;
  backupHooks?: BackupHooks;
  // How long a machine may be out of touch, read where it is used. Absent means the
  // owner's setting.
  lostGraceMs?: () => number;
  // The wall clock the Runner and the dispatcher read, and the clock the Runner times
  // what it saw begin by, which counts time passing and cannot be set.
  now?: () => number;
  monotonic?: () => number;
  // In place of this checkout's built console: a test serves a stand-in.
  consoleDir?: string;
  // In place of starting the command that puts a release in place, which outlives this
  // service: a test watches what would be started instead of starting it.
  launch?: UpgradeStarter;
  // Where this host's own executors keep their directories: a test points them at a directory of
  // its own.
  globalEntry?: { env?: NodeJS.ProcessEnv; home?: string };
  // In place of the real `claude setup-token` and the environment it starts from: a test
  // signs in with a stand-in CLI.
  claudeLogin?: Pick<ClaudeLoginOptions, 'commandLine' | 'env' | 'bridge'>;
  codexLogin?: Pick<CodexLoginOptions, 'resolveLaunch' | 'spawn' | 'readCatalog' | 'env' | 'platform'>;
}


const isDirectory = (path: string): boolean => statSync(path, { throwIfNoEntry: false })?.isDirectory() ?? false;

const snapshotOf = (run: { snapshot_json: string }): Snapshot => JSON.parse(run.snapshot_json) as Snapshot;

export interface DeliverableIngestorDeps {
  ledger: Pick<Ledger, 'getTask' | 'listRuns' | 'listProjectFiles' | 'createProjectFile'>;
  runner: Pick<Runner, 'fetchArtifacts'>;
  dataDir: string;
  onChanged?: () => void;
}

export function createDeliverableIngestor(deps: DeliverableIngestorDeps) {
  const inFlight = new Map<string, Promise<{ files: ProjectFileSummary[]; problem: string | null }>>();

  async function ingestRun(run: RunRow): Promise<{ files: ProjectFileSummary[]; problem: string | null }> {
    const running = inFlight.get(run.id);
    if (running) return running;

    const work = (async (): Promise<{ files: ProjectFileSummary[]; problem: string | null }> => {
      if (!run.task_id) return { files: [], problem: null };
      const task = deps.ledger.getTask(run.task_id);
      if (!task.project_id) return { files: [], problem: null };

      const tempDir = mkdtempSync(join(tmpdir(), 'tycho-deliverables-'));
      try {
        const fetched = await deps.runner.fetchArtifacts(run, tempDir);
        if (fetched.files.length === 0) return { files: [], problem: fetched.problem };

        const existing = deps.ledger.listProjectFiles(task.project_id);
        const runTag = `[run:${run.id}]`;
        const summary = `来自任务「${task.title}」[task:${task.id}]${runTag}`;
        const savedSummaries: ProjectFileSummary[] = [];
        let added = false;

        for (const { name, sha256, bytes } of fetched.files) {
          if (bytes > MAX_PROJECT_FILE_BYTES || name.toLowerCase().endsWith('.tar.gz')) continue;

          const safeName = normalizeProjectFileName(name);
          const mime = normalizeProjectFileMime(undefined, safeName);
          // Only auto-promote genuine visual/interactive deliverables (HTML, SVG, raster charts/images)
          // into the Project Library. Routine stage-report .md/.txt files stay on the run and are read
          // on-demand inside the task thread without polluting Project Files.
          if (!isPreviewableArtifactMime(mime) && !isRasterImageMime(mime)) continue;

          const duplicate = existing.find((row) => row.sha256 === sha256 && row.summary?.includes(runTag));
          if (duplicate) {
            savedSummaries.push(toProjectFileSummary(duplicate));
            continue;
          }

          const fileBytes = readFileSync(join(tempDir, name));
          if (fileBytes.length > MAX_PROJECT_FILE_BYTES) continue;

          const kind = isPreviewableArtifactMime(mime) ? 'artifact' : 'upload';
          const id = ulid();
          const written = writeProjectFileBytes(deps.dataDir, task.project_id, id, fileBytes);
          try {
            const created = deps.ledger.createProjectFile({
              id,
              projectId: task.project_id,
              name: safeName,
              mime,
              size: written.size,
              sha256: written.sha256,
              kind,
              origin: 'worker',
              summary,
            });
            existing.push(created);
            savedSummaries.push(toProjectFileSummary(created));
            added = true;
          } catch (err) {
            removeProjectFileBytes(deps.dataDir, task.project_id, id);
            throw err;
          }
        }

        if (added) deps.onChanged?.();
        return { files: savedSummaries, problem: fetched.problem };
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    })();

    inFlight.set(run.id, work);
    try {
      return await work;
    } finally {
      inFlight.delete(run.id);
    }
  }

  async function ingestTask(taskId: string): Promise<{ files: ProjectFileSummary[]; problem: string | null }> {
    const task = deps.ledger.getTask(taskId);
    if (!task.project_id) return { files: [], problem: null };
    const latestEnded = deps.ledger.listRuns(taskId).findLast((run) => run.state === 'ended');
    if (!latestEnded) return { files: [], problem: '任务还没有已结束的执行轮次' };
    return ingestRun(latestEnded);
  }

  return { ingestRun, ingestTask };
}

export function ingestRunDeliverables(
  deps: DeliverableIngestorDeps,
  run: RunRow,
): Promise<{ files: ProjectFileSummary[]; problem: string | null }> {
  return createDeliverableIngestor(deps).ingestRun(run);
}

// §5.6's order; anything that fails here leaves no driver running.
export async function startService(options: ServiceOptions) {
  const startupAt = performance.now();
  let phaseAt = startupAt;
  const phases: string[] = [];
  const phase = (name: string, detail = ''): void => {
    const now = performance.now();
    const elapsed = (now - phaseAt) / 1000;
    phases.push(`${name} ${elapsed.toFixed(2)} 秒${detail}`);
    if (elapsed > 5) log(`启动阶段 ${name} 用了 ${elapsed.toFixed(2)} 秒${detail}`);
    phaseAt = now;
  };
  const dataDir = prepareDataDir(options.dataDir);
  const lock = lockFile(dataDir);
  acquireLock(lock, log);

  // Front to back, on a failed start and on a stop alike: each resource adds itself
  // at the front as it comes up. A step that fails does not excuse the others.
  const teardown: [string, () => Promise<void> | void][] = [
    ['删除 service.json', () => rmSync(serviceFile(dataDir), { force: true })],
    ['释放锁', () => rmSync(lock, { force: true })],
  ];
  async function runTeardown(): Promise<boolean> {
    let clean = true;
    for (const [what, step] of teardown) {
      try {
        await step();
      } catch (err) {
        clean = false;
        log(`${what}失败：${String(err)}`);
      }
    }
    return clean;
  }
  const stopped = Promise.withResolvers<boolean>();
  const stopRequest = new AbortController();
  const stopping = (): boolean => stopRequest.signal.aborted;
  let recoveryTimer: NodeJS.Timeout | undefined;
  let pushTimer: NodeJS.Timeout | undefined;
  let entryTimer: NodeJS.Timeout | undefined;
  let dueTimer: NodeJS.Timeout | undefined;
  let retentionTimer: NodeJS.Timeout | undefined;
  let recoveryTask: Promise<void> | undefined;
  let backups: Backups | undefined;
  let backupsStopped: Promise<boolean> | undefined;
  // Why it stops is said once, in the log: a service that is gone without a word is one
  // nobody can tell from a crash afterwards.
  function stop(why = '程序内部请求停止'): Promise<boolean> {
    if (!stopping()) {
      log(`服务正在停止：${why}`);
      stopRequest.abort();
      clearInterval(recoveryTimer);
      clearInterval(pushTimer);
      clearInterval(entryTimer);
      clearInterval(dueTimer);
      clearInterval(retentionTimer);
      backupsStopped = backups?.stop(options.stopWaitMs ?? STOP_WAIT_MS);
      void runTeardown().then(stopped.resolve);
    }
    return stopped.promise;
  }
  const signalled = (): string => {
    const reason: unknown = options.stopSignal?.reason;
    return typeof reason === 'string' ? reason : '启动方请求停止';
  };
  if (options.stopSignal?.aborted) void stop(signalled());
  else options.stopSignal?.addEventListener('abort', () => void stop(signalled()), { once: true });

  // §5.6 and §2: true while an inventory runs, at a start and on leaving degraded mode.
  // Whatever could act on the outside world asks this before it does.
  let recovering = true;
  let orphans: OrphanReport[] = [];

  try {
    const adapters = options.adapters ?? ADAPTERS;

    const clock = options.now ? { now: options.now } : {};
    const ownership = projectHomeEnabled(dataDir) ? openProjectHome(dataDir) : undefined;
    if (ownership) teardown.unshift(['关闭项目归属账本', () => ownership.close()]);
    let weixin: Weixin | undefined;
    let weixinLoaded = false;
    let onOAuthLeaseAuthFailure: ((loginId: string, ref: string) => void) | undefined;
    const ledger = openLedger(join(dataDir, 'ledger.db'), {
      noticeTargets: () => (weixinLoaded && imPermissions('weixin').notify ? weixin?.noticeTargets() ?? [] : []),
      onOAuthLeaseAuthFailure: (loginId, ref) => onOAuthLeaseAuthFailure?.(loginId, ref),
      ...(ownership ? { projectHome: ownership } : {}),
      recovery: { recovering: () => recovering },

      knowledgeLimits: () => knowledgeLimits(settings),

      knowledgeLogins: () => settings.get('knowledge.logins'),
      pushPolicy: () => ({
        remindMs: settings.get('push.remindMs'),
        remindMax: settings.get('push.remindMax'),
        resultWindowMs: settings.get('push.resultWindowMs'),
      }),
      triggerPolicy: () => ({
        graceMs: settings.get('triggers.graceMs'),
        minIntervalMs: settings.get('triggers.minIntervalMs'),
        dedupeKeepMs: settings.get('triggers.dedupeKeepMs'),
        queueMax: settings.get('triggers.queueMax'),
        perTriggerPerMinute: settings.get('triggers.perTriggerPerMinute'),
        perMinute: settings.get('triggers.perMinute'),
        dataLimitBytes: settings.get('triggers.dataLimitKb') * 1024,
        inboundSkewMs: settings.get('triggers.inboundSkewMs'),
        inboundRotateMs: settings.get('triggers.inboundRotateMs'),
        problemAfter: settings.get('triggers.problemAfter'),
        problemAlertWindowMs: settings.get('triggers.problemAlertWindowMs'),
      }),
      log,
      ...(options.ledgerHooks ? { testHooks: options.ledgerHooks } : {}),
    });
    phase('账本');
    teardown.unshift(['关闭账本', () => ledger.close()]);
    const settings = serviceSettings({ ledger, dataDir, log });
    const imPermissions = (channel: ImChannel): ImChannelPermissions => (channel === 'wecom'
      ? {
          chat: settings.get('im.wecom.chat'),
          notify: settings.get('im.wecom.notify'),
          approve_login: settings.get('im.wecom.approveLogin'),
        }
      : {
          chat: settings.get('im.weixin.chat'),
          notify: settings.get('im.weixin.notify'),
          approve_login: settings.get('im.weixin.approveLogin'),
        });
    const imGateway = createImGateway({
      ledger,
      dataDir,
      isWhitelisted: (channel, actor) => (ledger.getWhitelist()[channel] ?? []).includes(actor),
      downloadMedia: (channel, ref) => {
        if (channel === 'wecom') return downloadWecomMedia(ref);
        throw new Error(`通道 ${channel} 暂不支持附件下载`);
      },
      log,
      ...(options.now ? { now: options.now } : {}),
    });
    const projectDirectory = createProjectDirectory({ dataDir, local: () => projectDirectoryFeed(ledger, ownership?.identity.id) });
    // The global entry (knowledge-and-skills.md §4.3): what is in force now, which a machine
    // whose copy is behind is given with its next poll, and this host's own copy, written for
    // each executor whose own directory is here (a machine's client goes by what it found
    // installed; this host asks no executor anything, so the directory is what it has). The
    // place is looked at again every time — an executor installed since, a file moved away, an
    // override added — and the writer itself leaves a file that already holds this content alone.
    const externalEntryEnabled = (): boolean => settings.get('knowledge.externalEntry');
    const entryContent = (): NodeEntryContent => {
      const publisher = globalEntryPublisher(dataDir);
      return globalEntryContent(
        ledger.applicable(null, null),
        settings.get('knowledge.globalEntryLimitKb') * 1024,
        'id' in publisher ? { ...publisher, source: { hostname: hostname(), port } } : publisher,
        externalEntryEnabled(),
      );
    };
    let hostEntry: NodeEntryReport | null = null;
    const writeHostEntry = (): void => {
      try {
        const content = entryContent();
        const env = options.globalEntry?.env ?? process.env;
        const home = options.globalEntry?.home ?? envHome(options.globalEntry?.env);
        const here = entryTargets().filter(({ entry }) => {
          try {
            return isDirectory(executorDirOf(env, home, entry.home.env, entry.home.dir));
          } catch {
            return false;
          }
        });
        hostEntry = { digest: content.digest, at: new Date().toISOString(), executors: applyEntry(content, here, { env, home }) };
      } catch (err) {
        log(`写主机本机执行器的全局指令入口没做成：${String(err)}`);
      }
    };
    const repairHostEntry = (executor: string, action: EntryRepairAction): NodeRepairEntryResult => {
      const target = entryTargets([executor])[0];
      if (target === undefined) throw new InputError(`不支持该执行器的全局入口修复：${executor}`);
      const content = entryContent();
      const env = options.globalEntry?.env ?? process.env;
      const home = options.globalEntry?.home ?? envHome(options.globalEntry?.env);
      const { status, backup_path } = repairEntry(action, content, target, { env, home });
      writeHostEntry();
      const report: NodeEntryReport = hostEntry ?? { digest: content.digest, at: new Date().toISOString(), executors: [status] };
      if (!report.executors.some((each) => each.executor === status.executor)) {
        hostEntry = { ...report, at: new Date().toISOString(), executors: [...report.executors, status] };
      }
      return {
        status,
        ...(backup_path === undefined ? {} : { backup_path }),
        report: hostEntry ?? report,
      };
    };
    const machines = createMachines({ ledger });
    const accounts = createAccounts({ ledger, executors: adapters,
      credentialExecutors: Object.entries(adapters).filter(([, adapter]) => adapter.credential).map(([id]) => id),
      routingExecutors: Object.entries(adapters).filter(([, adapter]) => adapter.canRoute).map(([id]) => id),
      dataDir, log });
    accounts.cleanCredentials();
    // Signing in to a Claude account from the console (docs/design/native-login.md): sessions
    // live in memory only, so whatever a crash left of one is nobody's.
    const claudeLogin = createClaudeLogin({
      dataDir,
      ledger,
      accounts,
      limitMs: () => settings.get('accounts.loginTimeoutMs'),
      models: { executors: adapters, timeoutMs: options.checkTimeoutMs ?? CHECK_TIMEOUT_MS },
      cleanupMs: () => settings.get('accounts.loginCleanupMs'),
      settleMs: () => settings.get('accounts.loginSettleMs'),
      ...options.claudeLogin,
      log,
    });
    claudeLogin.tidy();
    // Before the ledger closes: a login that finishes as the service goes must not write.
    teardown.unshift(['收尾登录会话', () => claudeLogin.stopAll({ close: true })]);
    const codexAuth = createCodexAuthBroker({
      dataDir,
      ledger,
      accounts,
      version: programVersion(),
      quotaTimeoutMs: () => settings.get('quota.readTimeoutMs'),
      recovering: () => recovering,
      ...(options.now ? { now: options.now } : {}),
      log,
    });
    codexAuth.tidy();
    teardown.unshift(['停下 Codex 令牌续期', () => codexAuth.stop()]);
    // Backfill real masked email & subscription plan from stored Codex OAuth JWTs so existing
    // centralized accounts immediately display their true login identity without re-signing in.
    for (const acc of accounts.list()) {
      if (acc.executor !== 'codex') continue;
      try {
        const cred = accounts.credentialOf(acc.id);
        const lease = cred ? decodeCodexOAuthLease(cred.value) : undefined;
        if (lease) {
          const identity = codexIdentityFromTokens(lease);
          if (identity.accountLabel || identity.planLabel || identity.quotaOwner) {
            ledger.noteIdentity(acc.id, identity);
          }
        }
      } catch { /* non-fatal startup backfill */ }
    }
    let onCodexRelogin: (accountId: string) => void = () => {};
    let kickAfterAuthRefresh: () => void = () => {};
    onOAuthLeaseAuthFailure = (loginId, ref) => {
      void codexAuth.verifyCredential(loginId, ref).finally(() => kickAfterAuthRefresh());
    };
    const codexLogin = createCodexLogin({
      dataDir,
      ledger,
      accounts,
      limitMs: () => settings.get('accounts.loginTimeoutMs'),
      cleanupMs: () => settings.get('accounts.loginCleanupMs'),
      onRelogin: (accountId) => onCodexRelogin(accountId),
      ...options.codexLogin,
      log,
    });
    codexLogin.tidy();
    teardown.unshift(['收尾 Codex 登录会话', () => codexLogin.stopAll({ close: true })]);
    // The inbound sources' keys (docs/design/triggers.md §2.2): the files of keys that verify
    // nowhere any more, or whose issue never committed, go at each start.
    const inbounds = createInbounds({ ledger, dataDir, skewMs: () => settings.get('triggers.inboundSkewMs'), log });
    try {
      inbounds.tidy();
    } catch (err) {
      log(`清理作废的入站密钥文件失败：${String(err)}`);
    }
    // Every login a round can run as: the accounts above and each machine's own logins.
    const logins = createLogins({ ledger, accounts, executors: adapters });
    const lostGraceMs = options.lostGraceMs ?? ((): number => settings.get('run.lostGraceMs'));
    const publicUrl = (): string => settings.get('http.publicUrl');
    const wecomEnabled = (): boolean => settings.get('wecom.botId') !== '';
    // Before anything can queue a notice: with the channel off there is nobody to tell.
    const updateChannels = (): void => ledger.setChannels(['console', ...(wecomEnabled() ? ['wecom'] : []), ...(!weixinLoaded || weixin?.ownerTarget() ? ['weixin'] : [])]);
    updateChannels();
    if (!ledger.getWhitelist().console) ledger.setWhitelist({ ...ledger.getWhitelist(), console: ['console'] }, SERVICE);

    const runTimeoutMs = (): number => settings.get('run.timeoutMs');
    // The machines that come back by themselves: who is allowed in, who is here, and one
    // command per connection (docs/design/nodes.md §5.3).
    // Set just below, once the nodes exist: a machine with a sign-in under way polls quickly.
    let hurried: (machineId: string) => boolean = () => false;
    const nodes = createNodes({
      ledger,
      pollHoldMs: (machineId) => hurried(machineId)
        ? Math.min(settings.get('node.pollHoldMs'), settings.get('accounts.signInPollMs'))
        : settings.get('node.pollHoldMs'),
      commandTimeoutMs: () => settings.get('node.commandTimeoutMs'),
      joinTtlMs: () => settings.get('node.joinTtlMs'),
      gapSlackMs: () => settings.get('node.gapSlackMs'),
      // §6: behind the recovery barrier and in degraded mode nothing is given to a machine,
      // and none is let in.
      barriers: () => ledger.dispatchConditions(),
      endedJoinKeepMs: () => settings.get('node.endedJoinKeepMs'),
      endedJoinMax: () => settings.get('node.endedJoinMax'),
      ownLoginTiers: (executor) => (Object.hasOwn(adapters, executor) ? ownLoginTiersOf(adapters[executor]!) : undefined),
      log,
    });
    // The host's own version, packed for the machines that follow it (docs/design/nodes.md
    // §1.4). It is the version directory this service runs from, so only an installed copy has
    // one; a source checkout answers why it has none.
    const nodeReleases = createNodeReleases({
      appRoot: PROGRAM_DIR,
      dataDir,
      system: realSystem(),
      checkEveryMs: () => settings.get('node.releaseCheckMs'),
      log,
    });
    // Sign-ins of an executor run on a machine itself (docs/design/native-login.md): memory
    // only, like the Claude login sessions, and given up with the service.
    const signIns = createSignIns({
      ledger,
      nodes,
      executors: adapters,
      limitMs: () => settings.get('accounts.loginTimeoutMs'),
      graceMs: () => settings.get('accounts.loginCleanupMs'),
      barriers: () => ledger.dispatchConditions(),
      log,
    });
    hurried = signIns.hurried;
    nodes.onSignIns(signIns.reported);
    teardown.unshift(['收尾机器上的登录', () => signIns.close()]);
    const outputReady=(machineId:string):boolean=>{const held=options.reportedOutput?.(machineId);return held?held.bounded_output===1&&!held.capacity.issue&&held.capacity.available_runs>0:nodes.outputReady(machineId);};
    const nodeChannel = createNodeChannel({ nodes });
    // A machine is reached through its own client, over the node channel (nodes.md §5.2).
    const connect = (target: Machine): RemoteHost => nodeChannel.for(target.id);
    // §1.3: the one-time join materials a round of a task with an open quota is handed,
    // minted when its machine fetches them and good for the setting's span from then. The
    // address the machines it spawns join at is the one that machine reaches this host at.
    const materialTtlMs = (): number => settings.get('node.materialTtlMs');
    // A round is handed its materials once (the ledger sees to that). The plaintext of what
    // it was handed is kept here, in memory only, so that the same round asking again — its
    // client lost the answer on the way — gets the same ones back; only rounds still being
    // started can ask. A restart forgets them: such a round is then handed none.
    const handed = new Map<string, string[]>();
    const invite = {
      open: (taskId: string): boolean => ledger.openInvite(taskId) !== undefined,
      hand: (taskId: string, runId: string): string[] | undefined => {
        for (const id of handed.keys()) if (id !== runId && ledger.getRun(id)?.state !== 'launching') handed.delete(id);
        const materials = ledger.handInvite(taskId, runId, materialTtlMs(), handed.get(runId));
        if (materials === undefined) handed.delete(runId);
        else handed.set(runId, materials);
        return materials;
      },
    };
    // What a machine last said of one of its executors (nodes.md §1.2): where new work may go,
    // read-only or not, is judged by it in one place (service/readonly.ts).
    const reported = (machineId: string, executor: string): ReportedStatus | null => {
      const report = (options.reportedExecutors ?? nodes.reportedExecutors)(machineId);
      const status = report?.executors.find((each) => each.executor === executor);
      return report && status ? { ...status, asked_at: report.at } : null;
    };
    // One wait for a machine to answer a question: a connection test, and what an
    // executor reports about itself.
    const checkTimeoutMs = options.checkTimeoutMs ?? CHECK_TIMEOUT_MS;
    const reviewFiles = (run: RunRow) => {
      if (run.state !== 'launching') return [];
      const binding = (JSON.parse(run.snapshot_json) as Snapshot).review_artifacts;
      return binding ? reviewArtifactSnapshot(dataDir, ledger.artifactsOfRun(binding.run_id), binding, ledger.runReport(binding.run_id)) : [];
    };
    let publishChanged: () => void = () => {};
    let ingestRunDeliverablesForRunner: ((run: RunRow) => Promise<{ files: ProjectFileSummary[]; problem: string | null }>) | undefined;
    let autoRequestReviewForRunner: ((run: RunRow) => Promise<void>) | undefined;
    const github = createGitHubService({ dataDir, ledger });
    const runner = createRunner({
      ledger, adapters, logins, machines, log, lostGraceMs, reviewFiles, ...clock,
      diagnosticsDir: join(dataDir, 'worker-diagnostics'),
      diagnosticsRetentionMs: () => settings.get('retention.endedDays') * 86_400_000,
      diagnosticsPolicy: () => ({ maxEvents: settings.get('site.diagnosticEvents'), maxBytes: settings.get('site.diagnosticLimitKb') * KIB }),
      artifactFileLimitBytes: () => settings.get('artifacts.fileLimitMb') * MIB,
      artifactsLimitBytes: () => settings.get('artifacts.totalLimitMb') * MIB,
      displayTextBytes: () => settings.get('site.outputLimitKb') * KIB,
      cooldownMs: () => settings.get('machine.cooldownMs'),
      probeFreshMs: () => settings.get('machine.probeFreshMs'),
      sweepMs: () => settings.get('machine.sweepMs'),
      outputReady,
      fits: (machineId, executor, readOnly, account) => fitsHere(reported(machineId, executor), {
        readOnly,
        ...(account ? { account: true } : {}),
      }, adapters[executor]),
      reported,
      reportedEntry: nodes.reportedEntry,
      externalEntryEnabled,
      credential: (id) => accounts.credentialOf(id),
      githubToken: () => github.readToken(),
      invite,
      ...(options.monotonic ? { monotonic: options.monotonic } : {}),
      connect: options.connect ?? connect,
      // §5.3: a machine whose client speaks another protocol is not a machine out of contact.
      refusesProtocol: (machineId) => nodes.refusesProtocol(machineId),
      // §1.2: a machine that came back by itself is asked about the executors on it through
      // its own client, which looks at the machine again and answers.
      executors: (machineId, timeoutMs) => nodeChannel.executors(machineId, timeoutMs),
      checkTimeoutMs: options.checkTimeoutMs ?? (() => executorCheckTimeoutMs(settings.get('node.modelListTimeoutMs'))),
      onRunSettled: async (run) => {
        try {
          await ingestRunDeliverablesForRunner?.(run);
        } catch (err) {
          log(`自动拉回 Run ${run.id} 交付产物失败：${String(err)}`);
        }
        try {
          await autoRequestReviewForRunner?.(run);
        } catch (err) {
          log(`自动派发任务 ${run.task_id} 独立审阅失败：${String(err)}`);
        }
      },
    });
    const deliverables = createDeliverableIngestor({
      ledger,
      runner,
      dataDir,
      onChanged: () => publishChanged(),
    });
    ingestRunDeliverablesForRunner = deliverables.ingestRun;
    // §4.4: a client that restarts reclaims what it was watching. What it says it has
    // running is asked about again, and what the ledger ended while it was away is cleared
    // on it by the next sweep. Only its own Runs: a Run belongs to the node identity it
    // started on, whatever the machine is called now (§7, §9).
    nodes.onReclaim((machineId, runs) => {
      runner.machineBack(machineId);
      for (const claimed of runs) {
        if (claimed.alive !== true) continue;
        // A machine may name a round this host never had (a Task deleted, a data directory
        // shared with another host): the answer to that is to ignore it, never to fail the
        // poll it came in on.
        if (!ledger.hasRun(claimed.run_id)) continue;
        const run = ledger.getRun(claimed.run_id);
        if (run.state === 'ended' || run.machine_id !== machineId || run.task_id !== claimed.task_id) continue;
        void runner.verify(run).catch((err: unknown) => log(`机器 ${machineId} 连回来后核实 Run ${run.id} 出错：${String(err)}`));
      }
    });
    // Accepting a Task is where a Run's artifacts come back, for the page and for the
    // Router's own tool alike.
    const accept = createAcceptor({ ledger, runner, dataDir });
    const autoReviewInFlight = new Set<string>();
    async function autoRequestReview(taskId: string): Promise<void> {
      if (stopping() || ledger.dispatchConditions().degraded) return;
      if (autoReviewInFlight.has(taskId)) return;
      let task: ReturnType<Ledger['getTask']>;
      try {
        task = ledger.getTask(taskId);
      } catch {
        return;
      }
      if (task.state !== 'ready' || task.project_id === null) return;
      if (task.review_of_json !== null || task.landing_json !== null || task.knowledge_json !== null) return;
      if (ledger.projectStopped(task.project_id) !== null) return;
      if (!ledger.listRoles().some((role) => role.id === 'review')) return;
      const gate = ledger.reviewGateInfo(taskId);
      if (gate === null || (gate.kind !== 'no_review' && gate.kind !== 'stale_pass')) return;
      if (ledger.activeReview(taskId) !== null) return;
      autoReviewInFlight.add(taskId);
      try {
        const registered = await accept.register(taskId);
        const createdId = ledger.transaction(() => {
          const current = ledger.getTask(taskId);
          if (current.state !== 'ready' || current.project_id === null) return null;
          if (ledger.projectStopped(current.project_id) !== null) return null;
          if (ledger.activeReview(taskId) !== null) return null;
          const currentGate = ledger.reviewGateInfo(taskId);
          if (currentGate === null || (currentGate.kind !== 'no_review' && currentGate.kind !== 'stale_pass')) return null;
          const review = ledger.createTask(
            {
              projectId: current.project_id,
              title: `独立审阅：${current.title}`,
              goal: '独立审阅当前产物',
              acceptance: '交付审阅结论',
              roleId: 'review',
              reviewOf: { taskId, ...registered },
            },
            { actor: 'service' },
          );
          ledger.queueTask(review.id, { actor: 'service' });
          return review.id;
        });
        if (createdId !== null) publishChanged();
      } finally {
        autoReviewInFlight.delete(taskId);
      }
    }
    autoRequestReviewForRunner = async (run) => {
      await autoRequestReview(run.task_id);
    };
    // What a service that stopped in the middle of a taking left behind is nobody's: no
    // registration names it. Nothing is being taken over yet.
    accept.sweep();
    // A finished work's copies on disk, cleared once its retention period has passed
    // (docs/design/phase1-design.md "已结束的工作"): the host's registered directories through
    // the acceptor's sweep, and each machine's code copy through that machine's own client.
    const retention = createRetention({
      ledger,
      nodes,
      channel: nodeChannel,
      sweep: () => {
        accept.sweep();
        runner.pruneDiagnostics();
      },
      // The one guard for both the start-up pass and the timer (service/retention.ts):
      // stopping, degraded, or still running the recovery inventory means no pass at all,
      // and a pass already under way stops before its next machine command.
      blocked: () => stopping() || recovering || ledger.dispatchConditions().degraded,
      log,
    });
    // A pass that fails in a way it did not catch is said and left for the next one: nothing
    // here may take the service down.
    const retentionPass = (): void => {
      void retention.runOnce().catch((err: unknown) => log(`按保留期清理这一遍没有做完：${String(err)}`));
    };
    const tools = createTools({
      ledger, dataDir, github, runner, logins, machines, accept, nodes, reported, release: launchRelease,
      readReport: (run, ref, range) => readRunReport({ run, ref, dataDir, held: ledger.artifactsOfRun(run.id), readNode: runner.readReportFile, finalMessage: ledger.runReport(run.id), recoverFinal: runner.recoverRunReport, ...range }),
      nodeRelease: { host: programVersion(), reported: (machineId) => nodes.reportedRelease(machineId) },
      serviceManager: nodes.reportedServiceManager,
      localSkills: (machineId) => nodes.reportedSkills(machineId)?.local_skills ?? null,
      routerExecutorsFor: (projectId) => [binding(projectId).executor],
      inviteLimits: () => ({
        maxMachines: settings.get('node.inviteMaxMachines'), ttlMs: settings.get('node.inviteTtlMs'), maxTtlMs: SETTINGS['node.inviteTtlMs'].max,
        materialTtlMs: materialTtlMs(),
      }),
    });
    const rawStream = createStream();
    const stream: typeof rawStream = {
      get size() {
        return rawStream.size;
      },
      publish(event, data) {
        rawStream.publish(event, event === 'message' ? hydrateMessageEvent(ledger, data) : data);
      },
      attach: rawStream.attach,
      detach: rawStream.detach,
      close: rawStream.close,
    };
    publishChanged = () => stream.publish('changed', {});
    const loginToken = randomBytes(32).toString('hex');
    const shutdownToken = randomBytes(32).toString('hex');
    const identity: Instance = { pid: process.pid, version: programVersion(), program_dir: PROGRAM_DIR, started_at: new Date().toISOString() };
    try {
      const ver = ledger.recordHostVersion(identity.version);
      if (ver.upgraded) log(`平台已从 ${ver.previous} 升级至 ${ver.current}，历史规避类知识将自动标记待复核`);
    } catch (err) {
      log(`记录平台版本失败（不影响启动）：${err instanceof Error ? err.message : String(err)}`);
    }
    writeOwnerOnly(loginTokenFile(dataDir), loginToken);
    const auth = createAuth({
      ledger,
      dataDir,
      linkTtlMs: () => settings.get('login.linkTtlMs'),
      sessionDays: () => settings.get('login.sessionDays'),
      temporarySessionMs: () => settings.get('login.temporarySessionMs'),
    });
    if (discardSecret(passphraseSecretFile(dataDir))) log('发现上次没写完的主人口令临时文件，已删掉；现在用的还是原来的口令');
    // What the service listens on is read once, here: both items take a restart.
    const host = settings.get('http.host');
    let port = 0;
    let reverseProxyPort = 0;

    // The channel is made, and made again, from what is set at that moment. `wecomProblem`
    // is why it is switched on and still has no connection to make.
    let wecom: Wecom | undefined;
    let wecomProblem: string | null = null;
    let sender: OutboxSender | undefined;
    const secretFile = wecomSecretFile(dataDir);
    if (discardSecret(secretFile)) log('发现上次没换完的企业微信 Secret 留下的临时文件，已删掉；现在用的还是原来的 Secret');
    const notify = createNotify({
      ledger,
      owner: () => settings.get('wecom.owner'),
      publicUrl,
      direct: async (content) => {
        if (!imPermissions('wecom').notify) return;
        await wecom?.send({ chatid: settings.get('wecom.owner'), chat_type: 1 }, { msgtype: 'markdown', markdown: { content } });
      },
      log,
    });
    backups = createBackups({
      dataDir,
      config: () => backupConfig(settings),
      ledger,
      recovering: () => recovering,
      onFailure: notify.backupFailed,
      ...(options.backupClock ? { clock: options.backupClock } : {}),
      ...(options.backupHooks ? { hooks: options.backupHooks } : {}),
      log,
    });
    teardown.unshift([
      '等待备份',
      async () => {
        await backupsStopped;
      },
    ]);

    // Which models each account's executor reports it may use: asked at a connection test,
    // at a save and on a timer of its own, and kept beside the rest of what the account has
    // taught the service. Never dispatch: a query that cannot be made holds nothing up. For
    // executors whose model catalog is queried locally by CLI (e.g. Codex), centralized accounts
    // sync from the freshest catalog reported by an online machine (preferring newer CLI versions).
    const machineModels = (executor: string) => {
      let best: {
        connected: boolean;
        semver: string | undefined;
        atMs: number;
        at: string;
        models: NonNullable<ReportedStatus['models']>['list'];
      } | null = null;
      for (const machine of machines.list()) {
        const report = (options.reportedExecutors ?? nodes.reportedExecutors)(machine.id);
        const status = report?.executors.find((each) => each.executor === executor);
        if (!report || !status?.installed || !status.models || status.models.list.length === 0) continue;
        const candidate = {
          connected: nodes.connected(machine.id),
          semver: status.version ? versionOf(status.version) : undefined,
          atMs: Number.isFinite(Date.parse(report.at)) ? Date.parse(report.at) : 0,
          at: report.at,
          models: status.models.list,
        };
        if (best === null) {
          best = candidate;
          continue;
        }
        if (candidate.connected !== best.connected) {
          if (candidate.connected) best = candidate;
          continue;
        }
        if (candidate.semver && best.semver) {
          const cmp = compareVersions(candidate.semver, best.semver);
          if (cmp !== 0) {
            if (cmp > 0) best = candidate;
            continue;
          }
        } else if (candidate.semver && !best.semver) {
          best = candidate;
          continue;
        }
        if (candidate.atMs > best.atMs) best = candidate;
      }
      return best === null ? null : { models: best.models, at: best.at };
    };
    const models = createModels({
      ledger,
      logins: () => logins.accounts(),
      executors: adapters,
      token: (id) => accounts.credentialOf(id)?.value,
      notify,
      refreshMs: () => settings.get('models.refreshMs'),
      timeoutMs: checkTimeoutMs,
      recovering: () => recovering,
      machineModels,
      log,
    });
    teardown.unshift(['停下模型列表的定时查询', () => models.stop()]);
    const executorUpdates = createExecutorUpdates({
      ledger,
      machines,
      nodes,
      notify,
      onChanged: () => publishChanged(),
      recovering: () => recovering,
      log,
    });
    teardown.unshift(['停下执行器自动更新调度', () => executorUpdates.stop()]);
    // Whenever a machine connects or refreshes its executor probe, automatically sync centralized
    // accounts whose adapter relies on a machine-local CLI model catalog (e.g. Codex) if the
    // available model list changed or was never populated.
    nodes.onExecutors((_machineId, report) => {
      if (recovering) return;
      const reportedExecutors = new Set<string>();
      for (const status of report.executors) {
        if (!status.installed || !status.models || status.models.list.length === 0) continue;
        const query = adapters[status.executor]?.listModels?.({});
        if (query?.kind === 'command') reportedExecutors.add(status.executor);
      }
      if (reportedExecutors.size === 0) return;
      for (const account of logins.accounts()) {
        if (account.provider !== undefined || !reportedExecutors.has(account.executor)) continue;
        const best = machineModels(account.executor);
        if (!best) continue;
        const current = models.state(account.id);
        const signature = (list: typeof best.models) =>
          list.map((m) => `${m.id}:${m.hidden ? '1' : '0'}:${(m.efforts ?? []).join(',')}:${m.defaultEffort ?? ''}`).join('|');
        if (current.at !== null && signature(current.list) === signature(best.models)) continue;
        void models.refresh(account).then((result) => {
          if (result.ok) publishChanged();
        }).catch(() => {});
      }
    });

    // Which Claude Code the Router runs and whether it is signed in, as the pages, the
    // self-check and each start of the Router are told. `inUse` is what a running Router
    // process was started with: the answer is then about that process, whatever has been
    // saved since. Without it the answer is about the settings as they are now, which is
    // what the next start takes. One answer for whoever asks about the same thing.
    let inspection: { at: number; of: string; facts: Promise<ClaudeInspection> } | undefined;
    // Everything the Router runs as, as the settings and the account stand at this moment:
    // the account it is bound to, or this machine's own login and the executor's own
    // default tier. Read at each use, so no page or launch holds a copy. The token is the
    // account's; it goes to a process environment and nowhere else.
    interface Binding {
      account: string;
      executor: string;
      // The tier the settings name, as the account can run it: a place on the machine, or
      // the executor's own text. Null when no tier is named, or the account cannot run that
      // one (an operate name runs on the account's execute content, roles-and-tiers.md §10.3).
      tier: Tier | null;
      token: string;
      // The number the ledger gives the token named above, or null for none. A number,
      // not the token: it is what tells one token from another after the fact.
      credentialRef: string | null;
      // Why what is saved cannot be started, in words for the owner; null when it can.
      problem: string | null;
    }
    // The name an account reference goes by in the owner's words. A reference the ledger no
    // longer holds is named by what it was called when it was removed (service/ledger.ts
    // deletedAccountName); only when even that cannot be read does the sentence say so, and
    // an internal id never reaches a page, a reason or a check.
    const shownAccount = (id: string): string => logins.get(id)?.name ?? ledger.deletedAccountName(id) ?? '（已删除的账号）';
    function binding(projectId?: string): Binding {
      const project = projectId === undefined ? undefined : ledger.getProject(projectId);
      const none: Binding = { account: '', executor: 'claude', tier: null, token: '', credentialRef: null, problem: null };
      const account = project?.router_account ?? settings.get('router.account');
      if (account === '') return none;
      const held = logins.get(account);
      if (!held) return { ...none, account, problem: ledger.accountFolded(account) ? foldedRouterText(account) : `负责人绑定的账号 ${shownAccount(account)} 已经删了` };
      if (!adapters[held.executor]?.canRoute) {
        return { ...none, account, problem: `账号 ${held.name} 的执行器 ${held.executor} 不支持负责人` };
      }
      if (held.machine && held.machine !== ledger.hostMachine()) return { ...none, account, problem: `账号 ${held.name} 是其他机器上的登录，负责人只能使用主机上的登录` };
      const tier = project?.router_account != null ? project.router_tier ?? '' : settings.get('router.tier');
      // An operate Router on an account with no operate content runs on its execute content
      // (roles-and-tiers.md §10.3); the setting still names the tier it asked for.
      const named = (tier === '' ? undefined : tierValueFrom(held.tiers, tier)?.value) ?? null;
      const token = accounts.credentialOf(account);
      const bound: Binding = { account, executor: held.executor, tier: named, token: token?.value ?? '', credentialRef: token?.ref ?? null, problem: null };
      if (!held.machine && held.credential === 'missing') return { ...bound, problem: `账号 ${held.name} 的登录凭据缺失。请到账号页重新登录或更换密钥` };
      // A name the system no longer uses is not a missing tier of this account: it is said
      // as what it is, so the owner knows to pick one of the names in shared/tiers.ts.
      if (tier !== '' && !isTierId(tier)) return { ...bound, problem: tierOnlyText(tier) };
      if (tier !== '' && named === null) return { ...bound, problem: `账号 ${held.name} 没有档位 ${tier}` };
      // The executor's own reading of the value: a tier the CLI would drop without a word is
      // refused here rather than started on the CLI's own default one.
      if (named !== null) {
        if (held.executor === 'codex' && codexSettings(named.text).some(({ key }) => !['model', 'model_reasoning_effort'].includes(key.trim()))) return { ...bound, problem: 'Codex 负责人目前只支持档位中的 model 和 model_reasoning_effort' };
        if (held.executor === 'gemini' && named.text.trim() !== '') {
          try {
            const parsed: unknown = JSON.parse(named.text);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)
                && Object.keys(parsed as Record<string, unknown>).some((key) => !['model', 'effort'].includes(key))) {
              return { ...bound, problem: 'Gemini 负责人目前只支持档位中的 model 和 effort' };
            }
          } catch { /* checkTier below reports invalid JSON */ }
        }
        const why = adapters[held.executor]?.checkTier?.(named);
        if (why) return { ...bound, problem: `负责人的档位 ${tier} 用不了：${why}` };
      }
      return bound;
    }
    const bindingKey = ({ account, tier, credentialRef, problem }: Binding): string =>
      JSON.stringify({ account, tier, credentialRef, problem });
    // Why the account a process that is already running holds can no longer be used. The
    // settings are not asked: what is bound now takes effect at the next start, and this
    // is about the process the service has. Null for a Router on this machine's own login.
    const runningProblem = (account: string, name?: string): string | null => {
      const held = logins.get(account);
      if (!held) return `负责人用的账号 ${name ?? shownAccount(account)} 已经不在了。改绑一个账号，然后点“重启负责人”`;
      if (!adapters[held.executor]?.canRoute) {
        return `账号 ${held.name} 的执行器是 ${held.executor}，不支持负责人。改绑另一个账号，然后点“重启负责人”`;
      }
      if (held.machine && held.machine !== ledger.hostMachine()) return `账号 ${held.name} 不在主机上`;
      return null;
    };
    // The environment a start would take now: what the saved settings and account say.
    const routerEnvFor = ({ token }: Binding): NodeJS.ProcessEnv => routerEnv(undefined, token);
    async function inspectBinding(selected: Binding): Promise<ClaudeInspection> {
      const env = routerEnvFor(selected);
      const { claude } = options;
      if (claude) return { path: claude.join(' '), command: claude, problem: null, login: await loginState(claude, env) };
      return inspectClaude(settings.get('router.cli'), env);
    }

    async function inspectNow(inUse?: RouterLaunch): Promise<ClaudeInspection> {
      const exec = inUse?.executor ?? binding().executor;
      if (exec === 'codex' || exec === 'gemini') return { path: inUse?.path ?? inUse?.claude.join(' ') ?? null, command: inUse?.claude ?? null, problem: null, login: null };
      if (inUse) {
        // The token the process was started with, if the ledger still names it: the
        // number is what says whether the two are the same one. A number whose file is
        // gone names nothing, and then there is nothing to ask that process with either.
        const held = inUse.account === undefined ? undefined : accounts.credentialOf(inUse.account);
        const same = (inUse.credentialRef ?? null) === (held?.ref ?? null);
        const env = same ? routerEnv(undefined, held?.value ?? '') : routerEnvFor(binding());
        const login = await loginState(inUse.claude, env);
        // The setting can name a file that is gone while this process runs on another one:
        // that is a fact about the setting, and the pages say it.
        const gone = missingClaudeSetting(settings.get('router.cli'));
        // A number the owner has replaced or cleared since: the file that process holds is
        // gone, so nothing can say what it would be refused for. What was asked is the
        // saved one, which is a question about the next start.
        return {
          path: inUse.path ?? inUse.claude.join(' '),
          command: inUse.claude,
          problem: null,
          ...(gone === undefined ? {} : { settingGone: gone }),
          login,
          ...(same ? {} : { loginOfNextStart: true as const }),
        };
      }
      return inspectBinding(binding());
    }
    function inspectCli(fresh = false, inUse?: RouterLaunch | null): Promise<ClaudeInspection> {
      // What the answer is about, and no secret: a token is the same account's answer
      // whatever it is, and it must not sit in a string this process keeps. The number
      // stands for the token, and the saved binding is in it because a replaced token, a
      // cleared one or a rebound account all change what the answer would be.
      const of = inUse
        ? JSON.stringify({
            claude: inUse.claude,
            account: inUse.account ?? '',
            credentialRef: inUse.credentialRef ?? '',
            saved: bindingKey(binding()),
          })
        : bindingKey(binding());
      if (fresh || inspection?.of !== of || performance.now() - inspection.at > CLI_FACTS_FRESH_MS) {
        inspection = { at: performance.now(), of, facts: inspectNow(inUse ?? undefined) };
      }
      return inspection.facts;
    }
    // What the settings name for the next start of the Router, without asking the CLI or
    // starting anything: the bound account's login and tier, resolved now.
    const routerSaved = (): RouterSetup => {
      const { account, executor, tier, credentialRef } = binding();
      let cliPath: string | null = null;
      if (executor === 'codex') {
        try { cliPath = launchOf(['codex'], process.env).found ?? null; } catch { /* The Router reports its launch error. */ }
      } else if (executor === 'gemini') {
        try { cliPath = launchOf(['agy'], process.env, process.platform, { places: geminiAdapter.installs }).found ?? null; } catch { /* The Router reports its launch error. */ }
      }
      return {
        executor,
        cli: executor === 'codex' || executor === 'gemini' ? cliPath : options.claude?.join(' ') ?? claudePath(settings.get('router.cli')) ?? null,
        account: account === '' ? '' : shownAccount(account), token: credentialRef !== null, tier,
      };
    };
    // What a Router process is started with, from the settings and the account as they are
    // now; or why it cannot be started, which stops the Router and leaves the service
    // running.
    function codexRouterCommand() {
      if (!existsSync(join(import.meta.dirname, 'router-codex.ts'))) throw new RouterUnavailable('Codex 负责人传输尚未安装');
      const found = launchOf(['codex'], process.env);
      if (found.verbatim) throw new RouterUnavailable('Codex 命令包装器不能直接启动；请安装标准 npm 包或可执行文件');
      return found;
    }

    function geminiRouterCommand() {
      if (!existsSync(join(import.meta.dirname, 'router-gemini.ts'))) throw new RouterUnavailable('Gemini 负责人传输尚未安装');
      const found = launchOf(['agy'], process.env, process.platform, { places: geminiAdapter.installs });
      if (found.verbatim) throw new RouterUnavailable('Gemini 命令包装器不能直接启动；请安装标准 agy 可执行文件');
      return found;
    }

    async function routerLaunch(projectId?: string): Promise<RouterLaunch> {
      const selected = binding(projectId);
      const { account, executor, tier, token, credentialRef, problem } = selected;
      const projectOverride = projectId !== undefined && ledger.getProject(projectId).router_account !== null;
      const identity = projectOverride ? { loginGeneration: ledger.quotaGeneration(account) } : {};
      const fix = projectOverride
        ? '在项目设置中换一个负责人账号，或到账号页恢复登录'
        : ROUTER_FIX;
      if (problem) throw new RouterUnavailable(problem + '。' + fix);
      if (executor === 'codex') {
        const found = codexRouterCommand();
        let leasedToken = token;
        let leaseExpiresAt: number | undefined;
        if (account !== '' && credentialRef !== null) {
          const leased = await codexAuth.lease(account);
          if (!leased || leased.ref !== credentialRef) {
            throw new RouterUnavailable(`账号 ${shownAccount(account)} 的 Codex 登录已失效或暂时无法刷新。${fix}`);
          }
          leasedToken = leased.value;
          const parsedLease = decodeCodexOAuthLease(leasedToken);
          if (parsedLease) leaseExpiresAt = codexAccessExpiryMs(parsedLease.access_token);
        }
        return { claude: [found.command, ...found.args], path: found.found, executor: 'codex', account, accountName: logins.get(account)?.name,
          ...identity, ...(leasedToken ? { token: leasedToken } : {}), ...(credentialRef === null ? {} : { credentialRef }),
          ...(leaseExpiresAt === undefined ? {} : { leaseExpiresAt }), ...(tier === null ? {} : { tier }) };
      }
      if (executor === 'gemini') {
        const found = geminiRouterCommand();
        const baseUrl = account !== '' ? geminiBaseUrl(accounts.get(account)?.provider) : undefined;
        return {
          claude: [found.command, ...found.args],
          path: found.found,
          executor: 'gemini',
          account,
          accountName: logins.get(account)?.name,
          ...identity,
          ...(token ? { token } : {}),
          ...(baseUrl ? { baseUrl } : {}),
          ...(credentialRef === null ? {} : { credentialRef }),
          ...(tier === null ? {} : { tier }),
        };
      }
      const found = await inspectBinding(selected);
      if (!found.command) throw new RouterUnavailable(`${found.problem}。装好 Claude Code 或填上它的路径：${ROUTER_FIX}`);
      if (found.login?.loggedIn === false) {
        throw new RouterUnavailable(account === ''
          ? `负责人用的 Claude 没有登录。在这台电脑上以运行服务的用户运行 claude 完成登录，或在“设置 › 负责人”里绑定一个账号，然后点“重启负责人”`
          : `账号 ${shownAccount(account)} 的 Claude 登录没有被接受。到账号页给这个账号点“重新登录”，或在“设置 › 负责人”里改绑另一个账号，然后点“重启负责人”`);
      }
      return {
        claude: found.command,
        ...identity,
        ...(found.path ? { path: found.path } : {}),
        ...(account ? { account, accountName: accounts.get(account)?.name } : {}),
        ...(token ? { token } : {}),
        ...(credentialRef === null ? {} : { credentialRef }),
        ...(tier === null ? {} : { tier }),
      };
    }

    // Account quota uses the adapter's HTTP declaration, Codex OAuth reader, and DSH official/New-API balance reader.
    const dshQuotaReader = createDshQuotaReader({
      token: (id) => accounts.credentialOf(id)?.value,
      ledger,
      timeoutMs: () => settings.get('quota.readTimeoutMs'),
    });
    const quotaReads = createQuotaReads({
      ledger,
      adapters,
      refreshModels: (account) => models.refresh(account),
      token: (id) => accounts.credentialOf(id)?.value,
      customRead: combineQuotaReaders(codexAuth.quotaReader, dshQuotaReader),
      timeoutMs: () => settings.get('quota.readTimeoutMs'),
      staleMs: () => settings.get('quota.readStaleMs'),
      log,
      onSettled: () => stream.publish('changed', {}),
    });
    onCodexRelogin = (accountId) => {
      const acc = accounts.get(accountId);
      if (acc) quotaReads.readStale([acc]);
    };
    teardown.unshift(['停下正在读的额度', () => quotaReads.stop()]);

    // Only a WeCom message has a stream, so everything else falls through here.
    const observer: TurnObserver = {
      onQueued: (id, position) => wecom?.streamFor(id)?.update({ queue: `排队中，前面还有 ${position} 条` }),
      onTurnStart: (id) => wecom?.streamFor(id)?.update({ queue: null }),
      onDraft: (id, text) => wecom?.streamFor(id)?.update({ body: text }),
      onTool: (id, tool) => wecom?.streamFor(id)?.tool(tool),
      // With no reply, no Outbox row will ever end the bubble.
      onTurnEnd(id, state, replied) {
        if (state === 'processed' && !replied) void wecom?.streamFor(id)?.finish(NO_REPLY);
      },
    };
    const session = createSessionHost({
      ledger,
      dataDir,
      launchWith: routerLaunch,
      projectBinding: (id) => {
        const project = ledger.getProject(id);
        if (project.router_account === null) return null;
        const selected = binding(id);
        return JSON.stringify([bindingKey(selected), selected.executor, ledger.quotaGeneration(selected.account)]);
      },
      bindingProblem: runningProblem,
      turnTimeoutMs: () => options.routerTurnTimeoutMs ?? settings.get('router.turnTimeoutMs'),
      initTimeoutMs: () => settings.get('router.startTimeoutMs'),
      interruptGraceMs: () => settings.get('router.interruptGraceMs'),
      toolNames: tools.names,
      toolDefinitions: (projectId) => tools.list({ projectId }),
      // A project's Router: the global entries and its own, for any role (project-sessions §3).
      knowledge: (projectId) => routerKnowledge(ledger.applicable(projectId, null), { hostVersion: ledger.hostVersionState() }),
      material: (projectId) => routerMaterial(ledger, projectId, settings.get('router.materialKb') * 1024),
      idleMs: () => options.routerIdleMs ?? settings.get('router.idleMs'),
      contextTokens: () => settings.get('router.contextTokens'),
      // Only the recorded local registration identifies this host's own login. With no
      // binding, the context records its display name without inventing a login reference.
      hostLogin: () => { const machine = ledger.hostMachine(); return machine == null ? null : ledger.getMachineLogin(machine, 'claude')?.id ?? null; },
      verifyAccountAuth: (account, ref) => codexAuth.verifyCredential(account, ref),
      publish: stream.publish,
      observer,
      notify,
      onHalt: notify.routerHalted,
      ...(options.processes ? { processes: options.processes } : {}),
      log,
    });
    const dispatcher = createDispatcher({
      ledger,
      dataDir,
      runner,
      logins,
      machines,
      executors: adapters,
      runTimeoutMs,
      modelIdleTimeoutMs: () => settings.get('run.modelIdleTimeoutMs'),
      knowledgeLimits: () => knowledgeLimits(settings),
      reportedEntry: nodes.reportedEntry,
      outputReady,
      externalEntryEnabled,
      log,
      // A folder source waits for its one machine, and a client of another protocol takes no
      // work: both are said on the Task page (docs/design/code-sources.md §2).
      connected: (machineId) => nodes.connected(machineId),
      refusedProtocol: (machineId) => nodes.refusesProtocol(machineId),
      lostGraceMs,
      frontLead: () => settings.get('dispatch.frontLead'),
      usageWarnAt: () => settings.get('quota.warnPercent') / 100,
      ...clock,
      onNoMachine: notify.noMachine,
      // §1.3: what an ephemeral machine says it can run is part of the intersection work is
      // dispatched within — a machine whose own report says the executor is not there is
      // not offered its work. No report yet is not "not installed".
      capable: (machineId, executor) => reported(machineId, executor)?.installed !== false,
      reported,
      signingIn: signIns.busy,
      // And an ephemeral machine whose work here is over is told so; it leaves by itself.
      // One that is not connected is asked again on a later sweep, when it is.
      retire: async (machineId) => {
        if (!nodes.connected(machineId)) return false;
        await nodes.send(machineId, { kind: 'retire' });
        return true;
      },
      // A review round's product: the reviewed round's file, as its registration holds it.
      ...(options.dispatchIntervalMs === undefined ? {} : { intervalMs: options.dispatchIntervalMs }),
      ...(options.watchIntervalMs === undefined ? {} : { watchIntervalMs: options.watchIntervalMs }),
    });
    kickAfterAuthRefresh = () => {
      stream.publish('changed', {});
      void dispatcher.tick();
    };

    const channelStatus = () =>
      wecom?.status() ?? (wecomProblem === null ? null : { connected: false, since: null, error: wecomProblem });

    // One release at a time, and one answer about it. Either this service started the
    // command (it is the one being stopped, so the flag lives as long as that can be the
    // case), or one is at work in the program directory right now: the installer holds its
    // lock from before the switch until the rollback and the record of the result are done.
    let launching = false;
    const releasePrefix = prefixOf(PROGRAM_DIR);
    const inFlight = (): boolean => launching || (releasePrefix !== null && upgradeRunning(releasePrefix));
    const startUpgrade = options.launch ?? upgradeStarter(realSystem(), log);

    // Putting a package a round brought back in place: the console's entry and the Router's
    // release_task are this one function, behind the same gate.
    function launchRelease(runId: string, chosen: ReleaseFile, ctx: Ctx): { started: boolean; version: string } {
      if (!nameIsSafe(runId)) throw new InputError(`不认识的 Run：${runId}`);
      // The file the owner confirmed, by name, digest and size, as the round's
      // registration holds it, hashed again as it is now: what was received and what is
      // installed have to be the same bytes. A round the retention rule cleared has no bytes
      // here any more, and says so in the same words the page does.
      const held = ledger.artifactsOfRun(runId);
      if (held?.releases_dropped_at != null) throw new InputError(artifactsDroppedText({ at: held.releases_dropped_at }));
      const found = registeredPackage(dataDir, held, chosen);
      if (!found) throw new InputError(`这一轮的 ${chosen.name} 和确认时不一样，或者已经不在了：重新验收这一轮，再上线`);
      // One release at a time: a second request for the same one is answered with the
      // state of the first, not with a second command.
      if (inFlight()) return { started: false, version: found.version };
      const prefix = prefixOf(PROGRAM_DIR);
      if (prefix === null) throw new InputError('这是源码目录里的 tycho，没有可切换的版本：用 git pull 更新它');
      const launcher = launcherPath(prefix, process.platform);
      if (!existsSync(launcher)) throw new InputError(`${launcher} 不在：重新运行一次安装脚本，或运行 tycho doctor 看安装`);
      // The promise made when the owner clicks is a health check and a way back to the
      // version before; both are the autostart's to give, because it is what stops the
      // service and what starts the next version in its place. A service nobody manages
      // keeps running the old program while `current` moves under it, and the version
      // just installed is left unrun and unchecked for the next start. Asked here, in
      // the same words the command that does the work asks it.
      const managed = autostartManages(realSystem(), PROGRAM_DIR, dataDir);
      if (!managed.managed) {
        throw new InputError(
          `这个服务不归开机自启管（${managed.why}）：升级命令换完版本以后，没有谁能把新版本启起来核对，也就没有健康检查和退回上一版，这样的上线不能从控制台做。`
          + '让它归开机自启管：运行 tycho service install，再点上线（现在这一份不用停，上线时它会停下来，新版本由开机自启启动）。'
          + `或者自己运行 tycho update --from <包>：程序会换，但这一版不会有人核对，下次启动才生效。`,
        );
      }
      // The same gate as acceptance (roles-and-tiers.md §4): a package of a Task that
      // needs review goes in place only when a current pass covers this very file, or
      // when the owner accepted the Task without review. A Run the ledger does not hold
      // is refused in its own words: nothing says it was reviewed.
      const unreviewed = ledger.releaseGate(runId, { name: found.name, sha256: found.sha256, bytes: found.bytes });
      if (unreviewed !== null) throw new InputError(unreviewed);
      // Who asked for it, the owner or the Router under its project's grant, before anything is
      // started: a ledger that cannot take the line starts nothing. What became of it is the
      // result the command records later.
      ledger.noteAction('release.launch', ctx, { taskId: ledger.getRun(runId)?.task_id, runId }, { name: found.name, version: found.version, sha256: found.sha256 });
      // The intent is written before the command exists: it is what the console reads
      // while the service is going down, and what the command is checked against.
      writeReleaseIntent(dataDir, {
        at: new Date().toISOString(),
        run_id: runId,
        name: found.name,
        version: found.version,
        sha256: found.sha256,
        bytes: found.bytes,
        file: found.file,
      });
      const trouble = startUpgrade({ launcher, packageFile: found.file, version: found.version, sha256: found.sha256, dataDir });
      if (trouble !== null) throw new Error(`没能启动升级命令（${trouble}）：自己运行 tycho update --from ${found.file}`);
      launching = true;
      log(`开始上线 ${found.version}：${found.file}`);
      return { started: true, version: found.version };
    }

    // Stops the connection there is and makes the one the settings and the Secret now
    // describe. Called at the start and after any of them changes: no restart needed.
    function connectWecom(): void {
      wecom?.stop();
      wecom = undefined;
      wecomProblem = null;
      if (stopping()) return;
      updateChannels();
      if (!wecomEnabled()) return;
      const owner = settings.get('wecom.owner');
      const secret = readSecret(secretFile);
      // The settings refuse to switch it on like this; a file removed by hand still can.
      if (!secret || !owner) {
        wecomProblem = secret ? '没有填接收人' : '没有设置 Secret';
        log(`企业微信启用了但连不了：${wecomProblem}`);
        return;
      }
      // The first time only: after that the list is the owner's to keep.
      const whitelist = ledger.getWhitelist();
      if (!whitelist.wecom) ledger.setWhitelist({ ...whitelist, wecom: [owner] }, SERVICE);
      if (!publicUrl()) log('没有填对外地址：企微发出的登录链接在手机上打不开');
      const url = settings.get('wecom.url');
      wecom = createWecom({
        ...(url ? { url } : {}),
        botId: settings.get('wecom.botId'),
        publicUrl,
        secret,
        ledger,
        createLoginUrl: () => loginUrl({ host, publicUrl: publicUrl() }, port, loginLinkPath(auth.createLink().credential)),
        loginValidity: auth.linkValidity,
        approveDeviceLogin: (code, actor, temporary) => auth.decideDeviceLogin(code, true, { actor: `wecom:${actor}` }, temporary, 'wecom'),
        decideJoin: (joinId, approve, actor) => nodes.decide({ id: joinId }, approve, { actor: `wecom:${actor}` }),
        permissions: () => imPermissions('wecom'),
        imGateway,
        onMessage(id) {
          stream.publish('message', ledger.getMessage(id));
          session.kick(id);
        },
        log,
        ...(options.wecomStreamTiming ? { streamTiming: options.wecomStreamTiming } : {}),
      });
      wecom.start();
    }
    // A machine asking to join is put before the owner on the phone as well (nodes.md §1.1
    // step 2). Sent straight, not through the Outbox: the request lives in memory and dies
    // with a restart, so a card held for later would only ever point at nothing.
    nodes.onJoinRequest((join) => {
      const channel = wecom;
      if (channel && imPermissions('wecom').notify) {
        channel.send({ chatid: settings.get('wecom.owner'), chat_type: 1 }, { msgtype: 'template_card', template_card: notify.card(null, joinCard(join), '/machines') })
          .catch((err: unknown) => log(`新机器加入的企微卡片没有发出：${(err as Error).message}`));
      }
      if (weixin && weixin.status().state === 'connected' && imPermissions('weixin').notify) {
        const text = `新机器申请加入：${join.name}（${join.platform}）\n放行码：${join.code}\n回复“放行 ${join.code}”或“拒绝 ${join.code}”，也可在控制台“放行”中处理。`;
        weixin.sendDirectText(text)
          .catch((err: unknown) => log(`新机器加入的微信通知没有发出：${(err as Error).message}`));
      }
    });
    // After the commit, so only what the ledger cannot hold: what it can, the whitelist
    // that follows the receiver included, was written with the setting.
    settings.subscribe((key) => {
      if (key.startsWith('backup.')) backups?.reconfigure();
      if (key.startsWith('router.')) inspection = undefined;
      if (key === 'knowledge.externalEntry') writeHostEntry();
      if (key === 'models.refreshMs') models.reschedule();
      // Before the port is known there is no connection yet to make again.
      if (key.startsWith('wecom.') && port !== 0) connectWecom();
      if (key.startsWith('gateway.') && port !== 0) gateway.reconfigure();
    });
    const wecomSecret = {
      isSet: (): boolean => readSecret(secretFile) !== '',
      // The order of service/secrets.ts: a Secret the ledger could not record is not put
      // in place, and one not put in place is not said to be set, nor connected with.
      // The value goes to the file and nowhere else.
      set(secret: unknown, ctx: Ctx): void {
        replaceSecret(secretFile, secret, () => ledger.noteAction('wecom.secret_set', ctx));
        if (port !== 0) connectWecom();
      },
    };

    // The connection to the gateway and the listener its requests arrive at come and go
    // together, as the settings stand: no restart for either.
    const gateway = createGateway({
      config: () => ({
        ssh: settings.get('gateway.ssh'),
        wss: settings.get('gateway.wss'),
        keyFile: settings.get('gateway.keyFile'),
        remotePort: settings.get('gateway.remotePort'),
        localPort: settings.get('gateway.localPort'),
      }),
      marker: gatewayMarker(dataDir),
      pidFile: join(dataDir, 'gateway.pid'),
      // Not the service's own port. Windows lets 127.0.0.1 be bound next to 0.0.0.0, and
      // this machine's own requests would then land on a listener that has none of their routes.
      async listen(outsidePort) {
        if (outsidePort === port) throw new Error(`对外入口的端口不能和服务自己的端口（${port}）相同。到“设置 › 门牌”换一个`);
        await http.outside.listen(outsidePort);
      },
      unlisten: () => http.outside.close(),
      ...(options.ssh ? { command: options.ssh } : {}),
      ...(options.processes ? { processes: options.processes } : {}),
      log,
    });

    // The Router is read once per check: the login asked about is that reading's process.
    async function checkCodexRouter(login: Binding): Promise<Pick<DoctorCheck, 'level' | 'text'> | undefined> {
      if (login.executor !== 'codex' || login.problem) return undefined;
      try { codexRouterCommand(); }
      catch (error) { return { level: 'fail', text: (error as Error).message }; }

      const account = accounts.get(login.account);
      if (!account || !codexAuth.quotaReader.canRead(account)) {
        return { level: 'warn', text: '已找到 Codex 命令，尚无可查询的托管 OAuth 授权' };
      }
      const refusal = quotaReads.refusal(account);
      if (refusal) return { level: 'fail', text: refusal };
      const cached = quotaReads.state(account.id);
      const fresh = cached.tried_at !== null && Date.now() - Date.parse(cached.tried_at) < CLI_FACTS_FRESH_MS;
      if (!fresh || cached.reading) await quotaReads.read(account);
      if (bindingKey(binding()) !== bindingKey(login)) return { level: 'warn', text: '检查期间负责人绑定已更改，请再查一次' };
      const denied = quotaReads.refusal(account);
      if (denied) return { level: 'fail', text: denied };
      const result = quotaReads.state(account.id);
      if (result.failure || result.limited || !result.tried_at) {
        return { level: 'warn', text: result.failure ?? result.limited ?? '尚未核对 Codex 授权' };
      }
      return { level: 'ok', text: 'Codex 命令可用，托管授权已通过额度查询验证' };
    }

    function checkGeminiRouter(login: Binding): Pick<DoctorCheck, 'level' | 'text'> | undefined {
      if (login.executor !== 'gemini' || login.problem) return undefined;
      try { geminiRouterCommand(); }
      catch (error) { return { level: 'fail', text: (error as Error).message }; }
      if (login.credentialRef !== null) {
        return { level: 'ok', text: 'agy 命令可用，使用托管 Gemini API 密钥' };
      }
      return { level: 'warn', text: '已找到 agy 命令，本机 Gemini 登录状态将在处理消息时核验（未登录可在本机运行 agy acp --login）' };
    }

    const selfCheck = async (): Promise<DoctorCheck[]> => {
      const router = session.status();
      const login = binding();
      const codexHealth = await checkCodexRouter(login);
      const geminiHealth = checkGeminiRouter(login);
      return doctor({
        dataDir,
        settings,
        claude: await inspectCli(false, router.launched),
        router,
        routerLogin: {
          executor: login.executor,
          account: login.account === '' ? '' : shownAccount(login.account),
          token: login.credentialRef !== null,
          // Why the binding cannot be started, said as itself: with one, the check is that
          // reason and nothing else (docs/design/native-login.md §2).
          problem: login.problem,
          ...(codexHealth ? { codexHealth } : {}),
          ...(geminiHealth ? { geminiHealth } : {}),
        },
        // Logins expected to run out, as the ledger reads them from the executors' own
        // declarations: the same derivation the expiry notices are made from.
        expiringLogins: ledger.expiringAccounts(new Date()),
        // Projects with no login left to run as, from the ledger's own pool derivation: the
        // overview lists the same, and the check points at each project's settings.
        projectsWithoutLogins: ledger.projectsWithoutLogins(),
        listening: { host, port, reverseProxyPort },
        logins: logins.list(),
        machines: runner.machines(),
        missingLogins: [...new Set(ledger.listActiveRuns().filter(loginMissing).map((run) => run.login_name ?? '已删除的登录'))],
        hostMachine: ledger.hostMachine(),
        wecomSecretSet: wecomSecret.isSet(),
        wecom: channelStatus(),
        gateway: gateway.status(),
      });
    };

    weixin = createWeixin({
      file: join(dataDir, 'secrets', 'weixin.json'), ledger,
      createLoginUrl: () => loginUrl({ host, publicUrl: publicUrl() }, port, loginLinkPath(auth.createLink().credential)),
      loginValidity: auth.linkValidity,
      publicUrl,
      approveDeviceLogin: (code, actor, temporary) => auth.decideDeviceLogin(code, true, { actor: `weixin:${actor}` }, temporary, 'weixin'),
      decideJoin: (code, approve, actor) => nodes.decide({ code }, approve, { actor: `weixin:${actor}` }),
      permissions: () => imPermissions('weixin'),
      onMessage(id) { stream.publish('message', ledger.getMessage(id)); session.kick(id); },
      onChanged() { updateChannels(); stream.publish('changed', {}); },
      log,
    });
    weixinLoaded = true;
    updateChannels();
    const weixinNotify = createNotify({ ledger, owner: () => weixin?.ownerTarget()?.chatid ?? '', publicUrl, direct: async () => {} });
    const http = createHttp({
      dataDir,
      replay: createReplayConsole({ dataDir }),
      weixin,
      github,
      ledger,
      claudeLogin,
      codexLogin,
      signIns,
      runner,
      tools,
      accept,
      deliverables: { ingestTask: deliverables.ingestTask },
      auth,
      session,
      stream,
      // A deleted project's copies go at once, not at the next hourly pass: its registered
      // directories through the acceptor's sweep, its machine's code copy through retention.
      cleanupAfterProjectDelete: retentionPass,
      loginToken,
      shutdownToken,
      onShutdown: () => void stop('收到本机的停止请求（tycho stop、升级或上线）'),
      instance: () => ({ ...identity, port, host, data_dir: dataDir }),
      // What a command putting a release in place asks of this one. The ledger read is
      // the point: an open connection that answers is the proof that it can be read.
      releaseCheck: () => {
        let reads = 'ok';
        try {
          ledger.listActiveRuns();
        } catch (err) {
          reads = (err as Error).message;
        }
        return { ledger: reads, degraded: ledger.dispatchConditions().degraded, recovering, health_window_ms: settings.get('release.healthWindowMs'), recovery_wait_ms: settings.get('release.recoveryWaitMs') };
      },
      // §3: an upgrade waits for the turn being handled, up to what the owner allows,
      // and goes ahead without it after that.
      drain: async () => {
        // A login cannot outlive the service: from this moment no new one starts (one still being
        // prepared starts nothing when its preparation returns), and those under way are cancelled
        // and their processes reclaimed. The service is about to stop, so this is not undone.
        await claudeLogin.stopAll({ close: 'upgrading' });
        await codexLogin.stopAll({ close: 'upgrading' });
        signIns.stopAll();
        const limit = settings.get('release.drainTimeoutMs');
        const from = Date.now();
        // Every project's turn (project-sessions §3), not one of them.
        while (limit > 0 && session.status().turns.length > 0 && Date.now() - from < limit) {
          await sleep(Math.min(500, Math.max(1, limit - (Date.now() - from))));
        }
        return { drained: session.status().turns.length === 0, waited_ms: Date.now() - from };
      },
      // The packages the Runs brought back, and putting one in place: only an installed
      // copy has a version to switch to, and the launcher is the version-independent way
      // to reach the command that does it. That command outlives this service — it is the
      // one that stops it — so it is started detached from it (cli/upgrade.ts).
      releases: {
        dataDir,
        version: identity.version,
        last: () => readReleaseResult(dataDir),
        intent: () => readReleaseIntent(dataDir),
        attempting: () => inFlight(),
        launch: launchRelease,
      },
      loginUrl: (path) => loginUrl({ host, publicUrl: publicUrl() }, port, path),
      publicUrl,
      projectDirectory,
      gateway: gateway.status,
      reverseProxyPort: () => reverseProxyPort,
      channels: () => ({ wecom: channelStatus(), weixin: weixin ? { state: weixin.status().state, error: weixin.status().error } : null }),
      orphans: () => orphans,
      backup: backups,
      settings,
      accounts,
      logins,
      models,
      executorUpdates,
      quota: quotaReads,
      machines,
      nodes,
      nodeRelease: nodeReleases,
      nodeReleaseCheckMs: () => settings.get('node.releaseCheckMs'),
      // What a machine fetches when it is told to prepare a round, and the one token it
      // may ask for while starting it. Both read the Run as the ledger holds it now, and
      // neither is ever written down.
      globalEntry: { content: entryContent, hostReport: () => hostEntry, repairHost: repairHostEntry },
      roundSnapshot(runId) {
        const run = ledger.getRun(runId);
        if (!run) return null;
        return { run_dir: runDirOf(run.task_id, run.id), files: snapshotFiles(snapshotOf(run), reviewFiles(run)) };
      },
      async roundCredential(runId) {
        const run = ledger.getRun(runId);
        if (!run || run.state === 'ended') return null;
        const snapshot = snapshotOf(run);
        const adapter = adapters[snapshot.executor ?? ''];
        if (!adapter?.credential || run.login_id === null) return null;
        const held = snapshot.executor === 'codex'
          ? await codexAuth.lease(run.login_id)
          : accounts.credentialOf(run.login_id);
        // The same guard the Runner applies before a start: a token the owner replaced
        // since this Run was created is not this round's to use.
        if (!held || (snapshot.credential_ref ?? null) !== held.ref) return null;
        return { run_id: runId, value: held.value };
      },
      // The one-time join materials for a round that is starting (nodes.md §1.3): minted
      // at this moment, for this round. Null when its task has no open quota. Only a round
      // that is being started is handed any.
      roundInvite(runId) {
        const run = ledger.getRun(runId);
        if (!run || run.state !== 'launching') return null;
        return invite.hand(run.task_id, run.id) ?? null;
      },
      wecomSecret,
      reconnectWecom: () => {
        if (!wecomEnabled()) return null;
        if (port !== 0) connectWecom();
        stream.publish('changed', {});
        return channelStatus();
      },
      knowledgeTokens: knowledgeTokenStore(dataDir),
      inbounds,
      skillFolder: join(dataDir, 'skills'),
      doctor: selfCheck,
      deployment: async () => {
        const { launched } = session.status();
        return deploymentFacts({ dataDir, listening: { host, port }, claude: await inspectCli(false, launched), launched, saved: routerSaved() });
      },
      waitingLogins: dispatcher.waitingLogins,
      taskWait: dispatcher.waitOf,
      ...clock,
      lostGraceMs,
      nodeLookEveryMs: () => settings.get('node.executorRefreshMs'),
      nodeModelListTimeoutMs: () => settings.get('node.modelListTimeoutMs'),
      nodeQuotaReadTimeoutMs: () => settings.get('node.quotaReadTimeoutMs'),
      loginLimit: {
        windowMs: () => settings.get('login.failWindowMs'),
        perSource: () => settings.get('login.failsPerSource'),
        total: () => settings.get('login.failsTotal'),
      },
      ...(options.consoleDir === undefined ? {} : { consoleDir: options.consoleDir }),
      log,
    });
    teardown.unshift(['关闭 HTTP', () => http.close()]);
    teardown.unshift(['断开门牌', () => gateway.stop()]);
    // After the Router, which has the last words to queue, and before the ledger.
    teardown.unshift([
      '收尾通道和 Outbox',
      async () => {
        wecom?.stop();
        weixin?.stop();
        await sender?.stop();
      },
    ]);
    // Both calls take effect before their first await. A Runner call in flight can
    // outlast its abort by minutes, and the Router has no reason to wait for that.
    teardown.unshift([
      '收尾派发和负责人',
      async () => {
        const hostStopped = session.stop();
        const dispatchStopped = dispatcher.stop().then(() => true);
        const waitMs = options.stopWaitMs ?? STOP_WAIT_MS;
        // Settled, not all: a Host that failed to stop is no reason to cut the wait short.
        const [dispatch, router] = await Promise.allSettled([
          Promise.race([dispatchStopped, sleep(waitMs, false, { ref: false })]),
          hostStopped,
        ]);
        if (dispatch.status === 'fulfilled' && !dispatch.value) log(`派发循环 ${waitMs} 毫秒内没有收尾，不再等`);
        if (router.status === 'rejected') throw router.reason;
      },
    ]);
    // Before anything it writes to closes. One that outlasts this finds the stop request
    // when its call returns, and does nothing further.
    teardown.splice(1, 0, [
      '等待恢复任务',
      async () => {
        if (!recoveryTask) return;
        const waitMs = options.stopWaitMs ?? STOP_WAIT_MS;
        const finished = await Promise.race([recoveryTask.then(() => true), sleep(waitMs, false, { ref: false })]);
        if (!finished) log(`恢复任务 ${waitMs} 毫秒内没有收尾，不再等`);
      },
    ]);

    // `busy`: the projects whose turn is still under way; their messages end by themselves.
    function markUnfinished(busy: readonly string[] = []): void {
      const unfinished = ledger.transaction(() => {
        const ids = ledger.markProcessingUnverified(busy);
        const messages = ids.map((id) => ledger.getMessage(id));
        // A merged turn's messages were being handled as one: the later ones say what the first
        // one committed, as the Session Host does when it ends a turn.
        turnFirsts(messages).forEach((first, index) => {
          const message = messages[index]!;
          if (first === message.id) notify.unverified(message);
          else notify.unverified(message, { committedBy: first });
        });
        return ids;
      });
      if (unfinished.length > 0) log(`${unfinished.length} 条消息处理中断，已置为待核实`);
    }
    async function inventory(): Promise<void> {
      for (const result of await runner.recover(stopRequest.signal)) {
        if ('error' in result) log(`Run ${result.runId} 核实失败：${result.error}`);
      }
      if (!stopping() && ledger.getRestore()) orphans = await runner.inventoryOrphans();
      if (!stopping()) dispatcher.watchActive();
    }
    // A stop that arrives during a start has taken the service down already: the start
    // adds nothing more and hands back what is stopping, not an error.
    const handle = () => ({ ledger, session, auth, settings, accounts, claudeLogin, codexLogin, codexAuth, machines, nodes, runner, tools, gateway, dataDir, port, stop, stopped: stopped.promise, globalEntryReport: () => hostEntry });

    // §11: a Router that cannot be cleared stops the Router. The service stays up to
    // say so; only what would start a second driver is refused.
    const unlessHalted = (err: unknown): void => {
      if (session.status().error === null) throw err;
    };
    phase('组件初始化');
    const cleanup = await session.cleanup().catch(unlessHalted);
    phase('清理旧负责人', cleanup ? `（查询 ${cleanup.queries} 次，匹配 ${cleanup.matches} 个进程）` : '（清理失败）');
    if (stopping()) return handle();
    markUnfinished();
    // §5.1: the node interfaces open before the inventory, or the two wait for each other
    // — a client cannot answer "what is on this machine" until it can reach the host, and
    // the host does not judge until it has asked. Everything else stays held: the barrier
    // is `recovering`, which refuses a start and an owner's change alike.
    const wanted = options.port ?? settings.get('http.port');
    try {
      port = await http.listen(wanted, host);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw err;
      throw new Error(
        `端口 ${wanted} 已被占用，服务起不来。关掉占用它的程序；或者这一次换一个端口运行：${OTHER_PORT}（要长期用别的端口，启动后到设置页改“端口”）`,
        { cause: err },
      );
    }
    if (stopping()) return handle();
    const publicPort = settings.get('http.reverseProxyPort');
    if (publicPort !== 0) {
      if (publicPort === port) throw new Error('反向代理入口端口不能和服务自己的端口相同');
      reverseProxyPort = await http.reverseProxy.listen(publicPort);
    }
    if (stopping()) return handle();
    phase('监听');
    writeOwnerOnly(serviceFile(dataDir), JSON.stringify({ ...identity, port, token: shutdownToken }));
    // A machine reaches the host through the gateway when one is configured: that has to
    // be up too, and it is the same promise to the outside as before.
    gateway.start();
    await inventory();
    phase('恢复清点');
    if (stopping()) return handle();
    // What came due while the service was down, before anything else moves: a wake once, a
    // trigger by its missed policy (§5). A trigger that cannot be scanned is said and holds
    // nothing else back.
    const dueScan = (): void => {
      if (stopping() || ledger.dispatchConditions().degraded) return;
      try {
        const { fired } = ledger.fireDue();
        if (fired > 0) session.kick();
      } catch (err) {
        log(`到期扫描这一轮没有做完：${String(err)}`);
      }
    };
    dueScan();
    recovering = false;
    connectWecom();
    weixin.start();
    const WEIXIN_DIRECT_REPLY_KEY = /^(?:front:|assign:|weixin-(?:control|menu|selection|login|device-login|join|chat-disabled|unsupported|rejected)[:-])/;
    sender = createOutboxSender({
      outbox: ledger.outbox,
      channels: {
        async weixin(row) {
          if (!imPermissions('weixin').notify && weixinNotify.answers(row) === undefined && row.kind !== 'assign') {
            const { external_id: key } = JSON.parse(row.payload_json) as { external_id?: string };
            if (typeof key !== 'string' || !WEIXIN_DIRECT_REPLY_KEY.test(key)) {
              return '微信主动通知已关闭';
            }
          }
          const outgoing = weixinNotify.render(row);
          if (!outgoing) return weixinNotify.skipReason(row);
          await weixin!.sendOutgoing(row, outgoing);
          return undefined;
        },
        // Whichever connection stands when the row goes out; none is a failure to retry.
        async wecom(row) {
          if (!imPermissions('wecom').notify && notify.answers(row) === undefined && row.kind !== 'assign') {
            const { external_id: key } = JSON.parse(row.payload_json) as { external_id?: string };
            if (typeof key !== 'string' || !key.startsWith('front:')) {
              return '企业微信主动通知已关闭';
            }
          }
          const outgoing = notify.render(row);
          if (!outgoing) return notify.skipReason(row);
          const channel = wecom;
          if (!channel) throw new Error(wecomProblem ?? '企微未连接');
          const { target, body } = outgoing;
          const inbound = notify.answers(row);
          const stream = inbound === undefined ? undefined : channel.streamFor(inbound);
          // Without a stream (an internal event, a restart) or on 'fallback', it is pushed.
          if (body.msgtype === 'markdown' && (await stream?.finish(body.markdown.content)) === 'delivered') return undefined;
          await channel.send(target, body);
          return undefined;
        },
      },
      beforeRound: notify.checkHealth,
      recovering: () => recovering,
      giveUpAfterMs: () => settings.get('outbox.giveUpAfterMs'),
      retryFirstMs: () => settings.get('outbox.retryFirstMs'),
      retryMaxMs: () => settings.get('outbox.retryMaxMs'),
      ...(options.outboxIntervalMs === undefined ? {} : { intervalMs: options.outboxIntervalMs }),
      log,
    });
    // §5.6: what was waiting to go out goes before the Router is back.
    sender.start();
    await session.start(port).catch(unlessHalted);
    phase('负责人预检');
    if (stopping()) return handle();
    dispatcher.start();

    // §2: writes working again is not enough to go on. Everything stays held until an
    // inventory has finished, and one that fails is tried again. Nothing awaits between
    // recover() clearing the degraded mark and the barrier going up.
    async function leaveDegraded(): Promise<void> {
      if (!recovering && !ledger.dispatchConditions().degraded) return;
      if (!ledger.recover()) return;
      recovering = true;
      // A failed write can strand a message in processing, which blocks the next one of its
      // project. Each project by its own turn: one still under way is not another's answer.
      markUnfinished(session.busyProjects());
      await inventory();
      if (stopping()) return;
      recovering = false;
      models.reschedule();
      void backups?.catchUp();
    }
    recoveryTimer = setInterval(() => {
      recoveryTask ??= leaveDegraded()
        .catch((err: unknown) => log(`降级恢复失败：${String(err)}`))
        .finally(() => {
          recoveryTask = undefined;
        });
    }, options.degradedRecoveryMs ?? DEGRADED_RECOVERY_MS);
    recoveryTimer.unref();
    // §2.1: reminders that are due, results whose window has passed, the daily brief, and a
    // release the upgrade command checked that the ledger has not handled yet — read every round;
    // the ledger's mark, not when this process started, says whether it was (a result written just
    // before a crash is handled after the restart). Writes: held while an inventory runs, and a
    // write the ledger refuses waits for the next round.
    pushTimer = setInterval(() => {
      // Degraded: every write here would fail the same way until recovery.
      if (recovering || stopping() || ledger.dispatchConditions().degraded) return;
      try {
        const now = new Date();
        ledger.pushTick(now);
        // A login whose token is expected to run out enters the owner's reminder window once
        // per credential (docs/design/native-login.md §2): scanned by this same timer, and
        // the Outbox's key makes it once.
        ledger.expiryReminders(now);
        if (settings.get('push.daily')) ledger.dailyBrief(now, latestMoment(now, settings.get('push.dailyAt')));
        const release = readReleaseResult(dataDir);
        const intent = readReleaseIntent(dataDir);
        if (release?.ok && release.verified && intent?.version === release.to) {
          ledger.noteReleased(release.at, { runId: intent.run_id, version: release.to });
        }
      } catch (err) {
        log(`主动推送这一轮没有做完：${String(err)}`);
      }
    }, options.pushIntervalMs ?? PUSH_INTERVAL_MS);
    pushTimer.unref();
    dueTimer = setInterval(() => {
      if (!recovering) dueScan();
    }, options.dueIntervalMs ?? DUE_INTERVAL_MS);
    dueTimer.unref();
    // Degraded mode and the recovery inventory hold this one too, inside retention.runOnce
    // (the same guard as the start-up pass): both halves of the cleanup write, and a write
    // that cannot be recorded would make the bytes' fate unknown. Once now (the service is
    // up and the inventory is done), then hourly: what came due while the service was down
    // goes now, not an hour from now.
    retentionPass();
    phase('启动循环');
    retentionTimer = setInterval(retentionPass, options.retentionIntervalMs ?? RETENTION_INTERVAL_MS);
    retentionTimer.unref();
    // Looked at once now, then whenever the interval the setting names has passed since the last
    // look — read on every tick, so a changed interval holds from the next second, not after the
    // old one runs out.
    let entryCheckedAt = Date.now();
    writeHostEntry();
    entryTimer = setInterval(() => {
      if (stopping() || Date.now() - entryCheckedAt < settings.get('knowledge.globalEntryCheckMs')) return;
      entryCheckedAt = Date.now();
      writeHostEntry();
    }, ENTRY_TICK_MS);
    entryTimer.unref();
    notify.started(settings.get('wecom.botId'));
    void backups?.start();
    models.start();
    executorUpdates.start();
    codexAuth.start();
    phase('全局入口');
    log(`启动用了 ${((performance.now() - startupAt) / 1000).toFixed(2)} 秒：${phases.join('、')}`);
    log(`服务已启动：http://${host}:${port}，数据目录 ${dataDir}`);

    return handle();
  } catch (err) {
    await stop('启动没有完成');
    throw err;
  }
}

// The port for this run only, when whoever started the service named one. 0 has the
// system pick a free one: only the process that binds can know a port is free, so a
// starter that needs any port asks for 0 and reads the one taken from service.json.
function portFromEnv(): number | undefined {
  const given = process.env.TYCHO_PORT;
  if (!given) return undefined;
  const port = Number(given);
  if (!Number.isInteger(port) || port < 0 || port > MAX_PORT) throw new Error(`TYCHO_PORT 应为 0 到 ${MAX_PORT} 的整数（0 表示这一次由系统挑一个空闲端口）：${given}`);
  return port;
}

async function main(): Promise<void> {
  // Before the start, not after it: a start can spend minutes on machines it cannot
  // reach, and a signal in that time has to end it as cleanly as one that comes later.
  // SIGHUP is a terminal or a console window closing.
  const stopRequest = new AbortController();
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(signal, () => stopRequest.abort(`收到信号 ${signal}`));
  const port = portFromEnv();
  const service = await startService({ dataDir: dataDirFromEnv(), stopSignal: stopRequest.signal, ...(port === undefined ? {} : { port }) });
  if (!stopRequest.signal.aborted) log(`${LOGIN_HINT}；已配置企微时私聊机器人发'登录'`);
  process.exit((await service.stopped) ? 0 : 1);
}

if (isEntry(import.meta.filename)) {
  main().catch((err: unknown) => {
    log(String(err));
    process.exit(1);
  });
}
