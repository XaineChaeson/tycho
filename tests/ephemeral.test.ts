// Guards docs/design/nodes.md §1.3 and §11 step 4: a machine a task spawns joins with a
// one-time material handed to a round of that task within a quota the Router asked for,
// and ends in separately recorded facts.
//
// What this file is here to catch:
//   - a material that keeps working after its time, a second time, or once its quota is
//     full — and two machines coming out of one material raced,
//   - a retried claim (the same device, the same secret) making a second machine instead
//     of returning the one it already has,
//   - the Router getting a quota for a project whose owner never allowed spawning, past the
//     ceiling the owner set, or for executors or accounts that could never use the machine,
//   - the material itself showing up anywhere but the Worker's hands: the host's log, the
//     ledger's tables (change rows among them), the round's directory on the machine, the
//     start's command,
//   - an ephemeral machine taking work outside the intersection of its quota, its project,
//     the account's range and what it says it can run,
//   - the endings collapsed into one: a material that lapsed, a machine that stopped taking
//     work, a machine whose evidence is all in, a registration that ended, an instance
//     actually destroyed — and in particular "gone from the list" read as "released",
//   - a revoked machine whose next poll is still answered,
//   - an idle ephemeral machine staying registered after the task it was spawned for ended,
//   - a round asking for its credential again (an answer lost on the way) being minted a
//     second batch of materials instead of the one it was handed,
//   - a client of the protocol before materials and `retire` existed being served answers
//     it misreads, instead of being refused,
//   - a spawned machine's joining read in the timeline as the owner letting a machine in,
//   - a quota that never handed a material shown as one whose materials lapsed, and a
//     machine whose round was lost shown as still waiting for its evidence,
//   - the Router told a material lasts 15 minutes whatever the setting says.
import './guard.ts';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';
import { claudeAdapter } from '../adapters/claude.ts';
import { createRunner } from '../runner/runner.ts';
import type { Account, Login } from '../runner/snapshot.ts';
import { eligibleMachines, prepareSnapshot } from '../runner/snapshot.ts';
import type { Ctx } from '../service/ledger.ts';
import { ACTION_TEXT, machineEndLines } from '../shared/labels.ts';
import type { MachineEnds } from '../shared/labels.ts';
import { HOST_URL_ENV, JOIN_MATERIALS_ENV, NODE_PROTOCOL } from '../shared/node-protocol.ts';
import type { NodeFacts, NodeJoinAnswer } from '../shared/node-protocol.ts';
import { createClient, factsOf, identityOf } from '../node/client.ts';
import { boxOf } from '../node/runbox.ts';
import { fakeRemote } from './fake-remote.ts';
import { LOGIN, fixture, MACHINE, memoryLogins, memoryMachines, RUNNER_TUNED, RUN_LIMIT_MS } from './helpers.ts';
import { signIn } from './stage.ts';
import { bench } from './node-run-fixture.ts';
import type { NodeBench } from './node-run-fixture.ts';

const options = { timeout: 120_000 };
const USER: Ctx = { actor: 'test' };
const MINUTE_MS = 60_000;
const hashOf = (text: string): string => createHash('sha256').update(text).digest('hex');
const facts = (nodeId: string, name: string): NodeFacts => ({ node_id: nodeId, name, platform: 'test', hostname: `${name}.local` });

async function until<T>(read: () => T | undefined | false | null | Promise<T | undefined | false | null>, what: string, timeoutMs = 40_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`等不到：${what}`);
    await sleep(20);
  }
}

// A join over HTTP, the way a machine's client sends it, with a material in place of the
// six digits (shared/node-protocol.ts NodeJoinRequest.invite).
async function joinWith(base: string, invite: { material: string; secret: string }, who: NodeFacts): Promise<{ status: number; answer: NodeJoinAnswer & { error?: string } }> {
  const response = await fetch(`${base}/api/node/join`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ protocol: NODE_PROTOCOL, facts: who, invite }),
  });
  return { status: response.status, answer: (await response.json()) as NodeJoinAnswer & { error?: string } };
}
const tokenOf = (answer: NodeJoinAnswer): string => (answer.state === 'approved' ? answer.token : '');
const machineOf = (answer: NodeJoinAnswer): string => (answer.state === 'approved' ? answer.machine_id : '');

const poll = (base: string, token: string, who: NodeFacts): Promise<Response> =>
  fetch(`${base}/api/node/poll`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ protocol: NODE_PROTOCOL, cursor: null, runs: [], facts: who }),
  });

// The task that spawns machines, with a round of its own that already settled: a real Run
// is what a material is handed to. It is another task than the bench's, so the bench's own
// stays free for the rounds a test wants run.
function creator(b: NodeBench): { taskId: string; runId: string; round: (label: string) => string } {
  const task = b.host.ledger.createTask({ projectId: b.projectId, title: '开机器', goal: '开一台', acceptance: '回执', loginId: 't1', roleId: 'implement' }, USER);
  const round = (label: string): string => {
    // Queued and dispatched in one go, before the dispatcher's next tick can take it; it is
    // left waiting for acceptance, which the dispatcher never touches.
    const before = b.host.ledger.getTask(task.id);
    if (before.state === 'draft') b.host.ledger.queueTask(task.id, USER);
    else b.host.ledger.reworkTask(task.id, '再来一轮', before.revision, USER);
    const account = b.host.accounts.get('t1')! as Account;
    const now = b.host.ledger.getTask(task.id);
    const snapshot = prepareSnapshot(now, account, {[account.executor]:claudeAdapter}, { timeoutMs: RUN_LIMIT_MS });
    const run = b.host.ledger.createRun(task.id, { login: account, machine: b.host.ledger.getMachine(b.machine.id)!, snapshot, expectedRevision: now.revision }, USER);
    b.host.ledger.settleRun(run.id, 0, { status: 'done', summary: label, artifacts: [{ kind: 'commit', ref: 'c0ffee' }, { kind: 'report', ref: 'report.md' }] }, {});
    return run.id;
  };
  return { taskId: task.id, runId: round('第一轮'), round };
}

