// Guards the knowledge pages (docs/design/knowledge-and-skills.md §2, §3, §5.2) against:
// - the parts of the list page (待处理, 条目, 提议, 接入): what waits for the owner not counted on
//   its tab; a part not reached by its address; nothing waiting passed over in silence;
// - the list: a change waiting for the owner's say not set apart, or shown without why it
//   waits; a change in force unreviewed missing from 待阅, or shown without its scope, loading
//   and how much of its evidence was checked; 标已审阅 / 退役 from 待阅 sending the wrong request,
//   a retire sent on the first press or against another revision; 直接改 or 退役 offered for a
//   change with several outputs, where only its own page can say which; entries not grouped by
//   their set of projects, 全局 not first, without loading or review state, or a retired entry
//   passed off as one in force;
// - a change's page: inputs without the revision they pinned, where they go, or the warning
//   that one has moved since; outputs without their text, scope, loading or what they revise;
//   a revision's diff against anything but the revision its input pinned; the lines a change
//   drops, or how each project and role's input grows or shrinks, left out; the gate's verdict,
//   that it changed the change, or an earlier rejection of the same content, left out;
// - deciding: 同意 offered on anything but a change waiting for the owner, or enabled before the
//   owner says they read it all; a decision sent without the digest of what takes effect; a
//   reject that drops its note; a refused decision that says nothing in the service's words or
//   leaves the page on the old state; a superseded change that does not lead to the next one;
// - the owner's own changes: a new entry or a direct edit sent without a chosen scope and
//   loading, the three answers or evidence; a retry after a refusal sent under a new request id,
//   or losing the draft; an edit not sent as a revision of the revision in force; an amend that
//   pins its inputs to anything but the revision in force now, or leaves the owner on the
//   change it superseded;
// - evidence without its own 已核实 / 提交者提供，未核对原记录 mark;
// - a history citation opening the latest content instead of the requested revision;
// - old rulings the upgrade could not turn into proposals sitting there unseen, or shown without
//   their text, project or the reason (project-sessions §6);
// - knowledge MCP clients: issued without an executor; a token not shown when issued, or still
//   on the page once put away; a revoke sent on the first press;
// - skills (§8 step 3): listed among knowledge, or with a loading they do not have; the owner's
//   own skill not starting from its template, offered a loading, or sent as knowledge; the old
//   skill files imported without a preview first, or without saying what became of each.
import { screen, waitFor, within } from '@testing-library/react';
import { expect, test } from 'vitest';
import { OWNER_REASON_LABELS, SKILL_TEMPLATE, UNVERIFIED_TEXT, VERIFIED_TEXT, WHY_QUESTIONS } from '@shared/knowledge.ts';
import { holdClock, open, pass, refusal, type Call, type Handler } from '@/test/harness';
import type {
  ChangeInput, ChangeOutput, KnowledgeChange, KnowledgeClient, KnowledgeEntry, KnowledgeEvidence, KnowledgeProposal, KnowledgeProposalPage, KnowledgeRevision,
  LegacyDecision,
} from '@/lib/types';

const AT = '2026-11-09T01:00:00Z';
const PROJECTS = [{ id: 'p1', name: 'QL' }, { id: 'p2', name: 'tycho' }, { id: 'p3', name: '空项目' }];
const ROLES = [{ id: 'implement', name: '实现' }, { id: 'analyse', name: '分析' }];
const EXECUTORS = ['claude', 'codex'];

const revision = (over: Partial<KnowledgeRevision>): KnowledgeRevision => ({
  id: 'k', revision: 1, kind: 'knowledge', title: '', when_to_use: '', body: '', project_ids: null, loading: 'on_demand', roles: [],
  proposal_id: 'p0', published_by: 'console', published_at: AT, reviewed_at: null, ...over,
});
const entry = (over: Partial<KnowledgeEntry>): KnowledgeEntry => ({
  ...revision(over), created_at: AT, state: 'active', retired_at: null, retired_by: null, retired_reason: null, replaced_by: null, ...over,
});
const evidence = (over: Partial<KnowledgeEvidence>): KnowledgeEvidence => ({
  id: 'ev', proposal_id: 'pr', seq: 1, source: 'run', ref: 'r-7', location: '回执的 learned', excerpt: '检查了三次才交',
  captured_at: AT, sha256: 'abcdef0123456789abcdef0123456789', submitted_by: 'laptop', verified: true, ...over,
});
const output = (over: Partial<ChangeOutput>): ChangeOutput => ({
  key: 'o1', revises: null, title: '候选', when_to_use: '什么时候', body: '正文', project_ids: null, loading: 'on_demand', roles: [], ...over,
});
const input = (over: Partial<ChangeInput> & { knowledge_id: string; revision: number }): ChangeInput => ({ active: true, disposition: 'keep', replaced_by: null, note: '', ...over });
const change = (outputs: ChangeOutput[], inputs: ChangeInput[] = []): KnowledgeChange => ({ kind: 'knowledge', inputs, outputs });
const WHY = { when: '答应了检查的时候', changes: '先查再说做完', generalizes: '三次复盘都一样；只限交付' };
const proposal = (over: Partial<KnowledgeProposal> & { id: string }): KnowledgeProposal => ({
  created_at: AT, kind: 'knowledge', change: change([output({})]), final: null, why: WHY, source: 'console', proposed_by: 'console',
  request_id: null, task_id: null, run_id: null, amended_from: null, next_id: null, digest: `digest-${over.id}`, final_digest: null,
  prior_rejection: null, gate_task_id: null, gate: null, owner_reasons: [], state: 'published', state_reason: null, decided_at: null,
  decided_by: null, decided_via: null, decision_note: null, published_at: null, reviewed_at: null, reviewed_by: null,
  evidence: [evidence({ proposal_id: over.id })], ...over,
});
const passed = (taskId: string, reason: string, modified = false) => ({ result: 'pass' as const, reason, modified, task_id: taskId, run_id: `run-${taskId}` });

const K1 = entry({ id: 'k1', revision: 2, title: '承诺与检查', when_to_use: '答应了要检查的事', body: '先说结论\n检查一次\n边界：只限交付', loading: 'resident', reviewed_at: AT, proposal_id: 'p-old' });
const K2 = entry({ id: 'k2', revision: 1, title: '差距分解', when_to_use: '性能差距', body: '分解再说', project_ids: ['p1'], roles: ['analyse'], proposal_id: 'pb' });
const K3 = entry({ id: 'k3', revision: 3, title: '旧的基准规则', state: 'retired', retired_at: AT, retired_by: 'console', retired_reason: '被取代', replaced_by: 'k4', reviewed_at: AT });
const K4 = entry({ id: 'k4', revision: 1, title: '跨项目的基准', project_ids: ['p1', 'p2'], proposal_id: 'pc' });
const K5 = entry({ id: 'k5', revision: 1, title: '基准的边界', project_ids: ['p1'], proposal_id: 'pc' });

const REVISE_K1 = [input({ knowledge_id: 'k1', revision: 2, disposition: 'revise' })];
const k1Output = (body: string) => output({ revises: 'k1', title: '承诺与检查', when_to_use: '答应了要检查的事', body, loading: 'resident' });
// Waits for the owner: global and resident, and it revises an entry the owner reviewed.
const PA = proposal({
  id: 'pa', state: 'awaiting_owner', source: 'mcp', proposed_by: 'laptop',
  change: change([k1Output('先说结论\n检查五次\n边界：只限交付')], REVISE_K1),
  final: change([k1Output('先说结论\n检查三次\n边界：只限交付')], REVISE_K1),
  final_digest: 'final-pa', owner_reasons: ['global_resident', 'owner_entry'],
  gate_task_id: 't-gate-a', gate: passed('t-gate-a', '证据撑得住三次，五次写过头了', true),
  prior_rejection: { id: 'pe', reason: '只改了措辞', rejected_at: AT },
  evidence: [
    evidence({ id: 'ev1', proposal_id: 'pa', seq: 1 }),
    evidence({ id: 'ev2', proposal_id: 'pa', seq: 2, source: 'conversation', ref: null, location: '11-08 的对话', excerpt: '主人说：再查一遍', verified: false }),
  ],
});
const PB_CHANGE = change([output({ title: '差距分解', when_to_use: '性能差距', body: '分解再说', project_ids: ['p1'], roles: ['analyse'] })]);
// Published, the change names the entry each output became.
const PB = proposal({ id: 'pb', source: 'worker', proposed_by: 'run-7', change: PB_CHANGE, final: { ...PB_CHANGE, outputs: PB_CHANGE.outputs.map((each) => ({ ...each, knowledge_id: 'k2' })) }, final_digest: 'final-pb', gate_task_id: 't-gate-b', gate: passed('t-gate-b', '新的、证据够'), published_at: AT });
const PC_CHANGE = change(
  [output({ key: 'o1', title: '跨项目的基准', project_ids: ['p1', 'p2'] }), output({ key: 'o2', title: '基准的边界', project_ids: ['p1'] })],
  [input({ knowledge_id: 'k3', revision: 3, disposition: 'replaced', replaced_by: 'o1' })],
);
const PC = proposal({ id: 'pc', source: 'curation', proposed_by: 'curation', change: PC_CHANGE, final: PC_CHANGE, final_digest: 'final-pc', gate: passed('t-gate-c', '拆得对'), published_at: AT });
const PD = proposal({ id: 'pd', state: 'gating', source: 'router', proposed_by: 'router', change: change([output({ title: '先给结论' })]), gate_task_id: 't-gate-d' });
const PE = proposal({ id: 'pe', state: 'rejected', change: change([output({ title: '换个说法' })]), gate: { ...passed('t-gate-e', '只改了措辞'), result: 'reject' } });
const PF = proposal({ id: 'pf', state: 'superseded', next_id: 'pd', change: change([output({ title: '先给结论（旧）' })]) });

