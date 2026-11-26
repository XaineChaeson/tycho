// Private storage primitives; no process/provider/business ownership is inferred here.
import { constants } from 'node:fs';
import { lstat, link, mkdir, open, readdir, realpath, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { normalizeCaptureSpec, outputRunDir, outputSource } from '../shared/node-output.ts';
import type { OutputLease, ResultReference } from '../shared/node-output.ts';
export const META = 16 * 1024;
export const PAGE = 256 * 1024;
export const QUEUE = 128 * 1024;
export const CHUNK = 64 * 1024;
export const FIXED = 8 * META + 2 * QUEUE + CHUNK + 2 * PAGE;
export const SOURCE = /^[0-9a-f]{64}$/;
export const SEGMENT = /^(stdout|stderr)-[0-9a-f-]{36}\.seg$/;
export interface Segment { name: string; start: number; end: number }
export interface StreamState { base: number; end: number; committed_end: number; segments: Segment[] }
export interface Manifest { version: 1; source: string; phase: 'reserved' | 'writing' | 'sealed'; stdout: StreamState; stderr: StreamState; result?: ResultReference; issue?: string; unavailable?: boolean; sealed_at?: number; raw_expired?: boolean }
export interface Held { version: 1; lease: OutputLease; created_at: number }
export const emptyStream = (): StreamState => ({ base: 0, end: 0, committed_end: 0, segments: [] });
export function cost(raw: number, result: number): number { const total = 2 * raw + 3 * result + FIXED; if (!Number.isSafeInteger(total)) throw new Error('节点输出预留超过安全整数'); return total; }
export async function safeDir(path: string): Promise<void> { const found = await lstat(path); if (!found.isDirectory() || found.isSymbolicLink()) throw new Error('节点输出目录含符号链接或不是目录'); }
export async function safeFile(path: string): Promise<void> { const found = await lstat(path); if (!found.isFile() || found.isSymbolicLink()) throw new Error('节点输出文件含符号链接或不是普通文件'); }
export async function maybe(path: string): Promise<boolean> { try { await lstat(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; } }
export async function file(path: string, flags = constants.O_RDONLY) { await safeFile(path); const fd = await open(path, flags | (constants.O_NOFOLLOW ?? 0)); try { if (!(await fd.stat()).isFile()) throw new Error('节点输出不是普通文件'); return fd; } catch (error) { await fd.close(); throw error; } }
const RETRYABLE_FS = new Set(['EPERM', 'EBUSY', 'EACCES']);
const waitMs = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
export async function renameWithRetry(from: string, to: string, attempts = 8): Promise<void> {
  for (let i = 0; ; i++) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!code || !RETRYABLE_FS.has(code) || i >= attempts - 1) throw error;
      await waitMs(15 * (i + 1));
    }
  }
}
export async function json<T>(path: string): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      const fd = await file(path);
      try {
        const stat = await fd.stat();
        if (stat.size > META) throw new Error('节点输出元数据过大');
        const body = Buffer.alloc(stat.size);
        let offset = 0;
        while (offset < body.length) {
          const answer = await fd.read(body, offset, body.length - offset, offset);
          if (!answer.bytesRead) throw new Error('节点输出元数据不完整');
          offset += answer.bytesRead;
        }
        return JSON.parse(body.toString('utf8')) as T;
      } finally {
        await fd.close();
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!code || !RETRYABLE_FS.has(code) || i >= 5) throw error;
      await waitMs(15 * (i + 1));
    }
  }
}
export async function atomic(path: string, value: unknown): Promise<void> { const body = JSON.stringify(value); if (Buffer.byteLength(body) > META) throw new Error('节点输出元数据超限'); const draft = path + '.' + randomUUID() + '.draft'; try { await writeFile(draft, body, { flag: 'wx', mode: 0o600, flush: true }); if (await maybe(path)) await safeFile(path); await renameWithRetry(draft, path); } finally { await rm(draft, { force: true }); } }
export type FenceRole = 'writer' | 'release';
export async function readFence(lease:OutputLease):Promise<FenceRole|undefined>{
 const target=join(lease.root,lease.source,'writer.lock');if(!await maybe(target))return;
 const value=await json<{version:number;root:string;source:string;nodeId:string;run_dir:string;role:FenceRole}>(target);
 if(value.version!==1||value.root!==lease.root||value.source!==lease.source||value.nodeId!==lease.nodeId||value.run_dir!==lease.run_dir||!['writer','release'].includes(value.role))throw new Error('输出启动fence归属不符或格式未知');return value.role;
}
export async function claimFence(lease:OutputLease,role:FenceRole):Promise<{won:boolean;role:FenceRole}>{
 const target=join(lease.root,lease.source,'writer.lock'),draft=target+'.'+randomUUID()+'.draft';
 const value={version:1,root:lease.root,source:lease.source,nodeId:lease.nodeId,run_dir:lease.run_dir,role};
 try{
  await writeFile(draft,JSON.stringify(value),{flag:'wx',mode:0o600,flush:true});
  try{await link(draft,target);return {won:true,role};}
  catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;const held=await readFence(lease);if(!held)throw new Error('输出启动fence竞争后丢失');return {won:false,role:held};}
 }finally{await rm(draft,{force:true});}
}
export const ROOT_OWNER={version:1,format:'tycho-node-output'} as const;
const OWNER_DRAFT=/^owner\.json\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.draft$/;
function nodeIdentity(value:unknown):string{if(typeof value!=='string'||!value||value.length>256)throw new Error('节点输出登记身份无效');return value;}
async function ownerDraft(root:string,name:string):Promise<void>{
 const fd=await file(join(root,name));const expected=Buffer.from(JSON.stringify(ROOT_OWNER));
 try{const size=(await fd.stat()).size;if(size>expected.length)throw new Error('未知根管理draft');const found=await fd.readFile();if(!expected.subarray(0,found.length).equals(found))throw new Error('未知根管理draft');}finally{await fd.close();}
}
export async function rootOf(path:string,nodeId:string):Promise<string>{
 nodeIdentity(nodeId);const at=resolve(path);await mkdir(at,{recursive:true,mode:0o700});await safeDir(at);const root=await realpath(at),owner=join(root,'owner.json');
 const names=await readdir(root),drafts=names.filter(name=>OWNER_DRAFT.test(name));if(drafts.length>4)throw new Error('根管理draft数量异常');
 if(!await maybe(owner)){
  if(names.some(name=>!OWNER_DRAFT.test(name)))throw new Error('节点输出根含未知文件');
  for(const name of drafts)await ownerDraft(root,name);
  for(const name of drafts)await unlink(join(root,name));
  const draft=owner+'.'+randomUUID()+'.draft';
  try{await writeFile(draft,JSON.stringify(ROOT_OWNER),{flag:'wx',mode:0o600,flush:true});try{await link(draft,owner);}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}}finally{await rm(draft,{force:true});}
 }
 const record=await json<{version:number;format:string}>(owner);if(record.version!==ROOT_OWNER.version||record.format!==ROOT_OWNER.format)throw new Error('节点输出根管理格式未知');
 for(const name of await readdir(root))if(OWNER_DRAFT.test(name)){await ownerDraft(root,name);await unlink(join(root,name));}
 return root;
}
export function verifyHeld(held: Held, root: string, source: string, nodeId?: string): Held {
 const lease=held.lease;
 if(held.version!==1||!lease||lease.root!==root||lease.source!==source)throw new Error('节点输出lease归属不匹配');
 nodeIdentity(lease.nodeId);if(nodeId!==undefined&&lease.nodeId!==nodeId)throw new Error('节点输出lease归属不匹配');
 normalizeCaptureSpec({version:1,...lease});outputRunDir(lease.run_dir);
 if(lease.reserved_bytes!==cost(lease.raw_bytes,lease.result_bytes)||!Number.isSafeInteger(held.created_at))throw new Error('节点输出lease格式损坏');return held;
}
export async function heldAt(root: string, source: string, nodeId?: string): Promise<Held | undefined> {
 outputSource(source);const dir=join(root,source);if(!await maybe(dir))return;await safeDir(dir);
 return verifyHeld(await json<Held>(join(dir,'lease.json')),root,source,nodeId);
}
// This namespace is never published to a writer. Only the sole allocator may create it.
export const STAGE=/^\.reserve-([0-9a-f]{64})-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export async function recoverStage(root:string,name:string):Promise<void>{
 const match=STAGE.exec(name);if(!match)throw new Error('未知预留目录');const source=match[1]!,dir=join(root,name);await safeDir(dir);
 const names=await readdir(dir);if(names.length>4)throw new Error('未发布预留含未知文件');
 for(const fileName of names){
  if(!/^(lease\.json|capture\.json)(\.[0-9a-f-]{36}\.draft)?$/.test(fileName))throw new Error('未发布预留含非metadata文件');
  await safeFile(join(dir,fileName));if((await lstat(join(dir,fileName))).size>META)throw new Error('未发布预留metadata超限');
 }
 const lease=await maybe(join(dir,'lease.json'));if(lease)verifyHeld(await json<Held>(join(dir,'lease.json')),root,source);
 if(names.some(name=>name.startsWith('capture.json'))&&!lease)throw new Error('未发布预留顺序不符');
 if(await maybe(join(dir,'capture.json'))){const m=await manifestAt(dir,source);if(m.phase!=='reserved'||m.result||m.stdout.end!==0||m.stderr.end!==0||m.stdout.segments.length||m.stderr.segments.length)throw new Error('未发布预留出现活动状态');}
 // The final source directory is the publication point; no watch can own this staging path.
 await rm(dir,{recursive:true});
}
export async function manifestAt(dir: string, source: string): Promise<Manifest> {
 const m = await json<Manifest>(join(dir, 'capture.json'));
 if (m.version !== 1 || m.source !== source || !['reserved','writing','sealed'].includes(m.phase)) throw new Error('节点输出manifest格式损坏');
 for (const [stream,s] of [['stdout',m.stdout],['stderr',m.stderr]] as const) { if (!s || ![s.base,s.end,s.committed_end].every(n=>Number.isSafeInteger(n)&&n>=0) || s.base>s.committed_end || s.committed_end>s.end || !Array.isArray(s.segments) || s.segments.length>32) throw new Error('节点输出范围损坏'); let last = -1; for (const seg of s.segments) { if (!SEGMENT.test(seg.name) || !seg.name.startsWith(stream+'-') || !Number.isSafeInteger(seg.start) || !Number.isSafeInteger(seg.end) || seg.start<0 || seg.start>=seg.end || seg.start<last) throw new Error('节点输出分段损坏'); last=seg.end; } }
 return m;
}
export async function namesSafe(dir: string): Promise<string[]> { await safeDir(dir); const names = await readdir(dir); if(names.length>64)throw new Error('节点输出元数据文件数量超限'); for (const name of names) { if (!['lease.json','capture.json','writer.lock','release.json','released.json','result.bin'].includes(name) && !SEGMENT.test(name) && !/^(capture\.json|lease\.json|release\.json|released\.json|result\.bin|writer\.lock)\.[0-9a-f-]{36}\.draft$/.test(name)) throw new Error('节点输出目录含未知文件：'+name); try { await safeFile(join(dir,name)); } catch(error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; } } return names; }
export async function logicalBytes(dir: string): Promise<number> { let size=0; for (const name of await namesSafe(dir)) { try { size+=(await lstat(join(dir,name))).size; } catch(error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; } } return size; }
export async function cleanRaw(dir: string, m: Manifest): Promise<boolean> { const held=new Set([...m.stdout.segments,...m.stderr.segments].map(s=>s.name)); let clean=true; for (const name of await namesSafe(dir)) if (SEGMENT.test(name)&&!held.has(name)) { try { try { await unlink(join(dir,name)); } catch(error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; } } catch (error) { if ((error as NodeJS.ErrnoException).code!=='ENOENT') clean=false; } } return clean; }
export async function cleanReleased(dir: string,lease:OutputLease): Promise<void> { if(await maybe(join(dir,'writer.lock')))await readFence(lease); for (const name of await namesSafe(dir)) if (!['lease.json','release.json','released.json'].includes(name)) try { await unlink(join(dir,name)); } catch(error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; } }
