// Guards the machines page (docs/design/accounts-machines-decoupled.md "控制台"): one card
// per machine with what it is and where it came from, and on it one block per executor —
// whether it is installed there, what version it printed, whether the machine is signed in
// to it, whether its read-only way started there, its own tiers, and the way to the
// form that edits them (a drawer beside the page). So: a machine never tried reading as reachable or as down; an
// executor the machine reports as installed when it is not, a version or a reason dropped, a
// report from hours ago reading as one just read, a machine that has not reported reading as
// one with nothing installed, a login tycho keeps shown as the machine's own report (or the
// other way round), and a machine's own login offered as usable while it is signed out,
// refused or unreported. A machine's own login whose form offers no models to pick although
// its machine reported them — most of all one not yet set up — or one left with a bare box
// and no word on why there is no list. Also: a target saved in the wrong unit or shape, an "add" that
// silently overwrites a machine of the same name, a refused save that loses the form or its
// reason, a machine with work on it deleted without its cost being shown first or one that
// still asks after the owner agreed, and a change to a machine that the service took showing
// as the old machine again because the read after it failed. And the machines a task spawned
// (nodes.md §1.3): their endings shown as one state or an ended registration read as a
// released instance, their quotas not listed or revoked wrongly, and their removal named or
// handled as a manual machine's. And the machines asking to be let in (nodes.md §1.1): the
// wrong request let in or refused, a decided one left waiting, an expired one shown as still
// valid, and an empty list reading as a failure. And that no account is set up here any more:
// tokens, accounts and their tiers are the accounts page's. And, once a list has been read, a tier that
// names no model yet opening as a box to type in with the list as an afterthought: the owner
// asked for the choices, and typing by hand is the way out of them, not the way in.
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import { modelText } from '@shared/labels.ts';
import { POLL_MS } from '@/lib/queries';
import { deferred, go, holdClock, open, pass, refusal } from '@/test/harness';
import { HOST_MACHINE_UNKNOWN_TEXT, RETIRED_TIER_STANDING } from '@shared/logins.ts';
import {
  ACCOUNTS_PAGE, ADD, CODEX, INVITE, JOIN, MACHINES, MODELS, REVOKED, SPAWNED_ENDS, TIERED, WINDOWS, accountsPage,
  machinesApp, nodeMachine, onB1, own, ownSaved, spawned, unreadable, type LoginsApp,
} from '@/test/logins';

// An executor's block on its machine's card: the name the page gives it, the same whether
// the test points at it or a screen reader reads it aloud. Found also while something is
// open over the page.
const execRow = (p: LoginsApp, machine: string, executor: string): HTMLElement =>
  within(p.target(`机器 ${machine}`)!).getByRole('group', { name: `${machine} 上的 ${executor}`, hidden: true });
// The executor's block when tycho also keeps a login for it there.
const ownRow = (p: LoginsApp, machine: string, executor: string): HTMLElement =>
  within(p.target(`机器 ${machine}`)!).getByRole('group', { name: `${machine} 上的 ${executor} 登录`, hidden: true });
// What a machine's "更多" holds, in order.
const actionsOf = async (p: LoginsApp, machine: string): Promise<(string | null)[]> => {
  const items = within(await p.menu(`机器 ${machine}`)).getAllByRole('menuitem').map((item) => item.textContent);
  await p.user.keyboard('{Escape}');
  await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
  return items;
};
const noteWindow = (machine: string): HTMLElement => screen.getByRole('dialog', { name: `机器 ${machine} 的备注` });

test('an unknown host registration says how to restore its own login binding', async () => {
  open('#/machines', (call) => {
    if (call.path === '/api/accounts') return ACCOUNTS_PAGE;
    if (call.path === '/api/machines') return { machines: MACHINES, invites: [], host_machine: null };
    return undefined;
  });
  expect(await screen.findByText(HOST_MACHINE_UNKNOWN_TEXT)).toBeInTheDocument();
});

test('the machines page lists each machine as the service has it, with its executors one block each', async () => {
  // b1 holds the machine's own login of its codex: one row, with what tycho keeps for it.
  const p = await machinesApp(undefined, () => ACCOUNTS_PAGE, onB1(own('b1', 'codex')));
  const a1 = p.target('机器 a1')!;
  expect(a1).toHaveTextContent('主机名 a1');
  expect(within(a1).getByRole('button', { name: '测试连接' })).toBeInTheDocument();
  // It has not reported its executors yet: there is nothing to list, and the card says why.
  expect(a1).toHaveTextContent('还没读到机器上有哪些执行器');
  expect(within(a1).queryByRole('group')).toBeNull();
  // What can be written about it or done to it is behind its "更多": a note, and its removal.
  // (That its name cannot be changed is said where the note is written.)
  expect(await actionsOf(p, 'a1')).toEqual(['加备注', '删除']);
  const row = ownRow(p, 'b1', 'codex');
  expect(row).toHaveTextContent('codex');
  expect(row).toHaveTextContent('已登录');
  expect(within(row).getByTitle('model=<模型名>')).toHaveTextContent('决策档');
  expect(within(row).getByRole('button', { name: '修改' })).toBeInTheDocument();
  // An account is not a machine: nothing of the accounts page is here.
  expect(screen.queryByRole('button', { name: ADD })).toBeNull();
  expect(screen.queryByLabelText('API 密钥')).toBeNull();
});

test('机器详情的重新登录固定这台机器，关闭窗口取消设备码登录', async () => {
  const offered = () => ({ ...ACCOUNTS_PAGE, account_logins: { ...ACCOUNTS_PAGE.account_logins, codex: [{ way: 'machine', available: true }] } });
  const machine = { ...nodeMachine('b1', { connected: true, executors: { at: '2026-11-11T00:00:00Z', executors: [{ executor: 'codex', installed: true, version: '0.162.0', logged_in: false }] } }), logins: [own('b1', 'codex', { refused: true })] };
  const view = { id: 's1', machine: 'b1', executor: 'codex', state: 'waiting', url: 'https://auth.openai.com/codex/device', code: 'ABCD-12345', reason: null, signed_in: false };
  const p = await machinesApp((call) => {
    if (call.path === '/api/sign-ins') return { sign_in: view };
    if (call.path === '/api/sign-ins/s1') return { sign_in: view };
    if (call.path === '/api/sign-ins/s1/cancel') return { sign_in: { ...view, state: 'cancelled' } };
    return undefined;
  }, offered, () => [machine]);
  await p.user.click(within(ownRow(p, 'b1', 'codex')).getByRole('button', { name: '重新登录' }));
  const dialog = screen.getByRole('dialog', { name: '重新登录 b1 上的 codex' });
  expect(dialog).toHaveTextContent('更换那台机器上执行器自己的登录');
  expect(within(dialog).queryByRole('radio')).toBeNull();
  await p.user.click(within(dialog).getByRole('button', { name: '开始登录' }));
  await within(dialog).findByText('ABCD-12345');
  expect(p.calls.find((call) => call.path === '/api/sign-ins')?.body).toEqual({ machine: 'b1', executor: 'codex', machine_uid: 'uid-b1' });
  await p.user.keyboard('{Escape}');
  await waitFor(() => expect(p.calls.some((call) => call.path === '/api/sign-ins/s1/cancel')).toBe(true));
});

// nodes.md §1.1: a machine is brought in on that machine, never added here. The steps say
// where, as whom, what to run and what counts as done, at the address the owner gave as this
// service's own — or, with none, at this page's own address, said to work only where that
// address opens.
test('bringing a machine in is a set of steps with the join command, not a form', async () => {
  const p = await machinesApp(undefined, () => ACCOUNTS_PAGE, () => MACHINES, undefined, undefined, undefined, 'https://tycho.example.test/');
  expect(screen.queryByRole('button', { name: '添加机器' })).toBeNull();
  await p.user.click(screen.getByRole('button', { name: '接入一台机器' }));
  const steps = screen.getByRole('dialog', { name: '接入一台机器' });
  expect(steps).toHaveTextContent('tycho node join --to https://tycho.example.test');
  expect(steps).toHaveTextContent('不是 root、不是管理员');
  expect(steps).toHaveTextContent('点侧栏的“放行”');
  expect(steps).toHaveTextContent('已连回来');
  // The command keeps running in that terminal; running in the background is the client's autostart.
  expect(steps).toHaveTextContent('在这个终端里接着运行');
  expect(steps).toHaveTextContent('tycho node service install');
  expect(steps).not.toHaveTextContent('后台常驻');
  expect(steps).not.toHaveTextContent('还没有填对外地址');
  expect(within(steps).queryByRole('textbox')).toBeNull();
  expect(p.calls).toEqual([]);
});

