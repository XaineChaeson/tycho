// Guards the Router bound to an account, against: an upgrade from a real version 8 ledger
// failing, or losing what the two settings it replaces named, or moving anything at all
// when they were never set; the account's login directory or token not reaching the Router
// process, or reaching one that is bound to no account (this computer's own login is then
// what runs, and the service's own environment is not a second place it is configured); a
// deleted account, one whose executor cannot drive the Router, or a login the CLI no
// longer takes, taking the service down instead of stopping the Router with a reason and a
// way back; an account deleted under a running Router going on handling messages; a
// conversation resumed under another account, where the CLI does not keep it, including
// one opened before the Router was bound to an account at all; a self-check calling a
// replaced token the one the running process uses; a token the Router was refused for
// leaving the account looking usable to the Workers; a tier left on an old name, one an
// account holds together with the name it would become included; and the token itself
// reaching a log, a change row or any interface. And the Router bound to an account the
// step to version 18 folded into a machine's own login: version 26 clears that dangling
// binding and records that the empty setting uses this computer's own login. And what the
// Router's turns say about its account's quota going nowhere, so the account page keeps
// showing the figure the last Worker round read.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename, dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import type { Account } from '../runner/snapshot.ts';
import { Db } from '../service/db.ts';
import { openLedger } from '../service/ledger.ts';
import { claudeTier, codexTier, content } from './helpers.ts';
import type { Service } from './stage.ts';
import { signIn, stage, until } from './stage.ts';

const options = { timeout: 90_000 };
const json = async (response: Response): Promise<any> => response.json();
const TOKEN = 'oauth-token-of-the-router-account';
// The tier the Router is bound to in these tests: one of the two names the system uses.
const TIER = 'decide';
// The name the version 10 migration gives the Router's own tier file. It is not one this
// program uses, and the step to version 15 leaves it standing: the Router stops and says
// which two names to pick from (docs/design/roles-and-tiers.md §8).
const UPGRADE_TIER = 'default';
const V9 = readFileSync(new URL('./fixtures/ledger/schema-v9.sql', import.meta.url), 'utf8');
const V17 = readFileSync(new URL('./fixtures/ledger/schema-v17.sql', import.meta.url), 'utf8');

// --- the migration off the two settings ---

// A ledger as version 9 left it: the recorded schema of that version, the settings row it
// kept its tunables in, and whatever accounts were already there (their tiers already in
// the `ref`/`content` shape that version wrote). It is brought forward the way a start
// brings a ledger forward — the real steps — never by stamping a version on what this
// program builds; and read as version 17 left it, the last version whose accounts may have
// no login of their own: the step to 18 (tests/migration.test.ts) is not this file's.
function upgraded(t: TestContext, tunables: Record<string, unknown> | undefined, held: (Account & { machines?: string[]; configDir?: string })[] = []) {
  const dir = mkdtempSync(join(tmpdir(), 'tycho-router-v9-'));
  const path = join(dir, 'ledger.db');
  // Closed before the directory goes: Windows does not remove a file that is open.
  const opened: { close(): void }[] = [];
  t.after(() => {
    for (const each of opened) each.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const conn = new DatabaseSync(path);
  conn.exec(V9);
  const setting = conn.prepare('INSERT INTO setting (id, created_at, key, value_json) VALUES (?, ?, ?, ?)');
  setting.run('s-version', '2026-11-01', 'schema_version', '9');
  if (tunables !== undefined) setting.run('s-tunables', '2026-11-01', 'tunables', JSON.stringify(tunables));
  const account = conn.prepare(`INSERT INTO account (id, created_at, updated_at, executor, machines_json, config_dir, tiers_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)`);
  for (const each of held) {
    account.run(each.id, '2026-11-01', '2026-11-01', each.executor, JSON.stringify(each.machines ?? []), each.configDir ?? null, JSON.stringify(each.tiers));
  }
  conn.close();
  const changed = (): unknown[] => {
    const read = new DatabaseSync(path, { readOnly: true });
    try {
      return read.prepare('SELECT * FROM change ORDER BY rowid').all() as unknown[];
    } finally {
      read.close();
    }
  };
  const before = changed();
  try {
    new Db(path, false, { beforeMigrationCommit(from) { if (from === 17) throw new StopAt17(); } }, { log: () => {}, copyBeforeUpgrade: false }).close();
  } catch (err) {
    if (!(err instanceof StopAt17)) throw err;
  }
  const read = new DatabaseSync(path, { readOnly: true });
  opened.push(read);
  const ledger = {
    getTunables: (): Record<string, unknown> => {
      const row = read.prepare(`SELECT value_json FROM setting WHERE key = 'tunables'`).get() as { value_json: string } | undefined;
      return row === undefined ? {} : (JSON.parse(row.value_json) as Record<string, unknown>);
    },
    getAccount: (id: string): (Account & { machines: string[]; configDir?: string }) | undefined => {
      const row = read.prepare('SELECT * FROM account WHERE id = ?').get(id) as { executor: string; machines_json: string; config_dir: string | null; tiers_json: string } | undefined;
      return row && { id, name: id, executor: row.executor, machines: JSON.parse(row.machines_json) as string[], ...(row.config_dir === null ? {} : { configDir: row.config_dir }), tiers: JSON.parse(row.tiers_json) };
    },
  };
  return { dir, path, ledger, before, after: changed() };
}
class StopAt17 extends Error {}

test('an upgrade with a login directory and a tier file moves both into an account the settings point at', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'tycho-router-v9-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const home = join(dir, 'router-home');
  const tier = join(dir, 'router-tier.json');
  const { ledger, before, after } = upgraded(t, { 'router.configDir': home, 'router.tierFile': tier, 'run.timeoutMs': 1000 });
  assert.deepEqual(ledger.getTunables(), { 'run.timeoutMs': 1000, 'router.account': 'router', 'router.tier': UPGRADE_TIER }, '旧的两项没了，其余照旧');
  const account = ledger.getAccount('router')!;
  assert.deepEqual(
    [account.executor, account.machines, account.configDir, { ...account.tiers }],
    ['claude', [], home, { [UPGRADE_TIER]: { kind: 'ref', value: tier } }],
    '账号带上登录目录和档位（按引用的形状记），机器为空：它是负责人的',
  );
  // Nobody's action: what an upgrade moves leaves no audit row of the owner's.
  assert.deepEqual(after, before, '升级不写 change');
});

test('an upgrade with neither setting set leaves the binding empty and creates no account', (t) => {
  const { ledger, before, after } = upgraded(t, undefined);
  assert.deepEqual(ledger.getTunables(), {}, '什么都没动');
  assert.equal(ledger.getAccount('router'), undefined);
  assert.deepEqual(after, before, '升级不写 change');
});

test('an upgrade with both settings left empty removes them and binds nothing', (t) => {
  const { ledger } = upgraded(t, { 'router.configDir': '', 'router.tierFile': '' });
  assert.deepEqual(ledger.getTunables(), {}, '空值不是设置：删掉，不建账号');
  assert.equal(ledger.getAccount('router'), undefined);
});

test('the account an upgrade makes gives way to a name already taken, and carries only what was set', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'tycho-router-v9-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const home = join(dir, 'router-home');
  const taken: Account = { id: 'router', name: 'router', executor: 'codex', tiers: { execute: codexTier('execute') } };
  const { ledger } = upgraded(t, { 'router.configDir': home, 'router.tierFile': '' }, [taken]);
  assert.deepEqual(ledger.getTunables(), { 'router.account': 'router@2' }, '名字被占了就加 @2');
  assert.deepEqual({ ...ledger.getAccount('router')!.tiers }, { execute: codexTier('execute') }, '原来那个账号不动');
  assert.deepEqual(
    [ledger.getAccount('router@2')!.configDir, { ...ledger.getAccount('router@2')!.tiers }],
    [home, {}],
    '只设了登录目录：账号没有档位，也就没有 router.tier',
  );

  const other = mkdtempSync(join(tmpdir(), 'tycho-router-v9-'));
  t.after(() => rmSync(other, { recursive: true, force: true }));
  const tier = join(other, 'tier.json');
  const onlyTier = upgraded(t, { 'router.tierFile': tier }).ledger;
  assert.deepEqual(
    [onlyTier.getAccount('router')!.configDir, { ...onlyTier.getAccount('router')!.tiers }, onlyTier.getTunables()['router.tier']],
    [undefined, { [UPGRADE_TIER]: { kind: 'ref', value: tier } }, UPGRADE_TIER],
    '只设了档位文件：账号没有登录目录，档位按引用的形状记',
  );
});

