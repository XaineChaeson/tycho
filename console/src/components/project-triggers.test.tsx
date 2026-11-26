import { screen, waitFor, within } from '@testing-library/react';
import { expect, test } from 'vitest';
import { open, type Call } from '@/test/harness';

const PROJECT = {
  id: 'p1',
  name: '试跑',
  sources: [],
  login_mode: 'all',
  logins: [],
  machines: [],
  spawn_machines: false,
  moving: 0,
  waiting: 0,
};

const leaf = (dot: string) => ({ dot, text: '', counts: {}, leaf: true });

test('event trigger form lets users pick existing project tasks from a dropdown with manual ULID fallback', async () => {
  const calls: Call[] = [];
  const { user } = open('#/projects/p1/triggers', (call) => {
    if (call.method === 'GET' && call.path === '/api/projects') return { projects: [PROJECT] };
    if (call.method === 'GET' && call.path === '/api/projects/p1/triggers') {
      return { triggers: [], recent: [], zone: 'Asia/Shanghai', min_interval_ms: 300_000 };
    }
    if (call.method === 'GET' && call.path === '/api/tasks?top=1') {
      return {
        tasks: [
          { id: '01WORKAAAA1111111111111111', title: '重构登录流程', state: 'running', project_id: 'p1', summary: leaf('running') },
          { id: '01OTHERBBB2222222222222222', title: '别的项目的任务', state: 'running', project_id: 'p2', summary: leaf('running') },
        ],
        children: [
          { id: '01CHILDCCC3333333333333333', parent_id: '01WORKAAAA1111111111111111', title: '前端改造子任务', state: 'queued', project_id: 'p1', summary: leaf('queued') },
        ],
      };
    }
    if (call.method === 'POST' && call.path === '/api/projects/p1/triggers') {
      calls.push(call);
      return { trigger: { id: 'tr-new' } };
    }
    return undefined;
  });

  const section = await screen.findByRole('region', { name: '试跑 的触发器' });
  await user.click(within(section).getByRole('button', { name: '新建触发器' }));
  const form = await screen.findByRole('dialog', { name: '新建触发器' });
  await user.type(within(form).getByRole('textbox', { name: '触发器的名字' }), '验收后通知');
  await user.type(within(form).getByRole('textbox', { name: '固定指令' }), '汇报结果');
  await user.selectOptions(within(form).getByRole('combobox', { name: '来源' }), 'event');

  // Project tasks (including child tasks) are offered by title; other projects' tasks are excluded.
  const picker = within(form).getByRole('combobox', { name: '选择监听任务' }) as HTMLSelectElement;
  const optionLabels = [...picker.options].map((opt) => opt.textContent);
  expect(optionLabels).toEqual([
    '本项目的全部任务',
    '重构登录流程（01WORKAA）',
    '↳ 前端改造子任务（01CHILDC）',
    '手动输入任务编号…',
  ]);
  expect(within(form).queryByRole('textbox', { name: '只看这个任务' })).toBeNull();

  // Pick a child task by title and submit.
  await user.selectOptions(picker, '01CHILDCCC3333333333333333');
  await user.click(within(form).getByRole('button', { name: '保存触发器' }));
  await waitFor(() => expect(calls).toHaveLength(1));
  expect(calls[0]!.body).toMatchObject({
    source: 'event',
    event: { kind: 'work_ready', task_id: '01CHILDCCC3333333333333333' },
  });

  // Reopen and switch to manual ULID entry.
  await user.click(within(section).getByRole('button', { name: '新建触发器' }));
  const second = await screen.findByRole('dialog', { name: '新建触发器' });
  await user.type(within(second).getByRole('textbox', { name: '触发器的名字' }), '历史任务');
  await user.type(within(second).getByRole('textbox', { name: '固定指令' }), '跟进');
  await user.selectOptions(within(second).getByRole('combobox', { name: '来源' }), 'event');
  await user.selectOptions(within(second).getByRole('combobox', { name: '选择监听任务' }), '__manual__');
  await user.type(within(second).getByRole('textbox', { name: '只看这个任务' }), '01MANUAL99');
  await user.click(within(second).getByRole('button', { name: '保存触发器' }));
  await waitFor(() => expect(calls).toHaveLength(2));
  expect(calls[1]!.body).toMatchObject({
    source: 'event',
    event: { kind: 'work_ready', task_id: '01MANUAL99' },
  });
});

