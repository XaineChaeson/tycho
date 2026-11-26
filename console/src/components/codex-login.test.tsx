import { screen, waitFor, within } from '@testing-library/react';
import { expect, test } from 'vitest';
import type { CodexLoginView } from '@shared/codex-login.ts';
import { GEMINI_SETTINGS_JSON, tierFormSpec } from '@shared/tier-form.ts';
import { open, type Call } from '@/test/harness';
import { ACCOUNTS_PAGE, CX, GPU, LIST, MACHINES } from '@/test/logins';

const LOGINS = '/api/codex-logins';
const DEVICE_URL = 'https://auth.openai.com/codex/device';
const DEVICE_CODE = 'ABCD-12345';

function view(over: Partial<CodexLoginView> = {}): CodexLoginView {
  return {
    id: 'C1',
    account: '',
    name: 'codex',
    mode: 'new',
    state: 'starting',
    url: null,
    code: null,
    reason: null,
    saved: false,
    ended: false,
    unconfirmed: false,
    deadline: '2026-11-17T01:00:00Z',
    models: { list: [], at: null, refreshing: false, reason: null },
    identity: {},
    duplicate: null,
    ...over,
  };
}

const dialog = () => screen.getByRole('dialog');
const tierRow = (place: number) => within(dialog()).getByRole('group', { name: `第 ${place} 个档位` });

