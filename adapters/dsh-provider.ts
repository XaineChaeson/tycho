// A dsh account is a line to a model service and that line's key (docs/design/native-login.md):
// what the console asks for it, how what it gathered is checked, and the patch a round on it
// is started with after its tier. Everything dsh-shaped about a line is here and nowhere else.
//
// After the tier, so that what makes the round this account's is structure, not a reading of
// the owner's text: dsh applies `--patch` layers in order, the last write winning per entry and
// an entry's `config` replaced whole (its own patch documentation). A tier that turns the
// stored-credential services back on, or redefines a route, is overwritten by the line.
//
// Measured on dsh 0.2.2-rc.1 against a stand-in gateway (tests/fixtures/dsh/0.2.2-rc.1/line):
// the headless profile leaves the credentials service off, and a route then takes its key
// from the launching environment — a hand-declared route from the variable its `apiKeyEnv`
// names, sent as a bearer token; the official route from DEEPSEEK_API_KEY, sent as x-api-key.
// Nothing of the key reaches the round's output or $DSH_HOME.
import type { CredentialWay, ModelInfo, Provider, ProviderDeclaration, Tier } from './types.ts';
import type { ProviderForm } from '../shared/provider-form.ts';

// The route a hand-declared line is given in the patch. dsh's own grammar for a route key is a
// lowercase hyphenated identifier; a tier names the line by it.
const CUSTOM_ROUTE = 'tycho';
const OFFICIAL_ROUTE = 'deepseek-official';
// The variable a hand-declared line's key travels in. tycho's own name: the patch that names
// it is tycho's too, so nothing on the machine has to agree with it. Not DEEPSEEK_API_KEY —
// dsh's web search reads that one and would send this line's key to DeepSeek.
const CUSTOM_KEY_ENV = 'TYCHO_DSH_API_KEY';
// The official route's own default (`apiKeyEnv` of @deepseek-ai/dsh-llm-deepseek-api-key),
// which dsh's web search shares: an official line's key serves both, as it does by hand.
const OFFICIAL_KEY_ENV = 'DEEPSEEK_API_KEY';
// The official route's endpoint, written into the round's patch: left out, dsh takes
// $DEEPSEEK_BASE_URL from the environment the round inherits (the README of
// @deepseek-ai/dsh-llm-deepseek), and a machine that points it elsewhere would send the
// account's key there.
const OFFICIAL_BASE_URL = 'https://api.deepseek.com/anthropic';
const OFFICIAL_MODELS_URL = 'https://api.deepseek.com/models';

// The wire protocols a hand-declared route may speak (the `api` enum of dsh-llm-pi-ai's
// provider schema, `dsh --dump-config-schema`).
const APIS = ['openai-completions', 'openai-responses', 'anthropic-messages'] as const;
type Api = (typeof APIS)[number];
const API_LABELS: Record<Api, string> = {
  'openai-completions': 'OpenAI Chat Completions',
  'openai-responses': 'OpenAI Responses',
  'anthropic-messages': 'Anthropic Messages',
};
// The strengths the form offers for a model: dsh's own level names (its Models page, 0.2.2-rc.1),
// each sent to the line as it is named, and `off` as leaving the reasoning field out.
const EFFORTS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
// What the patch itself writes for a route: `more` may not say these again.
const OWNED_KEYS = ['apiKeyEnv', 'api', 'baseURL', 'models', 'modelOverrides', 'displayName'];
// The services a stored credential would come from. A round of an account turns them off in
// its own patch, after the machine's profile layer and the tier: a key left in that machine's
// ~/.dsh/.credentials.yaml would otherwise win over the one the round is handed.
const CREDENTIAL_SERVICES = ['credentials', 'authorization', 'deepseek-account'];
const MORE_LIMIT = 8 * 1024;
const MAX_MODELS = 64;

interface CustomModel {
  id: string;
  efforts?: string[];
  image?: true;
}
type DshLine =
  | { line: 'official' }
  | { line: 'custom'; api: Api; baseURL: string; models: CustomModel[]; more?: string };

const FORM: ProviderForm = {
  lines: [
    {
      id: 'custom',
      route: CUSTOM_ROUTE,
      label: '自定义线路',
      hint: '你自己的网关或别家的模型服务：填它的地址、协议和提供的模型。',
      fields: [
        { name: 'baseURL', kind: 'text', label: '地址', placeholder: 'https://gateway.example.com/v1', hint: '内网地址只有够得着它的机器能用' },
        { name: 'api', kind: 'choice', label: '协议', options: APIS.map((value) => ({ value, label: API_LABELS[value] })) },
        { name: 'models', kind: 'models', label: '模型', efforts: EFFORTS, image: '能看图', hint: '这条线路提供的模型。强度是这个模型接受的推理强度，按名字原样发给线路；一个都不选就是不带推理。' },
        { name: 'more', kind: 'more', label: '线路的其他设置', hint: '按 dsh 自己的写法（YAML）原样进线路，tycho 不解析，例如 retryPolicy、compat、defaultContextWindow。密钥不要写在这里；这里写的请求头在读取模型时不带。' },
      ],
    },
    { id: 'official', route: OFFICIAL_ROUTE, label: 'DeepSeek 官方', hint: '直接连 DeepSeek 开放平台，只要一把 API 密钥。', fields: [] },
  ],
  key: { label: 'API 密钥', hint: '由 tycho 保管，每一轮只交给那一轮的进程；机器上不留。' },
};