// A round of a task being started on a machine (the bench's own unless named): launching,
// the state in which the credential channel answers. Made in one go, like creator's rounds,
// before the dispatcher's next tick could take the task.
function launching(b: NodeBench, taskId: string, machineId = b.machine.id): string {
  const before = b.host.ledger.getTask(taskId);
  if (before.state === 'draft') b.host.ledger.queueTask(taskId, USER);
  else if (before.state !== 'queued') b.host.ledger.reworkTask(taskId, '再来一轮', before.revision, USER);
  const account = b.host.accounts.get('t1')! as Account;
  const now = b.host.ledger.getTask(taskId);
  const snapshot = prepareSnapshot(now, account, {[account.executor]:claudeAdapter}, { timeoutMs: RUN_LIMIT_MS });
  return b.host.ledger.createRun(taskId, { login: account, machine: b.host.ledger.getMachine(machineId)!, snapshot, expectedRevision: now.revision }, USER).id;
}

// A quota on a creator's task, and materials handed to its round: the ledger's own steps,
// without a Worker in between.
function issued(b: NodeBench, over: { maxMachines?: number; materialTtlMs?: number; executors?: string[] } = {}) {
  b.host.ledger.setProjectSpawnMachines(b.projectId, true, USER);
  const made = creator(b);
  const invite = b.host.ledger.createInvite({ taskId: made.taskId, executors: over.executors ?? null, ttlMs: 60 * MINUTE_MS, maxMachines: over.maxMachines ?? 1 }, USER);
  const materials = b.host.ledger.handInvite(made.taskId, made.runId, over.materialTtlMs ?? 15 * MINUTE_MS);
  assert.ok(materials, '名额打开着，材料发得出来');
  assert.equal(materials.length, over.maxMachines ?? 1, '每一个还能登记的名额一份材料');
  return { invite, materials, ...made };
}

// Every row of every table of the ledger, as text: what a secret must not be in.
function ledgerText(path: string): string {
  const conn = new DatabaseSync(path);
  try {
    const tables = (conn.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as { name: string }[]).map(({ name }) => name);
    return tables.map((table) => JSON.stringify(conn.prepare(`SELECT * FROM ${table}`).all())).join('\n');
  } finally {
    conn.close();
  }
}

// The actions of the ledger's change rows, oldest first; with a machine, only those about it.
function changeActions(hostDataDir: string, machineId?: string): string[] {
  const conn = new DatabaseSync(join(hostDataDir, 'ledger.db'));
  try {
    const rows = conn.prepare('SELECT action, detail_json FROM change ORDER BY seq').all() as { action: string; detail_json: string | null }[];
    return rows
      .filter(({ detail_json }) => machineId === undefined || (JSON.parse(detail_json ?? '{}') as { machine_id?: string }).machine_id === machineId)
      .map(({ action }) => action);
  } finally {
    conn.close();
  }
}

function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? filesUnder(join(dir, entry.name)) : [join(dir, entry.name)]));
}

