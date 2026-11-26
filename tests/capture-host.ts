import {basename} from 'node:path';
import {createHash} from 'node:crypto';
import type {RemoteHost} from '../runner/host.ts';
import type {Ledger} from '../service/ledger.ts';
import type {Adapter} from '../adapters/types.ts';
import {claudeAdapter} from '../adapters/claude.ts';
import {captureOf} from '../service/capture-result.ts';
// These fixtures explicitly model a prepared Node's typed wire result. They never run in production.
// Invalid source/offset/size requests fail; parsing is the adapter's real authority, not a synthetic receipt.
export function capturedHost(host:RemoteHost,ledger:Pick<Ledger,'getRun'>,adapter:Adapter=claudeAdapter,exit?:()=>number|null):RemoteHost {
 const binding=(dir:string,source:string)=>{const run=ledger.getRun(basename(dir)),spec=captureOf(run);if(!spec||spec.source!==source||dir.replace(/^\.tycho\//,'')!==`tasks/${run.task_id}/runs/${run.id}`)throw new Error('fixture capture binding mismatch');return {run,spec};};
 return {...host,
  async readCapture(req){const {run}=binding(req.run_dir,req.source);if(!Number.isSafeInteger(req.offset)||req.offset<0||req.bytes>262144)throw new Error('fixture invalid capture range');const page=await host.readRange(req.run_dir+'/'+(req.stream==='stdout'?'stdout.ndjson':'stderr.log'),req.offset);if(!page.size&&!page.mtime)return {state:'unavailable',source:req.source,reason:'原始输出不存在'};return {state:'range',source:req.source,base:0,start:req.offset,end:page.size,committed_end:page.size,base64:page.bytes.subarray(0,req.bytes).toString('base64'),sealed:run.state==='ended'||(exit?.()??null)!==null};},
  async readResult(req){const {spec}=binding(req.run_dir,req.source);const reader=adapter.resultReader!({recordBytes:spec.result_bytes,stateBytes:spec.result_bytes,stderrBytes:spec.result_bytes});let envelope:unknown;
   try{for(const stream of ['stdout','stderr'] as const){let offset=0;for(;;){const page=await host.readRange(req.run_dir+'/'+(stream==='stdout'?'stdout.ndjson':'stderr.log'),offset);if(stream==='stdout')reader.feedStdout(page.bytes);else reader.feedStderr(page.bytes);offset+=page.bytes.length;if(!page.bytes.length||offset>=page.size)break;}}envelope={version:1,source:req.source,state:'ready',reading:reader.finish(exit?.()??0)};}catch(error){throw error;}
   const body=Buffer.from(JSON.stringify(envelope));if(body.length>spec.result_bytes)throw new Error('fixture result exceeds frozen limit');return {state:'ready',source:req.source,size:body.length,sha256:createHash('sha256').update(body).digest('hex'),offset:req.offset,base64:body.subarray(req.offset,req.offset+req.bytes).toString('base64')};
  },
 };
}
