// Guards against losing recorded output, treating interruption as completion,
// missing errors, and malformed input breaking event parsing; against a warning the turn
// went on past reading as a failure, a command shown inside the shell that wraps it, a
// read counted as running a command, a tool's output, exit code or reason lost, and a
// file change reported only at its end left without a row; and against a writable round
// started in a way the CLI takes as read-only (`codex exec` with no sandbox switch, or on
// Windows with no Windows sandbox kind), which runs, refuses every write and says done.
import './guard.ts';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { codexAdapter } from '../adapters/codex.ts';
import type { Turn } from '../adapters/types.ts';
import { roundTurn } from '../runner/snapshot.ts';
import { ARTIFACTS_PLACEHOLDER, MATERIALS_PLACEHOLDER } from '../shared/node-protocol.ts';
import { fillPlaces } from '../node/watch.ts';
const DIR = join(import.meta.dirname, 'fixtures', 'codex', '0.163.0');
function recording(name: string) {
  const read = (suffix: string) => readFileSync(join(DIR, `${name}.${suffix}`), 'utf8');
  const stdout = read('ndjson');
  const stderr = read('stderr');
  const exitCode = Number(read('exit'));
  return { stdout, stderr, exitCode, events: stdout.split('\n').flatMap(codexAdapter.parse), reading: codexAdapter.result(stdout, exitCode, stderr) };
}
const TURN: Turn = { prompt: '做事', workdir: '/work', tier: { kind: 'content', text: 'model="m"\n' } };
test('launch and resume', () => {
  assert.deepEqual(codexAdapter.launch(TURN), { argv: ['codex', 'exec', '--json', '-c', 'model="m"', '-c', 'approval_policy="never"', '-c', 'sandbox_mode="danger-full-access"', '--skip-git-repo-check', '-C', '/work', '做事'], env: {} });
  assert.throws(() => codexAdapter.resume(TURN), /续接需要 session_ref/);
  const root = 'C:\\tycho\\data\\tasks\\t1\\runs\\r2\\artifacts';
  assert.deepEqual(
    codexAdapter.resume({ ...TURN, sessionRef: 'thread-123', artifactsDir: root, prompt: '继续改测试' }),
    {
      argv: [
        'codex', 'exec', '--json', '-c', 'model="m"', '-c', 'approval_policy="never"', '-c', 'sandbox_mode="danger-full-access"',
        '--add-dir', root, '--skip-git-repo-check', '-C', '/work',
        'resume', '--all', 'thread-123', '继续改测试',
      ],
      env: {},
    },
  );
  // Explicit permissionMode overrides default sandbox_mode, and inherit-machine defers to native config.toml.
  assert.ok(codexAdapter.launch({ ...TURN, permissionMode: 'workspace-write' }).argv.includes('sandbox_mode="workspace-write"'));
  assert.ok(!codexAdapter.launch({ ...TURN, permissionMode: 'inherit-machine' }).argv.some((a) => a.startsWith('sandbox_mode=')));
});

// Recorded on this Windows workstation (codex-cli 0.162.0, tests/fixtures/codex/0.162.0/writable):
// the same one-file task, started as the adapter starts a writable round, and started with no
// sandbox switch at all. Only the first wrote the file; the second's writes were refused and it
// still ended its turn normally.
const WRITABLE = join(import.meta.dirname, 'fixtures', 'codex', '0.162.0', 'writable');
const writableRun = (name: string) => {
  const stdout = readFileSync(join(WRITABLE, `${name}.ndjson`), 'utf8');
  const fs = JSON.parse(readFileSync(join(WRITABLE, `${name}.fs.json`), 'utf8')) as { argv: string[]; changes: string[]; proof?: string };
  const ended = stdout.split('\n').flatMap(codexAdapter.parse).filter((event) => event.kind === 'tool.end');
  return { fs, reading: codexAdapter.result(stdout, 0, ''), ended };
};

// Historical recordings establish why an explicit writable mode is needed. They do not
// prove the newer Auto-review preset; its native scratch evidence is a separate gate.
test('historical workspace-write recording explicitly selected its sandbox', () => {
  const { fs } = writableRun('windows');
  assert.equal(fs.argv[fs.argv.indexOf('--sandbox') + 1], 'workspace-write');
});

