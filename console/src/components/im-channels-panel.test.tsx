import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { expect, test } from 'vitest';
import { go, IDLE_STATE, open, refusal, type Call, type Handler } from '@/test/harness';
import type { ImGroupBinding, Setting } from '@/lib/types';

const unset = { restart: false, stored: false, overridden: false, updated_at: null, updated_by: null };

function makeSettings(over: Record<string, Partial<Setting>> = {}): Setting[] {
  const base: Setting[] = [
    { ...unset, key: 'router.cli', group: '负责人', title: 'Claude Code 路径', help: '负责人用哪个', type: 'file', default: '', value: '' },
    { ...unset, key: 'wecom.botId', group: '消息通道', title: '机器人 Bot ID', help: '填上就启用', type: 'text', empty: '不启用企业微信', default: '', value: 'bot-1' },
    { ...unset, key: 'wecom.owner', group: '消息通道', title: '主人账号', help: '允许谁说话', type: 'text', default: '', value: 'owner-1' },
    { ...unset, key: 'wecom.url', group: '消息通道', title: '网关地址', help: '长连接连到哪', type: 'url', empty: '官方网关', default: '', value: '' },
    { ...unset, key: 'im.wecom.chat', group: '消息通道', title: '企业微信项目对话', help: '项目对话', type: 'boolean', default: true, value: true },
    { ...unset, key: 'im.wecom.notify', group: '消息通道', title: '企业微信主动通知', help: '主动通知', type: 'boolean', default: true, value: true },
    { ...unset, key: 'im.wecom.approveLogin', group: '消息通道', title: '企业微信放行登录', help: '放行登录', type: 'boolean', default: true, value: true },
    { ...unset, key: 'im.weixin.chat', group: '消息通道', title: '微信项目对话', help: '项目对话', type: 'boolean', default: true, value: true },
    { ...unset, key: 'im.weixin.notify', group: '消息通道', title: '微信主动通知', help: '主动通知', type: 'boolean', default: true, value: false },
    { ...unset, key: 'im.weixin.approveLogin', group: '消息通道', title: '微信放行登录', help: '放行登录', type: 'boolean', default: true, value: true },
  ];
  return base.map((item) => ({ ...item, ...over[item.key] }));
}

function makeBinding(over: Partial<ImGroupBinding> = {}): ImGroupBinding {
  return {
    id: 'gb-1',
    created_at: '2030-01-01T00:00:00.000Z',
    updated_at: '2030-01-01T00:00:00.000Z',
    channel: 'wecom',
    chat_id: 'wr_core',
    chat_name: '核心研发群',
    project_id: 'p1',
    project_name: '试跑',
    enabled: true,
    trigger_mode: 'mention_only',
    allow_all_senders: false,
    allowed_senders: ['u1'],
    rule_keywords: [],
    cooldown_seconds: 15,
    inline_context_count: 10,
    accept_media: true,
    notify_events: true,
    last_triggered_at: null,
    ...over,
  };
}

