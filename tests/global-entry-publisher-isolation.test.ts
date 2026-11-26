// Independent publishers must not mutate each other's shared native file; SQLite serializes actual processes.
import './guard.ts';
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fork, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync, mkdirSync, readdirSync, linkSync, unlinkSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { applyEntry, entryTargets, checkExternalEntry, ENTRY_MARK } from '../node/global-entry.ts';
const A = 'a'.repeat(32), B = 'b'.repeat(32);
const content = (id: string, text: string | null) => ({ publisher: { id }, digest: createHash('sha256').update(JSON.stringify([id, text])).digest('hex'), revisions: text === null ? [] : ['k@1'], text });
const childrenByHome = new Map<string, ChildProcess[]>();
const home = (t: TestContext) => {
  const dir = mkdtempSync(join(tmpdir(), 'tycho-publisher-')), children: ChildProcess[] = [];
  childrenByHome.set(dir, children);
  t.after(async () => {
    // Windows cannot remove the profile while a fixture still holds its SQLite file.
    const stopped = await Promise.allSettled(children.map(async child => {
      if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
      const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
    }));
    const failed = stopped.find(result => result.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
    rmSync(dir, { recursive: true, force: true });
    childrenByHome.delete(dir);
  });
  return dir;
};
const apply = (dir: string, id: string, text: string | null) => applyEntry(content(id, text), entryTargets(['codex']), { env: { CODEX_HOME: dir }, home: dir })[0]!;
let serial = 0;
async function worker(dir: string): Promise<ChildProcess> {
  const child = fork(new URL('./fixtures/global-entry/publisher-process.ts', import.meta.url), [dir], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  childrenByHome.get(dir)!.push(child);
  await new Promise<void>((resolve, reject) => { child.once('error', reject); child.once('message', () => resolve()); }); return child;
}
function request(child: ChildProcess, value: object): Promise<any> {
  const id = ++serial;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.off('message', listener); reject(Error('child did not answer')); }, 10000);
    const listener = (answer: any) => { if (answer.id !== id) return; clearTimeout(timer); child.off('message', listener); console.log(JSON.stringify({ event: 'publisher-child-result', pid: child.pid, operation: value, answer })); resolve(answer); };
    child.on('message', listener); child.send({ id, ...value });
  });
}
test('foreign off/update cannot remove or replace A; own withdraw permits B and old A cannot reassert', t => {
  const dir = home(t), path = join(dir, 'AGENTS.md');
  assert.equal(apply(dir, A, 'A1').state, 'written'); const first = readFileSync(path, 'utf8');
  assert.equal(apply(dir, B, null).state, 'occupied'); assert.equal(readFileSync(path, 'utf8'), first);
  assert.equal(apply(dir, B, 'B').state, 'occupied'); assert.equal(readFileSync(path, 'utf8'), first);
  assert.equal(apply(dir, A, 'A2').state, 'written'); assert.ok(readFileSync(path, 'utf8').endsWith('A2'));
  assert.equal(apply(dir, A, null).state, 'cleared'); assert.equal(existsSync(path), false);
  assert.equal(apply(dir, B, 'B').state, 'written'); const second = readFileSync(path, 'utf8');
  assert.equal(apply(dir, A, 'old A').state, 'occupied'); assert.equal(readFileSync(path, 'utf8'), second);
});
test('legacy and future Tycho are visible to the absence guard and cannot be claimed', t => {
  const dir = home(t), path = join(dir, 'AGENTS.md');
  for (const marker of [ENTRY_MARK, '<!-- tycho:generated:v99 publisher:future -->', '<!-- tycho:generated:v2 publisher:broken -->']) {
    const text = marker + '\nlegacy or future instructions'; writeFileSync(path, text);
    assert.notEqual(checkExternalEntry('codex', { env: { CODEX_HOME: dir } }).state, 'absent');
    assert.equal(apply(dir, A, null).state, 'occupied'); assert.equal(apply(dir, A, 'new').state, 'occupied'); assert.equal(readFileSync(path, 'utf8'), text);
  }
});
test('two Node processes cannot both claim a shared empty profile', { timeout: 20000 }, async t => {
  const dir = home(t), a = await worker(dir), b = await worker(dir);
  const results = await Promise.all([request(a, { content: content(A, 'A') }), request(b, { content: content(B, 'B') })]);
  assert.equal(results.filter(answer => answer.result[0].state === 'written').length, 1);
  const first = readFileSync(join(dir, 'AGENTS.md'), 'utf8');
  await Promise.all([request(a, { content: content(A, 'A') }), request(b, { content: content(B, 'B') })]);
  assert.equal(readFileSync(join(dir, 'AGENTS.md'), 'utf8'), first);
});

