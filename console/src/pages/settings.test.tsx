// Guards the settings page against: a setting shown in the wrong unit or sent in one, a
// failed save that loses what was typed or its reason, a second click or a late read
// putting an old value back over one just saved; a save still on its way when the owner
// leaves the page and comes back to one free to send a second save, whose answer the
// first one's late answer would then undo, or a page that stays locked, or keeps the old
// value, once that first save is answered or refused; a stored value this version will not
// take staying hidden with no way to clear it, a setting of a new kind sent as the wrong
// type, an empty value that does not say what empty stands for, the Secret appearing
// anywhere on the page, a Router that is stopped or restarting reading as running, a
// restart that does not say it waits for the turn under way, the page still pointing at
// config.json, and a link to one setting that lands on the page without showing which one.
// And against the Router's two rows: the account row offering an account that cannot be
// the Router, the tier row offering a name the bound account does not hold or losing the
// value in force, staying open with nothing to pick and nothing in force, the two of them
// typed instead of picked, and the rest of the page going with them when the accounts
// cannot be read.
// And against the page being one page per group: a group's page showing another group's
// items, the groups not all listed or none of them marked as the one in view, a draft lost
// on going to another group and back, a link to one item that does not open its group,
// and a search that misses a group, does not say which group a result is in, or does not
// lead to it.
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import { tierText } from '@shared/labels.ts';
import { deferred, go, holdClock, open, pass, shellStream, type Call } from '@/test/harness';
import type { Account, Tier } from '@/lib/types';

const unset = { restart: false, stored: false, overridden: false, updated_at: null, updated_by: null };
const SETTINGS_PAGE = {
  settings: [
    { ...unset, key: 'router.cli', group: '负责人', title: 'Claude Code 路径', help: '负责人用哪个', type: 'file', empty: '自动在 PATH 里找 claude', default: '', value: '' },
    { ...unset, key: 'router.account', group: '负责人', title: '负责人的账号', help: '负责人用哪个账号登录', type: 'text', empty: '不绑定：用这台电脑自己的登录和默认档位', default: '', value: 'gpu', stored: true, overridden: true },
    { ...unset, key: 'router.tier', group: '负责人', title: '负责人的档位', help: '负责人用哪一档', type: 'text', empty: '不指定，用执行器自己的默认档位', default: '', value: 'decide', stored: true, overridden: true },
    { ...unset, key: 'run.timeoutMs', group: '执行', title: '单次执行时限', help: '一轮最多跑多久', type: 'duration', unit: 'hours', default: 10_800_000, value: 10_800_000 },
    { ...unset, key: 'run.lostGraceMs', group: '执行', title: '宽限期', help: '失联多久', type: 'duration', unit: 'minutes', default: 600_000, value: 90_000, stored: true, overridden: true, updated_at: '2026-11-05T01:00:00Z', updated_by: 'console' },
    { ...unset, key: 'wecom.botId', group: '企业微信', title: '机器人 Bot ID', help: '填上就启用', type: 'text', empty: '不启用企业微信', default: '', value: '' },
    { ...unset, key: 'wecom.url', group: '企业微信', title: '网关地址', help: '长连接连到哪', type: 'url', empty: '官方网关', default: '', value: '' },
    { ...unset, key: 'login.sessionDays', group: '登录', title: '登录保持天数', help: '保持多少天', type: 'integer', default: 30, restart: true, value: 30 },
    { ...unset, key: 'http.port', group: '服务', title: '端口', help: '控制台开在哪', type: 'port', default: 8787, restart: true, value: 8787 },
    { ...unset, key: 'http.host', group: '服务', title: '监听地址', help: '谁能打开控制台', type: 'choice', choices: ['127.0.0.1', '0.0.0.0'], default: '127.0.0.1', restart: true, value: '127.0.0.1' },
    { ...unset, key: 'backup.dir', group: '备份', title: '备份目录', help: '放哪', type: 'directory', default: '', value: '' },
    { ...unset, key: 'backup.at', group: '备份', title: '时刻', help: '几点', type: 'clock', default: '03:30', value: '03:30', updated_at: '2026-11-05T01:00:00Z', updated_by: 'zhangsan' },
    { ...unset, key: 'backup.keepDays', group: '备份', title: '保留天数', help: '留多久', type: 'integer', default: 14, value: 14, stored: true, updated_at: '2026-11-05T01:00:00Z', updated_by: 'import' },
  ],
  deployment: [{ title: '数据目录', value: 'D:\\tycho\\data' }],
  wecom: { secret_set: false },
  router: { alive: true, pid: 4321, turn: null as string | null, error: null as string | null, restarting: false },
};

// The accounts the Router's two rows choose from: only one whose executor can be the
// Router may be bound, and a tier is one of the names in shared/tiers.ts, offered when the
// bound account can run it (an operate choice runs on the execute content when the account
// holds no operate content).
const account = (id: string, executor: string, can_route: boolean, tiers: Record<string, Tier>): Account => ({
  id, name: id, executor, can_route, tiers, credential: 'set',
  permission_mode: null, timeout_ms: null, max_runs: null, queued_tasks: 0,
});
// What a row reads of a tier is what the account holds for that name; the value is the kind
// it has. A name outside the two comes only from an older layout, and is never offered.
const tiers = (...names: string[]): Record<string, Tier> =>
  Object.fromEntries(names.map((name) => [name, { kind: 'content', text: `{"model":"<${name}>"}` }]));
const ACCOUNTS: { accounts: Account[] } = {
  accounts: [
    account('gpu', 'claude', true, tiers('decide', 'execute')),
    account('cx', 'codex', false, tiers('decide')),
    account('cpu', 'claude', true, tiers('execute')),
    account('bare', 'claude', true, {}),
  ],
};
// A read of the accounts that cannot be answered: what the two rows are without it.
const unreadable = (): never => { throw new Error('读不到账号'); };

// The list as the service sends it back after a change.
const listing = (changed: Record<string, object> = {}) => SETTINGS_PAGE.settings.map((item) => ({ ...item, ...changed[item.key] }));
const SAVED = listing({ 'run.timeoutMs': { value: 5_400_000, stored: true, overridden: true } });
const LIST = '/api/settings';
const EARLIER = '上一次的改动还没有结果，等它回来才能再改。';

// A page that says which read of it this is: a test that has to see the page drawn
// again from a later read waits for that read's number. It is said where the tests that
// count look: in what one item of 执行 and one of 负责人 mean.
const COUNTED = ['run.timeoutMs', 'router.cli'];
function numbered(page: () => typeof SETTINGS_PAGE = () => SETTINGS_PAGE) {
  let reads = 0;
  return {
    read: () => {
      const said = `第 ${reads += 1} 次`;
      const read = page();
      return { ...read, settings: read.settings.map((item) => (COUNTED.includes(item.key) ? { ...item, help: said } : item)) };
    },
    drawn: (read: number) => screen.findByText(`第 ${read} 次`),
  };
}

// One page per group: where each test starts.
const AT_RUN = '#/settings/执行';
const AT_ROUTER = '#/settings/负责人';
const groupHash = (group: string) => `#/settings/${encodeURIComponent(group)}`;

