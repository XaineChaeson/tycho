// Guards against a setting that lies: a default or override not being what is in force, a
// value outside its range or of the wrong kind getting stored, a value and its audit row
// parting ways in a crash, an edit that takes a restart or a key from another version
// being lost by a write, listeners firing when nothing changed or taking the write down
// with them, a write landing while the ledger cannot be trusted, a read failing in the
// degraded mode that still needs it, a whole service that goes on using old values, a
// stored value this version will not take being hidden from the list, a misspelt key
// that only fails once it runs, a help text silent about when a change takes hold, a Run
// in flight having its limit changed under it, a change and what it brings with it
// being committed apart (a crash between them leaves one without the other), and "back
// to the default" reaching a state that saving would be refused.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { DegradedError, InputError } from '../service/errors.ts';
import type { LedgerOptions } from '../service/ledger.ts';
import type { Definition, SettingKey, Settings } from '../service/settings.ts';
import { createSettings, problem, settingKey, SETTINGS } from '../service/settings.ts';
import { fixture, USER } from './helpers.ts';
import { signIn, stage, until } from './stage.ts';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const options = { timeout: 60_000 };

function setup(t: TestContext, ledgerOptions: LedgerOptions = {}) {
  const f = fixture(t, ledgerOptions);
  const logs: string[] = [];
  const settings = createSettings({ ledger: f.ledger, log: (line) => logs.push(line) });
  const stored = (): Record<string, unknown> => JSON.parse(f.peek<{ value_json: string }>(`SELECT value_json FROM setting WHERE key = 'tunables'`)[0]?.value_json ?? '{}');
  const changes = () => f.peek<{ actor: string; detail_json: string }>(`SELECT actor, detail_json FROM change WHERE action = 'setting.update' ORDER BY seq`);
  return { f, settings, logs, stored, changes };
}

const entry = (settings: ReturnType<typeof createSettings>, key: SettingKey) => settings.list().find((each) => each.key === key)!;

test('every item is declared whole, and its default is one it would accept', () => {
  for (const [key, definition] of Object.entries(SETTINGS) as [string, Definition][]) {
    assert.equal(problem(definition, definition.default), null, key);
    assert.ok(definition.group && definition.title && definition.help, key);
  }
});

test('with nothing stored every item is its default, and nothing has to be written to get there', (t) => {
  const { settings, stored } = setup(t);
  assert.equal(settings.get('run.timeoutMs'), 3 * HOUR);
  assert.equal(settings.get('run.lostGraceMs'), 10 * MINUTE);
  assert.equal(settings.get('run.maxLostContinuations'), 3);
  assert.equal(settings.get('router.turnTimeoutMs'), 30 * MINUTE);
  assert.equal(settings.get('outbox.giveUpAfterMs'), HOUR);
  assert.equal(settings.get('login.linkTtlMs'), 10 * MINUTE);
  assert.equal(settings.get('login.sessionDays'), 30);
  assert.equal(settings.get('backup.dir'), '');
  assert.equal(settings.get('backup.at'), '03:30');
  assert.equal(settings.get('backup.keepDays'), 14);
  assert.equal(settings.get('retention.endedDays'), 7);
  assert.deepEqual(stored(), {});
});

test('an override is what is in force, only it is stored, and a new reader finds it', (t) => {
  const { f, settings, stored } = setup(t);
  settings.set('login.sessionDays', 7, USER);
  assert.equal(settings.get('login.sessionDays'), 7);
  assert.deepEqual(stored(), { 'login.sessionDays': 7 });
  assert.equal(createSettings({ ledger: f.open() }).get('login.sessionDays'), 7);
});

test('going back to the default drops the override and is audited; with none it does nothing', (t) => {
  const { settings, stored, changes } = setup(t);
  settings.set('backup.keepDays', 30, USER);
  settings.reset('backup.keepDays', USER);
  assert.equal(settings.get('backup.keepDays'), 14);
  assert.deepEqual(stored(), {});
  assert.deepEqual(changes().map(({ detail_json: detail }) => JSON.parse(detail)), [
    { key: 'backup.keepDays', from: 14, to: 30 },
    { key: 'backup.keepDays', from: 30, to: 14 },
  ]);
  settings.reset('backup.keepDays', USER);
  assert.equal(changes().length, 2);
});

