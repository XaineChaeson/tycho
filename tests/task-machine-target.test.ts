// Guards direct task machine targeting (`task.machine_id`), explicit default task directory
// (`source: null`), automatic fallback when a project's default folder source lives on another
// machine, elimination of folder/login/machine conflict deadlocks, `list_machines` empty
// `local_skills` distinction, and production `ownLoginTiers` auto-adoption wiring.
import './guard.ts';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { ADAPTERS } from '../adapters/all.ts';
import { Db, SCHEMA_VERSION, verifySnapshot } from '../service/db.ts';
import { createDispatcher } from '../service/dispatcher.ts';
import { DEFAULT_KNOWLEDGE_LIMITS } from '../service/knowledge.ts';
import { openLedger, type Ledger } from '../service/ledger.ts';
import { createTools } from '../service/tools.ts';
import type { Login, LoginStore, Machine, MachineStore } from '../runner/snapshot.ts';
import { content, fixture, holdMachine, testMachine, USER } from './helpers.ts';

function ledgerLogins(ledger: Ledger): LoginStore {
  const all = (): Login[] => [
    ...ledger.listAccounts().map(({ created_at: _c, updated_at: _u, ...acc }) => acc),
    ...ledger.listMachineLogins().map(({ created_at: _c, updated_at: _u, ...ml }) => ml),
  ];
  return {
    get: (id) => all().find((login) => login.id === id),
    list: all,
  };
}

function ledgerMachines(ledger: Ledger): MachineStore {
  return {
    get: (id) => ledger.getMachine(id),
    list: () => ledger.listMachines(),
  };
}

function runTools(f: ReturnType<typeof fixture>, overrides: Partial<Parameters<typeof createTools>[0]> = {}) {
  const tools = createTools({
    ledger: f.ledger,
    logins: ledgerLogins(f.ledger),
    machines: { list: () => f.ledger.listMachines() },
    runner: {
      interrupt: async () => 'ended',
      events: () => [],
      abandon: async () => {},
    },
    accept: {
      accept: async () => ({ stored: [], problem: null }),
      register: async () => ({ runId: 'r', revision: 1, registration: 'reg', reviewed: null }),
      refetch: async () => ({ stored: [], problem: null }),
      sweep: () => {},
    },
    ...overrides,
  });
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = await tools.call(name, args, { actor: 'router' }, { projectId: f.projectId });
    const text = res.content.map((item) => item.text).join('\n');
    assert.equal(res.isError ?? false, false, text);
    return text;
  };
  return { tools, call };
}

const DISPATCHER_DEFAULTS = {
  knowledgeLimits: () => DEFAULT_KNOWLEDGE_LIMITS,
  runTimeoutMs: () => 60_000,
  lostGraceMs: () => 60_000,
  frontLead: () => 5 * 60_000,
  usageWarnAt: () => 85,
  outputReady: () => true,
};

test('v47 -> v48 migration adds task.machine_id and verifies snapshot', (t) => {
  const f = fixture(t);
  const path = join(f.dir, 'v47.db');
  const db = new Db(path, false, {}, { log: () => {} });
  db.close();

  const raw = new DatabaseSync(path);
  raw.exec(`
    ALTER TABLE task DROP COLUMN machine_id;
    UPDATE setting SET value_json = '47' WHERE key = 'schema_version';
  `);
  raw.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  raw.close();

  const v47Snap = join(f.dir, 'snap-v47.db');
  const c1 = new DatabaseSync(path);
  c1.prepare('VACUUM INTO ?').run(v47Snap);
  c1.close();
  assert.equal(verifySnapshot(v47Snap).get('schema_version'), '47');

  const upgraded = openLedger(path, { copyBeforeUpgrade: false });
  try {
    assert.equal(SCHEMA_VERSION, 48);
    const pid = upgraded.createProject({ name: '迁移项目' }, USER);
    const task = upgraded.createTask({ projectId: pid, title: '旧任务默认为空', goal: '验证 machine_id 列' }, USER);
    assert.equal(task.machine_id, null);
  } finally {
    upgraded.close();
  }

  const v48Snap = join(f.dir, 'snap-v48.db');
  const c2 = new DatabaseSync(path);
  c2.prepare('VACUUM INTO ?').run(v48Snap);
  c2.close();
  assert.equal(verifySnapshot(v48Snap).get('schema_version'), '48');
});