// The settings page on a service that answers every change with `answer`, every read of
// the page with `read`, and the read of the accounts the Router's two rows choose from
// with `accounts`.
async function settingsPage(
  answer: (call: Call) => unknown = () => ({ settings: listing() }),
  read: () => unknown = () => SETTINGS_PAGE,
  // Most of what is tested here sits in the group 执行.
  hash = AT_RUN,
  accounts: () => unknown = () => ACCOUNTS,
) {
  // Opening the page reads it twice: on arriving, and again once the console is
  // connected. Both are answered from one call of `read`, so a test counts its own.
  let asked = 0;
  let opening: () => unknown = read;
  const app = open(hash, (call) => {
    if (call.method !== 'GET') return answer(call);
    if (call.path === '/api/accounts') return accounts();
    if (call.path === '/api/machines') return { machines: [] };
    if (call.path !== LIST) return undefined;
    asked += 1;
    if (asked === 1) {
      try {
        const page = read();
        opening = () => page;
      } catch (error) {
        opening = () => { throw error; };
      }
    }
    return asked <= 2 ? opening() : read();
  });
  const field = (title: string) => screen.getByLabelText<HTMLInputElement | HTMLSelectElement>(title);
  const row = (title: string) => field(title).closest('form')!;
  /** The row with 保存 buttons is only there once something was typed; the buttons go with it. */
  const button = (title: string, label: string) => within(row(title)).queryByRole<HTMLButtonElement>('button', { name: label });
  const type = (title: string, value: string) => fireEvent.change(field(title), { target: { value } });
  const submit = (title: string) => app.user.click(button(title, '保存')!);
  // The Router's row has no box of its own: its button is the way in.
  const restart = () => screen.getByRole<HTMLButtonElement>('button', { name: '重启负责人' });
  const router = () => restart().closest('form')!;
  const pageReads = () => app.reads.filter((path) => path === LIST).length;
  // No change is on its way: every address the page has written to has been answered.
  const unlocked = () => waitFor(() => {
    const written = app.calls.map(({ path }) => path);
    expect(written.filter((path) => app.waiting(path) > 0)).toEqual([]);
  });
  // A save, through to its answer.
  const save = async (title: string) => {
    await submit(title);
    await unlocked();
  };
  // Everything that would send a change, each part read on its own: a part that opens back
  // up must not stand in for another that is still shut. `null` is a row with nothing to
  // send — a row shows 保存 only once something is typed into it.
  const sending = (title: string): HTMLButtonElement | null => within(row(title)).queryByRole<HTMLButtonElement>('button', { name: /^保存/ });
  // Another group's page, as its entry in the list of groups leads to it.
  const to = (group: string) => go(groupHash(group));
  // The parts sit on three pages: each is looked at on its own, and the test is put back
  // on the page it was on.
  const held = async (): Promise<(boolean | null)[]> => {
    const back = window.location.hash;
    await to('执行');
    const run = [sending('单次执行时限')?.disabled ?? null, sending('宽限期')?.disabled ?? null, button('宽限期', '恢复默认')?.disabled ?? null];
    await to('企业微信');
    const secret = sending('Secret')?.disabled ?? null;
    await to('负责人');
    const restarting = restart().disabled;
    await go(back);
    return [...run, secret, restarting];
  };
  // What makes the page read itself again without anyone asking: the service saying that the
  // ledger changed. Back once the read has been asked for; its answer is the test's to wait for.
  const reread = async () => {
    const before = pageReads();
    act(() => shellStream().emit('changed', {}));
    await waitFor(() => expect(pageReads()).toBe(before + 1));
  };
  // The page is there and every read of it so far has been answered.
  const ready = async () => {
    await screen.findByRole('heading', { level: 1, name: '设置' });
    await waitFor(() => {
      expect(pageReads()).toBeGreaterThanOrEqual(2);
      expect(app.waiting(LIST)).toBe(0);
    });
  };
  await ready();
  return { ...app, field, row, button, type, submit, save, unlocked, held, to, router, restart, pageReads, reread, ready };
}

test('the settings page lists items by group, each value in its own unit', async () => {
  const p = await settingsPage();
  const main = screen.getByRole('main');
  expect(within(main).getAllByRole('heading', { level: 2 }).map((node) => node.textContent)).toEqual(['执行']);
  expect(p.row('单次执行时限')).toHaveTextContent(/现在：3 小时/);
  expect(p.field('单次执行时限')).toHaveValue('3');
  expect(within(p.row('单次执行时限')).getByText('小时')).toBeInTheDocument();
  expect(p.field('宽限期')).toHaveValue('1.5');
  await p.to('备份');
  expect(p.row('备份目录')).toHaveTextContent(/现在：空（关闭）/);
  await p.to('部署信息');
  const deployment = screen.getByRole('region', { name: '部署信息' });
  expect(deployment.textContent).toMatch(/数据目录D:\\tycho\\data/);
  expect(deployment.textContent).toMatch(/服务现在实际的情况.*只能看/);
  expect(within(deployment).queryByRole('textbox')).toBeNull();
  expect(main.textContent).not.toMatch(/config\.json/);
});

test('a value away from its default shows the default, and only a stored value can be put back', async () => {
  const p = await settingsPage();
  expect(p.row('宽限期')).toHaveTextContent(/现在：1\.5 分钟 · 默认：10 分钟/);
  expect(p.row('宽限期')).toHaveTextContent(/由网页修改/);
  expect(p.row('单次执行时限')).not.toHaveTextContent(/默认：/);
  expect(p.button('宽限期', '恢复默认')).toBeInTheDocument();
  expect(p.button('单次执行时限', '恢复默认')).toBeNull();
});

test('an item that needs a restart says so', async () => {
  const p = await settingsPage(undefined, undefined, groupHash('登录'));
  expect(p.row('登录保持天数')).toHaveTextContent(/重启后生效/);
  await p.to('备份');
  expect(p.row('备份目录')).not.toHaveTextContent(/重启后生效/);
});

test('saving sends the service its own unit and goes back to what the service says', async () => {
  const p = await settingsPage();
  p.type('单次执行时限', '1.5');
  await p.save('单次执行时限');
  expect(p.calls).toEqual([{ path: '/api/settings/run.timeoutMs', method: 'PUT', body: { value: 5_400_000 } }]);
  // The service answered with the list unchanged: the page shows that, not what was typed.
  expect(p.field('单次执行时限')).toHaveValue('3');
  await p.to('登录');
  p.type('登录保持天数', '7');
  await p.save('登录保持天数');
  await p.to('备份');
  p.type('时刻', '04:00');
  await p.save('时刻');
  expect(p.calls.slice(1).map(({ body }) => body)).toEqual([{ value: 7 }, { value: '04:00' }]);
});

test('what is not a number goes as typed, and the reason comes from the service', async () => {
  const p = await settingsPage((call) => { throw new Error(`应为数字：${(call.body as { value: unknown }).value}`); });
  for (const typed of ['abc', '']) {
    p.type('单次执行时限', typed);
    await p.save('单次执行时限');
    expect((p.calls.at(-1)!.body as { value: unknown }).value).toBe(typed);
    expect(within(p.row('单次执行时限')).getByRole('alert')).toHaveTextContent(`应为数字：${typed}`);
  }
});

