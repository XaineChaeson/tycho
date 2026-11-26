// Guards the accounts page (docs/design/accounts-machines-decoupled.md "控制台"): it lists
// the logins tycho keeps itself — an account is a login token, and where its work runs
// is decided at dispatch — so no machine card may appear here, and it lists the machines'
// own logins beside the accounts in one section of their own, edited with the same form and
// the same endpoint the machines page uses. And, as it always did, that credential controls
// do not expose stored values,
// an account is not offered on an executor that takes no token, one is not made without a
// token, a new one is asked for a name (the service names it; the name is changed on the
// account afterwards), a token cannot be taken off, a refused token is not leaked through errors, and the
// account-wide mutation lock is not lost. Also: machines listed under an account (where it
// runs is decided at dispatch), a save in the wrong unit or shape (minutes for milliseconds, a tier's kind or its
// text lost, an empty field sent as a value), an "add" that silently overwrites an account of
// the same name, a refused save that loses the form or its reason, a consent to overwrite a
// tier carried over from the tier clicked before it, an account with work on it deleted
// without its cost being shown first or one that still asks after the owner agreed; a change
// the service took showing as the old account again (because the read after it failed, or
// because the owner left the page while it was on its way and came back to a page free to
// send a second change over it); and a connection test started twice, one that asks more
// than one machine shown as several, or one with no machine to ask said as nothing. And what the service has learned of an account not reaching the owner: a
// resting account or one at its ceiling reading as usable or as a fault, a rest with no time
// or no reason, usage not shown, "现在就试" missing, sent twice, or leaving the page on the
// old state, and a ceiling that cannot be set, read back or cleared. And the window a new
// account is made in knowing an executor by name instead of drawing what each one declares:
// the next executor that can be an account, or the next way to obtain a login, would then
// need the window rewritten. And a reason kept only in a hover: a rejected login with no way
// to sign in again on this host must say why where a touch screen can read it. And each
// tier's dispatch order: not shown, moved in both columns at once, or saved as anything but
// the whole order the section shows.
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { expect, test } from 'vitest';
import { modelText, tierText } from '@shared/labels.ts';
import { TIERS } from '@shared/tiers.ts';
import { POLL_MS } from '@/lib/queries';
import { deferred, go, holdClock, pass, refusal, type Call } from '@/test/harness';
import { ACCOUNTS_PAGE, ADD, CODEX, CX, GPU, LEGACY, MODELS, NARROWED, SERVICE_NAMED, TIERED, accountsApp, accountsPage, loginsApp, nodeMachine, numbered, own, saved, unreadable, type LoginsApp } from '@/test/logins';
import { RETIRED_TIER_STANDING } from '@shared/logins.ts';

// In the Master-Detail split view, select a centralized account or machine-own login in the left rail.
const selectAccount = (name: string): void => {
  const button = screen.queryByRole('button', { name: `选择账号 ${name}`, hidden: true });
  if (button) fireEvent.click(button);
};
const selectOwn = (machine: string, executor: string, accountLabel?: string): void => {
  const parts = [machine, executor, ...(accountLabel ? [accountLabel] : [])];
  fireEvent.click(screen.getByRole('button', { name: `选择单机登录 ${parts.join(' · ')}`, hidden: true }));
};
// Wait for a numbered read to appear in the left rail.
const drawnRead = (read: number) => screen.findByRole('button', { name: `选择账号 第 ${read} 次读到`, hidden: true });

// Everything that would send a change from this page. Deleting an account and replacing its
// token are behind the card's "更多", so that button is what is held for them.
const held = (p: LoginsApp) => {
  selectAccount('gpu');
  const gpuEdit = p.button('gpu', '修改')!.disabled;
  const gpuMore = p.more('gpu')!.disabled;
  selectAccount('cx');
  const cxMore = p.more('cx')!.disabled;
  selectAccount('gpu');
  return [gpuEdit, gpuMore, cxMore, p.add()!.disabled];
};
// The executor an account's card names beside its name.
const executorOf = (p: LoginsApp, name: string) => within(p.target(name)!).getByTitle('执行器');

test('清空仅有模型的结构化档位后不再提交该档', async () => {
  const account = { ...GPU, executor: 'codex', tiers: { decide: { kind: 'content', text: 'model=example\n' } } };
  const p = await accountsApp(saved, () => accountsPage(account));
  await p.click('gpu', '修改');
  const row = within(p.form('gpu')!).getByRole('group', { name: '第 3 个档位' });
  await p.user.clear(within(row).getByLabelText('模型'));
  await p.submit('gpu');
  await waitFor(() => expect(p.calls).toHaveLength(1));
  expect((p.calls[0]!.body as { tiers: unknown }).tiers).toEqual({});
});

test('机器登录的空文本档位说明使用本机配置，未提供的档位说明不接活', async () => {
  const login = own('b1', 'dsh', { tiers: { decide: { kind: 'content', text: '' } } });
  const machine = { ...nodeMachine('b1', { connected: true }), logins: [login] };
  const p = await loginsApp({ hash: '#/accounts', title: '账号', readMachines: () => [machine], answer: saved });
  selectOwn('b1', 'dsh');
  const card = screen.getByRole('region', { name: /机器 b1.*dsh/ });
  await p.user.click(within(card).getByRole('button', { name: '修改' }));
  const drawer = screen.getByRole('dialog');
  expect(within(drawer).getByRole('group', { name: '第 3 个档位' })).toHaveTextContent('不改这台机器上执行器自己的配置');
  expect(within(drawer).getByRole('group', { name: '第 1 个档位' })).toHaveTextContent(tierText.blankOperate);
  expect(within(drawer).getByRole('group', { name: '第 2 个档位' })).toHaveTextContent(tierText.blank);
  await p.user.click(within(drawer).getByRole('button', { name: '保存' }));
  await waitFor(() => expect(p.calls.some((call) => call.method === 'PUT')).toBe(true));
  expect(p.calls.find((call) => call.method === 'PUT')!.body).toMatchObject({ tiers: { decide: { kind: 'content', text: '' } } });
});

test('confirmed subscription surfaces freshest quota directly on the centralized account and folds duplicate machine login inline', async () => {
  const at = '2026-11-12T12:34:56.000Z';
  const login = own('b1', 'claude', { status: status({ usage: [{ window: 'five_hour', used: 0.75, resets_at: null, at }] }) });
  const machine = { ...nodeMachine('b1', { connected: true }), logins: [login] };
  await loginsApp({ hash: '#/accounts', title: '账号', readMachines: () => [machine],
    read: () => ({ ...accountsPage(RESTING, CX), login_groups: [['gpu', login.id]] }) });
  const accountCard = screen.getByRole('region', { name: 'gpu' });
  expect(accountCard).toHaveAttribute('id', 'gpu');
  expect(within(accountCard).getByText(/5 小时窗口 75%/)).toBeVisible();
  expect(within(accountCard).getByRole('button', { name: '修改' })).toBeEnabled();
  // Same-identity machine login is NOT duplicated as an independent entry in the left rail
  expect(screen.queryByRole('button', { name: /选择单机登录 b1 · claude/ })).toBeNull();
  // Instead, it is surfaced inline under the centralized account with a cleanup button
  expect(within(accountCard).getByText(/同账号本机冗余登录（1 台）/)).toBeVisible();
  expect(within(accountCard).getByText('b1/claude')).toBeVisible();
  expect(within(accountCard).getByRole('button', { name: '删除冗余登录' })).toBeEnabled();
  selectAccount('cx');
  expect(screen.getByRole('region', { name: 'cx' })).toBeInTheDocument();
});

test('同一台机器的同名账号按执行器区分，dsh 显示默认线路，并在派发策略页按逻辑账号分槽', async () => {
  const claude = own('b1', 'claude', { account_label: 'sample' });
  const codex = own('b1', 'codex', { account_label: 'sample' });
  const dsh = own('b1', 'dsh', { route_label: 'custom-gw' });
  const logins = [claude, codex, dsh];
  const machine = { ...nodeMachine('b1', { connected: true }), logins };
  const p = await loginsApp({ hash: '#/accounts', title: '账号', readMachines: () => [machine],
    read: () => ({ ...accountsPage(), dispatch_order: { decide: logins.map((login) => login.id!), execute: [], operate: [] } }) });
  selectOwn('b1', 'claude', 'sample');
  expect(within(screen.getByRole('region', { name: 'sample' })).getByTitle('执行器').textContent).toBe('claude');
  selectOwn('b1', 'codex', 'sample');
  expect(within(screen.getByRole('region', { name: 'sample' })).getByTitle('执行器').textContent).toBe('codex');
  selectOwn('b1', 'dsh');
  const dshCard = screen.getByRole('region', { name: /b1.*dsh/ });
  expect(within(dshCard).getByText('默认线路 custom-gw')).toBeVisible();
  expect(within(dshCard).getByRole('heading', { name: 'DSH' })).toBeVisible();
  expect(within(dshCard).getByTitle('执行器')).toHaveTextContent('dsh');
  expect(within(dshCard).getByText('机器 b1')).toBeVisible();

  await p.user.click(screen.getByRole('tab', { name: /派发策略/ }));
  const decide = screen.getByRole('region', { name: '决策档派发槽位' });
  expect(decide).toHaveTextContent('DSH · custom-gw');
});