test('with no public address the steps use this page\'s own address and say who can use it', async () => {
  const p = await machinesApp(undefined, () => ACCOUNTS_PAGE, () => MACHINES);
  await p.user.click(screen.getByRole('button', { name: '接入一台机器' }));
  const steps = screen.getByRole('dialog', { name: '接入一台机器' });
  expect(steps).toHaveTextContent(`tycho node join --to ${window.location.origin}`);
  expect(steps).toHaveTextContent('还没有填对外地址');
  expect(steps).toHaveTextContent('只有能打开这个地址的机器');
});

test('a machine\'s note is the one thing written here, and its name stays as its client said it', async () => {
  let listed = MACHINES;
  const p = await machinesApp((call) => {
    const updated = { ...MACHINES[0]!, ...(call.body as object) };
    listed = MACHINES.map((machine) => machine.id === updated.id ? updated : machine);
    return { machine: updated };
  }, () => ACCOUNTS_PAGE, () => listed);
  const region = screen.getByRole('region', { name: '机器 a1' });
  await p.pick('机器 a1', '加备注');
  const note = noteWindow('a1');
  // Its name is its own client's: the window says so, and offers no way to change it.
  expect(within(note).queryByLabelText('名字')).toBeNull();
  expect(note).toHaveTextContent('机器名是加入时那台机器上的客户端报上来的，改不了');
  fireEvent.change(within(note).getByLabelText('备注'), { target: { value: ' GPU 机器 ' } });
  await p.user.click(within(note).getByRole('button', { name: '保存' }));
  // Taken: the window closes, and the card shows the note.
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(region).toHaveTextContent('GPU 机器');
  expect(p.calls).toEqual([{ method: 'PUT', path: '/api/machines/a1', body: { note: 'GPU 机器' } }]);
  expect(await actionsOf(p, 'a1')).toEqual(['改备注', '删除']);
});

test('machine deletion shows the service cost, keeps confirmation across refresh, and deletes only after consent', async () => {
  let listed = MACHINES;
  const p = await machinesApp((call) => {
    if (!call.path.endsWith('?confirm=1')) throw refusal('机器 a1 还有未结束的执行，确认后会自动接续', 409, { needs_confirm: true });
    listed = MACHINES.filter((machine) => machine.id !== 'a1');
    return { deleted: true };
  }, () => ACCOUNTS_PAGE, () => listed);
  await p.pick('机器 a1', '删除');
  // The question names the machine, and nothing is sent before it is answered.
  expect(p.question()).toHaveAccessibleName('删除机器 a1？');
  expect(p.calls).toEqual([]);
  await p.decide('确认删除 a1');
  expect(await within(p.question()!).findByRole('alert')).toHaveTextContent('还有未结束的执行');
  expect(p.target('机器 a1')).toBeInTheDocument();
  await p.reread();
  expect(within(p.question()!).getByRole('alert'), '页面自己重读不能把等确认的状态冲掉').toHaveTextContent('还有未结束的执行');
  await p.decide('确认删除 a1');
  await waitFor(() => expect(p.target('机器 a1')).toBeNull());
  expect(p.question()).toBeNull();
  expect(p.calls.map(({ method, path }) => [method, path])).toEqual([['DELETE', '/api/machines/a1'], ['DELETE', '/api/machines/a1?confirm=1']]);
});

// What the service took must not be undone by a read that failed after it: the page stands
// on the answer, and the form is closed.
test('a machine change the service took is on the page from its own answer when the read after it fails', async () => {
  let down = false;
  const p = await machinesApp((call) => { down = true; return { machine: { ...MACHINES[0]!, ...(call.body as object) } }; },
    () => (down ? unreadable() : ACCOUNTS_PAGE), () => MACHINES);
  const region = screen.getByRole('region', { name: '机器 a1' });
  await p.pick('机器 a1', '加备注');
  fireEvent.change(within(noteWindow('a1')).getByLabelText('备注'), { target: { value: '新备注' } });
  await p.user.click(within(noteWindow('a1')).getByRole('button', { name: '保存' }));
  await waitFor(() => expect(p.main()).toHaveTextContent(/读不到账号/));
  expect(region).toHaveTextContent('新备注');
  expect(screen.queryByRole('dialog'), '保存成功后窗口收起').toBeNull();
});

test('a machine connection check asks that machine and preserves its failure reason', async () => {
  const answer = deferred();
  const p = await machinesApp(() => answer.promise);
  const region = screen.getByRole('region', { name: '机器 a1' });
  await p.user.click(within(region).getByRole('button', { name: '测试连接' }));
  expect(within(region).getByRole('button', { name: '测试中' })).toBeDisabled();
  expect(p.more('机器 a1'), '测试是只读的，不挡别的改动').toBeEnabled();
  expect(p.calls).toEqual([{ method: 'POST', path: '/api/machines/a1/check', body: {} }]);
  answer.resolve({ machine_id: 'a1', host: 'a1', reachable: false, error: '机器 a1 没有连回来' });
  await within(region).findByText('a1：连不上，机器 a1 没有连回来');
  expect(within(region).getByRole('button', { name: '测试连接' })).toBeEnabled();
});

// The console's side of the machines that come back by themselves (nodes.md §1.1), and the
// requests waiting to be let in, read while they wait.
test('a machine that came back by itself reads as here or away, with its platform, source and what it says is running', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-11-06T10:40:00.000Z'));
  const p = await machinesApp(undefined, () => ACCOUNTS_PAGE, () => [
    nodeMachine('mac-mini-01', { connected: true, reported_runs: 2, reported_unknown: 1 }),
    nodeMachine('cluster-07', { last_seen_at: '2026-11-06T10:12:00.000Z' }),
    nodeMachine('builder', { connected: true, platform: null, source: { task_id: 't-9', run_id: 'r-41', round: 3 }, ephemeral: true, scope: { project_id: 'p1', executors: null }, ends: SPAWNED_ENDS }),
  ]);
  const here = p.target('机器 mac-mini-01')!;
  expect(here).toHaveTextContent('主机名 mac-mini-01.local');
  expect(here).toHaveTextContent('已连回来');
  expect(here).toHaveTextContent('在跑 2 轮，另有 1 轮待核实');
  expect(here).toHaveTextContent('系统darwin 24.5.0');
  expect(here).toHaveTextContent('来源手动加入');
  // Its "测试连接" asks the machine itself, which is the one thing that can be tried here.
  expect(within(here).getByRole('button', { name: '测试连接' })).toBeInTheDocument();

  // Away: a state, not a fault, and it says when it was last heard from.
  const away = p.target('机器 cluster-07')!;
  expect(away).toHaveTextContent(/没连回来：上次往来 \d\d:\d\d/);
  expect(away).not.toHaveTextContent('执行在跑');
  // What it never reported is said as unknown, and a derived, temporary machine says so.
  const builder = p.target('机器 builder')!;
  expect(builder).toHaveTextContent('系统没说');
  expect(builder).toHaveTextContent('来源由任务 t-9 第 3 轮派生');
  expect(builder).toHaveTextContent('临时');
  // A machine let in by hand can be deleted.
  expect(await actionsOf(p, 'mac-mini-01')).toEqual(['加备注', '删除']);
});

