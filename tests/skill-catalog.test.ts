import './guard.ts';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { describe, test, type TestContext } from 'node:test';
import { DEFAULT_SKILL_BINDING, type SkillRegistryMap } from '../shared/skill-catalog.ts';
import { InputError } from '../service/errors.ts';
import { bytes, DEFAULT_KNOWLEDGE_LIMITS, type Entry, type KnowledgeLimits } from '../service/knowledge.ts';
import { briefSections, givenAll, knowledgeOverLimit } from '../service/knowledge-brief.ts';
import {
  applicableDirectorySkills,
  buildEffectiveContext,
  materializeLedgerEntry,
  MAX_SKILL_FILE_BYTES,
  parseSkillMarkdown,
  parseSkillRegistry,
  revisionForDirectorySkill,
  revisionFromHash,
  scanSkillDirectory,
  slugForLedgerEntry,
  syncManagedSkills,
  validateSkillBinding,
} from '../service/skill-catalog.ts';

function makeTempDir(t: TestContext, prefix = 'tycho-skill-catalog-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

const dirLinkType = (): 'junction' | 'dir' => (process.platform === 'win32' ? 'junction' : 'dir');

function makeLedgerEntry(overrides: Partial<Entry> = {}): Entry {
  return {
    id: 'k_01JXYZ000001',
    revision: 1,
    kind: 'knowledge',
    title: '测试条目',
    when_to_use: '需要测试时',
    body: '这是条目正文。',
    project_ids: null,
    loading: 'resident',
    roles: [],
    proposal_id: 'prop-1',
    published_by: 'owner',
    published_at: '2026-01-01T00:00:00.000Z',
    reviewed_at: '2026-01-01T00:00:00.000Z',
    created_at: '2026-01-01T00:00:00.000Z',
    state: 'active',
    retired_at: null,
    retired_by: null,
    retired_reason: null,
    replaced_by: null,
    ...overrides,
  };
}

describe('parseSkillMarkdown', () => {
  test('parses single-line unquoted and quoted frontmatter fields', () => {
    const raw = [
      '---',
      'name: "deploy: \\"prod\\" helper"',
      "description: 'Use when it''s release day'",
      '---',
      '',
      '# Steps',
      'Run the checklist.',
    ].join('\n');

    const parsed = parseSkillMarkdown(raw, 'fallback');
    assert.equal(parsed.name, 'deploy: "prod" helper');
    assert.equal(parsed.description, "Use when it's release day");
    assert.equal(parsed.body, '# Steps\nRun the checklist.');
    assert.equal(parsed.managedLedgerId, null);
  });

  test('parses YAML folded (>- / >) and literal (| / |-) multiline descriptions', () => {
    const folded = [
      '---',
      'name: release-skill',
      'description: >-',
      '  First line of folded',
      '  description text.',
      '',
      '  Second paragraph.',
      'license: MIT',
      '---',
      'Body content here.',
    ].join('\r\n');

    const parsedFolded = parseSkillMarkdown(folded, 'fallback');
    assert.equal(parsedFolded.name, 'release-skill');
    assert.equal(parsedFolded.description, 'First line of folded description text.\nSecond paragraph.');
    assert.equal(parsedFolded.body, 'Body content here.');

    const literal = [
      '---',
      'name: lit-skill',
      'description: |-',
      '  Line one',
      '  Line two',
      '---',
      'Body.',
    ].join('\n');

    const parsedLiteral = parseSkillMarkdown(literal, 'fallback');
    assert.equal(parsedLiteral.name, 'lit-skill');
    assert.equal(parsedLiteral.description, 'Line one\nLine two');
  });

  test('falls back to fallbackName and first prose line (clipped to 300 chars) when no frontmatter', () => {
    const longProse = '甲'.repeat(350);
    const raw = `\uFEFF# Heading Only\n\n${longProse}\n\n---\nMore text`;
    const parsed = parseSkillMarkdown(raw, 'my-skill');
    assert.equal(parsed.name, 'my-skill');
    assert.equal(parsed.description.length, 300);
    assert.equal(parsed.description, `${'甲'.repeat(299)}…`);
    assert.equal(parsed.managedLedgerId, null);

    const headingOnly = '# Only Heading\n## Subheading';
    const parsedHeadingOnly = parseSkillMarkdown(headingOnly, 'only-heading');
    assert.equal(parsedHeadingOnly.name, 'only-heading');
    assert.equal(parsedHeadingOnly.description, 'only-heading');
  });

  test('detects and strips tycho-ledger ownership marker only at file head or body head, ignoring YAML descriptions and prose', () => {
    const bodyTop = [
      '---',
      'name: "Managed Skill"',
      'description: "From ledger"',
      '---',
      '<!-- tycho-ledger: 01JABCDEF123@4 -->',
      '',
      '## 按什么顺序',
      '1. 执行构建',
    ].join('\n');

    const parsed1 = parseSkillMarkdown(bodyTop, 'managed');
    assert.equal(parsed1.managedLedgerId, '01JABCDEF123');
    assert.equal(parsed1.body, '## 按什么顺序\n1. 执行构建');

    const fileTop = [
      '<!-- tycho-ledger: k_top_99@2 -->',
      '---',
      'name: top-skill',
      '---',
      'Actual body.',
    ].join('\n');
    const parsed2 = parseSkillMarkdown(fileTop, 'top');
    assert.equal(parsed2.managedLedgerId, 'k_top_99');
    assert.equal(parsed2.body, 'Actual body.');

    // Mentioning the marker format inside YAML description or documentation prose must NOT mark it managed.
    const yamlDescMention = [
      '---',
      'name: yaml-docs-skill',
      'description: |',
      '  Explains <!-- tycho-ledger: fake-fm@1 --> format.',
      '---',
      'Body.',
    ].join('\n');
    assert.equal(parseSkillMarkdown(yamlDescMention, 'yaml-docs').managedLedgerId, null);

    const docMention = [
      '---',
      'name: docs-skill',
      'description: Explains marker format',
      '---',
      '# Docs',
      'Example marker:',
      '<!-- tycho-ledger: fake-id@1 -->',
    ].join('\n');
    const parsed3 = parseSkillMarkdown(docMention, 'docs');
    assert.equal(parsed3.managedLedgerId, null);
  });

  test('revisionForDirectorySkill changes when loading switches between on_demand and resident', () => {
    const revOnDemand = revisionForDirectorySkill('abcdef123456', 'on_demand');
    const revResident = revisionForDirectorySkill('abcdef123456', 'resident');
    assert.notEqual(revOnDemand, revResident);
  });
});

describe('scanSkillDirectory', () => {
  test('returns empty scan without throwing when skillsDir does not exist', (t) => {
    const root = makeTempDir(t);
    const missing = join(root, 'does-not-exist');
    const scan = scanSkillDirectory(missing, {});
    assert.deepEqual(scan, { dir: missing, skills: [], ignored: [] });
  });

  test('scans real dirs and directory junctions, ignores legacy folders, broken junctions, and oversized files', (t) => {
    const root = makeTempDir(t);
    const skillsDir = join(root, 'skills');
    const externalDir = join(root, 'external-skill');
    const tempBrokenTarget = join(root, 'will-delete');
    mkdirSync(skillsDir, { recursive: true });
    mkdirSync(externalDir, { recursive: true });
    mkdirSync(tempBrokenTarget, { recursive: true });

    // 1. Standard real skill dir with sibling scripts/ (which must not be counted in bytes)
    const alphaDir = join(skillsDir, 'alpha-tool');
    mkdirSync(join(alphaDir, 'scripts'), { recursive: true });
    const alphaRaw = '---\nname: Alpha Tool\ndescription: Run alpha checks\n---\nAlpha body 中文\n';
    writeFileSync(join(alphaDir, 'SKILL.md'), alphaRaw, 'utf8');
    writeFileSync(join(alphaDir, 'scripts', 'big.sh'), 'x'.repeat(10000), 'utf8');

    // 2. Directory Junction (Windows) / symlink (POSIX) pointing to external skill
    writeFileSync(join(externalDir, 'SKILL.md'), '---\nname: Mounted Skill\ndescription: Via junction\n---\nMounted body\n', 'utf8');
    symlinkSync(externalDir, join(skillsDir, 'mounted-skill'), dirLinkType());

    // 3. Broken Directory Junction
    symlinkSync(tempBrokenTarget, join(skillsDir, 'broken-link'), dirLinkType());
    rmSync(tempBrokenTarget, { recursive: true, force: true });

    // 4. Legacy folder without SKILL.md (e.g. tycho/release.md)
    mkdirSync(join(skillsDir, 'tycho'), { recursive: true });
    writeFileSync(join(skillsDir, 'tycho', 'release.md'), '# Legacy release doc', 'utf8');

    // 5. Top-level .md file (ignored with reason) and plain .txt file (silently skipped)
    writeFileSync(join(skillsDir, 'stray.md'), '# Stray', 'utf8');
    writeFileSync(join(skillsDir, 'notes.txt'), 'ignored silently', 'utf8');

    // 6. Hidden dot-directory (silently skipped)
    mkdirSync(join(skillsDir, '.trash'), { recursive: true });
    writeFileSync(join(skillsDir, '.trash', 'SKILL.md'), '# Deleted', 'utf8');

    // 7. Oversized SKILL.md (> 256 KiB)
    mkdirSync(join(skillsDir, 'huge-skill'), { recursive: true });
    writeFileSync(join(skillsDir, 'huge-skill', 'SKILL.md'), 'a'.repeat(MAX_SKILL_FILE_BYTES + 10), 'utf8');

    const registry: SkillRegistryMap = {
      'mounted-skill': { enabled: true, loading: 'resident', project_ids: ['p1'], roles: ['implement'], machine_ids: null },
    };

    const scan = scanSkillDirectory(skillsDir, registry);
    assert.equal(scan.dir, skillsDir);
    assert.equal(scan.skills.length, 2);

    const alpha = scan.skills.find((s) => s.slug === 'alpha-tool')!;
    assert.ok(alpha);
    assert.equal(alpha.id, 'dir-alpha-tool');
    assert.equal(alpha.name, 'Alpha Tool');
    assert.equal(alpha.description, 'Run alpha checks');
    assert.equal(alpha.body, 'Alpha body 中文');
    assert.equal(alpha.bytes, bytes('Alpha body 中文'));
    assert.equal(alpha.sha256.length, 12);
    assert.equal(alpha.rel_path, 'skills/alpha-tool/SKILL.md');
    assert.deepEqual(alpha.binding, DEFAULT_SKILL_BINDING);
    assert.equal(alpha.managed_ledger_id, null);

    // Deterministic sha256 across scans
    const scan2 = scanSkillDirectory(skillsDir, registry);
    assert.equal(scan2.skills.find((s) => s.slug === 'alpha-tool')!.sha256, alpha.sha256);

    const mounted = scan.skills.find((s) => s.slug === 'mounted-skill')!;
    assert.ok(mounted);
    assert.equal(mounted.id, 'dir-mounted-skill');
    assert.equal(mounted.name, 'Mounted Skill');
    assert.equal(mounted.body, 'Mounted body');
    assert.deepEqual(mounted.binding, registry['mounted-skill']);

    // Check ignored reasons
    const ignoredMap = new Map(scan.ignored.map((item) => [item.name, item.reason]));
    assert.equal(ignoredMap.get('broken-link'), '链接目标不存在或无法读取');
    assert.equal(ignoredMap.get('tycho'), '目录内缺少 SKILL.md（已忽略）');
    assert.equal(ignoredMap.get('stray.md'), '非标准技能目录（需为 <技能名>/SKILL.md）');
    assert.ok(ignoredMap.get('huge-skill')?.includes('256 KiB'));
    assert.equal(ignoredMap.has('notes.txt'), false);
    assert.equal(ignoredMap.has('.trash'), false);
  });
});

describe('registry validation & applicableDirectorySkills', () => {
  test('parseSkillRegistry tolerates malformed inputs and normalizes entries', () => {
    assert.deepEqual(parseSkillRegistry(null), {});
    assert.deepEqual(parseSkillRegistry(undefined), {});
    assert.deepEqual(parseSkillRegistry(['bad']), {});

    const parsed = parseSkillRegistry({
      good: { enabled: false, loading: 'resident', project_ids: ['p2', 'p1', 'p2'], roles: ['review', 'implement', 'review'] },
      partial: { enabled: 'not-bool', loading: 'unknown', project_ids: [], roles: null },
      '../escape': { enabled: true, loading: 'on_demand', project_ids: null, roles: [] },
      badVal: 'string',
    });
    assert.deepEqual(parsed.good, { enabled: false, loading: 'resident', project_ids: ['p1', 'p2'], roles: ['implement', 'review'], machine_ids: null });
    assert.deepEqual(parsed.partial, DEFAULT_SKILL_BINDING);
    assert.equal(Object.hasOwn(parsed, '../escape'), false);
    assert.equal(Object.hasOwn(parsed, 'badVal'), false);
  });

  test('validateSkillBinding validates fields, deduplicates IDs, and throws InputError on invalid input', () => {
    const projects = ['p1', 'p2'];
    const roles = ['implement', 'review'];
    const machines = ['work-pc', 'home-linux'];

    const valid = validateSkillBinding(
      { enabled: true, loading: 'resident', project_ids: ['p2', 'p1', 'p2'], roles: ['review', 'implement', 'review'], machine_ids: ['work-pc', 'work-pc'] },
      projects,
      roles,
      machines,
    );
    assert.deepEqual(valid, { enabled: true, loading: 'resident', project_ids: ['p1', 'p2'], roles: ['implement', 'review'], machine_ids: ['work-pc'] });

    const validGlobal = validateSkillBinding(
      { enabled: false, loading: 'on_demand', project_ids: null, roles: [] },
      projects,
      roles,
      machines,
    );
    assert.deepEqual(validGlobal, { enabled: false, loading: 'on_demand', project_ids: null, roles: [], machine_ids: null });

    assert.throws(() => validateSkillBinding(null, projects, roles, machines), InputError);
    assert.throws(() => validateSkillBinding({ enabled: 'yes', loading: 'on_demand', project_ids: null, roles: [] }, projects, roles, machines), InputError);
    assert.throws(() => validateSkillBinding({ enabled: true, loading: 'eager', project_ids: null, roles: [] }, projects, roles, machines), InputError);
    assert.throws(() => validateSkillBinding({ enabled: true, loading: 'on_demand', project_ids: [], roles: [] }, projects, roles, machines), InputError);
    assert.throws(() => validateSkillBinding({ enabled: true, loading: 'on_demand', project_ids: ['p999'], roles: [] }, projects, roles, machines), InputError);
    assert.throws(() => validateSkillBinding({ enabled: true, loading: 'on_demand', project_ids: null, roles: ['unknown-role'] }, projects, roles, machines), InputError);
    assert.throws(() => validateSkillBinding({ enabled: true, loading: 'on_demand', project_ids: null, roles: [], machine_ids: [] }, projects, roles, machines), InputError);
    assert.throws(() => validateSkillBinding({ enabled: true, loading: 'on_demand', project_ids: null, roles: [], machine_ids: ['missing-box'] }, projects, roles, machines), InputError);
  });

  test('applicableDirectorySkills filters by scope, enabled, managed marker, sorts deterministically, and tracks content edits via revision', (t) => {
    const root = makeTempDir(t);
    const skillsDir = join(root, 'skills');
    const writeSkill = (slug: string, content: string) => {
      mkdirSync(join(skillsDir, slug), { recursive: true });
      writeFileSync(join(skillsDir, slug, 'SKILL.md'), content, 'utf8');
    };

    writeSkill('global-any', '---\nname: Global Any\ndescription: Always\n---\nBody G1\n');
    writeSkill('global-review', '---\nname: Global Review\ndescription: For review\n---\nBody G2\n');
    writeSkill('proj-any', '---\nname: Proj Any\ndescription: For p1\n---\nBody P1\n');
    writeSkill('proj-impl', '---\nname: Proj Impl\ndescription: For p1 impl\n---\nBody P2\n');
    writeSkill('disabled-one', '---\nname: Disabled\ndescription: Off\n---\nBody D\n');
    writeSkill('ledger-copy', '---\nname: Ledger Copy\ndescription: Managed\n---\n<!-- tycho-ledger: k_1@3 -->\n\nBody L\n');

    const registry: SkillRegistryMap = {
      'global-review': { enabled: true, loading: 'resident', project_ids: null, roles: ['review'], machine_ids: null },
      'proj-any': { enabled: true, loading: 'on_demand', project_ids: ['p1'], roles: [], machine_ids: null },
      'proj-impl': { enabled: true, loading: 'resident', project_ids: ['p1'], roles: ['implement'], machine_ids: null },
      'disabled-one': { enabled: false, loading: 'on_demand', project_ids: null, roles: [], machine_ids: null },
    };

    // For project p1 + role implement: global-any, proj-any, proj-impl (in exact rank order)
    const p1Impl = applicableDirectorySkills(skillsDir, registry, 'p1', 'implement');
    assert.deepEqual(
      p1Impl.map((e) => e.id),
      ['dir-global-any', 'dir-proj-any', 'dir-proj-impl'],
    );
    assert.equal(p1Impl[0]!.loading, 'on_demand');
    assert.equal(p1Impl[2]!.loading, 'resident');
    assert.equal(p1Impl[0]!.kind, 'skill');

    // For project p2 + role review: global-any, global-review
    const p2Review = applicableDirectorySkills(skillsDir, registry, 'p2', 'review');
    assert.deepEqual(
      p2Review.map((e) => e.id),
      ['dir-global-any', 'dir-global-review'],
    );

    // For null project + null role: only global-any (no project-scoped or role-scoped skills)
    const globalOnly = applicableDirectorySkills(skillsDir, registry, null, null);
    assert.deepEqual(globalOnly.map((e) => e.id), ['dir-global-any']);

    // Revision is deterministic while unchanged, and changes when SKILL.md is edited on disk
    const revBefore = p1Impl[0]!.revision;
    assert.ok(Number.isInteger(revBefore) && revBefore > 0);
    assert.equal(applicableDirectorySkills(skillsDir, registry, 'p1', 'implement')[0]!.revision, revBefore);

    writeSkill('global-any', '---\nname: Global Any\ndescription: Always\n---\nBody G1 updated!\n');
    const revAfter = applicableDirectorySkills(skillsDir, registry, 'p1', 'implement')[0]!.revision;
    assert.notEqual(revAfter, revBefore);
    assert.equal(revisionFromHash('0000000abcdef'), 1);
  });
});

describe('materializeLedgerEntry & syncManagedSkills', () => {
  test('slugForLedgerEntry handles ASCII, Chinese titles, and Windows reserved names', () => {
    assert.equal(slugForLedgerEntry('Deploy Production Checklist', '01JXYZ987654'), 'deploy-production-checklist');
    assert.equal(slugForLedgerEntry('发布流程核对', '01JXYZ987654'), 'tycho-k-987654');
    assert.equal(slugForLedgerEntry('CON', '01JXYZ987654'), 'tycho-k-987654');
  });

  test('creates, updates on new revision, refuses to overwrite user/junction dirs, and removes on retired', (t) => {
    const root = makeTempDir(t);
    const skillsDir = join(root, 'skills');
    const externalDir = join(root, 'external-deploy');
    mkdirSync(skillsDir, { recursive: true });
    mkdirSync(externalDir, { recursive: true });

    // Pre-existing user-owned skill dir and mounted junction that collide with ledger titles
    mkdirSync(join(skillsDir, 'user-owned'), { recursive: true });
    writeFileSync(join(skillsDir, 'user-owned', 'SKILL.md'), '---\nname: User Owned\n---\nDo not overwrite me!\n', 'utf8');

    writeFileSync(join(externalDir, 'SKILL.md'), '---\nname: Junction Skill\n---\nMounted content!\n', 'utf8');
    symlinkSync(externalDir, join(skillsDir, 'mounted-deploy'), dirLinkType());

    // 1. Fresh active entry -> creates clean dir with standard SKILL.md
    const e1 = makeLedgerEntry({
      id: '01JLEDGERAAA111',
      revision: 1,
      kind: 'skill',
      title: 'Release Flow',
      when_to_use: 'When releasing "v2": verify first',
      body: '## 步骤\n1. 跑测试',
      state: 'active',
    });
    const res1 = materializeLedgerEntry(skillsDir, e1);
    assert.equal(res1.skippedReason, undefined);
    assert.equal(basename(dirname(res1.path)), 'release-flow');
    const parsed1 = parseSkillMarkdown(readFileSync(res1.path, 'utf8'), 'fallback');
    assert.equal(parsed1.name, e1.title);
    assert.equal(parsed1.description, e1.when_to_use);
    assert.equal(parsed1.body, e1.body);
    assert.equal(parsed1.managedLedgerId, e1.id);
    // No leftover temp files in directory
    assert.deepEqual(readdirSync(dirname(res1.path)), ['SKILL.md']);

    // 2. Update to revision 2 -> reuses same managed dir atomically
    const res1v2 = materializeLedgerEntry(skillsDir, { ...e1, revision: 2, body: '## 步骤\n1. 跑测试\n2. 发包' });
    assert.equal(res1v2.path, res1.path);
    assert.match(readFileSync(res1v2.path, 'utf8'), /<!-- tycho-ledger: 01JLEDGERAAA111@2 -->/);
    assert.equal(parseSkillMarkdown(readFileSync(res1v2.path, 'utf8'), 'fallback').body, '## 步骤\n1. 跑测试\n2. 发包');

    // 3. Collision with non-managed user directory -> writes to suffixed directory, leaves user dir untouched
    const eUserCollide = makeLedgerEntry({
      id: '01JLEDGERBBB222',
      revision: 1,
      kind: 'skill',
      title: 'User Owned',
      when_to_use: 'From ledger',
      body: 'Ledger body',
      state: 'active',
    });
    const resUser = materializeLedgerEntry(skillsDir, eUserCollide);
    assert.equal(basename(dirname(resUser.path)), 'user-owned-bbb222');
    assert.equal(readFileSync(join(skillsDir, 'user-owned', 'SKILL.md'), 'utf8'), '---\nname: User Owned\n---\nDo not overwrite me!\n');

    // 4. Collision with Directory Junction -> writes to suffixed directory, leaves junction untouched
    const eJuncCollide = makeLedgerEntry({
      id: '01JLEDGERCCC333',
      revision: 1,
      kind: 'skill',
      title: 'Mounted Deploy',
      when_to_use: 'From ledger',
      body: 'Ledger deploy body',
      state: 'active',
    });
    const resJunc = materializeLedgerEntry(skillsDir, eJuncCollide);
    assert.equal(basename(dirname(resJunc.path)), 'mounted-deploy-ccc333');
    assert.equal(lstatSync(join(skillsDir, 'mounted-deploy')).isSymbolicLink(), true);
    assert.equal(readFileSync(join(externalDir, 'SKILL.md'), 'utf8'), '---\nname: Junction Skill\n---\nMounted content!\n');

    // 5. Retire e1 and eJuncCollide -> removes ONLY managed directories; user & junction remain intact
    const retired1 = materializeLedgerEntry(skillsDir, { ...e1, state: 'retired' });
    assert.equal(retired1.skippedReason, undefined);
    assert.equal(existsSync(dirname(res1.path)), false);

    syncManagedSkills(skillsDir, [{ ...eJuncCollide, state: 'retired' }]);
    assert.equal(existsSync(dirname(resJunc.path)), false);
    assert.equal(lstatSync(join(skillsDir, 'mounted-deploy')).isSymbolicLink(), true);
    assert.equal(existsSync(join(skillsDir, 'user-owned', 'SKILL.md')), true);
  });
});

describe('buildEffectiveContext', () => {
  test('matches briefSections, givenAll, and knowledgeOverLimit exactly for mixed ledger and directory entries', () => {
    const residentKnowledge = makeLedgerEntry({
      id: 'k_res_1',
      revision: 2,
      kind: 'knowledge',
      title: '全局规范',
      when_to_use: '每轮遵守',
      body: '所有改动必须附带测试。',
      project_ids: null,
      loading: 'resident',
      roles: [],
    });
    const onDemandKnowledge = makeLedgerEntry({
      id: 'k_od_1',
      revision: 1,
      kind: 'knowledge',
      title: '数据库迁移',
      when_to_use: '改 schema 时',
      body: '迁移脚本必须向前兼容。',
      project_ids: ['p1'],
      loading: 'on_demand',
      roles: ['implement'],
    });
    const ledgerSkill = makeLedgerEntry({
      id: 'k_skill_1',
      revision: 3,
      kind: 'skill',
      title: '账本技能',
      when_to_use: '构建前',
      body: '## 按什么顺序\n1. npm run typecheck',
      project_ids: ['p1'],
      loading: 'on_demand',
      roles: [],
    });
    const dirOnDemandSkill = makeLedgerEntry({
      id: 'dir-deploy-check',
      revision: 123456,
      kind: 'skill',
      title: 'Deploy Check',
      when_to_use: '部署前检查',
      body: 'Check staging health endpoint.',
      project_ids: null,
      loading: 'on_demand',
      roles: [],
    });
    const dirResidentSkill = makeLedgerEntry({
      id: 'dir-always-on',
      revision: 654321,
      kind: 'skill',
      title: 'Always On Skill',
      when_to_use: '始终生效',
      body: 'Always verify lockfile integrity.',
      project_ids: null,
      loading: 'resident',
      roles: [],
    });

    const entries = [residentKnowledge, onDemandKnowledge, ledgerSkill, dirOnDemandSkill, dirResidentSkill];
    const project = { id: 'p1', name: 'Tycho' };
    const role = { id: 'implement', name: '实现' };

    const report = buildEffectiveContext({
      entries,
      project,
      role,
      limits: DEFAULT_KNOWLEDGE_LIMITS,
      named: ['k_skill_1'],
    });

    assert.equal(report.project_id, 'p1');
    assert.equal(report.project_name, 'Tycho');
    assert.equal(report.role_id, 'implement');
    assert.equal(report.role_name, '实现');

    // Resident bucket: residentKnowledge, task-named ledgerSkill, and resident directory skill
    assert.deepEqual(
      report.resident.map((item) => ({ id: item.id, origin: item.origin, slug: item.slug, revision: item.revision })),
      [
        { id: 'k_res_1', origin: 'ledger', slug: null, revision: 2 },
        { id: 'k_skill_1', origin: 'ledger', slug: null, revision: 3 },
        { id: 'dir-always-on', origin: 'directory', slug: 'always-on', revision: null },
      ],
    );

    // On-demand bucket: onDemandKnowledge and on-demand directory skill
    assert.deepEqual(
      report.on_demand.map((item) => ({ id: item.id, origin: item.origin, slug: item.slug, revision: item.revision })),
      [
        { id: 'k_od_1', origin: 'ledger', slug: null, revision: 1 },
        { id: 'dir-deploy-check', origin: 'directory', slug: 'deploy-check', revision: null },
      ],
    );

    // Verify single-source-of-truth parity with knowledge-brief.ts
    const expectedNamed = ['k_skill_1', 'dir-always-on'];
    const expectedSections = briefSections(entries, project.name, expectedNamed);
    const expectedGiven = givenAll(entries, expectedNamed);
    const expectedSnapshotBytes = expectedGiven.reduce((sum, g) => sum + (g.text === undefined ? 0 : bytes(g.text)), 0);

    assert.equal(report.budget.brief_bytes, bytes(expectedSections));
    assert.equal(report.budget.brief_limit_bytes, DEFAULT_KNOWLEDGE_LIMITS.briefBytes);
    assert.equal(report.budget.snapshot_bytes, expectedSnapshotBytes);
    assert.equal(report.budget.snapshot_limit_bytes, DEFAULT_KNOWLEDGE_LIMITS.snapshotBytes);
    assert.equal(report.budget.over_limit, null);

    // Tight brief limit triggers exact knowledgeOverLimit message
    const tightLimits: KnowledgeLimits = {
      ...DEFAULT_KNOWLEDGE_LIMITS,
      briefBytes: 100,
    };
    const overReport = buildEffectiveContext({
      entries,
      project,
      role,
      limits: tightLimits,
      named: ['k_skill_1'],
    });
    const expectedOver = knowledgeOverLimit(entries, expectedSections, tightLimits, undefined, expectedNamed);
    assert.ok(overReport.budget.over_limit !== null);
    assert.equal(overReport.budget.over_limit, expectedOver);
  });
});
