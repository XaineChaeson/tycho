import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, test, vi } from 'vitest';
import { TaskDiffPanel, formatAnnotationsMarkdown, parseUnifiedPatch } from '@/components/task-diff-panel';
import type { TaskDiffResponse } from '@/lib/types';
import { refusal, serve, type Handler } from '@/test/harness';

function renderPanel(props: Parameters<typeof TaskDiffPanel>[0], handler?: Handler) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const service = serve(handler);
  const user = userEvent.setup();
  const view = render(
    <QueryClientProvider client={client}>
      <TaskDiffPanel {...props} />
    </QueryClientProvider>,
  );
  return { ...service, client, user, ...view };
}

const SAMPLE_DIFF: TaskDiffResponse = {
  source: 'git',
  commit: 'abcdef1234567890',
  base: '0000001111222233',
  branch: 'feat/ux-overhaul',
  truncated: false,
  files: [
    {
      path: 'src/app.ts',
      status: 'modified',
      additions: 2,
      deletions: 1,
      patch: [
        '@@ -10,3 +10,4 @@ function boot() {',
        ' const a = 1;',
        '-const b = 2;',
        '+const b = 3;',
        '+const c = 4;',
      ].join('\n'),
    },
    {
      path: 'src/new.ts',
      status: 'added',
      additions: 1,
      deletions: 0,
      patch: ['@@ -0,0 +1,1 @@', '+export const ok = true;'].join('\n'),
    },
  ],
};

test('parseUnifiedPatch tracks old/new line numbers and formatAnnotationsMarkdown formats review payload', () => {
  const lines = parseUnifiedPatch(SAMPLE_DIFF.files[0]!.patch);
  expect(lines.map((line) => [line.kind, line.oldLine, line.newLine])).toEqual([
    ['hunk', null, null],
    ['context', 10, 10],
    ['del', 11, null],
    ['add', null, 11],
    ['add', null, 12],
  ]);

  const md = formatAnnotationsMarkdown([
    { id: '1', path: 'src/app.ts', line: 11, code: 'const b = 3;', comment: '改回常量命名', commit: 'abcdef123456' },
  ], 'abcdef1234567890');
  expect(md).toContain('`abcdef1234`');
  expect(md).toContain('`src/app.ts:L11`');
  expect(md).toContain('const b = 3;');
  expect(md).toContain('> 改回常量命名');
});

test('renders git diff header, file tabs, inline line annotations, and submits review payload via /continue or /inputs', async () => {
  const onSubmitted = vi.fn();
  const { user, calls } = renderPanel(
    { taskId: 't1', taskState: 'ready', onSubmitted },
    (call) => {
      if (call.path === '/api/tasks/t1/diff') return SAMPLE_DIFF;
      if (call.method === 'POST' && call.path === '/api/tasks/t1/continue') return { ok: true };
      return undefined;
    },
  );

  expect(await screen.findByText('权威 Git Diff')).toBeInTheDocument();
  expect(screen.getByText('feat/ux-overhaul')).toBeInTheDocument();
  expect(screen.getByText('abcdef1234')).toBeInTheDocument();
  expect(screen.getByText('2 个文件')).toBeInTheDocument();
  expect(screen.getByText('+3')).toBeInTheDocument();
  expect(screen.getAllByText('-1').length).toBeGreaterThanOrEqual(1);

  // Switch file tab to src/new.ts and back.
  await user.click(screen.getByRole('tab', { name: /src\/new\.ts/ }));
  expect(screen.getByText('export const ok = true;')).toBeInTheDocument();
  await user.click(screen.getByRole('tab', { name: /src\/app\.ts/ }));

  // Annotate added line 11 using Ctrl+Enter.
  await user.click(screen.getByRole('button', { name: '在第 11 行添加批注' }));
  const box = screen.getByRole('textbox', { name: '第 11 行批注内容' });
  await user.type(box, '请确认 b 的边界值');
  fireEvent.keyDown(box, { key: 'Enter', ctrlKey: true });

  const tray = await screen.findByRole('region', { name: '批注草稿箱' });
  expect(within(tray).getByText('已暂存 1 条行级批注')).toBeInTheDocument();
  expect(within(tray).getByText('请确认 b 的边界值')).toBeInTheDocument();

  await user.click(within(tray).getByRole('button', { name: '打包发送给当前线程返工' }));
  await waitFor(() => expect(calls).toHaveLength(1));
  expect(calls[0]!.path).toBe('/api/tasks/t1/continue');
  expect((calls[0]!.body as { note: string }).note).toContain('src/app.ts:L11');
  expect((calls[0]!.body as { note: string }).note).toContain('请确认 b 的边界值');
  expect(onSubmitted).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole('region', { name: '批注草稿箱' })).toBeNull();
});

