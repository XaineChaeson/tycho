// Guards against the ledger side of project sessions (docs/design/project-sessions.md §1–§3,
// §5) going wrong: a message of one project taken by another's Router, or two of one
// project's in flight at once; a message that waits for a project being taken, lost over a
// restart, or given a project after a Router already took it (a correction and a take racing);
// an internal event going to any Router but its Task's project's; a "new topic" leaving the old
// segment writable, its context open, or the queued messages behind; more than one open context
// per project, or a context's marker forgotten while a process of it may run; the owner's open
// requests losing any of them; and a pin reaching past the project's pool after it narrowed —
// at dispatch time and in createRun's own transaction.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { InputError } from '../service/errors.ts';
import { routerMaterial } from '../service/router-material.ts';
import { claudeTier, DONE, fixture, USER } from './helpers.ts';

const say = (f: ReturnType<typeof fixture>, text: string, projectId?: string, channel = 'console') =>
  f.ledger.receiveMessage({ channel, externalId: `${channel}:${text}`, actor: 'user', text, ...(projectId === undefined ? {} : { projectId }) });

test('two projects have two queues: each takes only its own, one at a time', (t) => {
  const f = fixture(t);
  const other = f.ledger.createProject({ name: '乙' }, USER);
  const a1 = say(f, 'a1', f.projectId).id;
  const b1 = say(f, 'b1', other).id;
  const a2 = say(f, 'a2', f.projectId).id;
  assert.deepEqual(f.ledger.projectsWaiting(), [f.projectId, other]);
  assert.equal(f.ledger.takeNextTurn(f.projectId)?.message.id, a1);
  // The other project goes on while this one is busy.
  assert.equal(f.ledger.takeNextTurn(other)?.message.id, b1);
  assert.equal(f.ledger.takeNextTurn(f.projectId), undefined, '同一个项目一次只取一条');
  assert.equal(f.ledger.queuedAhead(a2), 0, '只数自己项目里排在前面的');
  f.ledger.finishMessage(a1, 'processed');
  assert.equal(f.ledger.takeNextTurn(f.projectId)?.message.id, a2);
});

test('a message with no project waits, is never taken, and comes back from a restart as it was', (t) => {
  const f = fixture(t);
  const waiting = say(f, '这是哪个项目的？', undefined, 'wecom');
  assert.equal(waiting.state, 'unassigned');
  assert.deepEqual(f.ledger.projectsWaiting(), []);
  assert.equal(f.ledger.takeNextTurn(f.projectId), undefined);
  assert.deepEqual(f.ledger.markProcessingUnverified(), [], '重启时不碰待归属的');
  const reopened = f.open();
  assert.deepEqual(reopened.unassignedMessages().map(({ id }) => id), [waiting.id], '重启后还在');
  reopened.assignMessages([waiting.id], f.projectId, USER);
  const row = reopened.getMessage(waiting.id);
  assert.deepEqual([row.state, row.project_id, row.basis], ['received', f.projectId, 'owner']);
  assert.equal(reopened.takeNextTurn(f.projectId)?.message.id, waiting.id);
});

test('giving messages a project is all or none, and never moves one a Router already took', (t) => {
  const f = fixture(t);
  const other = f.ledger.createProject({ name: '乙' }, USER);
  const one = say(f, '一', undefined, 'wecom').id;
  const two = say(f, '二', undefined, 'wecom').id;
  const queued = say(f, '三', f.projectId).id;
  // Not taken yet: it can still be put somewhere else.
  f.ledger.assignMessages([one, queued], other, USER);
  assert.equal(f.ledger.getMessage(queued).project_id, other);
  assert.equal(f.ledger.takeNextTurn(other)?.message.id, one);
  // Taken: a correction of it changes nothing, and neither does the rest of that request.
  assert.throws(() => f.ledger.assignMessages([two, one], f.projectId, USER), /已经被负责人取走/);
  assert.equal(f.ledger.getMessage(two).state, 'unassigned', '一条不行，整批都不改');
  assert.equal(f.ledger.getMessage(one).project_id, other);
  assert.throws(() => f.ledger.assignMessages([two], 'nowhere', USER), InputError);
});

