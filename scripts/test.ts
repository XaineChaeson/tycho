import { spawn, spawnSync } from 'node:child_process';
import { createConnection, createServer, type Server } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Stay below Linux and Windows ephemeral port ranges, so outgoing connections cannot take it.
const port = Number(process.env.TYCHO_TEST_LOCK || 27931);
const own = { tycho_full_test: 1, pid: process.pid, repo: root, started_at: new Date().toISOString() };
type Holder = typeof own;
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

function listen(server: Server): Promise<boolean> {
  return new Promise((resolve, reject) => {
    server.once('error', onError);
    function onError(err: NodeJS.ErrnoException) {
      if (err.code === 'EADDRINUSE') resolve(false); else reject(err);
    }
    server.listen(port, '127.0.0.1', () => { server.removeListener('error', onError); resolve(true); });
  });
}

// A different program may own the port, or may never answer. Do not let it block tests.
function identify(): Promise<Holder | 'retry' | 'other'> {
  return new Promise(resolve => {
    const socket = createConnection({ host: '127.0.0.1', port });
    let data = '';
    let done = false;
    let timeout = setTimeout(() => finish('retry'), 1000);
    const finish = (result: Holder | 'retry' | 'other') => { if (!done) { done = true; clearTimeout(timeout); socket.destroy(); resolve(result); } };
    socket.on('connect', () => { clearTimeout(timeout); timeout = setTimeout(() => finish('other'), 1000); });
    socket.on('error', () => finish(data ? 'other' : 'retry'));
    socket.on('end', () => finish(data ? 'other' : 'retry'));
    socket.on('data', chunk => {
      data += chunk.toString();
      if (data.length > 8192) return finish('other');
      const end = data.indexOf('\n');
      if (end < 0) return;
      try {
        const h = JSON.parse(data.slice(0, end)) as Holder;
        if (h.tycho_full_test === 1 && Number.isInteger(h.pid) && h.pid > 0 && typeof h.repo === 'string' && typeof h.started_at === 'string' && Number.isFinite(Date.parse(h.started_at))) return finish(h);
      } catch { /* Not our protocol. */ }
      finish('other');
    });
  });
}

let stopping: NodeJS.Signals | undefined;
let child: ReturnType<typeof spawn> | undefined;
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => {
  stopping = signal;
  if (child) child.kill(signal);
});

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  // A bare option followed by a positional argument can consume that argument.
  // Only Node's own help can establish that the option takes no value.
  const ambiguous = args.filter((arg, i) => !arg.startsWith('-') && i > 0 && args[i - 1].startsWith('-') && !args[i - 1].includes('='));
  if (ambiguous.length) {
    const help = spawnSync(process.execPath, ['--help'], { encoding: 'utf8' });
    const booleanOptions = new Set<string>();
    if (help.status === 0) for (const line of help.stdout.split('\n')) {
      const match = line.match(/^  (-\S+(?:, -\S+)*)(?:\s{2,}|$)/);
      if (match && !/[=\[\]]/.test(match[1])) for (const option of match[1].split(', ')) booleanOptions.add(option);
    }
    for (let i = 1; i < args.length; i++) {
      const previous = args[i - 1];
      if (!args[i].startsWith('-') && previous.startsWith('-') && !previous.includes('=') && !booleanOptions.has(previous)) {
        console.error(`无法确定 ${previous} 后的参数是选项值还是测试文件；带值选项请写成 ${previous}=值。`);
        return 1;
      }
    }
  }
  const full = !args.some(arg => !arg.startsWith('-'));
  const testArgs = full ? [...args, 'tests/*.test.ts'] : args;
  let server: Server | undefined;
  try {
    if (full) {
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('TYCHO_TEST_LOCK 必须是有效的端口号');
      let nextNotice = 0;
      let retrySince: number | undefined;
      const retryLimit = Number(process.env.TYCHO_TEST_RETRY_LIMIT_MS || 30_000);
      while (!stopping) {
        own.started_at = new Date().toISOString();
        const candidate = createServer(socket => socket.end(JSON.stringify(own) + '\n'));
        if (await listen(candidate)) { server = candidate; break; }
        const holder = await identify();
        if (holder === 'retry') {
          retrySince ??= Date.now();
          if (Date.now() - retrySince >= retryLimit) {
            console.log(`端口 ${port} 一直连不上，不排队直接跑。`);
            break;
          }
          if (Date.now() >= nextNotice) {
            console.log('全量测试锁正在交接，正在排队等待。');
            nextNotice = Date.now() + 60_000;
          }
          await delay(2000);
          continue;
        }
        retrySince = undefined;
        if (holder === 'other') {
          console.log(`端口 ${port} 被别的程序占用，不排队直接跑。`);
          break;
        }
        if (Date.now() >= nextNotice) {
          const elapsed = Math.max(0, Math.floor((Date.now() - Date.parse(holder.started_at)) / 1000));
          console.log(`全量测试正在运行：pid ${holder.pid}，仓库 ${holder.repo}，已运行 ${elapsed} 秒；正在排队等待。`);
          nextNotice = Date.now() + 60_000;
        }
        await delay(2000);
      }
      if (stopping) return stopping === 'SIGINT' ? 130 : 143;
    }
    const fake = process.env.TYCHO_TEST_COMMAND;
    const command = fake ? [fake, ...testArgs] : ['--import', './tests/guard.ts', '--test', ...testArgs];
    child = spawn(process.execPath, command, { cwd: root, stdio: 'inherit' });
    return await new Promise<number>((resolve, reject) => {
      child!.once('error', reject);
      child!.once('exit', (code, signal) => resolve(code ?? (signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 1)));
    });
  } finally {
    if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
  }
}
process.exitCode = await main();
