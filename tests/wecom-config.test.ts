// Guards against the WeCom channel, now set up in the console, needing a restart to take
// a change, keeping an old connection open beside the new one, or being switched on
// with nothing to sign in with; against the Secret getting out of its file: into an
// answer of any interface, a change row, the ledger (which backups carry away) or a log;
// against that file being readable by other users of the machine; against a new owner
// who cannot talk to the bot because the whitelist still names the old one, a crash
// between the two writes included; against "back to the default" emptying the receiver
// of a channel that is on; against the Secret being set past the login, the Origin check
// or the recovery barrier; and against the file and the ledger disagreeing in silence:
// a Secret replaced on disk while its record was refused (so the running connection
// keeps the old one and the next start takes the new), an answer that says stored when
// the file never got into place, or a half-written draft surviving a crash.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { discardSecret, putSecret, readSecret, replaceSecret, wecomSecretFile } from '../service/secrets.ts';
import { consoleApp } from './console-helpers.ts';
import { fixture } from './helpers.ts';
import type { Service } from './stage.ts';
import { signIn, stage, until } from './stage.ts';
import { startGateway } from './wecom-gateway.mjs';

const options = { timeout: 60_000 };
const json = async (response: Response): Promise<any> => response.json();
const SECRET = 'wecom-s3cret-7f3a9c';