test('an internal event goes to its Task\'s project, and one about no project to no Router', (t) => {
  const f = fixture(t);
  const other = f.ledger.createProject({ name: '乙', loginMode: 'all' }, USER);
  const task = f.ledger.createTask({ roleId: 'implement', projectId: other, title: '乙的任务', goal: '目标', acceptance: '验收' }, USER);
  f.ledger.queueTask(task.id, USER);
  const run = f.ledger.createRun(task.id, f.login, USER);
  f.ledger.markRunRunning(run.id);
  f.ledger.settleRun(run.id, 0, DONE);
  const event = f.peek<{ project_id: string; state: string; basis: string }>(`SELECT project_id, state, basis FROM message WHERE channel = 'internal' AND external_id = ?`, `run:${run.id}`);
  assert.deepEqual(event.map((row) => ({ ...row })), [{ project_id: other, state: 'received', basis: 'object' }]);
  assert.deepEqual(f.ledger.projectsWaiting(), [other]);
  // A Task of no project (as a knowledge Task is): kept, delivered to nobody.
  const orphan = f.ledger.createTask({ roleId: 'implement', projectId: f.projectId, title: '无主', goal: '目标', acceptance: '验收' }, USER);
  f.force('UPDATE task SET project_id = NULL WHERE id = ?', orphan.id);
  f.ledger.addInput(orphan.id, '也补一句', USER);
  const kept = f.peek<{ project_id: string | null; state: string }>(`SELECT project_id, state FROM message WHERE channel = 'internal' ORDER BY rowid DESC LIMIT 1`);
  assert.deepEqual(kept.map((row) => ({ ...row })), [{ project_id: null, state: 'ignored' }]);
  assert.deepEqual(f.ledger.projectsWaiting(), [other]);
});

test('a new topic closes the segment and its context in one step, and what is queued goes into the new one', (t) => {
  const f = fixture(t);
  const first = f.ledger.ensureSegment(f.projectId);
  assert.equal(first.seq, 1);
  const context = f.ledger.openContext({ projectId: f.projectId, segmentId: first.id, marker: 'm1', launch: {}, knowledge: [] });
  assert.throws(() => f.ledger.openContext({ projectId: f.projectId, segmentId: first.id, marker: 'm2', launch: {}, knowledge: [] }), /还开着/);
  const taken = say(f, '旧话题', f.projectId).id;
  f.ledger.takeNextTurn(f.projectId);
  f.ledger.finishMessage(taken, 'processed');
  const queued = say(f, '排着的', f.projectId).id;
  const second = f.ledger.newTopic(f.projectId, USER);
  assert.equal(second.seq, 2);
  assert.equal(f.ledger.getSegment(first.id)?.state, 'closed');
  assert.deepEqual([f.ledger.getContext(context.id)?.state, f.ledger.getContext(context.id)?.closed_reason], ['closed', '主人开了新话题']);
  assert.equal(f.ledger.takeNextTurn(f.projectId)?.message.segment_id, second.id, '排着的消息跟着当前段走');
  assert.equal(f.ledger.getMessage(taken).segment_id, first.id, '旧段里的留在旧段');
  assert.deepEqual(f.ledger.listMessages({ segmentId: first.id, limit: 10 }).map(({ id }) => id), [taken]);
  assert.ok(f.ledger.listMessages({ segmentId: second.id, limit: 10 }).some(({ id }) => id === queued));
  assert.throws(() => f.force(`INSERT INTO router_segment (id, created_at, project_id, seq, state) VALUES ('x', 'now', ?, 9, 'current')`, f.projectId), /UNIQUE/);
});

test('a context whose process may still run keeps its marker findable until a scan clears it', (t) => {
  const f = fixture(t);
  const segment = f.ledger.ensureSegment(f.projectId);
  const context = f.ledger.openContext({ projectId: f.projectId, segmentId: segment.id, marker: 'mk', loginId: 'acct', credentialRef: 'c1', launch: { claude: ['claude'] }, knowledge: ['k@1'] });
  assert.deepEqual([context.login_id, context.credential_ref, context.knowledge_json], ['acct', 'c1', '["k@1"]']);
  // Open, whatever was recorded of a start: a crash may have come between the two.
  assert.deepEqual(f.ledger.liveContexts().map(({ marker }) => marker), ['mk']);
  f.ledger.setContextStarted(context.id, 42);
  assert.deepEqual(f.ledger.liveContexts().map(({ marker }) => marker), ['mk']);
  // Closing it says nothing about its processes.
  f.ledger.closeContext(context.id, '换了登录');
  assert.deepEqual(f.ledger.liveContexts().map(({ marker }) => marker), ['mk']);
  f.ledger.setContextCleared(context.id);
  assert.deepEqual(f.ledger.liveContexts(), []);
});