// What a machine reported of the executors on itself (nodes.md §1.2), one row each. Guards
// against: an executor said to be signed in when it is not (or the other way round), its
// version dropped, one that is not there at all reading as a fault or carrying anything
// else, what it could not read dropping its reason, a report from ten minutes ago reading as
// one just read, and a machine that has not reported yet reading as one with nothing
// installed — or as one that reported nothing.
// The global entry (knowledge-and-skills.md §4.3), in each machine's executor table and, for
// the host itself, at the top of the page. Guards against: a file written but kept out by the
// executor's own rules reading as in use, one whose loading cannot be confirmed reading as read,
// a file that is not tycho's (and was left alone) reading as written, the reason dropped, a
// machine that has not said anything reading as one with nothing written, and the moment of the
// entry lost beside the moment of the executor report.
test('each machine shows what became of the global entry, executor by executor, and the host its own at the top', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-11-06T10:40:00.000Z'));
  const executors = {
    at: '2026-11-06T10:30:00.000Z',
    executors: [
      { executor: 'claude', installed: true, version: '2.1.303 (Claude Code)', logged_in: true },
      { executor: 'codex', installed: true, version: 'codex-cli 0.162.0', logged_in: true },
      { executor: 'dsh', installed: true, version: '0.2.2-rc.1', logged_in: null, read_only_offered: false },
    ],
  };
  const p = await machinesApp(undefined, () => ACCOUNTS_PAGE, () => [
    nodeMachine('mac-mini-01', {
      connected: true,
      executors,
      entry: {
        digest: 'abcd', at: '2026-11-06T10:38:00.000Z',
        executors: [
          { executor: 'claude', path: '/home/o/.claude/rules/tycho-knowledge.md', state: 'written' },
          { executor: 'codex', path: '/home/o/.codex/AGENTS.md', state: 'occupied', note: '这里已有不是 tycho 生成的内容，没动它' },
          { executor: 'dsh', path: '/home/o/.dsh/AGENTS.md', state: 'unconfirmed', note: 'dsh 读不读取决于机器上的 profile' },
        ],
      },
    }),
    nodeMachine('quiet', { connected: true, executors }),
  ], undefined, undefined, () => ({ digest: 'abcd', at: '2026-11-06T10:39:30.000Z', executors: [{ executor: 'claude', path: 'C:/Users/o/.claude/rules/tycho-knowledge.md', state: 'covered', note: '旁边有 X' }] }));
  const card = p.target('机器 mac-mini-01')!;
  expect(execRow(p, 'mac-mini-01', 'claude')).not.toHaveTextContent('已写入 /home/o/.claude/rules/tycho-knowledge.md');
  expect(execRow(p, 'mac-mini-01', 'codex')).toHaveTextContent('没写：/home/o/.codex/AGENTS.md 这里已有不是 tycho 生成的内容，没动它');
  expect(execRow(p, 'mac-mini-01', 'dsh')).toHaveTextContent('已写入 /home/o/.dsh/AGENTS.md，读不读确认不了：dsh 读不读取决于机器上的 profile');
  // A machine that has said nothing about the entry: nothing written is not what it says.
  expect(execRow(p, 'quiet', 'claude')).not.toHaveTextContent('没有写');
  // The host's own abnormal entry state appears ahead of the cards.
  const host = await screen.findByText(/^主机本机执行器的全局知识入口/);
  expect(host).toHaveTextContent('主机本机执行器的全局知识入口（刚刚写）：claude 已写入 C:/Users/o/.claude/rules/tycho-knowledge.md，但执行器不会读到：旁边有 X');
  expect(card.contains(host)).toBe(false);
});

test('a machine that came back by itself shows what it read on itself, row by row, and when it read it', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-11-06T10:40:00.000Z'));
  const p = await machinesApp(undefined, () => ACCOUNTS_PAGE, () => [
    nodeMachine('mac-mini-01', {
      connected: true,
      executors: {
        at: '2026-11-06T10:30:00.000Z',
        executors: [
          { executor: 'claude', installed: true, version: '2.1.0 (Claude Code)', logged_in: true, read_only: { available: true, layer: 'tools', checks_code: true } },
          { executor: 'codex', installed: true, version: 'codex-cli 0.9', logged_in: false, read_only: { available: false, layer: 'filesystem', error: "bwrap: Can't bind mount" } },
          { executor: 'dsh', installed: true, version: '0.2.2-rc.1', logged_in: null, read_only_offered: false },
          { executor: 'gone', installed: false, version: null, logged_in: null },
          { executor: 'gemini', installed: true, version: null, logged_in: null, error: '命令没有回答' },
          { executor: 'old', installed: true, version: '0.2.1-rc.5', logged_in: null, unusable: '这一版用不了：不认 --permission-mode，升到 0.2.2-rc.1 以上' },
        ],
      },
    }),
    nodeMachine('quiet'),
  ]);
  const card = p.target('机器 mac-mini-01')!;
  // When it read them is on the table, so an old report never reads as a fresh one.
  expect(card).toHaveTextContent('机器上的执行器（10 分钟前读到）');
  // Each executor is one row, and the row says what its own facts are. The executor is
  // named by its id, which is what the rest of the console shows.
  expect(execRow(p, 'mac-mini-01', 'claude')).toHaveTextContent('装了 · 2.1.0 (Claude Code)');
  expect(execRow(p, 'mac-mini-01', 'claude')).toHaveTextContent('已登录');
  expect(execRow(p, 'mac-mini-01', 'claude')).toHaveTextContent('可用（工具层）');
  expect(execRow(p, 'mac-mini-01', 'codex')).toHaveTextContent('没登录');
  expect(execRow(p, 'mac-mini-01', 'codex')).toHaveTextContent("不可用（bwrap: Can't bind mount）");
  // An executor that offers no read-only way says so rather than nothing; one that could not
  // answer keeps its own words; a strength or a login it never read is not invented.
  expect(execRow(p, 'mac-mini-01', 'dsh')).toHaveTextContent('这个执行器不提供只读');
  expect(execRow(p, 'mac-mini-01', 'dsh')).toHaveTextContent('说不清');
  expect(execRow(p, 'mac-mini-01', 'gemini')).toHaveTextContent('说不清（命令没有回答）');
  // Not there at all: nothing else of that entry is said about it.
  const gone = execRow(p, 'mac-mini-01', 'gone');
  expect(gone).toHaveTextContent('没装');
  expect(gone).not.toHaveTextContent(/已登录|没登录/);
  // A version the service cannot run is said where the version is, and nothing is guessed
  // about a login or a read-only way it never had the chance to have.
  const old = execRow(p, 'mac-mini-01', 'old');
  expect(old).toHaveTextContent('装了 · 0.2.1-rc.5');
  expect(old).toHaveTextContent('这一版用不了：不认 --permission-mode，升到 0.2.2-rc.1 以上');
  expect(old).not.toHaveTextContent(/已登录|没登录|可用/);
  // A machine that has not said says so, never that nothing is installed there.
  const quiet = p.target('机器 quiet')!;
  expect(quiet).toHaveTextContent('还没读到机器上有哪些执行器');
  expect(quiet).not.toHaveTextContent('没装');
  p.unmount();

  // And a machine that reported and has nothing on it is not the same as one that never said.
  const empty = await machinesApp(undefined, () => ACCOUNTS_PAGE, () => [nodeMachine('bare', { executors: { at: new Date().toISOString(), executors: [] } })]);
  expect(empty.target('机器 bare')).toHaveTextContent('机器上一个执行器也没有');
  expect(empty.target('机器 bare')).not.toHaveTextContent('还没读到机器上有哪些执行器');
});

// The table joins the two facts: what the machine reported of an executor, and the login
// tycho keeps for it there. Neither invents the other, and a row the owner set up stays
// visible after the machine stops reporting that executor.
test('a machine\'s reported executors and its own logins are one table, and neither invents the other', async () => {
  const reported = { at: '2026-11-06T10:30:00.000Z', executors: [
    { executor: 'claude', installed: true, version: '2.1.0', logged_in: true },
    { executor: 'codex', installed: true, version: '0.9', logged_in: false },
  ] };
  const p = await machinesApp(undefined, () => ACCOUNTS_PAGE, () => [{
    ...nodeMachine('mac-mini-01', { connected: true, executors: reported }),
    logins: [own('mac-mini-01', 'claude'), own('mac-mini-01', 'dsh', { signed_in: null })],
  }]);
  // claude: reported and set up here — one row, with both facts on it.
  const claude = ownRow(p, 'mac-mini-01', 'claude');
  expect(claude).toHaveTextContent('装了 · 2.1.0');
  expect(claude).toHaveTextContent('已登录');
  // codex: reported, signed out, nobody set it up — a row with nothing to edit.
  const codex = execRow(p, 'mac-mini-01', 'codex');
  expect(codex).toHaveTextContent('没登录');
  expect(within(codex).queryByRole('button', { name: /修改|填档位|删除/ })).toBeNull();
  // dsh: set up here and no longer reported — a row all the same, with what tycho holds.
  const dsh = ownRow(p, 'mac-mini-01', 'dsh');
  expect(dsh).toHaveTextContent('没有报告');
  expect(within(dsh).getByRole('button', { name: '修改' })).toBeInTheDocument();
});

// The machine's own "测试连接" (nodes.md §1.2): the service asks that machine's client to
// look at its machine again, and the fresh report it then holds is what the table shows.
test('a check on a machine that came back by itself asks once and shows the report it brought back', async () => {
  holdClock();
  const answer = deferred();
  const report = (minutes: number, installed: boolean) => ({
    at: new Date(Date.now() - minutes * 60_000).toISOString(),
    executors: [{ executor: 'claude', installed, version: installed ? '2.1.0' : null, logged_in: installed ? true : null }],
  });
  let fresh = false;
  const p = await machinesApp(
    () => { fresh = true; return answer.promise; },
    () => ACCOUNTS_PAGE,
    () => [nodeMachine('mac-mini-01', { connected: true, executors: fresh ? report(0, true) : report(30, false) })],
  );
  const card = p.target('机器 mac-mini-01')!;
  expect(card).toHaveTextContent('机器上的执行器（30 分钟前读到）');
  expect(execRow(p, 'mac-mini-01', 'claude')).toHaveTextContent('没装');
  const ask = within(card).getByRole('button', { name: '测试连接' });
  fireEvent.click(ask);
  expect(within(card).getByRole('button', { name: '测试中' })).toBeDisabled();
  fireEvent.click(ask);
  await pass();
  expect(p.calls).toEqual([{ path: '/api/machines/mac-mini-01/check', method: 'POST', body: {} }]);
  answer.resolve({ machine_id: 'mac-mini-01', host: 'mac-mini-01.local', reachable: true });
  // The page reads again: what stands now is what the check just read.
  await waitFor(() => expect(card).toHaveTextContent('机器上的执行器（刚刚读到）'));
  await waitFor(() => expect(execRow(p, 'mac-mini-01', 'claude')).toHaveTextContent('装了 · 2.1.0'));
  expect(execRow(p, 'mac-mini-01', 'claude')).toHaveTextContent('已登录');
  expect(card).toHaveTextContent('连得上');
  expect(within(card).getByRole('button', { name: '测试连接' })).toBeEnabled();
});

