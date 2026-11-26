// Guards the console's own words for the machines that come back by themselves: a machine
// that is away reading as broken or as one that was never heard from, a source left blank
// or one a task derived reading as manual, an expiry counted wrong or past its time read as
// still valid, a decision that does not name the machine it was about (or says nothing
// about where a machine let in will show up), and the list a decision is put on. And what
// such a machine read of its own executors, one row per executor: a machine that has not
// reported reading as one with nothing installed, an installed executor said wrong (its
// version dropped, or signed in when it is not), a login tycho keeps read as the machine's
// own report or the other way round, the reason an executor could not say dropped, a report
// from hours ago reading as one just read, and an executor with no read-only way read as one
// that merely was not asked. And the machines a task spawned (nodes.md §1.3): a quota's
// materials, its count or its time said wrong, a quota never handed a material ticked as
// lapsed, a round judged gone read as evidence still to come, a quota that is over still
// offered for revoking (or one still open not offered), and a spawned machine's delete named
// as if it were a manual one's — revoking one still registered is not deleting its record.
// And the read-only probe (roles-and-tiers.md §5): a way that did not start read as
// available, its own words lost, the layer it reaches left out, or a version too old to take
// any work read as usable.
import assert from 'node:assert/strict';
import { test } from 'vitest';
import { CHECK_MISSING_TEXT } from '@shared/roles.ts';
import { joinDecisionText, machineEndLines, machineSourceText, nodeReleaseText } from '@shared/labels.ts';
import {
  MACHINE_NAME_FIXED, joinGuide, executorsCaption, executorsEmptyText, executorInstalledText, executorLoginText, executorReadOnlyText, executorWhereText,
  inviteExecutorsText, inviteMaterialText, inviteRevocable, inviteUsedText, inviteValidText, joinExpiryText,
  entryLine, executorEntryText, machineExecutorRows, machineRemoval, nodeRunsText, nodeStateLine,
} from './machines.ts';
import type { Invite, Machine, MachineExecutor, MachineExecutors, MachineLogin, MachineNode } from './types.ts';

const NOW = Date.parse('2026-11-06T10:25:00.000Z');
const at = (minutes: number): string => new Date(NOW + minutes * 60_000).toISOString();
const node = (over: Partial<MachineNode> = {}): MachineNode => ({
  node_id: 'a'.repeat(16), platform: 'darwin 24.5.0', joined_at: at(-100), last_seen_at: at(-5),
  connected: true, reported_runs: 0, reported_unknown: 0, source: null, ephemeral: false, scope: null, ends: null, executors: null, release: null, ...over,
});

test('a machine that is here says so, and one that is away says when it was last heard from', () => {
  assert.equal(nodeStateLine(node(), NOW), '已连回来');
  assert.match(nodeStateLine(node({ connected: false }), NOW), /^没连回来：上次往来 \d\d:\d\d$/);
  // Away is a state, not a fault: nothing here reads as broken.
  assert.equal(nodeStateLine(node({ connected: false, last_seen_at: null }), NOW), '没连回来：还没收到过它的消息');
  for (const line of [nodeStateLine(node(), NOW), nodeStateLine(node({ connected: false }), NOW)]) assert.doesNotMatch(line, /失败|出错|坏了/);
});

test('where a machine came from: one no task derived joined by hand, and what it says is running on it', () => {
  assert.equal(machineSourceText(null), '手动加入');
  // A spawned machine names the task and the round, not the run that is the service's own id.
  assert.equal(machineSourceText({ task_id: 't-9', run_id: 'r-41', round: 3 }), '由任务 t-9 第 3 轮派生');
  assert.equal(nodeRunsText(0), '空闲');
  assert.equal(nodeRunsText(3), '在跑 3 轮');
  // What the machine could not read is said as such: the rounds it merely holds are neither
  // running nor unknown, and the count is a count of processes (nodes.md §4.3).
  assert.equal(nodeRunsText(0, 2), '空闲，另有 2 轮待核实');
  assert.equal(nodeRunsText(3, 1), '在跑 3 轮，另有 1 轮待核实');
});

