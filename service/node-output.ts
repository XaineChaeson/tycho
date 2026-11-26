// Normalize the bounded, non-secret poll report at the HTTP boundary.
import type {NodeOutputReport,OutputRelease} from '../shared/node-protocol.ts';
import type {OutputPolicy} from '../shared/node-output.ts';
import type {Ledger} from './ledger.ts';
import {InputError} from './errors.ts';
export function outputReport(value:unknown):NodeOutputReport|undefined {
 if(value===undefined)return undefined;
 if(!value||typeof value!=='object')throw new InputError('输出容量报告不是对象');
 const v=value as NodeOutputReport,c=v.capacity;
 if(!c||!['limit_bytes','used_bytes','reserved_bytes','external_bytes','free_bytes','available_runs'].every(k=>Number.isSafeInteger(c[k as keyof typeof c])&&Number(c[k as keyof typeof c])>=0))throw new InputError('输出容量报告无效');
 if(c.other_node_reserved_bytes!==undefined&&(!Number.isSafeInteger(c.other_node_reserved_bytes)||c.other_node_reserved_bytes<0||c.other_node_reserved_bytes>c.reserved_bytes))throw new InputError('其他登记输出预留计数无效');
 if(c.issue!==undefined&&typeof c.issue!=='string')throw new InputError('输出容量原因无效');
 if(!v.references||!Array.isArray(v.references.items)||v.references.items.length>32||!v.legacy||!Array.isArray(v.legacy.items)||v.legacy.items.length>32)throw new InputError('输出引用页无效');
 const path=(s:unknown):s is string=>typeof s==='string'&&/^tasks\/[A-Za-z0-9_-]+\/runs\/[A-Za-z0-9_-]+$/.test(s);
 for(const r of v.references.items)if(!r||!path(r.run_dir)||!(typeof r.source==='string'&&/^[a-f0-9]{64}$/.test(r.source))||!['reserved','writing','sealed','release_pending','released'].includes(r.phase))throw new InputError('输出来源引用无效');
 for(const r of v.legacy.items)if(!r||!path(r.run_dir))throw new InputError('旧输出引用无效');
 return {capacity:{limit_bytes:c.limit_bytes,used_bytes:c.used_bytes,reserved_bytes:c.reserved_bytes,external_bytes:c.external_bytes,free_bytes:c.free_bytes,available_runs:c.available_runs,...(c.other_node_reserved_bytes===undefined?{}:{other_node_reserved_bytes:c.other_node_reserved_bytes}),...(c.issue?{issue:c.issue.slice(0,1000)}:{})},references:{items:v.references.items.map(r=>({source:r.source,run_dir:r.run_dir,phase:r.phase})),...(typeof v.references.next==='string'?{next:v.references.next}:{})},legacy:{items:v.legacy.items.map(r=>({run_dir:r.run_dir}))}};
}
export function releasesFor(ledger:Pick<Ledger,'outputRelease'|'confirmLegacyOutput'>,machineId:string,nodeId:string,report:NodeOutputReport|undefined):OutputRelease[]{
 if(!report)return [];const releases:OutputRelease[]=[];
 for(const ref of report.references.items){if(ref.phase==='released'||ref.phase==='release_pending')continue;const run=ref.run_dir.split('/')[3]!;if(ledger.outputRelease(run,ref.source,machineId,nodeId))releases.push({kind:'capture',source:ref.source});}
 for(const ref of report.legacy.items){const run=ref.run_dir.split('/')[3]!;if(!ledger.outputRelease(run,undefined,machineId,nodeId,ref.run_dir))ledger.confirmLegacyOutput(ref.run_dir,machineId,nodeId);if(ledger.outputRelease(run,undefined,machineId,nodeId,ref.run_dir))releases.push({kind:'legacy',run_dir:ref.run_dir});}
 return releases;
}
export function policyOf(get:(name:'node.outputStoreLimitMb'|'node.runOutputLimitMb'|'node.resultLimitMb'|'retention.endedDays')=>number):OutputPolicy{return {store_bytes:get('node.outputStoreLimitMb')*1048576,raw_bytes:get('node.runOutputLimitMb')*1048576,result_bytes:get('node.resultLimitMb')*1048576,retention_ms:get('retention.endedDays')*86400000};}