const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

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
  // The definition is kept in the ledger and written into every round's snapshot.
  if (url.username !== '' || url.password !== '') return { problem: '地址里不要带用户名和密码：密钥填在密钥一栏' };
  return { url: text };
}

function checkModels(value: unknown): { models: CustomModel[] } | { problem: string } {
  if (!Array.isArray(value) || value.length === 0) return { problem: '至少要填一个模型' };
  if (value.length > MAX_MODELS) return { problem: `模型最多 ${MAX_MODELS} 个` };
  const models: CustomModel[] = [];
  for (const each of value) {
    const row = object(each);
    const id = oneLine(row?.id);
    if (id === undefined || /\s/.test(id)) return { problem: '每个模型都要有名字，名字里不能有空白' };
    if (models.some((model) => model.id === id)) return { problem: `模型 ${id} 写了两次` };
    const efforts = row!.efforts === undefined || row!.efforts === null ? [] : row!.efforts;
    if (!Array.isArray(efforts) || efforts.some((effort) => typeof effort !== 'string' || !/^[\w.-]+$/.test(effort))) {
      return { problem: `模型 ${id} 的强度应是一组词，例如 high、max` };
    }
    const levels = [...new Set(efforts as string[])];
    models.push({ id, ...(levels.length === 0 ? {} : { efforts: levels }), ...(row!.image === true ? { image: true as const } : {}) });
  }
  return { models };
}

