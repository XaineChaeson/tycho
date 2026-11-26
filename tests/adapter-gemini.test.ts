// Guards against: the gemini adapter drifting from what `agy` 1.5.9 really prints (replaying
// sanitized recordings), passing `--settings` with keys agy rejects or without `--effort`,
// passing `-m`/`--model` or missing `--add-dir` / `--conversation`, leaking cross-turn totals
// from `result.usage` instead of summing `step_update` deltas, confusing `print_timeout` or
// interrupted runs with completed failures, dropping or duplicating `text_delta` / tool calls,
// missing forbidden permission keys in `checkTier`, and claiming credentials/readOnly/canRoute
// that `agy` does not enforce.
import './guard.ts';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { geminiAdapter, readGeminiSignIn } from '../adapters/gemini.ts';
import type { NormalizedEvent, Turn } from '../adapters/types.ts';

const DIR = join(import.meta.dirname, 'fixtures', 'gemini', '1.5.9-win');

function recording(name: string) {
  const read = (suffix: string) => readFileSync(join(DIR, `${name}.${suffix}`), 'utf8');
  const stdout = read('ndjson');
  const stderr = read('stderr');
  const exitCode = Number(read('exit'));
  const events = stdout
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => geminiAdapter.parse(line));
  return { stdout, stderr, exitCode, events, reading: geminiAdapter.result(stdout, exitCode, stderr) };
}

function ofKind<K extends NormalizedEvent['kind']>(events: NormalizedEvent[], kind: K) {
  return events.filter((event): event is Extract<NormalizedEvent, { kind: K }> => event.kind === kind);
}

const TURN: Turn = {
  prompt: '实现功能',
  workdir: '/work/repo',
  materialsDir: '/work/materials',
  artifactsDir: '/work/artifacts',
  tier: { kind: 'content', text: '{\n  "model": "gemini-4-carbon-high",\n  "effort": "high"\n}\n' },
  tierPath: '/work/runs/r1/snapshot/tier.json',
};

test('adapter declarations stay honest to agy 1.5.9 capabilities', () => {
  assert.equal(geminiAdapter.resumable, true);
  assert.deepEqual(geminiAdapter.permissionModes, ['dangerously-skip-permissions', 'accept-edits', 'auto', 'plan']);
  assert.equal(geminiAdapter.loginStatus, undefined);
  assert.deepEqual(geminiAdapter.credential!({}), { variable: 'GEMINI_API_KEY' });
  assert.equal(geminiAdapter.credentialCheck, undefined);
  assert.deepEqual(geminiAdapter.accountLogin, ['machine', 'key', 'provider']);
  assert.ok(geminiAdapter.provider);
  assert.deepEqual(geminiAdapter.signIn?.argv, ['agy', 'acp', '--login']);
  assert.equal(geminiAdapter.signIn?.acceptsCode, true);
  assert.equal(geminiAdapter.signIn?.minVersion?.version, '1.5.0');
  assert.equal(geminiAdapter.readOnly, undefined);
  assert.equal(geminiAdapter.canRoute, true);
  assert.equal(geminiAdapter.minVersion, undefined);
  assert.deepEqual(geminiAdapter.globalEntry?.home, { dir: '.gemini' });
  assert.equal(geminiAdapter.globalEntry?.file, 'AGENTS.md');
  assert.equal(geminiAdapter.globalEntry?.offInRound, undefined);
  assert.equal(geminiAdapter.memory?.scope, 'shared');
  assert.equal(geminiAdapter.mcpOff, undefined);
});

test('launch passes settings, effort, permission mode, and directories without --model', () => {
  const launched = geminiAdapter.launch(TURN);
  assert.deepEqual(launched, {
    argv: [
      'agy',
      '-p', '实现功能',
      '--output-format', 'stream-json',
      '--settings', '/work/runs/r1/snapshot/tier.json',
      '--effort', 'high',
      '--dangerously-skip-permissions',
      '--add-dir', '/work/repo',
      '--add-dir', '/work/materials',
      '--add-dir', '/work/artifacts',
    ],
    env: {},
  });
  assert.ok(!launched.argv.includes('--model') && !launched.argv.includes('-m'));
});