test('the list says what each item is, what it is now, and who last changed it', (t) => {
  const { settings } = setup(t);
  const fresh = entry(settings, 'run.timeoutMs');
  assert.deepEqual(
    { ...fresh },
    {
      key: 'run.timeoutMs', group: '执行', title: '单次执行时限', help: fresh.help, type: 'duration', unit: 'hours',
      default: 3 * HOUR, min: MINUTE, max: 7 * 24 * HOUR, restart: false,
      value: 3 * HOUR, stored: false, overridden: false, updated_at: null, updated_by: null,
    },
  );
  settings.set('run.timeoutMs', HOUR, { actor: 'console' });
  settings.set('run.timeoutMs', 2 * HOUR, { actor: 'owner' });
  const changed = entry(settings, 'run.timeoutMs');
  assert.deepEqual([changed.value, changed.stored, changed.overridden, changed.updated_by], [2 * HOUR, true, true, 'owner']);
  assert.ok(changed.updated_at);
  assert.deepEqual(settings.list().map(({ key }) => key), Object.keys(SETTINGS));
});

test('each kind refuses what it cannot hold, up to and including its bounds', () => {
  const duration: Definition = { group: 'g', title: 't', help: 'h', type: 'duration', unit: 'minutes', default: MINUTE, min: MINUTE, max: HOUR };
  const integer: Definition = { group: 'g', title: 't', help: 'h', type: 'integer', default: 2, min: 1, max: 5 };
  const clock: Definition = { group: 'g', title: 't', help: 'h', type: 'clock', default: '00:00' };
  const directory: Definition = { group: 'g', title: 't', help: 'h', type: 'directory', default: '' };
  const flag: Definition = { group: 'g', title: 't', help: 'h', type: 'boolean', default: false };
  for (const good of [MINUTE, HOUR]) assert.equal(problem(duration, good), null);
  assert.match(problem(duration, MINUTE - 1)!, /不能小于 1 分钟/);
  assert.match(problem(duration, HOUR + 1)!, /不能大于 1 小时/);
  for (const bad of [1.5 * MINUTE + 0.5, '60000', null, undefined, NaN, Infinity]) assert.match(problem(duration, bad)!, /应为数字/);
  for (const good of [1, 5]) assert.equal(problem(integer, good), null);
  assert.match(problem(integer, 0)!, /不能小于 1/);
  assert.match(problem(integer, 6)!, /不能大于 5/);
  for (const bad of [1.5, '2', null]) assert.match(problem(integer, bad)!, /应为整数/);
  for (const good of ['00:00', '23:59', '03:30']) assert.equal(problem(clock, good), null);
  for (const bad of ['24:00', '3:30', '03:60', '0330', 330, '']) assert.match(problem(clock, bad)!, /HH:MM/);
  for (const good of ['', 'D:\\b']) assert.equal(problem(directory, good), null);
  for (const bad of [5, null]) assert.match(problem(directory, bad)!, /目录/);
  for (const good of [true, false]) assert.equal(problem(flag, good), null);
  for (const bad of ['true', 1, null]) assert.match(problem(flag, bad)!, /开或关/);
});

test('入站来源的设置单独一组：签名时间和换密钥的过渡期属于来源，不属于定时规则', (t) => {
  const { settings } = setup(t);
  assert.equal(entry(settings, 'triggers.inboundSkewMs').group, '入站来源');
  assert.equal(entry(settings, 'triggers.inboundRotateMs').group, '入站来源');
  assert.equal(entry(settings, 'triggers.minIntervalMs').group, '触发器');
});

test('保留天数设置：默认 7 天，只收 1 到 3650 的整数', (t) => {
  const { f, settings, stored } = setup(t);
  assert.equal(entry(settings, 'retention.endedDays').group, '保留');
  assert.equal(settings.get('retention.endedDays'), 7);
  for (const bad of [0, 3651, 7.5]) {
    assert.throws(() => settings.set('retention.endedDays', bad, USER), InputError, String(bad));
  }
  settings.set('retention.endedDays', 1, USER);
  assert.deepEqual(stored(), { 'retention.endedDays': 1 });
  assert.equal(createSettings({ ledger: f.open() }).get('retention.endedDays'), 1);
  settings.set('retention.endedDays', 3650, USER);
  assert.equal(settings.get('retention.endedDays'), 3650);
});

