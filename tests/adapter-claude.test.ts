// Guards against: the adapter drifting from what the CLI really prints (every
// case replays a recording), trusting subtype instead of is_error, losing the
// session reference a resume needs, showing a text twice, a run with no result
// line passing as a success, and a malformed line changing a Run's fate. And the
// account's quota: a window the CLI reported dropped or given the wrong share or reset
// time, a line with no share in it read as usage, a used-up account classified as an
// ordinary failure or a login problem, and the time the quota comes back taken from the
// sentence for people instead of from the CLI's own field, or attached to a login failure.
// And for the page: a call's input, title or file lost, a result's output or refusal
// reason lost or swapped, a file change claimed with a patch the CLI never gave, and a
// retry read as a failure.
// And a round's use: a resumed round counted with the rounds before it (the CLI's cumulative
// figures), a price taken on a basis other than list prices, or the model it ran lost.
import './guard.ts';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { claudeAdapter } from '../adapters/claude.ts';
import type { NormalizedEvent, Tier, Turn } from '../adapters/types.ts';

const DIR = join(import.meta.dirname, 'fixtures', 'claude', '2.1.309-win');

function recording(name: string, dir = DIR) {
  const stdout = readFileSync(join(dir, `${name}.ndjson`), 'utf8');
  const stderr = readFileSync(join(dir, `${name}.stderr`), 'utf8');
  const exitCode = Number(readFileSync(join(dir, `${name}.exit`), 'utf8'));
  const events = stdout
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => claudeAdapter.parse(line));
  return { stdout, stderr, exitCode, events, reading: claudeAdapter.result(stdout, exitCode, stderr) };
}

test('non-objects in a content array are skipped', () => {
  for (const type of ['assistant', 'user']) {
    assert.deepEqual(claudeAdapter.parse(JSON.stringify({ type, message: { content: [null, 1, 'x'] } })), []);
  }
});

const TIER: Tier = { kind: 'content', text: '{"model":"m"}\n' };
const TURN: Turn = { prompt: '做事', workdir: '.', tier: TIER, tierPath: 'runs/r1/snapshot/tier.json' };

function ofKind<K extends NormalizedEvent['kind']>(events: NormalizedEvent[], kind: K) {
  return events.filter((event): event is Extract<NormalizedEvent, { kind: K }> => event.kind === kind);
}

test('launch builds the one driving command and names no model', () => {
  const { argv, env } = claudeAdapter.launch(TURN);
  assert.deepEqual(argv, [
    'claude',
    '-p',
    '做事',
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--settings',
    'runs/r1/snapshot/tier.json',
    '--permission-mode',
    'bypassPermissions',
    '--add-dir',
    '.',
  ]);
  // The machine's own configuration and auto memory pass through: nothing but the sandbox mark.
  assert.deepEqual(env, { IS_SANDBOX: '1' });
  assert.ok(!argv.includes('--model') && !argv.includes('-m'));
});

// The CLI takes a settings file or a JSON string; the file is what tycho hands it, so the
// tier's text never reaches a command line, and a resumed round reads the very file its
// own snapshot wrote.
test('the tier is read from the snapshot, and a resume reads the same', () => {
  const settings = (turn: Turn) => { const { argv } = claudeAdapter.launch(turn); return argv[argv.indexOf('--settings') + 1]; };
  const tier: Tier = { kind: 'content', text: '{"model":"m","effortLevel":"high"}' };
  const first: Turn = { ...TURN, tier, tierPath: 'runs/r1/snapshot/tier.json' };
  const again: Turn = { ...first, sessionRef: 's1' };
  assert.equal(settings(first), 'runs/r1/snapshot/tier.json');
  // The resumed round is handed the tier its own snapshot recorded: the same file.
  assert.equal(settings(again), 'runs/r1/snapshot/tier.json');
  assert.deepEqual(claudeAdapter.resume(again).argv.slice(-2), ['--resume', 's1']);
  // Content with nowhere to read it from is a broken turn, not a round on the machine's
  // own tier: nothing is sent.
  assert.throws(() => claudeAdapter.launch({ ...first, tierPath: undefined }), /快照路径/);
});

