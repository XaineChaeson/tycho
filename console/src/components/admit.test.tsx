// Guards the sidebar's one entry for letting something in (docs/design/nodes.md §1.1 step 2)
// against: a device's number not shown as a device, or a machine's not as a machine; a
// number that names both shown as one of them — both must be listed and the owner picks;
// a decision sent for the wrong kind, number or duration; stale request details surviving
// an edit of the number; duplicate sends; and a refusal hidden. The browser smoke checks phone geometry
// against the real service.
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import { deferred, holdClock, open, pass, refusal, type Handler } from '@/test/harness';

const LOOKUP = '/api/admissions/lookup';
const APPROVE = '/api/admissions/approve';
const REJECT = '/api/admissions/reject';
const SESSIONS = '/api/console-sessions';
const DEVICE = { kind: 'device', code: '482913', entry: 'outside', device: 'Edge · Windows', created_at: Date.now() - 120_000, expires_at: Date.now() + 480_000 };
const MACHINE = { kind: 'machine', code: '482913', name: 'mac-mini-01', platform: 'darwin 24.5.0', hostname: 'mac-mini-01.local', created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 10 * 60_000 + 30_000).toISOString() };
const LIST = { sessions: [], session_days: 30, temporary_ms: 12 * 60 * 60_000 };

async function drawer(handler: Handler = () => undefined, matches: unknown[] = [DEVICE]) {
  const p = open('#/', (call) => handler(call) ?? (
    call.path === SESSIONS ? LIST
      : call.path === LOOKUP ? { matches }
        : call.path === APPROVE ? ((call.body as { kind: string }).kind === 'device' ? { kind: 'device', device: DEVICE.device } : { kind: 'machine', name: MACHINE.name, machine: { id: MACHINE.name } })
          : call.path === REJECT ? ((call.body as { kind: string }).kind === 'device' ? { kind: 'device', device: DEVICE.device } : { kind: 'machine', name: MACHINE.name })
            : undefined));
  const trigger = screen.getByRole('button', { name: '放行' });
  await p.user.click(trigger);
  const sheet = screen.getByRole('dialog', { name: '放行' });
  const field = within(sheet).getByRole('textbox', { name: '六位数字' });
  const lookup = () => p.user.click(within(sheet).getByRole('button', { name: '查找' }));
  const enter = async (code = '482913') => { fireEvent.change(field, { target: { value: code } }); await lookup(); };
  return { ...p, trigger, sheet, field, lookup, enter };
}

test('a device number shows the device and the reminder before offering the configured long and temporary durations', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(DEVICE.created_at + 120_000);
  const p = await drawer((call) => call.path === SESSIONS ? { ...LIST, session_days: 14, temporary_ms: 6 * 60 * 60_000 } : undefined);
  expect(p.field).toHaveAttribute('inputmode', 'numeric');
  await p.enter();
  const waiting = await within(p.sheet).findByRole('region', { name: '等待放行的设备' });
  expect(waiting).toHaveTextContent('Edge · Windows');
  expect(waiting).toHaveTextContent('从外面');
  expect(waiting).toHaveTextContent('2 分钟前发起');
  expect(waiting).toHaveTextContent('482913');
  expect(waiting).toHaveTextContent('只有你自己面前那台设备上显示着同样的数字时才放行。');
  expect(within(p.sheet).queryByRole('region', { name: '等待放行的机器' })).toBeNull();
  expect(within(waiting).getByRole('button', { name: '放行，只保持 6 小时' })).toBeInTheDocument();
  expect(p.calls).toEqual([{ path: LOOKUP, method: 'POST', body: { code: '482913' } }]);
  await p.user.click(within(waiting).getByRole('button', { name: '放行，保持 14 天' }));
  expect(await within(p.sheet).findByRole('status')).toHaveTextContent('已放行：Edge · Windows，保持 14 天');
  expect(p.calls.at(-1)).toEqual({ path: APPROVE, method: 'POST', body: { kind: 'device', code: '482913', temporary: false } });
  expect(within(p.sheet).queryByRole('region', { name: '等待放行的设备' })).toBeNull();
});