test('started that way the round wrote its file; with no sandbox switch every write was refused', () => {
  const writable = writableRun('windows');
  assert.equal(writable.reading.finished, true);
  assert.deepEqual([writable.fs.changes, writable.fs.proof], [['proof.txt'], 'tycho-writable']);
  assert.ok(writable.ended.length > 0 && writable.ended.every((event) => event.kind === 'tool.end' && !event.isError), '写文件的命令成功了');
  const refused = writableRun('windows-no-sandbox');
  assert.equal(refused.reading.finished, true, '执行器自己把这一轮算作做完了：写不了不会让它失败');
  assert.deepEqual(refused.fs.changes, []);
  assert.ok(refused.ended.length > 0 && refused.ended.every((event) => event.kind === 'tool.end' && event.isError), '每一次写都被拒了');
});
// Read by the dispatcher and the account check: Codex supports native session resume
// and explicit sandbox permission modes aligned with Claude/Gemini/DSH.
test('resumable is enabled and permissionModes exposes sandbox modes', () => {
  assert.equal(codexAdapter.resumable, true);
  assert.deepEqual(codexAdapter.permissionModes, ['danger-full-access', 'workspace-write', 'read-only', 'inherit-machine']);
});

// The delivery directory is outside the source checkout and is always added to native roots,
// including on read-only rounds so review/report artifacts can be written.
test('both writable and readonly rounds add the delivery directory when present', () => {
  const root = 'C:\\tycho\\data\\tasks\\t1\\runs\\r1\\artifacts';
  const { argv } = codexAdapter.launch({ ...TURN, artifactsDir: root });
  assert.equal(argv[argv.indexOf('--add-dir') + 1], root);
  assert.ok(!argv.some(arg => arg.includes('writable_roots')));
  const read = codexAdapter.launch({ ...TURN, artifactsDir: root, readOnly: true });
  assert.equal(read.argv[read.argv.indexOf('--add-dir') + 1], root);
  assert.deepEqual(read.argv, ['codex', 'exec', '--json', '-c', 'model="m"', '-c', 'approval_policy="never"', '-c', 'sandbox_mode="danger-full-access"', '--add-dir', root, '--skip-git-repo-check', '-C', '/work', '做事']);
});

test('the machine fills the raw delivery and materials paths as separate --add-dir arguments', () => {
  const turn = roundTurn({ brief: 'b', history: [], executor: 'codex', tier: 'execute', tier_value: { kind: 'content', text: 'model="m"\n' }, timeout_ms: 60_000 }, 'r1');
  const { argv } = codexAdapter.launch(turn);
  const addDirs = argv.flatMap((arg, i) => (arg === '--add-dir' ? [argv[i + 1]] : []));
  assert.deepEqual(addDirs, [ARTIFACTS_PLACEHOLDER, MATERIALS_PLACEHOLDER]);
  for (const artifacts of ['C:\\Program Files\\tycho data\\runs\\r1\\artifacts', "C:\\O'Brien 的目录\\runs\\r1\\artifacts"]) {
    const made = fillPlaces(argv, { materials: 'C:\\m', artifacts });
    const filled = made.flatMap((arg, i) => (arg === '--add-dir' ? [made[i + 1]] : []));
    assert.deepEqual(filled, [artifacts, 'C:\\m']);
  }
});

// Content is the CLI's own `键=值` lines, one argument each, never reassembled: a value
// that is TOML, holds spaces or an inline table stays one argument. A profile is not
// passed beside it, and neither is the bypass switch the ref path still carries: the
// role controls sandbox and approval settings independently of the tier.
test('content goes to -c, one line per argument, in the words it was written in', () => {
  const text = [
    'model=<模型名>',
    'model_reasoning_effort=high',
    'model_providers.gw={name="gw",base_url="http://127.0.0.1:9/v1",wire_api="responses"}',
    'model_verbosity=low',
  ].join('\n');
  const { argv, env } = codexAdapter.launch({ ...TURN, tier: { kind: 'content', text } });
  assert.deepEqual(argv, [
    'codex', 'exec', '--json',
    '-c', 'model=<模型名>',
    '-c', 'model_reasoning_effort=high',
    '-c', 'model_providers.gw={name="gw",base_url="http://127.0.0.1:9/v1",wire_api="responses"}',
    '-c', 'model_verbosity=low',
    '-c', 'approval_policy="never"',
    '-c', 'sandbox_mode="danger-full-access"',
    '--skip-git-repo-check', '-C', '/work', '做事',
  ]);
  assert.deepEqual(env, {}, '机器上自己的配置照常：不设 CODEX_HOME');
});


