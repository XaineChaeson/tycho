// The knowledge MCP (docs/design/knowledge-and-skills.md §4.3): a stdio server for a Claude
// Code, Codex, dsh or Gemini (agy) session that tycho did not dispatch. It holds no ledger and reads no
// file of its own accord: every call goes to the host, by one of two ways in.
//   - On the host's own machine: the inside listener, on the loopback, with the knowledge
//     token (TYCHO_KNOWLEDGE_TOKEN).
//   - On a machine that joined as a node (`--node`): that machine's node channel to the host,
//     with its node token, and the knowledge token in a header of its own.
// What the host says comes back as it said it. When the host cannot be reached the answer
// says the knowledge service is unavailable — never an empty result, never a fallback to
// whatever memory files the session has.
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { KNOWLEDGE_MCP, NOT_FOUND_IN_SCOPE, SERVICE_UNAVAILABLE } from '../shared/knowledge.ts';
import { dataDirFromEnv, localUrl, serviceFile } from './config.ts';
import { existingIdentity, readToken } from '../node/client.ts';
import { readOrigin } from '../node/cli.ts';
import { toJsonSchemaToolsList } from './tool-schema.ts';

const INTERNAL_ERROR = -32603;
const METHOD_NOT_FOUND = -32601;
const REQUEST_TIMEOUT_MS = 30_000;

interface Request {
  jsonrpc: '2.0';
  id?: number | string;
  method: string;
  params?: { protocolVersion?: string; name?: string; arguments?: unknown };
}

// Where one call goes and what it shows, worked out at each call: a service restarted on
// another port, or a node that joined again, is found the next time.
interface Endpoint {
  url: string;
  headers: Record<string, string>;
}

class Unavailable extends Error {}

function endpointFor(options: { node: boolean; url?: string; token?: string; dataDir?: () => string }): () => Endpoint {
  const token = options.token ?? '';
  return (): Endpoint => {
    if (token === '') throw new Unavailable('没有设 TYCHO_KNOWLEDGE_TOKEN：到控制台的知识页签发一个令牌，填进这个 MCP 的环境变量');
    if (options.url && !options.node) return { url: `${options.url.replace(/\/$/, '')}/api/knowledge/mcp`, headers: { Authorization: `Bearer ${token}` } };
    const dataDir = (options.dataDir ?? dataDirFromEnv)();
    if (options.node) {
      const identity = existingIdentity(dataDir);
      const nodeToken = identity && readToken(identity);
      const origin = identity && (options.url ?? readOrigin(identity));
      if (!identity || !nodeToken || !origin) throw new Unavailable(`这台机器还没有接入主机（${dataDir} 下没有机器身份）：先运行 tycho node join`);
      return { url: `${origin}/api/node/knowledge/mcp`, headers: { Authorization: `Bearer ${nodeToken}`, 'X-Tycho-Knowledge-Token': token } };
    }
    let port: number | undefined;
    try {
      port = (JSON.parse(readFileSync(serviceFile(dataDir), 'utf8')) as { port?: number }).port;
    } catch {
      port = undefined;
    }
    if (typeof port !== 'number') throw new Unavailable(`这台电脑上的 tycho 服务没有在运行（${serviceFile(dataDir)} 不在）`);
    return { url: localUrl(port, '/api/knowledge/mcp'), headers: { Authorization: `Bearer ${token}` } };
  };
}

async function forward(endpoint: () => Endpoint, body: unknown): Promise<unknown> {
  const { url, headers } = endpoint();
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    throw new Unavailable(`连不上 ${new URL(url).origin}：${(err as Error).message}`);
  }
  const text = await response.text();
  if (!response.ok) {
    let message = text;
    try {
      message = (JSON.parse(text) as { error?: string }).error ?? text;
    } catch {}
    throw new Unavailable(`主机回答 ${response.status}：${message}`);
  }
  return JSON.parse(text) as unknown;
}

const failed = (err: unknown) => ({
  content: [{ type: 'text', text: `${SERVICE_UNAVAILABLE}：${(err as Error).message}。这不是“${NOT_FOUND_IN_SCOPE}”：知识这次没读到，不要改去读本地的旧记忆文件` }],
  isError: true,
});

async function answer(endpoint: () => Endpoint, { method, params }: Request, schemaDialect?: string): Promise<unknown> {
  switch (method) {
    case 'initialize':
      return {
        protocolVersion: params?.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: KNOWLEDGE_MCP, version: '0' },
        instructions: 'tycho 的知识库：已经生效的工作方法和项目知识（经独立把关通过，或者主人写的、点过头的；主人审阅在生效之后）。处理一个项目前用 get_working_context 读；有可复用的结论时用 propose_learning 提议（只提议：先由独立的把关任务查，通过才生效）。工具说“知识服务不可用”时就是没读到，不要改读本地的旧记忆文件。',
      };
    case 'ping':
      return {};
    case 'tools/list': {
      const result = await forward(endpoint, { method: 'tools/list' });
      return schemaDialect === 'openapi' ? result : toJsonSchemaToolsList(result);
    }
    case 'tools/call':
      // No retry: a proposal may have been taken. Its request_id is what makes a retry safe.
      return forward(endpoint, { method: 'tools/call', name: params?.name, arguments: params?.arguments }).catch(failed);
    default:
      throw Object.assign(new Error(`不支持的方法：${method}`), { code: METHOD_NOT_FOUND });
  }
}

function serveKnowledgeMcp(endpoint: () => Endpoint, input: Readable = process.stdin, output: Writable = process.stdout, schemaDialect?: string): Promise<void> {
  const send = (message: unknown): void => void output.write(`${JSON.stringify(message)}\n`);
  const pending = new Set<Promise<void>>();
  const lines = createInterface({ input });
  lines.on('line', (line) => {
    if (!line.trim()) return;
    let request: Request;
    try {
      request = JSON.parse(line) as Request;
    } catch {
      send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: '不是 JSON' } });
      return;
    }
    // Notifications have no id and get no reply.
    if (request.id === undefined) return;
    const { id } = request;
    const done = answer(endpoint, request, schemaDialect).then(
      (result) => send({ jsonrpc: '2.0', id, result }),
      (err: Error & { code?: number }) => send({ jsonrpc: '2.0', id, error: { code: err.code ?? INTERNAL_ERROR, message: err instanceof Unavailable ? `${SERVICE_UNAVAILABLE}：${err.message}` : err.message } }),
    ).finally(() => pending.delete(done));
    pending.add(done);
  });
  return new Promise((resolve) => lines.on('close', () => void Promise.allSettled([...pending]).then(() => resolve())));
}

// `tycho knowledge-mcp [--node] [--url <地址>]`, or this file run by node directly.
export function knowledgeMcpMain(args: readonly string[], env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const node = args.includes('--node');
  const at = args.indexOf('--url');
  const url = at >= 0 ? args[at + 1] : env.TYCHO_KNOWLEDGE_URL || undefined;
  return serveKnowledgeMcp(
    endpointFor({ node, ...(url ? { url } : {}), ...(env.TYCHO_KNOWLEDGE_TOKEN ? { token: env.TYCHO_KNOWLEDGE_TOKEN } : {}) }),
    process.stdin,
    process.stdout,
    env.TYCHO_MCP_SCHEMA_DIALECT,
  );
}

if (import.meta.main) await knowledgeMcpMain(process.argv.slice(2));
