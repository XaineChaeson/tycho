// Guards against hiding stale quota while reading, missing or endless polling, and unclear empty or unavailable states.
// Guards the usage page against: a login's quota shown without when it was read, or a failed
// read hidden behind the old figures; the page asking every quota again each time it opens
// instead of only the stale ones, or asking twice; a refresh offered for a machine's own login,
// which the host cannot ask; the use summed under the wrong group, a Router turn or a quota read
// mixed into a project's own work, a model the executor did not name passed off as its word; a
// price shown where the executor gave none, or rounds without a figure counted as using nothing.
import { screen, waitFor, within } from '@testing-library/react';
import { expect, test } from 'vitest';
import type { QuotaPage, UsageReport } from '@shared/usage.ts';
import { open, refusal, type Handler } from '@/test/harness';
import { rangeOf } from '@/lib/usage';

const today = rangeOf(7).days.at(-1)!;
const figures = (input: number, cost = 0, unpriced = 0) => ({ input, output: 10, cache_read: 100, cache_write: 0, list_cost_usd: cost, unpriced });
const unit = (over: object) => ({ day: today, source: 'run', project_id: 'p1', project_dropped: false, role_id: 'implement', tier: 'execute', login_id: 'a1', executor: 'claude', units: 1, without_usage: 0, duration_ms: 600_000, ...over });
const cell = (over: object) => ({ day: today, source: 'run', project_id: 'p1', project_dropped: false, role_id: 'implement', tier: 'execute', login_id: 'a1', executor: 'claude', model: 'model-a', model_basis: 'reported', units: 1, ...figures(1000, 0.5), ...over });

const REPORT: UsageReport = {
  from: '', to: '', tz_offset_minutes: 480,
  units: [
    unit({}),
    unit({ project_id: 'p2', login_id: 'a2', executor: 'codex', units: 2, without_usage: 1, duration_ms: 1_200_000 }),
    unit({ source: 'router', role_id: null, tier: null, duration_ms: 0, units: 3 }),
    unit({ source: 'quota', project_id: null, role_id: null, tier: null, duration_ms: 0 }),
  ] as UsageReport['units'],
  usage: [
    cell({}),
    cell({ project_id: 'p2', login_id: 'a2', executor: 'codex', model: 'gpt-x', model_basis: 'tier', ...figures(5000, 0, 1) }),
    cell({ source: 'router', role_id: null, tier: null, units: 3, ...figures(200, 0.1) }),
    cell({ source: 'quota', project_id: null, role_id: null, tier: null, ...figures(3, 0.001) }),
  ] as UsageReport['usage'],
  top_tasks: [{ task_id: 't1', title: '改登录页', project_id: 'p2', rounds: 2, ...figures(5000, 0, 1) }],
  names: { projects: { p1: '甲项目', p2: '乙项目' }, roles: { implement: '实现' }, logins: { a1: '主账号', a2: 'codex 账号' } },
};

const QUOTA: QuotaPage = {
  stale_ms: 600_000,
  logins: [
    {
      login_id: 'a1', name: '主账号', machine: null, executor: 'claude',
      status: { active_runs: 0, max_runs: null, rest: null, usage: [{ window: 'five_hour', used: 0.42, resets_at: null, at: new Date().toISOString() }] },
      read: { available: true, reading: false, tried_at: null, failure: null },
    },
    {
      login_id: 'a2', name: 'codex 账号', machine: null, executor: 'codex',
      status: { active_runs: 0, max_runs: null, rest: null, usage: [] },
      read: { available: false, why: '这个执行器不报额度', reading: false, tried_at: null, failure: null },
    },
    {
      login_id: 'm1', name: 'h1/claude', machine: 'h1', executor: 'claude',
      status: { active_runs: 0, max_runs: null, rest: null, usage: [] },
      read: { available: false, why: '机器自己的登录在它那台机器上，主机问不了；它干活时会更新', reading: false, tried_at: null, failure: null },
    },
  ],
};

function service(report: UsageReport = REPORT, refresh: Handler = () => QUOTA, quota: QuotaPage = QUOTA): Handler {
  return (call) => {
    if (call.method === 'GET' && call.path === '/api/quota') return quota;
    if (call.method === 'GET' && call.path.startsWith('/api/usage?')) return report;
    if (call.method === 'POST' && call.path === '/api/quota/refresh') return refresh(call);
    return undefined;
  };
}

const row = (name: string) => screen.findByRole('region', { name });

