// Guards the console's project page against the failures that made the two project
// routes necessary: a project's list of logins that the page cannot read back or
// change, a project pointed at a login or machine that does not exist, a list that takes
// one kind of login and not the other (an account, or a machine's own login), the old
// field name taken as if nothing had changed, a half-applied
// edit that leaves the list and its mode disagreeing, writes that skip the ledger's
// own checks, and a write that slips past a recovery or a degraded ledger.
// And against a project's code sources taking an address no machine may be handed or one
// carrying a secret, a folder whose machine does not exist, an id the project's list does not
// hold (a removed one included), or a change to them going unrecorded: the machines of this
// project are handed that list, and the old code_dir/repo fields are refused rather than read.
// And against a project's machines chosen by name at the moment of a save: a page opened
// before a machine was deleted and joined again under its name, saved for another field,
// must not hand the project's permission to the new machine. And against a project's grants
// saved half with the rest of a save, or taking a name that is not one.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Account } from '../runner/snapshot.ts';
import { ADAPTERS } from '../adapters/all.ts';
import { createDispatcher } from '../service/dispatcher.ts';
import { createLogins } from '../service/logins.ts';
import { consoleApp } from './console-helpers.ts';
import { claudeTier, DISPATCH_TUNED, fixture, holdMachine, testMachine, tuned, USER } from './helpers.ts';

const json = async (response: Response): Promise<any> => response.json();

const SECOND: Account = { id: 't2', name: 't2', executor: 'claude', tiers: { execute: claudeTier('/tiers/execute.json') } };

test('a project is listed with its logins as stored, its machines and the work waiting on it', async (t) => {
  const { f, get, send } = await consoleApp(t);
  f.ledger.putAccount(SECOND, USER, 'ref-t2');
  const h1 = f.ledger.getMachine('h1')!.uid;
  assert.equal((await send('PUT', `/api/projects/${encodeURIComponent(f.projectId)}`, { logins: ['t2', 't1'], machines: [h1] })).status, 200);
  const moving = f.newTask({});
  f.ledger.queueTask(moving.id, USER);
  const asking = f.newTask({});
  f.ledger.queueTask(asking.id, USER);
  f.ledger.openApproval(asking.id, [{ question: '选哪个？', options: ['A', 'B'] }], USER);

  const answer = await json(await get('/api/projects'));
  const [project] = answer.projects;
  assert.equal(project.id, f.projectId);
  assert.deepEqual(project.logins, ['t2', 't1'], '清单按存储顺序读回，不参与派发');
  assert.deepEqual(project.machines, [{ uid: h1, name: 'h1' }], '每一项是登记号和它现在的名字');
  assert.equal(project.moving, 1);
  assert.equal(project.waiting, 1);
});

test('changing a project replaces both lists in one audited step and answers with the project as it now stands', async (t) => {
  const { f, send } = await consoleApp(t);
  f.ledger.putAccount(SECOND, USER, 'ref-t2');
  const first = await send('PUT', `/api/projects/${encodeURIComponent(f.projectId)}`, { logins: ['t1'], machines: [] });
  assert.equal(first.status, 200);
  const answer = await json(first);
  assert.deepEqual(answer.project.logins, ['t1']);
  const again = await json(await send('PUT', `/api/projects/${encodeURIComponent(f.projectId)}`, { logins: ['t2', 't1'] }));
  assert.deepEqual(again.project.logins, ['t2', 't1']);
  assert.deepEqual(again.project.machines, [], '不带 machines 就不动它');

  const rows = f.peek<{ actor: string; detail_json: string }>(
    "SELECT actor, detail_json FROM change WHERE action = 'project.update' AND json_extract(detail_json, '$.project_id') = ? ORDER BY seq", f.projectId);
  assert.deepEqual(rows.map(({ actor }) => actor), ['console', 'console']);
  const [firstChange, secondChange] = rows.map(({ detail_json }) => JSON.parse(detail_json) as { logins: { from: string[]; to: string[] } });
  assert.deepEqual(firstChange!.logins, { from: [], to: ['t1'] });
  assert.deepEqual(secondChange!.logins, { from: ['t1'], to: ['t2', 't1'] });
});