test('a Worker has to run commands: the default mode lets it, and a target can name another', () => {
  const mode = (turn: Turn) => { const { argv } = claudeAdapter.launch(turn); return argv[argv.indexOf('--permission-mode') + 1]; };
  assert.equal(mode(TURN), 'bypassPermissions');
  assert.equal(mode({ ...TURN, permissionMode: 'acceptEdits' }), 'acceptEdits');
  assert.equal(claudeAdapter.launch({ ...TURN, permissionMode: 'acceptEdits' }).env.IS_SANDBOX, undefined);
  assert.equal(claudeAdapter.resume({ ...TURN, sessionRef: 's' }).env.IS_SANDBOX, '1');
  assert.deepEqual(claudeAdapter.credential!({}), { variable: 'CLAUDE_CODE_OAUTH_TOKEN' });
  assert.equal(claudeAdapter.resume({ ...TURN, permissionMode: 'acceptEdits', sessionRef: 's' }).argv.includes('acceptEdits'), true);
});

// The organization a machine's own Claude login belongs to, from the same `auth status` answer
// the login probe already read: no second command, and only a well-formed personal id when the
// subscription is pro/max. An account email never becomes an identity.
test('login identity keeps only a validated masked identity, plan, and personal organization', () => {
  const dir = join(import.meta.dirname, 'fixtures', 'claude', '2.1.303-win', 'auth-status');
  const identity = (json: string) => claudeAdapter.loginIdentity!(json, '');
  assert.deepEqual(identity(readFileSync(join(dir, 'machine-login.json'), 'utf8')), { organizationId: '00000000-0000-0000-0000-000000000000', accountLabel: 'owner@e***.com', planLabel: 'Max' });
  assert.deepEqual(identity(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'team', orgId: '00000000-0000-0000-0000-000000000000', email: 'sample@example.test' })), { organizationId: null, accountLabel: 'sample@e***.test', planLabel: 'Team' });
  assert.deepEqual(identity(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', email: 'bad name@example.test' })), { organizationId: null, accountLabel: null, planLabel: null });
  assert.deepEqual(identity(JSON.stringify({ loggedIn: false, authMethod: 'claude.ai', email: 'sample@example.test' })), { organizationId: null, accountLabel: null, planLabel: null });
  assert.deepEqual(identity('not json'), {});
});

// A valid `/usage` answer that lists no window line is "absent", not a broken read: the last
// figures stay and the page says so neutrally. Only an answer that cannot be read is a problem.
test('a valid /usage answer with no window line is absent, not a problem', () => {
  const quota = claudeAdapter.machineQuota!;
  assert.equal(quota.kind, 'command');
  const parse = quota.kind === 'command' ? quota.parse : () => ({ problem: 'unreachable' });
  assert.deepEqual(parse(JSON.stringify({ type: 'result', result: "You are currently using your subscription to power your Claude Code usage\n" })), { windows: [], absent: true });
  assert.match((parse('not json') as { problem: string }).problem, /读不出来/);
  assert.deepEqual(parse(JSON.stringify({ type: 'result', result: 'Current session: 5% used · resets in 3 hr\n' })), { windows: [{ window: 'five_hour', used: 0.05, resets_at: null }] });
  assert.deepEqual(parse(JSON.stringify({ type: 'result', is_error: true, result: 'private diagnostic' })), { problem: 'claude 没有完成额度读取' });
});

// Under Occam's Razor, credentialCheck is no longer declared as a dispatch blocker.
test('credential check blocker is not declared on the adapter', () => {
  assert.equal(claudeAdapter.credentialCheck, undefined);
});

// What the dispatcher and the account check read instead of knowing this executor by name.
test('the adapter declares that it continues a session, and the modes the CLI takes', () => {
  assert.equal(claudeAdapter.resumable, true);
  assert.deepEqual(claudeAdapter.permissionModes, ['bypassPermissions', 'acceptEdits', 'default', 'plan']);
});

test('launch passes native auto memory and MCPs through without CLAUDE_CODE_DISABLE_AUTO_MEMORY or --disallowedTools', () => {
  const launch = claudeAdapter.launch({ ...TURN, memoryOff: true, mcpOff: ['tycho-knowledge'], artifactsDir: '/work/artifacts', readOnly: true });
  assert.deepEqual(launch.env, { IS_SANDBOX: '1' });
  assert.equal(launch.argv.includes('--disallowedTools'), false);
  assert.equal(launch.argv[launch.argv.lastIndexOf('--add-dir') + 1], '/work/artifacts');
});

