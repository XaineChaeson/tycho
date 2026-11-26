import assert from 'node:assert/strict';
import { test } from 'node:test';
import { consoleApp, TOOL_TOKEN } from './console-helpers.ts';
import { USER } from './helpers.ts';
import type { TaskFeedback } from '../shared/task-feedback.ts';

test('feedback is owner-only, uses the authenticated actor and cannot masquerade as a model tool or task input', async (t) => {
  const app = await consoleApp(t);
  const task = app.f.ledger.createTask({ projectId: app.f.projectId, title: '验证', roleId: 'verify', goal: '目标', acceptance: '报告' }, USER);
  const path = `/api/tasks/${task.id}/feedback`;
  for (const headers of [{}, { Authorization: `Bearer ${TOOL_TOKEN}` }] as Record<string, string>[]) {
    assert.equal((await app.get(path, headers)).status, 401);
    assert.equal((await app.post(path, { kind: 'reuse' }, headers)).status, 401);
  }
  assert.equal((await app.post(path, { kind: 'reuse' }, { ...app.browser, Origin: 'https://foreign.example' })).status, 403);
  const sent = await app.post(path, { kind: 'incorrect', note: '报告遗漏退出码' });
  assert.equal(sent.status, 201);
  const { feedback } = await sent.json() as { feedback: TaskFeedback };
  assert.equal(feedback.actor, 'console');
  assert.equal(feedback.task_id, task.id);
  assert.equal(feedback.kind, 'incorrect');
  assert.deepEqual(await (await app.get(path)).json(), { feedback: [feedback] });
  assert.equal(app.f.ledger.listInputs(task.id).length, 0);
  assert.equal(app.f.ledger.listRuns(task.id).length, 0);
});