test('材料过期、用过、名额用完都兑换不了；同一台机器重试认领拿回的是同一台', options, async (t) => {
  const b = await bench(t, {}, {}, { anyMachine: true, hold: true });
  const { invite, materials: [material], taskId, runId, round } = issued(b, { maxMachines: 1 });
  const secret = 'a'.repeat(64);
  const who = facts('e1e1e1e1e1e1e1e1', 'eph-one');

  const first = await joinWith(b.base, { material: material!, secret }, who);
  assert.equal(first.status, 200, first.answer.error ?? '');
  const machineId = machineOf(first.answer);
  assert.equal(machineId, 'eph-one', '机器名来自它自己报的名字');
  const machine = b.host.ledger.getMachine(machineId)!;
  assert.equal(machine.ephemeral, true, '材料换来的机器是临时机器');
  assert.equal(machine.inviteId, invite.id);
  assert.deepEqual(machine.scope, { project_id: b.projectId, executors: null }, '它的范围就是名额的范围');
  assert.deepEqual(machine.source, { task_id: taskId, run_id: runId, round: 1 }, '来源是派生它的任务和那一轮');
  // Nobody let it in: the timeline says it came in with a material.
  const actions = changeActions(b.hostDataDir, machineId);
  assert.ok(actions.includes('machine.join_spawned'), '兑换记成“临时机器凭材料加入”');
  assert.equal(actions.includes('machine.join'), false, '不记成“放行新机器”');
  assert.equal(ACTION_TEXT['machine.join_spawned'], '临时机器凭材料加入');

  // The same device, the same secret: a response lost on the way is claimed again, and the
  // answer is the same machine — never a second one — although the material is used up.
  const again = await joinWith(b.base, { material: material!, secret }, who);
  assert.equal(again.status, 200, again.answer.error ?? '');
  assert.equal(machineOf(again.answer), machineId, '重试认领回的是同一台机器');
  assert.equal((await poll(b.base, tokenOf(again.answer), who)).status, 200, '重试拿到的令牌能用');
  assert.notEqual(tokenOf(first.answer), tokenOf(again.answer), '重试换一个令牌，丢在路上的那个不再有效');
  assert.equal((await poll(b.base, tokenOf(first.answer), who)).status, 401);
  // The secret is the device's: another device presenting it gets nothing.
  const thief = await joinWith(b.base, { material: material!, secret }, facts('e9e9e9e9e9e9e9e9', 'thief'));
  assert.equal(thief.status, 400);
  assert.equal(b.host.ledger.listMachines().filter((each) => each.ephemeral).length, 1, '登记里只有一台');

  // Another device with the same material: one material, one machine.
  const other = await joinWith(b.base, { material: material!, secret: 'b'.repeat(64) }, facts('e2e2e2e2e2e2e2e2', 'eph-two'));
  assert.equal(other.status, 400);
  assert.match(other.answer.error ?? '', /用过/);
  assert.equal(b.host.ledger.getInvite(invite.id)!.used, 1);
  assert.equal(b.host.ledger.handInvite(taskId, round('第二轮'), MINUTE_MS), undefined, '名额用完了，下一轮不再发材料');

  // A material that lapsed: a fresh quota, a material good for a millisecond.
  b.host.ledger.createInvite({ taskId, executors: null, ttlMs: 60 * MINUTE_MS, maxMachines: 1 }, USER);
  t.mock.timers.enable({ apis: ['Date'] });
  const [short] = b.host.ledger.handInvite(taskId, round('第三轮'), 1)!;
  t.mock.timers.tick(1);
  const expired = await joinWith(b.base, { material: short!, secret: 'c'.repeat(64) }, facts('e3e3e3e3e3e3e3e3', 'eph-three'));
  assert.equal(expired.status, 400);
  assert.match(expired.answer.error ?? '', /过期/);
  t.mock.timers.reset();
  // A material nobody issued, and one under a quota the owner revoked.
  const unknown = await joinWith(b.base, { material: 'f'.repeat(64), secret: 'd'.repeat(64) }, facts('e4e4e4e4e4e4e4e4', 'eph-four'));
  assert.equal(unknown.status, 400);
  const [fresh] = b.host.ledger.handInvite(taskId, round('第四轮'), MINUTE_MS)!;
  b.host.ledger.revokeInvite(b.host.ledger.openInvite(taskId)!.id, USER);
  const revoked = await joinWith(b.base, { material: fresh!, secret: '5'.repeat(64) }, facts('e5e5e5e5e5e5e5e5', 'eph-five'));
  assert.equal(revoked.status, 400);
  assert.match(revoked.answer.error ?? '', /撤销/);
  assert.equal(b.host.ledger.listMachines().filter((each) => each.ephemeral).length, 1, '失败的兑换不登记任何东西');
});

test('并发兑换同一份材料：只成一台，其余被拒，材料和登记在一个事务里', options, async (t) => {
  const b = await bench(t, {}, {}, { anyMachine: true, hold: true });
  const { materials: [material] } = issued(b, { maxMachines: 1 });
  const answers = await Promise.all(
    Array.from({ length: 6 }, (_, n) => joinWith(b.base, { material: material!, secret: String(n).repeat(64) }, facts(`${n}`.repeat(16), `racer-${n}`))),
  );
  assert.equal(answers.filter(({ status }) => status === 200).length, 1, '六台机器抢一份材料，只有一台成');
  assert.equal(answers.filter(({ status }) => status === 400).length, 5);
  assert.equal(b.host.ledger.listMachines().filter((each) => each.ephemeral).length, 1);
});

test('上限在兑换时把关：两轮各发了材料，名额两台，第三份材料被拒', options, async (t) => {
  const b = await bench(t, {}, {}, { anyMachine: true, hold: true });
  const { materials: first, taskId, round } = issued(b, { maxMachines: 2 });
  // A later round is handed materials too, while the first round's are still good: an
  // instance it made may still be booting.
  const second = b.host.ledger.handInvite(taskId, round('第二轮'), 15 * MINUTE_MS)!;
  assert.equal(second.length, 2);
  const one = await joinWith(b.base, { material: first[0]!, secret: '1'.repeat(64) }, facts('1'.repeat(16), 'pair-a'));
  const two = await joinWith(b.base, { material: second[0]!, secret: '2'.repeat(64) }, facts('2'.repeat(16), 'pair-b'));
  const three = await joinWith(b.base, { material: first[1]!, secret: '3'.repeat(64) }, facts('3'.repeat(16), 'pair-c'));
  assert.deepEqual([one.status, two.status, three.status], [200, 200, 400]);
  assert.match(three.answer.error ?? '', /用完/);
});

