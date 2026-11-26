// Node-side custody and process facts. Storage and provider parsers remain their owners'.
import {existsSync,lstatSync,readFileSync,rmSync,writeFileSync,renameSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {ADAPTERS} from '../adapters/all.ts';
import {normalizeCaptureSpec,normalizeOutputPolicy} from '../shared/node-output.ts';
import type {CaptureSpec,OutputPolicy} from '../shared/node-output.ts';
import {createOutputPool} from './output-pool.ts';
import {openOutputWriter} from './output-store.ts';
import {aliveOf,boxOf,listRuns,machineScope,runState,readWatchEvidence} from './runbox.ts';
import type {HostProcesses} from './hostprocess.ts';
export const DEFAULT_OUTPUT_POLICY:OutputPolicy={store_bytes:1024*1024*1024,raw_bytes:32*1024*1024,result_bytes:16*1024*1024,retention_ms:7*86400000};
import type {OutputRelease} from '../shared/node-protocol.ts';
export function outputMetadata(dataDir:string,runDir:string):{executor:string;capture:CaptureSpec}|undefined {
 const file=join(boxOf(dataDir,runDir).runDir,'snapshot','output.json');
 if(!existsSync(file))return undefined;
 const value=JSON.parse(readFileSync(file,'utf8')) as {executor?:unknown;capture?:unknown};
 if(typeof value.executor!=='string'||!ADAPTERS[value.executor]?.resultReader)throw new Error('输出采集执行器未知或需升级');
 return {executor:value.executor,capture:normalizeCaptureSpec(value.capture)};
}
export function captureController(dataDir:string,nodeId:string,procs:HostProcesses){
 const root=join(machineScope(dataDir),'output'),pool=createOutputPool({root,nodeId});
 const policyFile=join(machineScope(dataDir),'output-policy.json');
 let policy=existsSync(policyFile)?normalizeOutputPolicy(JSON.parse(readFileSync(policyFile,'utf8'))):DEFAULT_OUTPUT_POLICY;
 let after:string|undefined;let legacyAfter=0;
 async function legacy(){
  let bytes=0,issue:string|undefined;const refs:{run_dir:string}[]=[];
  for(const item of listRuns(dataDir)){
   const box=boxOf(dataDir,item.relative);
   if(existsSync(join(box.runDir,'snapshot','output.json')))continue;
   let present=false;
   for(const name of ['stdout.ndjson','stderr.log']){
    const st=lstatSync(join(box.runDir,name),{throwIfNoEntry:false});if(!st)continue;
    if(!st.isFile()||st.isSymbolicLink()){issue='旧原始输出不是普通文件，需核对来源';continue;}
    bytes+=st.size;present=true;
   }
   if(!present)continue;refs.push({run_dir:box.relative});
   if(!existsSync(box.procDir)){issue='旧原始输出缺本机过程归属证据，保留计费';continue;}
   try{const state=await runState(box,procs);if(aliveOf(state).alive!==false)issue='旧原始输出仍在写或无法核实，暂停新预留';}catch{issue='旧原始输出过程无法核实，保留计费';}
  }
  return {usage:{bytes,...(issue?{issue}:{})},refs};
 }
 return {
  pool,
  async takePolicy(given:unknown){policy=normalizeOutputPolicy(given);mkdirSync(machineScope(dataDir),{recursive:true});const tmp=policyFile+'.'+process.pid+'.tmp';writeFileSync(tmp,JSON.stringify(policy));renameSync(tmp,policyFile);},
  async prepare(run_dir:string,spec:CaptureSpec){return pool.reserve({run_dir,spec},policy,(await legacy()).usage);},
  async report(){try{
   await pool.reap(policy);
   const old=await legacy(),references=await pool.references({...(after?{after}:{}),limit:32});
   for(const ref of references.items){if(ref.phase!=='writing'&&ref.phase!=='release_pending')continue;const box=boxOf(dataDir,ref.run_dir);try{const evidence=readWatchEvidence(box);if(!evidence.pid)continue;const state=await runState(box,procs);if(aliveOf(state).alive===false)await pool.abandon(ref.source,'本机看管进程身份已核实退出，原生采集不完整');}catch{/* Unknown local ownership remains charged; never infer deletion. */}}
   await pool.reap(policy);
   const items=old.refs.slice(legacyAfter,legacyAfter+32);const nextLegacy=legacyAfter+items.length>=old.refs.length?0:legacyAfter+items.length;
   return {capacity:await pool.capacity(policy,old.usage),references:{...references,items:references.items.filter(item=>item.phase!=='released'&&item.phase!=='release_pending')},legacy:{items},advance:()=>{after=references.next;legacyAfter=nextLegacy;}};
  }catch(error){return {capacity:{limit_bytes:policy.store_bytes,used_bytes:0,reserved_bytes:0,external_bytes:0,free_bytes:0,available_runs:0,issue:'输出存储无法核实，容量计数待确认；'+String((error as Error).message).slice(0,512)},references:{items:[]},legacy:{items:[]},advance:()=>{}};}
  },
  async release(release:OutputRelease){
   if(release.kind==='capture'){if(!/^[a-f0-9]{64}$/.test(release.source))throw new Error('输出释放来源无效');await pool.release(release.source);return;}
   const box=boxOf(dataDir,release.run_dir);
   if(outputMetadata(dataDir,box.relative))throw new Error('有界输出不能当旧文件释放');
   const ownership=lstatSync(box.procDir,{throwIfNoEntry:false});
   if(!ownership?.isDirectory()||ownership.isSymbolicLink())throw new Error('旧输出缺本机过程归属证据，未删除');
   const state=await runState(box,procs);
   if(aliveOf(state).alive!==false)throw new Error('旧输出仍在写或未核实，未删除');
   // A lost watch may leave no exit file. Only its own recorded start and a complete
   // process check can replace that ending; a bare gate or a stop flag proves nothing.
   if(state.exit===null){
    const watch=readWatchEvidence(box);
    if(!state.started||watch.pid===undefined||!watch.at)throw new Error('旧输出缺本轮启动归属证据，未删除');
   }
   for(const name of ['stdout.ndjson','stderr.log']){const file=join(box.runDir,name),st=lstatSync(file,{throwIfNoEntry:false});if(!st)continue;if(!st.isFile()||st.isSymbolicLink())throw new Error('旧输出不是普通文件');rmSync(file);}
  },
 };
}
export async function openCapture(dataDir:string,nodeId:string,runDir:string,source:string|undefined){
 const meta=outputMetadata(dataDir,runDir);
 if(!meta){if(source!==undefined)throw new Error('缺有界输出元数据，未启动');return undefined;}
 if(source!==meta.capture.source)throw new Error('输出采集来源不符，未启动');
 const pool=createOutputPool({root:join(machineScope(dataDir),'output'),nodeId});
 const lease=await pool.lease(source,boxOf(dataDir,runDir).relative);
 if(!lease)throw new Error('输出预留不存在或已释放，未启动');
 const writer=await openOutputWriter(lease),limit=meta.capture.result_bytes;
 let reader=ADAPTERS[meta.executor]!.resultReader!({recordBytes:limit,stateBytes:limit,stderrBytes:limit});
 let failure:string|undefined;
 return {
  feed(stream:'stdout'|'stderr',bytes:Uint8Array){
   try{writer.feed(stream,bytes);}catch(error){failure=String((error as Error).message).slice(0,1000);reader=undefined as never;}if(failure)return;
   try{if(stream==='stdout')reader.feedStdout(bytes);else reader.feedStderr(bytes);}catch(error){failure=String((error as Error).message).slice(0,1000);reader=undefined as never;}
  },
  async finish(exit:number|null,problem?:string){
   let envelope:unknown;
   if(problem||failure)envelope={version:1,source,state:'incomplete',reason:problem??failure};
   else try{envelope={version:1,source,state:'ready',reading:reader.finish(exit)};}catch(error){envelope={version:1,source,state:'incomplete',reason:String((error as Error).message).slice(0,1000)};}
   reader=undefined as never;let body=Buffer.from(JSON.stringify(envelope));
   if(body.length>limit){envelope={version:1,source,state:'incomplete',reason:'原生结果超过本轮上限'};body=Buffer.from(JSON.stringify(envelope));}
   if(body.length>limit)throw new Error('结果预算不足以记录完整性说明');
   return writer.finish(body,(envelope as {state:'ready'|'incomplete'}).state);
  },
 };
}
