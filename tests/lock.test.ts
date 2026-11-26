// Guards against a pid being taken for a process: a service that crashed in a container
// comes back with the pid it had and must not read its own old lock as another live
// service (it would never start again); a pid handed to some other program after a crash
// must not keep the data directory locked for as long as that program lives; and a
// second holder in the very same process must still be refused. A lock from a version
// that recorded no start time, or a system that cannot say when a process began, falls
// back to the pid alone and never to "nobody holds it". And against a process that has ended
// but that its parent has not collected yet (a zombie) counting as alive: where the
// parent is busy or never collects — a container with no init — `tycho stop` would wait
// out its limit and a crashed service would keep its own data directory locked for good.
// And against two machines sharing a data directory (a cluster instance's home) writing
// one ledger: a pid means nothing across machines, so each would take the other's live
// lock for a stale one — the lock records the machine that wrote it, and a lock from
// another machine is never taken over here, only reported with the way out. A lock of
// this machine's own, an older lock that names no machine, and two starts at the same
// instant all behave exactly as before.
import './guard.ts';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { acquireLock, claimLock, elsewhereText, holderAlive, isAlive, lockElsewhere, machineId, processStart, readHolder, startQuestions } from '../service/lock.ts';

function lockFile(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'tycho-lock-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'lock');
}

const quiet = (): void => {};

// A process that stays until the test ends.
async function idle(t: TestContext): Promise<number> {
  const child = spawn(process.execPath, ['-e', 'console.log("up"); setInterval(() => {}, 1000)'], { stdio: ['ignore', 'pipe', 'ignore'] });
  t.after(() => void child.kill());
  await once(child.stdout, 'data');
  return child.pid!;
}

// A pid that is certainly gone: the second machine of a shared home sees the first
// machine's holder exactly this way.
async function gonePid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  await once(child, 'exit');
  return child.pid!;
}

async function until(what: string, condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`没有等到：${what}`);
    await sleep(20);
  }
}

const LOCK = new URL('../service/lock.ts', import.meta.url).href;

// A service starting at a named instant and staying up: it waits for that instant, so both
// try the very same lock file at the same time, leaves what happened in a file of its own
// rather than on a pipe, and keeps running so whoever lost sees a live holder.
function racer(file: string, answer: string, at: number) {
  const script = `
    import { writeFileSync } from 'node:fs';
    import { acquireLock } from ${JSON.stringify(LOCK)};
    const file = ${JSON.stringify(file)};
    while (Date.now() < ${at}) {}
    let said;
    try { acquireLock(file, () => {}); said = { won: true }; }
    catch (err) { said = { lost: err.message }; }
    writeFileSync(${JSON.stringify(answer)}, JSON.stringify({ pid: process.pid, ...said }));
    setInterval(() => {}, 1000);
  `;
  return spawn(process.execPath, ['--no-warnings', '--input-type=module', '-e', script], { stdio: 'ignore', windowsHide: true });
}

test('the system says when this process began, the same every time it is asked, and differently for another process', async (t) => {
  const own = processStart(process.pid);
  assert.ok(own, '这个平台上应当问得出进程的启动时刻');
  assert.equal(processStart(process.pid), own);
  const other = await idle(t);
  assert.ok(processStart(other));
  assert.notEqual(processStart(other), own);
});

test('本进程的启动时刻读到就留着；第一次没读到不留结论，下次还问；别的 pid 每次都问', () => {
  const answers: (string | undefined)[] = [undefined, 'the same moment', 'a stranger now'];
  const asked: number[] = [];
  const questions = startQuestions(
    (pid) => { asked.push(pid); return answers.shift(); },
    async (pid) => { asked.push(pid); return answers.shift(); },
    7,
  );
  assert.equal(questions.start(7), undefined, '系统这次没有答出来');
  assert.equal(questions.start(7), 'the same moment', '没有结论就不算结论：下次照样问');
  assert.equal(questions.start(7), 'the same moment', '读到了就留着');
  // Another pid is asked about every time: its number comes to mean another process once
  // the first is gone, so an old answer would name a stranger.
  assert.equal(questions.start(8), 'a stranger now');
  assert.deepEqual(asked, [7, 7, 8], '问了两次本进程，一次别的进程');
});

