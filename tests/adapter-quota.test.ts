// Guards how a machine reads the quota of an executor's own login there, against the two
// recordings (docs/design/usage.md §3, `Adapter.machineQuota`).
//
// What this file is here to catch:
//   - a reading that is not the executor's own recorded command (the set is closed, and this
//     program's declarations are the only source of it);
//   - a Claude Code reading that takes its windows from anywhere but the recorded window lines,
//     that lets this machine's own session statistics through as a window, or that invents a
//     reset time instead of reading the one the line gives in the line's own zone;
//   - a Codex reading that counts one bucket twice (`rateLimits` beside `rateLimitsByLimitId`),
//     that calls a window five hours because that is what it usually is, or that reports the
//     account's own identity;
//   - a reading that turns an unreadable answer into figures, or an empty reading into an empty
//     window list the host would then show as "read";
//   - an executor with no such reading claiming one (dsh).
import './guard.ts';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { claudeAdapter } from '../adapters/claude.ts';
import { codexAdapter } from '../adapters/codex.ts';
import { dshAdapter } from '../adapters/dsh.ts';
import { geminiAdapter, parseGeminiUsage } from '../adapters/gemini.ts';
import type { MachineQuota, QuotaReading, QuotaStep } from '../adapters/types.ts';

const fixture = (...parts: string[]): string => join(import.meta.dirname, 'fixtures', ...parts);

// ---- Claude Code: one command, its own result envelope -----------------------------------

const USAGE_TEXT = readFileSync(fixture('claude', '2.1.303', 'usage', 'usage.txt'), 'utf8');
// The envelope `--output-format json` prints: the text `/usage` shows is `result`, and nothing
// else of it is read.
const envelope = (text: string): string => JSON.stringify({ type: 'result', subtype: 'success', is_error: false, num_turns: 0, total_cost_usd: 0, duration_ms: 55_000, result: text });

const CLAUDE = claudeAdapter.machineQuota as MachineQuota;
const claudeRead = (stdout: string): QuotaReading => CLAUDE.kind === 'command' ? CLAUDE.parse(stdout) : { problem: '不是一条命令' };

// The window fields of one instant in one zone, as that zone reads them.
const zoneParts = (at: Date, zone: string): Record<string, string> =>
  Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    .formatToParts(at).map(({ type, value }) => [type, value]));
const windowsOf = (read: QuotaReading): readonly { window: string; used: number; resets_at: string | null }[] => {
  assert.ok('windows' in read, '这次读到了窗口');
  return read.windows;
};
const problemOf = (read: QuotaReading): string => {
  assert.ok('problem' in read, `这次没有读到：${JSON.stringify(read)}`);
  return read.problem;
};
// A valid envelope that names no window at all: absent, not a problem.
const absentOf = (read: QuotaReading): void => {
  assert.ok('windows' in read && read.windows.length === 0 && read.absent === true, `这次没有读到窗口：${JSON.stringify(read)}`);
};

test('claude：实录的两条窗口行规范为共同标识，重置时刻按行里给的时区、取下一个这样的日期', () => {
  assert.deepEqual(CLAUDE.kind === 'command' ? { kind: CLAUDE.kind, argv: CLAUDE.argv, parse: typeof CLAUDE.parse } : null, {
    kind: 'command', argv: ['claude', '-p', '/usage', '--output-format', 'json'], parse: 'function',
  }, '读法就是实录里那一条命令');
  const read = claudeRead(envelope(USAGE_TEXT));
  // The two window lines, in the order they were printed; the title line and the heading
  // "What's contributing to your limits usage?" are not windows.
  assert.deepEqual(windowsOf(read).map(({ window, used }) => [window, used]), [
    ['seven_day', 0.78],
    ['seven_day_fable', 0.09],
  ]);
  const thisYear = Number(zoneParts(new Date(), 'Asia/Shanghai').year);
  for (const { resets_at: resets } of windowsOf(read)) {
    assert.ok(resets !== null, '行里给了重置时刻');
    const at = new Date(resets);
    assert.ok(at.getTime() > Date.now(), '是下一个这样的日期，不是已经过去的那个');
    const parts = zoneParts(at, 'Asia/Shanghai');
    assert.deepEqual([parts.month, parts.day, parts.hour, parts.minute], ['11', '15', '07', '00'], '行里的 Nov 15, 7am (Asia/Shanghai) 就是那一刻');
    assert.ok(Number(parts.year) >= thisYear && Number(parts.year) <= thisYear + 1, '年份是今年或明年，不是猜的别的年份');
  }
  // Not the reader's own zone: the same line read as UTC would be a different instant.
  assert.notEqual(new Date(windowsOf(read)[0]!.resets_at!).getUTCHours(), 7);
});

