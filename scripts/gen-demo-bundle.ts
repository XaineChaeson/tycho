// Builds the 100% real, interactive static Tycho Console Demo inside `docs-site/demo/`.
// 1. Boots a temporary isolated Tycho stage service (zero user data touched) and snapshots
//    schema-exact JSON responses across every real Console API route.
// 2. Generates `docs-site/demo/demo-engine.js` with embedded seed state + interactive in-browser
//    fetch & EventSource('/api/stream') handlers (live task dispatch, approvals, acceptance,
//    knowledge self-evolution promotion, priority slots, and swimlane/blueprint switching).
// 3. Copies the built real Console SPA (`console/dist`, built with TYCHO_CONSOLE_BASE=./) into
//    `docs-site/demo/` and injects `demo-engine.js` ahead of the React bundle.
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openLedger } from '../service/ledger.ts';
import { startService } from '../service/main.ts';
import { createTools } from '../service/tools.ts';
import { fakeRemote } from '../tests/fake-remote.ts';
import { claudeTier, machineLogin, memoryLogins, noAccept, OUTPUT_AVAILABLE, seed, signedInEverywhere, testMachine } from '../tests/helpers.ts';
import { signIn, until } from '../tests/stage.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FAKE_CLAUDE = join(ROOT, 'tests', 'fake-claude.mjs');
const USER = { actor: 'owner' };

