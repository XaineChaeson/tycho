// Guards what each adapter declares about running a round read-only (docs/design/roles-and-
// tiers.md §5, §9 steps 4 and 6), against the recordings of docs/spike/readonly.md.
//
// What this file is here to catch:
//   - a read-only round started with arguments other than the ones measured to hold, or
//     declared at a layer it does not reach (Claude has no file-system layer);
//   - a read-only Claude round that takes away more than the tools that write files: the
//     shell, the web, MCP servers and connectors are the executor's own and stay;
//   - a read-only Codex round that carries the switch that runs commands outside the sandbox;
//   - an account's own permission mode loosening a read-only round;
//   - a probe that writes, spends quota, or reads "available" out of a failure: Codex's
//     sandbox that cannot start on the cluster, a help without the switch;
//   - dsh declaring a read-only way: its tier can replace or insert any plugin, so none holds;
//   - a dsh older than the one that knows --permission-mode taken for usable at all;
//   - a tier's text carrying a permission, sandbox or approval setting past the save.
import './guard.ts';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { claudeAdapter } from '../adapters/claude.ts';
import { codexAdapter } from '../adapters/codex.ts';
import { dshAdapter } from '../adapters/dsh.ts';
import type { Adapter, Turn } from '../adapters/types.ts';
import { compareVersions, tooOld } from '../adapters/version.ts';

const RO = join(import.meta.dirname, 'fixtures', 'readonly');
const json = (path: string): { argv: string[]; exit: number; changes?: string[] } => JSON.parse(readFileSync(join(RO, path), 'utf8'));
const text = (path: string): string => readFileSync(join(RO, path), 'utf8');
const BRIEF = '<brief>';

const turn = (tier: Turn['tier'], extra: Partial<Turn> = {}): Turn => ({ prompt: BRIEF, workdir: '/w', tier, readOnly: true, ...extra });

// The arguments a recording was started with, from the first option on: the command name
// differs from machine to machine (a .js shim, an Electron host), the options do not.
const optionsOf = (argv: readonly string[], first: string): string[] => argv.slice(argv.indexOf(first));
// The read-only runs were recorded before a round turned the executor's memory off; that switch
// has a recording of its own (tests/global-entry.test.ts) and is taken out to compare the rest.
const withoutMemoryOff = (argv: readonly string[]): string[] => {
  const at = argv.indexOf('--disable');
  return at >= 0 && argv[at + 1] === 'memories' ? [...argv.slice(0, at), ...argv.slice(at + 2)] : [...argv];
};

// The recordings were made with a profile for the tier; the tier now rides as -c lines, and
// what is compared is everything else on the command line.
const withoutTier = (argv: readonly string[]): string[] =>
  argv.flatMap((each, at) => (['--profile', '-c'].includes(each) || ['--profile', '-c'].includes(argv[at - 1]!) ? [] : [each]));

test('Codex：默认 danger-full-access 对齐其他执行器且支持 inherit-machine，只读走框架事后核对层', () => {
  const { argv } = codexAdapter.launch(turn({ kind: 'content', text: 'model=x\n' }));
  assert.deepEqual(argv, ['codex', 'exec', '--json', '-c', 'model=x', '-c', 'approval_policy="never"', '-c', 'sandbox_mode="danger-full-access"', '--skip-git-repo-check', '-C', '/w', BRIEF]);
  assert.ok(!argv.includes('--sandbox'));
  assert.ok(!argv.includes('--approve-for-me'));
  assert.ok(!argv.includes('--dangerously-bypass-approvals-and-sandbox'));
  const writable = codexAdapter.launch(turn({ kind: 'content', text: 'model=x\n' }, { readOnly: false })).argv;
  assert.ok(writable.includes('approval_policy="never"'));
  assert.ok(writable.includes('sandbox_mode="danger-full-access"'));
  assert.ok(!writable.includes('--approve-for-me'));
  assert.ok(!writable.includes('--sandbox'));
  assert.ok(!writable.includes('read-only') && !writable.includes('--dangerously-bypass-approvals-and-sandbox'));
  assert.ok(!writable.some((each) => each.startsWith('windows')), '不替机器选 Windows 沙箱');
  assert.deepEqual(codexAdapter.readOnly?.layer, 'contract');
  assert.deepEqual(codexAdapter.readOnly?.args, ['-c', 'approval_policy="never"']);
});

test('Claude：不叠加 --disallowedTools 或额外沙箱束缚，只读与可写均开放交付目录并走框架事后核对', () => {
  const tier = { kind: 'content', text: '{"model":"m"}' } as const;
  const { argv, env } = claudeAdapter.launch(turn(tier, { workdir: '/w', tierPath: '/t.json', artifactsDir: '/art' }));
  assert.deepEqual(env, { IS_SANDBOX: '1' });
  assert.ok(!argv.includes('--disallowedTools'), '不在原生 Claude 上叠加工具禁写束缚');
  assert.ok(!argv.includes('--tools') && !argv.includes('--strict-mcp-config'), '不收窄工具集，也不关掉 MCP');
  assert.ok(argv.includes('/art'), '只读轮次同样开放交付目录，用于写报告或产物');
  assert.equal(claudeAdapter.readOnly, undefined, '走框架默认 contract 事后核对层');
  const plan = claudeAdapter.launch(turn(tier, { permissionMode: 'plan', tierPath: '/t.json' })).argv;
  assert.equal(plan[plan.indexOf('--permission-mode') + 1], 'plan');
  const writable = claudeAdapter.launch(turn(tier, { readOnly: false, tierPath: '/t.json', artifactsDir: '/art' })).argv;
  assert.ok(writable.includes('/art'), '可写轮次照常附带交付目录');
});