const IMPACT: Record<string, KnowledgeProposalPage['impact']> = {
  pa: {
    kind: 'forecast',
    dropped: [{ knowledge_id: 'k1', title: '承诺与检查', disposition: 'revise', lines: ['检查一次'] }],
    combos: [{ project_id: 'p1', project: 'QL', role_id: 'analyse', role: '分析', before: { brief: 2048, files: 0 }, after: { brief: 3072, files: 512 } }],
  },
  pb: { kind: 'actual', dropped: [], combos: [{ project_id: 'p1', project: 'QL', role_id: 'analyse', role: '分析', before: { brief: 0, files: 0 }, after: { brief: 1024, files: 0 } }] },
};

const CLIENTS: KnowledgeClient[] = [
  { id: 'c1', created_at: AT, name: 'laptop', executor: 'claude', grants: ['read', 'propose'], revoked_at: null },
  { id: 'c2', created_at: AT, name: '旧电脑', executor: 'codex', grants: ['read'], revoked_at: AT },
];

type Store = { entries: KnowledgeEntry[]; proposals: KnowledgeProposal[]; clients: KnowledgeClient[]; legacy: LegacyDecision[] };

// The knowledge service as the pages see it, kept in step with what is sent to it. `answer`
// answers a change first: a refusal, or something of its own. `prepare` sets the store up.
function service(answer: (call: Call, store: Store) => unknown = () => undefined, prepare: (store: Store) => void = () => undefined): Handler {
  // A copy: what one test changes is not the next test's.
  const store: Store = structuredClone({ entries: [K1, K2, K3, K4, K5], proposals: [PA, PB, PC, PD, PE, PF], clients: CLIENTS, legacy: [] });
  prepare(store);
  const find = (id: string) => store.proposals.find((each) => each.id === id)!;
  const entryOf = (id: string) => store.entries.find((each) => each.id === id) ?? null;
  const pinned = (id: string, at: number) => {
    const fixture = [K1, K2, K3, K4, K5].find((each) => each.id === id);
    return fixture ? revision({ ...fixture, revision: at }) : null;
  };
  const summary = ({ evidence: items, ...rest }: KnowledgeProposal) => ({ ...rest, evidence_count: items.length, verified_count: items.filter((each) => each.verified).length });
  const publish = (body: Record<string, unknown>, extra: Partial<KnowledgeProposal>) => {
    const made = change(((body.outputs as Partial<ChangeOutput>[]) ?? []).map((each) => output(each)), (body.inputs as ChangeInput[] | undefined) ?? []);
    store.proposals.unshift(proposal({ id: 'px', change: made, final: made, final_digest: 'final-px', published_at: AT, reviewed_at: AT, evidence: [], ...extra }));
  };
  return (call) => {
    const [, , , kind, id, action] = call.path.split('?')[0]!.split('/');
    if (call.method !== 'GET') {
      const special = answer(call, store);
      if (special !== undefined) return special;
    }
    if (call.method === 'GET' && call.path === '/api/knowledge') {
      return {
        awaiting: store.proposals.filter((each) => each.state === 'awaiting_owner').map(summary),
        to_review: store.proposals.filter((each) => each.state === 'published' && each.reviewed_at === null).map(summary),
        proposals: store.proposals.map(summary),
        entries: store.entries, clients: store.clients, projects: PROJECTS, roles: ROLES, executors: EXECUTORS, legacy: store.legacy, skill_folder: '/data/skills',
      };
    }
    if (call.method === 'GET' && kind === 'proposals') {
      const found = find(id!);
      const shown = found.final ?? found.change;
      return {
        proposal: found,
        inputs: shown.inputs.map((each) => ({ ...each, pinned: pinned(each.knowledge_id, each.revision), now: entryOf(each.knowledge_id) })),
        impact: IMPACT[found.id] ?? { kind: 'forecast', dropped: [], combos: [] },
        ...(found.gate_task_id ? { gate_task: { id: found.gate_task_id, state: found.state === 'gating' ? 'running' : 'done', reason: null } } : {}),
      };
    }
    if (call.method === 'GET' && kind === 'entries') {
      const shown = entryOf(id!)!;
      const older = revision({ ...shown, revision: shown.revision - 1, body: '最早的说法', proposal_id: 'p-first', reviewed_at: null, published_at: '2026-11-01T00:00:00Z' });
      return {
        entry: shown,
        revisions: [
          { ...older, proposed_by: 'router', source: 'router', evidence: [evidence({ id: 'old', excerpt: '最早的证据' })] },
          { ...revision(shown), proposed_by: 'laptop', source: 'mcp', evidence: [evidence({ id: 'now', excerpt: '现在的证据' })] },
        ].filter((each) => each.revision > 0),
      };
    }
    if (call.method === 'GET' && kind === 'clients') return { token: `tk-${id}` };
    if (call.method === 'GET') return undefined;
    const body = call.body as Record<string, unknown>;
    if (kind === 'proposals' && action === 'decide') {
      const found = find(id!);
      Object.assign(found, { state: body.decision === 'approve' ? 'published' : 'rejected', decided_by: 'console', decided_via: 'console', decided_at: AT, decision_note: body.note ?? null });
      if (body.decision === 'approve') Object.assign(found, { published_at: AT, reviewed_at: AT });
      return { state: found.state };
    }
    if (kind === 'proposals' && action === 'review') {
      Object.assign(find(id!), { reviewed_at: AT, reviewed_by: 'console' });
      return { proposal: find(id!) };
    }
    if (kind === 'proposals' && action === 'amend') {
      Object.assign(find(id!), { state: 'superseded', next_id: 'px' });
      publish(body, { amended_from: id! });
      return { id: 'px' };
    }
    if (kind === 'proposals') {
      publish(body, {});
      return { id: 'px', duplicate: false, state: 'published' };
    }
    if (kind === 'entries' && action === 'retire') {
      Object.assign(entryOf(id!)!, { state: 'retired', retired_at: AT, retired_by: 'console', retired_reason: body.reason, replaced_by: body.replaced_by ?? null });
      return { entry: entryOf(id!) };
    }
    if (kind === 'clients' && action === 'revoke') {
      store.clients = store.clients.map((each) => (each.id === id ? { ...each, revoked_at: AT } : each));
      return { ok: true };
    }
    if (kind === 'clients') {
      const client = { id: 'c3', created_at: AT, name: body.name as string, executor: body.executor as string, grants: body.grants as KnowledgeClient['grants'], revoked_at: null };
      store.clients = [...store.clients, client];
      return { client, token: 'tk-issued-once' };
    }
    return undefined;
  };
}

const region = (name: string) => screen.findByRole('region', { name });
const hrefs = (where: HTMLElement) => within(where).getAllByRole('link').map((each) => each.getAttribute('href'));
// The page's parts, each an address of its own.
const tab = (name: string | RegExp) => within(screen.getByRole('navigation', { name: '知识的哪一部分' })).getByRole('link', { name });

