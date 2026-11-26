// Guards the inbound sources' page (docs/design/triggers.md §2.2, §7) against: a source's kind,
// projects, address, keys, refusals and problem not said on its row; a new one not sending the
// whole definition in one request; the page not offering the projects it may let through; a key's
// secret shown anywhere but the answer that issued it; and a stop or a delete going without one
// request.
import { expect, test } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import { open, refusal, type Call, type Handler } from '@/test/harness';

const PAGE = '#/inbound';

const aSource = (over: object = {}) => ({
  id: 's1', name: 'GitHub', kind: 'github', kind_label: 'GitHub', project_ids: ['p1'], note: '仓库通知，构建失败时看',
  push_final: false, enabled: true, created_by: 'console', created_at: '2030-01-01T00:00:00.000Z', updated_at: '2030-01-01T00:00:00.000Z',
  rejected: { count: 3, at: '2030-01-01T00:00:00.000Z', reason: 'no_project', text: '没有对应项目：事件没指向这个来源放行的任何项目' },
  problem: null, path: '/inbound/s1', ready: true,
  keys: [{ id: 'K1', created_at: '2030-01-01T00:00:00.000Z', retires_at: null }], ...over,
});

const aPage = (over: object = {}) => ({
  sources: [], recent: [],
  projects: [{ id: 'p1', name: '试跑', repos: ['owner/one'] }],
  kinds: [
    { kind: 'tycho-v1', label: 'tycho-v1（通用）', about: '按 tycho 自己的协议签名投递' },
    { kind: 'github', label: 'GitHub', about: '把一个 GitHub 仓库的推送指到这里' },
  ],
  reach: { reach: 'ready', reach_text: '可以接收', public_url: 'https://tycho.example' },
  ...over,
});

const sourceRow = (name = 'GitHub') => screen.findByRole('region', { name: `入站来源 ${name}` });

test('a read that fails is said in the page alert, where the owner sees it', async () => {
  open(PAGE, (call) => {
    if (call.method === 'GET' && call.path === '/api/inbound') throw refusal('服务暂时不可用', 503);
    return undefined;
  });
  expect(await screen.findByRole('alert')).toHaveTextContent('读不到入站来源：服务暂时不可用');
});

test('each source says its kind, projects, address, keys, refusals and problem', async () => {
  open(PAGE, (call) => {
    if (call.method === 'GET' && call.path === '/api/inbound') {
      return aPage({
        sources: [aSource({ problem: { kind: 'signature', since: '2030-01-01T00:00:00.000Z', text: '入站来源一直验不过签名：看看调用方用的密钥和它的时钟' } })],
      });
    }
    return undefined;
  });
  const row = await sourceRow();
  expect(row).toHaveTextContent('GitHub');
  expect(row).toHaveTextContent('试跑');
  expect(row).toHaveTextContent('https://tycho.example/inbound/s1');
  expect(row).toHaveTextContent('密钥 K1：在用');
  expect(row).toHaveTextContent('仓库通知');
  expect(within(row).getByRole('alert')).toHaveTextContent('入站来源一直验不过签名');
  expect(row).toHaveTextContent('拒收 3 次');
});

test('a source says how a caller picks a project: the number to sign for tycho-v1, the repository for GitHub', async () => {
  const { user } = open(PAGE, (call) => {
    if (call.method === 'GET' && call.path === '/api/inbound') {
      return aPage({
        sources: [
          aSource({ name: '通用', kind: 'tycho-v1', kind_label: 'tycho-v1（通用）', project_ids: ['p1', 'p9'] }),
          aSource({ id: 's2', name: 'Actions', project_ids: ['p2'], path: '/inbound/s2' }),
        ],
        projects: [
          { id: 'p1', name: '试跑', repos: ['owner/one'] },
          { id: 'p2', name: '部署', repos: [] },
        ],
      });
    }
    return undefined;
  });
  const generic = await sourceRow('通用');
  expect(generic).toHaveTextContent('试跑（p1）');
  expect(generic).toHaveTextContent('有的项目已经不在了');
  await user.click(screen.getByRole('button', { name: '选择入站来源 Actions' }));
  const github = await sourceRow('Actions');
  expect(github).toHaveTextContent('部署（没配仓库）');
  // What a tycho-v1 caller signs the project header with has to be readable from the form.
  await user.click(screen.getByRole('button', { name: '选择入站来源 通用' }));
  await user.click(within(await sourceRow('通用')).getByRole('button', { name: '修改' }));
  const drawer = await screen.findByRole('dialog', { name: '修改入站来源' });
  expect(within(drawer).getByText('p1')).toBeInTheDocument();
});

