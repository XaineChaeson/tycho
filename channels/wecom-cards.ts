import type { Question } from '../service/ledger.ts';
import { CANDIDATE_REASON_TEXT } from '../shared/labels.ts';
import type { ApprovalCard } from '../service/messages.ts';

// The card type allows six buttons, and one of them is "其他…".
const MAX_OPTIONS = 5;
const BUTTON_CHARS = 10;
const BODY_CHARS = 300;
const STYLE_RECOMMENDED = 1;
const STYLE_PLAIN = 2;
const FALLBACK_TITLE = '问题';
const EVENT_KEY = /^approval:([^:]+):(?:q0:(\d+)|other)$/;

export interface TemplateCard {
  card_type: 'button_interaction';
  task_id: string;
  main_title: { title: string };
  sub_title_text: string;
  button_list: { text: string; style: number; key: string; type?: 1; url?: string }[];
  // Pressing the card anywhere but a button opens this page.
  card_action?: { type: 1; url: string };
}

export interface Press {
  approvalId: string;
  // Absent for the button that sends the owner to the Console.
  option?: number;
}

type Asked = Pick<ApprovalCard, 'id' | 'task_title' | 'questions_json'>;
type Decided = Pick<ApprovalCard, 'id' | 'task_title' | 'answered_via'>;

const clip = (text: string, chars: number, tail = '…'): string =>
  text.length > chars ? `${text.slice(0, chars)}${tail}` : text;

// WeCom ties an update to the card it replaces by this id.
const taskId = (approvalId: string): string => `approval_${approvalId}`;
const questionsOf = ({ questions_json }: Pick<ApprovalCard, 'questions_json'>): Question[] =>
  JSON.parse(questions_json) as Question[];

export function parseEventKey(key: unknown): Press | undefined {
  const match = typeof key === 'string' ? EVENT_KEY.exec(key) : null;
  if (!match) return undefined;
  return { approvalId: match[1]!, ...(match[2] === undefined ? {} : { option: Number(match[2]) }) };
}

export function optionOf(approval: Pick<ApprovalCard, 'questions_json'>, index: number): string | undefined {
  const questions = questionsOf(approval);
  return questions.length === 1 ? questions[0]!.options?.[index] : undefined;
}

function singleBody({ question, about, options = [] }: Question): string {
  const lines = about ? [question, about] : [question];
  // A clipped button still has to be readable before anyone presses it.
  if (options.some((option) => option.length > BUTTON_CHARS)) {
    lines.push(...options.map((option, index) => `${index + 1}. ${option}`));
  }
  if (options.length > MAX_OPTIONS) lines.push(`另有 ${options.length - MAX_OPTIONS} 个选项，到 Console 回答`);
  return lines.join('\n');
}

const multiBody = (questions: Question[]): string =>
  [...questions.map(({ question }, index) => `${index + 1}. ${question}`), `共 ${questions.length} 题，到 Console 回答`].join('\n');

// A sheet is accepted whole or not at all, so a press can only ever answer a
// one-question Approval; several questions get the way to the Console and nothing else.
export function questionCard(approval: Asked, hint?: string, publicUrl?: string): TemplateCard {
  const questions = questionsOf(approval);
  const single = questions.length === 1 ? questions[0] : undefined;
  const options = single?.options ?? [];
  const labels = options.slice(0, MAX_OPTIONS).map((option) => clip(option, BUTTON_CHARS));
  const ambiguous = new Set(labels).size !== labels.length;
  const body = clip(single ? singleBody(single) : multiBody(questions), BODY_CHARS, '…（全文到 Console 看）');
  return {
    card_type: 'button_interaction',
    task_id: taskId(approval.id),
    main_title: { title: approval.task_title },
    sub_title_text: hint ? `${body}\n${hint}` : body,
    button_list: [
      ...(ambiguous ? [] : labels).map((label, index) => ({
        text: label,
        style: index === single?.recommend ? STYLE_RECOMMENDED : STYLE_PLAIN,
        key: `approval:${approval.id}:q0:${index}`,
      })),
      {
        text: options.length > 0 && !ambiguous ? '其他…' : '到 Console 回答',
        style: STYLE_PLAIN,
        key: `approval:${approval.id}:other`,
        ...(publicUrl ? { type: 1 as const, url: publicUrl } : {}),
      },
    ],
  };
}