test('a save that fails keeps the input and shows the reason beside that item alone', async () => {
  const page = numbered();
  const p = await settingsPage(() => { throw new Error('单次执行时限不能小于 1 分钟'); }, page.read);
  p.type('单次执行时限', '0');
  await p.save('单次执行时限');
  for (const [index, round] of ['保存失败之后', '页面自己重读之后'].entries()) {
    expect(within(p.row('单次执行时限')).getByRole('alert'), round).toHaveTextContent(/不能小于 1 分钟/);
    expect(p.row('宽限期'), round).not.toHaveTextContent(/不能小于/);
    expect(p.field('单次执行时限'), round).toHaveValue('0');
    expect(p.field('单次执行时限'), round).toBeEnabled();
    const before = p.pageReads();
    await p.reread();
    expect(p.pageReads()).toBe(before + 1);
    // The page is drawn from that read before it is looked at again.
    await page.drawn(index + 2);
  }
});

test('恢复默认 asks the service to drop the override, and a refusal shows the same way', async () => {
  const ok = await settingsPage();
  await ok.user.click(ok.button('宽限期', '恢复默认')!);
  await ok.unlocked();
  expect(ok.calls).toEqual([{ path: '/api/settings/run.lostGraceMs', method: 'DELETE', body: undefined }]);
  ok.unmount();

  const refused = await settingsPage(() => { throw new Error('服务正在恢复清点，现在不能改设置'); });
  await refused.user.click(refused.button('宽限期', '恢复默认')!);
  await refused.unlocked();
  expect(within(refused.row('宽限期')).getByRole('alert')).toHaveTextContent(/现在不能改设置/);
});

test('a save holds every save button until its answer is on the page, and takes the answer without reading again', async () => {
  holdClock();
  const answer = deferred();
  const p = await settingsPage(() => answer.promise);
  const reads = p.pageReads();
  p.type('单次执行时限', '1.5');
  p.type('宽限期', '5');
  await p.to('企业微信');
  p.type('Secret', 's3cret');
  await p.to('执行');
  await p.submit('单次执行时限');
  expect(p.button('单次执行时限', '保存中')).toBeDisabled();
  expect(p.field('单次执行时限')).toBeDisabled();
  expect(await p.held(), '别的项这时也不能提交').toEqual([true, true, true, true, true]);
  // Past the buttons: a form can be submitted without one.
  fireEvent.submit(p.row('单次执行时限'));
  fireEvent.submit(p.row('宽限期'));
  // A request that must not be made: there is none to wait for.
  await pass();
  expect(p.calls.length, '保存还没回来又发了一次').toBe(1);
  answer.resolve({ settings: SAVED });
  await waitFor(() => expect(p.field('单次执行时限')).toHaveValue('1.5'));
  // The lock opens on every part of the page, each looked at on its own: the row just
  // saved has nothing to send any more, the others can send again.
  await waitFor(async () => expect(await p.held(), '有了结果就该能接着改').toEqual([null, false, false, false, false]));
  // The lock opens on the new value, in the same step.
  expect(p.row('单次执行时限')).toHaveTextContent(/现在：1\.5 小时 · 默认：3 小时/);
  expect(p.button('单次执行时限', '恢复默认')).toBeInTheDocument();
  // A read that must not be made: there is none to wait for.
  await pass();
  expect(p.pageReads(), '保存之后又读了一遍，读回来之前页面是旧的').toBe(reads);
  // With nothing typed over it there is no 保存 to press: the old value cannot go back.
  expect(p.button('单次执行时限', '保存')).toBeNull();
  expect(p.calls).toHaveLength(1);
});

test('a read sent before a save cannot put the old list back, and one sent after it is taken', async () => {
  holdClock();
  const held: ReturnType<typeof deferred>[] = [];
  let reads = 0;
  const p = await settingsPage(() => ({ settings: SAVED }), () => {
    reads += 1;
    if (reads === 1) return SETTINGS_PAGE;
    held.push(deferred());
    return held.at(-1)!.promise;
  });
  // A read on its way while the save is made and answered.
  await p.reread();
  expect(held.length).toBe(1);
  p.type('单次执行时限', '1.5');
  await p.save('单次执行时限');
  expect(p.field('单次执行时限')).toHaveValue('1.5');
  held[0]!.resolve(SETTINGS_PAGE);
  // An answer that must change nothing: there is no result to wait for.
  await pass();
  expect(p.field('单次执行时限'), '迟到的旧读取盖掉了刚保存的值').toHaveValue('1.5');
  // With nothing typed there is no 保存 that could write the old value back.
  expect(p.button('单次执行时限', '保存')).toBeNull();
  expect(p.calls).toHaveLength(1);
  await p.reread();
  held.at(-1)!.resolve({ ...SETTINGS_PAGE, settings: listing({ 'run.timeoutMs': { value: 7_200_000, stored: true, overridden: true } }) });
  await waitFor(() => expect(p.field('单次执行时限'), '保存之后发出的读取照常生效').toHaveValue('2'));
});

const note = () => within(screen.getByRole('main')).queryByText(EARLIER);

test('a save still on its way when the owner leaves and comes back holds every other save until it is answered, and the page then shows what it saved', async () => {
  const answer = deferred();
  // Every read finds the list as it was before the save: the service has not taken it yet.
  const p = await settingsPage(() => answer.promise);
  p.type('单次执行时限', '1.5');
  await p.submit('单次执行时限');
  await go('#/');
  await go(AT_RUN);
  await p.ready();
  // The read made on coming back got there before the service took the save.
  expect(p.field('单次执行时限'), '离开前填的值不跟回来').toHaveValue('3');
  expect(p.button('单次执行时限', '保存中'), '这一页没有哪一行在保存').toBeNull();
  expect(await p.held(), '上一次保存还没回来，这时再存会被它迟到的答复盖掉').toEqual([null, null, true, null, true]);
  expect(note()).toHaveAttribute('role', 'status');
  // Past the buttons: a form can be submitted without one.
  p.type('宽限期', '5');
  fireEvent.submit(p.row('宽限期'));
  fireEvent.submit(p.row('单次执行时限'));
  await p.to('负责人');
  await p.user.click(p.restart());
  await p.to('执行');
  expect(p.calls.length, '上一次保存还没回来又发了一次').toBe(1);
  answer.resolve({ settings: SAVED });
  await waitFor(async () => expect(await p.held(), '有了结果就该能接着改').toEqual([null, false, false, null, false]));
  expect(note()).toBeNull();
  // What that save left, not the list read on coming back.
  expect(p.field('单次执行时限')).toHaveValue('1.5');
  expect(p.row('单次执行时限')).toHaveTextContent(/现在：1\.5 小时 · 默认：3 小时/);
  // What was typed meanwhile is still there to be saved.
  expect(p.field('宽限期')).toHaveValue('5');
  await p.save('宽限期');
  expect(p.calls.map(({ path }) => path)).toEqual(['/api/settings/run.timeoutMs', '/api/settings/run.lostGraceMs']);
});

