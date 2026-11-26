// Guards against the settings endpoints being a side door: a write without a login or
// from another site, one that gets past degraded mode because it is not a POST, a refusal
// that loses its reason, secrets reaching the deployment list, a Router being handed a
// tool that changes configuration, and a stored value this version will not take that
// the page can neither see nor clear.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { consoleApp, LOGIN_TOKEN, SHUTDOWN_TOKEN, TOOL_TOKEN } from './console-helpers.ts';
import { claudeTier, fixture } from './helpers.ts';
import { deploymentFacts } from '../service/doctor.ts';

const json = async (response: Response): Promise<any> => response.json();
const PATH = '/api/settings/login.sessionDays';

test('GET /api/settings lists every item with the deployment facts beside it', async (t) => {
  const deployment = [{ title: '数据目录', value: 'D:\\tycho\\data' }];
  const { get, settings } = await consoleApp(t, { deployment });
  settings.set('login.sessionDays', 7, { actor: 'console' });
  const body = await json(await get('/api/settings'));
  assert.deepEqual(Object.keys(body).sort(), ['deployment', 'router', 'settings', 'wecom']);
  assert.deepEqual(body.wecom, { secret_set: false });
  assert.deepEqual(body.deployment, deployment);
  const item = body.settings.find(({ key }: { key: string }) => key === 'login.sessionDays');
  assert.deepEqual([item.group, item.title, item.type, item.value, item.default, item.overridden, item.updated_by], ['登录', '登录保持天数', 'integer', 7, 30, true, 'console']);
});

test('PUT changes one item under the Console\'s name and DELETE puts the default back', async (t) => {
  const { f, send, settings } = await consoleApp(t);
  const saved = await send('PUT', PATH, { value: 7 });
  assert.equal(saved.status, 200);
  assert.equal((await json(saved)).settings.find(({ key }: { key: string }) => key === 'login.sessionDays').value, 7);
  assert.equal(settings.get('login.sessionDays'), 7);
  const reset = await send('DELETE', PATH);
  assert.equal(reset.status, 200);
  assert.equal(settings.get('login.sessionDays'), 30);
  const actors = f.peek<{ actor: string }>(`SELECT actor FROM change WHERE action = 'setting.update'`).map(({ actor }) => actor);
  assert.deepEqual(actors, ['console', 'console']);
});

test('a refused value comes back as a 400 with the reason, and an unknown key too', async (t) => {
  const { send, settings } = await consoleApp(t);
  const low = await send('PUT', PATH, { value: 0 });
  assert.equal(low.status, 400);
  assert.equal((await json(low)).error, '登录保持天数不能小于 1');
  const absent = await send('PUT', PATH, {});
  assert.equal(absent.status, 400);
  assert.match((await json(absent)).error, /应为整数/);
  const unknown = await send('PUT', '/api/settings/no.such', { value: 1 });
  assert.equal(unknown.status, 400);
  assert.match((await json(unknown)).error, /没有这个配置项/);
  assert.equal((await send('PUT', PATH, undefined)).status, 400, '不是 JSON 对象');
  assert.equal(settings.get('login.sessionDays'), 30);
  assert.equal((await send('POST', PATH, { value: 7 })).status, 404, '只有 PUT 和 DELETE');
  assert.equal((await send('PUT', '/api/settings/a%2Fb', { value: 7 })).status, 404);
});

test('DELETE clears a stored value this version will not take, and leaves a key it does not know', async (t) => {
  const f = fixture(t);
  f.force(`INSERT INTO setting (id, created_at, key, value_json) VALUES ('x', 'now', 'tunables', ?)`, JSON.stringify({ 'future.thing': 5, 'login.sessionDays': 'lots' }));
  const { get, send } = await consoleApp(t, { f });
  const item = async (response: Response) => (await json(response)).settings.find(({ key }: { key: string }) => key === 'login.sessionDays');
  const before = await item(await get('/api/settings'));
  assert.deepEqual([before.value, before.stored, before.overridden], [30, true, false]);
  const cleared = await send('DELETE', PATH);
  assert.equal(cleared.status, 200);
  const after = await item(cleared);
  assert.deepEqual([after.value, after.stored, after.overridden], [30, false, false]);
  const [row] = f.peek<{ value_json: string }>(`SELECT value_json FROM setting WHERE key = 'tunables'`);
  assert.deepEqual(JSON.parse(row!.value_json), { 'future.thing': 5 });
});