test('machine_id dispatches managed account directly to target machine in default task dir without folder binding', async (t) => {
  const f = fixture(t, {}, false);
  holdMachine(f.ledger, testMachine('work-pc', 'work-pc.local'));
  holdMachine(f.ledger, testMachine('home-win', 'home-win.local'));
  const m1 = f.ledger.getMachine('work-pc')!;
  const m2 = f.ledger.getMachine('home-win')!;
  f.ledger.putAccount({
    id: 'acc-gemini',
    name: 'gemini-shared',
    executor: 'gemini',
    tiers: { decide: content('{"effort":"high"}\n'), execute: content('{"effort":"medium"}\n') },
  }, USER, 'ref-gemini');
  const acc = ledgerLogins(f.ledger).get('acc-gemini')!;
  // Project default source is a local folder on work-pc only; home-win has NO folder source and NO own login.
  f.ledger.setProjectSources(f.projectId, [{ kind: 'folder', machine_uid: m1.uid, path: '/work/tycho' }], USER);
  f.ledger.setProjectLogins(f.projectId, [acc.id], USER, 'selected');

  // Omitting `source` while setting `machine_id: 'home-win'` auto-falls back to default empty task dir (`source_json: null`).
  const created = f.ledger.createTask({
    projectId: f.projectId,
    title: '巡检家庭 Windows',
    goal: '核实本机 skills',
    machineId: 'home-win',
  }, USER);
  assert.equal(created.machine_id, 'home-win');
  assert.equal(created.source_json, null);
  f.ledger.queueTask(created.id, USER);

  const launched: Array<{ runId: string; machineId: string | null; source: unknown }> = [];
  const dispatcher = createDispatcher({
    ledger: f.ledger,
    runner: {
      findMachine: async (_login: Login, offered: readonly Machine[]) => offered[0],
      launch: async (run) => {
        launched.push({
          runId: run.id,
          machineId: run.machine_id,
          source: (JSON.parse(run.snapshot_json) as { source?: unknown }).source,
        });
      },
      watch: async () => {},
      lostCandidates: () => [],
      presume: async () => 'ended',
      sweep: async () => {},
    },
    logins: ledgerLogins(f.ledger),
    machines: ledgerMachines(f.ledger),
    executors: ADAPTERS,
    ...DISPATCHER_DEFAULTS,
    connected: () => true,
    reported: () => ({ executor: 'gemini', installed: true, version: '1.5.18', logged_in: null }),
  });

  await dispatcher.tick();
  assert.equal(launched.length, 1);
  assert.equal(launched[0]!.machineId, m2.id);
  assert.equal(launched[0]!.source, undefined, 'runs in Tycho default empty task dir');

  // Ledger itself rejects dispatching a machine_id-pinned task onto another machine.
  const pinnedTask = f.ledger.createTask({
    projectId: f.projectId,
    title: '仅限 home-win',
    goal: '检查强约束',
    machineId: 'home-win',
    sourceId: null,
  }, USER);
  f.ledger.queueTask(pinnedTask.id, USER);
  assert.throws(() => f.ledger.createRun(pinnedTask.id, {
    login: acc,
    machine: m1,
    snapshot: { timeout_ms: 60_000, executor: 'gemini', tier: 'execute' },
    expectedRevision: pinnedTask.revision,
    placedBy: 'order',
  }, USER), /任务指定了目标机器 home-win，不能派发到 work-pc/);
});

