// Guards against: a brief missing a required section, a snapshot that promises a
// tier the account lacks, a skill the Task names left out of a brief that says to follow it, bound
// inputs not reaching the Worker's files, changed account configuration inventing a
// history's executor, a round that carries a code source not saying where it comes from, and a
// receipt format that leaves out the field a round reports destroyed machines in, and a receipt
// example that is not JSON. And the operate tier's substitute (roles-and-tiers.md §10.3): an
// operate round sent the execute content while saying so in its snapshot, a login with its own
// operate content sent that instead, and a decide round on a login without decide content refused.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { claudeAdapter } from '../adapters/claude.ts';
import { codexAdapter } from '../adapters/codex.ts';
import { InputError } from '../service/errors.ts';
import { snapshotSourceOf } from '../shared/sources.ts';
import { prepareSnapshot, roundTurn, writeSnapshot } from '../runner/snapshot.ts';
import type { Snapshot, Account } from '../runner/snapshot.ts';
import { ARTIFACTS_PLACEHOLDER, MATERIALS_PLACEHOLDER } from '../shared/node-protocol.ts';
import { DEFAULT_KNOWLEDGE_LIMITS } from '../service/knowledge.ts';
import { claudeTier, codexTier, DONE, fixture, RUN_LIMIT_MS, USER } from './helpers.ts';

// What a Run's value is checked against: the executor that will run it.
const EXECUTORS = { claude: claudeAdapter };

const LOGIN: Account = {
  id: 't1', name: 't1',
  executor: 'claude',
  tiers: { execute: claudeTier('/tiers/execute.json') },
};

test('the snapshot retains which executor was dispatched when the account configuration changes', (t) => {
  const f = fixture(t);
  const task = f.ledger.createTask({ projectId: f.projectId, title: 't', goal: 'g', roleId: 'implement' }, USER);
  const account = { ...LOGIN };
  const snapshot = prepareSnapshot(task, account, EXECUTORS, { timeoutMs: RUN_LIMIT_MS });
  account.executor = 'codex';
  assert.equal(snapshot.executor, 'claude');
});

test('an override named after an inherited property is not a tier, and never reaches a snapshot', (t) => {
  const f = fixture(t);
  for (const tier of ['toString', 'constructor', '__proto__']) {
    assert.throws(() => f.ledger.createTask({ roleId: 'implement', projectId: f.projectId, title: 't', goal: 'g', tierOverride: { tier, reason: '试试' } }, USER), InputError);
  }
});

