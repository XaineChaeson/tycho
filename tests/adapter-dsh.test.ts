// Guards against: the adapter drifting from what dsh really prints (every case replays a
// recording), losing the session reference a resume needs, reading a turn that never ended
// as finished, reading a failed turn as success, letting a malformed line change a Run's
// fate, losing or doubling a text or a tool call, dropping the step usage or adding it up
// wrong, and telling a credential problem, a used-up quota and a transient rate limit
// apart the wrong way. Also the one thing dsh does not have: a command that says whether it
// is signed in. And: what the adapter declares about continuing a session and about the
// permission modes an account may name; a run that ends with an error line and no turn; a
// turn that ended for a reason other than `completed`, reported as itself; and a failure
// dsh recorded without a message, reported as what the Runner saw instead of as nothing.
// For the page: a call's input, title or file lost, and a result's output, reason or dsh's
// own truncation mark lost.
import './guard.ts';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { dshAdapter } from '../adapters/dsh.ts';
import type { NormalizedEvent, Turn } from '../adapters/types.ts';

const DIR = join(import.meta.dirname, 'fixtures', 'dsh', '0.2.2-rc.1');

function recording(name: string) {
  const read = (suffix: string) => readFileSync(join(DIR, `${name}.${suffix}`), 'utf8');
  const stdout = read('ndjson');
  const stderr = read('stderr');
  const exitCode = Number(read('exit'));
  const events = stdout
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => dshAdapter.parse(line));
  return { stdout, stderr, exitCode, events, reading: dshAdapter.result(stdout, exitCode, stderr) };
}

function ofKind<K extends NormalizedEvent['kind']>(events: NormalizedEvent[], kind: K) {
  return events.filter((event): event is Extract<NormalizedEvent, { kind: K }> => event.kind === kind);
}

// What the Runner hands a Worker: the task directory, which is `.` inside the machine, the
// tier as the ledger held it, and where the snapshot keeps its text.
const TURN: Turn = {
  prompt: '做事',
  workdir: '.',
  tier: { kind: 'content', text: '- id: agent-default-model\n' },
  tierPath: 'runs/r1/snapshot/tier.patch.yml',
};
// What a one-shot headless invocation is on the machine: the command name is `dsh`.
const HEAD = ['dsh', '--profile', 'headless', '--patch', 'runs/r1/snapshot/tier.patch.yml', '--json'];

test('launch builds the one driving command, names no model, and runs with the default permission', () => {
  assert.deepEqual(dshAdapter.launch(TURN), {
    argv: [...HEAD, '--permission-mode', 'danger-full-access', '--approval-policy', 'never', '做事'],
    env: {},
  });
  assert.ok(!dshAdapter.launch(TURN).argv.includes('--model') && !dshAdapter.launch(TURN).argv.includes('-m'));
});

test('the account can name another permission preset, and no login directory means the variable is not set', () => {
  const mode = (turn: Turn) => {
    const { argv } = dshAdapter.launch(turn);
    return argv[argv.indexOf('--permission-mode') + 1];
  };
  assert.equal(mode(TURN), 'danger-full-access');
  assert.equal(mode({ ...TURN, permissionMode: 'workspace-write' }), 'workspace-write');
  const { prompt, workdir, tier, tierPath } = TURN;
  assert.deepEqual(dshAdapter.launch({ prompt, workdir, tier, tierPath }).env, {});
});

// The text rides the snapshot, so `--patch` names the snapshot's own copy.
test('the tier is the snapshot file', () => {
  const patchOf = (turn: Turn): string => {
    const { argv } = dshAdapter.launch(turn);
    return argv[argv.indexOf('--patch') + 1]!;
  };
  assert.equal(patchOf(TURN), 'runs/r1/snapshot/tier.patch.yml');
  // Content without a snapshot path is a Runner mistake, not a command with no patch.
  assert.throws(() => dshAdapter.launch({ ...TURN, tierPath: undefined }), /快照路径/);
});