test('accounts page separates 账号池 and 派发策略 tabs, and priority slots persist via PUT /api/dispatch/slots', async () => {
  const sent: { method: string; path: string; body: unknown }[] = [];
  const p = await accountsApp((call) => {
    if (call.method !== 'PUT') return undefined;
    sent.push({ method: call.method, path: call.path, body: call.body });
    const b = call.body as { tier: string; p1: string[]; p2: string[]; off: string[] };
    return { dispatch_slots: { [b.tier]: { p1: b.p1, p2: b.p2, off: b.off } }, dispatch_order: { [b.tier]: [...b.p1, ...b.p2] } };
  });
  // Default tab is 账号池: shows clean accounts without top dispatch order clutter, plus explicit execution permission
  expect(screen.queryByRole('region', { name: '各档位全局默认派发策略' })).toBeNull();
  const gpuCard = screen.getByRole('region', { name: 'gpu' });
  expect(gpuCard).toHaveTextContent('执行权限（防卡死保障）');
  expect(gpuCard).toHaveTextContent('acceptEdits');

  // Switch to 派发策略 tab
  await p.user.click(screen.getByRole('tab', { name: /派发策略/ }));
  const policy = screen.getByRole('region', { name: '各档位全局默认派发策略' });
  const decide = within(policy).getByRole('region', { name: '决策档派发槽位' });
  // Initially gpu is in P1 and cx is in P2; promote cx to P1 for parallel load balancing
  const cxGroup = within(policy).getByRole('group', { name: '决策档 cx 槽位' });
  await p.user.click(within(cxGroup).getByRole('button', { name: '把 cx 设为 P1' }));
  await waitFor(() => expect(sent).toEqual([{
    method: 'PUT',
    path: '/api/dispatch/slots',
    body: { tier: 'decide', p1: ['gpu', 'cx'], p2: [], off: [] },
  }]));
  expect(decide).toHaveTextContent('均衡');

  // Exclude gpu from decide tier
  const gpuGroup = within(policy).getByRole('group', { name: '决策档 gpu 槽位' });
  await p.user.click(within(gpuGroup).getByRole('button', { name: '把 gpu 设为 停' }));
  await waitFor(() => expect(sent.at(-1)).toEqual({
    method: 'PUT',
    path: '/api/dispatch/slots',
    body: { tier: 'decide', p1: ['cx'], p2: [], off: ['gpu'] },
  }));
});

test('renaming an account displays its name and updates the same opaque identity', async () => {
  const id = '01K00000000000000000000011';
  let current = { ...GPU, id, name: '原来的名字' };
  const p = await accountsApp((call) => {
    const answer = saved(call);
    current = { ...current, ...answer.account };
    return { account: current };
  }, () => accountsPage(current));
  expect(p.target('原来的名字')).toBeInTheDocument();
  expect(p.main()).not.toHaveTextContent(id);
  await p.click('原来的名字', '修改');
  p.type('原来的名字', '名字', '新的名字');
  await p.submit('原来的名字');
  await waitFor(() => expect(p.target('新的名字')).toBeInTheDocument());
  expect(p.calls).toHaveLength(1);
  expect(p.calls[0]).toMatchObject({ method: 'PUT', path: `/api/accounts/${id}`, body: { name: '新的名字' } });
  expect(p.target('原来的名字')).toBeNull();
  await p.click('新的名字', '修改');
  expect(p.control('新的名字', '名字')).toHaveValue('新的名字');
});

test('an account holding a tier that was a file on the machine says so, and is not shown as usable', async () => {
  const text = '账号 cx 的决策档原来写的是机器上的文件或 profile「/etc/tiers/decide.json」：到“账号”页这份登录那里重新填';
  const p = await accountsApp(undefined, () => accountsPage(GPU, { ...CX, tiers: {}, retired_tiers: [{ tier: 'decide', was: '/etc/tiers/decide.json', text }] }));
  expect(within(p.target('gpu')!).getByText('可用')).toBeInTheDocument();
  selectAccount('cx');
  const cx = p.target('cx')!;
  expect(within(cx).getByText(RETIRED_TIER_STANDING)).toBeInTheDocument();
  expect(within(cx).queryByText('可用')).toBeNull();
  expect(cx).toHaveTextContent(text);
});

test('the accounts page lists each account as it is set, and nothing of the machines', async () => {
  const p = await accountsApp();
  const gpu = p.target('gpu')!.textContent!;
  expect(executorOf(p, 'gpu')).toHaveTextContent('claude');
  expect(within(p.target('gpu')!).getByTitle(GPU.tiers.decide.text)).toHaveTextContent('决策档');
  expect(within(p.target('gpu')!).getByTitle(GPU.tiers.execute.text)).toHaveTextContent('执行档');
  expect(gpu).not.toMatch(/配置目录|登录目录/);
  expect(gpu).toMatch(/权限 acceptEdits/);
  expect(gpu).toMatch(/时限 90 分钟/);
  expect(gpu).toMatch(/排队 4/);
  // Where an account runs is decided at dispatch: no machine is listed under it.
  expect(gpu).not.toMatch(/连得上|连不上|还没连过|最近应答|在跑的执行/);
  expect(within(p.target('gpu')!).queryByRole('list', { name: /能用的机器/ })).toBeNull();
  expect(screen.getAllByRole('button', { name: '测试连接' }), '只有账号自己的连接测试').toHaveLength(1);
  selectAccount('cx');
  const cx = p.target('cx')!.textContent!;
  expect(executorOf(p, 'cx')).toHaveTextContent('claude');
  expect(within(p.target('cx')!).getByTitle(CX.tiers.decide.text)).toHaveTextContent('决策档');
  expect(cx).not.toMatch(/登录目录|时限|排队/);
  expect(cx).toMatch(/bypassPermissions/);
  expect(screen.getAllByRole('button', { name: '测试连接' }), '只有账号自己的连接测试').toHaveLength(1);
  expect(p.form(ADD), '没点“添加”之前不摆表单').toBeNull();
  // A machine is not an account: nothing of the machines page is here.
  expect(screen.queryByRole('region', { name: /^机器 / }), '账号页不该有机器卡片').toBeNull();
  expect(screen.queryByRole('button', { name: '接入一台机器' })).toBeNull();
});

test('with no account yet the page says so and offers to add one', async () => {
  const p = await accountsApp(undefined, () => accountsPage());
  expect(p.main()).toHaveTextContent(/还没有集中托管账号/);
  expect(p.main()).toHaveTextContent(/完成一次授权或填入密钥/);
  await p.user.click(p.add()!);
  // Only an executor that takes its login handed over can be picked: the others are machines'
  // own, and are listed as that.
  const executors = within(p.form(ADD)!).getAllByRole<HTMLInputElement>('radio', { name: /^(claude|codex|dsh)/ });
  expect(executors.map((radio) => [radio.checked, radio.disabled])).toEqual([[true, false], [false, true], [false, true]]);
});

test('adding an account posts its token once and no name, the form in pairs and milliseconds, and shows the name the service gave it', async () => {
  let listed: object = ACCOUNTS_PAGE;
  const p = await accountsApp((call) => { listed = accountsPage(GPU, CX, { ...CX, id: '01K00000000000000000000009', name: SERVICE_NAMED }); return saved(call, true); }, () => listed);
  await p.addByKey();
  expect([...(p.control(ADD, '权限模式') as HTMLSelectElement).options].map((option) => option.value)).toEqual(['', 'bypassPermissions', 'acceptEdits', 'default', 'plan']);
  expect(p.control(ADD, '名字'), '新账号不问名字').toBeNull();
  // An account is its token: without one there is nothing to make.
  await p.submit(ADD);
  await waitFor(() => expect(within(p.form(ADD)!).getByRole('alert')).toHaveTextContent(/先填 API 密钥/));
  expect(p.calls).toEqual([]);
  p.type(ADD, 'API 密钥', 'new-private-token');
  p.type(ADD, '档位', 'decide=<模型乙>@high\nexecute=<模型甲>');
  p.type(ADD, '权限模式', 'plan');
  p.type(ADD, '单次执行时限', '90');
  await p.submit(ADD);
  // Read again after it: the list is the service's.
  await waitFor(() => expect(executorOf(p, SERVICE_NAMED)).toHaveTextContent('claude'));
  expect(p.calls).toEqual([{ path: '/api/accounts', method: 'POST', body: {
    executor: 'claude', credential: 'new-private-token',
    // The tier's text is written from what the owner filled in, and only from that.
    tiers: {
      decide: { kind: 'content', text: '{\n  "model": "<模型乙>",\n  "effortLevel": "high"\n}\n' },
      execute: { kind: 'content', text: '{\n  "model": "<模型甲>"\n}\n' },
    },
    permission_mode: 'plan', timeout_ms: 5_400_000, max_runs: null,
  } }]);
  expect(p.form(ADD), '保存成功后表单收起').toBeNull();
  expect(p.add()).toBeInTheDocument();
  expect(document.body, '令牌不留在页面上').not.toHaveTextContent('new-private-token');
});



// The owner: 没道理说我有了 tycho 后，我还要去操心原生 harness 要怎么配置. The way off an old
// reference is one button; what the form then writes is content, and only content.
test('an old reference can be turned into a tier tycho sets, and what is typed goes as content', async () => {
  const patch = '{\n  "model": "<模型名>"\n}\n';
  const p = await accountsApp();
  await p.addByKey();
  p.type(ADD, 'API 密钥', 'tok');
  p.type(ADD, '档位', 'execute=<模型名>');
  // The row as the form wrote it, and as it is sent.
  await p.submit(ADD);
  await waitFor(() => expect(p.form(ADD), '保存成功后表单收起').toBeNull());
  expect((p.calls[0]!.body as { tiers: unknown }).tiers).toEqual({ execute: { kind: 'content', text: patch } });
});

// The values are read out of the text and written back into it: what the form does not
// manage is nobody's to drop, and the row says how much of it there is.
test('changing a model keeps every other setting, and the row says how many there are', async () => {
  const text = '{\n  "model": "<旧模型>",\n  "effortLevel": "low",\n  "permissions": {\n    "defaultMode": "acceptEdits"\n  }\n}\n';
  let listed = accountsPage({ ...GPU, tiers: { decide: { kind: 'content', text } } }, CX);
  const p = await accountsApp((call) => { listed = accountsPage(GPU, CX); return saved(call); }, () => listed);
  await p.click('gpu', '修改');
  expect(p.modelOf('gpu', 2)).toHaveValue('<旧模型>');
  expect(p.effortOf('gpu', 2)).toHaveValue('low');
  expect(p.row('gpu', 2).textContent).toContain('还有 1 项高级设置');
  fireEvent.change(p.modelOf('gpu', 2), { target: { value: '<模型名>' } });
  await p.submit('gpu');
  await waitFor(() => expect(p.editing('gpu')).toBe(false));
  expect((p.calls[0]!.body as { tiers: { decide: { text: string } } }).tiers.decide.text).toBe(
    '{\n  "model": "<模型名>",\n  "effortLevel": "low",\n  "permissions": {\n    "defaultMode": "acceptEdits"\n  }\n}\n',
  );
});

