// Guards the wording the pages share: a task that is its own work reading as a count
// ("1 个已停住") with its reason dropped, stopped work filed under "最近结束", a Run of
// unknown fate reading as in progress, raw event JSON reaching the owner, and a task
// whose machine is out of contact filed under what the owner must do, or shown with a
// deadline the rules do not keep: the time is when it may be continued, and past it the
// line has to name what the continuation is actually waiting for; a machine that answers
// and cannot tell read as one out of contact, with a time. And the top banner: a
// Router that is stopped shown without the way to put it right, a restart that reads as
// one under way while it still waits for a turn to end or for degraded mode or an
// inventory to be over, and the notes that were already there (degraded, recovering,
// paused, WeCom stopped) changing their words or order. And the gateway's line: a stopped
// one shown at all, ssh's many lines breaking the one line, a failure without its way out.
// And who changed a setting: an internal name reaching the owner.
// And the dates and state names every page shares: a time shown without its day once it
// is no longer today, and a raw state name reaching the owner inside a sentence.
// And what waits without the owner: a queued task that no target can take shown with no
// word on what it waits for or when, or in words that ask something of the owner; a
// resting or full target reading as a fault; usage shown without its window or its
// reset; and a round the quota ended reading as a failure.
import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  ACTION_TEXT, ACCOUNT_LOGIN_FIX, bannerNotes, changedByText, displayStateText, eventHeadline, exitKindLabels, gatewayNote, quotaEndLine, routerLine, runStateLabels, runTime, loginFull,
  loginLine, loginStatusLine, taskLine, taskStateLabels, usageLine, usageReadLine, waitLine, workGroup, type LoginStatus, type Wait,
} from '@shared/labels.ts';
import { formatTime, fullTime } from '@shared/time.ts';

const leaf = (dot: string, text: string) => ({ dot, text, counts: {}, leaf: true });
const container = (dot: string, text: string) => ({ dot, text, counts: {}, leaf: false });

test('a task with no children reads as its own state and reason, not as a count', () => {
  assert.equal(taskLine({ state: 'held', reason: '派发失败：没有可用的账号', summary: leaf('held', '1 个已停住') }),
    '已停住：派发失败：没有可用的账号');
  assert.equal(taskLine({ state: 'ready', reason: null, summary: leaf('ready', '1 个待验收') }), '待验收');
  assert.equal(taskLine({ state: 'abandoned', reason: '不再需要', summary: leaf('done', '已结束') }), '已放弃：不再需要');
  assert.equal(taskLine({ state: 'done', reason: null, summary: leaf('done', '已结束') }), '已完成');
  assert.equal(taskLine({ state: 'running', reason: null }), '执行中');
});

test('an open question outranks the state of the task that carries it', () => {
  assert.equal(taskLine({ state: 'running', reason: null, summary: leaf('waiting_person', '1 个等你决定') }), '等你决定');
});

test('a work with children keeps its counts', () => {
  assert.equal(taskLine({ state: 'draft', reason: null, summary: container('held', '1 个待验收，1 个已停住') }), '1 个待验收，1 个已停住');
});

