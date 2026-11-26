// Prevent one installed prefix from replacing another installation's same-role autostart.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { runCli } from '../cli/main.ts';
import { identityOf, writeToken } from '../node/client.ts';
import { autostartFor, ownerId, launchdPlist, systemdUnit, windowsTaskXml } from '../cli/autostart.ts';
import { installedSpec } from '../cli/install.ts';
import type { ServiceSpec } from '../cli/autostart.ts';
import type { Call } from './cli-helpers.ts';
import { checkAutostart } from '../cli/doctor.ts';
import { stage, stubApp } from './cli-helpers.ts';

async function installed(t: TestContext, home?: string) {
  const s=stage(t, {platform:'linux', ...(home ? {system:{home}} : {})});
  const prefix=join(s.dir,'prefix');
  s.cli.appRoot=stubApp(join(prefix,'versions','.staging-1.0.0'),'1.0.0');
  assert.equal(await runCli(['install-self','--prefix',prefix,'--node',process.execPath],s.cli),0,s.text());
  s.cli.appRoot=join(prefix,'versions','1.0.0');
  const identity=identityOf(s.dataDir);
  writeToken(identity,'f'.repeat(64));
  writeFileSync(join(identity.dir,'client.lock'),JSON.stringify({pid:process.pid,hostname:'here'}));
  return s;
}

test('normal CLI: two installed prefixes keep independent node autostarts',async t=>{
  const office=await installed(t);
  const home=await installed(t,office.home);
  assert.equal(await runCli(['node','service','install'],office.cli),0,office.text());
  const officeSpec=installedSpec(office.cli.system,office.cli.appRoot,'node');
  const first=autostartFor(office.cli.system,'node').state(officeSpec).where!;
  const original=readFileSync(first,'utf8');
  assert.equal(await runCli(['node','service','install'],home.cli),0,home.text());
  assert.equal(readFileSync(first,'utf8'),original,'home installation must leave office definition unchanged');
  const homeSpec=installedSpec(home.cli.system,home.cli.appRoot,'node');
  const second=autostartFor(home.cli.system,'node').state(homeSpec).where!;
  assert.notEqual(first,second);
  assert.equal(autostartFor(office.cli.system,'node').state(officeSpec).current,true);
  assert.equal(autostartFor(home.cli.system,'node').state(homeSpec).current,true);
});


test('normal CLI: own upgrade, doctor and uninstall retain the suffix after the other installation leaves',async t=>{
  const office=await installed(t), home=await installed(t,office.home);
  assert.equal(await runCli(['node','service','install'],office.cli),0,office.text());
  assert.equal(await runCli(['node','service','install'],home.cli),0,home.text());
  const officeSpec=installedSpec(office.cli.system,office.cli.appRoot,'node');
  const homeSpec=installedSpec(home.cli.system,home.cli.appRoot,'node');
  const first=autostartFor(office.cli.system,'node').state(officeSpec).where!;
  const second=autostartFor(home.cli.system,'node').state(homeSpec).where!;
  const original=readFileSync(first,'utf8');
  const prefix=join(home.dir,'prefix');
  home.cli.appRoot=stubApp(join(prefix,'versions','.staging-2.0.0'),'2.0.0');
  assert.equal(await runCli(['install-self','--prefix',prefix,'--node',process.execPath],home.cli),0,home.text());
  home.cli.appRoot=join(prefix,'versions','2.0.0');
  assert.equal(readFileSync(first,'utf8'),original);
  assert.equal(autostartFor(home.cli.system,'node').state(installedSpec(home.cli.system,home.cli.appRoot,'node')).where,second);
  assert.equal(checkAutostart(home.cli.system,homeSpec,'node').level,'ok');
  assert.equal(await runCli(['node','service','uninstall'],office.cli),0,office.text());
  assert.equal(existsSync(first),false);
  home.cli.system.env.TYCHO_DATA=join(home.dir,'wrong-terminal-data');
  assert.equal(await runCli(['node','service','status'],home.cli),0,home.text());
  assert.equal(await runCli(['node','service','install'],{...home.cli,system:{...home.cli.system,env:{...home.cli.system.env,TYCHO_DATA:home.dataDir}}}),0,home.text());
  assert.equal(autostartFor(home.cli.system,'node').state(homeSpec).where,second);
  assert.equal(existsSync(first),false,'do not recreate the removed installation name');
  assert.equal(await runCli(['node','service','uninstall'],home.cli),0,home.text());
  assert.equal(existsSync(second),false);
});