test('launch handles empty content, effort omission, modes, duplicate dirs, and readOnly artifactsDir', () => {
  const emptyTier: Turn = { ...TURN, tier: { kind: 'content', text: '   \n' } };
  assert.ok(!geminiAdapter.launch(emptyTier).argv.includes('--settings'));
  assert.ok(!geminiAdapter.launch(emptyTier).argv.includes('--effort'));

  const managedEmptyTier: Turn = { ...emptyTier, managedAccount: true };
  assert.ok(geminiAdapter.launch(managedEmptyTier).argv.includes('--settings'));
  assert.ok(!geminiAdapter.launch(managedEmptyTier).argv.includes('--effort'));

  const noEffort: Turn = { ...TURN, tier: { kind: 'content', text: '{"model":"gemini-4-carbon-high"}' } };
  const noEffortArgv = geminiAdapter.launch(noEffort).argv;
  assert.ok(noEffortArgv.includes('--settings'));
  assert.ok(!noEffortArgv.includes('--effort'));

  assert.throws(() => geminiAdapter.launch({ ...TURN, tierPath: undefined }), /快照路径/);

  assert.ok(geminiAdapter.launch({ ...TURN, permissionMode: 'dangerously-skip-permissions' }).argv.includes('--dangerously-skip-permissions'));
  for (const mode of ['accept-edits', 'auto', 'plan']) {
    const argv = geminiAdapter.launch({ ...TURN, permissionMode: mode }).argv;
    assert.ok(!argv.includes('--dangerously-skip-permissions'));
    assert.equal(argv[argv.indexOf('--mode') + 1], mode);
  }

  const roArgv = geminiAdapter.launch({ ...TURN, readOnly: true, materialsDir: '/work/repo' }).argv;
  const dirs: string[] = [];
  for (let i = 0; i < roArgv.length; i++) if (roArgv[i] === '--add-dir') dirs.push(roArgv[i + 1]!);
  assert.deepEqual(dirs, ['/work/repo', '/work/artifacts']);
});

test('resume passes --conversation sessionRef and refuses a turn without sessionRef', () => {
  const resumed = geminiAdapter.resume({ ...TURN, sessionRef: 'conv-42' });
  const at = resumed.argv.indexOf('--conversation');
  assert.ok(at > 0);
  assert.equal(resumed.argv[at + 1], 'conv-42');
  assert.ok(!resumed.argv.includes('--model') && !resumed.argv.includes('-m'));
  assert.deepEqual(resumed.env, {});
  assert.throws(() => geminiAdapter.resume(TURN));
  assert.throws(() => geminiAdapter.resume({ ...TURN, sessionRef: '  ' }));
});

test('normal recording (tools): pairs tools, extracts exitCode & changes, sums incremental usage', () => {
  const { exitCode, events, reading } = recording('tools');
  assert.equal(exitCode, 0);

  const starts = ofKind(events, 'tool.start');
  assert.deepEqual(starts.map(({ id, category, name }) => [id, category, name]), [
    ['step_2', 'read', 'read_file'],
    ['step_3', 'read', 'read_file'],
    ['step_4', 'edit', 'write_file'],
    ['step_5', 'run', 'run_command'],
    ['step_7', 'edit', 'edit_file'],
  ]);
  assert.deepEqual(starts[0]?.paths, ['C:\\work\\probe\\repo\\README.md']);
  assert.equal(starts[3]?.input, 'node -e "console.log(\'RAN-CMD\')"');

  const ends = ofKind(events, 'tool.end');
  assert.equal(ends.length, starts.length);
  assert.deepEqual(ends[0], { kind: 'tool.end', id: 'step_2', isError: false, output: { text: '2 lines, 23 bytes' } });
  assert.deepEqual(ends[1], { kind: 'tool.end', id: 'step_3', isError: true, reason: 'file does not exist' });
  assert.deepEqual(ends[2], { kind: 'tool.end', id: 'step_4', isError: false, changes: [{ path: 'C:\\work\\probe\\artifacts\\report.txt', op: 'add' }] });
  assert.equal(ends[3]?.id, 'step_5');
  assert.equal(ends[3]?.isError, false);
  assert.equal(ends[3]?.exitCode, 0);
  assert.match(ends[3]?.output?.text ?? '', /RAN-CMD/);
  assert.deepEqual(ends[4], { kind: 'tool.end', id: 'step_7', isError: false, changes: [{ path: 'C:\\work\\probe\\repo\\README.md', op: 'update' }] });

  assert.equal(ofKind(events, 'text').map((each) => each.text).join(''), 'DONE-42\n');
  assert.equal(ofKind(events, 'diagnostic').length, 0);
  assert.equal(ofKind(events, 'turn.end').length, 1);
  assert.equal(events.at(-1)?.kind, 'turn.end');

  assert.deepEqual(reading, {
    text: 'DONE-42\n',
    sessionRef: 'bfa01e59-ca2f-40b0-b1f4-1b48d6dea242',
    usage: [{ inputTokens: 14350, outputTokens: 416, cacheReadTokens: 15273, cacheWriteTokens: 0 }],
    finished: true,
  });
});