test('explicit source: null uses default task directory even when project has repo source', async (t) => {
  const f = fixture(t, {}, false);
  holdMachine(f.ledger, testMachine('home-ubuntu', 'home-ubuntu.local'));
  f.ledger.putAccount({
    id: 'acc-codex',
    name: 'codex-shared',
    executor: 'codex',
    tiers: { decide: content('model_reasoning_effort=high\n'), execute: content('model_reasoning_effort=medium\n') },
  }, USER, 'ref-codex');
  f.ledger.setProjectSources(f.projectId, [{ kind: 'repo', url: 'https://example.com/repo.git' }], USER);
  f.ledger.setProjectLogins(f.projectId, ['acc-codex'], USER, 'selected');

  const { call } = runTools(f);
  const answer = await call('create_task', {
    title: '轻量检查 Ubuntu',
    goal: '检查本机目录',
    machine_id: 'home-ubuntu',
    source: null,
  });
  assert.match(answer, /任务已创建并排队/);
  const [task] = f.ledger.listTasks({ projectId: f.projectId });
  assert.equal(task!.machine_id, 'home-ubuntu');
  assert.equal(task!.source_json, null);

  // update_task can clear machine_id with null.
  await call('update_task', { task_id: task!.id, machine_id: null });
  assert.equal(f.ledger.getTask(task!.id).machine_id, null);
});

