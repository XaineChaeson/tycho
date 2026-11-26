import { prepareHandoffFiles, collectHandoffFiles } from '../service/project-handoff-files.ts';
import { execFileSync } from 'node:child_process';
import './guard.ts';
import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
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


export async function materialProject(t: TestContext, oldGlobal = false) {
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

 return { root,a,b,c,ah,bh,ch,s,target,third,p,task,run,review,kid,file,binary,registered,acceptor,
   ready(){ s.pushTick(new Date('2099-01-01')); for(const row of s.outbox.takeDue(new Date('2099-01-01')))s.outbox.markSent(row.id);s.setProjectPaused(p,true,USER);s.close();target.close();third.close();opened.splice(opened.indexOf(s),3); },
 };
}
