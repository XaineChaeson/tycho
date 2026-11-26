// Guards first-message delivery, turn identity, and access to the scoped Tycho MCP.
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { once } from 'node:events';

const env = { ...process.env, CODEX_HOME: '' };

const fake = `
const rl = require('node:readline').createInterface({input:process.stdin});
const send = x => process.stdout.write(JSON.stringify(x)+'\\n');
rl.on('line', line => { const m=JSON.parse(line); if(!m.id)return;
let result={};
if(m.method==='initialize' && (process.argv[2]!=='app-server' || m.params.capabilities?.experimentalApi!==true)) process.exit(4);
if(m.method==='account/login/start') { if (m.params.type!=='apiKey' || m.params.apiKey!=='managed-test-key' || process.env.CODEX_API_KEY || process.env.UNRELATED_SECRET || !process.env.CODEX_HOME || !process.argv.includes('cli_auth_credentials_store=\"ephemeral\"') || !process.argv.includes('model_provider=\"openai\"')) process.exit(6); }
if(m.method==='config/read') result={config:{mcp_servers:JSON.parse('{"other":{"command":"x","tool_timeout_sec":null},"__proto__":{"url":"https://example.invalid"}}')}};
if(m.method==='thread/start'||m.method==='thread/resume') { if(m.params.config.shell_environment_policy.inherit!=='core' || JSON.stringify(m.params.config.shell_environment_policy.exclude)!==JSON.stringify(['CODEX_API_KEY','OPENAI_API_KEY','ANTHROPIC_API_KEY','CLAUDE_CODE_OAUTH_TOKEN']) || (process.env.CODEX_HOME && m.params.config.model_provider!=='openai') || m.params.config.mcp_servers.tycho.required!==true || m.params.config.mcp_servers.tycho.default_tools_approval_mode!=='approve' || m.params.sandbox!=='danger-full-access') process.exit(3); result={thread:{id:'t'},approvalPolicy:'never',sandbox:{type:'dangerFullAccess'},model:'test'}; }
if(m.method==='mcpServerStatus/list') result={data:[{name:'tycho',runtimeStatus:'connected',tools:{hello:{}},toolsError:null},{name:'other',runtimeStatus:'disabled',tools:{}},{name:'__proto__',runtimeStatus:'disabled',tools:{}}],nextCursor:null};
if(m.method==='turn/start') { if(m.params.input[0].text!=='question') process.exit(5); result={turn:{id:'a'}}; send({method:'turn/started',params:{threadId:'t',turn:{id:'old'}}}); send({method:'item/agentMessage/delta',params:{threadId:'t',turnId:'old',delta:'wrong'}}); send({id:m.id,result}); send({method:'item/agentMessage/delta',params:{threadId:'t',turnId:'a',delta:'hi'}}); send({method:'item/started',params:{threadId:'t',turnId:'a',item:{type:'mcpToolCall',id:'i',server:'tycho',tool:'hello',arguments:{}}}}); return; }
if(m.method==='turn/interrupt') { send({id:m.id,result:{}}); send({method:'item/completed',params:{threadId:'t',turnId:'a',item:{type:'mcpToolCall',id:'i',result:{}}}}); send({method:'item/completed',params:{threadId:'t',turnId:'a',item:{type:'agentMessage',text:'done'}}}); send({method:'turn/completed',params:{threadId:'t',turn:{id:'a',status:'completed'}}}); return; }
send({id:m.id,result}); });`;

