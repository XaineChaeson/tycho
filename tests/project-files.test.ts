import './guard.ts';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { createAcceptor } from '../service/accept.ts';
import { SCHEMA_VERSION, verifySnapshot } from '../service/db.ts';
import { openLedger } from '../service/ledger.ts';
import { hydrateMessageEvent } from '../service/http.ts';
import {
  buildSandboxedPreviewHtml,
  isPreviewableArtifactMime,
  isRasterImageMime,
  isTextFileMime,
  matchesRasterImageMagic,
  normalizeProjectFileMime,
  normalizeProjectFileName,
  projectFilePath,
  readProjectFileBytes,
  removeProjectFileBytes,
  removeProjectFilesDir,
  writeProjectFileBytes,
} from '../service/project-files.ts';
import { tempDir } from './cli-helpers.ts';
import { consoleApp } from './console-helpers.ts';
import { USER } from './helpers.ts';

const json = async (response: Response): Promise<any> => response.json();

// Minimal valid 1x1 PNG bytes.
const TINY_PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082',
  'hex',
);

test('project-files helpers normalize names, mimes, disk storage, and sandboxed preview HTML', (t) => {
  assert.equal(normalizeProjectFileName('foo/bar/设计稿.png'), '设计稿.png');
  assert.equal(normalizeProjectFileName('C:\\Users\\demo\\a   b\u0000\u0007.txt'), 'a b.txt');
  assert.equal(normalizeProjectFileName('../../../..'), 'untitled');
  assert.equal(normalizeProjectFileName('   '), 'untitled');
  assert.equal(normalizeProjectFileName('a'.repeat(200)).length, 160);

  assert.equal(normalizeProjectFileMime('image/png; charset=binary', 'x.bin'), 'image/png');
  assert.equal(normalizeProjectFileMime('application/octet-stream', 'diagram.svg'), 'image/svg+xml');
  assert.equal(normalizeProjectFileMime(undefined, 'report.HTML'), 'text/html');
  assert.equal(normalizeProjectFileMime(undefined, 'notes.md'), 'text/markdown');
  assert.equal(normalizeProjectFileMime(undefined, 'app.js'), 'application/javascript');
  assert.equal(normalizeProjectFileMime(undefined, 'unknown.xyz'), 'application/octet-stream');

  assert.equal(isRasterImageMime('image/png'), true);
  assert.equal(isRasterImageMime('image/svg+xml'), false);
  assert.equal(isPreviewableArtifactMime('text/html'), true);
  assert.equal(isPreviewableArtifactMime('image/svg+xml'), true);
  assert.equal(isPreviewableArtifactMime('image/png'), false);
  assert.equal(isTextFileMime('application/json'), true);
  assert.equal(isTextFileMime('image/svg+xml'), true);
  assert.equal(isTextFileMime('image/png'), false);

  const dir = tempDir(t, 'tycho-pfiles-');
  assert.throws(() => projectFilePath(dir, '../evil', 'file1'), /不合法/);
  assert.throws(() => projectFilePath(dir, 'proj1', 'a/b'), /不合法/);

  const payload = Buffer.from('hello tycho', 'utf8');
  const written = writeProjectFileBytes(dir, 'proj_1', 'file_1', payload);
  assert.equal(written.size, payload.length);
  assert.equal(written.sha256.length, 64);
  assert.deepEqual(readProjectFileBytes(dir, 'proj_1', 'file_1'), payload);
  assert.equal(readProjectFileBytes(dir, 'proj_1', 'missing'), null);
  removeProjectFileBytes(dir, 'proj_1', 'file_1');
  assert.equal(readProjectFileBytes(dir, 'proj_1', 'file_1'), null);

  writeProjectFileBytes(dir, 'proj_1', 'file_2', payload);
  removeProjectFilesDir(dir, 'proj_1');
  assert.equal(existsSync(join(dir, 'projects', 'proj_1')), false);

  const svgHtml = buildSandboxedPreviewHtml('<svg viewBox="0 0 10 10"><circle r="4"/></svg>', 'image/svg+xml', '图<1>', 'dark');
  assert.match(svgHtml, /data-theme="dark"/);
  assert.match(svgHtml, /<title>图&lt;1&gt;<\/title>/);
  assert.match(svgHtml, /<svg viewBox="0 0 10 10"><circle r="4"\/><\/svg>/);
  assert.match(svgHtml, /tycho:artifact:theme/);
  assert.match(svgHtml, /tycho:artifact:resize/);

  const fullHtml = buildSandboxedPreviewHtml('<!doctype html><html><head><title>A</title></head><body><h1>$1 Hi</h1></body></html>', 'text/html', 'A', 'light');
  assert.match(fullHtml, /<html data-theme="light">/);
  assert.match(fullHtml, /id="tycho-artifact-theme"/);
  assert.match(fullHtml, /id="tycho-artifact-bridge"/);
  assert.match(fullHtml, /<h1>\$1 Hi<\/h1>/);

  const fragHtml = buildSandboxedPreviewHtml('<div>Fragment</div>', 'text/html', 'Frag');
  assert.match(fragHtml, /<!doctype html>/i);
  assert.match(fragHtml, /<div>Fragment<\/div>/);

  // buildSandboxedPreviewHtml: JS string literal containing "</body>" must not be clobbered,
  // and missing <head> must not prepend <style> before <!doctype html> (no Quirks Mode).
  const scriptLiteralHtml = buildSandboxedPreviewHtml(
    '<!doctype html><html><body><script>const marker = "</body>";</script></body></html>',
    'text/html',
    'ScriptTest',
    'dark',
  );
  assert.match(scriptLiteralHtml, /^<!doctype html>/i, '<style> 不应插入到 <!doctype html> 之前');
  assert.match(scriptLiteralHtml, /const marker = "<\/body>";/, 'script 字符串字面量中的 </body> 不应被破坏');
  const scriptEndIdx = scriptLiteralHtml.indexOf('const marker = "</body>";</script>');
  const bridgeIdx = scriptLiteralHtml.indexOf('id="tycho-artifact-bridge"');
  assert.ok(scriptEndIdx > 0 && bridgeIdx > scriptEndIdx, '桥接脚本应注入在最后一个真实 </body> 之前');

  const doctypeOnlyHtml = buildSandboxedPreviewHtml(
    '<!DOCTYPE HTML><body><p>No html or head tag</p></body>',
    'text/html',
    'DoctypeOnly',
  );
  assert.match(doctypeOnlyHtml, /^<!DOCTYPE HTML>\n<style id="tycho-artifact-theme">/);

  // matchesRasterImageMagic covers PNG, JPEG, GIF87a/GIF89a, WebP, and rejects spoofed bytes.
  assert.equal(matchesRasterImageMagic(TINY_PNG, 'image/png'), true);
  assert.equal(matchesRasterImageMagic(Buffer.from('not a png'), 'image/png'), false);
  assert.equal(matchesRasterImageMagic(Buffer.from([0xff, 0xd8, 0xff, 0xe0]), 'image/jpeg'), true);
  assert.equal(matchesRasterImageMagic(Buffer.from([0xff, 0xd8, 0x00]), 'image/jpeg'), false);
  assert.equal(matchesRasterImageMagic(Buffer.from('GIF89a\x01\x00'), 'image/gif'), true);
  assert.equal(matchesRasterImageMagic(Buffer.from('GIF87a\x01\x00'), 'image/gif'), true);
  assert.equal(matchesRasterImageMagic(Buffer.from('GIF99a'), 'image/gif'), false);
  assert.equal(matchesRasterImageMagic(Buffer.from('RIFF\x24\x00\x00\x00WEBPVP8 '), 'image/webp'), true);
  assert.equal(matchesRasterImageMagic(Buffer.from('RIFF\x24\x00\x00\x00WAVEfmt '), 'image/webp'), false);
  assert.equal(matchesRasterImageMagic(TINY_PNG, 'image/svg+xml'), false);
});

