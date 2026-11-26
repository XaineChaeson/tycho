// Guards against the process table answering wrongly about the Router's tree (§6, §11):
// a leftover Router or MCP proxy not found, so a second driver starts beside it; one
// whose command line no longer names the marker being missed; the search finding itself,
// or a process whose id merely starts with the marker; a process that cannot be read
// failing the whole search, or an unexpected failure passing for "nothing there"; a kill
// that leaves part of the tree running, gives up on a process that ignores SIGTERM, or
// never returns; and a signal reaching anything that is not the marked tree: pid 1, a
// process group (0 or negative), this process, the service's own group, a reused pid.
// Also a process caught on its way out being taken for a stranger, which stops the Host
// for nothing; a grace period that grows with the size of the machine; and a platform
// nobody wrote this for being served by guesswork.
//
// The POSIX logic runs here against a made-up /proc, made-up `ps` output and a made-up
// process table. The last test uses this platform's real one.
import './guard.ts';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';
import type { PosixSystem, ProcFs, ProcessRow } from '../service/processes.ts';
import {
  carries,
  hostProcesses,
  linuxProcesses,
  parsePs,
  posixProcesses,
  procTable,
  psProcesses,
  rootSpawnOptions,
  selectProcesses,
  windowsProcesses,
} from '../service/processes.ts';

const M = 'f3b1c2d4-0000-4000-8000-aabbccddeeff';
const OTHER = '11111111-2222-4333-8444-555555555555';
const SELF = 999;

// As /proc/<pid>/cmdline has them: arguments ended by NUL.
const cmdline = (...args: string[]): string => args.map((arg) => `${arg}\0`).join('');
const ROUTER = cmdline('node', '/app/claude', '-p', '--mcp-config', `/data/router/mcp-${M}.json`, '--session-id', M);
const RESUMED = cmdline('claude', '-p', '--mcp-config', `/data/router/mcp-${M}.json`, '--resume', 'some-other-ref');
const PROXY = cmdline('node', '/app/service/tools-proxy.ts', '--marker', M);

test('the marker counts as a whole id, wherever the host puts it', () => {
  assert.ok(carries(ROUTER, M));
  assert.ok(carries(RESUMED, M), '续接时命令行上只有 mcp 配置的文件名带标记');
  assert.ok(carries(PROXY, M));
  assert.ok(carries(`PATH=/bin\0TYCHO_ROUTER_MARKER=${M}\0HOME=/root\0`, M));
  assert.ok(carries(`node proxy.ts --marker ${M}`, M));
  assert.ok(carries(`claude --mcp-config "/my data/router/mcp-${M}.json" -p`, M));
});

test('an id that only starts or ends with the marker is someone else', () => {
  assert.equal(carries(cmdline('node', 'x', '--marker', `${M}ff`), M), false);
  assert.equal(carries(cmdline('node', 'x', '--marker', `${M}-2`), M), false);
  assert.equal(carries(cmdline('node', 'x', '--marker', `${M}_old`), M), false);
  assert.equal(carries(cmdline('node', 'x', '--marker', `0${M}`), M), false);
  assert.equal(carries(cmdline('node', 'x', '--marker', OTHER), M), false);
  assert.equal(carries(cmdline('node', 'x', '--marker', M.slice(0, -4)), M), false);
  // The longer id first, the marker itself after it: the second one counts.
  assert.ok(carries(`${M}ff ${M}`, M));
  assert.equal(carries(ROUTER, ''), false, '空标记什么都不算');
});

type Entry = string | { fail: string };

// The 22nd field is when the process started, in clock ticks since boot.
const stat = (pid: number, comm: string, state: string, ppid: number, pgid: number, born = 12345): string =>
  `${pid} (${comm}) ${state} ${ppid} ${pgid} ${pgid} 0 -1 4194560 100 0 0 0 1 2 0 0 20 0 1 0 ${born} 1000 200\n`;