// Waits for something only an answer of the service can tell.
async function eventually(read: () => Promise<unknown>, what: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (!(await read())) {
    if (Date.now() > deadline) throw new Error(`等不到：${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function console_(service: Service) {
  const client = await signIn(service);
  const send = (method: string, path: string, body?: unknown): Promise<Response> =>
    fetch(`${client.base}${path}`, {
      method,
      headers: { Cookie: client.cookie, Origin: client.base, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const set = (key: string, value: unknown): Promise<Response> => send('PUT', `/api/settings/${key}`, { value });
  const secret = (value: unknown): Promise<Response> => send('PUT', '/api/wecom/secret', { secret: value });
  const channel = async () => (await json(await client.get('/api/state'))).channels.wecom as { connected: boolean; error: string | null } | null;
  return { ...client, send, set, secret, channel };
}

// How many times the ledger says a Secret was set, read the way a restart would.
function secretRecords(dataDir: string): number {
  const conn = new DatabaseSync(join(dataDir, 'ledger.db'), { readOnly: true });
  try {
    return (conn.prepare(`SELECT count(*) AS n FROM change WHERE action = 'wecom.secret_set'`).get() as { n: number }).n;
  } finally {
    conn.close();
  }
}

test('the channel is switched on in the console and connects at once; any change to it reconnects with the new values, with no restart', options, async (t) => {
  const gateway = await startGateway();
  t.after(() => gateway.close());
  const { start } = stage(t, {});
  const service = await start();
  const c = await console_(service);
  assert.equal(await c.channel(), null);
  const subscribes = () => gateway.sent('aibot_subscribe').map(({ body }) => [body.bot_id, body.secret]);

  assert.equal((await c.secret(SECRET)).status, 200);
  assert.equal((await c.set('wecom.url', gateway.url)).status, 200);
  assert.equal((await c.set('wecom.owner', 'zhang')).status, 200);
  assert.deepEqual(subscribes(), [], '没启用之前什么都不连');
  assert.equal((await c.set('wecom.botId', 'bot-1')).status, 200);
  await gateway.until(() => subscribes().length === 1, '启用后订阅');
  assert.deepEqual(subscribes(), [['bot-1', SECRET]]);
  await eventually(async () => (await c.channel())?.connected, '已连接');
  await until(() => service.ledger.getWhitelist().wecom, '白名单初始化');
  assert.deepEqual(service.ledger.getWhitelist().wecom, ['zhang'], '首次把接收人加进白名单');
  assert.deepEqual((await c.channel())?.connected, true);

  assert.equal((await c.set('wecom.botId', 'bot-2')).status, 200);
  await gateway.until(() => subscribes().length === 2, '换 Bot ID 后重连');
  assert.deepEqual(subscribes()[1], ['bot-2', SECRET]);

  assert.equal((await c.secret('another-s3cret')).status, 200);
  await gateway.until(() => subscribes().length === 3, '换 Secret 后重连');
  assert.deepEqual(subscribes()[2], ['bot-2', 'another-s3cret']);
  assert.equal(gateway.connections, 3, '每次重连一条新连接');
  await gateway.until(() => gateway.open === 1, '旧连接都关掉，只剩最新的一条');

  // The connection in use is the latest: a notice goes out on it, to whoever is the owner now.
  assert.equal((await c.set('wecom.owner', 'li')).status, 200);
  await gateway.until(() => subscribes().length === 4, '换接收人后重连');
  assert.deepEqual(service.ledger.getWhitelist().wecom, ['li'], '白名单里旧的接收人换成新的');
  service.ledger.enqueueNotification('wecom', 'markdown', { target: { chatid: 'li', chat_type: 1 }, content: '重连之后发的' });
  await gateway.until(() => gateway.sent('aibot_send_msg').some(({ body }) => String(body.markdown?.content).startsWith('【系统】重连之后发的')), '通知从新连接发出');

  assert.equal((await c.set('wecom.botId', '')).status, 200);
  await eventually(async () => (await c.channel()) === null, '停用后断开');
  assert.equal(await c.channel(), null);
  await gateway.until(() => gateway.open === 0, '停用后连接关掉');
  const before = subscribes().length;
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(subscribes().length, before, '停用之后不再重连');
});

test('the owner added by hand stays in the whitelist when the receiver changes; only the receiver\'s place moves', options, async (t) => {
  const gateway = await startGateway();
  t.after(() => gateway.close());
  const { start } = stage(t, {});
  const transactions: string[][] = [];
  const service = await start(
    { ledgerHooks: { beforeCommit: (actions) => void transactions.push([...actions]) } },
    { wecom: { botId: 'bot', secret: SECRET, owner: 'zhang', url: gateway.url } },
  );
  const c = await console_(service);
  await gateway.until(() => gateway.sent('aibot_subscribe').length === 1, '订阅');
  service.ledger.setWhitelist({ ...service.ledger.getWhitelist(), wecom: ['zhang', 'wang'] }, { actor: 'test' });
  transactions.length = 0;
  assert.equal((await c.set('wecom.owner', 'li')).status, 200);
  assert.deepEqual(service.ledger.getWhitelist().wecom, ['wang', 'li']);
  assert.deepEqual(
    transactions.filter((actions) => actions.includes('setting.update') || actions.includes('whitelist.set')),
    [['setting.update', 'whitelist.set']],
    '接收人和白名单是同一个事务',
  );
  await gateway.until(() => gateway.sent('aibot_subscribe').length === 2, '提交之后才重连');
});

for (const when of ['before', 'after'] as const) {
  test(`a crash ${when} the commit that changes the receiver: after the restart the receiver and the whitelist are both ${when === 'before' ? 'the old ones' : 'the new ones'}`, options, async (t) => {
    const gateway = await startGateway();
    t.after(() => gateway.close());
    const { start, crashAt, wreck } = stage(t, {});
    const first = await start({}, { wecom: { botId: 'bot', secret: SECRET, owner: 'zhang', url: gateway.url } });
    const c = await console_(first);
    await until(() => first.ledger.getWhitelist().wecom, '白名单初始化');
    first.ledger.setWhitelist({ ...first.ledger.getWhitelist(), wecom: ['zhang', 'wang'] }, { actor: 'test' });
    // Either row names the one transaction they are both in. Were they two, the crash
    // would fall between them and leave the new receiver without a place in the list.
    const crashed = crashAt(when === 'before' ? 'whitelist.set' : 'setting.update', when);
    const answer = await c.set('wecom.owner', 'li');
    await crashed;
    assert.ok(answer.status >= 500, String(answer.status));
    await wreck(first);

    const service = await start();
    const [owner, wecom] = when === 'before' ? ['zhang', ['zhang', 'wang']] : ['li', ['wang', 'li']];
    assert.equal(service.settings.get('wecom.owner'), owner);
    assert.deepEqual(service.ledger.getWhitelist().wecom, wecom);
  });
}

test('"back to the default" on the receiver of a channel that is on is refused like saving an empty one, and the channel goes on as it was', options, async (t) => {
  const gateway = await startGateway();
  t.after(() => gateway.close());
  const { start } = stage(t, {});
  const service = await start({}, { wecom: { botId: 'bot', secret: SECRET, owner: 'zhang', url: gateway.url } });
  const c = await console_(service);
  await gateway.until(() => gateway.sent('aibot_subscribe').length === 1, '订阅');
  const emptied = await c.set('wecom.owner', '');
  const reset = await c.send('DELETE', '/api/settings/wecom.owner');
  assert.deepEqual([emptied.status, reset.status], [400, 400]);
  const reason = (await json(reset)).error;
  assert.match(reason, /企业微信启用着，接收人不能为空/);
  assert.equal(reason, (await json(emptied)).error, '两个入口同一句话');
  assert.equal(service.settings.get('wecom.owner'), 'zhang');
  assert.deepEqual(service.ledger.getWhitelist().wecom, ['zhang']);
  await sleep(200);
  assert.equal(gateway.sent('aibot_subscribe').length, 1, '被拒的改动不重连');
});

test('switching the bot on without a Secret, or without anyone to tell, is refused with what to fill in first', options, async (t) => {
  const { start } = stage(t, {});
  const service = await start();
  const c = await console_(service);
  const noSecret = await c.set('wecom.botId', 'bot');
  assert.equal(noSecret.status, 400);
  assert.match((await json(noSecret)).error, /还没有设置企业微信的 Secret：先填 Secret/);
  assert.equal((await c.secret(SECRET)).status, 200);
  const noOwner = await c.set('wecom.botId', 'bot');
  assert.equal(noOwner.status, 400);
  assert.match((await json(noOwner)).error, /先填接收人/);
  assert.equal(service.settings.get('wecom.botId'), '');
  assert.equal(await c.channel(), null);
  for (const bad of ['', '   ', 7, null, 'two words', 'x'.repeat(501)]) {
    const refused = await c.secret(bad);
    assert.equal(refused.status, 400, JSON.stringify(bad));
  }
  assert.equal(readSecret(wecomSecretFile(service.dataDir)), SECRET, '被拒的 Secret 不覆盖原来的');
});

test('the Secret is in its file and nowhere else: no answer, no change row, no ledger row and no log line carries it', options, async (t) => {
  const gateway = await startGateway();
  t.after(() => gateway.close());
  const lines: string[] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => { lines.push(args.map(String).join(' ')); });
  const { start, dataDir, stop } = stage(t);
  const service = await start();
  const c = await console_(service);
  const answers: string[] = [];
  const keep = async (response: Response): Promise<Response> => {
    answers.push(await response.clone().text());
    return response;
  };
  const stored = await keep(await c.secret(`  ${SECRET}\n`));
  assert.deepEqual(await json(stored), { secret_set: true });
  await keep(await c.set('wecom.url', gateway.url));
  await keep(await c.set('wecom.owner', 'zhang'));
  await keep(await c.set('wecom.botId', 'bot'));
  await gateway.until(() => gateway.sent('aibot_subscribe').length === 1, '订阅');
  assert.equal(gateway.sent('aibot_subscribe')[0]!.body.secret, SECRET, '它确实被用上了，去掉了首尾空白');
  // A subscription the gateway refuses is the one place an error could quote it.
  gateway.answer = (frame) => (frame.cmd === 'aibot_subscribe' ? { errcode: 40001, errmsg: 'invalid secret' } : { errcode: 0, errmsg: 'ok' });
  await keep(await c.secret(`${SECRET}-2`));
  await eventually(async () => (await c.channel())?.error, '订阅被拒');
  for (const path of ['/api/settings', '/api/state', '/api/doctor', '/api/overview', '/api/accounts', '/api/messages', '/api/tasks']) {
    await keep(await c.get(path));
  }
  const settingsPage = JSON.parse(answers.find((text) => text.includes('"deployment"'))!) as { wecom: unknown };
  assert.deepEqual(settingsPage.wecom, { secret_set: true });
  await stop(service);

  assert.equal(readFileSync(wecomSecretFile(dataDir), 'utf8'), `${SECRET}-2\n`);
  for (const text of [...answers, ...lines]) assert.ok(!text.includes(SECRET), text.slice(0, 200));
  assert.ok(lines.some((line) => line.includes('订阅失败')), '失败照样有日志，只是不带 Secret');
  const conn = new DatabaseSync(join(dataDir, 'ledger.db'), { readOnly: true });
  try {
    const tables = conn.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as { name: string }[];
    for (const { name } of tables) {
      assert.ok(!JSON.stringify(conn.prepare(`SELECT * FROM ${name}`).all()).includes(SECRET), `账本的 ${name} 表`);
    }
    const noted = conn.prepare(`SELECT actor, detail_json FROM change WHERE action = 'wecom.secret_set' ORDER BY seq`).all();
    assert.deepEqual(noted.map((row) => ({ ...row })), [{ actor: 'console', detail_json: null }, { actor: 'console', detail_json: null }], '只记有人设过，不记是什么');
  } finally {
    conn.close();
  }
  for (const file of ['degraded.log', 'service.json', 'login-token']) {
    if (existsSync(join(dataDir, file))) assert.ok(!readFileSync(join(dataDir, file), 'utf8').includes(SECRET), file);
  }
});

test('the Secret file can be read by the user the service runs as and by nobody else', (t) => {
  const f = fixture(t);
  const file = wecomSecretFile(f.dir);
  putSecret(file, SECRET);
  putSecret(file, `${SECRET}-next`);
  assert.equal(readSecret(file), `${SECRET}-next`);
  assert.equal(existsSync(`${file}.new`), false, '不留半成品');
  if (process.platform !== 'win32') {
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(statSync(join(f.dir, 'secrets')).mode & 0o777, 0o700);
    return;
  }
  // One entry, this user's, and nothing inherited from wherever the data directory is.
  const acl = execFileSync('icacls', [file], { encoding: 'utf8' });
  const entries = acl.split(/\r?\n/).map((line) => line.replace(file, '').trim()).filter((line) => /:\(/.test(line));
  assert.equal(entries.length, 1, acl);
  assert.match(entries[0]!, /:\(F\)$/, acl);
  assert.ok(entries[0]!.toLowerCase().includes(userInfo().username.toLowerCase()), acl);
  assert.ok(!/\(I\)/.test(acl), '没有继承来的权限');
});

test('a Secret that cannot be stored is not said to be set, and leaves the old one', (t) => {
  const f = fixture(t);
  const file = wecomSecretFile(f.dir);
  assert.equal(readSecret(file), '', '没设过就是空');
  putSecret(file, SECRET);
  assert.throws(() => putSecret(file, ''), /Secret 不能为空/);
  assert.throws(() => putSecret(file, 'a b'), /不含空白/);
  assert.equal(readSecret(file), SECRET);
});

test('a Secret is replaced in steps: the draft is not in force until the record is committed, and is gone if that or putting it in place fails', (t) => {
  const f = fixture(t);
  const file = wecomSecretFile(f.dir);
  const draft = `${file}.new`;
  putSecret(file, SECRET);

  const refused = (): void => {
    assert.equal(readSecret(file), SECRET, '准备好的还没生效');
    assert.equal(readFileSync(draft, 'utf8'), `${SECRET}-next\n`);
    if (process.platform !== 'win32') assert.equal(statSync(draft).mode & 0o777, 0o600, '临时文件一开始就只有自己能读');
    throw new Error('账本拒绝了');
  };
  assert.throws(() => replaceSecret(file, `  ${SECRET}-next\n`, refused), /账本拒绝了/);
  assert.equal(existsSync(draft), false);
  assert.equal(readSecret(file), SECRET);

  assert.throws(() => replaceSecret(file, 'a b', () => assert.fail('校验没过不该记账')), /不含空白/);
  assert.equal(existsSync(draft), false, '校验没过就不写临时文件');

  assert.throws(
    () => replaceSecret(file, `${SECRET}-next`, () => {}, () => { throw new Error('EPERM: operation not permitted, rename'); }),
    (err: Error) => /Secret 没有存下来：EPERM/.test(err.message) && !err.message.includes(SECRET),
  );
  assert.equal(readSecret(file), SECRET, '改名失败：原来的 Secret 不变');
  assert.equal(existsSync(draft), false, '改名失败：临时文件删掉');

  replaceSecret(file, `${SECRET}-next`, () => {});
  assert.equal(readSecret(file), `${SECRET}-next`);
  assert.equal(existsSync(draft), false);

  // What a process that died between the steps leaves behind.
  writeFileSync(draft, 'half');
  assert.equal(discardSecret(file), true);
  assert.equal(existsSync(draft), false);
  assert.equal(discardSecret(file), false, '没有临时文件时说没有');
});

test('a Secret whose record the ledger refuses is not stored: the old one stays on disk, no draft is left, the answer is a failure and the channel is not reconnected', options, async (t) => {
  const gateway = await startGateway();
  t.after(() => gateway.close());
  const { start, dataDir } = stage(t, {});
  const refusing = { on: false };
  const service = await start(
    { ledgerHooks: { beforeCommit(actions) { if (refusing.on && actions.includes('wecom.secret_set')) throw new Error('commit refused'); } } },
    { wecom: { botId: 'bot', secret: SECRET, owner: 'zhang', url: gateway.url } },
  );
  const c = await console_(service);
  const file = wecomSecretFile(dataDir);
  const subscribes = () => gateway.sent('aibot_subscribe').map(({ body }) => body.secret);
  await gateway.until(() => subscribes().length === 1, '订阅');

  refusing.on = true;
  const failed = await c.secret('another-s3cret');
  assert.ok(failed.status >= 500, String(failed.status));
  assert.ok(!(await failed.text()).includes('another-s3cret'));
  assert.equal(readFileSync(file, 'utf8'), `${SECRET}\n`, '账本没记下，磁盘上的 Secret 就不换');
  assert.equal(existsSync(`${file}.new`), false, '不留临时文件');
  assert.equal(secretRecords(dataDir), 0);
  await sleep(300);
  assert.deepEqual(subscribes(), [SECRET], '没换成就不重连');

  refusing.on = false;
  assert.equal((await c.secret('another-s3cret')).status, 200);
  await gateway.until(() => subscribes().length === 2, '换成之后重连');
  assert.deepEqual(subscribes(), [SECRET, 'another-s3cret']);
  assert.equal(secretRecords(dataDir), 1);
});

test('a Secret that is recorded but cannot be moved into place is reported as a failure: the old one stays and the channel is not reconnected', options, async (t) => {
  const gateway = await startGateway();
  t.after(() => gateway.close());
  const { start, dataDir } = stage(t, {});
  const file = wecomSecretFile(dataDir);
  const sabotage = { on: false };
  const service = await start(
    {
      ledgerHooks: {
        // Without `force`: this also shows the draft is on disk before the record is committed.
        beforeCommit(actions) { if (sabotage.on && actions.includes('wecom.secret_set')) rmSync(`${file}.new`); },
      },
    },
    { wecom: { botId: 'bot', secret: SECRET, owner: 'zhang', url: gateway.url } },
  );
  const c = await console_(service);
  const subscribes = () => gateway.sent('aibot_subscribe').map(({ body }) => body.secret);
  await gateway.until(() => subscribes().length === 1, '订阅');

  sabotage.on = true;
  const failed = await c.secret('another-s3cret');
  assert.equal(failed.status, 500);
  const reason = await failed.text();
  assert.match(reason, /Secret 没有存下来/);
  assert.ok(!reason.includes('another-s3cret'));
  assert.equal(readFileSync(file, 'utf8'), `${SECRET}\n`);
  assert.equal(existsSync(`${file}.new`), false);
  await sleep(300);
  assert.deepEqual(subscribes(), [SECRET], '没换成就不重连');
  // The one trace: the ledger says someone set it at that moment, and the answer said it failed.
  assert.equal(secretRecords(dataDir), 1);
});

test('a draft of the Secret left by a crash is removed at the next start with a line in the log, and the Secret in use is still the old one', options, async (t) => {
  const gateway = await startGateway();
  t.after(() => gateway.close());
  const lines: string[] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => { lines.push(args.map(String).join(' ')); });
  const { start, stop, dataDir } = stage(t, {});
  const file = wecomSecretFile(dataDir);
  const first = await start({}, { wecom: { botId: 'bot', secret: SECRET, owner: 'zhang', url: gateway.url } });
  await gateway.until(() => gateway.sent('aibot_subscribe').length === 1, '订阅');
  await stop(first);
  writeFileSync(`${file}.new`, 'half-written-s3cret\n');
  lines.length = 0;

  await start();
  assert.equal(existsSync(`${file}.new`), false);
  assert.equal(readFileSync(file, 'utf8'), `${SECRET}\n`);
  await gateway.until(() => gateway.sent('aibot_subscribe').length === 2, '重启后订阅');
  assert.equal(gateway.sent('aibot_subscribe')[1]!.body.secret, SECRET);
  assert.equal(lines.filter((line) => /没换完的企业微信 Secret/.test(line)).length, 1, lines.join('\n'));
  for (const line of lines) assert.ok(!line.includes('half-written-s3cret') && !line.includes(SECRET), line.slice(0, 200));
});

test('PUT /api/wecom/secret follows the rules of the other controls, and answers only that one is set', async (t) => {
  const barrier = { recovering: false };
  const f = fixture(t, { recovery: { recovering: () => barrier.recovering } });
  const { send, get, url, cookie } = await consoleApp(t, { f });
  const file = wecomSecretFile(f.dir);
  assert.equal((await send('PUT', '/api/wecom/secret', { secret: SECRET }, { Origin: url })).status, 401);
  assert.equal((await send('PUT', '/api/wecom/secret', { secret: SECRET }, { Cookie: cookie, Origin: 'http://elsewhere.test' })).status, 403);
  barrier.recovering = true;
  const held = await send('PUT', '/api/wecom/secret', { secret: SECRET });
  assert.equal(held.status, 503);
  assert.match((await json(held)).error, /恢复清点/);
  barrier.recovering = false;
  assert.equal(readSecret(file), '');
  assert.deepEqual((await json(await get('/api/settings'))).wecom, { secret_set: false });

  const done = await send('PUT', '/api/wecom/secret', { secret: SECRET });
  assert.equal(done.status, 200);
  assert.deepEqual(await json(done), { secret_set: true });
  assert.equal(readSecret(file), SECRET);
  assert.deepEqual((await json(await get('/api/settings'))).wecom, { secret_set: true });
  assert.equal((await get('/api/wecom/secret')).status, 404, '没有读它的接口');
  const refused = await send('PUT', '/api/wecom/secret', { secret: '' });
  assert.equal(refused.status, 400);
  assert.equal(f.peek(`SELECT 1 FROM change WHERE action = 'wecom.secret_set'`).length, 1, '没存下来的那次不留记录');
});