test('a list asked for on coming back and still on its way when the save is answered is older than the answer, and is not put on the page', async () => {
  holdClock();
  const answer = deferred();
  const early = deferred();
  let reads = 0;
  const p = await settingsPage(() => answer.promise, () => { reads += 1; return reads === 1 ? SETTINGS_PAGE : early.promise; });
  p.type('单次执行时限', '1.5');
  await p.submit('单次执行时限');
  await go('#/');
  await go(AT_RUN);
  await screen.findByRole('heading', { level: 1, name: '设置' });
  expect(reads).toBe(2);
  expect(await p.held(), '上一次保存还没回来，这时再存会被它迟到的答复盖掉').toEqual([null, null, true, null, true]);
  answer.resolve({ settings: SAVED });
  await waitFor(async () => expect(await p.held(), '有了结果就该能接着改').toEqual([null, null, false, null, false]));
  expect(p.field('单次执行时限')).toHaveValue('1.5');
  early.resolve(SETTINGS_PAGE);
  // An answer that must change nothing: there is no result to wait for.
  await pass();
  expect(p.field('单次执行时限'), '迟到的旧读取盖掉了保存的结果').toHaveValue('1.5');
  expect(await p.held(), '迟到的答复不该把哪一项重新锁上').toEqual([null, null, false, null, false]);
});

test('a save refused after the owner left and came back opens the lock, and the page reads the list again: nothing on it says how the save ended', async () => {
  const answer = deferred();
  const page = numbered();
  const p = await settingsPage(() => answer.promise, page.read);
  p.type('单次执行时限', '0');
  await p.submit('单次执行时限');
  await go('#/');
  await go(AT_RUN);
  await p.ready();
  expect(await p.held(), '上一次保存还没回来，这时再存会被它迟到的答复盖掉').toEqual([null, null, true, null, true]);
  expect(note()).not.toBeNull();
  const reads = p.pageReads();
  answer.reject(new Error('单次执行时限不能小于 1 分钟'));
  await waitFor(async () => expect(await p.held(), '被拒了也是有了结果').toEqual([null, null, false, null, false]));
  expect(note()).toBeNull();
  expect(p.pageReads(), '答复回来以后要再读一遍').toBe(reads + 1);
  // Opened, come back to, and now: the third list the service was asked for.
  await page.drawn(3);
  expect(p.field('单次执行时限'), '被拒的值不该留在页面上').toHaveValue('3');
  expect(p.calls.length).toBe(1);
});

test('a save answered while the owner is on another page holds nothing afterwards: the settings page opens on what it saved', async () => {
  holdClock();
  const answer = deferred();
  const back = deferred();
  let reads = 0;
  const p = await settingsPage(() => answer.promise, () => { reads += 1; return reads === 1 ? SETTINGS_PAGE : back.promise; });
  p.type('单次执行时限', '1.5');
  await p.submit('单次执行时限');
  await go('#/');
  answer.resolve({ settings: SAVED });
  // Nobody is on the settings page to show the answer: there is no result to wait for.
  await pass();
  expect(reads, '不在设置页上，迟到的答复不该替这一页去读').toBe(1);
  await go(AT_RUN);
  await screen.findByRole('heading', { level: 1, name: '设置' });
  expect(reads).toBe(2);
  // Before the read made on coming back is answered: what the save left.
  expect(p.field('单次执行时限'), '回来看到的还是保存之前的值').toHaveValue('1.5');
  expect(await p.held(), '答复早就回来了，页面还锁着').toEqual([null, null, false, null, false]);
  expect(note()).toBeNull();
  back.resolve({ ...SETTINGS_PAGE, settings: listing({ 'run.timeoutMs': { value: 7_200_000, stored: true, overridden: true } }) });
  await waitFor(() => expect(p.field('单次执行时限')).toHaveValue('2'));
});

test('a stored value this version will not take is said so beside its item, and 恢复默认 clears it', async () => {
  const p = await settingsPage();
  for (const title of ['宽限期', '单次执行时限']) expect(p.row(title)).not.toHaveTextContent(/不接受的值/);
  await p.to('备份');
  expect(p.row('保留天数')).toHaveTextContent(/账本里存着一个这个版本不接受的值，现在按默认值生效/);
  await p.user.click(p.button('保留天数', '恢复默认')!);
  await p.unlocked();
  expect(p.calls).toEqual([{ path: '/api/settings/backup.keepDays', method: 'DELETE', body: undefined }]);
});

test('the kinds of value that came with the console configuration are shown and sent in their own types', async () => {
  const p = await settingsPage(undefined, undefined, groupHash('服务'));
  const host = p.field('监听地址') as HTMLSelectElement;
  expect(host.tagName).toBe('SELECT');
  expect([...host.options].map((option) => [option.value, option.selected])).toEqual([['127.0.0.1', true], ['0.0.0.0', false]]);
  expect(p.row('监听地址')).toHaveTextContent(/重启后生效（需重启 Tycho 服务进程）/);
  expect(screen.getByRole('region', { name: '服务' })).toHaveTextContent(/需重启 Tycho 服务进程/);
  expect(screen.getByRole('region', { name: '服务' })).not.toHaveTextContent(/下次启动负责人时才生效/);
  // Text, so that "80a" can be typed and refused by the service in its own words.
  expect(p.field('端口')).toHaveAttribute('type', 'text');
  expect(p.field('端口')).toHaveValue('8787');
  await p.to('负责人');
  // The Router's account and tier are picked, not typed; what they send is still a string.
  expect((p.field('负责人的账号') as HTMLSelectElement).tagName).toBe('SELECT');
  expect(p.field('负责人的账号')).toHaveValue('gpu');
  expect(p.field('负责人的档位')).toHaveValue('decide');
  const typed: [string, string, string, string, unknown][] = [
    ['服务', '端口', 'http.port', '9000', 9000],
    ['服务', '监听地址', 'http.host', '0.0.0.0', '0.0.0.0'],
    ['企业微信', '机器人 Bot ID', 'wecom.botId', 'bot-1', 'bot-1'],
    ['企业微信', '网关地址', 'wecom.url', 'wss://gw.example/ws', 'wss://gw.example/ws'],
    ['负责人', 'Claude Code 路径', 'router.cli', 'C:/bin/claude.exe', 'C:/bin/claude.exe'],
    ['备份', '备份目录', 'backup.dir', 'E:/b', 'E:/b'],
    ['服务', '端口', 'http.port', '80a', '80a'],
  ];
  for (const [group, title, key, field, value] of typed) {
    await p.to(group);
    p.type(title, field);
    await p.save(title);
    expect(p.calls.at(-1), title).toEqual({ path: `/api/settings/${key}`, method: 'PUT', body: { value } });
  }
});