function procfs(files: Record<string, Entry>, names?: string[] | { fail: string }): ProcFs {
  const failure = (code: string): NodeJS.ErrnoException => Object.assign(new Error(`${code}: made up`), { code });
  return {
    async names() {
      if (names && !Array.isArray(names)) throw failure(names.fail);
      return names ?? [...new Set(Object.keys(files).map((name) => name.split('/')[0]!))];
    },
    async read(name) {
      const entry = files[name];
      if (entry === undefined) throw failure('ENOENT');
      if (typeof entry !== 'string') throw failure(entry.fail);
      return entry;
    },
  };
}

const still = { signal: () => {}, sleep: async () => {}, now: () => 0, self: SELF };
const onProc = (fs: ProcFs) => posixProcesses({ ...still, table: () => procTable(fs) });

test('/proc: the Router, a resumed one and the MCP proxy are found; the searcher and strangers are not', async () => {
  const fs = procfs({
    '10/stat': stat(10, 'node', 'S', 1, 10),
    '10/cmdline': ROUTER,
    '10/environ': `TYCHO_ROUTER_MARKER=${M}\0`,
    '11/stat': stat(11, 'node', 'S', 10, 10),
    '11/cmdline': PROXY,
    '11/environ': 'PATH=/bin\0',
    '12/stat': stat(12, 'claude', 'S', 1, 12),
    '12/cmdline': RESUMED,
    '12/environ': '',
    // Whoever is searching, even if its command line names the marker.
    [`${SELF}/stat`]: stat(SELF, 'node', 'R', 1, SELF),
    [`${SELF}/cmdline`]: cmdline('node', 'service/main.ts', M),
    [`${SELF}/environ`]: '',
    '20/stat': stat(20, 'node', 'S', 1, 20),
    '20/cmdline': cmdline('node', 'x', '--marker', OTHER),
    '20/environ': `TYCHO_ROUTER_MARKER=${OTHER}\0`,
    '21/stat': stat(21, 'node', 'S', 1, 21),
    '21/cmdline': cmdline('node', 'x', '--marker', `${M}ff`),
    '21/environ': '',
  });
  assert.deepEqual((await onProc(fs).find(M)).sort(), [10, 11, 12]);
});

test('/proc: a process whose command line was overwritten is found by its environment', async () => {
  const fs = procfs({
    // What a CLI that sets its own title leaves: the name, then NULs where the arguments were.
    '10/stat': stat(10, 'claude', 'S', 1, 10),
    '10/cmdline': `claude${'\0'.repeat(200)}`,
    '10/environ': `HOME=/root\0TYCHO_ROUTER_MARKER=${M}\0`,
    // Started by the Router with nothing on its command line: it inherited the environment.
    '11/stat': stat(11, 'sleep', 'S', 10, 10),
    '11/cmdline': cmdline('sleep', '60'),
    '11/environ': `HOME=/root\0TYCHO_ROUTER_MARKER=${M}\0`,
  });
  assert.deepEqual((await onProc(fs).find(M)).sort(), [10, 11]);
});

test('/proc: a process that cannot be read is skipped, not an error', async () => {
  const fs = procfs(
    {
      // Gone between the listing and the read.
      '30/stat': { fail: 'ENOENT' },
      '31/stat': { fail: 'ESRCH' },
      // Someone else's: the environment is closed, here the command line too.
      '32/stat': stat(32, 'sshd', 'S', 1, 32),
      '32/cmdline': { fail: 'EACCES' },
      '32/environ': { fail: 'EACCES' },
      '33/stat': stat(33, 'root-thing', 'S', 1, 33),
      '33/cmdline': cmdline('root-thing'),
      '33/environ': { fail: 'EPERM' },
      // Died after its stat was read.
      '34/stat': stat(34, 'node', 'S', 1, 34),
      '34/cmdline': { fail: 'ESRCH' },
      '34/environ': { fail: 'ENOENT' },
      '10/stat': stat(10, 'node', 'S', 1, 10),
      '10/cmdline': ROUTER,
      '10/environ': { fail: 'EACCES' },
    },
    ['30', '31', '32', '33', '34', '10', 'self', 'cpuinfo', 'thread-self', '1x'],
  );
  assert.deepEqual(await onProc(fs).find(M), [10]);
  const rows = await procTable(fs);
  assert.deepEqual(rows.map((row) => row.pid).sort((a, b) => a - b), [10, 32, 33], '别人的进程仍在表里，已经没了的不在');
});

