// Guards the host's side of a sign-in made on a machine (service/sign-ins.ts,
// docs/design/native-login.md), against a node channel this test stands in for.
//
// What this file is here to catch:
//   - a sign-in sent to a machine that is not there, to an executor tycho cannot sign in to, to
//     one the machine has not reported installed (or reported too old), or to a login that rounds
//     are running as (ruling F: a login is not changed under its rounds),
//   - a second sign-in of the same executor on the same machine running beside the first,
//   - state taken from a poll of another machine, or for a sign-in this host never started,
//   - a cancel and a finished authorisation crossing, and "cancelled" winning over "done",
//   - a machine that never answers leaving the session "waiting" forever, or still named in its
//     poll answers so that its process lives on,
//   - a command that could not be handed over left "starting",
//   - new work given to a machine's own login while it is being signed in, or held back after,
//   - a sign-in outliving an upgrade's drain or the service,
//   - the one-time code written to the service log.
import './guard.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { ADAPTERS } from '../adapters/all.ts';
import type { Login, Machine } from '../runner/snapshot.ts';
import { createDispatcher } from '../service/dispatcher.ts';
import type { RunRow } from '../service/ledger.ts';
import { NodeAway } from '../service/nodes.ts';
import { asSignIns } from '../service/nodes.ts';
import { createSignIns } from '../service/sign-ins.ts';
import type { NodeExecutorReport, NodeExecutorStatus, NodeSignIn } from '../shared/node-protocol.ts';
import { SIGN_IN_REASON_TEXT } from '../shared/sign-in.ts';
import { content, DISPATCH_TUNED, DONE, fixture, machineLogin, memoryLogins, memoryMachines, tuned, USER } from './helpers.ts';

const MACHINES: Record<string, Machine> = {
  m1: { id: 'm1', host: 'm1', nodeId: 'a1a1a1a1a1a1a1a1' },
  m2: { id: 'm2', host: 'm2', nodeId: 'b2b2b2b2b2b2b2b2' },
};
const M1_CODEX = machineLogin('m1', 'codex', { tiers: { execute: content('model=x\n'), decide: content('model=y\n') } });
const URL = 'https://auth.openai.com/codex/device';
const CODE = 'ABCD-12345';

const codex = (extra: Partial<NodeExecutorStatus> = {}): NodeExecutorStatus => ({ executor: 'codex', installed: true, version: 'codex-cli 0.162.0', logged_in: true, ...extra });

function setUp(t: TestContext, logins: Login[] = [M1_CODEX]) {
  const f = fixture(t);
  const machines = memoryMachines(MACHINES, f.ledger);
  const store = memoryLogins(Object.fromEntries(logins.map((login) => [login.id, login])), f.ledger);
  f.ledger.setProjectLogins(f.projectId, logins.map(({ id }) => id), USER);
  const online = new Set(['m1', 'm2']);
  const reports: Record<string, NodeExecutorReport> = {
    m1: { at: '2026-11-11T00:00:00.000Z', executors: [codex()] },
    m2: { at: '2026-11-11T00:00:00.000Z', executors: [codex()] },
  };
  const sent: { machine: string; command: Record<string, unknown> }[] = [];
  // What the machine answers a command with: by default it starts and says so.
  let answer: (machine: string, command: Record<string, unknown>) => Promise<unknown> = async (_machine, command) =>
    command.kind === 'sign_in' ? { id: command.sign_in_id, executor: command.executor, state: 'starting' } : { sign_in_id: command.sign_in_id, known: true };
  let clock = Date.parse('2026-11-11T10:00:00.000Z');
  const lines: string[] = [];
  const signIns = createSignIns({
    ledger: f.ledger,
    nodes: {
      connected: (id) => online.has(id),
      reportedExecutors: (id) => reports[id] ?? null,
      send: ((machine: string, command: Record<string, unknown>) => {
        sent.push({ machine, command });
        if (!online.has(machine)) return Promise.reject(new NodeAway(`机器 ${machine} 没有连回来`));
        return answer(machine, command);
      }) as never,
    },
    executors: ADAPTERS,
    limitMs: () => 15 * 60_000,
    graceMs: () => 10_000,
    now: () => clock,
    log: (line) => lines.push(line),
    sweepMs: 3_600_000,
  });
  t.after(() => signIns.close());
  const launched: RunRow[] = [];
  const dispatcher = createDispatcher({ ...DISPATCH_TUNED,
    runTimeoutMs: tuned('run.timeoutMs'),
    ledger: f.ledger,
    runner: {
      findMachine: async (_login, offered) => offered[0], lostCandidates: () => [], presume: async () => 'unknown', sweep: async () => {},
      launch: async (run) => { launched.push(run); }, watch: async () => {},
    },
    logins: store, machines, executors: ADAPTERS,
    reported: (machineId, executor) => reports[machineId]?.executors.find((each) => each.executor === executor) ?? null,
    signingIn: signIns.busy,
    log: () => {},
  });
  t.after(() => dispatcher.stop());
  const queued = (): string => {
    const task = f.ledger.createTask({ roleId: 'implement', projectId: f.projectId, title: '活', goal: '做', acceptance: '交' }, USER);
    f.ledger.queueTask(task.id, USER);
    return task.id;
  };
  const poll = (machine: string, entries: NodeSignIn[]): void => signIns.reported(machine, entries);
  return {
    f, signIns, online, reports, sent, lines, launched, dispatcher, queued, poll,
    answer: (fn: typeof answer) => { answer = fn; },
    advance: (ms: number) => { clock += ms; },
    flush: () => new Promise((resolve) => setImmediate(resolve)),
  };
}

