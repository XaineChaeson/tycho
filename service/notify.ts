import type { WecomBody, WecomTarget } from '../channels/wecom.ts';
import { assignCard, knowledgeCard, questionCard, type TemplateCard } from '../channels/wecom-cards.ts';
import { knowledgeAskOf } from './knowledge-brief.ts';
import { ACCOUNT_LOGIN_FIX, ACTION_TEXT, machineLoginRefusedText, modelsAddedText, modelsGoneText } from '../shared/labels.ts';
import { fullTime } from '../shared/time.ts';
import type { ModelInfo } from '../adapters/types.ts';
import type { Ledger } from './ledger.ts';
import { InputError } from './errors.ts';
import type { MessageRow } from './messages.ts';
import type { OutboxRow } from './outbox.ts';
import { loginName, loginPage } from '../shared/logins.ts';
import { expiryDay } from '../shared/credential.ts';
import { shortCode, type Candidates } from './front-desk.ts';
import { createPresenter } from './present.ts';
import { PROBLEM_LABELS, TRIGGER_CHANNEL, type TriggerProblem } from '../shared/triggers.ts';

const CHANNEL = 'wecom';
const SINGLE = 1;
const GROUP = 2;
const QUOTE_CHARS = 40;
const SUMMARY_CHARS = 200;
const RESIDUE_TEXT = 'Worker 已经结束，但它留下的后台进程清不掉';
const BACKUP_PAGE = `/settings/${encodeURIComponent('备份')}`;

interface Outgoing {
  target: WecomTarget;
  body: WecomBody;
}

interface NotifyOptions {
  ledger: Ledger;
  // Both are settings the owner can change while the service runs: read at each use.
  owner: () => string;
  // Empty when the service has no address others can reach.
  publicUrl?: () => string;
  // Past the Outbox, for what has to be said when the ledger cannot be written.
  direct(content: string): Promise<void>;
  log?: (line: string) => void;
}

const isWeixinDm = (channel: string, thread: string | null, actor: string | null): boolean =>
  channel === 'weixin' && (!thread || thread === actor || (actor !== null && thread.startsWith('weixin:') && thread.endsWith(`:${actor}`)));

// The thread alone cannot say which kind it is, but a single chat's thread is the
// sender's own id (or `weixin:<botId>:<actor>` for Weixin 1v1 DMs).
const replyTarget = ({ channel, thread, actor }: Pick<MessageRow, 'channel' | 'thread' | 'actor'>): WecomTarget => ({
  chatid: thread ?? actor!,
  chat_type: !thread || thread === actor || isWeixinDm(channel, thread, actor) ? SINGLE : GROUP,
});

// The one sentence of a result: the Router's first paragraph, kept short.
function sentence(text: string): string {
  const first = text.trim().split(/\n\s*\n/)[0]!.trim();
  return first.length > SUMMARY_CHARS ? `${first.slice(0, SUMMARY_CHARS)}…` : first;
}