for (const name of ['normal', 'resume', 'long-prompt-completed', 'fail-openai-base-url-noeffect', 'fail-profile-nonexistent-noeffect']) {
  test(`${name}: recorded output completes intact`, () => {
    const { events, reading, exitCode } = recording(name);
    const expected = readFileSync(join(DIR, `${name}.last.txt`), 'utf8').trim();
    assert.equal(exitCode, 0);
    assert.ok(events.some(e => e.kind === 'text'));
    assert.ok(events.some(e => e.kind === 'turn.end'));
    assert.equal(reading.text?.trim(), expected);
    assert.equal(reading.finished, true);
    assert.equal(reading.error, undefined);
    assert.ok(reading.sessionRef);
    assert.ok(reading.usage);
    if (name === 'long-prompt-completed') assert.ok((reading.text?.length ?? 0) > 8000);
  });
}
test('interrupt is unfinished; its recorded nonzero exit is a failure', () => {
  const { stdout, stderr, exitCode, events, reading } = recording('interrupt');
  assert.ok(!events.some(e => e.kind === 'turn.end'));
  assert.equal(codexAdapter.result(stdout, null, stderr).finished, false);
  assert.equal(codexAdapter.result(stdout, null, stderr).error, undefined);
  assert.equal(exitCode, 1);
  assert.equal(reading.finished, false);
  assert.ok(reading.error);
});
test('unreachable provider: the reconnects are warnings, and the result fails', () => {
  const { events, reading } = recording('fail-provider-unreachable');
  const said = events.filter(e => e.kind === 'diagnostic');
  assert.ok(said.length > 1);
  assert.ok(said.every(e => e.kind === 'diagnostic' && e.level === 'warning'));
  assert.equal(reading.error?.kind, 'other');
  assert.equal(reading.finished, false);
});
test('rejected resume reports stderr', () => {
  const { reading, stderr } = recording('resume-with-c-profile-rejected');
  assert.equal(reading.finished, false);
  assert.equal(reading.error?.message, stderr.trim());
});
test('malformed lines are ignored', () => {
  for (const line of ['', 'not json', 'null', '[null]', '{"type":"item.completed","item":null}', '{"type":"item.completed","item":[null]}']) assert.deepEqual(codexAdapter.parse(line), []);
});
test('error forms, classification, and last result', () => {
  // Only a failed turn is fatal; the other two the turn goes on past.
  assert.deepEqual(codexAdapter.parse('{"type":"turn.failed","error":{"message":"401 unauthorized"}}'), [{ kind: 'diagnostic', level: 'fatal', message: '401 unauthorized', cause: 'auth' }]);
  assert.deepEqual(codexAdapter.parse('{"type":"item.completed","item":{"type":"error","message":"quota exceeded"}}'), [{ kind: 'diagnostic', level: 'warning', message: 'quota exceeded' }]);
  assert.deepEqual(codexAdapter.parse('{"type":"error","message":"network"}'), [{ kind: 'diagnostic', level: 'warning', message: 'network' }]);
  assert.equal(codexAdapter.result('{"type":"error","message":"quota exceeded"}', 1, '').error?.kind, 'quota');
  assert.equal(codexAdapter.result('{"type":"turn.failed","error":{"message":"401 unauthorized"}}', null, '').error?.kind, 'auth');
  const lines = [{ type: 'item.completed', item: { type: 'agent_message', text: 'first' } }, { type: 'item.completed', item: { type: 'agent_message', text: 'last' } }, { type: 'turn.completed', usage: { input_tokens: 7, cached_input_tokens: 3, cache_write_input_tokens: 2, output_tokens: 4 } }];
  // Codex counts the cached input inside its input: what is left of the 7 is 4.
  assert.deepEqual(codexAdapter.result(lines.map(x => JSON.stringify(x)).join('\n'), 0, ''), { text: 'last', usage: [{ inputTokens: 4, outputTokens: 4, cacheReadTokens: 3, cacheWriteTokens: 2 }], finished: true });

  // Trailing courtesy chatter after a receipt-containing agent_message must not wipe out the receipt.
  const receiptMsg = '任务已完成。\n```receipt\n{"status":"done","summary":"ok"}\n```';
  const withChatter = [
    { type: 'item.completed', item: { type: 'agent_message', text: receiptMsg } },
    { type: 'item.completed', item: { type: 'agent_message', text: '如有需要请随时告诉我！' } },
    { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } },
  ];
  const preserved = codexAdapter.result(withChatter.map(x => JSON.stringify(x)).join('\n'), 0, '');
  assert.equal(preserved.text, `${receiptMsg}\n\n如有需要请随时告诉我！`);

  // A later message that DOES contain a newer receipt supersedes the earlier one.
  const newerReceipt = '修订后回执：\n```receipt\n{"status":"done","summary":"v2"}\n```';
  const replaced = codexAdapter.result([
    { type: 'item.completed', item: { type: 'agent_message', text: receiptMsg } },
    { type: 'item.completed', item: { type: 'agent_message', text: newerReceipt } },
    { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } },
  ].map(x => JSON.stringify(x)).join('\n'), 0, '');
  assert.equal(replaced.text, newerReceipt);
});
test('tool lifecycle maps categories and failed status', () => {
  const item = { id: 't', type: 'command_execution', command: 'pwd', status: 'failed', exit_code: 2, aggregated_output: 'no' };
  const call = { category: 'run', name: 'command_execution', title: 'pwd', input: 'pwd' };
  assert.deepEqual(codexAdapter.parse(JSON.stringify({ type: 'item.started', item })), [{ kind: 'tool.start', id: 't', ...call }]);
  assert.deepEqual(codexAdapter.parse(JSON.stringify({ type: 'item.completed', item })), [{ kind: 'tool.end', id: 't', isError: true, call, output: { text: 'no' }, exitCode: 2 }]);
  const mcp = { id: 'm', type: 'mcp_tool_call', server: 'docs', tool: 'search', arguments: { q: 'x' }, status: 'failed', error: { message: '连不上' } };
  assert.deepEqual(codexAdapter.parse(JSON.stringify({ type: 'item.completed', item: mcp })), [{
    kind: 'tool.end', id: 'm', isError: true, reason: '连不上',
    call: { category: 'other', name: 'search', title: 'docs · search', input: JSON.stringify({ q: 'x' }, null, 2) },
  }]);
});