// A tier with a strength and no model is the executor's own default model: the value a login
// the host adopted from a machine's report starts with, and one a save keeps as it is.
test('a tier the form filled in without a model keeps the executor\'s own default, and saves as it is', async () => {
  const p = await accountsApp();
  await p.addByKey();
  p.type(ADD, 'API 密钥', 'tok');
  fireEvent.change(p.effortOf(ADD, 2), { target: { value: 'high' } });
  await p.submit(ADD);
  await waitFor(() => expect(p.calls).toHaveLength(1));
  expect((p.calls[0]!.body as { tiers: unknown }).tiers).toEqual({ decide: { kind: 'content', text: '{\n  "effortLevel": "high"\n}\n' } });
});

// The account's card says how many models were read and when, never that an older list is
// from this moment. A connection test answers with the list it just read, and with why a
// query failed when it did.
test('a connection test shows what models it just read without cluttering idle cards', async () => {
  const later = { at: '2026-11-05T02:00:00.000Z', refreshing: false, list: [{ id: '<模型丙>' }] };
  const p = await accountsApp((call) => call.method === 'POST' && call.path === '/api/accounts/gpu/check'
    ? { account_id: 'gpu', machine: null, unchecked: '没有在线、装了 claude 的机器，这次没有问机器', models: later, models_failure: '机器连不上' }
    : saved(call),
  () => accountsPage({ ...GPU, models: MODELS }));
  expect(p.target('gpu')).not.toHaveTextContent('最后读到');
  await p.user.click(p.button('gpu', '测试连接')!);
  await waitFor(() => expect(p.target('gpu')).toHaveTextContent(new RegExp(`${modelText.count(1)}最后读到`)));
  expect(p.target('gpu')).toHaveTextContent(modelText.queryFailed('机器连不上'));
  expect(p.target('gpu'), '隐藏的那个不列出来').not.toHaveTextContent(modelText.hidden(1));
});

test('an executor that declares no tier form is its raw text only', async () => {
  const raw = 'model=<模型名>\n';
  const page = { ...accountsPage({ ...CX, tiers: { decide: { kind: 'content', text: raw } } }), tier_forms: {} };
  let listed: object = page;
  const p = await accountsApp((call) => { listed = page; return saved(call); }, () => listed);
  await p.click('cx', '修改');
  expect(within(p.row('cx', 2)).queryByLabelText('模型')).toBeNull();
  expect(p.rawOf('cx', 2)).toHaveValue(raw);
  await p.submit('cx');
  await waitFor(() => expect(p.editing('cx')).toBe(false));
  expect((p.calls[0]!.body as { tiers: unknown }).tiers).toEqual({ decide: { kind: 'content', text: raw } });
});

test('a save the service refuses keeps the form and shows the reason, through the page\'s own refresh', async () => {
  const list = numbered();
  const p = await accountsApp(() => { throw refusal('单次执行时限 -5 不能用：要是正数', 400); }, list.read);
  await p.click('gpu', '修改');
  p.type('gpu', '单次执行时限', '-5');
  await p.submit('gpu');
  await within(p.form('gpu')!).findByRole('alert');
  for (const [index, round] of ['保存被拒之后', '页面自己重读之后'].entries()) {
    expect(within(p.form('gpu')!).getByRole('alert'), round).toHaveTextContent(/单次执行时限 -5 不能用/);
    selectAccount('cx');
    expect(p.target('cx'), round).not.toHaveTextContent(/不能用/);
    selectAccount('gpu');
    expect(p.control('gpu', '单次执行时限'), round).toHaveValue('-5');
    expect(p.button('gpu', '保存'), round).toBeEnabled();
    const before = p.listReads();
    await p.reread();
    expect(p.listReads()).toBe(before + 1);
    // The page is drawn from that read before it is looked at again.
    await drawnRead(index + 2);
  }
});

test('a time limit that cannot be read goes as typed, for the service to refuse in its own words', async () => {
  const p = await accountsApp(() => { throw refusal('单次执行时限应为正整数', 400); });
  selectAccount('cx');
  await p.click('cx', '修改');
  p.type('cx', '单次执行时限', 'abc');
  await p.submit('cx');
  await within(p.form('cx')!).findByRole('alert');
  expect(p.calls.at(-1)!.body).toEqual({ name: 'cx', executor: 'claude', tiers: CX.tiers, permission_mode: null, timeout_ms: 'abc', max_runs: null });
  p.type('cx', '单次执行时限', '0.5');
  await p.submit('cx');
  await waitFor(() => expect(p.calls).toHaveLength(2));
  expect((p.calls.at(-1)!.body as { timeout_ms: unknown }).timeout_ms).toBe(30_000);
  await p.done();
});

// The tiers are the page's, not the owner's to name: nothing adds, renames or deletes one
// of them, and a row of theirs that holds nothing says so (the operate row says what
// leaving it blank means). What can no longer be saved is a name the ledger still keeps from
// an older layout: that row stands marked, nothing is sent while it stands, and the form is
// not lost by the refusal.
test('the tiers are fixed rows, and a name the system no longer uses is refused where it stands', async () => {
  const p = await accountsApp(undefined, () => accountsPage(LEGACY, CX));
  await p.addByKey();
  expect(p.tierRows(ADD)).toHaveLength(3);
  expect(p.row(ADD, 0)).toHaveTextContent('操作档');
  expect(p.row(ADD, 0)).toHaveTextContent(TIERS[0]!.use);
  expect(p.row(ADD, 0)).toHaveTextContent(tierText.blankOperate);
  expect(p.row(ADD, 1)).toHaveTextContent('执行档');
  expect(p.row(ADD, 1)).toHaveTextContent(TIERS[1]!.use);
  expect(p.row(ADD, 2)).toHaveTextContent('决策档');
  expect(p.row(ADD, 2)).toHaveTextContent(TIERS[2]!.use);
  expect(within(p.form(ADD)!).queryByRole('button', { name: '加一个档位' })).toBeNull();
  expect(within(p.form(ADD)!).queryByLabelText(/第 \d+ 个档位的名字/)).toBeNull();
  expect(within(p.form(ADD)!).queryByRole('button', { name: /删掉第 \d+ 个档位/ })).toBeNull();
  p.type(ADD, 'API 密钥', 'tok');
  p.type(ADD, '档位', `decide=<模型名>`);
  // A row that holds content says what the tier wants in it, in place of the blank note.
  expect(p.row(ADD, 2)).toHaveTextContent(`${tierText.legend}内容：${TIERS[2]!.recommend}`);
  await p.submit(ADD);
  await waitFor(() => expect(p.calls).toHaveLength(1));
  expect((p.calls[0]!.body as { tiers: unknown }).tiers).toEqual({ decide: { kind: 'content', text: '{\n  "model": "<模型名>"\n}\n' } });
  p.unmount();

  const q = await accountsApp(undefined, () => accountsPage(LEGACY, CX));
  // Its card says the same of it: the name as it stands, marked as one the system dropped.
  expect(within(q.target('legacy')!).getByTitle(LEGACY.tiers.old.text)).toHaveTextContent(tierText.stale);
  await q.click('legacy', '修改');
  expect(q.tierRows('legacy')).toHaveLength(4);
  const stale = q.row('legacy', 3);
  expect(stale).toHaveTextContent('old');
  expect(stale).toHaveTextContent(tierText.stale);
  expect(within(stale).getByRole('button', { name: '把第 4 个档位改成决策档' })).toBeInTheDocument();
  expect(within(stale).getByRole('button', { name: '把第 4 个档位改成执行档' })).toBeInTheDocument();
  expect(within(stale).getByRole('button', { name: '把第 4 个档位改成操作档' })).toBeInTheDocument();
  expect(within(stale).getByRole('button', { name: tierText.remove })).toBeInTheDocument();
  fireEvent.change(q.modelOf('legacy', 0), { target: { value: '<模型名>' } });
  await q.submit('legacy');
  expect(within(stale).getByRole('alert')).toHaveTextContent(`${tierText.stale}：${tierText.staleNote}`);
  expect(q.calls).toEqual([]);
  expect(q.modelOf('legacy', 0), '被拒之后输入还在').toHaveValue('<模型名>');
});

