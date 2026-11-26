import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { browseDirs, createDir, renameDir, validateDirSegment } from '../node/fs-browse.ts';
import { createNodes, NodeAway, NodeRefused } from '../service/nodes.ts';
import { consoleApp } from './console-helpers.ts';
import { fixture, NODES_TUNED } from './helpers.ts';

test('fs-browse lists dirs (with git detection) and read-only files, respects hidden flag, and safely creates/renames dirs', () => {
  const root = mkdtempSync(join(tmpdir(), 'tycho-fs-browse-'));
  try {
    mkdirSync(join(root, 'alpha-repo', '.git'), { recursive: true });
    mkdirSync(join(root, 'beta'));
    mkdirSync(join(root, '.hidden-dir'));
    writeFileSync(join(root, 'README.md'), 'hello');
    writeFileSync(join(root, '.env'), 'secret');

    const initial = browseDirs({ path: root }, { home: root });
    assert.equal(initial.path, root);
    assert.equal(initial.home, root);
    assert.deepEqual(
      initial.entries.map(({ name, kind, is_git }) => ({ name, kind, is_git })),
      [
        { name: 'alpha-repo', kind: 'dir', is_git: true },
        { name: 'beta', kind: 'dir', is_git: undefined },
        { name: 'README.md', kind: 'file', is_git: undefined },
      ],
    );

    const withHidden = browseDirs({ path: root, show_hidden: true }, { home: root });
    assert.ok(withHidden.entries.some((e) => e.name === '.hidden-dir' && e.kind === 'dir'));
    assert.ok(withHidden.entries.some((e) => e.name === '.env' && e.kind === 'file'));

    const created = createDir({ parent: root, name: 'gamma-project' });
    assert.equal(created.name, 'gamma-project');
    assert.equal(created.path, join(root, 'gamma-project'));
    assert.ok(existsSync(created.path));

    assert.throws(() => createDir({ parent: root, name: 'gamma-project' }), /已存在/);
    assert.throws(() => createDir({ parent: root, name: '../escape' }), /路径分隔符/);
    assert.throws(() => createDir({ parent: root, name: 'a/b' }), /路径分隔符/);
    assert.throws(() => validateDirSegment('CON', 'win32'), /保留名/);
    assert.throws(() => validateDirSegment('bad:name', 'win32'), /不允许的字符/);

    const renamed = renameDir({ path: created.path, name: 'delta-project' });
    assert.equal(renamed.name, 'delta-project');
    assert.equal(renamed.path, join(root, 'delta-project'));
    assert.ok(!existsSync(created.path));
    assert.ok(existsSync(renamed.path));

    assert.throws(() => renameDir({ path: renamed.path, name: 'beta' }), /已存在/);
    assert.throws(() => renameDir({ path: join(root, 'README.md'), name: 'other.md' }), /只能重命名普通文件夹/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('HTTP /api/machines/:uid/dirs forwards browse, create, and rename commands and maps node errors cleanly', async (t) => {
  const f = fixture(t);
  const joined = f.ledger.joinMachine(
    { id: 'box1', host: 'box1', nodeId: 'n-1', tokenHash: 'h', platform: 'linux v24', source: null, ephemeral: false },
    { actor: 'console:owner' },
  );
  let online = true;
  const sent: unknown[] = [];
  const root = mkdtempSync(join(tmpdir(), 'tycho-http-browse-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'proj', '.git'), { recursive: true });

  const realNodes = createNodes({ ledger: f.ledger, ...NODES_TUNED, log: () => {} });

  let mode: 'ok' | 'old' | 'away' = 'ok';
  const app = await consoleApp(t, {
    f,
    nodes: {
      ...realNodes,
      connected: (id: string) => online && id === 'box1',
      send: async (_machineId: string, command: any) => {
        sent.push(command);
        if (mode === 'old') throw new NodeRefused('主机发来一条不认识的命令：browse_dirs');
        if (mode === 'away') throw new NodeAway('disconnected');
        if (command.kind === 'browse_dirs') return browseDirs(command, { home: root });
        if (command.kind === 'create_dir') return createDir(command);
        if (command.kind === 'rename_dir') return renameDir(command);
        throw new Error('unexpected');
      },
    },
  });

  const listRes = await app.get(`/api/machines/${joined.uid}/dirs?path=${encodeURIComponent(root)}`);
  assert.equal(listRes.status, 200);
  const listed = (await listRes.json()) as any;
  assert.equal(listed.path, root);
  assert.equal(listed.entries[0].name, 'proj');
  assert.equal(listed.entries[0].is_git, true);

  const createRes = await app.post(`/api/machines/${joined.uid}/dirs`, { parent: root, name: 'new-app' });
  assert.equal(createRes.status, 201);
  const created = (await createRes.json()) as any;
  assert.equal(created.name, 'new-app');
  assert.ok(existsSync(join(root, 'new-app')));

  const renameRes = await app.send('PUT', `/api/machines/${joined.uid}/dirs`, { path: created.path, name: 'renamed-app' });
  assert.equal(renameRes.status, 200);
  assert.ok(existsSync(join(root, 'renamed-app')));

  mode = 'old';
  const oldRes = await app.get(`/api/machines/${joined.uid}/dirs`);
  assert.equal(oldRes.status, 501);
  assert.match(((await oldRes.json()) as any).error, /版本较旧/);

  mode = 'away';
  const awayRes = await app.get(`/api/machines/${joined.uid}/dirs`);
  assert.equal(awayRes.status, 409);

  online = false;
  const offRes = await app.get(`/api/machines/${joined.uid}/dirs`);
  assert.equal(offRes.status, 409);
  assert.match(((await offRes.json()) as any).error, /不在线/);
  assert.ok(sent.length >= 4);
});
