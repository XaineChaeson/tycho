// Guards docs/design/nodes.md §5.3 and §9 at the HTTP surface: the node routes take a node
// token and nothing else, a console cookie opens nothing there, a node token opens nothing
// in the console's own routes, and the secret a round runs on is handed over exactly once,
// only to the machine that round is on.
//
// What this file is here to catch:
//   - a machine's token being accepted as a browser (or a browser's cookie as a machine),
//   - a snapshot or a credential handed to a machine that is not the round's,
//   - a credential the owner replaced since the Run was created still being given out,
//   - a revoked machine still reading anything,
//   - the poll's cursor being dropped or a response that finished writing being read as a
//     connection that went away — either one makes the host hand over commands the machine
//     already has, and the round stalls behind a re-sent one.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import type { Account, Snapshot } from '../runner/snapshot.ts';
import { NODE_HOLD_HEADER, NODE_PROTOCOL } from '../shared/node-protocol.ts';
import { prepareSnapshot } from '../runner/snapshot.ts';
import { claudeAdapter } from '../adapters/claude.ts';
import { accountCredentialFile } from '../service/secrets.ts';
import { signIn } from './stage.ts';
import { bench } from './node-run-fixture.ts';
import { RUN_LIMIT_MS } from './helpers.ts';
import { REPO } from './cli-helpers.ts';
import { appVersion } from '../cli/paths.ts';
import { openLedger } from '../service/ledger.ts';

const options = { timeout: 90_000 };
const USER = { actor: 'test' };

