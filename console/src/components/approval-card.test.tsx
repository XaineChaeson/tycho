import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';
import { HashRouter } from 'react-router';
import type { Approval } from '@/lib/types';
import { ApprovalCard, presentQuestion } from './approval-card';

afterEach(() => {
  vi.unstubAllGlobals();
});

function mountCard(card: Approval, onPost?: (path: string, body: unknown) => unknown) {
  const calls: { method: string; path: string; body: unknown }[] = [];
  vi.stubGlobal('fetch', async (path: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path, body });
    try {
      const result = onPost ? await onPost(path, body) : { ok: true };
      return { ok: true, status: 200, json: async () => result };
    } catch (error) {
      return { ok: false, status: 400, json: async () => ({ error: (error as Error).message }) };
    }
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const view = render(
    <QueryClientProvider client={client}>
      <HashRouter>
        <ApprovalCard card={card} />
      </HashRouter>
    </QueryClientProvider>,
  );
  return { ...view, user: userEvent.setup(), calls };
}

test('presentQuestion parses legacy duplicated decide-tier review rejection into deduplicated heading and structured Markdown', () => {
  const legacy = [
    '审阅在决策档的产物上又打回了，系统不再升档，要你来定：带引号凭据未脱敏，飞书围栏被关闭。',
    '',
    '独立审阅打回了上一轮的产物：带引号凭据未脱敏，飞书围栏被关闭。',
    '',
    '1. 违反的要求：验收标准 2 要求双流截断后仍满足脱敏。',
    '   证据：src/tasks/alerts.py:245 未匹配带双引号的 token 值。',
    '   要改的范围：修正脱敏规则并补单测。',
    '2. 违反的要求：补充核验要求飞书渲染无破坏。',
    '   证据：src/tasks/alerts.py:800 直接拼接日志。',
    '   要改的范围：修正飞书日志围栏处理。',
    '',
    '按这些意见改，改完照常交回执。',
  ].join('\n');

  const presented = presentQuestion({
    question: legacy,
    about: '回答之后任务回到队列，回答的内容交给下一轮；不想再做就放弃这个任务',
  });

  expect(presented.title).toBe('审阅在决策档的产物上又打回了（2 项问题），系统不再升档，要你来定');
  expect(presented.detail).toContain('**审阅结论**：带引号凭据未脱敏，飞书围栏被关闭。');
  expect(presented.detail).toContain('1. **违反要求**：验收标准 2 要求双流截断后仍满足脱敏。');
  expect(presented.detail).toContain('   - **证据**：src/tasks/alerts.py:245 未匹配带双引号的 token 值。');
  expect(presented.detail).toContain('   - **修改范围**：修正脱敏规则并补单测。');
  expect(presented.detail).toContain('2. **违反要求**：补充核验要求飞书渲染无破坏。');
  expect(presented.detail?.match(/带引号凭据未脱敏/g)?.length).toBe(1);
  expect(presented.detail).not.toContain('按这些意见改，改完照常交回执');
  expect(presented.hint).toBe('回答之后任务回到队列，回答的内容交给下一轮；不想再做就放弃这个任务');
});

test('presentQuestion splits generic multi-line question into heading and Markdown detail', () => {
  const presented = presentQuestion({
    question: '请选择数据库迁移策略\n\n- 方案 A：在线双写\n- 方案 B：停机切换',
  });
  expect(presented.title).toBe('请选择数据库迁移策略');
  expect(presented.detail).toBe('- 方案 A：在线双写\n- 方案 B：停机切换');
  expect(presented.hint).toBeNull();
});

