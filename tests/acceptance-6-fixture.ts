// The scene every restore case of §11 group 6 opens on, shared by the
// tests/acceptance-6-*.test.ts files: a backup taken while work is in flight, and life
// going on past it. It is the part that costs real time (services started and stopped,
// Router turns, a copy of the ledger while the service is down), so the cases that differ
// only in what they then assert keep it here instead of each writing it out.
//
// A crash is injected at a commit through the stage's own hooks, and the ledger files are
// copied only once the service that wrote them is down, so the backup is a real file a
// restore can be handed. The cases keep their own assertions; nothing here decides one.
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { signIn, stage, until } from './stage.ts';

// The cases run real services and real Router processes; §11's group 6 is end to end.
export const options = { timeout: 120_000 };
export const SENTENCE = '未持久化的不确认成功；恢复后先清点再派发';
export const FLOOR = '底线“写库失败停止副作用”';
export const USER = { actor: 'test' };
export const LEDGER_FILES = ['ledger.db', 'ledger.db-wal', 'ledger.db-shm'];

// What the overview reports of a restore the service found at its start.
export interface RestoreView {
  held_tasks: { id: string }[];
  unverified_messages: { id: string }[];
  runs: { id: string; state: string; exit_kind: string | null }[];
  orphan_runs: { runs: { run_id: string; alive: boolean }[] | null }[];
}

// A backup taken mid-flight, then life going on past it: what the restore cannot know.
export async function pastTheBackup(t: TestContext) {
  const scene = stage(t);
  const { dataDir, remote, start, stop, wreck, queued, launched, greet, say, turnsSeen, runsOf } = scene;
  const backups = join(dataDir, 'backups');
  mkdirSync(backups);

  const opening = await start();
  await greet(opening);
  const task = queued(opening, '备份时在跑的');
  const run = await launched(opening, task);
  await stop(opening);

  // Past their first round nothing dispatches or sends, which leaves things waiting.
  const first = await start({ dispatchIntervalMs: 60_000, outboxIntervalMs: 60_000 });
  const parked = queued(first, '备份时在排队的');
  const timer = queued(first, '备份时在等预约的');
  first.ledger.scheduleWake(timer.id, '2020-01-01T00:00:00Z', USER);
  const notice = first.ledger.outbox.enqueue('console', 'markdown', { text: '旧通知' });
  const message = say(first, '长回合');
  await until(() => turnsSeen().includes('长回合'), '备份时回合在进行');
  const queuedMessage = say(first, '排在后面的');
  await wreck(first);
  for (const file of LEDGER_FILES) {
    if (existsSync(join(dataDir, file))) copyFileSync(join(dataDir, file), join(backups, file));
  }

  // The Worker finishes, and the Task queued in the backup runs on the real timeline.
  remote.finish(run.id, { status: 'done', summary: '备份之后做完的', artifacts: [{ kind: 'commit', ref: 'c0ffee' }, { kind: 'report', ref: 'report.md' }] });
  const second = await start({ dispatchIntervalMs: 20 });
  assert.equal(second.ledger.getRun(run.id).state, 'ended');
  second.ledger.acceptTask(task.id, '看过了', USER, { withoutReview: true });
  const later = await launched(second, parked);
  // The message queued behind the long turn is handled on the real timeline too: its project's
  // Router starts for it (docs/design/project-sessions.md §3). Nothing else is sent meanwhile.
  second.ledger.setPause(true, USER);
  await until(() => turnsSeen().includes('排在后面的'), '备份之后排着的消息被处理');
  await stop(second);
  return { ...scene, backups, task, run, parked, timer, notice, message, queuedMessage, later, runsOf };
}

// What the page says the restore has left to confirm.
export const restoreOf = async (client: Awaited<ReturnType<typeof signIn>>): Promise<RestoreView> =>
  ((await (await client.get('/api/overview')).json()) as { restore: RestoreView }).restore;
