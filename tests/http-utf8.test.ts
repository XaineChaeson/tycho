// Guards against a request body in another encoding (a Windows console's GBK) being
// decoded leniently and its replacement characters stored as if they were the text: every
// body reader refuses bytes that are not UTF-8 and writes nothing, and a body that may be
// left out is not taken as "nothing said" when it is merely mis-encoded.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { consoleApp, TOOL_TOKEN } from './console-helpers.ts';

const REFUSED = '请求正文不是 UTF-8 编码，没有收下';
// "你好" as GBK: not a valid UTF-8 sequence.
const GBK_HELLO = Buffer.from([0xc4, 0xe3, 0xba, 0xc3]);

function body(text: Buffer): Buffer {
  return Buffer.concat([Buffer.from('{"text":"'), text, Buffer.from('"}')]);
}

async function setup(t: TestContext) {
  const app = await consoleApp(t);
  const raw = (path: string, bytes: Buffer, headers: Record<string, string> = app.browser) =>
    fetch(`${app.url}${path}`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: bytes });
  return { ...app, raw };
}

test('a GBK message is refused with a plain answer and nothing is stored', async (t) => {
  const { f, raw, state } = await setup(t);
  const before = f.count('message');
  const response = await raw('/api/messages', body(GBK_HELLO));
  assert.equal(response.status, 400);
  assert.equal(((await response.json()) as { error: string }).error, REFUSED);
  assert.equal(f.count('message'), before);
  assert.equal(state.kicks, 0);
});

test('a UTF-8 message sent as raw bytes is stored as written', async (t) => {
  const { f, raw } = await setup(t);
  const response = await raw('/api/messages', body(Buffer.from('你好，世界', 'utf8')));
  assert.equal(response.status, 201);
  const { id } = (await response.json()) as { id: string };
  assert.equal(f.ledger.getMessage(id).text, '你好，世界');
});

test('the tool interface refuses a GBK body the same way', async (t) => {
  const { f, raw, state } = await setup(t);
  state.current = f.ledger.receiveMessage({ channel: 'console', externalId: 'm', actor: 'console', text: '建项目' }).id;
  const before = f.ledger.listProjects().length;
  const call = Buffer.concat([
    Buffer.from('{"name":"create_project","arguments":{"name":"'),
    GBK_HELLO,
    Buffer.from('","accounts":[]}}'),
  ]);
  const response = await raw('/tools/call', call, { Authorization: `Bearer ${TOOL_TOKEN}` });
  assert.equal(response.status, 400);
  assert.equal(((await response.json()) as { error: string }).error, REFUSED);
  assert.equal(f.ledger.listProjects().length, before);
});

test('a body that may be left out is still refused when it is not UTF-8', async (t) => {
  const { raw } = await setup(t);
  const response = await raw('/api/releases/run-1/launch?confirm=1', body(GBK_HELLO));
  assert.equal(response.status, 400);
  assert.equal(((await response.json()) as { error: string }).error, REFUSED);
});