test('what waits for the owner, what took effect unreviewed and every change are listed apart', async () => {
  const { user } = open('#/knowledge', service());
  const awaiting = await region('等你点头');
  // One waits for a say and two took effect unread: the part's tab says how many.
  expect(tab(/^待处理\s*3$/)).toHaveAttribute('aria-current', 'page');
  expect(hrefs(awaiting)).toEqual(['#/knowledge/proposals/pa']);
  for (const text of ['修订 承诺与检查', OWNER_REASON_LABELS.global_resident, OWNER_REASON_LABELS.owner_entry, '证据 2 条（已核实 1）']) expect(awaiting).toHaveTextContent(text);

  const review = await region('待阅');
  const pb = within(review).getByRole('listitem', { name: '新增 差距分解' });
  for (const text of ['项目 QL · 分析 · 按需', '证据 1 条（已核实 1）', '执行者回执 · run-7']) expect(pb).toHaveTextContent(text);
  const pc = within(review).getByRole('listitem', { name: '新增 跨项目的基准；新增 基准的边界；取代 旧的基准规则' });
  expect(pc).toHaveTextContent('项目 QL、tycho · 按需；项目 QL · 按需');
  expect(within(review).queryByRole('listitem', { name: /承诺与检查/ }), '等你点头的还没生效').toBeNull();

  await user.click(tab('提议'));
  expect(window.location.hash).toBe('#/knowledge?view=proposals');
  const all = await region('提议');
  expect(hrefs(all).map((each) => each!.split('/').at(-1))).toEqual(['pa', 'pb', 'pc', 'pd', 'pe', 'pf']);
  const row = (id: string) => within(all).getAllByRole('link').find((each) => each.getAttribute('href')!.endsWith(`/${id}`))!;
  expect(row('pa')).toHaveTextContent('等你点头');
  expect(row('pa')).toHaveTextContent('外部会话（知识 MCP） · laptop');
  expect(row('pc')).toHaveTextContent('整理任务');
  expect(row('pd')).toHaveTextContent('把关中');
  expect(row('pe')).toHaveTextContent('已驳回');
  expect(row('pf')).toHaveTextContent('已改成新候选');
});

test('from 待阅 a change is marked reviewed, edited on its entry, or its entry retired on the second press', async () => {
  const { user, calls } = open('#/knowledge', service());
  const review = await region('待阅');
  const pb = within(review).getByRole('listitem', { name: '新增 差距分解' });
  expect(within(pb).getByRole('link', { name: '直接改' })).toHaveAttribute('href', '#/knowledge/entries/k2?edit=1');
  // Several outputs: which entry to edit or retire is said on the change's own page.
  const pc = within(review).getByRole('listitem', { name: /跨项目的基准/ });
  expect(within(pc).queryByRole('link', { name: '直接改' })).toBeNull();
  expect(within(pc).queryByRole('button', { name: '退役' })).toBeNull();
  expect(within(pc).getByRole('link', { name: '到提议页处理' })).toHaveAttribute('href', '#/knowledge/proposals/pc');

  await user.click(within(pb).getByRole('button', { name: '退役' }));
  expect(calls).toEqual([]);
  const retiring = screen.getByRole('dialog', { name: '退役 差距分解' });
  const confirm = within(retiring).getByRole('button', { name: '确认退役' });
  expect(confirm, '退役理由选填，不填也可直接退役').toBeEnabled();
  await user.type(within(retiring).getByRole('textbox', { name: '退役理由' }), '只在一个任务里成立');
  await user.click(confirm);
  await waitFor(() => expect(calls).toEqual([{ path: '/api/knowledge/entries/k2/retire', method: 'POST', body: { reason: '只在一个任务里成立', revision: 1 } }]));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

  await user.click(within(pc).getByRole('button', { name: '标已审阅' }));
  await waitFor(() => expect(calls[1]).toEqual({ path: '/api/knowledge/proposals/pc/review', method: 'POST', body: {} }));
  await waitFor(() => expect(within(review).queryByRole('listitem', { name: /跨项目的基准/ })).toBeNull());
});

test('entries are grouped by their set of projects, 全局 first, each with its loading and quick preview drawer', async () => {
  const { user } = open('#/knowledge?view=entries', service());
  const library = await region('知识与技能目录');
  expect(tab('条目')).toHaveAttribute('aria-current', 'page');
  expect(within(library).getAllByRole('region').map((each) => each.getAttribute('aria-label')), '没有条目的项目不占一组').toEqual(['全局', '项目 QL', '项目 QL、tycho']);
  const k1 = within(within(library).getByRole('region', { name: '全局' })).getByRole('button', { name: /承诺与检查/ });
  for (const text of ['k1@2', '不限职能', '常驻', '已审阅']) expect(k1).toHaveTextContent(text);
  const k2 = within(within(library).getByRole('region', { name: '项目 QL' })).getByRole('button', { name: /差距分解/ });
  for (const text of ['k2@1', '分析', '按需', '未审阅']) expect(k2).toHaveTextContent(text);
  await user.click(within(within(library).getByRole('region', { name: '项目 QL、tycho' })).getByRole('button', { name: /跨项目的基准/ }));
  const drawer = await screen.findByRole('dialog');
  expect(within(drawer).getByRole('link', { name: /完整详情/ })).toHaveAttribute('href', '#/knowledge/entries/k4');
  await user.keyboard('{Escape}');
  expect(within(library).queryByRole('button', { name: /旧的基准规则/ })).toBeNull();
  expect(library).toHaveTextContent('另有 1 条已停用或退役');
  await user.click(within(library).getByRole('switch', { name: '显示已停用/退役' }));
  expect(within(within(library).getByRole('region', { name: '全局' })).getByRole('button', { name: /旧的基准规则/ })).toHaveTextContent('已退役');
});

test('a change\'s page shows its inputs and where they go, its outputs, the lines it drops and how each input grows', async () => {
  open('#/knowledge/proposals/pa', service());
  expect(await screen.findByRole('heading', { name: '承诺与检查', level: 1 })).toBeInTheDocument();
  const inputs = await region('输入');
  const k1 = within(inputs).getByRole('listitem', { name: '承诺与检查' });
  for (const text of ['k1@2', '修订']) expect(k1).toHaveTextContent(text);
  expect(k1).not.toHaveTextContent('这条已经变了');
  const outputs = await region('输出');
  const out = within(outputs).getByRole('article', { name: '承诺与检查' });
  for (const text of ['修订 k1', '全局 · 常驻', '不限职能', '检查三次']) expect(out).toHaveTextContent(text);
  // What takes effect is what the gate passed, not what was sent.
  expect(out).not.toHaveTextContent('检查五次');

  const dropped = await region('被删掉的条件');
  expect(dropped).toHaveTextContent('承诺与检查（修订）');
  expect(within(dropped).getByText('检查一次')).toBeInTheDocument();
  const combos = await region('输入的增减');
  const cells = within(within(combos).getAllByRole('row')[1]!).getAllByRole('cell').map((each) => each.textContent);
  expect(cells).toEqual(['QL', '分析', '2.0 KiB → 3.0 KiB', '0.0 KiB → 0.5 KiB']);
  // Still waiting, it is a forecast on today's entries, and says so.
  expect(combos).toHaveTextContent('当前影响预测');
});

// A change in force shows what its publication really did, read back from the revisions in force
// just before and just after it — not a forecast run again on today's entries.
test('a change in force shows its real before and after, a waiting one a forecast that says so', async () => {
  open('#/knowledge/proposals/pb', service());
  const combos = await region('输入的增减');
  expect(combos).toHaveTextContent('生效那一刻前后的真实大小');
  expect(combos).not.toHaveTextContent('当前影响预测');
});

test('a change\'s page shows the gate\'s verdict, that it changed what was sent, why it waits, and an earlier rejection of the same content', async () => {
  open('#/knowledge/proposals/pa', service());
  const gate = await region('把关');
  for (const text of ['通过', '证据撑得住三次，五次写过头了', '把关时改过']) expect(gate).toHaveTextContent(text);
  // What was sent stays readable, folded away.
  expect(gate).toHaveTextContent('检查五次');
  const reasons = await region('为什么等你点头');
  for (const label of Object.values(OWNER_REASON_LABELS)) expect(reasons).toHaveTextContent(label);
  const prior = await region('之前的驳回');
  expect(prior).toHaveTextContent('只改了措辞');
  expect(within(prior).getByRole('link')).toHaveAttribute('href', '#/knowledge/proposals/pe');
});