test('a check the service refuses says why and leaves the report the machine last sent', async () => {
  holdClock();
  const p = await machinesApp(() => { throw refusal('机器没有回答', 503); }, () => ACCOUNTS_PAGE, () => [
    nodeMachine('mac-mini-01', {
      connected: true,
      executors: {
        at: new Date(Date.now() - 10 * 60_000).toISOString(),
        executors: [{ executor: 'claude', installed: true, version: '2.1.0', logged_in: true }],
      },
    }),
  ]);
  const card = p.target('机器 mac-mini-01')!;
  const reads = p.reads.filter((path) => path === '/api/machines').length;
  await p.user.click(within(card).getByRole('button', { name: '测试连接' }));
  // The service's own words, as the page shows a problem.
  expect(await within(card).findByText('机器没有回答')).toHaveClass('text-destructive');
  await pass();
  expect(card).toHaveTextContent('机器上的执行器（10 分钟前读到）');
  expect(execRow(p, 'mac-mini-01', 'claude')).toHaveTextContent('已登录');
  expect(within(card).getByRole('button', { name: '测试连接' })).toBeEnabled();
  expect(p.reads.filter((path) => path === '/api/machines').length, '被拒之后不该再读一次').toBe(reads);
});

// --- a machine's own login, set up on the machine it belongs to ---------------------------

test("a machine's own login is edited on its machine: only its tiers and limits, written the way its executor reads them", async () => {
  const machines = () => MACHINES.map((each) => (each.id === 'b1' ? { ...each, logins: [own('b1', 'codex'), own('b1', 'dsh', { configured: false })] } : each));
  const p = await machinesApp((call) => ({ machine: machines()[3] }), undefined, machines);
  expect(ownRow(p, 'b1', 'codex')).toHaveTextContent('已登录');
  expect(ownRow(p, 'b1', 'dsh'), '机器报了登录、还没填档位的，标出来等填').toHaveTextContent('还没填档位');
  await p.click(CODEX, '修改');
  // The machine's: no name, executor, directory or token to fill in.
  for (const label of ['名字', '执行器', 'API 密钥']) expect(p.control(CODEX, label), label).toBeNull();
  expect(p.control(CODEX, '权限模式'), 'codex 的命令没有权限模式').toBeNull();
  // The tier rows are the same rows, written the way codex reads them.
  expect(p.providerOf(CODEX, 2), 'provider 只有 dsh 有').toBeNull();
  p.type(CODEX, '档位', 'decide=<模型名>');
  await p.submit(CODEX);
  await waitFor(() => expect(p.calls).toHaveLength(1));
  expect(p.calls).toEqual([{ path: `/api/logins/${own('b1', 'codex').id}`, method: 'PUT', body: {
    tiers: { decide: { kind: 'content', text: 'model=<模型名>\n' } }, permission_mode: null, timeout_ms: null, max_runs: null,
  } }]);
});

test("another executor's own login offers its own permission modes and tier boxes, and a mode it does not take is not sent", async () => {
  const machines = () => MACHINES.map((each) => (each.id === 'b1' ? { ...each, logins: [own('b1', 'dsh', { configured: false, tiers: {} })] } : each));
  const p = await machinesApp(() => ({ machine: machines()[3] }), undefined, machines);
  const dsh = 'b1 上的 dsh 登录';
  await p.click(dsh, '填档位');
  expect([...(p.control(dsh, '权限模式') as HTMLSelectElement).options].map((option) => option.value))
    .toEqual(['', 'read-only', 'workspace-write', 'danger-full-access']);
  // dsh's tier names a provider as well; the strength is offered from its own declaration.
  expect([...p.effortOf(dsh, 0).options].map((option) => option.value)).toEqual(['', 'low', 'medium', 'high', 'max']);
  p.type(dsh, '档位', 'execute=<模型名>@max');
  fireEvent.change(p.providerOf(dsh, 1)!, { target: { value: 'deepseek-official' } });
  p.type(dsh, '权限模式', 'workspace-write');
  await p.submit(dsh);
  await waitFor(() => expect(p.calls).toHaveLength(1));
  expect(p.calls).toEqual([{ path: '/api/machines/uid-b1/logins/dsh', method: 'PUT', body: {
    tiers: { execute: { kind: 'content', text: '- id: agent-default-model\n  config:\n    provider: deepseek-official\n    model: <模型名>\n    reasoningEffort: max\n' } },
    permission_mode: 'workspace-write', timeout_ms: null, max_runs: null,
  } }]);
});

// What a model box offers, as the owner reads it.
const optionTexts = (box: HTMLElement): string[] => [...(box as HTMLSelectElement).options].map((option) => option.textContent ?? '');

test('the model is chosen from what the login\'s executor reported, and the strength follows the model', async () => {
  const p = await machinesApp(ownSaved(TIERED), () => accountsPage(), onB1(TIERED));
  await p.click(CODEX, '修改');
  // The models on offer are this login's own, with the one the executor hides left out.
  expect(p.modelOf(CODEX, 2).tagName).toBe('SELECT');
  // Around them: leaving the tier blank, and the way out of the list.
  expect(optionTexts(p.modelOf(CODEX, 2))).toEqual([modelText.none, '<模型甲>', '<模型乙>', modelText.typeByHand]);
  // The strengths are the model's own, and the empty choice names the one the executor
  // would use when the tier names none.
  expect([...p.effortOf(CODEX, 2).options].map((option) => option.value)).toEqual(['', 'low', 'high']);
  fireEvent.change(p.modelOf(CODEX, 2), { target: { value: '<模型乙>' } });
  expect([...p.effortOf(CODEX, 2).options].map((option) => option.value)).toEqual(['', 'low', 'medium', 'high', 'xhigh', 'max']);
  await p.submit(CODEX);
  await waitFor(() => expect(p.calls).toHaveLength(1));
  expect((p.calls[0]!.body as { tiers: unknown }).tiers).toEqual({
    decide: { kind: 'content', text: 'model=<模型乙>\n' },
    execute: { kind: 'content', text: 'model=<别名>\n' },
  });
});

test('a model outside the login\'s list is kept, marked, and can be moved to one from the list', async () => {
  const p = await machinesApp(ownSaved(TIERED), () => accountsPage(), onB1(TIERED));
  await p.click(CODEX, '修改');
  const row = p.row(CODEX, 1);
  expect(within(row).getByLabelText(modelText.handWritten)).toHaveValue('<别名>');
  fireEvent.change(within(row).getByLabelText(modelText.pick), { target: { value: '<模型乙>' } });
  expect(p.tiersOf(CODEX)[1]).toBe('execute=<模型乙>@');
  await p.submit(CODEX);
  await waitFor(() => expect(p.calls).toHaveLength(1));
  expect((p.calls[0]!.body as { tiers: unknown }).tiers).toEqual({
    decide: { kind: 'content', text: 'model=<模型甲>\n' },
    execute: { kind: 'content', text: 'model=<模型乙>\n' },
  });
});

test('with nothing read yet a model is typed by hand, and the row is not marked', async () => {
  const plain = own('b1', 'codex', { tiers: { decide: { kind: 'content', text: 'model=<别名>\n' } } });
  const p = await machinesApp(undefined, () => accountsPage(), onB1(plain));
  await p.click(CODEX, '修改');
  expect(p.modelOf(CODEX, 2).tagName).toBe('INPUT');
  expect(p.modelOf(CODEX, 2)).toHaveValue('<别名>');
});

