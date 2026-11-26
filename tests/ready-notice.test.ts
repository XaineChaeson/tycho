import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createNotify } from '../service/notify.ts';
import type { OutboxRow } from '../service/outbox.ts';
import { DEFAULT_PUSH_POLICY } from '../service/pushes.ts';
import type { LedgerOptions, Receipt } from '../service/ledger.ts';
import { fixture, tune, USER, type Fixture } from './helpers.ts';

const REPORT = { status: 'done', summary: '11 个检查通过', artifacts: [{ kind: 'report', ref: 'report.md' }] };
const FILES = [{ name: 'report.md', sha256: 'a'.repeat(64), bytes: 25 }];
const ROUTER = { actor: 'router' };

function setup(t: Parameters<typeof fixture>[0], options: LedgerOptions = {}): Fixture {
  const f = fixture(t, options);
  tune(f.ledger, 'wecom.owner', USER.actor);
  tune(f.ledger, 'http.publicUrl', 'https://tycho.example');
  return f;
}

function startReport(f: Fixture, onReady = true, beforeStart?: (f: Fixture, taskId: string) => void) {
  const incoming = f.ledger.receiveMessage({ channel: 'console', externalId: 'report-request', actor: 'user', text: '跑一次回归，完成就通知我，由我验收。', projectId: f.projectId });
  assert.equal(f.ledger.takeNextTurn(f.projectId)?.message.id, incoming.id);
  const ctx = { ...ROUTER, messageId: incoming.id };
  const task = f.ledger.createTask({
    projectId: f.projectId, title: '回归检查', roleId: 'verify', goal: '运行回归检查', acceptance: '报告检查结果',
    ...(onReady ? { onReady: 'notify_owner' as const } : {}),
  }, ctx);
  f.ledger.queueTask(task.id, ctx);
  f.ledger.finishMessage(incoming.id, 'processed');
  beforeStart?.(f, task.id);
  const run = f.ledger.createRun(task.id, { ...f.login, expectedRevision: f.ledger.getTask(task.id).revision, snapshot: { ...f.login.snapshot, tier: 'operate' } }, USER);
  f.ledger.markRunRunning(run.id);
  return { task, run };
}

function takeTurns(f: Fixture): string[][] {
  const turns: string[][] = [];
  for (let turn = f.ledger.takeNextTurn(f.projectId); turn !== undefined; turn = f.ledger.takeNextTurn(f.projectId)) {
    const events = [turn.message, ...turn.attached];
    turns.push(events.map(({ external_id }) => external_id));
    for (const event of events) f.ledger.finishMessage(event.id, 'processed');
  }
  return turns;
}

function noticeOf(f: Fixture, taskId: string) {
  const notify = createNotify({ ledger: f.ledger, owner: () => USER.actor, publicUrl: () => 'https://tycho.example', direct: async () => {} });
  const out = f.peek<OutboxRow>("SELECT * FROM outbox WHERE kind = 'work_ready'");
  assert.equal(out.length, 1);
  const notice = notify.render(out[0]!);
  assert.equal(notice?.target.chatid, USER.actor);
  assert.equal(notice?.body.msgtype, 'markdown');
  if (notice?.body.msgtype !== 'markdown') assert.fail('没有成果通知');
  const text = notice.body.markdown.content;
  assert.match(text, /回归检查.*等你验收/);
  assert.ok(text.includes('/work/' + taskId), '通知可打开任务和报告');
  return text.replace(taskId, '<task>');
}