// The one action a name the system no longer uses has: move it onto a tier and let its row
// go. A tier that holds nothing takes it at once; one that already holds something says
// what the second click would do, and the second click on the same button is the consent.
test('a name the system no longer uses moves onto a tier: at once when it is empty, on the second click when it is not', async () => {
  const legacy = {
    ...CX, id: 'legacy', name: 'legacy',
    tiers: {
      decide: { kind: 'content' as const, text: '{\n  "model": "<模型甲>"\n}\n' },
      fast: { kind: 'content' as const, text: '{"model":"<模型丙>"}' },
      slow: { kind: 'content' as const, text: '{\n  "model": "<模型乙>"\n}\n' },
    },
  };
  let listed: object = accountsPage(legacy, CX);
  const p = await accountsApp((call) => {
    listed = accountsPage({ ...CX, id: 'legacy', name: 'legacy', tiers: { decide: { kind: 'content', text: '{\n  "model": "<模型乙>"\n}\n' }, execute: { kind: 'content', text: '{"model":"<模型丙>"}' } } }, CX);
    return saved(call);
  }, () => listed);
  await p.click('legacy', '修改');
  // execute holds nothing: one click moves the old row's content over and the row is gone.
  await p.click('legacy', '把第 4 个档位改成执行档');
  expect(p.tiersOf('legacy')).toEqual(['operate=@', 'execute=<模型丙>@', 'decide=<模型甲>@', 'slow']);
  // decide already holds content: the first click only says so, and nothing moves.
  await p.click('legacy', '把第 4 个档位改成决策档');
  expect(within(p.row('legacy', 3)).getByText(tierText.overwrite('决策档'))).toBeInTheDocument();
  expect(p.tiersOf('legacy')).toEqual(['operate=@', 'execute=<模型丙>@', 'decide=<模型甲>@', 'slow']);
  await p.click('legacy', '把第 4 个档位改成决策档');
  expect(p.tiersOf('legacy')).toEqual(['operate=@', 'execute=<模型丙>@', 'decide=<模型乙>@']);
  await p.submit('legacy');
  await waitFor(() => expect(p.editing('legacy')).toBe(false));
  expect((p.calls[0]!.body as { tiers: unknown }).tiers).toEqual({
    decide: { kind: 'content', text: '{\n  "model": "<模型乙>"\n}\n' },
    execute: { kind: 'content', text: '{"model":"<模型丙>"}' },
  });
});

test('the consent to overwrite a tier is for the move that was asked for, not for the next one', async () => {
  const legacy = {
    ...CX, id: 'legacy', name: 'legacy',
    tiers: {
      decide: { kind: 'content' as const, text: '{\n  "model": "<模型甲>"\n}\n' },
      execute: { kind: 'content' as const, text: '{\n  "model": "<模型乙>"\n}\n' },
      fast: { kind: 'content' as const, text: '{"model":"<模型丙>"}' },
    },
  };
  const p = await accountsApp(undefined, () => accountsPage(legacy, CX));
  await p.click('legacy', '修改');
  const before = ['operate=@', 'execute=<模型乙>@', 'decide=<模型甲>@', 'fast'];
  // Both tiers hold something, so the first click only says what it would do to 决策档.
  await p.click('legacy', '把第 4 个档位改成决策档');
  expect(within(p.row('legacy', 3)).getByText(tierText.overwrite('决策档'))).toBeInTheDocument();
  expect(p.tiersOf('legacy')).toEqual(before);
  // Aiming at the other tier is another move: it says what it would do to 执行档 rather
  // than taking the click before it for consent, and nothing has moved.
  await p.click('legacy', '把第 4 个档位改成执行档');
  expect(within(p.row('legacy', 3)).getByText(tierText.overwrite('执行档'))).toBeInTheDocument();
  expect(within(p.row('legacy', 3)).queryByText(tierText.overwrite('决策档'))).toBeNull();
  expect(p.tiersOf('legacy')).toEqual(before);
  // The second click on that same tier is the consent, and takes the old row's content over.
  await p.click('legacy', '把第 4 个档位改成执行档');
  expect(p.tiersOf('legacy')).toEqual(['operate=@', 'execute=<模型丙>@', 'decide=<模型甲>@']);
});

test('one change at a time, and the list after it is the one read after it: an earlier read cannot put the old one back', async () => {
  holdClock();
  const answer = deferred();
  const early = deferred();
  let reads = 0;
  const after = accountsPage({ ...GPU, timeout_ms: 3_600_000, queued_tasks: 7 }, CX);
  const p = await accountsApp(() => answer.promise, () => { reads += 1; return reads === 1 ? ACCOUNTS_PAGE : reads === 2 ? early.promise : after; });
  // A read on its way while the change is made and answered.
  await p.reread();
  expect(reads).toBe(2);
  await p.click('gpu', '修改');
  p.type('gpu', '单次执行时限', '60');
  await p.submit('gpu');
  expect(p.button('gpu', '保存中')).toBeDisabled();
  expect(p.control('gpu', '单次执行时限')).toBeDisabled();
  // No other change can be sent meanwhile.
  selectAccount('cx');
  expect([p.button('cx', '修改')!.disabled, p.more('cx')!.disabled, p.add()!.disabled]).toEqual([true, true, true]);
  expect(p.button('cx', '测试连接'), '测试连接不改东西，不用等').toBeEnabled();
  selectAccount('gpu');
  expect(p.main(), '正在保存的那一项自己写着“保存中”，不用再说一遍').not.toHaveTextContent(/上一次的改动/);
  // Past the button: a form can be submitted without one.
  fireEvent.submit(p.control('gpu', '单次执行时限')!.closest('form')!);
  // A request that must not be made: there is none to wait for.
  await pass();
  expect(p.calls.length, '保存还没回来又发了一次').toBe(1);
  answer.resolve({ account: NARROWED, created: false });
  await waitFor(() => expect(p.editing('gpu'), '保存成功后表单收起').toBe(false));
  expect(reads, '保存之后要重新读列表').toBe(3);
  // The list read after the change, not only the change's own answer.
  await waitFor(() => expect(p.target('gpu')).toHaveTextContent(/排队 7/));
  early.resolve(ACCOUNTS_PAGE);
  // An answer that must change nothing: there is no result to wait for.
  await pass();
  expect(p.target('gpu'), '迟到的旧读取盖掉了刚保存的结果').toHaveTextContent(/排队 7/);
  selectAccount('cx');
  expect(p.more('cx')).toBeEnabled();
});

test('a change the service took is on the page from its own answer: a read that fails after it cannot put the old account back', async () => {
  let down = false;
  const p = await accountsApp(({ method }) => { down = true; return method === 'PUT' ? { account: NARROWED, created: false } : { deleted: true }; },
    () => (down ? unreadable() : ACCOUNTS_PAGE));
  await p.click('gpu', '修改');
  p.type('gpu', '单次执行时限', '60');
  await p.submit('gpu');
  // That the read failed is said.
  await waitFor(() => expect(p.main()).toHaveTextContent(/读不到账号/));
  expect(p.target('gpu'), '读失败以后页面回到了改之前的样子').not.toHaveTextContent(/时限 90 分钟/);
  expect(p.editing('gpu'), '保存成功后表单收起').toBe(false);
  await p.click('gpu', '修改');
  expect(p.control('gpu', '单次执行时限'), '表单里是旧值，再保存就把刚才的修改盖掉了').toHaveValue('60');
  await p.click('gpu', '取消');
  selectAccount('cx');
  await p.remove('cx');
  await waitFor(() => expect(p.target('cx'), '删掉的账号还留在页面上').toBeNull());
  expect(screen.queryByRole('button', { name: '选择账号 cx' })).toBeNull();
  expect(p.target('gpu')).not.toHaveTextContent(/时限 90 分钟/);
  expect(p.calls.map(({ method, path }) => [method, path])).toEqual([['PUT', '/api/accounts/gpu'], ['DELETE', '/api/accounts/cx']]);
});

test('an account just added is on the page from the answer that made it, under the name the service gave it, when the read after it fails', async () => {
  let down = false;
  const p = await accountsApp((call) => { down = true; return saved(call, true); }, () => (down ? unreadable() : ACCOUNTS_PAGE));
  await p.addByKey();
  p.type(ADD, 'API 密钥', 'tok');
  p.type(ADD, '档位', 'decide=/etc/decide.json');
  await p.submit(ADD);
  await waitFor(() => expect(p.target(SERVICE_NAMED), '新加的账号不在页面上').toBeInTheDocument());
  expect(executorOf(p, SERVICE_NAMED)).toHaveTextContent('claude');
  expect(p.form(ADD), '保存成功后表单收起').toBeNull();
  expect(screen.getByRole('button', { name: '选择账号 gpu' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '选择账号 cx' })).toBeInTheDocument();
  // And the name is the owner's to change from then on, on the account itself.
  await p.click(SERVICE_NAMED, '修改');
  expect(p.control(SERVICE_NAMED, '名字')).toHaveValue(SERVICE_NAMED);
  expect(p.calls.length).toBe(1);
});

test('a change still on its way when the owner leaves and comes back holds every other change until it is answered, and the page then shows what the service has', async () => {
  for (const ending of ['读得到', '读不到', '被拒'] as const) {
    const answer = deferred();
    let listed = ACCOUNTS_PAGE;
    let down = false;
    // Opened, come back to, and read once more when the change is answered.
    const list = numbered(() => listed);
    const p = await accountsApp(() => answer.promise, () => (down ? unreadable() : list.read()));
    await p.click('gpu', '修改');
    p.type('gpu', '单次执行时限', '60');
    await p.submit('gpu');
    await go('#/');
    await go('#/accounts');
    await p.ready();
    // The read made on coming back got there before the service took the change.
    expect(p.target('gpu'), ending).toHaveTextContent(/时限 90 分钟/);
    expect(p.editing('gpu'), `${ending}：离开前的表单不跟回来`).toBe(false);
    expect(held(p), `${ending}：上一次改动还没回来，这时再改会盖掉它`).toEqual([true, true, true, true]);
    expect(p.main(), ending).toHaveTextContent(/上一次的改动还没有结果/);
    expect(p.calls.length, ending).toBe(1);
    const reads = p.listReads();
    if (ending === '被拒') answer.reject(refusal('服务正在恢复清点，现在不能改账号', 503));
    else {
      listed = accountsPage({ ...NARROWED, queued_tasks: 7 }, CX);
      down = ending === '读不到';
      answer.resolve({ account: NARROWED, created: false });
    }
    await waitFor(() => expect(held(p), `${ending}：有了结果就该能接着改`).toEqual([false, false, false, false]));
    expect(p.main(), ending).not.toHaveTextContent(/上一次的改动/);
    // Nothing on this page says how the change ended: it reads the list again.
    expect(p.listReads(), `${ending}：答复回来以后要再读一遍`).toBe(reads + 1);
    // What that read brought is on the page before it is looked at.
    if (ending === '读得到') await waitFor(() => expect(p.target('gpu')!.textContent, '答复回来以后要再读一遍').toMatch(/排队 7/));
    if (ending === '读不到') await waitFor(() => expect(p.main()).toHaveTextContent(/读不到账号/));
    if (ending === '被拒') await drawnRead(3);
    expect(p.editing('gpu'), `${ending}：迟到的答复把离开前的表单带了回来`).toBe(false);
    // Refused: the page is what the service has now. Taken: no longer the account from before it.
    if (ending === '被拒') expect(p.target('gpu')).toHaveTextContent(/时限 90 分钟/);
    else expect(p.target('gpu'), `${ending}：改成了，页面还是改之前的样子`).not.toHaveTextContent(/时限 90 分钟/);
    if (ending === '读不到') {
      await p.click('gpu', '修改');
      expect(p.control('gpu', '单次执行时限'), '表单里是旧值，再保存就把刚才的修改盖掉了').toHaveValue('60');
    }
    p.unmount();
  }
});

