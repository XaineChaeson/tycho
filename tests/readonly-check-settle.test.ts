// Guards how a read-only round's code check is settled (docs/design/roles-and-tiers.md §5, §9
// step 6): the result is taken only when the machine says the code is as it was.
//
// What this file is here to catch:
//   - a read-only round whose code changed, or whose check is missing or cannot be told, having
//     its receipt taken: a verdict, a deliverable or a `learned` proposal recorded;
//   - such a round's Task not sent again once, fresh, or sent again forever instead of stopping
//     for the owner the second time in a row;
//   - the inputs that round was handed lost with its result;
//   - a round handed code that the machine says had none taken as checked;
//   - a writable round, or a read-only round stopped by the owner, judged by a check;
//   - a read-only round's artifacts/ collected when its Task is accepted;
//   - a machine's record of the check that is not of the protocol's shape taken as anything but
//     "cannot check", or its words and changes kept past the length the pages can show;
//   - a machine's report of where the round's code stood that is malformed in one field — a
//     missing or filled-in `head`, a `start` that is not a commit — repaired field by field and
//     the rest used to bind a review, instead of the whole report refused;
//   - the count of rounds not taken for their check running past the owner's "继续": the round
//     after it stopping the Task as if two in a row, instead of sent again once;
//   - a refused read-only round carried on by the automatic re-send while a restore nobody has
//     confirmed says every way on waits for the owner;
//   - the Router not told, in the service's words, what a refused round was and that it was
//     sent again once — or that record left in the Router's queue instead of only kept.
import './guard.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { createAcceptor } from '../service/accept.ts';
import { refusedByCheck } from '../service/ledger.ts';
import { codeCheckOf, sourceHeadOf } from '../runner/node-channel.ts';
import type { CodeCheck } from '../shared/roles.ts';
import { claudeTier, DONE, fixture, LOGIN, stripped, USER } from './helpers.ts';

const REPORT_DONE = { status: 'done', summary: '查清了', artifacts: [{ kind: 'report', ref: '最后一条消息' }], learned: [] };
const REPO = { kind: 'repo', url: 'https://example.test/owner/project.git', binding_key: 's-one-1a2b3c4d', commit: 'c0ffee' } as const;
const FOLDER = { kind: 'folder', path: '/srv/project', binding_key: 's-two-5e6f7a8b' } as const;

function setUp(t: TestContext) {
  const f = fixture(t);
  const login = () => {
    const held = f.ledger.getMachineLogin(f.login.login.machine, f.login.login.executor);
    return held ? stripped(held) : f.login.login;
  };
  // A round of an analysis Task (a read-only role), or of an implementation one.
  const round = (taskId: string, options: { repo?: boolean; folder?: boolean } = {}) => {
    const source = options.folder === true ? FOLDER : REPO;
    const run = f.ledger.createRun(taskId, {
      ...f.login, login: login(),
      snapshot: { brief: 'b', tier_value: claudeTier('/tiers/execute.json'), timeout_ms: 60_000, ...(options.repo === false ? {} : { source }) },
    }, USER);
    f.ledger.markRunRunning(run.id);
    return run.id;
  };
  const task = (roleId = 'analyse') => {
    const made = f.ledger.createTask({ roleId, projectId: f.projectId, title: '看一看', goal: '查原因', acceptance: '交报告' }, USER);
    f.ledger.queueTask(made.id, USER);
    return made.id;
  };
  const settle = (runId: string, check: CodeCheck | undefined, receipt: Record<string, unknown> = REPORT_DONE) =>
    f.ledger.settleRun(runId, 0, receipt as never, check === undefined ? {} : { codeCheck: check });
  return { f, round, task, settle };
}

const CHANGED: CodeCheck = { result: 'changed', changes: ['新增 out.txt'] };

test('代码没变：照常结算，记下“代码没变”', (t) => {
  const s = setUp(t);
  const id = s.task();
  const run = s.round(id);
  s.settle(run, { result: 'same' });
  assert.equal(s.f.task(id).state, 'ready');
  assert.ok(s.f.run(run).receipt_json);
  assert.deepEqual(JSON.parse(s.f.run(run).error_json!).code_check, { result: 'same' });
});

test('代码被改或核对不了：仅作参考元数据记录，不丢弃回执，也不自动重派或停下任务', (t) => {
  const s = setUp(t);
  const id = s.task();
  s.f.ledger.addInput(id, '顺便看一下日志', USER);
  const first = s.round(id);
  s.settle(first, CHANGED);
  const run = s.f.run(first);
  assert.equal(run.exit_kind, 'completed');
  assert.ok(run.receipt_json, '回执照常保留，不因只读代码变动而丢弃');
  assert.equal(refusedByCheck(run), true, 'refusedByCheck 仍作为参考标记反映 code_check 非采用状态');
  assert.deepEqual(JSON.parse(run.error_json!).code_check, CHANGED);
  assert.equal(s.f.task(id).state, 'ready');

  const secondTask = s.task();
  const second = s.round(secondTask);
  s.settle(second, { result: 'unverifiable', why: 'git 出错' });
  assert.equal(s.f.run(second).exit_kind, 'completed');
  assert.ok(s.f.run(second).receipt_json);
  assert.equal(s.f.task(secondTask).state, 'ready');
  assert.deepEqual(JSON.parse(s.f.run(second).error_json!).code_check, { result: 'unverifiable', why: 'git 出错' });
});

