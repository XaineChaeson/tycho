// Guards against the installer damaging the owner's shell setup while putting one
// directory on PATH: an uninstall that removes an entry the owner had before tycho came
// (nothing is undone without a record of having added it, and only one entry goes), a
// fish line that writes the directory into fish's universal variables where deleting the
// line no longer takes it back, a startup file written back from a stale read over what
// an editor or another installer saved in between, a half-written startup file, a file
// that loses its permissions or stops being the link into a dotfile repository, a new
// .bash_profile on macOS that makes bash stop reading the .profile the owner already
// had, a file left behind empty after an uninstall, and on Windows a user PATH read in
// one process and written back in another over whatever changed in between.
//
// Nothing here touches the real machine: every startup file is under a temporary home,
// the registry is reached only through a fake exec, and the one test that runs the real
// powershell.exe gives it sample strings and no registry.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, chmodSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { tool } from '../cli/system.ts';
import type { PathRecord } from '../cli/user-path.ts';
import { addToPath, PATH_EDIT_FUNCTION, rcFile, rcLine, removeFromPath } from '../cli/user-path.ts';
import type { Stage, StageOptions } from './cli-helpers.ts';
import { stage } from './cli-helpers.ts';

const BIN = '/opt/tycho app/bin';
const LINE = `export PATH="${BIN}:$PATH" # tycho`;

const rcRecord = (record: PathRecord | undefined): Extract<PathRecord, { kind: 'rc' }> => {
  assert.equal(record?.kind, 'rc');
  return record as Extract<PathRecord, { kind: 'rc' }>;
};

// ---- Which file, and which line ----

test('每种 shell 写它自己会读的文件', (t) => {
  const file = (options: StageOptions): string => {
    const s = stage(t, options);
    return rcFile(s.cli.system).slice(s.home.length + 1).replaceAll('\\', '/');
  };
  assert.equal(file({ env: { SHELL: '/bin/zsh' } }), '.zshrc');
  assert.equal(file({ env: { SHELL: '/usr/bin/bash' } }), '.bashrc');
  assert.equal(file({ env: { SHELL: '/usr/bin/fish' } }), '.config/fish/config.fish');
  assert.equal(file({ env: { SHELL: '/bin/dash' } }), '.profile');
  const zdot = stage(t, { env: { SHELL: '/bin/zsh', ZDOTDIR: '/somewhere/zsh' } });
  assert.equal(rcFile(zdot.cli.system), join('/somewhere/zsh', '.zshrc'));
});

test('macOS 的 bash：按 bash 自己的顺序找已有的登录文件，都没有才用 .bash_profile', (t) => {
  const chosen = (existing: string[]): string => {
    const s = stage(t, { platform: 'darwin', env: { SHELL: '/bin/bash' } });
    for (const name of existing) writeFileSync(join(s.home, name), '# mine\n');
    return rcFile(s.cli.system).slice(s.home.length + 1);
  };
  assert.equal(chosen([]), '.bash_profile');
  assert.equal(chosen(['.profile']), '.profile');
  assert.equal(chosen(['.bash_login', '.profile']), '.bash_login');
  assert.equal(chosen(['.bash_profile', '.bash_login', '.profile']), '.bash_profile');
  // A terminal on Linux opens a shell that reads .bashrc, whatever login files exist.
  const linux = stage(t, { env: { SHELL: '/bin/bash' } });
  writeFileSync(join(linux.home, '.profile'), '# mine\n');
  assert.equal(rcFile(linux.cli.system), join(linux.home, '.bashrc'));
});

test('macOS 的 bash：只有 .profile 时往它里面加，不新建 .bash_profile 把它挡掉', (t) => {
  const s = stage(t, { platform: 'darwin', env: { SHELL: '/bin/bash' } });
  writeFileSync(join(s.home, '.profile'), 'export EDITOR=vi\n');
  const added = addToPath(s.cli.system, BIN);
  assert.equal(added.changed, true);
  assert.equal(existsSync(join(s.home, '.bash_profile')), false, 'bash 一旦找到 .bash_profile 就不再读 .profile');
  assert.equal(readFileSync(join(s.home, '.profile'), 'utf8'), `export EDITOR=vi\n${LINE}\n`);
  assert.deepEqual(added.record, { kind: 'rc', file: join(s.home, '.profile'), line: LINE, created: false });
});

