// Guards the ways a Codex or dsh login is obtained in the one "添加账号" window
// (docs/design/native-login.md, the Codex and dsh accounts). Against: an API key saved without
// its executor, or under the word for another secret; a line saved without its kind or the
// fields that kind asks, or with tiers that name another line; "从线路读取" asking without the
// key typed here, or its answer not offered to the tiers; a machine sign-in started on a machine
// that is not there, its address opened in this tab, its code not shown whole, a window closed
// halfway leaving it running on the machine, and the tiers of the new login saved anywhere but
// under that machine; and any of these ways asking for a name — an account is named by the
// service, and a machine sign-in makes no account at all.
import { screen, waitFor, within } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import type { SignInView } from '@shared/sign-in.ts';
import { GEMINI_SETTINGS_JSON, tierFormSpec } from '@shared/tier-form.ts';
import { deferred, open, type Call } from '@/test/harness';
import { ACCOUNTS_PAGE, LIST, MACHINES, nodeMachine, own } from '@/test/logins';

// The dsh adapter's own declaration, as the service hands it over (tests/account-line-http.test.ts
// checks that it does): two kinds of line, the custom one with its fields.
const DSH_FORM = {
  lines: [
    {
      id: 'custom', route: 'tycho', label: '自定义线路', fields: [
        { name: 'baseURL', kind: 'text', label: '地址' },
        { name: 'api', kind: 'choice', label: '协议', options: [{ value: 'openai-completions', label: 'OpenAI Chat Completions' }, { value: 'anthropic-messages', label: 'Anthropic Messages' }] },
        { name: 'models', kind: 'models', label: '模型', efforts: ['off', 'high', 'max'], image: '能看图' },
        { name: 'more', kind: 'more', label: '线路的其他设置' },
      ],
    },
    { id: 'official', route: 'deepseek-official', label: 'DeepSeek 官方', fields: [] },
  ],
  key: { label: 'API 密钥', hint: '由 tycho 保管' },
};

const CODEX_ON_B1 = nodeMachine('b1', {
  connected: true,
  executors: { at: '2026-11-11T00:00:00Z', executors: [{ executor: 'codex', installed: true, version: 'codex-cli 0.162.0', logged_in: false }] },
});

const dialog = () => screen.getByRole('dialog');

async function page(handler: (call: Call) => unknown = () => undefined) {
  const p = open('#/accounts', async (call: Call) => {
    if (call.method === 'GET' && call.path === LIST) {
      return {
        ...ACCOUNTS_PAGE,
        executors: ['claude', 'codex', 'dsh', 'gemini'],
        credential_executors: ['claude', 'codex', 'dsh', 'gemini'],
        tier_forms: {
          ...ACCOUNTS_PAGE.tier_forms,
          gemini: tierFormSpec({ ...GEMINI_SETTINGS_JSON, fields: ['model', 'effort'], efforts: ['low', 'medium', 'high'] }),
        },
        account_logins: {
          ...ACCOUNTS_PAGE.account_logins,
          codex: [{ way: 'device', available: false, why: '此主机暂不支持' }, { way: 'key', available: true }, { way: 'machine', available: true }],
          dsh: [{ way: 'provider', available: true }],
          gemini: [{ way: 'machine', available: true }, { way: 'key', available: true }, { way: 'provider', available: true }],
        },
        provider_forms: { dsh: DSH_FORM },
      };
    }
    // A test may say what the machine reports, as it changes.
    if (call.method === 'GET' && call.path === '/api/machines') return (await handler(call)) ?? { machines: [...MACHINES.filter(({ id }) => id !== 'b1'), CODEX_ON_B1], invites: [], host_entry: null };
    if (call.method === 'GET' && call.path === '/api/node/joins') return { protocol: 1, joins: [] };
    return handler(call);
  });
  await screen.findByRole('heading', { level: 1, name: '账号' });
  await screen.findByRole('region', { name: 'gpu' });
  return p;
}