for (const platform of ['linux','darwin','win32'] as const) {
  test(`${platform}: two installations and two roles keep their definitions and management isolated`,t=>{
    const tasks=new Map<string,string>();
    const respond=(c:Call)=>{
      if(c.env.TYCHO_TASK!==undefined) {const xml=tasks.get(c.env.TYCHO_TASK);return {stdout:xml?`present ${Buffer.from(xml).toString('base64')}`:'absent'};}
      if(c.args[0]==='/Create'){const xml=readFileSync(c.args[c.args.indexOf('/XML')+1]!,'utf16le').replace(/^\ufeff/,'');tasks.set(c.args[c.args.indexOf('/TN')+1]!,xml);}
      if(c.args[0]==='/Delete')tasks.delete(c.args[c.args.indexOf('/TN')+1]!);
      return undefined;
    };
    const s=stage(t,{platform,respond});
    const specs=(id:string):ServiceSpec[]=>['host','node'].map(role=>({program:[`/opt/${id}/bin/tycho`],dataDir:`/data/${id}`,logFile:`/data/${id}/log`,role:role as 'host'|'node'}));
    const office=specs('office'),home=specs('home');
    // A real older installation used the fixed names; it must not need manual migration.
    for(const spec of office){
      const name=spec.role==='node'?'tycho-node':'tycho';
      if(platform==='win32')tasks.set(name,windowsTaskXml({user:'PC\\owner',powershell:'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',spec,conhost:null}));
      else {const file=platform==='linux'?join(s.home,'.config/systemd/user',name+'.service'):join(s.home,'Library/LaunchAgents',name+'.plist');mkdirSync(join(file,'..'),{recursive:true});writeFileSync(file,platform==='linux'?systemdUnit(spec):launchdPlist(spec));}
    }
    for(const spec of [...office,...home])autostartFor(s.cli.system,spec.role).install(spec,{start:false});
    const places=[...office,...home].map(spec=>autostartFor(s.cli.system,spec.role).state(spec).where!);
    assert.equal(new Set(places).size,4);
    for(const spec of home){
      const auto=autostartFor(s.cli.system,spec.role);
      const where=auto.state(spec).where;
      auto.state(office[0]!); // A query must not alter the following operation's target.
      const before=s.calls.length;
      auto.start(spec);auto.stop(spec);
      const mutations=s.calls.slice(before).filter(c=>c.args.some(a=>['start','stop','reset-failed','bootout','bootstrap','/Run','/End'].includes(a)));
      assert.ok(mutations.length>0);
      for(const c of mutations)assert.ok(c.args.some(a=>a.includes(ownerId(spec))),JSON.stringify(c.args));
      assert.equal(auto.state(spec).where,where);
      auto.uninstall(spec);
    }
    for(const spec of office)assert.equal(autostartFor(s.cli.system,spec.role).state(spec).current,true);
  });
}