test('concurrent withdraw/reclaim/update cannot let old A change B after B claims', { timeout: 20000 }, async t => {
  const dir = home(t), a = await worker(dir), b = await worker(dir), path = join(dir, 'AGENTS.md');
  assert.equal((await request(a, { content: content(A, 'A') })).result[0].state, 'written');
  await Promise.all([request(a, { content: content(A, null) }), request(b, { content: content(B, 'B') })]);
  // A busy/occupied attempt is retried by the next normal caller cycle, not by a runtime queue.
  assert.equal((await request(b, { content: content(B, 'B') })).result[0].state, 'written');
  await Promise.all([request(a, { content: content(A, 'stale A') }), request(b, { content: content(B, 'B2') })]);
  assert.equal((await request(b, { content: content(B, 'B2') })).result[0].state, 'written');
  assert.ok(readFileSync(path, 'utf8').endsWith('B2'));
  assert.equal((await request(a, { content: content(A, null) })).result[0].state, 'occupied');
  assert.ok(readFileSync(path, 'utf8').endsWith('B2'));
});

test('same publisher host/node is idempotent and durable creation is shared across processes', { timeout: 20000 }, async t => {
  const dir = home(t), a = await worker(dir), b = await worker(dir), dataDir = join(dir, 'data');
  const ids = await Promise.all([request(a, { op: 'publisher', dataDir }), request(b, { op: 'publisher', dataDir })]);
  assert.deepEqual(ids[0].result, ids[1].result); assert.match(ids[0].result.id, /^[0-9a-f]{32}$/);
  assert.deepEqual((await request(a, { op: 'publisher', dataDir })).result, ids[0].result);
  const id = ids[0].result.id;
  assert.equal((await request(a, { content: content(id, 'same') })).result[0].state, 'written');
  const first = readFileSync(join(dir, 'AGENTS.md'), 'utf8');
  await Promise.all([request(a, { content: content(id, 'same') }), request(b, { content: content(id, 'same') })]);
  assert.equal(readFileSync(join(dir, 'AGENTS.md'), 'utf8'), first);
});

test('SQLite contention is nonblocking and a killed holder releases its OS transaction lock', { timeout: 20000 }, async t => {
  const dir = home(t), a = await worker(dir), holder = await worker(dir);
  apply(dir, A, 'before'); const path = join(dir, 'AGENTS.md'), before = readFileSync(path, 'utf8');
  const held = await request(holder, { op: 'hold' }); assert.equal(held.held, true);
  const blocked = await request(a, { content: content(A, 'after') });
  assert.equal(blocked.result[0].state, 'failed'); assert.match(blocked.result[0].note, /下轮/);
  assert.equal(readFileSync(path, 'utf8'), before);
  holder.kill('SIGKILL'); await once(holder, 'exit');
  assert.equal((await request(a, { content: content(A, 'after') })).result[0].state, 'written');
  assert.ok(readFileSync(path, 'utf8').endsWith('after'));
});

test('bad publisher and foreign/corrupt mutex preserve known content; empty disabled profile stays absent', async t => {
  const dir = home(t), missing = join(dir, 'never-created');
  assert.equal(apply(missing, A, null).state, 'cleared'); assert.equal(existsSync(missing), false);
  apply(dir, A, 'safe'); const path = join(dir, 'AGENTS.md'), before = readFileSync(path, 'utf8');
  const unknown = applyEntry({ ...content(A, null), publisher: { problem: 'publisher file unavailable' } }, entryTargets(['codex']), { env: { CODEX_HOME: dir } })[0]!;
  assert.equal(unknown.state, 'failed'); assert.equal(readFileSync(path, 'utf8'), before);
  const mutex = join(dir, readdirSync(dir).find(name => name.endsWith('.sqlite'))!);
  writeFileSync(mutex, 'not this application');
  const broken = apply(dir, A, null); assert.equal(broken.state, 'failed'); assert.ok(broken.note?.includes(mutex)); assert.match(broken.note!, /保留.*不重建/); assert.equal(broken.projection?.state, 'present'); assert.equal(readFileSync(mutex, 'utf8'), 'not this application');
  assert.equal(readFileSync(path, 'utf8'), before);
  const { globalEntryPublisher } = await import('../service/global-entry-publisher.ts');
  const data = join(dir, 'service-data'); const id = globalEntryPublisher(data); assert.ok('id' in id);
  writeFileSync(join(data, 'global-entry-publisher'), 'corrupt');
  assert.ok('problem' in globalEntryPublisher(data)); assert.equal(readFileSync(join(data, 'global-entry-publisher'), 'utf8'), 'corrupt');
});