test('a task whose machine is out of contact says from when the rules may continue it and what they wait for, never a deadline', () => {
  const now = new Date(2026, 10, 5, 10, 0).getTime();
  const at = (minutes: number) => new Date(now + minutes * 60_000).toISOString();
  type Blocked = 'paused' | 'project_paused' | 'project_archived' | 'recovering' | 'no_machine' | 'limit' | null;
  const line = (lost: { eligible_at: string | null; stopping: boolean; blocked: Blocked } | undefined) =>
    taskLine({ state: 'needs_verification', reason: '执行机器失联，核实中', summary: leaf('needs_verification', '1 个执行机器失联'), lost }, now);
  const waiting = (minutes: number, blocked: Blocked = null) => line({ eligible_at: at(minutes), stopping: false, blocked });

  // Inside the grace period: when the Task becomes eligible, whatever else is true.
  assert.equal(waiting(7), '执行机器失联：10:07 后可自动接续');
  assert.equal(waiting(7, 'no_machine'), '执行机器失联：10:07 后可自动接续');
  // Past it: what actually stands in the way.
  assert.equal(waiting(-1, 'paused'), '执行机器失联：派发已暂停，恢复派发后接续');
  assert.equal(waiting(-1, 'project_paused'), '执行机器失联：项目已暂停，恢复后接续');
  assert.equal(waiting(-1, 'project_archived'), '执行机器失联：项目已归档，恢复后接续');
  assert.equal(waiting(-1, 'recovering'), '执行机器失联：恢复清点中');
  assert.equal(waiting(-1, 'no_machine'), '执行机器失联：等可用的机器');
  assert.equal(waiting(-1, 'limit'), '执行机器失联：已到连续丢失上限');
  assert.equal(waiting(-1), '执行机器失联：等待接续');
  // A stop needs no machine and no dispatch: only the time.
  assert.equal(line({ eligible_at: at(7), stopping: true, blocked: 'no_machine' }), '执行机器失联：10:07 后按已中断结算');
  assert.equal(line({ eligible_at: at(-1), stopping: true, blocked: 'paused' }), '执行机器失联：09:59 后按已中断结算');
  assert.equal(line(undefined), '执行机器失联');
  assert.equal(line({ eligible_at: null, stopping: false, blocked: null }), '执行机器失联');
  for (const text of [waiting(7), waiting(-1), waiting(-1, 'no_machine'), line({ eligible_at: at(7), stopping: true, blocked: null })]) {
    assert.doesNotMatch(text, /需要你|核实|最迟|即将/, '既不找人，也不许诺期限');
  }
  // A Run whose target the ledger never held is not a machine out of contact, and waits for no time.
  assert.equal(
    taskLine({ state: 'needs_verification', reason: null, lost: { eligible_at: null, stopping: false, blocked: 'recovering', missing_login: 't1' } }, now),
    '账本里没有账号 t1 的配置：需要重新选择登录，同名新建的账号或机器登录不会接续这份引用',
  );
  // A machine that answers and cannot tell is not out of contact either, and no time ends it.
  const said = taskLine({ state: 'needs_verification', reason: null, lost: { eligible_at: null, stopping: false, blocked: null, unverifiable: '读不出 exit：EACCES' } }, now);
  assert.equal(said, '机器在线，但核实不了这一轮，等它能核实：读不出 exit：EACCES');
  assert.doesNotMatch(said, /失联|后可自动接续/);
});

test('a queued task shows the reason it is waiting when the server gives one', () => {
  assert.equal(taskLine({ state: 'queued', reason: '等可用的机器', summary: leaf('running', '1 个在执行') }), '排队中：等可用的机器');
});

test('stopped work waits for the owner; only finished work is recent', () => {
  const group = (state: string, dot = state) => workGroup({ state, summary: { dot } });
  assert.equal(group('held'), '等你');
  assert.equal(group('needs_verification'), '在推进', '执行机器失联归在推进，不归等你');
  assert.equal(group('waiting_person'), '等你');
  assert.equal(group('ready'), '待验收');
  assert.equal(group('done'), '最近结束');
  assert.equal(group('abandoned', 'done'), '最近结束');
  assert.equal(group('running'), '在推进');
  assert.equal(group('draft', 'held'), '等你');
  assert.equal(workGroup({ state: 'queued' }), '在推进');
});

test('a Run of unknown fate never reads as in progress', () => {
  const now = Date.parse('2026-11-05T10:10:00Z');
  assert.equal(runTime(null, now), '尚未执行');
  assert.equal(runTime({ state: 'unknown', started_at: '2026-11-05T10:00:00Z', created_at: '2026-11-05T10:00:00Z' }, now), '执行情况未知');
  assert.equal(runTime({ state: 'running', started_at: '2026-11-05T10:00:00Z', created_at: '2026-11-05T09:00:00Z' }, now), '进行中 10 分钟');
  assert.match(runTime({ state: 'ended', ended_at: '2026-11-05T10:05:00Z', created_at: '2026-11-05T10:00:00Z' }, now), /\d/);
});

test('an internal event shows its sentence, not its payload', () => {
  assert.equal(eventHeadline('任务“甲”的 Run 已结算，任务转为 ready\n{"task_id":"t","receipt":null}'), '任务“甲”的 Run 已结算，任务转为 待验收');
  assert.equal(eventHeadline('一句普通的话'), '一句普通的话');
});

const steady = { degraded: false, recovering: false, paused: false };
const running = { alive: true, error: null, restarting: false, turn: null };
const banner = (state: Partial<Parameters<typeof bannerNotes>[0]>) => bannerNotes({ dispatch: steady, router: running, channels: { wecom: null }, ...state });