async function choose(p: Awaited<ReturnType<typeof page>>, executor: string, way: RegExp): Promise<void> {
  await p.user.click(screen.getByRole('button', { name: '添加账号' }));
  await p.user.click(within(dialog()).getByRole('radio', { name: new RegExp(`^${executor}`) }));
  await p.user.click(within(dialog()).getByRole('radio', { name: way }));
  expect(within(dialog()).queryByLabelText('名字'), '不问名字').toBeNull();
  await p.user.click(within(dialog()).getByRole('button', { name: '下一步' }));
}

// One tier row's model box, by its place.
const tierRow = (place: number) => within(dialog()).getByRole('group', { name: `第 ${place} 个档位` });

test('添加账号窗口只列集中保管的登录方式（过滤单机登录）；填 API 密钥就在同一个窗口里接着填密钥和档位', async () => {
  const created: unknown[] = [];
  const p = await page((call) => {
    if (call.method === 'POST' && call.path === LIST) { created.push(call.body); return { account: { id: 'k1', name: 'codex-key', executor: 'codex', credential: 'set', tiers: {}, queued_tasks: 0 }, created: true }; }
    return undefined;
  });
  await p.user.click(screen.getByRole('button', { name: '添加账号' }));
  await p.user.click(within(dialog()).getByRole('radio', { name: /^codex/ }));
  const ways = within(dialog()).getByRole('group', { name: '怎么登录' });
  const radios = within(ways).getAllByRole('radio');
  expect(radios.map((radio) => radio.closest('label')!.textContent)).toEqual([
    expect.stringMatching(/^设备码授权登录/),
    expect.stringMatching(/^填 API 密钥/),
  ]);
  await p.user.click(within(dialog()).getByRole('radio', { name: /^填 API 密钥/ }));
  await p.user.click(within(dialog()).getByRole('button', { name: '下一步' }));
  expect(within(dialog()).queryByLabelText('名字'), '密钥那一步也不问名字').toBeNull();
  const key = within(dialog()).getByLabelText('API 密钥');
  expect(key).toHaveAttribute('type', 'password');
  await p.user.click(within(dialog()).getByRole('button', { name: '保存' }));
  expect(within(dialog()).getByRole('alert')).toHaveTextContent('先填 API 密钥');
  await p.user.type(key, 'sk-codex-0001');
  await p.user.type(within(tierRow(1)).getAllByRole('textbox')[0]!, 'gpt-5.5');
  await p.user.click(within(dialog()).getByRole('button', { name: '保存' }));
  await waitFor(() => expect(created).toHaveLength(1));
  expect(created[0]).toMatchObject({ executor: 'codex', credential: 'sk-codex-0001', tiers: { operate: { kind: 'content', text: 'model=gpt-5.5\n' } } });
  expect(created[0], '名字由服务起').not.toHaveProperty('name');
});

test('dsh 选线路：官方线路只要密钥；从线路读取用刚填的密钥问，读到的模型档位里能选；保存带线路，档位写的是这条线路', async () => {
  const created: { provider?: unknown; tiers?: Record<string, { text: string }>; credential?: string }[] = [];
  const asked: unknown[] = [];
  const p = await page((call) => {
    if (call.path === '/api/account-lines/models') { asked.push(call.body); return { models: [{ id: 'deepseek-flash' }, { id: 'deepseek-v4-pro' }], at: '2026-11-11T00:00:00Z' }; }
    if (call.method === 'POST' && call.path === LIST) { created.push(call.body as never); return { account: { id: 'd1', name: 'ds', executor: 'dsh', credential: 'set', tiers: {}, queued_tasks: 0, provider: { line: 'official' } }, created: true }; }
    return undefined;
  });
  await choose(p, 'dsh', /^选一条线路/);
  await p.user.click(within(dialog()).getByRole('radio', { name: /DeepSeek 官方/ }));
  expect(within(dialog()).queryByLabelText('地址'), '官方线路不问地址').toBeNull();
  await p.user.type(within(dialog()).getByLabelText('API 密钥'), 'sk-ds-0001');
  await p.user.click(within(dialog()).getByRole('button', { name: '从线路读取模型' }));
  await within(dialog()).findByText(/读到 2 个模型/);
  expect(asked).toEqual([{ executor: 'dsh', provider: { line: 'official' }, key: 'sk-ds-0001' }]);
  // The line decides the provider: the row does not ask it.
  expect(within(tierRow(1)).queryByText('provider')).toBeNull();
  await p.user.selectOptions(within(tierRow(1)).getAllByRole('combobox')[0]!, 'deepseek-v4-pro');
  await p.user.click(within(dialog()).getByRole('button', { name: '保存' }));
  await waitFor(() => expect(created).toHaveLength(1));
  expect(created[0]!.provider).toEqual({ line: 'official' });
  expect(created[0], '名字由服务起').not.toHaveProperty('name');
  expect(created[0]!.credential).toBe('sk-ds-0001');
  expect(created[0]!.tiers!.operate!.text).toMatch(/provider: deepseek-official/);
  expect(created[0]!.tiers!.operate!.text).toMatch(/model: deepseek-v4-pro/);
  expect(created[0]!.tiers!.execute, '没填的档位是这个账号不接的档位').toBeUndefined();
});