test('/proc: a failure nobody expects fails the search instead of passing for nothing there', async () => {
  const broken = procfs({ '10/stat': stat(10, 'node', 'S', 1, 10), '10/cmdline': { fail: 'EIO' }, '10/environ': '' });
  await assert.rejects(onProc(broken).find(M), /EIO/);
  const tooMany = procfs({ '10/stat': { fail: 'EMFILE' } });
  await assert.rejects(onProc(tooMany).find(M), /EMFILE/);
  await assert.rejects(onProc(procfs({}, { fail: 'ENOENT' })).find(M), /ENOENT/, '没有 /proc 不等于没有残留');
  const garbled = procfs({ '10/stat': 'not a stat line', '10/cmdline': ROUTER, '10/environ': '' });
  await assert.rejects(onProc(garbled).find(M), /stat/);
});

test('/proc: parent and group come from stat whatever the command is called; the dead are not listed', async () => {
  const fs = procfs({
    '40/stat': stat(40, 'a b) (c', 'S', 7, 8),
    '40/cmdline': cmdline('weird'),
    '40/environ': '',
    '41/stat': stat(41, 'tmux: server', 'R', 1, 41),
    '41/cmdline': cmdline('tmux'),
    '41/environ': '',
    // Exited and not yet collected. Its memory is gone, and the command line with it.
    '42/stat': stat(42, 'node', 'Z', 1, 42),
    '42/cmdline': '',
    '42/environ': '',
    // On its way out: still "running" by its state, with nothing left to run.
    '43/stat': stat(43, 'node', 'R', 1, 43),
    '43/cmdline': '',
    '43/environ': '',
    // A kernel thread never had a command line.
    '2/stat': stat(2, 'kthreadd', 'S', 0, 0),
    '2/cmdline': '',
    '2/environ': { fail: 'EACCES' },
  });
  const rows = await procTable(fs);
  assert.deepEqual(
    rows.map(({ pid, ppid, pgid }) => ({ pid, ppid, pgid })),
    [
      { pid: 40, ppid: 7, pgid: 8 },
      { pid: 41, ppid: 1, pgid: 41 },
    ],
  );
});

test('/proc: a process that ends while it is being read is listed whole or not at all', async () => {
  // Its marker is in the environment only, and it ends before the nth read of its files.
  // A row without the marker would be a live stranger to kill(), which stops the Host.
  for (let endsBefore = 1; endsBefore <= 4; endsBefore += 1) {
    let reads = 0;
    const live: Record<string, string> = {
      '10/stat': stat(10, 'claude', 'S', 1, 10),
      '10/cmdline': `claude${'\0'.repeat(50)}`,
      '10/environ': `TYCHO_ROUTER_MARKER=${M}\0`,
    };
    const fs: ProcFs = {
      names: async () => ['10'],
      async read(name) {
        reads += 1;
        if (reads < endsBefore) return live[name]!;
        // Its memory goes first: the two that read it come back empty, stat still answers.
        return name === '10/stat' ? stat(10, 'claude', 'R', 1, 10) : '';
      },
    };
    const rows = await procTable(fs);
    assert.deepEqual(rows.map((row) => carries(row.text, M)), endsBefore > 3 ? [true] : [], `在第 ${endsBefore} 次读取前结束`);
  }
});