// Replacing a card is what takes its buttons away, for every kind of card. The one left only
// shows where things stand, under the card's own id, and its one key parses to nothing.
function settledCard({ id, title, text, status, key }: { id: string; title: string; text: string; status: string; key: string }): TemplateCard {
  return {
    card_type: 'button_interaction',
    task_id: id,
    main_title: { title },
    sub_title_text: text,
    button_list: [{ text: status, style: STYLE_PLAIN, key }],
  };
}

const resultCard = (approvalId: string, title: string, text: string, status: string): TemplateCard =>
  settledCard({ id: taskId(approvalId), title, text, status, key: `approval:${approvalId}:done` });

export const answeredCard = (approval: Pick<ApprovalCard, 'id' | 'task_title'>, choice: string): TemplateCard =>
  resultCard(approval.id, approval.task_title, `已回答：${choice}`, '已回答');

export const closedCard = (approval: Decided): TemplateCard =>
  resultCard(
    approval.id,
    approval.task_title,
    approval.answered_via ? `问题已关闭，已在 ${approval.answered_via} 回答` : '问题已关闭',
    '已关闭',
  );

export const unavailableCard = (approvalId: string, title: string = FALLBACK_TITLE): TemplateCard =>
  resultCard(approvalId, title, '暂时无法记录，请稍后在 Console 回答', '未记录');

export const missingCard = (approvalId: string): TemplateCard =>
  closedCard({ id: approvalId, task_title: FALLBACK_TITLE, answered_via: null });

// --- a machine asking to join (docs/design/nodes.md §1.1 step 2) ----------------------

const JOIN_KEY = /^join:([0-9a-f]{8,64}):(approve|reject)$/;

// What a card for a join says: the request it is about, by the request's own id, never by
// its six digits alone — a code is free again once its request is gone.
interface JoinAsk {
  id: string;
  code: string;
  name: string;
  platform: string;
}

export interface JoinPress {
  joinId: string;
  approve: boolean;
}

export function parseJoinKey(key: unknown): JoinPress | undefined {
  const match = typeof key === 'string' ? JOIN_KEY.exec(key) : null;
  return match ? { joinId: match[1]!, approve: match[2] === 'approve' } : undefined;
}

const joinTaskId = (joinId: string): string => `join_${joinId}`;
const JOIN_TITLE = '新机器请求加入';

export function joinCard(join: JoinAsk): TemplateCard {
  return {
    card_type: 'button_interaction',
    task_id: joinTaskId(join.id),
    main_title: { title: JOIN_TITLE },
    sub_title_text: clip(`机器 ${join.name}（${join.platform}）请求加入，号码 ${join.code}。只有你面前那台机器上显示着同样的数字时才放行。`, BODY_CHARS),
    button_list: [
      { text: '放行', style: STYLE_RECOMMENDED, key: `join:${join.id}:approve` },
      { text: '拒绝', style: STYLE_PLAIN, key: `join:${join.id}:reject` },
    ],
  };
}

// The card after a press: what happened, and a button that parses to nothing.
export const joinResultCard = (joinId: string, text: string, status: string): TemplateCard =>
  settledCard({ id: joinTaskId(joinId), title: JOIN_TITLE, text, status, key: `join:${joinId}:done` });

// --- a knowledge proposal (docs/design/knowledge-and-skills.md §3) -----------------------

const KNOWLEDGE_KEY = /^knowledge:([0-9A-Z]{26}):open$/;
const KNOWLEDGE_TITLE = '知识变更等你点头';

// What a card for a proposal says: a summary, and the way to the page where it is read in
// full and decided. Nothing on the card decides it: a global entry in particular is approved
// only after its full text, differences and evidence have been read.
export interface KnowledgeAsk {
  id: string;
  title: string;
  action: string;
  scope: string;
  // Why it waits for the owner (docs/design/knowledge-and-skills.md §3): the only cards there are.
  reasons: string[];
  proposedBy: string;
  evidence: number;
  verified: number;
  whenToUse: string;
}

export function parseKnowledgeKey(key: unknown): string | undefined {
  const match = typeof key === 'string' ? KNOWLEDGE_KEY.exec(key) : null;
  return match?.[1];
}

