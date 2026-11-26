// Normal polls refresh native knowledge facts without rescanning executors or resending content.
import './guard.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createClient } from '../node/client.ts';
import { applyEntry, entryTargets } from '../node/global-entry.ts';
import { questionsFrom } from '../node/executors.ts';
import { codexAdapter } from '../adapters/codex.ts';
import { NODE_PROTOCOL, type NodeEntryContent, type NodePollRequest } from '../shared/node-protocol.ts';
const A = 'a'.repeat(32), B = 'b'.repeat(32), C = 'c'.repeat(32);
const content = (id: string, text: string | null): NodeEntryContent => ({ publisher: { id }, digest: id + ':' + text, revisions: text === null ? [] : ['k@1'], text });

test('next normal poll refreshes foreign withdrawal/reappearance and retries own projection without a heavy look', { timeout: 15000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'tycho-entry-poll-refresh-')); const profile = join(root, 'profile'); mkdirSync(profile);
  const env = { CODEX_HOME: profile }, targets = entryTargets(['codex']);
  const apply = (id: string, text: string | null) => applyEntry(content(id, text), targets, { env, home: root });
  const path = join(profile, 'AGENTS.md'), mutex = join(profile, '.tycho-entry-mutex.sqlite');
  apply(A, 'foreign A');
  let hostContent = content(B, null), supplied = 0, scans = 0, polls = 0;
  const reports: NodePollRequest[] = [], times: number[] = [], scanCounts: number[] = []; const stop = new AbortController();
  let held: DatabaseSync | undefined; let originalMutex: Buffer | undefined;
  t.after(() => { held?.close(); rmSync(root, { recursive: true, force: true }); });
  const client = createClient({
    dataDir: join(root, 'data'), origin: 'http://127.0.0.1:1', token: 'synthetic',
    facts: { node_id: 'synthetic', name: 'entry-refresh', platform: 'test', hostname: 'private-profile' }, log: () => {},
    entry: { env, home: root },
    executors: { questions: questionsFrom({ codex: codexAdapter }), run: async argv => {
      scans++; return argv.length === 2 && argv[1] === '--version' ? { stdout: 'codex-cli 0.162.0\n', stderr: '', code: 0 } : { stdout: '', stderr: '', code: 1 };
    } },
    fetch: (async (url: string | URL, init?: RequestInit) => {
      if (!String(url).endsWith('/api/node/poll')) throw Error('unexpected external request');
      if (polls === 0) await client.look(); // Only the initial discovery already started by run().
      const body = JSON.parse(String(init?.body)) as NodePollRequest;
      reports.push(body); times.push(performance.now()); scanCounts.push(scans); polls++;
      if (polls === 2) apply(A, null);
      if (polls === 3) apply(C, 'foreign C');
      if (polls === 4) { apply(C, null); hostContent = content(B, 'own B'); }
      if (polls === 5) unlinkSync(path);
      if (polls === 6) { held = new DatabaseSync(mutex); held.exec('BEGIN EXCLUSIVE'); }
      if (polls === 7) { held!.exec('ROLLBACK'); held!.close(); held = undefined; }
      if (polls === 8) { originalMutex = readFileSync(mutex); writeFileSync(mutex, 'unknown coordination file'); }
      if (polls === 9) writeFileSync(mutex, originalMutex!);
      if (polls === 10) stop.abort();
      const entry = body.entry?.digest !== hostContent.digest ? hostContent : undefined;
      if (entry) supplied++;
      console.log(JSON.stringify({ event: 'normal-entry-poll', poll: polls, scans, report: body.entry }));
      return new Response(JSON.stringify({ protocol: NODE_PROTOCOL, command: null, look_every_ms: 600000, ...(entry ? { entry } : {}) }), { status: 200 });
    }) as typeof fetch,
  });
  await client.run(stop.signal);
  const state = (poll: number) => reports[poll - 1]!.entry!.executors[0]!;
  assert.equal(state(2).state, 'occupied'); assert.equal(state(2).projection?.state, 'present');
  assert.equal(state(3).projection?.state, 'absent', 'foreign owner withdrew; unchanged B off content must not retain old presence');
  assert.equal(state(3).state, 'cleared');
  assert.equal(state(4).state, 'occupied'); assert.equal(state(4).projection?.state, 'present'); assert.ok(state(4).note?.includes(C));
  assert.equal(state(5).state, 'written'); assert.equal(state(6).state, 'written', 'own enabled content is reasserted after file removal');
  assert.equal(state(7).state, 'failed'); assert.equal(state(7).projection?.state, 'present'); assert.match(state(7).note!, /下轮/);
  assert.equal(state(8).state, 'written');
  assert.equal(state(9).state, 'failed'); assert.equal(state(9).projection?.state, 'present');
  assert.equal(state(10).state, 'written'); assert.ok(readFileSync(path, 'utf8').endsWith('own B'));
  assert.equal(supplied, 2, 'unchanged content is not resent to retry observation');
  assert.ok(scanCounts.every(count => count === scanCounts[0]), 'normal entry refresh runs no additional executor commands');
  assert.ok(reports.slice(2).every(report => report.executors?.at === reports[1]!.executors?.at), 'no new heavy executor/account/model scan');
  assert.equal(reports[2]!.entry?.digest, reports[1]!.entry?.digest);
  console.log(JSON.stringify({ event: 'normal-entry-poll-timing', polls, supplied, scans, elapsedMs: times.at(-1)! - times[0]! }));
});