test('a refused write says which item and why, and leaves no trace', (t) => {
  const { f, settings, changes } = setup(t);
  const before = f.dump();
  assert.throws(() => settings.set('login.sessionDays', 0, USER), (err: Error) => err instanceof InputError && err.message === '登录保持天数不能小于 1');
  assert.throws(() => settings.set('run.timeoutMs', 1000, USER), /单次执行时限不能小于 1 分钟/);
  assert.throws(() => settings.set('backup.at', '25:00', USER), /每天备份的时刻应为 24 小时制/);
  assert.deepEqual(f.dump(), before);
  assert.equal(changes().length, 0);
});

test('a name from outside becomes a key only if it is declared', () => {
  assert.equal(settingKey('backup.keepDays'), 'backup.keepDays');
  for (const name of ['nope', '__proto__', 'constructor', '']) {
    assert.throws(() => settingKey(name), (err: Error) => err instanceof InputError && err.message === `没有这个配置项：${name}`);
  }
});

// Never called: these lines are for `npm run typecheck`, which fails on an expectation
// that finds no error.
function writesAreTypedByKey(settings: Settings): void {
  // @ts-expect-error a key that is not declared
  settings.set('backup.keeyDays', 30, USER);
  // @ts-expect-error a key that is not declared
  settings.reset('backup.keeyDays', USER);
  // @ts-expect-error a number where the item holds text
  settings.set('backup.at', 330, USER);
  // @ts-expect-error text where the item holds a number
  settings.set('backup.keepDays', '30', USER);
  // @ts-expect-error a name from outside has to go through settingKey first
  settings.reset('backup.keepDays' as string, USER);
  settings.set('backup.keepDays', 30, USER);
  settings.set('backup.at', '03:30', USER);
  settings.reset(settingKey('backup.at'), USER);
}

test('the help says when a change takes hold, for the items where that is not at once', () => {
  assert.match(SETTINGS['router.turnTimeoutMs'].help, /从下一回合起生效/);
  assert.match(SETTINGS['outbox.giveUpAfterMs'].help, /下一次发送失败时按新值判断/);
  assert.match(SETTINGS['backup.keepDays'].help, /下一次备份时按新值清理/);
});

test('a directory has to exist and be one, and empty is how it is turned off', (t) => {
  const { f, settings } = setup(t);
  const plain = join(f.dir, 'plain');
  writeFileSync(plain, '');
  const missing = join(f.dir, 'nope');
  assert.throws(() => settings.set('backup.dir', missing, USER), (err: Error) => err instanceof InputError && err.message.includes(`目录不存在：${missing}`));
  assert.throws(() => settings.set('backup.dir', plain, USER), /不是目录/);
  settings.set('backup.dir', f.dir, USER);
  assert.equal(settings.get('backup.dir'), f.dir);
  settings.set('backup.dir', '', USER);
  assert.equal(settings.get('backup.dir'), '');
});

test('a crash before the commit leaves neither the value nor its change row, on disk or in memory', (t) => {
  const crash = { armed: false };
  const { f, settings, stored, changes } = setup(t, {
    testHooks: {
      beforeCommit(actions) {
        if (crash.armed && actions.includes('setting.update')) throw new Error('injected crash');
      },
    },
  });
  settings.set('login.sessionDays', 7, USER);
  const seen: string[] = [];
  settings.subscribe((key) => seen.push(key));
  crash.armed = true;
  assert.throws(() => settings.set('login.sessionDays', 9, USER), /injected crash/);
  assert.equal(settings.get('login.sessionDays'), 7);
  assert.deepEqual(stored(), { 'login.sessionDays': 7 });
  assert.equal(changes().length, 1);
  assert.deepEqual(seen, []);
  crash.armed = false;
  f.ledger.close();
  assert.equal(createSettings({ ledger: f.open() }).get('login.sessionDays'), 7);
});