test('stale-SHA guard blocks submission until confirmed when commit advances', async () => {
  let currentCommit = '1111111111aa';
  const { user, client, calls } = renderPanel(
    { taskId: 't2', taskState: 'running' },
    (call) => {
      if (call.path === '/api/tasks/t2/diff') return { ...SAMPLE_DIFF, commit: currentCommit };
      if (call.method === 'POST' && call.path === '/api/tasks/t2/inputs') return { id: 'in-1' };
      return undefined;
    },
  );

  await screen.findByText('1111111111');
  await user.click(screen.getByRole('button', { name: '在第 11 行添加批注' }));
  await user.type(screen.getByRole('textbox', { name: '第 11 行批注内容' }), '这里需要补测试');
  await user.click(screen.getByRole('button', { name: '保存批注' }));

  // Commit changes underneath the pending annotations.
  currentCommit = '2222222222bb';
  await act(async () => {
    await client.invalidateQueries({ queryKey: ['page', 'task-diff', 't2', null] });
  });
  expect(await screen.findByText('代码提交已变化，批注可能已过期')).toBeInTheDocument();

  const submitBtn = screen.getByRole('button', { name: '打包发送给当前线程返工' });
  expect(submitBtn).toBeDisabled();

  await user.click(screen.getByRole('checkbox', { name: '确认内容仍适用并发送' }));
  expect(submitBtn).toBeEnabled();
  await user.click(submitBtn);

  await waitFor(() => expect(calls).toHaveLength(1));
  expect(calls[0]!.path).toBe('/api/tasks/t2/inputs');
  expect((calls[0]!.body as { text: string }).text).toContain('这里需要补测试');
});

test('degrades gracefully to fallbackChanges on 404 and supports checkpoint rollback when >= 2 commits exist', async () => {
  const fallback = renderPanel(
    {
      taskId: 't-fallback',
      taskState: 'done',
      fallbackChanges: [{ path: 'README.md', op: 'update', patch: '+updated line' }],
    },
    (call) => {
      if (call.path === '/api/tasks/t-fallback/diff') throw refusal('未找到', 404);
      return undefined;
    },
  );
  expect(await screen.findByText('README.md')).toBeInTheDocument();
  expect(screen.getByText('+updated line')).toBeInTheDocument();
  fallback.unmount();

  const rollback = renderPanel(
    {
      taskId: 't-roll',
      taskState: 'ready',
      checkpointCommits: [
        { commit: 'aaaa11112222', label: '第 1 轮' },
        { commit: 'abcdef1234567890', label: '第 2 轮' },
      ],
    },
    (call) => {
      if (call.path === '/api/tasks/t-roll/diff') return SAMPLE_DIFF;
      if (call.method === 'POST' && call.path === '/api/tasks/t-roll/rollback') return { ok: true };
      return undefined;
    },
  );
  await screen.findByText('权威 Git Diff');
  await rollback.user.click(screen.getByRole('button', { name: '回退检查点' }));
  await rollback.user.click(screen.getByRole('button', { name: '确认回退' }));
  await waitFor(() => expect(rollback.calls).toContainEqual({
    path: '/api/tasks/t-roll/rollback',
    method: 'POST',
    body: { commit: 'aaaa11112222' },
  }));
});
