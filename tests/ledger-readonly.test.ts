// Guards how a ledger is read by someone who does not own it. Two kinds of reader, two
// ways of opening (service/db.ts openStoppedLedger, service/ledger-peek.ts LedgerWriter):
//
//   - one whose writer is confirmed gone (`tycho doctor` with no service running, a release
//     reading the ledger of a service it stopped or of a candidate that died) must leave
//     everything beside the file exactly as it found it. The failures: resetting the -shm a
//     crashed writer left (a write, which on Windows fails with "disk I/O error" right after
//     the writer is seen gone, so a rollback was refused), and creating a -shm and a -wal
//     beside a ledger that was closed cleanly (a plain read-only open does both, and leaves
//     them). Either way it must still read the ledger, the commits only in the -wal included.
//   - one that may meet a live writer (a release before it stops anything) must read what
//     the writer committed, as an ordinary reader that takes part in SQLite's locking.
import './guard.ts';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { serviceChecks } from '../cli/service-checks.ts';
import { serviceState } from '../cli/service-client.ts';
import type { ClaudeInspection } from '../service/claude-cli.ts';
import { openStoppedLedger, SCHEMA_VERSION } from '../service/db.ts';
import { openLedger } from '../service/ledger.ts';
import { peekLedger } from '../service/ledger-peek.ts';
import { tempDir } from './cli-helpers.ts';

const PROBE = 'readonly_probe';
const SIGNED_OUT: ClaudeInspection = { path: '/opt/claude', command: ['/opt/claude'], problem: null, login: { loggedIn: false, detail: '' } };

// A ledger whose writer crashed: its last commit only in the -wal, the -shm still there.
// The writer is a process of its own that ends without closing, waited for to its end.
async function crashedWriter(file: string): Promise<void> {
  openLedger(file).close();
  const child = spawn(process.execPath, ['-e', `
    const { DatabaseSync } = require('node:sqlite');
    const conn = new DatabaseSync(${JSON.stringify(file)});
    conn.exec('PRAGMA wal_autocheckpoint = 0');
    conn.prepare("INSERT INTO setting (id, created_at, key, value_json) VALUES ('probe', '2026-01-01T00:00:00Z', ?, ?)").run(${JSON.stringify(PROBE)}, '"在 WAL 里"');
    process.exit(7);
  `], { stdio: 'ignore', windowsHide: true });
  const code = await new Promise((resolve) => child.once('exit', resolve));
  assert.equal(code, 7, '写者写完才退出');
}

// Every file of this ledger in its directory, with its bytes: what exists, how big, what is
// in it. Compared whole, so a file created, removed, grown or rewritten all show.
function scene(file: string): Record<string, Buffer> {
  const name = file.slice(dirname(file).length + 1);
  return Object.fromEntries(readdirSync(dirname(file))
    .filter((each) => each.startsWith(name))
    .sort()
    .map((each) => [each, readFileSync(join(dirname(file), each))]));
}

const probe = (file: string): string | undefined => {
  const conn = openStoppedLedger(file);
  try {
    return (conn.prepare('SELECT value_json FROM setting WHERE key = ?').get(PROBE) as { value_json: string } | undefined)?.value_json;
  } finally {
    conn.close();
  }
};

// Each reader of a stopped ledger, in turn, with the scene compared after every one.
async function everyStoppedReader(dataDir: string, file: string, before: Record<string, Buffer>): Promise<void> {
  const unchanged = (who: string): void => assert.deepEqual(scene(file), before, `${who}：账本旁边的文件一个字节都没动`);
  probe(file);
  unchanged('openStoppedLedger');
  openLedger(file, { readOnly: true }).close();
  unchanged('只读的 openLedger');
  assert.deepEqual(peekLedger(file, 'stopped'), { known: true, version: SCHEMA_VERSION, routers: [] });
  unchanged('peekLedger（服务已停）');
  const checks = await serviceChecks(dataDir, await serviceState(dataDir), async () => SIGNED_OUT);
  assert.equal(checks.find(({ title }) => title === '账本'), undefined, `自检读得出账本：${JSON.stringify(checks)}`);
  unchanged('tycho doctor（服务没在跑）');
}

test('写账本的进程崩掉之后：停了的账本的读者不动 -wal 和 -shm，读得到只在 WAL 里的提交', async (t) => {
  const dataDir = tempDir(t);
  const file = join(dataDir, 'ledger.db');
  await crashedWriter(file);
  const before = scene(file);
  assert.deepEqual(Object.keys(before), ['ledger.db', 'ledger.db-shm', 'ledger.db-wal'], '崩掉的写者留下了 -wal 和 -shm');
  assert.equal(probe(file), '"在 WAL 里"');
  await everyStoppedReader(dataDir, file, before);
});

test('正常关掉的账本（旁边没有 -wal 和 -shm）：停了的账本的读者读得了，也不在旁边留下文件', async (t) => {
  const dataDir = tempDir(t);
  const file = join(dataDir, 'ledger.db');
  openLedger(file).close();
  const before = scene(file);
  assert.deepEqual(Object.keys(before), ['ledger.db']);
  await everyStoppedReader(dataDir, file, before);
});

test('可能还有写者的读者：读得到写者已经提交的', (t) => {
  const file = join(tempDir(t), 'ledger.db');
  const writer = openLedger(file);
  try {
    const project = writer.createProject({ name: '甲' }, { actor: 'test' });
    const context = writer.openContext({ projectId: project, segmentId: writer.ensureSegment(project).id, marker: 'm', launch: {}, knowledge: [] });
    writer.setContextStarted(context.id, 4242);
    assert.deepEqual(peekLedger(file, 'live'), { known: true, version: SCHEMA_VERSION, routers: [{ marker: 'm', pid: 4242 }] });
  } finally {
    writer.close();
  }
});
