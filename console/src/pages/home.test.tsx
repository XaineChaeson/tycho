// Guards the overview against: a restore whose items cannot be gone through one by one,
// or where a host that could not be counted reads as having nothing; stopped work or a
// target with no machine missing from what needs the owner, or shown without its reason;
// a task whose machine is out of contact listed as something the owner must do; raw
// event JSON reaching the owner; a backup that has stopped working going unseen, or one
// started twice; dispatch resumed while a restore still waits for its count, with no
// word on why the button is off; a notification that was given up on with no way to try
// it again, or a retry that fails leaving its button dead; a new installation whose
// first screen does not say what is still missing or where to put it right; a
// self-check that cannot be read taking the overview down with it; and a change made
// after the page was read but before the console was listening, which nothing pushed
// to it, staying off the page until the next poll; and a gateway that is down and shows
// nothing, or nothing to do about it, in the service's status line; and a task that
// only waits for a quota to come back or a target to free up shown as the owner's to
// deal with, or with no word on what it waits for; and an at-a-glance summary that
// counts questions as tasks or mistakes a ready child for its parent work; and the
// latest run's account and machine being hidden behind another page; and a message sent
// from WeCom with no project left out of what needs the owner, given to a project other
// than the one chosen, or gone from the page when the service refuses to move it.
import { act, screen, waitFor, within } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import { formatTime } from '@shared/time.ts';
import { deferred, FakeEventSource, IDLE_STATE, open, refusal, shellStream, type Handler } from '@/test/harness';

const STATE = { router: { alive: true }, dispatch: { paused: false }, channels: {} };
const EMPTY = { counts: { waiting: 0, moving: 0, ready: 0 }, approvals: [], moving: [], recent: [], state: STATE };

function overviewOf(overview: object, more: Handler = () => undefined): Handler {
  return (call) => {
    const answer = more(call);
    if (answer !== undefined) return answer;
    if (call.path === '/api/overview') return overview;
    if (call.path === '/api/doctor') return { checks: [] };
    return undefined;
  };
}

const page = async (): Promise<HTMLElement> => screen.findByRole('article');
const column = (title: string): HTMLElement => screen.getByRole('region', { name: title });
// The sentence at the top of the overview: the page's own name (总览) is in its bar.
const headline = (text: string | RegExp): Promise<HTMLElement> => screen.findByRole('heading', { level: 2, name: text });

test('the summary distinguishes decisions, moving work, acceptable tasks and recently ended work', async () => {
  const approval = { id: 'a1', task_id: 't1', task_title: '选型', state: 'open', questions: [{ question: '选哪个？', options: ['甲', '乙'] }], answers: null, answered_via: null };
  const ready = { id: 'child', parent_id: 'work', title: '待验收的子任务', state: 'ready' };
  open('#/', overviewOf({
    ...EMPTY,
    counts: { waiting: 1, moving: 3, ready: 1 },
    approvals: [approval, { ...approval, id: 'a2' }],
    recent: [{ id: 'done', title: '已交付', state: 'done' }],
  }, (call) => call.path === '/api/tasks?top=1' ? { tasks: [], children: [ready] } : undefined));
  await screen.findByRole('link', { name: /待验收的子任务/ });
  const summary = screen.getByRole('list', { name: '工作概况' });
  expect(within(summary).getAllByRole('listitem').map((item) => item.textContent)).toEqual([
    '1等你决定', '1待验收', '3正在推进', '1最近结束',
  ]);
  // Two questions of one task are one decision; what waits to be accepted needs the owner too.
  expect(await headline('1 件等你决定，1 件待验收')).toBeInTheDocument();
  expect(within(column('需要你处理')).getByRole('textbox', { name: '验收依据' })).toBeVisible();
});

test('the headline says what needs the owner first, and each question leads to its task', async () => {
  const approval = { id: 'a1', task_id: 't1', task_title: '选型', state: 'open', questions: [{ question: '选哪个？', options: ['甲', '乙'] }], answers: null, answered_via: null };
  open('#/', overviewOf({ ...EMPTY, approvals: [approval, { ...approval, id: 'a2' }], held: [{ id: 'h', title: '卡住的', state: 'held', reason: '派发失败', summary: { dot: 'held', text: '', leaf: true } }] }));
  expect(await headline('1 件等你决定，1 件已停住')).toBeInTheDocument();
  expect(within(column('需要你处理')).getAllByText('选哪个？')).toHaveLength(2);
  const cards = within(column('需要你处理')).getAllByRole('region', { name: '等你决定 · 选型' });
  expect(cards).toHaveLength(2);
  for (const card of cards) expect(within(card).getByRole('link', { name: '选型' })).toHaveAttribute('href', '#/task/t1');
});

test('with nothing for the owner the headline counts what moves, or says nothing is going on', async () => {
  const first = open('#/', overviewOf({ ...EMPTY, counts: { waiting: 0, moving: 2, ready: 0 } }));
  expect(await headline('没有等你的事，2 项工作在推进')).toBeInTheDocument();
  first.unmount();
  open('#/', overviewOf(EMPTY));
  expect(await headline('没有等你的事')).toBeInTheDocument();
  const article = await page();
  expect(article).toHaveTextContent('现在没有在进行的工作');
  expect(article).toHaveTextContent('到项目里告诉它的负责人要做什么');
});