test('只比较通知规则，报告、业主验收权限和实际通知相同，负责人少一轮', (t) => {
  const simulate = (enabled: boolean) => {
    const f = setup(t);
    if (!enabled) tune(f.ledger, 'router.directReadyNotice', false);
    f.ledger.setProjectGrants(f.projectId, [], USER);
    const { task, run } = startReport(f);
    f.ledger.registerArtifacts(run.id, FILES);
    assert.deepEqual(f.ledger.settleRun(run.id, 0, REPORT), { late: false, task_state: 'ready' });
    assert.equal(takeTurns(f).length, enabled ? 0 : 1);
    assert.throws(() => f.ledger.acceptTask(task.id, '通过', ROUTER), /没有授权负责人自己验收/);
    const delivery = f.ledger.resultDelivery('work-ready:' + run.id);
    const notification = noticeOf(f, task.id);
    const product = f.ledger.currentProduct(task.id);
    assert.deepEqual(product.files, FILES);
    const receipt = JSON.parse(f.ledger.getRun(run.id).receipt_json!);
    assert.deepEqual(receipt, REPORT);
    assert.equal(f.ledger.settleRun(run.id, 0, REPORT).late, true);
    assert.equal(noticeOf(f, task.id), notification, '重试结算没有重复通知');
    const chosen = f.ledger.listChanges({ taskId: task.id }).find(({ action }) => action === 'run.ready_notice');
    if (enabled) {
      assert.equal(f.ledger.getMessage(chosen!.message_id!).state, 'ignored');
      assert.deepEqual(JSON.parse(chosen!.detail_json!), {
        rule: 'ready-report-v1', reason: 'owner_acceptance_requested', notice_key: 'work-ready:' + run.id,
      });
    } else {
      assert.equal(chosen, undefined);
    }
    f.ledger.acceptTask(task.id, '报告已看过', { actor: 'console' });
    return { delivery, notification, receipt, files: product.files, state: f.ledger.getTask(task.id).state };
  };
  assert.deepEqual(simulate(true), simulate(false));
});

test('旧任务、无推送通道、未配置对外地址和非 done 回执保留负责人回合；有 onReady=notify_owner 时直接通知', (t) => {
  const keepRouter: {
    what: string;
    prepare?: (f: Fixture) => void;
    onReady?: boolean;
    receipt?: Receipt;
  }[] = [
    { what: '旧任务没有指定直接通知', onReady: false },
    { what: '回执不是 done（等待决定）', receipt: { status: 'waiting', summary: '需要确认', ask: [{ question: '继续吗？' }] } },
    { what: '没有推送通道', prepare: (f) => { f.ledger.setChannels(['console']); } },
    { what: '未配置能打开报告的控制台地址', prepare: (f) => { tune(f.ledger, 'http.publicUrl', ''); } },
    { what: '关闭直接通知设置', prepare: (f) => { tune(f.ledger, 'router.directReadyNotice', false); } },
  ];
  for (const { what, prepare, onReady, receipt = REPORT } of keepRouter) {
    const f = setup(t);
    f.ledger.setProjectGrants(f.projectId, [], USER);
    prepare?.(f);
    const { run } = startReport(f, onReady);
    f.ledger.settleRun(run.id, 0, receipt);
    assert.ok(takeTurns(f).flat().includes('run:' + run.id), what);
  }

  // With simplified mayNotifyReadyDirectly, router accept grant or parallel work no longer blocks direct notice.
  const f = setup(t);
  f.queuedTask();
  const { run, task } = startReport(f, true);
  f.ledger.settleRun(run.id, 0, REPORT);
  assert.equal(takeTurns(f).length, 0, '简化判定后直接通知主人，不再多走一轮负责人');
  noticeOf(f, task.id);
});