// The owner removed this login in this registration, so the host will not adopt it back from
// the machine's reports; a sign-in made here is the owner's answer, and finishing it is what
// lets the next report adopt it again (docs/design/accounts-machines-decoupled.md).
test('在这台机器上登录完成：主人此前删掉它的拒用记录清掉', async (t) => {
  const s = setUp(t);
  s.f.ledger.deleteMachineLogin('m1', 'codex', USER);
  assert.equal(s.f.peek('SELECT * FROM machine_login_refusal').length, 1);
  const started = s.signIns.start('m1', 'codex');
  s.poll('m1', [{ id: started.id, executor: 'codex', state: 'done' }]);
  assert.deepEqual(s.f.peek('SELECT * FROM machine_login_refusal'), [], '登录完成就是主人收回删掉的意思');
});

test('重复的完成报告不撤销之后的拒用', (t) => {
  const s = setUp(t);
  const started = s.signIns.start('m1', 'codex');
  s.poll('m1', [{ id: started.id, executor: 'codex', state: 'done' }]);
  s.f.ledger.deleteMachineLogin('m1', 'codex', USER);
  const before = s.f.peek('SELECT * FROM machine_login_refusal');
  assert.equal(before.length, 1);
  s.poll('m1', [{ id: started.id, executor: 'codex', state: 'done' }]);
  assert.deepEqual(s.f.peek('SELECT * FROM machine_login_refusal'), before);
});

test('拒绝：机器不在、执行器不能从这里登录、机器没报告装了它（unusable 仅作参考不阻断）', async (t) => {  const s = setUp(t);
  assert.throws(() => s.signIns.start('m1', 'codex', 'old-registration'), /登记已经改变/);
  s.online.delete('m2');
  assert.throws(() => s.signIns.start('m2', 'codex'), /机器 m2 现在不在线，登录要在它在线时发起/);
  assert.throws(() => s.signIns.start('nowhere', 'codex'), /机器 nowhere 现在不在线/);
  assert.throws(() => s.signIns.start('m1', 'claude'), /claude 不能从这里登录/);
  assert.throws(() => s.signIns.start('m1', 'toString'), /toString 不能从这里登录/);
  s.reports.m1 = { at: 'x', executors: [codex({ installed: false, version: null, logged_in: null, error: '找不到 codex：查过 PATH' })] };
  assert.throws(() => s.signIns.start('m1', 'codex'), /机器 m1 没有报告装了 codex：找不到 codex：查过 PATH/);
  s.reports.m1 = { at: 'x', executors: [] };
  assert.throws(() => s.signIns.start('m1', 'codex'), /机器 m1 没有报告装了 codex/);
  assert.equal(s.sent.length, 0, '前面被拒的一条命令都没发');
  s.reports.m1 = { at: 'x', executors: [codex({ unusable: '最低要 0.160.0' })] };
  assert.equal(s.signIns.start('m1', 'codex').state, 'starting', 'unusable 仅作参考，不阻断登录');
});

