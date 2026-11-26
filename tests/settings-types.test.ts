// Guards against the kinds of item the console now holds taking a value the service
// cannot use: a port outside the range or not a whole number, a bind address nothing was
// designed for, a path to a file that is not there or is a directory, a public address
// with a path, an address carrying a credential (or a refusal that quotes one back),
// the same address stored two
// ways, a line of text with a line break in it; against an item that takes a restart not
// saying so, or one that takes effect at once not telling whoever uses it; against
// the WeCom channel being switched on with no Secret or nobody to tell, or "back to the
// default" emptying the receiver while it is on; and against the receiver and the
// whitelist entry that lets them command parting ways: written in two commits, so that
// a crash between leaves the new receiver locked out and the old one still let in.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { InputError } from '../service/errors.ts';
import type { LedgerOptions } from '../service/ledger.ts';
import { putSecret, wecomSecretFile } from '../service/secrets.ts';
import { serviceSettings } from '../service/service-settings.ts';
import type { SettingKey, SettingValue } from '../service/settings.ts';
import { problem, SETTINGS } from '../service/settings.ts';
import { TIER_IDS, tierNamesText } from '../shared/tiers.ts';
import { fixture, USER } from './helpers.ts';

function setup(t: TestContext, ledgerOptions: LedgerOptions = {}) {
  const f = fixture(t, ledgerOptions);
  const settings = serviceSettings({ ledger: f.ledger, dataDir: f.dir, log: () => {} });
  // What a page sends: a value that only claims its type.
  const set = (key: SettingKey, value: unknown): void => settings.set(key, value as SettingValue<SettingKey>, USER);
  const refusal = (act: () => void): string => {
    try {
      act();
    } catch (err) {
      assert.ok(err instanceof InputError, String(err));
      return err.message;
    }
    return '';
  };
  const refused = (key: SettingKey, value: unknown): string => refusal(() => set(key, value));
  const resetRefused = (key: SettingKey): string => refusal(() => settings.reset(key, USER));
  const changes = () => f.peek<{ detail_json: string }>(`SELECT detail_json FROM change WHERE action = 'setting.update' ORDER BY seq`).map((row) => JSON.parse(row.detail_json));
  return { f, settings, set, refused, resetRefused, changes };
}

test('a port is a whole number from 1 to 65535', (t) => {
  const { settings, set, refused } = setup(t);
  for (const bad of [0, -1, 65_536, 1.5, '8787', null, NaN]) assert.match(refused('http.port', bad), /端口应为 1 到 65535 的整数/, String(bad));
  set('http.port', 1);
  assert.equal(settings.get('http.port'), 1);
  set('http.port', 65_535);
  assert.equal(settings.get('http.port'), 65_535);
  assert.equal(SETTINGS['http.port'].default, 8787);
});

test('the bind address is the loopback or the wildcard and nothing else', (t) => {
  const { settings, set, refused } = setup(t);
  assert.equal(settings.get('http.host'), '127.0.0.1');
  for (const bad of ['10.0.0.1', 'localhost', '', 0, '0.0.0.0 ']) assert.match(refused('http.host', bad), /只能是 127\.0\.0\.1 或 0\.0\.0\.0/, String(bad));
  set('http.host', '0.0.0.0');
  assert.equal(settings.get('http.host'), '0.0.0.0');
});

test('a file item is empty or a file that exists; a directory in its place is refused', (t) => {
  const { f, settings, set, refused } = setup(t);
  const file = join(f.dir, 'tier.json');
  writeFileSync(file, '{}');
  for (const key of ['router.cli'] as const) {
    assert.match(refused(key, join(f.dir, 'nope')), /文件不存在/);
    assert.match(refused(key, f.dir), /不是文件/);
    assert.match(refused(key, 7), /应为文件路径/);
    set(key, file);
    assert.equal(settings.get(key), file);
    set(key, '');
    assert.equal(settings.get(key), '', '留空是一个值：自动找，或不指定');
  }
});

test('a directory item is empty or a directory that exists', (t) => {
  const { f, settings, set, refused } = setup(t);
  const file = join(f.dir, 'plain');
  writeFileSync(file, '');
  for (const key of ['backup.dir'] as const) {
    assert.match(refused(key, join(f.dir, 'nope')), /目录不存在/);
    assert.match(refused(key, file), /不是目录/);
    const dir = join(f.dir, 'elsewhere');
    mkdirSync(dir);
    set(key, dir);
    assert.equal(settings.get(key), dir);
  }
});