test('macOS 的 bash：自己新建的 .bash_profile 记在案，卸载时空了就删掉', (t) => {
  const s = stage(t, { platform: 'darwin', env: { SHELL: '/bin/bash' } });
  const added = addToPath(s.cli.system, BIN);
  const file = join(s.home, '.bash_profile');
  assert.deepEqual(added.record, { kind: 'rc', file, line: LINE, created: true });
  assert.equal(removeFromPath(s.cli.system, added.record!).changed, true);
  assert.equal(existsSync(file), false, '留下一个空的 .bash_profile，.profile 照样读不到');
});

test('写进文件的那一行：路径里的引号、$、反引号、反斜杠不被 shell 另作解释', (t) => {
  const s = stage(t);
  assert.equal(rcLine(s.cli.system, '/a "b"/$HOME/`x`/c\\d'), 'export PATH="/a \\"b\\"/\\$HOME/\\`x\\`/c\\\\d:$PATH" # tycho');
});

test('fish：用只影响当前 shell 的写法，不写进它的全局变量', (t) => {
  const s = stage(t, { env: { SHELL: '/usr/bin/fish' } });
  // Without --path, fish_add_path stores the directory in a universal variable, which
  // outlives the line: deleting the line would no longer take it off PATH.
  assert.equal(rcLine(s.cli.system, BIN), `fish_add_path --path "${BIN}" # tycho`);
  const added = addToPath(s.cli.system, BIN);
  const file = join(s.home, '.config', 'fish', 'config.fish');
  assert.equal(readFileSync(file, 'utf8'), `fish_add_path --path "${BIN}" # tycho\n`);
  assert.equal(rcRecord(added.record).created, true);
});

// ---- Adding, and undoing exactly that ----

test('加：只追加一行，原来的内容一个字符不动；已经有那一行就不改，也不记成自己加的', (t) => {
  const s = stage(t);
  const file = join(s.home, '.bashrc');
  writeFileSync(file, 'export FOO=1\n# no newline at the end');
  const added = addToPath(s.cli.system, BIN);
  assert.equal(added.changed, true);
  assert.equal(added.where, file);
  assert.deepEqual(added.record, { kind: 'rc', file, line: LINE, created: false });
  assert.equal(readFileSync(file, 'utf8'), `export FOO=1\n# no newline at the end\n${LINE}\n`);

  const before = statSync(file).mtimeMs;
  const again = addToPath(s.cli.system, BIN);
  assert.deepEqual(again, { changed: false, where: file });
  assert.equal(statSync(file).mtimeMs, before, '没有要改的就不写文件');
});

test('主人原来就有那一行：安装不给记录，卸载就没有可撤销的', (t) => {
  const s = stage(t);
  const file = join(s.home, '.bashrc');
  writeFileSync(file, `${LINE}\n`);
  const added = addToPath(s.cli.system, BIN);
  assert.equal(added.changed, false);
  assert.equal(added.record, undefined, '没加过东西，就没有记录；卸载只按记录撤销');
});

test('撤销：只去掉记录里的那一行；别人的行、空行、结尾都原样', (t) => {
  const s = stage(t);
  const file = join(s.home, '.bashrc');
  writeFileSync(file, 'export FOO=1\n\n');
  const { record } = addToPath(s.cli.system, BIN);
  appendFileSync(file, 'export BAR=2\n');
  const removed = removeFromPath(s.cli.system, record!);
  assert.deepEqual(removed, { changed: true, where: file });
  assert.equal(readFileSync(file, 'utf8'), 'export FOO=1\n\nexport BAR=2\n');
  // Nothing left to undo: said so, and nothing written.
  assert.equal(removeFromPath(s.cli.system, record!).changed, false);
});

test('撤销：按记录里的文件和那一行来，不看现在用的是什么 shell', (t) => {
  const s = stage(t);
  const { record } = addToPath(s.cli.system, BIN);
  s.cli.system.env.SHELL = '/usr/bin/fish';
  assert.equal(removeFromPath(s.cli.system, record!).changed, true);
  assert.equal(existsSync(join(s.home, '.config')), false, '不该去碰另一种 shell 的文件');
});