test('an empty value says what empty stands for, and "关闭" only where the item does not say', async () => {
  const p = await settingsPage(undefined, undefined, AT_ROUTER);
  expect(p.row('Claude Code 路径')).toHaveTextContent(/现在：空（自动在 PATH 里找 claude）/);
  expect(p.row('负责人的账号')).toHaveTextContent(/现在：gpu · 默认：空（不绑定：用这台电脑自己的登录和默认档位）/);
  expect(p.row('负责人的档位')).toHaveTextContent(/现在：决策档 · 默认：空（不指定，用执行器自己的默认档位）/);
  await p.to('企业微信');
  expect(p.row('机器人 Bot ID')).toHaveTextContent(/现在：空（不启用企业微信）/);
  await p.to('备份');
  expect(p.row('备份目录')).toHaveTextContent(/现在：空（关闭）/);
});

test('the Secret is typed and never shown: the page says only whether one is set, and a save empties the field', async () => {
  const p = await settingsPage(() => ({ secret_set: true }), undefined, groupHash('企业微信'));
  expect(p.field('Secret')).toHaveAttribute('type', 'password');
  expect(p.field('Secret')).toHaveValue('');
  expect(p.row('Secret')).toHaveTextContent(/现在：未设置/);
  expect(p.row('Secret')).toHaveAttribute('id', 'setting-wecom.secret');
  p.type('Secret', 's3cret');
  await p.save('Secret');
  expect(p.calls).toEqual([{ path: '/api/wecom/secret', method: 'PUT', body: { secret: 's3cret' } }]);
  expect(p.field('Secret'), '保存后输入框要清空').toHaveValue('');
  expect(p.row('Secret')).toHaveTextContent(/现在：已设置/);
  expect(document.body.innerHTML, 'Secret 留在了页面上').not.toContain('s3cret');
  expect([...document.querySelectorAll('input, textarea')].map((node) => (node as HTMLInputElement).value)).not.toContain('s3cret');
  p.unmount();

  const set = await settingsPage(undefined, () => ({ ...SETTINGS_PAGE, wecom: { secret_set: true } }), groupHash('企业微信'));
  expect(set.field('Secret'), '已设置的 Secret 不回填').toHaveValue('');
  expect(set.row('Secret')).toHaveTextContent(/现在：已设置/);
  expect(set.row('Secret')).not.toHaveTextContent(/未设置/);
});

test('a Secret the service refuses shows the reason beside its row alone, and holds the other saves while it is sent', async () => {
  const answer = deferred();
  const p = await settingsPage(() => answer.promise, undefined, groupHash('企业微信'));
  p.type('Secret', 'a b');
  await p.submit('Secret');
  expect(p.button('Secret', '保存中')).toBeDisabled();
  expect(await p.held(), '别的项这时也不能提交').toEqual([null, null, true, true, true]);
  answer.reject(new Error('Secret 应为一段不含空白的文字'));
  await waitFor(async () => expect(await p.held(), '有了结果就该能接着改').toEqual([null, null, false, false, false]));
  expect(within(p.row('Secret')).getByRole('alert')).toHaveTextContent(/不含空白/);
  expect(p.row('机器人 Bot ID')).not.toHaveTextContent(/不含空白/);
  expect(p.row('Secret')).toHaveTextContent(/现在：未设置/);
});

test('the Router account row explains and disables unsupported logins', async () => {
  const p = await settingsPage(undefined, undefined, AT_ROUTER);
  const account = p.field('负责人的账号') as HTMLSelectElement;
  expect(account.tagName).toBe('SELECT');
  expect([...account.options].map((option) => [option.value, option.selected]))
    .toEqual([['', false], ['gpu', true], ['cx', false], ['cpu', false], ['bare', false]]);
  expect(account.options[0]).toHaveTextContent('不绑定：用这台电脑自己的登录和默认档位');
  expect(account.options[2]).toBeDisabled();
  expect(account.options[2]).toHaveTextContent('不支持负责人');
});

test('the tier row offers the tiers of the account it is about, and keeps the value in force visible', async () => {
  const p = await settingsPage(undefined, undefined, AT_ROUTER);
  const tier = p.field('负责人的档位') as HTMLSelectElement;
  expect([...tier.options].map((option) => [option.value, option.selected]))
    .toEqual([['', false], ['operate', false], ['execute', false], ['decide', true]]);
  expect(tier.options[0]).toHaveTextContent('不指定，用执行器自己的默认档位');
  // The names read as the page calls them.
  expect(tier.options[1]).toHaveTextContent('操作档');
  expect(tier.options[2]).toHaveTextContent('执行档');
  expect(tier.options[3]).toHaveTextContent('决策档');
  // The account picked in the account row, not yet saved, is the account the tiers come from:
  // cpu holds the execute tier only, so the names it can run are operate (its execute content
  // stands in) and execute — but decide is what the Router is on, so it stays there under its
  // own name to be seen (and cleared). Only a name the system no longer uses is marked as such.
  p.type('负责人的账号', 'cpu');
  expect([...tier.options].map(({ value }) => value)).toEqual(['', 'operate', 'execute', 'decide']);
  expect(tier.options[3]).toHaveTextContent('decide');
  expect(tier.options[3]).not.toHaveTextContent(tierText.stale);
  // An account with no tiers of its own has none to offer; with nothing else to show, the
  // value in force is still the one thing on the row.
  p.type('负责人的账号', 'bare');
  expect(tier).toBeEnabled();
  expect([...tier.options].map(({ value }) => value)).toEqual(['', 'decide']);
  // No account at all: the same.
  p.type('负责人的账号', '');
  expect(tier).toBeEnabled();
  expect([...tier.options].map(({ value }) => value)).toEqual(['', 'decide']);
});

// The operate tier is offered, not refused: the Router may be put on it anyway, and the page
// says why it is not recommended (roles-and-tiers.md §10.3).
test('picking the operate tier for the Router says it is not recommended, without refusing it', async () => {
  const p = await settingsPage(undefined, () => ({ ...SETTINGS_PAGE, settings: listing({ 'router.tier': { value: 'operate' } }) }), AT_ROUTER);
  expect(p.row('负责人的档位')).toHaveTextContent('负责人的活全是判断，不建议用操作档。');
  // The note is about the choice in force; another tier has nothing to say.
  p.type('负责人的档位', 'decide');
  expect(p.row('负责人的档位')).not.toHaveTextContent('不建议用操作档');
  await p.save('负责人的档位');
  expect(p.calls.at(-1)).toEqual({ path: '/api/settings/router.tier', method: 'PUT', body: { value: 'decide' } });
});

// A stored value this version will not take is not lost from the row: it is offered back
// under its own name, marked, so the owner sees what the Router is stopped on and can move
// it, which is the one thing the row is for.
test('a tier the system no longer uses is offered back under its own name, marked', async () => {
  const p = await settingsPage(undefined, () => ({ ...SETTINGS_PAGE, settings: listing({ 'router.tier': { value: 'fast' } }) }), AT_ROUTER);
  const tier = p.field('负责人的档位') as HTMLSelectElement;
  expect([...tier.options].map((option) => [option.value, option.selected]))
    .toEqual([['', false], ['operate', false], ['execute', false], ['decide', false], ['fast', true]]);
  expect(tier.options[4]).toHaveTextContent(`fast（${tierText.stale}）`);
  // Picking one of the names is saved like any other value.
  p.type('负责人的档位', 'execute');
  await p.save('负责人的档位');
  expect(p.calls).toEqual([{ path: '/api/settings/router.tier', method: 'PUT', body: { value: 'execute' } }]);
});