const ndjson = (v: unknown): string => `${JSON.stringify(v)}\n`;
const said = (text: string): string => ndjson({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } });
const toolCall = (id: string, name: string, input: object = {}): string => ndjson({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } });
const toolDone = (id: string, failed = false): string => ndjson({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok', is_error: failed }] } });

async function collectSeed(): Promise<{ projectId: string; workId: string; seedMap: Record<string, unknown> }> {
  const dataDir = mkdtempSync(join(tmpdir(), 'tycho-demo-seed-'));
  const remote = fakeRemote();
  const tools = createTools({
    ledger: undefined as never,
    runner: { interrupt: async () => 'ended', events: () => [], abandon: async () => {} },
    logins: memoryLogins({}),
    machines: undefined as never,
    accept: noAccept,
  });
  Object.assign(process.env, {
    FAKE_CLAUDE_LOG: join(dataDir, 'fake.log'),
    FAKE_CLAUDE_TOOLS: JSON.stringify(tools.names.map((n: string) => `mcp__tycho__${n}`)),
  });

  const gpuMachine = { ...testMachine('linux-gpu-01'), host: 'linux-gpu-01', note: '主构建与 GPU 算力节点' };
  const macMachine = { ...testMachine('macbook-pro'), host: 'macbook-pro', note: '随身开发与跨模型审阅节点' };
  const winMachine = { ...testMachine('win-workstation'), host: 'win-workstation', note: '桌面端与本地验证工作站' };

  const allTiers = {
    decide: claudeTier('/tiers/decide.json'),
    execute: claudeTier('/tiers/execute.json'),
    operate: claudeTier('/tiers/operate.json'),
  };
  const primaryLogin = { ...machineLogin('linux-gpu-01', 'claude', { tiers: allTiers }), id: 'work-codex', name: 'Work Codex Pro' };
  const secondaryLogin = { ...machineLogin('macbook-pro', 'claude', { tiers: allTiers }), id: 'claude-max', name: 'Claude Max' };

  const initDb = openLedger(join(dataDir, 'ledger.db'));
  try {
    initDb.joinMachine({ id: gpuMachine.id, host: gpuMachine.host, nodeId: gpuMachine.nodeId!, tokenHash: 'tok-gpu', local: true, platform: 'linux 6.8 x64', source: null, ephemeral: false }, USER);
    initDb.joinMachine({ id: macMachine.id, host: macMachine.host, nodeId: macMachine.nodeId!, tokenHash: 'tok-mac', local: false, platform: 'darwin 24.3 arm64', source: null, ephemeral: false }, USER);
    initDb.joinMachine({ id: winMachine.id, host: winMachine.host, nodeId: winMachine.nodeId!, tokenHash: 'tok-win', local: false, platform: 'win32 10.0 x64', source: null, ephemeral: false }, USER);
  } finally {
    initDb.close();
  }

  seed(dataDir, {
    machines: { 'linux-gpu-01': gpuMachine, 'macbook-pro': macMachine, 'win-workstation': winMachine },
    logins: { 'work-codex': primaryLogin, 'claude-max': secondaryLogin },
  });

  const service = await startService({
    dataDir,
    claude: [process.execPath, FAKE_CLAUDE],
    port: 0,
    connect: remote.connect,
    reportedExecutors: signedInEverywhere(),
    reportedOutput: () => OUTPUT_AVAILABLE,
    dispatchIntervalMs: 20,
    watchIntervalMs: 20,
    outboxIntervalMs: 20,
    stopWaitMs: 2000,
    globalEntry: {
      home: join(dataDir, 'home'),
      env: {
        CLAUDE_CONFIG_DIR: join(dataDir, 'home', '.claude'),
        CODEX_HOME: join(dataDir, 'home', '.codex'),
        DSH_HOME: join(dataDir, 'home', '.dsh'),
        DSH_AGENTS_HOME: join(dataDir, 'home', '.agents'),
      },
    },
  });

  try {
    const { ledger } = service;
    const p1 = ledger.createProject({ name: 'atlas-payments', logins: [primaryLogin.id, secondaryLogin.id] }, USER);
    const p2 = ledger.createProject({ name: 'tycho-core', logins: [primaryLogin.id] }, USER);

    const launched = (taskId: string) => until(() => {
      const run = ledger.listRuns(taskId).at(-1);
      return run && remote.called('start.sh', run.id) > 0 && ledger.getRun(run.id).state === 'running' && run;
    }, `task ${taskId} launched`);

    const work = ledger.createTask({
      projectId: p1,
      title: 'EU 集群 Webhook 重试抖动修复与全链路验证',
      goal: '定位重试退避溢出、补齐边界与压测回归、执行跨模型独立审阅，并同步灰度播报。',
      acceptance: '全部 18 项边界单测与 10k 并发压测通过，独立审阅无阻断项',
      loginId: primaryLogin.id,
      roleId: 'implement',
    }, USER);

    const reqMsg = ledger.receiveMessage({
      channel: 'console',
      externalId: 'demo-msg-root',
      actor: 'owner',
      text: '排查 EU 集群 Webhook 重试抖动问题，修复退避上限溢出并补齐单测，完成后安排跨模型独立审阅。',
      projectId: p1,
    });

    const tc1 = 'demo-call-1';
    ledger.startRouterCall({
      id: tc1, projectId: p1, messageId: reqMsg.id, messageIds: [reqMsg.id], contextId: null,
      name: 'create_task', request: '{"title":"修复 webhooks/retry.ts 指数退避抖动上限","role":"implement"}',
    });
    const rctx = { actor: 'router', messageId: reqMsg.id, toolCallId: tc1 };

    // Child 1: READY (completed implementation waiting to be accepted, with rich report & commit)
    const readyTask = ledger.transaction(() => {
      const t = ledger.createTask({
        projectId: p1, parentId: work.id,
        title: '修复 webhooks/retry.ts 指数退避抖动上限',
        goal: '1. 定位指数退避抖动计算溢出点\n2. 限制最大退避窗口 300s 并加随机抖动\n3. 补充 18 组边界回归单测',
        acceptance: 'node --test tests/retry-backoff.test.ts 全绿',
        loginId: primaryLogin.id, roleId: 'implement',
      }, rctx);
      ledger.queueTask(t.id, rctx);
      return t;
    });
    ledger.finishRouterCall(tc1, 'returned', null);

    const run1 = await launched(readyTask.id);
    const report1 = [
      '# Webhook 重试抖动修复交付报告',
      '根因定位：`src/webhooks/retry.ts:84` 在 `attempt > 12` 时未对 `Math.pow(2, attempt) * jitter` 做上限截断，导致重试延迟飙升并引发回调队列堆积。',
      '| 验证项 | 执行节点 | 结果 |\n|---|---|---|\n| 边界单测 `tests/retry-backoff.test.ts` | `linux-gpu-01` | 18 / 18 通过 |\n| 10k 并发压测回归 | `linux-gpu-01` | P99 延迟恢复至 42ms |',
      '```ts\nconst MAX_BACKOFF_MS = 300_000;\nexport function nextDelay(attempt: number): number {\n  const raw = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** Math.min(attempt, 16));\n  return Math.round(raw * (0.85 + Math.random() * 0.3));\n}\n```',
    ].join('\n\n');
    const receipt1 = {
      status: 'done',
      summary: '已修复 `webhooks/retry.ts:84` 退避抖动上限截断并补齐 18 项边界单测，全部通过。',
      artifacts: [{ kind: 'commit', ref: 'e4a91bc' }, { kind: 'report', ref: '交付报告' }],
    };
    Object.assign(remote.runOf(run1.id), {
      stdout: said('读取 `src/webhooks/retry.ts` 并复现 attempt > 12 时的指数退避溢出。')
        + toolCall('t1', 'Read', { file: 'src/webhooks/retry.ts' }) + toolDone('t1')
        + toolCall('t2', 'Edit', { file: 'src/webhooks/retry.ts' }) + toolDone('t2')
        + toolCall('t3', 'Bash', { command: 'node --test tests/retry-backoff.test.ts' }) + toolDone('t3')
        + said('18 项单测全绿，提交交付报告并附提炼的退避上限经验。')
        + ndjson({ type: 'result', is_error: false, result: report1 + '\n\n```receipt\n' + JSON.stringify(receipt1) + '\n```', session_id: 'demo-s1' }),
      exit: 0, pid_alive: false, marked: false, launcher_alive: false,
    });
    await until(() => ledger.getTask(readyTask.id).state === 'ready', 'readyTask settled');

    // Child 2: DONE (already accepted benchmark task)
    const doneTask = ledger.createTask({
      projectId: p1, parentId: work.id,
      title: '补充 10k 并发 Webhook 压测基线',
      goal: '建立 EU 集群 Webhook 并发压测脚本并固化 P99 指标基线。',
      acceptance: 'P99 < 60ms 且零内存泄漏',
      loginId: primaryLogin.id, roleId: 'verify',
    }, USER);
    ledger.queueTask(doneTask.id, USER);
    const runDone = await launched(doneTask.id);
    Object.assign(remote.runOf(runDone.id), {
      stdout: said('运行 10,000 并发 Webhook 压测基线，P99 = 42ms，内存曲线平稳。')
        + toolCall('b1', 'Bash', { command: 'node scripts/bench-webhook.ts --concurrency=10000' }) + toolDone('b1')
        + ndjson({ type: 'result', is_error: false, result: '压测通过：P99 = 42ms。\n\n```receipt\n{"status":"done","summary":"10k 并发压测通过（P99 42ms），基线已固化。"}\n```', session_id: 'demo-s2' }),
      exit: 0, pid_alive: false, marked: false, launcher_alive: false,
    });
    await until(() => ledger.getTask(doneTask.id).state === 'ready', 'doneTask ready');
    ledger.acceptTask(doneTask.id, '压测指标达标', USER);

    // Child 3: RUNNING (cross-model independent review)
    const runTask = ledger.createTask({
      projectId: p1, parentId: work.id,
      title: '跨模型独立审阅 retry.ts 与向后兼容性',
      goal: '由独立执行器交叉审查 commit e4a91bc，确认无死锁、无旧账本兼容回归。',
      acceptance: '审阅无 P0/P1 阻断项',
      loginId: secondaryLogin.id, roleId: 'review',
    }, USER);
    ledger.queueTask(runTask.id, USER);
    const runRev = await launched(runTask.id);
    remote.runOf(runRev.id).stdout = said('正在独立交叉审阅提交 `e4a91bc` 的边界条件与并发抖动分布。')
      + toolCall('r1', 'Read', { file: 'src/webhooks/retry.ts' }) + toolDone('r1')
      + toolCall('r2', 'Bash', { command: 'git diff HEAD~1 -- src/webhooks/retry.ts' }) + toolDone('r2')
      + said('边界截断逻辑清晰，正在核对 18 个单测覆盖率与回滚方案...');

    // Child 4: ASKING (waiting for owner approval)
    const askTask = ledger.createTask({
      projectId: p1, parentId: work.id,
      title: '灰度上线与 #eng-ops 群播报确认',
      goal: '合入后是否同步触发预发压测并将交付摘要播报到企业微信/飞书值班群。',
      acceptance: '按主人决定执行发布动作',
      loginId: primaryLogin.id, roleId: 'implement',
    }, USER);
    ledger.queueTask(askTask.id, USER);
    ledger.openApproval(askTask.id, [{
      question: '验收合入后是否立即触发预发压测并播报 #eng-ops 群？',
      about: '18/18 边界单测与 10k 压测基线均已通过，独立审阅进行中',
      recommend: 0,
      options: ['自动合入并播报 #eng-ops 群（推荐）', '仅合入代码，暂不外发群播报'],
    }], USER);

    // Log in via real HTTP signIn() and snapshot every real Console API endpoint
    const client = await signIn(service);
    const apiGet = async (path: string, required = false): Promise<unknown> => {
      const r = await client.get(path);
      if (!r.ok) {
        if (required) throw new Error(`Demo seed GET ${path} failed with ${r.status}`);
        return null;
      }
      return await r.json();
    };

    const seedMap: Record<string, unknown> = {};
    const paths: [string, boolean][] = [
      ['/api/state', true],
      ['/api/summary', true],
      ['/api/overview', true],
      ['/api/doctor', true],
      ['/api/tasks?top=1', true],
      ['/api/approvals', true],
      ['/api/projects', true],
      ['/api/accounts', true],
      ['/api/machines', true],
      ['/api/node/joins', false],
      ['/api/executors/updates', false],
      ['/api/roles', true],
      ['/api/knowledge', true],
      ['/api/inbound', true],
      ['/api/im/groups', false],
      ['/api/settings', true],
      ['/api/usage', false],
      ['/api/themes', false],
      ['/api/messages/unassigned', false],
      [`/api/projects/${p1}/conversation`, true],
      [`/api/projects/${p2}/conversation`, false],
      [`/api/projects/${p1}/triggers`, false],
      [`/api/projects/${p2}/triggers`, false],
      [`/api/projects/${p1}/files`, false],
      [`/api/projects/${p2}/files`, false],
      [`/api/projects/${p1}/groups`, false],
      [`/api/projects/${p2}/groups`, false],
      [`/api/messages?project=${p1}&limit=50`, true],
      [`/api/messages?project=${p2}&limit=50`, false],
      [`/api/messages?limit=50`, true],
      [`/api/tasks/${work.id}`, true],
      [`/api/tasks/${readyTask.id}`, true],
      [`/api/tasks/${doneTask.id}`, true],
      [`/api/tasks/${runTask.id}`, true],
      [`/api/tasks/${askTask.id}`, true],
      [`/api/runs/${run1.id}/events`, false],
      [`/api/runs/${run1.id}/snapshot`, false],
      [`/api/runs/${runDone.id}/events`, false],
      [`/api/runs/${runDone.id}/snapshot`, false],
      [`/api/runs/${runRev.id}/events`, false],
      [`/api/runs/${runRev.id}/snapshot`, false],
    ];
    for (const [p, req] of paths) {
      const val = await apiGet(p, req);
      if (val !== null) seedMap[p] = val;
    }

    // Also snapshot segment messages & turn changes for p1
    const conv1 = seedMap[`/api/projects/${p1}/conversation`] as { segment?: string } | undefined;
    if (conv1?.segment) {
      seedMap[`/api/messages?segment=${conv1.segment}&limit=50`] = await apiGet(`/api/messages?segment=${conv1.segment}&limit=50`);
    }
    seedMap[`/api/messages/${reqMsg.id}/changes`] = await apiGet(`/api/messages/${reqMsg.id}/changes`);

    // Enrich online nodes, knowledge self-evolution proposals & entries, inbound sources, and triggers cleanly
    const now = new Date().toISOString();
    const in2h = new Date(Date.now() + 2 * 3600_000).toISOString();
    const in4d = new Date(Date.now() + 4 * 86400_000).toISOString();

    const machPage = seedMap['/api/machines'] as { machines?: Record<string, unknown>[] } | undefined;
    if (machPage?.machines) {
      machPage.machines = machPage.machines.map((m) => {
        const id = String(m.id ?? '');
        const node = (m.node as Record<string, unknown> | null) ?? {};
        const execs = id === 'linux-gpu-01'
          ? [
              { executor: 'codex', installed: true, version: '0.167.1', logged_in: true, read_only: { available: true, layer: 'filesystem' } },
              { executor: 'claude', installed: true, version: '2.1.309', logged_in: true, read_only: { available: true, layer: 'filesystem' } },
              { executor: 'gemini', installed: true, version: '1.107.0', logged_in: true, read_only: { available: true, layer: 'filesystem' } },
            ]
          : id === 'macbook-pro'
            ? [
                { executor: 'claude', installed: true, version: '2.1.309', logged_in: true, read_only: { available: true, layer: 'filesystem' } },
                { executor: 'codex', installed: true, version: '0.167.1', logged_in: true, read_only: { available: true, layer: 'filesystem' } },
              ]
            : [
                { executor: 'codex', installed: true, version: '0.167.1', logged_in: true, read_only: { available: true, layer: 'filesystem' } },
                { executor: 'dsh', installed: true, version: '0.2.2', logged_in: true, read_only: { available: true, layer: 'filesystem' } },
              ];
        return {
          ...m,
          online: true,
          node: {
            ...node,
            connected: true,
            last_seen_at: now,
            protocol: 8,
            release: { version: '0.2.1', at: now, upgrade: null },
            service: { manager: id === 'linux-gpu-01' ? 'systemd' : id === 'macbook-pro' ? 'launchd' : 'windows-task', state: 'running' },
            executors: { at: now, executors: execs },
          },
        };
      });
    }

    const knPage = seedMap['/api/knowledge'] as Record<string, unknown> | undefined;
    if (knPage) {
      const prop1 = {
        id: '01J9KP0001EVOLVE0000000001',
        created_at: now,
        kind: 'knowledge',
        state: 'awaiting_owner',
        state_reason: null,
        owner_reasons: ['global_resident'],
        source: 'worker',
        proposed_by: 'codex @ linux-gpu-01',
        request_id: null, task_id: readyTask.id, run_id: run1.id,
        amended_from: null, next_id: null, digest: 'a'.repeat(64), final_digest: 'a'.repeat(64),
        prior_rejection: null, gate_task_id: null,
        gate: { result: 'pass', reason: '独立把关已核实 3 条证据与 18/18 单测结果；因属全局常驻规范，等待主人点头生效。', modified: false, task_id: readyTask.id, run_id: run1.id },
        decided_at: null, decided_by: null, decided_via: null, decision_note: null,
        published_at: null, reviewed_at: null, reviewed_by: null,
        evidence_count: 3, verified_count: 3,
        why: { when: '任何 Webhook 或外部 HTTP 重试逻辑', changes: '强制添加 300s 退避上限与随机抖动', generalizes: '适用于全部跨机微服务项目，避免重试雪崩' },
        change: {
          kind: 'knowledge',
          inputs: [],
          outputs: [{
            key: 'out-1', revises: null, title: 'Webhook 重试必须加 300s 退避上限与随机抖动',
            when_to_use: '编写或修改外部 Webhook / HTTP 重试退避逻辑时',
            body: '从 atlas-payments #e4a91bc 事故提炼：指数退避在 attempt > 12 时禁止无上限增长，必须截断至 300s 并叠加随机抖动，防止下游恢复瞬间被重试洪峰击穿。',
            project_ids: null, loading: 'resident', roles: ['implement', 'review'],
          }],
        },
        final: null,
      };
      const prop2 = {
        id: '01J9KP0002EVOLVE0000000002',
        created_at: now,
        kind: 'skill',
        state: 'awaiting_owner',
        state_reason: null,
        owner_reasons: ['owner_entry'],
        source: 'router',
        proposed_by: 'project-router · atlas-payments',
        request_id: null, task_id: null, run_id: null,
        amended_from: null, next_id: null, digest: 'b'.repeat(64), final_digest: 'b'.repeat(64),
        prior_rejection: null, gate_task_id: null,
        gate: { result: 'pass', reason: '已核对 Nginx SSE 反代实测日志，建议沉淀为项目标准排障技能。', modified: false, task_id: readyTask.id, run_id: run1.id },
        decided_at: null, decided_by: null, decided_via: null, decision_note: null,
        published_at: null, reviewed_at: null, reviewed_by: null,
        evidence_count: 2, verified_count: 2,
        why: { when: '配置公网 Nginx / Caddy 反代 Tycho 主机', changes: '必须声明 proxy_buffering off 与长超时', generalizes: '防止公网控制台与出站节点 SSE 静默断流' },
        change: {
          kind: 'skill',
          inputs: [],
          outputs: [{
            key: 'out-2', revises: null, title: '公网 HTTPS 反代 SSE 必配清单',
            when_to_use: '部署或排查公网 HTTPS 反向代理时',
            body: '## 在哪里做\n公网 VPS 的 Nginx / Caddy 配置。\n\n## 按什么顺序\n1. 设置 proxy_buffering off 与 proxy_http_version 1.1\n2. 设置 proxy_read_timeout 3600s\n3. 用 tycho doctor 验证 SSE 实时流正常',
            project_ids: [p1], loading: 'catalog', roles: [],
          }],
        },
        final: null,
      };
      const entries = [
        {
          id: '01J9KE0001ENTRY00000000001',
          created_at: now, updated_at: now,
          title: '跨模型审阅前必须附带可复现测试命令与退出码',
          when_to_use: '提交写入类任务 ready 回执前',
          kind: 'knowledge', project_ids: null, loading: 'resident', roles: ['implement', 'review'],
          revision: 3, state: 'active', reviewed: true,
          body: '所有写入类任务提交回执前，必须附带精确测试命令、通过数及 commit SHA，以便独立审阅轮次直接核对。',
        },
        {
          id: '01J9KE0002ENTRY00000000002',
          created_at: now, updated_at: now,
          title: 'atlas-payments 入站幂等键必须按 (source_id, event_id) 联合唯一',
          when_to_use: '新增支付回调或 Webhook 接入点时',
          kind: 'knowledge', project_ids: [p1], loading: 'resident', roles: ['implement'],
          revision: 2, state: 'active', reviewed: true,
          body: '外部支付回调与入站 Webhook 统一使用复合唯一键防重放，严禁仅依赖时间戳。',
        },
        {
          id: '01J9KE0003ENTRY00000000003',
          created_at: now, updated_at: now,
          title: 'Windows 节点密钥落盘必须复用 icacls 仅当前用户读写',
          when_to_use: '修改凭据或节点令牌落盘逻辑时',
          kind: 'skill', project_ids: null, loading: 'catalog', roles: [],
          revision: 1, state: 'active', reviewed: true,
          body: 'Node token 与托管密钥写入后立即收紧 ACL，避免同机其他账户读取。',
        },
      ];
      knPage.awaiting = [prop1, prop2];
      knPage.proposals = [prop1, prop2];
      knPage.entries = entries;

      // Seed detail pages for both proposals & entries so clicking them in Demo works seamlessly!
      for (const prop of [prop1, prop2]) {
        seedMap[`/api/knowledge/proposals/${prop.id}`] = {
          proposal: {
            ...prop,
            evidence: [
              {
                id: `${prop.id}-ev-1`, seq: 1, source: 'task_run', ref: readyTask.id,
                location: 'src/webhooks/retry.ts:84',
                excerpt: 'const raw = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** Math.min(attempt, 16));',
                captured_at: now, sha256: 'e4a91bc048f3d219a77c50d912c8e0f104a891bc048f3d219a77c50d912c8e0f',
                submitted_by: 'codex @ linux-gpu-01', verified: true,
              },
              {
                id: `${prop.id}-ev-2`, seq: 2, source: 'report', ref: run1.id,
                location: '交付报告',
                excerpt: '18 / 18 边界单测通过，10k 并发 P99 延迟恢复至 42ms。',
                captured_at: now, sha256: '7c210ef9a8345b2019c4d1187e2f90ab7c210ef9a8345b2019c4d1187e2f90ab',
                submitted_by: 'codex @ linux-gpu-01', verified: true,
              },
            ],
          },
          inputs: [],
          impact: {
            kind: 'forecast',
            dropped: [],
            combos: [{ project_id: p1, project: 'atlas-payments', role_id: 'implement', role: '实现', before: { brief: 1420, files: 1 }, after: { brief: 1790, files: 2 } }],
          },
        };
      }
      for (const entry of entries) {
        seedMap[`/api/knowledge/entries/${entry.id}`] = {
          entry,
          revisions: [{
            revision: entry.revision, created_at: now, title: entry.title, when_to_use: entry.when_to_use,
            body: entry.body, project_ids: entry.project_ids, loading: entry.loading, roles: entry.roles,
            proposed_by: 'codex @ linux-gpu-01', source: 'worker', evidence: [],
          }],
        };
      }
    }

    const inbPage = seedMap['/api/inbound'] as Record<string, unknown> | undefined;
    if (inbPage) {
      inbPage.reach = { reach: 'ready', reach_text: '已就绪 · 公网 HTTPS 入口可用', public_url: 'https://tycho.example.com' };
      inbPage.sources = [
        {
          id: 'feishu-ops', name: '飞书研发值班群桥接', kind: 'tycho-v1', kind_label: 'tycho-v1 双向签名',
          path: '/inbound/feishu-ops', enabled: true, ready: true, problem: null, rejected: 0,
          note: '研发值班群快慢分流桥接，仅回读总控公开答复',
          project_ids: [p1], projects: [p1], broadcast_groups: true, broadcast_group_ids: [],
          keys: [{ id: '01J9KY00000000000000000001', created_at: now, retires_at: null }],
        },
        {
          id: 'github-pr-guard', name: 'GitHub PR 自动审阅 Webhook', kind: 'github', kind_label: 'GitHub Webhook',
          path: '/inbound/github-pr-guard', enabled: true, ready: true, problem: null, rejected: 0,
          note: 'PR 打开自动派发跨模型安全审阅并播报群聊',
          project_ids: [p1], projects: [p1], broadcast_groups: true, broadcast_group_ids: [],
          keys: [{ id: '01J9KY00000000000000000002', created_at: now, retires_at: null }],
        },
      ];
    }

    const ovPage = seedMap['/api/overview'] as { counts?: Record<string, number> } | undefined;
    if (ovPage?.counts) {
      ovPage.counts.knowledge_awaiting = 2;
    }

    const statePage = seedMap['/api/state'] as Record<string, unknown> | undefined;
    if (statePage) {
      statePage.version = '0.2.1';
      statePage.demo = true;
      const router = (statePage.router as Record<string, unknown> | undefined) ?? {};
      statePage.router = { ...router, alive: true };
    }

    // Seed a crisp initial Router reply in p1 conversation so visitors see a real dialogue immediately
    const replyMsg = {
      id: '01J9RM0001REPLY00000000001',
      created_at: now,
      direction: 'out',
      channel: 'console',
      external_id: `reply:${reqMsg.id}`,
      actor: 'router',
      text: '已核对 `atlas-payments` 生效知识简报（2 条规则）并将问题拆分为 4 个并行子任务：\n\n1. **修复退避上限**（`linux-gpu-01`）—— 18/18 单测通过，提交 `e4a91bc`，等待你验收；\n2. **10k 并发压测基线**（`linux-gpu-01`）—— 已验收完成，P99 = 42ms；\n3. **跨模型独立审阅**（`macbook-pro`）—— 正在独立复核边界与向后兼容性；\n4. **灰度上线与群播报** —— 待你确认是否自动播报 `#eng-ops` 群。\n\n> 💡 试试在下方输入框发一条新指令，实时观察总控拆活、进入泳道图，并自动生成新的「知识自进化」待审提案！',
      state: 'processed',
      final: 1,
      project_id: p1,
      segment_id: conv1?.segment ?? null,
    };
    for (const k of [`/api/messages?project=${p1}&limit=50`, '/api/messages?limit=50', ...(conv1?.segment ? [`/api/messages?segment=${conv1.segment}&limit=50`] : [])]) {
      const box = seedMap[k] as { messages?: Record<string, unknown>[] } | undefined;
      if (box?.messages) {
        const reqRow = box.messages.find((m) => m.id === reqMsg.id);
        if (reqRow) reqRow.state = 'processed';
        box.messages.push(replyMsg);
      }
    }

    // Add realistic quota telemetry timestamps
    const accPage = seedMap['/api/accounts'] as Record<string, unknown> | undefined;
    if (accPage) {
      accPage.demo_quotas = { in2h, in4d };
    }

    return { projectId: p1, workId: work.id, seedMap };
  } finally {
    await service.stop();
    rmSync(dataDir, { recursive: true, force: true });
  }
}

function buildDemoEngineSource(projectId: string, workId: string, seedMap: Record<string, unknown>): string {
  const serialized = JSON.stringify({ projectId, workId, seedMap }).replace(/<\/script>/gi, '<\\/script>');
  return `// Tycho Interactive Static Demo Engine (runs the real React Console in-browser with zero backend)
(function () {
  const INITIAL = ${serialized};
  const deepClone = (v) => JSON.parse(JSON.stringify(v));
  let db = deepClone(INITIAL.seedMap);
  const DEFAULT_PROJECT = INITIAL.projectId;
  const DEFAULT_WORK = INITIAL.workId;

  // Prevent /sw.js 404 console error when running as a static sub-path Demo
  try {
    if (navigator.serviceWorker && typeof navigator.serviceWorker.register === 'function') {
      navigator.serviceWorker.register = () => Promise.resolve({ scope: './', update: () => Promise.resolve() });
    }
  } catch {}

  // Default Work view to Swimlane ('trace') on first visit so visitors immediately see the signature swimlane DAG!
  try {
    if (!localStorage.getItem('tycho.projectWorkView')) {
      localStorage.setItem('tycho.projectWorkView', 'trace');
    }
  } catch {}

  // Rewrite default /#/ or empty hash to the virtual project's Work Swimlane or requested view
  if (!window.location.hash || window.location.hash === '#' || window.location.hash === '#/') {
    const params = new URLSearchParams(window.location.search);
    const go = params.get('go');
    if (go === 'project') window.location.hash = '#/projects/' + DEFAULT_PROJECT;
    else if (go === 'knowledge') window.location.hash = '#/knowledge';
    else if (go === 'accounts') window.location.hash = '#/accounts';
    else if (go === 'machines') window.location.hash = '#/machines';
    else if (go === 'inbound') window.location.hash = '#/inbound';
    else if (go === 'hud') {
      try { localStorage.setItem('tycho.projectWorkView', 'hud'); } catch {}
      window.location.hash = '#/projects/' + DEFAULT_PROJECT + '/work';
    } else {
      window.location.hash = '#/projects/' + DEFAULT_PROJECT + '/work';
    }
  }

  // Allow parent product website to smoothly switch views inside the embedded iframe without reload
  window.addEventListener('message', (ev) => {
    const d = ev.data;
    if (!d || typeof d !== 'object') return;
    if (d.type === 'tycho-demo-nav') {
      if (d.workMode) {
        try { localStorage.setItem('tycho.projectWorkView', d.workMode); } catch {}
      }
      const target = d.route === 'work' ? '#/projects/' + DEFAULT_PROJECT + '/work'
        : d.route === 'project' ? '#/projects/' + DEFAULT_PROJECT
        : d.route === 'knowledge' ? '#/knowledge'
        : d.route === 'accounts' ? '#/accounts'
        : d.route === 'machines' ? '#/machines'
        : d.route === 'inbound' ? '#/inbound'
        : '#/';
      const prev = window.location.hash;
      window.location.hash = target;
      if (prev === target && d.workMode) {
        // Click the corresponding view tab button directly if already on Work tab
        const label = d.workMode === 'hud' ? '蓝图' : d.workMode === 'trace' ? '泳道' : '列表';
        const tab = [...document.querySelectorAll('[role="tab"]')].find(el => el.textContent && el.textContent.includes(label));
        if (tab) tab.click();
      }
    } else if (d.type === 'tycho-demo-theme') {
      if (d.theme === 'dark' || d.theme === 'light') {
        document.documentElement.setAttribute('data-theme', d.theme);
        try { localStorage.setItem('tycho.theme', d.theme); } catch {}
      } else {
        document.documentElement.removeAttribute('data-theme');
        try { localStorage.removeItem('tycho.theme'); } catch {}
      }
    }
  });

  // Virtual EventSource('/api/stream') bus for real-time SSE updates
  const streams = new Set();
  function emitSSE(type, payload) {
    const data = JSON.stringify(payload);
    for (const s of streams) s._dispatch(type, data);
  }

  class DemoEventSource {
    constructor(url) {
      this.url = url;
      this.onopen = null;
      this.onerror = null;
      this._listeners = new Map();
      streams.add(this);
      setTimeout(() => { if (this.onopen) this.onopen(); }, 25);
    }
    addEventListener(type, fn) {
      const set = this._listeners.get(type) || new Set();
      set.add(fn);
      this._listeners.set(type, set);
    }
    removeEventListener(type, fn) {
      this._listeners.get(type)?.delete(fn);
    }
    _dispatch(type, data) {
      const set = this._listeners.get(type);
      if (set) for (const fn of set) fn({ data });
    }
    close() { streams.delete(this); }
  }
  window.EventSource = DemoEventSource;

  function jsonRes(obj, status = 200) {
    return new Response(JSON.stringify(obj), {
      status,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    });
  }

  let seq = 1;
  const uid = (prefix) => prefix + '_' + String(Date.now()).slice(-6) + '_' + (seq++);

  function findTaskListing(taskId) {
    const listing = db['/api/tasks?top=1'];
    if (!listing) return null;
    const all = [...(listing.tasks || []), ...(listing.children || [])];
    return all.find(t => t.id === taskId) || null;
  }

  function appendMessage(projectId, msg) {
    const conv = db['/api/projects/' + projectId + '/conversation'];
    const keys = ['/api/messages?project=' + projectId + '&limit=50', '/api/messages?limit=50'];
    if (conv && conv.segment) keys.push('/api/messages?segment=' + conv.segment + '&limit=50');
    for (const k of keys) {
      if (!db[k]) db[k] = { messages: [], changes: {} };
      const arr = db[k].messages || [];
      const idx = arr.findIndex(m => m.id === msg.id);
      if (idx >= 0) arr[idx] = msg;
      else arr.push(msg);
    }
    emitSSE('message', msg);
  }

  function handleSendMessage(body) {
    const projectId = body.project_id || DEFAULT_PROJECT;
    const text = String(body.text || '').trim();
    const conv = db['/api/projects/' + projectId + '/conversation'];
    const segId = conv?.segment || null;
    const now = new Date().toISOString();
    const inId = uid('msg_in');
    const inMsg = {
      id: inId, created_at: now, direction: 'in', channel: 'console',
      external_id: 'demo:' + inId, actor: 'owner', text, state: 'processing', final: 1,
      project_id: projectId, segment_id: segId,
    };
    appendMessage(projectId, inMsg);

    const outId = uid('msg_out');
    const newTaskId = uid('task_demo');
    const shortTitle = text.length > 26 ? text.slice(0, 26) + '…' : text;
    const replySteps = [
      '已读取项目生效知识简报（2 条规则），正在拆解「' + shortTitle + '」…',
      '已读取项目生效知识简报（2 条规则），正在拆解「' + shortTitle + '」并匹配最优账号与机器：\\n\\n1. 已在 **linux-gpu-01** 上派发执行任务（Work Codex Pro · 执行档），已同步加入**工作泳道图与 45° 蓝图**；\\n2. 完成后将自动安排独立模型交叉审阅，并提炼新经验提交至**知识自进化**待审队列。',
    ];

    setTimeout(() => {
      emitSSE('delta', { message_id: outId, reply_to: inId, project_id: projectId, segment_id: segId, text: replySteps[0] });
    }, 260);

    setTimeout(() => {
      const listing = db['/api/tasks?top=1'] || { tasks: [], children: [] };
      const templateChild = (listing.children || [])[0] || (listing.tasks || [])[0] || {};
      const newTask = {
        ...deepClone(templateChild),
        id: newTaskId,
        parent_id: DEFAULT_WORK,
        project_id: projectId,
        title: shortTitle,
        goal: text,
        state: 'running',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        summary: { dot: 'running', line: 'Codex @ linux-gpu-01 正在执行…' },
      };
      listing.children = [...(listing.children || []), newTask];
      db['/api/tasks/' + newTaskId] = {
        task: newTask,
        work: findTaskListing(DEFAULT_WORK) || newTask,
        children: [],
        runs: [{
          id: uid('run'), task_id: newTaskId, state: 'running', created_at: new Date().toISOString(),
          machine_id: 'linux-gpu-01', login_id: 'work-codex', role_id: 'implement',
        }],
        approvals: [],
      };
      db['/api/messages/' + inId + '/changes'] = {
        changes: [{ id: uid('chg'), kind: 'create_task', title: shortTitle }],
        tasks: [{ id: newTaskId, title: shortTitle, state: 'running', role_id: 'implement' }],
      };
      const outMsg = {
        id: outId, created_at: new Date().toISOString(), direction: 'out', channel: 'console',
        external_id: 'reply:' + inId, actor: 'router', text: replySteps[1], state: 'processed', final: 1,
        project_id: projectId, segment_id: segId,
      };
      inMsg.state = 'processed';
      appendMessage(projectId, inMsg);
      appendMessage(projectId, outMsg);
      emitSSE('task', { id: newTaskId, state: 'running' });
      emitSSE('changed', { at: Date.now() });
    }, 900);

    // Complete task & auto-propose a new Knowledge Evolution Proposal after 3.2s!
    setTimeout(() => {
      const t = findTaskListing(newTaskId);
      if (t) {
        t.state = 'ready';
        t.summary = { dot: 'waiting', line: '执行与单测已通过，等待验收' };
      }
      if (db['/api/tasks/' + newTaskId]?.task) {
        db['/api/tasks/' + newTaskId].task.state = 'ready';
      }
      const kn = db['/api/knowledge'];
      if (kn && Array.isArray(kn.awaiting)) {
        const pid = uid('01J9KP');
        const prop = {
          ...deepClone(kn.awaiting[0]),
          id: pid,
          created_at: new Date().toISOString(),
          proposed_by: 'codex @ linux-gpu-01',
          change: {
            kind: 'knowledge',
            inputs: [],
            outputs: [{
              key: 'out-live', revises: null,
              title: '从「' + shortTitle + '」提炼的新工程经验',
              when_to_use: '后续执行类似任务或跨模型审阅时',
              body: '本次交互演示自动沉淀：已通过独立把关核验，点击「同意」即可正式晋升为项目生效知识并同步至全网节点。',
              project_ids: [projectId], loading: 'resident', roles: ['implement', 'review'],
            }],
          },
        };
        kn.awaiting.unshift(prop);
        kn.proposals.unshift(prop);
        if (db['/api/overview']?.counts) db['/api/overview'].counts.knowledge_awaiting = kn.awaiting.length;
        db['/api/knowledge/proposals/' + pid] = {
          proposal: {
            ...prop,
            evidence: [{
              id: pid + '-ev-1', seq: 1, source: 'task_run', ref: newTaskId,
              location: 'live-demo', excerpt: text, captured_at: new Date().toISOString(),
              sha256: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
              submitted_by: 'codex @ linux-gpu-01', verified: true,
            }],
          },
          inputs: [],
          impact: { kind: 'forecast', dropped: [], combos: [] },
        };
      }
      emitSSE('task', { id: newTaskId, state: 'ready' });
      emitSSE('changed', { at: Date.now() });
    }, 3200);

    return jsonRes({ id: inId }, 201);
  }

  const nativeFetch = window.fetch.bind(window);
  window.fetch = async function (input, init) {
    const rawUrl = typeof input === 'string' ? input : (input instanceof Request ? input.url : String(input));
    const parsed = new URL(rawUrl, window.location.origin);
    const pathWithQuery = parsed.pathname + parsed.search;
    const method = ((init && init.method) || (input instanceof Request ? input.method : 'GET')).toUpperCase();

    if (!parsed.pathname.startsWith('/api/')) {
      return nativeFetch(input, init);
    }

    let body = {};
    if (init && typeof init.body === 'string') {
      try { body = JSON.parse(init.body); } catch {}
    }

    // Handle live interactive mutations
    if (method === 'POST' && parsed.pathname === '/api/messages') {
      return handleSendMessage(body);
    }
    const apMatch = method === 'POST' && /^\\/api\\/approvals\\/([^/]+)\\/answer$/.exec(parsed.pathname);
    if (apMatch) {
      const apId = decodeURIComponent(apMatch[1]);
      const apData = db['/api/approvals'];
      if (apData?.approvals) {
        for (const a of apData.approvals) {
          if (a.id === apId) {
            a.state = 'answered';
            a.answers = body.answers || ['已确认'];
            a.answered_via = 'console';
            const t = findTaskListing(a.task_id);
            if (t) { t.state = 'ready'; t.summary = { dot: 'waiting', line: '已确认决策，待验收' }; }
          }
        }
      }
      emitSSE('changed', { at: Date.now() });
      return jsonRes({ status: 'accepted' });
    }
    const accMatch = method === 'POST' && /^\\/api\\/tasks\\/([^/]+)\\/accept$/.exec(parsed.pathname);
    if (accMatch) {
      const tid = decodeURIComponent(accMatch[1]);
      const t = findTaskListing(tid);
      if (t) { t.state = 'done'; t.summary = { dot: 'success', line: '已验收合并' }; }
      if (db['/api/tasks/' + tid]?.task) db['/api/tasks/' + tid].task.state = 'done';
      emitSSE('task', { id: tid, state: 'done' });
      emitSSE('changed', { at: Date.now() });
      return jsonRes({ task: t || { id: tid, state: 'done' } });
    }
    const decMatch = method === 'POST' && /^\\/api\\/knowledge\\/proposals\\/([^/]+)\\/decide$/.exec(parsed.pathname);
    if (decMatch) {
      const pid = decodeURIComponent(decMatch[1]);
      const kn = db['/api/knowledge'];
      if (kn) {
        const idx = (kn.awaiting || []).findIndex(p => p.id === pid);
        const prop = idx >= 0 ? kn.awaiting.splice(idx, 1)[0] : null;
        if (prop) {
          prop.state = body.decision === 'approve' ? 'published' : 'rejected';
          if (body.decision === 'approve' && prop.change?.outputs?.[0]) {
            const o = prop.change.outputs[0];
            const eid = uid('01J9KE');
            const newEntry = {
              id: eid, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
              title: o.title, when_to_use: o.when_to_use, kind: prop.kind,
              project_ids: o.project_ids, loading: o.loading, roles: o.roles || [],
              revision: 1, state: 'active', reviewed: true, body: o.body,
            };
            kn.entries = [newEntry, ...(kn.entries || [])];
            db['/api/knowledge/entries/' + eid] = { entry: newEntry, revisions: [{ ...newEntry, proposed_by: prop.proposed_by, source: prop.source, evidence: [] }] };
          }
          if (db['/api/knowledge/proposals/' + pid]?.proposal) {
            const dp = db['/api/knowledge/proposals/' + pid].proposal;
            dp.state = prop.state;
            dp.decided_at = new Date().toISOString();
            dp.decided_by = 'owner';
            dp.decided_via = 'console';
            dp.decision_note = body.note || null;
            if (prop.state === 'published') dp.published_at = dp.decided_at;
          }
          if (db['/api/overview']?.counts) db['/api/overview'].counts.knowledge_awaiting = (kn.awaiting || []).length;
        }
      }
      emitSSE('changed', { at: Date.now() });
      return jsonRes({ ok: true });
    }

    // Serve GET snapshots (exact match, then pathname match, then graceful empty fallback)
    if (method === 'GET') {
      if (pathWithQuery in db) return jsonRes(deepClone(db[pathWithQuery]));
      if (parsed.pathname in db) return jsonRes(deepClone(db[parsed.pathname]));
      if (parsed.pathname.startsWith('/api/messages/') && parsed.pathname.endsWith('/changes')) {
        return jsonRes({ changes: [], tasks: [] });
      }
      if (parsed.pathname.startsWith('/api/messages')) {
        return jsonRes({ messages: [], changes: {} });
      }
      if (parsed.pathname.includes('/files')) return jsonRes({ files: [] });
      if (parsed.pathname.includes('/groups')) return jsonRes({ bindings: [], discovered: [] });
      if (parsed.pathname.includes('/triggers')) return jsonRes({ triggers: [], recent: [], groups: [] });
      if (parsed.pathname.includes('/runs/')) return jsonRes({ events: [], text: '', report: null });
      return jsonRes({});
    }

    // Graceful no-op acknowledgement for any other interactive write in Demo mode
    emitSSE('changed', { at: Date.now() });
    return jsonRes({ ok: true });
  };

  // Non-intrusive Demo badge & reset button (only when opened standalone, not inside iframe)
  if (window.self === window.top) {
    window.addEventListener('DOMContentLoaded', () => {
      const bar = document.createElement('div');
      bar.style.cssText = 'position:fixed;right:14px;bottom:14px;z-index:9999;display:flex;align-items:center;gap:8px;padding:6px 12px;border-radius:999px;background:rgba(13,19,34,0.92);color:#E4ECF8;border:1px solid rgba(56,189,248,0.35);font:12px/1.4 system-ui,-apple-system,sans-serif;backdrop-filter:blur(10px);box-shadow:0 8px 24px rgba(0,0,0,0.45)';
      bar.innerHTML = '<span style="color:#38BDF8;font-weight:700">● 交互式模拟工作台</span><a href="../index.html" style="color:#CBD5E1;text-decoration:none;border-left:1px solid rgba(148,163,184,0.25);padding-left:8px">返回官网</a><button id="tycho-demo-reset" style="cursor:pointer;background:rgba(56,189,248,0.16);color:#7DD3FC;border:1px solid rgba(56,189,248,0.3);border-radius:999px;padding:2px 9px;font-size:11px">重置</button>';
      document.body.appendChild(bar);
      document.getElementById('tycho-demo-reset')?.addEventListener('click', () => {
        db = deepClone(INITIAL.seedMap);
        emitSSE('changed', { at: Date.now() });
        window.location.reload();
      });
    });
  }
})();
`;
}

export async function buildInteractiveDemo(outDemoDir: string): Promise<{ projectId: string; workId: string }> {
  const consoleDist = join(ROOT, 'console', 'dist');
  if (!existsSync(join(consoleDist, 'index.html'))) {
    throw new Error('console/dist not found — run `TYCHO_CONSOLE_BASE=./ npm --prefix console run build` first');
  }

  const { projectId, workId, seedMap } = await collectSeed();
  rmSync(outDemoDir, { recursive: true, force: true });
  mkdirSync(outDemoDir, { recursive: true });
  cpSync(consoleDist, outDemoDir, { recursive: true });

  const engineJs = buildDemoEngineSource(projectId, workId, seedMap);
  writeFileSync(join(outDemoDir, 'demo-engine.js'), engineJs, 'utf8');

  // Inject synchronous demo-engine.js before Vite's module bundle & strip service worker registration in demo
  const htmlPath = join(outDemoDir, 'index.html');
  let html = readFileSync(htmlPath, 'utf8');
  html = html.replace('<head>', '<head>\n  <script src="./demo-engine.js"></script>');
  html = html.replace(/<link rel="manifest"[^>]*>/i, '');
  writeFileSync(htmlPath, html, 'utf8');
  rmSync(join(outDemoDir, 'sw.js'), { force: true });

  console.log(`Built real interactive Console Demo in ${outDemoDir} (project=${projectId}, work=${workId}, engine=${Math.round(engineJs.length / 1024)} KB)`);
  return { projectId, workId };
}