// --- what the Router runs as ---

async function client(service: Service) {
  const signed = await signIn(service);
  const headers = { Cookie: signed.cookie, Origin: signed.base, 'Content-Type': 'application/json' };
  const put = (key: string, value: unknown): Promise<Response> =>
    fetch(`${signed.base}/api/settings/${key}`, { method: 'PUT', headers, body: JSON.stringify({ value }) });
  const putAccount = (id: string, body: unknown): Promise<Response> =>
    fetch(`${signed.base}/api/accounts/${id}`, { method: 'PUT', headers, body: JSON.stringify(body) });
  const dropAccount = (id: string): Promise<Response> =>
    fetch(`${signed.base}/api/accounts/${id}?confirm=1`, { method: 'DELETE', headers });
  const credentials = async (): Promise<Record<string, string>> =>
    Object.fromEntries(((await json(await signed.get('/api/accounts'))).accounts as { id: string; credential: string }[]).map(({ id, credential }) => [id, credential]));
  const router = async () => (await json(await signed.get('/api/state'))).router as { alive: boolean; error: string | null; restarting: boolean };
  const facts = async (): Promise<Record<string, string>> =>
    Object.fromEntries(((await json(await signed.get('/api/settings'))).deployment as { title: string; value: string }[]).map(({ title, value }) => [title, value]));
  const restart = () => signed.post('/api/router/restart');
  return { ...signed, put, putAccount, dropAccount, credentials, router, facts, restart };
}

interface Entry { argv?: string[]; auth?: string; config_dir?: string | null; marker_env?: string | null; nested?: string[]; token_ok?: boolean }
const logOf = (dataDir: string): Entry[] =>
  readFileSync(join(dataDir, 'fake.log'), 'utf8').trim().split('\n').map((line) => JSON.parse(line) as Entry);
const startsOf = (dataDir: string): string[][] => logOf(dataDir).flatMap(({ argv }) => (argv ? [argv] : []));

// Every row of one table, read as a restart would read the file.
function rowsOf(dataDir: string, table: string): unknown[] {
  const conn = new DatabaseSync(join(dataDir, 'ledger.db'), { readOnly: true });
  try {
    return conn.prepare(`SELECT * FROM ${table}`).all() as unknown[];
  } finally {
    conn.close();
  }
}

