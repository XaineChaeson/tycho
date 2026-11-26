// Guards signing in to a Claude account from the console (docs/design/native-login.md §二): the
// steps inside the one "添加账号" window, and the window that signs an account in again. Against:
// a second way in beside "添加账号"; the authorization
// address not offered whole, or opened in this tab; the code kept on the page after it was
// sent; a new account made before its tiers are filled, or saved with an executor or a token
// from the page; a closed window leaving the login running on the service; a failure shown in
// anything but its fixed words, or without "重新授权"; "重新授权" not starting a new login; a
// re-login that does not start by itself, or is missing from a Claude account; a host that
// cannot sign in offering the login anyway, or not saying why it cannot; and the tiers of a
// new account asked for behind one more button, or before there is a model list to pick from;
// and a new account asked for a name at all — the service names it after who the login says it
// is, and the window only says which name that is. From the review of the first cut: a window closed
// while its "start" was still on its way leaving that login running on the service (a new one or
// a re-login that started by itself); a window closed during the exchange not cancelling it; and
// a window waiting for tiers that stops asking, so a token the service let go of at its time
// limit still reads as "已登录".
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { expect, test } from 'vitest';
import { FAIL_TEXT, UNSUPPORTED_TEXT, type LoginView } from '@shared/claude-login.ts';
import { modelText } from '@shared/labels.ts';
import { deferred, open, type Call } from '@/test/harness';
import { ACCOUNTS_PAGE, GPU, LIST, MACHINES } from '@/test/logins';

const URL = 'https://claude.com/cai/oauth/authorize?code=true&client_id=c&state=whole-state';
const LOGINS = '/api/claude-logins';

function view(over: Partial<LoginView> = {}): LoginView {
  return { id: 'L1', account: '', name: '', mode: 'new', state: 'preparing', url: null, reason: null, shape: null, saved: false, ended: false, unconfirmed: false, deadline: '2026-11-10T00:15:00Z', models: { list: [], at: null, refreshing: false, reason: null }, identity: {}, duplicate: null, ...over };
}

// The accounts page on a stand-in service whose login moves on when the test says so. `gate`
// holds the answer to "start" until the test lets it go.
async function page({ supported = true, gate }: { supported?: boolean; gate?: Promise<unknown> } = {}) {
  const at = { login: view() };
  let started = 0;
  const p = open('#/accounts', async (call: Call) => {
    if (call.method === 'GET' && call.path === LIST) {
      return { ...ACCOUNTS_PAGE, account_logins: { ...ACCOUNTS_PAGE.account_logins, claude: [supported ? { way: 'page', available: true } : { way: 'page', available: false, why: UNSUPPORTED_TEXT }] } };
    }
    if (call.method === 'GET' && call.path === '/api/machines') return { machines: MACHINES, invites: [], host_entry: null };
    if (call.method === 'GET' && call.path === '/api/node/joins') return { protocol: 1, joins: [] };
    if (call.path === LOGINS) {
      started += 1;
      const body = call.body as { account?: string; mode: 'new' | 'relogin' };
      // A new account has no name until the service has read who the login is.
      at.login = view({ id: `L${started}`, account: body.account ?? '', name: body.account ?? '', mode: body.mode });
      const answer = { login: at.login };
      if (gate) await gate;
      return answer;
    }
    if (call.method === 'GET' && call.path.startsWith(`${LOGINS}/`)) return { login: at.login };
    if (call.path.endsWith('/code')) { at.login = { ...at.login, state: 'exchanging' }; return { login: at.login }; }
    if (call.path.endsWith('/cancel')) { at.login = { ...at.login, state: 'cancelled', ended: true }; return { login: at.login }; }
    if (call.path.endsWith('/save')) { at.login = { ...at.login, saved: true }; return { login: at.login, account: { ...GPU, id: at.login.account } }; }
    return undefined;
  });
  await screen.findByRole('heading', { level: 1, name: '账号' });
  // The page's name is in its bar from the start; its accounts are there once they are read.
  await screen.findByRole('region', { name: 'gpu' });
  const move = (over: Partial<LoginView>): void => { at.login = { ...at.login, ...over }; };
  return { ...p, at, move };
}