test('without a login nothing is shown or changed, and from another site nothing is changed', async (t) => {
  const { get, send, origin, cookie, settings } = await consoleApp(t);
  assert.equal((await get('/api/settings', {})).status, 401);
  assert.equal((await send('PUT', PATH, { value: 7 }, origin)).status, 401);
  assert.equal((await send('DELETE', PATH, undefined, origin)).status, 401);
  const refused: Record<string, string>[] = [{ Cookie: cookie }, { Cookie: cookie, Origin: 'http://evil.example' }];
  for (const headers of refused) {
    assert.equal((await send('PUT', PATH, { value: 7 }, headers)).status, 403);
    assert.equal((await send('DELETE', PATH, undefined, headers)).status, 403);
  }
  assert.equal(settings.get('login.sessionDays'), 30);
});

test('a write is answered 503 during an inventory, and with a retired ledger before it gets that far', async (t) => {
  const barrier = { recovering: false };
  const crash = { armed: false };
  const f = fixture(t, {
    recovery: { recovering: () => barrier.recovering },
    testHooks: {
      beforeCommit() {
        if (crash.armed) throw new Error('commit failed');
      },
      beforeRollback() {
        if (crash.armed) throw new Error('rollback failed');
      },
    },
  });
  const { send, get, settings } = await consoleApp(t, { f });
  barrier.recovering = true;
  const held = await send('PUT', PATH, { value: 7 });
  assert.equal(held.status, 503);
  assert.match((await json(held)).error, /恢复清点/);
  assert.equal((await get('/api/settings')).status, 200, '读不受影响');
  barrier.recovering = false;

  crash.armed = true;
  assert.equal((await send('PUT', PATH, { value: 7 })).status, 503);
  assert.equal(f.ledger.dispatchConditions().paused, null);
  for (const answer of [await send('PUT', PATH, { value: 8 }), await send('DELETE', PATH)]) {
    assert.equal(answer.status, 503);
    assert.match((await json(answer)).error, /账本不可用/);
  }
  assert.equal(settings.get('login.sessionDays'), 30);
});

test('the deployment list has paths and addresses, never a Secret, a token or a Cookie', async (t) => {
  const f = fixture(t);
  const deployment = deploymentFacts({
    dataDir: f.dir,
    listening: { host: '0.0.0.0', port: 8787 },
    claude: { path: 'C:\\tools\\claude.exe', command: ['C:\\tools\\claude.exe'], problem: null, login: { loggedIn: true, detail: 'owner@example.com' } },
    launched: { claude: ['C:\\tools\\claude.exe'] },
    saved: { cli: 'C:\\tools\\claude.exe', account: '', token: false, tier: null },
  });
  const { get, send, cookie } = await consoleApp(t, { f, deployment });
  assert.equal((await send('PUT', '/api/wecom/secret', { secret: 'the-wecom-secret' })).status, 200);
  const text = await (await get('/api/settings')).text();
  const facts = Object.fromEntries((JSON.parse(text) as { deployment: { title: string; value: string }[] }).deployment.map(({ title, value }) => [title, value]));
  assert.deepEqual(facts, {
    数据目录: f.dir,
    实际监听地址: '0.0.0.0:8787',
    '负责人正在用的 Claude Code': 'C:\\tools\\claude.exe',
    负责人正在用的账号: '没有绑定账号，用这台电脑已有的登录和默认档位',
    负责人正在用的档位: '没有指定，用 Claude Code 自己的默认档位',
    '负责人的 Claude 登录': '已登录（owner@example.com）。查的是负责人正在用的那一份：这台电脑已有的登录',
  });
  assert.deepEqual((JSON.parse(text) as { wecom: unknown }).wecom, { secret_set: true }, '只说有没有，不说是什么');
  for (const secret of ['the-wecom-secret', LOGIN_TOKEN, TOOL_TOKEN, SHUTDOWN_TOKEN, cookie.split('=')[1]!]) {
    assert.ok(!text.includes(secret), secret);
  }
});