test('an empty tier never passes an empty patch to dsh', () => {
  const turn: Turn = { ...TURN, tier: { kind: 'content', text: '' } };
  assert.equal(dshAdapter.checkTier!(turn.tier), undefined);
  assert.ok(!dshAdapter.launch(turn).argv.includes('--patch'));
  assert.ok(!dshAdapter.resume({ ...turn, sessionRef: 's' }).argv.includes('--patch'));
});

test('resume adopts the session by id, and needs one', () => {
  assert.deepEqual(dshAdapter.resume({ ...TURN, sessionRef: 'session-1' }).argv, [
    ...HEAD,
    '--session-id',
    'session-1',
    '--permission-mode',
    'danger-full-access',
    '--approval-policy',
    'never',
    '做事',
  ]);
  assert.throws(() => dshAdapter.resume(TURN));
  assert.equal(dshAdapter.resume({ ...TURN, sessionRef: 's' }).env.DSH_HOME, undefined, '机器自己的 dsh 目录照常');
});

// dsh answers one task and exits; nothing in its command line reports who is signed in, so
// the service must not be handed a command to run.
test('no login-status command is claimed', () => {
  assert.equal(dshAdapter.loginStatus, undefined);
});

// What the dispatcher and the account check read instead of knowing this executor by name.
test('the adapter declares that it continues a session, and the permission modes dsh takes', () => {
  assert.equal(dshAdapter.resumable, true, '同账号同机器上的下一轮可以用 --session-id 接着做');
  assert.deepEqual(dshAdapter.permissionModes, ['read-only', 'workspace-write', 'danger-full-access'], 'dsh-base 配的预设名就是全部可填的值');
});

test('normal: tool calls and text arrive once each, the turn ends once, and the result reads as finished', () => {
  const { events, reading } = recording('tools');
  assert.deepEqual(ofKind(events, 'tool.start'), [
    { kind: 'tool.start', id: 'call_1', category: 'edit', name: 'write', title: 'b.txt', input: JSON.stringify({ file_path: 'b.txt', content: 'hello' }, null, 2), paths: ['b.txt'] },
    { kind: 'tool.start', id: 'call_2', category: 'read', name: 'read', title: 'b.txt', input: JSON.stringify({ file_path: 'b.txt' }, null, 2), paths: ['b.txt'] },
  ]);
  assert.deepEqual(ofKind(events, 'tool.end').map(({ id, isError, output }) => [id, isError, output?.text.split('\n')[0]]), [
    ['call_1', false, String.raw`<path>C:\work\probe\b.txt</path>`],
    ['call_2', false, String.raw`<path>C:\work\probe\b.txt</path>`],
  ]);
  assert.match(ofKind(events, 'tool.end')[1]?.output?.text ?? '', /1: hello/);
  assert.deepEqual(ofKind(events, 'text'), [{ kind: 'text', text: 'hello' }]);
  assert.equal(ofKind(events, 'thinking').length, 1);
  assert.equal(ofKind(events, 'diagnostic').length, 0);
  assert.equal(ofKind(events, 'turn.end').length, 1, 'turn_end 一次；final 不再来一遍');
  assert.equal(events.at(-1)?.kind, 'turn.end');
  assert.deepEqual(ofKind(events, 'usage'), [
    { kind: 'usage', usage: [{ inputTokens: 3127, outputTokens: 140, cacheReadTokens: 0, cacheWriteTokens: 0 }] },
    { kind: 'usage', usage: [{ inputTokens: 256, outputTokens: 39, cacheReadTokens: 7168, cacheWriteTokens: 0 }] },
    { kind: 'usage', usage: [{ inputTokens: 111, outputTokens: 2, cacheReadTokens: 7424, cacheWriteTokens: 0 }] },
  ]);
  assert.equal(reading.text, 'hello');
  assert.equal(reading.sessionRef, 'session-1cfe8f45-3c4c-429a-bb77-cb2565eb6f15');
  assert.equal(reading.finished, true);
  assert.equal(reading.error, undefined);
  // One turn, so the step usages add up to what the turn spent.
  assert.deepEqual(reading.usage, [{ inputTokens: 3494, outputTokens: 181, cacheReadTokens: 14592, cacheWriteTokens: 0 }]);
});