// What a machine reported of its own executors (nodes.md §1.2): the report as the service
// keeps it, read ten minutes before NOW.
const report = (over: Partial<MachineExecutors> = {}): MachineExecutors => ({
  at: at(-10),
  executors: [
    { executor: 'claude', installed: true, version: '2.1.0 (Claude Code)', logged_in: true },
    { executor: 'codex', installed: true, version: 'codex-cli 0.9', logged_in: false },
    { executor: 'dsh', installed: false, version: null, logged_in: null },
  ],
  ...over,
});

const ownLogin = (executor: string, over: Partial<MachineLogin> = {}): MachineLogin => ({
  can_route: false, router_reason: null, id: `m1/${executor}`, name: `m1/${executor}`, kind: 'machine', machine: 'm1', executor, signed_in: true, configured: true, tiers: {}, permission_mode: null,
  timeout_ms: null, max_runs: null, status: { active_runs: 0, max_runs: null, rest: null, usage: [] }, queued_tasks: 0,
  refused: false, usable_here: true, ...over,
});
const withReport = (report: MachineExecutors | null, logins: MachineLogin[] = []): Machine => machine('m1', {
  ...(report === null ? {} : { node: node({ executors: report }) }),
  logins,
});

// A machine's table has one row per executor: what the machine reported of it, and the
// login tycho keeps for it there. What the machine reported and what the owner set up are
// two facts, and either can be there without the other.
test('each executor is one row: what the machine reported, paired with the login set up for it here', () => {
  const rows = machineExecutorRows(withReport(report(), [ownLogin('claude'), ownLogin('gemini')]));
  // The machine's own order first, then the login it no longer reports.
  assert.deepEqual(rows.map((row) => [row.executor, row.reported !== null, row.login !== null]), [
    ['claude', true, true], ['codex', true, false], ['dsh', true, false], ['gemini', false, true],
  ]);
  // A machine that never reported still has the rows the owner set up.
  const ssh = machineExecutorRows(machine('m1', { logins: [ownLogin('claude')] }));
  assert.deepEqual(ssh.map((row) => [row.executor, row.reported, row.login !== null]), [['claude', null, true]]);
  assert.deepEqual(machineExecutorRows(machine('m1')), []);
});

test('whether its command is there, and the version it printed when asked', () => {
  const text = (over: Partial<MachineExecutor>): string => executorInstalledText({ executor: 'x', reported: { executor: 'x', installed: true, version: null, logged_in: null, ...over }, login: null });
  assert.equal(executorInstalledText({ executor: 'claude', reported: report().executors[0]!, login: null }), '装了 · 2.1.0 (Claude Code)');
  assert.equal(text({}), '装了');
  assert.equal(text({ installed: false }), '没装');
  assert.equal(executorInstalledText({ executor: 'x', reported: null, login: ownLogin('x') }), '没有报告');
});

// Fails if the page stops saying where a machine found an executor, or where it looked when
// it found none (nodes.md §1.2): the owner would be left guessing why one is "not installed".
test('where the machine found its command, or every place it looked in', () => {
  const where = (over: Partial<MachineExecutor>): string | null => executorWhereText({ executor: 'x', reported: { executor: 'x', installed: true, version: '1.0', logged_in: null, ...over }, login: null });
  assert.equal(where({ path: '/home/o/.local/bin/claude' }), '在 /home/o/.local/bin/claude');
  assert.equal(where({}), null, '旧客户端不说在哪里，就什么都不写');
  assert.equal(where({ installed: false, error: '这台机器上没有 dsh（查过：PATH、Windows 卸载登记里的 DeepSeek Harness（没有登记））' }), '这台机器上没有 dsh（查过：PATH、Windows 卸载登记里的 DeepSeek Harness（没有登记））');
  assert.equal(executorWhereText({ executor: 'x', reported: null, login: null }), null);
});