test('a stopped Router is said in the banner with its reason and the way to where it is restarted', () => {
  assert.deepEqual(banner({ router: { ...running, alive: false, error: '在 PATH 里没有找到 claude' } }),
    [{ text: '负责人已停摆：在 PATH 里没有找到 claude', href: '#/settings/router.cli', label: '去设置' }]);
  assert.deepEqual(banner({}), [], '一切正常时横幅不出现');
});

test('a restart is said in the banner, and one that waits for the turn under way says so', () => {
  assert.deepEqual(banner({ router: { ...running, restarting: true } }), [{ text: '负责人正在重启' }]);
  const [waiting] = banner({ router: { ...running, restarting: true, turn: 'm1' } });
  assert.match(waiting!.text, /当前这一回合结束后重启.*打断/);
  assert.equal(waiting!.href, undefined);
  assert.deepEqual(banner({ router: { alive: false, error: '档位文件不存在', restarting: true, turn: null } }).map(({ text }) => text),
    ['负责人已停摆：档位文件不存在', '负责人正在重启'], '重启还没做完，停摆的原因照样说');
});

test('a restart held back by a barrier says which one it waits for, in the banner and in the Router line', () => {
  const held = { ...running, alive: false, restarting: true };
  assert.equal(routerLine({ ...held, waiting: 'recovering' }), '已受理重启负责人：等恢复清点结束后启动');
  assert.equal(routerLine({ ...held, waiting: 'degraded' }), '已受理重启负责人：等账本恢复写入后启动');
  assert.deepEqual(banner({ dispatch: { ...steady, recovering: true }, router: { ...held, waiting: 'recovering' } }).map(({ text }) => text),
    ['正在恢复清点，暂不派发、不处理消息、不发通知', '已受理重启负责人：等恢复清点结束后启动']);
  assert.deepEqual(banner({ dispatch: { ...steady, degraded: true }, router: { ...held, waiting: 'degraded' } }).map(({ text }) => text),
    ['账本写入失败，派发已停止', '已受理重启负责人：等账本恢复写入后启动']);
  // Nothing holds it: the lines there were.
  assert.equal(routerLine({ ...held, waiting: null }), '负责人正在重启');
  assert.match(routerLine({ ...running, restarting: true, turn: 'm1', waiting: null }), /当前这一回合结束后重启/);
});

test('the notes the banner already had keep their words and their order', () => {
  assert.deepEqual(banner({
    dispatch: { degraded: true, recovering: true, paused: true },
    router: { ...running, error: '负责人进程起不来' },
    channels: { wecom: { error: '没有设置 Secret' } },
  }).map(({ text }) => text), [
    '账本写入失败，派发已停止',
    '正在恢复清点，暂不派发、不处理消息、不发通知',
    '派发已暂停',
    '负责人已停摆：负责人进程起不来',
    '企微已停止：没有设置 Secret',
  ]);
  assert.deepEqual(banner({ dispatch: { ...steady, paused: true } }), [{ text: '派发已暂停' }], '只有负责人停摆带链接');
  assert.deepEqual(banner({ channels: undefined }), []);
  // The ledger out of reach: paused is unknown, which is not "paused".
  assert.deepEqual(banner({ dispatch: { degraded: true, recovering: false, paused: null } }).map(({ text }) => text), ['账本写入失败，派发已停止']);
});

test('the Router reads as one line: a restart asked for comes before why it is stopped, and stopped never reads as running', () => {
  assert.equal(routerLine(running), '负责人在运行');
  assert.equal(routerLine({ ...running, alive: false }), '负责人现在没有在运行，有消息来时会自动启动');
  assert.equal(routerLine({ ...running, alive: true, error: '没有登录' }), '负责人已停摆：没有登录');
  assert.equal(routerLine({ ...running, alive: false, error: '没有登录', restarting: true }), '负责人正在重启');
  assert.match(routerLine({ ...running, restarting: true, turn: 'm1' }), /当前这一回合结束后重启/);
});

test('missing parts of a target leave no empty separators', () => {
  assert.equal(loginLine([undefined, '', '未指定']), '未指定');
  assert.equal(loginLine(['demo-target', 'demo-host', 'execute']), 'demo-target · demo-host · execute');
  assert.equal(loginLine([null, undefined, '']), '未指定');
});