test('dsh 自定义线路：地址、协议、模型和它的强度原样交给服务；手写的模型就是档位能选的', async () => {
  const created: { provider?: unknown }[] = [];
  const p = await page((call) => {
    if (call.method === 'POST' && call.path === LIST) { created.push(call.body as never); return { account: { id: 'd2', name: 'gw', executor: 'dsh', credential: 'set', tiers: {}, queued_tasks: 0 }, created: true }; }
    return undefined;
  });
  await choose(p, 'dsh', /^选一条线路/);
  await p.user.type(within(dialog()).getByLabelText('地址'), 'http://10.0.0.8:53000/v1');
  await p.user.type(within(dialog()).getByLabelText('第 1 个模型的名字'), 'm1');
  const model = within(dialog()).getByRole('group', { name: '第 1 个模型' });
  await p.user.click(within(model).getByRole('checkbox', { name: 'high' }));
  await p.user.click(within(model).getByRole('checkbox', { name: '能看图' }));
  await p.user.type(within(dialog()).getByLabelText('API 密钥'), 'sk-gw-0001');
  await p.user.selectOptions(within(tierRow(2)).getAllByRole('combobox')[0]!, 'm1');
  await p.user.click(within(dialog()).getByRole('button', { name: '保存' }));
  await waitFor(() => expect(created).toHaveLength(1));
  expect(created[0]!.provider).toEqual({ line: 'custom', baseURL: 'http://10.0.0.8:53000/v1', api: 'openai-completions', models: [{ id: 'm1', efforts: ['high'], image: true }] });
});

function signIns(over: Partial<SignInView> = {}) {
  let at: SignInView = { id: 'S1', machine: 'b1', executor: 'codex', state: 'starting', url: null, code: null, reason: null, signed_in: false, ...over };
  return {
    move: (change: Partial<SignInView>) => { at = { ...at, ...change }; },
    handle: (call: Call): unknown => {
      if (call.method === 'POST' && call.path === '/api/sign-ins') return { sign_in: at };
      if (call.method === 'GET' && call.path === '/api/sign-ins/S1') return { sign_in: at };
      if (call.method === 'POST' && call.path === '/api/sign-ins/S1/cancel') { at = { ...at, state: 'cancelled' }; return { sign_in: at }; }
      return undefined;
    },
  };
}

// The machine as it reports itself once the sign-in is over: signed in, and the models it lists
// signed in — the vendor's, not the command's built-in ones it listed before.
const SIGNED_IN_B1 = {
  ...nodeMachine('b1', { connected: true, executors: { at: '2026-11-11T00:01:00Z', executors: [{ executor: 'codex', installed: true, version: 'codex-cli 0.162.0', logged_in: true }] } }),
  logins: [own('b1', 'codex', { configured: false, tiers: {}, models: { list: [{ id: 'gpt-6.1-sol' }, { id: 'gpt-6.1-terra' }], at: '2026-11-11T00:01:00Z', refreshing: false } })],
};
const BEFORE_B1 = { ...CODEX_ON_B1, logins: [own('b1', 'codex', { configured: false, tiers: {}, models: { list: [{ id: 'gpt-6-astra' }, { id: 'gpt-5.5' }], at: '2026-11-11T00:00:00Z', refreshing: false } })] };

