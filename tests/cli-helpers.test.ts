// Guards the test helpers themselves. What it is for:
// - a candidate that came up and was stopped again before the helper next looked being
//   read as one that never came up: the service.json it wrote lives only a few
//   milliseconds (an upgrade checks and stops a failing candidate in about 8 ms, and the
//   service removes the file as it exits), so sampling that file alone misses it under load;
// - a program that exited without ever coming up being read as one that did;
// - a process of a test's that takes SIGTERM as a request and stays (a stand-in with
//   STUB_STOP_DELAY_MS) failing the test's teardown instead of being ended outright.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { endChild, endPid, startRealService, tempDir } from './cli-helpers.ts';
import { isAlive } from '../service/lock.ts';

// A stand-in for the program `current` names that lives as briefly as a candidate that is
// stopped at once: it writes service.json, says it is up, then removes the file and exits
// cleanly in the same breath. Synchronously rather than after a timer, so the helper
// polling the file all but never sees it: a timer's millisecond is a scheduler tick on
// Windows, long enough for a poll to land in it now and then.
const BRIEF_SERVICE = `
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const file = join(process.env.TYCHO_DATA, 'service.json');
writeFileSync(file, JSON.stringify({ pid: process.pid, port: 41975 }));
console.error(new Date().toISOString() + ' 服务已启动：http://127.0.0.1:41975，数据目录 ' + process.env.TYCHO_DATA);
rmSync(file, { force: true });
process.exit(0);
`;

// Exits before it ever comes up.
const NEVER_UP = `console.error(new Date().toISOString() + ' 服务启动失败：账本打不开'); process.exit(1);\n`;

function prefixWith(root: string, source: string): string {
  const prefix = join(root, 'prefix');
  mkdirSync(join(prefix, 'versions', '1.0.0', 'service'), { recursive: true });
  writeFileSync(join(prefix, 'current'), '1.0.0\n');
  writeFileSync(join(prefix, 'versions', '1.0.0', 'service', 'main.ts'), source);
  return prefix;
}

test('a service that came up and was gone before the next look still came up, on the port it said', async (t) => {
  const root = tempDir(t);
  const dataDir = join(root, 'data');
  mkdirSync(dataDir, { recursive: true });
  // Looked at seldom, as a loaded test process does: the file comes and goes between two looks.
  const service = await startRealService(t, prefixWith(root, BRIEF_SERVICE), dataDir, {}, { pollMs: 2000 });
  assert.equal(service.port, 41975, service.said());
});

test('a service that exited without coming up did not come up', async (t) => {
  const root = tempDir(t);
  const dataDir = join(root, 'data');
  mkdirSync(dataDir, { recursive: true });
  const service = await startRealService(t, prefixWith(root, NEVER_UP), dataDir);
  assert.equal(service.port, null, service.said());
});

// A child that hears SIGTERM and stays, as a stand-in that delays its stop does.
const STAYS = "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); console.log('ready');";
const POSIX_ONLY = { skip: process.platform === 'win32' && 'Windows 上 kill() 直接结束进程，没有"请求停下"这一步' };

async function staying() {
  const child = spawn(process.execPath, ['-e', STAYS], { stdio: ['ignore', 'pipe', 'ignore'] });
  await new Promise((resolve) => child.stdout.once('data', resolve));
  return child;
}

test('a child that stays after SIGTERM is ended outright once the grace is over, and is gone', POSIX_ONLY, async () => {
  const child = await staying();
  await endChild(child, { graceMs: 200 });
  assert.equal(child.signalCode, 'SIGKILL');
  assert.equal(isAlive(child.pid!), false);
});

test('a process known by pid that has not left after the grace is ended outright, and is gone', POSIX_ONLY, async () => {
  const child = await staying();
  child.kill();
  await endPid(child.pid!, { graceMs: 200 });
  assert.equal(isAlive(child.pid!), false);
});