test('what the machine said of being signed in: signed in, not signed in, or what it could not say', () => {
  const said = (over: Partial<MachineExecutor>, login: MachineLogin | null = null): string =>
    executorLoginText({ executor: 'x', reported: { executor: 'x', installed: true, version: '1.0', logged_in: null, ...over }, login });
  assert.equal(said({ logged_in: true }), '已登录');
  assert.equal(said({ logged_in: false }), '没登录');
  // ...with the executor's own reason when it gave one, and without it when there is none.
  assert.equal(said({ logged_in: null, error: '命令没有回答' }), '说不清（命令没有回答）');
  assert.equal(said({ logged_in: null }), '说不清');
  // Not there at all is not asked: nothing else in that entry was read.
  assert.equal(said({ installed: false, logged_in: null, error: '命令找不到' }), '—');
  // A version the service cannot run is not asked either: nothing is sent to it here.
  assert.equal(said({ logged_in: true, unusable: '这一版用不了：不认 --permission-mode' }), '—');
  // A machine that never reported, with a login set up for it: what the service last held.
  const ssh = (signed_in: boolean | null): string => executorLoginText({ executor: 'x', reported: null, login: ownLogin('x', { signed_in }) });
  assert.equal(ssh(true), '已登录');
  assert.equal(ssh(false), '机器说没登录');
  assert.equal(ssh(null), '没有报告');
  // A machine that never reported and nothing set up: nothing was read at all.
  assert.equal(executorLoginText({ executor: 'x', reported: null, login: null }), '没有报告');
});

test('whether its read-only way started there, by the probe that machine ran, and one that offers none', () => {
  const readOnly = (over: Partial<MachineExecutor>): string =>
    executorReadOnlyText({ executor: 'x', reported: { executor: 'x', installed: true, version: '1.0', logged_in: true, ...over }, login: null });
  assert.equal(readOnly({ read_only: { available: true, layer: 'tools', checks_code: true } }), '可用（工具层）');
  // A client that does not say it checks a read-only round's code afterwards takes none.
  assert.equal(readOnly({ read_only: { available: true, layer: 'tools' } }), `不可用（${CHECK_MISSING_TEXT}）`);
  assert.equal(readOnly({ read_only: { available: false, layer: 'filesystem', error: "bwrap: Can't bind mount" } }), "不可用（bwrap: Can't bind mount）");
  // Its way did not start and it gave no reason: said as such, not left blank.
  assert.equal(readOnly({ read_only: { available: false, layer: 'tools' } }), '不可用（没说原因）');
  // An executor with no read-only way of its own says so rather than nothing.
  assert.equal(readOnly({ read_only_offered: false }), '这个执行器不提供只读');
  // A client that did not ask says nothing — and that is not the same as offering none.
  assert.equal(readOnly({}), '没有报告');
  assert.notEqual(readOnly({}), readOnly({ read_only_offered: false }));
  assert.equal(readOnly({ installed: false }), '—');
  assert.equal(readOnly({ unusable: '这一版用不了' }), '—');
  assert.equal(executorReadOnlyText({ executor: 'x', reported: null, login: ownLogin('x') }), '没有报告');
});

// When the machine read its executors is always said, so an old report cannot read as a
// fresh one.
test('when the machine read its executors is always said, and a machine that never reported says that', () => {
  const when = (minutes: number): MachineExecutors => ({ at: at(-minutes), executors: [] });
  assert.equal(executorsCaption(when(0), NOW), '机器上的执行器（刚刚读到）');
  assert.equal(executorsCaption({ at: new Date(NOW - 30_000).toISOString(), executors: [] }, NOW), '机器上的执行器（刚刚读到）');
  assert.equal(executorsCaption(when(1), NOW), '机器上的执行器（1 分钟前读到）');
  assert.equal(executorsCaption(when(59), NOW), '机器上的执行器（59 分钟前读到）');
  assert.equal(executorsCaption(when(60), NOW), '机器上的执行器（1 小时前读到）');
  assert.equal(executorsCaption(when(3 * 60), NOW), '机器上的执行器（3 小时前读到）');
  assert.equal(executorsCaption(when(25 * 60), NOW), '机器上的执行器（1 天前读到）');
  // A moment that cannot be measured is not counted as just now: an unreadable time, or one
  // ahead of this host's clock.
  assert.equal(executorsCaption({ at: '不是时间', executors: [] }, NOW), '机器上的执行器（不知道是什么时候读到的）');
  assert.equal(executorsCaption({ at: at(5), executors: [] }, NOW), '机器上的执行器（不知道是什么时候读到的）');
  assert.equal(executorsCaption(null, NOW), '机器上的执行器');
  // The same executors, read at different moments, do not read alike.
  assert.notEqual(executorsCaption(report(), NOW), executorsCaption({ ...report(), at: at(-180) }, NOW));
});