test('what a change brings with it is committed with it or not at all; memory and listeners follow the commit', (t) => {
  const transactions: string[][] = [];
  const crash = { armed: false };
  const f = fixture(t, {
    testHooks: {
      beforeCommit(actions) {
        transactions.push([...actions]);
        if (crash.armed) throw new Error('injected crash');
      },
    },
  });
  const moved: string[] = [];
  const settings = createSettings({
    ledger: f.ledger,
    log: () => {},
    derived: {
      'backup.keepDays'({ from, to }, ctx) {
        moved.push(`${String(from)}->${String(to)}`);
        f.ledger.setWhitelist({ kept: [String(to)] }, ctx);
      },
    },
  });
  const onDisk = () => ({
    days: JSON.parse(f.peek<{ value_json: string }>(`SELECT value_json FROM setting WHERE key = 'tunables'`)[0]?.value_json ?? '{}')['backup.keepDays'],
    kept: JSON.parse(f.peek<{ value_json: string }>(`SELECT value_json FROM setting WHERE key = 'whitelist'`)[0]!.value_json).kept,
  });
  // Read through another connection: what a listener finds there has been committed.
  const heard: unknown[] = [];
  settings.subscribe(() => heard.push(onDisk()));
  transactions.length = 0;

  settings.set('backup.keepDays', 30, USER);
  assert.deepEqual(transactions, [['setting.update', 'whitelist.set']], '一个事务，两条记录');
  assert.deepEqual(heard, [{ days: 30, kept: ['30'] }], '监听在提交之后才被叫到');
  assert.equal(f.peek<{ actor: string }>(`SELECT actor FROM change WHERE action = 'whitelist.set' ORDER BY seq DESC LIMIT 1`)[0]!.actor, 'user', '记在改它的人名下');

  settings.reset('backup.keepDays', USER);
  assert.deepEqual(transactions[1], ['setting.update', 'whitelist.set'], '恢复默认走同一条路');
  assert.deepEqual(onDisk(), { days: undefined, kept: ['14'] });
  settings.set('backup.keepDays', 14, USER);
  assert.deepEqual(moved, ['14->30', '30->14'], '值没变就没有要跟着写的');

  crash.armed = true;
  assert.throws(() => settings.set('backup.keepDays', 40, USER), /injected crash/);
  crash.armed = false;
  assert.deepEqual(onDisk(), { days: undefined, kept: ['14'] }, '提交前崩溃：两样都没写进去');
  assert.equal(settings.get('backup.keepDays'), 14, '内存里的值不先于提交');
  assert.equal(heard.length, 2, '没提交就不通知');
  f.ledger.close();
  assert.equal(createSettings({ ledger: f.open() }).get('backup.keepDays'), 14);
});

test('what a change brings with it failing takes the change down with it', (t) => {
  const f = fixture(t);
  const settings = createSettings({
    ledger: f.ledger,
    log: () => {},
    derived: {
      'backup.keepDays'() {
        throw new Error('跟着写的那一步失败');
      },
    },
  });
  const seen: string[] = [];
  settings.subscribe((key) => seen.push(key));
  assert.throws(() => settings.set('backup.keepDays', 30, USER), /跟着写的那一步失败/);
  assert.equal(settings.get('backup.keepDays'), 14);
  assert.equal(f.peek(`SELECT 1 FROM change WHERE action = 'setting.update'`).length, 0);
  assert.deepEqual(seen, []);
});

test('going back to the default is judged like saving the default: a rule that would refuse the value refuses the reset, in the same words', (t) => {
  const f = fixture(t);
  const rule = { on: false };
  const settings = createSettings({
    ledger: f.ledger,
    log: () => {},
    checks: { 'backup.keepDays': (days) => (rule.on && days === 14 ? '现在不能是 14 天' : null) },
  });
  const refusal = (act: () => void): string => {
    try {
      act();
    } catch (err) {
      assert.ok(err instanceof InputError, String(err));
      return err.message;
    }
    return '';
  };
  settings.set('backup.keepDays', 30, USER);
  rule.on = true;
  assert.equal(refusal(() => settings.reset('backup.keepDays', USER)), '现在不能是 14 天');
  assert.equal(refusal(() => settings.set('backup.keepDays', 14, USER)), '现在不能是 14 天', '和直接保存这个值是同一句话');
  assert.equal(settings.get('backup.keepDays'), 30);
  assert.equal(f.peek(`SELECT 1 FROM change WHERE action = 'setting.update'`).length, 1, '被拒的恢复默认不留记录');
  rule.on = false;
  settings.reset('backup.keepDays', USER);
  assert.equal(settings.get('backup.keepDays'), 14);
});