// Nothing to pick and nothing in force is the only state in which the row is closed: a
// value in force is always there to be moved off or cleared.
test('the tier row is closed only when there is nothing to pick and nothing in force', async () => {
  const p = await settingsPage(undefined, () => ({ ...SETTINGS_PAGE, settings: listing({ 'router.tier': { value: '' } }) }), AT_ROUTER);
  expect([...(p.field('负责人的档位') as HTMLSelectElement).options].map(({ value }) => value)).toEqual(['', 'operate', 'execute', 'decide']);
  // An account that holds none of the names, with nothing in force: nothing to pick.
  p.type('负责人的账号', 'bare');
  expect(p.field('负责人的档位')).toBeDisabled();
  expect([...(p.field('负责人的档位') as HTMLSelectElement).options].map(({ value }) => value)).toEqual(['']);
});

test('the Router account selector displays names and saves the selected id', async () => {
  const first = { ...ACCOUNTS.accounts[0]!, id: '01K00000000000000000000031', name: '决策账号' };
  const second = { ...ACCOUNTS.accounts[2]!, id: '01K00000000000000000000032', name: '备用账号' };
  const p = await settingsPage(undefined, () => ({ ...SETTINGS_PAGE, settings: listing({ 'router.account': { value: first.id } }) }), AT_ROUTER,
    () => ({ accounts: [first, second] }));
  await waitFor(() => expect(p.row('负责人的账号')).toHaveTextContent('现在：决策账号'));
  expect(within(p.field('负责人的账号')).getByRole('option', { name: /备用账号/ })).toHaveValue(second.id);
  p.type('负责人的账号', second.id);
  await p.save('负责人的账号');
  expect(p.calls).toEqual([{ path: '/api/settings/router.account', method: 'PUT', body: { value: second.id } }]);
});

test('knowledge login names are read from ids and resolve back to ids on save', async () => {
  const first = { ...ACCOUNTS.accounts[0]!, id: '01K00000000000000000000041', name: '知识账号' };
  const second = { ...ACCOUNTS.accounts[2]!, id: '01K00000000000000000000042', name: '整理账号' };
  const item = { ...unset, key: 'knowledge.logins', group: '知识', title: '知识任务用哪些登录', help: '', type: 'logins', default: [], value: [first.id] };
  const p = await settingsPage(() => ({ settings: [item] }), () => ({ ...SETTINGS_PAGE, settings: [item] }), groupHash('知识'),
    () => ({ accounts: [first, second] }));
  await waitFor(() => expect(p.field(item.title)).toHaveValue('知识账号'));
  expect(p.row(item.title)).toHaveTextContent('现在：账号 知识账号');
  p.type(item.title, '整理账号, 知识账号');
  await p.save(item.title);
  expect(p.calls).toEqual([{ path: '/api/settings/knowledge.logins', method: 'PUT', body: { value: [second.id, first.id] } }]);
});

test('the Router\'s account and tier are saved as picked strings, one save at a time', async () => {
  holdClock();
  const answers = [deferred(), deferred()];
  let sent = 0;
  const p = await settingsPage(() => answers[sent++]!.promise, undefined, AT_ROUTER);
  p.type('负责人的账号', 'cpu');
  await p.submit('负责人的账号');
  expect(p.calls).toEqual([{ path: '/api/settings/router.account', method: 'PUT', body: { value: 'cpu' } }]);
  expect(p.button('负责人的账号', '保存中')).toBeDisabled();
  // The tier row has nothing to send until a tier is picked: with the account picked but
  // not yet saved, the tiers on offer are that account's — execute, and the value in force.
  expect(p.button('负责人的档位', '保存')).toBeNull();
  p.type('负责人的档位', 'execute');
  expect(p.button('负责人的档位', '保存')).toBeDisabled();
  expect(p.restart(), '一次只发一个改动').toBeDisabled();
  // Past the button: a form can be submitted without one.
  fireEvent.submit(p.row('负责人的档位'));
  // A request that must not be made: the first save has not been answered.
  await pass();
  expect(p.calls.length, '上一次保存还没回来又发了一次').toBe(1);
  answers[0]!.resolve({ settings: listing({ 'router.account': { value: 'cpu' } }) });
  // The lock goes with the answer: the row that still has something to send can send it,
  // and the account row has nothing left to send, so it has no button at all.
  await waitFor(() => expect(p.button('负责人的档位', '保存')).toBeEnabled());
  expect(p.button('负责人的账号', '保存')).toBeNull();
  expect(p.restart()).toBeEnabled();
  expect(p.field('负责人的账号')).toHaveValue('cpu');
  // The tier saved for the old account is not one of the new one's: the row offers cpu's own,
  // with the value in force beside them.
  expect([...(p.field('负责人的档位') as HTMLSelectElement).options].map(({ value }) => value)).toEqual(['', 'operate', 'execute', 'decide']);
  p.type('负责人的档位', 'execute');
  await p.submit('负责人的档位');
  expect(p.calls.at(-1)).toEqual({ path: '/api/settings/router.tier', method: 'PUT', body: { value: 'execute' } });
  answers[1]!.resolve({ settings: listing({ 'router.account': { value: 'cpu' }, 'router.tier': { value: 'execute' } }) });
  await waitFor(() => expect(p.field('负责人的档位')).toHaveValue('execute'));
});

test('the two Router rows are drawn while the accounts are still being read, and open on the answer', async () => {
  const accounts = deferred();
  const p = await settingsPage(undefined, undefined, AT_ROUTER, () => accounts.promise);
  // Nothing to bind yet: the account row offers the empty choice, and the tier row shows only
  // the value in force — no account was read, so neither name is on offer.
  expect([...(p.field('负责人的账号') as HTMLSelectElement).options].map(({ value }) => value)).toEqual(['']);
  expect([...(p.field('负责人的档位') as HTMLSelectElement).options].map(({ value }) => value)).toEqual(['', 'decide']);
  expect(p.field('负责人的档位')).toBeEnabled();
  accounts.resolve(ACCOUNTS);
  await waitFor(() => expect([...(p.field('负责人的账号') as HTMLSelectElement).options].map(({ value }) => value))
    .toEqual(['', 'gpu', 'cx', 'cpu', 'bare']));
  expect(p.field('负责人的账号')).toHaveValue('gpu');
  expect(p.field('负责人的档位')).toBeEnabled();
  expect(p.field('负责人的档位')).toHaveValue('decide');
});