test('claude：只出标题、认不出的信封、读不出的百分比都不编数字；没有时区就只记百分比', () => {
  absentOf(claudeRead(envelope('You are currently using your subscription to power your Claude Code usage\n')));
  absentOf(claudeRead(envelope(`What's contributing to your limits usage?\n`)));
  assert.equal(problemOf(claudeRead('not json at all')), 'claude 的回答读不出来');
  assert.equal(problemOf(claudeRead(JSON.stringify({ type: 'result', session_id: 's' }))), 'claude 的回答读不出来');
  assert.equal(problemOf(claudeRead(JSON.stringify({ type: 'result', result: 7 }))), 'claude 的回答读不出来');
  // A percentage outside 0..100 is not a share of anything, and a line without `% used` is not
  // a window at all: neither is guessed into one, and a valid answer with none is absent.
  absentOf(claudeRead(envelope('Current week (all models): 150% used · resets Nov 15, 7am (Asia/Shanghai)\n')));
  absentOf(claudeRead(envelope('Current week (all models): 78%\n')));
  // The share is the executor's own number even when the reset time cannot be read: no zone,
  // an unknown zone, or a date this program cannot place.
  for (const line of [
    'Current week (all models): 78% used',
    'Current week (all models): 78% used · resets Nov 15, 7am',
    'Current week (all models): 78% used · resets Nov 15, 7am (Mars/Olympus)',
    'Current week (all models): 78% used · resets someday',
    'Current week (all models): 78% used · resets Feb 30, 7am (Asia/Shanghai)',
  ]) {
    const read = claudeRead(envelope(`${line}\n`));
    assert.deepEqual(windowsOf(read).map(({ window, used, resets_at: resets }) => [window, used, resets]), [['seven_day', 0.78, null]], line);
  }
  // A whole number and a fraction both read, and a line with a minute in it.
  const minute = windowsOf(claudeRead(envelope('Current week (all models): 100% used · resets Nov 15, 7:30pm (Asia/Shanghai)\n')));
  assert.deepEqual(minute.map(({ used }) => used), [1]);
  assert.deepEqual([zoneParts(new Date(minute[0]!.resets_at!), 'Asia/Shanghai').hour, zoneParts(new Date(minute[0]!.resets_at!), 'Asia/Shanghai').minute], ['19', '30']);
});

test('claude：会话、全模型周窗口和模型周窗口在入口共用事件的标识，未知名称保留', () => {
  const read = claudeRead(envelope([
    'Current session: 12% used',
    'Current week (all models): 34% used',
    'Current week (FABLE): 56% used',
    'Future window: 7% used',
  ].join('\n')));
  assert.deepEqual(windowsOf(read).map(({ window, used }) => [window, used]), [
    ['five_hour', 0.12], ['seven_day', 0.34], ['seven_day_fable', 0.56], ['Future window', 0.07],
  ]);
});

// ---- Codex: a short conversation, its own answer line ------------------------------------

const RECORDED = JSON.parse(readFileSync(fixture('codex', '0.167.1', 'rate-limits', 'rate-limits.json'), 'utf8')) as Record<string, unknown>;
const RESETS_AT = '2026-11-19T05:41:03.000Z';

const CODEX = codexAdapter.machineQuota as MachineQuota;
const codexRead = (answer: string): QuotaReading => CODEX.kind === 'talk' ? CODEX.parse(answer) : { problem: '不是一段对话' };
const codexSteps = (version = '1.2.3'): readonly QuotaStep[] => CODEX.kind === 'talk' ? CODEX.steps(version) : [];