test('all Console dates share calendar-aware short text and retain full time', () => {
  const now = new Date(2026, 10, 5, 15, 0);
  assert.equal(formatTime(new Date(2026, 10, 5, 9, 3), now), '09:03');
  assert.equal(formatTime(new Date(2026, 10, 4, 23, 59), now), '昨天 23:59');
  assert.equal(formatTime(new Date(2026, 9, 31, 9, 3), now), '10-31 09:03');
  assert.equal(formatTime(new Date(2025, 11, 31, 9, 3), now), '2025-12-31 09:03');
  assert.equal(formatTime(new Date(2025, 11, 31, 9, 3), new Date(2026, 0, 1)), '2025-12-31 09:03');
  assert.equal(formatTime(null, now), '—');
  assert.match(fullTime(new Date(2026, 10, 5, 9, 3)), /2026/);
});

test('internal event summaries and task labels use one Chinese state table', () => {
  assert.equal(displayStateText('任务进入 needs_verification；Run unknown'), `任务进入 ${taskStateLabels.needs_verification}；Run ${runStateLabels.unknown}`);
  assert.equal(displayStateText('task.running 是 action'), 'task.running 是 action');
});

test('state translation preserves a task title that happens to be a state name', () => {
  assert.equal(displayStateText('任务“ready”的 Run 已结算，任务转为 held'), '任务“ready”的 Run 已结算，任务转为 已停住');
});

test('who changed a setting reads in the owner\'s words, the import keeps its own, and a value nobody named is shown as it is', () => {
  assert.equal(changedByText('console'), '由网页修改');
  assert.equal(changedByText('import'), '导入旧配置时修改');
  for (const [actor, text] of [['router', '由负责人修改'], ['service', '由服务修改'], ['runner', '由执行器修改'], ['dispatcher', '由派发修改'], ['timer', '由定时器修改'], ['session-host', '由负责人会话修改']]) {
    assert.equal(changedByText(actor!), text);
  }
  assert.equal(changedByText('zhangsan'), '由zhangsan修改', '企微里的人以账号记账，原样显示');
});

const TEN_35 = new Date(2026, 10, 6, 10, 35);

test('the gateway line says nothing when it is off, and puts what ssh said on one line', () => {
  assert.equal(gatewayNote({ state: 'off', since: null, error: null }), null);
  assert.deepEqual(gatewayNote({ state: 'connecting', since: null, error: null }), { text: '门牌：连接中', failed: false });
  assert.equal(gatewayNote({ state: 'connecting', since: null, error: 'refused\nagain\r\nand again\n' })!.text, '门牌：连接中，上一次没连上：refused；again；and again');
});

test('a connected gateway says since when, with the day once that is no longer today', () => {
  const connected = { state: 'connected', since: TEN_35.toISOString(), error: null };
  assert.deepEqual(gatewayNote(connected, TEN_35.getTime()), { text: '门牌：已连接（10:35 起）', failed: false });
  assert.equal(gatewayNote(connected, new Date(2026, 10, 7, 9).getTime())!.text, '门牌：已连接（昨天 10:35 起）');
});

test('a gateway that cannot be reached is a failure, with ssh\'s words and the way to its setting', () => {
  assert.deepEqual(gatewayNote({ state: 'down', since: null, error: 'no route\nto host' }), {
    text: '门牌：连不上，正在重试：no route；to host',
    failed: true,
    href: '#/settings/gateway.ssh',
    label: '去设置',
  });
  assert.equal(gatewayNote({ state: 'down', since: null, error: null })!.text, '门牌：连不上，正在重试', '没有原因就不留一个空的冒号');
});