test('each login says what is left and when it was read; only an account the host can ask has a refresh', async () => {
  const page = open('#/usage', service());
  const main = await row('主账号');
  expect(main).toHaveTextContent('5 小时窗口 剩 58%');
  expect(main).toHaveTextContent(/读于 \d\d:\d\d/);
  expect(within(main).getByRole('button', { name: '刷新' })).toBeEnabled();
  expect(await row('codex 账号')).toHaveTextContent('这个执行器不报额度');
  await page.user.click(await screen.findByText(/^不提供额度的单机登录/));
  const own = await row('机器 h1 上的 claude 登录');
  expect(own).toHaveTextContent('主机问不了');
  expect(within(own).queryByRole('button', { name: '刷新' })).toBeNull();
  // Opening asks for the stale ones once, StrictMode and all.
  await waitFor(() => expect(page.calls.filter((call) => call.path === '/api/quota/refresh')).toEqual([{ path: '/api/quota/refresh', method: 'POST', body: {} }]));
  await page.user.click(within(main).getByRole('button', { name: '刷新' }));
  await waitFor(() => expect(page.calls.at(-1)).toEqual({ path: '/api/quota/refresh', method: 'POST', body: { login_id: 'a1' } }));
  await page.user.click(screen.getByRole('button', { name: '刷新额度' }));
  await waitFor(() => expect(page.calls.at(-1)).toEqual({ path: '/api/quota/refresh', method: 'POST', body: { all: true } }));
});

test('model windows name the model, and unfamiliar windows keep their identifier', async () => {
  const quota: QuotaPage = { ...QUOTA, logins: [{ ...QUOTA.logins[0]!, status: { ...QUOTA.logins[0]!.status, usage: [
    { window: 'seven_day_fable', used: 0.45, resets_at: null, at: new Date().toISOString() },
    { window: 'other_60m', used: 0.2, resets_at: null, at: new Date().toISOString() },
  ] } }] };
  open('#/usage', service(REPORT, () => quota, quota));
  const main = await row('主账号');
  expect(main).toHaveTextContent('7 天窗口（Fable） 剩 55%');
  expect(main).toHaveTextContent('other_60m 剩 80%');
});

test('reading keeps the last figures and time visible, then polls until reading ends', async () => {
  const reading: QuotaPage = { ...QUOTA, logins: [{ ...QUOTA.logins[0]!, read: { ...QUOTA.logins[0]!.read, reading: true } }] };
  let reads = 0;
  open('#/usage', (call) => {
    if (call.path === '/api/quota' && call.method === 'GET') return ++reads < 3 ? reading : QUOTA;
    return service(REPORT, () => reading)(call);
  });
  const main = await row('主账号');
  expect(main).toHaveTextContent('5 小时窗口 剩 58%');
  expect(main).toHaveTextContent(/读于 \d\d:\d\d/);
  expect(main).toHaveTextContent('正在刷新');
  expect(main).not.toHaveTextContent('问执行器');
  await waitFor(() => expect(reads).toBeGreaterThanOrEqual(3), { timeout: 5000 });
  await waitFor(() => expect(main).not.toHaveTextContent('正在刷新'));
  const count = reads;
  await new Promise((resolve) => setTimeout(resolve, 2200));
  expect(reads).toBe(count);
}, 10000);

test('empty readings explain whether they are being read, can be refreshed, or are unavailable', async () => {
  const empty: QuotaPage = { ...QUOTA, logins: [
    { ...QUOTA.logins[0]!, status: { ...QUOTA.logins[0]!.status, usage: [] }, read: { ...QUOTA.logins[0]!.read, reading: true } },
    { ...QUOTA.logins[1]!, name: '未读取', read: { ...QUOTA.logins[1]!.read, available: true } },
    QUOTA.logins[2]!,
  ] };
  open('#/usage', service(REPORT, () => empty, empty));
  expect(await row('主账号')).toHaveTextContent('正在读取…');
  expect(await row('未读取')).toHaveTextContent('还没读过，点“刷新”读一次');
  expect(await row('机器 h1 上的 claude 登录')).toHaveTextContent('主机问不了');
});

test('a read that learned nothing says why beside the figures it kept', async () => {
  const failed: QuotaPage = { ...QUOTA, logins: [{ ...QUOTA.logins[0]!, read: { available: true, reading: false, tried_at: new Date().toISOString(), failure: '60 秒内没有答复' } }] };
  open('#/usage', service(REPORT, () => failed, failed));
  await waitFor(async () => expect(await row('主账号')).toHaveTextContent('没读到：60 秒内没有答复'));
  expect(await row('主账号')).toHaveTextContent('5 小时窗口 剩 58%');
});

