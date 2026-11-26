// Guards against a draft container hiding descendants, or projections mutating ledger facts.
import './guard.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { summarizeWork } from '../service/work-summary.ts';
import { taskLine, WORK_GROUPS, workGroup } from '../shared/labels.ts';

test('work summary includes all descendants and uses attention priority', () => {
  const tasks = [{ id: 'w', parent_id: null, state: 'draft' },
    { id: 'a', parent_id: 'w', state: 'running' },
    { id: 'b', parent_id: 'w', state: 'ready' },
    { id: 'c', parent_id: 'b', state: 'waiting_person' },
    { id: 'other', parent_id: null, state: 'needs_verification' }];
  const before = structuredClone(tasks);
  const result = summarizeWork('w', tasks, []);
  assert.equal(result.dot, 'waiting_person');
  assert.match(result.text, /1 个在执行/);
  assert.match(result.text, /1 个待验收/);
  assert.match(result.text, /1 个等你决定/);
  assert.equal(result.counts.running, 1);
  assert.equal(result.leaf, false);
  assert.equal(summarizeWork('other', tasks, []).leaf, true);
  assert.deepEqual(tasks, before);
});

test('a child whose machine is out of contact counts as moving work, and shows as itself only when nothing else moves', () => {
  const work = (...states: string[]) => [{ id: 'w', parent_id: null, state: 'draft' }, ...states.map((state, n) => ({ id: `c${n}`, parent_id: 'w', state }))];
  const alone = summarizeWork('w', work('needs_verification', 'held'), []);
  assert.equal(alone.dot, 'needs_verification', '比已停住优先：它还在推进');
  assert.match(alone.text, /1 个执行机器失联/);
  assert.doesNotMatch(alone.text, /需要你核实/);
  const mixed = summarizeWork('w', work('needs_verification', 'running'), []);
  assert.equal(mixed.dot, 'running');
  assert.match(mixed.text, /1 个在执行，1 个执行机器失联/);
  assert.equal(summarizeWork('w', work('needs_verification', 'ready'), []).dot, 'needs_verification', '在推进的排在待验收前面');
});

test('each child state overrides a draft parent, and open Approval wins', () => {
  for (const state of ['running', 'ready', 'waiting_person', 'needs_verification', 'held']) {
    const tasks = [{ id: 'w', parent_id: null, state: 'draft' }, { id: 'a', parent_id: 'w', state }];
    assert.equal(summarizeWork('w', tasks, []).dot, state);
    assert.equal(summarizeWork('w', tasks, [{ task_id: 'a', state: 'open' }]).dot, 'waiting_person');
  }
  assert.equal(summarizeWork('w', [{ id: 'w', parent_id: null, state: 'done' }], []).dot, 'done');
});

test('ready tasks with active reviews show as in-review or review-held instead of ready', () => {
  const reviewOf = (taskId: string) => JSON.stringify({ task_id: taskId });
  // Active running review -> dot 'running', text '审阅中', group '在推进'
  const running = [
    { id: 't1', parent_id: null, state: 'ready' },
    { id: 'r1', parent_id: null, state: 'running', review_of_json: reviewOf('t1') },
  ];
  const sRunning = summarizeWork('t1', running, []);
  assert.equal(sRunning.dot, 'running');
  assert.equal(sRunning.text, '审阅中');
  assert.equal(sRunning.leaf, true);
  assert.equal(workGroup({ state: 'ready', summary: sRunning }), WORK_GROUPS.moving);
  assert.equal(taskLine({ state: 'ready', summary: sRunning }), '审阅中');

  // Held review -> dot 'held', text '审阅停住', group '等你'
  const held = [
    { id: 't1', parent_id: null, state: 'ready' },
    { id: 'r1', parent_id: null, state: 'held', review_of_json: reviewOf('t1') },
  ];
  const sHeld = summarizeWork('t1', held, []);
  assert.equal(sHeld.dot, 'held');
  assert.equal(sHeld.text, '审阅停住');
  assert.equal(workGroup({ state: 'ready', summary: sHeld }), WORK_GROUPS.waiting);
  assert.equal(taskLine({ state: 'ready', summary: sHeld }), '审阅停住');

  // Completed passing review -> task is genuinely ready (even if an older review was held)
  const passed = [
    { id: 't1', parent_id: null, state: 'ready' },
    { id: 'r1', parent_id: null, state: 'held', review_of_json: reviewOf('t1') },
    { id: 'r2', parent_id: null, state: 'done', review_of_json: reviewOf('t1'), verdict_json: JSON.stringify({ result: 'pass' }) },
  ];
  const sPassed = summarizeWork('t1', passed, []);
  assert.equal(sPassed.dot, 'ready');
  assert.equal(workGroup({ state: 'ready', summary: sPassed }), WORK_GROUPS.ready);
  assert.equal(taskLine({ state: 'ready', summary: sPassed }), '待验收');

  // Composite work with a child in review
  const tree = [
    { id: 'w', parent_id: null, state: 'draft' },
    { id: 'c1', parent_id: 'w', state: 'ready' },
    { id: 'r1', parent_id: null, state: 'queued', review_of_json: reviewOf('c1') },
  ];
  const sTree = summarizeWork('w', tree, []);
  assert.equal(sTree.dot, 'running');
  assert.equal(sTree.text, '1 个审阅中');
});