test('撤销：自己新建的文件空了就删；主人后来往里写过东西就留着；原来就有的文件空了也留着', (t) => {
  const made = stage(t);
  const { record } = addToPath(made.cli.system, BIN);
  assert.equal(rcRecord(record).created, true);
  removeFromPath(made.cli.system, record!);
  assert.equal(existsSync(join(made.home, '.bashrc')), false);

  const used = stage(t);
  const kept = addToPath(used.cli.system, BIN).record!;
  appendFileSync(join(used.home, '.bashrc'), 'alias ll="ls -l"\n');
  removeFromPath(used.cli.system, kept);
  assert.equal(readFileSync(join(used.home, '.bashrc'), 'utf8'), 'alias ll="ls -l"\n');

  const theirs = stage(t);
  writeFileSync(join(theirs.home, '.bashrc'), '');
  const added = addToPath(theirs.cli.system, BIN).record!;
  assert.equal(rcRecord(added).created, false);
  removeFromPath(theirs.cli.system, added);
  assert.equal(readFileSync(join(theirs.home, '.bashrc'), 'utf8'), '', '这个空文件是主人的');
});

test('撤销：文件已经不在、或那一行已经被主人删了，都不算错，也不写东西', (t) => {
  const s = stage(t);
  const file = join(s.home, '.bashrc');
  const gone: PathRecord = { kind: 'rc', file, line: LINE, created: true };
  assert.deepEqual(removeFromPath(s.cli.system, gone), { changed: false, where: file });
  assert.equal(existsSync(file), false);
  writeFileSync(file, 'export FOO=1\n');
  assert.equal(removeFromPath(s.cli.system, gone).changed, false);
  assert.equal(readFileSync(file, 'utf8'), 'export FOO=1\n');
});

test('被编辑器存成 CRLF 的文件里，那一行照样认得出来', (t) => {
  const s = stage(t);
  const file = join(s.home, '.bashrc');
  writeFileSync(file, `export FOO=1\r\n${LINE}\r\n`);
  assert.equal(addToPath(s.cli.system, BIN).changed, false);
  assert.equal(removeFromPath(s.cli.system, { kind: 'rc', file, line: LINE, created: false }).changed, true);
  assert.equal(readFileSync(file, 'utf8'), 'export FOO=1\r\n');
});

// ---- Not writing over what changed in between ----

const leftovers = (dir: string): string[] => readdirSync(dir).filter((name) => name.includes('.tmp'));

test('读到之后文件被别人改了：重读一次再决定，别人的修改留着', (t) => {
  const s = stage(t);
  const file = join(s.home, '.bashrc');
  writeFileSync(file, 'export FOO=1\n');
  let interruptions = 0;
  const added = addToPath(s.cli.system, BIN, {
    beforeCommit() {
      if ((interruptions += 1) === 1) appendFileSync(file, 'export SAVED_BY_EDITOR=1\n');
    },
  });
  assert.equal(added.changed, true);
  assert.equal(readFileSync(file, 'utf8'), `export FOO=1\nexport SAVED_BY_EDITOR=1\n${LINE}\n`);
  assert.equal(interruptions, 2, '第二次是对着新内容重新决定的');

  // The same on the way out.
  let once = true;
  const removed = removeFromPath(s.cli.system, added.record!, {
    beforeCommit() {
      if (once) appendFileSync(file, 'export LATER=1\n');
      once = false;
    },
  });
  assert.equal(removed.changed, true);
  assert.equal(readFileSync(file, 'utf8'), 'export FOO=1\nexport SAVED_BY_EDITOR=1\nexport LATER=1\n');
});

test('读到之后别的安装器已经加上了那一行：重读后发现不用改，不再加第二行', (t) => {
  const s = stage(t);
  const file = join(s.home, '.bashrc');
  writeFileSync(file, 'export FOO=1\n');
  const added = addToPath(s.cli.system, BIN, { beforeCommit: () => appendFileSync(file, `${LINE}\n`) });
  assert.equal(added.changed, false);
  assert.equal(added.record, undefined);
  assert.equal(readFileSync(file, 'utf8'), `export FOO=1\n${LINE}\n`);
});