// A Router account: a token of its own and a tier.
function accountOn(id: string): Account {
  return { id, name: id, executor: 'claude', tiers: { [TIER]: claudeTier(`model-${id}`) } };
}

test('the account\'s token, and nothing else of it, is what the Router process is started with', options, async (t) => {
  const { start, dataDir, greet, routerStarts } = stage(t, {});
  const account = accountOn('router');
  process.env.FAKE_CLAUDE_EXPECT_TOKEN = TOKEN;
  t.after(() => delete process.env.FAKE_CLAUDE_EXPECT_TOKEN);
  const service = await start({}, {
    logins: { router: account },
    credentials: { router: TOKEN },
    settings: { 'router.account': 'router', 'router.tier': TIER },
  });
  const c = await client(service);
  assert.equal((await c.router()).error, null);
  await greet(service);

  const started = logOf(dataDir).filter(({ argv }) => argv);
  assert.equal(started.length, 1);
  assert.equal(started[0]!.config_dir, null, '账号只换身份：配置照旧是这台机器的');
  assert.equal(started[0]!.token_ok, true, '进程拿到的就是那个账号的令牌');
  assert.ok(started[0]!.nested!.includes('CLAUDE_CODE_OAUTH_TOKEN'), '令牌在环境里');
  const argv = startsOf(dataDir)[0]!;
  assert.deepEqual(
    JSON.parse(readFileSync(argv[argv.indexOf('--settings') + 1]!, 'utf8')),
    JSON.parse(account.tiers[TIER]!.text),
    '--settings 传的文件里是账号那个档位的内容',
  );
  // The login question is about the same account, and asks with the same token.
  const questions = logOf(dataDir).filter(({ auth }) => auth);
  assert.ok(questions.length >= 1);
  for (const entry of questions) {
    assert.deepEqual([entry.config_dir, entry.token_ok, entry.marker_env], [null, true, null]);
  }
  assert.equal(routerStarts(), 1);
});

test('a content tier is written to a settings file of the service\'s own, and the token stays out of it', options, async (t) => {
  const { start, dataDir, greet, routerStarts } = stage(t, {});
  const text = '{"model":"a-model-of-the-router","effortLevel":"high"}';
  const account: Account = { id: 'router', name: 'router', executor: 'claude', tiers: { [TIER]: content(text) } };
  process.env.FAKE_CLAUDE_EXPECT_TOKEN = TOKEN;
  t.after(() => delete process.env.FAKE_CLAUDE_EXPECT_TOKEN);
  const service = await start({}, {
    logins: { router: account },
    credentials: { router: TOKEN },
    settings: { 'router.account': 'router', 'router.tier': TIER },
  });
  const c = await client(service);
  assert.equal((await c.router()).error, null);
  await greet(service);

  // The CLI only reads a file, so the tier's settings are written under the data directory,
  // with the one exclusion that keeps the host's own global entry out (knowledge §4.2: the
  // Router is handed those entries with its material). The token is the account's and goes to
  // the process environment: it is nowhere in this file.
  // One file per process: two projects' Routers start side by side.
  const argv = startsOf(dataDir)[0]!;
  const settings = argv[argv.indexOf('--settings') + 1]!;
  assert.equal(dirname(settings), join(dataDir, 'router'));
  assert.match(basename(settings), /^tier-.+\.json$/);
  assert.deepEqual(argv.slice(argv.indexOf('--settings'), argv.indexOf('--settings') + 2), ['--settings', settings], '内容档位交给 --settings 的是服务写的那个文件');
  assert.deepEqual(JSON.parse(readFileSync(settings, 'utf8')), JSON.parse(text), '档位的设置原样写入，不附加隐藏覆盖');
  assert.ok(!readFileSync(settings, 'utf8').includes(TOKEN), '令牌不进这个文件');
  assert.equal(logOf(dataDir).find(({ argv }) => argv)!.token_ok, true, '令牌到了进程环境里');
  assert.equal((await c.facts())['负责人正在用的档位'], `账号里的档位内容（${text.length} 字）`, '页面上说的是内容，不是服务写的那个路径');

  // What is in force is what the ledger held when that process started: changing the
  // account shows as waiting for a restart, and the restart writes the new text.
  const changed = '{"model":"another-model"}';
  // The account is in the ledger already: this changes it, and a change is answered with
  // a 200 (a 201 is an account the console made).
  assert.equal((await c.putAccount('router', { executor: 'claude', tiers: { [TIER]: { kind: 'content', text: changed } } })).status, 200);
  assert.equal((await c.facts())['已保存，重启负责人后生效'], `档位：账号里的档位内容（${changed.length} 字）`);
  assert.equal(JSON.parse(readFileSync(settings, 'utf8')).model, 'a-model-of-the-router', '还没重启：文件还是上一轮那份');
  await c.restart();
  await greet(service);
  await until(() => routerStarts() === 2, '改档位以后重启');
  assert.equal(JSON.parse(readFileSync(settings, 'utf8')).model, 'another-model');
  assert.equal((await c.facts())['已保存，重启负责人后生效'], undefined, '重启后在用的和保存的一致');
});

