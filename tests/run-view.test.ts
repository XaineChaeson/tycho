import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runErrorView } from '../service/run-view.ts';

test('quota history displays the round name before a renamed or deleted login, without rewriting evidence', () => {
  const error_json = JSON.stringify({ quota: { login_id: 'internal', rest_until: null } });
  const run = { login_id: 'internal', login_name: '当时的账号', error_json };
  for (const now of ['现在的账号', undefined]) {
    const shown = runErrorView(run, () => now);
    assert.equal(shown.quota.login_name, '当时的账号');
    assert.equal(shown.quota.login_id, '当时的账号');
    assert.equal(run.error_json, error_json);
  }
});

test('quota history without a name snapshot resolves the current login name', () => {
  const shown = runErrorView({ login_id: 'internal', login_name: null, error_json: '{"quota":{"login_id":"internal"}}' }, () => '当前账号');
  assert.equal(shown.quota.login_name, '当前账号');
});