test('a refresh the service refuses says so', async () => {
  open('#/usage', service(REPORT, () => { throw refusal('没有可以读额度的地方', 503); }));
  expect(await screen.findByRole('alert')).toHaveTextContent('没有可以读额度的地方');
});

test('use adds up by project, with the Router and quota reads apart, and by model with what the tier asked for marked', async () => {
  const page = open('#/usage', service());
  const table = await screen.findByRole('table', { name: '按项目分的用量' });
  const line = (name: string) => within(table).getByRole('row', { name: new RegExp(`^${name}`) });
  // The Router's turns in a project are that project's use.
  expect(line('甲项目')).toHaveTextContent('1,200');
  expect(line('乙项目')).toHaveTextContent('5,000');
  expect(line('乙项目')).toHaveTextContent('无数据');
  expect(line('额度查询')).toHaveTextContent('3');
  // A round without a figure is still a round.
  expect(within(line('乙项目')).getAllByRole('cell')[0]).toHaveTextContent('2');
  expect(within(line('甲项目')).getAllByRole('cell')[0]).toHaveTextContent('4');
  expect(screen.getByText('其中 1 轮执行器没有报用量：多是被打断、丢失或在用量记录之前跑的轮次。')).toBeInTheDocument();
  expect(screen.getByText('3 轮')).toBeInTheDocument();
  expect(screen.getByText('负责人 3 个回合')).toBeInTheDocument();

  await page.user.click(screen.getByRole('radio', { name: '职能' }));
  const roles = await screen.findByRole('table', { name: '按职能分的用量' });
  expect(within(roles).getByRole('row', { name: /^负责人/ })).toHaveTextContent('200');
  expect(within(roles).getByRole('row', { name: /^实现/ })).toBeInTheDocument();

  await page.user.click(screen.getByRole('radio', { name: '档位' }));
  const tiers = await screen.findByRole('table', { name: '按档位分的用量' });
  expect(within(tiers).getByRole('row', { name: /^执行档/ })).toHaveTextContent('6,000');
  expect(within(tiers).getByRole('row', { name: /^负责人/ })).toBeInTheDocument();

  await page.user.click(screen.getByRole('radio', { name: '模型' }));
  const models = await screen.findByRole('table', { name: '按模型分的用量' });
  expect(within(models).getByRole('row', { name: /^gpt-x（按档位）/ })).toHaveTextContent('5,000');
  expect(within(models).queryByRole('columnheader', { name: '执行时长' })).toBeNull();

  const top = screen.getByRole('link', { name: /改登录页/ });
  expect(top).toHaveAttribute('href', '#/task/t1');
});

test('a group whose rounds reported nothing shows no figure rather than zero', async () => {
  open('#/usage', service({ ...REPORT, units: [unit({ project_id: 'p2', without_usage: 1 })] as UsageReport['units'], usage: [], top_tasks: [] }));
  const table = await screen.findByRole('table', { name: '按项目分的用量' });
  const cells = within(within(table).getByRole('row', { name: /^乙项目/ })).getAllByRole('cell').map((each) => each.textContent);
  expect(cells.slice(1, 7)).toEqual(['—', '—', '—', '—', '—', '—']);
});

test('a range with nothing in it says so instead of drawing zeros', async () => {
  open('#/usage', service({ ...REPORT, units: [], usage: [], top_tasks: [] }));
  expect(await screen.findByText('这段时间没有用量记录')).toBeInTheDocument();
});

test('a deleted project\'s use is a class of its own, kept with its unit, not a quota read', async () => {
  open('#/usage', service({
    ...REPORT,
    units: [unit({ project_id: null, project_dropped: true, role_id: null, tier: null, units: 1, duration_ms: 0 })] as UsageReport['units'],
    usage: [cell({ project_id: null, project_dropped: true, role_id: null, tier: null, units: 1, ...figures(10, 0) })] as UsageReport['usage'],
    top_tasks: [],
  }));
  const table = await screen.findByRole('table', { name: '按项目分的用量' });
  const line = within(table).getByRole('row', { name: /^已删除的项目/ });
  // The unit count and the figures stay, whatever the project's rows are gone.
  expect(within(line).getAllByRole('cell')[0]).toHaveTextContent('1');
  expect(within(line).getAllByRole('cell')[1]).toHaveTextContent('10');
  expect(within(table).queryByRole('row', { name: /^额度查询/ })).toBeNull();
  expect(within(table).queryByRole('row', { name: /^不属于项目/ })).toBeNull();
});