test('待验收订阅在原结算消息进入负责人回合，仍按订阅要求推终稿', (t) => {
  const f = setup(t);
  f.ledger.setProjectGrants(f.projectId, [], USER);
  const { task, run } = startReport(f);
  const subscription = f.ledger.createTrigger(f.projectId, {
    name: '后续复盘', source: 'event', event: { kind: 'work_ready', task_id: task.id },
    instruction: '按报告做后续复盘', push_final: true,
  }, USER);
  f.ledger.settleRun(run.id, 0, REPORT);
  const { message } = f.ledger.takeNextTurn(f.projectId)!;
  assert.equal(message.external_id, 'run:' + run.id);
  assert.match(message.text, /按报告做后续复盘/);
  assert.equal(f.ledger.listTriggerFires({ triggerId: subscription.id, limit: 1 })[0]?.message_id, message.id);
  const notify = createNotify({ ledger: f.ledger, owner: () => USER.actor, direct: async () => {} });
  const reply = f.ledger.writeOutbound({ channel: 'internal', thread: message.thread, text: '已经开始复盘', final: true, replyTo: message.id });
  notify.finalReply(message, f.ledger.getMessage(reply.id));
  assert.equal(f.peek<{ id: string }>("SELECT id FROM outbox WHERE json_extract(payload_json, '$.external_id') = ?", 'trigger-final:' + message.id).length, 1);
});

test('已有成果等待合并通知，保留负责人并沿用原通知时窗', (t) => {
  const f = setup(t, { pushPolicy: () => ({ ...DEFAULT_PUSH_POLICY, resultWindowMs: 60 * 60 * 1000 }) });
  f.ledger.setProjectGrants(f.projectId, [], USER);
  const task = f.newTask({ roleId: 'verify' });
  f.ledger.queueTask(task.id, USER);
  const prior = f.ledger.createRun(task.id, { ...f.login, snapshot: { ...f.login.snapshot, tier: 'operate' } }, USER);
  f.ledger.markRunRunning(prior.id);
  f.ledger.settleRun(prior.id, 0, REPORT);
  takeTurns(f);
  f.ledger.acceptTask(task.id, '通过', USER);
  const { run } = startReport(f);
  f.ledger.settleRun(run.id, 0, REPORT);
  assert.equal(f.ledger.resultDelivery('work-ready:' + run.id), 'held');
  assert.deepEqual(takeTurns(f), [['run:' + run.id]]);
});

test('onReady=notify_owner 对任意职能（包括只读分析和自定义协调职能）均可用并直接通知主人', (t) => {
  const f = setup(t);
  f.ledger.setProjectGrants(f.projectId, [], USER);
  f.ledger.putRole({
    id: 'orchestrate',
    name: '协调者',
    description: '本地环境编排与集群转达',
    default_tier: 'operate',
    permission: 'write',
    deliverable: 'report',
    needs_review: false,
  }, USER);

  // Read-only or commit roles are also allowed to set onReady: 'notify_owner'.
  const analyseTask = f.ledger.createTask({ projectId: f.projectId, title: '只读分析', roleId: 'analyse', goal: '分析', acceptance: '交报告', onReady: 'notify_owner' }, USER);
  assert.equal(analyseTask.role_id, 'analyse');

  // Custom write+report+no-review role succeeds and triggers direct owner notice
  const incoming = f.ledger.receiveMessage({ channel: 'console', externalId: 'orch-req', actor: 'user', text: '跑一次编排并通知我验收', projectId: f.projectId });
  assert.equal(f.ledger.takeNextTurn(f.projectId)?.message.id, incoming.id);
  const ctx = { ...ROUTER, messageId: incoming.id };
  const task = f.ledger.createTask({
    projectId: f.projectId, title: '回归检查', roleId: 'orchestrate', goal: '本地编排', acceptance: '交报告', onReady: 'notify_owner',
  }, ctx);
  f.ledger.queueTask(task.id, ctx);
  f.ledger.finishMessage(incoming.id, 'processed');
  const run = f.ledger.createRun(task.id, { ...f.login, expectedRevision: f.ledger.getTask(task.id).revision, snapshot: { ...f.login.snapshot, tier: 'operate' } }, USER);
  f.ledger.markRunRunning(run.id);
  f.ledger.registerArtifacts(run.id, FILES);
  assert.deepEqual(f.ledger.settleRun(run.id, 0, REPORT), { late: false, task_state: 'ready' });
  assert.equal(takeTurns(f).length, 0);
  noticeOf(f, task.id);
});
