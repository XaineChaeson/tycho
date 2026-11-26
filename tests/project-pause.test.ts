// Guards against a paused project still spending: a Task of it dispatched or a Router turn
// taken for it, by the dispatcher's queue or straight through createRun and takeNextTurn;
// against a pause that reaches other projects or the knowledge Tasks that belong to none;
// against a resume that leaves anything behind; against a pause the timeline does not show;
// and against a version 28 ledger that does not open as the current line with every project
// running and no Router context size known (docs/design/project-sessions.md §5).
import './guard.ts';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { SCHEMA_VERSION, verifySnapshot } from '../service/db.ts';
import { InputError } from '../service/errors.ts';
import { openLedger } from '../service/ledger.ts';
import { fixture, USER } from './helpers.ts';

test('a paused project dispatches nothing and its Router takes nothing; a resume gives both back', (t) => {
  const f = fixture(t);
  const task = f.queuedTask();
  const message = f.ledger.receiveMessage({ channel: 'console', externalId: 'm1', actor: 'user', text: '在吗', projectId: f.projectId });
  f.ledger.setProjectPaused(f.projectId, true, USER);
  assert.ok(f.ledger.getProject(f.projectId).paused_at);
  assert.equal(f.ledger.projectPaused(f.projectId), true);
  assert.deepEqual(f.ledger.queuedTasks().map(({ id }) => id), [], '派发的队列里没有它的任务');
  assert.throws(() => f.ledger.createRun(task.id, f.login, USER), (err: unknown) => err instanceof InputError && /项目已暂停/.test(err.message));
  assert.equal(f.task(task.id).state, 'queued', '任务照旧排着，不改状态');
  assert.equal(f.ledger.hasReceivedMessage(f.projectId), false);
  assert.deepEqual(f.ledger.projectsWaiting(), []);
  assert.equal(f.ledger.takeNextTurn(f.projectId), undefined);
  assert.equal(f.ledger.getMessage(message.id).state, 'received', '消息照常入账，等着');
  const later = f.ledger.receiveMessage({ channel: 'console', externalId: 'm2', actor: 'user', text: '暂停时来的', projectId: f.projectId });
  assert.equal(f.ledger.getMessage(later.id).state, 'received');

  f.ledger.setProjectPaused(f.projectId, false, USER);
  assert.equal(f.ledger.getProject(f.projectId).paused_at, null);
  assert.deepEqual(f.ledger.queuedTasks().map(({ id }) => id), [task.id]);
  assert.equal(f.ledger.takeNextTurn(f.projectId)?.message.id, message.id);
  assert.equal(f.ledger.createRun(task.id, f.login, USER).state, 'launching');
  const changes = f.peek<{ action: string; actor: string }>(`SELECT action, actor FROM change WHERE action IN ('project.pause', 'project.resume') ORDER BY rowid`).map((row) => ({ ...row }));
  assert.deepEqual(changes, [{ action: 'project.pause', actor: 'user' }, { action: 'project.resume', actor: 'user' }]);
});

test('pausing one project leaves the others and the knowledge Tasks alone; pausing twice changes nothing', (t) => {
  const f = fixture(t);
  const other = f.ledger.createProject({ name: '另一个', loginMode: 'all' }, USER);
  const mine = f.queuedTask();
  const theirs = f.ledger.createTask({ roleId: 'implement', projectId: other, title: '别的', goal: '目标', acceptance: '测试通过' }, USER);
  f.ledger.queueTask(theirs.id, USER);
  f.ledger.setProjectPaused(f.projectId, true, USER);
  const since = f.ledger.getProject(f.projectId).paused_at;
  f.ledger.setProjectPaused(f.projectId, true, USER);
  assert.equal(f.ledger.getProject(f.projectId).paused_at, since, '已经暂停的再暂停，时刻不变');
  assert.equal(f.peek(`SELECT 1 FROM change WHERE action = 'project.pause'`).length, 1, '没变就不记');
  assert.deepEqual(f.ledger.queuedTasks().map(({ id }) => id), [theirs.id]);
  assert.equal(f.ledger.projectPaused(null), false, '不属于任何项目的（知识任务）不受影响');
  assert.notEqual(mine.id, theirs.id);
});

test('a version 28 ledger opens as the current line with every project running and no context size known', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'tycho-pause-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'ledger.db');
  const db = new DatabaseSync(path);
  db.exec(readFileSync(new URL('./fixtures/ledger/schema-v28.sql', import.meta.url), 'utf8'));
  db.exec(`INSERT INTO setting (id, created_at, key, value_json) VALUES ('version', 'now', 'schema_version', '28');
    INSERT INTO project (id, created_at, name) VALUES ('p', 'now', '旧项目');
    INSERT INTO router_segment (id, created_at, project_id, seq, state) VALUES ('s', 'now', 'p', 1, 'current');
    INSERT INTO router_context (id, created_at, segment_id, project_id, marker, state) VALUES ('c', 'now', 's', 'p', 'm', 'open');`);
  db.close();
  assert.ok(SCHEMA_VERSION >= 46);
  const ledger = openLedger(path, { copyBeforeUpgrade: false });
  try {
    assert.equal(ledger.getProject('p').paused_at, null);
    assert.equal(ledger.projectPaused('p'), false);
    assert.equal(ledger.getContext('c')!.context_tokens, null);
  } finally { ledger.close(); }
  assert.equal(verifySnapshot(path).get('schema_version'), String(SCHEMA_VERSION));
});