test('dsh 与 gemini 均继承框架默认只读（contract 事后核对层），按原生模式启动且不设最低版本阻断', () => {
  assert.equal(dshAdapter.readOnly, undefined);
  const { argv } = dshAdapter.launch({ prompt: BRIEF, workdir: '/w', tier: { kind: 'content', text: '- model: m\n' }, tierPath: '/t.yml', permissionMode: 'workspace-write' });
  assert.equal(argv[argv.indexOf('--permission-mode') + 1], 'workspace-write');
  assert.equal(argv.filter((each) => each === '--patch').length, 1, '只有档位那一层补丁');
  assert.equal(dshAdapter.minVersion, undefined);
});

test('所有内置适配器均不强制额外只读探针，避免触发外部沙箱或额外子进程开销', () => {
  assert.equal(codexAdapter.readOnly?.probe, undefined);
  assert.equal(claudeAdapter.readOnly, undefined);
  assert.equal(dshAdapter.readOnly, undefined);
});

test('版本号比较工具保持可用，所有内置适配器均不设 minVersion 阻断', () => {
  const min = { version: '0.2.2-rc.1', lacks: '不认 --permission-mode' };
  assert.equal(text('probe/dsh-0.2.2-rc.1-win.version.stdout.txt').trim(), '0.2.2-rc.1');
  assert.equal(tooOld(min, '0.2.2-rc.1'), undefined);
  assert.equal(tooOld(min, '0.2.2'), undefined);
  assert.equal(tooOld(min, 'dsh 0.3.0'), undefined);
  assert.equal(tooOld(min, '0.2.1-rc.5'), '这一版用不了：不认 --permission-mode，升到 0.2.2-rc.1 以上');
  assert.equal(tooOld(min, '0.2.2-rc.0'), '这一版用不了：不认 --permission-mode，升到 0.2.2-rc.1 以上');
  assert.equal(tooOld(min, 'unknown'), undefined);
  const old = json('dsh/dsh-adapter-linux.fs.json');
  assert.equal(old.exit, 1);
  assert.match(text('dsh/dsh-adapter-linux.ndjson'), /unknown option '--permission-mode'/);
  assert.ok(compareVersions('0.2.2-rc.1', '0.2.2-rc.10') < 0);
  assert.ok(compareVersions('1.0.0', '0.9.9') > 0);
  assert.equal(dshAdapter.minVersion, undefined);
  assert.equal(codexAdapter.minVersion, undefined);
  assert.equal(claudeAdapter.minVersion, undefined);
});

test('档位内容放开原生权限/沙箱/审批键透传，只保留格式校验', () => {
  const claude = (body: unknown) => claudeAdapter.checkTier!({ kind: 'content', text: JSON.stringify(body) });
  assert.equal(claude({ model: 'm' }), undefined);
  assert.equal(claude({ model: 'm', permissions: { defaultMode: 'plan' } }), undefined);
  assert.equal(claude({ sandbox: { enabled: false } }), undefined);

  const codex = (body: string) => codexAdapter.checkTier!({ kind: 'content', text: body });
  assert.equal(codex('model=x\nmodel_reasoning_effort=high\n'), undefined);
  for (const key of ['sandbox_mode', 'approval_policy', 'sandbox_workspace_write.network_access', 'profiles.p.sandbox_mode', ' sandbox_permissions ', 'windows.sandbox']) {
    assert.equal(codex(`model=x\n${key}=1\n`), undefined, key);
  }
  assert.equal(codex('model=x\nwindows.sandbox="elevated"\n'), undefined);
  assert.equal(codex('model=x\nwindows={sandbox="elevated"}\n'), undefined);

  const dsh = (body: string) => dshAdapter.checkTier!({ kind: 'content', text: body });
  assert.equal(dsh('- id: agent-default-model\n  config:\n    model: m\n'), undefined);
  for (const id of ['sandbox-policy', 'approval', 'permission', 'sandbox', 'bash-sandbox', 'pwsh-sandbox']) {
    assert.equal(dsh(`- id: agent-default-model\n  config:\n    model: m\n- id: ${id}\n  config:\n    mode: danger-full-access\n`), undefined, id);
  }
  assert.equal(dsh(text('dsh/readonly.patch.linux.yml')), undefined);
});

test('gemini offers no native readOnly way and declares no minVersion blocker', async () => {
  const { geminiAdapter } = await import('../adapters/gemini.ts');
  assert.equal(geminiAdapter.readOnly, undefined);
  assert.equal(geminiAdapter.minVersion, undefined);
});
