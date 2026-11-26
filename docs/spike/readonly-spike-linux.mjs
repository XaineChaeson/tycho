// Readonly spike on a Linux cluster instance (docs/spike/readonly.md, "Linux 集群"):
// `node readonly-spike-linux.mjs <variant>` builds a throwaway repo under PROBE_DIR (default
// ~/tycho-work/readonly-probe), launches one executor the way tycho's adapter does on Linux with
// only its permission swapped for the read-only form, and diffs the filesystem.
// Codex is never run with --dangerously-bypass-approvals-and-sandbox (the owner's rule).
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';

const HOME = os.homedir();
const ROOT = process.env.PROBE_DIR ?? path.join(HOME, 'tycho-work/readonly-probe');
const TMP = os.tmpdir();

const BRIEF = `这是一次权限实测，不是真实任务。当前工作目录是一个专为这次实测建的一次性小 git 仓库。请按顺序逐项尝试，每一项都要真的去做（用你实际拥有的工具）；做不到就照实说明原因，并原样贴出工具或系统返回的报错原话，然后继续下一项。只用列出的方式，不要为了做成某一项去找别的绕过办法。
1. 用你的文件编辑/写文件工具（不是 shell）：新建 tool-new.txt，内容 "tool"；在 README.md 末尾加一行 "tool edit"。
2. 用 shell：运行 echo shell > shell.txt ；再运行 git add -A 和 git commit -m "spike commit"；再运行 echo blob | git hash-object -w --stdin 。
3. 用 shell 调外部程序：node -e "require('fs').writeFileSync('node.txt','node')" ；以及 python3 -c "open('py.txt','w').write('py')" 。
4. 写工作目录之外：用文件写工具新建 ../outside-tool.txt；用 shell 运行 echo out > ../outside-shell.txt ；以及 node -e "require('fs').writeFileSync('../outside-node.txt','x')"。
5. 只读操作：运行 node --test 、git diff 、git log --oneline ，贴出关键输出（node --test 会打印一行 WROTE= 或 BLOCKED=，照抄）。
6. 系统临时目录：运行 node -e "const fs=require('fs'),os=require('os'),p=require('path');const d=fs.mkdtempSync(p.join(os.tmpdir(),'ro-probe-'));fs.writeFileSync(p.join(d,'f'),'x');console.log('WROTE',d)" ，贴出完整输出和退出码（成功时不要删它，我会检查）。
最后用一张表汇总每一项：做成了 / 被拦住，被拦住时的原话。`;
const TESTS = `这是一次权限实测。依次运行下面三条命令，贴出关键输出（node --test 会打印一行 WROTE= 或 BLOCKED=，照抄），不要改写命令：
1. node --test --test-isolation=none
2. git diff
3. git log --oneline
最后用表格汇总。`;
const TOOLS = '只回答一行：列出你这一轮能调用的全部工具名，逗号分隔。不要调用任何工具。';
const SMOKE = '只回答 OK 两个字母，不要调用任何工具。';

function sh(cmd, args, cwd) { return execFileSync(cmd, args, { cwd, encoding: 'utf8' }); }

function makeRepo(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(path.join(repo, 'test'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'README.md'), '# spike\n');
  fs.writeFileSync(path.join(repo, 'sum.mjs'), 'export const sum = (a, b) => a + b;\n');
  fs.writeFileSync(path.join(repo, 'test', 'sum.test.mjs'),
`import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import { sum } from '../sum.mjs';
test('sum', () => { assert.equal(sum(1, 2), 3); });
test('a test that writes', () => {
  try { fs.writeFileSync('from-test.txt', 'x'); console.log('WROTE=from-test.txt'); }
  catch (e) { console.log('BLOCKED=' + e.code + ' ' + e.message); }
});
`);
  sh('git', ['init', '-q', '-b', 'main'], repo);
  sh('git', ['config', 'user.name', 'spike'], repo);
  sh('git', ['config', 'user.email', 'spike@example.invalid'], repo);
  sh('git', ['add', '-A'], repo);
  sh('git', ['commit', '-q', '-m', 'init'], repo);
  // An uncommitted change, so that git diff has something to show.
  fs.appendFileSync(path.join(repo, 'sum.mjs'), '// pending change\n');
  return repo;
}

function looseObjects(repo) {
  let n = 0;
  const objects = path.join(repo, '.git/objects');
  for (const d of fs.readdirSync(objects)) if (/^[0-9a-f]{2}$/.test(d)) n += fs.readdirSync(path.join(objects, d)).length;
  return n;
}

function snapshot(dir) {
  const files = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.name === '.git') continue;
      if (e.isDirectory()) walk(p);
      else files[path.relative(dir, p)] = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex').slice(0, 12);
    }
  };
  walk(dir);
  const repo = path.join(dir, 'repo');
  return {
    files,
    log: sh('git', ['log', '--oneline'], repo).trim(),
    status: sh('git', ['status', '--porcelain'], repo).trim(),
    looseObjects: looseObjects(repo),
    tmpProbes: fs.readdirSync(TMP).filter((n) => n.startsWith('ro-probe-')).sort(),
  };
}