test('the overview goes through a restore item by item, and an uncounted host never reads as none', async () => {
  open('#/', overviewOf({
    ...EMPTY,
    state: { ...STATE, dispatch: { paused: true } },
    restore: {
      from: 'D:/backups/1', backup_at: '2026-11-05T01:00:00Z', restored_at: '2026-11-05T02:00:00Z',
      held_tasks: [{ id: 'held', title: '旧排队任务' }],
      unverified_messages: [{ id: 'm', text: '旧指令', at: '2026-11-05T00:00:00Z', changes: [{ action: 'task.create', at: '2026-11-05T00:00:00Z' }] }],
      runs: [{ id: 'r', task_id: 't', task_title: '备份时在跑的', host: 'h1', state: 'ended', exit_kind: 'completed' }],
      orphan_runs: [
        // Two machines of one host, as the service reports them: the id tells them apart.
        { machine_id: 'shared', host: 'shared', runs: [{ task_id: 'gone', run_id: 'after', alive: true }] },
        { machine_id: 'shared@c', host: 'shared', runs: null, error: '连不上实例' },
        { machine_id: 'shared@a', host: 'shared', runs: [] },
      ],
      missing_logins: ['t9'],
    },
  }));
  const text = (await page()).textContent;
  expect(text).toMatch(/的备份恢复，以下项目等你确认/);
  expect(text).toMatch(/账本里没有账号 t9 的配置：需要重新选择登录，同名新建的账号或机器登录不会接续这份引用/);
  expect(text).toMatch(/旧指令.*创建任务/);
  expect(text).toMatch(/备份时在跑的 · 完成/);
  expect(text).toMatch(/after · 任务 gone · 仍有进程/);
  expect(text).toMatch(/shared@c（shared）：未能清点。连不上实例/);
  expect(text).toMatch(/shared@a（shared）：没有账本之外的 Run/);
  expect(text, '清点报告说的是机器，不是账号').not.toMatch(/undefined/);
  // Going through them one by one has to lead to the task page's 继续 and 放弃.
  expect(screen.getByRole('link', { name: '旧排队任务' })).toHaveAttribute('href', '#/task/held');
});

test('stopped work is listed with what needs the owner, with its reason, and the restore list shows no payload', async () => {
  open('#/', overviewOf({
    ...EMPTY,
    held: [{ id: 'stuck', title: '卡住的工作', state: 'held', reason: '派发失败', summary: { dot: 'held', text: '已停住：派发失败', counts: { held: 1 }, leaf: true } }],
    restore: {
      from: 'D:/backup', backup_at: '2026-11-05T00:00:00Z', restored_at: '2026-11-05T01:00:00Z', held_tasks: [], runs: [], orphan_runs: [],
      unverified_messages: [{ id: 'm', text: '任务“甲”的 Run 已结算，任务转为 ready\n{"task_id":"t"}', at: '2026-11-05T00:00:00Z', changes: [] }],
    },
  }));
  const text = (await page()).textContent;
  expect(text).toMatch(/1 件已停住/);
  const row = within(column('需要你处理')).getByRole('link', { name: /已停住：卡住的工作/ });
  expect(row).toHaveAttribute('href', '#/work/stuck');
  expect(row).toHaveTextContent('派发失败');
  expect(text).toMatch(/任务转为 待验收/);
  expect(text).not.toMatch(/task_id/);
  expect(text).toMatch(/都确认过了/);
  expect(text).toMatch(/未能清点：还没有结果/);
});

test('the overview lists a task whose machine is out of contact as moving, never as something the owner must do', async () => {
  const lost = {
    id: 'task', title: '失联的任务', state: 'needs_verification',
    summary: { dot: 'needs_verification', text: '1 个执行机器失联', leaf: true, counts: { needs_verification: 1 } },
    latest_run: { state: 'unknown', created_at: '2026-11-05T00:00:00Z' },
  };
  open('#/', overviewOf({ ...EMPTY, counts: { waiting: 0, moving: 1, ready: 0 }, moving: [lost], no_machine: [] }));
  const text = (await page()).textContent;
  expect(column('正在进行')).toHaveTextContent('失联的任务');
  expect(column('正在进行')).toHaveTextContent('执行情况未知');
  expect(column('需要你处理')).toHaveTextContent('没有待处理的事');
  expect(text).not.toMatch(/需要你核实/);
  expect(text).toMatch(/1 项工作在推进/);
});

test('moving work shows the latest run login and host without opening its page', async () => {
  open('#/', overviewOf({
    ...EMPTY,
    counts: { waiting: 0, moving: 1, ready: 0 },
    moving: [{
      id: 'task', title: '检查控制台', state: 'running',
      latest_run: { state: 'running', login_id: 'worker', login_name: 'worker', host: 'build-host', created_at: new Date().toISOString() },
    }],
  }));
  await page();
  const task = within(column('正在进行')).getByRole('link', { name: /检查控制台/ });
  // On the row itself, one hover away: beside how long the run has been going.
  expect(within(task).getByTitle('账号 worker · build-host')).toBeInTheDocument();
  expect(task).toHaveAttribute('href', '#/work/task');
});

test('overview shows a target with no machine left under what needs the owner, and abandoned notification deliveries', async () => {
  const { user, calls } = open('#/', overviewOf({
    ...EMPTY,
    no_machine: [{ login_id: 'gpu/codex', login_name: 'gpu/codex', since: '2026-11-05T00:00:00Z', overdue: true }],
    launching: [{ id: 'run', task_id: 'task' }],
    outbox: { pending: 0, given_up: 1, failures: [{ id: 'failed', kind: 'verify', payload_json: '{"task_id":"task"}', error: '离线', created_at: '2026-11-05T00:00:00Z' }] },
    state: { ...STATE, dispatch: { paused: true } },
  }, (call) => { if (call.method === 'POST') throw refusal('拒绝重试'); return undefined; }));
  const text = (await page()).textContent;
  expect(text).toMatch(/1 个登录没有可用的机器/);
  expect(column('需要你处理')).toHaveTextContent('机器 gpu 上的 codex 登录 没有可用的机器');
  expect(column('需要你处理')).toHaveTextContent('起一直连不上。排在它上面的任务在等，加上机器或机器恢复后自动继续');
  expect(text).toMatch(/待发送 0 条 · 已放弃 1 条/);
  expect(screen.getByRole('link', { name: 'run' })).toHaveAttribute('href', '#/task/task');
  const failed = column('发送失败的提醒');
  expect(failed).toHaveTextContent('发送失败 1 条');
  expect(failed).toHaveTextContent('通知未能确认送达，已停止自动重试；“忽略”仅清除提醒，不影响任务状态。');
  expect(within(failed).getByRole('link', { name: 'task' })).toHaveAttribute('href', '#/task/task');
  expect(failed.textContent).toMatch(/对象：task原因：离线/);
  const retry = within(failed).getByRole('button', { name: '重试发送' });
  await user.click(retry);
  expect(calls).toEqual([{ path: '/api/outbox/failed/retry', method: 'POST', body: {} }]);
  expect(await screen.findByRole('alert')).toHaveTextContent('拒绝重试');
  // A retry that was refused can be asked for again.
  expect(retry).toBeEnabled();
});

