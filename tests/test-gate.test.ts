// 防止全量测试并发、持有者结束后阻塞，以及其他程序占端口时卡住。
import './guard.ts';
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';

const gate = resolve('scripts/test.ts');
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean) {
  const end = Date.now() + 30000;
  while (!check()) { if (Date.now() > end) throw new Error('等待状态超时'); await pause(50); }
}
async function listen(server: Server): Promise<number> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return (server.address() as { port: number }).port;
}

async function exited(child: ReturnType<typeof spawn>): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null) return child.exitCode;
  const [code] = await once(child, 'exit');
  return code as number | null;
}

test('排队、结束或强杀后接手，指定文件不排队', { timeout: 60000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tycho-gate-'));
  const marker = join(dir, 'started');
  const fake = join(dir, 'fake.cjs');
  writeFileSync(fake, `const fs = require('fs'); fs.appendFileSync(process.env.MARKER + '.args', JSON.stringify(process.argv.slice(2)) + '\\n'); fs.appendFileSync(process.env.MARKER, process.pid + '\\n'); if (!process.argv.includes('short')) { const parent = process.ppid; setInterval(() => { try { process.kill(parent, 0); } catch { process.exit(); } if (fs.existsSync(process.env.MARKER + '.stop.' + process.pid)) process.exit(); }, 100); }`);
  const reservation = createServer();
  const port = await listen(reservation);
  await new Promise<void>(resolve => reservation.close(() => resolve()));
  const children: ReturnType<typeof spawn>[] = [];
  const run = (...args: string[]) => {
    const p = spawn(process.execPath, [gate, ...args], { env: { ...process.env, TYCHO_TEST_LOCK: String(port), TYCHO_TEST_COMMAND: fake, MARKER: marker }, stdio: 'pipe' });
    children.push(p); return p;
  };
  const lines = () => existsSync(marker) ? readFileSync(marker, 'utf8').trim().split('\n').length : 0;
  try {
    const first = run(); await until(() => lines() === 1);
    const second = run('--test-reporter=tap', '--test-reporter-destination=x.tap'); let output = ''; second.stdout!.on('data', d => { output += d; });
    await until(() => output.includes('排队')); assert.equal(lines(), 1);
    const targeted = run('--test-only', 'short'); assert.equal(await exited(targeted), 0); assert.equal(lines(), 2);
    const pids = () => readFileSync(marker, 'utf8').trim().split('\n');
    writeFileSync(marker + '.stop.' + pids()[0], ''); assert.equal(await exited(first), 0);
    await until(() => lines() === 3);
    const argumentsSeen = readFileSync(marker + '.args', 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(argumentsSeen, [['tests/*.test.ts'], ['--test-only', 'short'], ['--test-reporter=tap', '--test-reporter-destination=x.tap', 'tests/*.test.ts']]);
    const third = run(); let thirdOutput = ''; third.stdout!.on('data', d => { thirdOutput += d; });
    await until(() => thirdOutput.includes('排队')); assert.equal(lines(), 3);
    if (second.exitCode === null && second.signalCode === null) second.kill('SIGKILL');
    await exited(second); await until(() => lines() === 4);
    writeFileSync(marker + '.stop.' + pids()[3], ''); assert.equal(await exited(third), 0);
  } finally {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) { child.kill(); await exited(child); }
    rmSync(dir, { recursive: true, force: true });
  }
});

test('带值选项与文件不明确时提示用等号', async () => {
  const child = spawn(process.execPath, [gate, '--test-reporter', 'tap'], { stdio: 'pipe' });
  let error = ''; child.stderr!.on('data', d => { error += d; });
  const [code] = await once(child, 'close');
  assert.equal(code, 1);
  assert.match(error, /--test-reporter=值/);
});