test('a tier the CLI would drop without a word stops the Router before it opens a session', options, async (t) => {
  const { start, dataDir, routerStarts } = stage(t, {});
  // Written straight into the ledger, as a program older than this one could have: what
  // the console refuses, a hand-written ledger still holds.
  const account: Account = { id: 'router', name: 'router', executor: 'claude', tiers: { [TIER]: content('[]') } };
  const service = await start({}, {
    logins: { router: account },
    credentials: { router: TOKEN },
    settings: { 'router.account': 'router', 'router.tier': TIER },
  });
  assert.equal(routerStarts(), 0, '不拿一条消息去试一个 CLI 会丢掉的档位');
  assert.match(service.session.status().error!, /负责人的档位 decide 用不了：应为一份 settings 对象/);
  assert.match(service.session.status().error!, /设置 › 负责人/, '理由说去哪里改');
  assert.equal(service.ledger.currentContext(service.ledger.listProjects()[0]?.id ?? ''), undefined, '没有会话被开出来');
  const c = await client(service);
  assert.equal((await c.get('/api/overview')).status, 200, '控制台照常');
});

test('a Router tier left by an older layout stops the Router and says which two names to pick from', options, async (t) => {
  const { start, dataDir, routerStarts, greet } = stage(t, {});
  const account = accountOn('router');
  // A name this version does not use, put in the ledger the way an upgrade leaves one: the
  // settings layer refuses it as a new value and never writes over it either, so only a
  // ledger from before this program can hold one. `accountOn` binds the account to TIER, so
  // what stops the Router here is the name the setting holds, not a missing tier.
  const path = join(dataDir, 'ledger.db');
  const opened = openLedger(path, { log: () => {} });
  opened.close();
  const conn = new DatabaseSync(path);
  try {
    conn.prepare('INSERT INTO setting (id, created_at, key, value_json) VALUES (?, ?, ?, ?)')
      .run('s-left-by-upgrade', '2026-11-01T00:00:00.000Z', 'tunables', JSON.stringify({ 'router.tier': UPGRADE_TIER }));
  } finally {
    conn.close();
  }
  const service = await start({}, {
    logins: { router: account },
    credentials: { router: TOKEN },
    settings: { 'router.account': 'router' },
  });
  assert.equal(service.ledger.getTunables()['router.tier'], UPGRADE_TIER, '账本里的旧名字没有被换掉或清掉');
  assert.equal(routerStarts(), 0, '不拿旧名字去起负责人');
  assert.match(service.session.status().error!, /档位只有操作档（operate）、执行档（execute）、决策档（decide）三个，不能有 default/);
  assert.match(service.session.status().error!, /设置 › 负责人/, '理由说去哪里改');
  assert.equal(service.ledger.currentContext(service.ledger.listProjects()[0]?.id ?? ''), undefined, '没有会话被开出来');
  // Picking one of the names is what lets it start again.
  const c = await client(service);
  assert.equal((await c.put('router.tier', TIER)).status, 200);
  await c.restart();
  await greet(service);
  await until(() => routerStarts() === 1, '改成其中一个名字以后重启负责人');
  assert.equal(service.session.status().error, null);
});

// The Router's own tier left on a name the system no longer uses (the step to version 15
// renames `cheap` nowhere once an account holds both `cheap` and `execute`): the Router stops
// on a name it cannot use and says the two it can — the owner settles it, and the setting is
// left where it is until then.
test('a Router tier on a name the system no longer uses stops the Router and says the two names there are', options, async (t) => {
  const { start, dataDir, routerStarts } = stage(t, {});
  const account = accountOn('router');
  const path = join(dataDir, 'ledger.db');
  const opened = openLedger(path, { log: () => {} });
  opened.close();
  const conn = new DatabaseSync(path);
  try {
    conn.prepare('INSERT INTO setting (id, created_at, key, value_json) VALUES (?, ?, ?, ?)')
      .run('s-collided', '2026-11-01T00:00:00.000Z', 'tunables', JSON.stringify({ 'router.tier': 'cheap' }));
  } finally {
    conn.close();
  }
  const service = await start({}, {
    logins: {
      router: {
        ...account,
        tiers: { cheap: claudeTier('/tiers/cheap.json'), execute: claudeTier('/tiers/execute.json') },
      },
    },
    credentials: { router: TOKEN },
    settings: { 'router.account': 'router' },
  });
  assert.equal(service.ledger.getTunables()['router.tier'], 'cheap', '账本里的旧名字没有被换掉或清掉');
  assert.equal(routerStarts(), 0, '用哪一份还没定，不拿旧名字去起负责人');
  assert.match(service.session.status().error!, /档位只有操作档（operate）、执行档（execute）、决策档（decide）三个，不能有 cheap/);
  assert.equal(service.ledger.currentContext(service.ledger.listProjects()[0]?.id ?? ''), undefined, '没有会话被开出来');
  const c = await client(service);
  assert.equal((await c.get('/api/overview')).status, 200, '控制台照常');
});