test('a machine that never reported and one that reported nothing are not the same fact', () => {
  assert.equal(executorsEmptyText(null), '还没读到机器上有哪些执行器');
  assert.doesNotMatch(executorsEmptyText(null), /没装|一个也没有|没登录/);
  assert.equal(executorsEmptyText(report({ executors: [] })), '机器上一个执行器也没有');
});

test('how long a request to join has left reads in minutes and hours, and past its time it is over', () => {
  assert.equal(joinExpiryText(at(10), NOW), '还有 10 分钟过期');
  assert.equal(joinExpiryText(at(1), NOW), '还有 1 分钟过期');
  assert.equal(joinExpiryText(new Date(NOW + 30_000).toISOString(), NOW), '还有不到 1 分钟过期');
  assert.equal(joinExpiryText(new Date(NOW).toISOString(), NOW), '已经过期');
  assert.equal(joinExpiryText(at(-1), NOW), '已经过期');
  assert.equal(joinExpiryText(at(60), NOW), '还有 1 小时过期');
  assert.equal(joinExpiryText(at(95), NOW), '还有 1 小时 35 分钟过期');
  assert.equal(joinExpiryText('不是时间', NOW), '已经过期');
});

// The command is the owner's way in (nodes.md §1.1): it names the address the owner gave as
// this service's own, or else this page's own, which only a machine that opens it can use.
test('the join command names the public address, or this page’s own with who can use it', () => {
  assert.deepEqual(joinGuide('https://tycho.example.test/', 'http://127.0.0.1:8787'),
    { address: 'https://tycho.example.test', command: 'tycho node join --to https://tycho.example.test', unreachable: null });
  const local = joinGuide(null, 'http://127.0.0.1:8787');
  assert.equal(local.command, 'tycho node join --to http://127.0.0.1:8787');
  assert.match(local.unreachable!, /还没有填对外地址.*http:\/\/127\.0\.0\.1:8787.*只有能打开这个地址的机器/);
  assert.match(MACHINE_NAME_FIXED, /改不了/);
  assert.match(MACHINE_NAME_FIXED, /先在这里删掉这台机器，再在那台机器上带 --name/, '换名字要先删掉旧登记');
});

// Answered from the sidebar or from a card on the phone: neither is beside the machine list.
test('a decision names the machine, and one let in says where it will show up', () => {
  assert.equal(joinDecisionText(true, 'mac-mini-01'), '已放行 mac-mini-01，它连回来后会出现在“机器”页的列表里');
  assert.equal(joinDecisionText(false, 'mac-mini-01'), '已拒绝 mac-mini-01，那台机器上的加入命令已经退出');
});

const machine = (id: string, over: Partial<Machine> = {}): Machine =>
  ({ id, uid: `uid-${id}`, host: id, note: null, node: node(), ...over });

// A quota a round asked for, as the service lists it: open for another quarter hour, nothing
// handed yet.
const MATERIAL_NONE: Invite['material'] = { live: 0, live_until: null, ended_at: null, ended_why: null };
const invite = (over: Partial<Invite> = {}): Invite => ({
  id: 'inv-1', created_at: at(-20), project_id: 'p1', task_id: 't-9', executors: ['claude'], expires_at: at(15),
  max_machines: 2, used: 0, revoked_at: null, last_handed_at: null, last_run_id: null, material: MATERIAL_NONE, machines: [], ...over,
});
const clock = (iso: string): string => { const d = new Date(iso); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };

test('a quota says which executors it allows, how many it let in out of how many, and until when', () => {
  assert.equal(inviteExecutorsText(['claude', 'codex']), 'claude、codex');
  assert.equal(inviteExecutorsText(null), '不限');
  assert.equal(inviteUsedText(invite({ used: 1 })), '已登记 1/2');
  assert.equal(inviteValidText(invite(), NOW), `有效到 ${clock(at(15))}`);
  // Past its time it is over, and a revoked one says so with when, whatever time it had left.
  assert.equal(inviteValidText(invite({ expires_at: at(-5) }), NOW), `${clock(at(-5))} 已过期`);
  assert.equal(inviteValidText(invite({ revoked_at: at(-2) }), NOW), `${clock(at(-2))} 已撤销`);
});