function settingsHandler(opts: {
  settings?: Setting[];
  bindings?: ImGroupBinding[];
  discovered?: object[];
  projects?: { id: string; name: string }[];
  onMutate?: (call: Call) => unknown;
} = {}): Handler {
  let settings = opts.settings ?? makeSettings();
  let bindings = opts.bindings ?? [makeBinding()];
  const discovered = opts.discovered ?? [
    {
      channel: 'wecom',
      chat_id: 'wr_alert_room',
      last_seen_at: '2030-01-02T03:00:00.000Z',
      last_actor: 'bob',
      last_text: 'P0 告警：构建失败',
      message_count: 7,
    },
  ];
  const projects = opts.projects ?? [
    { id: 'p1', name: '试跑' },
    { id: 'p2', name: '生产监控' },
  ];
  return (call) => {
    if (call.method === 'GET' && call.path === '/api/state') {
      return {
        ...IDLE_STATE,
        channels: {
          wecom: { connected: true, error: null },
          weixin: { state: 'connected', error: null },
        },
      };
    }
    if (call.method === 'GET' && call.path === '/api/settings') {
      return {
        settings,
        deployment: [{ title: '数据目录', value: '/data' }],
        wecom: { secret_set: true },
        router: { alive: true, pid: 100, turn: null, error: null, restarting: false },
      };
    }
    if (call.method === 'GET' && call.path === '/api/accounts') return { accounts: [] };
    if (call.method === 'GET' && call.path === '/api/machines') return { machines: [] };
    if (call.method === 'GET' && call.path === '/api/weixin') return { state: 'connected', bot_id: 'wx-bot-1', user_id: 'wx-user-1' };
    if (call.method === 'GET' && call.path === '/api/im/groups') return { bindings, discovered, projects };

    if (call.method !== 'GET' && opts.onMutate) {
      const custom = opts.onMutate(call);
      if (custom !== undefined) return custom;
    }

    if (call.method === 'PUT' && call.path.startsWith('/api/settings/')) {
      const key = decodeURIComponent(call.path.slice('/api/settings/'.length));
      const { value } = call.body as { value: boolean };
      settings = settings.map((item) => (item.key === key ? { ...item, value, stored: true, overridden: true } : item));
      return { settings };
    }
    if (call.method === 'POST' && call.path === '/api/im/groups') {
      const body = call.body as Omit<ImGroupBinding, 'id' | 'created_at' | 'updated_at' | 'project_name' | 'last_triggered_at'>;
      const created = makeBinding({
        ...body,
        id: `gb-${bindings.length + 1}`,
        project_name: projects.find((p) => p.id === body.project_id)?.name ?? body.project_id,
      });
      bindings = [...bindings, created];
      return { binding: created };
    }
    if (call.method === 'PUT' && call.path.startsWith('/api/im/groups/')) {
      const id = decodeURIComponent(call.path.slice('/api/im/groups/'.length));
      const body = call.body as Partial<ImGroupBinding>;
      bindings = bindings.map((item) => (item.id === id ? { ...item, ...body } : item));
      return { binding: bindings.find((item) => item.id === id) };
    }
    if (call.method === 'DELETE' && call.path.startsWith('/api/im/groups/')) {
      const id = decodeURIComponent(call.path.slice('/api/im/groups/'.length));
      bindings = bindings.filter((item) => item.id !== id);
      return {};
    }
    return undefined;
  };
}

test('unified 消息通道 overview shows live channel status and toggles permission matrix with inline feedback', async () => {
  const calls: Call[] = [];
  let failNext = false;
  const { user } = open('#/settings/消息通道', settingsHandler({
    onMutate: (call) => {
      calls.push(call);
      if (failNext) {
        failNext = false;
        throw refusal('账本暂时不可写', 503);
      }
      return undefined;
    },
  }));

  await screen.findByRole('heading', { level: 2, name: '消息通道' });
  const navLinks = within(screen.getByRole('navigation', { name: '设置分组' })).getAllByRole('link').map((el) => el.textContent);
  expect(navLinks).toContain('消息通道');
  expect(navLinks).not.toContain('微信');

  const wecomCard = screen.getByRole('region', { name: '企业微信 通道权限' });
  const weixinCard = screen.getByRole('region', { name: '微信 通道权限' });
  expect(wecomCard).toHaveTextContent('已连接');
  expect(weixinCard).toHaveTextContent('已连接');
  expect(weixinCard).toHaveTextContent('登录 123456');

  // Toggle weixin notify on.
  const weixinNotify = within(weixinCard).getByRole('switch', { name: '微信 · 主动通知' });
  expect(weixinNotify).toHaveAttribute('aria-checked', 'false');
  await user.click(weixinNotify);
  await waitFor(() => expect(calls).toEqual([{ path: '/api/settings/im.weixin.notify', method: 'PUT', body: { value: true } }]));
  await waitFor(() => expect(weixinNotify).toHaveAttribute('aria-checked', 'true'));
  expect(within(weixinCard).getByRole('status')).toHaveTextContent('已保存');

  // Refused toggle shows inline alert beside that capability.
  failNext = true;
  await user.click(within(wecomCard).getByRole('switch', { name: '企业微信 · 放行控制台登录' }));
  expect(await within(wecomCard).findByRole('alert')).toHaveTextContent('账本暂时不可写');
});

