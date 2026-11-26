// Guards the version directories an upgrade must not delete (docs/design/nodes.md §1.4, §7):
// machines that share one data directory and one installation each keep their own client
// identity, and a client on another of them — or one this machine cannot look at because its
// lock names another machine — still starts its watch processes from the version directory it
// wrote down. Only this machine's own identity was counted before.
//
// What this file is here to catch:
//   - an upgrade deleting the version directory another machine's client is running from,
//   - a client whose lock is on another machine being read as "not in use".
import './guard.ts';
import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { runCli } from '../cli/main.ts';
import { clientsInUse } from '../node/cli.ts';
import { machineScope } from '../node/runbox.ts';
import type { Stage } from './cli-helpers.ts';
import { stage, stubApp } from './cli-helpers.ts';

const versions = (prefix: string): string[] => readdirSync(join(prefix, 'versions')).sort();

async function install(s: Stage, version: string, prefix: string): Promise<void> {
  s.cli.appRoot = stubApp(join(prefix, 'versions', `.staging-${process.pid}-${version}`), version);
  assert.equal(await runCli(['install-self', '--prefix', prefix, '--node', process.execPath], s.cli), 0, s.text());
}

// A second identity under this data directory, the way another machine sharing the home leaves
// one: its own id and its own client.json naming the program directory it runs from.
function otherIdentity(s: Stage, programDir: string, lockMachine?: string): void {
  const id = 'b'.repeat(32);
  const dir = join(machineScope(s.dataDir), id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'id'), `${id}\n`);
  writeFileSync(join(dir, 'client.json'), `${JSON.stringify({ pid: 4321, program_dir: programDir, version: '1.0.0' })}\n`);
  if (lockMachine !== undefined) {
    writeFileSync(join(dir, 'client.lock'), `${JSON.stringify({ pid: 4321, process_start: 'elsewhere', machine: lockMachine, hostname: 'other' })}\n`);
  }
}

test('别的身份的 client.json 指着的版本目录不被清理', async (t) => {
  const s = stage(t);
  const prefix = join(s.dir, 'prefix');
  await install(s, '1.0.0', prefix);
  otherIdentity(s, join(prefix, 'versions', '1.0.0'));
  await install(s, '1.1.0', prefix);
  await install(s, '1.2.0', prefix);
  assert.deepEqual(versions(prefix), ['1.0.0', '1.1.0', '1.2.0'], `另一个身份还在用 1.0.0：${JSON.stringify(clientsInUse(s.dataDir))}`);
});

test('持锁的进程在别的机器上：也算在用，不清理它指着的版本目录', async (t) => {
  const s = stage(t);
  const prefix = join(s.dir, 'prefix');
  await install(s, '1.0.0', prefix);
  otherIdentity(s, join(prefix, 'versions', '1.0.0'), 'another-machine');
  const inUse = clientsInUse(s.dataDir);
  assert.equal(inUse.length, 1);
  assert.equal(inUse[0]!.elsewhere, 'another-machine');
  await install(s, '1.1.0', prefix);
  await install(s, '1.2.0', prefix);
  assert.deepEqual(versions(prefix), ['1.0.0', '1.1.0', '1.2.0']);
});