test('master-detail workbench syncs selection with the 24h schedule timeline and supports filtering', async () => {
  const now = new Date();
  const futureA = new Date(now.getTime() + 60 * 60_000);
  const futureB = new Date(now.getTime() + 2 * 60 * 60_000);
  const fmtLocal = (d: Date) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
  const triggers = [
    {
      id: 't1', project_id: 'p1', name: '早盘核对', enabled: true, source: 'schedule',
      schedule: { kind: 'once', at: futureA.toISOString() }, schedule_text: '一次性', event: null,
      instruction: '检查 `md-merge` 启动状态', missed: 'latest', expires_at: null, push_final: true,
      revision: 1, created_by: 'console', created_at: now.toISOString(), updated_at: now.toISOString(),
      zone: 'UTC', next_at: futureA.toISOString(), next_local: fmtLocal(futureA), ended: null,
      next_error: null, rejected: null, problem: null,
    },
    {
      id: 't2', project_id: 'p1', name: '盘后封日', enabled: true, source: 'schedule',
      schedule: { kind: 'once', at: futureB.toISOString() }, schedule_text: '一次性', event: null,
      instruction: '核验 `state-merger.json` 封日', missed: 'latest', expires_at: null, push_final: false,
      revision: 1, created_by: 'console', created_at: now.toISOString(), updated_at: now.toISOString(),
      zone: 'UTC', next_at: futureB.toISOString(), next_local: fmtLocal(futureB), ended: null,
      next_error: null, rejected: null, problem: null,
    },
    {
      id: 't3', project_id: 'p1', name: '验收播报', enabled: true, source: 'event',
      schedule: null, schedule_text: '内部事件：可验收', event: { kind: 'work_ready', task_id: null },
      instruction: '汇总验收结论', missed: 'latest', expires_at: null, push_final: true,
      revision: 1, created_by: 'console', created_at: now.toISOString(), updated_at: now.toISOString(),
      zone: 'UTC', next_at: null, next_local: null, ended: null,
      next_error: null, rejected: null, problem: null,
    },
  ];
  const { user } = open('#/projects/p1/triggers', (call) => {
    if (call.method === 'GET' && call.path === '/api/projects') return { projects: [PROJECT] };
    if (call.method === 'GET' && call.path === '/api/projects/p1/triggers') {
      return { triggers, recent: [], zone: 'UTC', min_interval_ms: 300_000 };
    }
    if (call.method === 'GET' && call.path === '/api/tasks?top=1') return { tasks: [], children: [] };
    return undefined;
  });

  const section = await screen.findByRole('region', { name: '试跑 的触发器' });
  // First trigger selected by default
  expect(await within(section).findByRole('article', { name: '触发器详情 早盘核对' })).toBeInTheDocument();

  // Clicking second node on the 24h schedule timeline switches the right inspector
  const nodeB = within(section).getByRole('button', { name: /调度节点 .* 盘后封日/ });
  await user.click(nodeB);
  expect(await within(section).findByRole('article', { name: '触发器详情 盘后封日' })).toBeInTheDocument();
  expect(nodeB).toHaveAttribute('aria-pressed', 'true');

  // Filtering to 事件 narrows the left rail and selects the event trigger
  await user.click(within(section).getByRole('tab', { name: /事件 1/ }));
  expect(await within(section).findByRole('article', { name: '触发器详情 验收播报' })).toBeInTheDocument();
  expect(within(section).queryByRole('listitem', { name: '触发器 早盘核对' })).toBeNull();
});

test('completed one-shot triggers stay out of 运行中, move into 已结束 tab, and support clone + batch clear', async () => {
  const now = new Date();
  const deleted: string[] = [];
  let triggers = [
    {
      id: 't-active', project_id: 'p1', name: '每日早检', enabled: true, source: 'schedule',
      schedule: { kind: 'cron', expr: '0 8 * * *', zone: 'UTC' }, schedule_text: 'cron 0 8 * * *', event: null,
      instruction: '每天巡检', missed: 'latest', expires_at: null, push_final: false,
      revision: 1, created_by: 'console', created_at: now.toISOString(), updated_at: now.toISOString(),
      zone: 'UTC', next_at: new Date(now.getTime() + 3600_000).toISOString(), next_local: '2030-01-01 08:00',
      ended: null, next_error: null, rejected: null, problem: null,
    },
    {
      id: 't-done', project_id: 'p1', name: '昨日一次性核验', enabled: true, source: 'schedule',
      schedule: { kind: 'once', at: '2026-11-25T00:45:00.000Z' }, schedule_text: '一次性', event: null,
      instruction: '只读核查昨日上线', missed: 'latest', expires_at: null, push_final: true,
      revision: 1, created_by: 'console', created_at: now.toISOString(), updated_at: now.toISOString(),
      zone: 'UTC', next_at: null, next_local: null,
      ended: 'done', next_error: null, rejected: null, problem: null,
    },
  ];
  const { user } = open('#/projects/p1/triggers', (call) => {
    if (call.method === 'GET' && call.path === '/api/projects') return { projects: [PROJECT] };
    if (call.method === 'GET' && call.path === '/api/projects/p1/triggers') {
      return { triggers, recent: [], zone: 'UTC', min_interval_ms: 300_000 };
    }
    if (call.method === 'GET' && call.path === '/api/tasks?top=1') return { tasks: [], children: [] };
    if (call.method === 'DELETE' && call.path.startsWith('/api/triggers/')) {
      const id = call.path.slice('/api/triggers/'.length);
      deleted.push(id);
      triggers = triggers.filter((t) => t.id !== id);
      return {};
    }
    return undefined;
  });

  const section = await screen.findByRole('region', { name: '试跑 的触发器' });
  // Default tab is 运行中: completed one-shot trigger is excluded
  expect(await within(section).findByRole('listitem', { name: '触发器 每日早检' })).toBeInTheDocument();
  expect(within(section).queryByRole('listitem', { name: '触发器 昨日一次性核验' })).toBeNull();

  // Switch to 已结束 tab
  await user.click(within(section).getByRole('tab', { name: /已结束 1/ }));
  const detail = await within(section).findByRole('article', { name: '触发器详情 昨日一次性核验' });

  // Clone opens a new trigger sheet prefilled with instruction & empty time
  await user.click(within(detail).getByRole('button', { name: '复用再建' }));
  const form = await screen.findByRole('dialog', { name: '新建触发器' });
  expect(within(form).getByRole('textbox', { name: '触发器的名字' })).toHaveValue('昨日一次性核验');
  expect(within(form).getByRole('textbox', { name: '固定指令' })).toHaveValue('只读核查昨日上线');
  await user.click(within(form).getByRole('button', { name: '取消' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

  // Batch clear ended triggers
  await user.click(within(section).getByRole('button', { name: /清空已结束/ }));
  const confirm = await screen.findByRole('alertdialog', { name: '清空 1 条已结束触发器？' });
  await user.click(within(confirm).getByRole('button', { name: '确认清空 1 条' }));
  await waitFor(() => expect(deleted).toEqual(['t-done']));
});
