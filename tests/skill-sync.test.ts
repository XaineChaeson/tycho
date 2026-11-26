import './guard.ts';
import assert from 'node:assert/strict';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test, type TestContext } from 'node:test';
import { gzipSync } from 'node:zlib';
import type { EntryMachinesMap, SkillRegistryMap } from '../shared/skill-catalog.ts';
import type { NodeSkillsManifest } from '../shared/node-protocol.ts';
import {
  buildMachineSkillsManifest,
  collectSkillBundleFiles,
  computeManifestDigest,
  computeSkillBundleDigest,
  decodeTarGz,
  encodeTarGz,
  packAuthorizedSkillBundle,
} from '../service/skill-bundles.ts';
import { defaultExecutorSkillDirs, scanLocalNonMirrorSkills, syncNodeSkills } from '../node/skill-sync.ts';

function makeTempDir(t: TestContext, prefix = 'tycho-skill-sync-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

const dirLinkType = (): 'junction' | 'dir' => (process.platform === 'win32' ? 'junction' : 'dir');

function buildRawTarGzEntry(opts: {
  name: string;
  prefix?: string;
  typeFlag?: string;
  data?: Buffer;
  mode?: number;
  paxPath?: string;
}): Buffer {
  const buildHeader = (h: { name: string; prefix?: string; typeFlag: string; size: number; mode: number }): Buffer => {
    const buf = Buffer.alloc(512);
    Buffer.from(h.name, 'utf8').copy(buf, 0, 0, 100);
    Buffer.from(`${(h.mode & 0o777).toString(8).padStart(7, '0')}\0`, 'ascii').copy(buf, 100);
    Buffer.from('0000000\0', 'ascii').copy(buf, 108);
    Buffer.from('0000000\0', 'ascii').copy(buf, 116);
    Buffer.from(`${h.size.toString(8).padStart(11, '0')}\0`, 'ascii').copy(buf, 124);
    Buffer.from('00000000000\0', 'ascii').copy(buf, 136);
    buf.fill(0x20, 148, 156);
    buf[156] = h.typeFlag.charCodeAt(0);
    Buffer.from('ustar\0', 'ascii').copy(buf, 257);
    Buffer.from('00', 'ascii').copy(buf, 263);
    if (h.prefix) Buffer.from(h.prefix, 'utf8').copy(buf, 345, 0, 155);
    let sum = 0;
    for (let i = 0; i < 512; i += 1) sum += buf[i]!;
    Buffer.from(`${sum.toString(8).padStart(6, '0')}\0 `, 'ascii').copy(buf, 148);
    return buf;
  };
  const pad = (b: Buffer): Buffer => {
    const rem = b.length % 512;
    return rem === 0 ? b : Buffer.concat([b, Buffer.alloc(512 - rem)]);
  };

  const parts: Buffer[] = [];
  if (opts.paxPath !== undefined) {
    const body = Buffer.from(` path=${opts.paxPath}\n`, 'utf8');
    let len = body.length + 1;
    while (String(len).length + body.length !== len) len = String(len).length + body.length;
    const paxData = Buffer.concat([Buffer.from(String(len), 'ascii'), body]);
    parts.push(buildHeader({ name: 'PaxHeader/0', typeFlag: 'x', size: paxData.length, mode: 0o644 }));
    parts.push(pad(paxData));
  }

  const data = opts.data ?? Buffer.alloc(0);
  parts.push(
    buildHeader({
      name: opts.name,
      prefix: opts.prefix,
      typeFlag: opts.typeFlag ?? '0',
      size: data.length,
      mode: opts.mode ?? 0o644,
    }),
  );
  if (data.length > 0) parts.push(pad(data));
  parts.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(parts));
}

