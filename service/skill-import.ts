// Bringing the owner's old skill files into the ledger (docs/design/knowledge-and-skills.md §6):
// before skills were entries, the owner kept them as `<folder>/<project name>/*.md`, and every
// round of that project was handed them. Now nothing reads that folder but this, and only when
// the owner starts it in the console. Each file becomes one proposal of a skill, for its
// project, with the whole file as its evidence, and goes through the gate like any other: the
// owner's file is where it came from, not a stamp of approval. Running it again brings in only
// what is new or changed; a file that cannot be a skill says why and is left where it is.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, type Dirent } from 'node:fs';
import { basename, join } from 'node:path';
import type { Ctx } from './db.ts';
import { InputError } from './errors.ts';
import type { ProposalInput, Proposer } from './knowledge.ts';
import type { Ledger } from './ledger.ts';

// One request per file and content: an unchanged file imported again is the same request.
export const IMPORT_CLIENT = 'import:skills';
const IMPORTER: Proposer = { source: 'import', by: '技能文件迁移', client: IMPORT_CLIENT, writers: [] };
const MAX_TITLE = 200;
const MAX_WHEN = 300;

// What became of one file. `new`: a preview found it not brought in yet. `proposed`: brought
// in now, waiting for its gate. `imported`: brought in before, unchanged since. `refused`: the
// ledger would not take it (a preview says so too), and why. `skipped`: not a skill file of any
// project, and why. `failed`: it, or its project's folder, could not be read, and why.
export type ImportState = 'new' | 'proposed' | 'imported' | 'refused' | 'skipped' | 'failed';

export interface ImportItem {
  // Relative to the folder: `<project name>/<file>.md`, or the file at its top.
  path: string;
  project_id: string | null;
  title: string | null;
  state: ImportState;
  proposal_id?: string;
  reason?: string;
}

type ImportLedger = Pick<Ledger, 'listProjects' | 'propose' | 'checkProposal'>;

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');
const cut = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

