// Guards docs/design/nodes.md §11 step 3 on real processes: an upgrade of the installed
// program leaves the machine's client and the round it is running exactly where they are,
// keeps the version the client still starts rounds from, and an uninstall asks the client
// to leave before the program goes. The version the client runs from, the candidates that
// replace it and the upgrade itself are this repository's own code, unpacked into a prefix
// the way the install scripts unpack a release; the host is a stand-in that hands out start
// commands; the round's Worker is a real child process (tests/fake-executor.mjs).
//
// What this file is here to catch:
//   - an upgrade that stops the client in order to start it again on the new version: the
//     watch process of a running round is not the client's, and the round does not survive
//     being restarted under it (nodes.md §4.2, §4.4);
//   - one that removes the version directory the client and its watch are running from, or
//     anything under the data directory they keep the round's evidence in;
//   - a second upgrade removing the version a still-running client starts every new round's
//     watch process from: the client polls on, takes a start, and nothing starts;
//   - an uninstall that deletes the program under a client that keeps taking work, or one
//     that stops the client through its service manager and takes the running round with it;
//   - a client that never gets as far as polling the host while a command waits for it, or
//     a start it never turns into a watch process and a Worker;
//   - a test that calls a round "running" after a fixed sleep instead of reading what the
//     watch process wrote about itself, or one that reads the client's report of a start
//     the moment the watch's evidence is on disk, before the client has read it and sent
//     the report (the client looks on a clock of its own);
//   - a cleanup that signals a process it has just seen alive and fails because the
//     process left in between: a watch whose Worker was ended leaves on its own;
//   - a bench that fails while it is being set up and leaves its client running, or a
//     cleanup that removes the directory before the processes in it have ended — also one
//     that takes a killed Worker's exit code for its end: on Windows the code is there
//     before the Worker's working directory, inside the test's own, is let go;
//   - an uninstall checked as if on Linux while its processes are this machine's: on
//     Windows the program can be handed to a background helper instead of going at once;
//   - a round under a run id another test file also uses: a round's residue is cleared by
//     its marker across the whole machine, so the other file's round ending kills this
//     one's Worker.
import './guard.ts';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { deferredRemoval } from '../cli/install.ts';
import { runCli } from '../cli/main.ts';
import { writeRecord } from '../cli/record.ts';
import { encodedCommand, tool } from '../cli/system.ts';
import { writeOrigin } from '../node/cli.ts';
import { identityOf, writeToken } from '../node/client.ts';
import type { RunBox } from '../node/runbox.ts';
import { boxOf, readExit, readWatchEvidence, readWorkerEvidence } from '../node/runbox.ts';
import { isAlive } from '../service/lock.ts';
import type { NodeCommand } from '../shared/node-protocol.ts';
import { NODE_PROTOCOL } from '../shared/node-protocol.ts';
import type { Stage, StageOptions } from './cli-helpers.ts';
import { ownProcess, REPO, realApp, stage, until } from './cli-helpers.ts';
import { runId } from './helpers.ts';

const FAKE = join(import.meta.dirname, 'fake-executor.mjs');
const WAIT_MS = 60_000;
const options = { timeout: 300_000 };

// Ends a process this test started, by pid. One that has left between the look and the
// signal is what the signal was for: POSIX says so with ESRCH, and that alone is not a
// failure. Anything else (a pid this process may not signal, an unknown signal) still is.
function endIfThere(pid: number): void {
  try {
    process.kill(pid);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ESRCH') throw err;
  }
}

// The client's own log, put into the message of a failure about a client that did not do
// what it was supposed to: it is where the client says why.
function logTail(file: string): string {
  try {
    return `\n客户端（${file}）最后几行：\n${readFileSync(file, 'utf8').split('\n').slice(-20).join('\n')}`;
  } catch {
    return `\n（客户端没有写下日志 ${file}）`;
  }
}