test('a list asked for on coming back and still on its way when the change is answered is older than the answer, and is not put on the page', async () => {
  holdClock();
  const answer = deferred();
  const early = deferred();
  let reads = 0;
  const p = await accountsApp(() => answer.promise, () => { reads += 1; return reads === 1 ? ACCOUNTS_PAGE : reads === 2 ? early.promise : accountsPage(NARROWED, CX); });
  await p.click('gpu', '修改');
  p.type('gpu', '单次执行时限', '60');
  await p.submit('gpu');
  await go('#/');
  await go('#/accounts');
  // The read made on coming back is the one this test holds: the page stands on what it had.
  await p.shown();
  expect(reads).toBe(2);
  answer.resolve({ account: NARROWED, created: false });
  await waitFor(() => expect(held(p)).toEqual([false, false, false, false]));
  expect(reads, '答复回来以后要再读一遍').toBe(3);
  expect(p.target('gpu')).not.toHaveTextContent(/单次执行时限90 分钟/);
  early.resolve(ACCOUNTS_PAGE);
  // An answer that must change nothing: there is no result to wait for.
  await pass();
  expect(p.target('gpu'), '迟到的旧读取盖掉了改好的结果').not.toHaveTextContent(/单次执行时限90 分钟/);
  expect(held(p)).toEqual([false, false, false, false]);
});

test('a change answered while the owner is on another page holds nothing afterwards: the accounts page opens on what it reads', async () => {
  holdClock();
  const answer = deferred();
  const early = deferred();
  const back = deferred();
  let reads = 0;
  const p = await accountsApp(() => answer.promise, () => { reads += 1; return reads === 1 ? ACCOUNTS_PAGE : reads === 2 ? early.promise : back.promise; });
  // A read of the list on its way when the owner leaves, answered after the change is.
  await p.reread();
  await p.click('gpu', '修改');
  p.type('gpu', '单次执行时限', '60');
  await p.submit('gpu');
  await go('#/');
  answer.resolve({ account: NARROWED, created: false });
  // Nobody is on the accounts page to show the answer: there is no result to wait for.
  await pass();
  expect(reads, '不在账号页上，迟到的答复不该替这一页去读').toBe(2);
  early.resolve(ACCOUNTS_PAGE);
  // An answer that must change nothing, as far as it will ever get before the owner is back.
  await pass();
  await go('#/accounts');
  // The read made on coming back is the one this test holds.
  await p.shown();
  expect(reads).toBe(3);
  // Before the read made on coming back is answered: what the change left, not the
  // list from before it, on which a second change would undo the first.
  expect(p.target('gpu'), '离开时还在路上的旧读取盖掉了改好的结果').not.toHaveTextContent(/单次执行时限90 分钟/);
  expect(p.editing('gpu'), '离开前的表单不跟回来').toBe(false);
  expect(held(p), '答复早就回来了，页面还锁着').toEqual([false, false, false, false]);
  expect(p.main()).not.toHaveTextContent(/上一次的改动/);
  back.resolve(accountsPage({ ...NARROWED, queued_tasks: 7 }, CX));
  await waitFor(() => expect(p.target('gpu')!.textContent).toMatch(/排队 7/));
  expect(p.target('gpu')).not.toHaveTextContent(/时限 90 分钟/);
});

test('an account with nothing waiting on it is deleted once the question is answered: nothing is sent before, and one request after', async () => {
  let listed: object = ACCOUNTS_PAGE;
  const p = await accountsApp(() => { listed = accountsPage(GPU); return { deleted: true }; }, () => listed);
  selectAccount('cx');
  await p.pick('cx', '删除');
  // The question names the account, and nothing has been sent yet.
  expect(screen.getByRole('alertdialog', { name: '删除账号 cx？' })).toBeInTheDocument();
  expect(p.calls).toEqual([]);
  await p.decide('确认删除 cx');
  await waitFor(() => expect(p.target('cx')).toBeNull());
  expect(screen.queryByRole('button', { name: '选择账号 cx' })).toBeNull();
  expect(p.calls).toEqual([{ path: '/api/accounts/cx', method: 'DELETE', body: undefined }]);
  expect(p.question(), '删掉以后不再问').toBeNull();
  expect(p.target('gpu')).toBeInTheDocument();
});

test('saying no to the question deletes nothing', async () => {
  const p = await accountsApp();
  selectAccount('cx');
  await p.pick('cx', '删除');
  await p.decide('不删了');
  expect(p.question()).toBeNull();
  expect(p.calls).toEqual([]);
  expect(p.target('cx')).toBeInTheDocument();
});

const COST = '账号 gpu 上还有 4 个排队的任务、1 个没结束的执行。删掉后，排队的任务会停住。确认要删就再点一次';
const needsConfirm = () => refusal(COST, 409, { needs_confirm: true, queued_tasks: 4, active_runs: 1 });

test('an account with work on it is not deleted at the first click: the page shows what it costs, and the second click is the consent', async () => {
  let listed = ACCOUNTS_PAGE;
  const list = numbered(() => listed);
  const p = await accountsApp(({ path }) => {
    if (!path.endsWith('?confirm=1')) throw needsConfirm();
    listed = accountsPage(CX);
    return { deleted: true };
  }, list.read);
  await p.pick('gpu', '删除');
  await p.decide('确认删除 gpu');
  // The service said what it costs: its words are in the question, and the account is still there.
  await waitFor(() => expect(within(p.question()!).getByRole('alert')).toHaveTextContent(/还有 4 个排队的任务、1 个没结束的执行。删掉后，排队的任务会停住/));
  expect(p.question()).toHaveAccessibleName('删除账号 gpu？');
  expect(within(p.question()!).getByRole('button', { name: '确认删除 gpu' })).toBeEnabled();
  expect(p.target('gpu')).toBeInTheDocument();
  expect(p.calls.map(({ path, method }) => [method, path])).toEqual([['DELETE', '/api/accounts/gpu']]);
  await p.reread();
  await drawnRead(2);
  expect(within(p.question()!).getByRole('alert'), '页面自己重读不能把等确认的状态冲掉').toHaveTextContent(/还有 4 个排队的任务/);
  await p.decide('确认删除 gpu');
  await waitFor(() => expect(p.target('gpu')).toBeNull());
  // After the consent no further click is asked for.
  expect(p.calls.map(({ path, method }) => [method, path])).toEqual([['DELETE', '/api/accounts/gpu'], ['DELETE', '/api/accounts/gpu?confirm=1']]);
  expect(p.question()).toBeNull();
  expect(document.body).not.toHaveTextContent(/确认要删/);
});

test('backing out of a delete closes the question, and the next one asks the service afresh', async () => {
  const p = await accountsApp(() => { throw needsConfirm(); });
  await p.pick('gpu', '删除');
  await p.decide('确认删除 gpu');
  await within(p.question()!).findByRole('alert');
  await waitFor(() => expect(within(p.question()!).getByRole('button', { name: '不删了' })).toBeEnabled());
  await p.decide('不删了');
  expect(p.question()).toBeNull();
  expect(document.body).not.toHaveTextContent(/确认要删/);
  // Asked again, the question starts from nothing: no cost shown, and no consent carried over.
  await p.pick('gpu', '删除');
  expect(within(p.question()!).queryByRole('alert')).toBeNull();
  await p.decide('确认删除 gpu');
  await within(p.question()!).findByRole('alert');
  // Without the consent, no confirm goes with it.
  expect(p.calls.map(({ path }) => path)).toEqual(['/api/accounts/gpu', '/api/accounts/gpu']);
});

test('a delete refused for any other reason shows it and asks for no confirmation', async () => {
  const p = await accountsApp(() => { throw refusal('服务正在恢复清点，现在不能删账号', 503); });
  await p.pick('gpu', '删除');
  await p.decide('确认删除 gpu');
  expect(await within(p.question()!).findByRole('alert')).toHaveTextContent(/现在不能删账号/);
  // It can be tried again, and the next try carries no consent: none was asked for.
  await waitFor(() => expect(within(p.question()!).getByRole('button', { name: '确认删除 gpu' })).toBeEnabled());
  await p.decide('确认删除 gpu');
  await waitFor(() => expect(p.calls).toHaveLength(2));
  expect(p.calls.map(({ path }) => path)).toEqual(['/api/accounts/gpu', '/api/accounts/gpu']);
});

