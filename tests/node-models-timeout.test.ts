// Guards the one span the machine takes from the host for a single question
// (docs/design/nodes.md §1.2, "可用模型"): the command that lists an executor's models may have
// to reach the vendor after a fresh sign-in, so it gets its own deadline, said in every poll
// answer as `models_timeout_ms` (node.modelListTimeoutMs). The failure this catches: the
// models question staying at the other probes' 6 seconds — a sign-in that just finished shows
// "可选模型没读到" — or a client of an older host, which never says the field, having no
// deadline of its own.
import './guard.ts';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createClient } from '../node/client.ts';
import type { HostProcesses } from '../node/hostprocess.ts';
import { NODE_PROTOCOL, type NodeFacts } from '../shared/node-protocol.ts';

const FACTS: NodeFacts = { node_id: 'a1b2c3d4e5f60718', name: 'mac-mini-01', platform: 'test', hostname: 'mac-mini-01.local' };

// A machine with no round of its own, so the only commands run are the probe's.
const processes: HostProcesses = {
  alive: () => false,
  startOf: async () => undefined,
  descendants: async () => [],
  tagged: async () => [],
  endTree: async () => {},
  endGroup: async () => {},
};

test('主机在回答里说模型那一问的时限：客户端照它问，没说的那一次用自己 30 秒', { timeout: 10_000 }, async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'tycho-node-models-timeout-'));
  const asked: { argv: string; timeout: number }[] = [];
  const stop = new AbortController();
  const firstAnswer = Promise.withResolvers<void>();
  const secondPoll = Promise.withResolvers<void>();
  const changedAnswer = Promise.withResolvers<void>();
  const changedHeard = Promise.withResolvers<void>();
  let polls = 0;
  const client = createClient({
    dataDir, origin: 'http://127.0.0.1:1', token: 'f'.repeat(64), facts: FACTS, procs: processes, log: () => {},
    // These questions use a fake runner, not this machine's login shell.
    lookupEnv: async () => ({ env: {} }),
    executors: {
      questions: [{ executor: 'codex', command: 'codex', version: ['--version'], models: { argv: ['codex', 'debug', 'models'], parse: () => [{ id: 'm' }] } }],
      run: async (argv: string[], timeoutMs: number) => {
        asked.push({ argv: argv.join(' '), timeout: timeoutMs });
        return argv.includes('--version') ? { stdout: '0.1.0\n', stderr: '', code: 0 } : { stdout: '{"models":[{"id":"m"}]}', stderr: '', code: 0 };
      },
    },
    fetch: (async (url: string | URL) => {
      if (!String(url).endsWith('/api/node/poll')) return new Response('{}', { status: 200 });
      const poll = ++polls;
      // The test decides when the host has spoken. A login shell's speed does not.
      if (poll === 1) await firstAnswer.promise;
      if (poll === 2) { secondPoll.resolve(); await changedAnswer.promise; }
      if (poll === 3) changedHeard.resolve();
      // Yield as a real held poll would, so a fake fetch cannot starve the event loop.
      await new Promise((resolve) => setTimeout(resolve, 5));
      return new Response(JSON.stringify({
        protocol: NODE_PROTOCOL, command: null, look_every_ms: 3_600_000,
        ...(poll === 1 ? {} : { models_timeout_ms: 45_000 }),
      }), { status: 200 });
    }) as typeof globalThis.fetch,
  });
  const running = client.run(stop.signal);
  // The test deadline also runs this hook: a lost next poll must fail, not leave a client
  // waiting on either fake host answer after the assertion has stopped waiting.
  t.after(async () => {
    try {
      firstAnswer.resolve();
      changedAnswer.resolve();
      stop.abort();
      await running;
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
  await client.look();
  const models = () => asked.filter(({ argv }) => argv === 'codex debug models');
  assert.deepEqual(models().map(({ timeout }) => timeout), [30_000], '首个主机答复尚未释放，使用客户端默认');
  firstAnswer.resolve();
  await secondPoll.promise; // The first answer omitted the field, as an older host does.
  await client.look();
  assert.deepEqual(models().map(({ timeout }) => timeout), [30_000, 30_000], '已收到不带字段的旧主机答复，仍用 30 秒');
  changedAnswer.resolve();
  await changedHeard.promise; // A new poll can only begin after the 45-second answer was consumed.
  await client.look();
  assert.deepEqual(models().map(({ timeout }) => timeout), [30_000, 30_000, 45_000], '主机说过以后，下一探针使用 45 秒');
  assert.deepEqual([...new Set(asked.filter(({ argv }) => argv === 'codex --version').map(({ timeout }) => timeout))], [6_000], '其余探针还是 6 秒');
});