test('temporary approval sends its explicit choice and reports the lifetime the service granted', async () => {
  const p = await drawer((call) => call.path === APPROVE ? { kind: 'device', device: DEVICE.device, duration_ms: 3 * 60 * 60_000 } : undefined);
  await p.enter();
  await p.user.click(await within(p.sheet).findByRole('button', { name: '放行，只保持 12 小时' }));
  expect(await within(p.sheet).findByRole('status')).toHaveTextContent('已放行：Edge · Windows，保持 3 小时');
  expect(p.calls.at(-1)).toEqual({ path: APPROVE, method: 'POST', body: { kind: 'device', code: '482913', temporary: true } });
});

test('a local device request says it was started on the host and 不是我 refuses that number', async () => {
  const p = await drawer(undefined, [{ ...DEVICE, entry: 'inside' }]);
  await p.enter();
  const waiting = await within(p.sheet).findByRole('region', { name: '等待放行的设备' });
  expect(waiting).toHaveTextContent('在主机这台电脑上');
  await p.user.click(within(waiting).getByRole('button', { name: '不是我' }));
  expect(await within(p.sheet).findByRole('status')).toHaveTextContent('已拒绝：Edge · Windows');
  expect(p.calls.at(-1)).toEqual({ path: REJECT, method: 'POST', body: { kind: 'device', code: '482913' } });
});

test('a machine number shows the machine, what it runs and how long it has left, and 放行 lets that machine in', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse(MACHINE.created_at));
  const p = await drawer(undefined, [MACHINE]);
  await p.enter();
  const waiting = await within(p.sheet).findByRole('region', { name: '等待放行的机器' });
  expect(waiting).toHaveTextContent('mac-mini-01');
  expect(waiting).toHaveTextContent('darwin 24.5.0 · mac-mini-01.local');
  expect(waiting).toHaveTextContent('还有 10 分钟过期');
  expect(waiting).toHaveTextContent('只有你自己面前那台机器上显示着同样的数字时才放行。');
  expect(within(p.sheet).queryByRole('region', { name: '等待放行的设备' })).toBeNull();
  await p.user.click(within(waiting).getByRole('button', { name: '放行' }));
  expect(await within(p.sheet).findByRole('status')).toHaveTextContent('已放行 mac-mini-01，它连回来后会出现在“机器”页的列表里');
  expect(p.calls.at(-1)).toEqual({ path: APPROVE, method: 'POST', body: { kind: 'machine', code: '482913' } });
  expect(within(p.sheet).queryByRole('region', { name: '等待放行的机器' })).toBeNull();
});

test('refusing a machine sends its kind and number and says so', async () => {
  const p = await drawer(undefined, [MACHINE]);
  await p.enter();
  await p.user.click(within(await within(p.sheet).findByRole('region', { name: '等待放行的机器' })).getByRole('button', { name: '拒绝' }));
  expect(await within(p.sheet).findByRole('status')).toHaveTextContent('已拒绝 mac-mini-01，那台机器上的加入命令已经退出');
  expect(p.calls.at(-1)).toEqual({ path: REJECT, method: 'POST', body: { kind: 'machine', code: '482913' } });
});

test('a number that names a device and a machine at once lists both, and deciding one leaves the other to decide', async () => {
  const p = await drawer(undefined, [DEVICE, MACHINE]);
  await p.enter();
  expect(await within(p.sheet).findByText(/同时对上了一台设备和一台机器/)).toBeInTheDocument();
  const device = within(p.sheet).getByRole('region', { name: '等待放行的设备' });
  const machine = within(p.sheet).getByRole('region', { name: '等待放行的机器' });
  await p.user.click(within(machine).getByRole('button', { name: '放行' }));
  expect(await within(p.sheet).findByRole('status')).toHaveTextContent('已放行 mac-mini-01');
  expect(p.calls.at(-1)).toEqual({ path: APPROVE, method: 'POST', body: { kind: 'machine', code: '482913' } });
  expect(within(p.sheet).queryByRole('region', { name: '等待放行的机器' })).toBeNull();
  expect(device).toBeInTheDocument();
  expect(within(p.sheet).getByRole('region', { name: '等待放行的设备' })).toHaveTextContent('Edge · Windows');
});

