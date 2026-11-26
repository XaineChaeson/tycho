import type { ModelInfo, Provider, ProviderDeclaration } from './types.ts';
import type { ProviderForm } from '../shared/provider-form.ts';

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
const MAX_MODELS = 64;
const OFFICIAL_MODELS_URL = 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=100';

interface CustomModel {
  id: string;
  efforts?: string[];
}

type GeminiLine =
  | { line: 'official' }
  | { line: 'custom'; baseURL: string; models?: CustomModel[] };

const FORM: ProviderForm = {
  lines: [
    {
      id: 'custom',
      route: 'gemini-custom',
      label: '自定义 Gemini 网关',
      hint: '兼容 Gemini API 的自建网关、反代或 OAuth 代理号池（通过官方 GOOGLE_GEMINI_BASE_URL 注入给 agy）。',
      fields: [
        {
          name: 'baseURL',
          kind: 'text',
          label: '地址',
          placeholder: 'https://gemini-gateway.example.com',
          hint: '填网关根地址（http:// 或 https://）；内网地址需执行机器可达。',
        },
        {
          name: 'models',
          kind: 'models',
          label: '模型（留空则从网关读取）',
          efforts: EFFORTS,
          hint: '可点下方“从线路读取模型”自动拉取，或手填网关提供的模型名。',
        },
      ],
    },
    {
      id: 'official',
      route: 'gemini-official',
      label: 'Google AI Studio 官方',
      hint: '直连 Google 官方 generativelanguage.googleapis.com。',
      fields: [],
    },
  ],
  key: { label: 'API 密钥', hint: '由 tycho 统一保管，每一轮只注入该轮进程环境（GEMINI_API_KEY），机器上不留存。' },
};

const isObj = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const oneLine = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() !== '' && !/[\u0000-\u001f\u007f]/.test(value) ? value.trim() : undefined;

function checkUrl(value: unknown): { url: string } | { problem: string } {
  const text = oneLine(value);
  if (text === undefined || /\s/.test(text)) return { problem: '地址要填一个 http 或 https 地址' };
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return { problem: `地址 ${text} 不是一个完整的网址` };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { problem: '地址要以 http:// 或 https:// 开头' };
  if (url.username !== '' || url.password !== '') return { problem: '地址里不要带用户名和密码：密钥填在密钥一栏' };
  return { url: text.replace(/\/+$/, '') };
}

function checkModels(value: unknown): { models?: CustomModel[] } | { problem: string } {
  if (value === undefined || value === null) return {};
  if (!Array.isArray(value)) return { problem: '模型列表格式无效' };
  if (value.length === 0) return {};
  if (value.length > MAX_MODELS) return { problem: `模型最多 ${MAX_MODELS} 个` };
  const models: CustomModel[] = [];
  for (const each of value) {
    if (!isObj(each)) return { problem: '模型条目必须是对象' };
    const id = oneLine(each.id);
    if (id === undefined || /\s/.test(id)) return { problem: '每个模型都要有名字，名字里不能有空白' };
    if (models.some((model) => model.id === id)) return { problem: `模型 ${id} 写了两次` };
    const efforts = each.efforts === undefined || each.efforts === null ? [] : each.efforts;
    if (!Array.isArray(efforts) || efforts.some((effort) => typeof effort !== 'string' || !/^[\w.-]+$/.test(effort))) {
      return { problem: `模型 ${id} 的强度应是一组词，例如 low、high、max` };
    }
    const levels = [...new Set(efforts as string[])];
    models.push({ id, ...(levels.length === 0 ? {} : { efforts: levels }) });
  }
  return models.length === 0 ? {} : { models };
}

function check(input: unknown): { provider: Provider } | { problem: string } {
  if (!isObj(input)) return { problem: '线路要写成一个对象' };
  if (input.line === 'official') return { provider: { line: 'official' } };
  if (input.line !== 'custom') return { problem: `线路类型应为 ${FORM.lines.map(({ id }) => id).join('、')} 之一` };
  const url = checkUrl(input.baseURL);
  if ('problem' in url) return url;
  const models = checkModels(input.models);
  if ('problem' in models) return models;
  const line: GeminiLine = { line: 'custom', baseURL: url.url, ...models };
  return { provider: line };
}

const lineOf = (provider: Provider): GeminiLine => provider as unknown as GeminiLine;

export function geminiBaseUrl(provider: Provider | undefined): string | undefined {
  if (!provider) return undefined;
  const line = lineOf(provider);
  return line.line === 'custom' && typeof line.baseURL === 'string' && line.baseURL !== '' ? line.baseURL : undefined;
}

export function parseGeminiModelsListing(body: string): ModelInfo[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return [];
  }
  if (!isObj(parsed)) return [];
  if (Array.isArray(parsed.models)) {
    const models: ModelInfo[] = [];
    for (const raw of parsed.models) {
      if (!isObj(raw)) continue;
      if (Array.isArray(raw.supportedGenerationMethods) && !raw.supportedGenerationMethods.includes('generateContent')) continue;
      const rawName = oneLine(raw.name);
      const id = rawName?.replace(/^models\//, '').trim();
      if (!id) continue;
      const display = oneLine(raw.displayName);
      models.push({ id, ...(display && display !== id ? { name: display } : {}) });
    }
    return models;
  }
  if (Array.isArray(parsed.data)) {
    return parsed.data.flatMap((entry) => {
      if (!isObj(entry)) return [];
      const id = oneLine(entry.id)?.replace(/^models\//, '').trim();
      return id ? [{ id }] : [];
    });
  }
  return [];
}

function discover(provider: Provider, key: string): ReturnType<ProviderDeclaration['discover']> {
  const line = lineOf(provider);
  if (line.line === 'official') {
    return { url: OFFICIAL_MODELS_URL, headers: { 'x-goog-api-key': key }, parse: parseGeminiModelsListing };
  }
  const root = line.baseURL.replace(/\/+$/, '').replace(/\/v1beta$/, '');
  return {
    url: `${root}/v1beta/models?pageSize=100`,
    headers: { 'x-goog-api-key': key, authorization: `Bearer ${key}` },
    parse: parseGeminiModelsListing,
  };
}

export const geminiProvider: ProviderDeclaration = {
  form: FORM,
  check,
  config: (provider) => ({ file: 'line.json', text: `${JSON.stringify(provider, null, 2)}\n` }),
  tierProblem: () => undefined,
  route: (provider) => (lineOf(provider).line === 'custom' ? 'gemini-custom' : 'gemini-official'),
  models: (provider) => {
    const line = lineOf(provider);
    if (line.line !== 'custom' || !line.models || line.models.length === 0) return undefined;
    return line.models.map(({ id, efforts }) => ({ id, ...(efforts ? { efforts } : {}) }));
  },
  discover,
};