test('codex：实录的回答里一个桶只算一次，窗口名按 windowDurationMins 起，账号身份不上报', () => {
  assert.deepEqual(CODEX.kind === 'talk' ? { kind: CODEX.kind, argv: CODEX.argv, steps: typeof CODEX.steps, parse: typeof CODEX.parse } : null, {
    kind: 'talk', argv: ['codex', 'app-server', '--listen', 'stdio://'], steps: 'function', parse: 'function',
  }, '读法就是把 app-server 按实录那样问一遍');
  for (const answer of [
    JSON.stringify(RECORDED),
    // The same answer as the JSON-RPC reply it arrives in.
    JSON.stringify({ jsonrpc: '2.0', id: 2, result: RECORDED }),
  ]) {
    const read = codexRead(answer);
    assert.deepEqual(windowsOf(read), [{ window: 'seven_day', used: 0.01, resets_at: RESETS_AT }], 'primary 一个窗口，不因为两份 map 而算两次');
  }
  // `rateLimits` is read only when the by-id map is not there.
  const one = codexRead(JSON.stringify({ rateLimits: RECORDED.rateLimits }));
  assert.deepEqual(windowsOf(one), [{ window: 'seven_day', used: 0.01, resets_at: RESETS_AT }]);
  // An answer carrying the account's own id: none of it is in the reading.
  const withId = codexRead(JSON.stringify({ ...RECORDED, accountId: 'acct-not-to-leave-this-machine' }));
  assert.equal(JSON.stringify(withId).includes('acct-not-to-leave-this-machine'), false);
  assert.equal(JSON.stringify(withId).includes('accountId'), false);
});

test('codex：多个桶、primary 和 secondary 各是一个窗口，标准时长共用标识，其余带分钟数和桶标识', () => {
  const bucket = (usedPercent: number, windowDurationMins: number, resetsAt: number) => ({ usedPercent, windowDurationMins, resetsAt });
  const read = codexRead(JSON.stringify({
    rateLimitsByLimitId: {
      codex: { limitId: 'codex', primary: bucket(10, 300, 1_700_000_000), secondary: bucket(60, 10080, 1_700_500_000) },
      'gpt-6-codex': { limitId: 'gpt-6-codex', limitName: '第六代', primary: bucket(0, 1440, 1_700_000_000), secondary: null },
      alias: { limitId: 'other', limitName: '显示名', primary: bucket(5, 300, 1_700_000_000), secondary: bucket(20, 10080, 1_700_500_000) },
    },
  }));
  assert.deepEqual(windowsOf(read).map(({ window, used, resets_at: resets }) => [window, used, resets]), [
    ['five_hour', 0.1, new Date(1_700_000_000_000).toISOString()],
    ['seven_day', 0.6, new Date(1_700_500_000_000).toISOString()],
    ['gpt-6-codex_1440m', 0, new Date(1_700_000_000_000).toISOString()],
    ['other_five_hour', 0.05, new Date(1_700_000_000_000).toISOString()],
    ['other_seven_day', 0.2, new Date(1_700_500_000_000).toISOString()],
  ], 'primary 和 secondary 各是一个窗口，桶用 limitId，不用显示名 limitName');
});

test('codex：认不出的回答、没有窗口、窗口里没有可读的比例都不编数字', () => {
  assert.equal(problemOf(codexRead('not json at all')), 'codex 的回答读不出来');
  assert.equal(problemOf(codexRead('{"id":2}')), 'codex 没有报额度窗口');
  assert.equal(problemOf(codexRead(JSON.stringify({ rateLimits: { primary: null, secondary: null } }))), 'codex 没有报额度窗口');
  // A share that is not a number, or one outside 0..100, is left out rather than guessed at.
  for (const primary of [{ windowDurationMins: 10080, resetsAt: 1 }, { usedPercent: 'ten' }, { usedPercent: -1 }, { usedPercent: 101 }]) {
    assert.equal(problemOf(codexRead(JSON.stringify({ rateLimitsByLimitId: { codex: { primary } } }))), 'codex 没有报额度窗口', JSON.stringify(primary));
  }
  // A window with no length is still a window, named by the one it is.
  assert.deepEqual(windowsOf(codexRead(JSON.stringify({ rateLimitsByLimitId: { codex: { primary: { usedPercent: 5 } } } }))), [{ window: 'primary', used: 0.05, resets_at: null }]);
  // A reset time that is not a number: the share stands, the moment is unknown.
  assert.deepEqual(windowsOf(codexRead(JSON.stringify({ rateLimitsByLimitId: { codex: { primary: { usedPercent: 5, windowDurationMins: 300, resetsAt: 'soon' } } } }))), [{ window: 'five_hour', used: 0.05, resets_at: null }]);
});