const dialog = () => screen.getByRole('dialog');
// The one way in: "添加账号" and — signing in on Claude's own page being the way this host
// offers first — "开始登录". Nothing is typed on the way.
async function begin(p: Awaited<ReturnType<typeof page>>): Promise<void> {
  await p.user.click(screen.getByRole('button', { name: '添加账号' }));
  await p.user.click(within(dialog()).getByRole('button', { name: '开始登录' }));
}
const tierRows = () => within(dialog()).findAllByRole('group', { name: /^第 \d+ 个档位$/ }, { timeout: 3000 });
const changes = (p: { calls: Call[] }) => p.calls.filter((call) => call.path.startsWith(LOGINS));

test('登录窗口和修改表单共用模型选择、随模型变化的强度、默认强度及高级设置', async () => {
  const p = await page();
  await begin(p);
  p.move({ state: 'signed_in', ended: true, models: { list: [
    { id: 'm-one', efforts: ['low', 'high'], defaultEffort: 'low' },
    { id: 'm-two', efforts: ['medium', 'max'], defaultEffort: 'medium' },
  ], at: '2026-11-10T00:00:00Z', refreshing: false, reason: null } });
  const row = (await tierRows())[1]!;
  await p.user.selectOptions(within(row).getByLabelText('模型'), 'm-one');
  expect(within(row).getByLabelText('推理强度')).toHaveTextContent(modelText.defaultEffort('low'));
  expect(within(row).queryByRole('option', { name: 'max' })).toBeNull();
  await p.user.selectOptions(within(row).getByLabelText('模型'), 'm-two');
  expect(within(row).getByLabelText('推理强度')).toHaveTextContent(modelText.defaultEffort('medium'));
  expect(within(row).queryByRole('option', { name: 'low' })).toBeNull();
  await p.user.click(within(dialog()).getByText('更多设置'));
  for (const name of ['权限模式', '单次执行时限', '同时最多几轮执行']) expect(within(dialog()).getByLabelText(name)).toBeInTheDocument();
});

test('模型查询失败沿用修改表单的原因提示，仍可手填并保存', async () => {
  const p = await page();
  await begin(p);
  p.move({ state: 'signed_in', ended: true, models: { list: [], at: null, refreshing: false, reason: 'fake timeout' } });
  // Said once, where the model is picked: the same line the machines page says it in.
  expect(await within(dialog()).findByText(modelText.listMissing('fake timeout'), {}, { timeout: 3000 })).toBeInTheDocument();
  fireEvent.change(within((await tierRows())[1]!).getByLabelText('模型'), { target: { value: 'hand' } });
  await p.user.click(within(dialog()).getByRole('button', { name: '保存' }));
  await waitFor(() => expect(changes(p).some((call) => call.path.endsWith('/save'))).toBe(true));
});

test('同组织明确指出已有账号并禁止新建', async () => {
  const p = await page();
  await begin(p);
  p.move({ state: 'signed_in', ended: true, identity: { organizationId: 'org-fake' }, duplicate: 'gpu' });
  expect(await within(dialog()).findByText(/这次授权拿到的账号和账号 gpu 属于同一个 Claude 组织/, {}, { timeout: 3000 })).toBeInTheDocument();
  expect(within(dialog()).queryByRole('button', { name: '保存' })).toBeNull();
  expect(within(dialog()).getByRole('button', { name: '重新授权' })).toBeInTheDocument();
  expect(changes(p).some((c) => c.path.endsWith('/save'))).toBe(false);
});

test('认不出组织如实显示；查询中不能抢先保存；稍后发现重复也不能提交表单', async () => {
  const p = await page();
  await begin(p);
  p.move({ state: 'signed_in', ended: true, models: { list: [], at: null, refreshing: true, reason: null } });
  // Nothing to pick a model from yet: the tiers wait for the list, and so does the save.
  expect(await within(dialog()).findByText('正在读取模型和账号资料…', {}, { timeout: 3000 })).toBeInTheDocument();
  expect(within(dialog()).queryByRole('button', { name: '保存' })).toBeNull();
  p.move({ models: { list: [], at: null, refreshing: false, reason: null } });
  expect(await within(dialog()).findByText('认不出是哪个 Claude 账号', {}, { timeout: 3000 })).toBeInTheDocument();
  expect(await within(dialog()).findByRole('button', { name: '保存' })).toBeEnabled();
  p.move({ identity: { organizationId: 'org-fake' }, duplicate: 'gpu' });
  await within(dialog()).findByText(/这次授权拿到的账号和账号 gpu 属于同一个 Claude 组织/, {}, { timeout: 3000 });
  expect(within(dialog()).queryByRole('button', { name: '保存' })).toBeNull();
});