// The models of a machine's own login are what its machine reported of the executor
// (nodes.md §1.2), there before the login is set up: filling in its tiers for the first
// time is when the list is needed.
test("a machine's own login not yet set up picks its models from what the machine reported", async () => {
  const fresh = own('b1', 'codex', { configured: false, tiers: {}, models: { ...MODELS, reason: null } });
  const p = await machinesApp(ownSaved(TIERED), () => accountsPage(), onB1(fresh));
  const block = ownRow(p, 'b1', 'codex');
  expect(block).not.toHaveTextContent(modelText.hidden(1));
  await p.click(CODEX, '填档位');
  // A row that names no model yet: the reported models are choices to pick, not a bare box.
  const pick = p.modelOf(CODEX, 2) as HTMLSelectElement;
  expect(pick.tagName).toBe('SELECT');
  expect(optionTexts(pick)).toEqual([modelText.pick, '<模型甲>', '<模型乙>', modelText.typeByHand]);
  expect(within(p.row(CODEX, 2)).queryByLabelText(modelText.handWritten), '读到了列表，先给的是下拉，不是手填的框').toBeNull();
  await p.user.selectOptions(pick, '<模型甲>');
  expect(p.modelOf(CODEX, 2).tagName).toBe('SELECT');
  expect(optionTexts(p.modelOf(CODEX, 2))).toEqual([modelText.none, '<模型甲>', '<模型乙>', modelText.typeByHand]);
  expect([...p.effortOf(CODEX, 2).options].map((option) => option.value), '强度跟着选中的模型').toEqual(['', 'low', 'high']);
  expect(p.form(CODEX), '读到了列表就没有“没读到”那一行').not.toHaveTextContent('可选模型没读到');
  await p.submit(CODEX);
  await waitFor(() => expect(p.calls).toHaveLength(1));
  expect(p.calls).toEqual([{ path: '/api/machines/uid-b1/logins/codex', method: 'PUT', body: {
    tiers: { decide: { kind: 'content', text: 'model=<模型甲>\n' } }, permission_mode: null, timeout_ms: null, max_runs: null,
  } }]);
});

test('with a list read, typing a model by hand is a choice of the list itself, and picking from the list ends it', async () => {
  const fresh = own('b1', 'codex', { configured: false, tiers: {}, models: { ...MODELS, reason: null } });
  const p = await machinesApp(ownSaved(TIERED), () => accountsPage(), onB1(fresh));
  await p.click(CODEX, '填档位');
  const row = p.row(CODEX, 2);
  await p.user.selectOptions(p.modelOf(CODEX, 2), modelText.typeByHand);
  // The box to type in, holding the focus the list had, and the list still beside it.
  const box = within(row).getByLabelText<HTMLInputElement>(modelText.handWritten);
  expect(box.tagName).toBe('INPUT');
  expect(box).toHaveFocus();
  fireEvent.change(box, { target: { value: '<别名>' } });
  // Emptied on the way to another name, it is still the box: the owner is typing.
  fireEvent.change(box, { target: { value: '' } });
  expect(within(row).getByLabelText(modelText.handWritten)).toBe(box);
  fireEvent.change(box, { target: { value: '<别名>' } });
  expect(within(row).getByLabelText(modelText.handWritten)).toHaveValue('<别名>');
  expect(row).toHaveTextContent(modelText.missing);
  fireEvent.change(within(row).getByLabelText(modelText.pick), { target: { value: '<模型乙>' } });
  expect(p.modelOf(CODEX, 2).tagName).toBe('SELECT');
  expect(p.modelOf(CODEX, 2)).toHaveValue('<模型乙>');
  // And a tier that names a model can be left blank again from the same list.
  fireEvent.change(p.modelOf(CODEX, 2), { target: { value: '' } });
  expect(p.modelOf(CODEX, 2).tagName).toBe('SELECT');
  expect(p.modelOf(CODEX, 2)).toHaveValue('');
  expect(p.calls).toEqual([]);
});

test("when there is no list for a machine's own login, its block and its form say why, and the model is typed by hand", async () => {
  const failed = 'codex debug models 退出码 2';
  const machines = onB1(
    own('b1', 'codex', { configured: false, tiers: {}, models: { list: [], at: '2026-11-05T01:00:00.000Z', refreshing: false, reason: failed } }),
    own('b1', 'dsh', { models: { list: [], at: null, refreshing: false, reason: modelText.machineOffline } }),
  );
  const p = await machinesApp(undefined, () => accountsPage(), machines);
  expect(within(ownRow(p, 'b1', 'codex')).getByText(failed), '机器问过、没读到：写它报的原因').toBeInTheDocument();
  expect(within(ownRow(p, 'b1', 'dsh')).getByText(modelText.machineOffline)).toBeInTheDocument();
  expect(ownRow(p, 'b1', 'codex'), '没有列表时不写“几个、何时读到”').not.toHaveTextContent('最后读到');
  await p.click(CODEX, '填档位');
  expect(within(p.form(CODEX)!).getByText(modelText.listMissing(failed))).toBeInTheDocument();
  expect(modelText.listMissing(failed)).toContain('手填');
  expect(p.modelOf(CODEX, 2).tagName).toBe('INPUT');
  expect(within(p.row(CODEX, 2)).queryByRole('combobox', { name: modelText.label })).toBeNull();
  p.type(CODEX, '档位', 'decide=<手填的>');
  expect(p.tiersOf(CODEX)[2]).toBe('decide=<手填的>@');
});

test("a machine's own login reads as usable only where dispatch would use it: never while signed out, refused, unreported or holding a retired tier", async () => {
  // What the service says of a tier stored as a profile name (service/ledger.ts reads it out).
  const retired = { tier: 'execute', was: 'execute', text: '机器 b1 上的 opencode 登录 的执行档原来写的是机器上的文件或 profile「execute」：到“机器”页这份登录那里重新填' };
  const machines = () => MACHINES.map((each) => (each.id === 'b1' ? { ...each, logins: [
    own('b1', 'codex'),
    own('b1', 'claude', { signed_in: false, usable_here: false }),
    own('b1', 'dsh', { refused: true }),
    own('b1', 'gemini', { signed_in: null, usable_here: false }),
    own('b1', 'opencode', { tiers: {}, retired_tiers: [retired] }),
  ] } : each));
  const p = await machinesApp(undefined, undefined, machines);
  const badge = (executor: string): string => within(ownRow(p, 'b1', executor)).getAllByText(/^(可用|歇着|到上限|机器说没登录|登录失效|等机器报告|还没填档位|档位要重填)$/)[0]!.textContent!;
  expect(badge('opencode'), '档位原来是机器上的 profile：不显示可用').toBe(RETIRED_TIER_STANDING);
  expect(ownRow(p, 'b1', 'opencode')).toHaveTextContent(retired.text);
  expect(badge('codex')).toBe('可用');
  expect(badge('claude'), '机器说没登录时不显示可用').toBe('机器说没登录');
  expect(badge('dsh'), '执行器拒过这份登录').toBe('登录失效');
  expect(badge('gemini'), '自己连回来的机器还没报告这个执行器').toBe('等机器报告');
  expect(ownRow(p, 'b1', 'dsh')).toHaveTextContent('到那台机器上重新登录');
  // A refused login comes back when its machine reports it signed in again: no button here clears it.
  expect(within(ownRow(p, 'b1', 'dsh')).queryByRole('button', { name: '现在就试' })).toBeNull();
});

test("a machine's own login that rests can be let go now, and one that is set up can be deleted", async () => {
  const resting = own('b1', 'codex', { status: { active_runs: 0, max_runs: null, rest: { until: '2099-01-01T00:00:00.000Z', reason: '额度用完' }, usage: [] } });
  const machines = () => MACHINES.map((each) => (each.id === 'b1' ? { ...each, logins: [resting] } : each));
  const p = await machinesApp(() => ({ machine: machines()[3] }), undefined, machines);
  expect(ownRow(p, 'b1', 'codex')).toHaveTextContent(/歇着/);
  await p.click(CODEX, '现在就试');
  await waitFor(() => expect(p.calls).toEqual([{ path: `/api/logins/${own('b1', 'codex').id}/retry`, method: 'POST', body: {} }]));
  await waitFor(() => expect(p.button(CODEX, '删除')).toBeEnabled());
  await p.click(CODEX, '删除');
  // Asked first, by the name of the login; nothing is sent until it is answered.
  expect(p.question()).toHaveAccessibleName('删除 b1 上的 codex 登录？');
  expect(p.calls).toHaveLength(1);
  await p.decide('确认删除');
  await waitFor(() => expect(p.calls).toHaveLength(2));
  expect(p.calls[1]).toEqual({ path: `/api/logins/${own('b1', 'codex').id}`, method: 'DELETE', body: undefined });
  await waitFor(() => expect(p.question()).toBeNull());
});