describe('USTAR/PAX tar+gzip codec', () => {
  test('round-trips nested subdirs, Chinese filenames, USTAR long paths (>100), and PAX ultra-long paths (>255)', () => {
    const ustarLongAsciiPath = `${'nested-guidance/'.repeat(7)}modern-web-guidance-checklist.md`; // > 100 and <= 255
    assert.ok(ustarLongAsciiPath.length > 100 && ustarLongAsciiPath.length <= 255);

    const paxUltraLongPath = `${'deep-dir-segment/'.repeat(16)}${'a'.repeat(110)}.txt`; // > 255 and segment > 100
    assert.ok(paxUltraLongPath.length > 255);

    const input = [
      { path: 'SKILL.md', data: Buffer.from('---\nname: Demo\n---\nHello\n', 'utf8'), mode: 0o644 },
      { path: 'scripts/tool.py', data: Buffer.from('#!/usr/bin/env python3\nprint("ok")\n', 'utf8'), mode: 0o755 },
      { path: 'references/中文目录/接口规范说明.md', data: Buffer.from('# 中文内容\n', 'utf8'), mode: 0o644 },
      { path: ustarLongAsciiPath, data: Buffer.from('long ascii content', 'utf8'), mode: 0o644 },
      { path: paxUltraLongPath, data: Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe]), mode: 0o600 },
      { path: 'empty.txt', data: Buffer.alloc(0), mode: 0o644 },
    ];

    const gz = encodeTarGz(input);
    const decoded = decodeTarGz(gz);

    assert.equal(decoded.length, input.length);
    for (let i = 0; i < input.length; i += 1) {
      assert.equal(decoded[i]!.path, input[i]!.path);
      assert.deepEqual(decoded[i]!.data, input[i]!.data);
      assert.equal(decoded[i]!.mode, input[i]!.mode);
    }
  });

  test('rejects path traversal, absolute paths, Windows drives, backslashes, NUL bytes, symlinks, hardlinks, devices, and bomb limits', () => {
    const badEntries = [
      { label: 'dotdot traversal', gz: buildRawTarGzEntry({ name: '../escape.txt', data: Buffer.from('x') }) },
      { label: 'nested dotdot', gz: buildRawTarGzEntry({ name: 'a/../../escape.txt', data: Buffer.from('x') }) },
      { label: 'unix absolute', gz: buildRawTarGzEntry({ name: '/etc/passwd', data: Buffer.from('x') }) },
      { label: 'windows drive', gz: buildRawTarGzEntry({ name: 'C:/Windows/win.ini', data: Buffer.from('x') }) },
      { label: 'backslash', gz: buildRawTarGzEntry({ name: 'a\\b.txt', data: Buffer.from('x') }) },
      { label: 'PAX NUL byte', gz: buildRawTarGzEntry({ name: 'safe.txt', paxPath: 'evil\0.txt', data: Buffer.from('x') }) },
      { label: 'PAX traversal', gz: buildRawTarGzEntry({ name: 'safe.txt', paxPath: '../pax-escape.txt', data: Buffer.from('x') }) },
      { label: 'symlink type 2', gz: buildRawTarGzEntry({ name: 'link', typeFlag: '2' }) },
      { label: 'hardlink type 1', gz: buildRawTarGzEntry({ name: 'hlink', typeFlag: '1' }) },
      { label: 'char device type 3', gz: buildRawTarGzEntry({ name: 'dev', typeFlag: '3' }) },
      { label: 'fifo type 6', gz: buildRawTarGzEntry({ name: 'fifo', typeFlag: '6' }) },
    ];

    for (const tc of badEntries) {
      assert.throws(() => decodeTarGz(tc.gz), `Expected decodeTarGz to reject ${tc.label}`);
    }

    // maxBytes & maxFiles enforcement
    const twoFilesGz = encodeTarGz([
      { path: 'a.txt', data: Buffer.alloc(600, 0x61) },
      { path: 'b.txt', data: Buffer.alloc(600, 0x62) },
    ]);
    assert.throws(() => decodeTarGz(twoFilesGz, { maxBytes: 1000 }), /max bytes/i);
    assert.throws(() => decodeTarGz(twoFilesGz, { maxFiles: 1 }), /max files/i);

    // Gzip bomb protection: 5 MiB of zeros compressed tiny, rejected by tight maxBytes/maxFiles
    const bombGz = gzipSync(Buffer.alloc(5 * 1024 * 1024));
    assert.throws(() => decodeTarGz(bombGz, { maxBytes: 4096, maxFiles: 4 }));
  });
});

