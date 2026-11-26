// Guards against the models an executor reports being made up rather than read: a model
// the executor hides offered as if it were usable, strengths taken from one global table
// instead of the model's own answer, a display name where the executor writes the id, an
// answer that cannot be read coming back as "no models" over a list an account already
// has, and the account's token reaching anything but the request's own headers.
import './guard.ts';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { claudeAdapter } from '../adapters/claude.ts';
import { codexAdapter } from '../adapters/codex.ts';
import { dshAdapter } from '../adapters/dsh.ts';
import type { ModelInfo, ModelQuery } from '../adapters/types.ts';

const CLAUDE = join(import.meta.dirname, 'fixtures', 'claude', 'models');
const CODEX = join(import.meta.dirname, 'fixtures', 'codex', '0.162.0');
const DSH = join(import.meta.dirname, 'fixtures', 'dsh', '0.2.2-rc.1');
const read = (path: string): string => readFileSync(path, 'utf8');

// What one model of a list says, for showing a whole list at once.
const shape = ({ id, name, efforts, defaultEffort, hidden }: ModelInfo) => ({ id, ...(name ? { name } : {}), ...(efforts ? { efforts } : {}), ...(defaultEffort ? { defaultEffort } : {}), ...(hidden ? { hidden } : {}) });
const ids = (models: readonly ModelInfo[]): string[] => models.map((model) => model.id);

test('claude 身份协议只在适配器声明：模型响应头认组织', () => {
  const models = claudeAdapter.listModels!({ token: 'fake' });
  assert.ok(models.kind === 'http');
  assert.deepEqual(models.identity!(new Headers({ 'anthropic-organization-id': ' org-fake ' })), { organizationId: 'org-fake' });
  assert.deepEqual(models.identity!(new Headers()), {});
});

function query(adapter: typeof claudeAdapter, context: { token?: string }): ModelQuery {
  const declared = adapter.listModels?.(context);
  assert.ok(declared, '这个执行器应该声明怎么问模型');
  return declared;
}

// -- Codex: the CLI's own catalog, recorded on codex-cli 0.162.0 --------------------------

test('codex reads its own catalog: slug is the id, the name is its own, and a hidden model is marked', () => {
  const query = codexAdapter.listModels?.({});
  assert.deepEqual(query?.kind === 'command' ? query.argv : null, ['codex', 'debug', 'models']);
  const models = query!.parse(read(join(CODEX, 'models.json')));
  assert.equal(models.length, 10);
  assert.deepEqual(ids(models).slice(0, 2), ['gpt-6.1-sol', 'gpt-6-astra']);
  // The id is the slug, which is what a tier writes; the name is only for showing.
  assert.deepEqual(shape(models[0]!), { id: 'gpt-6.1-sol', name: 'GPT-6.1-Sol', efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], defaultEffort: 'low' });
  // Two models are `visibility: "hide"`: the CLI's own picker leaves them out, and so does
  // the console. They are still reported with what they take.
  assert.deepEqual(models.filter((model) => model.hidden).map((model) => model.id), ['gpt-reserve', 'codex-auto-review']);
  assert.deepEqual(models.find((model) => model.id === 'gpt-reserve')!.efforts, ['low', 'medium', 'high', 'xhigh', 'max']);
  // The strengths are each model's own: the recorded list has six for some and five for
  // others, so one table for every model would be wrong.
  assert.notDeepEqual(models.find((model) => model.id === 'gpt-6.1-sol')!.efforts, models.find((model) => model.id === 'gpt-reserve')!.efforts);
});

test('codex: an answer that is not its catalog yields nothing, never a made-up model', () => {
  const parse = query(codexAdapter, {}).parse;
  for (const text of ['', 'not json', '{}', '{"models":null}', '{"models":[{},"x",{"slug":7}]}', '[]']) {
    assert.deepEqual(parse(text), [], text);
  }
});

// -- Claude Code: the account's own token, or the aliases its help writes ------------------