test('the page and its Router rows stay usable when the accounts cannot be read', async () => {
  const p = await settingsPage(undefined, undefined, AT_RUN, unreadable);
  // The rest of the page is drawn from its own read, which answered.
  expect(p.field('单次执行时限')).toHaveValue('3');
  await p.to('负责人');
  expect(p.router()).toHaveTextContent(/负责人在运行/);
  // The account row offers only this computer's own login; the tier row has no account to
  // take tiers from, so the value in force is the one thing left on it.
  expect([...(p.field('负责人的账号') as HTMLSelectElement).options].map(({ value }) => value)).toEqual(['']);
  expect(p.field('负责人的账号')).toBeEnabled();
  expect([...(p.field('负责人的档位') as HTMLSelectElement).options].map(({ value }) => value)).toEqual(['', 'decide']);
  expect(p.field('负责人的档位')).toBeEnabled();
  // A row that could not read the accounts still saves what it was picked to say.
  p.type('负责人的账号', '');
  await p.save('负责人的账号');
  expect(p.calls).toEqual([{ path: '/api/settings/router.account', method: 'PUT', body: { value: '' } }]);
});

test('the Router reads as running, as stopped with its reason, or as restarting, and never as running when it is not', async () => {
  const cases: [object, RegExp, boolean][] = [
    [{}, /负责人在运行/, false],
    [{ alive: false, pid: null }, /没有在运行，有消息来时会自动启动/, false],
    [{ alive: false, pid: null, error: '在 PATH 里没有找到 claude。到“设置 › 负责人”改好后点“重启负责人”' }, /负责人已停摆：在 PATH 里没有找到 claude/, false],
    [{ restarting: true }, /负责人正在重启/, true],
    [{ restarting: true, turn: 'm1', error: '档位文件不存在' }, /当前这一回合结束后重启.*打断/, true],
  ];
  for (const [router, said, held] of cases) {
    const p = await settingsPage(undefined, () => ({ ...SETTINGS_PAGE, router: { ...SETTINGS_PAGE.router, ...router } }), AT_ROUTER);
    expect(p.router()).toHaveTextContent(said);
    if (!/负责人在运行/.test(String(said))) expect(p.router()).not.toHaveTextContent(/负责人在运行/);
    expect(p.restart()).toHaveTextContent('重启负责人');
    // While it restarts it cannot be asked again.
    if (held) expect(p.restart()).toBeDisabled(); else expect(p.restart()).toBeEnabled();
    expect(p.router()).toHaveTextContent(/Claude Code 路径、负责人的账号、负责人的档位.*下次启动负责人时才生效/);
    p.unmount();
  }
});

test('重启负责人 asks the service once, and the page says whether it waits for the turn under way', async () => {
  holdClock();
  for (const [turn, said] of [[null, /负责人正在重启/], ['m1', /当前这一回合结束后重启.*到对话里点“打断”/]] as const) {
    const p = await settingsPage(() => ({ restarting: true, waiting_for_turn: turn }), undefined, AT_ROUTER);
    const reads = p.pageReads();
    await p.user.click(p.restart());
    await p.unlocked();
    expect(p.calls).toEqual([{ path: '/api/router/restart', method: 'POST', body: {} }]);
    expect(p.router()).toHaveTextContent(said);
    if (turn === null) expect(p.router()).not.toHaveTextContent(/打断/);
    expect(p.restart()).toBeDisabled();
    // A read that must not be made: there is none to wait for.
    await pass();
    expect(p.pageReads(), '答复就是新的状态，不用再读一遍').toBe(reads);
    // The restart is handed over and its own button stays off until the Router is back,
    // which the row above says; every other row can be changed again.
    expect(await p.held(), '重启已经交给服务，别的项可以接着改').toEqual([null, null, false, null, true]);
    p.unmount();
  }
  const refused = await settingsPage(() => { throw new Error('服务正在恢复清点，现在不能重启负责人'); }, undefined, AT_ROUTER);
  await refused.user.click(refused.restart());
  await refused.unlocked();
  expect(within(refused.router()).getByRole('alert')).toHaveTextContent(/现在不能重启负责人/);
  expect(refused.router()).toHaveTextContent(/负责人在运行/);
  expect(refused.restart()).toBeEnabled();
});

const current = () => within(screen.getByRole('navigation', { name: '设置分组' })).getAllByRole('link').find((link) => link.getAttribute('aria-current') === 'page')?.textContent;

test('#/settings/<key> opens the settings page with that item marked, and brings it into view once', async () => {
  const marked = () => [...document.querySelectorAll('[aria-current="true"]')].map((node) => node.id);
  const scrolled = vi.mocked(Element.prototype.scrollIntoView);
  // Each read finds something changed, as a page left open does.
  const page = numbered();
  const p = await settingsPage(undefined, page.read, '#/settings/router.tier');
  expect(screen.getByRole('navigation', { name: '配置' }).querySelector('[aria-current="page"]')).toHaveTextContent('设置');
  expect(current()).toBe('负责人');
  expect(marked()).toEqual(['setting-router.tier']);
  expect(scrolled.mock.contexts).toEqual([p.row('负责人的档位')]);
  expect(scrolled).toHaveBeenCalledWith({ block: 'center' });
  expect(p.row('Claude Code 路径')).toHaveAttribute('id', 'setting-router.cli');
  await p.reread();
  // Drawn again, from a list that is not the one it was opened with.
  await page.drawn(2);
  p.type('Claude Code 路径', 'C:/x');
  expect(marked(), '标记要一直在').toEqual(['setting-router.tier']);
  expect(scrolled, '后来的重画不能再把页面拉回去').toHaveBeenCalledTimes(1);
  p.unmount();

  scrolled.mockClear();
  await settingsPage();
  expect(marked()).toEqual([]);
  expect(scrolled).not.toHaveBeenCalled();
});

test('who last changed an item is in the owner\'s words, and a name the page does not know stays as it is', async () => {
  const p = await settingsPage(undefined, undefined, groupHash('备份'));
  expect(p.row('保留天数')).toHaveTextContent(/导入旧配置时修改/);
  expect(p.row('保留天数')).not.toHaveTextContent(/import/);
  expect(p.row('时刻')).toHaveTextContent(/由zhangsan修改/);
});

test('nothing to save until something is typed, and 撤销 drops what was typed', async () => {
  const p = await settingsPage();
  expect(p.button('单次执行时限', '保存')).toBeNull();
  expect(p.button('单次执行时限', '撤销')).toBeNull();
  p.type('单次执行时限', '4');
  expect(p.button('单次执行时限', '保存')).toBeEnabled();
  await p.user.click(p.button('单次执行时限', '撤销')!);
  expect(p.field('单次执行时限')).toHaveValue('3');
  expect(p.button('单次执行时限', '保存')).toBeNull();
  expect(p.calls).toEqual([]);
});

test('what an item means folds away', async () => {
  const p = await settingsPage();
  const help = within(p.row('单次执行时限')).getByText('一轮最多跑多久');
  expect(help.closest('details')).not.toHaveAttribute('open');
  expect(help).not.toBeVisible();
  await p.user.click(within(p.row('单次执行时限')).getByText('说明'));
  await waitFor(() => expect(help).toBeVisible());
});