// Recorded on a cluster instance (Linux, CLI 2.1.312): the same task under two modes.
const LINUX = join(import.meta.dirname, 'fixtures', 'claude', '2.1.312-linux');

test('linux, commands allowed: every tool call ends, and the result reads as finished', () => {
  const { events, reading } = recording('tools', LINUX);
  const started = ofKind(events, 'tool.start');
  assert.equal(started.length, 2, '这份实录里是两次工具调用：写文件，再一条命令做完其余的');
  assert.equal(ofKind(events, 'tool.end').length, started.length);
  assert.equal(ofKind(events, 'diagnostic').length, 0);
  assert.equal(reading.finished, true);
  assert.equal(reading.error, undefined);
  assert.match(reading.text ?? '', /git init/);
});

test('linux, commands refused by the mode: the turn still ends as finished, and the refusals show as failed tool calls', () => {
  const { events, reading } = recording('denied', LINUX);
  assert.equal(reading.finished, true, '执行器自己把这算作成功：靠回执和现场区分');
  const ended = ofKind(events, 'tool.end');
  assert.ok(ended.some((event) => event.isError), '被拦下的命令要显示成失败的工具调用');
});

test('resume adds the session reference, and needs one', () => {
  const { argv } = claudeAdapter.resume({ ...TURN, sessionRef: 's-1' });
  assert.deepEqual(argv.slice(-2), ['--resume', 's-1']);
  assert.throws(() => claudeAdapter.resume(TURN));
});

test('normal: text arrives once, the turn ends, and the result reads as finished', () => {
  const { events, reading } = recording('normal');
  assert.deepEqual(ofKind(events, 'text'), [{ kind: 'text', text: '好的' }]);
  assert.equal(ofKind(events, 'turn.end').length, 1);
  assert.equal(events.at(-1)?.kind, 'turn.end');
  assert.equal(ofKind(events, 'usage')[0]?.usage[0]?.outputTokens, 4);
  assert.equal(ofKind(events, 'diagnostic').length, 0);
  assert.equal(reading.text, '好的');
  assert.equal(reading.sessionRef, '8e79cd8b-0337-4872-a11a-b2872f3afbb1');
  assert.equal(reading.finished, true);
  assert.equal(reading.error, undefined);
  assert.deepEqual(reading.usage, [{ model: 'claude-opus-5-5', inputTokens: 2, outputTokens: 4, cacheReadTokens: 3396, cacheWriteTokens: 6539, listCostUsd: 0.0530792 }]);
});

test('a resumed round counts its own use, not that of the session before it', () => {
  // The recorded result line's cumulative figures are 6 in, 11 out; this turn's are 4 and 7.
  assert.deepEqual(recording('resume').reading.usage, [{ model: 'claude-opus-5-5', inputTokens: 4, outputTokens: 7, cacheReadTokens: 8514, cacheWriteTokens: 1444, listCostUsd: 0.0134108 }]);
});

test('use is added per model across result lines; a price on another basis, and a CLI without per-model figures, give none', () => {
  const result = (since: unknown, usage?: unknown) => JSON.stringify({ type: 'result', is_error: false, result: 'ok', session_id: 's', model_usage_since_last_result: since, ...(usage ? { usage } : {}) });
  const figures = (input: number, cost: number, basis = 'list') => ({ inputTokens: input, outputTokens: 1, cacheReadInputTokens: 2, cacheCreationInputTokens: 3, costUSD: cost, costBasis: basis });
  const stdout = [result({ big: figures(10, 0.5), small: figures(1, 0.1) }), result({ big: figures(5, 0.25), small: figures(1, 0.1, 'subscription') })].join('\n');
  assert.deepEqual(claudeAdapter.result(stdout, 0, '').usage, [
    { model: 'big', inputTokens: 15, outputTokens: 2, cacheReadTokens: 4, cacheWriteTokens: 6, listCostUsd: 0.75 },
    { model: 'small', inputTokens: 2, outputTokens: 2, cacheReadTokens: 4, cacheWriteTokens: 6 },
  ]);
  const old = JSON.stringify({ type: 'result', is_error: false, result: 'ok', session_id: 's', total_cost_usd: 9, usage: { input_tokens: 7, output_tokens: 8, cache_read_input_tokens: 9, cache_creation_input_tokens: 10 } });
  assert.deepEqual(claudeAdapter.result(old, 0, '').usage, [{ inputTokens: 7, outputTokens: 8, cacheReadTokens: 9, cacheWriteTokens: 10 }]);
});