describe('buildMachineSkillsManifest & packAuthorizedSkillBundle', () => {
  test('enforces per-machine authorization for directory skills, global skills, managed ledger skills, and retired entries', (t) => {
    const root = makeTempDir(t);
    const skillsDir = join(root, 'skills');
    const externalGlobal = join(root, 'external-global-skill');
    const outsideSecret = join(root, 'outside-secret.txt');
    mkdirSync(skillsDir, { recursive: true });
    mkdirSync(externalGlobal, { recursive: true });
    writeFileSync(outsideSecret, 'TOP SECRET', 'utf8');

    const writeSkill = (slug: string, skillMd: string, extras?: Record<string, string>) => {
      const dir = join(skillsDir, slug);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'SKILL.md'), skillMd, 'utf8');
      for (const [rel, content] of Object.entries(extras ?? {})) {
        const p = join(dir, ...rel.split('/'));
        mkdirSync(join(p, '..'), { recursive: true });
        writeFileSync(p, content, 'utf8');
      }
    };

    // 1. Company-only skill with nested scripts & references + ignored .git / node_modules
    writeSkill(
      'company-deploy',
      '---\nname: Company Deploy\ndescription: Internal deploy flow\n---\nRun scripts/tool.py\n',
      {
        'scripts/tool.py': 'print("company v1")\n',
        'references/doc.md': '# Internal Docs\n',
        '.git/HEAD': 'ref: refs/heads/main\n',
        'node_modules/pkg/index.js': 'module.exports = 1;\n',
        '.DS_Store': 'junk',
      },
    );

    // 2. Home-only skill
    writeSkill('home-homelab', '---\nname: Home Lab\ndescription: Home cluster ops\n---\nManage home NAS\n');

    // 3. Global skill mounted via top-level junction/symlink
    writeFileSync(join(externalGlobal, 'SKILL.md'), '---\nname: Global Web\ndescription: Modern web guidance\n---\nWeb rules\n', 'utf8');
    mkdirSync(join(externalGlobal, 'references'), { recursive: true });
    writeFileSync(join(externalGlobal, 'references', '中文规范.md'), '# 前端规范\n', 'utf8');
    symlinkSync(externalGlobal, join(skillsDir, 'global-web'), dirLinkType());

    // 4. Disabled global skill (must never be distributed)
    writeSkill('disabled-skill', '---\nname: Disabled\ndescription: Off\n---\nBody\n');

    // 5. Fail-closed skill (machine_ids: [])
    writeSkill('orphan-machine-skill', '---\nname: Orphan\ndescription: Bound to deleted machine\n---\nBody\n');

    // 6. Managed ledger skill: active + restricted to work-pc
    writeSkill(
      'ledger-corp-only',
      '---\nname: Ledger Corp\ndescription: Corp policy\n---\n<!-- tycho-ledger: k_corp@2 -->\n\nCorp rule\n',
    );

    // 7. Managed ledger skill: active + global (not listed in entryMachines -> null -> all machines)
    writeSkill(
      'ledger-global',
      '---\nname: Ledger Global\ndescription: Global policy\n---\n<!-- tycho-ledger: k_global@1 -->\n\nGlobal rule\n',
    );

    // 8. Managed ledger skill: retired (NOT in activeLedgerIds)
    writeSkill(
      'ledger-retired',
      '---\nname: Ledger Retired\ndescription: Old policy\n---\n<!-- tycho-ledger: k_retired@5 -->\n\nOld rule\n',
    );

    const registry: SkillRegistryMap = {
      'company-deploy': { enabled: true, loading: 'on_demand', project_ids: null, roles: [], machine_ids: ['work-pc'] },
      'home-homelab': { enabled: true, loading: 'on_demand', project_ids: null, roles: [], machine_ids: ['home-linux'] },
      'global-web': { enabled: true, loading: 'on_demand', project_ids: null, roles: [], machine_ids: null },
      'disabled-skill': { enabled: false, loading: 'on_demand', project_ids: null, roles: [], machine_ids: null },
      'orphan-machine-skill': { enabled: true, loading: 'on_demand', project_ids: null, roles: [], machine_ids: [] },
    };
    const entryMachines: EntryMachinesMap = {
      k_corp: ['work-pc'],
    };
    const activeLedgerIds = new Set(['k_corp', 'k_global']);

    // Empty/null skillsDir yields stable empty manifest
    const emptyManifest = buildMachineSkillsManifest({
      skillsDir: null,
      registry,
      entryMachines,
      activeLedgerIds,
      machineId: 'work-pc',
    });
    assert.deepEqual(emptyManifest.items, []);
    assert.equal(emptyManifest.digest, computeManifestDigest([]));

    // Company machine manifest
    const workManifest = buildMachineSkillsManifest({
      skillsDir,
      registry,
      entryMachines,
      activeLedgerIds,
      machineId: 'work-pc',
    });
    assert.deepEqual(
      workManifest.items.map((i) => i.slug),
      ['company-deploy', 'global-web', 'ledger-corp-only', 'ledger-global'],
    );

    // Home machine manifest (strictly isolated from company skills & retired ledger entries)
    const homeManifest = buildMachineSkillsManifest({
      skillsDir,
      registry,
      entryMachines,
      activeLedgerIds,
      machineId: 'home-linux',
    });
    assert.deepEqual(
      homeManifest.items.map((i) => i.slug),
      ['global-web', 'home-homelab', 'ledger-global'],
    );

    // Pack authorization checks
    assert.equal(
      packAuthorizedSkillBundle({
        skillsDir,
        registry,
        entryMachines,
        activeLedgerIds,
        machineId: 'home-linux',
        slug: 'company-deploy',
      }),
      null,
    );
    assert.equal(
      packAuthorizedSkillBundle({
        skillsDir,
        registry,
        entryMachines,
        activeLedgerIds,
        machineId: 'home-linux',
        slug: 'ledger-corp-only',
      }),
      null,
    );
    assert.equal(
      packAuthorizedSkillBundle({
        skillsDir,
        registry,
        entryMachines,
        activeLedgerIds,
        machineId: 'work-pc',
        slug: 'home-homelab',
      }),
      null,
    );
    assert.equal(
      packAuthorizedSkillBundle({
        skillsDir,
        registry,
        entryMachines,
        activeLedgerIds,
        machineId: 'work-pc',
        slug: 'ledger-retired',
      }),
      null,
    );
    assert.equal(
      packAuthorizedSkillBundle({
        skillsDir,
        registry,
        entryMachines,
        activeLedgerIds,
        machineId: 'work-pc',
        slug: '../escape',
      }),
      null,
    );

    // Multi-file bundle packs scripts/ and references/, skips .git/node_modules/.DS_Store
    const packedCompany = packAuthorizedSkillBundle({
      skillsDir,
      registry,
      entryMachines,
      activeLedgerIds,
      machineId: 'work-pc',
      slug: 'company-deploy',
    });
    assert.ok(packedCompany);
    const decodedCompany = decodeTarGz(packedCompany.tarGz);
    assert.deepEqual(
      decodedCompany.map((f) => f.path),
      ['SKILL.md', 'references/doc.md', 'scripts/tool.py'],
    );
    assert.equal(
      packedCompany.digest,
      workManifest.items.find((i) => i.slug === 'company-deploy')!.digest,
    );

    // Top-level junction skill packs cleanly with Chinese nested files
    const packedGlobal = packAuthorizedSkillBundle({
      skillsDir,
      registry,
      entryMachines,
      activeLedgerIds,
      machineId: 'home-linux',
      slug: 'global-web',
    });
    assert.ok(packedGlobal);
    assert.deepEqual(
      decodeTarGz(packedGlobal.tarGz).map((f) => f.path),
      ['SKILL.md', 'references/中文规范.md'],
    );

    // Nested file modification changes digest
    const digestBefore = collectSkillBundleFiles(join(skillsDir, 'company-deploy')).digest;
    writeFileSync(join(skillsDir, 'company-deploy', 'scripts', 'tool.py'), 'print("company v2")\n', 'utf8');
    const digestAfter = collectSkillBundleFiles(join(skillsDir, 'company-deploy')).digest;
    assert.notEqual(digestAfter, digestBefore);
  });

  test('collectSkillBundleFiles skips nested symlinks that escape skillRootDir', (t) => {
    const root = makeTempDir(t);
    const skillDir = join(root, 'my-skill');
    const outsideDir = join(root, 'outside');
    mkdirSync(skillDir, { recursive: true });
    mkdirSync(outsideDir, { recursive: true });
    writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: Safe\n---\nBody\n', 'utf8');
    writeFileSync(join(outsideDir, 'secret.txt'), 'secret data', 'utf8');
    symlinkSync(outsideDir, join(skillDir, 'escape-dir'), dirLinkType());

    const collected = collectSkillBundleFiles(skillDir);
    assert.deepEqual(
      collected.files.map((f) => f.path),
      ['SKILL.md'],
    );
  });
});