test('one page per group: every group is listed with the one in view marked, and a draft waits on its page', async () => {
  const p = await settingsPage(undefined, undefined, '#/settings');
  const groups = within(screen.getByRole('navigation', { name: '设置分组' })).getAllByRole('link');
  expect(groups.map((link) => link.textContent)).toEqual(['负责人', '执行', '企业微信', '登录', '服务', '备份', '部署信息']);
  // No group named: the first one.
  expect(current()).toBe('负责人');
  const shown = () => within(screen.getByRole('main')).getAllByRole('heading', { level: 2 }).map((node) => node.textContent);
  expect(shown()).toEqual(['负责人']);
  expect(screen.queryByLabelText('单次执行时限')).toBeNull();
  // Each group's entry leads to its page, and only its items are on it.
  await p.user.click(groups[1]!);
  expect(window.location.hash).toBe(groupHash('执行'));
  expect(current()).toBe('执行');
  expect(shown()).toEqual(['执行']);
  expect(screen.queryByLabelText('Claude Code 路径')).toBeNull();
  // What was typed on one page is there when the owner comes back to it.
  p.type('单次执行时限', '4');
  await p.to('备份');
  expect(shown()).toEqual(['备份']);
  await p.to('执行');
  expect(p.field('单次执行时限')).toHaveValue('4');
  expect(p.button('单次执行时限', '保存')).toBeEnabled();
  // A group the page does not know is no page of its own: the first one is shown.
  await go('#/settings/没有这一组');
  expect(current()).toBe('负责人');
  expect(p.calls).toEqual([]);
});

test('a link to an item in any group opens that group at it, and the two rows that are no items can be linked to too', async () => {
  const marked = () => [...document.querySelectorAll('[aria-current="true"]')].map((node) => node.id);
  const scrolled = vi.mocked(Element.prototype.scrollIntoView);
  const p = await settingsPage(undefined, undefined, '#/settings/backup.at');
  expect(current()).toBe('备份');
  expect(marked()).toEqual(['setting-backup.at']);
  expect(scrolled.mock.contexts).toEqual([p.row('时刻')]);
  await go('#/settings/wecom.secret');
  expect(current()).toBe('企业微信');
  expect(marked()).toEqual(['setting-wecom.secret']);
  await go('#/settings/router.restart');
  expect(current()).toBe('负责人');
  expect(marked()).toEqual(['setting-router.restart']);
  expect(scrolled).toHaveBeenCalledTimes(3);
});

test('the search finds an item in any group by its name, its meaning or its key, says which group, and leads there', async () => {
  const scrolled = vi.mocked(Element.prototype.scrollIntoView);
  const p = await settingsPage(undefined, undefined, '#/settings');
  const search = screen.getByRole('combobox', { name: '搜索设置' });
  const results = () => screen.queryByRole('listbox', { name: '搜索结果' });
  expect(results(), '没有输入时不该有结果').toBeNull();
  // By meaning: across two groups, each result under its own group.
  await p.user.type(search, '多久');
  const found = () => within(results()!).getAllByRole('option').map((option) => option.textContent);
  expect(found()).toEqual(['单次执行时限执行 · run.timeoutMs', '宽限期执行 · run.lostGraceMs', '保留天数备份 · backup.keepDays']);
  expect(within(results()!).getByRole('group', { name: '执行' })).toBeInTheDocument();
  expect(within(results()!).getByRole('group', { name: '备份' })).toBeInTheDocument();
  // By key, and by name; the Secret, which is no item of the list, is found too.
  await p.user.clear(search);
  await p.user.type(search, 'HTTP.PORT');
  expect(found()).toEqual(['端口服务 · http.port']);
  await p.user.clear(search);
  await p.user.type(search, 'secret');
  expect(found()).toEqual(['Secret企业微信 · wecom.secret']);
  await p.user.clear(search);
  await p.user.type(search, '没有这种设置');
  expect(results()).toHaveTextContent('没有匹配“没有这种设置”的设置。');
  // A result leads to its group's page, at that item.
  await p.user.clear(search);
  await p.user.type(search, '宽限');
  await p.user.click(within(results()!).getByRole('option', { name: /宽限期/ }));
  expect(window.location.hash).toBe('#/settings/run.lostGraceMs');
  expect(current()).toBe('执行');
  expect(p.row('宽限期')).toHaveAttribute('aria-current', 'true');
  expect(scrolled.mock.contexts.at(-1)).toBe(p.row('宽限期'));
  expect(results(), '选好以后结果就收起').toBeNull();
  // Picking the same one again brings it into view again.
  await p.user.click(search);
  await p.user.click(within(results()!).getByRole('option', { name: /宽限期/ }));
  expect(scrolled).toHaveBeenCalledTimes(2);
  expect(p.calls).toEqual([]);
});

test('a save says 已保存 for a moment and then goes quiet', async () => {
  holdClock();
  const p = await settingsPage(() => ({ settings: listing({ 'run.timeoutMs': { value: 5_400_000, stored: true, overridden: true } }) }));
  p.type('单次执行时限', '1.5');
  await p.save('单次执行时限');
  expect(within(p.row('单次执行时限')).getByRole('status')).toHaveTextContent('已保存');
  await pass(2000);
  expect(within(p.row('单次执行时限')).queryByRole('status')).toBeNull();
});

test('Enter in the box is the same send as 保存', async () => {
  const p = await settingsPage();
  const field = p.field('单次执行时限');
  await p.user.clear(field);
  await p.user.type(field, '1.5{Enter}');
  await p.unlocked();
  expect(p.calls).toEqual([{ path: '/api/settings/run.timeoutMs', method: 'PUT', body: { value: 5_400_000 } }]);
});

test('standalone boolean switch saves immediately without a separate 保存 button and marks dirty text groups in nav', async () => {
  const boolItem = { ...unset, key: 'run.autoRetry', group: '执行', title: '自动重试', help: '失败后自动重试', type: 'boolean', default: false, value: false };
  let boolValue = false;
  const p = await settingsPage(
    (call) => {
      if (call.path === '/api/settings/run.autoRetry') {
        boolValue = Boolean((call.body as { value: boolean }).value);
        return { settings: [...SETTINGS_PAGE.settings, { ...boolItem, value: boolValue, stored: true, overridden: boolValue }] };
      }
      return { settings: [...SETTINGS_PAGE.settings, { ...boolItem, value: boolValue }] };
    },
    () => ({ ...SETTINGS_PAGE, settings: [...SETTINGS_PAGE.settings, { ...boolItem, value: boolValue }] }),
  );
  const toggle = screen.getByRole('switch', { name: '自动重试' });
  expect(toggle).not.toBeChecked();
  await p.user.click(toggle);
  await p.unlocked();
  expect(p.calls).toEqual([{ path: '/api/settings/run.autoRetry', method: 'PUT', body: { value: true } }]);
  expect(screen.getByRole('switch', { name: '自动重试' })).toBeChecked();
  expect(p.button('自动重试', '保存')).toBeNull();
  expect(within(p.row('自动重试')).getByRole('status')).toHaveTextContent('已保存');

  // Unsaved text edits show a dirty indicator on their group nav item.
  const execNav = within(screen.getByRole('navigation', { name: '设置分组' })).getByRole('link', { name: '执行' });
  expect(execNav).not.toHaveAttribute('data-dirty');
  p.type('单次执行时限', '5');
  expect(execNav).toHaveAttribute('data-dirty', 'true');
});