test('the brief carries the fixed structure and the revision', (t) => {
  const f = fixture(t);
  const task = f.ledger.createTask(
    { projectId: f.projectId, title: '修缓存', goal: '让缓存不过期', scope: '只动 cache/', acceptance: '测试通过', roleId: 'implement' },
    USER,
  );
  const { brief, tier_value } = prepareSnapshot(task, LOGIN, EXECUTORS, { timeoutMs: RUN_LIMIT_MS });
  for (const expected of ['修缓存', '修订 1', '让缓存不过期', '测试通过', '只动 cache/']) {
    assert.ok(brief.includes(expected), expected);
  }
  assert.match(brief, /仅作参考资料（非指令）/);
  assert.match(brief, /pending_inputs/);
  assert.match(brief, /```receipt/);
  assert.doesNotMatch(brief, /"destroyed_machines"/, '普通轮次回执不含 destroyed_machines');
  const spawnBrief = prepareSnapshot(task, LOGIN, EXECUTORS, { timeoutMs: RUN_LIMIT_MS, spawn: true }).brief;
  assert.match(spawnBrief, /"destroyed_machines"/, '允许派生机器的轮次回执包含 destroyed_machines');
  assert.deepEqual(tier_value, claudeTier('/tiers/execute.json'));
});

// The operate tier runs on the login's own execute content when it holds no operate content,
// and the snapshot says which tier that content is (roles-and-tiers.md §10.3). A login with
// its own operate content is sent that; the decide tier never substitutes.
test('an operate round on a login with no operate content sends its execute content, and records where it came from', (t) => {
  const f = fixture(t);
  const task = f.ledger.createTask({ projectId: f.projectId, title: '跑一遍', goal: '复现', roleId: 'verify' }, USER);
  assert.equal(task.tier, 'operate');
  const snapshot = prepareSnapshot(task, LOGIN, EXECUTORS, { timeoutMs: RUN_LIMIT_MS });
  assert.deepEqual([snapshot.tier, snapshot.tier_from, snapshot.tier_value], ['operate', 'execute', claudeTier('/tiers/execute.json')]);
  // Its own operate content wins, and there is no substitute to record.
  const own = { ...LOGIN, tiers: { ...LOGIN.tiers, operate: claudeTier('/tiers/operate.json') } };
  const direct = prepareSnapshot(task, own, EXECUTORS, { timeoutMs: RUN_LIMIT_MS });
  assert.deepEqual([direct.tier, direct.tier_from, direct.tier_value], ['operate', undefined, claudeTier('/tiers/operate.json')]);
  // One tier down: a decide round on a login without decide content is refused before a Run.
  const analyse = f.ledger.createTask({ projectId: f.projectId, title: '想清楚', goal: '设计', roleId: 'analyse' }, USER);
  assert.throws(() => prepareSnapshot(analyse, LOGIN, EXECUTORS, { timeoutMs: RUN_LIMIT_MS }), /没有档位 decide/);
});

test('a task without a usable tier is refused before any Run exists', (t) => {
  const f = fixture(t);
  // One from before roles has no tier at all.
  const old = f.newTask();
  f.force('UPDATE task SET role_id = NULL WHERE id = ?', old.id);
  assert.throws(() => prepareSnapshot(f.task(old.id), LOGIN, EXECUTORS, { timeoutMs: RUN_LIMIT_MS }), /没有职能/);
  const task = f.ledger.createTask(
    { projectId: f.projectId, title: 't', goal: 'g', acceptance: 'a', roleId: 'analyse' },
    USER,
  );
  assert.throws(() => prepareSnapshot(task, LOGIN, EXECUTORS, { timeoutMs: RUN_LIMIT_MS }), InputError);
});

test('a skill the Task names that is not among the round\'s entries is skipped with a note in the brief', (t) => {
  const f = fixture(t);
  const task = f.ledger.createTask({ projectId: f.projectId, title: 't', goal: 'g', roleId: 'implement' }, USER);
  const snapshot = prepareSnapshot(task, LOGIN, EXECUTORS, {
    timeoutMs: RUN_LIMIT_MS,
    knowledge: { entries: [], projectName: '试跑', limits: DEFAULT_KNOWLEDGE_LIMITS, named: ['gone'] },
  });
  assert.match(snapshot.brief, /任务原指定的技能 `gone` 已退役或当前不适用，已跳过/);
});

test('files split pending inputs from history, and a round from before skills were entries still gets its skill files', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'tycho-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const snapshot: Snapshot = {
    brief: '简报',
    timeout_ms: RUN_LIMIT_MS,
    history: [{ text: '旧' }],
    skills: [{ name: 'deploy', content: '步骤' }],
    tier: 'execute',
    tier_value: claudeTier('/t'),
    inputs: [{ id: 'i1', text: '插话' }],
  };
  writeSnapshot(snapshot, dir);
  assert.equal(readFileSync(join(dir, 'brief.md'), 'utf8'), '简报');
  assert.equal(readFileSync(join(dir, 'skills', 'deploy.md'), 'utf8'), '步骤');
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'context.json'), 'utf8')), {
    pending_inputs: [{ id: 'i1', text: '插话' }],
    history: [{ text: '旧' }],
  });
});

// What the machine prepares the working directory from: one file naming the source, and none
// at all for a round whose project names none. The brief says where the code is.
test('a snapshot with a source writes where the code comes from, and one without writes none', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'tycho-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const base = { brief: '简报', history: [], skills: [], tier: 'execute', tier_value: claudeTier('/t'), timeout_ms: RUN_LIMIT_MS } satisfies Snapshot;
  writeSnapshot({ ...base, source: { kind: 'repo', url: 'https://example.test/owner/project.git', binding_key: 's-one-1a2b3c4d', commit: 'a'.repeat(40) } }, dir);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'source.json'), 'utf8')), {
    kind: 'repo', url: 'https://example.test/owner/project.git', binding_key: 's-one-1a2b3c4d', commit: 'a'.repeat(40),
  });
  // A second snapshot in the same directory as the first: without a source, it writes none.
  const other = join(dir, 'other');
  writeSnapshot(base, other);
  assert.deepEqual(readdirSync(other).sort(), ['brief.md', 'context.json']);
});

test('the brief says where the code is for each kind of source, and that there is none', (t) => {
  const f = fixture(t);
  const task = f.ledger.createTask({ projectId: f.projectId, title: 't', goal: 'g', roleId: 'implement' }, USER);
  const repo = prepareSnapshot(task, LOGIN, EXECUTORS, { timeoutMs: RUN_LIMIT_MS, source: { kind: 'repo', url: 'https://example.test/a.git', binding_key: 's-one-1a2b3c4d' } }).brief;
  assert.match(repo, /当前工作目录为 `https:\/\/example\.test\/a\.git` 的任务仓库副本/);
  const folder = prepareSnapshot(task, LOGIN, EXECUTORS, { timeoutMs: RUN_LIMIT_MS, source: { kind: 'folder', path: '/srv/project', binding_key: 's-two-5e6f7a8b' } }).brief;
  assert.match(folder, /当前工作目录为本机目录 `\/srv\/project`（非 tycho 管理）/);
  const none = prepareSnapshot(task, LOGIN, EXECUTORS, { timeoutMs: RUN_LIMIT_MS }).brief;
  assert.match(none, /当前工作目录为空任务目录/);
});

// The receipt example every brief carries is what an executor copies: it has to be JSON, in a
// plain round's brief, a review's and a knowledge gate's alike.
test('the receipt example in every kind of brief parses as JSON', (t) => {
  const f = fixture(t);
  const task = f.ledger.createTask({ projectId: f.projectId, title: 't', goal: 'g', roleId: 'implement' }, USER);
  const plain = prepareSnapshot(task, LOGIN, EXECUTORS, { timeoutMs: RUN_LIMIT_MS }).brief;
  const gate = prepareSnapshot(task, LOGIN, EXECUTORS, { timeoutMs: RUN_LIMIT_MS, knowledgeTask: { kind: 'gate', files: [], listing: '- 材料' } }).brief;
  for (const brief of [plain, gate]) {
    const example = /```receipt\n([\s\S]*?)\n```/.exec(brief)?.[1];
    assert.ok(example, '有回执示例');
    const parsed = JSON.parse(example!) as Record<string, unknown>;
    assert.equal(parsed.status, 'done', '回执示例为合法可复制的最小 done 样例');
    assert.equal('ask' in parsed, false, '最小回执示例不同时塞入互斥字段 ask');
    assert.equal('later' in parsed, false, '最小回执示例不同时塞入互斥字段 later');
  }
});


for(const executor of ['claude','codex'] as const) for(const source of [undefined,{kind:'folder' as const,path:'/srv/readonly-analysis',binding_key:'source-folder'},{kind:'repo' as const,url:'https://example.test/readonly-analysis.git',binding_key:'source-repo'}]) {
  test(`read-only ${executor} ${source?.kind??'no-source'} brief allows final message or artifacts/ and states the actual code-check boundary`,t=>{
    const f=fixture(t);
    const task=f.ledger.createTask({projectId:f.projectId,title:'只读分析',goal:'只核对环境',roleId:'analyse'},USER);
    const login={...LOGIN,executor,tiers:{decide:executor==='claude'?claudeTier('/tiers/decide.json'):codexTier('/tiers/decide.toml')}};
    const snapshot=prepareSnapshot(task,login,{claude:claudeAdapter,codex:codexAdapter},{timeoutMs:RUN_LIMIT_MS,permission:'read',role:f.ledger.getRole('analyse')!,...(source?{source}:{})});
    assert.equal(snapshot.access?.permission,'read');
    assert.match(snapshot.brief,/交付报告可写在最后回复（`ref` 填 `最后一条消息`）或放入 `\.\.\/artifacts\/`/);
    assert.match(snapshot.brief,/最后一条消息/);
    assert.doesNotMatch(snapshot.brief,/如有提交、分支或 PR|一个发布包|按这个顺序做：|git fetch origin/);
    if(source===undefined){
      assert.match(snapshot.brief,/当前工作目录为空任务目录/);
      assert.doesNotMatch(snapshot.brief,/请勿改动代码仓库|请勿改动工作目录/);
    } else if(source.kind==='folder'){
      assert.match(snapshot.brief,/`\/srv\/readonly-analysis`/);
      assert.match(snapshot.brief,/请勿改动工作目录，结束后会记录目录状态/);
      assert.doesNotMatch(snapshot.brief,/请勿改动代码仓库，结束后会核对代码基线/);
    } else {
      assert.match(snapshot.brief,/https:\/\/example\.test\/readonly-analysis\.git/);
      assert.match(snapshot.brief,/请勿改动代码仓库，结束后会核对代码基线/);
    }
  });
}


test('a folder code review describes external directory changes as observations throughout its full brief',t=>{
  const f=fixture(t),{run,task}=f.runningRun();
  f.ledger.settleRun(run.id,0,DONE);
  const registration=f.ledger.registerArtifacts(run.id,[]);
  const review=f.ledger.createTask({projectId:f.projectId,title:'审代码',goal:'核对提交',roleId:'review',reviewOf:{taskId:task.id,runId:run.id,revision:task.revision,registration,reviewed:{source_kind:'folder',commit:'c0ffee',path:'/srv/shared-code'}}},USER);
  const snapshot=prepareSnapshot(review,LOGIN,EXECUTORS,{timeoutMs:RUN_LIMIT_MS,permission:'read',source:{kind:'folder',path:'/srv/shared-code',binding_key:'folder-source'}});
  assert.match(snapshot.brief,/c0ffee/);assert.match(snapshot.brief,/`\/srv\/shared-code`/);
  assert.match(snapshot.brief,/请勿改动工作目录，结束后会记录目录状态/);
  assert.doesNotMatch(snapshot.brief,/请勿改动代码仓库，结束后会核对代码基线|一个发布包/);
});


for(const executor of ['claude','codex'] as const) for(const sourceKind of ['none','folder','repo'] as const) {
  test(`missing check record settles ${executor}/${sourceKind} without discarding receipt and recheck brief follows the current source`,t=>{
    const f=fixture(t);
    f.ledger.putRole({...f.ledger.getRole('analyse')!,default_tier:'execute'},USER);
    if(sourceKind!=='none') f.ledger.setProjectSources(f.projectId,[sourceKind==='repo'
      ? {kind:'repo',url:'https://example.test/recheck.git'}
      : {kind:'folder',path:'/srv/recheck-folder',machine_uid:f.ledger.getMachine('h1')!.uid}],USER);
    const task=f.ledger.createTask({projectId:f.projectId,title:'核对环境',goal:'只读检查',acceptance:'报告命令结果',roleId:'analyse'},USER);
    f.ledger.queueTask(task.id,USER);
    const login={id:`recheck-${executor}`,name:`recheck-${executor}`,executor,tiers:{execute:executor==='claude'?claudeTier('/tiers/check.json'):codexTier('/tiers/check.toml')}};
    f.ledger.putAccount(login,USER,'fixture-credential-reference');
    const pinned=f.ledger.taskSource(task.id)?.pinned;
    const source=pinned?snapshotSourceOf(pinned):undefined;
    const options={timeoutMs:RUN_LIMIT_MS,permission:'read' as const,role:f.ledger.getRole('analyse')!,...(source?{source}:{})};
    const snapshot=prepareSnapshot(f.ledger.getTask(task.id),login,{claude:claudeAdapter,codex:codexAdapter},options);
    const run=f.ledger.createRun(task.id,{login,machine:f.ledger.getMachine('h1')!,snapshot,expectedRevision:task.revision},USER);
    f.ledger.markRunRunning(run.id);
    f.ledger.settleRun(run.id,0,{status:'done',summary:'命令正常',artifacts:[{kind:'report',ref:'最后一条消息'}]});
    assert.equal(f.ledger.getTask(task.id).state,'ready','missing codeCheck is advisory and never discards receipts');
    const retry=prepareSnapshot(f.ledger.getTask(task.id),login,{claude:claudeAdapter,codex:codexAdapter},{...options,checkSite:'recheck'});
    assert.match(retry.brief,/## 现场提示\n\n上一轮代码基线核对未通过，本轮为重新派发的新会话/);
    assert.doesNotMatch(retry.brief,/核对发现代码目录被改了/);
    if(sourceKind==='repo') assert.match(retry.brief,/请勿改动代码仓库，结束后会核对代码基线/);
    else {
      assert.doesNotMatch(retry.brief,/请勿改动代码仓库，结束后会核对代码基线/);
      if(sourceKind==='none') assert.doesNotMatch(retry.brief,/请勿改动工作目录|请勿改动代码仓库/);
      else assert.match(retry.brief,/请勿改动工作目录，结束后会记录目录状态/);
    }
  });
}

for(const checkSite of ['auth','lost','quota'] as const) {
  test(`a no-source ${checkSite} continuation preserves the event and unconfirmed inputs without prescribing Git work`,t=>{
    const f=fixture(t),task=f.newTask();
    const brief=prepareSnapshot(task,LOGIN,EXECUTORS,{timeoutMs:RUN_LIMIT_MS,permission:'read',checkSite}).brief;
    assert.match(brief,/## 现场提示/);
    assert.match(brief,/unconfirmed_inputs/);
    assert.match(brief,/请先核对现场/);
    assert.doesNotMatch(brief,/先看工作目录、分支|分支和已推送的提交|按已推送的内容接着做/);
    assert.match(brief,checkSite==='auth'?/登录令牌失效/:checkSite==='lost'?/机器失联或进程中断/:/执行器额度用尽/);
  });
}

test('roundTurn emits single-line brief/followup prompts and snapshotFiles writes followup.md on resumed inputs', (t) => {
  const f = fixture(t);
  const task = f.ledger.createTask({ projectId: f.projectId, title: 't', goal: 'g', roleId: 'implement' }, USER);

  // Cold start: single-line prompt naming BOTH brief.md and artifacts dir
  const cold = prepareSnapshot(task, LOGIN, EXECUTORS, { timeoutMs: RUN_LIMIT_MS });
  assert.equal(cold.resumed_definition_changed, undefined);
  const coldPrompt = roundTurn(cold, 'r1').prompt;
  assert.equal(
    coldPrompt,
    `请先读 ${MATERIALS_PLACEHOLDER}/brief.md，按其中要求完成任务，并在最后一条消息末尾写回执（如需回传文件放 ${ARTIFACTS_PLACEHOLDER}/）。`,
  );
  assert.equal(/[\r\n]/.test(coldPrompt), false);

  // Resumed round with multi-line pending inputs: single-line prompt pointing to followup.md
  const resumed = prepareSnapshot(task, LOGIN, EXECUTORS, { timeoutMs: RUN_LIMIT_MS, sessionRef: 'sess-1' });
  const resumedSnap: Snapshot = {
    ...resumed,
    inputs: [
      { id: 'i1', text: '把按钮改成蓝色\n并加 hover 效果' },
      { id: 'i2', text: '   ' },
      { id: 'i3', text: '顺便补一个单测' },
    ],
  };
  const deltaPrompt = roundTurn(resumedSnap, 'r2').prompt;
  assert.equal(
    deltaPrompt,
    `请读 ${MATERIALS_PLACEHOLDER}/followup.md 中的后续指令继续当前任务，完成后在最后一条消息末尾附 \`\`\`receipt\`\`\` 回执（如需回传文件放 ${ARTIFACTS_PLACEHOLDER}/；完整任务背景见 ${MATERIALS_PLACEHOLDER}/brief.md）。`,
  );
  assert.equal(/[\r\n]/.test(deltaPrompt), false, 'CLI prompt must never embed newlines');
  assert.doesNotMatch(deltaPrompt, /把按钮改成蓝色/);

  const dir = mkdtempSync(join(tmpdir(), 'tycho-followup-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeSnapshot(resumedSnap, dir);
  const followup = readFileSync(join(dir, 'followup.md'), 'utf8');
  assert.match(followup, /把按钮改成蓝色\n并加 hover 效果/);
  assert.match(followup, /---/);
  assert.match(followup, /顺便补一个单测/);

  // Resumed round with pending inputs AND project_files: mentions project-files/ in both prompt & followup.md
  const withFilesSnap: Snapshot = {
    ...resumed,
    inputs: [{ id: 'i1', text: '参考新附件\n第二行' }],
    project_files: [{ id: 'f1', name: 'spec.md', mime: 'text/markdown', path: 'project-files/spec.md', text: 'hi' }],
  };
  const deltaWithFiles = roundTurn(withFilesSnap, 'r3').prompt;
  assert.equal(
    deltaWithFiles,
    `请读 ${MATERIALS_PLACEHOLDER}/followup.md 中的后续指令继续当前任务（新增附带文件位于 ${MATERIALS_PLACEHOLDER}/project-files/），完成后在最后一条消息末尾附 \`\`\`receipt\`\`\` 回执（如需回传文件放 ${ARTIFACTS_PLACEHOLDER}/；完整任务背景见 ${MATERIALS_PLACEHOLDER}/brief.md）。`,
  );
  assert.equal(/[\r\n]/.test(deltaWithFiles), false);
  const dir2 = mkdtempSync(join(tmpdir(), 'tycho-followup-files-'));
  t.after(() => rmSync(dir2, { recursive: true, force: true }));
  writeSnapshot(withFilesSnap, dir2);
  const followup2 = readFileSync(join(dir2, 'followup.md'), 'utf8');
  assert.match(followup2, /参考新附件\n第二行/);
  assert.match(followup2, /project-files\/spec\.md/);

  // Resumed round with updated task definition: single-line prompt referencing brief.md + followup.md
  const changed = prepareSnapshot(task, LOGIN, EXECUTORS, {
    timeoutMs: RUN_LIMIT_MS,
    sessionRef: 'sess-1',
    resumedDefinitionChanged: true,
  });
  assert.equal(changed.resumed_definition_changed, true);
  const changedPrompt = roundTurn({ ...changed, inputs: [{ id: 'i1', text: '按新验收标准执行\n细则如下' }] }, 'r4').prompt;
  assert.equal(
    changedPrompt,
    `任务定义已更新，请结合 ${MATERIALS_PLACEHOLDER}/brief.md 与 ${MATERIALS_PLACEHOLDER}/followup.md 中的新指令继续完成，末尾附 \`\`\`receipt\`\`\` 回执（如需回传文件放 ${ARTIFACTS_PLACEHOLDER}/）。`,
  );
  assert.equal(/[\r\n]/.test(changedPrompt), false);

  // Resumed round without new inputs (e.g. resume_task / timer wake): no followup.md written
  const noInputsSnap: Snapshot = { ...resumed, inputs: [] };
  assert.equal(
    roundTurn(noInputsSnap, 'r5').prompt,
    `请结合 ${MATERIALS_PLACEHOLDER}/brief.md 与 ${MATERIALS_PLACEHOLDER}/context.json 继续完成任务，末尾附 \`\`\`receipt\`\`\` 回执（如需回传文件放 ${ARTIFACTS_PLACEHOLDER}/）。`,
  );
  const dir3 = mkdtempSync(join(tmpdir(), 'tycho-no-followup-'));
  t.after(() => rmSync(dir3, { recursive: true, force: true }));
  writeSnapshot(noInputsSnap, dir3);
  assert.equal(readdirSync(dir3).includes('followup.md'), false);
});