test('resume recording uses step_update incremental usage instead of cumulative result.usage', () => {
  const { exitCode, events, reading } = recording('resume');
  assert.equal(exitCode, 0);
  assert.equal(reading.sessionRef, 'bfa01e59-ca2f-40b0-b1f4-1b48d6dea242');
  assert.equal(reading.finished, true);
  assert.equal(reading.error, undefined);
  assert.equal(ofKind(events, 'text').map((each) => each.text).join(''), reading.text);
  assert.match(reading.text ?? '', /DELIVERED-OK/);
  // result.usage reports cumulative 16626 / 529 / 23471 across turns; this turn spent 2276 / 113 / 8198.
  assert.deepEqual(reading.usage, [{ inputTokens: 2276, outputTokens: 113, cacheReadTokens: 8198, cacheWriteTokens: 0 }]);
});

test('timeout recording is unfinished with other error', () => {
  const { exitCode, reading } = recording('timeout');
  assert.equal(exitCode, 3);
  assert.equal(reading.finished, false);
  assert.equal(reading.sessionRef, '28cbcbe8-6f9b-47a6-807c-7f787726a4f4');
  assert.equal(reading.error?.kind, 'other');
  assert.match(reading.error?.message ?? '', /print timeout/);
});

test('failure-auth recording is finished with auth error and fatal diagnostic', () => {
  const { exitCode, events, reading } = recording('failure-auth');
  assert.equal(exitCode, 3);
  assert.equal(reading.finished, true);
  assert.equal(reading.sessionRef, '87132c4d-6830-422a-ac59-c3876f97e8c3');
  assert.equal(reading.error?.kind, 'auth');
  assert.match(reading.error?.message ?? '', /API key not valid|API_KEY_INVALID/);
  const [diag] = ofKind(events, 'diagnostic');
  assert.equal(diag?.level, 'fatal');
  assert.equal(diag?.cause, 'auth');
});

test('interrupted and launch-failure edge cases keep sessionRef or verbatim stderr', () => {
  const initLine = JSON.stringify({ event: 'init', conversation_id: 's-interrupted', init: {} });
  assert.deepEqual(geminiAdapter.result(initLine, null, ''), {
    sessionRef: 's-interrupted',
    finished: false,
  });

  const launchFail = geminiAdapter.result('', 2, 'Worker 没能启动：bad flag\n');
  assert.equal(launchFail.finished, false);
  assert.equal(launchFail.error?.kind, 'other');
  assert.equal(launchFail.error?.message, 'Worker 没能启动：bad flag');
});

test('classifies quota, auth, and transient/server failures', () => {
  const errResult = (error: string) =>
    geminiAdapter.result(JSON.stringify({ event: 'result', result: { conversation_id: 'c1', status: 'ERROR', error, finished_reason: 'error' } }), 3, '');
  assert.equal(errResult('Error 429 RESOURCE_EXHAUSTED: quota exceeded').error?.kind, 'quota');
  assert.equal(errResult('HTTP 402 payment required').error?.kind, 'quota');
  assert.equal(errResult('Error 401 UNAUTHENTICATED: not logged in').error?.kind, 'auth');
  assert.equal(errResult('Error 403 forbidden').error?.kind, 'auth');
  assert.equal(errResult('Error 500 internal DEADLINE_EXCEEDED').error?.kind, 'other');
});

test('malformed lines yield nothing and never throw in parse or result', () => {
  for (const line of ['', 'not-json', 'null', '[1]', '{"event":"unknown"}', '{"event":"step_update"}']) {
    assert.deepEqual(geminiAdapter.parse(line), []);
  }
  const reading = geminiAdapter.result(['noise', '[]', JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: 'ok' } })].join('\n'), 0, '');
  assert.deepEqual(reading, { text: 'ok', finished: true });
});

test('checkTier validates settings JSON and effort while allowing native keys including modelProvider', () => {
  assert.equal(geminiAdapter.checkTier!({ kind: 'content', text: '' }), undefined);
  assert.equal(geminiAdapter.checkTier!({ kind: 'content', text: '   ' }), undefined);
  assert.equal(geminiAdapter.checkTier!({ kind: 'content', text: '{}' }), undefined);
  assert.equal(geminiAdapter.checkTier!({ kind: 'content', text: '{"model":"gemini-4-carbon-high","effort":"high"}' }), undefined);
  for (const key of ['agentMode', 'toolPermission', 'permissions', 'enableTerminalSandbox', 'allowNonWorkspaceAccess', 'modelProvider']) {
    assert.equal(geminiAdapter.checkTier!({ kind: 'content', text: JSON.stringify({ model: 'gemini-4-carbon-high', [key]: 'x' }) }), undefined, key);
  }

  for (const bad of ['{', '[1]', '"str"', '123', '{"effort":1}', '{"effort":"  "}']) {
    assert.ok(geminiAdapter.checkTier!({ kind: 'content', text: bad }), bad);
  }
});