test('a new source is one request of the whole definition, with the projects it may reach', async () => {
  const calls: Call[] = [];
  const { user } = open(PAGE, ((call) => {
    if (call.method === 'GET' && call.path === '/api/inbound') return aPage();
    if (call.method === 'POST' && call.path === '/api/inbound') {
      calls.push(call);
      return { source: aSource({ id: 's2', name: '构建', kind: 'tycho-v1', kind_label: 'tycho-v1（通用）', note: '', project_ids: ['p1'], path: '/inbound/s2', ready: false, keys: [] }) };
    }
    return undefined;
  }) as Handler);
  await user.click(await screen.findByRole('button', { name: '新建来源' }));
  const drawer = await screen.findByRole('dialog', { name: '新建入站来源' });
  await user.type(within(drawer).getByRole('textbox', { name: '入站来源的名字' }), '构建');
  await user.click(within(drawer).getByRole('checkbox', { name: '试跑' }));
  await user.click(within(drawer).getByRole('button', { name: '保存来源' }));
  await waitFor(() => expect(calls.length).toBe(1));
  expect(calls[0]).toEqual({
    path: '/api/inbound',
    method: 'POST',
    body: { name: '构建', kind: 'tycho-v1', project_ids: ['p1'], note: '', push_final: false, result_reply: false, broadcast_groups: false, broadcast_group_ids: [] },
  });
});

test('a key is got from the row, shown once with how to sign, and gone when closed', async () => {
  let current = aSource({ ready: false, keys: [] });
  const calls: Call[] = [];
  const { user } = open(PAGE, ((call) => {
    if (call.method === 'GET' && call.path === '/api/inbound') return aPage({ sources: [current] });
    if (call.method === 'POST' && call.path === '/api/inbound/s1/key') {
      calls.push(call);
      current = aSource();
      return { key_id: 'K1', secret: 'the-secret-once', source: current };
    }
    return undefined;
  }) as Handler);
  const row = await sourceRow();
  expect(row).toHaveTextContent('还没领取密钥');
  await user.click(within(row).getByRole('button', { name: '领取密钥' }));
  const shown = await within(row).findByRole('status', { name: '新密钥' });
  expect(shown).toHaveTextContent('the-secret-once');
  expect(shown).toHaveTextContent('X-Hub-Signature-256');
  expect(calls).toEqual([{ path: '/api/inbound/s1/key', method: 'POST', body: {} }]);
  const after = await sourceRow();
  await waitFor(() => expect(after).toHaveTextContent('密钥 K1：在用'));
  await user.click(within(shown).getByRole('button', { name: '我已保存，关掉' }));
  await waitFor(() => expect(within(after).queryByRole('status', { name: '新密钥' })).toBeNull());
});

test('a stop and a delete are each one request, and the delete asks first', async () => {
  let sources = [aSource()];
  const calls: Call[] = [];
  const { user } = open(PAGE, ((call) => {
    if (call.method === 'GET' && call.path === '/api/inbound') return aPage({ sources });
    if (call.method === 'POST' && call.path === '/api/inbound/s1/enabled') {
      calls.push(call);
      sources = [aSource({ enabled: false })];
      return { source: sources[0] };
    }
    if (call.method === 'DELETE') {
      calls.push(call);
      sources = [];
      return {};
    }
    return undefined;
  }) as Handler);
  const row = await sourceRow();
  await user.click(within(row).getByRole('button', { name: '停用' }));
  await waitFor(() => expect(calls.at(-1)).toEqual({ path: '/api/inbound/s1/enabled', method: 'POST', body: { enabled: false } }));
  const stopped = await sourceRow();
  await user.click(within(stopped).getByRole('button', { name: '删除' }));
  const confirm = await screen.findByRole('alertdialog', { name: '删除入站来源 GitHub？' });
  await user.click(within(confirm).getByRole('button', { name: '确认删除 GitHub' }));
  await waitFor(() => expect(calls.at(-1)).toEqual({ path: '/api/inbound/s1', method: 'DELETE', body: undefined }));
});

test('主人能在受理记录中展开来源已获准回读的具体答复', async () => {
  const { user } = open(PAGE, (call) => {
    if (call.method === 'GET' && call.path === '/api/inbound') {
      return aPage({
        recent: [{ id: 'fire1', event_id: 'event1', created_at: '2030-01-01T00:00:00Z', project_id: 'p1', trigger_name: '飞书', outcome: 'delivered',
          message_state: 'processed', public_reply: '检查完成，结果可公开。' }],
      });
    }
    return undefined;
  });
  const summary = await screen.findByText('已向来源发布的答复');
  await user.click(summary);
  expect(summary.closest('details')).toHaveAttribute('open');
  expect(within(summary.closest('details')!).getByText('检查完成，结果可公开。')).toBeInTheDocument();
});