test('with no account bound, and a token in the service\'s own environment, the Router runs on this computer\'s own login', options, async (t) => {
  const { start, dataDir, greet, routerStarts } = stage(t, {});
  // What a service started from a shell that runs Claude Code, or from inside a Router,
  // finds in its own environment.
  process.env.CLAUDE_CONFIG_DIR = join(dataDir, 'inherited-home');
  process.env.CLAUDE_CODE_OAUTH_TOKEN = 'inherited-token';
  process.env.FAKE_CLAUDE_EXPECT_TOKEN = 'inherited-token';
  t.after(() => {
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    delete process.env.FAKE_CLAUDE_EXPECT_TOKEN;
  });
  const service = await start();
  const c = await client(service);
  await greet(service);
  assert.equal((await c.router()).error, null);
  const asked = logOf(dataDir).filter(({ argv, auth }) => argv || auth);
  assert.ok(asked.length >= 2, '问过登录状态，也起过负责人');
  for (const entry of asked) {
    assert.deepEqual([entry.config_dir, entry.token_ok], [null, false], '不设 CLAUDE_CONFIG_DIR，也不用环境里带来的令牌');
  }
  // No tier: settings file is an empty JSON object without hidden claudeMdExcludes or memory-off overlays.
  const argv = startsOf(dataDir)[0]!;
  const settings = argv[argv.indexOf('--settings') + 1]!;
  assert.deepEqual(JSON.parse(readFileSync(settings, 'utf8')), {}, '没有档位时给空设置对象，不注入隐藏排除项');
  const started = logOf(dataDir).find(({ argv }) => argv)!;
  assert.ok(!started.nested!.includes('CLAUDE_CODE_DISABLE_AUTO_MEMORY'), '保留原生自动记忆，不注入隐藏开关');
  const [context] = rowsOf(dataDir, 'router_context') as { launch_json: string }[];
  const launch = JSON.parse(context!.launch_json) as { machine_inputs: { instructions: Record<string, unknown>; memory: Record<string, unknown> } };
  assert.deepEqual(launch.machine_inputs.instructions, { reads: '按执行器原生配置运行' });
  assert.deepEqual(launch.machine_inputs.memory, { scope: 'shared' });
  assert.equal(routerStarts(), 1);
});

test('a Router on an account\'s tier records native machine_inputs without hidden exclusion overlays', options, async (t) => {
  const { start, dataDir, greet } = stage(t, {});
  const account = accountOn('router');
  process.env.FAKE_CLAUDE_EXPECT_TOKEN = TOKEN;
  t.after(() => delete process.env.FAKE_CLAUDE_EXPECT_TOKEN);
  const service = await start({}, { logins: { router: account }, credentials: { router: TOKEN }, settings: { 'router.account': 'router', 'router.tier': TIER } });
  await greet(service);
  const [context] = rowsOf(dataDir, 'router_context') as { launch_json: string }[];
  const launch = JSON.parse(context!.launch_json) as { machine_inputs: { instructions: Record<string, unknown> } };
  assert.deepEqual(launch.machine_inputs.instructions, { reads: '按执行器原生配置运行' });
});