test('invite_machine：项目没开就拒绝、超上限拒绝、用不上的执行器和账号拒绝，开着就申请', options, async (t) => {
  // The bench's account keeps its work on the bench machine: a spawned one is in no list.
  const b = await bench(t, {}, {}, { hold: true });
  const call = (args: Record<string, unknown>) => b.host.tools.call('invite_machine', args, USER, { projectId: b.host.ledger.getTask(b.taskId).project_id! });

  const closed = await call({ task_id: b.taskId });
  assert.equal(closed.isError, true);
  assert.match(closed.content[0]!.text, /允许派生机器/, '项目的开关关着：拒绝，并说明是哪个开关');
  assert.equal(b.host.ledger.listInvites().length, 0, '拒绝的申请什么都不写');

  b.host.ledger.setProjectSpawnMachines(b.projectId, true, USER);
  // A project that allows only a machine's own login: that login stays on its machine, and a
  // spawned machine is a new one nobody's login is on.
  b.host.ledger.putMachineLogin({ executor: b.account.executor, machine: b.machine.id, tiers: b.account.tiers }, USER);
  b.host.ledger.setProjectLogins(b.projectId, [b.host.ledger.getMachineLogin(b.machine.id, b.account.executor)!.id], USER);
  const nobody = await call({ task_id: b.taskId });
  assert.equal(nobody.isError, true, '项目只允许机器自己的登录：派生的机器谁也用不上');
  assert.match(nobody.content[0]!.text, /没有能用派生机器的账号/);
  b.host.ledger.setProjectLogins(b.projectId, ['t1'], USER);

  const tooMany = await call({ task_id: b.taskId, max_machines: 999 });
  assert.equal(tooMany.isError, true);
  assert.match(tooMany.content[0]!.text, /最多登记 3 台/, '上限来自设置');
  const tooLong = await call({ task_id: b.taskId, valid_for_minutes: 60 * 24 * 365 });
  assert.equal(tooLong.isError, true);
  const wrongExecutor = await call({ task_id: b.taskId, executors: ['nobody-has-this'] });
  assert.equal(wrongExecutor.isError, true, '名额只能写项目里账号真有的执行器');

  // What a material lasts is the setting's, said as it is now.
  b.host.settings.set('node.materialTtlMs', 7 * MINUTE_MS, USER);
  const ok = await call({ task_id: b.taskId, executors: [b.account.executor], max_machines: 2, valid_for_minutes: 30 });
  assert.equal(ok.isError, undefined, ok.content[0]!.text);
  assert.match(ok.content[0]!.text, /7 分钟/, '材料的有效期按设置的实际值说');
  assert.doesNotMatch(ok.content[0]!.text, /15 分钟/);
  const description = b.host.tools.list({ projectId: b.host.ledger.getTask(b.taskId).project_id! }).find(({ name }) => name === 'invite_machine')!.description;
  assert.doesNotMatch(description, /15 分钟/, '工具说明里不写死有效期');
  // A spawned machine joins where the round's own machine reaches this host: no public
  // address is asked for (runner/conventions.ts).
  assert.doesNotMatch(ok.content[0]!.text, /对外地址/);
  const invites = b.host.ledger.listInvites();
  assert.equal(invites.length, 1);
  assert.equal(invites[0]!.task_id, b.taskId);
  assert.equal(invites[0]!.max_machines, 2);
  assert.deepEqual(JSON.parse(invites[0]!.executors_json!), [b.account.executor]);
  assert.equal(invites[0]!.last_handed_at, null, '申请名额不等于发材料：材料在一轮启动时才交给执行者');
  assert.match(ok.content[0]!.text, new RegExp(JOIN_MATERIALS_ENV), '回答里说清执行者在哪个环境变量里拿到材料');
  assert.match(ok.content[0]!.text, /t1/, '回答里说清哪些账号能用派生的机器');

  const second = await call({ task_id: b.taskId });
  assert.equal(second.isError, true, '一个任务同一时间只有一条打开的名额');
  assert.match(second.content[0]!.text, /已经有/);
  // The setting is the ceiling, read at each call.
  b.host.settings.set('node.inviteMaxMachines', 1, USER);
  b.host.ledger.revokeInvite(invites[0]!.id, USER);
  assert.equal((await call({ task_id: b.taskId, max_machines: 2 })).isError, true);
  // With a public address there is nothing to fill in first.
  b.host.settings.set('http.publicUrl', 'https://tycho.example.test', USER);
  const addressed = await call({ task_id: b.taskId });
  assert.equal(addressed.isError, undefined, addressed.content[0]!.text);
  assert.doesNotMatch(addressed.content[0]!.text, /对外地址/);
});

test('材料只到 Worker 手里：日志、账本（含 change）、机器上这一轮的目录里都没有它', options, async (t) => {
  const envFile = join(mkdtempSync(join(tmpdir(), 'tycho-env-')), 'env.json');
  t.after(() => rmSync(join(envFile, '..'), { recursive: true, force: true }));
  const said: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { said.push(args.map(String).join(' ')); };
  t.after(() => { console.error = original; });

  const b = await bench(t, { envFile }, {}, { anyMachine: true, spawn: true, hold: true });
  const invited = await b.host.tools.call('invite_machine', { task_id: b.taskId, executors: [b.account.executor] }, USER, { projectId: b.host.ledger.getTask(b.taskId).project_id! });
  assert.equal(invited.isError, undefined, invited.content[0]!.text);
  b.host.ledger.queueTask(b.taskId, USER);

  // The Worker of the task's round has the materials in its environment, and nowhere else.
  const env = await until(() => (existsSync(envFile) ? (JSON.parse(readFileSync(envFile, 'utf8')) as Record<string, string>) : undefined), 'Worker 起来并写下它的环境');
  const materials = (env[JOIN_MATERIALS_ENV] ?? '').split(' ');
  assert.equal(materials.length, 1, '名额一台：一份材料');
  const [material] = materials;
  assert.match(material!, /^[0-9a-f]{64}$/);
  assert.equal(env[HOST_URL_ENV], b.base, '新机器连到哪里：机器的客户端连主机的那个地址');
  const run = await until(() => b.host.ledger.listRuns(b.taskId).at(-1), '这一轮');
  await until(() => b.host.ledger.getRun(run.id).state === 'ended', '这一轮结束', 60_000);
  const invite = b.host.ledger.listInvites()[0]!;
  assert.equal(invite.last_run_id, run.id, '名额记下材料给了哪一轮');

  const box = boxOf(b.nodeDir, `.tycho/tasks/${b.taskId}/runs/${run.id}`);
  for (const file of filesUnder(box.runDir)) {
    if (file === envFile) continue;
    assert.equal(readFileSync(file, 'utf8').includes(material!), false, `材料出现在机器上的 ${file}`);
  }
  const ledger = ledgerText(join(b.hostDataDir, 'ledger.db'));
  assert.equal(ledger.includes(material!), false, '材料出现在账本的某张表里');
  assert.equal(ledger.includes(hashOf(material!)), true, '账本里只有材料的哈希');
  assert.equal(said.join('\n').includes(material!), false, '材料出现在主机的日志里');
  // And the material redeems: the Worker's hands were the right ones.
  const joined = await joinWith(b.base, { material: material!, secret: 'e'.repeat(64) }, facts('ee'.repeat(8), 'spawned'));
  assert.equal(joined.status, 200, joined.answer.error ?? '');
  assert.deepEqual(b.host.ledger.getMachine('spawned')!.source, { task_id: b.taskId, run_id: run.id, round: 1 }, '来源写的是拿到材料的那一轮');
});