test('placement conflicts reject early on create/update and hold cleanly in dispatcher instead of deadlocking in queued', async (t) => {
  const f = fixture(t, {}, false);
  holdMachine(f.ledger, testMachine('work-pc', 'work-pc.local'));
  holdMachine(f.ledger, testMachine('home-win', 'home-win.local'));
  const m1 = f.ledger.getMachine('work-pc')!;
  f.ledger.putMachineLogin({
    executor: 'claude',
    machine: 'work-pc',
    tiers: { decide: content('{"effortLevel":"high"}\n'), execute: content('{"effortLevel":"medium"}\n') },
  }, USER);
  f.ledger.putMachineLogin({
    executor: 'claude',
    machine: 'home-win',
    tiers: { decide: content('{"effortLevel":"high"}\n'), execute: content('{"effortLevel":"medium"}\n') },
  }, USER);
  const workLogin = f.ledger.getMachineLogin('work-pc', 'claude')!;
  const homeLogin = f.ledger.getMachineLogin('home-win', 'claude')!;
  f.ledger.setProjectSources(f.projectId, [{ kind: 'folder', machine_uid: m1.uid, path: '/work/repo' }], USER);
  const workFolderId = f.ledger.projectSources(f.projectId)[0]!.id;
  f.ledger.setProjectLogins(f.projectId, [workLogin.id, homeLogin.id], USER, 'selected');

  // 1. Explicit folder@work-pc + machine_id: home-win -> rejected immediately.
  assert.throws(() => f.ledger.createTask({
    projectId: f.projectId,
    title: '冲突1',
    goal: 'g',
    machineId: 'home-win',
    sourceId: workFolderId,
  }, USER), /目标机器 home-win 与代码来源 .* 所在机器 work-pc 冲突/);

  // 2. Explicit folder@work-pc + home-win/claude -> rejected immediately.
  assert.throws(() => f.ledger.createTask({
    projectId: f.projectId,
    title: '冲突2',
    goal: 'g',
    loginId: homeLogin.id,
    sourceId: workFolderId,
  }, USER), /只能在机器 home-win 上跑，与代码来源 .* 所在机器 work-pc 冲突/);

  // 3. machine_id: home-win + work-pc/claude -> rejected immediately.
  assert.throws(() => f.ledger.createTask({
    projectId: f.projectId,
    title: '冲突3',
    goal: 'g',
    machineId: 'home-win',
    loginId: workLogin.id,
    sourceId: null,
  }, USER), /只能在机器 work-pc 上跑，与目标机器 home-win 冲突/);

  // 4. Unpinned task targeting home-win when project ONLY allows work-pc/claude -> dispatcher holds immediately (no queued deadlock!).
  f.ledger.setProjectLogins(f.projectId, [workLogin.id], USER, 'selected');
  const stranded = f.ledger.createTask({
    projectId: f.projectId,
    title: '无兼容登录的任务',
    goal: '不应永久卡在 queued',
    machineId: 'home-win',
    sourceId: null,
  }, USER);
  f.ledger.queueTask(stranded.id, USER);

  const dispatcher = createDispatcher({
    ledger: f.ledger,
    runner: {
      findMachine: async (_login: Login, offered: readonly Machine[]) => offered[0],
      launch: async () => {},
      watch: async () => {},
      lostCandidates: () => [],
      presume: async () => 'ended',
      sweep: async () => {},
    },
    logins: ledgerLogins(f.ledger),
    machines: ledgerMachines(f.ledger),
    executors: ADAPTERS,
    ...DISPATCHER_DEFAULTS,
    connected: () => true,
    reported: () => ({ executor: 'claude', installed: true, version: '2.1.317', logged_in: true }),
  });

  await dispatcher.tick();
  const after = f.ledger.getTask(stranded.id);
  assert.equal(after.state, 'held');
  assert.match(after.reason ?? '', /没有能在机器 home-win 上跑的可用登录/);

  // 5. Offline pinned machine surfaces `source_offline` in waitOf.
  f.ledger.setProjectLogins(f.projectId, [homeLogin.id], USER, 'selected');
  const waitingTask = f.ledger.createTask({
    projectId: f.projectId,
    title: '等待 home-win 上线',
    goal: '检查离线等待原因',
    machineId: 'home-win',
    sourceId: null,
  }, USER);
  f.ledger.queueTask(waitingTask.id, USER);
  const offlineDispatcher = createDispatcher({
    ledger: f.ledger,
    runner: {
      findMachine: async () => undefined,
      launch: async () => {},
      watch: async () => {},
      lostCandidates: () => [],
      presume: async () => 'ended',
      sweep: async () => {},
    },
    logins: ledgerLogins(f.ledger),
    machines: ledgerMachines(f.ledger),
    executors: ADAPTERS,
    ...DISPATCHER_DEFAULTS,
    connected: (id) => id !== 'home-win',
    reported: () => ({ executor: 'claude', installed: true, version: '2.1.317', logged_in: true }),
  });
  const wait = offlineDispatcher.waitOf(f.ledger.getTask(waitingTask.id));
  assert.equal(wait?.source_offline, 'home-win');
});

test('list_machines distinguishes scanned empty local_skills ([]) from unreported (null/omitted)', async (t) => {
  const f = fixture(t, {}, false);
  holdMachine(f.ledger, testMachine('scanned-empty', 'empty.local'));
  holdMachine(f.ledger, testMachine('unreported', 'old.local'));
  const { call } = runTools(f, {
    localSkills: (id) => (id === 'scanned-empty' ? [] : null),
  });
  const rows = JSON.parse(await call('list_machines')) as Array<{ id: string; local_skills?: unknown[] }>;
  const emptyRow = rows.find((row) => row.id === 'scanned-empty')!;
  const oldRow = rows.find((row) => row.id === 'unreported')!;
  assert.deepEqual(emptyRow.local_skills, []);
  assert.equal('local_skills' in oldRow, false);
});

test('service/main.ts wires ownLoginTiers into createNodes so machine logins auto-adopt in production', () => {
  const src = readFileSync(join(import.meta.dirname, '..', 'service', 'main.ts'), 'utf8');
  const match = src.match(/const nodes = createNodes\(\{[\s\S]*?\}\);/);
  assert.ok(match, 'createNodes call exists in service/main.ts');
  assert.match(match[0], /ownLoginTiers:\s*\(executor\)\s*=>/);
});