async function machinesPage(handler: (call: Call) => unknown = () => undefined) {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query.includes('1024px'),
    media: query,
    addEventListener() {},
    removeEventListener() {},
  }));
  const p = open('#/machines', async (call: Call) => {
    if (call.method === 'GET' && call.path === LIST) {
      return {
        ...ACCOUNTS_PAGE,
        executors: ['claude', 'codex', 'dsh', 'gemini'],
        credential_executors: ['claude', 'codex', 'dsh', 'gemini'],
        tier_forms: {
          ...ACCOUNTS_PAGE.tier_forms,
          gemini: tierFormSpec({ ...GEMINI_SETTINGS_JSON, fields: ['model', 'effort'], efforts: ['low', 'medium', 'high'] }),
        },
        account_logins: {
          ...ACCOUNTS_PAGE.account_logins,
          codex: [{ way: 'device', available: false, why: '此主机暂不支持' }, { way: 'key', available: true }, { way: 'machine', available: true }],
          dsh: [{ way: 'provider', available: true }],
          gemini: [{ way: 'machine', available: true }, { way: 'key', available: true }, { way: 'provider', available: true }],
        },
        provider_forms: { dsh: DSH_FORM },
      };
    }
    if (call.method === 'GET' && call.path === '/api/machines') return (await handler(call)) ?? { machines: [...MACHINES.filter(({ id }) => id !== 'b1'), CODEX_ON_B1], invites: [], host_entry: null };
    if (call.method === 'GET' && call.path === '/api/node/joins') return { protocol: 1, joins: [] };
    return handler(call);
  });
  await screen.findByRole('heading', { level: 1, name: '机器' });
  return p;
}

async function openMachineSignIn(p: Awaited<ReturnType<typeof machinesPage>>): Promise<void> {
  await p.user.click(await screen.findByRole('button', { name: '选择机器 b1' }));
  const b1 = await screen.findByRole('region', { name: '机器 b1' });
  const row = within(b1).getByRole('group', { name: /^b1 上的 codex/ });
  await p.user.click(within(row).getByRole('button', { name: '重新登录' }));
}