test('Codex 设备码授权排在第一并标推荐，完成后填档位建全机账号；已登录的 Codex 授权账号显示“重新登录”，API 密钥账号显示“更换 API 密钥”', async () => {
  const state = {
    login: view(),
    savedBodies: [] as unknown[],
    relogins: [] as unknown[],
  };
  const oauthCodex = { ...CX, id: 'cx-oauth', name: 'codex-sub', executor: 'codex', signed_in: true, tiers: { decide: { kind: 'content' as const, text: 'model=gpt-5.4\n' } } };
  const keyCodex = { ...CX, id: 'cx-key', name: 'codex-key', executor: 'codex', signed_in: false, tiers: { decide: { kind: 'content' as const, text: 'model=gpt-5.4\n' } } };

  const p = open('#/accounts', async (call: Call) => {
    if (call.method === 'GET' && call.path === LIST) {
      return {
        ...ACCOUNTS_PAGE,
        accounts: [GPU, oauthCodex, keyCodex],
        executors: ['claude', 'codex', 'dsh', 'gemini'],
        credential_executors: ['claude', 'codex', 'dsh', 'gemini'],
        tier_forms: {
          ...ACCOUNTS_PAGE.tier_forms,
          gemini: tierFormSpec({ ...GEMINI_SETTINGS_JSON, fields: ['model', 'effort'], efforts: ['low', 'medium', 'high'] }),
        },
        account_logins: {
          ...ACCOUNTS_PAGE.account_logins,
          codex: [
            { way: 'device', available: true },
            { way: 'key', available: true },
            { way: 'machine', available: true },
          ],
          gemini: [{ way: 'key', available: true }],
        },
      };
    }
    if (call.method === 'GET' && call.path === '/api/machines') return { machines: MACHINES, invites: [], host_entry: null };
    if (call.method === 'GET' && call.path === '/api/node/joins') return { protocol: 1, joins: [] };
    if (call.method === 'POST' && call.path === LOGINS) {
      const body = call.body as { account?: string; mode: 'new' | 'relogin' };
      if (body.mode === 'relogin') {
        state.relogins.push(body);
        state.login = view({ id: 'C-relogin', account: body.account ?? '', name: 'codex-sub', mode: 'relogin', state: 'signed_in', saved: true, ended: true });
      } else {
        state.login = view({ id: 'C1', mode: 'new', state: 'waiting', url: DEVICE_URL, code: DEVICE_CODE });
      }
      return { login: state.login };
    }
    if (call.method === 'GET' && call.path.startsWith(`${LOGINS}/`)) return { login: state.login };
    if (call.path.endsWith('/save')) {
      state.savedBodies.push(call.body);
      state.login = { ...state.login, saved: true, account: 'cx-new', name: 'codex 2' };
      return { login: state.login, account: { ...oauthCodex, id: 'cx-new', name: 'codex 2' } };
    }
    if (call.path.endsWith('/cancel')) {
      state.login = { ...state.login, state: 'cancelled', ended: true };
      return { login: state.login };
    }
    return undefined;
  });

  await screen.findByRole('heading', { level: 1, name: '账号' });
  await p.user.click(await screen.findByRole('button', { name: '选择账号 codex-sub' }));
  const oauthCard = await screen.findByRole('region', { name: 'codex-sub' });
  // OAuth Codex account shows "重新登录", while API-key Codex account does not.
  expect(within(oauthCard).getByRole('button', { name: '重新登录' })).toBeEnabled();
  await p.user.click(screen.getByRole('button', { name: '选择账号 codex-key' }));
  const keyCard = await screen.findByRole('region', { name: 'codex-key' });
  expect(within(keyCard).queryByRole('button', { name: '重新登录' })).toBeNull();

  // Add new Codex account via Host device-code flow.
  await p.user.click(screen.getByRole('button', { name: '添加账号' }));
  await p.user.click(within(dialog()).getByRole('radio', { name: /^codex/ }));
  const ways = within(dialog()).getByRole('group', { name: '怎么登录' });
  const labels = within(ways).getAllByRole('radio').map((r) => r.closest('label')!.textContent);
  expect(labels).toEqual([
    expect.stringMatching(/^设备码授权登录推荐/),
    expect.stringMatching(/^填 API 密钥/),
  ]);

  await p.user.click(within(dialog()).getByRole('button', { name: '开始登录' }));
  const verifyLink = await within(dialog()).findByRole('link', { name: '打开验证页' });
  expect(verifyLink).toHaveAttribute('href', DEVICE_URL);
  expect(verifyLink).toHaveAttribute('target', '_blank');
  expect(within(dialog()).getByText(DEVICE_CODE)).toBeVisible();

  // Simulate user completing device authorization in browser.
  state.login = {
    ...state.login,
    state: 'signed_in',
    url: null,
    code: null,
    ended: true,
    identity: { accountLabel: 'dev.owner' },
    models: {
      list: [{ id: 'gpt-5.4', name: 'GPT-5.4', efforts: ['low', 'medium', 'high'], defaultEffort: 'medium' }],
      at: '2026-11-17T00:05:00Z',
      refreshing: false,
      reason: null,
    },
  };

  await within(dialog()).findByText(/账号标识：dev\.owner/, {}, { timeout: 3_000 });
  await p.user.selectOptions(within(tierRow(1)).getAllByRole('combobox')[0]!, 'gpt-5.4');
  await p.user.click(within(dialog()).getByRole('button', { name: '保存' }));

  await waitFor(() => expect(state.savedBodies).toHaveLength(1));
  expect(state.savedBodies[0]).toMatchObject({
    tiers: { operate: { kind: 'content', text: 'model=gpt-5.4\n' } },
  });

  // Trigger relogin on existing OAuth Codex account.
  await p.user.click(screen.getByRole('button', { name: '选择账号 codex-sub' }));
  const oauthCardAgain = await screen.findByRole('region', { name: 'codex-sub' });
  await p.user.click(within(oauthCardAgain).getByRole('button', { name: '重新登录' }));
  await within(dialog()).findByText(/新令牌已经换上/);
  expect(state.relogins).toEqual([{ account: 'cx-oauth', mode: 'relogin' }]);
  await p.user.click(within(dialog()).getByRole('button', { name: '完成' }));
});