test('并发问本进程的启动时刻：在空中的那次问候只有一个', async () => {
  let asks = 0;
  let release!: (answer: string) => void;
  const questions = startQuestions(
    () => { throw new Error('这条测的是异步问法'); },
    () => {
      asks += 1;
      return new Promise<string>((resolve) => { release = resolve; });
    },
    7,
  );
  const both = Promise.all([questions.startLater(7), questions.startLater(7)]);
  assert.equal(asks, 1, '两个并发的问题只问了一次');
  release('once');
  assert.deepEqual(await both, ['once', 'once']);
  assert.equal(await questions.startLater(7), 'once', '问到之后不再问');
  assert.equal(asks, 1);
});

test('the lock records the pid, when its process began, and the machine that wrote it', (t) => {
  const file = lockFile(t);
  acquireLock(file, quiet);
  const holder = readHolder(file)!;
  assert.ok(machineId(), '这台机器应当说得出来自己是谁');
  assert.equal(holder.pid, process.pid);
  assert.equal(holder.start, processStart(process.pid));
  assert.equal(holder.machine, machineId());
  assert.equal(holder.hostname, hostname());
  assert.equal(lockElsewhere(holder), undefined, '本机写的锁不是另一台机器的');
});

test('a lock another machine wrote is not taken for a stale one, and says what to do about it', async (t) => {
  const file = lockFile(t);
  const pid = await gonePid();
  const body = JSON.stringify({ pid, machine: 'another-machine', hostname: 'node-b', started_at: 'then' });
  writeFileSync(file, body);
  const holder = readHolder(file)!;
  assert.equal(lockElsewhere(holder), 'another-machine');
  assert.equal(holderAlive(holder), true, '本机看不见的持有者不判为不在');
  const said: string[] = [];
  assert.equal(claimLock(file, (line) => said.push(line))?.pid, pid, '锁还是那台机器的');
  assert.deepEqual(said, [], '没有说“已不在，覆盖”');
  assert.equal(readFileSync(file, 'utf8'), body, '锁文件原样不动');

  const problem = ((): string => {
    try {
      acquireLock(file, quiet);
      return '';
    } catch (err) {
      return (err as Error).message;
    }
  })();
  assert.ok(problem, '另一台机器的锁要拒绝启动');
  assert.match(problem, /node-b/, '报出对方的机器');
  assert.match(problem, /another-machine/, '报出对方的机器身份');
  assert.match(problem, new RegExp(`进程 ${pid}`), '报出对方的进程号');
  assert.ok(problem.includes(file), `说明确认对方已停后删掉 ${file}`);
  assert.equal(readFileSync(file, 'utf8'), body);
});

test('a lock of this machine for a process that is gone is taken over as before', async (t) => {
  const file = lockFile(t);
  const pid = await gonePid();
  writeFileSync(file, JSON.stringify({ pid, machine: machineId(), hostname: hostname(), started_at: 'then' }));
  const said: string[] = [];
  assert.equal(claimLock(file, (line) => said.push(line)), null, '同机的死锁照常接管');
  assert.equal(readHolder(file)?.pid, process.pid);
  assert.match(said.join('\n'), /已不在/);
});

test('a lock from a version that named no machine is read as before, and the pid still decides', async (t) => {
  const file = lockFile(t);
  const gone = await gonePid();
  writeFileSync(file, JSON.stringify({ pid: gone, process_start: 'a time', started_at: 'then' }));
  assert.deepEqual(readHolder(file), { pid: gone, start: 'a time' }, '旧格式原样读出来，没有凭空多出机器');
  assert.equal(lockElsewhere(readHolder(file)!), undefined, '没写机器的不算另一台机器');
  assert.equal(claimLock(file, quiet), null, '旧格式的死锁照旧接管');
  assert.equal(readHolder(file)?.pid, process.pid);

  const start = processStart(process.pid);
  writeFileSync(file, JSON.stringify({ pid: process.pid, ...(start === undefined ? {} : { process_start: start }), started_at: 'then' }));
  assert.equal(claimLock(file, quiet)?.pid, process.pid, '活着的旧格式锁不被覆盖');
});