test('机器页上的 Codex 单机登录：网址在新标签页打开、用户码完整可复制；登录好后档位存到那台机器上', async () => {
  const flow = signIns();
  const saved: Call[] = [];
  let reported = false;
  const p = await machinesPage((call) => {
    if (call.method === 'GET' && call.path === '/api/machines') return { machines: [...MACHINES.filter(({ id }) => id !== 'b1'), reported ? SIGNED_IN_B1 : BEFORE_B1], invites: [], host_entry: null };
    if (call.method === 'PUT' && call.path.startsWith('/api/machines/')) { saved.push(call); return { machine: SIGNED_IN_B1 }; }
    return flow.handle(call);
  });
  await openMachineSignIn(p);
  expect(within(dialog()).queryByLabelText('名字'), '机器上的登录不是账号，不起名字').toBeNull();
  await p.user.click(within(dialog()).getByRole('button', { name: '开始登录' }));
  expect(p.calls.find((call) => call.path === '/api/sign-ins')!.body).toEqual({ machine: 'b1', machine_uid: 'uid-b1', executor: 'codex' });
  flow.move({ state: 'waiting', url: 'https://auth.openai.com/codex/device', code: 'ABCD-12345' });
  const link = await within(dialog()).findByRole('link', { name: '打开验证页' }, { timeout: 3000 });
  expect(link).toHaveAttribute('href', 'https://auth.openai.com/codex/device');
  expect(link).toHaveAttribute('target', '_blank');
  expect(within(dialog()).getByText('ABCD-12345')).toBeInTheDocument();
  await p.user.click(within(dialog()).getByRole('button', { name: /^复制用户码/ }));
  expect(await navigator.clipboard.readText()).toBe('ABCD-12345');
  flow.move({ state: 'done', signed_in: true });
  await within(dialog()).findByText(/已登录。填好下面的档位保存后即可接活/, undefined, { timeout: 3000 });
  // The list it reported signed out is not offered: the tiers wait for the signed-in one.
  expect(within(dialog()).getByText(/正在等那台机器报告登录后能用的模型/)).toBeInTheDocument();
  expect(within(dialog()).queryByRole('group', { name: '第 1 个档位' })).toBeNull();
  reported = true;
  const row = await within(dialog()).findByRole('group', { name: '第 2 个档位' }, { timeout: 3000 });
  expect(within(dialog()).queryByLabelText('API 密钥')).toBeNull();
  const choices = within(row).getAllByRole('combobox')[0]!;
  expect(within(choices).getAllByRole('option').map((option) => option.textContent)).toEqual(expect.arrayContaining(['gpt-6.1-terra']));
  expect(within(choices).queryByRole('option', { name: 'gpt-5.5' }), '登录前的旧列表不再出现').toBeNull();
  await p.user.selectOptions(choices, 'gpt-6.1-terra');
  await p.user.click(within(dialog()).getByRole('button', { name: '保存' }));
  await waitFor(() => expect(saved).toHaveLength(1));
  expect(saved[0]!.path).toBe('/api/machines/uid-b1/logins/codex');
  expect(saved[0]!.body).toMatchObject({ tiers: { execute: { kind: 'content', text: 'model=gpt-6.1-terra\n' } } });
  expect(p.calls.some((call) => call.path.endsWith('/cancel')), '登录好了不取消').toBe(false);
});

test('登录完成时表单从那台机器现有的登录读初值：现有档位保留，保存走同一个接口', async () => {
  const flow = signIns();
  const saved: Call[] = [];
  const tiers = { decide: { kind: 'content', text: 'model_reasoning_effort=high\n' }, execute: { kind: 'content', text: 'model_reasoning_effort=medium\n' } };
  const existing = own('b1', 'codex', { tiers, models: { list: [{ id: 'gpt-x' }], at: '2026-11-11T00:01:00Z', refreshing: false } });
  const machine = {
    ...nodeMachine('b1', { connected: true, executors: { at: '2026-11-11T00:01:00Z', executors: [{ executor: 'codex', installed: true, version: 'codex-cli 0.162.0', logged_in: true }] } }),
    logins: [existing],
  };
  const p = await machinesPage((call) => {
    if (call.method === 'GET' && call.path === '/api/machines') return { machines: [machine], invites: [], host_entry: null };
    if (call.method === 'PUT' && (call.path.startsWith('/api/machines/') || call.path.startsWith('/api/logins/'))) { saved.push(call); return { machine }; }
    return flow.handle(call);
  });
  await openMachineSignIn(p);
  await p.user.click(within(dialog()).getByRole('button', { name: '开始登录' }));
  flow.move({ state: 'done', signed_in: true });
  const decide = await within(dialog()).findByRole('group', { name: '第 3 个档位' }, { timeout: 3000 });
  expect(within(decide).getByLabelText('推理强度')).toHaveValue('high');
  expect(within(dialog()).getByText(/模型留空就是机器上这个执行器自己的默认/)).toBeInTheDocument();
  await p.user.click(within(dialog()).getByRole('button', { name: '保存' }));
  await waitFor(() => expect(saved).toHaveLength(1));
  expect(saved[0]!.path).toBe('/api/machines/uid-b1/logins/codex');
  const body = saved[0]!.body as { tiers: Record<string, { text: string }> };
  expect(body.tiers.decide!.text).toBe('model_reasoning_effort=high\n');
  expect(body.tiers.execute!.text).toBe('model_reasoning_effort=medium\n');
});