test('the owner can ignore a failed notification without retrying or accepting its task; both actions wait and the row disappears', async () => {
  const answer = deferred();
  let confirmed = false;
  const failure = { id: 'unknown/send', payload_json: '{"task_id":"task"}', task_title: '夜间回归', error: '发送结果未知：请先核对原聊天', created_at: '2026-11-05T00:00:00Z' };
  const { user, calls, reads } = open('#/', (call) => {
    if (call.method === 'POST') return answer.promise.then(() => { confirmed = true; return { confirmed: true }; });
    if (call.path === '/api/overview') return { ...EMPTY, outbox: { given_up: confirmed ? 0 : 1, pending: 0, failures: confirmed ? [] : [failure] } };
    if (call.path === '/api/doctor') return { checks: [] };
    return undefined;
  });
  await page();
  const failed = column('发送失败的提醒');
  expect(within(failed).getByRole('link', { name: '夜间回归' })).toHaveAttribute('href', '#/task/task');
  expect(failed).toHaveTextContent('原因：发送结果未知：请先核对原聊天');
  expect(failed).toHaveTextContent('“忽略”仅清除提醒，不影响任务状态。');
  const confirm = within(failed).getByRole('button', { name: '忽略' });
  const forceResend = within(failed).getByRole('button', { name: '确认未收到，强制补发' });
  expect(within(failed).queryByRole('button', { name: '重试发送' })).toBeNull();
  const before = reads.filter((path) => path === '/api/overview').length;
  await user.click(confirm);
  expect(confirm).toBeDisabled();
  expect(forceResend).toBeDisabled();
  expect(calls).toEqual([{ path: '/api/outbox/unknown%2Fsend/confirm', method: 'POST', body: {} }]);
  expect(screen.queryByRole('dialog')).toBeNull();
  await act(async () => { answer.resolve({}); });
  await waitFor(() => expect(screen.queryByRole('region', { name: '发送失败的提醒' })).toBeNull());
  await waitFor(() => expect(reads.filter((path) => path === '/api/overview').length).toBeGreaterThan(before));
  expect(calls).toHaveLength(1);
});

