// The owner's global resident knowledge, written where each executor on this machine reads
// instructions for every session it starts (docs/design/knowledge-and-skills.md §4.3). Where
// that is, and what keeps the executor from reading it, is each adapter's declaration
// (`globalEntry`); this file only writes and reports.
//
// What it is careful about:
//   - Only a v2 file with this publication's ID is managed. Other publishers, legacy
//     projections and the owner's files are preserved; the guard still recognizes Tycho
//     projections independently of their publisher.
//   - This publication's file is taken down when it no longer holds what is in force: an old rule left
//     in an entry the executor loads would go on applying.
//   - Written is not the same as read: a file the executor's own rules put aside (a file of
//     higher priority beside it) is reported as such, and one whose loading turns on what cannot
//     be seen from here (a profile) is reported written with its loading unconfirmed.
//   - Each executor is answered on its own: what goes wrong with one is that one's line, and a
//     condition that cannot be checked is said as such, never taken for absent.
//   - The executor's directory comes through the one guarded exit (service/home-paths.ts), so a
//     test that names none never writes where the owner's own sessions read.
import { randomBytes } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, readlinkSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { ADAPTERS } from '../adapters/all.ts';
import type { GlobalEntry } from '../adapters/types.ts';
import { executorDirOf } from '../service/home-paths.ts';
import { isEntryPublisherId, isEntryPublisherSource, type EntryProjection, type EntryPublisherSource, type EntryRepairAction, type NodeEntryContent, type NodeEntryStatus } from '../shared/node-protocol.ts';
import { withEntryMutex } from './global-entry-mutex.ts';

// Legacy marker: recognized for guarding, never enough to claim ownership.
export const ENTRY_MARK = '<!-- tycho:generated -->';

export interface EntryTarget {
  executor: string;
  entry: GlobalEntry;
}

// The executors this program declares an entry for, or those of them named.
export function entryTargets(executors?: readonly string[]): EntryTarget[] {
  return Object.entries(ADAPTERS).flatMap(([executor, adapter]) =>
    adapter.globalEntry === undefined || (executors !== undefined && !executors.includes(executor)) ? [] : [{ executor, entry: adapter.globalEntry }]);
}

// The file as written: the mark, then a header for whoever opens it, then the content.
export function renderEntryFile(content: Pick<NodeEntryContent, 'publisher' | 'digest' | 'revisions' | 'text'>, now: string): string {
  if (!('id' in content.publisher) || !isEntryPublisherId(content.publisher.id)) throw new Error('没有可核实的发布方');
  return `<!-- tycho:generated:v2 publisher:${content.publisher.id} -->\n<!-- 由 tycho 生成，勿改；正本在 tycho。修订：${content.revisions.join('、') || '无'}；摘要 ${content.digest}；生成时间 ${now}；来源 ${JSON.stringify(isEntryPublisherSource(content.publisher.source) ? content.publisher.source : null)} -->\n\n${content.text ?? ''}`;
}

function renderManagedSection(content: Pick<NodeEntryContent, 'publisher' | 'digest' | 'revisions' | 'text'>, now: string): string {
  if (!('id' in content.publisher) || !isEntryPublisherId(content.publisher.id)) throw new Error('没有可核实的发布方');
  const start = `<!-- tycho:managed:v2:start publisher:${content.publisher.id} -->`;
  const meta = `<!-- 由 tycho 维护的全局知识区块，勿改；正本在 tycho。修订：${content.revisions.join('、') || '无'}；摘要 ${content.digest}；生成时间 ${now}；来源 ${JSON.stringify(isEntryPublisherSource(content.publisher.source) ? content.publisher.source : null)} -->`;
  const end = `<!-- tycho:managed:v2:end publisher:${content.publisher.id} -->`;
  if (content.text === null || content.text === '') return `${start}\n${meta}\n${end}`;
  const body = content.text.replace(/\r?\n$/, '');
  return `${start}\n${meta}\n\n${body}\n${end}`;
}

type ManagedSection =
  | { kind: 'malformed' }
  | {
      kind: 'valid';
      publisher: string;
      source?: EntryPublisherSource;
      startIndex: number;
      endIndex: number;
      digest?: string;
      revisions: string[];
      bodyText: string;
    };