test('review escalation card renders structured Markdown, link to review task, and owner direct accept / abandon controls', async () => {
  const card: Approval = {
    id: 'ap-review-1',
    task_id: 'task-fix',
    task_title: '修复报警缺陷',
    project_id: 'proj-1',
    review_task_id: 'task-review-2',
    state: 'open',
    questions: [{
      question: '审阅在决策档的产物上又打回了（2 项问题），系统不再升档，要你来定',
      about: [
        '**审阅结论**：带引号凭据未脱敏',
        '',
        '1. **违反要求**：满足脱敏约束',
        '   - **证据**：`src/tasks/alerts.py:245`',
        '   - **修改范围**：修正脱敏规则',
      ].join('\n'),
      options: ['按审阅意见在决策档再改一轮'],
    }],
    answers: null,
    answered_via: null,
  };

  const app = mountCard(card);
  const region = screen.getByRole('region', { name: '等你决定 · 修复报警缺陷' });
  expect(within(region).getByRole('link', { name: '查看复审报告' })).toHaveAttribute('href', '#/task/task-review-2');
  expect(within(region).getByText('审阅在决策档的产物上又打回了（2 项问题），系统不再升档，要你来定')).toBeInTheDocument();
  expect(within(region).getByText('src/tasks/alerts.py:245')).toBeInTheDocument();

  // Direct accept without review requires explicit basis and posts without_review: true.
  await app.user.click(within(region).getByRole('button', { name: '不经审阅验收' }));
  const confirmAccept = within(region).getByRole('button', { name: '确认不经审阅验收' });
  expect(confirmAccept).toBeDisabled();
  await app.user.type(within(region).getByRole('textbox', { name: '不经审阅验收依据' }), '边界场景可接受');
  expect(confirmAccept).toBeEnabled();
  await app.user.click(confirmAccept);
  expect(app.calls.some((c) => c.path === '/api/tasks/task-fix/accept' && JSON.stringify(c.body) === JSON.stringify({ basis: '边界场景可接受', without_review: true }))).toBe(true);

  // Direct abandon asks confirmation before posting.
  await app.user.click(within(region).getByRole('button', { name: '放弃任务' }));
  await app.user.type(within(region).getByRole('textbox', { name: '放弃理由' }), '改走其他方案');
  await app.user.click(within(region).getByRole('button', { name: '确认放弃' }));
  expect(app.calls.some((c) => c.path === '/api/tasks/task-fix/abandon' && JSON.stringify(c.body) === JSON.stringify({ reason: '改走其他方案' }))).toBe(true);
});

test('non-review approval card omits review-only shortcuts, offers direct abandon, and collapses very long detail with toggle', async () => {
  const longLines = Array.from({ length: 20 }, (_, i) => `${i + 1}. 详细背景说明条目 ${i + 1}：这里包含充足的上下文细节。`).join('\n');
  const card: Approval = {
    id: 'ap-normal-1',
    task_id: 'task-1',
    task_title: '普通选型',
    project_id: 'proj-1',
    review_task_id: null,
    state: 'open',
    questions: [{
      question: '选哪个方案？',
      about: longLines,
      options: ['方案一', '方案二'],
    }],
    answers: null,
    answered_via: null,
  };

  const app = mountCard(card);
  const region = screen.getByRole('region', { name: '等你决定 · 普通选型' });
  expect(within(region).queryByRole('link', { name: '查看复审报告' })).toBeNull();
  expect(within(region).queryByRole('button', { name: '不经审阅验收' })).toBeNull();

  // Direct abandon is also available on non-review open approvals with inline confirmation.
  await app.user.click(within(region).getByRole('button', { name: '放弃任务' }));
  await app.user.type(within(region).getByRole('textbox', { name: '放弃理由' }), '需求已取消');
  await app.user.click(within(region).getByRole('button', { name: '确认放弃' }));
  expect(app.calls.some((c) => c.path === '/api/tasks/task-1/abandon' && JSON.stringify(c.body) === JSON.stringify({ reason: '需求已取消' }))).toBe(true);

  const toggle = within(region).getByRole('button', { name: '展开全部' });
  await app.user.click(toggle);
  expect(within(region).getByRole('button', { name: '收起明细' })).toBeInTheDocument();
});

test('3-option decide-tier review escalation card submits chosen native option smoothly', async () => {
  const card: Approval = {
    id: 'ap-review-3opt',
    task_id: 'task-3opt',
    task_title: '核心重构',
    project_id: 'proj-1',
    review_task_id: 'task-review-9',
    state: 'open',
    questions: [{
      question: '审阅在决策档的产物上又打回了（1 项问题），系统不再升档，要你来定',
      about: '**审阅结论**：边界测试不足',
      options: ['按审阅意见在决策档再改一轮', '不经审阅直接验收', '放弃这个任务'],
    }],
    answers: null,
    answered_via: null,
  };

  const app = mountCard(card);
  const region = screen.getByRole('region', { name: '等你决定 · 核心重构' });
  await app.user.click(within(region).getByRole('button', { name: '不经审阅直接验收' }));
  await app.user.click(within(region).getByRole('button', { name: '提交答复' }));
  expect(app.calls.some((c) => c.path === '/api/approvals/ap-review-3opt/answer' && JSON.stringify(c.body) === JSON.stringify({ answers: ['不经审阅直接验收'] }))).toBe(true);
});