test('the Router account setting is an existing internal id or empty, on one line', (t) => {
  const { f, settings, set, refused } = setup(t);
  const id = '01INTERNALACCOUNTNUMBER';
  f.ledger.putAccount({ id, name: 'gpu', executor: 'claude', tiers: {} }, USER, 'test-ref');
  set('router.account', `  ${id}  `);
  assert.equal(settings.get('router.account'), id, '两头的空白不留');
  assert.match(refused('router.account', 'gpu'), /账号不存在/);
  assert.match(refused('router.account', 'a\nb'), /应为一行文字/);
  assert.match(refused('router.account', 7), /应为一行文字/);
  set('router.account', '');
  assert.equal(settings.get('router.account'), '');
});

test('the Router\'s own tier is one of the names, or empty', (t) => {
  const { settings, set, refused } = setup(t);
  for (const id of TIER_IDS) {
    set('router.tier', id);
    assert.equal(settings.get('router.tier'), id);
  }
  // A name outside them is refused as such, and what was in force stays.
  for (const bad of ['cheap', 'strong', 'escalation', 'default', 'gpu']) {
    assert.equal(refused('router.tier', bad), `负责人的档位只能是${tierNamesText}之一`, bad);
    assert.equal(settings.get('router.tier'), TIER_IDS.at(-1), bad);
  }
  assert.match(refused('router.tier', 'a\nb'), /负责人的档位应为一行文字/);
  assert.match(refused('router.tier', 7), /负责人的档位应为一行文字/);
  set('router.tier', '');
  assert.equal(settings.get('router.tier'), '', '留空是用执行器自己的默认档位');
});

test('an address is the bare base: credentials, a query or a fragment are refused, and never quoted back', (t) => {
  const { refused } = setup(t);
  for (const [what, value] of [
    ['用户名密码', 'http://owner:hunter2-secret@10.0.0.1:8787'],
    ['只有用户名', 'http://hunter2-secret@10.0.0.1:8787'],
    ['查询串', 'http://10.0.0.1:8787/?token=hunter2-secret'],
    ['片段', 'http://10.0.0.1:8787/#hunter2-secret'],
    ['空的查询串', 'http://10.0.0.1:8787/?'],
  ] as const) {
    const message = refused('http.publicUrl', value);
    assert.match(message, /对外地址只写基础地址/, what);
    assert.ok(!message.includes('hunter2-secret'), what);
  }
  for (const bad of ['ftp://x', 'nonsense', 'ws://10.0.0.1:1', 7]) assert.match(refused('http.publicUrl', bad), /对外地址应为/, String(bad));
});

test('an address is stored one way however it was typed, and each item takes its own schemes', (t) => {
  const { settings, set, refused, changes } = setup(t);
  set('http.publicUrl', '  HTTPS://tycho.example:8443/  ');
  assert.equal(settings.get('http.publicUrl'), 'HTTPS://tycho.example:8443');
  set('http.publicUrl', 'HTTPS://tycho.example:8443/');
  assert.equal(changes().length, 1, '同一个地址换个写法不算改动');
  set('http.publicUrl', '');
  assert.equal(settings.get('http.publicUrl'), '');
  assert.match(refused('wecom.url', 'http://x'), /网关地址应为 ws 或 wss 地址/);
  set('wecom.url', 'ws://127.0.0.1:1/');
  assert.equal(settings.get('wecom.url'), 'ws://127.0.0.1:1');
  set('wecom.url', 'wss://wecom.example/channel');
  assert.equal(settings.get('wecom.url'), 'wss://wecom.example/channel');
});

test('a line of text is kept without the blanks around it, and is one line of bounded length', (t) => {
  const { settings, set, refused } = setup(t);
  set('wecom.owner', '  zhang  ');
  assert.equal(settings.get('wecom.owner'), 'zhang');
  for (const bad of ['a\nb', 'a\tb', 'a\u0000b', 7, null]) assert.match(refused('wecom.owner', bad), /应为一行文字/, JSON.stringify(bad));
  assert.match(refused('wecom.owner', 'x'.repeat(201)), /不能超过 200 个字/);
  set('wecom.owner', 'x'.repeat(200));
});

test('every kind judges a stored value the way it judges a new one', () => {
  assert.equal(problem(SETTINGS['http.port'], 8787), null);
  assert.notEqual(problem(SETTINGS['http.port'], '8787'), null);
  assert.equal(problem(SETTINGS['http.host'], '0.0.0.0'), null);
  assert.notEqual(problem(SETTINGS['http.host'], '1.2.3.4'), null);
  assert.equal(problem(SETTINGS['http.publicUrl'], 'http://10.0.0.1:8787'), null);
  assert.notEqual(problem(SETTINGS['http.publicUrl'], 'http://a:b@10.0.0.1'), null);
  // The disk is not asked: a path stays the setting while its drive is away.
  assert.equal(problem(SETTINGS['router.cli'], 'Z:\\gone\\claude.exe'), null);
});

