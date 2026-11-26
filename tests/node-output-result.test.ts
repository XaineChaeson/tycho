// Guards chunk binding, non-adoption and secret-generation checks on the public Node result envelope.
import './guard.ts';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {test} from 'node:test';
import {readCaptureResult} from '../runner/capture-result.ts';
const source='a'.repeat(64),spec={version:1 as const,source,raw_bytes:1024,result_bytes:1024*1024};
function transport(value:unknown,change=false){const bytes=Buffer.from(JSON.stringify(value)),hash=createHash('sha256').update(bytes).digest('hex');return async(req:{source:string;offset:number;bytes:number})=>({state:'ready' as const,source:req.source,size:bytes.length,sha256:change&&req.offset?'b'.repeat(64):hash,offset:req.offset,base64:bytes.subarray(req.offset,req.offset+req.bytes).toString('base64')});}
test('multi-page result is hash-checked, normalized, hidden and does not infer finished from ready',async()=>{
 const reader=transport({version:1,source,state:'ready',reading:{finished:false,text:'secret-token-'+'.'.repeat(300000),sessionRef:'secret-token-session'}});
 let checks=0;const got=await readCaptureResult('tasks/t/runs/r',spec,reader,()=>{checks++;},text=>text.replaceAll('secret-token','HIDDEN'));
 assert.equal(got.reading?.finished,false);assert.match(got.reading!.text!,/^HIDDEN/);assert.equal(got.reading!.sessionRef,'HIDDEN-session');assert.ok(checks>=4);assert.equal(got.evidence.complete,true);
});
test('changing a result hash between pages cannot return a partial Reading',async()=>{
 await assert.rejects(readCaptureResult('tasks/t/runs/r',spec,transport({version:1,source,state:'ready',reading:{finished:true,text:'.'.repeat(300000)}},true),()=>{},x=>x),/变化/);
});
test('credential generation guard runs before fetching any secret result',async()=>{
 let reads=0;await assert.rejects(readCaptureResult('tasks/t/runs/r',spec,async()=>{reads++;throw Error();},()=>{throw Error('credential retired');},x=>x),/credential retired/);assert.equal(reads,0);
});