test('/proc: a process caught while it leaves the table is not there, and not a table that cannot be read', async () => {
  // As a Linux kernel shows a process between its end and its removal: state X, no
  // parent, and -1 where its group and session were. Seen on a real machine, where the
  // search threw on it and the Router could not be stopped.
  const leaving = '10 (MainThread) X 0 -1 -1 0 -1 4228108 2759 0 0 0 1 0 0 0 20 0 0 0 345982290 0 0 0 0 0\n';
  const rows = await procTable(procfs({
    '10/stat': leaving, '10/cmdline': '', '10/environ': '',
    '11/stat': stat(11, 'node', 'S', 1, 11), '11/cmdline': ROUTER, '11/environ': '',
    // A zombie keeps a well-formed line; nothing of it runs either.
    '12/stat': stat(12, 'node', 'Z', 1, 12), '12/cmdline': ROUTER, '12/environ': '',
  }));
  assert.deepEqual(rows.map((row) => row.pid), [11]);
  // A line that makes no sense for a process that is there is still an error.
  await assert.rejects(procTable(procfs({ '10/stat': '10 (node) S what is this\n', '10/cmdline': ROUTER, '10/environ': '' })), /读不懂/);
});

test('/proc: when a process started is part of who it is', async () => {
  const table = (born: number) =>
    procTable(procfs({ '10/stat': stat(10, 'node', 'S', 1, 10, born), '10/cmdline': ROUTER, '10/environ': '' }));
  const [first] = await table(777);
  const [again] = await table(777);
  const [reused] = await table(778);
  assert.ok(first!.born !== undefined);
  assert.equal(first!.born, again!.born);
  assert.notEqual(first!.born, reused!.born);
});

const onPs = (stdout: string) => posixProcesses({ ...still, table: async () => parsePs(stdout) });

test('ps: columns are read whatever the padding, and the command keeps its spaces and quotes', async () => {
  const out = [
    `    1     0     1 Ss   /sbin/launchd`,
    `   10     1    10 S    node /app/claude -p --mcp-config /Users/me/my data/router/mcp-${M}.json --append-system-prompt you are "the router" --session-id ${M} PATH=/bin`,
    `   11    10    10 S+   node /app/service/tools-proxy.ts --marker ${M}`,
    `12345 54321 12345 R    claude HOME=/Users/me TYCHO_ROUTER_MARKER=${M}`,
    `   20     1    20 S    grep --color "it's ${OTHER}"`,
    `  ${SELF}     1   ${SELF} S    node service/main.ts ${M}`,
    '',
  ].join('\n');
  assert.deepEqual(parsePs(out).map(({ pid, ppid, pgid }) => [pid, ppid, pgid]), [
    [1, 0, 1],
    [10, 1, 10],
    [11, 10, 10],
    [12345, 54321, 12345],
    [20, 1, 20],
    [SELF, 1, SELF],
  ]);
  assert.equal(parsePs(out)[4]!.text, `grep --color "it's ${OTHER}"`);
  assert.deepEqual((await onPs(out).find(M)).sort((a, b) => a - b), [10, 11, 12345]);
});

test('ps: a command line cut short does not match, and one that runs over lines stays with its process', async () => {
  const cut = `   10     1    10 S    node /app/claude -p --mcp-config /data/router/mcp-${M.slice(0, 20)}\n`;
  assert.deepEqual(await onPs(cut).find(M), []);
  // An argument with line breaks in it, as the role prompt is.
  const wrapped = [
    `   10     1    10 S    claude -p --append-system-prompt # Router`,
    ``,
    `1. first rule`,
    `   30 is a number, not a pid --session-id ${M}`,
    `   11     1    11 S    unrelated`,
  ].join('\n');
  const rows = parsePs(wrapped);
  assert.deepEqual(rows.map((row) => row.pid), [10, 11]);
  assert.deepEqual(await onPs(wrapped).find(M), [10]);
});