// docs/design/accounts-machines-decoupled.md: a project lists logins, an account or a
// machine's own login, in one ordered list; the old name of the field is refused, not read.
test('a project lists both kinds of login in one order, and the old field name is refused', async (t) => {
  const { f, get, send } = await consoleApp(t);
  const path = `/api/projects/${encodeURIComponent(f.projectId)}`;
  const ownId = f.ledger.getMachineLogin('h1', 'claude')!.id;
  const own = await send('PUT', path, { logins: [ownId, 't1'] });
  assert.equal(own.status, 200);
  assert.deepEqual((await json(own)).project.logins, [ownId, 't1']);
  assert.deepEqual((await json(await get('/api/projects'))).projects[0].logins, [ownId, 't1']);
  const old = await send('PUT', path, { accounts: ['t1'] });
  assert.equal(old.status, 400);
  assert.match((await json(old)).error, /logins/);
  assert.equal('accounts' in (await json(await get('/api/projects'))).projects[0], false);
});

test('a project cannot be pointed at an account or a machine that does not exist, and a refused change writes nothing', async (t) => {
  const { f, send } = await consoleApp(t);
  const before = f.dump();
  const path = `/api/projects/${encodeURIComponent(f.projectId)}`;
  const missingAccount = await send('PUT', path, { logins: ['nope'] });
  assert.equal(missingAccount.status, 400);
  assert.match((await json(missingAccount)).error, /已删除的登录 不存在/);
  const missingOwn = await send('PUT', path, { logins: ['h1/codex'] });
  assert.equal(missingOwn.status, 400);
  assert.match((await json(missingOwn)).error, /已删除的登录 不存在/, '机器上没设过的执行器登录不能放进清单');
  const missingMachine = await send('PUT', path, { logins: ['t1'], machines: ['nope'] });
  assert.equal(missingMachine.status, 400);
  assert.match((await json(missingMachine)).error, /允许的机器里有一项（登记号 nope）已经不是任何一台机器/);
  // A name is not a registration: a list of names is refused the same way.
  assert.equal((await send('PUT', path, { logins: ['t1'], machines: ['h1'] })).status, 400);
  assert.equal((await send('PUT', path, { logins: 't1' })).status, 400);
  assert.equal((await send('PUT', path, { logins: ['t1'], machines: 'h1' })).status, 400);
  assert.deepEqual(f.dump(), before, '被拒的改动不写任何行');
  assert.deepEqual(f.ledger.getProject(f.projectId).logins_json, '[]');
});

test('the project routes need a login and a matching Origin for a write', async (t) => {
  const { f, get, send, url, cookie } = await consoleApp(t);
  const before = f.dump();
  const path = `/api/projects/${encodeURIComponent(f.projectId)}`;
  const anonymous = { Origin: url };
  assert.equal((await get('/api/projects', anonymous)).status, 401);
  assert.equal((await send('PUT', path, { logins: ['t1'] }, anonymous)).status, 401);
  const foreign = { Cookie: cookie, Origin: 'http://elsewhere.test' };
  assert.equal((await send('PUT', path, { logins: ['t1'] }, foreign)).status, 403);
  assert.deepEqual(f.dump(), before);
});