// accounts-machines-decoupled "控制台": the test asks one machine, online and with the
// executor, and its answer is shown where the button is; with none to ask, it says so.
test('a connection test holds its own button while it runs, then shows the one machine it asked', async () => {
  const answer = deferred();
  const list = numbered();
  const p = await accountsApp(() => answer.promise, list.read);
  await p.click('gpu', '测试连接');
  expect(p.button('gpu', '测试中')).toBeDisabled();
  selectAccount('cx');
  expect(p.button('cx', '测试连接')).toBeEnabled();
  selectAccount('gpu');
  expect(p.button('gpu', '修改'), '测试是只读的，不挡修改').toBeEnabled();
  expect(p.calls).toEqual([{ path: '/api/accounts/gpu/check', method: 'POST', body: {} }]);
  answer.resolve({ account_id: 'gpu', machine: { machine_id: 'a1', host: 'a1', reachable: true, version: '2.1.0 (Claude Code)', logged_in: false } });
  await waitFor(() => expect(p.button('gpu', '测试连接')).toBeEnabled());
  for (const [index, round] of ['测试回来之后', '页面自己重读之后'].entries()) {
    const region = p.target('gpu')!;
    expect(within(region).getByText('a1：连得上 · 2.1.0 (Claude Code) · 没有登录'), round).toBeInTheDocument();
    expect(region, round).toHaveTextContent('测试连接的结果');
    selectAccount('cx');
    expect(p.target('cx')!.textContent, round).not.toMatch(/连得上 ·/);
    selectAccount('gpu');
    await p.reread();
    await drawnRead(index + 2);
  }
});

test('a connection test with no machine to ask says so, and a machine that failed says why', async () => {
  let n = 0;
  const p = await accountsApp(() => (n++ === 0
    ? { account_id: 'cx', machine: null, unchecked: '没有在线、装了 claude 的机器，这次没有问机器' }
    : { account_id: 'cx', machine: { machine_id: 'a2', host: 'a2', reachable: false, error: '20 秒内没有应答', version: null, logged_in: null } }));
  selectAccount('cx');
  await p.click('cx', '测试连接');
  await waitFor(() => expect(p.target('cx')).toHaveTextContent('没有在线、装了 claude 的机器，这次没有问机器'));
  await waitFor(() => expect(p.button('cx', '测试连接')).toBeEnabled());
  await p.click('cx', '测试连接');
  await waitFor(() => expect(within(p.target('cx')!).getByText('a2：连不上，20 秒内没有应答')).toBeInTheDocument());
  expect(p.target('cx')).not.toHaveTextContent('这次没有问机器');
});

test('a connection test that cannot run says why and gives the button back', async () => {
  const p = await accountsApp(() => { throw refusal('执行服务不可用', 503); });
  selectAccount('cx');
  await p.click('cx', '测试连接');
  await waitFor(() => expect(p.target('cx')).toHaveTextContent(/执行服务不可用/));
  expect(p.button('cx', '测试连接')).toBeEnabled();
});

// What the service has learned of an account by using it.
const status = (over: object = {}) => ({ active_runs: 0, max_runs: null, rest: null, usage: [], ...over });
const tomorrow = (hours: number, minutes: number): string => {
  const at = new Date();
  at.setDate(at.getDate() + 1);
  at.setHours(hours, minutes, 0, 0);
  return at.toISOString();
};
const RESTING = {
  ...GPU,
  status: status({
    active_runs: 1,
    rest: { until: tomorrow(6, 40), reason: "You've hit your session limit · resets 6:40am" },
    usage: [
      { window: 'five_hour', used: 0.99, resets_at: tomorrow(6, 40), at: '2026-11-10T04:33:00.000Z' },
      { window: 'seven_day', used: 0.51, resets_at: tomorrow(8, 0), at: '2026-11-10T04:33:00.000Z' },
    ],
  }),
};

test('each account says whether it can take work now: usable, resting until a time with why, or at its ceiling, with its usage', async () => {
  const p = await accountsApp(undefined, () => accountsPage(RESTING, { ...CX, max_runs: 2, status: status({ active_runs: 2, max_runs: 2 }) }, { ...CX, id: 'idle', name: 'idle', status: status() }, { ...CX, id: 'old', name: 'old' }));
  const state = (name: string) => within(p.target(name)!).queryByRole('status');
  expect(state('gpu')).toHaveTextContent(/^歇着：额度用完，约 \d\d-\d\d 06:40 再试$/);
  expect(p.target('gpu')).toHaveTextContent("执行器的原话：You've hit your session limit · resets 6:40am");
  expect(p.target('gpu')).toHaveTextContent(/5 小时窗口 99%，\d\d-\d\d 06:40 重置/);
  expect(p.target('gpu')).toHaveTextContent(/7 天窗口 51%，\d\d-\d\d 08:00 重置/);
  expect(p.target('gpu')).toHaveTextContent(/读于 [^·]+ · 在用量页刷新/);
  expect(within(p.target('gpu')!).getByRole('link', { name: '在用量页刷新' })).toHaveAttribute('href', '#/usage');
  expect(p.button('gpu', '现在就试')).not.toBeNull();
  selectAccount('cx');
  expect(state('cx')).toHaveTextContent('已到并发上限：在跑 2 轮，最多 2 轮');
  expect(p.target('cx')).toHaveTextContent('上限 2 轮');
  expect(p.button('cx', '现在就试')).toBeNull();
  selectAccount('idle');
  expect(p.target('idle')).not.toHaveTextContent('读于');
  expect(within(p.target('idle')!).getByText('可用')).toBeInTheDocument();
  expect(state('idle')).toBeNull();
  expect(p.button('idle', '现在就试')).toBeNull();
  selectAccount('old');
  expect(p.button('old', '现在就试')).toBeNull();
  expect(state('old')).toBeNull();
  // A wait that ends by itself is not a fault.
  expect(screen.queryByRole('alert')).toBeNull();
});

test('"现在就试" asks the service to end the rest and shows the account as it answers: usable, with nothing left to try', async () => {
  // The list read after the answer is the service's too: the rest is over there as well.
  const tried = { ...GPU, status: status({ active_runs: 1 }) };
  let resting = true;
  const p = await accountsApp(() => { resting = false; return { account: tried }; }, () => accountsPage(resting ? RESTING : tried, CX));
  await p.click('gpu', '现在就试');
  await waitFor(() => expect(p.button('gpu', '现在就试')).toBeNull());
  expect(p.calls.map(({ method, path }) => [method, path])).toEqual([['POST', '/api/accounts/gpu/retry']]);
  expect(within(p.target('gpu')!).getByRole('status')).toHaveTextContent('可用，在跑 1 轮');
});

test('a "现在就试" on its way holds the other changes, and one the service refuses says why and can be pressed again', async () => {
  const answer = deferred<unknown>();
  const p = await accountsApp(() => answer.promise, () => accountsPage(RESTING, CX));
  await p.click('gpu', '现在就试');
  expect(await within(p.target('gpu')!).findByRole('button', { name: '正在放行' })).toBeDisabled();
  expect(held(p)).toEqual([true, true, true, true]);
  answer.reject(refusal('账本写入失败，服务处于降级模式，现在不能让账号现在就试', 503));
  expect(await within(p.target('gpu')!).findByRole('alert')).toHaveTextContent('现在不能让账号现在就试');
  expect(p.button('gpu', '现在就试')).toBeEnabled();
  expect(within(p.target('gpu')!).getByRole('status')).toHaveTextContent(/^歇着/);
});

test('the ceiling is a box in the form: shown as set, sent as a number, cleared by emptying it, and sent as typed when it is no number', async () => {
  const sent: unknown[] = [];
  const p = await accountsApp((call) => { sent.push((call.body as { max_runs: unknown }).max_runs); return saved(call); }, () => accountsPage({ ...CX, max_runs: 3 }, GPU));
  await p.click('cx', '修改');
  expect(p.control('cx', '同时最多几轮执行')).toHaveValue('3');
  p.type('cx', '同时最多几轮执行', ' 5 ');
  await p.submit('cx');
  await p.done();
  await p.click('cx', '修改');
  p.type('cx', '同时最多几轮执行', '');
  await p.submit('cx');
  await p.done();
  selectAccount('gpu');
  await p.click('gpu', '修改');
  expect(p.control('gpu', '同时最多几轮执行'), '没填就是空的：不限').toHaveValue('');
  p.type('gpu', '同时最多几轮执行', '两个');
  await p.submit('gpu');
  await p.done();
  expect(sent).toEqual([5, null, '两个']);
});

test('typed keys are write-only password fields, with each credential state shown, and none can be taken off', async () => {
  const p = await accountsApp(undefined, () => accountsPage(
    { ...GPU, id: 'set', name: 'set', credential: 'set' }, { ...GPU, id: 'rejected', name: 'rejected', credential: 'rejected', status: status() },
  ));
  // Healthy cards show the green badge without redundant secret chatter; rejected cards say how to fix.
  expect(within(p.target('set')!).getByText('可用')).toBeInTheDocument();
  selectAccount('rejected');
  expect(p.target('rejected')).toHaveTextContent('API 密钥已失效，要重新填');
  expect(within(p.target('rejected')!).getByRole('status')).not.toHaveTextContent('可用');
  for (const [id, state] of [['set', '已设置'], ['rejected', '已失效，要重新填']] as const) {
    selectAccount(id);
    expect(within(p.target(id)!).queryByLabelText('API 密钥'), '卡片上没有令牌的输入框').toBeNull();
    await p.pick(id, '更换 API 密钥');
    const opened = p.tokenWindow(id)!;
    const box = within(opened).getByLabelText('API 密钥');
    expect(box).toHaveAttribute('type', 'password');
    expect(box).toHaveValue('');
    expect(opened).toHaveTextContent('只进不出：保存后页面上不再显示');
    expect(opened).toHaveTextContent(state);
    expect(within(opened).queryByRole('button', { name: '清除' }), '账号就是这份令牌，没有“清除”').toBeNull();
    await p.user.click(within(opened).getByRole('button', { name: '取消' }));
    expect(p.tokenWindow(id)).toBeNull();
  }
  expect(p.calls).toEqual([]);
});