test('这份登录上还有轮次在跑：拒绝并说清是哪个任务；结束后就能登录', async (t) => {
  const s = setUp(t);
  const task = s.queued();
  await s.dispatcher.tick();
  assert.equal(s.launched.length, 1);
  assert.throws(() => s.signIns.start('m1', 'codex'), new RegExp(`这份登录上还有 1 轮在跑（任务 ${task}），等它们结束再登录`));
  s.f.ledger.markRunRunning(s.launched[0]!.id);
  s.f.ledger.settleRun(s.launched[0]!.id, 0, DONE);
  assert.equal(s.signIns.start('m1', 'codex').state, 'starting');
});

test('发起：带上时限发 sign_in，poll 的上报推进状态；同一台机器同一个执行器只留一次', async (t) => {
  const s = setUp(t);
  const first = s.signIns.start('m1', 'codex');
  assert.deepEqual(first, { id: first.id, machine: 'm1', executor: 'codex', state: 'starting', url: null, code: null, reason: null, signed_in: true });
  assert.deepEqual(s.sent[0], { machine: 'm1', command: { kind: 'sign_in', sign_in_id: first.id, executor: 'codex', timeout_ms: 15 * 60_000 } });
  assert.deepEqual(s.signIns.listFor('m1'), [first.id]);
  assert.equal(s.signIns.hurried('m1'), true, '这台机器的 poll 要快');
  assert.equal(s.signIns.hurried('m2'), false);
  s.poll('m1', [{ id: first.id, executor: 'codex', state: 'waiting', url: URL, code: CODE }]);
  assert.deepEqual(s.signIns.get(first.id), { ...first, state: 'waiting', url: URL, code: CODE });

  const second = s.signIns.start('m1', 'codex');
  assert.equal(s.signIns.get(first.id)?.state, 'cancelled', '旧的先取消');
  assert.deepEqual(s.sent.map(({ command }) => command.kind), ['sign_in', 'sign_in_cancel', 'sign_in']);
  s.poll('m1', [{ id: first.id, executor: 'codex', state: 'cancelled' }, { id: second.id, executor: 'codex', state: 'starting' }]);
  assert.deepEqual(s.signIns.listFor('m1'), [second.id], '机器报了结束的，就不再列给它');

  s.reports.m1 = { at: 'y', executors: [codex({ logged_in: true })] };
  s.poll('m1', [{ id: second.id, executor: 'codex', state: 'done' }]);
  assert.deepEqual(s.signIns.get(second.id), { ...second, state: 'done', signed_in: true });
  assert.deepEqual(s.signIns.listFor('m1'), []);
  assert.equal(s.signIns.hurried('m1'), false, '登录结束，poll 回到平时的节奏');
  assert.equal(s.lines.join('\n').includes(CODE), false, '服务日志里没有用户码');
  assert.equal(s.lines.join('\n').includes(URL), false, '服务日志里没有网址');
});

test('失败的原因：机器报的几类和主机自己的几类，都是给人看的一句话', async (t) => {
  const s = setUp(t);
  const one = s.signIns.start('m1', 'codex');
  s.poll('m1', [{ id: one.id, executor: 'codex', state: 'failed', reason: 'timeout' }]);
  assert.equal(s.signIns.get(one.id)?.reason, SIGN_IN_REASON_TEXT.timeout);
  s.answer(async () => {
    throw new NodeAway('刚掉线');
  });
  const lost = s.signIns.start('m2', 'codex');
  await s.flush();
  assert.equal(s.signIns.get(lost.id)?.state, 'failed', '命令没送到就记失败');
  assert.equal(s.signIns.get(lost.id)?.reason, SIGN_IN_REASON_TEXT.not_delivered);
  assert.deepEqual(s.signIns.listFor('m2'), []);
});

test('别的机器报同一个编号不被采信，主机没开过的编号也不认', async (t) => {
  const s = setUp(t);
  const one = s.signIns.start('m1', 'codex');
  s.poll('m2', [{ id: one.id, executor: 'codex', state: 'done' }]);
  assert.equal(s.signIns.get(one.id)?.state, 'starting');
  s.poll('m1', [{ id: 'made-up', executor: 'codex', state: 'done' }]);
  assert.equal(s.signIns.get('made-up'), undefined);
});