const knowledgeTaskId = (id: string): string => `knowledge_${id}`;

export function knowledgeCard(ask: KnowledgeAsk, publicUrl?: string): TemplateCard {
  const code = ask.id.slice(-4).toUpperCase();
  const lines = [
    ask.action,
    `${ask.scope} · 来自 ${ask.proposedBy} · 证据 ${ask.evidence} 条（已核实 ${ask.verified}）`,
    ask.whenToUse,
    ...ask.reasons.map((reason) => `要你点头：${reason}`),
    publicUrl ? '全文、差异和证据在控制台看' : `全文、差异和证据在控制台看，也可回复“同意知识 ${code}”或“驳回知识 ${code} <理由>”`,
  ];
  return {
    card_type: 'button_interaction',
    task_id: knowledgeTaskId(ask.id),
    main_title: { title: KNOWLEDGE_TITLE },
    sub_title_text: clip(lines.join('\n'), BODY_CHARS, '…（全文到控制台看）'),
    button_list: [{
      text: publicUrl ? '打开' : '到控制台的知识页看',
      style: STYLE_RECOMMENDED,
      key: `knowledge:${ask.id}:open`,
      ...(publicUrl ? { type: 1 as const, url: `${publicUrl.replace(/\/$/, '')}/#/knowledge/proposals/${ask.id}` } : {}),
    }],
  };
}

// The card once the proposal is no longer waiting: where it stands, and a key that parses to
// nothing.
export const knowledgeResultCard = (id: string, text: string, status: string): TemplateCard =>
  settledCard({ id: knowledgeTaskId(id), title: KNOWLEDGE_TITLE, text, status, key: `knowledge:${id}:done` });

// --- a message the front desk could not place (docs/design/project-sessions.md §2) ------

const ASSIGN_KEY = /^assign:([0-9A-Z]{26}):([0-9A-Z]{26})$/;
const ASSIGN_TITLE = '这条消息归哪个项目？';

interface AssignAsk {
  id: string;
  code: string;
  text: string;
  reason: string;
  projects: { id: string; name: string }[];
}

export interface AssignPress {
  messageId: string;
  projectId: string;
}

export function parseAssignKey(key: unknown): AssignPress | undefined {
  const match = typeof key === 'string' ? ASSIGN_KEY.exec(key) : null;
  return match ? { messageId: match[1]!, projectId: match[2]! } : undefined;
}

const assignTaskId = (messageId: string): string => `assign_${messageId}`;

// One button per candidate, up to what a card holds with the way to the console beside them; the
// numbered list and the typed form are there for all of them, and for the rest of the chat's
// waiting messages at once.
export function assignCard(ask: AssignAsk, consoleUrl?: string): TemplateCard {
  const shown = ask.projects.slice(0, MAX_OPTIONS);
  const lines = [
    `“${clip(ask.text, 40)}”`,
    `${CANDIDATE_REASON_TEXT[ask.reason] ?? ask.reason}。点项目归过去，或回复“归 ${ask.code} <序号>”；“全归 ${ask.code} <序号>”把这里待归属的都归过去`,
    ...ask.projects.map((project, index) => `${index + 1}. ${project.name}`),
  ];
  return {
    card_type: 'button_interaction',
    task_id: assignTaskId(ask.id),
    main_title: { title: ASSIGN_TITLE },
    sub_title_text: clip(lines.join('\n'), BODY_CHARS, '…（全部候选到控制台看）'),
    button_list: [
      ...shown.map((project, index) => ({ text: clip(project.name, BUTTON_CHARS), style: index === 0 ? STYLE_RECOMMENDED : STYLE_PLAIN, key: `assign:${ask.id}:${project.id}` })),
      { text: '到控制台归属', style: STYLE_PLAIN, key: `assign:${ask.id}:console`, ...(consoleUrl ? { type: 1 as const, url: consoleUrl } : {}) },
    ],
  };
}

// The card after a press: what happened, and a key that parses to nothing.
export const assignResultCard = (messageId: string, title: string, text: string, status: string): TemplateCard => ({
  card_type: 'button_interaction',
  task_id: assignTaskId(messageId),
  main_title: { title },
  sub_title_text: text,
  button_list: [{ text: status, style: STYLE_PLAIN, key: `assign:${messageId}:done` }],
});