// Review of the page split: a refused "现在就试" happens with no form open, so its reason
// must not live only in the form; a refused "删除" is said where it was confirmed.
test("a machine's own login whose 现在就试 or 删除 is refused says why, and can be tried again", async () => {
  const resting = own('b1', 'codex', { status: { active_runs: 0, max_runs: null, rest: { until: '2099-01-01T00:00:00.000Z', reason: '额度用完' }, usage: [] } });
  const machines = () => MACHINES.map((each) => (each.id === 'b1' ? { ...each, logins: [resting] } : each));
  const p = await machinesApp((call) => {
    if (call.method === 'POST') throw refusal('服务在降级模式，现在不能放行', 503);
    throw refusal('机器 b1 上的 codex 登录还有排队的任务', 409);
  }, undefined, machines);
  await p.click(CODEX, '现在就试');
  expect(await within(ownRow(p, 'b1', 'codex')).findByRole('alert')).toHaveTextContent('服务在降级模式，现在不能放行');
  await waitFor(() => expect(p.button(CODEX, '删除')).toBeEnabled());
  await p.click(CODEX, '删除');
  await p.decide('确认删除');
  await waitFor(() => expect(within(p.question()!).getByRole('alert')).toHaveTextContent('还有排队的任务'));
  await waitFor(() => expect(within(p.question()!).getByRole('button', { name: '不删了' })).toBeEnabled());
  await p.decide('不删了');
  expect(p.question()).toBeNull();
  expect(within(ownRow(p, 'b1', 'codex')).queryByRole('alert'), '问题收起以后，它的原因不留在页面上').toBeNull();
  await waitFor(() => expect(p.button(CODEX, '现在就试')).toBeEnabled());
  await p.click(CODEX, '现在就试');
  await waitFor(() => expect(p.calls.map(({ method }) => method)).toEqual(['POST', 'DELETE', 'POST']));
});

// --- the machines asking to be let in (nodes.md §1.1) ------------------------------------

test('the waiting machines are listed with what each reported and how long it has left, and offer inline 6-digit admission without leaking the code', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-11-06T10:25:00.000Z'));
  const p = await machinesApp(undefined, () => ACCOUNTS_PAGE, () => MACHINES, () => [JOIN, { ...WINDOWS, expires_at: '2026-11-06T10:25:45.000Z' }]);
  const card = await p.openJoins();
  await within(card).findByText(JOIN.name);
  expect(p.joinEntry(JOIN.name)).toHaveTextContent('darwin 24.5.0 · mac-mini-01.local');
  expect(p.joinEntry(JOIN.name)).toHaveTextContent('还有 10 分钟过期');
  expect(p.joinEntry(WINDOWS.name)).toHaveTextContent('win32 10.0.26100 · build-02');
  expect(p.joinEntry(WINDOWS.name)).toHaveTextContent('还有不到 1 分钟过期');
  // Typing the digits from that machine's own screen is the check: they are never repeated here.
  expect(card).not.toHaveTextContent(JOIN.code);
  const joinRow = p.joinEntry(JOIN.name)!;
  expect(within(joinRow).getByRole('textbox', { name: `放行 ${JOIN.name} 的六位数字` })).toHaveValue('');
  expect(within(joinRow).getByRole('button', { name: '放行' })).toBeDisabled();
  expect(within(joinRow).getByRole('button', { name: '拒绝' })).toBeDisabled();
  expect(card).toHaveTextContent('点侧栏的“放行”');
  // A list is not a fault: nothing is raised while there is something to decide.
  expect(screen.queryByRole('alert')).toBeNull();
});

test('a waiting machine can be admitted inline inside 接入一台机器 after verifying its 6-digit code', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-11-06T10:25:00.000Z'));
  const joined = nodeMachine(JOIN.name, { connected: true, reported_runs: 1 });
  let machines: unknown[] = MACHINES;
  let waiting: unknown[] = [JOIN, WINDOWS];
  const p = await machinesApp(
    (call) => {
      if (call.path === '/api/admissions/approve') {
        machines = [...MACHINES, joined];
        waiting = [WINDOWS];
        return { kind: 'machine', name: JOIN.name, machine: joined };
      }
      return {};
    },
    () => ACCOUNTS_PAGE,
    () => machines,
    () => waiting,
  );
  const card = await p.openJoins();
  await within(card).findByText(JOIN.name);
  const joinRow = p.joinEntry(JOIN.name)!;
  const codeBox = within(joinRow).getByRole('textbox', { name: `放行 ${JOIN.name} 的六位数字` });

  // Wrong 6-digit code for this machine is caught inline and sends nothing.
  fireEvent.change(codeBox, { target: { value: '000000' } });
  await p.user.click(within(joinRow).getByRole('button', { name: '放行' }));
  expect(await within(joinRow).findByRole('alert')).toHaveTextContent('不匹配');
  expect(p.calls).toEqual([]);

  // Matching 6-digit code admits via /api/admissions/approve and updates both lists.
  fireEvent.change(codeBox, { target: { value: JOIN.code } });
  await p.user.click(within(joinRow).getByRole('button', { name: '放行' }));
  expect(await within(card).findByRole('status')).toHaveTextContent('已放行 mac-mini-01');
  expect(p.calls).toEqual([{ path: '/api/admissions/approve', method: 'POST', body: { kind: 'machine', code: JOIN.code } }]);
  await waitFor(() => expect(within(card).queryByText(JOIN.name)).toBeNull());
  expect(within(card).getByText(WINDOWS.name)).toBeInTheDocument();
  await p.closeJoins();
  await waitFor(() => expect(p.target(`机器 ${JOIN.name}`)).toBeInTheDocument());
});

test('an expired request is said to be expired rather than still waiting', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-11-06T10:40:00.000Z'));
  const p = await machinesApp(undefined, () => ACCOUNTS_PAGE, () => MACHINES, () => [JOIN]);
  const card = await p.openJoins();
  expect(await within(card).findByText(JOIN.name)).toBeInTheDocument();
  expect(card).toHaveTextContent('已经过期');
});

test('a machine let in from the sidebar leaves the waiting list and shows up on the page without waiting for the next poll', async () => {
  holdClock();
  const joined = nodeMachine(JOIN.name, { connected: true, reported_runs: 1 });
  let machines: unknown[] = MACHINES;
  let waiting: unknown[] = [JOIN, WINDOWS];
  const p = await machinesApp(
    (call) => {
      if (call.path === '/api/admissions/lookup') return { matches: [{ kind: 'machine', ...JOIN }] };
      if (call.path === '/api/admissions/approve') {
        machines = [...MACHINES, joined];
        waiting = [WINDOWS];
        return { kind: 'machine', name: JOIN.name, machine: joined };
      }
      return {};
    },
    () => ACCOUNTS_PAGE,
    () => machines,
    () => waiting,
  );
  const card = await p.openJoins();
  await within(card).findByText(JOIN.name);
  // The side column is behind the window: it is closed first, as its steps say.
  await p.closeJoins();
  await p.user.click(screen.getByRole('button', { name: '放行' }));
  const sheet = screen.getByRole('dialog', { name: '放行' });
  fireEvent.change(within(sheet).getByRole('textbox', { name: '六位数字' }), { target: { value: JOIN.code } });
  await p.user.click(within(sheet).getByRole('button', { name: '查找' }));
  await p.user.click(within(await within(sheet).findByRole('region', { name: '等待放行的机器' })).getByRole('button', { name: '放行' }));
  expect(await within(sheet).findByRole('status')).toHaveTextContent('已放行 mac-mini-01');
  expect(p.calls.at(-1)).toEqual({ path: '/api/admissions/approve', method: 'POST', body: { kind: 'machine', code: JOIN.code } });
  await p.user.click(within(sheet).getByRole('button', { name: '关闭' }));
  // The machine is on the page, and the list — opened again — no longer holds its request.
  await waitFor(() => expect(p.target(`机器 ${JOIN.name}`)).toBeInTheDocument());
  const again = await p.openJoins();
  await waitFor(() => expect(within(again).queryByText(JOIN.name)).toBeNull());
  expect(await within(again).findByText(WINDOWS.name)).toBeInTheDocument();
});

test('with nothing waiting the list says how to bring a machine in', async () => {
  const p = await machinesApp();
  expect(p.joinsCard(), '没人点开之前不读这条列表').toBeNull();
  const card = await p.openJoins();
  expect(await within(card).findByText(/现在没有等着放行的机器/)).toBeInTheDocument();
  // The steps the list stands under hold the command and what to do with its six digits.
  const steps = screen.getByRole('dialog', { name: '接入一台机器' });
  expect(steps).toHaveTextContent(`tycho node join --to ${window.location.origin}`);
  expect(steps).toHaveTextContent('点侧栏的“放行”，输入那个六位数');
  // An empty list is the ordinary state: no failure.
  expect(within(card).queryByRole('alert')).toBeNull();
});

test('the waiting list reads again by itself while it is open, because that machine is waiting for the answer', async () => {
  holdClock();
  let waiting = [JOIN];
  const p = await machinesApp(undefined, () => ACCOUNTS_PAGE, () => MACHINES, () => waiting);
  const card = await p.openJoins();
  expect(await within(card).findByText(JOIN.name)).toBeInTheDocument();
  waiting = [WINDOWS];
  await pass(POLL_MS);
  // Read again and drawn from that read: the request that is gone is gone.
  await waitFor(() => expect(within(card).getByText(WINDOWS.name)).toBeInTheDocument());
  expect(within(card).queryByText(JOIN.name)).toBeNull();
});