test('legacy links #/settings/企业微信 and #/settings/微信 resolve into 消息通道 sub-tabs, and search finds synthetic entries', async () => {
  const { user } = open('#/settings/企业微信', settingsHandler());
  await screen.findByRole('heading', { level: 2, name: '消息通道' });
  expect(screen.getByRole('tab', { name: '企业微信配置' })).toHaveAttribute('aria-selected', 'true');
  expect(screen.getByLabelText('机器人 Bot ID')).toHaveValue('bot-1');
  expect(screen.getByLabelText('Secret')).toBeInTheDocument();

  await go('#/settings/微信');
  await waitFor(() => expect(screen.getByRole('tab', { name: '微信连接' })).toHaveAttribute('aria-selected', 'true'));
  expect(await screen.findByText('微信已连接')).toBeInTheDocument();

  // Search for synthetic entry 群聊绑定.
  const search = screen.getByRole('combobox', { name: '搜索设置' });
  await user.type(search, '群聊绑定');
  const results = await screen.findByRole('listbox', { name: '搜索结果' });
  await user.click(within(results).getByRole('option', { name: /群聊绑定/ }));
  await waitFor(() => expect(screen.getByRole('tab', { name: '群聊绑定' })).toHaveAttribute('aria-selected', 'true'));
  expect(await screen.findByRole('listitem', { name: '群聊绑定 核心研发群' })).toBeInTheDocument();
});

test('group bindings manager supports quick-bind, Fast Path rules creation, validation, edit, and confirm delete', async () => {
  const calls: Call[] = [];
  const { user } = open('#/settings/消息通道', settingsHandler({
    onMutate: (call) => {
      calls.push(call);
      return undefined;
    },
  }));

  await screen.findByRole('heading', { level: 2, name: '消息通道' });
  await user.click(screen.getByRole('tab', { name: '群聊绑定' }));

  // Existing binding row + discovered unbound group appear.
  const existingRow = await screen.findByRole('listitem', { name: '群聊绑定 核心研发群' });
  expect(existingRow).toHaveTextContent('试跑');
  expect(existingRow).toHaveTextContent('仅 @ 机器人');
  expect(screen.getByText('wr_alert_room')).toBeInTheDocument();

  // Quick-bind discovered group with Fast Path rules.
  await user.click(screen.getByRole('button', { name: '一键绑定' }));
  const sheet = await screen.findByRole('dialog', { name: '绑定群聊' });
  expect(within(sheet).getByRole('combobox', { name: '群聊通道' })).toHaveValue('wecom');
  expect(within(sheet).getByRole('option', { name: '微信（暂仅支持私聊）' })).toBeDisabled();
  expect(within(sheet).getByRole('textbox', { name: '群 ID' })).toHaveValue('wr_alert_room');

  await user.type(within(sheet).getByRole('textbox', { name: '群备注名' }), '线上告警企微群');
  await user.selectOptions(within(sheet).getByRole('combobox', { name: '绑定项目' }), 'p2');
  await user.click(within(sheet).getByText('@ 或快通道规则'));
  await user.type(within(sheet).getByRole('textbox', { name: '快通道关键词或正则' }), 'P0告警\n/error|panic/i');
  await user.type(within(sheet).getByRole('textbox', { name: '额外允许的发送者' }), 'bob\nalice');

  const cooldownInput = within(sheet).getByRole('spinbutton', { name: '冷却合并窗口（秒）' });
  expect(cooldownInput).toHaveAttribute('min', '0');
  expect(cooldownInput).toHaveAttribute('max', '86400');
  fireEvent.change(cooldownInput, { target: { value: '30' } });
  const contextInput = within(sheet).getByRole('spinbutton', { name: '群内联上下文条数' });
  expect(contextInput).toHaveAttribute('min', '0');
  expect(contextInput).toHaveAttribute('max', '20');
  fireEvent.change(contextInput, { target: { value: '12' } });
  await user.click(within(sheet).getByRole('switch', { name: '延迟接收群图片或文件' }));

  await user.click(within(sheet).getByRole('button', { name: '确认绑定' }));
  await waitFor(() => expect(calls).toHaveLength(1));
  expect(calls[0]).toEqual({
    path: '/api/im/groups',
    method: 'POST',
    body: {
      channel: 'wecom',
      chat_id: 'wr_alert_room',
      chat_name: '线上告警企微群',
      project_id: 'p2',
      enabled: true,
      trigger_mode: 'mention_or_rules',
      allow_all_senders: false,
      allowed_senders: ['bob', 'alice'],
      rule_keywords: ['P0告警', '/error|panic/i'],
      cooldown_seconds: 30,
      inline_context_count: 12,
      accept_media: false,
      notify_events: true,
    },
  });

  // New binding is rendered and discovered card is hidden now that it's bound.
  const createdRow = await screen.findByRole('listitem', { name: '群聊绑定 线上告警企微群' });
  expect(createdRow).toHaveTextContent('@ 或快通道规则');
  expect(createdRow).toHaveTextContent('P0告警、/error|panic/i');

  // Edit existing binding (channel & chat_id locked).
  await user.click(within(existingRow).getByRole('button', { name: '编辑' }));
  const editSheet = await screen.findByRole('dialog', { name: '编辑群聊绑定' });
  expect(within(editSheet).getByRole('combobox', { name: '群聊通道' })).toBeDisabled();
  expect(within(editSheet).getByRole('textbox', { name: '群 ID' })).toBeDisabled();
  await user.click(within(editSheet).getByText('允许群内全员'));
  await user.click(within(editSheet).getByRole('button', { name: '保存修改' }));
  await waitFor(() => expect(calls).toHaveLength(2));
  expect(calls[1]).toMatchObject({
    path: '/api/im/groups/gb-1',
    method: 'PUT',
    body: { allow_all_senders: true },
  });

  // Delete requires confirm dialog.
  await user.click(within(await screen.findByRole('listitem', { name: '群聊绑定 线上告警企微群' })).getByRole('button', { name: '解绑' }));
  const confirm = await screen.findByRole('alertdialog', { name: '解绑群聊 线上告警企微群？' });
  await user.click(within(confirm).getByRole('button', { name: '确认解绑' }));
  await waitFor(() => expect(calls).toHaveLength(3));
  expect(calls[2]).toEqual({ path: '/api/im/groups/gb-2', method: 'DELETE', body: undefined });
});