test('usage page unifies multi-machine Gemini logins, formats DSH gateway balance, and rolls up by account dimension', async () => {
  const now = new Date().toISOString();
  const quota: QuotaPage = {
    stale_ms: 600_000,
    logins: [
      {
        login_id: 'dsh1', name: 'DEV-WORKSTATION/dsh', machine: 'DEV-WORKSTATION', executor: 'dsh',
        status: { active_runs: 0, max_runs: null, rest: null, usage: [
          { window: 'balance:CNY:39.84', used: 0, resets_at: null, at: now },
          { window: 'gateway_unlimited:custom_gw:$412.08', used: 0, resets_at: null, at: now },
        ] },
        read: { available: true, reading: false, tried_at: now, failure: null },
        telemetry: { five_hour_tokens: 0, five_hour_runs: 0, day_tokens: 54_500_000, day_runs: 4, week_tokens: 95_700_000, week_runs: 13, total_tokens: 95_700_000, total_runs: 13, last_at: now },
      },
      {
        login_id: 'g1', name: 'DEV-WORKSTATION/gemini', machine: 'DEV-WORKSTATION', executor: 'gemini',
        status: { active_runs: 0, max_runs: null, rest: null, usage: [
          { window: 'five_hour', used: 0.03, resets_at: null, at: now },
          { window: 'seven_day', used: 0.13, resets_at: null, at: now },
        ] },
        read: { available: true, reading: false, tried_at: now, failure: null },
        telemetry: { five_hour_tokens: 7_700_000, five_hour_runs: 2, day_tokens: 7_700_000, day_runs: 2, week_tokens: 13_000_000, week_runs: 5, total_tokens: 13_000_000, total_runs: 5, last_at: now },
      },
      {
        login_id: 'g2', name: 'kr/gemini', machine: 'kr', executor: 'gemini',
        status: { active_runs: 0, max_runs: null, rest: null, usage: [] },
        read: { available: true, reading: false, tried_at: null, failure: null },
        telemetry: { five_hour_tokens: 6_800_000, five_hour_runs: 5, day_tokens: 6_800_000, day_runs: 5, week_tokens: 12_800_000, week_runs: 10, total_tokens: 12_800_000, total_runs: 10, last_at: now },
      },
    ],
  };
  const report: UsageReport = {
    ...REPORT,
    units: [
      unit({ login_id: 'g1', executor: 'gemini', units: 2 }),
      unit({ login_id: 'g2', executor: 'gemini', units: 3 }),
    ] as UsageReport['units'],
    usage: [
      cell({ login_id: 'g1', executor: 'gemini', ...figures(1000, 0, 1) }),
      cell({ login_id: 'g2', executor: 'gemini', ...figures(2000, 0, 1) }),
    ] as UsageReport['usage'],
    names: { projects: { p1: '甲项目' }, roles: { implement: '实现' }, logins: { g1: 'DEV-WORKSTATION/gemini', g2: 'kr/gemini' } },
  };
  const page = open('#/usage', service(report, () => quota, quota));
  const dshRow = await row('机器 DEV-WORKSTATION 上的 dsh 登录');
  expect(dshRow).toHaveTextContent('官网余额 ¥39.84');
  expect(dshRow).toHaveTextContent('网关 custom_gw 无限额 · 近 30 天已用 $412.08');
  expect(dshRow).toHaveTextContent('账本用量：24h 54.50M · 7 天 95.70M · 13 轮');

  const geminiRow = await row('Gemini（2 台机器）');
  expect(geminiRow).toHaveTextContent('DEV-WORKSTATION · kr');
  expect(geminiRow).toHaveTextContent('5 小时窗口 剩 97%');
  expect(geminiRow).toHaveTextContent('7 天窗口 剩 87%');
  expect(geminiRow).toHaveTextContent('近 5h 14.50M');

  await page.user.click(screen.getByRole('radio', { name: '账号' }));
  const accountTable = await screen.findByRole('table', { name: '按账号分的用量' });
  expect(within(accountTable).getByRole('row', { name: /^Gemini（单机聚合）/ })).toHaveTextContent('3,220');
});