test('claude with a token asks the API with it, and reads each model\'s own strengths', () => {
  const asked = query(claudeAdapter, { token: '<令牌>' });
  assert.equal(asked.kind, 'http');
  assert.ok(asked.kind === 'http');
  assert.equal(asked.url, 'https://api.anthropic.com/v1/models?limit=100');
  // The token is in the header it belongs in, and nowhere else of what is declared.
  assert.deepEqual(asked.headers, {
    Authorization: 'Bearer <令牌>',
    'anthropic-version': '2023-06-01',
    'anthropic-beta': 'oauth-2025-04-20',
  });
  assert.equal(JSON.stringify({ url: asked.url }).includes('<令牌>'), false);
  const models = asked.parse(read(join(CLAUDE, 'models.json')));
  assert.deepEqual(models.map(shape), [
    { id: '<模型甲>', name: '<模型甲>', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
    // `supported: false` is not a strength the model takes: xhigh and max are left out.
    { id: '<模型乙>', name: '<模型乙>', efforts: ['low', 'medium', 'high'] },
    { id: '<模型丙>', name: '<模型丙>', efforts: ['medium', 'high'] },
  ]);
});

test('claude without a token falls back to what its help writes, and an answer it cannot read leaves the list empty', () => {
  const asked = query(claudeAdapter, {});
  assert.deepEqual(asked.kind === 'command' ? asked.argv : null, ['claude', '--help']);
  const models = asked.parse(read(join(CLAUDE, 'help.txt')));
  // The aliases the help names, each with the levels `--effort` takes. The block wraps
  // over two lines, and the levels are read out of the parentheses.
  assert.deepEqual(models.map(shape), [
    { id: '<别名甲>', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
    { id: '<别名乙>', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
    { id: '<别名丙>', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  ]);
  for (const text of ['', 'Usage: claude\n\nOptions:\n  -v, --version  Output the version number\n']) {
    assert.deepEqual(asked.parse(text), [], text);
  }
  // A help whose aliases are written without quotes still says something.
  assert.deepEqual(ids(asked.parse('Options:\n  --model <model>  Model for the current session (alias-b, alias-a)\n  --effort <level>  Effort level (low, high)\n')), ['alias-b', 'alias-a']);
  // Aliases without any level: the model is still offered, with no strengths of its own.
  assert.deepEqual(asked.parse('Options:\n  --model <model>  Provide an alias (e.g. \'<别名甲>\') or a full model name\n').map(shape), [{ id: '<别名甲>' }]);
});

// -- dsh: whatever the dump itself writes down ---------------------------------------------

test('dsh reads the models a dump writes down, and leaves the list empty when it writes none', () => {
  const asked = query(dshAdapter, {});
  // The dump is of the profile a round boots: without one the launcher prints nothing.
  assert.deepEqual(asked.kind === 'command' ? asked.argv : null, ['dsh', '--profile', 'headless', '--dump-config']);
  const dump = [
    'agent-default-model:',
    '  config:',
    '    provider: <线路>',
    '    models:',
    '      - id: <模型甲>',
    '        name: <模型甲的名字>',
    '        efforts: [low, high]',
    '        defaultEffort: high',
    '      - <模型乙>',
    '      - id: <模型丙>',
    '        visibility: hide',
    'gateway:',
    '  config:',
    '    models: [<模型丁>]',
  ].join('\n');
  assert.deepEqual(asked.parse(dump).map(shape), [
    { id: '<模型甲>', name: '<模型甲的名字>', efforts: ['low', 'high'], defaultEffort: 'high' },
    { id: '<模型乙>' },
    { id: '<模型丙>', hidden: true },
    { id: '<模型丁>' },
  ]);
  // A route that writes no models is not guessed at: the owner fills those in.
  for (const text of ['', 'agent-default-model:\n  config:\n    provider: <线路>\n', 'models: []', 'not: [a dump']) {
    assert.deepEqual(asked.parse(text), [], text);
  }
});

test('dsh reads from a real dump the one model the profile is set up to run, and no other entry\'s', () => {
  const asked = query(dshAdapter, {});
  // Recorded: the shipped headless profile writes no models block, only its default model.
  assert.deepEqual(asked.parse(read(join(DSH, 'dump-config-headless.yml'))).map(shape), [{ id: 'deepseek-flash' }]);
  // The default named again by a route's own list is one model, not two.
  const both = '- id: agent-default-model\n  config:\n    provider: <线路>\n    model: <模型甲>\n- id: route\n  config:\n    models: [<模型甲>, <模型乙>]\n';
  assert.deepEqual(asked.parse(both).map(shape), [{ id: '<模型甲>' }, { id: '<模型乙>' }]);
  // A model key under any other entry is that plugin's own setting, not what a round runs on.
  assert.deepEqual(asked.parse('- id: web\n  config:\n    model: <别的>\n- id: agent-default-model\n  name: x\n'), []);
});

test('the answers recorded from a real account read as models with their own strengths', () => {
  const api = claudeAdapter.listModels!({ token: 'recorded-token' } as never) as Extract<ModelQuery, { kind: 'http' }>;
  const models = api.parse(read(join(CLAUDE, 'recorded.json')));
  assert.ok(models.length > 0);
  for (const model of models) {
    assert.ok(model.id && !model.id.includes(' '), `不是 id：${model.id}`);
    assert.ok(model.efforts === undefined || Array.isArray(model.efforts));
  }
  assert.ok(models.some(({ efforts }) => efforts?.includes('high')));
  // The answer writes a flag of its own beside the strengths.
  assert.ok(models.every(({ efforts }) => !efforts?.includes('supported')));
  const help = claudeAdapter.listModels!({} as never) as Extract<ModelQuery, { kind: 'command' }>;
  const aliases = help.parse(read(join(CLAUDE, 'help.recorded.txt')));
  assert.ok(aliases.length > 0, '帮助里读不出别名');
  assert.ok(aliases.every(({ efforts }) => efforts?.includes('high')));
});

test('gemini parses agy models TSV recording and dynamic --help efforts, ignoring unparseable lines', async () => {
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { geminiAdapter } = await import('../adapters/gemini.ts');
  const query = geminiAdapter.listModels!({});
  assert.equal(query.kind, 'command');
  if (query.kind !== 'command') return;
  assert.deepEqual(query.argv, ['agy', 'models']);
  assert.deepEqual(query.extraArgv, ['agy', '--help']);
  const stdout = readFileSync(join(import.meta.dirname, 'fixtures', 'gemini', '1.5.9-win', 'models.stdout'), 'utf8');
  const models = query.parse(stdout);
  assert.equal(models.length, 22);
  assert.deepEqual(models[0], { id: 'gemini-4-carbon-medium', name: 'Gemini 4 Carbon (Medium)' });
  assert.deepEqual(models.at(-1), { id: 'gpt-oss-120b-medium', name: 'GPT-OSS 120B (Medium)' });
  const helpOut = 'Usage of agy:\n  --effort  Reasoning effort for the current CLI session (low|medium|high|xhigh|max)\n';
  const withEfforts = query.parse(stdout, helpOut);
  assert.deepEqual(withEfforts[0], {
    id: 'gemini-4-carbon-medium',
    name: 'Gemini 4 Carbon (Medium)',
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
  });
  assert.deepEqual(query.parse(''), []);
  assert.deepEqual(query.parse('\n  \n\tmissing-id\n'), []);
});