test('a refused ignore keeps the failed row and its error readable, and releases both actions', async () => {
  const { user, calls } = open('#/', overviewOf({
    ...EMPTY,
    outbox: { pending: 0, given_up: 1, failures: [{ id: 'failed', payload_json: '{}', error: '原始发送错误', created_at: '2026-11-05T00:00:00Z' }] },
  }, (call) => { if (call.method === 'POST') throw refusal('暂时无法记录确认'); return undefined; }));
  await page();
  const failed = column('发送失败的提醒');
  await user.click(within(failed).getByRole('button', { name: '忽略' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('暂时无法记录确认');
  expect(failed).toHaveTextContent('原始发送错误');
  expect(within(failed).getByRole('button', { name: '忽略' })).toBeEnabled();
  expect(within(failed).getByRole('button', { name: '重试发送' })).toBeEnabled();
  expect(calls).toEqual([{ path: '/api/outbox/failed/confirm', method: 'POST', body: {} }]);
});

test('multiple failed deliveries expose a one-click batch ignore button', async () => {
  let cleared = false;
  const failures = [
    { id: 'f1', payload_json: '{"external_id":"a"}', error: '微信会话回复窗口已过期（-2）', created_at: '2026-11-05T00:00:00Z' },
    { id: 'f2', payload_json: '{"external_id":"b"}', error: '微信会话回复窗口已过期（-2）', created_at: '2026-11-05T00:01:00Z' },
  ];
  const { user, calls } = open('#/', (call) => {
    if (call.method === 'POST' && call.path === '/api/outbox/confirm-all') {
      cleared = true;
      return { confirmed: 2 };
    }
    if (call.path === '/api/overview') return { ...EMPTY, outbox: { given_up: cleared ? 0 : 2, pending: 0, failures: cleared ? [] : failures } };
    if (call.path === '/api/doctor') return { checks: [] };
    return undefined;
  });
  await page();
  const failed = column('发送失败的提醒');
  const confirmAll = within(failed).getByRole('button', { name: '全部忽略（2 条）' });
  await user.click(confirmAll);
  await waitFor(() => expect(calls).toEqual([{ path: '/api/outbox/confirm-all', method: 'POST', body: {} }]));
  await waitFor(() => expect(screen.queryByRole('region', { name: '发送失败的提醒' })).toBeNull());
});

test('a start that was never confirmed is said so beside the pause', async () => {
  open('#/', overviewOf({ ...EMPTY, launching: [{ id: 'r9', task_id: 't', unconfirmed: true }], state: { ...STATE, dispatch: { paused: true } } }));
  expect(await screen.findByRole('link', { name: 'r9（启动未确认）' })).toBeInTheDocument();
});

const BACKUP = { configured: true, dir: 'E:/b', at: '03:30', last_ok_at: '2026-11-05T01:00:00Z', last_ok_incomplete: false, last_error: null, running: false };
const withBackup = (backup: object): object => ({ ...EMPTY, state: { ...STATE, dispatch: {} }, backup });
const backup = (): HTMLElement => screen.getByRole('region', { name: '备份' });

test('the overview shows a good backup and offers to run one', async () => {
  open('#/', overviewOf(withBackup(BACKUP)));
  await page();
  expect(backup()).toHaveTextContent(/上次成功：.*2026/);
  expect(backup()).toHaveTextContent('每天 03:30 备份到 E:/b');
  expect(backup().textContent).not.toMatch(/不完整|上次失败|还没有成功过/);
  expect(within(backup()).getByRole('button', { name: '立即备份' })).toBeEnabled();
});

test('an incomplete log copy is explained as such, not as a failure', async () => {
  open('#/', overviewOf(withBackup({ ...BACKUP, last_ok_incomplete: true })));
  await page();
  expect(backup()).toHaveTextContent('日志副本不完整：账本是全的');
  expect(backup().textContent).not.toMatch(/上次失败/);
});

test('a failure shows when and why, next to the last success or the lack of one', async () => {
  open('#/', overviewOf(withBackup({ ...BACKUP, last_ok_at: null, last_error: { at: '2026-11-05T02:00:00Z', text: '盘满了' } })));
  await page();
  expect(backup()).toHaveTextContent('还没有成功过');
  expect(backup()).toHaveTextContent(/上次失败：.*原因：盘满了/);
});

test('no backup configured points to the settings page, with no button', async () => {
  open('#/', overviewOf(withBackup({ configured: false })));
  await page();
  expect(backup()).toHaveTextContent(/没有配置自动备份.*设置页/);
  expect(within(backup()).getByRole('link', { name: '去设置' })).toHaveAttribute('href', '#/settings/backup.dir');
  expect(within(backup()).queryByRole('button')).toBeNull();
});

test('the button is off while a backup runs, from the service or from this page', async () => {
  const running = open('#/', overviewOf(withBackup({ ...BACKUP, running: true })));
  await page();
  expect(within(backup()).getByRole('button', { name: '备份中' })).toBeDisabled();
  running.unmount();

  const gate = deferred();
  const { user, calls } = open('#/', overviewOf(withBackup(BACKUP), (call) => (call.path === '/api/backup' ? gate.promise : undefined)));
  await page();
  await user.click(within(backup()).getByRole('button', { name: '立即备份' }));
  expect(within(backup()).getByRole('button', { name: '备份中' })).toBeDisabled();
  expect(calls.map(({ path }) => path)).toEqual(['/api/backup']);
  gate.resolve({});
  expect(await within(backup()).findByRole('button', { name: '立即备份' })).toBeEnabled();
});

test('dispatch cannot be resumed from the overview while a restore waits for its count, and the button says why', async () => {
  const mark = { from: 'D:/backup', backup_at: '2026-11-05T00:00:00Z', restored_at: '2026-11-05T01:00:00Z', held_tasks: [], unverified_messages: [], runs: [], orphan_runs: [] };
  const cases: [object | null, object, string, boolean, RegExp | null][] = [
    [mark, { paused: true }, '恢复派发', false, /先确认清点完成/],
    [null, { paused: true }, '恢复派发', true, null],
    // Pausing is always allowed.
    [mark, { paused: false }, '暂停派发', true, null],
    [null, { paused: true, recovering: true }, '恢复派发', false, /正在清点/],
  ];
  for (const [restore, dispatch, label, enabled, why] of cases) {
    const view = open('#/', overviewOf({ ...EMPTY, held: [], state: { ...STATE, dispatch }, restore }));
    const button = await screen.findByRole('button', { name: label });
    if (enabled) expect(button).toBeEnabled(); else expect(button).toBeDisabled();
    if (why) {
      expect(button).toHaveAttribute('title', expect.stringMatching(why));
      expect((await page()).textContent).toMatch(why);
    }
    view.unmount();
  }
});

test('pausing asks the service and reads the page and the banner again', async () => {
  let paused = false;
  const { user, calls, reads, waiting } = open('#/', (call) => {
    if (call.path === '/api/pause') { paused = (call.body as { paused: boolean }).paused; return { dispatch: { paused } }; }
    if (call.path === '/api/overview') return { ...EMPTY, state: { ...STATE, dispatch: { paused } } };
    if (call.path === '/api/state') return { ...IDLE_STATE, dispatch: { ...IDLE_STATE.dispatch, paused } };
    if (call.path === '/api/doctor') return { checks: [] };
    return undefined;
  });
  const pause = await screen.findByRole('button', { name: '暂停派发' });
  const overviewReads = (): number => reads.filter((path) => path === '/api/overview').length;
  // Opening reads the page twice: on arriving, and again once the console is connected.
  await waitFor(() => expect([overviewReads(), waiting('/api/overview')]).toEqual([2, 0]));
  await user.click(pause);
  expect(calls).toEqual([{ path: '/api/pause', method: 'POST', body: { paused: true } }]);
  expect(await screen.findByRole('button', { name: '恢复派发' })).toBeEnabled();
  // The side column says it too, and the banner keeps it in front of the owner.
  await waitFor(() => expect(screen.getAllByText('派发已暂停').length).toBeGreaterThanOrEqual(1));
  expect(screen.getByLabelText('运行状况')).toHaveTextContent('派发已暂停');
  expect(overviewReads()).toBe(3);
});

test('what changed between the page being read and the console starting to listen is on the page once it is connected', async () => {
  // The stream is opened by the test, after the change.
  FakeEventSource.autoOpen = false;
  let counts = { waiting: 0, moving: 1, ready: 0 };
  open('#/', (call) => overviewOf({ ...EMPTY, counts })(call));
  expect(await headline('没有等你的事，1 项工作在推进')).toBeInTheDocument();
  // The work is delivered. No stream is open yet: the change is pushed to nobody.
  counts = { waiting: 0, moving: 0, ready: 1 };
  await waitFor(() => expect(shellStream()).toBeDefined());
  await act(async () => { shellStream().open(); });
  expect(await headline('1 件待验收')).toBeInTheDocument();
});

const fix = (label: string, href: string) => ({ label, href });
// As the service lists them: in its own order, with the ones that are fine in between.
const CHECKS = [
  { id: 'wecom', level: 'warn', title: '企业微信', text: '没有启用：手机上收不到通知', fix: fix('去设置', '#/settings/wecom.botId') },
  { id: 'node', level: 'ok', title: 'Node 版本', text: 'Node v24.1.0', fix: null },
  { id: 'claude-cli', level: 'fail', title: 'Claude Code', text: '在 PATH 里没有找到 claude。装好 Claude Code，或填上它的路径', fix: fix('去设置', '#/settings/router.cli') },
  { id: 'claude-login', level: 'warn', title: '负责人的 Claude 登录', text: '找到 Claude Code 之后才能检查登录', fix: null },
  { id: 'accounts', level: 'fail', title: '账号', text: '还没有账号，任务派不出去', fix: fix('去账号页', '#/accounts') },
  { id: 'backup', level: 'warn', title: '自动备份', text: '没有配置：这台电脑的盘坏了，账本就没了', fix: fix('去设置', '#/settings/backup.dir') },
];
const checked = (doctor: () => unknown): Handler => (call) =>
  call.path === '/api/overview' ? withBackup(BACKUP) : call.path === '/api/doctor' ? doctor() : undefined;
// What cannot work stands at the top of the page under its own name; advice is a folded
// line among the things about the service, further down.
const faults = (): HTMLElement | null => screen.queryByRole('region', { name: '不处理就用不了' });
const advice = (): HTMLElement | null => screen.queryByRole('region', { name: '建议配置的事' });
const links = (section: HTMLElement): (string | null)[][] => within(section).getAllByRole('link').map((link) => [link.textContent, link.getAttribute('href')]);

test('the overview opens with what still has to be set up: what cannot work first, each with its reason and the way there', async () => {
  const { user } = open('#/', checked(() => ({ checks: CHECKS })));
  const article = await page();
  // What cannot work is the first thing on the page.
  expect(article.firstElementChild).toBe(faults());
  const broken = faults()!;
  // The level is said in words, not by the colour alone.
  expect(within(broken).getByText('不处理就用不了')).toBeInTheDocument();
  expect(broken.textContent).toMatch(/Claude Code.*在 PATH 里没有找到 claude.*账号.*还没有账号，任务派不出去/);
  // What is fine is not listed, and advice is not mixed in with what cannot work.
  expect(broken.textContent).not.toMatch(/Node|企业微信|自动备份/);
  expect(links(broken)).toEqual([['去设置', '#/settings/router.cli'], ['去账号页', '#/accounts']]);

  // Advice is one line until it is asked for, and can be told to stop repeating here.
  const section = advice()!;
  const folded = within(section).getByRole('button', { name: '还有 3 件建议配置的事' });
  expect(folded).toHaveAttribute('aria-expanded', 'false');
  expect(section).not.toHaveTextContent('没有启用：手机上收不到通知');
  expect(section.textContent).not.toMatch(/Node|Claude Code/);
  await user.click(folded);
  expect(section).toHaveTextContent('没有启用：手机上收不到通知');
  expect(section.textContent).toMatch(/企业微信.*负责人的 Claude 登录.*自动备份/);
  expect(links(section)).toEqual([['去设置', '#/settings/wecom.botId'], ['去设置', '#/settings/backup.dir']]);
  const dismiss = within(section).getAllByRole('button', { name: '不再提醒' });
  expect(dismiss).toHaveLength(3);
  await user.click(dismiss[0]!);
  expect(section).not.toHaveTextContent('没有启用：手机上收不到通知');
  expect(within(section).getByRole('button', { name: '还有 2 件建议配置的事' })).toBeInTheDocument();
  expect(article).toHaveTextContent('没有在进行的工作');
});

test('advice told to stop repeating stays away, but the same check turning into a fault is shown all the same', async () => {
  let level = 'warn';
  const { user } = open('#/', (call) => (call.path === '/api/backup' ? {} : checked(() => ({
    checks: [{ id: 'account:t1', level, title: '账号 t1', text: '账号 t1 还没有连接', fix: fix('去账号页', '#/accounts') }],
  }))(call)));
  await page();
  const section = advice()!;
  // One piece of advice at a time is folded away until it is asked for.
  await user.click(within(section).getByRole('button', { name: '还有 1 件建议配置的事' }));
  await user.click(within(section).getByRole('button', { name: '不再提醒' }));
  expect(advice()).toBeNull();
  expect(faults()).toBeNull();
  // The same check, now one that cannot work until it is put right: advice can be told to
  // stop repeating, a fault cannot.
  level = 'fail';
  await user.click(within(backup()).getByRole('button', { name: '立即备份' }));
  await waitFor(() => expect(faults()).toHaveTextContent('账号 t1 还没有连接'));
  expect(advice()).toBeNull();
});

test('a dismissal the browser will not keep still takes effect on the page', async () => {
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('存储已满'); });
  const { user } = open('#/', checked(() => ({ checks: CHECKS })));
  await page();
  const section = advice()!;
  await user.click(within(section).getByRole('button', { name: '还有 3 件建议配置的事' }));
  await user.click(within(section).getAllByRole('button', { name: '不再提醒' })[0]!);
  // Whether or not the browser kept it, it is gone from this page now.
  expect(section).not.toHaveTextContent('没有启用：手机上收不到通知');
  expect(within(section).getByRole('button', { name: '还有 2 件建议配置的事' })).toBeInTheDocument();
});

test('a browser that refuses storage leaves the overview standing, advice and all', async () => {
  const denied = new Proxy({}, { get() { throw new Error('SecurityError: 存储被拒绝'); } });
  vi.stubGlobal('sessionStorage', denied);
  vi.stubGlobal('localStorage', denied);
  const { user } = open('#/', checked(() => ({ checks: CHECKS })));
  const article = await page();
  expect(article).toHaveTextContent('没有在进行的工作');
  expect(within(backup()).getByRole('button', { name: '立即备份' })).toBeEnabled();
  // What was open before cannot be known, so it starts folded; opening it is this page's.
  expect(faults()).toHaveTextContent('还没有账号，任务派不出去');
  const folded = within(advice()!).getByRole('button', { name: '还有 3 件建议配置的事' });
  expect(folded).toHaveAttribute('aria-expanded', 'false');
  await user.click(folded);
  expect(folded).toHaveAttribute('aria-expanded', 'true');
  expect(advice()).toHaveTextContent('没有启用：手机上收不到通知');
});

test('nothing is said about setup when every check is fine', async () => {
  open('#/', checked(() => ({ checks: CHECKS.map((check) => ({ ...check, level: 'ok', fix: null })) })));
  const article = await page();
  expect(faults()).toBeNull();
  expect(advice()).toBeNull();
  expect(article.textContent).not.toMatch(/不处理就用不了|建议配置|自检/);
  expect(article).toHaveTextContent('没有在进行的工作');
});

test('a self-check that cannot be read leaves the overview on the page and says so in one line', async () => {
  let failing = true;
  const { user } = open('#/', (call) => {
    if (call.path === '/api/backup') return {};
    return checked(() => { if (failing) throw refusal('检查超时', 500); return { checks: CHECKS }; })(call);
  });
  const article = await page();
  expect(article).toHaveTextContent('没有在进行的工作');
  expect(backup()).toHaveTextContent('上次成功：');
  expect(article).toHaveTextContent('自检结果读不到：检查超时');
  expect(faults()).toBeNull();
  expect(advice()).toBeNull();
  // The next read that works lists them as usual.
  failing = false;
  await user.click(within(backup()).getByRole('button', { name: '立即备份' }));
  await waitFor(() => expect(faults()).not.toBeNull());
  expect(advice()).not.toBeNull();
  expect(article.textContent).not.toMatch(/自检结果读不到/);
});

test('an overview that cannot be read says why, and keeps what it showed before', async () => {
  const first = open('#/', (call) => { if (call.path === '/api/overview') throw refusal('账本不可用', 503); return call.path === '/api/doctor' ? { checks: [] } : undefined; });
  expect(await screen.findByText('账本不可用')).toBeInTheDocument();
  expect(screen.queryByText('正在读取…')).toBeNull();
  expect(document.querySelector('[data-slot="skeleton-page"]')).toBeNull();
  expect(screen.queryByRole('article')).toBeNull();
  first.unmount();

  let down = false;
  const { user } = open('#/', (call) => {
    if (call.path === '/api/backup') { down = true; return {}; }
    if (call.path === '/api/overview') { if (down) throw refusal('读不到总览', 500); return withBackup(BACKUP); }
    return call.path === '/api/doctor' ? { checks: [] } : undefined;
  });
  await page();
  await user.click(within(backup()).getByRole('button', { name: '立即备份' }));
  expect(await screen.findByText('读不到总览')).toBeInTheDocument();
  // What was read before is still there to look at.
  expect(backup()).toHaveTextContent('每天 03:30 备份到 E:/b');
});

// The state of the service's parts is in the side column, always in sight: folded into
// one line while everything is as it should be, opened out when something is not.
const folded = (): HTMLElement => screen.getByText('一切正常');
const health = (): HTMLElement => screen.getByLabelText('运行状况');
const withGateway = (gateway: object): Handler => (call) =>
  call.path === '/api/state' ? { ...IDLE_STATE, gateway } : overviewOf(EMPTY)(call);

test('a gateway that is off, or a service that does not report one, folds away with the rest', async () => {
  const first = open('#/', withGateway({ state: 'off', since: null, error: null }));
  await page();
  expect(folded()).not.toHaveTextContent('门牌');
  first.unmount();
  open('#/', overviewOf(EMPTY));
  await page();
  expect(folded()).not.toHaveTextContent('门牌');
});

test('a gateway being connected says so, with why the last try failed when there was one', async () => {
  open('#/', withGateway({ state: 'connecting', since: null, error: 'refused\nagain' }));
  await page();
  expect(health()).toHaveTextContent('门牌：连接中，上一次没连上：refused；again');
  expect(within(health()).queryByRole('link')).toBeNull();
});

test('a connected gateway says since when, as an ordinary fact', async () => {
  const since = new Date();
  open('#/', withGateway({ state: 'connected', since: since.toISOString(), error: null }));
  await page();
  expect(folded().title).toContain(`门牌：已连接（${formatTime(since)} 起）`);
  expect(folded()).not.toHaveTextContent('门牌');
});

test('a gateway that cannot be reached shows as a problem, and leads to its setting', async () => {
  open('#/', withGateway({ state: 'down', since: '2026-11-05T01:00:00Z', error: 'Connection refused\nexit 255' }));
  await page();
  expect(health()).toHaveTextContent('门牌：连不上，正在重试：Connection refused；exit 255');
  expect(within(health()).getByRole('link', { name: '去设置' })).toHaveAttribute('href', '#/settings/gateway.ssh');
});

test('a task that waits for a quota or for a target to free up is under what moves, with what it waits for, and never under what needs the owner', async () => {
  const until = new Date();
  until.setDate(until.getDate() + 1);
  until.setHours(6, 40, 0, 0);
  const waiting = (id: string, title: string, wait: object) => ({
    id, title, state: 'queued', reason: null, summary: { dot: 'running', text: '1 个在执行', leaf: true }, latest_run: null, waiting: wait,
  });
  open('#/', overviewOf({
    ...EMPTY,
    counts: { waiting: 0, moving: 2, ready: 0 },
    moving: [
      waiting('q1', '等额度的', { rest: { login: 'cluster-claude', until: until.toISOString() }, full: [], no_machine: [] }),
      waiting('q2', '等位置的', { rest: null, full: ['cluster-codex'], no_machine: [] }),
    ],
  }));
  expect(await headline('没有等你的事，2 项工作在推进')).toBeInTheDocument();
  const moving = column('正在进行');
  expect(within(moving).getByRole('link', { name: /等额度的/ })).toHaveTextContent(/排队中：等额度恢复，约 \d\d-\d\d 06:40/);
  expect(within(moving).getByRole('link', { name: /等位置的/ })).toHaveTextContent('排队中：等 账号 cluster-codex 空出来');
  expect(column('需要你处理')).toHaveTextContent('没有待处理的事');
  expect(column('需要你处理')).not.toHaveTextContent(/等额度|空出来/);
});

test('a work waiting to be accepted is accepted where it is seen, without opening its page', async () => {
  const ready = { id: 'w', title: '待验收的工作', state: 'ready', summary: { dot: 'ready', text: '1 个待验收', leaf: true, counts: {} } };
  const calls: { path: string; method: string; body: unknown }[] = [];
  const { user } = open('#/', (call) => {
    if (call.path === '/api/tasks?top=1') return { tasks: [ready], children: [] };
    if (call.path === '/api/tasks/w/accept') { calls.push({ path: call.path, method: call.method, body: call.body }); return { task: ready }; }
    return overviewOf({ ...EMPTY, counts: { waiting: 0, moving: 0, ready: 1 } })(call);
  });
  const column = await screen.findByRole('region', { name: '需要你处理' });
  expect(within(column).getByRole('link', { name: /待验收的工作/ })).toHaveAttribute('href', '#/task/w');
  await user.type(within(column).getByRole('textbox', { name: '验收依据' }), '  跑过了回归  ');
  await user.click(within(column).getByRole('button', { name: '验收通过' }));
  await waitFor(() => expect(calls).toEqual([{ path: '/api/tasks/w/accept', method: 'POST', body: { basis: '跑过了回归' } }]));
});

test('a work that only waits because a task under it waits is not accepted itself', async () => {
  const work = { id: 'w', title: '工作包', state: 'draft', summary: { dot: 'ready', text: '1 个待验收', leaf: false, counts: { ready: 1 } } };
  const child = { id: 'c1', parent_id: 'w', title: '子任务甲', state: 'ready' };
  const calls: { path: string; method: string; body: unknown }[] = [];
  const { user } = open('#/', (call) => {
    if (call.path === '/api/tasks?top=1') return { tasks: [work], children: [child] };
    if (call.path === '/api/tasks/c1/accept') { calls.push({ path: call.path, method: call.method, body: call.body }); return { task: child }; }
    if (call.path.startsWith('/api/tasks/')) { calls.push({ path: call.path, method: call.method, body: call.body }); return { task: work }; }
    return overviewOf({ ...EMPTY, counts: { waiting: 0, moving: 0, ready: 1 } })(call);
  });
  const column = await screen.findByRole('region', { name: '需要你处理' });
  // The summary says a task under it waits; the work itself is a draft, and the ledger
  // would refuse it. What is offered is the task that is itself waiting.
  expect(within(column).getByRole('link', { name: /子任务甲/ })).toHaveAttribute('href', '#/task/c1');
  expect(within(column).queryByRole('link', { name: /工作包/ })).toBeNull();
  // The work it is under is said beside it, as words.
  expect(within(column).getByRole('region', { name: '待验收 · 子任务甲' })).toHaveTextContent('工作包');
  await user.type(within(column).getByRole('textbox', { name: '验收依据' }), '跑过了回归');
  await user.click(within(column).getByRole('button', { name: '验收通过' }));
  await waitFor(() => expect(calls).toEqual([{ path: '/api/tasks/c1/accept', method: 'POST', body: { basis: '跑过了回归' } }]));
});

// docs/design/project-sessions.md §2: what the owner sent from WeCom with no project waits
// on the overview, among what needs the owner, until it is given one.
const P1 = { id: 'p1', name: '试跑', sources: [], logins: [], machines: [], spawn_machines: false, moving: 0, waiting: 0 };
const unassigned = (id: string, text: string) => ({ id, direction: 'in', channel: 'wecom', external_id: `x-${id}`, text, state: 'unassigned' });

test('a message that waits for a project is counted among what needs the owner and given a project where it is seen', async () => {
  let waiting = [unassigned('w1', '企微里说的')];
  const { user, calls } = open('#/', (call) => {
    if (call.path === '/api/projects') return { projects: [P1, { ...P1, id: 'p2', name: '量化' }] };
    if (call.path === '/api/messages/unassigned') return { messages: waiting };
    if (call.method === 'POST' && call.path === '/api/messages/assign') { waiting = []; return { messages: [] }; }
    return undefined;
  });
  const region = await screen.findByRole('region', { name: '待归属的消息' });
  expect(column('需要你处理')).toContainElement(region);
  expect(within(region).getByText('企微里说的')).toBeInTheDocument();
  expect(await headline('1 条消息待归属')).toBeInTheDocument();
  // The projects themselves are in the side column.
  expect(within(screen.getByRole('navigation', { name: '项目' })).getByRole('link', { name: /试跑/ })).toHaveAttribute('href', '#/projects/p1');
  await user.selectOptions(within(region).getByRole('combobox', { name: '归到哪个项目' }), 'p2');
  await user.click(within(region).getByRole('button', { name: '归到这个项目' }));
  expect(calls).toEqual([{ path: '/api/messages/assign', method: 'POST', body: { ids: ['w1'], project_id: 'p2' } }]);
  await waitFor(() => expect(screen.queryByRole('region', { name: '待归属的消息' })).toBeNull());
  expect(await headline('没有等你的事')).toBeInTheDocument();
});

test('an assignment the service refuses says why and leaves the message waiting, and batch assign supports choosing any project', async () => {
  const { user, calls } = open('#/', (call) => {
    if (call.path === '/api/projects') return { projects: [P1, { ...P1, id: 'p2', name: '量化' }] };
    if (call.path === '/api/messages/unassigned') return { messages: [unassigned('w1', '企微里说的'), unassigned('w2', '又说了一句')] };
    if (call.method === 'POST') throw refusal('消息已经被取走', 409);
    return undefined;
  });
  const region = await screen.findByRole('region', { name: '待归属的消息' });
  await user.selectOptions(within(region).getByRole('combobox', { name: '全部归到哪个项目' }), 'p2');
  await user.click(within(region).getByRole('button', { name: '归到所选项目' }));
  expect(calls).toEqual([{ path: '/api/messages/assign', method: 'POST', body: { ids: ['w1', 'w2'], project_id: 'p2' } }]);
  expect(await within(region).findByRole('alert')).toHaveTextContent('消息已经被取走');
  expect(within(region).getByText('企微里说的')).toBeInTheDocument();
  expect(within(region).getByText('又说了一句')).toBeInTheDocument();
});

test('审阅门禁阻止总览直接验收，并指向任务页', async () => {
  const ready = { id: 'gated', title: '需要审阅', state: 'ready', accept_blocked: '需要审阅通过', summary: { dot: 'ready', text: '待验收', leaf: true, counts: {} } };
  open('#/', (call) => {
    if (call.path === '/api/tasks?top=1') return { tasks: [ready], children: [] };
    return overviewOf({ ...EMPTY, counts: { waiting: 0, moving: 0, ready: 1 } })(call);
  });
  const card = await screen.findByRole('region', { name: '待验收 · 需要审阅' });
  expect(within(card).getByText(/需要审阅通过/)).toBeInTheDocument();
  expect(within(card).queryByRole('button', { name: '验收通过' })).toBeNull();
  expect(within(card).getByRole('link', { name: '前往请求审阅' })).toHaveAttribute('href', '#/task/gated');
});

test('已归档项目的待验收任务不出现在总览待办和侧栏角标，且活跃任务可不填备注一键验收', async () => {
  const archivedProj = { id: 'p-arch', name: '已归档项目', archived_at: '2026-11-20T00:00:00.000Z' };
  const activeReady = { id: 't-active', project_id: P1.id, title: '活跃任务', state: 'ready', summary: { dot: 'ready', text: '待验收', leaf: true, counts: {} } };
  const archivedReady = { id: 't-arch', project_id: archivedProj.id, title: '归档残留任务', state: 'ready', summary: { dot: 'ready', text: '待验收', leaf: true, counts: {} } };
  const { user, calls } = open('#/', (call) => {
    if (call.path === '/api/projects') return { projects: [P1, archivedProj] };
    if (call.path === '/api/tasks?top=1') return { tasks: [activeReady, archivedReady], children: [] };
    if (call.method === 'POST' && call.path === '/api/tasks/t-active/accept') return { task: { ...activeReady, state: 'done' } };
    return overviewOf({ ...EMPTY, counts: { waiting: 0, moving: 0, ready: 1 } })(call);
  });
  const card = await screen.findByRole('region', { name: '待验收 · 活跃任务' });
  expect(screen.queryByRole('region', { name: '待验收 · 归档残留任务' })).toBeNull();
  const acceptBtn = within(card).getByRole('button', { name: '验收通过' });
  expect(acceptBtn).toBeEnabled();
  await user.click(acceptBtn);
  await waitFor(() => expect(calls).toContainEqual({ path: '/api/tasks/t-active/accept', method: 'POST', body: { basis: '' } }));
});

test('uncertain delivery failure shows explicit force-resend action instead of normal retry', async () => {
  const failures = [
    { id: 'uncertain/1', payload_json: '{"task_id":"t-wx"}', error: '微信发送结果未确认，避免重复推送已停止重试', created_at: '2026-11-05T00:00:00Z' },
    { id: 'normal-2', payload_json: '{"task_id":"t-ok"}', error: '网络超时', created_at: '2026-11-05T00:01:00Z' },
  ];
  const { user, calls } = open('#/', (call) => {
    if (call.method === 'POST' && call.path === '/api/outbox/uncertain%2F1/force-resend') return { resent: true };
    if (call.method === 'POST' && call.path === '/api/outbox/normal-2/retry') return { retried: true };
    if (call.path === '/api/overview') return { ...EMPTY, outbox: { given_up: 2, pending: 0, failures } };
    if (call.path === '/api/doctor') return { checks: [] };
    return undefined;
  });
  await page();
  const failed = column('发送失败的提醒');
  const forceBtn = within(failed).getByRole('button', { name: '确认未收到，强制补发' });
  const retryBtn = within(failed).getByRole('button', { name: '重试发送' });

  await user.click(forceBtn);
  await waitFor(() => expect(calls).toContainEqual({ path: '/api/outbox/uncertain%2F1/force-resend', method: 'POST', body: {} }));

  await user.click(retryBtn);
  await waitFor(() => expect(calls).toContainEqual({ path: '/api/outbox/normal-2/retry', method: 'POST', body: {} }));
});

test('ready tasks currently in automatic independent review appear in 正在进行 instead of 需要你处理', async () => {
  const reviewing = {
    id: 'rev-target', title: '自动审阅中的任务', state: 'ready', active_review: 'rev-1',
    review_gate: { kind: 'in_review', message: '正在审阅', review_task_id: 'rev-1' },
    summary: { dot: 'running', text: '正在独立审阅', leaf: true, counts: {} },
  };
  open('#/', (call) => {
    if (call.path === '/api/tasks?top=1') return { tasks: [reviewing], children: [] };
    return overviewOf({ ...EMPTY, counts: { waiting: 0, moving: 0, ready: 1 } })(call);
  });
  await page();
  expect(await headline('没有等你的事，1 项工作在推进')).toBeInTheDocument();
  expect(within(column('正在进行')).getByRole('link', { name: /自动审阅中的任务/ })).toBeInTheDocument();
  expect(within(column('需要你处理')).queryByText('自动审阅中的任务')).toBeNull();
});

test('parked_waiting tasks without an approval card render inside 需要你处理 and keep counts consistent', async () => {
  open('#/', overviewOf({
    ...EMPTY,
    counts: { waiting: 1, moving: 0, ready: 0 },
    parked_waiting: [{ id: 'p-wait', title: '缺职能的任务', state: 'waiting_person', reason: '需要选定职能后继续' }],
  }));
  expect(await headline('1 件等你决定')).toBeInTheDocument();
  const summary = screen.getByRole('list', { name: '工作概况' });
  expect(within(summary).getAllByRole('listitem')[0]).toHaveTextContent('1等你决定');
  const link = within(column('需要你处理')).getByRole('link', { name: /待处理：缺职能的任务/ });
  expect(link).toHaveAttribute('href', '#/task/p-wait');
  expect(link).toHaveTextContent('需要选定职能后继续');
});

test('slow /api/doctor does not block initial rendering of the overview', async () => {
  const slowDoctor = deferred();
  open('#/', (call) => {
    if (call.path === '/api/doctor') return slowDoctor.promise;
    if (call.path === '/api/overview') return { ...EMPTY, counts: { waiting: 0, moving: 2, ready: 0 } };
    return undefined;
  });
  expect(await headline('没有等你的事，2 项工作在推进')).toBeInTheDocument();
  expect(document.querySelector('[data-slot="skeleton-page"]')).toBeNull();
});