test('文件一直在变：停下并说明，不写，不留临时文件', (t) => {
  const s = stage(t);
  const file = join(s.home, '.bashrc');
  writeFileSync(file, 'export FOO=1\n');
  let saves = 0;
  assert.throws(
    () => addToPath(s.cli.system, BIN, { beforeCommit: () => appendFileSync(file, `# save ${(saves += 1)}\n`) }),
    /正在被别的程序改/,
  );
  assert.equal(readFileSync(file, 'utf8'), 'export FOO=1\n# save 1\n# save 2\n');
  assert.deepEqual(leftovers(s.home), []);
});

test('文件原来没有、读过之后才被别人建出来：不拿自己那一行盖掉它', (t) => {
  const s = stage(t);
  const file = join(s.home, '.bashrc');
  let once = true;
  const added = addToPath(s.cli.system, BIN, {
    beforeCommit() {
      if (once) writeFileSync(file, 'export NEW=1\n');
      once = false;
    },
  });
  assert.equal(readFileSync(file, 'utf8'), `export NEW=1\n${LINE}\n`);
  assert.equal(rcRecord(added.record).created, false, '这个文件不是安装器建的');
});

test('提交用“写临时文件再改名”：成功后不留临时文件', (t) => {
  const s = stage(t);
  writeFileSync(join(s.home, '.bashrc'), 'export FOO=1\n');
  const { record } = addToPath(s.cli.system, BIN);
  assert.deepEqual(leftovers(s.home), []);
  removeFromPath(s.cli.system, record!);
  assert.deepEqual(leftovers(s.home), []);
});

test('提交是整个换掉文件，不是在原文件上改写：已经打开它的读者读到的仍是完整的旧内容', (t) => {
  const s = stage(t);
  const file = join(s.home, '.bashrc');
  const old = 'export FOO=1\n'.repeat(200);
  writeFileSync(file, old);
  const before = statSync(file, { bigint: true }).ino;
  // A shell starting at this moment. Written in place, the file would be cut to nothing
  // and filled again under it, and a write that stops halfway would leave it cut.
  // Windows refuses to replace a file someone holds open, and has no startup file to edit.
  const reader = process.platform === 'win32' ? undefined : openSync(file, 'r');
  t.after(() => {
    if (reader !== undefined) closeSync(reader);
  });
  addToPath(s.cli.system, BIN);
  if (reader !== undefined) assert.equal(readFileSync(reader, 'utf8'), old);
  assert.equal(readFileSync(file, 'utf8'), `${old}${LINE}\n`);
  assert.notEqual(statSync(file, { bigint: true }).ino, before, '新内容是另一个文件改名过来的');
});

test('提交在读到的内容确认没变之后才开始：确认之前没有任何写入', (t) => {
  const s = stage(t);
  const file = join(s.home, '.bashrc');
  writeFileSync(file, 'export FOO=1\n');
  const seen: { content: string; partial: string[] }[] = [];
  addToPath(s.cli.system, BIN, { beforeCommit: () => seen.push({ content: readFileSync(file, 'utf8'), partial: leftovers(s.home) }) });
  assert.deepEqual(seen, [{ content: 'export FOO=1\n', partial: [] }]);
});

test('文件的权限保留', { skip: process.platform === 'win32' && 'Windows 上没有这套权限位' }, (t) => {
  const s = stage(t);
  const file = join(s.home, '.bashrc');
  writeFileSync(file, 'export FOO=1\n');
  chmodSync(file, 0o600);
  const { record } = addToPath(s.cli.system, BIN);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  removeFromPath(s.cli.system, record!);
  assert.equal(statSync(file).mode & 0o777, 0o600);
});

