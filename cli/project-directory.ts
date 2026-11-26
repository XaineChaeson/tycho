import { existsSync, readFileSync, statSync } from 'node:fs';
import { dataDirOf } from '../service/config.ts';
import { InputError } from '../service/errors.ts';
import {
  issueProjectDirectoryToken, listProjectDirectoryPeers, registerProjectDirectoryPeer,
  removeProjectDirectoryPeer, revokeProjectDirectoryToken,
} from '../service/project-directory.ts';
import { writeOwnerOnly } from '../service/secrets.ts';
import type { Cli } from './system.ts';

const HELP = 'tycho project-directory\n'
  + '  issue <令牌文件>                                签发此环境的只读目录令牌，替换旧令牌\n'
  + '  revoke                                          撤销此环境目录的旧令牌\n'
  + '  add <服务 ID> <环境名称> <HTTPS 地址> <令牌文件>  登记远程服务\n'
  + '  remove <服务 ID>                                移除远程服务和本地缓存\n'
  + '  list                                            查看已登记的远程服务';

export function projectDirectoryCommand(cli: Cli, args: string[]): number {
  const [action = 'help', ...values] = args;
  const dataDir = dataDirOf(cli.system.env, cli.system.home);
  if (action === 'help' && values.length === 0) {
    cli.out(HELP);
  } else if (action === 'issue' && values.length === 1) {
    const file = values[0]!;
    if (existsSync(file)) throw new InputError('输出文件已存在，请另选一个路径');
    writeOwnerOnly(file, issueProjectDirectoryToken(dataDir) + '\n');
    cli.out('目录令牌已写入 ' + file);
  } else if (action === 'revoke' && values.length === 0) {
    revokeProjectDirectoryToken(dataDir);
    cli.out('已撤销目录令牌');
  } else if (action === 'add' && values.length === 4) {
    const [service_id, environment, origin, file] = values as [string, string, string, string];
    const size = statSync(file);
    if (!size.isFile() || size.size > 128) throw new InputError('目录令牌文件无效');
    registerProjectDirectoryPeer(dataDir, { service_id, environment, origin, token: readFileSync(file, 'utf8').trim() });
    cli.out('已登记远程服务 ' + environment);
  } else if (action === 'remove' && values.length === 1) {
    removeProjectDirectoryPeer(dataDir, values[0]!);
    cli.out('已移除远程服务');
  } else if (action === 'list' && values.length === 0) {
    cli.out(JSON.stringify(listProjectDirectoryPeers(dataDir), null, 2));
  } else {
    cli.err(HELP);
    return 2;
  }
  return 0;
}