test('登录完成先于已配置登录报告到达时，等待已配置的登录初始化档位', async () => {
  const flow = signIns();
  const saved: Call[] = [];
  let adopted = false;
  const tiers = { decide: { kind: 'content', text: 'model_reasoning_effort=high\n' }, execute: { kind: 'content', text: 'model_reasoning_effort=medium\n' } };
  const machine = { ...SIGNED_IN_B1, logins: [own('b1', 'codex', { tiers })] };
  const p = await machinesPage((call) => {
    if (call.method === 'GET' && call.path === '/api/machines') return { machines: [adopted ? machine : BEFORE_B1], invites: [], host_entry: null };
    if (call.method === 'PUT' && call.path.startsWith('/api/machines/')) { saved.push(call); return { machine }; }
    return flow.handle(call);
  });
  await openMachineSignIn(p);
  await p.user.click(within(dialog()).getByRole('button', { name: '开始登录' }));
  flow.move({ state: 'done', signed_in: true });
  await within(dialog()).findByText(/已登录。填好下面的档位保存后即可接活/, undefined, { timeout: 3000 });
  adopted = true;
  const decide = await within(dialog()).findByRole('group', { name: '第 3 个档位' }, { timeout: 3000 });
  await waitFor(() => expect(within(decide).getByLabelText('推理强度')).toHaveValue('high'));
  expect(within(tierRow(2)).getByLabelText('推理强度')).toHaveValue('medium');
  await p.user.click(within(dialog()).getByRole('button', { name: '保存' }));
  await waitFor(() => expect(saved).toHaveLength(1));
  expect(saved[0]!.body).toMatchObject({ tiers });
});

test('机器上的登录进行到一半关窗口：取消那台机器上的这次登录', async () => {
  const flow = signIns({ state: 'waiting', url: 'https://auth.openai.com/codex/device', code: 'ABCD-12345' });
  const p = await machinesPage(flow.handle);
  await openMachineSignIn(p);
  await p.user.click(within(dialog()).getByRole('button', { name: '开始登录' }));
  await within(dialog()).findByText('ABCD-12345');
  await p.user.keyboard('{Escape}');
  await waitFor(() => expect(p.calls.some((call) => call.path === '/api/sign-ins/S1/cancel')).toBe(true));
});

test('机器上的登录失败：只说固定原因，可以再试一次', async () => {
  const flow = signIns();
  const p = await machinesPage(flow.handle);
  await openMachineSignIn(p);
  await p.user.click(within(dialog()).getByRole('button', { name: '开始登录' }));
  flow.move({ state: 'failed', reason: '等太久，这次的用户码已作废，再试一次' });
  await within(dialog()).findByText(/没有登录成功。等太久/, undefined, { timeout: 3000 });
  expect(within(dialog()).getByRole('button', { name: '再试一次' })).toBeEnabled();
});

test('离线机器上的执行器不开启单机重登流程', async () => {
  const offlineB1 = nodeMachine('b1', {
    connected: false,
    executors: { at: '2026-11-11T00:00:00Z', executors: [{ executor: 'codex', installed: true, version: 'codex-cli 0.162.0', logged_in: false }] },
  });
  const p = await machinesPage((call) => {
    if (call.method === 'GET' && call.path === '/api/machines') return { machines: [offlineB1], invites: [], host_entry: null };
    return undefined;
  });
  const b1 = await screen.findByRole('region', { name: '机器 b1' });
  await p.user.click(within(b1).getByRole('button', { name: '重新登录' }));
  expect(dialog()).toHaveTextContent('这台机器没有在线，或没有报告可用的 codex');
  expect(within(dialog()).getByRole('button', { name: '开始登录' })).toBeDisabled();
});