test('一轮的启动只说这一轮有名额：材料和主机地址不在启动命令里，由机器取凭据时一起取', async (t) => {
  const f = fixture(t);
  const account = { ...LOGIN.login };
  const accounts = memoryLogins({ [account.id]: account }, f.ledger);
  const remote = fakeRemote();
  const runner = createRunner({ ...RUNNER_TUNED,
    ledger: f.ledger, adapters: { claude: claudeAdapter }, logins: accounts,
    machines: memoryMachines({ [MACHINE.id]: MACHINE }, f.ledger), connect: remote.connect,
    invite: { open: () => true },
  });
  const task = f.ledger.createTask({ projectId: f.projectId, title: 'spawn', goal: 'g', acceptance: '测试通过', roleId: 'implement' }, USER);
  f.ledger.queueTask(task.id, USER);
  const snapshot = prepareSnapshot(task, account, { claude: claudeAdapter }, { timeoutMs: RUN_LIMIT_MS });
  const run = f.ledger.createRun(task.id, { login: account, machine: f.ledger.getMachine('h1')!, snapshot, expectedRevision: task.revision }, USER);
  await runner.launch(run);
  const start = remote.calls.find((call) => call.script === 'start.sh')!;
  assert.ok(start.args!.includes('--invite'), '启动命令只说有名额');
  assert.equal(start.args!.some((arg) => arg.startsWith(`${HOST_URL_ENV}=`) || arg.startsWith(`${JOIN_MATERIALS_ENV}=`)), false, '地址和材料由机器自己取、自己放进 Worker 的环境');
});

test('权限交集：临时机器只接它名额项目、允许执行器、登录能到、它自己说装了的活', options, async (t) => {
  const b = await bench(t, {}, {}, { anyMachine: true, hold: true });
  const { materials: [material], taskId, round } = issued(b, { maxMachines: 1 });
  const otherProject = b.host.ledger.createProject({ name: '别的项目', logins: ['t1'] }, USER);
  const joined = await joinWith(b.base, { material: material!, secret: '9'.repeat(64) }, facts('9'.repeat(16), 'scoped'));
  assert.equal(joined.status, 200);
  const store = { get: (id: string) => b.host.ledger.getMachine(id), list: () => b.host.ledger.listMachines() };
  const stub: Account = { id: 'x', name: 'x', executor: b.account.executor, tiers: {} };
  const offered = (login: Pick<Login, 'executor' | 'machine'>, project: string, allowed: string[] = []): boolean =>
    eligibleMachines(login, allowed, store, project).some((each) => each.id === 'scoped');

  assert.equal(offered(stub, b.projectId), true, '名额的项目、任何执行器、账号不限机器：在范围里');
  assert.equal(offered(stub, otherProject), false, '别的项目拿不到它');
  assert.equal(offered({ ...stub, machine: b.machine.id }, b.projectId), false, '别的机器自己的登录：不在');
  assert.equal(offered({ ...stub, machine: 'scoped' }, b.projectId), true, '它自己的登录：在');
  assert.equal(offered(stub, b.projectId, [b.machine.id]), true, '项目点了名的机器之外，它派生的机器也算它的');
  assert.equal(offered(stub, otherProject, ['scoped']), false, '别的项目把它点名也不行：名额只属于一个项目');

  // A quota that names the executors: a machine spawned under it serves those and no other.
  b.host.ledger.revokeInvite(b.host.ledger.listInvites()[0]!.id, USER);
  b.host.ledger.createInvite({ taskId, executors: [b.account.executor], ttlMs: MINUTE_MS, maxMachines: 1 }, USER);
  const [narrowMaterial] = b.host.ledger.handInvite(taskId, round('第二轮'), MINUTE_MS)!;
  assert.equal((await joinWith(b.base, { material: narrowMaterial!, secret: '8'.repeat(64) }, facts('8'.repeat(16), 'narrow'))).status, 200);
  assert.deepEqual(b.host.ledger.getMachine('narrow')!.scope?.executors, [b.account.executor]);
  assert.equal(eligibleMachines(stub, [], store, b.projectId).some((each) => each.id === 'narrow'), true);
  assert.equal(eligibleMachines({ ...stub, executor: 'other' }, [], store, b.projectId).some((each) => each.id === 'narrow'), false, '名额没写的执行器用不了它');
  // And a machine whose registration ended is nobody's to dispatch to.
  b.host.ledger.leaveMachine('narrow', 'leave', USER);
  assert.equal(eligibleMachines(stub, [], store, b.projectId).some((each) => each.id === 'narrow'), false);
});