test('what a quota\'s materials are now is said the way a machine\'s first ending says it', () => {
  assert.equal(inviteMaterialText({ live: 1, live_until: at(10), ended_at: null, ended_why: null }, NOW), `还有 1 份有效，到 ${clock(at(10))}`);
  assert.equal(inviteMaterialText({ live: 0, live_until: null, ended_at: at(-3), ended_why: 'used' }, NOW), `已失效（名额用完，${clock(at(-3))}）`);
  assert.equal(inviteMaterialText({ live: 0, live_until: null, ended_at: at(-3), ended_why: 'revoked' }, NOW), `已失效（名额被撤销，${clock(at(-3))}）`);
  // A quota no round has been handed a material from yet: nothing lapsed, and it is not done.
  assert.equal(inviteMaterialText(MATERIAL_NONE, NOW), '还没有发过材料');
});

test('a quota is offered for revoking while it can still let a machine in, and not once it cannot', () => {
  assert.equal(inviteRevocable(invite(), NOW), true);
  // Full and past its time, but a material handed earlier still works: still worth revoking.
  assert.equal(inviteRevocable(invite({ used: 2, expires_at: at(-1), material: { live: 1, live_until: at(5), ended_at: null, ended_why: null } }), NOW), true);
  assert.equal(inviteRevocable(invite({ used: 2 }), NOW), false);
  assert.equal(inviteRevocable(invite({ expires_at: at(-1) }), NOW), false);
  assert.equal(inviteRevocable(invite({ revoked_at: at(-1) }), NOW), false);
});

const ENDS: NonNullable<MachineNode['ends']> = { material: MATERIAL_NONE, drain_at: null, evidence_at: null, left_at: null, left_reason: null, destroyed_at: null, destroyed_by: null, lost_rounds: 0 };

test('a material never handed is not ticked as lapsed, and a lost round is said instead of a wait for evidence', () => {
  const line = (ends: Partial<typeof ENDS>, key: string) => machineEndLines({ ...ENDS, ...ends }, new Date(NOW)).find((each) => each.key === key)!;
  assert.deepEqual([line({}, 'material').text, line({}, 'material').done], ['还没有发过材料', false]);
  assert.deepEqual([line({ material: { live: 0, live_until: null, ended_at: at(-3), ended_why: 'expired' } }, 'material').done], [true]);
  assert.equal(line({}, 'evidence').text, '还没确认全部交回');
  // A round judged gone never brings its output back: there is nothing to wait for.
  assert.equal(line({ lost_rounds: 1 }, 'evidence').text, '有一轮按失联结束，结果没交回');
  assert.equal(line({ lost_rounds: 3 }, 'evidence').text, '有 3 轮按失联结束，结果没交回');
  assert.equal(line({ lost_rounds: 1 }, 'evidence').done, false);
});

test('a spawned machine still registered is revoked, one whose registration ended has its record deleted, a manual one is deleted', () => {
  const spawned = (ends: Partial<typeof ENDS>): Machine => machine('b1', { node: node({ ephemeral: true, source: { task_id: 't-9', run_id: 'r-1', round: 1 }, ends: { ...ENDS, ...ends } }) });
  assert.deepEqual(machineRemoval(spawned({})), { action: '撤销这台机器', confirm: '确认撤销', sending: '撤销中', back: '不撤了', keeps: true });
  assert.deepEqual(machineRemoval(spawned({ left_at: at(-1), left_reason: 'revoked' })), { action: '删除记录', confirm: '确认删除', sending: '删除中', back: '不删了', keeps: false });
  assert.deepEqual(machineRemoval(machine('a1')), { action: '删除', confirm: '确认删除', sending: '删除中', back: '不删了', keeps: false });
  assert.deepEqual(machineRemoval(machine('m1', { node: node() })), machineRemoval(machine('a1')));
});

