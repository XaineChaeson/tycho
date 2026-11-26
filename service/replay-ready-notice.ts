import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import type { WecomBody, WecomTarget } from '../channels/wecom.ts';
import type { Ledger, Receipt } from './ledger.ts';

export type ReplaySplit = 'tune' | 'release';
type Variant = 'owner-review' | 'router-grant' | 'old-task' | 'parallel' | 'owner-followup' | 'subscribed' | 'no-channel';

export interface ReadyNoticeCase {
  schema: 'tycho-ready-notice/v1';
  case_id: string;
  family: 'ready-notice';
  split: ReplaySplit;
  at: string;
  inputs: { variant: Variant };
  expected: {
    state: 'ready';
    router_can_accept: boolean;
    delivered: ('work_ready' | 'updated_work_ready' | 'trigger-final')[];
    saved_router_turns: 0 | 1;
  };
}

const VARIANTS: readonly Variant[] = ['owner-review', 'router-grant', 'old-task', 'parallel', 'owner-followup', 'subscribed', 'no-channel'];
const CASE = 'tycho-ready-notice/v1';
const FAMILY = 'ready-notice';
const splitOf = (value: unknown): value is ReplaySplit => value === 'tune' || value === 'release';

function dateOf(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\d$/.test(value)) return false;
  const at = new Date(value);
  return Number.isFinite(at.getTime()) && at.toISOString().slice(0, 10) === value;
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('案例字段应为对象');
  return value as Record<string, unknown>;
}

function exact(value: unknown, keys: string[]): Record<string, unknown> {
  const fields = record(value);
  if (Object.keys(fields).length !== keys.length || keys.some((key) => !Object.hasOwn(fields, key))) throw new Error('案例字段不符合已冻结的格式');
  return fields;
}

export function parseReadyNoticeCase(value: unknown): ReadyNoticeCase {
  if (record(value).status === 'draft') throw new Error('案例草稿需要补齐冻结的重放输入和独立判定后才能运行');
  const fields = exact(value, ['schema', 'case_id', 'family', 'split', 'at', 'inputs', 'expected']);
  const inputs = exact(fields.inputs, ['variant']);
  const expected = exact(fields.expected, ['state', 'router_can_accept', 'delivered', 'saved_router_turns']);
  if (fields.schema !== CASE || fields.family !== FAMILY || !splitOf(fields.split)
    || typeof fields.case_id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(fields.case_id)
    || !dateOf(fields.at)
    || !VARIANTS.includes(inputs.variant as Variant) || expected.state !== 'ready' || typeof expected.router_can_accept !== 'boolean'
    || !Array.isArray(expected.delivered) || expected.delivered.length > 2
    || !expected.delivered.every((item) => item === 'work_ready' || item === 'updated_work_ready' || item === 'trigger-final')
    || (expected.saved_router_turns !== 0 && expected.saved_router_turns !== 1)) {
    throw new Error('案例字段的值不符合已冻结的格式');
  }
  return fields as unknown as ReadyNoticeCase;
}

function builtIn(case_id: string, variant: Variant, at: string, split: ReplaySplit, expected: ReadyNoticeCase['expected']): ReadyNoticeCase {
  return { schema: CASE, family: FAMILY, case_id, split, at, inputs: { variant }, expected };
}