test('the listing says which items take a restart, what a choice offers and what empty means', (t) => {
  const { settings } = setup(t);
  const byKey = Object.fromEntries(settings.list().map((entry) => [entry.key, entry]));
  assert.deepEqual(
    settings.list().filter(({ restart }) => restart).map(({ key }) => key).sort(),
    ['http.host', 'http.port', 'http.reverseProxyPort'],
    '只有监听地址、端口和反代端口要重启',
  );
  assert.deepEqual(byKey['http.host']!.choices, ['127.0.0.1', '0.0.0.0']);
  assert.equal(byKey['http.publicUrl']!.restart, false);
  assert.equal(byKey['router.cli']!.empty, '自动找 claude：先 PATH，再 Windows 桌面应用自带的');
  assert.equal(byKey['router.account']!.empty, '不绑定：用这台电脑自己的登录和默认档位');
  assert.equal(byKey['wecom.botId']!.empty, '不启用企业微信');
  for (const key of ['router.cli', 'router.account', 'router.tier'] as const) {
    assert.match(byKey[key]!.help, /下次启动负责人时生效/, key);
    assert.equal(byKey[key]!.default, '');
  }
  assert.deepEqual(
    Object.fromEntries(['http.port', 'http.host', 'http.publicUrl', 'wecom.botId', 'wecom.owner', 'wecom.url'].map((key) => [key, byKey[key]!.default])),
    { 'http.port': 8787, 'http.host': '127.0.0.1', 'http.publicUrl': '', 'wecom.botId': '', 'wecom.owner': '', 'wecom.url': '' },
  );
});

test('a change is told to whoever uses the item, at once', (t) => {
  const { settings, set } = setup(t);
  const heard: string[] = [];
  settings.subscribe((key) => heard.push(`${key}=${String(settings.get(key))}`));
  set('http.publicUrl', 'http://10.0.0.1:8787');
  set('http.port', 9000);
  assert.deepEqual(heard, ['http.publicUrl=http://10.0.0.1:8787', 'http.port=9000']);
});

test('the WeCom bot is switched on only with a Secret and someone to tell, and that someone cannot be removed while it is on', (t) => {
  const { f, settings, set, refused } = setup(t);
  assert.match(refused('wecom.botId', 'bot'), /先填 Secret/);
  mkdirSync(join(f.dir, 'secrets'), { recursive: true });
  putSecret(wecomSecretFile(f.dir), 's3cret');
  assert.match(refused('wecom.botId', 'bot'), /先填接收人/);
  set('wecom.owner', 'zhang');
  set('wecom.botId', 'bot');
  assert.equal(settings.get('wecom.botId'), 'bot');
  assert.match(refused('wecom.owner', ''), /接收人不能为空/);
  assert.match(refused('wecom.owner', '   '), /接收人不能为空/, '只有空白也是空');
  set('wecom.owner', 'li');
  set('wecom.botId', '');
  set('wecom.owner', '');
  assert.equal(settings.get('wecom.owner'), '');
});

test('"back to the default" on the receiver is refused while the bot is on, in the words saving an empty one gets; a stored value this version will not take can still be cleared', (t) => {
  const { f, settings, set, refused, resetRefused, changes } = setup(t);
  putSecret(wecomSecretFile(f.dir), 's3cret');
  set('wecom.owner', 'zhang');
  set('wecom.botId', 'bot');
  const before = changes().length;
  assert.equal(resetRefused('wecom.owner'), refused('wecom.owner', ''));
  assert.match(resetRefused('wecom.owner'), /企业微信启用着，接收人不能为空。要停用，清空 Bot ID/);
  assert.equal(settings.get('wecom.owner'), 'zhang');
  assert.equal(settings.get('wecom.botId'), 'bot');
  assert.equal(changes().length, before, '被拒的恢复默认不留记录');

  // Switching the bot off is itself a reset away, and then the receiver's goes through.
  settings.reset('wecom.botId', USER);
  assert.equal(settings.get('wecom.botId'), '');
  settings.reset('wecom.owner', USER);
  assert.equal(settings.get('wecom.owner'), '');

  // Left by another version: not in force, and clearing it leaves a state that holds.
  f.force(`UPDATE setting SET value_json = ? WHERE key = 'tunables'`, JSON.stringify({ 'wecom.owner': 7 }));
  const reopened = serviceSettings({ ledger: f.open(), dataDir: f.dir, log: () => {} });
  assert.deepEqual(reopened.list().filter(({ key }) => key === 'wecom.owner').map(({ stored, overridden }) => [stored, overridden]), [[true, false]]);
  reopened.reset('wecom.owner', USER);
  assert.deepEqual(reopened.list().filter(({ key }) => key === 'wecom.owner').map(({ stored, value }) => [stored, value]), [[false, '']]);
});