test('ps: the dead are not listed, and output that is not a process table is an error', async () => {
  const out = [
    `   10     1    10 Z    (node)`,
    `   11     1    11 Z+   <defunct> ${M}`,
    // "Trying to exit", as BSD ps marks it.
    `   13     1    13 RE   (node)`,
    `   12     1    12 S    node x --marker ${M}`,
  ].join('\n');
  assert.deepEqual(parsePs(out).map((row) => row.pid), [12]);
  assert.throws(() => parsePs('ps: illegal option -- E\nusage: ps [-AaCcEefhjlMmrSTvwXx]\n'), /ps/);
  assert.deepEqual(parsePs(''), []);
});

const proc = (pid: number, ppid: number, pgid: number, text = ''): ProcessRow => ({ pid, ppid, pgid, text });
const marked = `node x --marker ${M}`;

// A process table that behaves: a signal ends what it reaches, unless the process is
// deaf to SIGTERM or cannot be ended at all; what the dead leave behind goes to pid 1.
// `scanMs` is what one look at the table costs; `afterSleep` lets the table change
// while kill() waits.
function world(
  initial: ProcessRow[],
  traits: { deaf?: number[]; immortal?: number[]; scanMs?: number; afterSleep?: (rows: ProcessRow[]) => ProcessRow[] } = {},
) {
  let rows = initial.map((row) => ({ ...row }));
  const sent: [number, string][] = [];
  const sentAt: number[] = [];
  const deaf = new Set(traits.deaf);
  const immortal = new Set(traits.immortal);
  const clock = { slept: 0, now: 0 };
  const system: PosixSystem = {
    self: SELF,
    now: () => clock.now,
    async table() {
      clock.now += traits.scanMs ?? 0;
      return rows.map((row) => ({ ...row }));
    },
    signal(target, signal) {
      sent.push([target, signal]);
      sentAt.push(clock.now);
      const reached = rows.filter((row) => (target < 0 ? row.pgid === -target : row.pid === target)).map((row) => row.pid);
      if (reached.length === 0) throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' });
      const dead = new Set(reached.filter((pid) => !immortal.has(pid) && (signal === 'SIGKILL' || !deaf.has(pid))));
      rows = rows.filter((row) => !dead.has(row.pid)).map((row) => (dead.has(row.ppid) ? { ...row, ppid: 1 } : row));
    },
    sleep: async (ms) => {
      clock.slept += ms;
      clock.now += ms;
      if (traits.afterSleep) rows = traits.afterSleep(rows);
    },
  };
  const timing = { termGraceMs: 1000, killWaitMs: 500, pollMs: 100 };
  return { system, sent, sentAt, clock, timing, processes: posixProcesses(system, timing), alive: () => rows.map((row) => row.pid) };
}

// Everything else on the machine: init, the service and its shell, another user's Router.
const BYSTANDERS = [
  proc(1, 0, 1, '/sbin/init'),
  proc(900, 1, 900, 'bash'),
  proc(SELF, 900, 900, 'node service/main.ts'),
  proc(950, SELF, 900, 'ssh host bash -s'),
  proc(70, 1, 70, `node x --marker ${OTHER}`),
  proc(71, 70, 70, 'sleep 60'),
];
const BYSTANDER_PIDS = BYSTANDERS.map((row) => row.pid);

test('kill: the whole group goes with one signal, and nothing else is touched', async () => {
  const w = world([...BYSTANDERS, proc(10, SELF, 10, marked), proc(11, 10, 10, 'sleep 60'), proc(12, 11, 10, 'sleep 61')]);
  await w.processes.kill(10, M);
  assert.deepEqual(w.sent, [[-10, 'SIGTERM']]);
  assert.deepEqual(w.alive(), BYSTANDER_PIDS);
});