test('setting a token sends only the credential request, clears the password, and shows the account answer when rereading fails', async () => {
  let changed = false;
  const p = await accountsApp(() => { changed = true; return { account: { ...GPU, credential: 'set' } }; },
    () => changed ? unreadable() : accountsPage({ ...GPU, credential: 'rejected' }, CX));
  await p.pick('gpu', '更换 API 密钥');
  fireEvent.change(within(p.tokenWindow('gpu')!).getByLabelText('API 密钥'), { target: { value: 'ui-private-login-token' } });
  await p.user.click(within(p.tokenWindow('gpu')!).getByRole('button', { name: '保存密钥' }));
  // Taken: the window closes with what was typed, and the card is the account as answered.
  await waitFor(() => expect(p.tokenWindow('gpu')).toBeNull());
  await waitFor(() => expect(within(p.target('gpu')!).getByText('可用')).toBeInTheDocument());
  expect(p.calls).toEqual([{ method: 'PUT', path: '/api/accounts/gpu/credential', body: { value: 'ui-private-login-token' } }]);
  expect(document.body).not.toHaveTextContent('ui-private-login-token');
  expect(p.target('gpu')).not.toHaveTextContent('已失效');
  // Opened again, nothing of the last one is in it.
  await p.pick('gpu', '更换 API 密钥');
  expect(within(p.tokenWindow('gpu')!).getByLabelText('API 密钥')).toHaveValue('');
});

test('a token write holds every account change, refuses duplicates, and erases refused input', async () => {
  holdClock();
  const answer = deferred();
  const p = await accountsApp(() => answer.promise, () => accountsPage({ ...GPU, credential: 'rejected' }, CX));
  await p.pick('gpu', '更换 API 密钥');
  const opened = p.tokenWindow('gpu')!;
  const box = within(opened).getByLabelText('API 密钥');
  fireEvent.change(box, { target: { value: 'ui-rejected-private-token' } });
  const form = box.closest('form')!;
  fireEvent.submit(form);
  await waitFor(() => expect(within(opened).getByRole('button', { name: '保存密钥中' })).toBeDisabled());
  expect(held(p)).toEqual([true, true, true, true]);
  expect(box).toHaveValue('');
  fireEvent.submit(form);
  await pass();
  expect(p.calls).toHaveLength(1);
  // Closing the window does not get past a write that is on its way.
  await p.user.keyboard('{Escape}');
  expect(p.tokenWindow('gpu')).toBe(opened);
  answer.reject(refusal('令牌格式不对', 400));
  expect(await within(opened).findByRole('alert')).toHaveTextContent('令牌格式不对');
  expect(box).toHaveValue('');
  expect(document.body).not.toHaveTextContent('ui-rejected-private-token');
  expect(within(opened).getByRole('button', { name: '保存密钥' })).toBeEnabled();
});

// The two pages write one list: a change sent from the accounts page holds the machines page
// until it is answered, exactly as the one page's changes once held each other.
test('a change sent from the accounts page holds the machines page while it is on its way', async () => {
  holdClock();
  const answer = deferred();
  const read = () => accountsPage({ ...GPU, credential: 'rejected' }, CX);
  const p = await accountsApp(() => answer.promise, read);
  await p.pick('gpu', '更换 API 密钥');
  fireEvent.change(within(p.tokenWindow('gpu')!).getByLabelText('API 密钥'), { target: { value: 'on-its-way' } });
  await p.user.click(within(p.tokenWindow('gpu')!).getByRole('button', { name: '保存密钥' }));
  expect(within(p.tokenWindow('gpu')!).getByRole('button', { name: '保存密钥中' })).toBeDisabled();
  // Another page of the same list: its own changes wait, and it says why.
  await go('#/machines');
  await waitFor(() => expect(screen.getByRole('heading', { level: 1, name: '机器' })).toBeInTheDocument());
  expect(screen.getByRole('main')).toHaveTextContent(/上一次的改动还没有结果/);
  // A machine's note and its removal are behind its "更多": that is what waits.
  const changes = () => within(screen.getByRole('region', { name: '机器 a1' })).getByRole('button', { name: '更多' });
  expect(changes()).toBeDisabled();
  answer.resolve({ account: { ...GPU, credential: 'set' } });
  await waitFor(() => expect(changes()).toBeEnabled());
  await go('#/accounts');
  await waitFor(() => expect(p.target('gpu')).toBeInTheDocument());
  expect(screen.queryByRole('button', { name: '保存密钥中' })).toBeNull();
  expect(p.tokenWindow('gpu'), '离开前的窗口不跟回来').toBeNull();
});

// Nothing here waits on a clock: unmounting stops the page's own reads.
test('leaving the page stops its reading', async () => {
  holdClock();
  const p = await accountsApp();
  const reads = p.listReads();
  p.unmount();
  await pass(POLL_MS * 2);
  expect(p.reads.filter((path) => path === '/api/accounts').length).toBe(reads);
});

test('the add window draws the ways each executor declares, in the order it declares them', async () => {
  const declared = { claude: [], codex: [{ way: 'key', available: true }], dsh: [{ way: 'page', available: true }, { way: 'key', available: true }] };
  const p = await accountsApp(undefined, () => ({ ...accountsPage(), account_logins: declared }));
  await p.user.click(p.add()!);
  const window = within(p.form(ADD)!);
  const executors = () => window.getAllByRole<HTMLInputElement>('radio', { name: /^(claude|codex|dsh)/ });
  const ways = () => window.getAllByRole<HTMLInputElement>('radio', { name: /^(在官方页面授权|填 API 密钥)/ });
  // The ones that offer a way come first and the first of them is picked; one that offers
  // none cannot be, whatever it is called.
  expect(executors().map((radio) => [radio.closest('label')!.querySelector('code')!.textContent, radio.checked, radio.disabled]))
    .toEqual([['codex', true, false], ['dsh', false, false], ['claude', false, true]]);
  expect(p.form(ADD)).toHaveTextContent('claude 暂不支持集中保管凭据');
  // One way only: nothing to recommend, and the button says what that way does next.
  expect(ways().map((radio) => radio.checked)).toEqual([true]);
  expect(window.queryByText('推荐')).toBeNull();
  expect(window.getByRole('button', { name: '下一步' })).toBeEnabled();
  // Two ways: the first the executor lists is the one picked and recommended.
  await p.user.click(executors()[1]!);
  expect(ways().map((radio) => radio.checked)).toEqual([true, false]);
  expect(ways()[0]!.closest('label')).toHaveTextContent('推荐');
  expect(window.getByRole('button', { name: '开始登录' })).toBeEnabled();
  expect(p.calls).toEqual([]);
});

// A login made on the executor's own page is never typed into a page: the service refuses
// one handed that way, so the card must not offer to.
test('an account signed in on its executor\'s own page offers no box for a secret: its login is said as a login, and renewed by signing in again', async () => {
  const signedIn = { ...accountsPage({ ...GPU, credential: 'rejected', status: status() }, CX), account_logins: { claude: [{ way: 'page', available: true }], codex: [], dsh: [] } };
  const p = await accountsApp(undefined, () => signedIn);
  expect(p.target('gpu')).toHaveTextContent('登录已失效，要重新登录');
  expect(p.target('gpu')).not.toHaveTextContent('API 密钥');
  expect(p.button('gpu', '重新登录')).toBeEnabled();
  expect(within(await p.menu('gpu')).queryByRole('menuitem', { name: /更换/ }), '没有“更换”这一项').toBeNull();
  expect(within(screen.getByRole('menu')).getByRole('menuitem', { name: '删除' })).toBeInTheDocument();
  await p.user.keyboard('{Escape}');
  selectAccount('cx');
  expect(within(p.target('cx')!).getByText('可用')).toBeInTheDocument();
});

// The reason a rejected login cannot be signed in to again on this host was only the button's
// tooltip, which a touch screen never shows.
test('a rejected account whose way to sign in again cannot be done here says why in words, and the button is disabled', async () => {
  const page = {
    ...accountsPage({ ...GPU, credential: 'rejected', status: status() }, CX),
    account_logins: { claude: [{ way: 'page' as const, available: false, why: '此主机暂不支持' }], codex: [], dsh: [] },
  };
  const p = await accountsApp(undefined, () => page);
  expect(p.target('gpu')).toHaveTextContent('此主机暂不支持');
  expect(p.button('gpu', '重新登录')).toBeDisabled();
});

// A login the machine already holds is a login the owner can use, and the accounts page is
// where both kinds are read: the machines' own are listed in a dedicated group in the left rail,
// with the same form and endpoint the machines page edits them by.
test('机器登录在左侧按提供商分组显示额度和可用操作，清晰标注覆盖范围', async () => {
  const login = own('b1', 'codex', { status: RESTING.status });
  const machine = { ...nodeMachine('b1', { connected: true }), logins: [login] };
  await loginsApp({ hash: '#/accounts', title: '账号', readMachines: () => [machine] });
  const claudeList = screen.getByRole('group', { name: 'Claude 账号' });
  expect(within(claudeList).queryByRole('button', { name: /b1.*codex/ })).toBeNull();
  const codexList = screen.getByRole('group', { name: 'Codex 账号' });
  expect(within(codexList).getByRole('button', { name: '选择单机登录 b1 · codex' })).toBeInTheDocument();
  selectOwn('b1', 'codex');
  const card = screen.getByRole('region', { name: '机器 b1 上的 codex 登录' });
  expect(card).toHaveTextContent(/5 小时窗口 99%/);
  expect(within(card).getByRole('button', { name: '现在就试' })).toBeEnabled();
  expect(within(card).getByRole('link', { name: '在用量页刷新' })).toHaveAttribute('href', '#/usage');
});