const noSaving: ReadyNoticeCase['expected'] = { state: 'ready', router_can_accept: false, delivered: ['work_ready'], saved_router_turns: 0 };
export const baselineCases: readonly ReadyNoticeCase[] = [
  builtIn('report-request', 'owner-review', '2026-10-01', 'tune', { ...noSaving, saved_router_turns: 1 }),
  builtIn('granted-router-review', 'router-grant', '2026-10-15', 'tune', { ...noSaving, router_can_accept: true, saved_router_turns: 1 }),
  builtIn('legacy-request', 'old-task', '2026-10-25', 'tune', noSaving),
  builtIn('clean-owner-review', 'owner-review', '2026-11-01', 'release', { ...noSaving, saved_router_turns: 1 }),
  builtIn('parallel-report', 'parallel', '2026-11-02', 'release', { ...noSaving, saved_router_turns: 1 }),
  builtIn('unresolved-followup', 'owner-followup', '2026-11-03', 'release', { ...noSaving, saved_router_turns: 1 }),
  builtIn('subscribed-review', 'subscribed', '2026-11-04', 'release', { ...noSaving, delivered: ['updated_work_ready', 'trigger-final'] }),
  builtIn('without-wecom', 'no-channel', '2026-11-05', 'release', { ...noSaving, delivered: [] }),
];

// An export is a projection, never a copy of a ledger, prompt, attachment or message.
// Conditions that cannot be proven as of settlement are deliberately left for the case author.
export function exportReadyNoticeDraft(path: string, runId: string, split: ReplaySplit) {
  if (!splitOf(split)) throw new Error('案例集应为 tune 或 release');
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    db.exec('BEGIN');
    const row = db.prepare(`
      SELECT run.id, run.ended_at, run.task_revision, run.exit_kind, run.receipt_json, run.artifacts_json,
             CASE WHEN json_valid(creation.detail_json) THEN json_extract(creation.detail_json, '$.on_ready') END AS on_ready,
             CASE WHEN json_valid(settled.detail_json) THEN json_extract(settled.detail_json, '$.task_state') END AS settled_state,
             CASE WHEN json_valid(run.snapshot_json) THEN json_extract(run.snapshot_json, '$.role.id') END AS role_id
      FROM run JOIN task ON task.id = run.task_id
      LEFT JOIN change creation ON creation.task_id = task.id AND creation.action = 'task.create'
      LEFT JOIN change settled ON settled.run_id = run.id AND settled.action = 'run.settle'
      WHERE run.id = ? AND run.state = 'ended' ORDER BY settled.seq DESC LIMIT 1
    `).get(runId);
    if (row === undefined || row.role_id !== 'verify' || typeof row.ended_at !== 'string' || !Number.isFinite(Date.parse(row.ended_at))) {
      throw new Error('要选择一个已结算、且快照记有验证职能的轮次');
    }
    const receipt = row.receipt_json === null ? null : record(JSON.parse(String(row.receipt_json)));
    const payload = typeof row.artifacts_json === 'string' ? record(JSON.parse(row.artifacts_json)) : undefined;
    const registration = payload?.registration === undefined ? undefined : record(payload.registration);
    const registered = Array.isArray(registration?.files) ? registration.files.length : null;
    const receiptKind = receipt === null ? 'unknown' : receipt.status === 'done' && Array.isArray(receipt.artifacts)
      && receipt.artifacts.every((item) => {
        const field = record(item);
        return (field.kind === 'report' || field.kind === 'file') && typeof field.ref === 'string' && field.ref.trim() !== '';
      }) ? 'report' : 'other';
    const recorded = db.prepare("SELECT 1 FROM change WHERE run_id = ? AND action = 'run.ready_notice'").get(runId) !== undefined;
    const case_id = `run-${createHash('sha256').update('ready-notice/v1\0').update(String(row.id)).digest('hex').slice(0, 24)}`;
    return {
      schema: CASE, family: FAMILY, status: 'draft', split, case_id, at: new Date(row.ended_at).toISOString().slice(0, 10),
      observed: { role: 'verify', task_revision: row.task_revision, receipt: receiptKind,
        registered_report_files: registered, owner_notice_requested: row.on_ready === null ? null : row.on_ready === 'notify_owner',
        settled_ready: row.settled_state === null ? null : row.settled_state === 'ready', direct_notice_recorded: recorded },
      missing: ['结算前生效的权限和通道', '并行工作、待办与订阅', '独立判定及通知顺序'],
    };
  } finally {
    db.close();
  }
}