// A project's code comes from an ordered list of sources (docs/design/code-sources.md §1, §8):
// the service names every new item, an item that carries an id must be one the list already
// holds (so a removed id never comes back and a reorder keeps them), a repository's address
// must be one a machine may be handed and must not carry a secret, a folder must name a machine
// that exists, and the change is audited. The old code_dir/repo fields are refused rather than
// read.
test('代码来源：服务给新项编号、已有项保持编号，机器要存在、地址不带秘密，写了读得回来', async (t) => {
  const { f, get, send } = await consoleApp(t);
  const path = `/api/projects/${encodeURIComponent(f.projectId)}`;
  const machine = f.ledger.getMachine('h1')!.uid;

  for (const sources of [
    [{ kind: 'repo', url: '/local/checkout' }],
    [{ kind: 'repo', url: 'file:///local/checkout' }],
    [{ kind: 'repo', url: 'ftp://example.test/r.git' }],
    [{ kind: 'repo', url: 'https://user:secret@example.test/r.git' }],
    [{ kind: 'repo', url: 'https://example.test/r.git?token=secret' }],
    [{ kind: 'folder', machine_uid: 'nope', path: '/work/project' }],
    [{ kind: 'folder', machine_uid: machine, path: '  ' }],
    [{ id: 's1', kind: 'repo', url: 'https://example.test/r.git' }],
  ]) {
    const before = f.dump();
    const refused = await send('PUT', path, { sources });
    assert.equal(refused.status, 400, JSON.stringify(sources));
    assert.deepEqual(f.dump(), before, '被拒的来源不写任何行');
    if (JSON.stringify(sources).includes('secret')) {
      assert.equal((await json(refused)).error.includes('secret'), false, '报错不回显秘密');
    }
  }
  assert.equal((await send('PUT', path, { sources: 'nope' })).status, 400);
  assert.equal((await send('PUT', path, { code_dir: '/host/tycho' })).status, 400, '旧的 code_dir 不再读');
  assert.equal((await send('PUT', path, { repo: 'https://example.test/r.git' })).status, 400, '旧的 repo 不再读');

  const set = await send('PUT', path, {
    sources: [
      { kind: 'repo', url: ' https://example.test/r.git ' },
      { kind: 'folder', machine_uid: machine, path: ' /work/project ' },
    ],
  });
  assert.equal(set.status, 200);
  const written = (await json(set)).project.sources as { id: string }[];
  const [s1, s2] = written;
  assert.deepEqual(written.map(({ id: _id, ...rest }) => rest), [
    { kind: 'repo', url: 'https://example.test/r.git', default: true, label: '仓库 https://example.test/r.git' },
    { kind: 'folder', machine_uid: machine, path: '/work/project', default: false, label: 'h1 上的 /work/project' },
  ], '两边空白不留下来，第一项是默认，每一项都有服务给的编号');
  assert.deepEqual((await json(await get('/api/projects'))).projects[0].sources.map(({ id }: { id: string }) => id), [s1!.id, s2!.id]);

  // 重排：已有的项保持自己的编号。
  const reorder = await send('PUT', path, { sources: [written[1], written[0]] });
  assert.equal(reorder.status, 200);
  assert.deepEqual(((await json(reorder)).project.sources as { id: string }[]).map(({ id }) => id), [s2!.id, s1!.id]);
  const rows = f.peek<{ detail_json: string }>(
    "SELECT detail_json FROM change WHERE action = 'project.update' AND json_extract(detail_json, '$.project_id') = ? ORDER BY seq", f.projectId);
  const details = rows.map(({ detail_json }) => JSON.parse(detail_json) as { sources?: { from: unknown[]; to: unknown[] } });
  const recorded = details.filter((each) => each.sources !== undefined);
  assert.deepEqual(recorded.at(-1)!.sources!.to.map((each) => (each as { id: string }).id), [s2!.id, s1!.id], '重排记的是新顺序');
  // 不带这一项就不动它。
  await send('PUT', path, { logins: ['t1'] });
  assert.deepEqual(f.ledger.projectSources(f.projectId).map(({ id }) => id), [s2!.id, s1!.id]);
  const cleared = await send('PUT', path, { sources: [] });
  assert.deepEqual((await json(cleared)).project.sources, []);
  // 删掉的编号不再收：一个已删来源的编号不能复活。
  assert.equal((await send('PUT', path, { sources: [s1] })).status, 400);
  assert.deepEqual(f.ledger.projectSources(f.projectId), []);
});

// docs/design/code-sources.md §8: a new project's items are named by the service, and a
// repository address carrying a secret is refused with a message that does not repeat it.
test('新建项目：带编号的来源和带秘密的地址都被拒，服务给新项发编号', async (t) => {
  const { f, send } = await consoleApp(t);
  const before = f.dump();
  const withId = await send('POST', '/api/projects', { name: '甲', sources: [{ id: 's1', kind: 'repo', url: 'https://example.test/r.git' }] });
  assert.equal(withId.status, 400);
  const secret = await send('POST', '/api/projects', { name: '甲', sources: [{ kind: 'repo', url: 'https://user:secret@example.test/r.git' }] });
  assert.equal(secret.status, 400);
  assert.equal((await json(secret)).error.includes('secret'), false, '报错不回显秘密');
  assert.deepEqual(f.dump(), before, '被拒的建项目什么都不写');
  const made = await send('POST', '/api/projects', { name: '甲', sources: [{ kind: 'repo', url: 'https://example.test/r.git' }] });
  assert.equal(made.status, 201);
  const [source] = (await json(made)).project.sources as { id: string; default: boolean }[];
  assert.equal(source!.default, true);
  assert.equal(source!.id.length, 26, '新项由服务编号（ULID）');
});