test('resume: same session continues', () => {
  const { events, reading } = recording('resume');
  assert.deepEqual(ofKind(events, 'text'), [{ kind: 'text', text: '青松-7429' }]);
  assert.equal(reading.sessionRef, '8e79cd8b-0337-4872-a11a-b2872f3afbb1');
  assert.equal(reading.finished, true);
  assert.equal(reading.error, undefined);
});

test('failure: ten retries then an error, though subtype says success', () => {
  const { stdout, events, reading, exitCode } = recording('failure');
  assert.match(stdout, /"subtype":"success"/);
  assert.equal(exitCode, 1);
  const said = ofKind(events, 'diagnostic');
  const retries = said.filter((event) => event.level === 'recovering');
  assert.equal(retries.length, 10);
  assert.deepEqual(retries[0], { kind: 'diagnostic', level: 'recovering', message: 'unknown', attempt: 1, maxRetries: 10 });
  const fatal = said.filter((event) => event.level === 'fatal');
  assert.equal(fatal.length, 1);
  assert.equal(fatal[0]?.cause, 'other');
  assert.ok(events.indexOf(fatal[0]!) > events.indexOf(retries.at(-1)!));
  assert.equal(reading.finished, true);
  assert.equal(reading.error?.kind, 'other');
  assert.match(reading.error?.message ?? '', /Connection refused/);
  assert.equal(reading.sessionRef, '76635a41-fdc9-478b-8d8e-60ea38fbae03');
});

test('is_error alone is a failure even with exit 0', () => {
  const stdout = JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: 'boom', session_id: 's' });
  assert.equal(claudeAdapter.result(stdout, 0, '').error?.message, 'boom');
});

test('a non-zero exit is a failure even when the result says fine', () => {
  const stdout = JSON.stringify({ type: 'result', is_error: false, result: '好', session_id: 's' });
  assert.equal(claudeAdapter.result(stdout, 2, 'stderr tail').error?.message, 'stderr tail');
});

test('no result line with an exit code is a failure carrying the end of stderr', () => {
  const stderr = `${'x'.repeat(5000)}the real cause`;
  const reading = claudeAdapter.result('', 1, stderr);
  assert.equal(reading.finished, false);
  assert.ok(reading.error?.message.endsWith('the real cause'));
  assert.ok((reading.error?.message.length ?? 0) < 5000);
});

test('no result line with exit 0 is a failure too', () => {
  assert.equal(claudeAdapter.result('', 0, '').error?.kind, 'other');
});

test('no result line and no exit code is unfinished, not failed, and keeps the session', () => {
  const init = JSON.stringify({ type: 'system', subtype: 'init', session_id: 's-9' });
  assert.deepEqual(claudeAdapter.result(init, null, ''), { sessionRef: 's-9', finished: false });
});

test('quota and login failures are told apart from other errors', () => {
  const failed = (fields: object) =>
    claudeAdapter.result(JSON.stringify({ type: 'result', is_error: true, result: 'x', ...fields }), 1, '').error?.kind;
  assert.equal(failed({ api_error_status: 429 }), 'quota');
  assert.equal(failed({ api_error_status: 401 }), 'auth');
  assert.equal(failed({ api_error_status: 500 }), 'other');
  const lines = [
    JSON.stringify({ type: 'assistant', error: 'rate_limit', is_api_error_message: true, message: { content: [] } }),
    JSON.stringify({ type: 'result', is_error: true, result: 'x' }),
  ];
  assert.equal(claudeAdapter.result(lines.join('\n'), 1, '').error?.kind, 'quota');
});

// The names beyond Bash and Write are not recorded: the category table follows the CLI's
// own tool list.
test('tool calls map to a category and keep the original name', () => {
  const assistant = {
    type: 'assistant',
    message: {
      content: [
        { type: 'tool_use', id: 't1', name: 'Read', input: {} },
        { type: 'tool_use', id: 't2', name: 'Edit', input: {} },
        { type: 'tool_use', id: 't3', name: 'Bash', input: {} },
        { type: 'tool_use', id: 't4', name: 'Grep', input: {} },
        { type: 'tool_use', id: 't5', name: 'mcp__x__y', input: {} },
      ],
    },
  };
  const events = claudeAdapter.parse(JSON.stringify(assistant));
  assert.deepEqual(
    events.map((event) => (event.kind === 'tool.start' ? [event.category, event.name] : [])),
    [
      ['read', 'Read'],
      ['edit', 'Edit'],
      ['run', 'Bash'],
      ['search', 'Grep'],
      ['other', 'mcp__x__y'],
    ],
  );
  const user = { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true }] } };
  assert.deepEqual(claudeAdapter.parse(JSON.stringify(user)), [{ kind: 'tool.end', id: 't1', isError: true }]);
});