test('Linux: unknown files and duplicate own names report uncertainty without mutation',t=>{
 const s=stage(t,{platform:'linux'}), spec:ServiceSpec={program:['/opt/one/bin/tycho'],dataDir:'/data/one',logFile:'/data/log'};
 const auto=autostartFor(s.cli.system),legacy=join(s.home,`.config/systemd/user/tycho-${ownerId(spec)}.service`);
 mkdirSync(legacy,{recursive:true});
 assert.throws(()=>auto.install(spec,{start:false}),/查不了/);
 assert.equal(s.calls.length,0);
 rmSync(legacy,{recursive:true});
 auto.install(spec,{start:false});
 const alternate=join(s.home,'.config/systemd/user/tycho.service');
 writeFileSync(alternate,readFileSync(legacy));
 s.calls.length=0;
 for(const act of [()=>auto.state(spec),()=>auto.install(spec,{start:false}),()=>auto.start(spec),()=>auto.stop(spec),()=>auto.uninstall(spec)])assert.throws(act,/两个开机自启/);
 assert.equal(s.calls.some(c=>c.args.some(a=>['start','stop','disable','enable','daemon-reload'].includes(a))),false);
 assert.equal(existsSync(legacy)&&existsSync(alternate),true);
});


test('Linux: foreign definitions in both candidate names are never overwritten or stopped',t=>{
 const s=stage(t,{platform:'linux'}), spec:ServiceSpec={program:['/opt/ours/bin/tycho'],dataDir:'/data/ours',logFile:'/data/log'};
 const auto=autostartFor(s.cli.system),dir=join(s.home,'.config/systemd/user');
 mkdirSync(dir,{recursive:true});
 const files=['tycho.service',`tycho-${ownerId(spec)}.service`].map(n=>join(dir,n));
 for(const f of files)writeFileSync(f,'foreign user definition\n');
 for(const action of [()=>auto.install(spec,{start:false}),()=>auto.start(spec),()=>auto.stop(spec),()=>auto.uninstall(spec)])assert.throws(action,/属于其他/);
 for(const f of files)assert.equal(readFileSync(f,'utf8'),'foreign user definition\n');
 assert.equal(s.calls.some(c=>c.args.some(a=>['start','stop','disable','enable','daemon-reload'].includes(a))),false);
});


test('Linux: a missing or unreadable shared legacy name is never allocated to a fresh installation',t=>{
 const s=stage(t,{platform:'linux'}),spec:ServiceSpec={program:['/opt/new/bin/tycho'],dataDir:'/data/new',logFile:'/data/log'};
 const shared=join(s.home,'.config/systemd/user/tycho.service');
 mkdirSync(shared,{recursive:true});
 const auto=autostartFor(s.cli.system);
 auto.install(spec,{start:false});
 const owned=auto.state(spec).where!;
 assert.ok(owned.endsWith(`tycho-${ownerId(spec)}.service`));
 assert.equal(existsSync(shared),true);
 rmSync(shared,{recursive:true});
 auto.install(spec,{start:false});
 assert.equal(auto.state(spec).where,owned);
 assert.equal(existsSync(shared),false);
 auto.uninstall(spec);
 assert.equal(existsSync(shared),false);
});


test('Linux: a foreign suffix blocks management even with an owned legacy definition', t => {
  const s = stage(t, { platform: 'linux' });
  const spec: ServiceSpec = { program: ['/opt/one/bin/tycho'], dataDir: '/data/one', logFile: '/data/log' };
  const dir = join(s.home, '.config/systemd/user');
  mkdirSync(dir, { recursive: true });
  const legacy = join(dir, 'tycho.service');
  const suffix = join(dir, `tycho-${ownerId(spec)}.service`);
  writeFileSync(legacy, systemdUnit(spec));
  writeFileSync(suffix, 'foreign definition\n');
  const auto = autostartFor(s.cli.system);
  for (const action of [() => auto.state(spec), () => auto.install(spec, { start: false }), () => auto.start(spec), () => auto.stop(spec), () => auto.uninstall(spec)]) assert.throws(action, /属于其他/);
  assert.equal(readFileSync(legacy, 'utf8'), systemdUnit(spec));
  assert.equal(readFileSync(suffix, 'utf8'), 'foreign definition\n');
  assert.equal(s.calls.some(c => c.args.some(a => ['start', 'stop', 'disable', 'enable', 'daemon-reload'].includes(a))), false);
});
