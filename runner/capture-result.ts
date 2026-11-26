// A bounded transport envelope is not an adopted verdict. Decode it once before the ordinary Runner settlement.
import {createHash} from 'node:crypto';
import type {Reading,Usage} from '../adapters/types.ts';
import type {CaptureSpec,ResultRange} from '../shared/node-output.ts';
import type {CaptureEvidence} from '../service/capture-result.ts';
import {InputError} from '../service/errors.ts';
const CHUNK=256*1024;
function object(value:unknown):Record<string,unknown>{if(!value||typeof value!=='object'||Array.isArray(value))throw new InputError('节点结果对象不可读');return value as Record<string,unknown>;}
export function readingOf(value:unknown,hide:(text:string)=>string):Reading{
 const given=object(value);if(typeof given.finished!=='boolean')throw new InputError('节点结果缺完整解析标记');
 const text=(key:string):string|undefined=>{const v=given[key];if(v===undefined)return undefined;if(typeof v!=='string')throw new InputError('节点结果字段不可读：'+key);return hide(v);};
 const output:Reading={finished:given.finished};
 const body=text('text'),session=text('sessionRef');if(body!==undefined)output.text=body;if(session!==undefined)output.sessionRef=session;
 if(given.error!==undefined){const e=object(given.error);if(!['quota','auth','other'].includes(e.kind as string)||typeof e.message!=='string'||(e.resetsAt!==undefined&&typeof e.resetsAt!=='string'))throw new InputError('节点错误分类不可读');output.error={kind:e.kind as 'quota'|'auth'|'other',message:hide(e.message),...(typeof e.resetsAt==='string'?{resetsAt:hide(e.resetsAt)}:{})};}
 if(given.usage!==undefined){
  if(!Array.isArray(given.usage))throw new InputError('节点用量不可读');
  output.usage=given.usage.map(item=>{
   const v=object(item),u={} as Usage;
   for(const key of ['inputTokens','outputTokens','cacheReadTokens','cacheWriteTokens'] as const){const n=v[key];if(typeof n!=='number'||!Number.isFinite(n)||n<0)throw new InputError('节点用量数值不可读');u[key]=n;}
   if(v.model!==undefined){if(typeof v.model!=='string')throw new InputError('节点用量模型不可读');u.model=hide(v.model);}
   if(v.listCostUsd!==undefined){if(typeof v.listCostUsd!=='number'||!Number.isFinite(v.listCostUsd)||v.listCostUsd<0)throw new InputError('节点用量费用不可读');u.listCostUsd=v.listCostUsd;}return u;
  });
 }
 return output;
}
export async function readCaptureResult(runDir:string,spec:CaptureSpec,read:(request:{run_dir:string;source:string;offset:number;bytes:number})=>Promise<ResultRange>,guard:()=>void,hide:(text:string)=>string):Promise<{reading?:Reading;evidence:CaptureEvidence;issue?:string}>{
 const chunks:Buffer[]=[];let offset=0,size:number|undefined,hash:string|undefined,state:'ready'|'incomplete'|undefined;
 for(;;){
  guard();const page=await read({run_dir:runDir,source:spec.source,offset,bytes:CHUNK});guard();
  if(page.source!==spec.source||page.offset!==offset)throw new InputError('原生结果来源或分页位置不符');
  if(page.state!=='ready'&&page.state!=='incomplete')return {evidence:{source:spec.source,complete:false},issue:hide(page.reason??('原生结果'+page.state))};
  if(!Number.isSafeInteger(page.size)||page.size<=0||page.size>spec.result_bytes||typeof page.sha256!=='string'||!/^[a-f0-9]{64}$/.test(page.sha256))throw new InputError('原生结果总长或摘要不可核实');
  size??=page.size;hash??=page.sha256;state??=page.state;
  if(page.size!==size||page.sha256!==hash||page.state!==state)throw new InputError('读取中原生结果已变化');
  const bytes=Buffer.from(page.base64,'base64');
  if(!bytes.length||bytes.length>CHUNK||offset+bytes.length>size)throw new InputError('原生结果分页不连续或超限');
  chunks.push(bytes);offset+=bytes.length;if(offset===size)break;
 }
 const bytes=Buffer.concat(chunks);
 if(createHash('sha256').update(bytes).digest('hex')!==hash)throw new InputError('原生结果摘要不符');
 let decoded:unknown;try{decoded=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{throw new InputError('原生结果不是完整JSON/UTF8');}
 const envelope=object(decoded);
 if(envelope.version!==1||envelope.source!==spec.source||envelope.state!==state)throw new InputError('原生结果封装绑定不符');
 const evidence:CaptureEvidence={source:spec.source,complete:state==='ready',ref:{version:1,source:spec.source,state:state!,size:size!,sha256:hash!}};
 if(state==='incomplete'){if(typeof envelope.reason!=='string')throw new InputError('原生结果缺不可核实原因');return {evidence,issue:hide(envelope.reason)};}
 return {evidence,reading:readingOf(envelope.reading,hide)};
}