// Recorded (2.1.312-linux): a Bash call says what it does and carries its command; its
// result is the text the model got back. A Write names its file, and its result says it
// created it. A refused command's text is the reason it failed, not output.
test('linux recordings: a call keeps its input and title, its end keeps the output, a reason, the file it changed', () => {
  const tools = recording('tools', LINUX).events;
  const [bash] = ofKind(tools, 'tool.start');
  assert.equal(bash?.name, 'Bash');
  assert.equal(bash?.title, 'Inspect directory and initialize a git repository');
  assert.equal(bash?.input, `pwd && ls -la; echo '--- git init'; git init; echo "--- exit=$?"`);
  const [first] = ofKind(tools, 'tool.end');
  assert.match(first?.output?.text ?? '', /Initialized empty Git repository/);
  assert.equal(first?.exitCode, undefined, 'Claude 的结果里没有退出码，不编一个');

  const denied = recording('denied', LINUX).events;
  const write = ofKind(denied, 'tool.start').find((event) => event.name === 'Write')!;
  assert.deepEqual([write.category, write.title, write.paths], ['edit', '/home/dev/tycho-probe/acceptEdits/a.py', ['/home/dev/tycho-probe/acceptEdits/a.py']]);
  assert.equal(JSON.parse(write.input ?? '').content, 'print(6*7)\n');
  const ends = ofKind(denied, 'tool.end');
  const written = ends.find((event) => event.id === write.id)!;
  assert.deepEqual(written.changes, [{ path: '/home/dev/tycho-probe/acceptEdits/a.py', op: 'add' }], '整份写入没有 patch，就不给 diff');
  const refused = ends.find((event) => event.isError)!;
  assert.equal(refused.reason, 'This command requires approval');
  assert.equal(refused.output, undefined);
});

// From the CLI's own result type, not a recording: an edit hands back its hunks.
test('an edit that hands back its hunks has a patch', () => {
  const user = {
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: 'e', content: [{ type: 'text', text: 'updated' }] }] },
    tool_use_result: { filePath: 'a.ts', type: 'update', structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+b'] }] },
  };
  assert.deepEqual(claudeAdapter.parse(JSON.stringify(user)), [{
    kind: 'tool.end', id: 'e', isError: false, output: { text: 'updated' },
    changes: [{ path: 'a.ts', op: 'update', patch: '@@ -1,1 +1,1 @@\n-a\n+b' }],
  }]);
});

test('a line that is not JSON, or not a known shape, yields nothing', () => {
  for (const line of ['', 'not json', '[1]', 'null', '{"type":"assistant"}', '{"type":"stream_event"}']) {
    assert.deepEqual(claudeAdapter.parse(line), []);
  }
});

// The quota an account has left. The windows are recorded (both CLI versions); the
// used-up account is the coordinator's sample, see fixtures/claude/coordinator-sample.
const SAMPLE = join(import.meta.dirname, 'fixtures', 'claude', 'coordinator-sample');

test('recorded quota windows become one event each, with the share used and when it starts over', () => {
  assert.deepEqual(ofKind(recording('normal').events, 'quota'), [
    { kind: 'quota', window: 'five_hour', used: 0.63, resetsAt: new Date(1793795400 * 1000).toISOString() },
    { kind: 'quota', window: 'seven_day', used: 0.66, resetsAt: new Date(1794081600 * 1000).toISOString() },
  ]);
  const linux = ofKind(recording('tools', join(import.meta.dirname, 'fixtures', 'claude', '2.1.312-linux')).events, 'quota');
  assert.deepEqual(linux.map(({ window, used }) => [window, used]), [['five_hour', 0.2], ['seven_day', 0.17]]);
});