// From Codex's protocol source, not a recording: a file change may arrive only completed,
// with paths and kinds and no patch. Its end carries the call, so the page has a row.
test('a file change reported only at its end carries its call and the changes', () => {
  const item = { id: 'f', type: 'file_change', status: 'completed', changes: [{ path: 'a.ts', kind: 'update' }, { path: 'b.ts', kind: 'add' }, { path: 'c.ts', kind: 'odd' }] };
  assert.deepEqual(codexAdapter.parse(JSON.stringify({ type: 'item.completed', item })), [{
    kind: 'tool.end', id: 'f', isError: false,
    call: { category: 'edit', name: 'file_change', title: 'a.ts 等 3 个文件', paths: ['a.ts', 'b.ts', 'c.ts'] },
    changes: [{ path: 'a.ts', op: 'update' }, { path: 'b.ts', op: 'add' }, { path: 'c.ts' }],
  }]);
  const failed = codexAdapter.parse(JSON.stringify({ type: 'item.completed', item: { ...item, status: 'failed' } }))[0];
  assert.equal(failed?.kind === 'tool.end' ? failed.changes : 'none', undefined, '失败的改动不报告改了文件');
});

// Recorded on this machine (fixtures/codex/0.162.0/site-windows.*): the round the owner's
// screenshot showed.
const SITE = join(import.meta.dirname, 'fixtures', 'codex', '0.162.0', 'site-windows');
test('the recorded Windows round: warnings, unwrapped commands, reads, outputs and a failure', () => {
  const stdout = readFileSync(`${SITE}.ndjson`, 'utf8');
  const events = stdout.split('\n').flatMap(codexAdapter.parse);
  const said = events.filter(e => e.kind === 'diagnostic');
  assert.equal(said.length, 2, '两条一样的配置告警，都在');
  assert.ok(said.every(e => e.kind === 'diagnostic' && e.level === 'warning' && e.message === said[0]!.message));
  const reading = codexAdapter.result(stdout, 0, readFileSync(`${SITE}.stderr`, 'utf8'));
  assert.equal(reading.error, undefined, '告警不让这一轮失败');
  assert.equal(reading.finished, true);

  const starts = events.flatMap(e => e.kind === 'tool.start' ? [e] : []);
  assert.equal(starts[0]!.title, "Get-Content -Raw -LiteralPath 'runs/01M6Z6RKVEZN6J2DAERXJ5S2WQ/snapshot/brief.md'");
  assert.ok(starts[0]!.input?.startsWith('"C:\\\\WINDOWS'), '原文整条保留');
  // brief.md twice, context.json, skills/release.md: four reads of three files.
  assert.deepEqual(starts.slice(0, 4).map(e => [e.category, e.paths]), [
    ['read', ['runs/01M6Z6RKVEZN6J2DAERXJ5S2WQ/snapshot/brief.md']],
    ['read', ['runs/01M6Z6RKVEZN6J2DAERXJ5S2WQ/snapshot/brief.md']],
    ['read', ['runs/01M6Z6RKVEZN6J2DAERXJ5S2WQ/snapshot/context.json']],
    ['read', ['runs/01M6Z6RKVEZN6J2DAERXJ5S2WQ/snapshot/skills/release.md']],
  ]);
  // A script of several statements is a command run, shown unwrapped with its quoting undone.
  const seventh = starts.find(e => e.id === 'item_7')!;
  assert.equal(seventh.category, 'run');
  assert.equal(seventh.title, "git status --porcelain=v1; git branch --show-current; git rev-parse HEAD; rg --files -g AGENTS.md -g '*adapters*' -g '!node_modules' -g '!.git'; rg --files adapters");
  assert.ok(starts.every(e => !e.title.includes('powershell.exe')), '没有一条标题带着外壳');

  const ends = events.flatMap(e => e.kind === 'tool.end' ? [e] : []);
  const failed = ends.find(e => e.id === 'item_7')!;
  assert.equal(failed.isError, true);
  assert.equal(failed.exitCode, 1);
  assert.match(failed.output?.text ?? '', /CommandNotFoundException/);
  assert.equal(ends.length, starts.length, '每条开始都有结束');
  assert.ok(ends.every(e => e.call !== undefined && typeof e.exitCode === 'number'));
});

