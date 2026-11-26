// Guards device management against showing the wrong entry or lifetime, losing the
// current-device mark, duplicate actions, and revoking a login before confirmation or
// hiding a refusal. Letting a new device in is the sidebar's 放行 (admit.test.tsx). The
// browser smoke checks phone geometry against the real service.
import { screen, waitFor, within } from '@testing-library/react';
import { expect, test } from 'vitest';
import { fullTime } from '@shared/time.ts';
import { session } from '@/lib/api';
import { deferred, holdClock, open, pass, refusal, type Handler } from '@/test/harness';

const SESSIONS = '/api/console-sessions';
const CURRENT = { id: 'irreversible-current-id', device: 'Safari · iPhone', entry: 'outside', method: 'link', created_at: '2026-11-05T10:00:00Z', last_seen_at: '2026-11-06T02:00:00Z', expires_at: '2026-12-05T10:00:00Z', current: true };
const OTHER = { id: 'irreversible-other-id', device: 'Chrome · Windows', entry: 'inside', method: 'device', created_at: '2026-11-06T00:00:00Z', last_seen_at: '2026-11-06T01:00:00Z', expires_at: '2026-11-06T12:00:00Z', current: false };
const LIST = { sessions: [CURRENT, OTHER], session_days: 30, temporary_ms: 12 * 60 * 60_000 };

async function drawer(handler: Handler = () => undefined) {
  const p = open('#/', (call) => handler(call) ?? (call.path === SESSIONS ? LIST : undefined));
  const trigger = screen.getByRole('button', { name: '设备' });
  await p.user.click(trigger);
  const sheet = screen.getByRole('dialog', { name: '设备' });
  await within(sheet).findByRole('button', { name: '注销' });
  return { ...p, trigger, sheet };
}

const device = (sheet: HTMLElement, name: string) => within(sheet).getByRole('region', { name });

test('the device drawer lists both entries, how they signed in, login, last-use and expiry times, and marks this device', async () => {
  const p = await drawer();
  const current = device(p.sheet, CURRENT.device);
  const other = device(p.sheet, OTHER.device);
  expect(current).toHaveTextContent('这一台');
  expect(current).toHaveTextContent('从外面');
  expect(current).toHaveTextContent('一次性链接');
  expect(current).toHaveTextContent('登录：' + fullTime(CURRENT.created_at));
  expect(current).toHaveTextContent('最近使用：' + fullTime(CURRENT.last_seen_at));
  expect(current).toHaveTextContent('到期：' + fullTime(CURRENT.expires_at));
  expect(other).toHaveTextContent('在主机这台电脑上');
  expect(other).toHaveTextContent('被另一台设备放行');
  expect(other).not.toHaveTextContent('这一台');
  expect(other).toHaveTextContent('到期：' + fullTime(OTHER.expires_at));
  expect(within(current).getByRole('button', { name: '注销' })).toBeInTheDocument();
  expect(within(other).getByRole('button', { name: '让它退出' })).toBeInTheDocument();
  expect(p.sheet).not.toHaveTextContent(CURRENT.id);
  expect(p.sheet).not.toHaveTextContent(OTHER.id);
});

test('old and WeCom-approved sessions retain the service device fallback and login method', async () => {
  const p = await drawer((call) => call.path === SESSIONS ? { ...LIST, sessions: [{ ...CURRENT, device: '未知设备', method: null }, { ...OTHER, method: 'wecom' }] } : undefined);
  expect(device(p.sheet, '未知设备')).toHaveTextContent('这一台');
  expect(device(p.sheet, OTHER.device)).toHaveTextContent('在企业微信里放行');
});

test('passphrase, weixin, and unknown login methods never render undefined', async () => {
  const p = await drawer((call) => call.path === SESSIONS ? {
    ...LIST,
    sessions: [
      { ...CURRENT, device: 'Passphrase Browser', method: 'passphrase' },
      { ...OTHER, id: 'wx-id', device: 'Weixin Phone', method: 'weixin' },
      { ...OTHER, id: 'future-id', device: 'Future Device', method: 'sso_custom' },
    ],
  } : undefined);
  expect(device(p.sheet, 'Passphrase Browser')).toHaveTextContent('口令登录');
  expect(device(p.sheet, 'Weixin Phone')).toHaveTextContent('在微信里放行');
  expect(device(p.sheet, 'Future Device')).toHaveTextContent('sso_custom');
  expect(p.sheet).not.toHaveTextContent('undefined');
});

test('revoking another login requires confirmation, can be cancelled, and refreshes the list after success', async () => {
  holdClock();
  let sessions = LIST.sessions;
  const p = await drawer((call) => {
    if (call.path === SESSIONS) return { ...LIST, sessions };
    if (call.path === SESSIONS + '/' + OTHER.id + '/revoke') { sessions = [CURRENT]; return { ok: true }; }
    return undefined;
  });
  await p.user.click(within(device(p.sheet, OTHER.device)).getByRole('button', { name: '让它退出' }));
  let confirmation = screen.getByRole('alertdialog', { name: '让这台设备退出？' });
  expect(confirmation).toHaveTextContent(OTHER.device);
  await pass();
  expect(p.calls).toEqual([]);
  await p.user.click(within(confirmation).getByRole('button', { name: '取消' }));
  expect(screen.queryByRole('alertdialog')).toBeNull();
  await p.user.click(within(device(p.sheet, OTHER.device)).getByRole('button', { name: '让它退出' }));
  confirmation = screen.getByRole('alertdialog', { name: '让这台设备退出？' });
  await p.user.click(within(confirmation).getByRole('button', { name: '确认退出' }));
  await waitFor(() => expect(within(p.sheet).queryByRole('region', { name: OTHER.device })).toBeNull());
  expect(p.calls).toEqual([{ path: SESSIONS + '/' + OTHER.id + '/revoke', method: 'POST', body: {} }]);
  expect(device(p.sheet, CURRENT.device)).toHaveTextContent('这一台');
});