function link(t: TestContext, target: string, path: string): boolean {
  try {
    symlinkSync(target, path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EPERM') throw err;
    t.skip('这个账号建不了符号链接（Windows 上要开发者模式或管理员）');
    return false;
  }
}

test('启动文件是指向 dotfile 仓库的符号链接：改的是它指向的文件，链接还是链接', (t) => {
  const s = stage(t);
  const real = join(s.dir, 'dotfiles', 'bashrc');
  mkdirSync(join(s.dir, 'dotfiles'));
  writeFileSync(real, 'export FOO=1\n');
  const file = join(s.home, '.bashrc');
  if (!link(t, real, file)) return;
  const added = addToPath(s.cli.system, BIN);
  assert.equal(lstatSync(file).isSymbolicLink(), true, '不能把链接换成普通文件');
  assert.equal(readFileSync(real, 'utf8'), `export FOO=1\n${LINE}\n`);
  assert.equal(rcRecord(added.record).file, real, '记下的是真正写入的那个文件');
  assert.equal(added.where, file, '告诉主人的是 shell 读的那个名字');
  assert.deepEqual(leftovers(s.home), []);
  assert.deepEqual(leftovers(join(s.dir, 'dotfiles')), []);

  removeFromPath(s.cli.system, added.record!);
  assert.equal(lstatSync(file).isSymbolicLink(), true);
  assert.equal(readFileSync(real, 'utf8'), 'export FOO=1\n');
});

test('启动文件所在的目录是指向 dotfile 仓库的链接：链接不动，记下的是真实路径', (t) => {
  const s = stage(t, { env: { SHELL: '/usr/bin/fish' } });
  const real = join(s.dir, 'dotfiles', 'fish');
  mkdirSync(real, { recursive: true });
  writeFileSync(join(real, 'config.fish'), 'set -g fish_greeting\n');
  mkdirSync(join(s.home, '.config'));
  const dir = join(s.home, '.config', 'fish');
  // A junction on Windows, which needs no privilege; a plain link elsewhere.
  symlinkSync(real, dir, 'junction');
  const added = addToPath(s.cli.system, BIN);
  assert.equal(lstatSync(dir).isSymbolicLink(), true);
  assert.equal(rcRecord(added.record).file, join(real, 'config.fish'));
  assert.equal(rcRecord(added.record).created, false);
  assert.equal(readFileSync(join(real, 'config.fish'), 'utf8'), `set -g fish_greeting\nfish_add_path --path "${BIN}" # tycho\n`);
  assert.deepEqual(leftovers(real), []);
});

// ---- Windows: the current user's Path ----

interface RegistryCall {
  args: string[];
  env: Record<string, string>;
}

function windows(t: TestContext, answer: (call: RegistryCall) => { code?: number; stdout?: string; stderr?: string }): Stage {
  return stage(t, { platform: 'win32', respond: (call) => (/powershell/i.test(call.file) ? answer(call) : { code: 1 }) });
}

const WIN_BIN = 'C:\\Users\\张三\\.tycho\\app\\bin';

test('Windows：读、改、写在同一次 PowerShell 调用里，条目经环境变量传过去', (t) => {
  const s = windows(t, () => ({ stdout: 'changed\r\n' }));
  const added = addToPath(s.cli.system, WIN_BIN);
  assert.deepEqual(added, { changed: true, where: '当前用户的环境变量', record: { kind: 'windows', entry: WIN_BIN } });
  assert.equal(s.calls.length, 1, '读和写分两次调用，中间别的安装器改的 PATH 就会被盖掉');
  const [call] = s.calls;
  assert.deepEqual(call!.env, { TYCHO_VAR: 'Path', TYCHO_ENTRY: WIN_BIN, TYCHO_OP: 'add' });
  const script = call!.args.at(-1)!;
  // What the one call has to hold: the stored value unexpanded, its kind kept, the edit,
  // the write, and the notice to running programs.
  for (const part of ['DoNotExpandEnvironmentNames', 'GetValueKind', 'Edit-PathValue', 'SetValue', 'SetEnvironmentVariable']) {
    assert.ok(script.includes(part), `脚本里没有 ${part}`);
  }
  assert.doesNotMatch(script, /张三|"/, '路径不进脚本文本，脚本里也没有会被命令行改写的双引号');
});

test('Windows：已经在 PATH 里就不改，也不记成自己加的', (t) => {
  const s = windows(t, () => ({ stdout: 'unchanged\r\n' }));
  assert.deepEqual(addToPath(s.cli.system, WIN_BIN), { changed: false, where: '当前用户的环境变量' });
});

test('Windows：撤销按记录里的那一条来', (t) => {
  const s = windows(t, () => ({ stdout: 'changed\r\n' }));
  const removed = removeFromPath(s.cli.system, { kind: 'windows', entry: WIN_BIN });
  assert.deepEqual(removed, { changed: true, where: '当前用户的环境变量' });
  assert.equal(s.calls.length, 1);
  assert.deepEqual(s.calls[0]!.env, { TYCHO_VAR: 'Path', TYCHO_ENTRY: WIN_BIN, TYCHO_OP: 'remove' });
});

test('Windows：PowerShell 失败或答非所问都报错，不当成改好了', (t) => {
  const failing = windows(t, () => ({ code: 1, stderr: 'Requested registry access is not allowed.' }));
  assert.throws(() => addToPath(failing.cli.system, WIN_BIN), /改不了.*registry access/);
  const odd = windows(t, () => ({ stdout: '' }));
  assert.throws(() => addToPath(odd.cli.system, WIN_BIN), /改不了/);
  assert.throws(() => removeFromPath(odd.cli.system, { kind: 'windows', entry: WIN_BIN }), /改不了/);
});

test('Windows 的 PATH 值（真实的 powershell.exe，只给样例字符串）：别人的条目一个字符都不动，只动一条', { skip: process.platform !== 'win32' && '要 Windows 自带的 PowerShell' }, () => {
  const bin = 'C:\\Users\\o\\.tycho\\app\\bin';
  const chinese = 'C:\\Users\\张三\\.tycho\\app\\bin';
  const cases: [value: string, entry: string, op: 'add' | 'remove', expected: string | null][] = [
    ['', bin, 'add', bin],
    ['C:\\a;;%X%\\b;', bin, 'add', `C:\\a;;%X%\\b;${bin}`],
    ['C:\\a;%USERPROFILE%\\bin', chinese, 'add', `C:\\a;%USERPROFILE%\\bin;${chinese}`],
    [`C:\\a;${bin.toUpperCase()}\\`, bin, 'add', null],
    [`C:\\a;${bin.replaceAll('\\', '/')}/`, `${bin}\\`, 'add', null],
    [`C:\\a;;${bin};%X%\\b`, bin, 'remove', 'C:\\a;;%X%\\b'],
    ['C:\\a', bin, 'remove', null],
    [bin, bin, 'remove', ''],
    [`${chinese};D:\\工具`, chinese, 'remove', 'D:\\工具'],
    // The owner's own spelling of the same directory stays; the one written by the installer goes.
    [`${bin.toUpperCase()}\\;C:\\a;${bin}`, bin, 'remove', `${bin.toUpperCase()}\\;C:\\a`],
    [`${bin};C:\\a;${bin.toUpperCase()}\\`, bin, 'remove', `C:\\a;${bin.toUpperCase()}\\`],
    // No entry spelled exactly as recorded: one equivalent entry goes, never all of them.
    [`${bin}\\;C:\\a;${bin.toUpperCase()}`, bin, 'remove', `${bin}\\;C:\\a`],
  ];
  const harness = [
    "$ErrorActionPreference = 'Stop'",
    PATH_EDIT_FUNCTION,
    '$cases = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:TYCHO_CASES)) | ConvertFrom-Json',
    'foreach ($case in $cases) {',
    '  $new = Edit-PathValue $case[0] $case[1] $case[2]',
    "  if ($null -eq $new) { '-' } else { '+' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($new)) }",
    '}',
  ].join('\n');
  const ran = spawnSync(tool({ platform: 'win32', env: process.env }, 'powershell'), ['-NoProfile', '-NonInteractive', '-Command', harness], {
    encoding: 'utf8',
    env: { ...process.env, TYCHO_CASES: Buffer.from(JSON.stringify(cases.map(([value, entry, op]) => [value, entry, op]))).toString('base64') },
  });
  assert.equal(ran.status, 0, ran.stderr);
  const answers = ran.stdout.trim().split(/\r?\n/).map((line) => (line === '-' ? null : Buffer.from(line.slice(1), 'base64').toString('utf8')));
  assert.deepEqual(answers, cases.map(([, , , expected]) => expected));
});