function entryOwner(text: string): { kind: 'other' | 'legacy' | 'unknown' } | { kind: 'owned'; publisher: string } {
  const first = text.replace(/^﻿/, '').split(/\r?\n/, 1)[0]!.trim();
  if (first === ENTRY_MARK) return { kind: 'legacy' };
  const match = /^<!-- tycho:generated:v2 publisher:([^ ]+) -->$/.exec(first);
  if (match && isEntryPublisherId(match[1])) return { kind: 'owned', publisher: match[1] };
  return /^<!--\s*tycho:generated/i.test(first) ? { kind: 'unknown' } : { kind: 'other' };
}
function sourceInLine(line: string): EntryPublisherSource | undefined {
  const encoded = /；来源 (.+) -->$/.exec(line)?.[1];
  try { const source: unknown = JSON.parse(encoded ?? 'null'); return isEntryPublisherSource(source) ? source : undefined; }
  catch { return undefined; }
}
const sourceIn = (text: string): EntryPublisherSource | undefined => sourceInLine(text.split(/\r?\n/, 2)[1] ?? '');
const digestIn = (text: string): string | undefined => /摘要 ([0-9a-f]+)；/.exec(text)?.[1];
const digestInLine = (line: string): string | undefined => /摘要 ([^；\r\n]+)；/.exec(line)?.[1];
const revisionsInLine = (line: string): string[] => (/修订：([^；]+)；摘要 /.exec(line)?.[1] ?? '')
  .split('、').filter((revision) => /^[\w-]+@\d+$/.test(revision));
const revisionsIn = (text: string): string[] => revisionsInLine(text.split(/\r?\n/, 2)[1] ?? '');

function findManagedSection(text: string): ManagedSection | undefined {
  const all = [...text.matchAll(/<!--\s*tycho:managed\b/gi)];
  if (all.length === 0) return undefined;
  const starts = [...text.matchAll(/^(\uFEFF)?<!-- tycho:managed:v2:start publisher:([^\s>]+) -->(?=\r?$)/gm)];
  const ends = [...text.matchAll(/^<!-- tycho:managed:v2:end publisher:([^\s>]+) -->(?=\r?$)/gm)];
  if (all.length !== 2 || starts.length !== 1 || ends.length !== 1) return { kind: 'malformed' };
  const startMatch = starts[0]!;
  const endMatch = ends[0]!;
  const startPublisher = startMatch[2]!;
  const endPublisher = endMatch[1]!;
  if (!isEntryPublisherId(startPublisher) || startPublisher !== endPublisher) return { kind: 'malformed' };
  const startLineEnd = startMatch.index + startMatch[0].length;
  if (startLineEnd > endMatch.index) return { kind: 'malformed' };
  const startIndex = startMatch.index + (startMatch[1]?.length ?? 0);
  const endIndex = endMatch.index + endMatch[0].length;
  const inner = text.slice(startLineEnd, endMatch.index).replace(/^\r?\n/, '');
  const eol = inner.search(/\r?\n/);
  const firstLine = eol === -1 ? inner : inner.slice(0, eol);
  const hasMeta = /^<!-- 由 tycho 维护的全局知识区块，勿改；正本在 tycho。.* -->$/.test(firstLine);
  const digest = hasMeta ? digestInLine(firstLine) : undefined;
  const revisions = hasMeta ? revisionsInLine(firstLine) : [];
  const source = hasMeta ? sourceInLine(firstLine) : undefined;
  const bodyRaw = hasMeta ? (eol === -1 ? '' : inner.slice(eol).replace(/^\r?\n/, '')) : inner;
  return {
    kind: 'valid',
    publisher: startPublisher,
    ...(source === undefined ? {} : { source }),
    startIndex,
    endIndex,
    ...(digest === undefined ? {} : { digest }),
    revisions,
    bodyText: bodyRaw.trim(),
  };
}

