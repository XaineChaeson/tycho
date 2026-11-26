// Stdio MCP server for the Router. It holds no state and no ledger handle: the
// service owns both, and this process lives and dies with the Claude that spawned it.
import { createInterface } from 'node:readline';
import { toJsonSchemaToolsList } from './tool-schema.ts';

interface Request {
  jsonrpc: '2.0';
  id?: number | string;
  method: string;
  params?: { protocolVersion?: string; name?: string; arguments?: unknown };
}

const INTERNAL_ERROR = -32603;
const METHOD_NOT_FOUND = -32601;

const base = `http://127.0.0.1:${process.env.TYCHO_TOOLS_PORT}`;
const token = process.env.TYCHO_TOOLS_TOKEN;

async function forward(path: string, body: unknown): Promise<unknown> {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${path} 返回 ${response.status}：${await response.text()}`);
  return response.json();
}

async function answer({ method, params }: Request): Promise<unknown> {
  switch (method) {
    case 'initialize':
      return {
        protocolVersion: params?.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'tycho', version: '0' },
        instructions: '这些工具是 tycho 账本的唯一写入口；失败信息原样来自账本。',
      };
    case 'ping':
      return {};
    case 'tools/list': {
      const result = await forward('/tools/list', {});
      return process.env.TYCHO_MCP_SCHEMA_DIALECT === 'openapi' ? result : toJsonSchemaToolsList(result);
    }
    case 'tools/call':
      // No retry: the call may have committed, and only the Router can decide what
      // to do about that.
      return forward('/tools/call', { name: params?.name, arguments: params?.arguments }).catch((err: Error) => ({
        content: [{ type: 'text', text: `编排工具调用失败：${err.message}` }],
        isError: true,
      }));
    default:
      throw Object.assign(new Error(`不支持的方法：${method}`), { code: METHOD_NOT_FOUND });
  }
}

const send = (message: unknown): void => void process.stdout.write(`${JSON.stringify(message)}\n`);

createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return;
  const request = JSON.parse(line) as Request;
  // Notifications have no id and get no reply.
  if (request.id === undefined) return;
  const { id } = request;
  answer(request).then(
    (result) => send({ jsonrpc: '2.0', id, result }),
    (err: Error & { code?: number }) =>
      send({ jsonrpc: '2.0', id, error: { code: err.code ?? INTERNAL_ERROR, message: err.message } }),
  );
});