test('closing the list stops its reading and opening it again reads afresh', async () => {
  holdClock();
  let waiting = [JOIN];
  const p = await machinesApp(undefined, () => ACCOUNTS_PAGE, () => MACHINES, () => waiting);
  const card = await p.openJoins();
  await within(card).findByText(JOIN.name);
  const reads = p.reads.filter((path) => path === '/api/node/joins').length;
  await p.closeJoins();
  expect(p.joinsCard()).toBeNull();
  await pass(POLL_MS);
  expect(p.reads.filter((path) => path === '/api/node/joins').length, '关掉以后还在读').toBe(reads);
  waiting = [WINDOWS];
  const again = await p.openJoins();
  expect(await within(again).findByText(WINDOWS.name)).toBeInTheDocument();
  expect(within(again).queryByText(JOIN.name)).toBeNull();
});

// --- the machines a task spawned, and the quotas they came in under (nodes.md §1.3) -------

const endLines = (region: HTMLElement) => within(within(region).getByRole('list', { name: '结束情况' })).getAllByRole('listitem');

test('a spawned machine shows where it came from, what its quota allows, and each ending on its own line', async () => {
  const p = await machinesApp(undefined, () => ACCOUNTS_PAGE, () => [spawned('builder'), nodeMachine('mac-mini-01')]);
  const builder = p.target('机器 builder')!;
  expect(builder).toHaveTextContent('来源由任务 t-9 第 3 轮派生');
  expect(builder).toHaveTextContent('临时');
  expect(builder).toHaveTextContent('只接项目 p1 的活，只用 claude');
  const lines = endLines(builder);
  expect(lines.map((line) => line.textContent)).toEqual([
    expect.stringMatching(/^接入材料已失效（名额用完，.+）$/),
    expect.stringMatching(/^接新活.+起不再接$/),
    '结果和日志还没确认全部交回',
    expect.stringMatching(/^登记.+结束（机器自己注销）$/),
    // The registration ended; nobody reported the instance gone, so it is not said to be.
    '实例实例销毁未确认',
  ]);
  expect(lines.map((line) => line.dataset.done)).toEqual(['true', 'true', 'false', 'true', 'false']);
  expect(builder).not.toHaveTextContent(/已释放|已销毁/);
  // A machine let in by hand has none of this, and with no quota there is no quota section.
  const manual = p.target('机器 mac-mini-01')!;
  expect(manual).toHaveTextContent('来源手动加入');
  expect(within(manual).queryByRole('list', { name: '结束情况' })).toBeNull();
  expect(manual).not.toHaveTextContent('临时');
  expect(p.target('接入名额')).toBeNull();
});

test('a spawned machine with a round judged gone says its output did not come back, not that it is still waiting', async () => {
  const p = await machinesApp(undefined, () => ACCOUNTS_PAGE, () => [spawned('builder', { lost_rounds: 1 })]);
  expect(endLines(p.target('机器 builder')!)[2]).toHaveTextContent('结果和日志有一轮按失联结束，结果没交回');
});

test('a quota no round was handed a material from yet says so, without a tick', async () => {
  const fresh = { ...INVITE, used: 0, last_handed_at: null, last_run_id: null, material: { live: 0, live_until: null, ended_at: null, ended_why: null }, machines: [] };
  const p = await machinesApp(undefined, () => ACCOUNTS_PAGE, () => [], () => [], () => [fresh]);
  const [item] = within(p.target('接入名额')!).getAllByRole('listitem');
  expect(item).toHaveTextContent('接入材料还没有发过材料');
  expect(item).not.toHaveTextContent('已失效');
});

test('an instance is said to be destroyed only when a report says so, and by whom', async () => {
  const p = await machinesApp(undefined, () => ACCOUNTS_PAGE, () => [spawned('builder', { destroyed_at: '2026-11-06T10:35:00.000Z', destroyed_by: 'r-42' })]);
  expect(endLines(p.target('机器 builder')!).at(-1)).toHaveTextContent(/^实例.+由执行 r-42 报告已销毁$/);
});

test('revoking a spawned machine still registered sends the delete and leaves it on the list with how it ended', async () => {
  let listed = [spawned('builder', { left_at: null, left_reason: null })];
  const p = await machinesApp((call) => {
    listed = [spawned('builder', { left_at: '2026-11-06T10:41:00.000Z', left_reason: 'revoked' })];
    return call.method === 'DELETE' ? { deleted: true } : {};
  }, () => ACCOUNTS_PAGE, () => listed);
  const builder = p.target('机器 builder')!;
  expect(endLines(builder)[3]).toHaveTextContent('还在登记里');
  // What takes it out is a revoke, not a delete.
  expect(await actionsOf(p, 'builder')).toEqual(['加备注', '撤销这台机器']);
  await p.pick('机器 builder', '撤销这台机器');
  expect(p.question()).toHaveAccessibleName('撤销机器 builder？');
  await p.decide('确认撤销 builder');
  await waitFor(() => expect(p.question()).toBeNull());
  await waitFor(() => expect(endLines(p.target('机器 builder')!)[3]).toHaveTextContent('被撤销'));
  expect(p.calls.map(({ method, path }) => [method, path])).toEqual([['DELETE', '/api/machines/builder']]);
  expect(endLines(p.target('机器 builder')!)[4]).toHaveTextContent('实例销毁未确认');
  // Its registration has ended: what is left to remove is its record.
  expect(await actionsOf(p, 'builder')).toEqual(['加备注', '删除记录']);
});

test('a spawned machine whose registration ended has its record deleted, after the same confirmation', async () => {
  let listed = [spawned('builder')];
  const p = await machinesApp((call) => {
    if (!call.path.endsWith('?confirm=1')) throw refusal('机器 builder 还有没交回的结果，确认后就不再等它', 409, { needs_confirm: true });
    listed = [];
    return { deleted: true };
  }, () => ACCOUNTS_PAGE, () => listed);
  await p.pick('机器 builder', '删除记录');
  expect(p.question()).toHaveAccessibleName('删除机器 builder 的记录？');
  await p.decide('确认删除 builder');
  expect(await within(p.question()!).findByRole('alert')).toHaveTextContent('还有没交回的结果');
  await p.decide('确认删除 builder');
  await waitFor(() => expect(p.target('机器 builder')).toBeNull());
  expect(p.calls.map(({ method, path }) => [method, path])).toEqual([['DELETE', '/api/machines/builder'], ['DELETE', '/api/machines/builder?confirm=1']]);
});

test('the quotas tasks asked for are listed with what they allow, and one still open is revoked by its own id', async () => {
  let invites: object[] = [INVITE, REVOKED];
  const p = await machinesApp((call) => {
    if (call.method !== 'DELETE') return {};
    invites = [{ ...INVITE, revoked_at: '2026-11-06T10:41:00.000Z', material: { live: 0, live_until: null, ended_at: '2026-11-06T10:41:00.000Z', ended_why: 'revoked' } }, REVOKED];
    return { revoked: true };
  }, () => ACCOUNTS_PAGE, () => [spawned('builder')], () => [], () => invites);
  const section = p.target('接入名额')!;
  const [open, over] = within(section).getAllByRole('listitem');
  expect(open).toHaveTextContent('任务 t-9');
  expect(open).toHaveTextContent('项目 p1');
  expect(open).toHaveTextContent('执行器claude');
  expect(open).toHaveTextContent('已登记 1/2');
  expect(open).toHaveTextContent(/有效到 .+/);
  expect(open).toHaveTextContent(/接入材料还有 1 份有效，到 .+/);
  expect(open).toHaveTextContent('带进来的机器builder');
  // Revoked already: nothing is left for a revoke to stop.
  expect(over).toHaveTextContent('任务 t-8');
  expect(over).toHaveTextContent('执行器不限');
  expect(over).toHaveTextContent('已撤销');
  expect(over).toHaveTextContent('已失效（名额被撤销');
  expect(within(over!).queryByRole('button', { name: '撤销名额' })).toBeNull();

  await p.user.click(within(open!).getByRole('button', { name: '撤销名额' }));
  await waitFor(() => expect(within(within(p.target('接入名额')!).getAllByRole('listitem')[0]!).queryByRole('button', { name: '撤销名额' })).toBeNull());
  expect(p.calls).toEqual([{ method: 'DELETE', path: '/api/invites/inv-1', body: undefined }]);
  // The machine it brought in is not touched by it.
  expect(p.target('机器 builder')).not.toBeNull();
});