test('权限交集的第四样：临时机器自己说没装这个执行器，就不派给它；说装了才派', options, async (t) => {
  const b = await bench(t, {}, {}, { anyMachine: true, hold: true });
  // What the machine says rides its next poll: the shortest hold, so the wait is on that.
  b.host.settings.set('node.pollHoldMs', 5000, USER);
  const { materials: [material] } = issued(b, { maxMachines: 1 });
  const dir = mkdtempSync(join(tmpdir(), 'tycho-eph-'));
  const who = factsOf(identityOf(dir), 'probing');
  const joined = await joinWith(b.base, { material: material!, secret: '4'.repeat(64) }, who);
  assert.equal(joined.status, 200, joined.answer.error ?? '');
  // What this machine says about its executors is the test's: first "not installed".
  let installed = false;
  const client = createClient({
    dataDir: dir, origin: b.base, token: tokenOf(joined.answer), facts: who, log: () => {},
    executors: {
      questions: [{ executor: b.account.executor, command: 'stub-cli', version: ['--version'], login: ['login', 'status'] }],
      run: async () => (installed ? { stdout: 'stub 1.0\n', stderr: '', code: 0 } : { stdout: '', stderr: '', code: null, failure: '这台机器上没有 stub-cli' }),
    },
  });
  const stop = new AbortController();
  const polling = client.run(stop.signal).catch(() => {});
  t.after(async () => {
    stop.abort();
    await polling;
    rmSync(dir, { recursive: true, force: true });
  });
  await until(() => b.host.nodes.reportedExecutors('probing')?.executors.some((each) => each.executor === b.account.executor && !each.installed), '它报上来没装 stub');
  // The only other machine goes, so the task can go nowhere but here.
  b.host.ledger.deleteMachine(b.machine.id, USER);
  b.host.ledger.queueTask(b.taskId, USER);
  const console_ = await signIn(b.host);
  await until(async () => {
    const task = (await (await console_.get(`/api/tasks/${b.taskId}`)).json()) as { task?: { waiting?: { no_machine?: string[] } } };
    return task.task?.waiting?.no_machine?.includes('t1');
  }, '任务在等可用的机器');
  assert.equal(b.host.ledger.listRuns(b.taskId).length, 0, '没派给说自己没装的机器');

  installed = true;
  await client.look();
  const run = await until(() => b.host.ledger.listRuns(b.taskId).at(-1), '说装了之后派过来了');
  assert.equal(run.machine_id, 'probing');
  await until(() => b.host.ledger.getRun(run.id).state === 'ended', '这一轮结束，机器释放目录');
});

type Shown = {
  machines: { id: string; node: { ephemeral: boolean; ends: MachineEnds | null } | null }[];
  invites: { id: string; material: MachineEnds['material'] }[];
};

test('结束事实分开记、分开显示；没报告销毁就不说已释放；撤销后下一次 poll 是 401；销毁由回执报告', options, async (t) => {
  const b = await bench(t, { receipt: { destroyed_machines: ['ending', 'not-a-machine', 'node-test'] } }, {}, { anyMachine: true, hold: true });
  const console_ = await signIn(b.host);
  const { invite, materials: [material] } = issued(b);
  const who = facts('7'.repeat(16), 'ending');
  const joined = await joinWith(b.base, { material: material!, secret: '7'.repeat(64) }, who);
  assert.equal(joined.status, 200);
  const token = tokenOf(joined.answer);
  assert.equal((await poll(b.base, token, who)).status, 200);

  const shown = async (): Promise<Shown> => (await (await console_.get('/api/machines')).json()) as Shown;
  const ends = async (): Promise<MachineEnds> => (await shown()).machines.find((each) => each.id === 'ending')!.node!.ends!;
  const line = (now: MachineEnds, key: string) => machineEndLines(now).find((each) => each.key === key)!;

  // 1. The material lapsed: used up, said on the quota and on the machine that came in.
  const page = await shown();
  assert.equal(page.invites.find((each) => each.id === invite.id)?.material.ended_why, 'used', '材料用完了，这是名额的事实');
  let now = await ends();
  assert.equal(line(now, 'material').done, true);
  assert.deepEqual([now.drain_at, now.evidence_at, now.left_at, now.destroyed_at], [null, null, null, null], '机器自己还一件都没结束');

  // 2. Revoked by the owner: the token dies at once and it stops taking work at that moment;
  // the row stays with its facts — what the list no longer connects to is not an instance
  // anybody released.
  assert.equal((await console_.del('/api/machines/ending')).status, 200);
  assert.equal((await poll(b.base, token, who)).status, 401, '撤销后下一次 poll 是 401');
  now = await ends();
  assert.ok(now.left_at && now.drain_at);
  assert.equal(now.left_reason, 'revoked');
  // 3. It ran nothing, so its evidence is all in — its own fact, written by the host after.
  const settled = await until(async () => { const held = await ends(); return held.evidence_at === null ? undefined : held; }, '证据确认');
  assert.ok(Date.parse(settled.evidence_at!) >= Date.parse(settled.left_at!));
  assert.equal(settled.destroyed_at, null, '没人报告销毁，就不能显示成已释放');
  assert.equal(line(settled, 'destroyed').text, '实例销毁未确认');
  assert.equal(line(settled, 'destroyed').done, false);
  assert.deepEqual(machineEndLines(settled).map(({ key }) => key), ['material', 'drain', 'evidence', 'left', 'destroyed'], '每件事一行');

  // 4. The skill that made the instance reports its destruction, in the receipt of a round
  // of the project: that is the only way this fact is written. The machine the owner let
  // in, named in the same receipt, is not touched.
  b.host.ledger.queueTask(b.taskId, USER);
  const run = await until(() => b.host.ledger.listRuns(b.taskId).find((each) => each.state === 'ended'), '一轮跑完并结算', 60_000);
  now = await ends();
  assert.ok(now.destroyed_at, '销毁由回执报告');
  assert.equal(now.destroyed_by, run.id);
  assert.equal(line(now, 'destroyed').done, true);
  assert.equal(b.host.ledger.getMachine('node-test')!.destroyedAt, undefined, '回执点不了主人放进来的机器');
  // Removing it now is the owner forgetting a record: the row goes.
  assert.equal((await console_.del('/api/machines/ending')).status, 200);
  assert.equal((await shown()).machines.some((each) => each.id === 'ending'), false);
});