test('codex：对话是实录里那两问，初始化带上这个客户端的版本，答的是各自那个 id', () => {
  const steps = codexSteps('9.9.9');
  assert.equal(steps.length, 2);
  assert.deepEqual(steps.map((step) => step.say.length), [1, 2]);
  assert.deepEqual(JSON.parse(steps[0]!.say[0]!), {
    id: 1, method: 'initialize', params: { clientInfo: { name: 'tycho', title: 'tycho', version: '9.9.9' } },
  });
  assert.deepEqual(JSON.parse(steps[1]!.say[0]!), { method: 'initialized', params: {} });
  assert.deepEqual(JSON.parse(steps[1]!.say[1]!), { id: 2, method: 'account/rateLimits/read' });
  // Each step waits for its own id, and the notification is nobody's answer.
  assert.deepEqual([steps[0]!.answers('{"id":1,"result":{}}'), steps[0]!.answers('{"id":2,"result":{}}'), steps[0]!.answers('{"method":"initialized","params":{}}'), steps[0]!.answers('not json')], [true, false, false, false]);
  assert.deepEqual([steps[1]!.answers('{"id":2,"result":{}}'), steps[1]!.answers('{"id":1,"result":{}}')], [true, false]);
});

// ---- the executions with no reading ------------------------------------------------------

test('gemini：agy -p /usage --output-format json 解析 Gemini 与 Claude/GPT 5h/7d 窗口与重置时间', () => {
  const sample = JSON.stringify({
    status: 'SUCCESS',
    command: {
      name: 'usage',
      data: {
        groups: [
          {
            name: 'Gemini Models',
            buckets: [
              { id: 'gemini-weekly', window: 'weekly', remaining_fraction: 0.87, reset_time: '2026-12-01T03:21:24Z' },
              { id: 'gemini-5h', window: '5h', remaining_fraction: 0.97, reset_time: '2026-11-25T19:54:08Z' },
            ],
          },
          {
            name: 'Claude and GPT models',
            buckets: [
              { id: '3p-weekly', window: 'weekly', remaining_fraction: 1, reset_time: '1970-01-01T00:00:00Z' },
              { id: '3p-5h', window: '5h', remaining_fraction: 1, reset_time: '1970-01-01T00:00:00Z' },
            ],
          },
        ],
      },
    },
  });
  const parsed = parseGeminiUsage(sample);
  assert.ok('windows' in parsed);
  assert.equal(parsed.windows.length, 4);
  assert.equal(parsed.windows[0]!.window, 'seven_day');
  assert.ok(Math.abs(parsed.windows[0]!.used - 0.13) < 1e-6);
  assert.equal(parsed.windows[0]!.resets_at, '2026-12-01T03:21:24.000Z');
  assert.equal(parsed.windows[1]!.window, 'five_hour');
  assert.ok(Math.abs(parsed.windows[1]!.used - 0.03) < 1e-6);
  assert.equal(parsed.windows[2]!.window, 'seven_day_3p');
  assert.equal(parsed.windows[2]!.resets_at, null);
  assert.equal(parsed.windows[3]!.window, 'five_hour_3p');
  assert.equal(parsed.windows[3]!.resets_at, null);
});

test('各执行器声明的机器读法：dsh 走本机 probe，claude/gemini 走 command，codex 走 talk', () => {
  assert.equal(dshAdapter.machineQuota?.kind, 'probe');
  assert.equal(claudeAdapter.machineQuota?.kind, 'command');
  assert.equal(geminiAdapter.machineQuota?.kind, 'command');
  assert.equal(codexAdapter.machineQuota?.kind, 'talk');
});