test('master-detail rail switches sources via click or arrow keys and filters recent deliveries per source', async () => {
  const { user } = open(PAGE, (call) => {
    if (call.method === 'GET' && call.path === '/api/inbound') {
      return aPage({
        sources: [
          aSource({ id: 's1', name: 'GitHub', path: '/inbound/s1', rejected: null }),
          aSource({ id: 's2', name: '构建调度', kind: 'tycho-v1', kind_label: 'tycho-v1（通用）', path: '/inbound/s2', enabled: false, rejected: null }),
        ],
        recent: [
          { id: 'f1', source_id: 's1', trigger_id: null, event_id: 'ev-gh-1', created_at: '2030-01-01T00:00:00Z', project_id: 'p1', trigger_name: 'GitHub', outcome: 'delivered', message_state: 'processed' },
          { id: 'f2', source_id: 's2', trigger_id: null, event_id: 'ev-ci-2', created_at: '2030-01-01T01:00:00Z', project_id: 'p1', trigger_name: '构建调度', outcome: 'delivered', message_state: 'processed' },
        ],
      });
    }
    return undefined;
  });
  expect(await sourceRow('GitHub')).toBeInTheDocument();
  expect(screen.getByText(/ev-gh-1/)).toBeInTheDocument();
  expect(screen.queryByText(/ev-ci-2/)).toBeNull();
  // ArrowDown outside the left rail does not hijack scrolling or switch sources.
  await user.keyboard('{ArrowDown}');
  expect(await sourceRow('GitHub')).toBeInTheDocument();
  // Focusing the left rail and pressing ArrowDown switches to the second source and updates filtered deliveries.
  const firstBtn = screen.getByRole('button', { name: '选择入站来源 GitHub' });
  firstBtn.focus();
  await user.keyboard('{ArrowDown}');
  expect(await sourceRow('构建调度')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '选择入站来源 构建调度' })).toHaveFocus();
  expect(screen.getByText(/ev-ci-2/)).toBeInTheDocument();
  expect(screen.queryByText(/ev-gh-1/)).toBeNull();
  // Toggling "全部来源" shows deliveries from all sources.
  await user.click(screen.getByRole('button', { name: '全部来源 2' }));
  expect(screen.getByText(/ev-gh-1/)).toBeInTheDocument();
  expect(screen.getByText(/ev-ci-2/)).toBeInTheDocument();
});

test('inbound source supports toggling group broadcast, pinning specific bound groups, and showing badges', async () => {
  const calls: Call[] = [];
  let sources = [
    aSource({ id: 's1', name: '告警网关', broadcast_groups: true, broadcast_group_ids: ['g1'] }),
  ];
  const { user } = open(PAGE, ((call) => {
    if (call.method === 'GET' && call.path === '/api/inbound') {
      return aPage({
        sources,
        groups: [
          { id: 'g1', channel: 'wecom', chat_id: 'wr_ops', chat_name: '运维值班群', project_id: 'p1', enabled: true, notify_events: true },
          { id: 'g2', channel: 'weixin', chat_id: 'wx_dev', chat_name: '研发微信群', project_id: 'p1', enabled: true, notify_events: true },
        ],
      });
    }
    if (call.method === 'PUT' && call.path === '/api/inbound/s1') {
      calls.push(call);
      const body = call.body as { broadcast_groups: boolean; broadcast_group_ids: string[] };
      sources = [aSource({ id: 's1', name: '告警网关', broadcast_groups: body.broadcast_groups, broadcast_group_ids: body.broadcast_group_ids })];
      return { source: sources[0] };
    }
    return undefined;
  }) as Handler);

  const detail = await sourceRow('告警网关');
  expect(within(detail).getByText('同步播报群')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '选择入站来源 告警网关' })).toHaveTextContent('同步播报群');

  await user.click(within(detail).getByRole('button', { name: '修改' }));
  const drawer = await screen.findByRole('dialog', { name: '修改入站来源' });
  const toggle = within(drawer).getByRole('switch', { name: '同步播报到绑定群' });
  expect(toggle).toHaveAttribute('aria-checked', 'true');
  expect(within(drawer).getByRole('checkbox', { name: '运维值班群' })).toBeChecked();
  await user.click(within(drawer).getByRole('checkbox', { name: '研发微信群' }));
  await user.click(within(drawer).getByRole('button', { name: '保存来源' }));
  await waitFor(() => expect(calls).toHaveLength(1));
  expect(calls[0]!.body).toMatchObject({
    broadcast_groups: true,
    broadcast_group_ids: ['g1', 'g2'],
  });
});

