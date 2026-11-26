import './guard.ts';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ulid } from '../service/ids.ts';
import { openLedger } from '../service/ledger.ts';
import { createProjectHome } from '../service/project-home.ts';
import { exportProjectHandoff, freezeProjectHandoff, importProjectHandoff, stageProjectHandoff } from '../service/project-home-transfer.ts';
import { createTools } from '../service/tools.ts';
import { accepting, memoryLogins } from './helpers.ts';

test('offline project handoff preserves packed historical tool catalogs and legacy templates without other project definitions', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'tycho-catalog-transfer-'));
  const sourceDir = join(dir, 'source'), targetDir = join(dir, 'target');
  const sourceHome = createProjectHome(sourceDir), targetHome = createProjectHome(targetDir);
  const opened: { close(): void }[] = [sourceHome, targetHome];
  t.after(() => { for (const item of opened) item.close(); rmSync(dir, { recursive: true, force: true }); });
  const source = openLedger(join(sourceDir, 'ledger.db'), { projectHome: sourceHome });
  opened.push(source);
  const owner = { actor: 'console' };
  source.setWhitelist({ console: ['owner'] }, owner);
  const project = source.createProject({ name: '移交工具目录', loginMode: 'all' }, owner);
  const other = source.createProject({ name: '保留私有目录', loginMode: 'all' }, owner);
  const tools = createTools({ ledger: source, logins: memoryLogins({}), machines: { list: source.listMachines },
    accept: accepting(source), runner: { events: () => [], interrupt: async () => 'ended', abandon: async () => {} } });
  function record(projectId: string, template: string) {
    const message = source.receiveMessage({ channel: 'console', externalId: ulid(), actor: 'owner', projectId, text: '核对工具' });
    source.takeNextTurn(projectId);
    const context = source.openContext({ projectId, segmentId: source.ensureSegment(projectId).id, marker: 'catalog-' + projectId, launch: {}, knowledge: [] });
    for (const catalog of [tools.list({ projectId }), undefined]) {
      const id = ulid();
      source.startRouterExchange({ id, messageId: message.id, contextId: context.id, phase: 'request', input: '输入保持原样', template, tools: catalog });
      source.finishRouterExchange(id, 'completed', '完成');
    }
    source.finishMessage(message.id, 'processed');
    source.closeContext(context.id, '移交目录');
    return message.id;
  }
  const messageId = record(project, '原项目固定模板');
  record(other, '不移交的私有固定模板');
  const expected = source.routerTurnTrace(project, messageId, null);
  assert.ok(expected.exchanges[0]!.tool_catalog!.tools.some(({ name }) => name === 'create_task'));
  assert.equal(expected.exchanges[1]!.tool_catalog, null);
  source.setProjectPaused(project, true, owner);
  source.close();
  const target = openLedger(join(targetDir, 'ledger.db'), { projectHome: targetHome });
  target.close();
  const bytes = exportProjectHandoff(sourceDir, project);
  const bundle = JSON.parse(bytes.toString('utf8'));
  assert.equal(bundle.rows.router_template.length, 2);
  assert.ok(!JSON.stringify(bundle.rows.router_template).includes('不移交的私有固定模板'));
  const staged = stageProjectHandoff(targetDir, bytes, sourceHome.identity);
  const receipt = freezeProjectHandoff(sourceDir, bytes, staged.id);
  importProjectHandoff(targetDir, bytes, receipt);
  const moved = openLedger(join(targetDir, 'ledger.db'), { projectHome: targetHome });
  opened.push(moved);
  assert.deepEqual(moved.routerTurnTrace(project, messageId, null), expected);
});