test('the deployment list shows the account the Router runs as, and never its token', () => {
  const base = { dataDir: 'D:\\data', listening: { host: '127.0.0.1', port: 8787 }, launched: null };
  const rows = (facts: Parameters<typeof deploymentFacts>[0]) => Object.fromEntries(deploymentFacts(facts).map(({ title, value }) => [title, value]));
  const claude = { path: 'claude', command: ['claude'], problem: null, login: { loggedIn: true, detail: '' } };
  const saved = { cli: 'claude', account: 'gpu', token: false, tier: claudeTier('D:\\tier.json') };
  const stopped = rows({ ...base, claude, saved });
  assert.equal(stopped['负责人下次启动会用的账号'], 'gpu');
  assert.equal(stopped['负责人的 Claude 登录'], '已登录。查的是负责人下次启动会用的那一份：账号 gpu 的登录（用这台电脑已有的登录）');
  // An account with a token of its own: what the Router signs in with is that token. An
  // account replaces only the identity, so there is no login directory to list.
  const byToken = { cli: 'claude', account: 'gpu', token: true, tier: null };
  const token = rows({ ...base, claude, saved: byToken });
  assert.equal(token['负责人下次启动会用的登录目录'], undefined);
  assert.equal(token['负责人的 Claude 登录'], '已登录。查的是负责人下次启动会用的那一份：账号 gpu 的令牌');
  assert.equal(
    rows({ ...base, claude, launched: { claude: ['claude'], account: 'gpu', credentialRef: '3' }, saved: { ...byToken, cli: null } })['负责人的 Claude 登录'],
    '已登录。查的是负责人正在用的那一份：账号 gpu 的令牌',
    '在跑的那个进程拿的是账号的令牌',
  );
  // The token is what that process was started with too, and this list is not the place
  // any of it shows.
  const running = rows({
    ...base,
    claude,
    launched: { claude: ['claude'], account: 'gpu', token: 'never-shown-token', tier: claudeTier('D:\\tier.json') },
    saved,
  });
  assert.ok(!JSON.stringify(running).includes('never-shown-token'));
  assert.equal(running['负责人正在用的账号'], 'gpu');
});

test('the deployment facts say plainly when there is no Claude Code or it is not signed in', () => {
  const base = { dataDir: 'D:\\data', listening: { host: '127.0.0.1', port: 8787 }, launched: null };
  const value = (claude: Parameters<typeof deploymentFacts>[0]['claude'], title: string) =>
    deploymentFacts({ ...base, claude, saved: { cli: claude.path, account: '', token: false, tier: null } }).find((fact) => fact.title === title)!.value;
  const missing = { path: null, command: null, problem: '在 PATH 里找不到 claude', login: null };
  assert.equal(value(missing, '负责人下次启动会用的 Claude Code'), '在 PATH 里找不到 claude');
  assert.match(value(missing, '负责人的 Claude 登录'), /查不了/);
  const found = { path: 'claude', command: ['claude'], problem: null };
  const NEXT = '查的是负责人下次启动会用的那一份：这台电脑已有的登录';
  assert.equal(value({ ...found, login: { loggedIn: false, detail: '' } }, '负责人的 Claude 登录'), `没有登录。${NEXT}`);
  assert.match(value({ ...found, login: { loggedIn: null, detail: '8 秒内没有答复' } }, '负责人的 Claude 登录'), /^查不出：8 秒内没有答复。查的是负责人下次启动会用的那一份/);
  assert.equal(value({ ...found, login: { loggedIn: true, detail: '' } }, '负责人的 Claude 登录'), `已登录。${NEXT}`);
  // A path the setting names that is gone: the file found instead is shown, and it says
  // which one the setting asked for — with a process running on another file as well.
  const replaced = { ...found, settingGone: 'C:\\moved\\claude.exe', login: { loggedIn: true, detail: '' } };
  const saved = { cli: 'claude', account: '', token: false, tier: null };
  assert.equal(value(replaced, '负责人下次启动会用的 Claude Code'), 'claude（设置里填的 C:\\moved\\claude.exe 不存在）');
  assert.equal(
    deploymentFacts({ ...base, claude: replaced, launched: { claude: ['claude'] }, saved }).find((fact) => fact.title === '负责人正在用的 Claude Code')!.value,
    'claude（设置里填的 C:\\moved\\claude.exe 不存在）',
    '在跑的那个进程用的是别的文件，设置里的那条路径还是要说',
  );
});