test('resume: the recorded turn continues the same session and spends its own tokens', () => {
  const { events, reading } = recording('resume');
  assert.deepEqual(ofKind(events, 'text'), [{ kind: 'text', text: 'hello' }]);
  assert.equal(reading.sessionRef, recording('tools').reading.sessionRef);
  assert.equal(reading.finished, true);
  assert.equal(reading.error, undefined);
  assert.deepEqual(reading.usage, [{ inputTokens: 132, outputTokens: 2, cacheReadTokens: 7424, cacheWriteTokens: 0 }]);
});

test('a missing credential is a login problem, not an ordinary failure, and still ends the turn', () => {
  const { events, reading, exitCode } = recording('missing-credential');
  assert.equal(exitCode, 1);
  assert.equal(ofKind(events, 'usage').length, 0, '没有用量的 step_end 不产生事件');
  const [error] = ofKind(events, 'diagnostic');
  assert.equal(error?.level, 'fatal');
  assert.equal(error?.cause, 'auth');
  assert.match(error?.message ?? '', /no API key/);
  assert.equal(ofKind(events, 'turn.end').length, 1);
  assert.equal(reading.finished, true);
  assert.equal(reading.error?.kind, 'auth');
  assert.equal(reading.error?.resetsAt, undefined, '凭证问题没有额度恢复时间');
  assert.equal(reading.text, '');
});

test('an interrupted turn is unfinished, not failed, while the Runner is the one that killed it', () => {
  const { stdout, stderr, exitCode, events, reading } = recording('interrupt');
  assert.equal(exitCode, 1);
  assert.equal(events.some((event) => event.kind === 'turn.end'), false, '没有结束事件');
  assert.equal(events.some((event) => event.kind === 'diagnostic'), false);
  assert.deepEqual(dshAdapter.result(stdout, null, stderr), {
    sessionRef: 'session-ab6d029e-4742-4799-8c2e-fea0a7b0587d',
    finished: false,
  });
  assert.equal(reading.finished, false);
  assert.equal(reading.error?.kind, 'other');
  assert.match(reading.error?.message ?? '', /进程退出码 1/);
});

test('malformed lines and shapes with nothing in them yield nothing', () => {
  for (const line of ['', 'not json', 'null', '[1]', '{"type":"status"}', '{"type":"status","phase":"step_start"}']) {
    assert.deepEqual(dshAdapter.parse(line), []);
  }
  for (const line of ['{"type":"tool_call"}', '{"type":"tool_result"}', '{"type":"text"}', '{"type":"thinking"}', '{"type":"session"}', '{"type":"error"}']) {
    assert.deepEqual(dshAdapter.parse(line), []);
  }
});

test('a line that is not an object or carries no text never fails a result read', () => {
  const reading = dshAdapter.result(['noise', '{"type":"final"}', '[]'].join('\n'), 0, '');
  assert.deepEqual(reading, { finished: true });
});