test('listModels uses HTTP Generative Language API when token is given, and agy models command otherwise', () => {
  const cmdQuery = geminiAdapter.listModels!({});
  assert.equal(cmdQuery.kind, 'command');
  if (cmdQuery.kind === 'command') {
    assert.deepEqual(cmdQuery.argv, ['agy', 'models']);
    assert.deepEqual(cmdQuery.parse('gemini-2.5-pro\tGemini 2.5 Pro\n'), [{ id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro' }]);
  }

  const httpQuery = geminiAdapter.listModels!({ token: 'AIzaTestKey123' });
  assert.equal(httpQuery.kind, 'http');
  if (httpQuery.kind === 'http') {
    assert.equal(httpQuery.url, 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=100');
    assert.deepEqual(httpQuery.headers, { 'x-goog-api-key': 'AIzaTestKey123' });
    const parsed = httpQuery.parse(JSON.stringify({
      models: [
        { name: 'models/gemini-2.5-pro', displayName: 'Gemini 2.5 Pro', supportedGenerationMethods: ['generateContent', 'countTokens'] },
        { name: 'models/text-embedding-004', displayName: 'Text Embedding 004', supportedGenerationMethods: ['embedContent'] },
        { name: 'models/gemini-2.5-flash', displayName: 'gemini-2.5-flash' },
      ],
    }));
    assert.deepEqual(parsed, [
      { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro' },
      { id: 'gemini-2.5-flash' },
    ]);
    assert.deepEqual(httpQuery.parse('not-json'), []);
  }
});

test('custom Gemini gateway line injects GOOGLE_GEMINI_BASE_URL and discovers models across Gemini and OpenAI shapes', () => {
  const checked = geminiAdapter.provider!.check({
    line: 'custom',
    baseURL: 'https://gemini-proxy.internal:8317/',
  });
  assert.ok('provider' in checked);
  const { provider } = checked;

  const launched = geminiAdapter.launch({ ...TURN, provider });
  assert.deepEqual(launched.env, { GOOGLE_GEMINI_BASE_URL: 'https://gemini-proxy.internal:8317' });

  const resumed = geminiAdapter.resume!({ ...TURN, provider, sessionRef: 'conv-123' });
  assert.deepEqual(resumed.env, { GOOGLE_GEMINI_BASE_URL: 'https://gemini-proxy.internal:8317' });

  assert.equal(geminiAdapter.provider!.models(provider), undefined);
  const disc = geminiAdapter.provider!.discover(provider, 'proxy-secret-key')!;
  assert.equal(disc.url, 'https://gemini-proxy.internal:8317/v1beta/models?pageSize=100');
  assert.deepEqual(disc.headers, {
    'x-goog-api-key': 'proxy-secret-key',
    authorization: 'Bearer proxy-secret-key',
  });
  assert.deepEqual(
    disc.parse(JSON.stringify({ data: [{ id: 'gemini-3.1-pro' }, { id: 'models/gemini-2.5-flash' }] })),
    [{ id: 'gemini-3.1-pro' }, { id: 'gemini-2.5-flash' }],
  );

  // Rejects credentials embedded in URL.
  const badUrl = geminiAdapter.provider!.check({ line: 'custom', baseURL: 'https://user:pass@proxy.example.com' });
  assert.ok('problem' in badUrl);
});

test('readGeminiSignIn extracts Google OAuth URL only after paste prompt appears and strips ANSI sequences', () => {
  const url = 'https://accounts.google.com/o/oauth2/auth?access_type=offline&client_id=123.apps.googleusercontent.com&redirect_uri=https%3A%2F%2Fantigravity.google%2Foauth-callback&response_type=code&state=abc';
  const screen = [
    'Open this link in a browser to log in with Google:',
    '',
    `  ${url}`,
    '',
    'Then paste the authorization code, or the full URL of the page you land on, and press Enter: ',
  ].join('\n');

  assert.deepEqual(readGeminiSignIn(screen), { url });
  assert.deepEqual(readGeminiSignIn(`\x1b[36m${screen}\x1b[0m`), { url });

  // Partial output without the stdin prompt must wait so a truncated URL is never shown.
  const beforePrompt = screen.slice(0, screen.indexOf('Then paste'));
  assert.equal(readGeminiSignIn(beforePrompt), undefined);
  assert.equal(readGeminiSignIn(''), undefined);
  assert.equal(readGeminiSignIn('Error: unknown flag --login\n'), undefined);
  assert.doesNotThrow(() => readGeminiSignIn(undefined as unknown as string));
});
