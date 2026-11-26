// A native Worker may report its absolute artifacts path. Preview must recognize
// only this Task/Run's complete path, keep the original receipt, and read only the
// bound Run's safe name. Never open the absolute path or accept its basename alone.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { reportFilesOf, readRunReport, REPORT_TEXT_LIMIT } from '../service/reports.ts';
import { consoleApp } from './console-helpers.ts';
import { DONE } from './helpers.ts';

const TASK = '01M7CG39WNGJ0J7FA8R8XPZZHV';
const RUN = '01M7CG3A3CJ9H99SDJRG10AWKS';
// Exact decoded ref from the real Windows Worker receipt, including doubled slashes.
const REAL_REF = String.raw`C:\\Users\\dev\\AppData\\Local\\Temp\\tycho-crosshost-d2627c7ede874d1eb7f3dc35e4ce75c1\\wecom-canary-5305fba4c90d45589a9ef4bc5d60b6ca\\host\\tasks\\01M7CG39WNGJ0J7FA8R8XPZZHV\\runs\\01M7CG3A3CJ9H99SDJRG10AWKS\\artifacts\\report.md`;
const projected = (refs: string[], taskId = TASK, runId = RUN) => reportFilesOf({
  id: runId, task_id: taskId, receipt_json: JSON.stringify({ artifacts: refs.map(ref => ({ kind: 'report', ref })) }),
});

test('the actual doubled-backslash Windows receipt and absolute native paths project their exact original refs', () => {
  const refs = [REAL_REF, `C:/host/tasks/${TASK}/runs/${RUN}/artifacts/report.md`,
    `/tmp/tycho/tasks/${TASK}/runs/${RUN}/artifacts/report.md`];
  assert.deepEqual(projected(refs), refs.map(ref => ({ ref, name: 'report.md' })));
  assert.equal(projected([REAL_REF], 'another-task')[0]?.kind, 'invalid');
  assert.equal(projected([REAL_REF], TASK, 'another-run')[0]?.kind, 'invalid');
});

test('absolute references accept nested subpaths under this run artifacts/ and reject arbitrary basename, traversal, foreign round, URL, device or UNC', () => {
  const tail = `tasks/${TASK}/runs/${RUN}/artifacts/report.md`;
  // Nested subpaths under this run's artifacts/ are allowed.
  assert.deepEqual(projected([`C:/${tail.replace('report.md', 'nested/report.md')}`]), [
    { ref: `C:/${tail.replace('report.md', 'nested/report.md')}`, name: 'nested/report.md' },
  ]);
  const rejected = [
    'C:/other/report.md', '/tmp/report.md', `C:/${tail}/`,
    `C:/host/tasks/other/runs/${RUN}/artifacts/report.md`, `C:/host/tasks/${TASK}/runs/other/artifacts/report.md`,
    `C:/host/../${tail}`, `/tmp/./${tail}`, `/tmp/../${tail}`, `C:/host/tasks/${TASK}/runs/${RUN}/artifacts/../report.md`,
    `C:/${tail.replace('report.md', 'CON.md')}`,
    `//server/share/${tail}`, String.raw`\\server\share` + '\\' + tail,
    String.raw`\\?\C:` + '\\' + tail, String.raw`\\.\C:` + '\\' + tail,
    `file:///tmp/${tail}`, `https://host/${tail}`, `C:host/${tail}`, `/tmp/${tail}?query=1`,
    `/tmp/${tail}#fragment`, `C:/host:stream/${tail}`, `/tmp//${tail}`,
    `/tmp/${tail.replace('report.md', '最后一条消息')}`, `/tmp/\u0000/${tail}`,
  ];
  for (const ref of rejected) {
    const reports = projected([ref]);
    assert.equal(reports.length, 1, ref);
    assert.equal(reports[0]!.kind, 'invalid', ref);
    assert.equal(reports[0]!.ref, ref);
    assert.match(reports[0]!.kind === 'invalid' ? reports[0]!.problem : '', /无法识别/);
  }
});

test('owner preview retains an absolute receipt ref but sends only the current bound Run and safe filename to node reading', async t => {
  const reads: { run: string; task: string; name: string; max: number }[] = [];
  const app = await consoleApp(t, { runner: { readReportFile: async (run, name, max) => {
    reads.push({ run: run.id, task: run.task_id, name, max });
    return Buffer.from('本轮真实报告');
  } } });
  const { task, run } = app.f.runningRun();
  const ref = String.raw`D:\\worker\\tasks\\${task.id}\\runs\\${run.id}\\artifacts\\report.md`;
  app.f.ledger.settleRun(run.id, 0, { ...DONE, artifacts: [{ kind: 'commit', ref: 'c0ffee' }, { kind: 'report', ref }] });
  const before = app.f.ledger.getRun(run.id).receipt_json;
  const response = await app.get(`/api/runs/${run.id}/report?ref=${encodeURIComponent(ref)}`);
  assert.equal(response.status, 200);
  const bytes = Buffer.byteLength('本轮真实报告');
  assert.deepEqual(await response.json(), {
    run_id: run.id, ref, name: 'report.md', text: '本轮真实报告', source: 'node',
    complete: true, bytes, original_bytes: bytes,
  });
  assert.deepEqual(reads, [{ run: run.id, task: task.id, name: 'report.md', max: REPORT_TEXT_LIMIT }]);
  assert.equal(app.f.ledger.getRun(run.id).receipt_json, before);
  assert.equal(app.f.ledger.getTask(task.id).state, 'ready');
  const unlisted = ref.replace('D:', 'E:');
  assert.equal((await app.get(`/api/runs/${run.id}/report?ref=${encodeURIComponent(unlisted)}`)).status, 400);
  assert.equal(reads.length, 1);
  const foreign = { ...app.f.ledger.getRun(run.id), task_id: 'other-task' };
  await assert.rejects(readRunReport({ run: foreign, ref, dataDir: app.f.dir, held: undefined, readNode: async () => { throw new Error('must not read'); } }), /无法识别/);
});