test('a new receiver takes the old one\'s place in the WeCom whitelist in the commit that changes the receiver; names added by hand stay, and a list never made is not made here', (t) => {
  const transactions: string[][] = [];
  const { f, settings, set } = setup(t, { testHooks: { beforeCommit: (actions) => void transactions.push([...actions]) } });
  const whitelist = () => JSON.parse(f.peek<{ value_json: string }>(`SELECT value_json FROM setting WHERE key = 'whitelist'`)[0]!.value_json);
  f.ledger.setWhitelist({ console: ['console'], wecom: ['wang'] }, USER);
  transactions.length = 0;

  set('wecom.owner', 'zhang');
  assert.deepEqual(whitelist(), { console: ['console'], wecom: ['wang', 'zhang'] });
  set('wecom.owner', 'li');
  assert.deepEqual(whitelist(), { console: ['console'], wecom: ['wang', 'li'] }, '旧接收人的位置换成新的，手工加的不动');
  set('wecom.owner', 'wang');
  assert.deepEqual(whitelist().wecom, ['wang'], '新接收人本来就在名单里：不重复');
  settings.reset('wecom.owner', USER);
  assert.deepEqual(whitelist().wecom, [], '恢复默认也走这条路：没有接收人了，他的位置也没了');
  assert.deepEqual(transactions, Array.from({ length: 4 }, () => ['setting.update', 'whitelist.set']), '每次都是一个事务里的两条记录');
  const actors = f.peek<{ actor: string }>(`SELECT actor FROM change WHERE action = 'whitelist.set' ORDER BY seq DESC LIMIT 4`).map(({ actor }) => actor);
  assert.deepEqual(actors, ['user', 'user', 'user', 'user'], '白名单的改动记在改接收人的那个人名下');

  // Before the channel was ever switched on: the list is made at the first connect.
  f.ledger.setWhitelist({ console: ['console'] }, USER);
  transactions.length = 0;
  set('wecom.owner', 'zhao');
  assert.deepEqual(whitelist(), { console: ['console'] });
  assert.deepEqual(transactions, [['setting.update']]);
});

for (const when of ['before', 'after'] as const) {
  test(`a crash ${when} the commit that changes the receiver leaves the receiver and the whitelist both ${when === 'before' ? 'old' : 'new'}`, (t) => {
    const crash = { armed: false };
    const { f, settings, set } = setup(t, {
      testHooks: {
        beforeCommit() {
          if (crash.armed && when === 'before') throw new Error('injected crash');
        },
        afterCommit(_actions, retire) {
          if (!crash.armed || when !== 'after') return;
          retire();
          throw new Error('injected crash');
        },
      },
    });
    f.ledger.setWhitelist({ console: ['console'], wecom: ['zhang', 'wang'] }, USER);
    set('wecom.owner', 'zhang');
    crash.armed = true;
    assert.throws(() => set('wecom.owner', 'li'), /injected crash/);
    crash.armed = false;
    if (when === 'before') assert.equal(settings.get('wecom.owner'), 'zhang', '内存里的值不先于提交');

    const reopened = f.open();
    const [owner, wecom] = when === 'before' ? ['zhang', ['wang', 'zhang']] : ['li', ['wang', 'li']];
    assert.equal(serviceSettings({ ledger: reopened, dataDir: f.dir, log: () => {} }).get('wecom.owner'), owner);
    assert.deepEqual(reopened.getWhitelist().wecom, wecom);
  });
}

test('the public address ends at the domain and optional port, so login paths can be reached', (t) => {
  const { settings, set, refused } = setup(t);
  for (const bad of [
    'https://tycho.example/base', 'https://tycho.example//',
    'https://tycho.example/base/..', 'https://tycho.example/?',
    'https:tycho.example', 'https://tycho.example\\base',
    'https://tycho.example?token=private', 'https://tycho.example/#private',
  ]) assert.match(refused('http.publicUrl', bad), /只填到域名（和端口）为止/, bad);
  for (const good of ['https://tycho.example', 'HTTPS://tycho.example:8443/']) {
    set('http.publicUrl', good);
    assert.equal(settings.get('http.publicUrl'), good.replace(/\/$/, ''));
  }
});

test('the registry exposes settings without listener-specific write permissions', (t) => {
  const { settings } = setup(t);
  for (const entry of settings.list()) {
    assert.equal(Object.hasOwn(entry, 'localOnly'), false, entry.key);
    assert.equal(Object.hasOwn(entry, 'writable'), false, entry.key);
  }
});
