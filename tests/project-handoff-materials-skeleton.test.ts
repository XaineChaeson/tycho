import { prepareHandoffFiles, collectHandoffFiles } from '../service/project-handoff-files.ts';
import { execFileSync } from 'node:child_process';
import './guard.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { openLedger } from '../service/ledger.ts';
import { createProjectHome } from '../service/project-home.ts';
import { exportProjectHandoff,stageProjectHandoff,freezeProjectHandoff,importProjectHandoff } from '../service/project-home-transfer.ts';
import { createAcceptor } from '../service/accept.ts';
import { registrationDir } from '../service/releases.ts';
import { readBoundArtifact } from '../service/artifact-file.ts';
import { holdMachine, MACHINE, LOGIN, USER } from './helpers.ts';
import { create, output, WHY, OWNER_SAYS, OWNER } from './knowledge-helpers.ts';
import { givenOf } from '../service/knowledge-brief.ts';
const sha = (body: Buffer|string) => createHash('sha256').update(body).digest('hex');

for(const oldGlobal of [false,true]) test(`public populated handoff preserves Console revisions, original Run/report/review and registered binary (oldGlobal=${oldGlobal})`, async t => {
 const root=mkdtempSync(join(tmpdir(),'tycho-handoff-materials-')); const opened:{close():void}[]=[];
 t.after(()=>{for(const value of opened.reverse())value.close();rmSync(root,{recursive:true,force:true});});
 const a=join(root,'office'),b=join(root,'home'),c=join(root,'third');
 const ah=createProjectHome(a),bh=createProjectHome(b),ch=createProjectHome(c);opened.push(ah,bh,ch);
 const s=openLedger(join(a,'ledger.db'),{projectHome:ah}),target=openLedger(join(b,'ledger.db'),{projectHome:bh}),third=openLedger(join(c,'ledger.db'),{projectHome:ch});opened.push(s,target,third);
 s.setWhitelist({console:['user']},USER);const p=s.createProject({name:'实用非空交接样条',loginMode:'all'},USER);
 holdMachine(s,MACHINE);const login={id:'account',name:'synthetic',executor:'claude',tiers:LOGIN.login.tiers};s.putAccount(login,USER,'synthetic-ref');
 for(const id of ['analyse','review']) { const role={...s.getRole(id)!,default_tier:'execute' as const,...(id==='analyse'?{permission:'write' as const}:{})};s.putRole(role,USER);target.putRole(role,USER);third.putRole(role,USER); }
 const proposal=s.propose(create({title:'项目方法',body:'方法@1',project_ids:oldGlobal?null:[p]}),OWNER_SAYS,OWNER);
 const kid=s.listEntries().find(e=>e.proposal_id===proposal.id)!.id;
 const task=s.createTask({projectId:p,title:'完成的报告',goal:'核对方法@1',acceptance:'正式正文和证据齐全',roleId:'analyse'},USER);s.queueTask(task.id,USER);
 const snap={...LOGIN.snapshot,brief:'实际样条原输入方法@1',knowledge:s.applicable(p,'analyse').map(givenOf),access:{permission:'write',layer:'tools',args:[]}};
 const run=s.createRun(task.id,{...LOGIN,login,machine:s.getMachine(MACHINE.id)!,snapshot:snap},USER);s.markRunRunning(run.id);
 const receipt={status:'done',summary:'完成',artifacts:[{kind:'report',ref:'最后一条消息'},{kind:'file',ref:'artifacts/evidence.bin'}]};
 s.settleRun(run.id,0,receipt,{finalReply:'按方法@1完成的正式报告',codeCheck:{result:'same'}});
 const binary=Buffer.alloc(256*1024,0xa5);binary[0]=0;binary[1]=0xff;
 const file={name:'evidence.bin',bytes:binary.length,sha256:sha(binary)};
 const acceptor=createAcceptor({ledger:s,dataDir:a,runner:{fetchArtifacts:async(_run,into)=>{mkdirSync(into,{recursive:true});writeFileSync(join(into,file.name),binary);return{files:[file],problem:null};}}});
 const registered=await acceptor.register(task.id);assert.deepEqual(s.artifactsOfRun(run.id)?.registration?.files,[file]);assert.equal(sha(readFileSync(join(registrationDir(a,run.id,registered.registration),file.name))),file.sha256);
 const review=s.createTask({projectId:p,title:'独立审阅',goal:'审阅原报告和证据',roleId:'review',reviewOf:{taskId:task.id,...registered}},USER);
 // Keep the real review binding as history without running any model.
 s.abandonTask(review.id,'样条只核对交接闭包，不执行模型',USER);
 s.acceptTask(task.id,'Owner已核对样条报告与登记文件',{actor:'console'},{withoutReview:true});
 s.propose({inputs:[{knowledge_id:kid,revision:1,disposition:'revise'}],outputs:[output({revises:kid,title:'项目方法',body:'方法@2',project_ids:[p]})],why:WHY,evidence:[{source:'run',ref:run.id,location:'formal report',excerpt:'按方法@1完成的正式报告'}]},OWNER_SAYS,OWNER);
 const before={snapshot:s.getRun(run.id).snapshot_json,report:s.runReport(run.id),review:s.getTask(review.id).review_of_json,heads:s.getEntry(kid),revisions:s.revisionsOf(kid),proposal:s.getProposal(proposal.id)};
 s.pushTick(new Date('2099-01-01'));for(const row of s.outbox.takeDue(new Date('2099-01-01')))s.outbox.markSent(row.id);s.setProjectPaused(p,true,USER);
 s.close();target.close();third.close(); opened.splice(opened.indexOf(s),3);
 const bundle=exportProjectHandoff(a,p);if(process.env.TYCHO_HANDOFF_EVIDENCE_DIR)writeFileSync(join(process.env.TYCHO_HANDOFF_EVIDENCE_DIR,'bundle-'+p+'.json'),bundle);console.log(JSON.stringify({event:'exported-materials',project:p,task:task.id,run:run.id,review:review.id,knowledge:kid,registration:registered.registration,file,files:JSON.parse(bundle.toString()).files.map(({base64,...f}:any)=>f),held:JSON.parse(bundle.toString()).rows.run.map((r:any)=>({id:r.id,artifacts:r.artifacts_json,dropped:r.releases_dropped_at})),format:JSON.parse(bundle.toString()).format,sha256:sha(bundle)}));
 const damaged=JSON.parse(bundle.toString());damaged.files[0].base64=Buffer.from('changed').toString('base64');assert.throws(()=>stageProjectHandoff(b,Buffer.from(JSON.stringify(damaged)),ah.identity),/登记文件/);
 const globalHead=JSON.parse(bundle.toString());globalHead.rows.knowledge_revision.at(-1).projects_json='null';assert.throws(()=>stageProjectHandoff(b,Buffer.from(JSON.stringify(globalHead)),ah.identity),/当前头/);
 const foreignGate=JSON.parse(bundle.toString());foreignGate.rows.knowledge_proposal[0].gate_task_id='outside';assert.throws(()=>stageProjectHandoff(b,Buffer.from(JSON.stringify(foreignGate)),ah.identity),/把关来源/);
 const stage=stageProjectHandoff(b,bundle,ah.identity);stageProjectHandoff(c,bundle,ah.identity);
 const claim=freezeProjectHandoff(a,bundle,stage.id);assert.throws(()=>importProjectHandoff(c,bundle,claim),/目标服务/);
 assert.throws(()=>importProjectHandoff(b,bundle,claim,{afterLedgerInstall:()=>{throw Error('crash-after-ledger');}}),/crash-after-ledger/);assert.equal(bh.describe(p).phase,'incoming');importProjectHandoff(b,bundle,claim);assert.deepEqual(importProjectHandoff(b,bundle,claim),{service_id:bh.identity.id,generation:2});
 const landed=openLedger(join(b,'ledger.db'),{projectHome:bh}),old=openLedger(join(a,'ledger.db'),{projectHome:ah});opened.push(landed,old);
 assert.equal(landed.getRun(run.id).snapshot_json,before.snapshot);assert.deepEqual(landed.runReport(run.id),before.report);assert.equal(landed.getTask(review.id).review_of_json,before.review);
 assert.deepEqual(landed.revisionsOf(kid),before.revisions);assert.deepEqual(landed.getEntry(kid),before.heads);assert.deepEqual(landed.getProposal(proposal.id),before.proposal);
 assert.deepEqual(landed.readRevision(kid,1)?.project_ids,oldGlobal?null:[p]);assert.equal(landed.applicable(null,null).some(e=>e.id===kid),false);assert.equal(landed.readRevision(kid,1)?.body,'方法@1');assert.equal(landed.readRevision(kid,2)?.body,'方法@2');
 const readback=readBoundArtifact(join(registrationDir(b,run.id,registered.registration),file.name),file);console.log(JSON.stringify({event:'file-raw-read',path:join(registrationDir(b,run.id,registered.registration),file.name),actualSha:sha(readFileSync(join(registrationDir(b,run.id,registered.registration),file.name)))}));assert.ok(readback,'registered binary is readable');assert.equal(sha(readback),file.sha256);if(process.env.TYCHO_HANDOFF_EVIDENCE_DIR)writeFileSync(join(process.env.TYCHO_HANDOFF_EVIDENCE_DIR,'readback-'+p+'.bin'),readback);
 assert.throws(()=>old.createTask({projectId:p,title:'旧服务拒写',goal:'x',roleId:'analyse'},USER),/冻结|归属/);
 const next=landed.createTask({projectId:p,title:'下一件工作',goal:'按方法@2',roleId:'analyse'},USER);assert.equal(landed.applicable(p,next.role_id).find(e=>e.id===kid)?.revision,2);
 console.log(JSON.stringify({event:'target-readback',project:p,task:task.id,run:run.id,knowledge:kid,revisions:landed.revisionsOf(kid).map(r=>({id:r.id,revision:r.revision,body:r.body})),report:before.report,fileSha256:sha(readFileSync(join(registrationDir(b,run.id,registered.registration),file.name))),snapshotSha256:sha(before.snapshot),nextTask:next.id}));
});