test('a tool call maps to a category, keeps the original name, and a failed result says so', () => {
  const call = (tool: string, callId = 'c') => dshAdapter.parse(JSON.stringify({ type: 'tool_call', callId, tool, input: {} }));
  // Recorded: write and read. The other names come from the tool packages dsh ships
  // (dsh-tool-fs, -fs-search, -pwsh, -web), and a failed tool result from the projection
  // in dsh's own json-stream; no recording has produced either yet.
  assert.deepEqual(call('write'), [{ kind: 'tool.start', id: 'c', category: 'edit', name: 'write', title: 'write' }]);
  assert.deepEqual(call('edit'), [{ kind: 'tool.start', id: 'c', category: 'edit', name: 'edit', title: 'edit' }]);
  assert.deepEqual(call('read_image'), [{ kind: 'tool.start', id: 'c', category: 'read', name: 'read_image', title: 'read_image' }]);
  assert.deepEqual(call('grep'), [{ kind: 'tool.start', id: 'c', category: 'search', name: 'grep', title: 'grep' }]);
  assert.deepEqual(call('web_search'), [{ kind: 'tool.start', id: 'c', category: 'search', name: 'web_search', title: 'web_search' }]);
  assert.deepEqual(call('pwsh'), [{ kind: 'tool.start', id: 'c', category: 'run', name: 'pwsh', title: 'pwsh' }]);
  assert.deepEqual(call('todo_write'), [{ kind: 'tool.start', id: 'c', category: 'other', name: 'todo_write', title: 'todo_write' }]);
  const result = (status: string, more = {}) => dshAdapter.parse(JSON.stringify({ type: 'tool_result', callId: 'c', status, result: 'x', ...more }));
  assert.deepEqual(result('completed'), [{ kind: 'tool.end', id: 'c', isError: false, output: { text: 'x' } }]);
  assert.deepEqual(result('error'), [{ kind: 'tool.end', id: 'c', isError: true, output: { text: 'x' } }]);
  assert.deepEqual(result('error', { error: { message: '没有这个文件' } }), [{ kind: 'tool.end', id: 'c', isError: true, output: { text: 'x' }, reason: '没有这个文件' }]);
  // dsh's projection cuts a long string itself and says so on the line.
  assert.deepEqual(result('completed', { truncated: true }), [{ kind: 'tool.end', id: 'c', isError: false, output: { text: 'x', executorTruncated: true } }]);
  // A shell call is shown by its command, kept whole.
  assert.deepEqual(dshAdapter.parse(JSON.stringify({ type: 'tool_call', callId: 'p', tool: 'pwsh', input: { command: 'Get-ChildItem' } })), [
    { kind: 'tool.start', id: 'p', category: 'run', name: 'pwsh', title: 'Get-ChildItem', input: 'Get-ChildItem' },
  ]);
});

test('an error turn_end emits fatal diagnostic without premature turn.end; final emits turn.end', () => {
  const line = JSON.stringify({ type: 'status', phase: 'turn_end', turn: 1, reason: { kind: 'error', error: { code: 'QUOTA', message: '没了' } } });
  assert.deepEqual(dshAdapter.parse(line), [
    { kind: 'diagnostic', level: 'fatal', message: '没了', cause: 'quota' },
  ]);
  const completedTurnEnd = JSON.stringify({ type: 'status', phase: 'turn_end', turn: 1, reason: { kind: 'completed' } });
  assert.deepEqual(dshAdapter.parse(completedTurnEnd), []);
  const finalLine = JSON.stringify({ type: 'final', sessionId: 's', reason: { kind: 'completed' }, text: 'ok' });
  assert.deepEqual(dshAdapter.parse(finalLine), [{ kind: 'turn.end' }]);
});

