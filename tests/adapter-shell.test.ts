// Guards how a command reads on the page: a known shell wrapper left on the title, an
// unknown or not-exactly-a-wrapper line unwrapped anyway, quoting undone wrongly, and — the
// one that misleads — a command that does more than read or search (a pipe, a variable, a
// block, `find -delete`) counted as a read or a search, or a read naming the wrong files.
import './guard.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inputText, readCommand, unwrapShell } from '../adapters/shell.ts';

test('known wrappers give up their script, and only when the line is exactly that', () => {
  assert.deepEqual(unwrapShell(`"C:\\\\WINDOWS\\\\System32\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe" -Command "Get-Content -Raw a.md"`), { script: 'Get-Content -Raw a.md', dialect: 'powershell' });
  assert.deepEqual(unwrapShell(`pwsh -NoProfile -Command 'ls'`), { script: 'ls', dialect: 'powershell' });
  assert.deepEqual(unwrapShell(`/bin/bash -lc 'cat a.txt'`), { script: 'cat a.txt', dialect: 'posix' });
  assert.deepEqual(unwrapShell(`bash -c "echo \\"hi\\""`), { script: 'echo "hi"', dialect: 'posix' });
  for (const line of [`bash -lc 'a' extra`, `bash -x 'a'`, `python -c 'print(1)'`, `powershell.exe -File x.ps1`, `bash -lc 'open`, `powershell -Command a; rm b`]) {
    assert.equal(unwrapShell(line), undefined, line);
  }
});

test('reads name their files, searches are searches, anything else runs', () => {
  const cases: [string, string, string[] | undefined][] = [
    [`bash -lc 'cat a.txt b.txt'`, 'read', ['a.txt', 'b.txt']],
    [`bash -lc 'head -n 20 src/x.ts'`, 'read', ['src/x.ts']],
    [`bash -lc "sed -n '1,80p' docs/a.md"`, 'read', ['docs/a.md']],
    [`powershell -Command "Get-Content -Path 'a b.md' -TotalCount 100"`, 'read', ['a b.md']],
    [`powershell -Command "Get-Content -Raw -Encoding UTF8 -LiteralPath 'it''s.md'"`, 'read', ["it's.md"]],
    [`powershell -Command "Get-Content C:\\\\x\\\\y.txt"`, 'read', ['C:\\x\\y.txt']],
    [`bash -lc 'rg -n foo src'`, 'search', undefined],
    [`powershell -Command "Get-ChildItem -LiteralPath adapters -Recurse"`, 'search', undefined],
    [`bash -lc 'git grep foo'`, 'search', undefined],
    [`bash -lc 'cat a | head'`, 'run', undefined],
    [`bash -lc 'cat $HOME/a'`, 'run', undefined],
    [`bash -lc 'find . -name x -delete'`, 'run', undefined],
    [`bash -lc 'cat'`, 'run', undefined],
    [`bash -lc 'sed -i s/a/b/ f'`, 'run', undefined],
    [`powershell -Command "Get-Content a; Remove-Item b"`, 'run', undefined],
    [`powershell -Command "Get-ChildItem | ForEach-Object { $_ }"`, 'run', undefined],
    [`powershell -Command "Get-Content \\"$env:X\\""`, 'run', undefined],
    [`npm test`, 'run', undefined],
  ];
  for (const [command, category, paths] of cases) {
    const reading = readCommand(command);
    assert.equal(reading.category, category, command);
    assert.deepEqual(reading.paths, paths, command);
  }
});

test('the title is the script without its wrapper, or the command as it came', () => {
  assert.equal(readCommand(`bash -lc 'npm test && npm run build'`).title, 'npm test && npm run build');
  assert.equal(readCommand(`weird "unclosed`).title, `weird "unclosed`);
  assert.equal(readCommand(`weird "unclosed`).category, 'run');
});

test('a tool input is a command as written, or the input as JSON, or nothing', () => {
  assert.equal(inputText({ command: 'ls -la', description: 'x' }), 'ls -la');
  assert.equal(inputText({ file_path: 'a' }), '{\n  "file_path": "a"\n}');
  assert.equal(inputText({}), undefined);
  assert.equal(inputText(undefined), undefined);
});

// Review (run-scene): a newline between statements was eaten as plain blank, so a second
// command read as files of the first. A newline outside quotes ends a statement: the line
// is not one plain command and runs.
test('a script of several lines is never one read or one search', () => {
  for (const command of [
    `bash -lc 'cat a.txt\nrm b.txt'`,
    `bash -lc 'rg foo\nrm b.txt'`,
    `powershell -Command "Get-Content a.txt\nRemove-Item b.txt"`,
    `powershell -Command "Get-ChildItem\r\nRemove-Item b.txt"`,
  ]) {
    const reading = readCommand(command);
    assert.equal(reading.category, 'run', JSON.stringify(command));
    assert.equal(reading.paths, undefined, JSON.stringify(command));
  }
  // A newline inside quotes is part of a word, not a new statement.
  assert.equal(readCommand(`bash -lc "cat 'a\nb.txt'"`).category, 'read');
});

// A searcher's option that makes it run or write something, in every spelling it takes.
test('a search that runs or writes something is running a command, however the option is spelled', () => {
  for (const command of [
    `bash -lc 'rg --pre=helper pattern .'`,
    `bash -lc 'rg --pre helper pattern .'`,
    `bash -lc 'find . -name x -fprint out.txt'`,
    `bash -lc 'fd -x rm'`,
    `bash -lc 'fd --exec=rm x'`,
    `bash -lc 'git grep -Ovim foo'`,
    `bash -lc 'git grep --open-files-in-pager=vim foo'`,
    `bash -lc 'tree -o listing.txt'`,
  ]) assert.equal(readCommand(command).category, 'run', command);
  assert.equal(readCommand(`bash -lc 'find . -xdev -name x'`).category, 'search', '-xdev 只是不跨文件系统');
});