test('新账号：只有“添加账号”一个入口；选执行器、不用起名、拿到授权按钮、交码后清空、已登录后填档位才建账号', async () => {
  const p = await page();
  expect(screen.queryByRole('button', { name: /登录 Claude/ }), '账号页只有一个入口').toBeNull();
  await p.user.click(screen.getByRole('button', { name: '添加账号' }));
  expect(within(dialog()).getByRole('heading', { name: '添加账号' })).toBeInTheDocument();
  // Which executor, and how its login is obtained: signing in on its own page comes first.
  expect(within(dialog()).getByRole('radio', { name: /^claude/ })).toBeChecked();
  expect(within(dialog()).getByRole('radio', { name: /^在官方页面授权/ })).toBeChecked();
  // The one way there is: nothing is typed for a login of this executor.
  expect(within(within(dialog()).getByRole('group', { name: '怎么登录' })).getAllByRole('radio')).toHaveLength(1);
  expect(within(dialog()).queryByLabelText('名字'), '不问名字').toBeNull();
  await p.user.click(within(dialog()).getByRole('button', { name: '开始登录' }));
  expect(await within(dialog()).findByText(/正在准备/)).toBeInTheDocument();
  expect(changes(p)[0]).toEqual({ path: LOGINS, method: 'POST', body: { mode: 'new' } });

  p.move({ url: URL });
  const link = await within(dialog()).findByRole('link', { name: '前往 Claude 授权' }, { timeout: 3000 });
  expect(link).toHaveAttribute('href', URL);
  expect(link).toHaveAttribute('target', '_blank');
  expect(link.getAttribute('rel')).toMatch(/noopener/);
  expect(within(dialog()).getByText('等待 CLI 准备接收授权码…')).toBeInTheDocument();
  expect(within(dialog()).queryByLabelText('授权码')).toBeNull();
  p.move({ state: 'waiting_code' });
  const box = await within(dialog()).findByLabelText('授权码', {}, { timeout: 3000 }) as HTMLInputElement;
  await p.user.type(box, 'the-code#state');
  await p.user.click(within(dialog()).getByRole('button', { name: '提交授权码' }));
  expect(changes(p).at(-1)).toMatchObject({ path: `${LOGINS}/L1/code`, body: { code: 'the-code#state' } });
  expect(await within(dialog()).findByText(/正在核对授权码/)).toBeInTheDocument();

  // Who the login is, and the name the service will give the account for it: said, not asked.
  p.move({ state: 'signed_in', ended: true, name: 'claude 账号 2', identity: { organizationId: 'org-fake' } });
  const rows = await tierRows();
  expect(changes(p).some((call) => call.path.endsWith('/save'))).toBe(false);
  expect(within(dialog()).queryByLabelText(/登录令牌|API 密钥/)).toBeNull();
  expect(within(dialog()).queryByLabelText('名字')).toBeNull();
  expect(dialog()).toHaveTextContent('账号会叫 claude 账号 2，建好后可以随时改名。');
  fireEvent.change(within(rows[1]!).getByLabelText('模型'), { target: { value: 'm-exec' } });
  await p.user.click(within(dialog()).getByRole('button', { name: '保存' }));
  const save = changes(p).find((call) => call.path.endsWith('/save'))!;
  expect(save.path).toBe(`${LOGINS}/L1/save`);
  expect(save.body).not.toHaveProperty('executor');
  expect(save.body).not.toHaveProperty('credential');
  expect(save.body).not.toHaveProperty('name');
  expect(JSON.stringify((save.body as { tiers: unknown }).tiers)).toContain('m-exec');
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(changes(p).some((call) => call.path.endsWith('/cancel'))).toBe(false);
});