test('schema migration v44 -> v45 adds message.attachments_json, project_file, and project_files_cleanup', (t) => {
  const dir = tempDir(t, 'tycho-mig45-');
  const dbPath = join(dir, 'ledger.db');
  // Seed a ledger, then roll its schema back to v44 shape to simulate an existing v44 database.
  const initial = openLedger(dbPath);
  const projectId = initial.createProject({ name: '旧项目' }, USER);
  initial.setWhitelist({ console: ['console'] }, USER);
  const oldMsg = initial.receiveMessage({ channel: 'console', externalId: 'old-1', actor: 'console', text: '旧消息', projectId });
  initial.close();

  const raw = new DatabaseSync(dbPath);
  raw.exec('PRAGMA foreign_keys = OFF');
  raw.exec(`
    DROP TABLE project_file;
    DROP TABLE project_files_cleanup;
    CREATE TABLE message_v44 (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      channel TEXT NOT NULL,
      external_id TEXT NOT NULL,
      thread TEXT,
      direction TEXT NOT NULL,
      actor TEXT,
      text TEXT NOT NULL,
      state TEXT,
      final INTEGER NOT NULL DEFAULT 0,
      at TEXT NOT NULL,
      project_id TEXT REFERENCES project(id),
      segment_id TEXT REFERENCES router_segment(id),
      basis TEXT,
      candidates_json TEXT,
      task_id TEXT REFERENCES task(id),
      UNIQUE (channel, external_id)
    );
    INSERT INTO message_v44
      SELECT id, created_at, channel, external_id, thread, direction, actor, text, state, final, at, project_id, segment_id, basis, candidates_json, task_id
      FROM message;
    DROP TABLE message;
    ALTER TABLE message_v44 RENAME TO message;
    CREATE INDEX message_by_project ON message(project_id, state);
    UPDATE setting SET value_json = '44' WHERE key = 'schema_version';
  `);
  raw.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  raw.close();

  assert.equal(verifySnapshot(dbPath).get('schema_version'), '44');

  // Re-open with current code: must migrate cleanly from 44 -> 45.
  const migrated = openLedger(dbPath, { log: () => {} });
  t.after(() => migrated.close());

  assert.equal(SCHEMA_VERSION, 47);
  const restoredMsg = migrated.getMessage(oldMsg.id);
  assert.equal(restoredMsg.text, '旧消息');
  assert.equal(restoredMsg.attachments_json, null);

  const created = migrated.createProjectFile({
    projectId,
    name: 'demo.html',
    mime: 'text/html',
    size: 12,
    sha256: 'a'.repeat(64),
    kind: 'artifact',
    origin: 'owner',
    summary: '迁移后新建',
  });
  assert.equal(migrated.getProjectFile(projectId, created.id)?.name, 'demo.html');
  assert.deepEqual(migrated.deletedProjectFilesDue(), []);

  migrated.close();
  const check = new DatabaseSync(dbPath);
  check.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  check.close();
  assert.equal(verifySnapshot(dbPath).get('schema_version'), String(SCHEMA_VERSION));
});