test('real physical 741 schema42 v1 bundle is rejected by the same-schema43 boundary',t=>{
 const root=mkdtempSync(join(tmpdir(),'tycho-real-v1-stage-'));const home=createProjectHome(root);const ledger=openLedger(join(root,'ledger.db'),{projectHome:home});ledger.close();
 t.after(()=>{home.close();rmSync(root,{recursive:true,force:true});});
 const bytes=readFileSync(new URL('./fixtures/project-handoff/physical741-v1.json',import.meta.url));const parsed=JSON.parse(bytes.toString());
 assert.equal(parsed.format,'tycho-project-handoff-v1');assert.equal(parsed.schema,42);assert.throws(()=>stageProjectHandoff(root,bytes,parsed.source),/身份或结构无效/);assert.equal(home.describe(parsed.project_id).phase,'unknown');
 console.log(JSON.stringify({event:'real-v1-schema42-refused',project:parsed.project_id,sha256:sha(bytes),target:home.identity.id}));
});
test('new default writer does not change a v1 source snapshot during freeze/import',t=>{
 const root=mkdtempSync(join(tmpdir(),'tycho-v1-freeze-')),a=join(root,'office'),b=join(root,'home');
 const ah=createProjectHome(a),bh=createProjectHome(b),s=openLedger(join(a,'ledger.db'),{projectHome:ah}),target=openLedger(join(b,'ledger.db'),{projectHome:bh});
 const id=s.createProject({name:'v1 continued transaction',loginMode:'all'},USER);s.setProjectPaused(id,true,USER);s.close();target.close();
 t.after(()=>{ah.close();bh.close();rmSync(root,{recursive:true,force:true});});
 const legacy=new URL('./fixtures/project-handoff/v1-writer.ts',import.meta.url).href;
 const out=join(root,'legacy.json');execFileSync(process.execPath,['--input-type=module','-e',"import {writeFileSync} from 'node:fs';const m=await import(process.argv[1]);writeFileSync(process.argv[4],m.exportProjectHandoff(process.argv[2],process.argv[3]));",legacy,a,id,out]);
 const bytes=readFileSync(out);assert.equal(JSON.parse(bytes.toString()).format,'tycho-project-handoff-v1');
 const staged=stageProjectHandoff(b,bytes,ah.identity);const receipt=freezeProjectHandoff(a,bytes,staged.id);importProjectHandoff(b,bytes,receipt);
 console.log(JSON.stringify({event:'pristine-v1-freeze-import',project:id,sha256:sha(bytes),receipt}));
});


test('file preparation refuses unknown existing directories without changing their bytes',t=>{
 const root=mkdtempSync(join(tmpdir(),'tycho-handoff-unknown-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const dir=registrationDir(root,'run1','reg1');mkdirSync(dir,{recursive:true});writeFileSync(join(dir,'owner.txt'),'KEEP');
 const body=Buffer.from('ordinary registered evidence');const file={run_id:'run1',registration_id:'reg1',name:'evidence.bin',bytes:body.length,sha256:sha(body),body};
 assert.throws(()=>prepareHandoffFiles(root,[file],'transfer1','a'.repeat(64)),/未知既有登记目录/);assert.equal(readFileSync(join(dir,'owner.txt'),'utf8'),'KEEP');
});


test('source file collection bounds registered byte counts before opening a source path',()=>{
 const registration={id:'reg1',at:'synthetic',files:[{name:'large.bin',bytes:64*1024*1024+1,sha256:'a'.repeat(64)}]};
 const run={id:'run1',releases_dropped_at:null,artifacts_json:JSON.stringify({registration,registered:['reg1'],problem:null})};
 assert.throws(()=>collectHandoffFiles('/nonexistent-synthetic-source',[run],[]),/读取前.*预算/);
});
