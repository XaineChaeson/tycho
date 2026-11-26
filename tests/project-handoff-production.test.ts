import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createAcceptor } from '../service/accept.ts';
import './guard.ts';
import assert from 'node:assert/strict';
import fs, { lstatSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { materialProject } from './project-handoff-helpers.ts';
import { exportProjectHandoff, stageProjectHandoff, freezeProjectHandoff, importProjectHandoff } from '../service/project-home-transfer.ts';
import { openLedger } from '../service/ledger.ts';
import { ulid } from '../service/ids.ts';
import { registrationDir } from '../service/releases.ts';
import { create, output, WHY, EVIDENCE, OWNER, OWNER_SAYS, MCP } from './knowledge-helpers.ts';
import { LOGIN, USER } from './helpers.ts';

const wire = (bytes:Buffer) => JSON.parse(bytes.toString());
const encoded = (value:unknown) => Buffer.from(JSON.stringify(value));

test('wire boundary rejects malformed shapes, rows, JSON references and file identities before staging',async t=>{
 const f=await materialProject(t);f.ready();const bytes=exportProjectHandoff(f.a,f.p),original=wire(bytes);
 const cases:[string,(value:any)=>void][]=[
  ['unknown format',v=>v.format='future'],['extra envelope member',v=>v.secret='no'],['extra table',v=>v.rows.account=[]],
  ['missing column',v=>delete v.rows.task[0].goal],['extra column',v=>v.rows.task[0].secret='no'],['column type',v=>v.rows.task[0].revision='1'],
  ['invalid JSON',v=>v.rows.run[0].snapshot_json='{'],['duplicate record',v=>v.rows.task.push(v.rows.task[0])],
  ['unknown current head',v=>v.rows.knowledge_revision.at(-1).projects_json='null'],['Q historical revision',v=>v.rows.knowledge_revision[0].projects_json='["Q"]'],
  ['missing old revision',v=>v.rows.knowledge_revision.shift()],['external gate',v=>v.rows.knowledge_proposal[0].gate_task_id='external'],
  ['missing proposal',v=>v.rows.knowledge_proposal.pop()],['extra file path',v=>v.files[0].path='../outside'],['duplicate file',v=>v.files.push(v.files[0])],
  ['wrong file size',v=>v.files[0].bytes++],['wrong file hash',v=>v.files[0].sha256='0'.repeat(64)],['noncanonical base64',v=>v.files[0].base64+='!'],
  ['missing file',v=>v.files=[]],['unsafe file name',v=>v.files[0].name='../outside'],['device name',v=>v.files[0].name='CON'],
  ['unregistered run',v=>v.files[0].run_id='other'],['stale live run',v=>v.rows.run[0].state='running'],
 ];
 for(const [name,mutate] of cases){const value=structuredClone(original);mutate(value);assert.throws(()=>stageProjectHandoff(f.b,encoded(value),f.ah.identity),Error,name);assert.equal(f.bh.describe(f.p).phase,'unknown',name);}
 assert.throws(()=>stageProjectHandoff(f.b,Buffer.alloc(64*1024*1024+1),f.ah.identity),/大小/);
 assert.throws(()=>stageProjectHandoff(f.b,Buffer.from([0xff]),f.ah.identity),/JSON/);
 assert.equal(stageProjectHandoff(f.b,bytes,f.ah.identity).id,f.bh.identity.id);
});

test('registered bytes are exact, historical manifests authoritative, links and unknown members never followed',async t=>{
 const f=await materialProject(t);f.ready();const path=join(registrationDir(f.a,f.run.id,f.registered.registration),f.file.name),held=readFileSync(path);
 const exported=()=>exportProjectHandoff(f.a,f.p);
 unlinkSync(path);assert.throws(exported);writeFileSync(path,held.subarray(1));assert.throws(exported,/大小或摘要/);
 writeFileSync(path,Buffer.alloc(held.length,0));assert.throws(exported,/大小或摘要/);writeFileSync(path,held);
 const extra=join(registrationDir(f.a,f.run.id,f.registered.registration),'unknown.txt');writeFileSync(extra,'USER');assert.throws(exported,/成员/);unlinkSync(extra);
 const detached=path+'.original';renameSync(path,detached);
 try{symlinkSync(detached,path);assert.throws(exported,/成员|普通路径/);unlinkSync(path);}catch(e){if((e as NodeJS.ErrnoException).code!=='EPERM')throw e;}finally{renameSync(detached,path);}
 const directory=registrationDir(f.a,f.run.id,f.registered.registration),copy=directory+'.original';renameSync(directory,copy);
 try{symlinkSync(copy,directory,'dir');assert.throws(exported,/普通路径/);unlinkSync(directory);}catch(e){if((e as NodeJS.ErrnoException).code!=='EPERM')throw e;}finally{renameSync(copy,directory);}
 if(process.platform!=='win32'){unlinkSync(path);execFileSync('mkfifo',[path]);assert.throws(exported,/普通路径/);unlinkSync(path);writeFileSync(path,held);}
 const bytes=exported(),value=wire(bytes);value.rows.change=value.rows.change.filter((row:any)=>row.action!=='run.artifacts');value.rows.run[0].artifacts_json=JSON.stringify({...JSON.parse(value.rows.run[0].artifacts_json),registered:[f.registered.registration,'missing-history']});
 assert.throws(()=>stageProjectHandoff(f.b,encoded(value),f.ah.identity),/历史登记清单/);
 assert.equal(readFileSync(path).equals(held),true);
});

test('a retained old registration and a dropped registration keep their original identity and lifetime',async t=>{
 const f=await materialProject(t);await f.acceptor.refetch(f.task.id);const latest=f.s.artifactsOfRun(f.run.id)!.registration!;assert.notEqual(latest.id,f.registered.registration);
 const originalReview=f.s.getTask(f.review.id).review_of_json;f.ready();const bytes=exportProjectHandoff(f.a,f.p);assert.equal(wire(bytes).files.length,2);
 const staged=stageProjectHandoff(f.b,bytes,f.ah.identity),claim=freezeProjectHandoff(f.a,bytes,staged.id);importProjectHandoff(f.b,bytes,claim);
 for(const id of [latest.id,f.registered.registration])assert.equal(readFileSync(join(registrationDir(f.b,f.run.id,id),f.file.name)).equals(f.binary),true);
 const target=openLedger(join(f.b,'ledger.db'),{projectHome:f.bh});try{assert.equal(target.getTask(f.review.id).review_of_json,originalReview);}finally{target.close();}
});

test('drop is preserved without resurrecting bytes, even when the old source directory remains',async t=>{
 const f=await materialProject(t);const marked=f.s.dropDueReleases(new Date('2099-01-01'));assert.ok(marked.some(row=>row.run_id===f.run.id));f.ready();
 const bytes=exportProjectHandoff(f.a,f.p);assert.equal(wire(bytes).files.length,0);const target=stageProjectHandoff(f.b,bytes,f.ah.identity);importProjectHandoff(f.b,bytes,freezeProjectHandoff(f.a,bytes,target.id));
 const ledger=openLedger(join(f.b,'ledger.db'),{projectHome:f.bh});try{assert.ok(ledger.getRun(f.run.id).releases_dropped_at);assert.equal(lstatSync(registrationDir(f.b,f.run.id,f.registered.registration),{throwIfNoEntry:false}),undefined);}finally{ledger.close();}
});

test('Console multi-input and retired/replaced history is carried as one graph without changing scopes',async t=>{
 const f=await materialProject(t,true);const p2=f.s.propose(create({title:'另一个方法',body:'另一个方法正文',project_ids:[f.p]}),OWNER_SAYS,OWNER);const other=f.s.listEntries().find(e=>e.proposal_id===p2.id)!;
 f.s.propose({inputs:[{knowledge_id:f.kid,revision:2,disposition:'revise'},{knowledge_id:other.id,revision:1,disposition:'keep',note:'相关'}],outputs:[output({revises:f.kid,title:'项目方法',body:'第三版',project_ids:[f.p]})],why:WHY,evidence:[{source:'run',ref:f.run.id,location:'formal',excerpt:'按方法@1完成的正式报告'}]},OWNER_SAYS,OWNER);
 f.s.retireEntry(other.id,{reason:'合并经验',revision:1,replacedBy:f.kid},OWNER);const history=f.s.revisionsOf(f.kid);f.ready();
 const bytes=exportProjectHandoff(f.a,f.p),target=stageProjectHandoff(f.b,bytes,f.ah.identity);importProjectHandoff(f.b,bytes,freezeProjectHandoff(f.a,bytes,target.id));
 const ledger=openLedger(join(f.b,'ledger.db'),{projectHome:f.bh});try{assert.deepEqual(ledger.revisionsOf(f.kid),history);assert.equal(ledger.getEntry(other.id)?.state,'retired');assert.equal(ledger.getEntry(other.id)?.replaced_by,f.kid);}finally{ledger.close();}
});

test('Console amendments cannot hide service-global Worker gate ancestry; related unpublished proposals also block',async t=>{
 const f=await materialProject(t);f.s.putRole({...f.s.getRole('analyse')!,permission:'read'},USER);
 const prior=f.s.propose({inputs:[],outputs:[output({title:'待把关',project_ids:[f.p]}),output({key:'out-2',title:'全局常驻规则',project_ids:null,loading:'resident'})],why:WHY,evidence:EVIDENCE},MCP,USER);
 const amended=f.s.amendProposal(prior.id,{outputs:[output({title:'主人修订',project_ids:[f.p]})]},OWNER);assert.ok(amended);
 f.ready();assert.throws(()=>exportProjectHandoff(f.a,f.p),new RegExp('把关来源.*'+prior.id));
});

for(const point of ['preparation-write','preparation-publish','registration-publish','ledger-before','ledger-after','authority-before','authority-after'] as const){
 test(`public import resumes the same receipt after failure at ${point}`,async t=>{
  const f=await materialProject(t);await f.acceptor.refetch(f.task.id);f.ready();const bytes=exportProjectHandoff(f.a,f.p),target=stageProjectHandoff(f.b,bytes,f.ah.identity),claim=freezeProjectHandoff(f.a,bytes,target.id);
  const write=fs.writeFileSync,rename=fs.renameSync,exec=DatabaseSync.prototype.exec;let injected=false,published=0;
  const hit=()=>{injected=true;throw Error('injected-'+point);};
  fs.writeFileSync=((path,...args:unknown[])=>{if(!injected&&point==='preparation-write'&&String(path).includes(f.b)&&String(path).endsWith('.bin'))hit();return (write as Function)(path,...args);}) as typeof write;
  fs.renameSync=((from,to)=>{const at=String(to);if(!injected&&at.includes(f.b)&&(point==='preparation-publish'&&at.includes('.project-handoff-')||point==='registration-publish'&&at.startsWith(join(f.b,'releases',f.run.id))&&++published===2))hit();return rename(from,to);}) as typeof rename;
  DatabaseSync.prototype.exec=function(sql:string){
   if(!injected&&sql==='COMMIT'){
    const authority=this.prepare("SELECT 1 FROM sqlite_master WHERE name='authority'").get();
    if(authority&&this.prepare("SELECT 1 FROM authority WHERE project=? AND generation=2 AND phase='owned'").get(f.p)){
     if(point==='authority-before')hit();if(point==='authority-after'){exec.call(this,sql);hit();}
    }
    if(!authority&&point==='ledger-before'&&this.prepare("SELECT 1 FROM project WHERE id=?").get(f.p))hit();
   }
   return exec.call(this,sql);
  };
  syncBuiltinESMExports();
  try{assert.throws(()=>importProjectHandoff(f.b,bytes,claim,{afterLedgerInstall:()=>{if(point==='ledger-after')hit();}}));}finally{fs.writeFileSync=write;fs.renameSync=rename;DatabaseSync.prototype.exec=exec;syncBuiltinESMExports();}
  assert.equal(injected,true);const adopted=importProjectHandoff(f.b,bytes,claim);assert.equal(adopted.service_id,f.bh.identity.id);
  assert.deepEqual(importProjectHandoff(f.b,bytes,claim),adopted);assert.equal(readFileSync(join(registrationDir(f.b,f.run.id,f.registered.registration),f.file.name)).equals(f.binary),true);
 });
}


test('a related pending proposal cannot disappear merely because it has no published revision',async t=>{
 const f=await materialProject(t);f.s.putRole({...f.s.getRole('analyse')!,permission:'read'},USER);
 const pending=f.s.propose({inputs:[],outputs:[output({title:'尚未发布的提议',project_ids:[f.p]}),output({key:'out-2',title:'全局常驻规则',project_ids:null,loading:'resident'})],why:WHY,evidence:EVIDENCE},MCP,USER);f.ready();
 assert.throws(()=>exportProjectHandoff(f.a,f.p),new RegExp('项目关联提议.*'+pending.id));
});

test('a Console publication with a rejected Worker predecessor exposes that gate dependency',async t=>{
 const f=await materialProject(t);f.s.putRole({...f.s.getRole('analyse')!,permission:'read'},USER);
 const change={inputs:[],outputs:[output({title:'重提的内容',body:'同一内容',project_ids:[f.p]}),output({key:'out-2',title:'全局常驻规则',body:'规则正文',project_ids:null,loading:'resident'})],why:WHY,evidence:EVIDENCE};
 const previous=f.s.propose(change,MCP,USER);
 const gateId=ulid(),at=new Date().toISOString();
 const db=new DatabaseSync(join(f.a,'ledger.db'));
 try{
  db.prepare(`INSERT INTO task (id, project_id, title, goal, acceptance, state, role_id, knowledge_json, revision, created_at, created_by) VALUES (?, NULL, ?, ?, ?, 'queued', 'analyse', ?, 1, ?, 'service')`).run(gateId,'把关','把关','给出 verdict',JSON.stringify({kind:'gate',proposal_id:previous.id,writers:[]}),at);
  db.prepare(`UPDATE knowledge_proposal SET state = 'gating', gate_task_id = ?, final_json = NULL, final_digest = NULL, owner_reasons_json = NULL WHERE id = ?`).run(gateId,previous.id);
 }finally{db.close();}
 const gate=f.s.getTask(gateId);
 const login=f.s.getAccount('account')!;
 const run=f.s.createRun(gate.id,{...LOGIN,login,machine:f.s.getMachine('h1')!,snapshot:{...LOGIN.snapshot,access:{permission:'read',layer:'tools',args:[]},knowledge:f.s.applicable(null,'analyse').map(e=>({id:e.id,revision:e.revision,title:e.title,loading:e.loading,scope:e.project_ids===null?'global':'project',roles:e.roles}))}},USER);
 f.s.markRunRunning(run.id);f.s.settleRun(run.id,0,{status:'done',summary:'拒绝',artifacts:[{kind:'report',ref:'最后一条消息'}],knowledge_verdict:{result:'reject',reason:'已有足够反例'}},{finalReply:'把关拒绝',codeCheck:{result:'no-code'}});
 assert.equal(f.s.getProposal(previous.id).state,'rejected');
 const pub=f.s.propose(create({title:'重提的内容',body:'同一内容',project_ids:[f.p]}),OWNER_SAYS,OWNER);
 const linkDb=new DatabaseSync(join(f.a,'ledger.db'));
 try{linkDb.prepare(`UPDATE knowledge_proposal SET prior_rejection_id = ? WHERE id = ?`).run(previous.id,pub.id);}finally{linkDb.close();}
 f.ready();
 assert.throws(()=>exportProjectHandoff(f.a,f.p),new RegExp('把关来源.*'+previous.id));
});

test('encoded JSON budget includes base64, without making the preview limit a file limit',async t=>{
 const f=await materialProject(t);const body=Buffer.alloc(49*1024*1024,0x61),file={name:'large.bin',bytes:body.length,sha256:createHash('sha256').update(body).digest('hex')};
 const acceptor=createAcceptor({ledger:f.s,dataDir:f.a,runner:{fetchArtifacts:async(_run,into)=>{mkdirSync(into,{recursive:true});writeFileSync(join(into,file.name),body);return{files:[file],problem:null};}}});
 await acceptor.refetch(f.task.id);f.ready();assert.throws(()=>exportProjectHandoff(f.a,f.p),/64 MiB/);assert.equal(f.ah.describe(f.p,{service_id:f.ah.identity.id,generation:1}).phase,'owned');
});

test('immutable source changes after stage prevent freezing; target ID and unknown path conflicts have no partial install',async t=>{
 const f=await materialProject(t);f.ready();const bytes=exportProjectHandoff(f.a,f.p);stageProjectHandoff(f.b,bytes,f.ah.identity);
 const file=join(registrationDir(f.a,f.run.id,f.registered.registration),f.file.name);writeFileSync(file,'changed');assert.throws(()=>freezeProjectHandoff(f.a,bytes,f.bh.identity.id),/摘要|大小|成员/);
 writeFileSync(file,f.binary);const claim=freezeProjectHandoff(f.a,bytes,f.bh.identity.id);
 const directory=registrationDir(f.b,f.run.id,f.registered.registration);mkdirSync(directory,{recursive:true});writeFileSync(join(directory,'owner.txt'),'KEEP');
 assert.throws(()=>importProjectHandoff(f.b,bytes,claim),/未知既有/);assert.equal(f.bh.describe(f.p).phase,'incoming');assert.equal(readFileSync(join(directory,'owner.txt'),'utf8'),'KEEP');
 const ledger=openLedger(join(f.b,'ledger.db'),{projectHome:f.bh});try{assert.equal(ledger.listProjects().some(project=>project.id===f.p),false);}finally{ledger.close();}
});
