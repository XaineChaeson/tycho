// Guards against a module quietly using the registry's default when its caller forgot to
// hand it the setting: the owner's value would then be ignored with no word (a forgotten
// lost grace period fell back to the default). Each getter is required, so leaving one out
// does not compile; `npm run typecheck` is what runs these, the test below only keeps the
// file live.
import './guard.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { drain } from '../cli/service-client.ts';
import type { Running } from '../cli/service-client.ts';
import type { RunnerOptions } from '../runner/runner.ts';
import type { DispatcherOptions } from '../service/dispatcher.ts';
import type { HttpOptions } from '../service/http.ts';
import type { ModelsOptions } from '../service/models.ts';
import type { NodeOptions } from '../service/nodes.ts';
import type { OutboxSenderOptions } from '../service/outbox-sender.ts';

// True only when K is a required key of T.
type Required<T, K extends keyof T> = {} extends Pick<T, K> ? false : true;
const required = <T, K extends keyof T>(value: Required<T, K>): boolean => value;

test('every setting a module reads is one its caller must hand it', () => {
  const checks = [
    required<DispatcherOptions, 'frontLead'>(true),
    required<DispatcherOptions, 'usageWarnAt'>(true),
    required<DispatcherOptions, 'lostGraceMs'>(true),
    required<RunnerOptions, 'lostGraceMs'>(true),
    required<RunnerOptions, 'artifactFileLimitBytes'>(true),
    required<RunnerOptions, 'artifactsLimitBytes'>(true),
    required<HttpOptions, 'lostGraceMs'>(true),
    required<HttpOptions, 'loginLimit'>(true),
    required<NodeOptions, 'endedJoinKeepMs'>(true),
    required<NodeOptions, 'endedJoinMax'>(true),
    required<ModelsOptions, 'refreshMs'>(true),
    required<ModelsOptions, 'timeoutMs'>(true),
    required<OutboxSenderOptions, 'retryFirstMs'>(true),
    required<OutboxSenderOptions, 'retryMaxMs'>(true),
  ];
  // The sanity of the check itself: an optional key does not pass for a required one.
  // @ts-expect-error `intervalMs` is optional, so `true` is not what Required says of it.
  required<OutboxSenderOptions, 'intervalMs'>(true);
  assert.ok(checks.every(Boolean));
});

// What this catches: the CLI's wait for a drain being the ordinary request limit, or a
// number of its own below what the setting allows, so the CLI gave up while the service was
// still waiting for the Router's turn. A stand-in service on the loopback takes longer to
// answer than an ordinary request may (10 seconds); drain() still gets its answer.
test('排空等待比普通请求等得久：服务过了普通请求的期限才回答，CLI 照样拿到回答', { timeout: 60_000 }, async (t) => {
  const server = createServer((request, response) => {
    request.resume();
    if (request.url !== '/api/drain') {
      response.writeHead(404).end();
      return;
    }
    setTimeout(() => response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ drained: true, waited_ms: 10_500 })), 10_500);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const { port } = server.address() as AddressInfo;
  const running = { state: 'running', pid: process.pid, port, token: 't', version: '0', programDir: '', dataDir: '' } as unknown as Running;
  assert.deepEqual(await drain(running), { drained: true, waitedMs: 10_500 });
});
