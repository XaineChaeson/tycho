// Guards the supervisor that a machine's client lives under (docs/design/nodes.md §1.4): it
// starts the client, and after the client leaves with 75 it reads `current` again and starts
// that generation. Any other exit code is the client's own and is passed on.
//
// What this file is here to catch:
//   - a supervisor that keeps starting the version it began with instead of `current`,
//   - a client's failure mistaken for a version swap, or a swap's code lost so the client is
//     never brought back,
//   - Ctrl+C reaching the supervisor first and leaving the client (and its rounds) behind,
//   - a supervisor that takes the client lock or writes the client's facts: those would stop
//     the client itself from starting.
import './guard.ts';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { identityOf, writeToken } from '../node/client.ts';
import { CLIENT_LOCK } from '../node/cli.ts';
import { endChild, exited, ownProcess, tempDir, until } from './cli-helpers.ts';

const A = '0.1.100';
const B = '0.1.200';

// A version directory whose entry is the real `nodeCommand`, except when the supervisor starts
// it: then it is a stand-in client that writes a line and leaves with the code this test asked
// for. The first generation also moves `current` to B before leaving with 75, the way a client
// that has installed the host's version does.
function versionEntry(t: TestContext, prefix: string, version: string): void {
  const dir = join(prefix, 'versions', version);
  mkdirSync(join(dir, 'cli'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'tycho', version, type: 'module' }));
  const cli = pathToFileURL(join(import.meta.dirname, '..', 'node', 'cli.ts')).href;
  writeFileSync(join(dir, 'cli', 'main.ts'), [
    `import { appendFileSync, writeFileSync } from 'node:fs';`,
    `import { join } from 'node:path';`,
    `const root = join(import.meta.dirname, '..');`,
    `const version = root.replace(/[\\\\/]+$/, '').split(/[\\\\/]/).at(-1);`,
    `const prefix = join(root, '..', '..');`,
    `if (process.env.TYCHO_NODE_SUPERVISED === '1') {`,
    `  appendFileSync(process.env.TEST_MARKER, version + '\\n');`,
    `  if (version === ${JSON.stringify(A)} && process.env.TEST_KEEP_CURRENT !== '1') {`,
    `    writeFileSync(join(prefix, 'current'), ${JSON.stringify(B)});`,
    `    process.exit(75);`,
    `  }`,
    `  if (process.env.TEST_SLEEP === '1') { setInterval(() => {}, 1000); }`,
    `  else process.exit(Number(process.env.TEST_CHILD_EXIT ?? '0'));`,
    `} else {`,
    `  const { nodeCommand } = await import(${JSON.stringify(cli)});`,
    `  const code = await nodeCommand({ out: (line) => console.log(line), err: (line) => console.error(line), dataDir: process.env.TYCHO_DATA, signal: new AbortController().signal, appRoot: root }, ['run', '--to', 'http://127.0.0.1:1']);`,
    `  process.exit(code);`,
    `}`,
    '',
  ].join('\n'));
}

interface Bench {
  prefix: string;
  marker: string;
  log: string;
  start(env?: Record<string, string>): ReturnType<typeof spawn>;
}

function bench(t: TestContext, current = A): Bench {
  const dir = tempDir(t, 'tycho-supervisor-');
  const prefix = join(dir, 'prefix');
  versionEntry(t, prefix, A);
  versionEntry(t, prefix, B);
  writeFileSync(join(prefix, 'current'), current);
  mkdirSync(prefix, { recursive: true });
  const dataDir = join(dir, 'data');
  // The run command wants the machine's token before it becomes a supervisor; the stand-in
  // clients never read it.
  writeToken(identityOf(dataDir), 'f'.repeat(64));
  const marker = join(dir, 'started.log');
  const log = join(dir, 'client.log');
  return {
    prefix,
    marker,
    log,
    start(env = {}) {
      const child = spawn(process.execPath, [join(prefix, 'versions', A, 'cli', 'main.ts'), 'node', 'run', '--to', 'http://127.0.0.1:1', '--log', log], {
        env: { ...process.env, TYCHO_DATA: dataDir, TEST_MARKER: marker, ...env },
        stdio: 'ignore',
        windowsHide: true,
      });
      ownProcess(t, () => endChild(child));
      return child;
    },
  };
}

const started = (marker: string): string[] => {
  try {
    return readFileSync(marker, 'utf8').split('\n').filter(Boolean);
  } catch {
    return [];
  }
};

test('子进程退 75：看守重新读 current，从新版再起一次', async (t) => {
  const b = bench(t);
  const child = b.start();
  const code = await exited(child);
  assert.equal(code, 0, '新的一代正常退出，看守用它的码退出');
  assert.deepEqual(started(b.marker), [A, B], '先起 A，换版后起 B');
  // The supervisor itself never took the client lock: the client it starts does.
  assert.equal(existsSync(join(identityOf(join(b.prefix, '..', 'data')).dir, CLIENT_LOCK)), false);
});

test('子进程退 1：看守用同一个码退出，不再起下一代', async (t) => {
  const b = bench(t);
  const child = b.start({ TEST_KEEP_CURRENT: '1', TEST_CHILD_EXIT: '1' });
  assert.equal(await exited(child), 1);
  assert.deepEqual(started(b.marker), [A]);
});

test('子进程退 0：看守也退 0，不再起下一代', async (t) => {
  const b = bench(t);
  const child = b.start({ TEST_KEEP_CURRENT: '1', TEST_CHILD_EXIT: '0' });
  assert.equal(await exited(child), 0);
  assert.deepEqual(started(b.marker), [A]);
});

// SIGINT is delivered to every process in the console on POSIX; on Windows there is no way to
// send it to another process from here, so the rule is checked where it can be observed.
test('SIGINT 不让看守先走：等子进程退出后用它的码退出', { skip: process.platform === 'win32' && '要能把 SIGINT 发给另一个进程' }, async (t) => {
  const b = bench(t);
  const child = b.start({ TEST_KEEP_CURRENT: '1', TEST_SLEEP: '1' });
  await until('子进程起来', () => started(b.marker).length === 1);
  process.kill(child.pid!, 'SIGINT');
  await sleep(500);
  assert.equal(child.exitCode, null, '看守收到 Ctrl+C 不能自己先退');
  assert.equal(child.signalCode, null);
  process.kill(child.pid!, 'SIGTERM');
  assert.equal(await exited(child), 1, '子进程被停掉，看守用它的结束退出');
});