test('a project change waits for recovery and stops on a write failure while the list stays readable', async (t) => {
  let recovering = false;
  let fail = false;
  const f = fixture(t, { recovery: { recovering: () => recovering }, testHooks: {
    beforeCommit() { if (fail) throw Object.assign(new Error('disk I/O error'), { errcode: 10 }); },
  } });
  const { get, send } = await consoleApp(t, { f });
  const path = `/api/projects/${encodeURIComponent(f.projectId)}`;
  const wanted = { logins: ['t1'], machines: [f.ledger.getMachine('h1')!.uid] };
  recovering = true;
  assert.equal((await send('PUT', path, wanted)).status, 503);
  assert.equal((await get('/api/projects')).status, 200);
  recovering = false;
  fail = true;
  assert.equal((await send('PUT', path, wanted)).status, 503);
  fail = false;
  const degraded = await send('PUT', path, wanted);
  assert.equal(degraded.status, 503);
  assert.match((await json(degraded)).error, /降级模式/);
  assert.equal(f.ledger.getProject(f.projectId).logins_json, '[]', '一次都没写成');
});

// docs/design/project-sessions.md §1, §5: the owner switches a project between "全部登录" and
// "只用所选" both ways. Guards against a switch that only goes one way, one that throws the
// chosen list away (switching back must find it), a save of another field that moves the
// mode, a mode the ledger does not know, and a switch that goes unrecorded or records a no-op.
test('a project switches between every login and only the chosen ones, both ways, keeping the list', async (t) => {
  const { f, send } = await consoleApp(t);
  f.ledger.putAccount(SECOND, USER, 'ref-t2');
  const path = `/api/projects/${encodeURIComponent(f.projectId)}`;
  const put = async (body: unknown) => (await json(await send('PUT', path, body))).project;

  const chosen = await put({ logins: ['t1'] });
  assert.deepEqual([chosen.login_mode, chosen.logins, chosen.pool], ['selected', ['t1'], ['t1']]);
  const every = await put({ login_mode: 'all' });
  assert.equal(every.login_mode, 'all');
  assert.deepEqual(every.logins, ['t1'], '切到全部登录，清单留着');
  assert.ok(every.pool.includes('t2') && every.pool.includes('t1'), '全部登录：清单不参与派发');
  assert.equal((await put({ machines: [] })).login_mode, 'all', '保存别的字段不动登录方式');
  const back = await put({ login_mode: 'selected' });
  assert.deepEqual([back.login_mode, back.logins, back.pool], ['selected', ['t1'], ['t1']], '切回所选，原来的清单回来');
  const both = await put({ login_mode: 'all', logins: ['t2', 't1'] });
  assert.deepEqual([both.login_mode, both.logins], ['all', ['t2', 't1']], '全部登录时也能存下清单');
  const emptied = await put({ login_mode: 'selected', logins: [] });
  assert.deepEqual([emptied.login_mode, emptied.pool], ['selected', []], '只用所选、一个不选就是不派发');

  const before = f.dump();
  const refused = await send('PUT', path, { login_mode: 'some' });
  assert.equal(refused.status, 400);
  assert.match((await json(refused)).error, /登录方式/);
  await put({ login_mode: 'selected' });
  assert.deepEqual(f.dump(), before, '被拒的、没变的都不写');

  const modes = f.peek<{ detail_json: string }>(
    "SELECT detail_json FROM change WHERE action = 'project.update' AND json_extract(detail_json, '$.project_id') = ? ORDER BY seq", f.projectId)
    .map(({ detail_json }) => (JSON.parse(detail_json) as { login_mode?: { from: string; to: string } }).login_mode ?? null);
  assert.deepEqual(modes, [{ from: 'all', to: 'selected' }, { from: 'selected', to: 'all' }, { from: 'all', to: 'selected' }, { from: 'selected', to: 'all' }, { from: 'all', to: 'selected' }]);
});