test('project files HTTP API supports binary/JSON upload, listing, safe /raw, air-tight /preview, and DELETE', async (t) => {
  const { f, url, browser, get, post, send } = await consoleApp(t);
  const pid = f.projectId;

  // Auth guard.
  assert.equal((await get(`/api/projects/${pid}/files`, {})).status, 401);

  // 1. Binary PNG upload.
  const pngRes = await fetch(`${url}/api/projects/${pid}/files`, {
    method: 'POST',
    headers: {
      ...browser,
      'Content-Type': 'image/png',
      'X-File-Name': encodeURIComponent('截图 01.png'),
      'X-File-Summary': encodeURIComponent('页面问题截图'),
    },
    body: TINY_PNG,
  });
  assert.equal(pngRes.status, 201);
  const { file: pngFile } = await json(pngRes);
  assert.equal(pngFile.name, '截图 01.png');
  assert.equal(pngFile.mime, 'image/png');
  assert.equal(pngFile.size, TINY_PNG.length);
  assert.equal(pngFile.kind, 'upload');
  assert.equal(pngFile.origin, 'owner');
  assert.equal(pngFile.summary, '页面问题截图');
  assert.equal(pngFile.is_image, true);
  assert.equal(pngFile.previewable, false);
  assert.equal('sha256' in pngFile, false);

  // 2. JSON upload of an HTML artifact.
  const htmlContent = '<!doctype html><html><head><title>Chart</title></head><body><div id="app">Hello</div></body></html>';
  const htmlRes = await post(`/api/projects/${pid}/files`, {
    name: 'reports/chart.html',
    content: htmlContent,
    summary: '交互式图表',
  }, { ...browser, 'Content-Type': 'application/json' });
  assert.equal(htmlRes.status, 201);
  const { file: htmlFile } = await json(htmlRes);
  assert.equal(htmlFile.name, 'chart.html');
  assert.equal(htmlFile.mime, 'text/html');
  assert.equal(htmlFile.kind, 'artifact');
  assert.equal(htmlFile.previewable, true);
  assert.equal(htmlFile.is_image, false);

  // 3. Binary upload of an SVG with generic octet-stream content-type (must infer image/svg+xml).
  const svgContent = '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64"/></svg>';
  const svgRes = await fetch(`${url}/api/projects/${pid}/files`, {
    method: 'POST',
    headers: {
      ...browser,
      'Content-Type': 'application/octet-stream',
      'X-File-Name': encodeURIComponent('architecture.svg'),
    },
    body: Buffer.from(svgContent, 'utf8'),
  });
  assert.equal(svgRes.status, 201);
  const { file: svgFile } = await json(svgRes);
  assert.equal(svgFile.mime, 'image/svg+xml');
  assert.equal(svgFile.kind, 'artifact');
  assert.equal(svgFile.previewable, true);

  // 4. Listing returns all three files.
  const listBody = await json(await get(`/api/projects/${pid}/files`));
  assert.equal(listBody.files.length, 3);
  assert.deepEqual(new Set(listBody.files.map((each: { id: string }) => each.id)), new Set([pngFile.id, htmlFile.id, svgFile.id]));

  // 5. /raw inline vs attachment Content-Disposition, CSP sandbox, and ETag/304.
  const pngRaw = await get(`/api/projects/${pid}/files/${pngFile.id}/raw`);
  assert.equal(pngRaw.status, 200);
  assert.equal(pngRaw.headers.get('content-type'), 'image/png');
  assert.equal(pngRaw.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(pngRaw.headers.get('content-security-policy'), "default-src 'none'; sandbox");
  assert.equal(pngRaw.headers.get('cache-control'), 'private, no-cache');
  const pngEtag = pngRaw.headers.get('etag');
  assert.ok(pngEtag && /^"[0-9a-f]{64}"$/.test(pngEtag));
  assert.equal(pngRaw.headers.get('content-disposition'), null, 'PNG should be served inline by default');
  assert.deepEqual(Buffer.from(await pngRaw.arrayBuffer()), TINY_PNG);

  // Conditional GET with matching ETag returns 304 with empty body and same ETag/Cache-Control/CSP.
  const png304 = await get(`/api/projects/${pid}/files/${pngFile.id}/raw`, { ...browser, 'If-None-Match': pngEtag });
  assert.equal(png304.status, 304);
  assert.equal(png304.headers.get('etag'), pngEtag);
  assert.equal(png304.headers.get('cache-control'), 'private, no-cache');
  assert.equal(png304.headers.get('content-security-policy'), "default-src 'none'; sandbox");
  assert.equal((await png304.arrayBuffer()).byteLength, 0);

  const pngDl = await get(`/api/projects/${pid}/files/${pngFile.id}/raw?download=1`);
  assert.equal(pngDl.status, 200);
  assert.equal(pngDl.headers.get('content-security-policy'), "default-src 'none'; sandbox");
  assert.match(pngDl.headers.get('content-disposition') ?? '', /^attachment; filename\*=UTF-8''/);

  // PDF must NOT be served inline (forces Content-Disposition: attachment) and includes CSP sandbox.
  const pdfBytes = Buffer.from('%PDF-1.4\n%EOF\n', 'utf8');
  const pdfUploadRes = await fetch(`${url}/api/projects/${pid}/files`, {
    method: 'POST',
    headers: {
      ...browser,
      'Content-Type': 'application/pdf',
      'X-File-Name': 'report.pdf',
    },
    body: pdfBytes,
  });
  assert.equal(pdfUploadRes.status, 201);
  const { file: pdfFile } = await json(pdfUploadRes);
  assert.equal(pdfFile.mime, 'application/pdf');
  const pdfRaw = await get(`/api/projects/${pid}/files/${pdfFile.id}/raw`);
  assert.equal(pdfRaw.status, 200);
  assert.equal(pdfRaw.headers.get('content-type'), 'application/pdf');
  assert.equal(pdfRaw.headers.get('content-security-policy'), "default-src 'none'; sandbox");
  assert.match(pdfRaw.headers.get('content-disposition') ?? '', /^attachment; filename\*=UTF-8''report\.pdf$/);

  // Raw .json upload with X-File-Name preserves EXACT raw JSON bytes even when containing "name" & "content" fields!
  const rawPkgJson = Buffer.from('{\n  "name": "my-pkg",\n  "content": "should not be unwrapped",\n  "version": "1.0.0"\n}\n', 'utf8');
  const jsonDirectRes = await fetch(`${url}/api/projects/${pid}/files`, {
    method: 'POST',
    headers: {
      ...browser,
      'Content-Type': 'application/json',
      'X-File-Name': 'package.json',
    },
    body: rawPkgJson,
  });
  assert.equal(jsonDirectRes.status, 201);
  const { file: jsonDirectFile } = await json(jsonDirectRes);
  assert.equal(jsonDirectFile.name, 'package.json');
  assert.equal(jsonDirectFile.mime, 'application/json');
  assert.equal(jsonDirectFile.size, rawPkgJson.length);
  const jsonDirectRaw = await get(`/api/projects/${pid}/files/${jsonDirectFile.id}/raw`);
  assert.deepEqual(Buffer.from(await jsonDirectRaw.arrayBuffer()), rawPkgJson);

  // Raw upload with Content-Type: application/octet-stream + X-File-Mime: application/json preserves MIME and raw bytes.
  const jsonOctetRes = await fetch(`${url}/api/projects/${pid}/files`, {
    method: 'POST',
    headers: {
      ...browser,
      'Content-Type': 'application/octet-stream',
      'X-File-Name': 'payload.dat',
      'X-File-Mime': 'application/json',
    },
    body: rawPkgJson,
  });
  assert.equal(jsonOctetRes.status, 201);
  const { file: jsonOctetFile } = await json(jsonOctetRes);
  assert.equal(jsonOctetFile.name, 'payload.dat');
  assert.equal(jsonOctetFile.mime, 'application/json');
  const jsonOctetRaw = await get(`/api/projects/${pid}/files/${jsonOctetFile.id}/raw`);
  assert.deepEqual(Buffer.from(await jsonOctetRaw.arrayBuffer()), rawPkgJson);

  const htmlRaw = await get(`/api/projects/${pid}/files/${htmlFile.id}/raw`);
  assert.equal(htmlRaw.status, 200);
  assert.equal(htmlRaw.headers.get('content-type'), 'text/html');
  assert.equal(htmlRaw.headers.get('content-security-policy'), "default-src 'none'; sandbox");
  assert.match(htmlRaw.headers.get('content-disposition') ?? '', /^attachment; filename\*=UTF-8''chart\.html$/);

  const svgRaw = await get(`/api/projects/${pid}/files/${svgFile.id}/raw`);
  assert.equal(svgRaw.status, 200);
  assert.equal(svgRaw.headers.get('content-type'), 'image/svg+xml');
  assert.equal(svgRaw.headers.get('content-security-policy'), "default-src 'none'; sandbox");
  assert.match(svgRaw.headers.get('content-disposition') ?? '', /^attachment; filename\*=UTF-8''architecture\.svg$/);

  // 6. /preview headers and wrapped output.
  const htmlPreview = await get(`/api/projects/${pid}/files/${htmlFile.id}/preview?theme=dark`);
  assert.equal(htmlPreview.status, 200);
  assert.equal(htmlPreview.headers.get('content-type'), 'text/html; charset=utf-8');
  assert.equal(htmlPreview.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(htmlPreview.headers.get('cache-control'), 'no-store');
  const csp = htmlPreview.headers.get('content-security-policy') ?? '';
  assert.match(csp, /\bsandbox allow-scripts\b/);
  assert.match(csp, /\bconnect-src 'none'/);
  assert.match(csp, /\bframe-ancestors 'self'/);
  assert.match(csp, /\bdefault-src 'none'/);
  const htmlPreviewBody = await htmlPreview.text();
  assert.match(htmlPreviewBody, /data-theme="dark"/);
  assert.match(htmlPreviewBody, /tycho:artifact:resize/);
  assert.match(htmlPreviewBody, /<div id="app">Hello<\/div>/);

  const svgPreview = await get(`/api/projects/${pid}/files/${svgFile.id}/preview?theme=light`);
  assert.equal(svgPreview.status, 200);
  assert.match(svgPreview.headers.get('content-security-policy') ?? '', /\bsandbox allow-scripts\b/);
  const svgPreviewBody = await svgPreview.text();
  assert.match(svgPreviewBody, /data-theme="light"/);
  assert.match(svgPreviewBody, /<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);

  // Non-previewable file rejected on /preview.
  assert.equal((await get(`/api/projects/${pid}/files/${pngFile.id}/preview`)).status, 400);

  // 7. DELETE removes DB row and disk bytes.
  const diskPath = projectFilePath(f.dir, pid, htmlFile.id);
  assert.equal(existsSync(diskPath), true);
  const delRes = await send('DELETE', `/api/projects/${pid}/files/${htmlFile.id}`);
  assert.equal(delRes.status, 200);
  assert.deepEqual(await json(delRes), { deleted: true });
  assert.equal(existsSync(diskPath), false);
  assert.equal(f.ledger.getProjectFile(pid, htmlFile.id), null);
  assert.equal((await get(`/api/projects/${pid}/files/${htmlFile.id}/raw`)).status, 404);
  assert.equal((await send('DELETE', `/api/projects/${pid}/files/${htmlFile.id}`)).status, 404);
});

test('POST /api/messages supports attachment_ids, rejects cross-project files, and hydrates attachments in conversation & messages', async (t) => {
  const { f, url, browser, get, post, send } = await consoleApp(t);
  const pid = f.projectId;
  const otherPid = f.ledger.createProject({ name: '其他项目' }, USER);

  // Upload an image in project A and another file in project B.
  const uploadA = await fetch(`${url}/api/projects/${pid}/files`, {
    method: 'POST',
    headers: { ...browser, 'Content-Type': 'image/png', 'X-File-Name': 'shot.png' },
    body: TINY_PNG,
  });
  const { file: fileA } = await json(uploadA);

  const uploadB = await fetch(`${url}/api/projects/${otherPid}/files`, {
    method: 'POST',
    headers: { ...browser, 'Content-Type': 'text/plain', 'X-File-Name': 'other.txt' },
    body: Buffer.from('other'),
  });
  const { file: fileB } = await json(uploadB);

  // Validation checks.
  assert.equal((await post('/api/messages', { text: '   ', project_id: pid })).status, 400);
  assert.equal((await post('/api/messages', { text: '', attachment_ids: [fileA.id] })).status, 400, 'attachment without project_id');
  assert.equal((await post('/api/messages', { text: '跨项目', project_id: pid, attachment_ids: [fileB.id] })).status, 400, 'cross-project attachment');
  assert.equal((await post('/api/messages', { text: '不存在', project_id: pid, attachment_ids: ['nosuch'] })).status, 400);

  // Empty text + valid image attachment succeeds.
  const sent = await post('/api/messages', { text: '', project_id: pid, attachment_ids: [fileA.id] });
  assert.equal(sent.status, 201);
  const received = await json(sent);
  assert.equal(f.ledger.getProjectFile(pid, fileA.id)?.message_id, received.id);

  // Conversation hydrates attachments.
  const conv = await json(await get(`/api/projects/${pid}/conversation`));
  const msgInConv = conv.messages.find((m: { id: string }) => m.id === received.id);
  assert.ok(msgInConv);
  assert.equal(msgInConv.attachments.length, 1);
  assert.equal(msgInConv.attachments[0].id, fileA.id);
  assert.equal(msgInConv.attachments[0].is_image, true);

  // GET /api/messages also hydrates attachments.
  const list = await json(await get(`/api/messages?project=${pid}`));
  const msgInList = list.messages.find((m: { id: string }) => m.id === received.id);
  assert.equal(msgInList.attachments.length, 1);
  assert.equal(msgInList.attachments[0].name, 'shot.png');

  // SSE message event hydration preserves attachments on state transitions (processing/processed/unverified).
  const rawRow = f.ledger.getMessage(received.id);
  const hydratedEvent = hydrateMessageEvent(f.ledger, rawRow) as { attachments?: Array<{ id: string; name: string }> };
  assert.equal(hydratedEvent.attachments?.length, 1);
  assert.equal(hydratedEvent.attachments?.[0]?.id, fileA.id);
  assert.equal(hydratedEvent.attachments?.[0]?.name, 'shot.png');
  assert.strictEqual(hydrateMessageEvent(f.ledger, hydratedEvent), hydratedEvent, '已 hydrated 的事件直接透传不重复查询');

  // Rule of Repair: deleting the attached file does not break conversation hydration.
  assert.equal((await send('DELETE', `/api/projects/${pid}/files/${fileA.id}`)).status, 200);
  const convAfterDelete = await json(await get(`/api/projects/${pid}/conversation`));
  const msgAfterDelete = convAfterDelete.messages.find((m: { id: string }) => m.id === received.id);
  assert.ok(msgAfterDelete);
  assert.equal(msgAfterDelete.attachments, undefined);
});

test('DELETE /api/projects/:id wipes project_file rows and disk dir cleanly (zero-run project and crash recovery)', async (t) => {
  // Case 1: Project with files and ZERO runs/messages -> archive -> delete -> immediate sweep wipes disk.
  {
    const { f, url, browser, post, send } = await consoleApp(t);
    const pid = f.ledger.createProject({ name: '仅文件项目' }, USER);

    const up = await fetch(`${url}/api/projects/${pid}/files`, {
      method: 'POST',
      headers: { ...browser, 'Content-Type': 'text/plain', 'X-File-Name': 'readme.txt' },
      body: Buffer.from('just a file'),
    });
    assert.equal(up.status, 201);
    const { file } = await json(up);
    const projectDir = join(f.dir, 'projects', pid);
    assert.equal(existsSync(projectFilePath(f.dir, pid, file.id)), true);

    // Must require archive first because it has files.
    const deletableBefore = f.ledger.projectDeletable(pid);
    assert.equal(deletableBefore.allowed, false);
    assert.equal(deletableBefore.reason, '先归档才能删除');
    assert.ok(deletableBefore.counts.some((c) => c.label === '文件' && c.count === 1));

    // Archive and delete.
    assert.equal((await post(`/api/projects/${pid}/archive`, { archived: true })).status, 200);
    const del = await send('DELETE', `/api/projects/${pid}`, { confirm_name: '仅文件项目' });
    assert.equal(del.status, 200);

    // DB rows gone, disk dir gone, cleanup row marked dropped.
    assert.equal(f.peek('SELECT id FROM project_file WHERE project_id = ?', pid).length, 0);
    assert.equal(existsSync(projectDir), false);
    assert.deepEqual(f.ledger.deletedProjectFilesDue(), []);
    const cleanupRows = f.peek<{ project_id: string; dropped_at: string | null }>(
      'SELECT project_id, dropped_at FROM project_files_cleanup WHERE project_id = ?',
      pid,
    );
    assert.equal(cleanupRows.length, 1);
    assert.notEqual(cleanupRows[0]!.dropped_at, null);
  }

  // Case 2: Crash recovery — immediate cleanup skipped after DELETE, then accept.sweep() recovers later.
  {
    const { f, url, browser, post, send } = await consoleApp(t, {
      cleanupAfterProjectDelete: () => {
        // Simulate crash before post-delete disk cleanup runs.
      },
    });
    const pid = f.ledger.createProject({ name: '崩溃恢复项目' }, USER);

    const up = await fetch(`${url}/api/projects/${pid}/files`, {
      method: 'POST',
      headers: { ...browser, 'Content-Type': 'image/png', 'X-File-Name': 'pic.png' },
      body: TINY_PNG,
    });
    assert.equal(up.status, 201);
    const { file } = await json(up);

    // Also attach to a message to verify FK cleanup order (project_file -> message -> project).
    assert.equal((await post('/api/messages', { text: '附带图片', project_id: pid, attachment_ids: [file.id] })).status, 201);

    assert.equal((await post(`/api/projects/${pid}/archive`, { archived: true })).status, 200);
    const del = await send('DELETE', `/api/projects/${pid}`, { confirm_name: '崩溃恢复项目' });
    assert.equal(del.status, 200);

    const projectDir = join(f.dir, 'projects', pid);
    assert.equal(existsSync(projectDir), true, '模拟崩溃后目录仍在磁盘上');
    assert.equal(f.peek('SELECT id FROM project_file WHERE project_id = ?', pid).length, 0);
    assert.deepEqual(f.ledger.deletedProjectFilesDue().map((r) => r.project_id), [pid]);

    // Restarted acceptor sweeps and clears pending project files dir.
    const restartedAcceptor = createAcceptor({ ledger: f.ledger, dataDir: f.dir });
    restartedAcceptor.sweep();

    assert.equal(existsSync(projectDir), false, 'sweep 之后目录已被彻底清理');
    assert.deepEqual(f.ledger.deletedProjectFilesDue(), []);
    const cleanupRows = f.peek<{ dropped_at: string | null }>(
      'SELECT dropped_at FROM project_files_cleanup WHERE project_id = ?',
      pid,
    );
    assert.notEqual(cleanupRows[0]!.dropped_at, null);
  }
});

test('DELETE /api/projects/:id/files/:fileId unlinks disk before deleting DB row and allows ENOENT', async (t) => {
  const { f, url, browser, send } = await consoleApp(t);
  const pid = f.ledger.createProject({ name: '单删顺序项目' }, USER);

  // 1. Disk unlink fails -> DB row MUST stay intact so retry succeeds after obstruction clears.
  {
    const up = await fetch(`${url}/api/projects/${pid}/files`, {
      method: 'POST',
      headers: { ...browser, 'Content-Type': 'text/plain', 'X-File-Name': 'locked.txt' },
      body: Buffer.from('precious bytes'),
    });
    assert.equal(up.status, 201);
    const { file } = await json(up);
    const target = projectFilePath(f.dir, pid, file.id);
    // Replace file with a non-empty directory so rmSync(target, { force: true }) without recursive fails.
    rmSync(target, { force: true });
    mkdirSync(target);
    writeFileSync(join(target, 'blocker'), 'x');

    const failed = await send('DELETE', `/api/projects/${pid}/files/${file.id}`);
    assert.equal(failed.status, 500);
    assert.ok(f.ledger.getProjectFile(pid, file.id), '磁盘删除失败时账本记录必须保留以便重试');

    // Clear obstruction and retry: now DELETE succeeds cleanly.
    rmSync(target, { recursive: true, force: true });
    writeFileSync(target, 'precious bytes');
    const retried = await send('DELETE', `/api/projects/${pid}/files/${file.id}`);
    assert.equal(retried.status, 200);
    assert.equal(f.ledger.getProjectFile(pid, file.id), null);
    assert.equal(existsSync(target), false);
  }

  // 2. Disk file already missing (ENOENT) -> DELETE succeeds cleanly and removes DB row.
  {
    const up = await fetch(`${url}/api/projects/${pid}/files`, {
      method: 'POST',
      headers: { ...browser, 'Content-Type': 'text/plain', 'X-File-Name': 'already-gone.txt' },
      body: Buffer.from('ephemeral'),
    });
    assert.equal(up.status, 201);
    const { file } = await json(up);
    rmSync(projectFilePath(f.dir, pid, file.id), { force: true });
    const res = await send('DELETE', `/api/projects/${pid}/files/${file.id}`);
    assert.equal(res.status, 200);
    assert.equal(f.ledger.getProjectFile(pid, file.id), null);
  }
});