test('有退出码没有核对记录、带着代码报 no-code 或文件夹来源：都照常保留回执并结算', (t) => {
  const s = setUp(t);
  const missing = s.task();
  const run = s.round(missing);
  s.settle(run, undefined);
  assert.equal(s.f.task(missing).state, 'ready');
  assert.ok(s.f.run(run).receipt_json);

  const reportedNoCode = s.task();
  const other = s.round(reportedNoCode);
  s.settle(other, { result: 'no-code' });
  assert.equal(s.f.task(reportedNoCode).state, 'ready');
  assert.deepEqual(JSON.parse(s.f.run(other).error_json!).code_check, { result: 'no-code' });

  const none = s.task();
  const plain = s.round(none, { repo: false });
  s.settle(plain, { result: 'no-code' });
  assert.equal(s.f.task(none).state, 'ready');

  const folder = s.task();
  const own = s.round(folder, { folder: true });
  s.settle(own, { result: 'no-code', folder_change: { changed: true } });
  assert.equal(s.f.task(folder).state, 'ready', '文件夹有变化也照常结算');
  assert.deepEqual(JSON.parse(s.f.run(own).error_json!).code_check, { result: 'no-code', folder_change: { changed: true } });
});

test('可写的一轮没有 code_check；被主人停下的只读一轮按中断结算', async (t) => {
  const s = setUp(t);
  const writable = s.task('implement');
  const run = s.round(writable);
  s.settle(run, undefined, DONE);
  assert.equal(s.f.task(writable).state, 'ready');
  assert.equal(JSON.parse(s.f.run(run).error_json ?? '{}').code_check, undefined);

  const stopped = s.task();
  const other = s.round(stopped);
  s.f.ledger.markRunStopping(other, USER);
  s.settle(other, CHANGED);
  assert.equal(s.f.run(other).exit_kind, 'interrupted');
  assert.deepEqual(JSON.parse(s.f.run(other).error_json!).code_check, CHANGED);
});

test('机器给的核对记录形状不对：按“核对不了”算，原话和改动截到上限', () => {
  assert.deepEqual(codeCheckOf({ result: 'same' }), { result: 'same' });
  assert.deepEqual(codeCheckOf({ result: 'no-code' }), { result: 'no-code' });
  assert.deepEqual(codeCheckOf({ result: 'changed', changes: ['a'] }), { result: 'changed', changes: ['a'] });
  // A folder round's reading of the folder travels with its "no code" (§8.2): rebuilt as
  // narrowly as the rest, and a shape that is not the protocol's is dropped, never guessed at.
  assert.deepEqual(codeCheckOf({ result: 'no-code', folder_change: { changed: true } }), { result: 'no-code', folder_change: { changed: true } });
  assert.deepEqual(codeCheckOf({ result: 'no-code', folder_change: { changed: false, why: 'x'.repeat(2000) } }), { result: 'no-code', folder_change: { changed: false, why: 'x'.repeat(500) } });
  for (const value of [
    { result: 'no-code', folder_change: '变了' },
    { result: 'no-code', folder_change: {} },
    { result: 'no-code', folder_change: { changed: 'yes' } },
    { result: 'no-code', folder_change: null },
    { result: 'same', folder_change: { changed: true } },
  ]) assert.deepEqual(codeCheckOf(value), value.result === 'same' ? { result: 'same' } : { result: 'no-code' }, `形状不对的文件夹读数 ${JSON.stringify(value)}`);

  const bad = { result: 'unverifiable', why: '机器给的核对记录形状不对' };
  for (const value of [
    undefined,
    null,
    'same',
    {},
    { result: 'changed' },
    { result: 'changed', changes: [] },
    { result: 'changed', changes: 'a' },
    { result: 'changed', changes: [1] },
    { result: 'changed', changes: ['a', 2] },
    { result: 'done' },
    { result: 'unverifiable' },
    { result: 'unverifiable', why: 7 },
    [],
  ]) assert.deepEqual(codeCheckOf(value), bad, `形状不对的核对记录 ${JSON.stringify(value)}`);

  const why = 'x'.repeat(2000);
  assert.deepEqual(codeCheckOf({ result: 'unverifiable', why }), { result: 'unverifiable', why: 'x'.repeat(500) });
  const changes = Array.from({ length: 40 }, (_, i) => `${i}`.padStart(2, '0') + 'y'.repeat(2000));
  assert.deepEqual(codeCheckOf({ result: 'changed', changes }), {
    result: 'changed',
    changes: changes.slice(0, 31).map((each) => each.slice(0, 500)),
  });
});