// The front matter a skill file may open with (`name:`, `description:`), and what follows it.
function split(text: string): { fields: Record<string, string>; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!match) return { fields: {}, body: text.trim() };
  const fields: Record<string, string> = {};
  for (const line of match[1]!.split(/\r?\n/)) {
    const field = /^([A-Za-z_-]+):\s*(.*)$/.exec(line);
    if (field) fields[field[1]!.toLowerCase()] = field[2]!.trim().replace(/^(['"])(.*)\1$/, '$2');
  }
  return { fields, body: text.slice(match[0].length).trim() };
}

// A skill as the file says it: its title from the front matter or the first heading, when to use
// it from the front matter's description or the first line of prose. The gate may reword both.
function proposalOf(text: string, folder: string, file: string, projectId: string): { input: ProposalInput; title: string } {
  const { fields, body } = split(text);
  const lines = body.split(/\r?\n/).map((line) => line.trim());
  const heading = lines.find((line) => /^#\s+\S/.test(line))?.replace(/^#\s+/, '');
  const prose = lines.find((line) => line !== '' && !line.startsWith('#') && !line.startsWith('```') && !line.startsWith('|') && !line.startsWith('-'));
  const title = cut(fields.name || heading || basename(file, '.md'), MAX_TITLE);
  const when = cut(fields.description || prose || `项目 ${folder} 的技能文件 ${file}，原来随这个项目的每一轮送达`, MAX_WHEN);
  const path = `${folder}/${file}`;
  const digest = sha256(text);
  return {
    title,
    input: {
      kind: 'skill',
      outputs: [{ title, when_to_use: when, body, project_ids: [projectId] }],
      why: {
        when: `项目 ${folder} 的工作用到它的时候：升级前它是这个项目每一轮都会拿到的技能文件`,
        changes: '它写的是在这个项目里怎么做一件事；不迁进来，升级后就没有任何一轮再拿到它',
        generalizes: `原文是主人放在数据目录技能文件夹里的 ${path}，作用域照原来的目录只是项目 ${folder}；步骤还能不能用由把关判断`,
      },
      evidence: [{ source: 'file', ref: path, location: `数据目录技能文件夹里的 ${path}（sha256 ${digest.slice(0, 12)}）`, excerpt: text }],
      request_id: `${projectId}/${file}@${digest.slice(0, 16)}`,
    },
  };
}

// How the folder is read. The service reads the disk; a test hands one that fails where it says.
export interface ImportFiles {
  list(dir: string): Dirent[];
  read(file: string): string;
}
const DISK: ImportFiles = {
  list: (dir) => readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)),
  read: (file) => readFileSync(file, 'utf8'),
};

const failure = (err: unknown): string => {
  const code = (err as NodeJS.ErrnoException).code;
  return `${code === 'EACCES' || code === 'EPERM' ? '没有权限读' : code === 'ENOENT' ? '读的时候已经不在了' : '读不出来'}（${code ?? String(err)}）`;
};

type Found = { path: string; folder: string; file: string; full: string; project: { id: string; name: string } | null; state?: 'skipped' | 'failed'; reason?: string };

// The files under the folder, each with the project it is for or why it is for none. Only
// regular `.md` files directly in a project's folder, as rounds were handed them; a link, to a
// file or to a project's folder, is not followed and says so. A project folder that cannot be
// listed is one line that says why; the rest go on.
function filesIn(folder: string, projects: readonly { id: string; name: string }[], files: ImportFiles): Found[] {
  if (!existsSync(folder) || !statSync(folder).isDirectory()) throw new InputError(`目录不存在：${folder}`);
  let tops: Dirent[];
  try {
    tops = files.list(folder);
  } catch (err) {
    throw new InputError(`目录 ${folder} 列不出来：${failure(err)}`);
  }
  const found: Found[] = [];
  for (const top of tops) {
    const project = projects.find(({ name }) => name === top.name) ?? null;
    if (top.isSymbolicLink()) {
      found.push({ path: top.name, folder: '', file: top.name, full: join(folder, top.name), project, state: 'skipped', reason: '是一个链接，没有跟过去读：把原来的目录或文件放在这里再导入' });
      continue;
    }
    if (top.isFile() && top.name.endsWith('.md')) {
      found.push({ path: top.name, folder: '', file: top.name, full: join(folder, top.name), project: null, state: 'skipped', reason: '不在项目子目录里：技能文件按项目名放在子目录里，才知道它是哪个项目的' });
      continue;
    }
    if (!top.isDirectory()) continue;
    let inside: Dirent[];
    try {
      inside = files.list(join(folder, top.name));
    } catch (err) {
      found.push({ path: `${top.name}/`, folder: top.name, file: '', full: join(folder, top.name), project, state: 'failed', reason: `这个目录${failure(err)}，里面的文件一份都没有看` });
      continue;
    }
    for (const each of inside) {
      if (!each.name.endsWith('.md')) continue;
      const path = `${top.name}/${each.name}`;
      const reason = project === null ? `没有叫“${top.name}”的项目：先建这个项目，或者把文件挪到对应项目名的目录里`
        : each.isSymbolicLink() ? '是一个链接，没有跟过去读：把原文件放在这里再导入'
        : each.isFile() ? undefined : '不是普通文件';
      found.push({ path, folder: top.name, file: each.name, full: join(folder, top.name, each.name), project, ...(reason === undefined ? {} : { state: 'skipped' as const, reason }) });
    }
  }
  return found;
}

// A preview (`dryRun`) says what each file is and what the entrance would make of it — the
// refusal it would give, by the entrance's own checks — and writes nothing; otherwise each file
// not yet in is proposed, one by one. A file that cannot be read or is refused says why on its
// own line and the rest go on; anything else (the ledger failing to write) stops the import.
export function importSkills(ledger: ImportLedger, folder: string, ctx: Ctx, options: { dryRun: boolean; files?: ImportFiles }): { dir: string; items: ImportItem[] } {
  const files = options.files ?? DISK;
  const projects = ledger.listProjects().map(({ id, name }) => ({ id, name }));
  const items = filesIn(folder, projects, files).map((found): ImportItem => {
    const base = { path: found.path, project_id: found.project?.id ?? null, title: null };
    if (found.state !== undefined || found.project === null) return { ...base, state: found.state ?? 'skipped', reason: found.reason ?? '' };
    let text: string;
    try {
      text = files.read(found.full);
    } catch (err) {
      return { ...base, state: 'failed', reason: `这份文件${failure(err)}` };
    }
    if (text.trim() === '') return { ...base, state: 'skipped', reason: '空文件' };
    const { input, title } = proposalOf(text, found.folder, found.file, found.project.id);
    try {
      const known = ledger.checkProposal(input, IMPORTER);
      if (known) return { ...base, title, state: 'imported', proposal_id: known.id };
      if (options.dryRun) return { ...base, title, state: 'new' };
      const { id } = ledger.propose(input, IMPORTER, ctx);
      return { ...base, title, state: 'proposed', proposal_id: id };
    } catch (err) {
      if (!(err instanceof InputError)) throw err;
      return { ...base, title, state: 'refused', reason: err.message };
    }
  });
  return { dir: folder, items };
}