const root = dirname(import.meta.dirname);
const localModule = <T>(dir: string, file: string): Promise<T> => import(pathToFileURL(join(resolve(dir), 'service', file)).href) as Promise<T>;
const OWNER = 'user';
const URL = 'https://replay.invalid';
const SETUP = { actor: 'replay' };
const ROUTER = { actor: 'router' };
const FILES = [{ name: 'report.md', sha256: 'a'.repeat(64), bytes: 25 }];
const RECEIPT = { status: 'done', summary: '11 个检查通过', artifacts: [{ kind: 'report', ref: 'report.md' }] };
const CLOCK = () => 1;

interface Notification { kind: string; target: WecomTarget; body: WecomBody }

const LINK = '\n\n[在控制台打开](https://replay.invalid/#';
const EXPECTED_NOTICE = {
  work_ready: { kind: 'work_ready', content: `【重放项目】回归检查 做完了，等你验收${LINK}/work/<task>)` },
  updated_work_ready: { kind: 'work_ready', content: `【重放项目】已经开始复盘${LINK}/work/<task>)` },
  'trigger-final': { kind: 'trigger-final', content: `【重放项目】触发器“后续复盘”这一次的结果：\n\n已经开始复盘${LINK}/projects/<project>)` },
};

function makeReadyRound(ledger: Ledger, projectId: string, variant: Variant) {
  const input = ledger.receiveMessage({
    channel: 'console', externalId: 'replay-request', actor: OWNER,
    text: '跑一次回归，完成就通知我，由我验收。', projectId,
  });
  if (ledger.takeNextTurn(projectId)?.message.id !== input.id) throw new Error('重放的主人请求没有进入负责人');
  const ctx = { ...ROUTER, messageId: input.id };
  const task = ledger.createTask({
    projectId, title: '回归检查', roleId: 'verify', goal: '运行回归检查', acceptance: '报告检查结果',
    ...(variant === 'old-task' ? {} : { onReady: 'notify_owner' as const }),
  }, ctx);
  ledger.queueTask(task.id, ctx);
  ledger.finishMessage(input.id, 'processed');
  const machine = ledger.getMachine('replay-node')!;
  const login = ledger.getMachineLogin(machine.id, 'claude')!;
  const { created_at: _created, updated_at: _updated, ...held } = login;
  const run = ledger.createRun(task.id, { login: held, machine, expectedRevision: task.revision, snapshot: {
    brief: '冻结的演示报告', tier: 'operate', tier_value: { kind: 'content', text: '{"model":"offline-fixture"}' }, timeout_ms: 60_000, knowledge: [],
  } }, SETUP);
  ledger.markRunRunning(run.id);
  return { task, run };
}

