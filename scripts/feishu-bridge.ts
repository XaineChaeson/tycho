import { readFileSync, rmSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { acquireLock } from '../service/lock.ts';
import { prepareOwnerOnlyDirectory } from '../service/secrets.ts';
import { type CallbackPolicy } from '../integrations/feishu/callback.ts';
import { createClients } from '../integrations/feishu/clients.ts';
import { openFeishuQueue } from '../integrations/feishu/queue.ts';
import { createFeishuServer } from '../integrations/feishu/server.ts';

const USAGE = 'node scripts/feishu-bridge.ts serve <私有配置 JSON> <数据目录>\n'
  + 'node scripts/feishu-bridge.ts status <数据目录>';
const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

function configOf(path: string) {
  if (!statSync(path).isFile() || statSync(path).size > 128 * 1024) throw new Error('配置文件无效');
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(path, 'utf8')); } catch { throw new Error('配置文件不是有效 JSON'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('配置文件需要 JSON 对象');
  const config = parsed as Record<string, unknown>;
  const string = (key: string, pattern?: RegExp): string => {
    const value = config[key];
    if (typeof value !== 'string' || value.length === 0 || value.length > 4096 || value !== value.trim() || (pattern && !pattern.test(value))) {
      throw new Error('配置字段无效：' + key);
    }
    return value;
  };
  function entries(key: string): [string, unknown][] {
    const value = config[key];
    if (value === undefined && key === 'quickAnswers') return [];
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('配置字段无效：' + key);
    return Object.entries(value);
  }
  const groups = entries('projectsByChat');
  const answers = entries('quickAnswers');
  if (groups.length === 0 || groups.some(([chat, project]) => !/^oc_[a-zA-Z0-9_-]+$/.test(chat) || typeof project !== 'string' || !ULID.test(project))) {
    throw new Error('使用飞书群 ID 映射到获准的 Tycho 项目 ID');
  }
  if (answers.some(([prompt, reply]) => !prompt.trim() || prompt !== prompt.trim() || prompt.length > 4000 || typeof reply !== 'string' || !reply.trim() || reply.length > 12000)) {
    throw new Error('快答使用完整问题和公开答案');
  }
  let tycho: URL;
  try { tycho = new URL(string('tychoOrigin')); } catch { throw new Error('Tycho 地址无效'); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(tycho.hostname);
  if ((tycho.protocol !== 'https:' && !(loopback && tycho.protocol === 'http:')) || tycho.username || tycho.password || tycho.pathname !== '/' || tycho.search || tycho.hash) {
    throw new Error('Tycho 地址用 HTTPS origin，本机可用环回 HTTP');
  }
  const port = config.port ?? 8791;
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('端口无效');
  const policy: CallbackPolicy = {
    appId: string('appId', /^cli_[a-zA-Z0-9_-]+$/), tenantKey: string('tenantKey'),
    encryptKey: string('encryptKey'), verificationToken: string('verificationToken'), botOpenId: string('botOpenId', /^ou_[a-zA-Z0-9_-]+$/),
    projectsByChat: new Map(groups as [string, string][]), quickAnswers: new Map(answers as [string, string][]),
  };
  return {
    port, policy, accounts: {
      appId: policy.appId, appSecret: string('appSecret'), tychoOrigin: tycho.origin,
      tychoSource: string('tychoSource', ULID), tychoSecret: string('tychoSecret'),
    },
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 0 || (args.length === 1 && args[0] === '--help')) {
    console.log(USAGE);
    return;
  }
  if (args[0] === 'status' && args.length === 2) {
    using db = new DatabaseSync(join(resolve(args[1]!), 'feishu.db'), { readOnly: true });
    console.log(JSON.stringify(db.prepare(
      'SELECT event_id, project_id, state, receipt, return_message, detail, attempts FROM delivery ORDER BY accepted_at DESC, rowid DESC LIMIT 100',
    ).all(), null, 2));
    return;
  }
  if (args[0] !== 'serve' || args.length !== 3) throw new Error(USAGE);
  const config = configOf(args[1]!);
  const dir = resolve(args[2]!);
  prepareOwnerOnlyDirectory(dir);
  const lock = join(dir, 'bridge.lock');
  acquireLock(lock, () => {});
  const closed: (() => Promise<void>)[] = [];
  try {
    const { policy, accounts } = config;
    const queue = openFeishuQueue(join(dir, 'feishu.db'), {
      clients: createClients(accounts),
      binding: JSON.stringify([policy.appId, policy.tenantKey, policy.botOpenId, accounts.tychoOrigin, accounts.tychoSource]),
    });
    closed.push(() => queue.stop());
    const server = createFeishuServer(policy, queue);
    closed.push(() => new Promise((done) => server.close(() => done())));
    await new Promise<void>((done, failed) => server.once('error', failed).listen(config.port, '127.0.0.1', done));
    console.log('飞书桥接监听 http://127.0.0.1:' + config.port + '/feishu/events');
    await new Promise<void>((done) => {
      process.once('SIGINT', done);
      process.once('SIGTERM', done);
    });
  } finally {
    try {
      for (const close of closed.reverse()) await close();
    } finally {
      rmSync(lock, { force: true });
    }
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : '飞书桥接启动失败');
  process.exitCode = 1;
});