const nodeGet = (base: string, token: string, path: string): Promise<Response> =>
  fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${token}` } });

const nodePost = (base: string, token: string, path: string, body: unknown = {}): Promise<Response> =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ protocol: NODE_PROTOCOL, ...(body as object) }),
  });

test('旧快照按登记和派发的顺序回填，同名同身份重新登记不能继承', options, async (t) => {
  const b = await bench(t, {}, {}, { hold: true });
  const ref = 'legacy-registration-fixture';
  const file = accountCredentialFile(b.host.dataDir, ref);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, 'fixture-token\n');
  b.host.ledger.recordAccountCredential('t1', ref, USER);
  b.host.ledger.queueTask(b.taskId, USER);
  const account = b.host.accounts.get('t1')! as Account;
  const task = b.host.ledger.getTask(b.taskId);
  const snapshot = prepareSnapshot(task, account, { claude: claudeAdapter }, { timeoutMs: RUN_LIMIT_MS });
  const run = b.host.ledger.createRun(task.id, { login: account, machine: b.machine, snapshot, expectedRevision: task.revision }, USER);
  const dbPath = join(b.hostDataDir, 'ledger.db');
  const eraseUid = () => {
    const db = new DatabaseSync(dbPath);
    try { db.prepare("UPDATE run SET snapshot_json = json_remove(snapshot_json, '$.machine_uid') WHERE id = ?").run(run.id); } finally { db.close(); }
  };
  const recover = () => { const ledger = openLedger(dbPath); ledger.close(); };
  eraseUid();
  // Admissions written by older versions did not include the registration uid.
  const legacy = new DatabaseSync(dbPath);
  try { legacy.prepare("UPDATE change SET detail_json = json_remove(detail_json, '$.machine_uid') WHERE action = 'machine.join' AND json_extract(detail_json, '$.machine_id') = ?").run(b.machine.id); } finally { legacy.close(); }
  recover();
  assert.equal((await nodeGet(b.base, b.token, `/api/node/runs/${run.id}/snapshot`)).status, 200);
  assert.equal((await nodePost(b.base, b.token, `/api/node/runs/${run.id}/credential`)).status, 200);
  eraseUid();
  b.host.ledger.deleteMachine(b.machine.id, USER, { confirmed: true });
  const request = b.host.nodes.register({ node_id: b.machine.nodeId, name: b.machine.id, platform: 'test', hostname: b.machine.host });
  b.host.nodes.approve(request.code, USER);
  const claim = b.host.nodes.claim(request.secret);
  assert.equal(claim.state, 'approved');
  if (claim.state !== 'approved') throw new Error('接入未获批准');
  recover();
  assert.equal((await nodeGet(b.base, claim.token, `/api/node/runs/${run.id}/snapshot`)).status, 403);
  assert.equal((await nodePost(b.base, claim.token, `/api/node/runs/${run.id}/credential`)).status, 403);
});

test('节点接口只认机器令牌：控制台 Cookie 打不开，机器令牌也进不了控制台', options, async (t) => {
  const b = await bench(t);
  const console_ = await signIn(b.host);

  // A browser's cookie is not a machine. The node group is checked before the cookie is
  // even looked at, so this is 401 rather than a console session.
  const withCookie = await fetch(`${b.base}/api/node/poll`, {
    method: 'POST',
    headers: { Cookie: console_.cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ protocol: NODE_PROTOCOL, cursor: null, runs: [], facts: {} }),
  });
  assert.equal(withCookie.status, 401, '控制台 Cookie 不能当机器令牌用');

  // And a machine's token is not a browser: the console's own routes want a session.
  const withToken = await nodeGet(b.base, b.token, '/api/machines');
  assert.ok([401, 403].includes(withToken.status), `机器令牌不能读控制台接口，实际 ${withToken.status}`);
  const withTokenWrite = await nodePost(b.base, b.token, '/api/pause');
  assert.ok([401, 403].includes(withTokenWrite.status), '机器令牌也不能写');
});

test('放行新机器：控制台看得见请求、放行之后机器出现在列表里、拒绝之后不再出现', options, async (t) => {
  const b = await bench(t);
  const console_ = await signIn(b.host);
  const facts = { node_id: 'ffffffffffffffff', name: 'second-machine', platform: 'linux 6', hostname: 'second.local' };
  const join = b.host.nodes.register(facts);

  const listed = (await (await console_.get('/api/node/joins')).json()) as { joins: { code: string; name: string; platform: string; hostname: string }[] };
  const entry = listed.joins.find((each) => each.code === join.code);
  assert.ok(entry, '待放行的机器出现在控制台读到的列表里');
  assert.equal(entry.name, 'second-machine');
  assert.equal(entry.platform, 'linux 6');
  assert.equal(entry.hostname, 'second.local');

  // The owner lets it in: the machine object is written in the same act, and the client's
  // next claim is what collects the token.
  const approved = await console_.post('/api/admissions/approve', { kind: 'machine', code: join.code });
  assert.equal(approved.status, 200);
  const body = (await approved.json()) as { machine: { id: string; host: string; node: { connected: boolean } | null } };
  assert.equal(body.machine.id, 'second-machine');
  assert.equal(body.machine.node?.connected, false, '还没有连回来');
  const claimed = b.host.nodes.claim(join.secret);
  assert.equal(claimed.state, 'approved');
  // The same secret keeps collecting the same token while the release lives: a response lost
  // on the way is not a reason for the owner to delete the machine and let it in again.
  const again = b.host.nodes.claim(join.secret);
  assert.equal(again.state, 'approved');
  assert.equal(again.state === 'approved' ? again.token : '', claimed.state === 'approved' ? claimed.token : '');

  const machines = (await (await console_.get('/api/machines')).json()) as { machines: { id: string; node: { node_id: string } | null }[] };
  assert.equal(machines.machines.find((each) => each.id === 'second-machine')?.node?.node_id, 'ffffffffffffffff');

  // A second request from the same machine is refused: one machine, one identity.
  assert.throws(() => b.host.nodes.register(facts), /已经加入过/);

  // Rejection: the request goes away and the machine is never written.
  const other = b.host.nodes.register({ ...facts, node_id: 'eeeeeeeeeeeeeeee', name: 'third-machine' });
  const rejected = await console_.post('/api/admissions/reject', { kind: 'machine', code: other.code });
  assert.equal(rejected.status, 200);
  const claim = b.host.nodes.claim(other.secret);
  assert.equal(claim.state, 'rejected');
  const after = (await (await console_.get('/api/machines')).json()) as { machines: { id: string }[] };
  assert.equal(after.machines.some((each) => each.id === 'third-machine'), false, '拒绝的机器不进列表');
});

test('快照只给这一轮所在的那台机器，取到的就是发出去的那些字节', options, async (t) => {
  const b = await bench(t, { sleepMs: 3000 });
  const run = await (async () => {
    for (let attempt = 0; attempt < 300; attempt += 1) {
      const found = b.host.ledger.listRuns(b.taskId).at(-1);
      if (found) return found;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error('等不到这一轮被创建');
  })();

  const mine = await nodeGet(b.base, b.token, `/api/node/runs/${run.id}/snapshot`);
  assert.equal(mine.status, 200);
  const answer = (await mine.json()) as { run_dir: string; files: { path: string; text: string }[] };
  assert.equal(answer.run_dir, `.tycho/tasks/${b.taskId}/runs/${run.id}`);
  assert.ok(answer.files.some((file) => file.path === 'brief.md' && file.text.includes('节点跑一轮')));

  // Another machine's token is not this round's: the Run was created on one machine.
  const stranger = b.host.nodes.register({ node_id: 'dddddddddddddddd', name: 'stranger', platform: 'test', hostname: 'stranger.local' });
  const strangerMachine = b.host.nodes.approve(stranger.code, USER)!;
  const strangerToken = b.host.nodes.claim(stranger.secret);
  assert.equal(strangerToken.state, 'approved');
  const refused = await nodeGet(b.base, strangerToken.state === 'approved' ? strangerToken.token : '', `/api/node/runs/${run.id}/snapshot`);
  assert.equal(refused.status, 403, `别的机器读不到这一轮的快照（${strangerMachine.id}）`);

  // A revoked machine reads nothing at all.
  b.host.ledger.deleteMachine(b.machine.id, USER, { confirmed: true });
  const revoked = await nodeGet(b.base, b.token, `/api/node/runs/${run.id}/snapshot`);
  assert.equal(revoked.status, 401);
});

// The code a round was handed now travels in its snapshot (`source.json`): there is no
// second, binary route to guard, and a round with no source has nothing to fetch at all
// (docs/design/code-sources.md §6).

// §7, §9: a Run belongs to the client identity it was dispatched to, not to the name the
// owner reads in the console. Deleting the machine and joining again under the same name is
// a different machine: it inherits nothing of the old one — the round's account token least
// of all.
test('同名重新接入是另一台机器：旧节点的快照和凭据都拿不到', options, async (t) => {
  const b = await bench(t, {}, {}, { hold: true });
  const ref = 'registration-test-fixture';
  const file = accountCredentialFile(b.host.dataDir, ref);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, 'fixture-token\n');
  b.host.ledger.recordAccountCredential('t1', ref, USER);
  b.host.ledger.queueTask(b.taskId, USER);
  const account = b.host.accounts.get('t1')! as Account;
  const task = b.host.ledger.getTask(b.taskId);
  const prepared = prepareSnapshot(task, account, { claude: claudeAdapter }, { timeoutMs: RUN_LIMIT_MS });
  const run = b.host.ledger.createRun(task.id, { login: account, machine: b.machine, snapshot: prepared, expectedRevision: task.revision }, USER);
  assert.equal((await nodePost(b.base, b.token, `/api/node/runs/${run.id}/credential`)).status, 200);
  assert.equal(run.machine_id, b.machine.id);
  assert.equal(run.node_id, 'a1b2c3d4e5f60718', '这一轮绑的是客户端自己的标识');

  assert.equal((await nodeGet(b.base, b.token, `/api/node/runs/${run.id}/snapshot`)).status, 200);
  // The owner removes the machine; another machine joins under the same name, which is the
  // name the console shows and the ledger keys machines by.
  b.host.ledger.deleteMachine(b.machine.id, USER, { confirmed: true });
  const facts = { node_id: 'a1b2c3d4e5f60718', name: b.machine.id, platform: 'test', hostname: 'node-test.local' };
  const request = b.host.nodes.register(facts);
  const joined = b.host.nodes.approve(request.code, USER)!;
  assert.equal(joined.id, b.machine.id, '名字一样，所以机器名也还是这个');
  const claim = b.host.nodes.claim(request.secret);
  const token = claim.state === 'approved' ? claim.token : '';
  assert.ok(token);

  const snapshot = await nodeGet(b.base, token, `/api/node/runs/${run.id}/snapshot`);
  assert.equal(snapshot.status, 403, '旧节点的这一轮不是它的');
  const credential = await nodePost(b.base, token, `/api/node/runs/${run.id}/credential`);
  assert.equal(credential.status, 403, '旧节点的账号令牌也不是它的');
});

// A round with no node identity is one that ran over SSH before machines only joined: no
// client was ever its machine, so none is let read it under the name — not the snapshot, not
// the code bundle, not the credential, whether or not the round has ended.
test('没有节点身份的旧轮次：同名机器的快照、代码包、凭据三个入口都拒绝', options, async (t) => {
  // Nothing dispatched: the round is made here and nothing of the service looks at it meanwhile.
  const b = await bench(t, {}, {}, { hold: true });
  b.host.ledger.queueTask(b.taskId, USER);
  const account = b.host.accounts.get('t1')! as Account;
  const task = b.host.ledger.getTask(b.taskId);
  const snapshot = prepareSnapshot(task, account, { claude: claudeAdapter }, { timeoutMs: RUN_LIMIT_MS });
  const run = b.host.ledger.createRun(task.id, { login: account, machine: b.machine, snapshot, expectedRevision: task.revision }, USER);
  const conn = new DatabaseSync(join(b.hostDataDir, 'ledger.db'));
  try {
    conn.prepare('UPDATE run SET node_id = NULL WHERE id = ?').run(run.id);
  } finally {
    conn.close();
  }
  for (const [name, path, post] of [['快照', 'snapshot', false], ['凭据', 'credential', true]] as const) {
    const answer = post ? await nodePost(b.base, b.token, `/api/node/runs/${run.id}/${path}`) : await nodeGet(b.base, b.token, `/api/node/runs/${run.id}/${path}`);
    assert.equal(answer.status, 403, `${name}：没有节点身份的轮次不是任何一台机器的`);
  }
  const legacy = new DatabaseSync(join(b.hostDataDir, 'ledger.db'));
  try {
    const old = JSON.parse(run.snapshot_json) as Record<string, unknown>;
    delete old.machine_uid;
    legacy.prepare('UPDATE run SET node_id = ?, snapshot_json = ? WHERE id = ?').run(b.machine.nodeId, JSON.stringify(old), run.id);
  } finally { legacy.close(); }
  assert.equal((await nodeGet(b.base, b.token, `/api/node/runs/${run.id}/snapshot`)).status, 403);
  assert.equal((await nodePost(b.base, b.token, `/api/node/runs/${run.id}/credential`)).status, 403);

});

// §8.2: asking about this machine takes nothing out of the queue. A status question that
// consumed the command it was about to be given would leave a Worker that never starts.
test('状态查询不吃掉队列里的命令', options, async (t) => {
  // A host that dispatches nothing while this test runs: what is in the queue is then only
  // what this test put there, and the count says exactly what happened to it.
  const b = await bench(t, {}, { dispatchIntervalMs: 600_000, watchIntervalMs: 600_000, outboxIntervalMs: 600_000 });
  for (let attempt = 0; b.host.nodes.status().connected.length === 0; attempt += 1) {
    if (attempt > 300) throw new Error('等不到机器连回来');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  b.stopClients();

  const FACTS = { node_id: 'a1b2c3d4e5f60718', name: 'node-test', platform: 'test', hostname: 'node-test.local' };
  // One command goes to a poll of this test's own, which is what a request the machine left
  // half-open looks like; after it, nothing is waiting and the next one stays in the queue.
  const draining = b.host.nodes.poll(b.machine.id, { runs: [], facts: FACTS });
  const drained = b.host.nodes.send(b.machine.id, { kind: 'state', run_dir: 'tasks/t/runs/r' });
  const taken = await draining;
  assert.ok(taken, '这一次 poll 拿到的正是刚发的那条');
  assert.equal(b.host.nodes.report(b.machine.id, taken.id, true, {}), true);
  await drained;

  const sent = b.host.nodes.send(b.machine.id, { kind: 'list', alive_only: false });
  const before = b.host.nodes.status().queued;
  assert.equal(before, 1, '一条命令在队列里等着');
  const answer = await nodePost(b.base, b.token, '/api/node/status');
  assert.equal(answer.status, 200);
  const body = (await answer.json()) as { machine_id: string };
  assert.equal(body.machine_id, b.machine.id);
  assert.equal(b.host.nodes.status().queued, before, '状态查询没有从队列里拿走任何东西');

  // And the queue is still the machine's to take.
  const command = await b.host.nodes.poll(b.machine.id, { runs: [], facts: FACTS });
  assert.equal(command?.kind, 'list', '还是那一条');
  assert.equal(b.host.nodes.report(b.machine.id, command!.id, true, []), true);
  assert.deepEqual(await sent, []);
});

// §8.2: the poll carries the machine's own word about the last command it took, and the
// host acts on it. What this route must not do is read a response that finished writing its
// answer as a connection that went away: every command it had just handed over would be
// read as one the machine never saw, and handed over again.
test('poll 里的游标就是收到证明：收到过的命令不会再送，也没被当成没送', options, async (t) => {
  const b = await bench(t, {}, { dispatchIntervalMs: 600_000, watchIntervalMs: 600_000, outboxIntervalMs: 600_000 });
  for (let attempt = 0; b.host.nodes.status().connected.length === 0; attempt += 1) {
    if (attempt > 300) throw new Error('等不到机器连回来');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  b.stopClients();

  const FACTS = { node_id: 'a1b2c3d4e5f60718', name: 'node-test', platform: 'test', hostname: 'node-test.local' };
  const asked = { runs: [], facts: FACTS };
  const hand = (cursor: string | null): Promise<Response> => nodePost(b.base, b.token, '/api/node/poll', { ...asked, cursor });

  // A poll of this test's own is what the host writes into: the client that was just
  // stopped can still have a request on its way, and one of mine takes its place.
  const holding = hand(null);
  const sent = b.host.nodes.send(b.machine.id, { kind: 'state', run_dir: 'tasks/t/runs/r' });
  const first = (await (await holding).json()) as { command: { id: string; kind: string } | null };
  assert.equal(first.command?.kind, 'state', '这一条命令写进了这条连接');

  // The answer was written and this response finished. That is not a machine that has gone,
  // and this one has said nothing yet: the command is out, not back in the queue. Three
  // round trips through the same event loop are what makes "the close has been dealt with"
  // a fact rather than a hope — nothing here waits on a clock.
  for (let round = 0; round < 3; round += 1) await nodePost(b.base, b.token, '/api/node/status');
  const held = b.host.nodes.status();
  assert.equal(held.inFlight, 1, '写完了不等于断开：命令还在等机器的回答');
  assert.equal(held.queued, 0, '写完不算没送出去：命令没有被放回队列');

  // The machine names it: that is the whole of the proof the host gets, and from here the
  // command is in flight. The next thing it is given is the next command, not this one.
  const next = b.host.nodes.send(b.machine.id, { kind: 'list', alive_only: false });
  const second = (await (await hand(first.command.id)).json()) as { command: { id: string; kind: string } | null };
  assert.equal(second.command?.kind, 'list', '说收到过的命令不会再送一次');
  assert.notEqual(second.command?.id, first.command.id);

  assert.equal(b.host.nodes.report(b.machine.id, second.command!.id, true, []), true);
  assert.deepEqual(await next, []);
  assert.equal(b.host.nodes.report(b.machine.id, first.command.id, true, { started: true }), true);
  assert.deepEqual(await sent, { started: true });
});

// §4.1/§8.1: what the client last said about being able to drop a Task's code copy is kept,
// and an old client that never says it reads as "cannot" — its machine's copies stay where
// they are, rather than being reported as cleared (service/retention.ts).
test('清任务代码副本的能力按最后一次 poll 记：旧客户端不带就是不能', options, async (t) => {
  const b = await bench(t);
  const facts = { node_id: 'bbbbbbbbbbbbbbbb', name: 'can-drop', platform: 'test', hostname: 'drop.local' };
  const machine = b.host.nodes.approve(b.host.nodes.register(facts).code, USER)!;
  void b.host.nodes.poll(machine.id, { runs: [], facts, drops_task_code: true });
  assert.equal(b.host.nodes.reportedDropTaskCode(machine.id), true, '说了就能收');
  void b.host.nodes.poll(machine.id, { runs: [], facts });
  assert.equal(b.host.nodes.reportedDropTaskCode(machine.id), false, '不带就是旧客户端，不能收');
});

// §4.3: what the machine reports is what is running on it, and what it could not read is said
// as such. The rounds it merely holds — finished long ago — are neither.
//
// The report this reads belongs to a machine with no client of its own. A client that has just
// been stopped can still have a poll on its way, and the host takes the newest report there is:
// one landing after this wrote its own would put what that machine really has running in place
// of it. That race belongs to the test, not to the page, so the machine is one nothing else
// speaks for; the report itself is the same call a client's poll makes.
test('机器页：在跑的数量按“在跑”算，读不出来的另算', options, async (t) => {
  const b = await bench(t);
  const console_ = await signIn(b.host);
  const facts = { node_id: 'ffffffffffffffff', name: 'page-count', platform: 'test', hostname: 'page-count.local' };
  const machine = b.host.nodes.approve(b.host.nodes.register(facts).code, USER)!;
  // What the machine itself says, as it says it on every poll. The record is made where the
  // call is, before it waits: with nothing queued for this machine, a poll nobody holds open
  // waits out the host's hold, and that is not what this test is about.
  void b.host.nodes.poll(machine.id, {
    runs: [
      { task_id: 't', run_id: 'running', alive: true },
      { task_id: 't', run_id: 'finished', alive: false },
      { task_id: 't', run_id: 'unreadable', alive: null },
    ],
    facts,
  });
  const machines = (await (await console_.get('/api/machines')).json()) as {
    machines: { id: string; node: { reported_runs: number; reported_unknown: number } | null }[];
  };
  const node = machines.machines.find((each) => each.id === machine.id)!.node!;
  assert.equal(node.reported_runs, 1, '机器上说在跑的是有几个在跑，不是它留着几轮记录');
  assert.equal(node.reported_unknown, 1, '读不出来的那一轮不混进在跑的');
});

// §1.2, §11 step 5: what a machine read from its own executors is on the page as the machine
// reported it, and "test connection" on such a machine is that machine's client looking at
// itself again — through the same closed set, with nothing the console can put into it.
//
// What this picks up: a report the machine sent being dropped on the floor, a machine that
// never reported reading as one with nothing installed, and the check on a node machine
// being answered by this host instead of by that machine.
test('机器页：执行器状态是这台机器报的那一份，没报过的就是没有', options, async (t) => {
  const b = await bench(t);
  const console_ = await signIn(b.host);
  const facts = { node_id: 'ffffffffffffffff', name: 'quiet-machine', platform: 'test', hostname: 'quiet.local' };
  const quiet = b.host.nodes.approve(b.host.nodes.register(facts).code, USER)!;
  const report = {
    at: '2026-11-06T10:00:00.000Z',
    executors: [
      { executor: 'claude', installed: true, version: '2.1.303 (Claude Code)', logged_in: true },
      { executor: 'codex', installed: false, version: null, logged_in: null, error: '这台机器上没有 codex（PATH 里没有这个命令）' },
    ],
  };
  const shown = async (): Promise<unknown> => {
    const machines = (await (await console_.get('/api/machines')).json()) as { machines: { id: string; node: { executors: unknown } | null }[] };
    return machines.machines.find((each) => each.id === quiet.id)!.node!.executors;
  };
  // A machine with no client of its own: a client just stopped can still have a poll on its
  // way, and the page takes the newest report there is (the same reason as the count below).
  assert.equal(await shown(), null, '还没说过就是没有，不是"没装"');
  void b.host.nodes.poll(quiet.id, { runs: [], facts, executors: report });
  // As reported, each read by this host's own declarations: this bench's service ships only a
  // stand-in adapter, so neither executor named here offers a read-only way on it.
  const read = { ...report, executors: report.executors.map((each) => ({ ...each, read_only_offered: each.executor==='claude' })) };
  assert.deepEqual(await shown(), read);
  // A poll with no report is a machine with no news: what it said last stands.
  void b.host.nodes.poll(quiet.id, { runs: [], facts });
  assert.deepEqual(await shown(), read);
});

test('机器页的测试连接：节点机器是让它的客户端现在问一次，页面读到的就是这一次的', options, async (t) => {
  // This checks the answer, not a shorter SLA than the public probe's default.
  const b = await bench(t);
  const console_ = await signIn(b.host);
  const listed = async (): Promise<{ at: string; executors: { executor: string; version: string | null }[] } | null> => {
    const machines = (await (await console_.get('/api/machines')).json()) as { machines: { id: string; node: { executors: never } | null }[] };
    return machines.machines.find((each) => each.id === b.machine.id)!.node!.executors;
  };

  // The owner presses the button: the machine's own client is asked, it looks at that machine
  // again, and what it read is what the page shows afterwards. Nothing here asks this host
  // about the executors; the closed set of commands is the client's own.
  const answer = await (await console_.post(`/api/machines/${encodeURIComponent(b.machine.id)}/check`)).json() as { reachable: boolean; error?: string };
  assert.deepEqual(answer, { machine_id: b.machine.id, host: b.machine.host, reachable: true });
  const after = await listed();
  assert.equal(after?.executors[0]?.executor, 'claude');
  assert.equal(after?.executors[0]?.version, 'stub-cli 1.0');
});

test('机器页的测试连接：客户端不在时短等待后如实返回不可达', options, async (t) => {
  const b = await bench(t, {}, { checkTimeoutMs: 500 }, { hold: true });
  const console_ = await signIn(b.host);
  await b.stopClients();
  const away = await (await console_.post(`/api/machines/${encodeURIComponent(b.machine.id)}/check`)).json() as { reachable: boolean; error?: string };
  assert.equal(away.reachable, false);
  assert.match(String(away.error), /没有连回来|没有回答/);
});

test('凭据只交给这一轮：换过令牌之后不再给，没填令牌的轮次没有可取的东西', options, async (t) => {
  const b = await bench(t, { sleepMs: 5000 }, {});
  // An account with a token, and a Run created while it holds it. The file is written by
  // hand: the store's own step is an ACL this environment refuses (icacls), and what is
  // under test here is who may read the file, not how it came to be written.
  const secret = 'oauth-token-of-the-owner';
  const ref = 'ref-of-the-owner';
  const secretFile = accountCredentialFile(b.host.dataDir, ref);
  mkdirSync(dirname(secretFile), { recursive: true });
  writeFileSync(secretFile, `${secret}\n`);
  b.host.ledger.recordAccountCredential('t1', ref, USER);
  const account = b.host.accounts.get('t1')! as Account;
  const task = b.host.ledger.getTask(b.taskId);
  const snapshot: Snapshot = {
    ...prepareSnapshot(task, account, { claude: claudeAdapter }, { timeoutMs: RUN_LIMIT_MS }),
    credential_ref: b.host.ledger.accountCredentialRef('t1') ?? undefined,
  };
  const run = b.host.ledger.createRun(task.id, { login: account, machine: b.machine, snapshot, expectedRevision: task.revision }, USER);
  assert.equal(snapshot.executor, 'claude', '这一轮用的是这台机器上那个执行器（凭据声明取自它）');

  const taken = await nodePost(b.base, b.token, `/api/node/runs/${run.id}/credential`);
  assert.equal(taken.status, 200);
  const given = (await taken.json()) as { fd?: string; value: string };
  // How it reaches the Worker is said in the start, as the adapter declares it; this answer
  // carries the token and nothing about where it goes.
  assert.equal('fd' in given, false, '凭据回答里不再说变量');
  assert.equal(given.value, secret);

  // The owner replaces the token: what this Run recorded is no longer the account's, so
  // nothing is handed out (the Runner withdraws such a Run the same way).
  const next = 'another-ref';
  const nextFile = accountCredentialFile(b.host.dataDir, next);
  mkdirSync(dirname(nextFile), { recursive: true });
  writeFileSync(nextFile, 'another-token\n');
  b.host.ledger.recordAccountCredential('t1', next, USER);
  const stale = await nodePost(b.base, b.token, `/api/node/runs/${run.id}/credential`);
  assert.equal(stale.status, 409);
  assert.equal(JSON.stringify(b.host.ledger.getRun(run.id)).includes('another-token'), false, '账本里没有令牌');
  const changes = JSON.stringify(b.host.ledger.listChanges({ taskId: task.id }));
  assert.equal(changes.includes(secret), false, 'change 里没有令牌');
});

// What this catches: the client being told the hold only in the answer that ends it, which
// is too late to wait for it — so it fell back on a fixed wait of its own, and a hold longer
// than that broke. The hold the host chose is in the headers, and they come before the hold
// runs out.
test('挂起的 poll 一开始就把挂起时长写在回答头里，答案在挂完之后才来', options, async (t) => {
  const b = await bench(t, {}, { dispatchIntervalMs: 600_000, watchIntervalMs: 600_000, outboxIntervalMs: 600_000 });
  for (let attempt = 0; b.host.nodes.status().connected.length === 0; attempt += 1) {
    if (attempt > 300) throw new Error('等不到机器连回来');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  b.stopClients();
  // The registry's floor, so the test is as short as the setting allows.
  b.host.settings.set('node.pollHoldMs', 5000, USER);
  const FACTS = { node_id: 'a1b2c3d4e5f60718', name: 'node-test', platform: 'test', hostname: 'node-test.local' };
  const asked = Date.now();
  const response = await nodePost(b.base, b.token, '/api/node/poll', { runs: [], facts: FACTS, cursor: null });
  assert.ok(Date.now() - asked < 3000, '回答头要在挂起开始时就到，不等挂完');
  assert.equal(response.headers.get(NODE_HOLD_HEADER), '5000');
  const answer = (await response.json()) as { command: unknown };
  assert.ok(Date.now() - asked >= 4900, '答案在挂完之后才来');
  assert.equal(answer.command, null);
});

// What this catches: a client of the previous protocol, which gives up on a poll at 75
// seconds of its own, being let in by a host that holds polls as long as its setting says
// and tells the hold in a header that client never reads. It is told the versions differ,
// at once and not after a hold, and the host keeps that against the machine.
test('新主机遇到上一版协议的客户端：当场答版本不符，不挂起，不当成失联', options, async (t) => {
  const b = await bench(t, {}, { dispatchIntervalMs: 600_000, watchIntervalMs: 600_000, outboxIntervalMs: 600_000 });
  for (let attempt = 0; b.host.nodes.status().connected.length === 0; attempt += 1) {
    if (attempt > 300) throw new Error('等不到机器连回来');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  b.stopClients();
  b.host.settings.set('node.pollHoldMs', 5 * 60_000, USER);
  const FACTS = { node_id: 'a1b2c3d4e5f60718', name: 'node-test', platform: 'test', hostname: 'node-test.local' };
  const asked = Date.now();
  const answer = await fetch(`${b.base}/api/node/poll`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${b.token}` },
    body: JSON.stringify({ protocol: NODE_PROTOCOL - 1, cursor: null, runs: [], facts: FACTS, entry: { digest: 'legacy', at: new Date().toISOString(), executors: [{ executor: 'codex', path: '/synthetic/legacy', state: 'cleared', projection: { state: 'absent' } }] } }),
  });
  assert.equal(answer.status, 426);
  assert.ok(Date.now() - asked < 5000, '版本不符要当场说，不挂起');
  assert.equal(answer.headers.get(NODE_HOLD_HEADER), null);
  assert.match(((await answer.json()) as { error: string }).error, new RegExp(`协议版本不符.*第 ${NODE_PROTOCOL - 1} 版`));
  assert.equal(b.host.nodes.refusesProtocol(b.machine.id), true);
  assert.equal(b.host.nodes.reportedEntry(b.machine.id), null, '旧读方的 absent 不能进入新事实');
});