test('group binding sheet fails loudly inline when required chat_id is empty, rejects inline_context_count > 20, and disables weixin channel option', async () => {
  const calls: Call[] = [];
  const { user } = open('#/settings/消息通道', settingsHandler({
    onMutate: (call) => {
      calls.push(call);
      return undefined;
    },
  }));

  await screen.findByRole('heading', { level: 2, name: '消息通道' });
  await user.click(screen.getByRole('tab', { name: '群聊绑定' }));
  await user.click(await screen.findByRole('button', { name: '绑定群聊' }));
  const sheet = await screen.findByRole('dialog', { name: '绑定群聊' });

  expect(within(sheet).getByRole('option', { name: '微信（暂仅支持私聊）' })).toBeDisabled();

  await user.click(within(sheet).getByRole('button', { name: '确认绑定' }));
  expect(await within(sheet).findByRole('alert')).toHaveTextContent('请填写群 ID');

  await user.type(within(sheet).getByRole('textbox', { name: '群 ID' }), 'wr_bounds_check');
  fireEvent.change(within(sheet).getByRole('spinbutton', { name: '群内联上下文条数' }), { target: { value: '21' } });
  await user.click(within(sheet).getByRole('button', { name: '确认绑定' }));
  expect(await within(sheet).findByRole('alert')).toHaveTextContent('0 到 20');

  fireEvent.change(within(sheet).getByRole('spinbutton', { name: '群内联上下文条数' }), { target: { value: '10' } });
  fireEvent.change(within(sheet).getByRole('spinbutton', { name: '冷却合并窗口（秒）' }), { target: { value: '86401' } });
  await user.click(within(sheet).getByRole('button', { name: '确认绑定' }));
  expect(await within(sheet).findByRole('alert')).toHaveTextContent('0 到 86400');

  expect(calls).toHaveLength(0);
});