describe('defaultExecutorSkillDirs & syncNodeSkills', () => {
  test('defaultExecutorSkillDirs returns standard per-executor skill roots under home', () => {
    const fakeHome = join(tmpdir(), 'tycho-fake-home');
    const dirs = defaultExecutorSkillDirs(undefined, fakeHome);
    assert.deepEqual(dirs, [
      join(fakeHome, '.agents', 'skills'),
      join(fakeHome, '.claude', 'skills'),
      join(fakeHome, '.codex', 'skills'),
      join(fakeHome, '.gemini', 'config', 'skills'),
    ]);
  });

  test('performs initial sync, zero-fetch incremental sync, single-skill update, pruning, user/external link preservation, skipLinkDirs, and digest mismatch protection', async (t) => {
    const root = makeTempDir(t);
    const hostSkillsDir = join(root, 'host-skills');
    const mirrorDir = join(root, 'node-mirror');
    const execClaudeDir = join(root, 'exec-claude-skills');
    const execCodexDir = join(root, 'exec-codex-skills');
    const skippedHostDir = join(root, 'host-own-dir');
    const externalUserTarget = join(root, 'user-external-skill');

    mkdirSync(hostSkillsDir, { recursive: true });
    mkdirSync(execClaudeDir, { recursive: true });
    mkdirSync(execCodexDir, { recursive: true });
    mkdirSync(skippedHostDir, { recursive: true });
    mkdirSync(externalUserTarget, { recursive: true });

    const writeHostSkill = (slug: string, body: string, script: string) => {
      const dir = join(hostSkillsDir, slug);
      mkdirSync(join(dir, 'scripts'), { recursive: true });
      writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${slug}\n---\n${body}\n`, 'utf8');
      writeFileSync(join(dir, 'scripts', 'run.py'), script, 'utf8');
    };

    writeHostSkill('alpha', 'Alpha v1', 'print("alpha1")');
    writeHostSkill('beta', 'Beta v1', 'print("beta1")');
    writeHostSkill('user-collision', 'Host copy', 'print("host")');
    writeHostSkill('ext-link-collision', 'Host ext copy', 'print("host-ext")');

    // Pre-existing user-owned real directory in execClaudeDir -> MUST be preserved!
    mkdirSync(join(execClaudeDir, 'user-collision'), { recursive: true });
    writeFileSync(join(execClaudeDir, 'user-collision', 'SKILL.md'), 'USER OWNED DO NOT TOUCH', 'utf8');

    // Pre-existing external junction in execClaudeDir -> MUST be preserved!
    writeFileSync(join(externalUserTarget, 'SKILL.md'), 'EXTERNAL USER SKILL', 'utf8');
    symlinkSync(externalUserTarget, join(execClaudeDir, 'ext-link-collision'), dirLinkType());

    const registry: SkillRegistryMap = {};
    const entryMachines: EntryMachinesMap = {};
    const activeLedgerIds = new Set<string>();
    const machineId = 'node-1';

    const buildManifest = () =>
      buildMachineSkillsManifest({
        skillsDir: hostSkillsDir,
        registry,
        entryMachines,
        activeLedgerIds,
        machineId,
      });

    const fetched: string[] = [];
    const fetchBundle = async (slug: string): Promise<Buffer> => {
      fetched.push(slug);
      const packed = packAuthorizedSkillBundle({
        skillsDir: hostSkillsDir,
        registry,
        entryMachines,
        activeLedgerIds,
        machineId,
        slug,
      });
      if (!packed) throw new Error(`Bundle not found: ${slug}`);
      return packed.tarGz;
    };

    const linkDirs = [execClaudeDir, execCodexDir, skippedHostDir];
    const skipLinkDirs = [skippedHostDir];

    // 1. Initial sync downloads all 4 bundles & links junctions
    const manifest1 = buildManifest();
    const report1 = await syncNodeSkills({
      mirrorDir,
      manifest: manifest1,
      fetchBundle,
      linkDirs,
      skipLinkDirs,
    });

    assert.equal(report1.error, undefined);
    assert.equal(report1.digest, manifest1.digest);
    assert.deepEqual(report1.synced, ['alpha', 'beta', 'ext-link-collision', 'user-collision']);
    assert.deepEqual(fetched.sort(), ['alpha', 'beta', 'ext-link-collision', 'user-collision']);

    // Verify mirror files extracted completely
    assert.equal(readFileSync(join(mirrorDir, 'alpha', 'scripts', 'run.py'), 'utf8'), 'print("alpha1")');
    assert.equal(readFileSync(join(mirrorDir, 'beta', 'scripts', 'run.py'), 'utf8'), 'print("beta1")');

    // Verify managed links created in execClaudeDir & execCodexDir, and skippedHostDir untouched
    assert.equal(lstatSync(join(execClaudeDir, 'alpha')).isSymbolicLink(), true);
    assert.equal(readFileSync(join(execClaudeDir, 'alpha', 'scripts', 'run.py'), 'utf8'), 'print("alpha1")');
    assert.equal(lstatSync(join(execCodexDir, 'beta')).isSymbolicLink(), true);
    assert.deepEqual(readdirSync(skippedHostDir), []);

    // Verify user-owned real directory & external user junction preserved and reported in skipped
    assert.equal(lstatSync(join(execClaudeDir, 'user-collision')).isSymbolicLink(), false);
    assert.equal(readFileSync(join(execClaudeDir, 'user-collision', 'SKILL.md'), 'utf8'), 'USER OWNED DO NOT TOUCH');
    assert.equal(lstatSync(join(execClaudeDir, 'ext-link-collision')).isSymbolicLink(), true);
    assert.equal(readFileSync(join(execClaudeDir, 'ext-link-collision', 'SKILL.md'), 'utf8'), 'EXTERNAL USER SKILL');
    const skippedReasons = new Map((report1.skipped ?? []).map((s) => [s.slug, s.reason]));
    assert.equal(skippedReasons.get('user-collision'), '本地已存在非托管目录，已保留');
    assert.equal(skippedReasons.get('ext-link-collision'), '本地已存在其他链接，已保留');

    // 2. Second sync with identical manifest calls fetchBundle 0 times
    fetched.length = 0;
    const report2 = await syncNodeSkills({
      mirrorDir,
      manifest: manifest1,
      fetchBundle,
      linkDirs,
      skipLinkDirs,
    });
    assert.equal(fetched.length, 0);
    assert.equal(report2.digest, manifest1.digest);
    assert.equal(report2.error, undefined);

    // 3. Updating ONLY 1 skill fetches ONLY that 1 slug
    fetched.length = 0;
    writeHostSkill('alpha', 'Alpha v2', 'print("alpha2")');
    const manifest3 = buildManifest();
    assert.notEqual(manifest3.digest, manifest1.digest);

    const report3 = await syncNodeSkills({
      mirrorDir,
      manifest: manifest3,
      fetchBundle,
      linkDirs,
      skipLinkDirs,
    });
    assert.deepEqual(fetched, ['alpha']);
    assert.equal(report3.digest, manifest3.digest);
    assert.equal(report3.error, undefined);
    assert.equal(readFileSync(join(mirrorDir, 'alpha', 'scripts', 'run.py'), 'utf8'), 'print("alpha2")');
    assert.equal(readFileSync(join(execClaudeDir, 'alpha', 'scripts', 'run.py'), 'utf8'), 'print("alpha2")');
    // No leftover .stage-* or .old-* temp directories in mirrorDir
    assert.equal(
      readdirSync(mirrorDir).some((n) => n.startsWith('.stage-') || n.startsWith('.old-')),
      false,
    );

    // 4. Digest mismatch refuses swap and preserves previous synced copy intact
    writeHostSkill('alpha', 'Alpha v3', 'print("alpha3")');
    const manifest4 = buildManifest();
    const report4 = await syncNodeSkills({
      mirrorDir,
      manifest: manifest4,
      fetchBundle: async (slug) => {
        if (slug === 'alpha') {
          // Return tampered bundle whose digest does not match manifest4
          return encodeTarGz([{ path: 'SKILL.md', data: Buffer.from('TAMPERED CONTENT', 'utf8') }]);
        }
        return fetchBundle(slug);
      },
      linkDirs,
      skipLinkDirs,
    });
    assert.ok(report4.error && report4.error.includes('摘要不匹配'));
    assert.notEqual(report4.digest, manifest4.digest);
    // Previous v2 copy in mirrorDir is completely preserved!
    assert.equal(readFileSync(join(mirrorDir, 'alpha', 'scripts', 'run.py'), 'utf8'), 'print("alpha2")');

    // 5. Removing skills prunes mirrorDir AND removes our managed junctions, while keeping user real dir & external junction untouched!
    rmSync(join(hostSkillsDir, 'beta'), { recursive: true, force: true });
    rmSync(join(hostSkillsDir, 'user-collision'), { recursive: true, force: true });
    rmSync(join(hostSkillsDir, 'ext-link-collision'), { recursive: true, force: true });
    // Restore alpha v2 so manifest matches cleanly
    writeHostSkill('alpha', 'Alpha v2', 'print("alpha2")');
    const manifest5 = buildManifest();
    assert.deepEqual(
      manifest5.items.map((i) => i.slug),
      ['alpha'],
    );

    fetched.length = 0;
    const report5 = await syncNodeSkills({
      mirrorDir,
      manifest: manifest5,
      fetchBundle,
      linkDirs,
      skipLinkDirs,
    });
    assert.equal(report5.error, undefined);
    assert.equal(report5.digest, manifest5.digest);
    assert.deepEqual(report5.synced, ['alpha']);
    assert.equal(fetched.length, 0);

    // Pruned from mirrorDir
    assert.equal(existsSync(join(mirrorDir, 'beta')), false);
    assert.equal(existsSync(join(mirrorDir, 'user-collision')), false);
    assert.equal(existsSync(join(mirrorDir, 'ext-link-collision')), false);

    // Managed junctions for removed skills deleted from executor dirs
    assert.equal(lstatSync(join(execClaudeDir, 'beta'), { throwIfNoEntry: false }), undefined);
    assert.equal(lstatSync(join(execCodexDir, 'beta'), { throwIfNoEntry: false }), undefined);
    assert.equal(lstatSync(join(execCodexDir, 'user-collision'), { throwIfNoEntry: false }), undefined);
    assert.equal(lstatSync(join(execCodexDir, 'ext-link-collision'), { throwIfNoEntry: false }), undefined);

    // User-owned real dir and external junction in execClaudeDir MUST still be completely intact!
    assert.equal(lstatSync(join(execClaudeDir, 'user-collision')).isSymbolicLink(), false);
    assert.equal(readFileSync(join(execClaudeDir, 'user-collision', 'SKILL.md'), 'utf8'), 'USER OWNED DO NOT TOUCH');
    assert.equal(lstatSync(join(execClaudeDir, 'ext-link-collision')).isSymbolicLink(), true);
    assert.equal(readFileSync(join(execClaudeDir, 'ext-link-collision', 'SKILL.md'), 'utf8'), 'EXTERNAL USER SKILL');
    // Still-active alpha junction remains intact
    assert.equal(lstatSync(join(execClaudeDir, 'alpha')).isSymbolicLink(), true);

    // 6. If the user replaces a previously managed junction with their own external junction,
    // subsequent sync MUST NOT overwrite or delete it (P1-3).
    const replacementExternal = join(root, 'replacement-external');
    mkdirSync(replacementExternal, { recursive: true });
    writeFileSync(join(replacementExternal, 'SKILL.md'), 'REPLACED BY USER', 'utf8');
    rmSync(join(execClaudeDir, 'alpha'), { force: true });
    symlinkSync(replacementExternal, join(execClaudeDir, 'alpha'), process.platform === 'win32' ? 'junction' : 'dir');

    const report6 = await syncNodeSkills({
      mirrorDir,
      manifest: manifest5,
      fetchBundle,
      linkDirs,
      skipLinkDirs,
    });
    assert.equal(report6.error, undefined);
    assert.equal(readFileSync(join(execClaudeDir, 'alpha', 'SKILL.md'), 'utf8'), 'REPLACED BY USER');
    assert.ok(report6.skipped?.some((entry) => entry.slug === 'alpha' && entry.reason.includes('其他链接')));
  });
});

test('decodeTarGz rejects Windows-illegal names, case-insensitive duplicates, and dangling PAX without EOF block', () => {
  const buildHeader = (name: string, size: number, typeFlag = '0'): Buffer => {
    const buf = Buffer.alloc(512);
    Buffer.from(name, 'utf8').copy(buf, 0, 0, 100);
    Buffer.from('0000644\0', 'ascii').copy(buf, 100);
    Buffer.from('0000000\0', 'ascii').copy(buf, 108);
    Buffer.from('0000000\0', 'ascii').copy(buf, 116);
    Buffer.from(`${size.toString(8).padStart(11, '0')}\0`, 'ascii').copy(buf, 124);
    Buffer.from('00000000000\0', 'ascii').copy(buf, 136);
    buf.fill(0x20, 148, 156);
    buf[156] = typeFlag.charCodeAt(0);
    Buffer.from('ustar\0', 'ascii').copy(buf, 257);
    Buffer.from('00', 'ascii').copy(buf, 263);
    let sum = 0;
    for (let i = 0; i < 512; i += 1) sum += buf[i]!;
    Buffer.from(`${sum.toString(8).padStart(6, '0')}\0 `, 'ascii').copy(buf, 148);
    return buf;
  };
  const pad512 = (b: Buffer): Buffer => {
    const rem = b.length % 512;
    return rem === 0 ? b : Buffer.concat([b, Buffer.alloc(512 - rem)]);
  };

  // Windows illegal character ':'
  const illegalTar = buildRawTarGzEntry({ name: 'bad:name.txt', data: Buffer.from('abc', 'utf8') });
  assert.throws(() => decodeTarGz(illegalTar), /forbidden character/i);

  // Case-insensitive duplicate paths
  const dupCaseTar = gzipSync(
    Buffer.concat([
      buildHeader('SKILL.md', 1, '0'),
      pad512(Buffer.from('A', 'utf8')),
      buildHeader('skill.md', 1, '0'),
      pad512(Buffer.from('B', 'utf8')),
      Buffer.alloc(1024),
    ]),
  );
  assert.throws(() => decodeTarGz(dupCaseTar), /Duplicate tar entry path/i);

  // Dangling PAX header at archive EOF (no trailing zero block)
  const paxPayload = Buffer.from('17 path=SKILL.md\n', 'utf8');
  const danglingPaxTar = gzipSync(
    Buffer.concat([
      buildHeader('PaxHeader/0', paxPayload.length, 'x'),
      pad512(paxPayload),
    ]),
  );
  assert.throws(() => decodeTarGz(danglingPaxTar), /dangling PAX header/i);
});

test('syncNodeSkills normalizes read-only 0o444 bundle files so Windows updates and pruning succeed', async (t) => {
  const root = makeTempDir(t);
  const mirrorDir = join(root, 'mirror');
  const filesV1 = [{ path: 'SKILL.md', data: Buffer.from('readonly v1', 'utf8'), mode: 0o444 }];
  const digestV1 = computeSkillBundleDigest(filesV1);
  const tarV1 = encodeTarGz(filesV1);
  const manifestV1 = {
    digest: computeManifestDigest([{ slug: 'ro-skill', digest: digestV1 }]),
    items: [{ slug: 'ro-skill', digest: digestV1, bytes: tarV1.length }],
  };

  const r1 = await syncNodeSkills({
    mirrorDir,
    manifest: manifestV1,
    fetchBundle: async () => tarV1,
  });
  assert.equal(r1.error, undefined);
  assert.equal(readFileSync(join(mirrorDir, 'ro-skill', 'SKILL.md'), 'utf8'), 'readonly v1');

  // Replace with v2 and then prune — neither may fail with EPERM on Windows
  const filesV2 = [{ path: 'SKILL.md', data: Buffer.from('readonly v2', 'utf8'), mode: 0o444 }];
  const digestV2 = computeSkillBundleDigest(filesV2);
  const tarV2 = encodeTarGz(filesV2);
  const manifestV2 = {
    digest: computeManifestDigest([{ slug: 'ro-skill', digest: digestV2 }]),
    items: [{ slug: 'ro-skill', digest: digestV2, bytes: tarV2.length }],
  };
  const r2 = await syncNodeSkills({
    mirrorDir,
    manifest: manifestV2,
    fetchBundle: async () => tarV2,
  });
  assert.equal(r2.error, undefined);
  assert.equal(readFileSync(join(mirrorDir, 'ro-skill', 'SKILL.md'), 'utf8'), 'readonly v2');

  const emptyManifest = { digest: computeManifestDigest([]), items: [] };
  const r3 = await syncNodeSkills({
    mirrorDir,
    manifest: emptyManifest,
    fetchBundle: async () => {
      throw new Error('should not fetch');
    },
  });
  assert.equal(r3.error, undefined);
  assert.equal(existsSync(join(mirrorDir, 'ro-skill')), false);
});

test('scanLocalNonMirrorSkills reports only non-mirror local skills metadata without leaking body or scripts', (t) => {
  const root = makeTempDir(t);
  const mirrorDir = join(root, 'mirror');
  const execDir = join(root, 'exec-skills');
  const externalSource = join(root, 'company-skills', 'corp-cluster');
  mkdirSync(join(mirrorDir, 'mirrored-skill'), { recursive: true });
  writeFileSync(join(mirrorDir, 'mirrored-skill', 'SKILL.md'), '---\nname: Mirrored\ndescription: From host\n---\nBody', 'utf8');

  mkdirSync(execDir, { recursive: true });
  // Host-mirrored junction -> MUST be excluded from local_skills
  symlinkSync(join(mirrorDir, 'mirrored-skill'), join(execDir, 'mirrored-skill'), dirLinkType());

  // Local real directory skill -> MUST be included (metadata only!)
  mkdirSync(join(execDir, 'local-real'), { recursive: true });
  writeFileSync(
    join(execDir, 'local-real', 'SKILL.md'),
    '---\nname: Local Real Skill\ndescription: |\n  Handles intranet tasks.\n  Second line.\n---\nSECRET_INTRANET_BODY_DO_NOT_LEAK\n',
    'utf8',
  );
  writeFileSync(join(execDir, 'local-real', 'secret.sh'), 'echo SECRET_SCRIPT', 'utf8');

  // External junction (e.g. shared demo-plugins) -> MUST be included (metadata only!)
  mkdirSync(externalSource, { recursive: true });
  writeFileSync(
    join(externalSource, 'SKILL.md'),
    '---\nname: corp-cluster\ndescription: "Manage company research cluster"\n---\nINTERNAL_CLUSTER_SECRET_URL\n',
    'utf8',
  );
  symlinkSync(externalSource, join(execDir, 'corp-cluster'), dirLinkType());

  const scanned = scanLocalNonMirrorSkills({ mirrorDir, linkDirs: [execDir] });
  assert.deepEqual(scanned, [
    { slug: 'corp-cluster', name: 'corp-cluster', description: 'Manage company research cluster' },
    { slug: 'local-real', name: 'Local Real Skill', description: 'Handles intranet tasks. Second line.' },
  ]);
  const serialized = JSON.stringify(scanned);
  assert.equal(serialized.includes('SECRET_INTRANET_BODY_DO_NOT_LEAK'), false);
  assert.equal(serialized.includes('INTERNAL_CLUSTER_SECRET_URL'), false);
  assert.equal(serialized.includes('SECRET_SCRIPT'), false);
});

test('syncNodeSkills reports explicit empty local_skills array when linkDirs are scanned and none found', async (t) => {
  const root = makeTempDir(t);
  const mirrorDir = join(root, 'mirror');
  const execDir = join(root, 'exec-skills');
  mkdirSync(execDir, { recursive: true });
  const manifest: NodeSkillsManifest = { digest: computeManifestDigest([]), items: [] };
  const scannedReport = await syncNodeSkills({
    mirrorDir,
    manifest,
    fetchBundle: async () => { throw new Error('unexpected fetch'); },
    linkDirs: [execDir],
  });
  assert.deepEqual(scannedReport.local_skills, []);
  const unscannedReport = await syncNodeSkills({
    mirrorDir,
    manifest,
    fetchBundle: async () => { throw new Error('unexpected fetch'); },
  });
  assert.equal('local_skills' in unscannedReport, false);
});
