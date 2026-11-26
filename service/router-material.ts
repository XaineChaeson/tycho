// What a project's Router starts a new executor context from (docs/design/project-sessions.md
// §3): continuity lives in the ledger, not in a conversation's history, so a context that is
// new is handed the project as the ledger holds it. Facts are given as they are — the owner's
// words, ids, revisions and registration numbers; a summary is only an index. The owner's limit
// (router.materialKb) is on the whole material: what does not fit is not dropped silently, the
// material says which tool reads the rest.
import type { VerdictRecord } from '../shared/review.ts';
import type { Ledger } from './ledger.ts';
import type { MessageRow } from './messages.ts';
import { routerKnowledge } from './knowledge-brief.ts';
import { entryText } from './knowledge-brief.ts';
import { parseReviewOf } from './review.ts';

const MATERIAL_PREFIX = '[tycho 内部事件]';
const ENDED = new Set(['done', 'abandoned']);
// The most requests one page of list_open_requests or list_unverified_requests gives.
export const OPEN_REQUESTS_PAGE = 50;
// What is kept back for the lines that say where to read what did not fit.
const POINTER_ROOM = 1200;

type MaterialLedger = Pick<Ledger, 'getProject' | 'listTasks' | 'listRuns' | 'listInputs' | 'listApprovals' | 'artifactsOfRun' | 'listChanges'
  | 'openRequests' | 'taskOwnerRequests' | 'unverifiedRequests' | 'applicable' | 'currentSegment' | 'getAccount' | 'listMachineLogins'
  | 'reviewGate' | 'activeReview'> & Partial<Pick<Ledger, 'listProjectBroadcastGroups' | 'listRecentResumableTasks' | 'hostVersionState'>>;

export interface Material {
  text: string;
  // The resident knowledge revisions in force for the context (what a change of means a new one).
  knowledge: string[];
  // Whether anything did not fit, and the material says where to read it.
  more_requests: boolean;
}

const bytes = (text: string): number => Buffer.byteLength(text, 'utf8');

export const requestView = ({ id, at, channel, actor, state, text }: MessageRow) => ({ id, at, channel, actor, state, text });

// One part of the material: a heading, its items in order, and what reads the ones left out.
interface Part {
  heading: string;
  items: Iterable<string>;
  rest: string;
}

