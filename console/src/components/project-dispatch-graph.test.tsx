import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { ProjectDispatchGraph } from '@/components/project-dispatch-graph';
import type { Project, Task } from '@/lib/types';
import { open } from '@/test/harness';

const project: Project = {
  id: 'p1',
  name: 'TY-cluster-alert-fix',
  sources: [],
  logins: [],
  login_mode: 'all',
  machines: [],
  spawn_machines: false,
  router: { account: 'gemini', tier: 'decide' },
  moving: 1,
  waiting: 1,
};

const now = Date.now();
const isoAgo = (minutes: number): string => new Date(now - minutes * 60_000).toISOString();

const makeTask = (overrides: Partial<Task> & { id: string; title: string; state: string }): Task => ({
  project_id: 'p1',
  parent_id: null,
  source: null,
  source_state: null,
  source_label: null,
  created_at: isoAgo(15),
  updated_at: isoAgo(1),
  summary: { dot: overrides.state, text: '', counts: {}, leaf: true },
  ...overrides,
});

const sampleWorks: Task[] = [
  makeTask({
    id: 'w-upgrade',
    title: 'md-gateway TickType=7 升级',
    state: 'running',
    created_at: isoAgo(12),
    assignment: {
      role_id: 'r1',
      role_name: '协调者',
      tier: 'decide',
      tier_source: 'role',
      login_name: 'gemini',
      executor: 'gemini',
      machine_name: 'DP-DM',
      placed_by: 'order',
      is_live: true,
    },
  }),
  makeTask({
    id: 'w-old',
    title: '上周历史巡检任务',
    state: 'done',
    created_at: new Date(now - 72 * 3600_000).toISOString(),
    finished_at: new Date(now - 48 * 3600_000).toISOString(),
    updated_at: new Date(now - 48 * 3600_000).toISOString(),
  }),
];

const sampleChildren: Task[] = [
  makeTask({
    id: 'c-impl',
    parent_id: 'w-upgrade',
    title: 'merger.rs 兼容 ORDER_STATUS',
    state: 'running',
    created_at: isoAgo(6),
    assignment: {
      role_id: 'r2',
      role_name: '实施',
      tier: 'execute',
      tier_source: 'role',
      login_name: 'codex',
      executor: 'codex',
      machine_name: 'kr',
      placed_by: 'order',
      is_live: true,
    },
  }),
  makeTask({
    id: 'c-rev',
    parent_id: 'w-upgrade',
    title: '独立审阅：合并端兼容风险',
    state: 'ready',
    created_at: isoAgo(3),
    finished_at: isoAgo(1),
    assignment: {
      role_id: 'r3',
      role_name: '审阅',
      tier: 'decide',
      tier_source: 'role',
      login_name: 'gemini',
      executor: 'gemini',
      machine_name: 'kr',
      placed_by: 'spread',
      is_live: false,
    },
  }),
  makeTask({
    id: 'c-cluster',
    parent_id: 'w-upgrade',
    title: '集群 dev 17:30 盘后回归',
    state: 'held',
    created_at: isoAgo(2),
  }),
];

describe('ProjectDispatchGraph', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  test('renders HUD blueprint with telemetry codes, collapses >24h completed works, and routes clicks', async () => {
    const user = userEvent.setup();
    const onSelectTask = vi.fn();
    const onOpenConversation = vi.fn();

    render(
      <ProjectDispatchGraph
        project={project}
        works={sampleWorks}
        children={sampleChildren}
        mode="hud"
        onSelectTask={onSelectTask}
        onOpenConversation={onOpenConversation}
      />,
    );

    const region = screen.getByRole('region', { name: '航天测控派发蓝图' });
    expect(within(region).getByText('SYS.00')).toBeInTheDocument();
    expect(within(region).getByText('WRK.01')).toBeInTheDocument();
    expect(within(region).getByText('SUB.011')).toBeInTheDocument();
    expect(within(region).getByText('REV.012')).toBeInTheDocument();
    expect(within(region).getByText('CLU.013')).toBeInTheDocument();
    expect(within(region).getByText('协调者 // gemini@DP-DM')).toBeInTheDocument();
    expect(within(region).queryByText('上周历史巡检任务')).toBeNull();

    // Expand completed works >24h old
    await user.click(within(region).getByRole('button', { name: '含已完成 (+1)' }));
    expect(within(region).getByText('上周历史巡检任务')).toBeInTheDocument();

    // Click child chip & router chip
    await user.click(within(region).getByRole('button', { name: /merger\.rs 兼容 ORDER_STATUS/ }));
    expect(onSelectTask).toHaveBeenCalledWith('c-impl');

    await user.click(within(region).getByRole('button', { name: /SYS\.00/ }));
    expect(onOpenConversation).toHaveBeenCalledTimes(1);
  });

  test('renders Trace pulse lanes with hierarchy and canvas tone toggle', async () => {
    const user = userEvent.setup();
    const onSelectTask = vi.fn();

    render(
      <ProjectDispatchGraph
        project={project}
        works={sampleWorks}
        children={sampleChildren}
        mode="trace"
        onSelectTask={onSelectTask}
      />,
    );

    const region = screen.getByRole('region', { name: '执行脉搏派发泳道' });
    expect(within(region).getByText('TRACE // 执行脉搏泳道')).toBeInTheDocument();
    expect(within(region).getByText('merger.rs 兼容 ORDER_STATUS')).toBeInTheDocument();
    expect(within(region).getByText('待介入')).toBeInTheDocument();

    // Switch canvas tone from adaptive (default) to deep space
    await user.click(within(region).getByRole('button', { name: '切换为深空暗场画布' }));
    expect(localStorage.getItem('tycho.dispatchGraphTone')).toBe('deep');
    expect(within(region).getByRole('button', { name: '切换为跟随系统主题画布' })).toBeInTheDocument();

    await user.click(within(region).getByRole('button', { name: /集群 dev 17:30 盘后回归/ }));
    expect(onSelectTask).toHaveBeenCalledWith('c-cluster');
  });

  test('Project Work tab switches cleanly between 列表, 蓝图, and 泳道', async () => {
    const app = open('#/projects/p1/work', (call) => {
      if (call.path === '/api/tasks?top=1') {
        return { tasks: [sampleWorks[0]], children: sampleChildren };
      }
      return undefined;
    });

    expect(await screen.findByText('md-gateway TickType=7 升级')).toBeInTheDocument();
    const switcher = screen.getByRole('tablist', { name: '工作视图' });
    expect(within(switcher).getByRole('tab', { name: '列表' })).toHaveAttribute('aria-selected', 'true');

    await app.user.click(within(switcher).getByRole('tab', { name: '蓝图' }));
    expect(screen.getByRole('region', { name: '航天测控派发蓝图' })).toBeInTheDocument();
    expect(localStorage.getItem('tycho.projectWorkView')).toBe('hud');

    await app.user.click(within(switcher).getByRole('tab', { name: '泳道' }));
    expect(screen.getByRole('region', { name: '执行脉搏派发泳道' })).toBeInTheDocument();
    expect(localStorage.getItem('tycho.projectWorkView')).toBe('trace');
  });
});
