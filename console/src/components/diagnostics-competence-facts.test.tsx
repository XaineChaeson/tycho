// Guards against eager diagnostic reads, missing execution evidence, a competence report
// for the wrong window, and a proposal that loses the owner's edits or its evidence.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { MemoryRouter } from 'react-router';
import { expect, test, vi } from 'vitest';
import type { CompetenceReport } from '@shared/competence.ts';
import type { RunDiagnosticsBundle } from '@shared/run-diagnostics.ts';
import type { KnowledgeProposalDraft, KnowledgeProposalDraftOutput, TaskRunFacts } from '@shared/run-facts.ts';
import { WHY_QUESTIONS } from '@shared/knowledge.ts';
import { holdClock, pass, serve, type Handler } from '@/test/harness';
import { CompetencePanel } from './competence-panel';
import { RunDiagnosticsButton } from './run-diagnostics';
import { RunFactsCard } from './run-facts-card';

const AT = '2026-11-18T08:00:00.000Z';
const DIAGNOSTICS_PATH = '/api/runs/run-1/diagnostics';
const FACTS_PATH = '/api/tasks/task-1/facts';
const PROPOSALS_PATH = '/api/knowledge/proposals';

function mount(component: ReactElement, handler: Handler) {
  const service = serve(handler);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={client}>
      <MemoryRouter>{component}</MemoryRouter>
    </QueryClientProvider>,
  );
  return { ...service, ...view, user: userEvent.setup() };
}

test('the diagnostic sheet reads on demand and shows the recorded evidence and coverage gap', async () => {
  const bundle: RunDiagnosticsBundle = {
    schema_version: 1, generated_at: AT, platform_version: '0.1.811',
    run: {
      id: 'run-1', task_id: 'task-1', status: 'ended', executor: 'codex', tier: 'execute',
      login_id: 'login-1', node_id: null, started_at: AT, finished_at: AT, duration_ms: 0, error: null,
    },
    task: null, snapshot: null, trace: null,
    first_error: { source: 'diagnostic', message: '迁移检查超时', event_index: 4 },
    stderr: { head: [], tail: [] },
    tools: {
      total: 1, error_count: 0, unfinished_count: 1, by_category: { run: 1 }, failed_tools: [],
      unfinished_tools: [{ id: 'tool-1', name: 'shell', category: 'run', title: '检查迁移状态', event_index: 5 }],
    },
    models: { tier_model: null, reported_models: ['reported-model'] },
    coverage: { events_loaded: true, events_count: 2, dropped_before_index: 4, incomplete_reason: '较早事件已丢弃', stderr_loaded: false },
  };
  holdClock();
  const app = mount(<RunDiagnosticsButton runId="run-1" round={1} />, ({ path, method }) => {
    if (method === 'GET' && path === DIAGNOSTICS_PATH) return bundle;
  });
  await pass();
  const button = screen.getByRole('button', { name: '诊断包' });
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(app.reads).toEqual([]);

  vi.useRealTimers();
  await app.user.click(button);

  const sheet = within(await screen.findByRole('dialog', { name: '第 1 轮诊断包' }));
  expect(await sheet.findByText('迁移检查超时')).toBeInTheDocument();
  expect(sheet.getByText('未结束工具（1）')).toBeInTheDocument();
  expect(sheet.getByRole('listitem')).toHaveTextContent('检查迁移状态');
  expect(sheet.getByText('reported-model')).toBeInTheDocument();
  expect(sheet.getByText('存在缺口')).toBeInTheDocument();
  expect(sheet.getByText('较早事件已丢弃')).toBeInTheDocument();
  expect(app.reads).toEqual([DIAGNOSTICS_PATH]);
});