export function routerMaterial(ledger: MaterialLedger, projectId: string, limitBytes: number): Material {
  const project = ledger.getProject(projectId);
  const entries = ledger.applicable(projectId, null);
  const hostVersion = ledger.hostVersionState?.() ?? null;
  const knowledge = routerKnowledge(entries, { hostVersion });
  const segment = ledger.currentSegment(projectId);
  const loginName = (id: string | null, snapshot: string | null = null): string | null => id === null ? snapshot
    : ledger.getAccount(id)?.name ?? ledger.listMachineLogins().find((login) => login.id === id)?.name ?? snapshot ?? '（已删除的登录）';

  const tasks = function* () {
    for (const task of ledger.listTasks({ projectId }).filter(({ state }) => !ENDED.has(state))) {
      const runs = ledger.listRuns(task.id);
      const last = runs.at(-1);
      const held = last === undefined ? undefined : ledger.artifactsOfRun(last.id);
      const reviewOf = parseReviewOf(task.review_of_json);
      const verdict = task.verdict_json === null ? null : (JSON.parse(task.verdict_json) as VerdictRecord);
      yield JSON.stringify({
        id: task.id, title: task.title, state: task.state, reason: task.reason, revision: task.revision,
        parent_id: task.parent_id,
        role_id: task.role_id, tier: task.tier, login_id: loginName(task.login_id),
        ...(reviewOf === null ? {} : { review_of: { task_id: reviewOf.task_id, run_id: reviewOf.run_id } }),
        ...(verdict === null ? {} : { verdict: { result: verdict.result, current: verdict.current } }),
        ...(task.state === 'ready' ? { active_review: ledger.activeReview(task.id)?.id ?? null, accept_blocked: ledger.reviewGate(task.id) } : {}),
        running: runs.filter(({ state }) => state !== 'ended').map(({ id, state, host, login_id, login_name, started_at }) => ({ id, state, host, login_id: loginName(login_id, login_name), started_at })),
        ...(held?.registration ? { registration: { run_id: held.run_id, ...held.registration } } : {}),
        owner_requests: ledger.taskOwnerRequests(task.id).map(requestView),
        open_questions: ledger.listApprovals(task.id).filter(({ state }) => state === 'open')
          .map(({ id, questions_json }) => ({ id, questions: JSON.parse(questions_json) as unknown })),
        undelivered_inputs: ledger.listInputs(task.id).filter(({ state }) => state === 'queued').map(({ id, text, created_at }) => ({ id, text, at: created_at })),
      });
    }
  };
  // Paged straight from the ledger, oldest first: however long ago, none is left out unsaid.
  const paged = function* (read: (after: string | undefined) => MessageRow[], view: (row: MessageRow) => unknown) {
    let after: string | undefined;
    for (;;) {
      const page = read(after);
      for (const row of page) yield JSON.stringify(view(row));
      if (page.length < OPEN_REQUESTS_PAGE) return;
      after = page.at(-1)!.id;
    }
  };
  const committed = (row: MessageRow) => ({
    ...requestView(row),
    committed: ledger.listChanges({ messageId: row.id }).filter(({ action }) => !action.startsWith('message.')).map(({ action, task_id, at }) => ({ action, task_id, at })),
  });
  const resident = entries.filter(({ state, roles, loading }) => state === 'active' && roles.length === 0 && loading === 'resident');

  const broadcastGroups = ledger.listProjectBroadcastGroups?.(projectId) ?? [];
  const recentResumable = ledger.listRecentResumableTasks?.(projectId, 8) ?? [];
  const head = `${MATERIAL_PREFIX} 项目“${project.name}”（${project.id}）新上下文${segment ? `（第 ${segment.seq} 段）` : ''}。以下为从账本重建的恢复资料（非新指令，无需回复）；owner_requests 为关联的主人原话，勿重复已提交操作。`;
  const parts: Part[] = [
    ...(broadcastGroups.length > 0
      ? [{
        heading: '## 绑定播报群聊（可用 post_group_update）',
        items: broadcastGroups.map(({ channel, chat_id, chat_name }) => JSON.stringify({ channel, chat_id, chat_name })),
        rest: '其余群聊见控制台项目设置',
      }]
      : []),
    { heading: '## 常驻知识', items: resident.map((entry) => entryText(entry)), rest: '其余常驻条目用 get_working_context 或 read_library 读' },
    { heading: '## 未结束任务', items: tasks(), rest: '其余未结束任务用 list_tasks（next 填 after）或 get_task 读' },
    ...(recentResumable.length > 0
      ? [{
        heading: '## 近期可续接线程（done，保留原会话，可用 continue_task 续跑）',
        items: recentResumable.map((item) => JSON.stringify(item)),
        rest: '其余已完成任务用 list_tasks（states 填 ["done"]）查',
      }]
      : []),
    {
      heading: '## 待核实请求（已提交操作见 committed）',
      items: paged((after) => ledger.unverifiedRequests(projectId, { ...(after === undefined ? {} : { after }), limit: OPEN_REQUESTS_PAGE }), committed),
      rest: '其余待核实请求用 list_unverified_requests 续读',
    },
    {
      heading: '## 未闭合主人要求',
      items: paged((after) => ledger.openRequests(projectId, { ...(after === undefined ? {} : { after }), limit: OPEN_REQUESTS_PAGE }), requestView),
      rest: '其余未闭合要求用 list_open_requests 续读',
    },
    { heading: '', items: knowledge.catalog === '' ? [] : [knowledge.catalog], rest: '按需条目目录用 get_working_context 读' },
  ];

  const chunks: string[] = [head];
  const pointers: string[] = [];
  let used = bytes(head) + POINTER_ROOM;
  for (const part of parts) {
    let shown = 0;
    let lastShown: string | undefined;
    let first = true;
    for (const item of part.items) {
      const piece = `${first && part.heading !== '' ? `\n\n${part.heading}\n` : '\n'}${item}`;
      if (used + bytes(piece) > limitBytes) {
        // Where to go on from: the id of the last one shown, when the items have one.
        const after = lastShown === undefined ? undefined : (/"id":"([^"]+)"/.exec(lastShown)?.[1]);
        pointers.push(`${part.rest}${after ? `（after 填 ${after}）` : ''}。`);
        break;
      }
      chunks.push(piece);
      used += bytes(piece);
      shown += 1;
      lastShown = item;
      first = false;
    }
    void shown;
  }
  const tail = pointers.length === 0 ? '' : `\n\n## 超限未列出部分（按以下工具续读）\n${pointers.map((each) => `- ${each}`).join('\n')}`;
  let text = `${chunks.join('')}${tail}`;
  // The pointers are short, but the room kept for them is a guess: never past the limit.
  if (bytes(text) > limitBytes) text = Buffer.from(text, 'utf8').subarray(0, limitBytes).toString('utf8').replace(/�+$/, '');
  return { text, knowledge: knowledge.resident, more_requests: pointers.length > 0 };
}