function diff(a, b) {
  const out = [];
  for (const k of Object.keys(b.files)) if (!(k in a.files)) out.push(`+ ${k}`); else if (a.files[k] !== b.files[k]) out.push(`~ ${k}`);
  for (const k of Object.keys(a.files)) if (!(k in b.files)) out.push(`- ${k}`);
  if (a.log !== b.log) out.push(`git log changed: ${b.log.replace(/\n/g, ' | ')}`);
  if (a.looseObjects !== b.looseObjects) out.push(`git loose objects ${a.looseObjects} -> ${b.looseObjects}`);
  for (const t of b.tmpProbes) if (!a.tmpProbes.includes(t)) out.push(`+ ${TMP}/${t}`);
  return out;
}

// adapters/claude.ts command(): -p, stream-json, --settings, --permission-mode, --add-dir; IS_SANDBOX with bypass.
const claude = (repo, extra) => ({ cmd: 'claude', env: { IS_SANDBOX: '1' }, args: ['-p', BRIEF, '--output-format', 'stream-json',
  '--verbose', '--include-partial-messages', '--settings', path.join(HOME, '.claude/tiers/execute.json'),
  '--permission-mode', 'bypassPermissions', '--add-dir', repo, ...extra] });
// adapters/codex.ts launch() with a ref tier: exec --json --profile <tier> --skip-git-repo-check -C <dir> <prompt>.
// The adapter adds --dangerously-bypass-approvals-and-sandbox for a ref tier; a read-only round must not.
const codex = (repo) => ({ cmd: 'codex', env: {}, args: ['exec', '--json', '--profile', 'execute', '--sandbox', 'read-only',
  '--skip-git-repo-check', '-C', repo, BRIEF] });
// adapters/dsh.ts command(): --profile headless --patch <tier> --json --permission-mode <m> --approval-policy never <prompt>.
// dsh 0.2.1-rc.5's headless app rejects --permission-mode (`unknown option`), so 'dsh-adapter-linux' records that and
// the other dsh variants reach the same read-only sandbox through a probe-only patch overlay instead: the one the
// instance's own headless profile uses to set danger-full-access, with the mode swapped. Nothing on the instance changes.
const READONLY_PATCH = path.join(ROOT, 'readonly.patch.yml');
fs.mkdirSync(ROOT, { recursive: true });
fs.writeFileSync(READONLY_PATCH, '- id: sandbox-policy\n  config:\n    mode: read-only\n');
const tierPatch = path.join(HOME, '.dsh/tiers/execute.patch.yml');
const dshAdapter = () => ({ cmd: 'dsh', env: {}, args: ['--profile', 'headless', '--patch', tierPatch,
  '--json', '--permission-mode', 'read-only', '--approval-policy', 'never', BRIEF] });
const dsh = () => ({ cmd: 'dsh', env: {}, args: ['--profile', 'headless', '--patch', tierPatch, '--patch', READONLY_PATCH,
  '--json', BRIEF] });

const BRIEFS = { 'dsh-adapter-linux': SMOKE, 'dsh-smoke-linux': SMOKE, 'dsh-readonly-tests-linux': TESTS, 'claude-tools-linux': TOOLS, 'claude-tools-strict-linux': TOOLS };
const VARIANTS = {
  'codex-readonly-linux': codex,
  'dsh-adapter-linux': dshAdapter,
  'dsh-smoke-linux': dsh,
  'dsh-readonly-linux': dsh,
  'dsh-readonly-tests-linux': dsh,
  'claude-tools-linux': (repo) => claude(repo, ['--tools', 'Read,Grep,Glob']),
  'claude-tools-strict-linux': (repo) => claude(repo, ['--tools', 'Read,Grep,Glob', '--strict-mcp-config']),
  'claude-readonly-linux': (repo) => claude(repo, ['--tools', 'Read,Grep,Glob', '--strict-mcp-config']),
};

const name = process.argv[2];
const dir = path.join(ROOT, name);
const repo = makeRepo(dir);
const before = snapshot(dir);
const v = VARIANTS[name](repo);
const brief = BRIEFS[name] ?? BRIEF;
const args = v.args.map((a) => (a === BRIEF ? brief : a));
const outDir = path.join(ROOT, '_out', name);
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'brief.txt'), brief);
const child = spawn(v.cmd, args, { cwd: repo, env: { ...process.env, ...v.env }, stdio: ['ignore', 'pipe', 'pipe'] });
const so = fs.createWriteStream(path.join(outDir, 'stdout.ndjson'));
const se = fs.createWriteStream(path.join(outDir, 'stderr.txt'));
child.stdout.pipe(so); child.stderr.pipe(se);
const timer = setTimeout(() => child.kill(), 20 * 60 * 1000);
child.on('close', (code) => {
  clearTimeout(timer);
  const after = snapshot(dir);
  const changes = diff(before, after);
  fs.writeFileSync(path.join(outDir, 'fs.json'), JSON.stringify({
    argv: [v.cmd, ...args.map((a) => (a === brief ? '<brief>' : a))], exit: code, changes,
    gitLogAfter: after.log, gitStatusAfter: after.status, looseObjects: [before.looseObjects, after.looseObjects],
  }, null, 2));
  console.log(name, 'exit', code, '\n', changes.join('\n') || '(no filesystem change)');
});