// The global entry (knowledge-and-skills.md §4.3): nothing said is not nothing written, a file
// kept out by the executor or whose loading cannot be confirmed is not "written", and the reason
// travels with every state.
test('the global entry says, executor by executor, where it went and why not', () => {
  const row = (executor: string) => ({ executor, reported: null, login: null });
  const report = { digest: 'a', at: at(-10), executors: [
    { executor: 'codex', path: '/h/.codex/AGENTS.md', state: 'covered' as const, note: '旁边有 AGENTS.override.md，codex 读那一份、不读这份' },
    { executor: 'dsh', path: '/h/.dsh/AGENTS.md', state: 'unconfirmed' as const, note: '取决于 profile' },
    { executor: 'claude', path: '/h/.claude/rules/tycho-knowledge.md', state: 'cleared' as const, note: '没有要写的全局常驻知识' },
    { executor: 'x', path: '/h/x', state: 'failed' as const, note: '写不进去：EACCES' },
  ] };
  assert.equal(executorEntryText(row('codex'), null), '没有报告');
  assert.equal(executorEntryText(row('codex'), report), '已写入 /h/.codex/AGENTS.md，但执行器不会读到：旁边有 AGENTS.override.md，codex 读那一份、不读这份');
  assert.equal(executorEntryText(row('dsh'), report), '已写入 /h/.dsh/AGENTS.md，读不读确认不了：取决于 profile');
  assert.equal(executorEntryText(row('claude'), report), '没有写：没有要写的全局常驻知识');
  assert.equal(executorEntryText(row('x'), report), '没写进去：写不进去：EACCES');
  // Reported, and this executor not in it: nothing was written for it, said as nothing to say.
  assert.equal(executorEntryText(row('gemini'), report), '—');
  assert.equal(executorsCaption({ at: at(-10), executors: [] }, NOW, report), '机器上的执行器（10 分钟前读到）');
  assert.equal(entryLine(null, NOW, '主机本机'), '主机本机执行器的全局知识入口：还没报告');
  assert.equal(entryLine({ ...report, executors: [] }, NOW, '主机本机'), '主机本机执行器的全局知识入口（10 分钟前写）：没有要写的执行器');
});

// What this catches (docs/design/nodes.md §1.4): a machine whose client never reported reading
// as one on the host's version, a version difference hidden, and a failed move not saying it
// failed or when that was.
test('what version a machine runs is said with the host version, and a failed move says when', () => {
  const host = '0.1.500';
  assert.equal(nodeReleaseText(null, host, NOW), '没报版本（客户端太旧，重启一次它就会跟上）');
  assert.equal(nodeReleaseText({ version: host, at: at(-1), upgrade: null }, host, NOW), 'tycho 0.1.500');
  assert.equal(
    nodeReleaseText({ version: '0.1.400', at: at(-1), upgrade: { state: 'waiting', target: host, detail: '等 2 轮跑完后换到 0.1.500' } }, host, NOW),
    'tycho 0.1.400，主机 0.1.500，等 2 轮跑完后换到 0.1.500',
  );
  assert.equal(
    nodeReleaseText({ version: '0.1.400', at: at(-90), upgrade: { state: 'failed', target: host, detail: '磁盘满了' } }, host, NOW),
    'tycho 0.1.400，主机 0.1.500，换版没成功：磁盘满了（1 小时前）',
  );
});


test('pre-write projection failures never claim to have written in host or node viewer text', () => {
  const row = { executor: 'codex', reported: null, login: null };
  for (const note of ['发布身份文件 /private/data/global-entry-publisher 损坏，请从原 ID 备份恢复', '协调文件 /private/profile/.tycho-entry-mutex.sqlite 正忙，下轮自动重看']) {
    const report = { digest: 'pending', at: at(-1), executors: [{ executor: 'codex', path: '/private/profile/AGENTS.md', state: 'failed' as const, note }] };
    const node = executorEntryText(row, report), host = entryLine(report, NOW, '主机本机');
    assert.ok(node.includes(note)); assert.ok(host.includes(note)); assert.ok(!node.includes('已写入')); assert.ok(!host.includes('已写入'));
  }
});
