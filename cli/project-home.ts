import { existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { dataDirOf, lockFile, prepareDataDir } from '../service/config.ts';
import { InputError } from '../service/errors.ts';
import { acquireLock } from '../service/lock.ts';
import { createProjectHome, openProjectHome, type ProjectHandoff, type ProjectHomeIdentity } from '../service/project-home.ts';
import { exportProjectHandoff, freezeProjectHandoff, importProjectHandoff, stageProjectHandoff } from '../service/project-home-transfer.ts';
import { writeOwnerOnly } from '../service/secrets.ts';
import type { Cli } from './system.ts';

const HELP = 'tycho project-home\n'
  + '  init                            给新的 TYCHO_DATA 创建环境身份\n'
  + '  identity                        读取环境 ID 及公钥\n'
  + '  export <项目 ID> <移交包路径>     导出已暂停的项目\n'
  + '  stage <移交包路径> <源身份文件> [--replace]  在目标服务核对已信任的源公钥并准备接管\n'
  + '  freeze <移交包路径> <目标 ID> <凭证路径>  冻结源服务并签发给指定目标的凭证\n'
  + '  import <移交包路径> <凭证路径>    在目标服务接管\n'
  + '移交命令在服务停止期间使用。源身份文件需经独立渠道核对。';

function readInput(path: string, limit: number): Buffer {
  const size = statSync(path);
  if (!size.isFile() || size.size > limit) throw new InputError('文件无效或超出移交协议限制');
  return readFileSync(path);
}

function readJson<T>(path: string): T {
  const bytes = readInput(path, 64 * 1024);
  try {
    return JSON.parse(bytes.toString('utf8')) as T;
  } catch {
    throw new InputError('文件不是有效 JSON');
  }
}

function separateOutput(path: string): void {
  if (existsSync(path)) throw new InputError('输出文件已存在，请另选一个路径：' + path);
}

export function projectHomeCommand(cli: Cli, args: string[]): number {
  const [action = 'help', ...values] = args;
  if (action === 'help' && values.length === 0) {
    cli.out(HELP);
    return 0;
  }
  const [first, second, third] = values;
  const dir = dataDirOf(cli.system.env, cli.system.home);
  if (action === 'init' && values.length === 0) {
    prepareDataDir(dir);
    const lock = lockFile(dir);
    acquireLock(lock, cli.err);
    try {
      if (existsSync(join(dir, 'ledger.db'))) throw new InputError('请用新的数据目录初始化环境身份');
      const home = createProjectHome(dir);
      try { cli.out(JSON.stringify(home.identity)); } finally { home.close(); }
    } finally {
      rmSync(lock, { force: true });
    }
  } else if (action === 'identity' && values.length === 0) {
    const home = openProjectHome(dir);
    try { cli.out(JSON.stringify(home.identity)); } finally { home.close(); }
  } else if (action === 'export' && first && second && values.length === 2) {
    separateOutput(second);
    writeOwnerOnly(second, exportProjectHandoff(dir, first).toString('utf8'));
    cli.out('项目移交包已写入 ' + second);
  } else if (action === 'stage' && first && second && (values.length === 2 || (values.length === 3 && third === '--replace'))) {
    const target = stageProjectHandoff(dir, readInput(first, 64 * 1024 * 1024), readJson<ProjectHomeIdentity>(second), third === '--replace');
    cli.out(JSON.stringify(target));
  } else if (action === 'freeze' && first && second && third && values.length === 3) {
    separateOutput(third);
    const receipt = freezeProjectHandoff(dir, readInput(first, 64 * 1024 * 1024), second);
    writeOwnerOnly(third, JSON.stringify(receipt));
    cli.out('源项目已冻结，移交凭证已写入 ' + third);
  } else if (action === 'import' && first && second && values.length === 2) {
    const ownership = importProjectHandoff(dir, readInput(first, 64 * 1024 * 1024), readJson<ProjectHandoff>(second));
    cli.out(JSON.stringify(ownership));
  } else {
    cli.err(HELP);
    return 2;
  }
  return 0;
}