test('the deployment facts are about the Claude the Router runs on, and list apart what was saved since and waits for a restart', () => {
  const claude = { path: 'C:\\old\\claude.exe', command: ['C:\\old\\claude.exe'], problem: null, login: { loggedIn: true, detail: 'a@example.com' } };
  const base = { dataDir: 'D:\\data', listening: { host: '127.0.0.1', port: 8787 }, claude };
  const launched = { claude: ['node', 'C:\\old\\cli.js'], path: 'C:\\old\\claude.cmd', account: 'old', tier: claudeTier('a') };
  const same = { cli: 'C:\\old\\claude.cmd', account: 'old', token: false, tier: claudeTier('a') };
  const rows = (facts: Parameters<typeof deploymentFacts>[0]) => Object.fromEntries(deploymentFacts(facts).map(({ title, value }) => [title, value]));

  const running = rows({ ...base, launched, saved: same });
  assert.deepEqual(Object.keys(running), ['数据目录', '实际监听地址', '负责人正在用的 Claude Code', '负责人正在用的账号', '负责人正在用的档位', '负责人的 Claude 登录']);
  assert.deepEqual(
    [running['负责人正在用的 Claude Code'], running['负责人正在用的账号'], running['负责人正在用的档位']],
    ['C:\\old\\claude.cmd', 'old', '账号里的档位内容（14 字）'],
  );
  assert.equal(running['负责人的 Claude 登录'], '已登录（a@example.com）。查的是负责人正在用的那一份：账号 old 的登录（用这台电脑已有的登录）');

  // Saved and not yet in force: the facts stay those of the process, the rest is one more line.
  const pending = rows({ ...base, launched, saved: { cli: 'C:\\new\\claude.exe', account: 'new', token: false, tier: claudeTier('model-b') } });
  assert.deepEqual([pending['负责人正在用的 Claude Code'], pending['负责人正在用的档位']], ['C:\\old\\claude.cmd', '账号里的档位内容（14 字）']);
  assert.equal(pending['负责人的 Claude 登录'], running['负责人的 Claude 登录']);
  assert.equal(pending['已保存，重启负责人后生效'], 'Claude Code：C:\\new\\claude.exe；账号：new；档位：账号里的档位内容（20 字）');
  assert.equal(rows({ ...base, launched, saved: { ...same, account: '' } })['已保存，重启负责人后生效'], '账号：没有绑定账号，用这台电脑已有的登录和默认档位');
  assert.equal(rows({ ...base, launched, saved: { ...same, tier: null } })['已保存，重启负责人后生效'], '档位：没有指定，用 Claude Code 自己的默认档位');
  assert.equal(rows({ ...base, launched, saved: { ...same, cli: null } })['已保存，重启负责人后生效'], 'Claude Code：在 PATH 里找不到 claude');
  assert.equal(rows({ ...base, launched, saved: { ...same, cli: 'C:\\new\\claude.exe', token: true } })['已保存，重启负责人后生效'], 'Claude Code：C:\\new\\claude.exe');
  // A content tier is the executor's own text, and the file it is written to is the
  // service's business: what is shown is that the account holds content, not a path.
  assert.equal(
    rows({ ...base, launched, saved: { ...same, tier: { kind: 'content', text: '{"model":"x"}' } } })['已保存，重启负责人后生效'],
    '档位：账号里的档位内容（13 字）',
  );
  // A process started without the file the owner knows it by is named by what was run.
  assert.equal(rows({ ...base, launched: { claude: ['node', 'cli.js'] }, saved: { cli: 'node cli.js', account: '', token: false, tier: null } })['负责人正在用的 Claude Code'], 'node cli.js');

  // No process: what is listed is said to be what the next start would take, and nothing waits.
  const stopped = rows({ ...base, launched: null, saved: { cli: 'C:\\new\\claude.exe', account: '', token: false, tier: null } });
  assert.deepEqual(Object.keys(stopped), ['数据目录', '实际监听地址', '负责人下次启动会用的 Claude Code', '负责人下次启动会用的账号', '负责人下次启动会用的档位', '负责人的 Claude 登录']);
  assert.deepEqual(
    [stopped['负责人下次启动会用的 Claude Code'], stopped['负责人下次启动会用的账号'], stopped['负责人下次启动会用的档位']],
    ['C:\\new\\claude.exe', '没有绑定账号，用这台电脑已有的登录和默认档位', '没有指定，用 Claude Code 自己的默认档位'],
  );
  assert.equal(stopped['负责人的 Claude 登录'], '已登录（a@example.com）。查的是负责人下次启动会用的那一份：这台电脑已有的登录');
});

test('the Router gets no tool that changes settings', async (t) => {
  const { post } = await consoleApp(t);
  const answer = await post('/tools/list', {}, { Authorization: `Bearer ${TOOL_TOKEN}` });
  const { tools } = await json(answer);
  assert.ok(tools.length > 0);
  assert.ok(!tools.some(({ name }: { name: string }) => /setting|config/i.test(name)));
});
