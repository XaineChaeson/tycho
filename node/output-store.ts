import { constants } from 'node:fs';
import { open, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { outputSource } from '../shared/node-output.ts';
import type { OutputLease, OutputWriter, OutputStream, ResultReference } from '../shared/node-output.ts';
import { atomic, claimFence, CHUNK, cleanRaw, file, heldAt, manifestAt, maybe, QUEUE, renameWithRetry, rootOf, safeDir } from './output-files.ts';
import type { Manifest, Segment, StreamState } from './output-files.ts';
interface Job { stream: OutputStream; start: number; end: number; bytes: Buffer }
export async function openOutputWriter(lease: OutputLease): Promise<OutputWriter> {
 await safeDir(lease.root); if (!await maybe(join(lease.root,'owner.json'))) throw new Error('节点输出lease不存在');
 const root=await rootOf(lease.root,lease.nodeId); const held=await heldAt(root,outputSource(lease.source),lease.nodeId);
 if (!held || (['root','source','run_dir','nodeId','raw_bytes','result_bytes','reserved_bytes'] as const).some(key=>held.lease[key]!==lease[key])) throw new Error('节点输出lease不存在或不匹配');
 const dir=join(root,lease.source);if(await maybe(join(dir,'release.json'))||await maybe(join(dir,'released.json')))throw new Error('节点输出预留已释放'); const m=await manifestAt(dir,lease.source);
 if (m.phase!=='reserved') throw new Error('节点输出已经开始或封存');
 const fence=await claimFence(lease,'writer');if(!fence.won)throw new Error('节点输出启动fence已被占用');
 // A release may have completed and removed its fence while this opener was paused.
 if(await maybe(join(dir,'release.json'))||await maybe(join(dir,'released.json')))throw new Error('节点输出预留已释放');
 m.phase='writing';await atomic(join(dir,'capture.json'),m);
 const queues:Record<OutputStream,Job[]>={stdout:[],stderr:[]}; const charged={stdout:0,stderr:0};
 const limits={stdout:Math.floor(lease.raw_bytes/2),stderr:lease.raw_bytes-Math.floor(lease.raw_bytes/2)};
 let running=false,closing=false,next:OutputStream='stdout',failure:unknown;const waiters:Array<()=>void>=[];
 const normalize=(s:StreamState)=>{s.segments=s.segments.filter(seg=>seg.end>s.base);s.committed_end=Math.max(s.base,Math.min(s.end,s.committed_end));};
 const advance=(stream:OutputStream,to:number,reason:string)=>{const s=m[stream];s.base=Math.max(s.base,to);m.issue=reason;normalize(s);};
 const persist=async()=>{(m as Manifest&{queued_bytes:number}).queued_bytes=charged.stdout+charged.stderr;await atomic(join(dir,'capture.json'),m);};
 async function append(job:Job):Promise<void>{
  const s=m[job.stream];if(job.end<=s.base)return;
  if(!await cleanRaw(dir,m)){advance(job.stream,job.end,'旧诊断段暂不能释放，当前诊断已丢弃');return;}
  let done=Math.max(0,s.base-job.start); const segmentSize=Math.max(1,Math.ceil(limits[job.stream]/8));
  while(done<job.bytes.length){
   let segment=s.segments.at(-1);let fresh=false;
   if(!segment||segment.end!==job.start+done||segment.end-segment.start>=segmentSize){segment={name:job.stream+'-'+randomUUID()+'.seg',start:job.start+done,end:job.start+done};fresh=true;}
   const count=Math.min(job.bytes.length-done,segmentSize-(segment.end-segment.start));
   const fd=fresh?await open(join(dir,segment.name),constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|(constants.O_NOFOLLOW??0),0o600):await file(join(dir,segment.name),constants.O_APPEND|constants.O_WRONLY);
   try{let wrote=0;while(wrote<count){const answer=await fd.write(job.bytes,done+wrote,count-wrote,null);if(answer.bytesWritten===0)throw new Error('诊断段没有写入');wrote+=answer.bytesWritten;}}finally{await fd.close();}
   if(fresh)s.segments.push(segment);segment.end+=count;done+=count;s.committed_end=segment.end;
  }
  let bytes=s.segments.reduce((sum,seg)=>sum+seg.end-seg.start,0);
  while(bytes>limits[job.stream]&&s.segments.length){const old=s.segments.shift()!;bytes-=old.end-old.start;s.base=Math.max(s.base,old.end);}
  normalize(s);
 }
 async function pump():Promise<void>{
  if(running)return;running=true;
  try{for(;;){while(queues.stdout.length||queues.stderr.length){const stream=queues[next].length?next:next==='stdout'?'stderr':'stdout';next=stream==='stdout'?'stderr':'stdout';const job=queues[stream].shift()!;
   try{await persist();await append(job);}catch(error){advance(stream,job.end,'诊断写入失败：'+String((error as Error).message).slice(0,200));}
   finally{charged[stream]-=job.bytes.buffer.byteLength;try{await persist();await cleanRaw(dir,m);}catch(error){failure=error;}}
  }try{await persist();}catch(error){failure=error;}if(!queues.stdout.length&&!queues.stderr.length)break;}}finally{running=false;for(const resolve of waiters.splice(0))resolve();}
 }
 return {
  feed(stream,bytes){
   if(closing)throw new Error('节点输出已结束接收');if(stream!=='stdout'&&stream!=='stderr')throw new Error('诊断流不合法');
   const s=m[stream];if(!Number.isSafeInteger(s.end+bytes.byteLength))throw new Error('诊断逻辑位置超限');const end=s.end+bytes.byteLength;s.end=end;
   const keep=Math.min(bytes.byteLength,CHUNK,limits[stream]);const start=end-keep;
   if(start>s.committed_end&&bytes.byteLength>keep)advance(stream,start,'单次诊断输入超过保留窗口，前段已丢弃');
   if(!keep){advance(stream,end,'该诊断流没有可用保留容量');void pump();return;}
   while(charged[stream]+keep>QUEUE&&queues[stream].length){const dropped=queues[stream].shift()!;charged[stream]-=dropped.bytes.buffer.byteLength;advance(stream,dropped.end,'诊断待写队列已满，早期区段已丢弃');}
   if(charged[stream]+keep>QUEUE){advance(stream,end,'诊断待写队列已满，当前区段已丢弃');void pump();return;}
   const owned=Buffer.allocUnsafeSlow(keep);owned.set(bytes.subarray(bytes.byteLength-keep));charged[stream]+=owned.buffer.byteLength;queues[stream].push({stream,start,end,bytes:owned});void pump();
  },
  async finish(envelopeBytes,state){
   if(closing)throw new Error('节点结果只能封存一次');closing=true;
   let body:Buffer;
   if(envelopeBytes.byteLength>lease.result_bytes){state='incomplete';body=Buffer.from(JSON.stringify({version:1,source:lease.source,state,reason:'原生结果超过冻结容量上限'}));}
   else body=Buffer.from(envelopeBytes);
   envelopeBytes=new Uint8Array(0); // Do not retain the caller's possibly larger backing across asynchronous I/O.
   if(body.length>lease.result_bytes)throw new Error('冻结结果容量放不下不可核实说明');
   const value=JSON.parse(body.toString('utf8')) as {version?:unknown;source?:unknown;state?:unknown;reading?:unknown;reason?:unknown};
   if(value.version!==1||value.source!==lease.source||value.state!==state||!['ready','incomplete'].includes(state))throw new Error('结果envelope归属或状态不匹配');
   if(state==='ready'&&(value.reading===null||typeof value.reading!=='object'||Array.isArray(value.reading)))throw new Error('结果envelope缺少reading');
   if(state==='incomplete'&&(typeof value.reason!=='string'||!value.reason||value.reading!==undefined))throw new Error('结果envelope缺少原因');
   if(running||queues.stdout.length||queues.stderr.length)await new Promise<void>(resolve=>waiters.push(resolve));
   if(failure){m.issue='采集元数据无法持久化';throw failure;}
   const target=join(dir,'result.bin');if(await maybe(target))throw new Error('原生结果已经存在');const draft=target+'.'+randomUUID()+'.draft';
   const ref:ResultReference={version:1,source:lease.source,state,size:body.length,sha256:createHash('sha256').update(body).digest('hex')};
   try{await writeFile(draft,body,{flag:'wx',mode:0o600,flush:true});await renameWithRetry(draft,target);m.result=ref;m.phase='sealed';m.sealed_at=Date.now();await persist();return ref;}catch(error){m.phase='writing';delete m.result;delete m.sealed_at;m.issue='原生结果没有成功封存';try{await persist();}catch{}throw error;}finally{await rm(draft,{force:true});}
  }
 };
}