test('standard-webhooks source enforces single-project routing in form, detail, and signing text', async () => {
  const calls: Call[] = [];
  let sources = [
    aSource({
      id: 'sw1',
      name: '集群告警',
      kind: 'standard-webhooks',
      kind_label: 'Standard Webhooks',
      project_ids: ['p1'],
      path: '/inbound/sw1',
      ready: false,
      keys: [],
      rejected: null,
    }),
  ];
  const { user } = open(PAGE, ((call) => {
    if (call.method === 'GET' && call.path === '/api/inbound') {
      return aPage({
        sources,
        projects: [
          { id: 'p1', name: '试跑', repos: ['owner/one'] },
          { id: 'p2', name: '生产监控', repos: [] },
        ],
        kinds: [
          { kind: 'tycho-v1', label: 'tycho-v1（通用）', about: '按 tycho 自己的协议签名投递' },
          { kind: 'standard-webhooks', label: 'Standard Webhooks', about: '按 Standard Webhooks v1 验签' },
          { kind: 'github', label: 'GitHub', about: '把一个 GitHub 仓库的推送指到这里' },
        ],
      });
    }
    if (call.method === 'POST' && call.path === '/api/inbound/sw1/key') {
      sources = [{ ...sources[0]!, ready: true, keys: [{ id: 'K1', created_at: '2030-01-01T00:00:00.000Z', retires_at: null }] }];
      return { key_id: 'K1', secret: 'whsec_testsecret', source: sources[0] };
    }
    if (call.method === 'POST' && call.path === '/api/inbound') {
      calls.push(call);
      return {
        source: aSource({
          id: 'sw2',
          name: '新告警源',
          kind: 'standard-webhooks',
          kind_label: 'Standard Webhooks',
          project_ids: ['p2'],
          path: '/inbound/sw2',
          ready: false,
          keys: [],
        }),
      };
    }
    return undefined;
  }) as Handler);

  const detail = await sourceRow('集群告警');
  expect(detail).toHaveTextContent('单项目直达（Standard Webhooks v1 签名不含项目头）');

  // Key signing instructions should not mention X-Tycho-Project multi-project routing.
  await user.click(within(detail).getByRole('button', { name: '领取密钥' }));
  const shown = await within(detail).findByRole('status', { name: '新密钥' });
  expect(shown).toHaveTextContent('whsec_testsecret');
  expect(shown).toHaveTextContent('单');
  expect(shown).not.toHaveTextContent('X-Tycho-Project');

  // Creating a new source: selecting 2 projects then switching to standard-webhooks trims to 1,
  // and clicking another project replaces the selection instead of adding a second.
  await user.click(screen.getByRole('button', { name: '新建来源' }));
  const drawer = await screen.findByRole('dialog', { name: '新建入站来源' });
  await user.type(within(drawer).getByRole('textbox', { name: '入站来源的名字' }), '新告警源');
  await user.click(within(drawer).getByRole('checkbox', { name: '试跑' }));
  await user.click(within(drawer).getByRole('checkbox', { name: '生产监控' }));
  expect(within(drawer).getByRole('checkbox', { name: '试跑' })).toBeChecked();
  expect(within(drawer).getByRole('checkbox', { name: '生产监控' })).toBeChecked();

  await user.selectOptions(within(drawer).getByRole('combobox', { name: '翻译器种类' }), 'standard-webhooks');
  expect(drawer).toHaveTextContent('Standard Webhooks 协议签名不含项目头，每个来源只放行 1 个项目');
  expect(within(drawer).getByRole('checkbox', { name: '试跑' })).toBeChecked();
  expect(within(drawer).getByRole('checkbox', { name: '生产监控' })).not.toBeChecked();

  await user.click(within(drawer).getByRole('checkbox', { name: '生产监控' }));
  expect(within(drawer).getByRole('checkbox', { name: '试跑' })).not.toBeChecked();
  expect(within(drawer).getByRole('checkbox', { name: '生产监控' })).toBeChecked();

  await user.click(within(drawer).getByRole('button', { name: '保存来源' }));
  await waitFor(() => expect(calls).toHaveLength(1));
  expect(calls[0]!.body).toMatchObject({
    name: '新告警源',
    kind: 'standard-webhooks',
    project_ids: ['p2'],
  });
});