test('机器报的代码现场形状不对：整份报告当没报，不补齐字段、不丢下不合法的字段继续用', () => {
  const A = 'a'.repeat(40);
  const B = 'b'.repeat(40);
  // A whole one, as the protocol says it, and every field it may leave out.
  assert.deepEqual(sourceHeadOf({ kind: 'repo', head: A, branch: 'main', remote_head: B, start: B }), { kind: 'repo', head: A, branch: 'main', remote_head: B, start: B });
  assert.deepEqual(sourceHeadOf({ kind: 'repo', head: A }), { kind: 'repo', head: A, remote_head: null }, '远端没报就是没报；只读的一轮本来就不带');
  assert.deepEqual(sourceHeadOf({ kind: 'folder', head: A, branch: 'main', start: B }), { kind: 'folder', head: A, branch: 'main', start: B });
  assert.deepEqual(sourceHeadOf({ kind: 'folder', head: null, problem: '不是一个仓库' }), { kind: 'folder', head: null, problem: '不是一个仓库' });
  assert.deepEqual(sourceHeadOf({ kind: 'repo', head: A, remote_head: null, problem: '问不到远端' }), { kind: 'repo', head: A, remote_head: null, problem: '问不到远端' });
  assert.deepEqual(sourceHeadOf({ kind: 'folder', head: A, start: null }), { kind: 'folder', head: A, start: null }, '开始就读不出，明写成 null');
  // A word that is there but empty is no word, not a reason to throw the report away.
  assert.deepEqual(sourceHeadOf({ kind: 'repo', head: A, branch: '' }), { kind: 'repo', head: A, remote_head: null });
  assert.deepEqual(sourceHeadOf({ kind: 'repo', head: A, branch: null }), { kind: 'repo', head: A, remote_head: null });

  for (const value of [
    undefined,
    null,
    'repo',
    {},
    { kind: 'repo' },                                        // 必填的 head 缺了，不能补成 null
    { kind: 'repo', head: undefined },
    { kind: 'repo', head: 7 },
    { kind: 'repo', head: 'c0ffee' },                        // 不是提交号
    { kind: 'repo', head: A, branch: 7 },
    { kind: 'repo', head: A, remote_head: 7 },
    { kind: 'repo', head: A, remote_head: 'c0ffee' },
    { kind: 'repo', head: A, start: 123 },                   // 出现了但不是提交号：整份不认
    { kind: 'repo', head: A, start: 'c0ffee' },
    { kind: 'repo', head: A, problem: 7 },
    { kind: 'folder', head: A, remote_head: B },             // 工作目录没有远端
    { kind: 'folder', head: A, start: 123 },
    { kind: 'worktree', head: A },
  ]) assert.equal(sourceHeadOf(value), undefined, `形状不对的报告 ${JSON.stringify(value)}`);

  const long = 'x'.repeat(2000);
  assert.deepEqual(sourceHeadOf({ kind: 'folder', head: A, problem: long }), { kind: 'folder', head: A, problem: 'x'.repeat(500) }, '机器的话截到能显示的长度');
});

test('只读轮次代码被改时照常完成，不产生“不采用并自动重派”的拒收记录', (t) => {
  const s = setUp(t);
  const id = s.task();
  const run = s.round(id);
  s.settle(run, CHANGED);
  assert.equal(s.f.task(id).state, 'ready');
  assert.equal(s.f.run(run).exit_kind, 'completed');
  assert.ok(s.f.run(run).receipt_json);
  const messages = s.f.peek<{ text: string; state: string }>(
    `SELECT text, state FROM message WHERE channel = 'internal' AND external_id = ? AND task_id = ?`, `run:${run}`, id,
  );
  assert.ok(messages.every((m) => !/没有采用/.test(m.text)), '不产生“结果没有采用”的内部拒收记录');
});

test('验收只读那一轮：照常去机器上取 artifacts/ 并登记', async (t) => {
  const s = setUp(t);
  const id = s.task();
  const run = s.round(id);
  s.settle(run, { result: 'same' });
  let asked = 0;
  const acceptor = createAcceptor({
    ledger: s.f.ledger,
    runner: { fetchArtifacts: async () => { asked += 1; return { files: [], problem: null }; } },
    dataDir: s.f.dir,
  });
  const outcome = await acceptor.accept(id, '看过了', USER);
  assert.equal(asked, 1, '只读轮次同样拉取 artifacts/ 目录中的交付物');
  assert.deepEqual(outcome, { stored: [], problem: null });
});