export function createNotify({ ledger, owner, publicUrl, direct, log = (line) => console.error(line) }: NotifyOptions) {
  const loginDisplay = (id: string | null | undefined, name?: string): string => {
    const held = id == null ? undefined : ledger.getAccount(id) ?? ledger.listMachineLogins().find((login) => login.id === id);
    return held?.name ?? name ?? '已删除的登录';
  };
  const ownerChat = (): WecomTarget => ({ chatid: owner(), chat_type: SINGLE });
  let degraded = ledger.dispatchConditions().degraded;

  const present = createPresenter({ ledger, ...(publicUrl ? { publicUrl } : {}) });
  const { pageUrl, projectName, taskProject } = present;
  const base = (): string => (publicUrl?.() ?? '').replace(/\/$/, '');
  const taskTitle = (taskId: string | null | undefined): string => {
    if (!taskId) return '';
    try {
      return ledger.getTask(taskId).title;
    } catch {
      return taskId;
    }
  };

  // §2: every message carries the project it is about, or 【系统】, and the way to the page
  // (omitted in group chats so the owner's private console URL is never exposed to colleagues).
  const markdown = (projectId: string | null | undefined, text: string, path: string, includeConsoleLink = true): WecomBody =>
    ({ msgtype: 'markdown', markdown: { content: present.text(projectId, text, path, { includeConsoleLink }) } });
  const card = (projectId: string | null | undefined, template: TemplateCard, path: string, includeConsoleLink = true): WecomBody =>
    ({ msgtype: 'template_card', template_card: present.card(projectId, template, path, { includeConsoleLink }) });

  function enqueue(content: string, place: { channel?: string; target?: WecomTarget; projectId?: string | null; path?: string; key?: string } = {}): void {
    ledger.enqueueNotification(place.channel ?? CHANNEL, 'markdown', {
      ...(place.key ? { external_id: place.key } : {}),
      ...(place.target ? { target: place.target } : {}),
      content,
      project_id: place.projectId ?? null,
      path: place.path ?? (place.projectId ? `/projects/${place.projectId}` : '/'),
    });
  }

  function answeredText(approvalId: string): string {
    const approval = ledger.getApprovalCard(approvalId);
    const answers = JSON.parse(approval?.answers_json ?? '[]') as unknown[];
    const summary = answers.map(String).join('；');
    const via = approval?.answered_via;
    return via === 'console' ? `问题已在 Console 回答：${summary}` : `已回答（来自 ${via}）：${summary}`;
  }

  function verifyText(taskId: string): string {
    return `需要你核实：${taskTitle(taskId)}。${RESIDUE_TEXT}，清掉之前这一轮不会结算`;
  }

  const DELETED_SKIP_REASON = '关联记录已删除';

  function skipReason(row: OutboxRow): string | undefined {
    const payload = JSON.parse(row.payload_json) as Record<string, any>;
    if (typeof payload.project_id === 'string' && payload.project_id !== '') {
      try {
        ledger.getProject(payload.project_id);
      } catch (err) {
        if (err instanceof InputError) return DELETED_SKIP_REASON;
        throw err;
      }
    }
    // Asked again as it goes out: the owner may have dealt with it since it was queued.
    if (row.kind === 'remind') {
      if (!ledger.pushStillWaiting(payload.kind, payload.payload)) return '已处理';
      if (payload.kind === 'approval') return ledger.getApprovalCard(payload.payload?.approval_id) ? undefined : DELETED_SKIP_REASON;
      if (payload.kind === 'verify') {
        try {
          return ledger.getRun(payload.payload?.run_id).state === 'ended' ? '已失效' : undefined;
        } catch (err) {
          if (err instanceof InputError) return DELETED_SKIP_REASON;
          throw err;
        }
      }
      if (payload.kind === 'knowledge_proposal') {
        try {
          return ledger.getProposal(payload.payload?.proposal_id).state === 'awaiting_owner' ? undefined : '已处理';
        } catch (err) {
          if (err instanceof InputError) return DELETED_SKIP_REASON;
          throw err;
        }
      }
      if (payload.kind === 'held') {
        try {
          ledger.getTask(payload.payload?.task_id);
          return undefined;
        } catch (err) {
          if (err instanceof InputError) return DELETED_SKIP_REASON;
          throw err;
        }
      }
      return undefined;
    }
    // A token stored again since it was queued is another credential: the notice is about one
    // the account no longer holds, and does not go out (docs/design/native-login.md §2). Only
    // that is asked here: "inside the window" was the scan's to decide when it queued the
    // notice, and a window narrowed since must not leave the credential with no notice at all.
    if (row.kind === 'account_expiry') return ledger.expiryCredentialCurrent(payload) ? undefined : '已处理';
    // A trigger's problem gone before it went out is not news (docs/design/triggers.md §8).
    if (row.kind === 'trigger_problem') return ledger.pushStillWaiting(row.kind, payload) ? undefined : '已解决';
    if (row.kind === 'assign') {
      try {
        return ledger.getMessage(payload.message_id).state === 'unassigned' ? undefined : '已归属';
      } catch (err) {
        if (err instanceof InputError) return DELETED_SKIP_REASON;
        throw err;
      }
    }
    if (row.kind === 'approval') {
      const approval = ledger.getApprovalCard(payload.approval_id);
      if (!approval) return DELETED_SKIP_REASON;
      return approval.state === 'open' ? undefined : '已处理';
    }
    if (row.kind === 'knowledge_proposal') {
      try {
        return ledger.getProposal(payload.proposal_id).state === 'awaiting_owner' ? undefined : '已处理';
      } catch (err) {
        if (err instanceof InputError) return DELETED_SKIP_REASON;
        throw err;
      }
    }
    if (row.kind === 'held') {
      try {
        const task = ledger.getTask(payload.task_id);
        return task.state === 'held' && (!('reason' in payload) || task.reason === (payload.reason ?? null)) ? undefined : '已处理';
      } catch (err) {
        if (err instanceof InputError) return DELETED_SKIP_REASON;
        throw err;
      }
    }
    if (row.kind === 'work_ready') {
      try {
        const task = ledger.getTask(payload.task_id);
        if (task.state !== 'ready') return '已处理';
        return ledger.reviewGate(task.id) === null ? undefined : '需先审阅';
      } catch (err) {
        if (err instanceof InputError) return DELETED_SKIP_REASON;
        throw err;
      }
    }
    if (row.kind !== 'verify') return undefined;
    // Residue is about a Run still held open by processes nobody can clear; it stops
    // mattering only once that Run has ended. Rows from before lost Runs continued by
    // themselves asked the owner about a host out of contact: nothing to ask any more.
    if (payload.finding !== 'residue') return '已失效';
    try {
      return ledger.getRun(payload.run_id).state === 'ended' ? '已失效' : undefined;
    } catch (err) {
      if (err instanceof InputError) return DELETED_SKIP_REASON;
      throw err;
    }
  }

  // What a result says, with neither mark nor link: alone, or as a line of several.
  function resultText(kind: string, payload: Record<string, any>): string {
    switch (kind) {
      case 'work_ready':
        return payload.summary ?? `${taskTitle(payload.task_id)} 做完了，等你验收`;
      case 'merged':
        return `已合入：${taskTitle(payload.task_id)} → 分支 ${payload.branch ?? '（未知）'}`;
      case 'integrated':
        // A merge round's base branch is the platform's to know, not the service's: said as
        // the main line rather than as the branch the host's checkout happens to be on.
        return `已并入 ${payload.branch ?? '主线'}：${taskTitle(payload.task_id)}`;
      case 'released':
        return `已上线 ${payload.version}${payload.task_id ? `：${taskTitle(payload.task_id)}` : ''}`;
      default:
        throw new Error(`不认识的成果类型：${kind}`);
    }
  }
  // A trigger or inbound source that keeps failing by itself (docs/design/triggers.md §8): which
  // one, what it keeps running into, and the page where it is listed.
  const triggerProblemText = (payload: Record<string, any>, again: boolean): string =>
    `${payload.source_id ? '入站来源' : '触发器'}“${payload.name}”${again ? '的问题还在' : '出了问题'}：${PROBLEM_LABELS[payload.problem as TriggerProblem] ?? payload.problem}${payload.detail ? `（最近一次：${payload.detail}）` : ''}`;
  // What a source's accepted occurrence is called when its final reply is pushed: it is no
  // trigger of a project's (docs/design/triggers.md §2.2, §8).
  const fireNoun = (fire: { source_id: string | null }): string => (fire.source_id === null ? '触发器' : '入站来源');
  // A source's problem is fixed on the inbound page; a rule's on its project's page.
  const triggerProblemPath = (payload: Record<string, any>): string =>
    payload.source_id ? '/inbound' : `/projects/${payload.project_id}`;

  const resultPath = (kind: string, payload: Record<string, any>): string =>
    kind === 'work_ready' ? `/work/${payload.task_id}` : payload.task_id ? `/task/${payload.task_id}` : '/';

  // A login whose token is expected to run out (docs/design/native-login.md §2, ruling L): the
  // account, the estimated day, and where it is signed in again. An estimate already past says
  // it may be gone rather than pretending it is still working.
  function expiryText(payload: Record<string, any>): string {
    const name = loginDisplay(payload.account_id, payload.account_name);
    const day = expiryDay(payload.expected_expiry);
    const past = typeof payload.expected_expiry === 'string' && Date.parse(payload.expected_expiry) <= Date.now();
    return past
      ? `账号 ${name} 的登录可能已经失效（预计到期 ${day}）。到账号页重新登录`
      : `账号 ${name} 的登录预计 ${day} 到期，到期后这一份登录就用不了了。到账号页重新登录`;
  }

  // What a reminder is about, in words, while it still waits.
  function remindText(kind: string, payload: Record<string, any>): { text: string; path: string } | undefined {
    switch (kind) {
      case 'approval': {
        const approval = ledger.getApprovalCard(payload.approval_id);
        if (!approval) return undefined;
        const typed = (JSON.parse(approval.questions_json) as unknown[]).length === 1 ? `回复“答 ${shortCode(approval.id)} <答复>”，或` : '';
        return { text: `问题还没回答：${approval.task_title}。${typed}到控制台回答`, path: `/task/${approval.task_id}` };
      }
      case 'held':
        return { text: `任务还停着，要你处理：${taskTitle(payload.task_id)}${payload.reason ? `（${payload.reason}）` : ''}`, path: `/task/${payload.task_id}` };
      case 'knowledge_proposal':
        return { text: `知识变更还在等你点头：${knowledgeAskOf(ledger, payload.proposal_id).action}`, path: `/knowledge/proposals/${payload.proposal_id}` };
      case 'account_credential_rejected':
        return { text: `账号 ${loginDisplay(payload.account_id, payload.account_name)} 的登录还没换上新的：${ACCOUNT_LOGIN_FIX}`, path: '/accounts' };
      case 'machine_login_refused':
        return { text: machineLoginRefusedText(loginDisplay(payload.login_id, payload.login_name)), path: '/machines' };
      case 'account_expiry':
        return { text: expiryText(payload), path: '/accounts' };
      case 'verify':
        return { text: verifyText(payload.task_id), path: `/task/${payload.task_id}` };
      case 'trigger_problem':
        return { text: triggerProblemText(payload, true), path: triggerProblemPath(payload) };
      default:
        return undefined;
    }
  }

  function pushTriggerNotice(
    message: MessageRow,
    format: (fire: ReturnType<Ledger['triggerFiresOfMessage']>[number]) => string,
  ): Set<string> {
    const fires = ledger.triggerFiresOfMessage(message.id);
    const seenGroups = new Set<string>();
    if (fires.length === 0) return seenGroups;
    let ownerQueued = false;
    for (const fire of fires) {
      if (fire.push_final === 1 && !ownerQueued) {
        ownerQueued = true;
        enqueue(format(fire), { projectId: message.project_id, key: `trigger-final:${message.id}` });
      }
      if (fire.broadcast_groups === 1 && message.project_id) {
        const groups = ledger.listProjectBroadcastGroups(message.project_id, fire.broadcast_group_ids);
        for (const group of groups) {
          const groupKey = `${group.channel}:${group.chat_id}`;
          if (seenGroups.has(groupKey)) continue;
          seenGroups.add(groupKey);
          enqueue(format(fire), {
            channel: group.channel,
            target: { chatid: group.chat_id, chat_type: GROUP },
            projectId: message.project_id,
            key: `trigger-group:${message.id}:${group.channel}:${group.chat_id}`,
          });
        }
      }
    }
    return seenGroups;
  }

  // When an internal run-settlement turn ends with a real conclusion for a Task that
  // originated from an inbound/trigger broadcast or a bound group `@` mention, automatically
  // broadcast the Router's final summary back to those authorized groups (unless the Router
  // already called `post_group_update` in this turn or an explicit trigger subscription already
  // broadcast to the same group). Intermediate review/retry rounds stay silent.
  function broadcastTaskClosure(
    inbound: MessageRow,
    replyText: string,
    turnMessageId: string,
    alreadyBroadcast: Set<string>,
  ): void {
    const runId = /^run:([^:]+)$/.exec(inbound.external_id)?.[1];
    if (runId === undefined) return;
    let settledTask: ReturnType<Ledger['getTask']>;
    try {
      const run = ledger.getRun(runId);
      settledTask = ledger.getTask(run.task_id);
    } catch {
      return;
    }
    let subject = settledTask;
    if (settledTask.review_of_json !== null) {
      try {
        const reviewOf = JSON.parse(settledTask.review_of_json) as { task_id?: string };
        if (!reviewOf.task_id) return;
        subject = ledger.getTask(reviewOf.task_id);
      } catch {
        return;
      }
    } else if (settledTask.landing_json !== null) {
      if (settledTask.state !== 'done' && settledTask.state !== 'held') return;
      try {
        const landing = JSON.parse(settledTask.landing_json) as { of?: string };
        if (!landing.of) return;
        subject = ledger.getTask(landing.of);
      } catch {
        return;
      }
    }
    if (subject.project_id === null) return;
    const isConclusive =
      subject.state === 'done'
      || (subject.state === 'ready' && ledger.reviewGate(subject.id) === null)
      || subject.state === 'waiting_person'
      || subject.state === 'held';
    if (!isConclusive) return;
    if (ledger.listChanges({ messageId: turnMessageId }).some((change) => change.action === 'im.group_broadcast')) return;
    const targets = ledger.taskBroadcastTargets(subject.id);
    for (const target of targets) {
      const groupKey = `${target.channel}:${target.chat_id}`;
      if (alreadyBroadcast.has(groupKey)) continue;
      alreadyBroadcast.add(groupKey);
      enqueue(replyText, {
        channel: target.channel,
        target: { chatid: target.chat_id, chat_type: GROUP },
        projectId: subject.project_id,
        path: `/task/${subject.id}`,
        key: `task-group:${turnMessageId}:${target.channel}:${target.chat_id}`,
      });
    }
  }

  return {
    // In the transaction that ends the turn, so neither stands without the other. `reply` is
    // absent when the turn had nothing to say. An internal event's reply is pushed only as the
    // sentence of a result; its level is the event's, never the reply's (§2.1).
    finalReply(inbound: MessageRow, reply: MessageRow | undefined, options: { supplementRun?: boolean; turnMessageId?: string } = {}): void {
      if ((inbound.channel === CHANNEL || inbound.channel === 'weixin') && reply) {
        enqueue(reply.text, { channel: inbound.channel, target: replyTarget(inbound), projectId: inbound.project_id, key: `reply:${inbound.id}` });
      } else if (inbound.channel === 'internal' && reply && reply.text.trim()) {
        // The result was made at settlement, in the service's words; the Router's sentence only
        // takes their place while it has not gone out (§2.1). Only the first message of a merged
        // turn does this: an event taken with it keeps its own sentence.
        if (options.supplementRun !== false) {
          const run = /^run:([^:]+)$/.exec(inbound.external_id)?.[1];
          if (run !== undefined) ledger.supplementResult(`work-ready:${run}`, sentence(reply.text));
        }
        // Subscriptions that rode on this message and asked for the final reply or group broadcast (docs/design/triggers.md §2.3, §8).
        const alreadyBroadcast = pushTriggerNotice(inbound, (fire) => `${fireNoun(fire)}“${fire.trigger_name}”这一次的结果：\n\n${reply.text}`);
        broadcastTaskClosure(inbound, reply.text, options.turnMessageId ?? inbound.id, alreadyBroadcast);
      } else if (inbound.channel === TRIGGER_CHANNEL && reply && reply.text.trim()) {
        // Only for a trigger that asked for it when the occurrence was accepted, once per message
        // (docs/design/triggers.md §8). What the turn started reports its results the usual way.
        pushTriggerNotice(inbound, (fire) => `${fireNoun(fire)}“${fire.trigger_name}”这一次的结果：\n\n${reply.text}`);
      }
    },

    // §5.1: not redelivered; the owner sees what stands and decides. The Console shows
    // this by itself, and an internal event has nobody waiting on it. `committedBy`: the message
    // whose committed operations describe the turn, when this one was taken with another (the
    // first of a merged turn); the audit rows hang on that one.
    unverified(message: MessageRow, options: { committedBy?: string } = {}): void {
      const done = ledger.listChanges({ messageId: options.committedBy ?? message.id }).map(({ action }) => ACTION_TEXT[action] ?? action);
      const committed = done.length ? `已提交的操作如下：\n${done.map((each) => `- ${each}`).join('\n')}` : '没有已提交的操作。';
      if (message.channel === TRIGGER_CHANNEL || message.channel === 'internal') {
        // Said as it stands, under the key its final reply would have gone by (§8).
        const fires = ledger.triggerFiresOfMessage(message.id);
        if (fires.length > 0) {
          pushTriggerNotice(message, (fire) => `${fireNoun(fire)}“${fire.trigger_name}”这一次的处理未确认完成：回合没有正常结束。${committed}\n\n不会自动重做。`);
          return;
        }
        if (message.channel === 'internal') {
          const asked = message.text.slice(0, QUOTE_CHARS);
          enqueue(`一条内部事件处理未确认完成（${asked}）。${committed}\n\n不会自动重做，请到控制台查看并决定后续操作。`, {
            projectId: message.project_id,
            key: `unverified:${message.id}`,
          });
        }
        return;
      }
      if (message.channel !== CHANNEL && message.channel !== 'weixin') return;
      const asked = message.text.slice(0, QUOTE_CHARS);
      const content = `该请求未完成（${asked}）。${committed}\n\n不会自动重做，要不要重新下达由你决定。`;
      enqueue(content, { channel: message.channel, target: replyTarget(message), projectId: message.project_id, key: `unverified:${message.id}` });
    },

    routerHalted(reason: string): void {
      enqueue(`负责人已停摆，消息不再处理：${reason}`, { path: '/settings/router.cli' });
    },

    started(botId?: string): void {
      enqueue('服务已启动');
      if (botId) ledger.enqueueNotification(CHANNEL, 'project_menu', { external_id: 'project-menu:' + botId + ':' + owner() });
    },

    executorUpdated(machineId: string, executor: string, before: string | null, after: string | null): void {
      const fromText = before ?? '未知版本';
      const toText = after ?? '最新版';
      enqueue(`机器 ${machineId} 上的 ${executor} CLI 已自动更新：${fromText} → ${toText}`, {
        path: '/machines',
        key: `executor-updated:${machineId}:${executor}:${toText}`,
      });
    },

    // The one thing about machines the rules cannot handle: none left to continue on.
    // Once per stretch: the key carries when this one began.
    noMachine(loginId: string, since: string): void {
      ledger.enqueueNotification(CHANNEL, 'no_machine', { external_id: `no-machine:${loginId}:${since}`, login_id: loginId, login_name: loginDisplay(loginId), since });
    },

    // What a login's executor reports differently about its models. Once per login and
    // model, whatever becomes of the row: the Outbox's key is what makes it once.
    modelsAdded(loginId: string, model: ModelInfo): void {
      const name = loginDisplay(loginId);
      enqueue(modelsAddedText(name, model.id), { key: `models-added:${loginId}:${model.id}`, path: loginPage(name).path });
    },

    modelsGone(loginId: string, model: ModelInfo): void {
      const name = loginDisplay(loginId);
      enqueue(modelsGoneText(name, model.id), { key: `models-gone:${loginId}:${model.id}`, path: loginPage(name).path });
    },

    // Keyed by when the failure began: going bad again after a good backup is another
    // failure, on the same day too. A backup can fail because the ledger did, and then
    // queueing fails the same way.
    backupFailed(reason: string, lastOkAt: string | null, failedAt: string): void {
      const content = `自动备份失败：${reason}。上次成功：${lastOkAt ? fullTime(lastOkAt) : '从未'}`;
      try {
        enqueue(content, { key: `backup-failed:${failedAt}`, path: BACKUP_PAGE });
      } catch {
        direct(present.text(null, content, BACKUP_PAGE)).catch((err: unknown) => {
          log(`备份失败通知发送失败：${String(err)}`);
        });
      }
    },

    // Entering degraded mode cannot be queued: queueing is the write that fails.
    checkHealth(): void {
      const now = ledger.dispatchConditions().degraded;
      if (now === degraded) return;
      degraded = now;
      if (!now) {
        enqueue('服务已从降级模式恢复');
        return;
      }
      direct(present.text(null, '服务进入降级模式：账本写不进去，已停止派发', '/')).catch((err: unknown) => {
        log(`降级通知发送失败：${String(err)}`);
      });
    },

    skipReason,

    // What goes out without the Outbox, a card made elsewhere: the same mark and way to the page.
    card: (projectId: string | null, template: TemplateCard, path: string): TemplateCard => present.card(projectId, template, path),

    // The inbound message a row answers, if it is the end of a reply.
    answers(row: OutboxRow): string | undefined {
      const { external_id: key } = JSON.parse(row.payload_json) as { external_id?: string };
      return /^(?:reply|unverified):(.+)$/.exec(key ?? '')?.[1];
    },

    // Rendered as it goes out: a question answered in the meantime needs no card.
    render(row: OutboxRow): Outgoing | undefined {
      if (skipReason(row)) return undefined;
      const payload = JSON.parse(row.payload_json) as Record<string, any>;
      const toOwner = (body: WecomBody): Outgoing => ({ target: ownerChat(), body });
      switch (row.kind) {
        case 'project_menu':
          return toOwner({ msgtype: 'template_card', template_card: {
            card_type: 'button_interaction', task_id: 'tycho_project_menu',
            main_title: { title: 'Tycho 项目' }, sub_title_text: '点下面的按钮，选择要对话的项目。',
            button_list: [{ text: '选项目', style: 1, key: 'project-menu:open' }],
          } });
        case 'markdown': {
          const rawTarget = (payload.target as WecomTarget | undefined) ?? ownerChat();
          const target: WecomTarget = row.channel === 'weixin' && rawTarget.chatid.startsWith('weixin:')
            ? { ...rawTarget, chat_type: SINGLE }
            : rawTarget;
          const isGroup = target.chat_type === GROUP;
          return { target, body: markdown(payload.project_id, payload.content, payload.path ?? '/', !isGroup) };
        }
        case 'account_credential_rejected':
          return toOwner(markdown(null, `账号 ${loginDisplay(payload.account_id, payload.account_name)} 的登录失效，${ACCOUNT_LOGIN_FIX}`, '/accounts'));
        case 'machine_login_refused':
          return toOwner(markdown(null, machineLoginRefusedText(loginDisplay(payload.login_id, payload.login_name)), '/machines'));
        case 'account_expiry':
          return toOwner(markdown(null, expiryText(payload), '/accounts'));
        case 'no_machine':
          return toOwner(markdown(null, `${loginName(loginDisplay(payload.login_id, payload.login_name))} 没有可用的机器。排在它上面的任务会一直等，加上机器或让机器恢复后自动继续`, '/machines'));
        case 'approval': {
          const approval = ledger.getApprovalCard(payload.approval_id);
          if (approval?.state !== 'open') return undefined;
          const single = (JSON.parse(approval.questions_json) as unknown[]).length === 1;
          const hint = single ? `也可以回复“答 ${shortCode(approval.id)} <序号或答复>”` : undefined;
          return toOwner(card(approval.project_id, questionCard(approval, hint, pageUrl(`/task/${approval.task_id}`)), `/task/${approval.task_id}`));
        }
        case 'approval_closed':
          return toOwner(markdown(taskProject(payload.task_id), `问题已关闭：${taskTitle(payload.task_id)}`, `/task/${payload.task_id}`));
        case 'approval_answered':
          return toOwner(markdown(taskProject(payload.task_id), answeredText(payload.approval_id), `/task/${payload.task_id}`));
        case 'verify':
          return toOwner(markdown(taskProject(payload.task_id), verifyText(payload.task_id), `/task/${payload.task_id}`));
        case 'trigger_problem':
          return toOwner(markdown(payload.project_id, triggerProblemText(payload, false), triggerProblemPath(payload)));
        case 'held':
          return toOwner(markdown(taskProject(payload.task_id), `任务停住了，要你处理：${taskTitle(payload.task_id)}${payload.reason ? `（${payload.reason}）` : ''}`, `/task/${payload.task_id}`));
        // Only the two kinds that wait for the owner's say are pushed (knowledge-and-skills.md §3):
        // a summary and the way to the page, where it is decided. One decided meanwhile needs none.
        case 'knowledge_proposal': {
          if (ledger.getProposal(payload.proposal_id).state !== 'awaiting_owner') return undefined;
          return toOwner(card(present.proposalProject(payload.proposal_id), knowledgeCard(knowledgeAskOf(ledger, payload.proposal_id), base() || undefined), `/knowledge/proposals/${payload.proposal_id}`));
        }
        case 'work_ready':
        case 'merged':
        case 'integrated':
        case 'released':
          return toOwner(markdown(taskProject(payload.task_id), resultText(row.kind, payload), resultPath(row.kind, payload)));
        case 'results': {
          const items = payload.items as { kind: string; payload: Record<string, any> }[];
          const lines = items.map((item) => `- ${resultText(item.kind, item.payload)}`);
          return toOwner(markdown(payload.project_id, `这段时间有 ${items.length} 项成果：\n${lines.join('\n')}`, payload.project_id ? `/projects/${payload.project_id}` : '/'));
        }
        case 'remind': {
          // skipReason has asked the ledger whether it still waits.
          const about = remindText(payload.kind, payload.payload);
          if (!about) return undefined;
          return toOwner(markdown(payload.project_id, `再次提醒（${payload.n}/${payload.of}）：${about.text}`, about.path));
        }
        case 'brief':
          return toOwner(markdown(null, `每日简报\n${(payload.lines as string[]).join('\n')}`, '/overview'));
        case 'assign': {
          const message = ledger.getMessage(payload.message_id);
          const candidates = JSON.parse(message.candidates_json ?? '{"reason":"none","projects":[]}') as Candidates;
          const code = shortCode(message.id);
          const target = replyTarget(message);
          const isGroup = target.chat_type === GROUP;
          if (candidates.projects.length === 0) {
            return {
              target,
              body: markdown(null, `已记下这条消息，但还没有任何项目：先到控制台新建一个，再回复“归 ${code} <项目名>”`, '/projects', !isGroup),
            };
          }
          const projects = candidates.projects.map((id) => ({ id, name: projectName(id) ?? id }));
          return { target, body: card(null, assignCard({ id: message.id, code, text: message.text, reason: candidates.reason, projects }, isGroup ? undefined : pageUrl('/')), '/', !isGroup) };
        }
        default:
          throw new Error(`不认识的出站类型：${row.kind}`);
      }
    },
  };
}

export type Notify = ReturnType<typeof createNotify>;