test('取消后机器报 done：如实改成 done（取消和授权成功可能同时发生）', async (t) => {
  const s = setUp(t);
  const one = s.signIns.start('m1', 'codex');
  assert.equal(s.signIns.cancel(one.id)?.state, 'cancelled');
  assert.equal(s.sent.at(-1)?.command.kind, 'sign_in_cancel');
  assert.equal(s.signIns.busy('m1', 'codex'), true, '机器确认结束之前还算在登录');
  s.poll('m1', [{ id: one.id, executor: 'codex', state: 'done' }]);
  assert.equal(s.signIns.get(one.id)?.state, 'done');
  assert.equal(s.signIns.busy('m1', 'codex'), false);
  assert.equal(s.signIns.cancel('nobody'), undefined);
});

test('机器不回音：掉线超过宽限、或过了时限还没报终态，记失败，不再列给它', async (t) => {
  const s = setUp(t);
  const away = s.signIns.start('m1', 'codex');
  s.online.delete('m1');
  s.signIns.sweep();
  s.advance(5_000);
  s.signIns.sweep();
  assert.equal(s.signIns.get(away.id)?.state, 'starting', '宽限之内还等着');
  s.advance(6_000);
  s.signIns.sweep();
  assert.equal(s.signIns.get(away.id)?.state, 'failed');
  assert.equal(s.signIns.get(away.id)?.reason, SIGN_IN_REASON_TEXT.no_echo);
  assert.deepEqual(s.signIns.listFor('m1'), [], '机器回来后按“主机不列它”收场');

  const quiet = s.signIns.start('m2', 'codex');
  s.poll('m2', [{ id: quiet.id, executor: 'codex', state: 'waiting', url: URL, code: CODE }]);
  s.advance(15 * 60_000 + 9_000);
  s.signIns.sweep();
  assert.equal(s.signIns.get(quiet.id)?.state, 'waiting', '时限加清理等待之内还等着');
  s.advance(2_000);
  s.signIns.sweep();
  assert.equal(s.signIns.get(quiet.id)?.state, 'failed');
  // Ended ones stay a while for the page, then go.
  s.advance(11 * 60_000);
  s.signIns.sweep();
  assert.equal(s.signIns.get(quiet.id), undefined);
});

test('登录进行期间这份登录不接新活，任务等着不算失败；结束后恢复', async (t) => {
  const s = setUp(t);
  const one = s.signIns.start('m1', 'codex');
  const task = s.queued();
  await s.dispatcher.tick();
  assert.equal(s.launched.length, 0, '登录进行中不派');
  assert.equal(s.f.task(task).state, 'queued', '任务等着');
  assert.equal(s.f.ledger.loginState(M1_CODEX.id)?.auth_failed_at ?? null, null, '不记登录被拒');
  s.poll('m1', [{ id: one.id, executor: 'codex', state: 'done' }]);
  await s.dispatcher.tick();
  assert.equal(s.launched[0]?.task_id, task, '登录结束后照常派');
});

test('排空、停服、降级：取消全部没结束的登录', async (t) => {
  const s = setUp(t);
  const one = s.signIns.start('m1', 'codex');
  const two = s.signIns.start('m2', 'codex');
  s.poll('m2', [{ id: two.id, executor: 'codex', state: 'done' }]);
  s.signIns.stopAll();
  assert.equal(s.signIns.get(one.id)?.state, 'cancelled');
  assert.equal(s.signIns.get(one.id)?.reason, SIGN_IN_REASON_TEXT.stopped);
  assert.equal(s.signIns.get(two.id)?.state, 'done', '结束了的不动');
  assert.deepEqual(s.signIns.listFor('m1'), [], '不再列给机器：机器自己收场');
  assert.ok(s.sent.some(({ machine, command }) => machine === 'm1' && command.kind === 'sign_in_cancel'));
});