test('a wrong number or a request that ended after the lookup shows the service explanation and leaves no decision buttons', async () => {
  for (const endsAfterLookup of [false, true]) {
    const p = await drawer((call) => {
      if (!call.path.startsWith('/api/admissions/')) return undefined;
      if (endsAfterLookup && call.path === LOOKUP) return { matches: [DEVICE] };
      throw refusal('没有这个号码，或者它已经过期', 404);
    });
    await p.enter();
    if (endsAfterLookup) await p.user.click(within(p.sheet).getByRole('button', { name: '放行，保持 30 天' }));
    expect(await within(p.sheet).findByRole('alert')).toHaveTextContent('没有这个号码，或者它已经过期');
    expect(within(p.sheet).queryByRole('region', { name: '等待放行的设备' })).toBeNull();
    expect(p.field).toHaveValue('482913');
    p.unmount();
  }
});

test('editing the number removes the previous request before it can be approved', async () => {
  const p = await drawer(undefined, [DEVICE, MACHINE]);
  await p.enter();
  await within(p.sheet).findByText('Edge · Windows');
  fireEvent.change(p.field, { target: { value: '123456' } });
  expect(within(p.sheet).queryByText('Edge · Windows')).toBeNull();
  expect(within(p.sheet).queryByRole('region', { name: '等待放行的机器' })).toBeNull();
});

test('lookup and decision each hold the form until answered and cannot be sent twice', async () => {
  holdClock();
  const lookupAnswer = deferred();
  const decisionAnswer = deferred();
  const p = await drawer((call) => call.path === LOOKUP ? lookupAnswer.promise : call.path === APPROVE ? decisionAnswer.promise : undefined);
  await p.enter();
  expect(p.field).toBeDisabled();
  fireEvent.submit(p.field.closest('form')!);
  await pass();
  expect(p.calls).toHaveLength(1);
  lookupAnswer.resolve({ matches: [DEVICE] });
  await within(p.sheet).findByText('Edge · Windows');
  await p.user.click(within(p.sheet).getByRole('button', { name: '放行，保持 30 天' }));
  expect(within(p.sheet).getByRole('button', { name: '不是我' })).toBeDisabled();
  expect(within(p.sheet).getByRole('button', { name: '放行，只保持 12 小时' })).toBeDisabled();
  await p.user.click(within(p.sheet).getByRole('button', { name: '不是我' }));
  fireEvent.submit(p.field.closest('form')!);
  await pass();
  expect(p.calls).toHaveLength(2);
  decisionAnswer.resolve({ kind: 'device', device: DEVICE.device });
  expect(await within(p.sheet).findByRole('status')).toHaveTextContent('已放行');
});

test('closing the drawer returns focus and reopening starts without the previous number or request', async () => {
  const p = await drawer();
  await p.enter();
  await within(p.sheet).findByText('Edge · Windows');
  await p.user.click(within(p.sheet).getByRole('button', { name: '关闭' }));
  await waitFor(() => expect(screen.queryByRole('dialog', { name: '放行' })).toBeNull());
  expect(p.trigger).toHaveFocus();
  await p.user.click(p.trigger);
  const sheet = screen.getByRole('dialog', { name: '放行' });
  expect(within(sheet).getByRole('textbox', { name: '六位数字' })).toHaveValue('');
  expect(within(sheet).queryByText('Edge · Windows')).toBeNull();
});