test('error events before a completed turn with exit 0 are warnings, not a failure', () => {
  const stdout = [
    '{"type":"thread.started","thread_id":"t1"}',
    '{"type":"item.completed","item":{"id":"item_0","type":"error","message":"Model metadata not found. Defaulting to fallback metadata."}}',
    '{"type":"error","message":"Reconnecting... waiting for network"}',
    '{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"done"}}',
    '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}',
  ].join('\n');
  const reading = codexAdapter.result(stdout, 0, '');
  assert.equal(reading.finished, true);
  assert.equal(reading.error, undefined);
  assert.equal(reading.text, 'done');
});
test('codex reports no quota windows: no recording yields a quota event, and a used-up account has no time', () => {
  for (const name of ['normal', 'resume', 'interrupt', 'fail-provider-unreachable']) assert.equal(recording(name).events.some((event) => event.kind === 'quota'), false);
  assert.deepEqual(codexAdapter.result('{"type":"turn.failed","error":{"message":"You have hit your usage limit"}}', 1, '').error, { kind: 'quota', message: 'You have hit your usage limit' });
});

// Recorded (fixtures/readonly/codex/codex-readonly-mcp.ndjson, line 19): an MCP call the
// sandbox refused ends `failed` with `error: null`, and says why in its result's content.
// What it said is the call's output; there is no separate reason to make up.
test('an MCP call keeps what its result says, and a reason only when the executor gave one apart', () => {
  const stdout = readFileSync(join(import.meta.dirname, 'fixtures', 'readonly', 'codex', 'codex-readonly-mcp.ndjson'), 'utf8');
  const end = stdout.split('\n').flatMap(codexAdapter.parse).find((e) => e.kind === 'tool.end' && e.id === 'item_9');
  assert.ok(end?.kind === 'tool.end');
  assert.equal(end.isError, true);
  assert.equal(end.output?.text, String.raw`EPERM: operation not permitted, open 'C:\work\probe\codex-readonly-mcp\repo\mcp.txt'`);
  assert.equal(end.reason, undefined);
  assert.deepEqual([end.call?.name, end.call?.title], ['js', 'node_repl · js']);
  // With an error of its own beside the content, both are kept.
  const both = codexAdapter.parse(JSON.stringify({ type: 'item.completed', item: { id: 'm', type: 'mcp_tool_call', server: 's', tool: 't', status: 'failed', result: { content: [{ type: 'text', text: '一' }, { type: 'image', data: 'x' }, { type: 'text', text: '二' }] }, error: { message: '超时' } } }))[0];
  assert.ok(both?.kind === 'tool.end');
  assert.deepEqual([both.output?.text, both.reason], ['一\n二', '超时']);
});

// Recorded with a made-up key (fixtures/codex/0.162.0/api-key): `codex exec` takes the key from
// CODEX_API_KEY, and with it there the machine's own ChatGPT login takes no part.
for (const name of ['wrong-key', 'wrong-key-beside-chatgpt-login']) test(`an account's API key travels in the environment, and a refused one is a login failure: ${name}`, () => {
  assert.deepEqual(codexAdapter.credential!({}), { variable: 'CODEX_API_KEY' });
  const dir = join(import.meta.dirname, 'fixtures', 'codex', '0.162.0', 'api-key');
  const stdout = readFileSync(join(dir, `${name}.ndjson`), 'utf8');
  const reading = codexAdapter.result(stdout, Number(readFileSync(join(dir, `${name}.exit`), 'utf8')), '');
  assert.equal(reading.finished, false);
  assert.equal(reading.error!.kind, 'auth');
  assert.match(reading.error!.message, /Incorrect API key provided/);
});