test('all other logins are revoked only after confirmation and this device remains listed', async () => {
  let sessions = LIST.sessions;
  const p = await drawer((call) => {
    if (call.path === SESSIONS) return { ...LIST, sessions };
    if (call.path === SESSIONS + '/revoke-others') { sessions = [CURRENT]; return { ok: true }; }
    return undefined;
  });
  await p.user.click(within(p.sheet).getByRole('button', { name: '全部退出，只留这一台' }));
  const confirmation = screen.getByRole('alertdialog', { name: '让其他设备全部退出？' });
  expect(p.calls).toEqual([]);
  await p.user.click(within(confirmation).getByRole('button', { name: '确认退出' }));
  await waitFor(() => expect(within(p.sheet).queryByRole('region', { name: OTHER.device })).toBeNull());
  expect(p.calls).toEqual([{ path: SESSIONS + '/revoke-others', method: 'POST', body: {} }]);
  expect(device(p.sheet, CURRENT.device)).toBeInTheDocument();
});

test('this device signs out through the existing endpoint only after confirmation', async () => {
  const p = await drawer((call) => call.path === '/api/logout' ? { ok: true } : undefined);
  await p.user.click(within(device(p.sheet, CURRENT.device)).getByRole('button', { name: '注销' }));
  const confirmation = screen.getByRole('alertdialog', { name: '注销这一台？' });
  expect(p.calls).toEqual([]);
  await p.user.click(within(confirmation).getByRole('button', { name: '确认注销' }));
  await waitFor(() => expect(session.toLogin).toHaveBeenCalledTimes(1));
  expect(p.calls).toEqual([{ path: '/api/logout', method: 'POST', body: {} }]);
});

test('a rejected revocation explains why and keeps the device available for another attempt', async () => {
  const p = await drawer((call) => { if (call.method === 'POST' && call.path.startsWith(SESSIONS)) throw refusal('账本不可用', 503); return undefined; });
  await p.user.click(within(device(p.sheet, OTHER.device)).getByRole('button', { name: '让它退出' }));
  await p.user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: '确认退出' }));
  expect(await within(p.sheet).findByRole('alert')).toHaveTextContent('账本不可用');
  expect(device(p.sheet, OTHER.device)).toBeInTheDocument();
});

test('a revocation in flight cannot be sent twice and holds every logout action', async () => {
  holdClock();
  const answer = deferred();
  const p = await drawer((call) => call.path === SESSIONS + '/' + OTHER.id + '/revoke' ? answer.promise : undefined);
  await p.user.click(within(device(p.sheet, OTHER.device)).getByRole('button', { name: '让它退出' }));
  await p.user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: '确认退出' }));
  expect(within(device(p.sheet, OTHER.device)).getByRole('button', { name: '让它退出' })).toBeDisabled();
  expect(within(device(p.sheet, CURRENT.device)).getByRole('button', { name: '注销' })).toBeDisabled();
  expect(within(p.sheet).getByRole('button', { name: '全部退出，只留这一台' })).toBeDisabled();
  await p.user.click(within(device(p.sheet, OTHER.device)).getByRole('button', { name: '让它退出' }));
  await pass();
  expect(p.calls).toHaveLength(1);
  answer.resolve({ ok: true });
  expect(await within(p.sheet).findByRole('status')).toHaveTextContent('已让这台设备退出：' + OTHER.device);
});

test('a refused logout reports the reason and leaves this device on the page', async () => {
  const p = await drawer((call) => { if (call.path === '/api/logout') throw refusal('账本不可用', 503); return undefined; });
  await p.user.click(within(device(p.sheet, CURRENT.device)).getByRole('button', { name: '注销' }));
  await p.user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: '确认注销' }));
  expect(await within(p.sheet).findByRole('alert')).toHaveTextContent('账本不可用');
  expect(session.toLogin).not.toHaveBeenCalled();
  expect(device(p.sheet, CURRENT.device)).toBeInTheDocument();
});

test('a missing list explains the failure and a refresh can recover it', async () => {
  let fail = true;
  const p = open('#/', (call) => { if (call.path !== SESSIONS) return undefined; if (fail) throw refusal('账本不可用', 503); return LIST; });
  await p.user.click(screen.getByRole('button', { name: '设备' }));
  const sheet = screen.getByRole('dialog', { name: '设备' });
  expect(await within(sheet).findByRole('alert')).toHaveTextContent('账本不可用');
  fail = false;
  await p.user.click(within(sheet).getByRole('button', { name: '刷新设备' }));
  expect(await within(sheet).findByRole('region', { name: CURRENT.device })).toBeInTheDocument();
});