// The codes are dsh's own, from its error table: the llm transport fails a non-2xx request
// with AUTH (401/403), QUOTA, RATE_LIMIT and the rest; the account route adds ACCOUNT_*
// (its 401 is ACCOUNT_TOKEN_INVALID, a signed-out account ACCOUNT_SIGNED_OUT); a credential
// that is absent or malformed is MISSING_CREDENTIAL or INVALID_CREDENTIAL. Only
// MISSING_CREDENTIAL is recorded (missing-credential.ndjson); the others are written from
// dsh's own sources, which is what the fixture README says too.
test('credential problems, a used-up quota and a transient rate limit are told apart', () => {
  const kindOf = (code: string, message = 'x') =>
    dshAdapter.result(JSON.stringify({ type: 'final', sessionId: 's', reason: { kind: 'error', error: { code, message } }, text: '' }), 1, '')
      .error?.kind;
  assert.equal(kindOf('MISSING_CREDENTIAL'), 'auth');
  assert.equal(kindOf('INVALID_CREDENTIAL'), 'auth');
  assert.equal(kindOf('AUTH', 'authentication failed'), 'auth', '认得码，不靠 401 这几个字');
  assert.equal(kindOf('ACCOUNT_SIGN_IN_REQUIRED'), 'auth');
  assert.equal(kindOf('ACCOUNT_TOKEN_INVALID'), 'auth');
  assert.equal(kindOf('ACCOUNT_SIGNED_OUT'), 'auth');
  assert.equal(kindOf('QUOTA'), 'quota');
  assert.equal(kindOf('ACCOUNT_QUOTA'), 'quota');
  assert.equal(kindOf('RATE_LIMIT'), 'other', '限流是暂时的，账号不用歇');
  assert.equal(kindOf('INTERRUPTED'), 'other', '被停下的任务不是账号的问题');
  assert.equal(kindOf('SERVER'), 'other', '上游出错也不该让账号歇着');
  assert.equal(kindOf('HTTP_500'), 'other');
  assert.equal(kindOf('PROVIDER_ERROR', '401 Unauthorized'), 'auth', '没有 dsh 的码时按话术兜底');
  assert.equal(kindOf('PROVIDER_ERROR', 'insufficient balance'), 'quota');
  assert.equal(kindOf('PROVIDER_ERROR', 'connection reset'), 'other');
});

// A turn does not only end as completed or as an error: dsh's TurnEndReasonMap has
// aborted (which names its cause), blocked, max-tokens, interrupted and forked, and the
// process exits non-zero for every one of them. A reason nobody writes down leaves the
// round explaining itself with an exit code.
test('every ending but completed is reported as itself', () => {
  const errorOf = (reason: unknown) =>
    dshAdapter.result(JSON.stringify({ type: 'final', sessionId: 's', reason, text: '半句' }), 1, '').error;
  assert.deepEqual(errorOf({ kind: 'aborted', reason: { kind: 'user' } }), { kind: 'other', message: '这一轮被取消（有人取消）' });
  assert.deepEqual(errorOf({ kind: 'aborted', reason: { kind: 'hook', reason: '预算没批' } }), { kind: 'other', message: '这一轮被取消（钩子说：预算没批）' });
  assert.deepEqual(errorOf({ kind: 'aborted', reason: { kind: 'disposed' } }), { kind: 'other', message: '这一轮被取消（进程退出）' });
  assert.deepEqual(errorOf({ kind: 'aborted', reason: { kind: 'legacy' } }), { kind: 'other', message: '这一轮被取消（原因没有记下）' });
  assert.deepEqual(errorOf({ kind: 'interrupted' }), { kind: 'other', message: '这一轮被中断' });
  assert.deepEqual(errorOf({ kind: 'blocked' }), { kind: 'other', message: '这一轮被挡住' });
  assert.deepEqual(errorOf({ kind: 'max-tokens' }), { kind: 'other', message: '这一轮用完了 token 上限' });
  assert.deepEqual(errorOf({ kind: 'forked' }), { kind: 'other', message: '这一轮分叉了' });
  // A kind dsh adds later is still reported rather than dropped.
  assert.deepEqual(errorOf({ kind: 'something-new' }), { kind: 'other', message: '这一轮以 something-new 结束' });
  // A completed turn is not a failure in itself: with the exit code dsh really gives it,
  // there is nothing to report.
  const done = JSON.stringify({ type: 'final', sessionId: 's', reason: { kind: 'completed' }, text: '好' });
  assert.equal(dshAdapter.result(done, 0, '').error, undefined);
  // The same ending reaches the stream, so the timeline says it too (turn.end comes on final).
  const line = JSON.stringify({ type: 'status', phase: 'turn_end', turn: 1, reason: { kind: 'max-tokens' } });
  assert.deepEqual(dshAdapter.parse(line), [
    { kind: 'diagnostic', level: 'fatal', message: '这一轮用完了 token 上限', cause: 'other' },
  ]);
});