test('a key this version does not know is ignored and survives every write; a known one with an unusable value is listed as stored, not in force, until it is cleared', (t) => {
  const { f, stored } = setup(t);
  f.force(`INSERT INTO setting (id, created_at, key, value_json) VALUES ('x', 'now', 'tunables', ?)`, JSON.stringify({ 'future.thing': 5, 'login.sessionDays': 'lots' }));
  const settings = createSettings({ ledger: f.open() });
  assert.equal(settings.get('login.sessionDays'), 30);
  const unusable = entry(settings, 'login.sessionDays');
  assert.deepEqual([unusable.value, unusable.stored, unusable.overridden], [30, true, false], '存着却不生效，这两件事要分开说');
  assert.ok(!settings.list().some(({ key }) => (key as string) === 'future.thing'));
  settings.set('backup.keepDays', 30, USER);
  settings.reset('backup.keepDays', USER);
  assert.deepEqual(stored(), { 'future.thing': 5, 'login.sessionDays': 'lots' });
  settings.reset('login.sessionDays', USER);
  assert.deepEqual(stored(), { 'future.thing': 5 }, '恢复默认能清掉用不了的值，不认识的键还在');
  const cleared = entry(createSettings({ ledger: f.open() }), 'login.sessionDays');
  assert.deepEqual([cleared.value, cleared.stored, cleared.overridden], [30, false, false], '重开登记处，该键已不在');
});

test('listeners hear a real change once, and a value that stays is no change', (t) => {
  const { settings, changes } = setup(t);
  const seen: string[] = [];
  const unsubscribe = settings.subscribe((key) => seen.push(`${key}=${settings.get('backup.keepDays')}`));
  settings.set('backup.keepDays', 14, USER);
  assert.deepEqual(seen, [], '和当前值一样');
  assert.equal(changes().length, 0);
  settings.set('backup.keepDays', 30, USER);
  settings.set('backup.keepDays', 30, USER);
  assert.deepEqual(seen, ['backup.keepDays=30'], '通知时新值已经生效');
  settings.reset('backup.keepDays', USER);
  assert.equal(seen.length, 2);
  settings.set('backup.keepDays', 20, USER);
  settings.set('backup.keepDays', 14, USER);
  assert.equal(seen.length, 4);
  settings.reset('backup.keepDays', USER);
  assert.equal(seen.length, 4, '覆盖值等于默认值，恢复默认后值没变');
  unsubscribe();
  settings.set('backup.keepDays', 15, USER);
  assert.equal(seen.length, 4);
});

test('a listener that fails is logged, and neither the write nor the other listeners suffer', (t) => {
  const { settings, logs } = setup(t);
  const seen: string[] = [];
  settings.subscribe(() => {
    throw new Error('排不上');
  });
  settings.subscribe((key) => seen.push(key));
  settings.set('backup.keepDays', 30, USER);
  assert.equal(settings.get('backup.keepDays'), 30);
  assert.deepEqual(seen, ['backup.keepDays']);
  assert.ok(logs.some((line) => line.includes('排不上')));
});

test('during an inventory no write gets through, even one that would change nothing', (t) => {
  const barrier = { recovering: false };
  const { settings, changes } = setup(t, { recovery: { recovering: () => barrier.recovering } });
  settings.set('backup.keepDays', 30, USER);
  barrier.recovering = true;
  assert.throws(() => settings.set('backup.keepDays', 40, USER), (err: Error) => err instanceof DegradedError && /恢复清点/.test(err.message));
  assert.throws(() => settings.set('backup.keepDays', 30, USER), DegradedError);
  assert.throws(() => settings.reset('backup.keepDays', USER), DegradedError);
  assert.equal(settings.get('backup.keepDays'), 30);
  assert.equal(changes().length, 1);
});