// The page opened, the machine deleted and joined again under its name, the page saved for
// another field: the project still names the old registration, which matches no machine, and
// the new machine is not in it. A save that does send the old registration is refused.
test('a stale page saving another field leaves the project\u2019s machines as they were, and its old choice is refused', async (t) => {
  const { f, get, send } = await consoleApp(t);
  const path = `/api/projects/${encodeURIComponent(f.projectId)}`;
  const old = f.ledger.getMachine('h1')!.uid;
  assert.equal((await send('PUT', path, { machines: [old] })).status, 200);
  const opened = (await json(await get('/api/projects'))).projects[0];
  assert.deepEqual(opened.machines, [{ uid: old, name: 'h1' }]);

  holdMachine(f.ledger, testMachine('h1', 'h1', 'another-client'));
  const fresh = f.ledger.getMachine('h1')!.uid;
  assert.notEqual(fresh, old);
  // What the page sends for a change of another field: no machines.
  assert.equal((await send('PUT', path, { spawn_machines: true })).status, 200);
  const after = (await json(await get('/api/projects'))).projects[0];
  assert.deepEqual([after.machines, after.machines_gone], [[], 1], '许可还是旧登记，匹配不到任何机器；新机器不在里面');
  // The page's old choice, sent as it was: refused, saying which entry.
  const refused = await send('PUT', path, { machines: [old] });
  assert.equal(refused.status, 400);
  assert.ok((await json(refused)).error.includes(old));
  // The owner chooses again: the new machine, by its own registration; the old entry is cleared.
  const chosen = (await json(await send('PUT', path, { machines: [fresh] }))).project;
  assert.deepEqual([chosen.machines, chosen.machines_gone], [[{ uid: fresh, name: 'h1' }], 0]);
});

test('saving another field from a page with only deleted machines still dispatches nowhere', async (t) => {
  const { f, get, send, accounts, machines } = await consoleApp(t);
  const path = `/api/projects/${encodeURIComponent(f.projectId)}`;
  const old = f.ledger.getMachine('h1')!.uid;
  assert.equal((await send('PUT', path, { logins: ['t1'], machines: [old] })).status, 200);
  f.ledger.deleteMachine('h1', USER);
  holdMachine(f.ledger, testMachine('h1', 'h1', 'another-client'));
  const opened = (await json(await get('/api/projects'))).projects[0];
  assert.deepEqual([opened.machines, opened.machines_gone], [[], 1]);
  // A save of another field omits machines (also covered by the console's request tests).
  assert.equal((await send('PUT', path, { login_mode: 'all' })).status, 200);
  const saved = (await json(await get('/api/projects'))).projects[0];
  assert.deepEqual([saved.machines, saved.machines_gone], [[], 1]);
  const task = f.newTask({});
  f.ledger.queueTask(task.id, USER);
  let launches = 0;
  const dispatcher = createDispatcher({ ...DISPATCH_TUNED,
    ledger: f.ledger, machines, executors: ADAPTERS,
    logins: createLogins({ ledger: f.ledger, accounts, executors: ADAPTERS }),
    runTimeoutMs: tuned('run.timeoutMs'),
    runner: {
      findMachine: async (_login, offered) => offered[0],
      launch: async () => { launches += 1; }, watch: async () => {},
      lostCandidates: () => [], presume: async () => 'unknown', sweep: async () => {},
    }, log: () => {},
  });
  t.after(() => dispatcher.stop());
  await dispatcher.tick();
  assert.equal(launches, 0, '同名重新接入的和其他机器都不能接活');
  assert.equal(f.ledger.getTask(task.id).state, 'held');
  assert.match(f.ledger.getTask(task.id).reason!, /允许的机器都已经删掉了/);
});

// What a project's Router may do without asking is the owner's to set here, read back as the
// service holds it; an unknown name takes nothing else of the same save with it.
test('a project\u2019s grants are saved and read back, and an unknown one refuses the whole save', async (t) => {
  const { f, send } = await consoleApp(t);
  const path = `/api/projects/${encodeURIComponent(f.projectId)}`;
  const before = f.dump();
  const refused = await send('PUT', path, { spawn_machines: true, grants: ['accept', 'push'] });
  assert.equal(refused.status, 400);
  assert.match((await json(refused)).error, /不认识的授权：push/);
  assert.deepEqual(f.dump(), before, '被拒的保存连“允许派生机器”也不改');
  assert.equal((await send('PUT', path, { grants: 'accept' })).status, 400);
  const saved = await send('PUT', path, { grants: ['release', 'accept'] });
  assert.equal(saved.status, 200);
  assert.deepEqual((await json(saved)).project.grants, ['accept', 'release']);
});