// `fail()` writes {"type":"error","message"} and exits 1; on a usage error the headless
// app replaces commander's own error output, so this line is the only place the reason
// appears (recorded: usage-error.ndjson).
test('a run that never ended a turn reports the error line, not just the exit code', () => {
  const { stdout, stderr, exitCode, events, reading } = recording('usage-error');
  assert.equal(exitCode, 1);
  assert.equal(stderr, '', 'stderr 是空的，原因只在 stdout 那一行');
  assert.deepEqual(events, [{ kind: 'diagnostic', level: 'fatal', message: "unknown option '--definitely-not-an-option'", cause: 'other' }]);
  assert.equal(reading.finished, false);
  assert.equal(reading.sessionRef, undefined);
  assert.equal(reading.error?.message, "unknown option '--definitely-not-an-option'");
});

test('a failure dsh recorded without a message is reported as what the Runner saw', () => {
  const final = (reason: unknown) => JSON.stringify({ type: 'final', sessionId: 's', reason, text: '' });
  const failed = { kind: 'error', error: { code: 'SERVER' } };
  assert.equal(dshAdapter.result(final(failed), 1, '').error?.message, '进程退出码 1', '空话术会让任务的原因是空行');
  assert.equal(dshAdapter.result(final(failed), 1, 'dsh: SERVER: 上游挂了\n').error?.message, 'dsh: SERVER: 上游挂了');
  assert.equal(dshAdapter.result(final(failed), null, '').error?.message, 'SERVER', '连退出码都没有时，码本身也是话');
  // The stream says the same thing when the turn line carries no message.
  assert.deepEqual(dshAdapter.parse(JSON.stringify({ type: 'status', phase: 'turn_end', reason: failed })), [
    { kind: 'diagnostic', level: 'fatal', message: 'SERVER', cause: 'other' },
  ]);
});


test('a turn that ends as an error but exits 0 is still a failure', () => {
  const stdout = JSON.stringify({ type: 'final', sessionId: 's', reason: { kind: 'error', error: { code: 'QUOTA', message: '没了' } }, text: '' });
  const reading = dshAdapter.result(stdout, 0, '');
  assert.equal(reading.finished, true);
  assert.deepEqual(reading.error, { kind: 'quota', message: '没了' });
});

test('a finished turn whose exit code is not zero still reports the failure', () => {
  const stdout = JSON.stringify({ type: 'final', sessionId: 's', reason: { kind: 'completed' }, text: '好' });
  const reading = dshAdapter.result(stdout, 2, 'stderr tail');
  assert.equal(reading.finished, true);
  assert.equal(reading.text, '好');
  assert.equal(reading.error?.message, 'stderr tail');
});

// From dsh's json-stream projection, not a recording: a failed result keeps the text it
// gave and dsh's own mark that it cut it; a structured error beside it is the reason, and
// takes nothing away from the text.
test('a failed result keeps its text and dsh\'s truncation mark; a structured error is the reason', () => {
  const line = (more: object) => dshAdapter.parse(JSON.stringify({ type: 'tool_result', callId: 't', status: 'error', result: 'error details', truncated: true, ...more }));
  assert.deepEqual(line({ error: { message: '命令退出码 2' } }), [{ kind: 'tool.end', id: 't', isError: true, output: { text: 'error details', executorTruncated: true }, reason: '命令退出码 2' }]);
  assert.deepEqual(line({}), [{ kind: 'tool.end', id: 't', isError: true, output: { text: 'error details', executorTruncated: true } }]);
});