test('a change still being gated links its gate task and still allows direct owner decision', async () => {
  open('#/knowledge/proposals/pd', service());
  const gate = await region('把关');
  expect(gate).toHaveTextContent('把关中');
  expect(within(gate).getByRole('link', { name: '看把关任务' })).toHaveAttribute('href', '#/task/t-gate-d');
  const decide = await region('决定');
  expect(within(decide).getByRole('button', { name: '同意' })).toBeEnabled();
  expect(within(decide).getByRole('button', { name: '驳回' })).toBeEnabled();
  expect(screen.getByRole('button', { name: '改成我的修改，直接生效' })).toBeInTheDocument();
});

test('同意 is directly clickable after proposal content without a ceremonial checkbox, and goes with the digest of what takes effect', async () => {
  const { user, calls } = open('#/knowledge/proposals/pa', service());
  const evidenceRegion = await region('证据');
  const decide = await region('决定');
  // Decide appears after the content/evidence and has a quick jump button at the top.
  expect(evidenceRegion.compareDocumentPosition(decide) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(screen.getByRole('button', { name: '前往审批决策 ↓' })).toBeInTheDocument();
  expect(within(decide).queryByRole('checkbox')).toBeNull();
  const agree = within(decide).getByRole('button', { name: '同意' });
  expect(agree).toBeEnabled();
  await user.click(agree);
  await waitFor(() => expect(calls).toEqual([{ path: '/api/knowledge/proposals/pa/decide', method: 'POST', body: { decision: 'approve', digest: 'final-pa' } }]));
  expect(await screen.findByText('已生效')).toBeInTheDocument();
  expect(screen.queryByRole('region', { name: '决定' })).toBeNull();
});

test('a change waiting for the owner is turned down with the owner\'s note', async () => {
  const { user, calls } = open('#/knowledge/proposals/pa', service());
  const decide = await region('决定');
  await user.type(within(decide).getByRole('textbox', { name: '备注（可不写）' }), '三次也不够');
  await user.click(within(decide).getByRole('button', { name: '驳回' }));
  await waitFor(() => expect(calls).toEqual([{ path: '/api/knowledge/proposals/pa/decide', method: 'POST', body: { decision: 'reject', digest: 'final-pa', note: '三次也不够' } }]));
  expect(await screen.findByText('已驳回')).toBeInTheDocument();
  expect(screen.getByText('三次也不够')).toBeInTheDocument();
});

test('a refused decision says why in the service\'s words, and the page reads the change again', async () => {
  const { user, reads } = open('#/knowledge/proposals/pa', service((call, store) => {
    if (!call.path.endsWith('/decide')) return undefined;
    Object.assign(store.proposals.find((each) => each.id === 'pa')!, { state: 'stale', state_reason: '条目 k1 现在是修订 3' });
    throw refusal('这份变更依据的 k1@2 已经不是现在的修订：要按现在的重新提');
  }));
  const decide = await region('决定');
  const before = reads.filter((path) => path === '/api/knowledge/proposals/pa').length;
  await user.click(within(decide).getByRole('button', { name: '同意' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('这份变更依据的 k1@2 已经不是现在的修订：要按现在的重新提');
  await waitFor(() => expect(reads.filter((path) => path === '/api/knowledge/proposals/pa').length).toBeGreaterThan(before));
  expect(await screen.findByText('依据的修订已变')).toBeInTheDocument();
  expect(screen.getByText(/条目 k1 现在是修订 3/)).toBeInTheDocument();
  expect(screen.queryByRole('region', { name: '决定' })).toBeNull();
});

test('a change in force unreviewed is marked reviewed on its page, and one in force has nothing to agree to', async () => {
  const { user, calls } = open('#/knowledge/proposals/pb', service());
  expect(await screen.findByText('未审阅')).toBeInTheDocument();
  expect(screen.queryByRole('region', { name: '决定' })).toBeNull();
  expect(screen.queryByRole('button', { name: '改成我的修改，直接生效' })).toBeNull();
  await user.click(screen.getByRole('button', { name: '标已审阅' }));
  await waitFor(() => expect(calls).toEqual([{ path: '/api/knowledge/proposals/pb/review', method: 'POST', body: {} }]));
  expect(await screen.findByText('已审阅')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '标已审阅' })).toBeNull();
});

test('a superseded change leads to the one that replaced it', async () => {
  open('#/knowledge/proposals/pf', service());
  expect(await screen.findByText('已改成新候选')).toBeInTheDocument();
  expect(screen.getByRole('link', { name: '看新的那份' })).toHaveAttribute('href', '#/knowledge/proposals/pd');
  for (const name of ['同意', '驳回', '标已审阅', '改成我的修改，直接生效']) expect(screen.queryByRole('button', { name })).toBeNull();
});

test('a revision is diffed against the revision its input pinned; a new entry has nothing to diff', async () => {
  open('#/knowledge/proposals/pa', service());
  const diff = await region('差异');
  expect(within(diff).getByText('检查一次').closest('del')).not.toBeNull();
  expect(within(diff).getByText('检查三次').closest('ins')).not.toBeNull();
  const kept = within(diff).getByText('先说结论');
  expect(kept.closest('del') ?? kept.closest('ins')).toBeNull();
  expect(diff).toHaveTextContent('k1@2');
  expect(diff, '作用域和加载方式都没变').not.toHaveTextContent('加载方式：');
});

test('a change with no revision in it says there is nothing to diff', async () => {
  open('#/knowledge/proposals/pb', service());
  expect(await region('差异')).toHaveTextContent('没有修订现有条目');
});

test('every piece of evidence says whether the service checked it, and the three answers are under their questions', async () => {
  open('#/knowledge/proposals/pa', service());
  const list = await region('证据');
  const first = within(list).getByRole('listitem', { name: '证据 1' });
  for (const text of ['执行轮次', 'r-7', '回执的 learned', '检查了三次才交', 'abcdef012345', VERIFIED_TEXT]) expect(first).toHaveTextContent(text);
  expect(first).not.toHaveTextContent(UNVERIFIED_TEXT);
  const second = within(list).getByRole('listitem', { name: '证据 2' });
  for (const text of ['外部对话', '11-08 的对话', '主人说：再查一遍', UNVERIFIED_TEXT]) expect(second).toHaveTextContent(text);
  const why = await region('为什么提');
  for (const [key, question] of Object.entries(WHY_QUESTIONS)) {
    expect(why).toHaveTextContent(question);
    expect(why).toHaveTextContent(WHY[key as keyof typeof WHY]);
  }
});

test('the owner\'s amend keeps the inputs, pins them to the revision in force now, and goes to the change it made', async () => {
  const { user, calls } = open('#/knowledge/proposals/pa', service(undefined, (store) => { store.entries.find((each) => each.id === 'k1')!.revision = 3; }));
  const inputs = await region('输入');
  expect(within(inputs).getByRole('listitem', { name: '承诺与检查' })).toHaveTextContent('这条已经变了：现在是 k1@3');
  await user.click(screen.getByRole('button', { name: '改成我的修改，直接生效' }));
  const form = screen.getByRole('dialog', { name: '改成我的修改' });
  const fields = within(form).getByRole('group', { name: '输出 1' });
  expect(within(fields).getByRole('textbox', { name: '标题' })).toHaveValue('承诺与检查');
  expect(within(fields).getByRole('radio', { name: '全局' })).toBeChecked();
  expect(within(fields).getByRole('radio', { name: '常驻' })).toBeChecked();
  expect(within(form).getByRole('button', { name: '保存并生效' }), '没改就不是新的').toBeDisabled();
  await user.clear(within(fields).getByRole('textbox', { name: '正文' }));
  await user.type(within(fields).getByRole('textbox', { name: '正文' }), '先查再说');
  await user.click(within(form).getByRole('button', { name: '保存并生效' }));
  await waitFor(() => expect(calls).toEqual([{
    path: '/api/knowledge/proposals/pa/amend', method: 'POST',
    body: {
      inputs: [{ knowledge_id: 'k1', revision: 3, disposition: 'revise', replaced_by: null, note: '' }],
      outputs: [{ key: 'o1', revises: 'k1', title: '承诺与检查', when_to_use: '答应了要检查的事', body: '先查再说', project_ids: null, loading: 'resident', roles: [] }],
    },
  }]));
  await waitFor(() => expect(window.location.hash).toBe('#/knowledge/proposals/px'));
  expect(await screen.findByText('已生效')).toBeInTheDocument();
});

async function fillEntry(user: ReturnType<typeof open>['user'], form: HTMLElement): Promise<void> {
  await user.type(within(form).getByRole('textbox', { name: '标题' }), '先查');
  await user.type(within(form).getByRole('textbox', { name: '什么时候用' }), '检查时');
  await user.type(within(form).getByRole('textbox', { name: '正文' }), '先查再交');
}

async function fillSupport(user: ReturnType<typeof open>['user'], form: HTMLElement): Promise<void> {
  for (const [index, question] of Object.values(WHY_QUESTIONS).entries()) await user.type(within(form).getByRole('textbox', { name: question }), '一二三'[index]!);
  const first = within(form).getByRole('group', { name: '证据 1' });
  await user.type(within(first).getByRole('textbox', { name: '位置' }), '对话');
  await user.type(within(first).getByRole('textbox', { name: '摘录' }), '原话');
}

test('the owner can submit a new knowledge entry with just title and body (no when_to_use, why, or evidence)', async () => {
  const { user, calls } = open('#/knowledge', service());
  await user.click(await screen.findByRole('button', { name: '自己写一条' }));
  const form = screen.getByRole('dialog', { name: '新建条目' });
  expect(form).toHaveTextContent('直接生效');
  const send = () => within(form).getByRole('button', { name: '保存并生效' });
  expect(within(form).getByRole('radio', { name: '全局' })).toBeChecked();
  expect(within(form).getByRole('radio', { name: '按需' })).toBeChecked();
  expect(send()).toBeDisabled();
  expect(form).toHaveTextContent('还差：标题、正文');

  await user.type(within(form).getByRole('textbox', { name: '标题' }), '最小条目');
  await user.type(within(form).getByRole('textbox', { name: '正文' }), '只需要标题和正文即可提交');
  expect(send()).toBeEnabled();

  await user.click(send());
  await waitFor(() => expect(calls).toEqual([{
    path: '/api/knowledge/proposals', method: 'POST',
    body: {
      kind: 'knowledge',
      outputs: [{ title: '最小条目', when_to_use: '', body: '只需要标题和正文即可提交', project_ids: null, loading: 'on_demand', roles: [] }],
      request_id: expect.any(String),
    },
  }]));
});

test('project scope requires at least one project, while empty why and evidence rows never block submission', async () => {
  holdClock();
  const { user, calls } = open('#/knowledge', service());
  await user.click(await screen.findByRole('button', { name: '自己写一条' }));
  const form = screen.getByRole('dialog', { name: '新建条目' });
  const send = () => within(form).getByRole('button', { name: '保存并生效' });
  await fillEntry(user, form);
  expect(send()).toBeEnabled();

  await user.click(within(form).getByRole('radio', { name: '一组项目' }));
  expect(form).toHaveTextContent('还差：作用域里的项目');
  expect(send()).toBeDisabled();
  await user.click(send());
  await pass();
  expect(calls).toEqual([]);

  await user.click(within(form).getByRole('checkbox', { name: 'QL' }));
  expect(send()).toBeEnabled();

  await user.click(within(form).getByRole('button', { name: '再加一条证据' }));
  expect(send(), '空证据行不阻塞保存').toBeEnabled();
  await user.click(within(within(form).getByRole('group', { name: '证据 2' })).getByRole('button', { name: '删掉这条' }));
  await user.click(within(within(form).getByRole('group', { name: '证据 1' })).getByRole('button', { name: '删掉这条' }));
  expect(within(form).getByRole('button', { name: '添加证据' })).toBeInTheDocument();
  expect(send()).toBeEnabled();
});

test('the owner\'s own entry, refused once, keeps the draft and is sent again under the same request id', async () => {
  let refused = false;
  const { user, calls } = open('#/knowledge', service((call) => {
    if (call.path === '/api/knowledge/proposals' && !refused) {
      refused = true;
      throw refusal('第 1 条证据的摘录里像是有令牌：凭据不进摘录，删掉它再交');
    }
    return undefined;
  }));
  await user.click(await screen.findByRole('button', { name: '自己写一条' }));
  const form = screen.getByRole('dialog', { name: '新建条目' });
  await fillEntry(user, form);
  await fillSupport(user, form);
  await user.click(within(form).getByRole('radio', { name: '一组项目' }));
  await user.click(within(form).getByRole('checkbox', { name: 'tycho' }));
  await user.click(within(form).getByRole('radio', { name: '全局' }));
  await user.click(within(form).getByRole('radio', { name: '常驻' }));
  await user.click(within(form).getByRole('checkbox', { name: '分析' }));
  await user.click(within(form).getByRole('button', { name: '保存并生效' }));
  expect(await within(form).findByRole('alert')).toHaveTextContent('第 1 条证据的摘录里像是有令牌：凭据不进摘录，删掉它再交');
  expect(within(form).getByRole('textbox', { name: '标题' })).toHaveValue('先查');
  await user.click(within(form).getByRole('button', { name: '保存并生效' }));
  await waitFor(() => expect(calls).toHaveLength(2));
  // The projects ticked before 全局 was chosen are not sent.
  expect(calls[0]).toEqual({
    path: '/api/knowledge/proposals', method: 'POST',
    body: {
      kind: 'knowledge',
      outputs: [{ title: '先查', when_to_use: '检查时', body: '先查再交', project_ids: null, loading: 'resident', roles: ['analyse'] }],
      why: { when: '一', changes: '二', generalizes: '三' },
      evidence: [{ source: 'owner', location: '对话', excerpt: '原话' }],
      request_id: expect.any(String),
    },
  });
  expect(calls[1]).toEqual(calls[0]);
  await waitFor(() => expect(window.location.hash).toBe('#/knowledge?view=entries'));
  const notice = await screen.findByRole('status');
  expect(notice).toHaveTextContent('新条目已保存并直接生效');
  expect(within(notice).getByRole('link', { name: '查看变更记录' })).toHaveAttribute('href', '#/knowledge/proposals/px');
});

test('a client is issued only for an executor, its token is shown once, shown again on asking, and a revoke needs a second press', async () => {
  const { user, calls } = open('#/knowledge?view=access', service());
  const clients = await region('知识 MCP 客户端');
  const laptop = within(clients).getByRole('listitem', { name: 'laptop' });
  for (const text of ['读取', '提议', 'claude']) expect(laptop).toHaveTextContent(text);
  const old = within(clients).getByRole('listitem', { name: '旧电脑' });
  expect(old).toHaveTextContent('已吊销');
  expect(within(old).queryByRole('button')).toBeNull();

  await user.click(within(clients).getByRole('button', { name: '签发一个' }));
  const form = screen.getByRole('dialog', { name: '签发一个' });
  await user.type(within(form).getByRole('textbox', { name: '客户端名字' }), '工作站');
  await user.click(within(form).getByRole('checkbox', { name: '提议' }));
  expect(within(form).getByRole('button', { name: '签发' }), '还没选执行器').toBeDisabled();
  await user.selectOptions(within(form).getByRole('combobox', { name: '执行器' }), 'codex');
  await user.click(within(form).getByRole('button', { name: '签发' }));
  await waitFor(() => expect(calls).toEqual([{ path: '/api/knowledge/clients', method: 'POST', body: { name: '工作站', executor: 'codex', grants: ['read', 'propose'] } }]));
  const issued = await within(clients).findByRole('status');
  expect(issued).toHaveTextContent('tk-issued-once');
  expect(issued).toHaveTextContent('"command": "tycho"');
  expect(issued).toHaveTextContent('"knowledge-mcp"');
  expect(issued).toHaveTextContent('"TYCHO_KNOWLEDGE_TOKEN": "tk-issued-once"');
  expect(issued).toHaveTextContent('--node');
  expect(issued).not.toHaveTextContent('/api/knowledge/mcp');
  expect(issued).not.toHaveTextContent('"type": "http"');
  expect(issued).toHaveTextContent('只在这里显示；配置方法见部署文档');
  await user.click(within(issued).getByRole('button', { name: '收起' }));
  expect(screen.queryByText('tk-issued-once')).toBeNull();
  expect(await within(clients).findByRole('listitem', { name: '工作站' })).toHaveTextContent('codex');

  await user.click(within(laptop).getByRole('button', { name: '显示令牌' }));
  expect(await within(laptop).findByText('tk-c1')).toBeInTheDocument();
  await user.click(within(laptop).getByRole('button', { name: '吊销' }));
  expect(calls).toHaveLength(1);
  await user.click(within(screen.getByRole('alertdialog', { name: '吊销 laptop 的令牌？' })).getByRole('button', { name: '确认吊销 laptop' }));
  await waitFor(() => expect(calls[1]).toEqual({ path: '/api/knowledge/clients/c1/revoke', method: 'POST', body: {} }));
  await waitFor(() => expect(within(clients).getByRole('listitem', { name: 'laptop' })).toHaveTextContent('已吊销'));
});

test('an entry shows every revision with its loading and review state, and is edited directly as a revision of the one in force', async () => {
  const { user, calls } = open('#/knowledge/entries/k1', service());
  expect(await screen.findByRole('heading', { name: '承诺与检查', level: 1 })).toBeInTheDocument();
  const history = await region('修订记录');
  expect(within(history).getAllByText(/^修订 \d/).map((each) => each.textContent)).toEqual(['修订 2', '修订 1']);
  for (const text of ['现在的证据', '最早的说法', '加载方式：常驻', '已审阅', '未审阅']) expect(history).toHaveTextContent(text);

  await user.click(screen.getByRole('button', { name: '直接改' }));
  const form = screen.getByRole('dialog', { name: '直接改' });
  expect(within(form).getByRole('textbox', { name: '标题' })).toHaveValue('承诺与检查');
  await user.clear(within(form).getByRole('textbox', { name: '正文' }));
  await user.type(within(form).getByRole('textbox', { name: '正文' }), '先查再说');
  await fillSupport(user, form);
  await user.click(within(form).getByRole('button', { name: '保存并生效' }));
  await waitFor(() => expect(calls).toEqual([{
    path: '/api/knowledge/proposals', method: 'POST',
    body: {
      kind: 'knowledge',
      inputs: [{ knowledge_id: 'k1', revision: 2, disposition: 'revise' }],
      outputs: [{ revises: 'k1', title: '承诺与检查', when_to_use: '答应了要检查的事', body: '先查再说', project_ids: null, loading: 'resident', roles: [] }],
      why: { when: '一', changes: '二', generalizes: '三' },
      evidence: [{ source: 'owner', location: '对话', excerpt: '原话' }],
      request_id: expect.any(String),
    },
  }]));
  await waitFor(() => expect(screen.queryByRole('dialog', { name: '直接改' })).toBeNull());
});

test('an entry opened from 待阅 to edit has its edit form open', async () => {
  open('#/knowledge/entries/k2?edit=1', service());
  expect(await screen.findByRole('dialog', { name: '直接改' })).toBeInTheDocument();
});

test('a knowledge citation opens just the revision it cites and its own evidence', async () => {
  open('#/knowledge/entries/k1?revision=1', service());
  const historical = await screen.findByRole('region', { name: '历史修订 1' });
  expect(historical).toHaveTextContent('最早的说法');
  expect(historical).toHaveTextContent('最早的证据');
  expect(screen.queryByText('现在的证据')).toBeNull();
  expect(screen.queryByRole('button', { name: '直接改' })).toBeNull();
  expect(screen.getByRole('link', { name: '查看当前条目' })).toHaveAttribute('href', '#/knowledge/entries/k1');
});

test('an unavailable knowledge revision reports the gap without substituting the current content', async () => {
  open('#/knowledge/entries/k1?revision=9', service());
  expect(await screen.findByRole('alert')).toHaveTextContent('这个修订已不可查看');
  expect(screen.queryByRole('region', { name: '现在的内容' })).toBeNull();
});

test('an entry is retired on the second press with a reason against the revision in force', async () => {
  holdClock();
  const { user, calls } = open('#/knowledge/entries/k1', service());
  // The first press opens the window that asks why; only its own button retires.
  await user.click(await screen.findByRole('button', { name: '退役这一条' }));
  const form = screen.getByRole('dialog', { name: '退役 承诺与检查' });
  const retire = () => within(form).getByRole('button', { name: '确认退役' });
  expect(retire()).toBeEnabled();
  await user.type(within(form).getByRole('textbox', { name: '退役理由' }), '被差距分解替代');
  const options = within(within(form).getByRole('combobox', { name: '替代它的条目' })).getAllByRole('option').map((each) => each.textContent);
  expect(options, '只有可用的条目能替代它').toEqual(['没有替代它的', '差距分解（k2@1）', '跨项目的基准（k4@1）', '基准的边界（k5@1）']);
  await user.selectOptions(within(form).getByRole('combobox', { name: '替代它的条目' }), '差距分解（k2@1）');
  await pass();
  expect(calls).toEqual([]);
  await user.click(retire());
  await waitFor(() => expect(calls).toEqual([{ path: '/api/knowledge/entries/k1/retire', method: 'POST', body: { reason: '被差距分解替代', replaced_by: 'k2', revision: 2 } }]));
  expect(await screen.findByText('已退役')).toBeInTheDocument();
});

test('old rulings the upgrade could not carry over are listed with their project and why, and not at all when there are none', async () => {
  open('#/knowledge', service(undefined, (store) => {
    store.legacy = [
      { id: 'd1', created_at: AT, task_id: 't1', project_id: 'p2', text: '周五不发版', problem: '证据摘录里有令牌' },
      { id: 'd2', created_at: AT, task_id: null, project_id: null, text: '先量再改', problem: null },
    ];
  }));
  const legacy = await region('没能转成提议的旧裁定（2）');
  const first = within(legacy).getByRole('listitem', { name: '周五不发版' });
  expect(first).toHaveTextContent('项目 tycho');
  expect(first).toHaveTextContent('没转成的原因：证据摘录里有令牌');
  expect(within(legacy).getByRole('listitem', { name: '先量再改' })).toHaveTextContent('全局');
  expect(within(legacy).getByRole('listitem', { name: '先量再改' })).toHaveTextContent('还没转成提议');
});

test('with no old rulings left over the page has no such list', async () => {
  open('#/knowledge', service());
  await region('待阅');
  expect(screen.queryByRole('region', { name: /没能转成提议的旧裁定/ })).toBeNull();
});

test('old rulings left over count among what waits for the owner', async () => {
  open('#/knowledge', service(undefined, (store) => {
    store.legacy = [{ id: 'd1', created_at: AT, task_id: null, project_id: null, text: '先量再改', problem: null }];
  }));
  await region('待阅');
  expect(tab(/^待处理\s*4$/)).toBeInTheDocument();
});

test('with nothing waiting the page lands on the catalog, and explicit 待处理 view says so with no count', async () => {
  const { user } = open('#/knowledge', service(undefined, (store) => {
    store.proposals = store.proposals.filter((each) => each.state !== 'awaiting_owner').map((each) => ({ ...each, reviewed_at: AT }));
  }));
  await region('知识与技能目录');
  expect(tab('条目')).toHaveAttribute('aria-current', 'page');
  await user.click(tab('待处理'));
  expect(await screen.findByText('没有等你处理的知识')).toBeInTheDocument();
  expect(tab('待处理')).toHaveAttribute('aria-current', 'page');
  for (const name of ['等你点头', '待阅']) expect(screen.queryByRole('region', { name })).toBeNull();
});

const K6 = entry({ id: 'k6', kind: 'skill', title: '部署到机器', when_to_use: '要上线时', body: '## 在哪里做\n\n仓库根目录', project_ids: ['p1'], proposal_id: 'pz' });

test('skills appear in the unified catalog alongside knowledge, keep SKILL_TEMPLATE as an optional placeholder, and submit as skill', async () => {
  const { user, calls } = open('#/knowledge?view=entries', service(undefined, (store) => { store.entries.push(K6); }));
  const library = await region('知识与技能目录');
  const skill = within(within(library).getByRole('region', { name: '项目 QL' })).getByRole('button', { name: /部署到机器/ });
  for (const text of ['k6@1', '技能', '未审阅']) expect(skill).toHaveTextContent(text);
  expect(within(within(library).getByRole('region', { name: '全局' })).getByRole('button', { name: /承诺与检查/ })).toBeInTheDocument();

  await user.click(screen.getByRole('button', { name: '自己写一条' }));
  const form = screen.getByRole('dialog', { name: '新建条目' });
  await user.click(within(within(form).getByRole('radiogroup', { name: '类型' })).getByRole('radio', { name: '技能' }));
  expect(within(form).queryByRole('radiogroup', { name: '加载方式' }), '技能没有加载方式可选').toBeNull();
  const bodyBox = within(form).getByRole('textbox', { name: '正文' });
  expect(bodyBox).toHaveValue('');
  expect(bodyBox).toHaveAttribute('placeholder', SKILL_TEMPLATE);
  await user.type(within(form).getByRole('textbox', { name: '标题' }), '发布');
  await user.type(within(form).getByRole('textbox', { name: '什么时候用' }), '要上线时');
  await user.type(bodyBox, '执行 npm run deploy 即可上线');
  await user.click(within(form).getByRole('radio', { name: '全局' }));
  await fillSupport(user, form);
  await user.click(within(form).getByRole('button', { name: '保存并生效' }));
  await waitFor(() => expect(calls).toEqual([{
    path: '/api/knowledge/proposals', method: 'POST',
    body: {
      kind: 'skill',
      outputs: [{ title: '发布', when_to_use: '要上线时', body: '执行 npm run deploy 即可上线', project_ids: null, roles: [] }],
      why: { when: '一', changes: '二', generalizes: '三' },
      evidence: [{ source: 'owner', location: '对话', excerpt: '原话' }],
      request_id: expect.any(String),
    },
  }]));
});

test('the access tab shows the read-only native skills directory path without legacy import form', async () => {
  open('#/knowledge?view=access', service());
  const dirCard = await region('技能目录');
  expect(dirCard).toHaveTextContent('/data/skills');
  expect(dirCard).toHaveTextContent('SKILL.md');
  expect(screen.queryByRole('region', { name: '迁入技能文件' })).toBeNull();
});

test('the access tab renders machine knowledge sync in a master-detail view with issue focus and searchable local skills', async () => {
  const base = service();
  const { user } = open('#/knowledge?view=access', (call) => {
    if (call.method === 'GET' && call.path === '/api/accounts') {
      return { accounts: [] };
    }
    if (call.method === 'GET' && call.path === '/api/machines') {
      return {
        invites: [],
        host_entry: {
          at: AT,
          executors: [
            { executor: 'claude', state: 'cleared', path: '/home/host/.claude/rules/tycho-knowledge.md', note: '没有要写的全局常驻知识' },
          ],
        },
        machines: [
          {
            uid: 'u-win',
            id: 'DP-WIN',
            node: {
              connected: true,
              entry: {
                at: AT,
                executors: [
                  { executor: 'claude', state: 'cleared', path: 'C:\\Users\\me\\.claude\\rules\\tycho-knowledge.md', note: '没有要写的全局常驻知识' },
                  { executor: 'codex', state: 'occupied', path: 'C:\\Users\\me\\.codex\\AGENTS.md', note: '这里已有不是 tycho 生成的内容，没动它' },
                ],
              },
              local_skills: [
                { slug: 'cluster-admin', name: 'cluster-admin', description: '管理研究集群的成员与实例' },
                { slug: 'cluster-use', name: 'cluster-use', description: '日常集群使用指南' },
                { slug: 'data-tools', name: 'data-tools', description: '公司内部数据入口' },
                { slug: 'eng-arch', name: 'eng-arch', description: '架构评审流程' },
              ],
            },
          },
          {
            uid: 'u-linux',
            id: 'kr',
            node: {
              connected: true,
              entry: {
                at: AT,
                executors: [
                  { executor: 'gemini', state: 'written', path: '/home/kr/.gemini/AGENTS.md', note: null },
                ],
              },
              local_skills: [],
            },
          },
        ],
      };
    }
    return base(call);
  });

  const section = await region('各机器知识同步与本机私有技能');
  // Auto-focuses the machine with entry issues first, surfaces its warning, hides boilerplate cleared note.
  const detail = await within(section).findByRole('region', { name: 'DP-WIN 的知识状态' });
  expect(detail).toHaveTextContent('被占用未改');
  expect(detail).toHaveTextContent('这里已有不是 tycho 生成的内容，没动它');
  expect(detail).not.toHaveTextContent('没有要写的全局常驻知识');

  // Local skills can be filtered and expanded without bloating the page.
  await user.type(within(detail).getByRole('textbox', { name: '筛选本机私有技能' }), 'data');
  expect(within(detail).getByText('data-tools')).toBeInTheDocument();
  expect(within(detail).queryByText('cluster-admin')).toBeNull();

  // Switch to another machine via the left rail.
  await user.click(within(section).getByRole('button', { name: '选择机器 kr' }));
  const krDetail = await within(section).findByRole('region', { name: 'kr 的知识状态' });
  expect(krDetail).toHaveTextContent('已写入');
  expect(krDetail).toHaveTextContent('本机未上报非托管私有技能');
});

test('occupied entry repairs with coexist after confirmation and shows success notice', async () => {
  const base = service();
  let codexState: 'occupied' | 'written' = 'occupied';
  const { user, calls, reads } = open('#/knowledge?view=access', (call) => {
    if (call.method === 'GET' && call.path === '/api/accounts') return { accounts: [] };
    if (call.method === 'GET' && call.path === '/api/machines') {
      return {
        invites: [],
        machines: [
          {
            uid: 'u-win',
            id: 'DP-WIN',
            node: {
              connected: true,
              entry: {
                at: AT,
                executors: [
                  {
                    executor: 'codex',
                    state: codexState,
                    path: 'C:\\Users\\me\\.codex\\AGENTS.md',
                    note: codexState === 'occupied' ? '这里已有不是 tycho 生成的内容，没动它' : null,
                  },
                ],
              },
              local_skills: [],
            },
          },
        ],
      };
    }
    if (call.method === 'POST' && call.path === '/api/knowledge/entry/repair') {
      codexState = 'written';
      const status = { executor: 'codex', path: 'C:\\Users\\me\\.codex\\AGENTS.md', state: 'written' };
      return { status, report: { digest: 'd1', at: AT, executors: [status] } };
    }
    return base(call);
  });

  const section = await region('各机器知识同步与本机私有技能');
  const detail = await within(section).findByRole('region', { name: 'DP-WIN 的知识状态' });
  const codexRow = within(detail).getByRole('listitem', { name: 'codex' });
  const readsBefore = reads.filter((path) => path === '/api/machines').length;

  await user.click(within(codexRow).getByRole('button', { name: '区块共存' }));
  expect(calls).toEqual([]);
  const dialog = screen.getByRole('alertdialog', { name: '在 DP-WIN 的 codex 入口启用区块共存？' });
  expect(dialog).toHaveTextContent('C:\\Users\\me\\.codex\\AGENTS.md');
  await user.click(within(dialog).getByRole('button', { name: '确认区块共存' }));

  await waitFor(() => expect(calls).toEqual([
    { path: '/api/knowledge/entry/repair', method: 'POST', body: { target: 'u-win', executor: 'codex', action: 'coexist' } },
  ]));
  expect(await within(detail).findByRole('status')).toHaveTextContent('已为 codex 启用区块共存');
  await waitFor(() => expect(reads.filter((path) => path === '/api/machines').length).toBeGreaterThan(readsBefore));
  expect(await within(detail).findByText('已写入')).toBeInTheDocument();
});

test('occupied entry repairs with backup_takeover after confirmation and shows backup_path', async () => {
  const base = service();
  const backupPath = 'C:\\Users\\me\\.codex\\AGENTS.md.pre-tycho-20261121.bak';
  const { user, calls } = open('#/knowledge?view=access', (call) => {
    if (call.method === 'GET' && call.path === '/api/accounts') return { accounts: [] };
    if (call.method === 'GET' && call.path === '/api/machines') {
      return {
        invites: [],
        machines: [
          {
            uid: 'u-win',
            id: 'DP-WIN',
            node: {
              connected: true,
              entry: {
                at: AT,
                executors: [
                  { executor: 'codex', state: 'occupied', path: 'C:\\Users\\me\\.codex\\AGENTS.md', note: '这里已有不是 tycho 生成的内容，没动它' },
                ],
              },
              local_skills: [],
            },
          },
        ],
      };
    }
    if (call.method === 'POST' && call.path === '/api/knowledge/entry/repair') {
      const status = { executor: 'codex', path: 'C:\\Users\\me\\.codex\\AGENTS.md', state: 'written' };
      return { status, backup_path: backupPath, report: { digest: 'd2', at: AT, executors: [status] } };
    }
    return base(call);
  });

  const section = await region('各机器知识同步与本机私有技能');
  const detail = await within(section).findByRole('region', { name: 'DP-WIN 的知识状态' });
  const codexRow = within(detail).getByRole('listitem', { name: 'codex' });

  await user.click(within(codexRow).getByRole('button', { name: '备份并接管' }));
  expect(calls).toEqual([]);
  const dialog = screen.getByRole('alertdialog', { name: '备份并接管 DP-WIN 的 codex 入口？' });
  expect(dialog).toHaveTextContent('.pre-tycho-*.bak');
  await user.click(within(dialog).getByRole('button', { name: '确认备份并接管' }));

  await waitFor(() => expect(calls).toEqual([
    { path: '/api/knowledge/entry/repair', method: 'POST', body: { target: 'u-win', executor: 'codex', action: 'backup_takeover' } },
  ]));
  const status = await within(detail).findByRole('status');
  expect(status).toHaveTextContent(`已接管 codex 入口（原文件已备份至 ${backupPath}）`);
});

test('failed and unconfirmed entries send resync directly without confirm dialog and report errors inline', async () => {
  const base = service();
  const { user, calls } = open('#/knowledge?view=access', (call) => {
    if (call.method === 'GET' && call.path === '/api/accounts') return { accounts: [] };
    if (call.method === 'GET' && call.path === '/api/machines') {
      return {
        invites: [],
        machines: [
          {
            uid: 'u-linux',
            id: 'kr',
            node: {
              connected: true,
              entry: {
                at: AT,
                executors: [
                  { executor: 'gemini', state: 'failed', path: '/home/kr/.gemini/AGENTS.md', note: '磁盘写入权限不足' },
                  { executor: 'claude', state: 'unconfirmed', path: '/home/kr/.claude/rules/tycho-knowledge.md', note: '尚未确认执行器是否加载' },
                ],
              },
              local_skills: [],
            },
          },
        ],
      };
    }
    if (call.method === 'POST' && call.path === '/api/knowledge/entry/repair') {
      const body = call.body as { executor: string };
      if (body.executor === 'claude') {
        throw refusal('节点版本过旧，不支持远程入口修复');
      }
      const status = { executor: 'gemini', path: '/home/kr/.gemini/AGENTS.md', state: 'written' };
      return { status, report: { digest: 'd3', at: AT, executors: [status] } };
    }
    return base(call);
  });

  const section = await region('各机器知识同步与本机私有技能');
  const detail = await within(section).findByRole('region', { name: 'kr 的知识状态' });

  const geminiRow = within(detail).getByRole('listitem', { name: 'gemini' });
  await user.click(within(geminiRow).getByRole('button', { name: '重新同步' }));
  expect(screen.queryByRole('alertdialog')).toBeNull();
  await waitFor(() => expect(calls).toEqual([
    { path: '/api/knowledge/entry/repair', method: 'POST', body: { target: 'u-linux', executor: 'gemini', action: 'resync' } },
  ]));
  expect(await within(detail).findByRole('status')).toHaveTextContent('已重新同步 gemini 入口');

  const claudeRow = within(detail).getByRole('listitem', { name: 'claude' });
  await user.click(within(claudeRow).getByRole('button', { name: '重新同步' }));
  expect(await within(detail).findByRole('alert')).toHaveTextContent('节点版本过旧，不支持远程入口修复');
});

test('offline machine disables all entry repair actions and explains why', async () => {
  const base = service();
  open('#/knowledge?view=access', (call) => {
    if (call.method === 'GET' && call.path === '/api/accounts') return { accounts: [] };
    if (call.method === 'GET' && call.path === '/api/machines') {
      return {
        invites: [],
        machines: [
          {
            uid: 'u-off',
            id: 'offline-box',
            node: {
              connected: false,
              entry: {
                at: AT,
                executors: [
                  { executor: 'codex', state: 'occupied', path: '/home/off/.codex/AGENTS.md', note: '这里已有不是 tycho 生成的内容，没动它' },
                  { executor: 'gemini', state: 'failed', path: '/home/off/.gemini/AGENTS.md', note: '写入失败' },
                ],
              },
              local_skills: [],
            },
          },
        ],
      };
    }
    return base(call);
  });

  const section = await region('各机器知识同步与本机私有技能');
  const detail = await within(section).findByRole('region', { name: 'offline-box 的知识状态' });
  const codexRow = within(detail).getByRole('listitem', { name: 'codex' });
  expect(within(codexRow).getByRole('button', { name: '区块共存' })).toBeDisabled();
  expect(within(codexRow).getByRole('button', { name: '备份并接管' })).toBeDisabled();
  expect(codexRow).toHaveTextContent('机器离线，上线后可修复');

  const geminiRow = within(detail).getByRole('listitem', { name: 'gemini' });
  expect(within(geminiRow).getByRole('button', { name: '重新同步' })).toBeDisabled();
  expect(geminiRow).toHaveTextContent('机器离线，上线后可修复');
});

test('proposal detail translates weixin and task_abandon decision channels cleanly', async () => {
  const first = open('#/knowledge/proposals/pb', service(undefined, (store) => {
    const p = store.proposals.find((each) => each.id === 'pb')!;
    Object.assign(p, { decided_at: AT, decided_by: 'owner', decided_via: 'weixin' });
  }));
  expect(await screen.findByText(/经微信/)).toBeInTheDocument();
  first.unmount();

  open('#/knowledge/proposals/pe', service(undefined, (store) => {
    const p = store.proposals.find((each) => each.id === 'pe')!;
    Object.assign(p, { decided_at: AT, decided_by: 'owner', decided_via: 'task_abandon' });
  }));
  expect(await screen.findByText(/经放弃把关任务/)).toBeInTheDocument();
});

test('ToReview offers 全部标已审阅 calling review-all and visually separates blocking awaiting from non-blocking to_review', async () => {
  const { user, calls } = open('#/knowledge', service((call, store) => {
    if (call.path === '/api/knowledge/proposals/review-all') {
      for (const item of store.proposals) {
        if (item.state === 'published' && item.reviewed_at === null) item.reviewed_at = AT;
      }
      return { reviewed: 2 };
    }
    return undefined;
  }));
  expect(await screen.findByText('阻塞审批：等你点头 1')).toBeInTheDocument();
  expect(screen.getByText('非阻塞待阅 2')).toBeInTheDocument();
  const review = await region('待阅');
  await user.click(within(review).getByRole('button', { name: '全部标已审阅' }));
  await waitFor(() => expect(calls).toEqual([{ path: '/api/knowledge/proposals/review-all', method: 'POST', body: {} }]));
  await waitFor(() => expect(screen.queryByRole('region', { name: '待阅' })).toBeNull());
});

test('when nothing awaits approval, Pending reassures the owner there are no blocking approvals', async () => {
  open('#/knowledge', service(undefined, (store) => {
    store.proposals = store.proposals.filter((each) => each.state !== 'awaiting_owner');
  }));
  await region('待阅');
  expect(screen.getByText('当前无阻塞审批')).toBeInTheDocument();
  expect(screen.getByText('非阻塞待阅 2')).toBeInTheDocument();
});

test('direct entry creation navigates to the new entry when API returns knowledge_id', async () => {
  const { user } = open('#/knowledge', service((call) => {
    if (call.path === '/api/knowledge/proposals') return { id: 'px', knowledge_id: 'k2', duplicate: false, state: 'published' };
    return undefined;
  }));
  await user.click(await screen.findByRole('button', { name: '自己写一条' }));
  const form = screen.getByRole('dialog', { name: '新建条目' });
  await fillEntry(user, form);
  await fillSupport(user, form);
  await user.click(within(form).getByRole('radio', { name: '全局' }));
  await user.click(within(form).getByRole('radio', { name: '按需' }));
  await user.click(within(form).getByRole('button', { name: '保存并生效' }));
  await waitFor(() => expect(window.location.hash).toBe('#/knowledge/entries/k2'));
});

test('historical revision body is rendered as formatted Markdown instead of raw preformatted text', async () => {
  const base = service();
  open('#/knowledge/entries/k1?revision=1', (call) => {
    if (call.method === 'GET' && call.path === '/api/knowledge/entries/k1') {
      const result = base(call) as { entry: KnowledgeEntry; revisions: (KnowledgeRevision & { proposed_by: string; source: string; evidence: KnowledgeEvidence[] })[] };
      result.revisions[0]!.body = '先看 **关键约束**\n\n- 第一条规则';
      return result;
    }
    return base(call);
  });
  const historical = await screen.findByRole('region', { name: '历史修订 1' });
  const bold = within(historical).getByText('关键约束');
  expect(bold.tagName).toBe('STRONG');
  expect(bold.closest('pre')).toBeNull();
  expect(within(historical).getByText('第一条规则').closest('li')).not.toBeNull();
});
