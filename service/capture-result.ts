// Run result custody: bytes stay on the Node; this ledger record only authorizes their disposition.
import {createHash} from 'node:crypto';
import type {CaptureSpec, ResultReference} from '../shared/node-output.ts';
import {normalizeCaptureSpec} from '../shared/node-output.ts';
import {InputError} from './errors.ts';
export interface CaptureEvidence {source:string;ref?:ResultReference;complete:boolean}
export interface CaptureDisposition extends CaptureEvidence {version:1;disposition:'adopted'|'not_adopted';reason?:string;legacy?:true}
export function captureOf(run:{snapshot_json:string}):CaptureSpec|undefined {
 try{const snapshot=JSON.parse(run.snapshot_json) as {output_capture?:unknown};return snapshot.output_capture===undefined?undefined:normalizeCaptureSpec(snapshot.output_capture);}catch(error){throw new InputError((error as Error).message);}
}
export function outputSource(service:string,run:string,task:string,machineUid:string,nodeId:string):string {
 if(!service||!run||!task||!machineUid||!nodeId)throw new InputError('无法绑定这一轮的输出来源');
 return createHash('sha256').update(JSON.stringify(['tycho-node-output-v1',service,run,task,machineUid,nodeId])).digest('hex');
}
export function captureEvidence(value:CaptureEvidence,spec:CaptureSpec):CaptureEvidence {
 if(value.source!==spec.source||typeof value.complete!=='boolean')throw new InputError('节点结果来源与这一轮不符');
 const ref=value.ref;
 if(ref&&(ref.version!==1||ref.source!==spec.source||!['ready','incomplete'].includes(ref.state)||!Number.isSafeInteger(ref.size)||ref.size<0||ref.size>spec.result_bytes||!/^[a-f0-9]{64}$/.test(ref.sha256)))throw new InputError('节点结果摘要不可核实');
 if(value.complete&&(!ref||ref.state!=='ready'))throw new InputError('没有完整节点结果凭据');
 return {source:spec.source,complete:value.complete,...(ref?{ref:{...ref}}:{})};
}