// A host as the client sees one: each poll is answered with the next command waiting to go
// out, or with nothing. It counts what it was asked, so "the client is polling" is something
// a test waits for rather than sleeps on, and keeps what the client reported back.
function standInHost() {
  let polls = 0;
  const queue: NodeCommand[] = [];
  const reports: { command_id: string; ok: boolean; result?: unknown; error?: string }[] = [];
  // Closing is asked twice — once by the test and once by its own cleanup — and a second
  // `close` after the server is down never calls back: the process would hang at the end
  // of a test that has already said everything it has to say.
  let closed = false;
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const answer = (code: number, body?: unknown): void => {
        res.writeHead(code, { 'Content-Type': 'application/json' });
        res.end(body === undefined ? '' : JSON.stringify(body));
      };
      if (req.method !== 'POST') return answer(404, { error: `没有这条接口：${req.method} ${req.url}` });
      if (req.url === '/api/node/poll') {
        polls += 1;
        return answer(200, { protocol: NODE_PROTOCOL, command: queue.shift() ?? null });
      }
      if (req.url === '/api/node/status') return answer(200, { protocol: NODE_PROTOCOL, machine_id: 'm1', connected: true });
      if (req.url === '/api/node/report') {
        reports.push(JSON.parse(Buffer.concat(chunks).toString('utf8')) as (typeof reports)[number]);
        return answer(202);
      }
      answer(404, { error: `没有这条接口：${req.url}` });
    });
  });
  return {
    polls: (): number => polls,
    reports,
    send: (command: NodeCommand): void => {
      queue.push(command);
    },
    // Where this machine reaches it, and nowhere else.
    async listen(): Promise<string> {
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    },
    // A client killed mid-poll leaves a connection the server would otherwise wait on.
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

// A round this bench handed out, with the pids its watch wrote about it once they are known.
interface Round {
  box: RunBox;
  watch?: number;
  worker?: number;
}

interface Bench {
  s: Stage;
  prefix: string;
  log: string;
  host: ReturnType<typeof standInHost>;
  client: ChildProcess;
  // A round the host hands this machine: the snapshot is laid down first, because the
  // client refuses to start a round whose snapshot is not on the machine yet. The Worker
  // sleeps long enough to outlive the test: what is watched is that nothing ends it.
  // Under an id of its own: see runId.
  startRound(): Promise<{ id: string; box: RunBox; watch: number; worker: number }>;
  // Installs this repository as `version` over the prefix, the way `tycho update` runs the
  // candidate's own install-self.
  upgrade(version: string): Promise<number>;
  // Everything this test started, ended.
  stop(): Promise<void>;
}

// This repository's own code in a prefix as version 1.0.0, a machine as `tycho node join`
// leaves it (an identity, the host's token, the host's address), and the client running out
// of that version against the stand-in host.
async function bench(t: TestContext, options: StageOptions = {}): Promise<Bench> {
  const s = stage(t, options);
  const prefix = join(s.dir, 'prefix');
  const log = join(s.dir, 'node.log');
  const host = standInHost();
  const rounds: Round[] = [];
  let client: ChildProcess | undefined;
  // The client is waited for by its own event, and not with cli-helpers' `exited`: that
  // one waits on the exit code, and a child this test killed has none (on POSIX it has a
  // signal instead) — a second call would wait for an event that has already been.
  const ended = (child: ChildProcess): Promise<void> =>
    child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : new Promise((resolve) => child.once('exit', () => resolve()));
  // Everything this bench started, ended and seen gone. Owned by the stage's teardown from
  // before anything is started, so a bench that fails while it is being set up is torn
  // down all the same, and always before the stage removes the directory these processes
  // sit in. A test also calls it from its own `finally`; a second call finds nothing left.
  //
  // A round is ended the way it ends on a machine: its Worker goes, and its watch process,
  // which waits on the Worker itself, writes the round's exit and leaves. That exit is what
  // says the Worker is gone, not `isAlive`: on Windows a killed process already answers with
  // an exit code while the system is still closing its handles — the Worker's working
  // directory among them, the task directory inside this test's own — and removing the
  // directory in that moment fails. The watch hears of the Worker only once the process has
  // really ended. The watch itself runs elsewhere and holds nothing open in here.
  // The client goes first: it reads a round's ending and would act on it.
  const stop = async (): Promise<void> => {
    if (client?.pid !== undefined) {
      if (isAlive(client.pid)) client.kill();
      await ended(client);
    }
    const over = (round: Round): boolean => {
      const watchGone = round.watch === undefined || !isAlive(round.watch);
      if (round.worker === undefined) return watchGone;
      // A watch that died before it saw its Worker go cannot say so: then the Worker's own
      // answer is all there is.
      return watchGone && (readExit(round.box) !== null || !isAlive(round.worker));
    };
    for (const round of rounds) {
      if (over(round)) continue;
      // A round whose exit is written is left alone: its Worker is gone and the pid may be
      // someone else's by now. Before that, a live watch still holds the Worker's pid.
      if (round.worker !== undefined) {
        if (readExit(round.box) === null) endIfThere(round.worker);
      } else if (round.watch !== undefined) {
        endIfThere(round.watch);
      }
    }
    await until('每一轮的 Worker 都结束了，看管进程记下结束后也走了', () => rounds.every(over), WAIT_MS);
    await host.close();
  };
  ownProcess(t, stop);

  realApp(join(prefix, 'versions', '1.0.0'), '1.0.0', { source: REPO });
  writeFileSync(join(prefix, 'current'), '1.0.0');
  writeRecord(prefix, { files: ['versions/1.0.0', 'current'], paths: [] });
  const identity = identityOf(s.dataDir);
  writeToken(identity, 'f'.repeat(64));
  writeOrigin(identity, await host.listen());
  client = spawn(process.execPath, [join(prefix, 'versions', '1.0.0', 'cli', 'main.ts'), 'node', 'run', '--log', log], {
    env: { ...s.cli.system.env, TYCHO_DATA: s.dataDir, TYCHO_NODE_SUPERVISED: '1' },
    // Nothing is piped to it: a round's output is written where it belongs, and this
    // machine refuses a pipe on a child process.
    stdio: 'ignore',
    windowsHide: true,
  });
  try {
    await until('客户端开始向主机轮询', () => host.polls() > 0, WAIT_MS);
  } catch (err) {
    throw new Error(`${(err as Error).message}${logTail(log)}`);
  }

  return {
    s, prefix, log, host, client, stop,
    async startRound() {
      const id = runId('svc');
      const box = boxOf(s.dataDir, `tasks/t1/runs/${id}`);
      mkdirSync(join(box.runDir, 'snapshot'), { recursive: true });
      writeFileSync(join(box.runDir, 'snapshot', 'brief.md'), `# ${id}\n`);
      const round: Round = { box };
      rounds.push(round);
      host.send({
        id: `start-${id}`, kind: 'start', run_dir: `tasks/t1/runs/${id}`, task_id: 't1', run_id: id, round: rounds.length,
        argv: [process.execPath, FAKE], env: { TYCHO_FAKE_SLEEP_MS: '120000' }, credential: null,
      });
      try {
        await until('看管进程登记自己的 pid', () => (round.watch = readWatchEvidence(box).pid) !== undefined, WAIT_MS);
        await until('Worker 自己的 pid 写在证据里', () => (round.worker = readWorkerEvidence(box).pid) !== undefined, WAIT_MS);
      } catch (err) {
        throw new Error(`${(err as Error).message}${logTail(log)}`);
      }
      // The round is really running, not merely recorded: both processes this machine can
      // point at answer for themselves, and the round has no ending yet.
      assert.equal(isAlive(round.watch!), true, `看管进程 ${round.watch} 在跑`);
      assert.equal(isAlive(round.worker!), true, `这一轮的 Worker ${round.worker} 在跑`);
      assert.equal(existsSync(join(box.runDir, 'exit')), false, '这一轮还没有写下结束语');
      return { id, box, watch: round.watch!, worker: round.worker! };
    },
    async upgrade(version) {
      s.cli.appRoot = realApp(join(prefix, 'versions', `.staging-${process.pid}-${version}`), version, { source: REPO });
      s.out.length = 0;
      s.err.length = 0;
      return runCli(['install-self', '--prefix', prefix, '--node', process.execPath], s.cli);
    },
  };
}

test('升级：机器客户端和它正在跑的那一轮都不受影响', options, async (t) => {
  const b = await bench(t);
  try {
    const { box, watch, worker } = await b.startRound();
    const polledBefore = b.host.polls();
    assert.equal(await b.upgrade('1.1.0'), 0, b.s.text());
    assert.equal(readFileSync(join(b.prefix, 'current'), 'utf8'), '1.1.0');

    // The client is not a service of this installation's autostart, and nothing about the
    // switch was its to end: neither the process taking commands, nor the watch process
    // that owns the round, nor the Worker below it. The program it runs from is still
    // there, and it is still asking the host for work.
    const clientExit = { exit: b.client.exitCode, signal: b.client.signalCode };
    assert.deepEqual(clientExit, { exit: null, signal: null }, `客户端没有结束${logTail(b.log)}`);
    assert.equal(isAlive(b.client.pid!), true, `客户端 ${b.client.pid} 还在跑`);
    assert.equal(isAlive(watch), true, '看管进程没有被升级结束');
    assert.equal(isAlive(worker), true, '这一轮的 Worker 没有被升级结束');
    assert.ok(existsSync(join(b.prefix, 'versions', '1.0.0', 'cli', 'main.ts')), '客户端和这一轮跑的版本目录还在');
    assert.equal(existsSync(join(box.runDir, 'exit')), false, '这一轮还在跑');
    // Waited for, not read at once: the poll this asks about is one the upgrade command
    // held up while it was switching the version.
    await until('客户端还在向主机要活', () => b.host.polls() > polledBefore, WAIT_MS);
  } finally {
    await b.stop();
  }
});

// The failure this guards: the cleanup kept only the versions a *service* of this
// installation was running from. A client that kept running through two upgrades still
// started every new round's watch process out of the version it began on — and that
// directory was gone after the second one, with no round running to keep it.
test('连升两次：原客户端还在用的版本目录留着，它照样能起新轮次', options, async (t) => {
  const b = await bench(t);
  try {
    assert.equal(await b.upgrade('1.1.0'), 0, b.s.text());
    assert.match(b.s.out.join('\n'), /机器客户端（进程 \d+）还在用 .*1\.0\.0/, '升级说出谁还在用旧版本');
    assert.equal(await b.upgrade('1.2.0'), 0, b.s.text());
    assert.equal(readFileSync(join(b.prefix, 'current'), 'utf8'), '1.2.0');
    assert.ok(existsSync(join(b.prefix, 'versions', '1.0.0', 'node', 'watch.ts')), '客户端还在用的版本目录没有被第二次升级清掉');
    assert.equal(isAlive(b.client.pid!), true, `客户端 ${b.client.pid} 还在跑`);

    // The original client, never restarted, takes a start now and turns it into a watch
    // process and a Worker — out of the directory the upgrades left it.
    const { id, watch, worker } = await b.startRound();
    assert.equal(isAlive(watch), true);
    assert.equal(isAlive(worker), true);
    // The client reports the start once it has read the watch's registration itself, on a
    // clock of its own, and the report travels over HTTP: it is waited for, not read the
    // moment the evidence is on disk.
    const started = (): { confirmed?: boolean } | undefined =>
      b.host.reports.find((report) => report.command_id === `start-${id}`)?.result as { confirmed?: boolean } | undefined;
    try {
      await until('客户端把这一轮的启动报告给主机', () => started() !== undefined, WAIT_MS);
    } catch (err) {
      throw new Error(`${(err as Error).message}${logTail(b.log)}`);
    }
    assert.equal(started()?.confirmed, true, `启动由看管进程登记确认${logTail(b.log)}`);
  } finally {
    await b.stop();
  }
});

// A whole-program uninstall run against a client running out of the installation, with a
// round of its going. The CLI is told it is on this very machine's platform: the client,
// the watch process and the Worker are real processes of this machine, and what Windows
// does with the program they ran from (keep it busy a moment, so that the installer hands
// it to a background helper) is part of what is checked. Autostart is not installed for
// either role: on Windows the stand-in task scheduler says so.
async function uninstalled(t: TestContext) {
  const b = await bench(t, {
    platform: process.platform,
    respond: (call) => (call.env.TYCHO_TASK !== undefined ? { stdout: 'absent\r\n' } : undefined),
  });
  const round = await b.startRound();
  const clientExit = new Promise<number | null>((resolve) => b.client.once('exit', (code) => resolve(code)));
  // What is not the installer's and must outlive the uninstall: a file of the owner's
  // inside the program directory, and one beside it.
  const keep = [join(b.prefix, 'owner-notes.txt'), join(b.s.dir, 'beside-prefix.txt')];
  for (const file of keep) writeFileSync(file, '主人的，不归安装器');
  b.s.cli.appRoot = join(b.prefix, 'versions', '1.0.0');
  b.s.out.length = 0;
  b.s.err.length = 0;
  const code = await runCli(['uninstall'], b.s.cli);
  return { b, round, code, clientExit, keep };
}

// The failure this guards: the whole-program uninstall stopped the host's service, removed
// both roles' autostart definitions and deleted the program — with the client still
// polling the host, which went on handing it rounds it could no longer start.
test('整包卸载：先请客户端自己退出，它是自己退的', options, async (t) => {
  const { b, code, clientExit } = await uninstalled(t);
  try {
    assert.equal(code, 0, b.s.text());
    assert.match(b.s.out.join('\n'), /已请机器客户端（进程 \d+）退出/);
    // Asked by its own mark and left by itself: exit code 0, which no service manager
    // restarts.
    assert.equal(await clientExit, 0, `客户端是自己退出的${logTail(b.log)}`);
    assert.match(readFileSync(b.log, 'utf8'), /已按要求停下/);
    assert.equal(isAlive(b.client.pid!), false, '客户端不在了');
  } finally {
    await b.stop();
  }
});

// The failure this guards: an uninstall that stops the client through its service manager,
// or anything else that takes the running round, its evidence or the machine's identity
// with the program.
test('整包卸载：看管进程、Worker 和任务证据留下，机器的身份还在', options, async (t) => {
  const { b, round, code } = await uninstalled(t);
  try {
    assert.equal(code, 0, b.s.text());
    assert.equal(isAlive(round.watch), true, '看管进程不归卸载管');
    assert.equal(isAlive(round.worker), true, '这一轮的 Worker 照跑');
    assert.equal(existsSync(join(round.box.runDir, 'exit')), false, '这一轮还在跑');
    assert.equal(existsSync(join(round.box.runDir, 'snapshot', 'brief.md')), true, '任务证据一个字不动');
    assert.ok(readWatchEvidence(round.box).pid !== undefined, '进程证据还在');
    assert.equal(existsSync(join(identityOf(b.s.dataDir).dir, 'token')), true, '机器的身份还在');
  } finally {
    await b.stop();
  }
});

// The failure this guards: a program left in place by an uninstall that said it was gone.
// On Windows a file a process has just let go of can still refuse to be deleted, and the
// installer then hands it to a background helper that deletes it once the uninstall's own
// process has ended (cli/install.ts). That process is this test's, which does not end
// here: the helper is run as the installer asked for it, for the same targets, after a
// process that has ended — which is what it waits for.
test('整包卸载：程序目录删掉——当场删，或在 Windows 上交给后台助手、最后由它删完', options, async (t) => {
  const { b, code, keep } = await uninstalled(t);
  // Deleting the right things, not merely deleting: what is not the installer's stays.
  const kept = (): void => {
    for (const file of keep) assert.equal(existsSync(file), true, `不归安装器的 ${file} 还在`);
  };
  try {
    assert.equal(code, 0, b.s.text());
    const versions = join(b.prefix, 'versions');
    const handed = b.s.launched.filter(({ file }) => /powershell/i.test(file));
    t.diagnostic(handed.length === 0 ? '程序当场删了' : '程序交给了后台助手');
    if (handed.length === 0) {
      assert.equal(existsSync(versions), false, `程序当场删了：${b.s.text()}`);
      kept();
      return;
    }
    assert.equal(process.platform, 'win32', '只有 Windows 上有后台助手');
    assert.equal(handed.length, 1);
    assert.match(b.s.out.join('\n'), /后台助手/);
    const script = Buffer.from(handed[0]!.args.at(-1)!, 'base64').toString('utf16le');
    // What was busy is some of what the record names; the record and the lock go with it.
    const recorded = [join(b.prefix, 'versions', '1.0.0'), join(b.prefix, 'current')];
    const tail = [join(b.prefix, 'install.json'), join(b.prefix, 'install.lock')];
    const targets = [[recorded[0]!], [recorded[1]!], recorded]
      .map((busy) => [...busy, ...tail])
      .find((waiting) => script === deferredRemoval(b.prefix, waiting, process.pid));
    assert.ok(targets, `后台助手拿到的是这次安装记下的东西：${script}`);
    const done = spawn(process.execPath, ['-e', '']);
    await new Promise((resolve) => done.once('close', resolve));
    const ran = spawnSync(tool(b.s.cli.system, 'powershell'), [
      '-NoProfile', '-NonInteractive', '-EncodedCommand', encodedCommand(deferredRemoval(b.prefix, targets, done.pid!)),
    ], { encoding: 'utf8', windowsHide: true });
    // What the helper leaves is what counts: it runs hidden and nobody reads its exit code.
    // It returns once it is done, so what it leaves is there to be looked at now.
    assert.equal(ran.error, undefined);
    assert.equal(existsSync(versions), false, `后台助手把程序目录删完：${ran.stderr}`);
    assert.equal(existsSync(join(b.prefix, 'install.json')), false, '安装记录和程序一起走');
    kept();
  } finally {
    await b.stop();
  }
});