// What this catches: the routes a client that has just been refused for its protocol uses to
// find the host's version being behind the same version check — which is the one situation
// they exist for. They take a node token, nothing else, and a host that runs from a checkout
// says it has no package rather than packing something it does not have.
test('版本接口：节点令牌必须，协议号不对也照样回答，源码目录主机给原因不给包', options, async (t) => {
  const b = await bench(t, {}, { dispatchIntervalMs: 600_000, watchIntervalMs: 600_000, outboxIntervalMs: 600_000 });
  const host = appVersion(REPO);
  const body = JSON.stringify({ protocol: 6, version: '0.0.1', upgrade: null });

  const anonymous = await fetch(`${b.base}/api/node/release`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
  assert.equal(anonymous.status, 401, '没有节点令牌不回答');

  const answer = await fetch(`${b.base}/api/node/release`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${b.token}` },
    body,
  });
  assert.equal(answer.status, 200, '协议号不对也照样回答：它就是换版本的通道');
  const said = (await answer.json()) as { version: string; package: unknown; why: string; check_every_ms: number };
  assert.equal(said.version, host);
  assert.equal(said.package, null);
  assert.match(said.why, /源码目录/);
  assert.ok(said.check_every_ms > 0);

  const pkg = await nodeGet(b.base, b.token, '/api/node/release/package');
  assert.equal(pkg.status, 409);
  assert.match(((await pkg.json()) as { error: string }).error, /源码目录/);

  // The report is on the machine's page: the client's version, and the host's version beside it.
  const console_ = await signIn(b.host);
  const page = (await (await console_.get('/api/machines')).json()) as {
    host_version: string;
    machines: { id: string; node: { release: { version: string; at: string; upgrade: unknown } | null } }[];
  };
  assert.equal(page.host_version, host);
  const mine = page.machines.find((machine) => machine.id === b.machine.id);
  assert.equal(mine?.node.release?.version, '0.0.1');
  assert.equal(mine?.node.release?.upgrade, null);
});

test('malformed output source arrays fail at HTTP before any disposition query',options,async t=>{
 const b=await bench(t,{}, {},{hold:true});
 const response=await nodePost(b.base,b.token,'/api/node/poll',{bounded_output:1,runs:[],facts:{node_id:b.machine.nodeId,name:b.machine.id,platform:'test',hostname:b.machine.host},output:{capacity:{limit_bytes:100,used_bytes:0,reserved_bytes:0,external_bytes:0,free_bytes:100,available_runs:1},references:{items:[{source:['a'.repeat(64)],run_dir:'tasks/t/runs/r',phase:'sealed'}]},legacy:{items:[]}}});
 assert.equal(response.status,400);assert.match(await response.text(),/输出来源引用无效/);
});

test('/api/machines counts unknown output refs safely instead of failing 400 when a run is missing', options, async (t) => {
  const b = await bench(t, {}, {}, { hold: true });
  await b.stopClients();
  const poll = await nodePost(b.base, b.token, '/api/node/poll', {
    bounded_output: 1,
    runs: [],
    facts: { node_id: b.machine.nodeId, name: b.machine.id, platform: 'test', hostname: b.machine.host },
    output: {
      capacity: { limit_bytes: 100, used_bytes: 0, reserved_bytes: 0, external_bytes: 0, free_bytes: 100, available_runs: 1 },
      references: { items: [{ source: 'a'.repeat(64), run_dir: 'tasks/missing-task/runs/missing-run', phase: 'sealed' }] },
      legacy: { items: [] },
    },
  });
  assert.equal(poll.status, 200);
  const console_ = await signIn(b.host);
  const res = await console_.get('/api/machines');
  assert.equal(res.status, 200);
  const body = await res.json() as { machines: { id: string; node: { output: { unknown_sources: number } | null } }[] };
  const mine = body.machines.find((each) => each.id === b.machine.id);
  assert.equal(mine?.node.output?.unknown_sources, 1);
});