test('competence reads the seven-day window and shows the login, executor, tier, and advice', async () => {
  vi.setSystemTime(new Date(2026, 10, 18, 12));
  const from = new Date(2026, 10, 12).toISOString();
  const to = new Date(2026, 10, 19).toISOString();
  const report: CompetenceReport = {
    from, to, min_sample_size: 5,
    summary: { total_rounds: 6, reviewed_rounds: 6, escalated_rounds: 0, total_list_cost_usd: 0 },
    rows: [{
      login_id: 'login-1', login_name: '主登录', executor: 'codex', tier: 'execute',
      rounds: 6, completed_rounds: 6, failed_rounds: 0, reviewed_rounds: 6,
      first_pass_count: 6, rework_count: 0, escalated_count: 0, first_pass_rate: 1,
      failure_rate: 0, avg_duration_ms: 1000, total_tokens: 100, list_cost_usd: 0, unpriced_rounds: 6,
      advice: { kind: 'promote', reason: '一次通过率高且零升档' },
    }],
  };
  const path = `/api/usage/competence?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
  const app = mount(<CompetencePanel days={7} />, (call) => {
    if (call.method === 'GET' && call.path === path) return report;
  });

  const row = within(await screen.findByRole('row', { name: /主登录.*codex.*执行档/ }));
  expect(row.getByText('100%')).toBeInTheDocument();
  expect(row.getByText('6/6 已评')).toBeInTheDocument();
  expect(row.getByText('适合承担')).toBeInTheDocument();
  expect(app.reads).toEqual([path]);
});

const CLEAN_FACTS: TaskRunFacts = {
  task_id: 'task-1', project_id: 'proj-1', analyzed_runs: 1, failed_rounds: 0, escalations: 0,
  noteworthy: false, noteworthy_reasons: [], ping_pong: [], tool_repeats: [], error_facts: [],
  proposal_draft: null,
};

test('a clean task still renders nothing after its facts are loaded', async () => {
  holdClock();
  const app = mount(<RunFactsCard taskId="task-1" projectId="proj-1" />, ({ path, method }) => {
    if (method === 'GET' && path === FACTS_PATH) return CLEAN_FACTS;
  });
  await pass();

  expect(app.reads).toEqual([FACTS_PATH]);
  expect(app.waiting(FACTS_PATH)).toBe(0);
  expect(app.container).toBeEmptyDOMElement();
});

test('a noteworthy task prefills an editable proposal and submits the edited draft with its evidence', async () => {
  const output: KnowledgeProposalDraftOutput = {
    title: '迁移前检查索引', when_to_use: '执行数据库迁移前', body: '先确认目标索引存在。',
    project_ids: ['proj-1'], loading: 'on_demand', roles: ['implement'],
  };
  const draft: KnowledgeProposalDraft = {
    kind: 'knowledge', inputs: [],
    outputs: [output],
    why: { when: '两轮迁移均缺少索引', changes: '在迁移前检查索引', generalizes: '同类迁移适用' },
    evidence: [{ source: 'run', ref: 'run-1', location: 'summary', excerpt: '缺少目标索引' }],
    request_id: 'facts-task-1',
  };
  const facts: TaskRunFacts = {
    ...CLEAN_FACTS, analyzed_runs: 2, failed_rounds: 2, noteworthy: true,
    noteworthy_reasons: ['累计 2 轮执行失败'], proposal_draft: draft,
  };
  const app = mount(<RunFactsCard taskId="task-1" projectId="proj-1" />, ({ path, method }) => {
    if (method === 'GET' && path === FACTS_PATH) return facts;
    if (method === 'POST' && path === PROPOSALS_PATH) return { id: 'proposal-1', duplicate: false, state: 'published' };
  });
  expect(await screen.findByRole('heading', { name: '执行病历' })).toBeInTheDocument();
  expect(screen.getByText('累计 2 轮执行失败')).toBeInTheDocument();
  expect(app.calls).toEqual([]);

  await app.user.click(screen.getByRole('button', { name: '基于病历发起改进提议' }));
  const title = screen.getByRole('textbox', { name: '提议标题' });
  expect(title).toHaveValue(output.title);
  expect(screen.getByRole('textbox', { name: '什么时候用' })).toHaveValue(output.when_to_use);
  expect(screen.getByRole('textbox', { name: '提议正文' })).toHaveValue(output.body);
  expect(screen.getByRole('textbox', { name: WHY_QUESTIONS.when })).toHaveValue(draft.why.when);
  expect(screen.getByRole('textbox', { name: WHY_QUESTIONS.changes })).toHaveValue(draft.why.changes);
  expect(screen.getByRole('textbox', { name: WHY_QUESTIONS.generalizes })).toHaveValue(draft.why.generalizes);
  expect(app.calls).toEqual([]);

  await app.user.clear(title);
  await app.user.type(title, '检查目标索引');
  expect(screen.getByText('缺少目标索引')).toBeInTheDocument();
  await app.user.click(screen.getByRole('button', { name: '发布到知识库' }));

  const link = await screen.findByRole('link', { name: '前往查看' });
  expect(link).toHaveAttribute('href', '/knowledge');
  expect(screen.getByRole('status')).toHaveTextContent('已提交至知识库并生效');
  expect(app.calls).toEqual([{
    path: PROPOSALS_PATH, method: 'POST',
    body: { ...draft, outputs: [{ ...output, title: '检查目标索引' }] },
  }]);
});

test('a noteworthy task proposal can be submitted with just title and body after clearing optional why and when_to_use fields', async () => {
  const output: KnowledgeProposalDraftOutput = {
    title: '迁移前检查索引', when_to_use: '执行数据库迁移前', body: '先确认目标索引存在。',
    project_ids: ['proj-1'], loading: 'on_demand', roles: ['implement'],
  };
  const draft: KnowledgeProposalDraft = {
    kind: 'knowledge', inputs: [],
    outputs: [output],
    why: { when: '两轮迁移均缺少索引', changes: '在迁移前检查索引', generalizes: '同类迁移适用' },
    evidence: [],
    request_id: 'facts-task-2',
  };
  const facts: TaskRunFacts = {
    ...CLEAN_FACTS, analyzed_runs: 2, failed_rounds: 2, noteworthy: true,
    noteworthy_reasons: ['累计 2 轮执行失败'], proposal_draft: draft,
  };
  const app = mount(<RunFactsCard taskId="task-2" projectId="proj-1" />, ({ path, method }) => {
    if (method === 'GET' && path === '/api/tasks/task-2/facts') return facts;
    if (method === 'POST' && path === PROPOSALS_PATH) return { id: 'proposal-2', duplicate: false, state: 'published' };
  });
  await app.user.click(await screen.findByRole('button', { name: '基于病历发起改进提议' }));
  await app.user.clear(screen.getByRole('textbox', { name: '什么时候用' }));
  await app.user.clear(screen.getByRole('textbox', { name: WHY_QUESTIONS.when }));
  await app.user.clear(screen.getByRole('textbox', { name: WHY_QUESTIONS.changes }));
  await app.user.clear(screen.getByRole('textbox', { name: WHY_QUESTIONS.generalizes }));

  const submit = screen.getByRole('button', { name: '发布到知识库' });
  expect(submit).toBeEnabled();
  await app.user.click(submit);

  expect(await screen.findByRole('status')).toHaveTextContent('已提交至知识库并生效');
  expect(app.calls).toEqual([{
    path: PROPOSALS_PATH, method: 'POST',
    body: {
      ...draft,
      outputs: [{ ...output, when_to_use: '' }],
      why: { when: '', changes: '', generalizes: '' },
      evidence: [],
    },
  }]);
});