test('报告销毁、机器空闲：主机排空它、确认证据并结束登记，不必等它自己说', options, async (t) => {
  // The quota allows another executor, so the bench's own round never goes to it.
  const b = await bench(t, { receipt: { destroyed_machines: ['gone-one'] } }, {}, { anyMachine: true, hold: true });
  const { materials: [material] } = issued(b, { executors: ['other'] });
  const joined = await joinWith(b.base, { material: material!, secret: '3'.repeat(64) }, facts('3'.repeat(16), 'gone-one'));
  assert.equal(joined.status, 200, joined.answer.error ?? '');
  b.host.ledger.queueTask(b.taskId, USER);
  const machine = await until(() => { const held = b.host.ledger.getMachine('gone-one'); return held?.leftAt === undefined ? undefined : held; }, '登记结束', 60_000);
  assert.equal(machine.leftReason, 'destroyed');
  assert.ok(machine.destroyedAt && machine.drainAt && machine.evidenceAt, '四件事都记下了');
  assert.equal((await poll(b.base, tokenOf(joined.answer), facts('3'.repeat(16), 'gone-one'))).status, 401);
});

test('名额对应的任务结束、机器空闲：主机让它排空、确认证据，客户端自己 leave', options, async (t) => {
  const b = await bench(t, {}, {}, { anyMachine: true, hold: true });
  const { invite, materials: [material], taskId } = issued(b);
  // The spawned machine, as its client would be: an in-process client on its own data
  // directory, joined with the material instead of six digits.
  const dir = mkdtempSync(join(tmpdir(), 'tycho-eph-'));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const who = factsOf(identityOf(dir), 'spawned-one');
  const joined = await joinWith(b.base, { material: material!, secret: '6'.repeat(64) }, who);
  assert.equal(joined.status, 200, joined.answer.error ?? '');
  const token = tokenOf(joined.answer);
  const client = createClient({
    dataDir: dir, origin: b.base, token, facts: who, log: () => {},
    executors: { questions: [], run: async () => ({ stdout: '', stderr: '', code: 1 }) },
  });
  const stop = new AbortController();
  t.after(() => stop.abort());
  const loop = client.run(stop.signal);
  await until(() => b.host.nodes.connected('spawned-one'), '临时机器连回来');
  assert.equal(b.host.ledger.getMachine('spawned-one')!.drainAt, undefined, '任务还没结束：机器照常接活');

  // Its task ends.
  b.host.ledger.acceptTask(taskId, '看过了', USER, { withoutReview: true });
  // The host drains it, confirms its evidence (it ran nothing), tells it to go; the client
  // leaves by itself and its loop ends. Each fact its own, in order.
  await until(() => b.host.ledger.getMachine('spawned-one')?.leftAt, '客户端自己注销', 30_000);
  const ends = b.host.ledger.getMachine('spawned-one')!;
  assert.ok(ends.drainAt && ends.evidenceAt && ends.leftAt);
  assert.equal(ends.leftReason, 'leave');
  assert.equal(ends.destroyedAt, undefined, '实例销毁要由技能报告，注销不是销毁');
  assert.ok(Date.parse(ends.drainAt) <= Date.parse(ends.evidenceAt) && Date.parse(ends.evidenceAt) <= Date.parse(ends.leftAt));
  await loop;
  assert.equal(client.retired(), true, '客户端知道自己是被主机请走的');
  assert.equal((await poll(b.base, token, who)).status, 401, '注销后令牌作废');
  assert.equal(b.host.ledger.getInvite(invite.id)!.used, 1);
});

test('项目关掉“允许派生机器”：发出去的材料也兑换不了，下一轮也不再发', options, async (t) => {
  const b = await bench(t, {}, {}, { anyMachine: true, hold: true });
  const { materials: [material], taskId, round } = issued(b, { maxMachines: 2 });
  b.host.ledger.setProjectSpawnMachines(b.projectId, false, USER);
  const refused = await joinWith(b.base, { material: material!, secret: '2'.repeat(64) }, facts('2'.repeat(16), 'late'));
  assert.equal(refused.status, 400);
  assert.match(refused.answer.error ?? '', /允许派生机器/);
  assert.equal(b.host.ledger.handInvite(taskId, round('第二轮'), MINUTE_MS), undefined);
});