test('a queued task that no target can take says what it waits for and about when, in the words of what ends by itself', () => {
  const now = new Date(2026, 10, 6, 5, 0).getTime();
  const at = (minutes: number) => new Date(now + minutes * 60_000).toISOString();
  const queued = (waiting: Wait | null, reason: string | null = null) => taskLine({ state: 'queued', reason, summary: leaf('running', '1 个在执行'), waiting }, now);
  assert.equal(queued({ rest: { login: 'cluster-claude', until: at(100) }, full: [], no_machine: [] }), '排队中：等额度恢复，约 06:40');
  assert.equal(queued({ rest: null, full: ['cluster-codex'], no_machine: [] }), '排队中：等 账号 cluster-codex 空出来');
  assert.equal(queued({ rest: null, full: ['a', 'b'], no_machine: [] }), '排队中：等 账号 a、账号 b 空出来');
  assert.equal(queued({ rest: null, full: [], no_machine: ['a'] }), '排队中：等可用的机器');
  // A machine's own login is named by its machine and executor.
  assert.equal(queued({ rest: null, full: ['gpu-1/codex'], no_machine: [] }), '排队中：等 机器 gpu-1 上的 codex 登录 空出来');
  // Several at once: whichever ends first lets the Task go.
  assert.equal(queued({ rest: { login: 'a', until: at(100) }, full: ['b'], no_machine: ['c'] }), '排队中：等 账号 b 空出来；或等额度恢复，约 06:40；或等可用的机器');
  // A time on another day carries its day.
  assert.equal(queued({ rest: { login: 'a', until: at(24 * 60 + 100) }, full: [], no_machine: [] }), '排队中：等额度恢复，约 11-07 06:40');
  assert.equal(queued(null), '排队中');
  assert.equal(queued({ rest: null, full: [], no_machine: [] }, '别的原因'), '排队中：别的原因');
  assert.equal(waitLine(undefined), null);
  for (const text of [queued({ rest: { login: 'a', until: at(100) }, full: ['b'], no_machine: ['c'] })]) assert.doesNotMatch(text, /需要你|失败|处理/);
  // Only the queue reads it: a Task in another state does not show a stale wait.
  assert.equal(taskLine({ state: 'running', reason: null, waiting: { rest: null, full: ['a'], no_machine: [] } }, now), '执行中');
  assert.equal(workGroup({ state: 'queued' }), '在推进');
});

test('a task whose machine is out of contact, past its time, says exactly what its continuation waits for', () => {
  const now = new Date(2026, 10, 6, 5, 0).getTime();
  const at = (minutes: number) => new Date(now + minutes * 60_000).toISOString();
  const line = (waiting: Wait | null | undefined) => taskLine({
    state: 'needs_verification', reason: null, lost: { eligible_at: at(-1), stopping: false, blocked: 'no_machine', ...(waiting === undefined ? {} : { waiting }) },
  }, now);
  assert.equal(line({ rest: { login: 'a', until: at(100) }, full: [], no_machine: [] }), '执行机器失联：等额度恢复，约 06:40');
  assert.equal(line({ rest: null, full: ['a'], no_machine: [] }), '执行机器失联：等 账号 a 空出来');
  assert.equal(line({ rest: null, full: [], no_machine: ['a'] }), '执行机器失联：等可用的机器');
  assert.equal(line(undefined), '执行机器失联：等可用的机器');
});

// Also guards model windows losing their model and unknown windows losing their identifier.
test('usage reads as the window, the remaining share and when it starts over', () => {
  const now = new Date(2026, 10, 6, 5, 0).getTime();
  const at = new Date(2026, 10, 6, 4, 0).toISOString();
  const resets = new Date(2026, 10, 6, 6, 40).toISOString();
  assert.equal(usageLine({ window: 'five_hour', used: 0.82, resets_at: resets, at }, now), '5 小时窗口 剩 18%，06:40 重置');
  assert.equal(usageLine({ window: 'seven_day', used: 0.515, resets_at: new Date(2026, 10, 9, 8, 0).toISOString(), at }, now), '7 天窗口 剩 49%，11-09 08:00 重置');
  assert.equal(usageLine({ window: 'seven_day_fable', used: 0.45, resets_at: null, at }, now), '7 天窗口（Fable） 剩 55%');
  for (const model of ['opus', 'sonnet']) {
    assert.equal(usageLine({ window: `seven_day_${model}`, used: 0.45, resets_at: null, at }, now), `7 天窗口（${model}） 剩 55%`);
  }
  assert.equal(usageLine({ window: 'opus_weekly', used: 1, resets_at: null, at }, now), 'opus_weekly 剩 0%');
  assert.equal(usageLine({ window: 'constructor', used: 1, resets_at: null, at }, now), 'constructor 剩 0%');
});