test('一个线路账号：卡片上说是哪条线路；修改抽屉里能改线路，保存带上新线路，档位跟着写新线路', async () => {
  const LINE_ACCOUNT = {
    id: 'd1', name: 'gw', executor: 'dsh', credential: 'set', permission_mode: null, timeout_ms: null, max_runs: null, queued_tasks: 0,
    provider: { line: 'custom', api: 'openai-completions', baseURL: 'http://10.0.0.8:53000/v1', models: [{ id: 'm1', efforts: ['high'] }] },
    tiers: { decide: { kind: 'content', text: '- id: agent-default-model\n  config:\n    provider: tycho\n    model: m1\n' } },
  };
  const saved: Call[] = [];
  const p = open('#/accounts', async (call: Call) => {
    if (call.method === 'GET' && call.path === LIST) return { ...ACCOUNTS_PAGE, accounts: [...ACCOUNTS_PAGE.accounts, LINE_ACCOUNT], provider_forms: { dsh: DSH_FORM } };
    if (call.method === 'GET' && call.path === '/api/machines') return { machines: MACHINES, invites: [], host_entry: null };
    if (call.method === 'GET' && call.path === '/api/node/joins') return { protocol: 1, joins: [] };
    if (call.method === 'PUT' && call.path === '/api/accounts/d1') { saved.push(call); return { account: LINE_ACCOUNT, created: false }; }
    return undefined;
  });
  await p.user.click(await screen.findByRole('button', { name: '选择账号 gw' }));
  const card = await screen.findByRole('region', { name: 'gw' });
  expect(card).toHaveTextContent('自定义线路 · http://10.0.0.8:53000/v1');
  await p.user.click(within(card).getByRole('button', { name: '修改' }));
  const drawer = await screen.findByRole('dialog', { name: '修改 gw' });
  expect(within(drawer).getByRole('textbox', { name: '地址' })).toHaveValue('http://10.0.0.8:53000/v1');
  await p.user.click(within(drawer).getByRole('radio', { name: /DeepSeek 官方/ }));
  await p.user.click(within(drawer).getByRole('button', { name: '保存' }));
  await waitFor(() => expect(saved).toHaveLength(1));
  const body = saved[0]!.body as { provider: unknown; tiers: Record<string, { text: string }>; credential?: string };
  expect(body.provider).toEqual({ line: 'official' });
  expect(body.tiers.decide!.text).toMatch(/provider: deepseek-official/);
  expect(body.credential, '换线路不换密钥').toBeUndefined();
});

test('开始登录的答复还没回来就关窗口：答复一到就取消那台机器上的这次登录', async () => {
  const flow = signIns({ state: 'waiting', url: 'https://auth.openai.com/codex/device', code: 'ABCD-12345' });
  const gate = deferred();
  const p = await machinesPage(async (call) => {
    if (call.method === 'POST' && call.path === '/api/sign-ins') await gate.promise;
    return flow.handle(call);
  });
  await openMachineSignIn(p);
  await p.user.click(within(dialog()).getByRole('button', { name: '开始登录' }));
  await p.user.keyboard('{Escape}');
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  gate.resolve(undefined);
  await waitFor(() => expect(p.calls.some((call) => call.path === '/api/sign-ins/S1/cancel')).toBe(true));
});