test('the recovery material is kept with the context before it is sent', (t) => {
  const f = fixture(t);
  const segment = f.ledger.ensureSegment(f.projectId);
  const context = f.ledger.openContext({ projectId: f.projectId, segmentId: segment.id, marker: 'mk', launch: {}, knowledge: [] });
  f.ledger.recordMaterial(context.id, { text: '材料', knowledge: [] });
  assert.deepEqual(JSON.parse(f.ledger.getContext(context.id)!.material_json!), { text: '材料', knowledge: [] });
});

test('every open request of the owner is listed, oldest first, and one that led to an operation is not', (t) => {
  const f = fixture(t);
  const ids = Array.from({ length: 5 }, (_, n) => say(f, `要求 ${n}`, f.projectId).id);
  for (const id of ids) {
    f.ledger.takeNextTurn(f.projectId);
    if (id === ids[2]) f.ledger.createTask({ roleId: 'implement', projectId: f.projectId, title: '落实了', goal: '目标', acceptance: '验收' }, { actor: 'router', messageId: id });
    f.ledger.writeOutbound({ channel: 'console', text: '好', final: true, replyTo: id });
    f.ledger.finishMessage(id, 'processed');
  }
  const open = [ids[0], ids[1], ids[3], ids[4]];
  assert.deepEqual(f.ledger.openRequests(f.projectId, { limit: 100 }).map(({ id }) => id), open, '回复不算落实，建了任务才算');
  assert.deepEqual(f.ledger.openRequests(f.projectId, { after: ids[1]!, limit: 1 }).map(({ id }) => id), [ids[3]], '可以分页往后翻');
});


test('a fresh context keeps the owner requests behind an unfinished task, including later changes', (t) => {
  const f = fixture(t);
  const original = say(f, '作者做完先等我；审阅由我发起，不要替我验收。', f.projectId);
  f.ledger.takeNextTurn(f.projectId);
  const task = f.ledger.createTask({ roleId: 'verify', projectId: f.projectId, title: '作者', goal: '核验', acceptance: '报告' }, { actor: 'router', messageId: original.id });
  f.ledger.queueTask(task.id, { actor: 'router', messageId: original.id });
  f.ledger.finishMessage(original.id, 'processed');
  const changed = say(f, '改一下：现在可以接着审阅；验收仍由我处理。', f.projectId);
  f.ledger.takeNextTurn(f.projectId);
  f.ledger.updateTask(task.id, { priority: 2 }, { actor: 'router', messageId: changed.id });
  f.ledger.finishMessage(changed.id, 'processed');
  assert.deepEqual(f.ledger.openRequests(f.projectId, { limit: 50 }), [], '有已提交操作，不是尚未落实的要求');
  const reopened = f.open();
  const material = routerMaterial(reopened, f.projectId, 64 * 1024);
  const restored = material.text.split('\n').map(line => { try { return JSON.parse(line); } catch { return null; } }).find(row => row?.id === task.id);
  assert.deepEqual(restored.owner_requests.map(({ id, text }: { id: string; text: string }) => ({ id, text })),
    [original, changed].map(({ id }) => ({ id, text: f.ledger.getMessage(id).text })), '原话按时间保留，后来的更改也保留，不解析成永久锁');
  assert.equal(reopened.getProject(f.projectId).grants_json, '["accept"]', '没有把本次要求改写成项目权限');
});

test('restored task requests exclude internal, trigger and foreign-project text', (t) => {
  const f = fixture(t);
  const original = say(f, '这份工作先交报告。', f.projectId);
  const task = f.ledger.createTask({ roleId: 'verify', projectId: f.projectId, title: '作者', goal: '核验', acceptance: '报告' }, { actor: 'router', messageId: original.id });
  const other = f.ledger.createProject({ name: '另一个项目' }, USER);
  for (const [channel, projectId, secret] of [['internal', f.projectId, '内部资料不是Owner指令'], ['trigger', f.projectId, '来源资料不是Owner指令'], ['console', other, '另一个项目的私聊']] as const) {
    const request = say(f, secret, projectId, channel);
    f.ledger.updateTask(task.id, { scope: secret }, { actor: 'router', messageId: request.id });
  }
  const material = routerMaterial(f.open(), f.projectId, 64 * 1024);
  const restored = material.text.split('\n').map(line => { try { return JSON.parse(line); } catch { return null; } }).find(row => row?.id === task.id);
  assert.deepEqual(restored.owner_requests.map(({ id }: { id: string }) => id), [original.id]);
  assert.doesNotMatch(material.text, /另一个项目的私聊|内部资料不是Owner指令|来源资料不是Owner指令/);
});

