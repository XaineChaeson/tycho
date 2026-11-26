// Guards docs/design/nodes.md §1.3 and §11 step 4 end to end, with real processes: the
// Router asks for a quota, the round of its task is handed the material in its Worker's
// environment, a real `tycho node join --material-fd 0` on another data directory comes in
// with it — no six digits, no owner — takes a round of the project's work, and leaves by
// itself once the task it was spawned for is over and it is idle.
//
// What this file is here to catch: any of those hand-offs working only in-process (the
// material read from argv instead of a descriptor, the client never told to go, a leave
// that does not end the process or the registration), a spawned machine that never gets
// work, and the material landing in the new machine's log or data directory.
import './guard.ts';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { closeSync, existsSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';
import type { Ctx } from '../service/ledger.ts';
import { HOST_URL_ENV, JOIN_MATERIALS_ENV } from '../shared/node-protocol.ts';
import { bench, removeTree } from './node-run-fixture.ts';

const USER: Ctx = { actor: 'test' };
const REPO = join(import.meta.dirname, '..');
const CLI = join(REPO, 'cli', 'main.ts');

async function until<T>(read: () => T | undefined | false | null, what: string, timeoutMs = 60_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`等不到：${what}`);
    await sleep(50);
  }
}

function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? filesUnder(join(dir, entry.name)) : [join(dir, entry.name)]));
}

test('从签发到临时机器加入、跑一轮、离开：真的 tycho node join 进程', { timeout: 240_000 }, async (t) => {
  const scratch = mkdtempSync(join(tmpdir(), 'tycho-eph-proc-'));
  const envFile = join(scratch, 'env.json');
  const gate = join(scratch, 'gate');
  const ephDir = join(scratch, 'instance');
  const log = join(scratch, 'instance.log');
  let child: ChildProcess | undefined;
  t.after(async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill();
      await new Promise((resolve) => child!.once('exit', resolve));
    }
    // The instance's own watch process is not this client's to end and may still be leaving:
    // a directory it holds a handle on is not what this case may fail for (removeTree).
    await removeTree(scratch);
  });

  // This case plays the Router itself; the bench's unsigned-in fake keeps it stopped.
  const b = await bench(t, { envFile, waitFile: gate }, {}, { anyMachine: true, spawn: true, hold: true });
  b.host.settings.set('node.pollHoldMs', 5000, USER);

  // 1. The Router asks; the creator's round is handed the material and the address.
  const invited = await b.host.tools.call('invite_machine', { task_id: b.taskId, executors: [b.account.executor] }, USER, { projectId: b.host.ledger.getTask(b.taskId).project_id! });
  assert.equal(invited.isError, undefined, invited.content[0]!.text);
  b.host.ledger.queueTask(b.taskId, USER);
  const handed = await until(() => (existsSync(envFile) ? (JSON.parse(readFileSync(envFile, 'utf8')) as Record<string, string>) : undefined), '创建者那一轮的 Worker 起来');
  const [material, ...more] = (handed[JOIN_MATERIALS_ENV] ?? '').split(' ');
  assert.equal(more.length, 0);
  assert.match(material!, /^[0-9a-f]{64}$/);
  const creatorRun = b.host.ledger.listRuns(b.taskId).at(-1)!;

  // 2. The instance boots and joins. What the skill injects stands in as a file opened as
  // the join's standard input: the material is on no command line.
  const injected = join(scratch, 'material');
  writeFileSync(injected, `${material}\n`);
  const env: NodeJS.ProcessEnv = { ...process.env, TYCHO_DATA: ephDir, TYCHO_NODE_SUPERVISED: '1' };
  // A proxy in the environment would have the client start itself again (cli/main.ts):
  // this machine only reaches 127.0.0.1.
  for (const name of ['HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'https_proxy', 'http_proxy', 'all_proxy']) env[name] = '';
  const stdin = openSync(injected, 'r');
  try {
    child = spawn(process.execPath, [CLI, 'node', 'join', '--to', handed[HOST_URL_ENV]!, '--material-fd', '0', '--name', 'eph-1', '--log', log], {
      cwd: REPO, env, stdio: [stdin, 'ignore', 'ignore'], windowsHide: true,
    });
  } finally {
    closeSync(stdin);
  }
  rmSync(injected);
  const exited = new Promise<number | null>((resolve) => child!.once('exit', (code) => resolve(code)));
  const said = (): string => (existsSync(log) ? readFileSync(log, 'utf8') : '');
  await until(() => b.host.nodes.connected('eph-1'), `临时机器连回来\n${said()}`);
  const machine = b.host.ledger.getMachine('eph-1')!;
  assert.equal(machine.ephemeral, true);
  assert.deepEqual(machine.source, { task_id: b.taskId, run_id: creatorRun.id, round: 1 }, '来源：这个任务的第 1 轮');

  // 3. The creator's round ends; the project's next piece of work goes to the new machine,
  // which is now the only one.
  writeFileSync(gate, '');
  await until(() => b.host.ledger.getTask(b.taskId).state === 'ready', '创建者的任务等验收');
  // The settlement hands this round's work to the Router. The Router is stopped instead (the
  // CLI above, answered at the service's start), so that what becomes of the round is this
  // case's own facts and not a live turn's reading of them.
  const router = b.host.session.status();
  assert.notEqual(router.error, null, `这一场没有负责人：${router.error ?? '负责人在跑'}`);
  assert.equal(router.alive, false, '没有真的负责人进程');
  b.host.ledger.deleteMachine(b.machine.id, USER);
  const next = b.host.ledger.createTask({ projectId: b.projectId, title: '在新机器上干', goal: '跑通', acceptance: '回执', loginId: 't1', roleId: 'implement' }, USER);
  b.host.ledger.queueTask(next.id, USER);
  const run = await until(() => b.host.ledger.listRuns(next.id).find((each) => each.state === 'ended'), `新机器上的一轮跑完\n${said()}`, 90_000);
  assert.equal(run.machine_id, 'eph-1', '这一轮跑在派生的机器上');
  assert.equal(run.exit_kind, 'completed');
  const second = JSON.parse(readFileSync(envFile, 'utf8')) as Record<string, string>;
  assert.equal(second[JOIN_MATERIALS_ENV], undefined, '没有名额的任务，它的轮次拿不到材料');

  // 4. The task it was spawned for is over and it is idle: it is told to go, leaves, and
  // the process ends by itself.
  b.host.ledger.acceptTask(b.taskId, '看过了', USER, { withoutReview: true });
  const code = await Promise.race([exited, sleep(60_000).then(() => 'timeout' as const)]);
  assert.equal(code, 0, `客户端自己退出\n${said()}`);
  const ended = b.host.ledger.getMachine('eph-1')!;
  assert.ok(ended.drainAt && ended.evidenceAt && ended.leftAt, '排空、证据、注销都记下了');
  assert.equal(ended.leftReason, 'leave');
  assert.equal(ended.destroyedAt, undefined, '实例有没有销毁，只有创建它的技能能说');
  assert.match(said(), /已经自己注销/);

  // The material reached the instance on its standard input and nowhere else.
  for (const file of [...filesUnder(ephDir), log]) {
    assert.equal(readFileSync(file).includes(material!), false, `材料出现在新机器的 ${file}`);
  }
});