test('kill: a descendant that left the group is ended too, by the parent links', async () => {
  const w = world([
    ...BYSTANDERS,
    proc(10, SELF, 10, marked),
    proc(11, 10, 10, 'in the group'),
    // Its own session, and a child and grandchild in there with it.
    proc(12, 10, 12, 'left the group'),
    proc(13, 12, 12, 'child of the one that left'),
    proc(14, 13, 14, 'left again'),
  ]);
  await w.processes.kill(10, M);
  assert.deepEqual(w.sent.filter(([, signal]) => signal !== 'SIGTERM'), []);
  assert.deepEqual(w.sent.map(([target]) => target).sort((a, b) => a - b), [-10, 12, 13, 14]);
  assert.deepEqual(w.alive(), BYSTANDER_PIDS);
});

test('kill: a group member whose parent is long dead goes with the group, and what it started is found through it', async () => {
  const w = world([...BYSTANDERS, proc(10, SELF, 10, marked), proc(11, 1, 10, 'reparented member'), proc(12, 11, 12, 'left the group')]);
  await w.processes.kill(10, M);
  assert.deepEqual(w.alive(), BYSTANDER_PIDS);
  assert.ok(w.sent.some(([target]) => target === 12));
});

test('kill: a target that is already gone is not an error and sends nothing', async () => {
  const w = world(BYSTANDERS);
  await w.processes.kill(10, M);
  assert.deepEqual(w.sent, []);
});

test('kill: what ignores SIGTERM gets SIGKILL after the grace period, and only that', async () => {
  const w = world(
    [...BYSTANDERS, proc(10, SELF, 10, marked), proc(11, 10, 10, 'deaf, in the group'), proc(12, 10, 12, 'deaf, left the group'), proc(13, 10, 13, 'listens')],
    { deaf: [11, 12] },
  );
  await w.processes.kill(10, M);
  const firstKill = w.sent.findIndex(([, signal]) => signal === 'SIGKILL');
  assert.deepEqual(w.sent.slice(0, firstKill).sort(([a], [b]) => a - b), [[-10, 'SIGTERM'], [12, 'SIGTERM'], [13, 'SIGTERM']]);
  // By now 12 has no living parent to be reached through: it is known from the first look.
  assert.deepEqual(w.sent.slice(firstKill).sort(([a], [b]) => a - b), [[-10, 'SIGKILL'], [12, 'SIGKILL']]);
  assert.ok(w.clock.slept >= w.timing.termGraceMs, `只等了 ${w.clock.slept} 毫秒就升级`);
  assert.deepEqual(w.alive(), BYSTANDER_PIDS);
});

test('kill: a root that listens is not kept waiting for the grace period', async () => {
  const w = world([...BYSTANDERS, proc(10, SELF, 10, marked)]);
  await w.processes.kill(10, M);
  assert.ok(w.clock.slept <= w.timing.pollMs, `等了 ${w.clock.slept} 毫秒`);
});

test('kill: the grace period is time on the clock, however long a look at the table takes', async () => {
  // On a machine with thousands of processes one look can take longer than the pause between looks.
  const w = world([...BYSTANDERS, proc(10, SELF, 10, marked)], { deaf: [10], scanMs: 400 });
  await w.processes.kill(10, M);
  const [termAt, killAt] = w.sentAt as [number, number];
  assert.deepEqual(w.sent, [[-10, 'SIGTERM'], [-10, 'SIGKILL']]);
  const waited = killAt - termAt;
  assert.ok(waited >= w.timing.termGraceMs, `只等了 ${waited} 毫秒`);
  assert.ok(waited < w.timing.termGraceMs + 400 + w.timing.pollMs, `等了 ${waited} 毫秒，宽限期只有 ${w.timing.termGraceMs}`);
});