test('账号页左侧按提供商列出所有登录：单机登录用同一个编辑器改档位，保存和删除走同一个接口', async () => {
  const calls: Call[] = [];
  const machine = { ...nodeMachine('b1', { connected: true }), logins: [TIERED] };
  const p = await loginsApp({
    hash: '#/accounts',
    title: '账号',
    readMachines: () => [machine],
    answer: (call) => {
      if (call.method === 'PUT' && (call.path.startsWith('/api/machines/') || call.path.startsWith('/api/logins/'))) { calls.push(call); return { machine }; }
      if (call.method === 'DELETE' && call.path.startsWith('/api/logins/')) { calls.push(call); return { deleted: true, projects: [] }; }
      return saved(call);
    },
  });
  const claudeSection = screen.getByRole('group', { name: 'Claude 账号' });
  expect(within(claudeSection).getByRole('button', { name: '选择账号 gpu' })).toBeInTheDocument();
  const codexSection = screen.getByRole('group', { name: 'Codex 账号' });
  expect(within(codexSection).getByRole('button', { name: '选择单机登录 b1 · codex' })).toBeInTheDocument();
  selectAccount('gpu');
  expect(screen.getByRole('region', { name: 'gpu' })).toBeInTheDocument();
  selectOwn('b1', 'codex');
  const card = screen.getByRole('region', { name: `机器 ${CODEX}` });
  expect(card).toHaveTextContent('机器 b1');
  expect(card).toHaveAttribute('id', TIERED.id);
  expect(within(card).queryByRole('button', { name: '测试连接' })).toBeNull();
  expect(within(card).getByText('可用')).toBeInTheDocument();
  expect(within(card).getByRole('heading', { name: 'Codex' })).toBeInTheDocument();
  await p.user.click(within(card).getByRole('button', { name: '修改' }));
  const drawer = await screen.findByRole('dialog', { name: `修改 机器 ${CODEX}` });
  expect(within(drawer).getAllByRole('group', { name: /^第 \d+ 个档位$/ })).toHaveLength(TIERS.length);
  const decide = within(drawer).getByRole('group', { name: '第 3 个档位' });
  const model = within(decide).getAllByRole('combobox')[0]!;
  expect([...model.querySelectorAll('option')].map((option) => option.textContent)).toEqual(expect.arrayContaining(['<模型乙>']));
  await p.user.selectOptions(model, '<模型乙>');
  await p.user.click(within(drawer).getByRole('button', { name: '保存' }));
  await waitFor(() => expect(calls).toHaveLength(1));
  expect(calls[0]!.path).toBe(`/api/logins/${TIERED.id}`);
  const body = calls[0]!.body as { tiers: Record<string, { kind: string; text: string }> };
  expect(body.tiers.decide!.text).toBe('model=<模型乙>\n');
  expect(body.tiers.execute!.text).toBe('model=<别名>\n');
  await p.user.click(within(screen.getByRole('region', { name: `机器 ${CODEX}` })).getByRole('button', { name: '删除' }));
  const question = await screen.findByRole('alertdialog');
  expect(question).toHaveTextContent('到“机器”页重新启用即可');
  await p.user.click(within(question).getByRole('button', { name: '确认删除' }));
  await waitFor(() => expect(calls).toHaveLength(2));
  expect(calls[1]).toMatchObject({ method: 'DELETE', path: `/api/logins/${TIERED.id}` });
});

test('左侧账号清单支持键盘上下键切换，超过 5 项时显示搜索框过滤', async () => {
  const extras = ['a3', 'a4', 'a5', 'a6'].map((id) => ({ ...CX, id, name: id }));
  const login = own('b1', 'codex');
  const machine = { ...nodeMachine('b1', { connected: true }), logins: [login] };
  const p = await loginsApp({
    hash: '#/accounts',
    title: '账号',
    read: () => accountsPage(GPU, CX, ...extras),
    readMachines: () => [machine],
  });
  const gpuBtn = screen.getByRole('button', { name: '选择账号 gpu' });
  fireEvent.click(gpuBtn);
  gpuBtn.focus();
  expect(gpuBtn).toHaveAttribute('aria-current', 'true');
  await p.user.keyboard('{ArrowDown}');
  expect(screen.getByRole('region', { name: 'cx' })).toBeInTheDocument();
  await p.user.keyboard('{ArrowUp}');
  expect(screen.getByRole('region', { name: 'gpu' })).toBeInTheDocument();

  const searchBox = screen.getByRole('textbox', { name: '搜索账号' });
  await p.user.type(searchBox, 'codex');
  expect(screen.queryByRole('button', { name: '选择账号 gpu' })).toBeNull();
  expect(screen.getByRole('button', { name: '选择单机登录 b1 · codex' })).toBeInTheDocument();
  expect(screen.getByRole('region', { name: '机器 b1 上的 codex 登录' })).toBeInTheDocument();
});

test('shows verified masked identity + plan on centralized accounts and supports universal inline rename via PUT /api/logins/alias', async () => {
  const aliasCalls: unknown[] = [];
  const codexAcc = { ...GPU, id: 'acc-cx', name: '主力 Codex', executor: 'codex', account_label: 'alice@e***.com', plan_label: 'Pro' };
  const dshLogin = own('b1', 'dsh', { route_label: 'customgw' });
  const machine = { ...nodeMachine('b1', { connected: true }), logins: [dshLogin] };
  const p = await loginsApp({
    hash: '#/accounts',
    title: '账号',
    read: () => accountsPage(codexAcc),
    readMachines: () => [machine],
    answer: (call) => {
      if (call.method === 'PUT' && call.path === '/api/logins/alias') {
        aliasCalls.push(call.body);
        const b = call.body as { target: string; name: string | null };
        return { target: b.target, name: b.name, login_aliases: b.name ? { [b.target]: b.name } : {} };
      }
      return saved(call);
    },
  });
  // Centralized account shows masked identity + plan
  expect(screen.getByRole('region', { name: '主力 Codex' })).toHaveTextContent('alice@e***.com · Pro');
  // Single-machine DSH login supports inline rename via PUT /api/logins/alias
  selectOwn('b1', 'dsh');
  const dshCard = screen.getByRole('region', { name: /b1.*dsh/ });
  await p.user.click(within(dshCard).getByRole('button', { name: '重命名 DSH' }));
  const input = within(dshCard).getByRole('textbox', { name: '修改账号名称' });
  await p.user.clear(input);
  await p.user.type(input, '公司 DSH');
  await p.user.click(within(dshCard).getByRole('button', { name: '保存名称' }));
  await waitFor(() => expect(aliasCalls).toHaveLength(1));
  expect(aliasCalls[0]).toEqual({ target: dshLogin.id, name: '公司 DSH' });
  expect(within(dshCard).getByRole('heading', { name: '公司 DSH' })).toBeVisible();
});

test('account quota section supports inline 刷新额度 calling POST /api/quota/refresh and reports errors inline', async () => {
  let fail = false;
  const p = await accountsApp((call) => {
    if (call.path === '/api/quota/refresh') {
      if (fail) throw refusal('额度服务暂时不可用', 503);
      return { logins: [] };
    }
    return saved(call);
  }, () => accountsPage(RESTING, CX));
  const gpu = p.target('gpu')!;
  const readsBefore = p.listReads();
  await p.user.click(within(gpu).getByRole('button', { name: '刷新额度' }));
  await waitFor(() => expect(p.calls).toEqual([{ path: '/api/quota/refresh', method: 'POST', body: { login_id: 'gpu' } }]));
  await waitFor(() => expect(p.listReads()).toBeGreaterThan(readsBefore));

  fail = true;
  await p.user.click(within(gpu).getByRole('button', { name: '刷新额度' }));
  expect(await within(gpu).findByRole('alert')).toHaveTextContent('额度服务暂时不可用');
});

test('groups multi-machine logins of the same executor into one unified logical account with batch sync', async () => {
  const krLogin = own('kr', 'gemini', { id: 'ml-kr', tiers: { decide: { kind: 'content', text: '' } } });
  const winLogin = own('DP-DM', 'gemini', { id: 'ml-win', tiers: { decide: { kind: 'content', text: '' } } });
  const krMachine = { ...nodeMachine('kr', { connected: true }), logins: [krLogin] };
  const winMachine = { ...nodeMachine('DP-DM', { connected: true }), logins: [winLogin] };

  const p = await loginsApp({
    hash: '#/accounts',
    title: '账号',
    read: () => ({
      ...accountsPage(),
      login_telemetry: {
        'ml-kr': { five_hour_tokens: 12_500, five_hour_runs: 2, day_tokens: 50_000, day_runs: 6, week_tokens: 100_000, week_runs: 12, total_tokens: 200_000, total_runs: 20, last_at: '2026-11-25T10:00:00.000Z' },
        'ml-win': { five_hour_tokens: 7_500, five_hour_runs: 1, day_tokens: 25_000, day_runs: 3, week_tokens: 50_000, week_runs: 6, total_tokens: 120_000, total_runs: 10, last_at: '2026-11-25T10:05:00.000Z' },
      },
    }),
    readMachines: () => [krMachine, winMachine],
    answer: (call) => {
      if (call.method === 'PUT' && call.path === '/api/logins/batch') {
        return { machines: [krMachine, winMachine], count: 2 };
      }
      return saved(call);
    },
  });

  const groupBtn = screen.getByRole('button', { name: '选择逻辑账号 Gemini' });
  await p.user.click(groupBtn);
  const region = screen.getByRole('region', { name: 'Gemini 统一逻辑账号' });
  expect(within(region).getByText(/2 \/ 2 在线/)).toBeInTheDocument();
  expect(within(region).getByText('20.0k tok')).toBeInTheDocument();
  expect(within(region).getByText('75.0k tok')).toBeInTheDocument();
  expect(within(region).getByText('150.0k tok')).toBeInTheDocument();
  expect(within(region).getByText('320.0k tok')).toBeInTheDocument();

  await p.user.click(within(region).getByRole('button', { name: /统一修改全部 2 台/ }));
  const drawer = await screen.findByRole('dialog');
  await p.user.click(within(drawer).getByRole('button', { name: '保存' }));

  await waitFor(() => expect(p.calls.some((c) => c.method === 'PUT' && c.path === '/api/logins/batch')).toBe(true));
  const batchCall = p.calls.find((c) => c.method === 'PUT' && c.path === '/api/logins/batch')!;
  expect((batchCall.body as { login_ids: string[] }).login_ids).toEqual(['ml-kr', 'ml-win']);
});