test('a quota line with no share in it says nothing, and never fails a parse', () => {
  const line = (info: unknown) => claudeAdapter.parse(JSON.stringify({ type: 'rate_limit_event', rate_limit_info: info }));
  assert.deepEqual(line({ status: 'allowed', resetsAt: 1793795400, rateLimitType: 'five_hour' }), []);
  assert.deepEqual(line({ unifiedWindows: { five_hour: { utilization: 'most' }, seven_day: null, odd: { utilization: 7 } } }), []);
  assert.deepEqual(line(null), []);
  assert.deepEqual(line({ rateLimitType: '7d_oi', utilization: 0.5 }), [{ kind: 'quota', window: 'seven_day_fable', used: 0.5, resetsAt: null }]);
  assert.deepEqual(line({ unifiedWindows: { seven_day_overage_included: { utilization: 0.7 } } }), [{ kind: 'quota', window: 'seven_day_fable', used: 0.7, resetsAt: null }]);
  assert.deepEqual(line({ rateLimitType: 'five_hour', utilization: 0.5 }), [{ kind: 'quota', window: 'five_hour', used: 0.5, resetsAt: null }]);
});

test('a real run that hit its weekly limit is a quota failure, back when the limit that refused it starts over', () => {
  // Recorded on 2026-11-06: the end of a run that used up a seven-day window while its
  // five-hour window had plenty left. Telling them apart is why this reads the refusal's
  // own window and not the shortest one.
  const { reading, events } = recording('limit', join(import.meta.dirname, 'fixtures', 'claude', '2.1.309-win'));
  assert.equal(reading.error?.kind, 'quota');
  assert.match(reading.error!.message, /reached your .* limit/);
  assert.equal(reading.error?.resetsAt, new Date(1794081600 * 1000).toISOString());
  const windows = Object.fromEntries(ofKind(events, 'quota').map(({ window, used }) => [window, used]));
  assert.equal(windows['seven_day_fable'], 1);
  assert.equal(windows['five_hour'], 0.29);
});

test('a used-up account is a quota failure that carries when the quota comes back, not read from the sentence', () => {
  const { reading, events } = recording('quota', SAMPLE);
  assert.equal(reading.finished, true);
  assert.deepEqual(reading.error, {
    kind: 'quota',
    message: "You've hit your session limit · resets 6:40am (Asia/Shanghai)",
    resetsAt: new Date(1793918400 * 1000).toISOString(),
  });
  assert.deepEqual(ofKind(events, 'quota').map(({ window, used }) => [window, used]), [['five_hour', 0.99], ['seven_day', 0.51]]);
  assert.equal(ofKind(events, 'diagnostic')[0]?.cause, 'quota');
});

test('the sentence alone names a used-up account, and without a quota line there is no time to go by', () => {
  const said = JSON.stringify({ type: 'result', is_error: true, result: "You've hit your session limit · resets 6:40am (Asia/Shanghai)" });
  assert.deepEqual(claudeAdapter.result(said, 1, '').error, { kind: 'quota', message: "You've hit your session limit · resets 6:40am (Asia/Shanghai)" });
  const named = JSON.stringify({ type: 'result', is_error: true, result: 'x', api_error: 'usage_limit_reached' });
  assert.equal(claudeAdapter.result(named, 1, '').error?.kind, 'quota');
});

test('a login failure carries no time, whatever the quota lines said', () => {
  const lines = [
    JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { resetsAt: 1793918400, rateLimitType: 'five_hour' } }),
    JSON.stringify({ type: 'result', is_error: true, result: 'x', api_error_status: 401 }),
  ];
  assert.deepEqual(claudeAdapter.result(lines.join('\n'), 1, '').error, { kind: 'auth', message: 'x' });
});

test('a CLI without per-turn figures (2.1.303) gives the turn its main-thread use, under the one model it used, unpriced', () => {
  const stdout = readFileSync(join(import.meta.dirname, 'fixtures', 'claude', '2.1.303-win', 'quota-read.ndjson'), 'utf8');
  assert.deepEqual(claudeAdapter.result(stdout, 0, '').usage, [{ model: 'claude-opus-5-5', inputTokens: 2, outputTokens: 19, cacheReadTokens: 6535, cacheWriteTokens: 0 }]);
  assert.deepEqual(claudeAdapter.parse(stdout.split('\n')[0]!).filter((event) => event.kind === 'quota').map((event) => event.kind === 'quota' && event.used), [0.72]);
});