test('bridge verifies and translates a resumed turn and interrupt', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'router-codex-'));
  try {
    const server = join(dir, 'server.cjs'); const config = join(dir, 'config.json');
    writeFileSync(server, fake);
    writeFileSync(config, JSON.stringify({ argv: [process.execPath, server], prompt: 'instructions', resume: 't', tools: ['hello'], mcp: { command: 'proxy', args: [], env: {} } }));
    const child = spawn(process.execPath, ['service/router-codex.ts', '--marker', 'm', '--config', config], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
    const read = async () => JSON.parse((await lines.next()).value!);
    child.stdin.write(JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: 'question' }] } }) + '\n');
    assert.equal((await read()).session_id, 't');
    assert.equal((await read()).event.delta.text, 'hi');
    assert.equal((await read()).message.content[0].name, 'mcp__tycho__hello');
    child.stdin.write(JSON.stringify({ type: 'control_request', request_id: 'r', request: { subtype: 'interrupt' } }) + '\n');
    const received = [await read(), await read(), await read()];
    assert(received.some(x => x.type === 'control_response' && x.response.subtype === 'success'));
    assert(received.some(x => x.type === 'user' && x.message.content[0].tool_use_id === 'i'));
    assert(received.some(x => x.type === 'result' && x.result === 'done'));
    child.stdin.end(); await once(child, 'close');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});


test('managed login uses ephemeral RPC credentials and strips child secrets', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'router-managed-'));
  try {
    const server = join(dir, 'server.cjs'); const config = join(dir, 'config.json');
    writeFileSync(server, fake);
    writeFileSync(config, JSON.stringify({ argv: [process.execPath, server], prompt: '', tools: ['hello'], mcp: { command: 'proxy', args: [], env: {} }, managedHome: join(dir, 'home') }));
    const child = spawn(process.execPath, ['service/router-codex.ts', '--marker', 'm', '--config', config], { env: { ...process.env, CODEX_API_KEY: 'managed-test-key', UNRELATED_SECRET: 'host-secret', CODEX_HOME: '' }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });
    const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
    const init = await lines.next();
    assert.equal(JSON.parse(init.value!).subtype, 'init');
    child.stdin.end(); await once(child, 'close');
    assert(!stderr.includes('managed-test-key'));
    assert(!stderr.includes('host-secret'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});


test('RPC errors report method and code without server text', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'router-error-'));
  try {
    const server = join(dir, 'server.cjs'); const config = join(dir, 'config.json');
    writeFileSync(server, `require('node:readline').createInterface({input:process.stdin}).on('line', line => { const m=JSON.parse(line); if(m.id) process.stdout.write(JSON.stringify({id:m.id,error:{code:-32602,message:'secret from server'}})+'\\n'); });`);
    writeFileSync(config, JSON.stringify({ argv: [process.execPath, server], prompt: '', tools: [], mcp: { command: 'proxy', args: [], env: {} } }));
    const child = spawn(process.execPath, ['service/router-codex.ts', '--marker', 'm', '--config', config], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });
    const [code] = await once(child, 'close');
    assert.equal(code, 1);
    assert.match(stderr, /app-server request rejected: initialize \(-32602\)/);
    assert(!stderr.includes('secret from server'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('bridge refuses mismatched resumed threadId or missing thread id', async () => {
  for (const returnedId of ['wrong-thread', '']) {
    const dir = mkdtempSync(join(tmpdir(), 'router-thread-'));
    try {
      const server = join(dir, 'server.cjs'); const config = join(dir, 'config.json');
      writeFileSync(server, fake.replace("result={thread:{id:'t'},approvalPolicy:'never',sandbox:{type:'dangerFullAccess'},model:'test'}", `result={thread:{id:${JSON.stringify(returnedId)}},approvalPolicy:'never',sandbox:{type:'dangerFullAccess'},model:'test'}`));
      writeFileSync(config, JSON.stringify({ argv: [process.execPath, server], prompt: '', resume: 't', tools: ['hello'], mcp: { command: 'proxy', args: [], env: {} } }));
      const child = spawn(process.execPath, ['service/router-codex.ts', '--marker', 'm', '--config', config], { env, stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '', stderr = ''; child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
      const [code] = await once(child, 'close');
      assert.equal(code, 1); assert.equal(stdout, ''); assert.match(stderr, /thread policy verification failed/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});