test('Gemini 支持在添加账号窗口填 GEMINI_API_KEY 建全机通用账号', async () => {
  const created: unknown[] = [];
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
          gemini: [{ way: 'key', available: true }],
        },
      };
    }
    if (call.method === 'GET' && call.path === '/api/machines') return { machines: MACHINES, invites: [], host_entry: null };
    if (call.method === 'GET' && call.path === '/api/node/joins') return { protocol: 1, joins: [] };
    if (call.method === 'POST' && call.path === LIST) {
      created.push(call.body);
      return { account: { id: 'g-1', name: 'gemini', executor: 'gemini', credential: 'set', signed_in: false, can_route: false, tiers: {}, permission_mode: null, timeout_ms: null, max_runs: null, queued_tasks: 0 }, created: true };
    }
    return undefined;
  });

  await screen.findByRole('heading', { level: 1, name: '账号' });
  await screen.findByRole('region', { name: 'gpu' });
  await p.user.click(screen.getByRole('button', { name: '添加账号' }));
  await p.user.click(within(dialog()).getByRole('radio', { name: /^gemini/ }));
  await p.user.click(within(dialog()).getByRole('button', { name: '下一步' }));
  await p.user.type(within(dialog()).getByLabelText('API 密钥'), 'AIzaSyGeminiManagedKey');
  await p.user.type(within(tierRow(2)).getAllByRole('textbox')[0]!, 'gemini-2.5-pro');
  await p.user.click(within(dialog()).getByRole('button', { name: '保存' }));

  await waitFor(() => expect(created).toHaveLength(1));
  expect(created[0]).toMatchObject({
    executor: 'gemini',
    credential: 'AIzaSyGeminiManagedKey',
    tiers: {
      execute: {
        kind: 'content',
        text: '{\n  "model": "gemini-2.5-pro"\n}\n',
      },
    },
  });
});

test('桌面端进入 Codex 等待授权时自动调用 window.open 打开验证页（且同一网址只弹一次）', async () => {
  const win = window as unknown as { __TYCHO_DESKTOP__?: boolean };
  const prevDesktop = win.__TYCHO_DESKTOP__;
  const origOpen = window.open;
  const opened: Array<[string | URL | undefined, string | undefined, string | undefined]> = [];
  win.__TYCHO_DESKTOP__ = true;
  window.open = ((url?: string | URL, target?: string, features?: string) => {
    opened.push([url, target, features]);
    return null;
  }) as typeof window.open;
  try {
    const login = view({ id: 'C-desktop', mode: 'new', state: 'waiting', url: DEVICE_URL, code: DEVICE_CODE });
    const p = open('#/accounts', async (call: Call) => {
      if (call.method === 'GET' && call.path === LIST) {
        return {
          ...ACCOUNTS_PAGE,
          executors: ['claude', 'codex'],
          credential_executors: ['claude', 'codex'],
          account_logins: {
            ...ACCOUNTS_PAGE.account_logins,
            codex: [{ way: 'device', available: true }, { way: 'key', available: true }],
          },
        };
      }
      if (call.method === 'GET' && call.path === '/api/machines') return { machines: MACHINES, invites: [], host_entry: null };
      if (call.method === 'GET' && call.path === '/api/node/joins') return { protocol: 1, joins: [] };
      if (call.method === 'POST' && call.path === LOGINS) return { login };
      if (call.method === 'GET' && call.path.startsWith(`${LOGINS}/`)) return { login };
      if (call.path.endsWith('/cancel')) return { login: { ...login, state: 'cancelled', ended: true } };
      return undefined;
    });

    await screen.findByRole('heading', { level: 1, name: '账号' });
    await p.user.click(await screen.findByRole('button', { name: '添加账号' }));
    await p.user.click(within(dialog()).getByRole('radio', { name: /^codex/ }));
    await p.user.click(within(dialog()).getByRole('button', { name: '开始登录' }));
    await within(dialog()).findByRole('link', { name: '打开验证页' });

    await waitFor(() => expect(opened).toHaveLength(1));
    expect(opened[0]).toEqual([DEVICE_URL, '_blank', 'noopener,noreferrer']);
  } finally {
    win.__TYCHO_DESKTOP__ = prevDesktop;
    window.open = origOpen;
  }
});