test('the token is in no log, change row or interface', options, async (t) => {
  const { start, dataDir, greet } = stage(t, {});
  const account = accountOn('router');
  process.env.FAKE_CLAUDE_EXPECT_TOKEN = TOKEN;
  t.after(() => delete process.env.FAKE_CLAUDE_EXPECT_TOKEN);
  const complaints: string[] = [];
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: unknown, ...rest: unknown[]): boolean => {
    complaints.push(String(chunk));
    return (write as (...args: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof process.stderr.write;
  t.after(() => {
    process.stderr.write = write;
  });
  const service = await start({}, {
    logins: { router: account },
    credentials: { router: TOKEN },
    settings: { 'router.account': 'router', 'router.tier': TIER },
  });
  const c = await client(service);
  await greet(service);

  const pages = ['/api/state', '/api/settings', '/api/accounts', '/api/overview', '/api/doctor'];
  for (const path of pages) {
    assert.ok(!(await (await c.get(path)).text()).includes(TOKEN), `${path} 里有令牌`);
  }
  for (const table of ['change', 'setting', 'account', 'run', 'message', 'outbox']) {
    assert.ok(!JSON.stringify(rowsOf(dataDir, table)).includes(TOKEN), `${table} 里有令牌`);
  }
  assert.ok(!complaints.join('').includes(TOKEN), '服务日志里有令牌');
  assert.ok(!readFileSync(join(dataDir, 'fake.log'), 'utf8').includes(TOKEN), '假 CLI 的日志里有令牌');
  // The token did reach the process, so this is not a test of nothing.
  assert.equal(logOf(dataDir).find(({ argv }) => argv)!.token_ok, true);
});

test('a deleted account and one whose executor cannot drive the Router each stop the Router alone', options, async (t) => {
  const { start, dataDir, greet, routerStarts } = stage(t, {});
  const account = accountOn('router');
  const service = await start({}, {
    logins: { router: account },
    credentials: { router: TOKEN },
    settings: { 'router.account': 'router', 'router.tier': TIER },
  });
  const c = await client(service);
  await greet(service);
  assert.equal(routerStarts(), 1);
  const facts = async (): Promise<Record<string, string | undefined>> =>
    Object.fromEntries(((await json(await c.get('/api/settings'))).deployment as { title: string; value: string }[]).map(({ title, value }) => [title, value]));

  // Deleted in the console while the service runs: the setting still names it, and the
  // Router says so instead of running on another login.
  assert.equal((await c.dropAccount('router')).status, 200);
  assert.equal((await c.restart()).status, 202);
  await until(() => service.session.status().error !== null, '账号没了以后停摆');
  const gone = await c.router();
  assert.deepEqual([gone.alive, gone.restarting], [false, false]);
  assert.match(gone.error!, /负责人绑定的账号 router 已经删了/);
  assert.match(gone.error!, /设置 › 负责人/, '理由说去哪里改');
  assert.match((await facts())['负责人下次启动会用的账号']!, /router/, '设置还指着那个账号编号');
  assert.equal((await c.get('/api/overview')).status, 200, '控制台照常');
  const { id } = await json(await c.post('/api/messages', { text: '停摆时发的' }));
  assert.equal(service.ledger.getMessage(id).state, 'received', '消息留着，不丢');

  // Another executor: the account is there, but its adapter cannot drive the Router. The
  // console makes no Codex account (its login is a machine's own), so the ledger is given
  // one the way an older program could have left it.
  service.ledger.putAccount({ id: 'replacement-router', name: 'router', executor: 'codex', tiers: account.tiers }, { actor: 'test' }, 'ref-router-codex');
  await c.restart();
  await until(() => service.session.status().error !== null, '同名账号没有继承绑定');
  assert.match((await c.router()).error!, /负责人绑定的账号 router 已经删了/);
  assert.equal((await c.put('router.account', 'replacement-router')).status, 200);
  await c.restart();
  await until(() => service.session.status().error !== null, '不能当负责人以后停摆');
  assert.match((await c.router()).error!, /账号 router 的登录凭据缺失/);
  assert.equal((await facts())['负责人下次启动会用的账号'], 'router');
  assert.equal((await c.get('/api/overview')).status, 200, '控制台照常');
  assert.equal(service.ledger.getMessage(id).state, 'received', '还是留着的');
});

test('a bound account the ledger deleted is named by what it was called, never by its internal id', options, async (t) => {
  const { start, dataDir } = stage(t, {});
  // An account made the way the console makes one: an internal id of its own, and a name the
  // owner typed. The settings bind the Router to the id.
  const service = await start({});
  const c = await client(service);
  service.ledger.putAccount(
    { id: 'internal-account-id', name: 'claude', executor: 'claude', tiers: { [TIER]: claudeTier('router-model') } },
    { actor: 'test' }, 'ref-claude',
  );
  mkdirSync(join(dataDir, 'home-claude'), { recursive: true });
  assert.equal((await c.put('router.account', 'internal-account-id')).status, 200);
  assert.equal((await c.put('router.tier', TIER)).status, 200);
  assert.equal((await c.facts())['负责人下次启动会用的账号'], 'claude');

  service.ledger.deleteAccount('internal-account-id', { actor: 'owner' }, { confirmed: true });
  // The self-check says the binding cannot start, in the account's own words, with the way to
  // the setting that decides it — and the internal id stays out of every sentence.
  const check = ((await json(await c.get('/api/doctor'))).checks as { id: string; level: string; text: string; fix: { href: string } | null }[])
    .find(({ id }) => id === 'claude-login')!;
  assert.equal(check.level, 'fail');
  assert.match(check.text, /负责人绑定的账号 claude 已经删了/);
  assert.ok(!check.text.includes('internal-account-id'), `自检里露了编号：${check.text}`);
  assert.equal(check.fix?.href, '#/settings/router.account');
  assert.equal((await c.facts())['负责人下次启动会用的账号'], 'claude');
  // Why the next start stops: the same words, not the id.
  assert.equal((await c.restart()).status, 202);
  await until(() => service.session.status().error !== null, '账号没了以后停摆');
  const stopped = (await c.router()).error!;
  assert.match(stopped, /负责人绑定的账号 claude 已经删了/);
  assert.ok(!stopped.includes('internal-account-id'), `停摆理由里露了编号：${stopped}`);
});

test('version 26 clears and audits a dangling Router binding left by the version 18 account migration', (t) => {
  const { dataDir } = stage(t, {});
  // Version 17 as the owner could have left it: the Router bound to a Claude account that
  // kept no token of its own, signed in on the one machine it names.
  const at = '2026-11-01T00:00:00.000Z';
  const conn = new DatabaseSync(join(dataDir, 'ledger.db'));
  conn.exec(V17);
  const setting = conn.prepare('INSERT INTO setting (id, created_at, key, value_json) VALUES (?, ?, ?, ?)');
  setting.run('v', at, 'schema_version', '17');
  setting.run('w', at, 'whitelist', JSON.stringify({ console: ['console'] }));
  setting.run('t', at, 'tunables', JSON.stringify({ 'router.account': 'mine', 'router.tier': TIER }));
  conn.prepare('INSERT INTO machine (id, created_at, updated_at, host) VALUES (?, ?, ?, ?)').run('h1', at, at, 'h1');
  conn.prepare(`INSERT INTO account (id, created_at, updated_at, executor, tiers_json, machines_json, credential_ref) VALUES ('mine', ?, ?, 'claude', ?, '["h1"]', NULL)`)
    .run(at, at, JSON.stringify({ [TIER]: { kind: 'content', text: '{}' } }));
  conn.close();

  const ledger = openLedger(join(dataDir, 'ledger.db'), { log: () => {} });
  try {
    assert.equal(ledger.getTunables()['router.account'], '');
    const audit = (rowsOf(dataDir, 'change') as { action: string; detail_json: string }[]).filter(({ action }) => action === 'setting.update').map(({ detail_json }) => JSON.parse(detail_json));
    assert.ok(audit.some((detail) => detail.key === 'router.account' && detail.from === 'mine' && detail.to === '' && detail.logins_removed.includes('mine') && /主机自己的登录/.test(detail.reason)));
  } finally { ledger.close(); }
});

test('a login the CLI refuses stops the Router alone, and a login it takes again brings it back', options, async (t) => {
  const { start, dataDir, greet, routerStarts } = stage(t, {});
  const account = accountOn('router');
  const service = await start({}, {
    logins: { router: account },
    credentials: { router: TOKEN },
    settings: { 'router.account': 'router', 'router.tier': TIER },
  });
  const c = await client(service);
  await greet(service);
  assert.equal(routerStarts(), 1);

  process.env.FAKE_CLAUDE_AUTH = 'out';
  t.after(() => delete process.env.FAKE_CLAUDE_AUTH);
  await c.restart();
  await until(() => service.session.status().error !== null, '登录被拒以后停摆');
  const refused = await c.router();
  assert.deepEqual([refused.alive, refused.restarting], [false, false]);
  assert.match(refused.error!, /账号 router 的 Claude 登录没有被接受/);
  assert.match(refused.error!, /重新登录|改绑另一个账号/, '理由说怎么改');
  assert.equal((await c.get('/api/overview')).status, 200, '控制台照常');
  const { id } = await json(await c.post('/api/messages', { text: '停摆时发的' }));
  assert.equal(service.ledger.getMessage(id).state, 'received', '消息留着，不丢');

  // The way back: a login the CLI takes again, and the messages left behind are handled.
  process.env.FAKE_CLAUDE_AUTH = 'in';
  await c.restart();
  await until(() => service.session.status().alive && service.session.status().error === null, '登录好了以后起来');
  await until(() => service.ledger.getMessage(id).state === 'processed', '留下的消息被处理');
});

test('what a Router turn says about the quota of its account is that account\'s usage', options, async (t) => {
  const { start, dataDir, greet, say } = stage(t, {});
  const account = accountOn('router');
  const service = await start({}, {
    logins: { router: account },
    credentials: { router: TOKEN },
    settings: { 'router.account': 'router', 'router.tier': TIER },
  });
  await greet(service);
  assert.deepEqual(service.ledger.loginState('router').usage, [], '还没有回合说过额度');
  const id = say(service, '报额度');
  await until(() => service.ledger.getMessage(id).state === 'processed', '回合结束');
  const usage = service.ledger.loginState('router').usage;
  assert.deepEqual(usage.map(({ window, used, resets_at }) => [window, used, resets_at]), [
    ['five_hour', 0.63, new Date(1793795400 * 1000).toISOString()],
    ['seven_day', 0.66, new Date(1794081600 * 1000).toISOString()],
  ]);
  assert.ok(usage.every(({ at }) => Date.parse(at) > Date.now() - 60_000), '带着读到的时刻');
});

test('a session is reopened when the account changes', options, async (t) => {
  const { start, dataDir, greet, routerStarts } = stage(t, {});
  const first = accountOn('one');
  const second = accountOn('two');
  const service = await start({}, {
    logins: { one: first, two: second },
    credentials: { one: TOKEN, two: TOKEN },
    settings: { 'router.account': 'one', 'router.tier': TIER },
  });
  const c = await client(service);
  await greet(service);
  const opened = service.ledger.currentContext(service.ledger.listProjects()[0]?.id ?? '')!;

  // The same account: the conversation is where it was, and is resumed.
  await c.restart();
  await greet(service);
  await until(() => routerStarts() === 2, '按原账号重启');
  assert.equal(service.ledger.currentContext(service.ledger.listProjects()[0]?.id ?? '')!.id, opened.id, '同一个会话');
  assert.ok(startsOf(dataDir)[1]!.includes('--resume'), '同一个账号：续接');

  // Another account: the conversation is that account's, and this one is not it.
  assert.equal((await c.put('router.account', 'two')).status, 200);
  await c.restart();
  await greet(service);
  await until(() => routerStarts() === 3, '改绑以后重启');
  assert.notEqual(service.ledger.currentContext(service.ledger.listProjects()[0]?.id ?? '')!.id, opened.id, '换了账号就是新会话');
  assert.ok(!startsOf(dataDir)[2]!.includes('--resume'), '不拿别的账号的会话去续');

  // Back to the login this computer has: the account is unbound, and nothing of its login
  // is left in the environment.
  assert.equal((await c.put('router.account', '')).status, 200);
  assert.equal((await c.put('router.tier', '')).status, 200);
  await c.restart();
  await greet(service);
  await until(() => routerStarts() === 4, '解绑以后重启');
  const unbound = logOf(dataDir).filter(({ argv }) => argv).at(-1)!;
  assert.deepEqual([unbound.config_dir, unbound.token_ok ?? false], [null, false], '解绑后不再用账号的令牌');
  // No tier: settings file is an empty object without hidden exclusions.
  const argv = startsOf(dataDir)[3]!;
  assert.deepEqual(JSON.parse(readFileSync(argv[argv.indexOf('--settings') + 1]!, 'utf8')), {}, '没有账号、没有档位，设置为空对象');
});

test('deleting the account a running Router holds stops it without waiting for a restart', options, async (t) => {
  const { start, dataDir, greet, routerStarts } = stage(t, {});
  const account = accountOn('router');
  const service = await start({}, {
    logins: { router: account },
    credentials: { router: TOKEN },
    settings: { 'router.account': 'router', 'router.tier': TIER },
  });
  const c = await client(service);
  await greet(service);
  assert.equal(routerStarts(), 1);

  // Nobody clicks 重启负责人: the account goes while the process is up and holding it.
  assert.equal((await c.dropAccount('router')).status, 200);
  const { id } = await json(await c.post('/api/messages', { text: '账号没了以后发的' }));
  await until(() => service.session.status().error !== null, '账号被删以后停摆');
  const stopped = await c.router();
  assert.deepEqual([stopped.alive, stopped.restarting], [false, false], '进程也停下了');
  assert.match(stopped.error!, /账号 router 已经不在了/);
  assert.match(stopped.error!, /重启负责人/, '理由说去哪里改');
  assert.equal(routerStarts(), 1, '没有再起一个负责人');
  assert.equal(service.ledger.getMessage(id).state, 'received', '排队的那条原样留着');
  assert.equal((await c.get('/api/overview')).status, 200, '服务照常');
  assert.equal((await c.get('/api/doctor')).status, 200, '自检照常');
});

test('the login check is about the token the next start would take once the running one is replaced', options, async (t) => {
  const NEW = 'the-replacement-token';
  const { start, dataDir, greet, routerStarts } = stage(t, {});
  const account = accountOn('router');
  process.env.FAKE_CLAUDE_EXPECT_TOKEN = TOKEN;
  t.after(() => delete process.env.FAKE_CLAUDE_EXPECT_TOKEN);
  const service = await start({}, {
    logins: { router: account },
    credentials: { router: TOKEN },
    settings: { 'router.account': 'router', 'router.tier': TIER },
  });
  const c = await client(service);
  await greet(service);
  assert.match((await c.facts())['负责人的 Claude 登录']!, /查的是负责人正在用的那一份/);

  // A new token for the same account, with the process still running on the old one.
  process.env.FAKE_CLAUDE_EXPECT_TOKEN = NEW;
  // Replaced the way signing in again replaces it: through the store, not a form.
  service.accounts.setCredential('router', NEW, { actor: 'test' });
  const login = (await c.facts())['负责人的 Claude 登录']!;
  assert.match(login, /账本里已经换掉了/, '说清楚运行中那份查不了');
  assert.match(login, /下次启动会用/, '说清楚查的是哪一份');
  assert.ok(!login.includes('查的是负责人正在用的那一份'), '不把新令牌的检查说成运行中进程的登录');
  const check = ((await json(await c.get('/api/doctor'))).checks as { id: string; text: string }[]).find(({ id }) => id === 'claude-login')!;
  assert.equal(check.text, login, '自检和设置页说同一件事');
  // The account and the login directory shown are still the running process's.
  assert.equal((await c.facts())['负责人正在用的账号'], 'router');
  assert.equal(routerStarts(), 1, '没有重启过负责人');
  assert.equal(logOf(dataDir).filter(({ auth }) => auth).at(-1)!.token_ok, true, '查的是新令牌');
});

test('a token the CLI writes back reaches no log, page or notice, and the account reads as one to fill in again', options, async (t) => {
  const { start, dataDir, greet } = stage(t, {});
  const account = accountOn('router');
  process.env.FAKE_CLAUDE_EXPECT_TOKEN = TOKEN;
  t.after(() => delete process.env.FAKE_CLAUDE_EXPECT_TOKEN);
  const complaints: string[] = [];
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: unknown, ...rest: unknown[]): boolean => {
    complaints.push(String(chunk));
    return (write as (...args: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof process.stderr.write;
  t.after(() => {
    process.stderr.write = write;
  });
  const service = await start({}, {
    logins: { router: account },
    credentials: { router: TOKEN },
    settings: { 'router.account': 'router', 'router.tier': TIER },
  });
  const c = await client(service);
  await greet(service);

  // Diagnostics of the kind that carry the token: the CLI writes it on stderr and in the
  // result line of a login the API no longer takes.
  const { id } = await json(await c.post('/api/messages', { text: '回显令牌' }));  await until(() => service.session.status().error !== null, '登录被拒以后停摆');
  // The turn the refusal came in on is nobody's completed work: it is left to be looked at.
  await until(() => service.ledger.getMessage(id).state === 'unverified', '那条消息记为待核实');
  const reason = (await c.router()).error!;
  assert.match(reason, /负责人用的账号 router 的登录已失效/);
  assert.ok(!reason.includes(TOKEN), `停摆理由里有令牌：${reason}`);
  assert.match(reason, /令牌已隐去/);
  // The exit line carries what the CLI wrote on stderr: waiting for it is what shows the
  // log is clean rather than that nothing was logged yet.
  await until(() => complaints.join('').includes('负责人进程退出'), '被拒的进程退出并记日志');
  assert.ok(!complaints.join('').includes(TOKEN), '服务日志里有令牌');
  for (const path of ['/api/state', '/api/accounts', '/api/settings', '/api/overview', '/api/doctor']) {
    assert.ok(!(await (await c.get(path)).text()).includes(TOKEN), `${path} 里有令牌`);
  }
  for (const table of ['outbox', 'message', 'change', 'account']) {
    assert.ok(!JSON.stringify(rowsOf(dataDir, table)).includes(TOKEN), `${table} 里有令牌`);
  }
  assert.ok(!readFileSync(join(dataDir, 'fake.log'), 'utf8').includes(TOKEN), '假 CLI 的日志里有令牌');
  // The statement is the account's: the Workers see the same token as unusable, and the
  // owner is told to fill one in. What the ledger holds of it is the number this process
  // was started with, marked on the account; the notice itself goes to 企业微信, which
  // this service has no Bot ID for, so no channel is enabled and no Outbox row is queued.
  assert.equal((await c.credentials())['router'], 'rejected');
  const row = <T>(table: string): T => (rowsOf(dataDir, table) as { id: string }[]).find(({ id }) => id === 'router') as T;
  const held = row<{ credential_ref: string | null }>('account');
  const rejection = row<{ credential_rejected_ref: string | null }>('login_state');
  assert.notEqual(held.credential_ref, null, '账号有一个登录令牌');
  assert.equal(rejection.credential_rejected_ref, held.credential_ref, '账号在账本里被记为要重新填');
});