test('poll 里的登录状态：形状不对的条目丢掉并记一行，不拒整个 poll，不记条目内容', () => {
  const lines: string[] = [];
  const kept = asSignIns([
    { id: 's1', executor: 'codex', state: 'waiting', url: URL, code: CODE },
    { id: 's2', executor: 'codex', state: 'weird' },
    { id: 's3', executor: 'codex', state: 'waiting', url: 'javascript:alert(1)', code: 'SECRET-CODE1' },
    'nonsense',
    { id: 's4', executor: 'codex', state: 'failed', reason: 'exit' },
  ], (line) => lines.push(line));
  assert.deepEqual(kept.map(({ id }) => id), ['s1', 's4']);
  assert.equal(lines.length, 1);
  assert.equal(lines.join('').includes('SECRET-CODE1'), false);
  assert.deepEqual(asSignIns('x', () => {}), []);
});

test('gemini acp --login：minVersion 仅作参考不阻断；提交授权码转入 exchanging、挡住陈旧 waiting 轮询，完成后清掉 auth_failed_at', async (t) => {
  const m1Gemini = machineLogin('m1', 'gemini', { tiers: { decide: content('{"effort":"high"}\n'), execute: content('{"effort":"medium"}\n') } });
  const s = setUp(t, [m1Gemini]);
  // Version string is advisory only and does not gate sign-in; settle a failed auth round so `auth_failed_at` is set.
  s.reports.m1 = { at: '2026-11-18T00:01:00.000Z', executors: [{ executor: 'gemini', installed: true, version: 'agy 1.5.10', logged_in: null }] };
  s.queued();
  await s.dispatcher.tick();
  assert.equal(s.launched.length, 1);
  s.f.ledger.markRunRunning(s.launched[0]!.id);
  s.f.ledger.settleRun(
    s.launched[0]!.id,
    1,
    { finished: false, error: { kind: 'auth', message: '401 not logged in' } },
    { kind: 'auth' },
  );
  assert.ok(s.f.ledger.loginState(m1Gemini.id)?.auth_failed_at, '原先处于认证失败停用态');

  s.answer(async (_machine, command) => {
    if (command.kind === 'sign_in') return { id: command.sign_in_id, executor: 'gemini', state: 'starting' };
    if (command.kind === 'sign_in_code') return { id: command.sign_in_id, executor: 'gemini', state: 'exchanging', url: 'https://accounts.google.com/o/oauth2/auth?client_id=x' };
    return { sign_in_id: command.sign_in_id, known: true };
  });

  const started = s.signIns.start('m1', 'gemini');
  await assert.rejects(() => s.signIns.submitCode(started.id, 'code-too-early'), /不在等待授权码状态/);

  const googleUrl = 'https://accounts.google.com/o/oauth2/auth?client_id=x';
  s.poll('m1', [{ id: started.id, executor: 'gemini', state: 'waiting', url: googleUrl, accepts_code: true }]);
  assert.equal(s.signIns.get(started.id)?.accepts_code, true);

  await assert.rejects(() => s.signIns.submitCode(started.id, '   '), /有效的授权码/);
  await assert.rejects(() => s.signIns.submitCode(started.id, 'bad\ncode'), /有效的授权码/);

  const secretCode = '4/0AeanS0aSecretPasteCode_XYZ';
  const afterSubmit = await s.signIns.submitCode(started.id, `  ${secretCode}  `);
  assert.equal(afterSubmit?.state, 'exchanging');
  assert.equal(afterSubmit?.accepts_code, undefined);
  assert.deepEqual(s.sent.at(-1), { machine: 'm1', command: { kind: 'sign_in_code', sign_in_id: started.id, code: secretCode } });

  // Stale in-flight poll carrying `waiting` must not regress `exchanging` back to `waiting`.
  s.poll('m1', [{ id: started.id, executor: 'gemini', state: 'waiting', url: googleUrl, accepts_code: true }]);
  assert.equal(s.signIns.get(started.id)?.state, 'exchanging');

  // Completing sign-in clears `auth_failed_at` immediately even though `logged_in` is null.
  s.poll('m1', [{ id: started.id, executor: 'gemini', state: 'done' }]);
  assert.equal(s.signIns.get(started.id)?.state, 'done');
  assert.equal(s.f.ledger.loginState(m1Gemini.id)?.auth_failed_at ?? null, null, '重登成功后认证失败态立即清除');
  assert.equal(s.lines.join('\n').includes(secretCode), false, '服务日志绝不记录粘贴的授权码');
});