test('添加账号里的 Gemini 官方授权（机器保管）：排第一并标推荐，一步走完贴授权码与保存默认档位', async () => {
  const googleUrl = 'https://accounts.google.com/o/oauth2/auth?client_id=agy&redirect_uri=https%3A%2F%2Fantigravity.google%2Foauth-callback';
  let view: SignInView = {
    id: 'G1',
    machine: 'b1',
    executor: 'gemini',
    state: 'waiting',
    url: googleUrl,
    code: null,
    accepts_code: true,
    reason: null,
    signed_in: null,
  };
  let signedIn = false;
  const submittedCodes: unknown[] = [];
  const saved: Call[] = [];
  const geminiBefore = nodeMachine('b1', {
    connected: true,
    executors: { at: '2026-11-18T00:00:00Z', executors: [{ executor: 'gemini', installed: true, version: 'agy 1.5.10', logged_in: null }] },
  });
  const geminiAfter = {
    ...nodeMachine('b1', {
      connected: true,
      executors: { at: '2026-11-18T00:01:00Z', executors: [{ executor: 'gemini', installed: true, version: 'agy 1.5.10', logged_in: null }] },
    }),
    logins: [
      own('b1', 'gemini', {
        configured: true,
        tiers: {
          decide: { kind: 'content', text: '{\n  "effort": "high"\n}\n' },
          execute: { kind: 'content', text: '{\n  "effort": "medium"\n}\n' },
        },
        models: { list: [{ id: 'gemini-3.1-pro' }, { id: 'gemini-2.5-flash' }], at: '2026-11-18T00:01:00Z', refreshing: false },
      }),
    ],
  };

  const p = await page((call) => {
    if (call.method === 'GET' && call.path === '/api/machines') {
      return { machines: [...MACHINES.filter(({ id }) => id !== 'b1'), signedIn ? geminiAfter : geminiBefore], invites: [], host_entry: null };
    }
    if (call.method === 'POST' && call.path === '/api/sign-ins') return { sign_in: view };
    if (call.method === 'GET' && call.path === '/api/sign-ins/G1') return { sign_in: view };
    if (call.method === 'POST' && call.path === '/api/sign-ins/G1/code') {
      submittedCodes.push(call.body);
      view = { ...view, state: 'exchanging', accepts_code: undefined };
      return { sign_in: view };
    }
    if (call.method === 'PUT' && call.path === '/api/machines/uid-b1/logins/gemini') {
      saved.push(call);
      return { machine: geminiAfter };
    }
    return undefined;
  });

  await p.user.click(screen.getByRole('button', { name: '添加账号' }));
  await p.user.click(within(dialog()).getByRole('radio', { name: /^gemini/ }));
  const ways = within(dialog()).getByRole('group', { name: '怎么登录' });
  const radios = within(ways).getAllByRole('radio');
  expect(radios.map((radio) => radio.closest('label')!.textContent)).toEqual([
    expect.stringMatching(/^在官方页面授权（机器保管）.*推荐/),
    expect.stringMatching(/^填 API 密钥/),
    expect.stringMatching(/^选一条线路/),
  ]);
  expect(radios[0]).toBeChecked();

  await p.user.click(within(dialog()).getByRole('button', { name: '下一步' }));
  await p.user.click(within(dialog()).getByRole('button', { name: '开始登录' }));
  expect(p.calls.find((call) => call.path === '/api/sign-ins')?.body).toEqual({ machine: 'b1', executor: 'gemini' });

  const link = await within(dialog()).findByRole('link', { name: '打开授权页' });
  expect(link).toHaveAttribute('href', googleUrl);
  expect(link).toHaveAttribute('target', '_blank');

  const codeBox = within(dialog()).getByLabelText('授权码');
  await p.user.type(codeBox, 'https://antigravity.google/oauth-callback?code=4/0AeanS0Test&state=1');
  await p.user.click(within(dialog()).getByRole('button', { name: '提交授权码' }));
  await waitFor(() => expect(submittedCodes).toEqual([{ code: 'https://antigravity.google/oauth-callback?code=4/0AeanS0Test&state=1' }]));
  expect(within(dialog()).getByText(/正在那台机器上向官方验证授权码/)).toBeInTheDocument();

  signedIn = true;
  view = { ...view, state: 'done' };
  const decideRow = await within(dialog()).findByRole('group', { name: '第 3 个档位' }, { timeout: 3000 });
  await waitFor(() => expect(within(decideRow).getByLabelText('推理强度')).toHaveValue('high'));
  expect(within(tierRow(2)).getByLabelText('推理强度')).toHaveValue('medium');

  await p.user.click(within(dialog()).getByRole('button', { name: '保存' }));
  await waitFor(() => expect(saved).toHaveLength(1));
  expect(saved[0]!.body).toMatchObject({
    tiers: {
      decide: { kind: 'content', text: '{\n  "effort": "high"\n}\n' },
      execute: { kind: 'content', text: '{\n  "effort": "medium"\n}\n' },
    },
  });
});