// Guards an old figure shown as this moment's: the page says when the figures were read,
// by the oldest of them, and that what was spent since is not in them.
test('usage says when it was read, by the oldest figure', () => {
  const now = new Date(2026, 10, 10, 17, 35).getTime();
  const figure = (at: Date) => ({ window: 'seven_day', used: 0.85, resets_at: null, at: at.toISOString() });
  assert.equal(usageReadLine([], now), undefined);
  assert.equal(
    usageReadLine([figure(new Date(2026, 10, 10, 12, 34)), figure(new Date(2026, 10, 10, 12, 33))], now),
    '读于 12:33',
  );
  assert.match(usageReadLine([figure(new Date(2026, 10, 8, 9, 0))], now)!, /^读于 11-08 09:00$/);
});

test('a target reads as usable, resting until a time, or at its ceiling, and never as broken', () => {
  const now = new Date(2026, 10, 6, 5, 0).getTime();
  const status = (over: Partial<LoginStatus> = {}): LoginStatus => ({ active_runs: 0, max_runs: null, rest: null, usage: [], ...over });
  assert.equal(loginStatusLine(status(), now), '可用');
  assert.equal(loginStatusLine(status({ active_runs: 3 }), now), '可用，在跑 3 轮');
  assert.equal(loginStatusLine(status({ active_runs: 1, max_runs: 2 }), now), '可用，在跑 1 轮');
  assert.equal(loginStatusLine(status({ active_runs: 2, max_runs: 2 }), now), '已到并发上限：在跑 2 轮，最多 2 轮');
  assert.equal(loginFull(status({ active_runs: 2, max_runs: 2 })), true);
  assert.equal(loginFull(status({ active_runs: 9 })), false);
  // Resting comes first: it is why nothing new starts, whatever still runs.
  const resting = status({ active_runs: 2, max_runs: 2, rest: { until: new Date(2026, 10, 6, 6, 40).toISOString(), reason: 'limit' } });
  assert.equal(loginStatusLine(resting, now), '歇着：额度用完，约 06:40 再试');
});

test('a round the quota ended says where, until when that target rests, and that the Task goes on by itself', () => {
  const now = new Date(2026, 10, 6, 5, 0).getTime();
  const until = new Date(2026, 10, 6, 6, 40).toISOString();
  assert.equal(quotaEndLine({ account_id: 'cluster-claude', rest_until: until }, now),
    '账号 cluster-claude 的额度用完，它歇到 06:40。任务已回到队列：额度恢复后，或换到项目里别的登录上，自动接续');
  assert.equal(quotaEndLine({ account_id: 'gone' }, now), '账号 gone 的额度用完。任务已回到队列：额度恢复后，或换到项目里别的登录上，自动接续');
  assert.equal(quotaEndLine(undefined, now), '执行器的额度用完，任务已回到队列，自动接续');
  assert.equal(exitKindLabels.quota, '额度用完');
});

// Existing ended Runs retain their original error JSON across migration.
test('a pre-migration quota record still names the account in the owner wording', () => {
  assert.equal(quotaEndLine({ target_id: 'old-account', rest_until: null }), '账号 old-account 的额度用完。任务已回到队列：额度恢复后，或换到项目里别的登录上，自动接续');
});


// Guards a rejected credential from reading as a timed wait that will heal itself.
test('a rejected credential names the account and asks for a new token without a retry time', () => {
  const waiting = { rest: null, full: [], no_machine: [], rejected: ['claude-a', 'claude-b'] };
  assert.equal(waitLine(waiting), `账号 claude-a、账号 claude-b：登录失效，${ACCOUNT_LOGIN_FIX}`);
  assert.equal(taskLine({ state: 'queued', waiting }), `排队中：账号 claude-a、账号 claude-b：登录失效，${ACCOUNT_LOGIN_FIX}`);
  assert.equal(exitKindLabels.auth, '登录失效');
});

test('没有符合条件的登录时说明接续在等什么', () => {
  assert.match(waitLine({ rest: null, full: [], no_machine: [], no_candidate: true }) ?? '', /没有符合任务条件的登录/);
});


test('output waiting explains available capacity without claiming an upgrade is necessary', () => {
  const line = waitLine({ rest: null, full: [], no_machine: [], output_waiting: ['h1'] });
  assert.equal(line, '等 h1 提供可用的待传输出容量；到机器页检查版本、存储状态和占用');
  assert.doesNotMatch(line ?? '', /升级/);
});


test('legacy output disposition actions name what happened for the owner', () => {
  assert.equal(ACTION_TEXT['run.output_custody'], '旧原始输出已确认处置');
  assert.equal(ACTION_TEXT['run.output_retained'], '旧原始输出继续保留');
});