test('in degraded mode no write gets through, and reads go on without the ledger', (t) => {
  const crash = { armed: false };
  const { f, settings } = setup(t, {
    testHooks: {
      beforeCommit() {
        if (crash.armed) throw new Error('commit failed');
      },
      beforeRollback() {
        if (crash.armed) throw new Error('rollback failed');
      },
    },
  });
  settings.set('login.sessionDays', 7, USER);
  crash.armed = true;
  assert.throws(() => settings.set('login.sessionDays', 9, USER), DegradedError);
  assert.equal(f.ledger.dispatchConditions().degraded, true);
  assert.equal(f.ledger.dispatchConditions().paused, null, '连接已退役');
  assert.equal(settings.get('login.sessionDays'), 7);
  assert.throws(() => settings.set('backup.keepDays', 30, USER), /降级模式/);
  assert.throws(() => settings.reset('login.sessionDays', USER), /降级模式/);
});

test('through a whole service: a new Run takes the new limit and one in flight keeps its own', options, async (t) => {
  const { start, queued, launched, snapshotOf } = stage(t);
  const service = await start();
  service.settings.set('run.timeoutMs', 2 * HOUR, USER);
  const first = await launched(service, queued(service, '甲'));
  assert.equal(snapshotOf(first).timeout_ms, 2 * HOUR);
  service.settings.set('run.timeoutMs', 5 * HOUR, USER);
  const second = await launched(service, queued(service, '乙'));
  assert.equal(snapshotOf(second).timeout_ms, 5 * HOUR);
  assert.equal(snapshotOf(service.ledger.getRun(first.id)).timeout_ms, 2 * HOUR);
});

test('through a whole service: login settings apply at once, and a test option beats the registry', options, async (t) => {
  const { start, dataDir, say, greet } = stage(t);
  process.env.FAKE_CLAUDE_CONTROL = 'no-result';
  const service = await start({ routerTurnTimeoutMs: 300 });
  service.settings.set('login.linkTtlMs', 5 * MINUTE, USER);
  const left = Date.parse(service.auth.createLink().expires_at) - Date.now();
  assert.ok(left > 4 * MINUTE && left <= 5 * MINUTE);
  const client = await signIn(service);
  assert.equal((await client.get('/api/state')).status, 200);

  await greet(service);
  say(service, '不理会');
  await until(() => readFileSync(join(dataDir, 'fake.log'), 'utf8').includes('"control":"interrupt"'), '回合按测试选项的时限被打断');
});

test('through a whole service: a notification gives up by the setting', options, async (t) => {
  const { start, dataDir } = stage(t);
  const service = await start({}, { wecom: { botId: 'b', secret: 's', owner: 'zhang', url: 'ws://127.0.0.1:1' } });
  service.settings.set('outbox.giveUpAfterMs', MINUTE, USER);
  const { id } = service.ledger.outbox.enqueue('wecom', 'markdown', { target: { chatid: 'zhang', chat_type: 1 }, content: '发不出去' });
  // Past the new limit, well inside the default one.
  const conn = new DatabaseSync(join(dataDir, 'ledger.db'));
  conn.prepare('UPDATE outbox SET first_failed_at = ? WHERE id = ?').run(new Date(Date.now() - 2 * MINUTE).toISOString(), id);
  conn.close();
  await until(() => service.ledger.outbox.listGivenUp().some((row) => row.id === id), '按设置放弃');
});

test('through a whole service: a backup directory chosen on the page works straight away', options, async (t) => {
  const { start, dataDir } = stage(t);
  const service = await start();
  const client = await signIn(service);
  const put = (key: string, value: unknown): Promise<Response> =>
    fetch(`${client.base}/api/settings/${key}`, { method: 'PUT', headers: { Cookie: client.cookie, Origin: client.base }, body: JSON.stringify({ value }) });
  const backup = async () => ((await (await client.get('/api/state')).json()) as { backup: { configured: boolean; last_ok_at?: string | null } }).backup;
  assert.deepEqual(await backup(), { configured: false });
  const dir = join(dataDir, 'backup-disk');
  mkdirSync(dir);
  assert.equal((await put('backup.dir', dir)).status, 200);
  assert.equal((await backup()).configured, true);
  for (let i = 0; i < 500 && !(await backup()).last_ok_at; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok((await backup()).last_ok_at, '刚配置要按补做规则备份一次');
  assert.equal((await put('backup.dir', '')).status, 200);
  assert.deepEqual(await backup(), { configured: false });
  const { deployment } = (await (await client.get('/api/settings')).json()) as { deployment: { title: string; value: string }[] };
  assert.ok(deployment.some(({ title, value }) => title === '数据目录' && value === dataDir));
});