test('a revoke the service refuses says why on that quota and leaves the button to try again', async () => {
  const p = await machinesApp((call) => {
    if (call.method === 'DELETE') throw refusal('服务在降级模式，现在不能撤销接入名额', 503);
    return {};
  }, () => ACCOUNTS_PAGE, () => [], () => [], () => [INVITE]);
  const entry = within(p.target('接入名额')!).getAllByRole('listitem')[0]!;
  await p.user.click(within(entry).getByRole('button', { name: '撤销名额' }));
  expect(await within(entry).findByRole('alert')).toHaveTextContent('现在不能撤销接入名额');
  expect(within(entry).getByRole('button', { name: '撤销名额' })).toBeEnabled();
});

test('the machines page reads again by itself for what no event tells it', async () => {
  holdClock();
  const p = await machinesApp(undefined, () => ACCOUNTS_PAGE, () => MACHINES);
  const before = p.reads.filter((path) => path === '/api/machines').length;
  await pass(POLL_MS);
  await waitFor(() => expect(p.reads.filter((path) => path === '/api/machines').length).toBeGreaterThan(before));
});

test('the machines page is where an account is not set up: no add form, no token, no tiers of one', async () => {
  const p = await machinesApp(undefined, () => ACCOUNTS_PAGE, () => MACHINES);
  expect(screen.queryByRole('button', { name: ADD })).toBeNull();
  expect(screen.queryByRole('region', { name: 'gpu' })).toBeNull();
  expect(screen.queryByLabelText('API 密钥')).toBeNull();
  // But it still leads to where they are: the side column's two entries.
  const views = within(screen.getByRole('navigation', { name: '配置' }));
  expect(views.getByRole('link', { name: '账号' })).toHaveAttribute('href', '#/accounts');
  expect(views.getByRole('link', { name: '机器' })).toHaveAttribute('aria-current', 'page');
  expect(p.target('机器 a1')).toBeInTheDocument();
});

test('going to the accounts page from here leaves it: one address, one page', async () => {
  holdClock();
  const p = await machinesApp(undefined, () => ACCOUNTS_PAGE, () => MACHINES);
  await go('#/accounts');
  await waitFor(() => expect(screen.getByRole('heading', { level: 1, name: '账号' })).toBeInTheDocument());
  expect(screen.queryByRole('heading', { level: 1, name: '机器' })).toBeNull();
  await go('#/machines');
  await waitFor(() => expect(screen.getByRole('heading', { level: 1, name: '机器' })).toBeInTheDocument());
  expect(p.target('机器 a1')).toHaveTextContent('主机名 a1');
});

// nodes.md §1.4: each card says which version its client runs, and what it is doing about
// being behind the host — the same words list_machines gives the Router.
test('each machine says the version its client runs and what it is doing about the host version', async () => {
  const at = '2026-11-06T10:20:00.000Z';
  const machines = [
    nodeMachine('a1', { release: { version: '0.1.500', at, upgrade: null } }),
    nodeMachine('a2', { release: { version: '0.1.400', at, upgrade: { state: 'waiting', target: '0.1.500', detail: '等 2 轮跑完后换到 0.1.500' } } }),
    nodeMachine('a3', { release: null }),
  ];
  const p = await machinesApp(undefined, () => ({ ...ACCOUNTS_PAGE, host_version: '0.1.500' }), () => machines);
  expect(p.target('机器 a1')).toHaveTextContent('tycho 0.1.500');
  expect(p.target('机器 a2')).toHaveTextContent('tycho 0.1.400，主机 0.1.500，等 2 轮跑完后换到 0.1.500');
  expect(p.target('机器 a3')).toHaveTextContent('没报版本（客户端太旧，重启一次它就会跟上）');
});

test('bounded output capacity is local accounting and an issue waits without pretending the machine is offline',async()=>{
 const machine=nodeMachine('capacity-node',{connected:true,bounded_output:1,output:{capacity:{limit_bytes:1073741824,used_bytes:1048576,reserved_bytes:33554432,external_bytes:2097152,free_bytes:0,available_runs:0,issue:'有未核实的旧输出'}}});
 await machinesApp(undefined, () => ACCOUNTS_PAGE, () => [machine]);
 expect(await screen.findByText(/输出容量待核实，新轮次等待/)).toHaveTextContent('有未核实的旧输出');expect(screen.queryByText(/1 MiB 已占用/)).toBeNull();
});

test('confirmed output capacity keeps its numbers and labels reservations from other registrations',async()=>{
 const machine=nodeMachine('capacity-node',{connected:true,bounded_output:1,output:{capacity:{limit_bytes:1073741824,used_bytes:1048576,reserved_bytes:33554432,external_bytes:2097152,free_bytes:800000000,available_runs:6,other_node_reserved_bytes:16777216}}});
 await machinesApp(undefined, () => ACCOUNTS_PAGE, () => [machine]);
 const text=await screen.findByText(/待传输出：1 MiB 已占用，32 MiB 预留/);expect(text).toHaveTextContent('其他登记仍预留 16 MiB');expect(text).toHaveTextContent('可接 6 轮');
});


test('system service observations distinguish stopped, unknown, offline history and not reported', async () => {
  const observed_at = '2026-11-16T00:00:00.000Z';
  const p = await machinesApp(undefined, undefined, () => [
    nodeMachine('stopped', { service_manager: { observed_at, services: [
      { role: 'node', manager: 'systemd', entry: 'tycho-node', installed: true, enabled: true, running: false, main_pid: null },
    ] } }),
    nodeMachine('unknown', { connected: true, service_manager: { observed_at, services: [
      { role: 'host', manager: 'systemd', entry: 'tycho', installed: true, enabled: null, running: null, main_pid: null,
        problem: { kind: 'permission_error', message: '当前用户无权读取系统服务状态' } },
    ] } }),
    nodeMachine('old'),
  ]);
  const stopped = within(p.target('机器 stopped')!).getByLabelText('stopped 的系统服务');
  expect(stopped.textContent).toContain('已安装，未运行，已启用自启');
  expect(stopped.textContent).toContain('机器已离线，以上为最后报告');
  const unknown = within(p.target('机器 unknown')!).getByLabelText('unknown 的系统服务');
  expect(unknown.textContent).toContain('已安装，运行状态未知');
  expect(unknown.textContent).toContain('当前用户无权读取系统服务状态');
  expect(unknown.textContent).not.toContain('未安装');
  expect(within(p.target('机器 old')!).getByLabelText('old 的系统服务').textContent).toContain('机器尚未报告系统服务状态');
});

test('master-detail fleet rail filters by status and search, switches machines by click or arrow keys, and opens detail sheet on narrow screens', async () => {
  const kr = nodeMachine('kr', {
    connected: true,
    executors: { at: '2026-11-21T07:00:00Z', executors: [{ executor: 'codex', installed: true, version: '0.171.0', logged_in: true }, { executor: 'claude', installed: false, version: null, logged_in: null }] },
    local_skills: [{ slug: 'internal-ops', name: '内部运维', description: '仅内网可用' }],
  });
  const offlineBox = nodeMachine('offline-box', { connected: false, last_seen_at: '2026-11-21T06:00:00Z' });
  const p = await machinesApp(undefined, () => ACCOUNTS_PAGE, () => [kr, offlineBox]);

  // Desktop Master-Detail shows first machine detail immediately and links local skills to knowledge page
  expect(screen.getByRole('region', { name: '机器 kr' })).toBeInTheDocument();
  expect(screen.queryByRole('region', { name: '机器 offline-box' })).toBeNull();
  expect(execRow(p, 'kr', 'codex')).toBeInTheDocument();
  expect(within(p.target('机器 kr')!).getByRole('link', { name: '本机私有技能（1）· 在知识页查看' })).toHaveAttribute('href', '#/knowledge?view=access#machine-knowledge');

  // ArrowDown on window does not hijack scrolling when focus is outside the left rail
  fireEvent.keyDown(window, { key: 'ArrowDown' });
  expect(screen.getByRole('region', { name: '机器 kr' })).toBeInTheDocument();

  // Focusing a machine row in the left rail and pressing ArrowDown switches to the next machine
  const krButton = screen.getByRole('button', { name: '选择机器 kr' });
  krButton.focus();
  await p.user.keyboard('{ArrowDown}');
  expect(await screen.findByRole('region', { name: '机器 offline-box' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '选择机器 offline-box' })).toHaveFocus();
  expect(screen.queryByRole('region', { name: '机器 kr' })).toBeNull();

  // Filter by status and search in the left fleet rail
  await p.user.click(screen.getByRole('button', { name: '离线 1' }));
  expect(screen.queryByRole('button', { name: '选择机器 kr' })).toBeNull();
  expect(screen.getByRole('button', { name: '选择机器 offline-box' })).toBeInTheDocument();

  await p.user.click(screen.getByRole('button', { name: '全部 2' }));
  fireEvent.change(screen.getByLabelText('筛选机器'), { target: { value: 'kr' } });
  expect(screen.getByRole('button', { name: '选择机器 kr' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '选择机器 offline-box' })).toBeNull();
});