test('foreign note identifies the safe source, while source changes never grant ownership', t => {
  const dir = home(t), targets = entryTargets(['codex']), env = { CODEX_HOME: dir };
  const a = { ...content(A, 'A'), publisher: { id: A, source: { hostname: 'office.example', port: 8787 } } };
  applyEntry(a, targets, { env });
  const blocked = applyEntry(content(B, null), targets, { env })[0]!;
  assert.equal(blocked.state, 'occupied'); assert.match(blocked.note!, /office.example:8787/); assert.match(blocked.note!, /关闭.*撤下/);
  assert.equal(applyEntry({ ...content(B, 'B'), publisher: a.publisher.id === A ? { id: B, source: a.publisher.source } : a.publisher }, targets, { env })[0]!.state, 'occupied');
  assert.equal(applyEntry({ ...content(A, 'A2'), publisher: { id: A, source: { hostname: 'new-label', port: 9999 } } }, targets, { env })[0]!.state, 'written');
  assert.match(readFileSync(join(dir, 'AGENTS.md'), 'utf8'), /new-label/);
});

// Equivalent filesystem state to interruption after closed cold DB link publication and before unlink.
test('cold publication alias left by interruption recovers in new Node processes using only the final name', { timeout: 20000 }, async t => {
  const dir = home(t); apply(dir, A, 'setup');
  const file = join(dir, readdirSync(dir).find(name => name.endsWith('.sqlite'))!);
  const coldAlias = file + '.cold-publication.tmp'; linkSync(file, coldAlias); unlinkSync(join(dir, 'AGENTS.md'));
  const before = createHash('sha256').update(readFileSync(file)).digest('hex');
  console.log(JSON.stringify({ event: 'cold-publication-interrupted', file, coldAlias, nlink: lstatSync(file).nlink, sha256: before }));
  const a = await worker(dir), b = await worker(dir);
  const answers = await Promise.all([request(a, { content: content(A, 'A') }), request(b, { content: content(B, 'B') })]);
  assert.equal(answers.filter(answer => answer.result[0].state === 'written').length, 1);
  const first = readFileSync(join(dir, 'AGENTS.md'), 'utf8');
  await Promise.all([request(a, { content: content(A, 'A') }), request(b, { content: content(B, 'B') })]);
  assert.equal(readFileSync(join(dir, 'AGENTS.md'), 'utf8'), first);
  assert.equal(existsSync(coldAlias), true, 'no cleanup of an unclaimed residual alias');
  assert.equal(createHash('sha256').update(readFileSync(file)).digest('hex'), before);
});
test('Claude rules contain only knowledge Markdown; profile mutex also serializes other adapter targets', { timeout: 20000 }, async t => {
  const dir = home(t), env = { CLAUDE_CONFIG_DIR: dir, CODEX_HOME: dir, DSH_HOME: dir };
  applyEntry(content(A, 'knowledge'), entryTargets(['claude']), { env, home: dir });
  assert.deepEqual(readdirSync(join(dir, 'rules')), ['tycho-knowledge.md']);
  assert.equal(existsSync(join(dir, '.tycho-entry-mutex.sqlite')), true);
  const holder = await worker(dir); await request(holder, { op: 'hold' });
  const before = readFileSync(join(dir, 'rules', 'tycho-knowledge.md'), 'utf8');
  const statuses = applyEntry(content(A, 'changed'), entryTargets().filter(({ entry }) => entry.home.env !== undefined), { env, home: dir });
  for (const status of statuses) { assert.equal(status.state, 'failed'); assert.match(status.note!, /下轮/); }
  assert.equal(applyEntry(content(A, 'changed'), entryTargets(['gemini']), { env, home: dir })[0]!.state, 'unconfirmed');
  assert.equal(readFileSync(join(dir, 'rules', 'tycho-knowledge.md'), 'utf8'), before);
  assert.deepEqual(readdirSync(join(dir, 'rules')), ['tycho-knowledge.md']);
});