async function simulate(frozen: ReadyNoticeCase['inputs'], dir: string, enabled: boolean) {
  const [{ openLedger }, { createNotify }, { createOutboxSender }] = await Promise.all([
    localModule<typeof import('./ledger.ts')>(dir, 'ledger.ts'),
    localModule<typeof import('./notify.ts')>(dir, 'notify.ts'),
    localModule<typeof import('./outbox-sender.ts')>(dir, 'outbox-sender.ts'),
  ]);
  const work = mkdtempSync(join(tmpdir(), 'tycho-ready-replay-'));
  let ledger: Ledger | undefined;
  let externalAttempts = 0;
  const variant = frozen.variant;
  try {
    const current = openLedger(join(work, 'ledger.db'));
    ledger = current;
    const setting = (key: string, to: unknown) => current.writeTunable(key, { from: null, to, override: true }, SETUP);
    setting('router.directReadyNotice', enabled);
    setting('wecom.owner', OWNER);
    setting('http.publicUrl', URL);
    ledger.setWhitelist({ console: [OWNER] }, SETUP);
    const project = ledger.createProject({ name: '重放项目', loginMode: 'all' }, SETUP);
    ledger.setProjectGrants(project, variant === 'router-grant' ? ['accept'] : [], SETUP);
    if (variant === 'no-channel') ledger.setChannels(['console']);
    ledger.joinMachine({ id: 'replay-node', host: 'replay-node', nodeId: 'replay-node-id', tokenHash: 'fake-hash',
      platform: 'replay', source: null, ephemeral: false }, SETUP);
    ledger.putMachineLogin({ executor: 'claude', machine: 'replay-node',
      tiers: { execute: { kind: 'content', text: '{"model":"offline-fixture"}' } } }, SETUP);
    if (variant === 'parallel') {
      const other = ledger.createTask({ projectId: project, title: '并行任务', roleId: 'implement', goal: '同时执行', acceptance: '完成其他任务' }, SETUP);
      ledger.queueTask(other.id, SETUP);
    }
    const { task, run } = makeReadyRound(ledger, project, variant);
    if (variant === 'owner-followup') {
      ledger.receiveMessage({ channel: 'console', actor: OWNER, externalId: 'replay-followup', text: '完成后再做一件事', projectId: project });
    }
    if (variant === 'subscribed') {
      ledger.createTrigger(project, { name: '后续复盘', source: 'event', event: { kind: 'work_ready', task_id: task.id },
        instruction: '按报告做后续复盘', push_final: true }, SETUP);
    }
    const notify = createNotify({ ledger, owner: () => OWNER, publicUrl: () => URL, direct: async () => { externalAttempts += 1; throw new Error('评测没有配置外部传输'); } });
    const ids = [[task.id, '<task>'], [project, '<project>'], [run.id, '<run>']] as const;
    const normalized = (input: string) => ids.reduce((text, [id, local]) => text.replaceAll(id, local), input);
    ledger.registerArtifacts(run.id, FILES);
    const settlement = ledger.settleRun(run.id, 0, RECEIPT);
    const retry = ledger.settleRun(run.id, 0, RECEIPT);
    const delivery = ledger.resultDelivery(`work-ready:${run.id}`);
    const router_turns: string[][] = [];
    for (let turn = ledger.takeNextTurn(project); turn !== undefined; turn = ledger.takeNextTurn(project)) {
      if (router_turns.length >= 16) throw new Error('重放产生了预期以外的负责人循环');
      router_turns.push([turn.message, ...turn.attached].map(({ external_id }) => external_id === `run:${run.id}` ? 'settlement' : normalized(external_id)));
      if (variant === 'subscribed' && turn.message.external_id === `run:${run.id}`) {
        const reply = ledger.writeOutbound({ channel: 'internal', thread: turn.message.thread, text: '已经开始复盘', final: true, replyTo: turn.message.id });
        notify.finalReply(turn.message, ledger.getMessage(reply.id));
      }
      for (const message of [turn.message, ...turn.attached]) ledger.finishMessage(message.id, 'processed');
    }
    const sent: string[] = [];
    const clock = { giveUpAfterMs: CLOCK, retryFirstMs: CLOCK, retryMaxMs: CLOCK };
    const due = ledger.outbox.takeDue().filter(({ channel }) => channel === 'wecom').length;
    const batch = Promise.withResolvers<void>();
    if (due === 0) batch.resolve();
    let captured = 0;
    const sender = createOutboxSender({
      ...clock, outbox: ledger.outbox, log: () => batch.reject(new Error('出站消息队列回放失败')),
      channels: { wecom: async (row) => {
        try {
          const value = notify.render(row);
          if (value === undefined) return notify.skipReason(row);
          const key = (JSON.parse(row.payload_json) as { external_id?: string }).external_id;
          const kind = key?.startsWith('trigger-final:') ? 'trigger-final' : row.kind;
          sent.push(normalized(JSON.stringify({ kind, ...value })));
        } finally {
          if (++captured === due) batch.resolve();
        }
      } },
    });
    sender.start();
    // The sender stops taking items when asked to stop, even while it is awaiting the
    // current fake send. Wait for the captured batch before stopping it.
    const deadline = setTimeout(() => batch.reject(new Error('未处理完冻结案例的通知队列')), 1500);
    try {
      await batch.promise;
    } finally {
      clearTimeout(deadline);
      await sender.stop();
    }
    const notifications = sent.map((value) => JSON.parse(value) as Notification);
    const approvals = ledger.listApprovals(task.id).map(({ state }) => state);
    const held = ledger.getRun(run.id);
    const product = ledger.currentProduct(task.id);
    const state = ledger.getTask(task.id).state;
    let routerCanAccept = true;
    try {
      ledger.acceptTask(task.id, '报告已看过', ROUTER);
    } catch (error) {
      if (!/没有授权负责人自己验收/.test((error as Error).message)) throw error;
      routerCanAccept = false;
    }
    if (!routerCanAccept) ledger.acceptTask(task.id, '报告已看过', { actor: 'console' });
    return {
      outcomes: { state, settlement, retry, delivery, approvals, router_can_accept: routerCanAccept,
        accepted: ledger.getTask(task.id).state, receipt: JSON.parse(held.receipt_json ?? 'null') as Receipt | null,
        product: { ...product, runId: product.runId === run.id ? '<run>' : null } },
      notifications, router_turns, external_attempts: externalAttempts,
    };
  } finally {
    ledger?.close();
    rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

const json = (value: unknown): string => JSON.stringify(value);

export async function compareReadyNotice(value: ReadyNoticeCase, checkouts: { baseline?: string; candidate?: string } = {}) {
  const input = parseReadyNoticeCase(value);
  const baseline = await simulate(input.inputs, checkouts.baseline ?? root, false);
  const candidate = await simulate(input.inputs, checkouts.candidate ?? root, true);
  const external_effects = baseline.external_attempts + candidate.external_attempts;
  const failures: string[] = [];
  if (json(baseline.outcomes) !== json(candidate.outcomes)) failures.push('两版业务结果不同');
  if (json(baseline.notifications) !== json(candidate.notifications)) failures.push('两版送达的通知内容、顺序或收件人不同');
  const saved = baseline.router_turns.length - candidate.router_turns.length;
  if (saved !== input.expected.saved_router_turns) failures.push('节省的负责人轮数与独立判定不同');
  if (external_effects !== 0) failures.push('发生了过错或外部传输尝试');
  for (const [version, result] of [['baseline', baseline], ['candidate', candidate]] as const) {
    const actual = result.outcomes;
    if (actual.state !== input.expected.state || actual.router_can_accept !== input.expected.router_can_accept
      || actual.accepted !== 'done' || actual.retry.late !== true || actual.approvals.length !== 0
      || json(actual.receipt) !== json(RECEIPT) || json(actual.product.files) !== json(FILES)
      || actual.product.runId !== '<run>' || actual.product.revision !== 1) {
      failures.push(`${version} 业务结果未通过固定判定`);
    }
    const expected = input.expected.delivered.map((key) => EXPECTED_NOTICE[key]);
    const notices = result.notifications.map(({ kind, body }) => ({
      kind, content: body.msgtype === 'markdown' ? body.markdown.content : null,
    }));
    if (json(notices) !== json(expected) || result.notifications.some(({ target }) => target.chatid !== OWNER || target.chat_type !== 1)) {
      failures.push(`${version} 通知未通过固定判定`);
    }
  }
  return {
    case_id: input.case_id, split: input.split,
    input_digest: createHash('sha256').update(json([input.schema, input.case_id, input.family, input.split, input.at, input.inputs])).digest('hex'),
    judge_digest: createHash('sha256').update(json([
      input.expected.state, input.expected.router_can_accept, input.expected.delivered, input.expected.saved_router_turns,
    ])).digest('hex'),
    baseline, candidate, external_effects, failures,
  };
}