test('端口被其他程序占用时报告并继续', async () => {
  const server = createServer(socket => socket.end('not tycho\n'));
  const port = await listen(server);
  const dir = mkdtempSync(join(tmpdir(), 'tycho-gate-'));
  const fake = join(dir, 'fake.cjs');
  writeFileSync(fake, "console.log('fake started')");
  try {
    const child = spawn(process.execPath, [gate], { env: { ...process.env, TYCHO_TEST_LOCK: String(port), TYCHO_TEST_COMMAND: fake }, stdio: 'pipe' });
    let output = ''; child.stdout!.on('data', d => { output += d; });
    const [code] = await once(child, 'close');
    assert.equal(code, 0);
    assert.match(output, /被别的程序占用，不排队直接跑/);
    assert.match(output, /fake started/);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('端口接受连接却不回答时报告并继续', { timeout: 15000 }, async () => {
  const server = createServer(() => {});
  const port = await listen(server);
  const dir = mkdtempSync(join(tmpdir(), 'tycho-gate-'));
  const fake = join(dir, 'fake.cjs');
  writeFileSync(fake, "console.log('fake started')");
  const child = spawn(process.execPath, [gate], { env: { ...process.env, TYCHO_TEST_LOCK: String(port), TYCHO_TEST_COMMAND: fake }, stdio: 'pipe' });
  let output = ''; child.stdout!.on('data', d => { output += d; });
  try {
    const [code] = await once(child, 'close');
    assert.equal(code, 0);
    assert.match(output, /被别的程序占用，不排队直接跑/);
    assert.match(output, /fake started/);
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill(); await exited(child); }
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('持有者交接时空关闭连接，等待者重新取得端口', { timeout: 15000 }, async () => {
  const server = createServer(socket => { server.close(); socket.end(); });
  const port = await listen(server);
  const dir = mkdtempSync(join(tmpdir(), 'tycho-gate-'));
  const fake = join(dir, 'fake.cjs');
  writeFileSync(fake, `const net = require('net'); const s = net.connect(+process.env.TYCHO_TEST_LOCK, '127.0.0.1'); s.on('data', data => { if (JSON.parse(data).tycho_full_test === 1) console.log('lock held'); else process.exitCode = 1; }); s.on('error', () => { process.exitCode = 1; });`);
  try {
    const child = spawn(process.execPath, [gate], { env: { ...process.env, TYCHO_TEST_LOCK: String(port), TYCHO_TEST_COMMAND: fake }, stdio: 'pipe' });
    let output = ''; child.stdout!.on('data', d => { output += d; });
    const [code] = await once(child, 'close');
    assert.equal(code, 0);
    assert.match(output, /lock held/);
    assert.doesNotMatch(output, /被别的程序占用/);
  } finally {
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('查询持有者时持续连接被拒，到上限后报告并继续', { timeout: 20000 }, async () => {
  const server = createServer(socket => socket.end(JSON.stringify({ tycho_full_test: 1, pid: process.pid, repo: 'test', started_at: new Date().toISOString() }) + '\n'));
  const port = await listen(server);
  const unused = createServer();
  const refusedPort = await listen(unused);
  await new Promise<void>(resolve => unused.close(() => resolve()));
  const dir = mkdtempSync(join(tmpdir(), 'tycho-gate-'));
  const fake = join(dir, 'fake.cjs');
  const preload = join(dir, 'refuse.cjs');
  writeFileSync(fake, "console.log('fake started')");
  writeFileSync(preload, `const net = require('node:net'); const connect = net.createConnection; net.createConnection = (...args) => { args[0] = { ...args[0], port: ${refusedPort} }; return connect(...args); }; require('node:module').syncBuiltinESMExports();`);
  const child = spawn(process.execPath, [gate], { env: { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --import=${pathToFileURL(preload).href}`, TYCHO_TEST_LOCK: String(port), TYCHO_TEST_COMMAND: fake, TYCHO_TEST_RETRY_LIMIT_MS: '100' }, stdio: 'pipe' });
  let output = ''; child.stdout!.on('data', d => { output += d; });
  try {
    const [code] = await once(child, 'close');
    assert.equal(code, 0);
    assert.match(output, /一直连不上，不排队直接跑/);
    assert.match(output, /fake started/);
  } finally {
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    if (child.exitCode === null && child.signalCode === null) { child.kill(); await exited(child); }
    rmSync(dir, { recursive: true, force: true });
  }
});