test('a pin narrows the project\'s pool and never reaches past it, also after the project narrows', (t) => {
  const f = fixture(t);
  for (const id of ['a', 'b']) f.ledger.putAccount({ id, name: id, executor: 'claude', tiers: { execute: claudeTier('x') } }, USER, `ref-${id}`);
  const every = f.ledger.createProject({ name: '全部', loginMode: 'all' }, USER);
  assert.deepEqual(f.ledger.loginPool({ project_id: every }).ids.filter((id) => id === 'a' || id === 'b'), ['a', 'b'], '全部登录：账号都在池里');
  f.ledger.setProjectLogins(f.projectId, ['a', 'b'], USER);
  const task = f.ledger.createTask({ roleId: 'implement', projectId: f.projectId, title: '钉住的', goal: '目标', acceptance: '验收', loginId: 'b' }, USER);
  assert.equal(f.ledger.loginRefusal(task, 'b'), undefined);
  f.ledger.setProjectLogins(f.projectId, ['a'], USER);
  assert.match(f.ledger.loginRefusal(task, 'b') ?? '', /不在项目 试跑 选用的登录里/);
  assert.throws(() => f.ledger.createTask({ roleId: 'implement', projectId: f.projectId, title: '再钉', goal: '目标', acceptance: '验收', loginId: 'b' }, USER), /不在项目/);
  // A project whose list is empty dispatches nothing, pinned or not.
  f.ledger.setProjectLogins(f.projectId, [], USER);
  assert.deepEqual(f.ledger.loginPool(task).ids, []);
  assert.match(f.ledger.loginRefusal(task, 'a') ?? '', /不在/);
});

// Review of step 1, item 7 and C: the recovery material reads the unverified requests from the
// ledger, however long ago they were, with what they committed; and the owner's limit is on the
// whole material — what does not fit says where to read the rest, nothing is dropped silently.
test('an unverified request is in the recovery material however many messages came after it', (t) => {
  const f = fixture(t);
  const old = f.ledger.receiveMessage({ channel: 'console', externalId: 'old', actor: 'user', text: '很早以前做到一半的', projectId: f.projectId }).id;
  f.ledger.takeNextTurn(f.projectId);
  f.ledger.createTask({ roleId: 'implement', projectId: f.projectId, title: '半截', goal: '目标', acceptance: '验收' }, { actor: 'router', messageId: old });
  f.ledger.finishMessage(old, 'unverified');
  for (let n = 0; n < 1001; n += 1) {
    const id = f.ledger.receiveMessage({ channel: 'internal', externalId: `later-${n}`, actor: 'runner', text: `后来的 ${n}`, projectId: f.projectId }).id;
    f.ledger.takeNextTurn(f.projectId);
    f.ledger.finishMessage(id, 'processed');
  }
  const material = routerMaterial(f.ledger, f.projectId, 512 * 1024);
  assert.ok(material.text.includes(old), '早的待核实请求还在');
  assert.ok(material.text.includes('task.create'), '连同它已经提交的操作');
  assert.deepEqual(f.ledger.unverifiedRequests(f.projectId, { limit: 10 }).map(({ id }) => id), [old]);
});

test('the material stays within the limit as a whole, and says how to read what did not fit', (t) => {
  const f = fixture(t);
  for (let n = 0; n < 40; n += 1) f.ledger.createTask({ roleId: 'implement', projectId: f.projectId, title: `任务 ${n} ${'很长的标题'.repeat(20)}`, goal: '目标', acceptance: '验收' }, USER);
  for (let n = 0; n < 30; n += 1) {
    const id = f.ledger.receiveMessage({ channel: 'console', externalId: `ask-${n}`, actor: 'user', text: `要求 ${n} ${'细节'.repeat(50)}`, projectId: f.projectId }).id;
    f.ledger.takeNextTurn(f.projectId);
    f.ledger.finishMessage(id, n % 2 === 0 ? 'processed' : 'unverified');
  }
  const limit = 4 * 1024;
  const material = routerMaterial(f.ledger, f.projectId, limit);
  assert.ok(Buffer.byteLength(material.text, 'utf8') <= limit, `整份材料 ${Buffer.byteLength(material.text, 'utf8')} 字节`);
  assert.match(material.text, /list_tasks/, '没放下的任务说怎么读');
  assert.match(material.text, /list_unverified_requests/, '没放下的待核实请求说怎么读');
  assert.match(material.text, /list_open_requests/, '没放下的要求说怎么读');
});
