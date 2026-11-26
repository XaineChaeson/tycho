import { mkdir, readdir, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { normalizeCaptureSpec, normalizeOutputPolicy, outputInteger, outputRunDir, outputSource } from '../shared/node-output.ts';
import type { CaptureRange, CaptureReadRequest, OutputCapacity, OutputExternalUsage, OutputLease, OutputPolicy, OutputPool, OutputReference, ResultRange, ResultReadRequest } from '../shared/node-output.ts';
import { atomic, claimFence, cleanReleased, cost, emptyStream, file, heldAt, json, logicalBytes, manifestAt, maybe, META, namesSafe, PAGE, readFence, recoverStage, ROOT_OWNER, rootOf, SOURCE, STAGE } from './output-files.ts';
import type { Manifest } from './output-files.ts';

// One Nodeclient owns admission; this queue also pins one reader per source against release/reap.
export function createOutputPool(options: {root: string; nodeId: string; now?: () => number}): OutputPool {
 const clock=options.now??Date.now;
 let opened:Promise<string>|undefined;
 const root=()=>opened??=rootOf(options.root,options.nodeId);
 let tail:Promise<unknown>=Promise.resolve();
 const serial=<T>(action:()=>Promise<T>):Promise<T>=>{const answer=tail.then(action);tail=answer.catch(()=>{});return answer;};
 const reason=(error:unknown)=>String(error instanceof Error?error.message:error).slice(0,512);
 const issueResult=(source:string,state:ResultRange['state'],offset:number,why?:string):ResultRange=>({state,source,size:0,sha256:null,offset,base64:'',...(why?{reason:why}:{})});
 async function marker(dir:string,name:'release.json'|'released.json',source:string):Promise<boolean>{
  if(!await maybe(join(dir,name)))return false;const value=await json<{version:number;source:string;at:number}>(join(dir,name));
  if(value.version!==1||value.source!==source||!Number.isSafeInteger(value.at)||value.at<0)throw new Error('节点输出释放记录损坏');return true;
 }
 async function sources():Promise<string[]> {
  const at=await root();for(const name of await readdir(at))if(STAGE.test(name))await recoverStage(at,name);const found=await readdir(at);
  for(const name of found)if(name!=='owner.json'&&!SOURCE.test(name))throw new Error('节点输出根含未知文件：'+name);
  return found.filter(name=>SOURCE.test(name)).sort();
 }
 async function bound(source:string,run_dir:string){
  outputSource(source);outputRunDir(run_dir);const at=await root();const held=await heldAt(at,source,options.nodeId);
  if(held&&held.lease.run_dir!==run_dir)throw new Error('节点输出Run归属不匹配');
  return held;
 }
 async function capacity(policy:OutputPolicy,external:OutputExternalUsage,needed?:number):Promise<OutputCapacity>{
  policy=normalizeOutputPolicy(policy);outputInteger(external.bytes,'externalUsage.bytes');
  const target=needed??cost(policy.raw_bytes,policy.result_bytes);const tombstones:Array<{source:string;bytes:number;other:boolean}>=[];
  let used=0,reserved=META,otherReserved=0,issue=external.issue===undefined?undefined:(external.issue||'legacy输出占用尚未核实');
  try {
   const at=await root();used=Buffer.byteLength(JSON.stringify(ROOT_OWNER));
   for(const source of await sources()){
    const dir=join(at,source);const held=await heldAt(at,source);if(!held)throw new Error('节点输出预留消失');const other=held.lease.nodeId!==options.nodeId;
    let bytes=await logicalBytes(dir);
    if(await marker(dir,'release.json',source)&&!await marker(dir,'released.json',source)){const m=await manifestAt(dir,source);await collect(source);bytes=await logicalBytes(dir);}
    used+=bytes;if(bytes>held.lease.reserved_bytes)throw new Error('节点输出占用超过原预留，停止新准入');
    if(await marker(dir,'released.json',source)){const clean=(await namesSafe(dir)).every(name=>['lease.json','release.json','released.json'].includes(name));const charge=clean?3*META:held.lease.reserved_bytes;reserved+=charge;if(other)otherReserved+=charge;if(clean)tombstones.push({source,bytes,other});continue;}
    const m=await manifestAt(dir,source);const queued=(m as Manifest&{queued_bytes?:unknown}).queued_bytes??0;outputInteger(queued,'queued_bytes');used+=queued as number;if(bytes+(queued as number)>held.lease.reserved_bytes)throw new Error('节点输出文件与队列超过预留');
    reserved+=held.lease.reserved_bytes;if(other)otherReserved+=held.lease.reserved_bytes;
   }
   if(!issue)for(const entry of tombstones){if(policy.store_bytes-reserved-external.bytes>=target)break;const dir=join(at,entry.source);await namesSafe(dir);await rm(dir,{recursive:true});reserved-=3*META;if(entry.other)otherReserved-=3*META;used-=entry.bytes;}
   if(!Number.isSafeInteger(used)||!Number.isSafeInteger(reserved)||!Number.isSafeInteger(reserved+external.bytes))throw new Error('节点输出容量计数超限');
  }catch(error){issue=reason(error);}
  const free=Math.max(0,policy.store_bytes-reserved-external.bytes);
  return {limit_bytes:policy.store_bytes,used_bytes:used,reserved_bytes:reserved,external_bytes:external.bytes,other_node_reserved_bytes:otherReserved,free_bytes:issue?0:free,available_runs:issue?0:Math.floor(free/cost(policy.raw_bytes,policy.result_bytes)),...(issue?{issue}:{})};
 }
 async function released(source:string):Promise<boolean>{return marker(join(await root(),source),'released.json',source);}
 async function collect(source:string):Promise<void>{
  const at=await root(),dir=join(at,source);const m=await manifestAt(dir,source);
  const held=await heldAt(at,source);if(!held)throw new Error('输出预留消失');if(!await marker(dir,'release.json',source))throw new Error('缺少已持久释放授权');
  if(m.phase==='reserved'){const fence=await claimFence(held.lease,'release');if(fence.role!=='release')return;}
  else if(m.phase!=='sealed')return;
  else if(await maybe(join(dir,'writer.lock')))await readFence(held.lease);
  // Durable release intent precedes deletion; its presence makes all readers nonpayload.
  await atomic(join(dir,'released.json'),{version:1,source,at:clock()});await cleanReleased(dir,held.lease);
 }
 async function readCapture(request:CaptureReadRequest):Promise<CaptureRange>{
  const {source,run_dir,stream}=request;outputInteger(request.offset,'offset');outputInteger(request.bytes,'bytes');
  if(stream!=='stdout'&&stream!=='stderr')throw new Error('节点输出stream不合法');
  try{
   const held=await bound(source,run_dir);if(!held)return {state:'unavailable',source,reason:'节点输出预留不存在'};
   const dir=join(await root(),source);
   if(await marker(dir,'release.json',source))return {state:'unavailable',source,reason:'节点输出已按服务依据释放'};
   for(let attempt=0;attempt<4;attempt++){
    const m=await manifestAt(dir,source);if(m.unavailable)throw new Error(m.issue??'采集者输出无法核实');const s=m[stream];
    if(request.offset>s.end)throw new Error('读取位置超过可核实逻辑末端');
    const start=Math.max(request.offset,s.base),end=Math.max(start,Math.min(s.committed_end,start+Math.min(PAGE,request.bytes)));
    const heldFiles:Array<{fd:Awaited<ReturnType<typeof file>>;start:number;end:number;origin:number}>=[];
    try{
     let cursor=start;
     if(end>start)for(const seg of s.segments){
      if(!seg.name.startsWith(stream+'-'))throw new Error('诊断分段流归属不匹配');
      if(seg.end<=cursor||seg.start>=end)continue;
      if(seg.start>cursor)throw new Error('诊断保留区间有未声明缺口');
      const fd=await file(join(dir,seg.name));heldFiles.push({fd,start:cursor,end:Math.min(seg.end,end),origin:seg.start});
      if((await fd.stat()).size<seg.end-seg.start)throw new Error('诊断段未完整提交');cursor=Math.min(seg.end,end);
     }
     if(cursor<end)throw new Error('诊断尾段缺失');
     const body=Buffer.alloc(end-start);for(const chunk of heldFiles){let got=0;while(got<chunk.end-chunk.start){const answer=await chunk.fd.read(body,chunk.start-start+got,chunk.end-chunk.start-got,chunk.start-chunk.origin+got);if(!answer.bytesRead)throw new Error('诊断尾段提前结束');got+=answer.bytesRead;}}
     return {state:'range',source,base:s.base,end:s.end,committed_end:s.committed_end,start,base64:body.toString('base64'),sealed:m.phase==='sealed',...(request.offset<s.base?{gap:{from:request.offset,to:s.base,reason:m.issue??'早期诊断已淘汰'}}:{}),...(m.issue?{issue:m.issue}:{})};
    }catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT'||attempt===3)throw error;}
    finally{await Promise.all(heldFiles.map(({fd})=>fd.close()));}
   }
   throw new Error('诊断分段持续变化，请重试');
  }catch(error){return {state:'unavailable',source,reason:reason(error)};}
 }
 async function readResult(request:ResultReadRequest):Promise<ResultRange>{
  const {source,run_dir,offset}=request;outputInteger(offset,'offset');outputInteger(request.bytes,'bytes');
  try{
   const held=await bound(source,run_dir);if(!held)return issueResult(source,'missing',offset);
   const dir=join(await root(),source);
   if(await marker(dir,'release.json',source))return issueResult(source,'released',offset);
   const m=await manifestAt(dir,source);if(m.unavailable&&m.phase!=='sealed')return issueResult(source,'unavailable',offset,m.issue);
   if(m.phase!=='sealed')return issueResult(source,'pending',offset,m.issue);
   const ref=m.result;
   if(!ref||ref.version!==1||ref.source!==source||!['ready','incomplete'].includes(ref.state)||!Number.isSafeInteger(ref.size)||ref.size<1||ref.size>held.lease.result_bytes||!/^[0-9a-f]{64}$/.test(ref.sha256))throw new Error('原生结果引用损坏');
   if(offset>ref.size)throw new Error('结果读取位置超过末端');
   const fd=await file(join(dir,'result.bin'));
   try{
    if((await fd.stat()).size!==ref.size)throw new Error('原生结果文件大小与封存引用不符');
    const body=Buffer.alloc(Math.min(PAGE,request.bytes,ref.size-offset));let got=0;
    while(got<body.length){const answer=await fd.read(body,got,body.length-got,offset+got);if(!answer.bytesRead)throw new Error('原生结果文件提前结束');got+=answer.bytesRead;}
    return {state:ref.state,source,size:ref.size,sha256:ref.sha256,offset,base64:body.toString('base64')};
   }finally{await fd.close();}
  }catch(error){return issueResult(source,'unavailable',offset,reason(error));}
 }
 return {
  capacity:(policy,external)=>serial(()=>capacity(policy,external)),
  reserve:(request,policy,external)=>serial(async()=>{
   const spec=normalizeCaptureSpec(request.spec),run_dir=outputRunDir(request.run_dir);policy=normalizeOutputPolicy(policy);
   const at=await root(),existing=await heldAt(at,spec.source,options.nodeId);
   if(existing){
    const lease=existing.lease;if(lease.run_dir!==run_dir||lease.raw_bytes!==spec.raw_bytes||lease.result_bytes!==spec.result_bytes)throw new Error('同一source的输出预留发生冲突');
    await namesSafe(join(at,spec.source));
    if(await marker(join(at,spec.source),'release.json',spec.source))return {state:'capacity',capacity:await capacity(policy,external),reason:'该source已释放，不能重新启动'};
    await manifestAt(join(at,spec.source),spec.source);return {state:'ready',lease};
   }
   const reserved_bytes=cost(spec.raw_bytes,spec.result_bytes),available=await capacity(policy,external,reserved_bytes);
   if(available.issue||available.free_bytes<reserved_bytes)return {state:'capacity',capacity:available,reason:available.issue??'节点输出存储暂无足够容量'};
   const lease:OutputLease={root:at,source:spec.source,run_dir,nodeId:options.nodeId,raw_bytes:spec.raw_bytes,result_bytes:spec.result_bytes,reserved_bytes};
   const dir=join(at,'.reserve-'+spec.source+'-'+randomUUID());await mkdir(dir,{mode:0o700});
   await atomic(join(dir,'lease.json'),{version:1,lease,created_at:clock()});
   await atomic(join(dir,'capture.json'),{version:1,source:spec.source,phase:'reserved',stdout:emptyStream(),stderr:emptyStream()});
   await rename(dir,join(at,spec.source));
   return {state:'ready',lease};
  }),
  lease:(source,run_dir)=>serial(async()=>{const held=await bound(source,run_dir);if(!held)return;const dir=join(await root(),source);await namesSafe(dir);await manifestAt(dir,source);if(await marker(dir,'release.json',source))throw new Error('节点输出预留已释放');return held.lease;}),
  references:(request={})=>serial(async()=>{
   const after=request.after===undefined?'':outputSource(request.after),limit=Math.min(100,outputInteger(request.limit??20,'limit',true));
   const own:string[]=[];for(const source of await sources()){try{const held=await heldAt(await root(),source);if(held?.lease.nodeId===options.nodeId)own.push(source);}catch{}}
   const all=own.filter(source=>source>after),page=all.slice(0,limit),items:OutputReference[]=[];
   for(const source of page){
    const at=await root();let held;try{held=await heldAt(at,source,options.nodeId);}catch{continue;}if(!held)continue;
    const dir=join(at,source);
    try{if(await released(source)){items.push({source,run_dir:held.lease.run_dir,phase:'released'});continue;}const m=await manifestAt(dir,source);items.push({source,run_dir:held.lease.run_dir,phase:await marker(dir,'release.json',source)?'release_pending':m.phase,...(m.result?{result:m.result}:{}),...(m.issue?{issue:m.issue}:{})});}
    catch(error){items.push({source,run_dir:held.lease.run_dir,phase:'writing',issue:reason(error)});}
   }
   return {items,...(all.length>page.length?{next:page.at(-1)}:{})};
  }),
  release:source=>serial(async()=>{outputSource(source);const at=await root(),held=await heldAt(at,source,options.nodeId);if(!held||await released(source))return;await namesSafe(join(at,source));if(!await marker(join(at,source),'release.json',source))await atomic(join(at,source,'release.json'),{version:1,source,at:clock()});await collect(source);}),
  abandon:(source,why)=>serial(async()=>{
   outputSource(source);if(!why.trim())throw new Error('放弃采集必须说明依据');const at=await root(),held=await heldAt(at,source,options.nodeId);if(!held||await released(source))return;
   const dir=join(at,source);await namesSafe(dir);if(await maybe(join(dir,'writer.lock')))await readFence(held.lease);let m:Manifest;
   try{m=await manifestAt(dir,source);}catch{m={version:1,source,phase:'writing',stdout:emptyStream(),stderr:emptyStream(),unavailable:true};}
   if(m.phase==='sealed')return;
   const body=Buffer.from(JSON.stringify({version:1,source,state:'incomplete',reason:why.slice(0,512)}));if(body.length>held.lease.result_bytes)throw new Error('结果容量不足，无法保全放弃采集说明');
   const target=join(dir,'result.bin');if(await maybe(target))await unlink(target);
   const draft=target+'.'+randomUUID()+'.draft';await writeFile(draft,body,{flag:'wx',mode:0o600,flush:true});
   await rename(draft,target);
   for(const stream of [m.stdout,m.stderr]){stream.base=stream.end;stream.committed_end=stream.end;stream.segments=[];}
   m.phase='sealed';m.issue=why.slice(0,512);m.sealed_at=clock();
   m.result={version:1,source,state:'incomplete',size:body.length,sha256:createHash('sha256').update(body).digest('hex')};
   await atomic(join(dir,'capture.json'),m);
   if(await marker(dir,'release.json',source))await collect(source);
  }),
  reap:policy=>serial(async()=>{
   policy=normalizeOutputPolicy(policy);const at=await root();
   for(const source of await sources()){
    const dir=join(at,source);const held=await heldAt(at,source);if(!held)throw new Error('节点输出预留丢失');await namesSafe(dir);
    if(await marker(dir,'release.json',source)&&!await released(source))await collect(source);
    if(await released(source)){await cleanReleased(dir,held.lease);const marker=await json<{version:number;source:string;at:number}>(join(dir,'released.json'));if(marker.version!==1||marker.source!==source||!Number.isSafeInteger(marker.at))throw new Error('释放记录损坏');if(clock()-marker.at>=policy.retention_ms){await namesSafe(dir);await rm(dir,{recursive:true});}}
   }
  }),
  readCapture:request=>serial(()=>readCapture(request)),
  readResult:request=>serial(()=>readResult(request)),
 };
}