test('two services starting at the same instant: one takes the lock, the other reports the holder', async (t) => {
  const file = lockFile(t);
  const answers = [`${file}.1`, `${file}.2`];
  const at = Date.now() + 300;
  const children = answers.map((answer) => racer(file, answer, at));
  t.after(() => children.forEach((child) => child.kill()));
  await until('两个抢锁的都说了结果', () => answers.every((answer) => existsSync(answer)));
  const said = answers.map((answer) => JSON.parse(readFileSync(answer, 'utf8')) as { pid: number; won?: boolean; lost?: string });
  const winners = said.filter((answer) => answer.won === true);
  assert.equal(winners.length, 1, `只有一个拿到锁：${JSON.stringify(said)}`);
  assert.equal(readHolder(file)?.pid, winners[0]!.pid, '锁里是赢的那个');
  assert.match(said.find((answer) => answer.won !== true)!.lost ?? '', new RegExp(`另一份服务（${winners[0]!.pid}）`), '输的那个报出持有者，不覆盖');
});

test('elsewhereText names the machine, its pid and the file to delete', (t) => {
  const file = lockFile(t);
  const text = elsewhereText(file, { pid: 4242, machine: 'another-machine', hostname: 'node-b' });
  assert.match(text, /node-b/);
  assert.match(text, /another-machine/);
  assert.match(text, /进程 4242/);
  assert.ok(text.includes(file));
  assert.match(text, /删掉/, '说出确认对方已停之后怎么处理');
});

test('a lock holding this pid from an earlier process is stale: the service that restarts under the same pid takes it over', (t) => {
  const file = lockFile(t);
  writeFileSync(file, JSON.stringify({ pid: process.pid, process_start: 'some earlier process' }));
  const said: string[] = [];
  acquireLock(file, (line) => said.push(line));
  assert.equal(readHolder(file)?.start, processStart(process.pid));
  assert.match(said.join('\n'), /已不在/);
});

test('a second holder in the same process is still refused', (t) => {
  const file = lockFile(t);
  acquireLock(file, quiet);
  const before = readFileSync(file, 'utf8');
  assert.throws(() => acquireLock(file, quiet), new RegExp(`另一份服务（${process.pid}）`));
  assert.equal(readFileSync(file, 'utf8'), before);
});

test('a live pid that now belongs to another process does not hold the lock', async (t) => {
  const file = lockFile(t);
  const pid = await idle(t);
  writeFileSync(file, JSON.stringify({ pid, process_start: 'the process that had this pid before' }));
  assert.equal(holderAlive(readHolder(file)!), false);
  assert.equal(claimLock(file, quiet), null);
  assert.equal(readHolder(file)?.pid, process.pid);
});

test('a live process whose start matches holds the lock', async (t) => {
  const file = lockFile(t);
  const pid = await idle(t);
  writeFileSync(file, JSON.stringify({ pid, process_start: processStart(pid) }));
  assert.equal(claimLock(file, quiet)?.pid, pid);
  assert.equal(readHolder(file)?.pid, pid, '活着的持有者的锁不能被动');
});

test('a lock with no start time is judged by the pid alone', async (t) => {
  const file = lockFile(t);
  const pid = await idle(t);
  writeFileSync(file, JSON.stringify({ pid, started_at: 'then' }));
  assert.equal(holderAlive(readHolder(file)!), true);
  assert.equal(claimLock(file, quiet)?.pid, pid);
});

test('a process that has ended and is not collected yet is not alive, and holds no lock', { skip: process.platform !== 'linux' && '只有 Linux 上能不靠外部命令问出进程是否已结束' }, (t) => {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  const pid = child.pid!;
  t.after(() => void child.kill());
  const start = processStart(pid);
  // Without giving the event loop a turn: this process is the parent and collects its
  // child only there, so the child stays a zombie for as long as this stays synchronous.
  const state = (): string => {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.charAt(stat.lastIndexOf(')') + 2);
  };
  const pause = new Int32Array(new SharedArrayBuffer(4));
  for (let waited = 0; state() !== 'Z'; waited += 10) {
    assert.ok(waited < 10_000, '子进程没有结束');
    Atomics.wait(pause, 0, 0, 10);
  }
  assert.equal(isAlive(pid), false);
  assert.equal(holderAlive({ pid, ...(start === undefined ? {} : { start }) }), false);
});
