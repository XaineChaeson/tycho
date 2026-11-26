// The global publication set has its own durable identity; it does not enable project ownership.
import { randomBytes } from 'node:crypto';
import { linkSync, lstatSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isEntryPublisherId, type EntryPublisher } from '../shared/node-protocol.ts';

export function globalEntryPublisher(dataDir: string): EntryPublisher {
  const file = join(dataDir, 'global-entry-publisher');
  try {
    if (lstatSync(file, { throwIfNoEntry: false }) === undefined) {
      mkdirSync(dataDir, { recursive: true });
      const temporary = `${file}.${randomBytes(8).toString('hex')}.tmp`;
      let created = false;
      try {
        writeFileSync(temporary, randomBytes(16).toString('hex') + '\n', { flag: 'wx', mode: 0o600 }); created = true;
        try { linkSync(temporary, file); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      } finally { if (created) unlinkSync(temporary); }
    }
    const held = lstatSync(file);
    if (!held.isFile() || held.size > 64) throw new Error('发布身份文件不是可核实的普通文件');
    const id = readFileSync(file, 'utf8').trim();
    if (!isEntryPublisherId(id)) throw new Error('发布身份文件损坏');
    return { id };
  } catch (error) {
    return { problem: `无法核实全局知识发布方，未改动原生投影。请在服务主机核对发布身份文件 ${file} 的权限；若损坏，从原发布身份的备份恢复该文件后重试，勿生成新 ID。原因：${(error as Error).message}` };
  }
}