test('关窗口就是取消；失败只说固定原因，重新授权开一次新的', async () => {
  const p = await page();
  await begin(p);
  p.move({ state: 'failed', reason: 'rejected', ended: true });
  expect(await within(dialog()).findByText(FAIL_TEXT.rejected, {}, { timeout: 3000 })).toBeInTheDocument();
  await p.user.click(within(dialog()).getByRole('button', { name: '重新授权' }));
  await waitFor(() => expect(changes(p).filter((call) => call.path === LOGINS)).toHaveLength(2));
  expect(changes(p).at(-1)!.body).toEqual({ mode: 'new' });
  p.move({ state: 'waiting_code', url: URL });
  await within(dialog()).findByRole('link', { name: '前往 Claude 授权' }, { timeout: 3000 });
  await p.user.keyboard('{Escape}');
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  await waitFor(() => expect(changes(p).at(-1)).toMatchObject({ path: `${LOGINS}/L2/cancel`, method: 'POST' }));
});

test('已有的 Claude 账号有“重新登录”，打开就开始，成功后说新令牌已换上', async () => {
  const p = await page();
  const card = screen.getByRole('region', { name: 'gpu' });
  await p.user.click(within(card).getByRole('button', { name: '重新登录' }));
  expect(within(dialog()).getByRole('heading', { name: '重新登录 gpu' })).toBeInTheDocument();
  await waitFor(() => expect(changes(p)[0]).toMatchObject({ path: LOGINS, body: { account: 'gpu', mode: 'relogin' } }));
  p.move({ state: 'signed_in', saved: true, ended: true });
  expect(await within(dialog()).findByText(/新令牌已经换上/, {}, { timeout: 3000 })).toBeInTheDocument();
  expect(within(dialog()).queryByText(/认不出是哪个 Claude 账号|组织标识|正在读取模型和账号资料/)).toBeNull();
  await p.user.click(within(dialog()).getByRole('button', { name: '完成' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(changes(p).some((call) => call.path.endsWith('/cancel'))).toBe(false);
});

test('开始的答复还没回来就关窗口：答复一到就取消这一次（新账号）', async () => {
  const gate = deferred();
  const p = await page({ gate: gate.promise });
  await begin(p);
  await waitFor(() => expect(changes(p).filter((call) => call.path === LOGINS)).toHaveLength(1));
  await p.user.keyboard('{Escape}');
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(changes(p).some((call) => call.path.endsWith('/cancel'))).toBe(false);
  gate.resolve(undefined);
  await waitFor(() => expect(changes(p).at(-1)).toMatchObject({ path: `${LOGINS}/L1/cancel`, method: 'POST' }));
});

test('自动开始的重新登录，答复还没回来就关窗口：答复一到就取消', async () => {
  const gate = deferred();
  const p = await page({ gate: gate.promise });
  await p.user.click(within(screen.getByRole('region', { name: 'gpu' })).getByRole('button', { name: '重新登录' }));
  await waitFor(() => expect(changes(p).filter((call) => call.path === LOGINS)).toHaveLength(1));
  await p.user.keyboard('{Escape}');
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  gate.resolve(undefined);
  await waitFor(() => expect(changes(p).at(-1)).toMatchObject({ path: `${LOGINS}/L1/cancel`, method: 'POST' }));
});

test('交换中关窗口：取消这一次', async () => {
  const p = await page();
  await p.user.click(within(screen.getByRole('region', { name: 'gpu' })).getByRole('button', { name: '重新登录' }));
  p.move({ state: 'waiting_code', url: URL });
  await p.user.type(await within(dialog()).findByLabelText('授权码', {}, { timeout: 3000 }), 'c#s');
  await p.user.click(within(dialog()).getByRole('button', { name: '提交授权码' }));
  expect(await within(dialog()).findByText(/正在核对授权码/)).toBeInTheDocument();
  await p.user.keyboard('{Escape}');
  await waitFor(() => expect(changes(p).at(-1)).toMatchObject({ path: `${LOGINS}/L1/cancel`, method: 'POST' }));
});

for (const how of ['点窗口外', '组件卸载'] as const) {
  test(`开始答复迟到，期间${how}：仍取消服务端会话`, async () => {
    const gate = deferred();
    const p = await page({ gate: gate.promise });
    await p.user.click(within(screen.getByRole('region', { name: 'gpu' })).getByRole('button', { name: '重新登录' }));
    await waitFor(() => expect(changes(p).filter((call) => call.path === LOGINS)).toHaveLength(1));
    if (how === '组件卸载') p.unmount();
    else {
      // The dimmed page behind the window: what is drawn just before it.
      await p.user.click(dialog().previousElementSibling!);
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    }
    gate.resolve(undefined);
    await waitFor(() => expect(changes(p).filter((call) => call.path === `${LOGINS}/L1/cancel`)).toHaveLength(1));
  });
}

test('已拿到会话后组件卸载：取消正在进行的登录', async () => {
  const p = await page();
  await p.user.click(within(screen.getByRole('region', { name: 'gpu' })).getByRole('button', { name: '重新登录' }));
  p.move({ state: 'waiting_code', url: URL });
  await within(dialog()).findByRole('link', { name: '前往 Claude 授权' }, { timeout: 3000 });
  p.unmount();
  await waitFor(() => expect(changes(p).filter((call) => call.path === `${LOGINS}/L1/cancel`)).toHaveLength(1));
});

test('等填档位时仍在问：服务到时限作废了令牌，页面如实说并给“重新授权”', async () => {
  const p = await page();
  await begin(p);
  p.move({ state: 'signed_in', ended: true });
  await tierRows();
  p.move({ state: 'failed', reason: 'timeout' });
  expect(await within(dialog()).findByText(FAIL_TEXT.timeout, {}, { timeout: 3000 })).toBeInTheDocument();
  expect(within(dialog()).queryByRole('button', { name: '保存' })).toBeNull();
  expect(within(dialog()).getByRole('button', { name: '重新授权' })).toBeInTheDocument();
});

test('主机不支持时：官方页面授权选不了并说明原因，没有别的方式就走不下去；重新登录不可用', async () => {
  const p = await page({ supported: false });
  expect(within(screen.getByRole('region', { name: 'gpu' })).getByRole('button', { name: '重新登录' })).toBeDisabled();
  await p.user.click(screen.getByRole('button', { name: '添加账号' }));
  const official = within(dialog()).getByRole('radio', { name: /^在官方页面授权/ });
  expect(official).toBeDisabled();
  expect(official.closest('label')).toHaveTextContent(UNSUPPORTED_TEXT);
  expect(within(dialog()).queryByRole('button', { name: '开始登录' })).toBeNull();
  expect(within(dialog()).getByRole('button', { name: '下一步' }), '没有能做的方式').toBeDisabled();
  expect(changes(p)).toEqual([]);
});

test('执行器自己说能怎样登录：不能由 tycho 保管的列出来、选不了，并说它的登录在哪', async () => {
  const p = await page();
  await p.user.click(screen.getByRole('button', { name: '添加账号' }));
  const executors = within(dialog()).getByRole('group', { name: '执行器' });
  expect(within(executors).getAllByRole('radio')).toHaveLength(3);
  expect(within(executors).getByRole('radio', { name: /^claude/ })).toBeEnabled();
  expect(within(executors).getByRole('radio', { name: /^codex/ })).toBeDisabled();
  expect(within(executors).getByRole('radio', { name: /^dsh/ })).toBeDisabled();
  expect(within(executors).getByRole('radio', { name: /^codex/ }).closest('label')).toHaveTextContent('它的登录留在机器上，tycho 不保管');
  expect(dialog()).toHaveTextContent('codex、dsh 暂不支持集中保管凭据：若要使用某台机器上已登录的本地执行器，请到机器页启用。');
  expect(within(dialog()).getByRole('link', { name: '机器' })).toHaveAttribute('href', '#/machines');
});

test('授权网址说明如何换账号，并可复制完整网址', async () => {
  const p = await page();
  await begin(p);
  p.move({ state: 'waiting_code', url: URL });
  await within(dialog()).findByRole('link', { name: '前往 Claude 授权' }, { timeout: 3000 });
  expect(within(dialog()).getByText(/无痕窗口/)).toBeInTheDocument();
  await p.user.click(within(dialog()).getByRole('button', { name: /^复制网址/ }));
  expect(await navigator.clipboard.readText()).toBe(URL);
});