function writeAtomic(path: string, text: string): void {
  const temporary = `${path}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(temporary, text);
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

export interface EntryOptions {
  // Where the executors' variables are read from, and the home their default places are under.
  env?: NodeJS.ProcessEnv;
  home?: string;
  now?: string;
}

function inspectEntry(entry: GlobalEntry, env: NodeJS.ProcessEnv, home: string): EntryProjection {
  try {
    const dir = executorDirOf(env, home, entry.home.env, entry.home.dir);
    const files = [...(entry.coveredBy ?? []).map(({ file }) => file), entry.file];
    for (const file of files) {
      const path = join(dir, ...file.split('/'));
      const stat = statSync(path, { throwIfNoEntry: false });
      if (stat === undefined || stat.isDirectory()) continue;
      if (!stat.isFile()) return { state: 'unknown', why: '指令入口不是可检查的普通文件' };
      const text = readFileSync(path, 'utf8');
      if (text.trim() === '') continue;
      const owner = entryOwner(text);
      if (owner.kind === 'unknown') return { state: 'unknown', why: 'Tycho 投影格式或发布方无法核实' };
      if (owner.kind !== 'other') return { state: 'present', revisions: revisionsIn(text) };
      const managed = findManagedSection(text);
      if (managed === undefined) return { state: 'absent' };
      if (managed.kind === 'malformed') return { state: 'unknown', why: 'Tycho 托管区块格式无法核实' };
      return managed.bodyText === '' ? { state: 'absent' } : { state: 'present', revisions: managed.revisions };
    }
    return { state: 'absent' };
  } catch {
    return { state: 'unknown', why: '机器无法核实全局指令入口是否带有 Tycho 知识' };
  }
}

export const envHome = (env?: NodeJS.ProcessEnv): string =>
  (process.platform === 'win32' ? env?.USERPROFILE : env?.HOME) || homedir();

export function checkExternalEntry(executor: string, options: EntryOptions = {}): EntryProjection {
  const entry = entryTargets([executor])[0]?.entry;
  const env = options.env ?? process.env;
  return entry === undefined ? { state: 'unknown', why: '执行器没有声明可核实的全局指令入口' }
    : inspectEntry(entry, env, options.home ?? envHome(options.env));
}

// Apply one content to each target. Every target is answered, whatever became of the others.
export function applyEntry(content: NodeEntryContent, targets: readonly EntryTarget[], options: EntryOptions = {}): NodeEntryStatus[] {
  const env = options.env ?? process.env;
  const home = options.home ?? envHome(options.env);
  const now = options.now ?? new Date().toISOString();
  return targets.map((target) => {
    try {
      return { ...applyOne(content, target, env, home, now), projection: inspectEntry(target.entry, env, home) };
    } catch (error) {
      return { executor: target.executor, path: join(home, target.entry.home.dir, ...target.entry.file.split('/')), state: 'failed', note: (error as Error).message };
    }
  });
}

function applyOne(content: NodeEntryContent, { executor, entry }: EntryTarget, env: NodeJS.ProcessEnv, home: string, now: string): NodeEntryStatus {
  const dir = executorDirOf(env, home, entry.home.env, entry.home.dir);
  const path = join(dir, ...entry.file.split('/'));
  const status = (state: NodeEntryStatus['state'], note?: string): NodeEntryStatus => ({ executor, path, state, ...(note === undefined ? {} : { note }) });
  if (!('id' in content.publisher) || !isEntryPublisherId(content.publisher.id)) return status('failed', 'problem' in content.publisher ? content.publisher.problem : '全局知识发布方无法核实');
  if (content.text === null && lstatSync(path, { throwIfNoEntry: false }) === undefined) return status('cleared', content.problem ?? '没有要写的全局常驻知识');
  const result = withEntryMutex(dir, () => applyLocked(content, executor, entry, dir, path, now));
  return result.state === 'done' ? result.value : status('failed', result.problem);
}

function writtenStatus(entry: GlobalEntry, dir: string, executor: string, status: (state: NodeEntryStatus['state'], note?: string) => NodeEntryStatus): NodeEntryStatus {
  for (const { file, when } of entry.coveredBy ?? []) {
    let text: string | undefined;
    try {
      text = readFileSync(join(dir, file), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      return status('unconfirmed', `已写入，但查不了 ${file}（${(error as Error).message}），${executor} 读不读这份确认不了`);
    }
    if (when === 'not-blank' && text.trim() !== '') return status('covered', `旁边有 ${file}，${executor} 读那一份、不读这份`);
  }
  if (entry.unconfirmed !== undefined) return status('unconfirmed', entry.unconfirmed);
  return status('written');
}

function applyLocked(content: NodeEntryContent, executor: string, entry: GlobalEntry, dir: string, path: string, now: string): NodeEntryStatus {
  const status = (state: NodeEntryStatus['state'], note?: string): NodeEntryStatus => ({ executor, path, state, ...(note === undefined ? {} : { note }) });
  let existing: string | undefined;
  try {
    const held = lstatSync(path, { throwIfNoEntry: false });
    if (held !== undefined && !held.isFile()) return status('occupied', '那里不是一个普通文件（目录或链接），不归 tycho，没动它');
    if (held !== undefined) existing = readFileSync(path, 'utf8');
  } catch (error) {
    return status('failed', `读不了这个文件：${(error as Error).message}`);
  }
  const owner = existing === undefined ? undefined : entryOwner(existing);
  const ours = owner?.kind === 'owned' && 'id' in content.publisher && owner.publisher === content.publisher.id;
  const source = existing === undefined ? undefined : sourceIn(existing);
  if (existing !== undefined && !ours) {
    if (owner?.kind === 'other') {
      const managed = findManagedSection(existing);
      if (managed?.kind === 'malformed') return status('occupied', '全局入口内的 Tycho 托管区块格式无法核实，未改动');
      if (managed?.kind === 'valid') {
        if ('id' in content.publisher && managed.publisher === content.publisher.id) {
          if (content.text === null) {
            const why = content.problem ?? '没有要写的全局常驻知识';
            if (managed.bodyText !== '' || managed.digest !== content.digest) {
              try {
                writeAtomic(path, `${existing.slice(0, managed.startIndex)}${renderManagedSection(content, now)}${existing.slice(managed.endIndex)}`);
              } catch (error) {
                return status('failed', `撤不下 tycho 托管区块里的内容：${(error as Error).message}`);
              }
            }
            return status('cleared', `${why}（已保留本机原有内容）`);
          }
          if (managed.digest !== content.digest || (content.text.trim() !== '' && managed.bodyText === '')) {
            try {
              writeAtomic(path, `${existing.slice(0, managed.startIndex)}${renderManagedSection(content, now)}${existing.slice(managed.endIndex)}`);
            } catch (error) {
              return status('failed', `写不进去：${(error as Error).message}`);
            }
          }
          return writtenStatus(entry, dir, executor, status);
        }
        return status('occupied', '全局入口内的 Tycho 托管区块由其他服务占用，未改动');
      }
    }
    return status('occupied', owner?.kind === 'legacy' ? '旧版 Tycho 投影的发布方未知，未改动；请由原发布方撤下或经主人明确迁移'
      : owner?.kind === 'owned' ? `全局入口由${source ? `${source.hostname}:${source.port}` : "来源未知的服务"}的知识发布集合（${owner.publisher}）占用，未改动。请在该服务关闭外部知识投影，等其撤下后重试`
      : owner?.kind === 'unknown' ? 'Tycho 投影格式或发布方未知，未改动'
      : '这里已有不是 tycho 生成的内容，没动它；要用 tycho 的全局知识，先把它挪走或并进 tycho');
  }
  if (content.text === null) {
    const why = content.problem ?? '没有要写的全局常驻知识';
    if (!ours) return status('cleared', why);
    try {
      unlinkSync(path);
    } catch (error) {
      return status('failed', `撤不下 tycho 之前写的那份：${(error as Error).message}`);
    }
    return status('cleared', `${why}；撤下了 tycho 之前写的那份`);
  }
  // The same content is not written again: the file is checked every time, written only when
  // it is not already this content. A write replaces the file (a new one renamed over it), so a
  // file linked elsewhere is never rewritten in place.
  if (!ours || digestIn(existing!) !== content.digest) {
    try {
      writeAtomic(path, renderEntryFile(content, now));
    } catch (error) {
      return status('failed', `写不进去：${(error as Error).message}`);
    }
  }
  return writtenStatus(entry, dir, executor, status);
}

export function repairEntry(
  action: EntryRepairAction,
  content: NodeEntryContent,
  target: EntryTarget,
  options: EntryOptions = {},
): { status: NodeEntryStatus; backup_path?: string } {
  if (!('id' in content.publisher) || !isEntryPublisherId(content.publisher.id)) {
    throw new Error('problem' in content.publisher ? content.publisher.problem : '全局知识发布方无法核实');
  }
  const publisherId = content.publisher.id;
  const env = options.env ?? process.env;
  const home = options.home ?? envHome(options.env);
  const now = options.now ?? new Date().toISOString();
  const dir = executorDirOf(env, home, target.entry.home.env, target.entry.home.dir);
  const path = join(dir, ...target.entry.file.split('/'));

  const result = withEntryMutex(dir, (): { status: NodeEntryStatus; backup_path?: string } => {
    const finish = (backupPath?: string): { status: NodeEntryStatus; backup_path?: string } => {
      const applied = applyLocked(content, target.executor, target.entry, dir, path, now);
      return {
        status: { ...applied, projection: inspectEntry(target.entry, env, home) },
        ...(backupPath === undefined ? {} : { backup_path: backupPath }),
      };
    };

    if (action === 'resync') return finish();

    if (action === 'coexist') {
      const held = lstatSync(path, { throwIfNoEntry: false });
      if (held === undefined) return finish();
      if (held.isDirectory()) throw new Error('目标位置是一个目录，不能启用区块共存');
      if (held.isSymbolicLink()) {
        const targetLink = readlinkSync(path);
        throw new Error(`目标是指向 ${targetLink} 的符号链接，为防止误改外部仓库，请改用“备份并接管”或手动编辑目标文件`);
      }
      if (!held.isFile()) throw new Error('目标位置不是普通文件，不能启用区块共存');
      const existing = readFileSync(path, 'utf8');
      const owner = entryOwner(existing);
      if (owner.kind === 'owned' && owner.publisher === publisherId) return finish();
      if (owner.kind === 'owned') {
        const source = sourceIn(existing);
        throw new Error(`当前入口由其他 Tycho 服务占用（${source ? `${source.hostname}:${source.port}` : owner.publisher}），请先在对应服务关闭外部投影或改用“备份并接管”`);
      }
      if (owner.kind === 'legacy' || owner.kind === 'unknown') {
        throw new Error('当前入口由其他或旧版 Tycho 服务占用，请先撤下或改用“备份并接管”');
      }
      const managed = findManagedSection(existing);
      if (managed?.kind === 'valid' && managed.publisher === publisherId) return finish();
      if (managed?.kind === 'valid') throw new Error('当前入口由其他 Tycho 服务占用');
      if (managed?.kind === 'malformed') throw new Error('当前入口内的 Tycho 托管区块格式已损坏，请先手动清理或改用“备份并接管”');

      const separator = existing === '' ? '' : existing.endsWith('\n\n') || existing.endsWith('\r\n\r\n') ? '' : existing.endsWith('\n') ? '\n' : '\n\n';
      writeAtomic(path, `${existing}${separator}${renderManagedSection(content, now)}\n`);
      return finish();
    }

    if (action === 'backup_takeover') {
      const held = lstatSync(path, { throwIfNoEntry: false });
      if (held === undefined) return finish();
      if (held.isDirectory()) throw new Error('目标位置是一个目录，无法备份接管');
      const stamp = now.replace(/[-:]/g, '').replace(/\.\d+(?=[Zz]|[+-])/, '').replace(/[^0-9A-Za-z_-]/g, '');
      let backupPath = `${path}.pre-tycho-${stamp}.bak`;
      while (lstatSync(backupPath, { throwIfNoEntry: false }) !== undefined) {
        backupPath = `${path}.pre-tycho-${stamp}-${randomBytes(2).toString('hex')}.bak`;
      }
      renameSync(path, backupPath);
      return finish(backupPath);
    }

    const never: never = action;
    throw new Error(`不支持的入口修复方式：${String(never)}`);
  });

  if (result.state !== 'done') throw new Error(result.problem);
  return result.value;
}