test('控制台：项目页的开关读写“允许派生机器”，机器页能撤销名额', options, async (t) => {
  const b = await bench(t, {}, {}, { anyMachine: true, hold: true });
  const console_ = await signIn(b.host);
  const put = (body: unknown): Promise<Response> => fetch(`${console_.base}/api/projects/${b.projectId}`, {
    method: 'PUT', headers: { Cookie: console_.cookie, Origin: console_.base, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  type Projects = { projects: { id: string; spawn_machines: boolean }[] };
  const shownSwitch = async (): Promise<boolean | undefined> =>
    ((await (await console_.get('/api/projects')).json()) as Projects).projects.find((each) => each.id === b.projectId)?.spawn_machines;
  assert.equal(await shownSwitch(), false, '默认关着');
  assert.equal((await put({ logins: ['t1'], spawn_machines: 'yes' })).status, 400, '只认开或关');
  assert.equal((await put({ logins: ['t1'], spawn_machines: true })).status, 200);
  assert.equal(await shownSwitch(), true);
  assert.equal(b.host.ledger.getProject(b.projectId).spawn_machines, 1);

  const invite = b.host.ledger.createInvite({ taskId: b.taskId, executors: null, ttlMs: 60 * MINUTE_MS, maxMachines: 1 }, USER);
  assert.equal((await console_.del(`/api/invites/${invite.id}`)).status, 200);
  assert.ok(b.host.ledger.getInvite(invite.id)!.revoked_at, '撤销记下了');
  type Page = { invites: { id: string; revoked_at: string | null; material: MachineEnds['material'] }[] };
  const shown = ((await (await console_.get('/api/machines')).json()) as Page).invites.find((each) => each.id === invite.id)!;
  assert.ok(shown.revoked_at);
  assert.equal(shown.material.live, 0);
  assert.equal(b.host.ledger.openInvite(b.taskId), undefined, '撤销之后这个任务没有打开的名额');
});

test('一轮只签发一次：同一轮再取凭据，拿回的是它已经拿到、还有效的那一批，不再签新的', options, async (t) => {
  const b = await bench(t, {}, {}, { anyMachine: true, hold: true });
  // This test creates a launching Run directly; no Worker is actually being started.
  // The watcher must not judge that artificial Run while the credential requests use it.
  t.mock.method(b.host.runner, 'watch', async () => {});
  b.host.ledger.setProjectSpawnMachines(b.projectId, true, USER);
  const { taskId } = creator(b);
  const invite = b.host.ledger.createInvite({ taskId, executors: null, ttlMs: 60 * MINUTE_MS, maxMachines: 2 }, USER);
  const runId = launching(b, taskId);
  // As the machine's client asks, and asks again when the first answer was lost on the way.
  const ask = async (): Promise<{ status: number; materials: string[] | null }> => {
    const response = await fetch(`${b.base}/api/node/runs/${runId}/credential`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${b.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ protocol: NODE_PROTOCOL }),
    });
    const answer = (await response.json()) as { materials?: string[] | null };
    return { status: response.status, materials: answer.materials ?? null };
  };
  const first = await ask();
  assert.equal(first.status, 200);
  assert.equal(first.materials?.length, 2, '名额两台：两份');
  const again = await ask();
  assert.equal(again.status, 200);
  assert.deepEqual(again.materials, first.materials, '再取一次拿回同一批');
  assert.equal(b.host.ledger.getInvite(invite.id)!.live, 2, '没有多签发');
  assert.equal(changeActions(b.hostDataDir).filter((action) => action === 'machine.invite_handed').length, 1, '交材料只记一次');
  // One of them used: asking again hands back only the one still good.
  const joined = await joinWith(b.base, { material: first.materials![0]!, secret: 'a'.repeat(64) }, facts('a1'.repeat(8), 'once-a'));
  assert.equal(joined.status, 200, joined.answer.error ?? '');
  assert.deepEqual((await ask()).materials, [first.materials![1]], '用掉的那份不再交出去');
  assert.equal(b.host.ledger.handInvite(taskId, runId, MINUTE_MS), undefined, '账本对已经拿过材料的一轮不再签发');
  assert.equal(b.host.ledger.getInvite(invite.id)!.live, 1);
});

test('第 1 版协议的客户端被拒绝并记在那台机器上：凭据回答的新形状和 retire 是第 2 版才有的', options, async (t) => {
  const b = await bench(t, {}, {}, { hold: true });
  // The bench's own client speaks the current version and would clear the record.
  b.stopClients();
  // The client of version 1 is still refused by every later host.
  assert.ok(NODE_PROTOCOL > 1);
  const answer = await fetch(`${b.base}/api/node/status`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${b.token}` },
    body: JSON.stringify({ protocol: 1 }),
  });
  assert.equal(answer.status, 426);
  assert.match(((await answer.json()) as { error: string }).error, /第 1 版/);
  assert.equal(b.host.nodes.refusesProtocol(b.machine.id), true, '版本不符记在这台机器上');
});

test('临时机器上有一轮按失联结束：“结果和日志”说清结果没交回，不像还在等', options, async (t) => {
  const b = await bench(t, {}, {}, { anyMachine: true, hold: true });
  const console_ = await signIn(b.host);
  const { materials: [material], taskId } = issued(b);
  const joined = await joinWith(b.base, { material: material!, secret: '5'.repeat(64) }, facts('5'.repeat(16), 'lost-one'));
  assert.equal(joined.status, 200, joined.answer.error ?? '');
  // A round of the task on it, judged gone; then the task given up, so nothing comes after.
  const runId = launching(b, taskId, 'lost-one');
  b.host.ledger.settleRun(runId, null, null, { kind: 'lost', lost: { basis: 'presumed' } });
  b.host.ledger.abandonTask(taskId, '不要了', USER);
  const ends = await until(async () => {
    const page = (await (await console_.get('/api/machines')).json()) as Shown;
    const held = page.machines.find((each) => each.id === 'lost-one')?.node?.ends;
    return held?.drain_at ? held : undefined;
  }, '机器排空');
  assert.equal(ends.lost_rounds, 1);
  assert.equal(ends.evidence_at, null, '失联的一轮的结果交不回来：证据不会确认');
  const line = machineEndLines(ends).find(({ key }) => key === 'evidence')!;
  assert.equal(line.text, '有一轮按失联结束，结果没交回');
});