test('kill: a pid that came to mean another process during the wait is left alone', async () => {
  const stranger = { ...proc(12, 1, 12, 'postgres'), born: 'later' };
  const w = world(
    [...BYSTANDERS, proc(10, SELF, 10, marked), { ...proc(12, 10, 12, 'deaf, left the group'), born: 'then' }, proc(13, 12, 12, 'its child')],
    {
      deaf: [12],
      // The deaf one ends by itself and its number goes to someone new, with a child of its own.
      afterSleep: (rows) => [...rows.filter((row) => row.pid !== 12 && row.pid !== 13), stranger, proc(14, 12, 12, 'postgres worker')],
    },
  );
  await w.processes.kill(10, M);
  assert.deepEqual(w.sent.filter(([, signal]) => signal === 'SIGKILL'), []);
  assert.deepEqual(w.sent.filter(([target]) => target === 14), []);
  assert.deepEqual(w.alive(), [...BYSTANDER_PIDS, 12, 14]);
  assert.ok(w.clock.slept <= w.timing.pollMs, '树已经没了，不该再等');
});

test('kill: what even SIGKILL does not end is left to the caller, after a bounded wait', async () => {
  const w = world([...BYSTANDERS, proc(10, SELF, 10, marked)], { immortal: [10] });
  await w.processes.kill(10, M);
  assert.deepEqual(w.sent, [[-10, 'SIGTERM'], [-10, 'SIGKILL']]);
  assert.ok(w.clock.slept <= w.timing.termGraceMs + w.timing.killWaitMs + 2 * w.timing.pollMs, `等了 ${w.clock.slept} 毫秒`);
  assert.deepEqual(await w.processes.find(M), [10], '调用方复查时它还在');
});

test('kill: a target that does not lead its group is signalled alone, never that group', async () => {
  // A leftover the service's own shell started: its group is the service's.
  const w = world([...BYSTANDERS, proc(10, 900, 900, marked), proc(11, 10, 900, 'its child')]);
  await w.processes.kill(10, M);
  assert.deepEqual(w.sent.sort(([a], [b]) => a - b), [[10, 'SIGTERM'], [11, 'SIGTERM']]);
  assert.deepEqual(w.alive(), BYSTANDER_PIDS);
});

test('kill: the service and pid 1 are never signalled, not even as part of a marked tree or group', async () => {
  // Made up on purpose: the service descends from a marked process and shares its group,
  // and pid 1 claims that process as its parent.
  const w = world([proc(1, 10, 1, 'init'), proc(10, 2, 10, marked), proc(SELF, 10, 10, 'node service/main.ts'), proc(11, 10, 10, 'sibling')]);
  await w.processes.kill(10, M);
  assert.deepEqual(w.sent.sort(([a], [b]) => a - b), [[10, 'SIGTERM'], [11, 'SIGTERM']]);
  assert.deepEqual(w.alive(), [1, SELF]);
});

for (const pid of [1, 0, -1, -10, 1.5, Number.NaN, SELF]) {
  test(`kill: pid ${pid} is refused before anything is sent`, async () => {
    const w = world([...BYSTANDERS, proc(10, SELF, 10, marked)]);
    await assert.rejects(w.processes.kill(pid, M), /不向/);
    assert.deepEqual(w.sent, []);
  });
}

test('kill: a process without the marker is never signalled, and the caller is told', async () => {
  // The pid was the Router's a moment ago and is someone else's now.
  const w = world([...BYSTANDERS, proc(10, SELF, 10, 'vim notes.txt'), proc(11, 10, 10, 'its child')]);
  await assert.rejects(w.processes.kill(10, M), /不带标记/);
  await assert.rejects(w.processes.kill(70, M), /不带标记/, '别人的标记不算');
  await assert.rejects(w.processes.kill(10, ''), /不带标记/);
  assert.deepEqual(w.sent, []);
  assert.deepEqual(w.alive(), [...BYSTANDER_PIDS, 10, 11]);
});