// The owner's own lines for the route, kept as written. Only what would make the patch say
// one thing twice, or break out of the route's block, is refused; what the settings mean is
// dsh's to check, which refuses a route it cannot serve where the round starts.
function checkMore(value: unknown): { more?: string } | { problem: string } {
  if (value === undefined || value === null || value === '') return {};
  if (typeof value !== 'string') return { problem: '线路的其他设置应是一段文字' };
  const text = value.replace(/\r\n?/g, '\n').replace(/\s+$/, '');
  if (text.trim() === '') return {};
  if (Buffer.byteLength(text) > MORE_LIMIT) return { problem: `线路的其他设置最多 ${MORE_LIMIT / 1024} KB` };
  if (/[\t\0]/.test(text)) return { problem: '线路的其他设置里不要用制表符缩进，用空格' };
  for (const line of text.split('\n')) {
    if (line.trim() === '' || line.trim().startsWith('#')) continue;
    if (/^(---|\.\.\.)\s*$/.test(line)) return { problem: '线路的其他设置里不要写文档分隔线' };
    // A line that starts at the margin is a key of the route itself.
    if (/^\S/.test(line)) {
      const key = /^['"]?([\w.-]+)['"]?\s*:/.exec(line)?.[1];
      if (key === undefined) return { problem: `线路的其他设置里这一行不是「键: 值」：${line.slice(0, 60)}` };
      if (OWNED_KEYS.includes(key)) return { problem: `线路的其他设置里不要再写 ${key}：它由上面的表单决定` };
    }
  }
  return { more: text };
}

function check(input: unknown): { provider: Provider } | { problem: string } {
  const draft = object(input);
  if (!draft) return { problem: '线路要写成一个对象' };
  if (draft.line === 'official') return { provider: { line: 'official' } };
  if (draft.line !== 'custom') return { problem: `线路类型应为 ${FORM.lines.map(({ id }) => id).join('、')} 之一` };
  if (typeof draft.api !== 'string' || !(APIS as readonly string[]).includes(draft.api)) return { problem: `协议应为 ${APIS.join('、')} 之一` };
  const url = checkUrl(draft.baseURL);
  if ('problem' in url) return url;
  const models = checkModels(draft.models);
  if ('problem' in models) return models;
  const more = checkMore(draft.more);
  if ('problem' in more) return more;
  const line: DshLine = { line: 'custom', api: draft.api as Api, baseURL: url.url, models: models.models, ...more };
  return { provider: line };
}

// A definition as `check` left it. Anything else was never an account's line.
const lineOf = (provider: Provider): DshLine => provider as unknown as DshLine;

// A YAML scalar that cannot be read as anything but this string: JSON's double-quoted form is
// YAML's too.
const quoted = (text: string): string => JSON.stringify(text);

function routeBlock(line: Extract<DshLine, { line: 'custom' }>): string[] {
  const indent = '        ';
  const models = line.models.flatMap((model) => [
    `${indent}  - id: ${quoted(model.id)}`,
    ...(model.image ? [`${indent}    input: [text, image]`] : []),
    // Only `off` is dsh's non-reasoning model, which it spells `false`: a table of `off` alone
    // it refuses ("offers no level beyond off").
    ...(model.efforts === undefined ? []
      : model.efforts.every((effort) => effort === 'off') ? [`${indent}    reasoningEfforts: false`]
      : [`${indent}    reasoningEfforts:`, ...model.efforts.map((effort) => `${indent}      ${quoted(effort)}: ${effort === 'off' ? 'null' : quoted(effort)}`)]),
  ]);
  return [
    '- id: llm-pi-ai',
    '  config:',
    '    providers:',
    `      ${CUSTOM_ROUTE}:`,
    `${indent}apiKeyEnv: ${CUSTOM_KEY_ENV}`,
    `${indent}api: ${line.api}`,
    `${indent}baseURL: ${quoted(line.baseURL)}`,
    ...(line.more === undefined ? [] : line.more.split('\n').map((each) => (each.trim() === '' ? '' : `${indent}${each}`))),
    `${indent}models:`,
    ...models,
  ];
}

// The official route with its key's variable and its endpoint said, so that neither is the
// machine's: the rest of the entry keeps dsh's defaults (its catalog among them).
const officialBlock = (): string[] => [
  '- id: llm-deepseek',
  '  config:',
  `    apiKeyEnv: ${OFFICIAL_KEY_ENV}`,
  `    baseURL: ${quoted(OFFICIAL_BASE_URL)}`,
];

function config(provider: Provider): { file: string; text: string } {
  const line = lineOf(provider);
  const lines = [
    '# Written by tycho from the account\'s line. The key is not here: the round is handed it',
    '# in its environment, and the stored-credential services stay off so nothing kept on this',
    '# machine is used instead.',
    ...CREDENTIAL_SERVICES.flatMap((id) => [`- id: ${id}`, '  disabled: true']),
    ...(line.line === 'custom' ? routeBlock(line) : officialBlock()),
  ];
  return { file: 'line.patch.yml', text: `${lines.join('\n')}\n` };
}

const route = (provider: Provider): string => (lineOf(provider).line === 'custom' ? CUSTOM_ROUTE : OFFICIAL_ROUTE);

// `line.patch.yml` is applied after the tier patch at boot and overrides credential services
// and route definitions structurally, so no regex policing of tier YAML is needed here.
function tierProblem(_provider: Provider, _tier: Tier): string | undefined {
  return undefined;
}

function models(provider: Provider): ModelInfo[] | undefined {
  const line = lineOf(provider);
  if (line.line !== 'custom') return undefined;
  return line.models.map(({ id, efforts }) => ({ id, efforts: efforts ?? [] }));
}

// The ids a model listing names: OpenAI's `data` list, which DeepSeek's and Anthropic's own
// listings share. Nothing else of an entry is read.
function parseListing(body: string): ModelInfo[] {
  let answer: unknown;
  try {
    answer = JSON.parse(body);
  } catch {
    return [];
  }
  const data = object(answer)?.data;
  if (!Array.isArray(data)) return [];
  return data.flatMap((entry) => {
    const id = oneLine(object(entry)?.id);
    return id === undefined ? [] : [{ id }];
  });
}

// How a line is asked what it serves, the way dsh's own model discovery asks (the README of
// @deepseek-ai/dsh-llm-pi-ai): `GET {baseURL}/models` with a bearer key for the OpenAI
// protocols, Anthropic's `GET /v1/models` with x-api-key for the other.
function discover(provider: Provider, key: string): ReturnType<ProviderDeclaration['discover']> {
  const line = lineOf(provider);
  // As dsh's own official route asks it (the README of @deepseek-ai/dsh-llm-deepseek-api-key).
  if (line.line === 'official') return { url: OFFICIAL_MODELS_URL, headers: { 'x-api-key': key }, parse: parseListing };
  const base = line.baseURL.replace(/\/+$/, '');
  if (line.api === 'anthropic-messages') {
    return { url: `${base.replace(/\/v1$/, '')}/v1/models?limit=1000`, headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' }, parse: parseListing };
  }
  return { url: `${base}/models`, headers: { authorization: `Bearer ${key}` }, parse: parseListing };
}

export const dshProvider: ProviderDeclaration = { form: FORM, check, config, tierProblem, route, models, discover };

// The variable a round reads its account's key from. dsh takes a key from its environment and
// nowhere else once the stored-credential services are off; no `credentialCheck` is declared
// because there is no way to ask: a line patch turns those services off, so the launching
// environment is the only source, and dsh has no command that would say which key it took.
export const dshCredential = ({ provider }: { provider?: Provider }): CredentialWay => ({
  variable: provider !== undefined && lineOf(provider).line === 'custom' ? CUSTOM_KEY_ENV : OFFICIAL_KEY_ENV,
});