test('kill: a target with no marker at one look gets a second look before anyone is told', async () => {
  const bare = proc(10, SELF, 10, '(node)');
  // Caught between its last breath and leaving the table: gone by the next look.
  const leaving = world([...BYSTANDERS, bare], { afterSleep: (rows) => rows.filter((row) => row.pid !== 10) });
  await leaving.processes.kill(10, M);
  assert.deepEqual(leaving.sent, []);
  // Caught before its command line was there to read.
  const arriving = world([...BYSTANDERS, bare], { afterSleep: (rows) => rows.map((row) => (row.pid === 10 ? { ...row, text: marked } : row)) });
  await arriving.processes.kill(10, M);
  assert.deepEqual(arriving.sent, [[-10, 'SIGTERM']]);
  assert.deepEqual(arriving.alive(), BYSTANDER_PIDS);
});

test('kill: a process that ends between the look and the signal is not an error; any other failure is', async () => {
  const table = [proc(10, SELF, 10, marked), proc(12, 10, 12, 'left the group')];
  const failing = (code: string): PosixSystem => {
    let now = 0;
    return {
      self: SELF,
      now: () => now,
      table: async () => table,
      signal() {
        throw Object.assign(new Error(`kill ${code}`), { code });
      },
      sleep: async (ms) => {
        now += ms;
      },
    };
  };
  const timing = { termGraceMs: 200, killWaitMs: 200, pollMs: 100 };
  await posixProcesses(failing('ESRCH'), timing).kill(10, M);
  // Not ours to signal: the caller's next look finds it and says so.
  await posixProcesses(failing('EPERM'), timing).kill(10, M);
  await assert.rejects(posixProcesses(failing('EINVAL'), timing).kill(10, M), /EINVAL/);
});

test('each platform gets its own implementation', () => {
  assert.equal(selectProcesses('win32'), windowsProcesses);
  assert.equal(selectProcesses('linux'), linuxProcesses);
  assert.equal(selectProcesses('darwin'), psProcesses);
  assert.equal(hostProcesses, selectProcesses(process.platform));
});

test('a platform nobody wrote this for is refused by name, not served by guesswork', async () => {
  const processes = selectProcesses('freebsd');
  await assert.rejects(processes.find(M), /freebsd/);
  await assert.rejects(processes.kill(10, M), /freebsd/);
});

test('only a POSIX root is started in its own group', () => {
  assert.equal(rootSpawnOptions('linux').detached, true);
  assert.equal(rootSpawnOptions('darwin').detached, true);
  // On Windows `detached` means no console at all, and the tree is found by parent links.
  assert.equal(rootSpawnOptions('win32').detached, false);
});

test('for real: a marked tree is found whole and ended by one kill of its root', { timeout: 60_000 }, async (t) => {
  const marker = randomUUID();
  const idle = 'setInterval(() => {}, 1000)';
  // One child beside it, one that leaves for a session of its own.
  const root = spawn(
    process.execPath,
    [
      '-e',
      `const { spawn } = require('node:child_process');
       const args = ['-e', ${JSON.stringify(idle)}, '--', '--marker', process.argv.at(-1)];
       spawn(process.execPath, args, { stdio: 'ignore', windowsHide: true });
       spawn(process.execPath, args, { stdio: 'ignore', windowsHide: true, detached: true });
       ${idle};`,
      '--',
      '--marker',
      marker,
    ],
    { stdio: 'ignore', ...rootSpawnOptions(process.platform) },
  );
  let found: number[] = [];
  t.after(() => {
    for (const pid of found) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // Gone, as it should be.
      }
    }
  });
  const within = async (ms: number, done: () => boolean): Promise<void> => {
    for (const deadline = Date.now() + ms; ; ) {
      found = await hostProcesses.find(marker);
      if (done() || Date.now() > deadline) return;
      await sleep(100);
    }
  };
  await within(20_000, () => found.length === 3);
  assert.equal(found.length, 3, `标记找到：${found.join(', ')}`);
  assert.ok(found.includes(root.pid!));
  assert.ok(!found.includes(process.pid));

  await hostProcesses.kill(root.pid!, marker);
  // The contract is "the caller looks again", which is what the Host does.
  await within(5000, () => found.length === 0);
  assert.deepEqual(found, []);
});
