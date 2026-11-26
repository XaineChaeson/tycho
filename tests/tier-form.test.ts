// Guards a tier the console writes from being a tier the machine reads differently: a value
// the shape cannot read back, so the next open shows an empty box for something the text
// says; an item the form does not manage being dropped when the model changes; a text the
// shape cannot read showing as nothing set, so saving writes over it; a form writing a text
// its own adapter would refuse or silently drop; a strength outside the executor's declared
// list being lost; and an executor whose form the console cannot find.
import './guard.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { claudeAdapter } from '../adapters/claude.ts';
import { codexAdapter } from '../adapters/codex.ts';
import { dshAdapter } from '../adapters/dsh.ts';
import { geminiAdapter } from '../adapters/gemini.ts';
import type { Adapter } from '../adapters/types.ts';
import { GEMINI_SETTINGS_JSON, KEY_VALUE_LINES, PATCH_LIST, SETTINGS_JSON, shapeOf, tierFormSpec, type TierShape, type TierValues } from '../shared/tier-form.ts';

const PLAIN: TierValues = { provider: '', model: '<模型名>', effort: 'high' };
const WITH_PROVIDER: TierValues = { provider: 'deepseek-official', model: '<模型名>', effort: 'max' };

// The text an account already holds, with items the form does not manage: a permissions
// block, a sandbox line, another patch entry under a comment.
const CLAUDE_TEXT = ['{', '  "model": "<旧模型>",', '  "effortLevel": "low",', '  "permissions": {', '    "defaultMode": "acceptEdits"', '  }', '}', ''].join('\n');
const CODEX_TEXT = 'model=<旧模型>\nmodel_reasoning_effort=low\nsandbox_mode=danger-full-access\n';
const DSH_TEXT = ['# 主人写的注释', '- id: agent-default-model', '  config:', '    provider: deepseek-official', '    model: <旧模型>', '    reasoningEffort: high', '- id: credentials', '  config:', '    disabled: false', ''].join('\n');

const GEMINI_TEXT = JSON.stringify({ disableSlashCommands: true, model: PLAIN.model, effort: PLAIN.effort }, null, 2);

const SHAPES: [string, TierShape, string, TierValues][] = [
  ['claude 的 settings', SETTINGS_JSON, CLAUDE_TEXT, PLAIN],
  ['codex 的键值行', KEY_VALUE_LINES, CODEX_TEXT, PLAIN],
  ['dsh 的 patch', PATCH_LIST, DSH_TEXT, WITH_PROVIDER],
  ['gemini 的 settings', GEMINI_SETTINGS_JSON, GEMINI_TEXT, PLAIN],
];

test('each shape writes a tier it can read back, for the text it already had', () => {
  for (const [what, shape, kept, values] of SHAPES) {
    assert.deepEqual(shape.parse(shape.render(values, kept)), values, `${what}：写出来的读不回来`);
    assert.deepEqual(shape.parse(shape.render(values, '')), values, `${what}：从空文本写出来的读不回来`);
  }
  // A value that is not set is written as nothing, not as an empty assignment.
  const bare = SETTINGS_JSON.render({ provider: '', model: '<模型名>', effort: '' }, '');
  assert.deepEqual(JSON.parse(bare), { model: '<模型名>' });
  assert.equal(KEY_VALUE_LINES.render({ provider: '', model: '<模型名>', effort: '' }, ''), 'model=<模型名>\n');
  assert.deepEqual(PATCH_LIST.render({ provider: '', model: '<模型名>', effort: '' }, '').split('\n'), ['- id: agent-default-model', '  config:', '    model: <模型名>', '']);
});

test('an item the form does not manage keeps the bytes it was written with', () => {
  const settings = JSON.parse(SETTINGS_JSON.render(PLAIN, CLAUDE_TEXT)) as Record<string, unknown>;
  assert.deepEqual(settings.permissions, { defaultMode: 'acceptEdits' }, 'claude：权限块被换模型冲掉了');
  assert.equal(settings.model, '<模型名>');
  assert.equal(settings.effortLevel, 'high');
  assert.deepEqual(KEY_VALUE_LINES.render(PLAIN, CODEX_TEXT).split('\n'),
    ['model=<模型名>', 'model_reasoning_effort=high', 'sandbox_mode=danger-full-access', ''], 'codex：改了模型就重写了别的行');
  // dsh: the comment, the other entry and its config are where they were, as they were.
  const patch = PATCH_LIST.render(WITH_PROVIDER, DSH_TEXT).split('\n');
  assert.deepEqual(patch.slice(0, 3), ['# 主人写的注释', '- id: agent-default-model', '  config:']);
  assert.deepEqual(patch.slice(6), ['- id: credentials', '  config:', '    disabled: false', ''], 'dsh：别的条目被动过');
  // Setting a value the text did not have writes one line, and clearing one takes its line
  // away: a value that is not set says nothing in the text either.
  const added = PATCH_LIST.render({ provider: '', model: '<模型名>', effort: 'max' }, DSH_TEXT).split('\n');
  assert.deepEqual(added.slice(0, 7), ['# 主人写的注释', '- id: agent-default-model', '  config:', '    model: <模型名>', '    reasoningEffort: max', '- id: credentials', '  config:']);
});

test('an empty text reads as nothing set, and a text the shape cannot read says so', () => {
  for (const [what, shape] of SHAPES) {
    assert.deepEqual(shape.parse(''), { provider: '', model: '', effort: '' }, `${what}：空文本`);
    assert.deepEqual(shape.parse('  \n\n'), { provider: '', model: '', effort: '' }, `${what}：只有空白的文本`);
    assert.equal(shape.advanced(''), 0, `${what}：空文本的高级项`);
  }
  assert.equal(SETTINGS_JSON.parse('{"model":'), undefined);
  assert.equal(SETTINGS_JSON.parse('[1, 2]'), undefined);
  assert.equal(KEY_VALUE_LINES.parse('model=<模型名>\nhigh\n'), undefined);
  assert.equal(PATCH_LIST.parse('id: agent-default-model\n'), undefined);
  // What cannot be read is not thrown away: there was nothing to render from anyway.
  const unreadable: [string, TierShape, string][] = [['claude', SETTINGS_JSON, '{"model":'], ['codex', KEY_VALUE_LINES, 'high'], ['dsh', PATCH_LIST, 'id: x\n']];
  for (const [what, shape, text] of unreadable) assert.equal(shape.render(PLAIN, text), text, `${what}：读不出来的文本被 render 重写了`);
});

test('the row can say how many items the form does not manage', () => {
  assert.equal(SETTINGS_JSON.advanced(CLAUDE_TEXT), 1, 'claude：permissions 没算进去');
  assert.equal(SETTINGS_JSON.advanced(SETTINGS_JSON.render(PLAIN, CLAUDE_TEXT)), 1, 'claude：改过模型之后算错了');
  assert.equal(SETTINGS_JSON.advanced('{"model":"m","effortLevel":"high"}'), 0);
  assert.equal(KEY_VALUE_LINES.advanced(CODEX_TEXT), 1, 'codex：sandbox_mode 没算进去');
  assert.equal(KEY_VALUE_LINES.advanced('model=m\nmodel_reasoning_effort=high\n'), 0);
  // dsh: the other entry counts as one thing, and a setting of this entry's own that the
  // form does not manage counts as one; a comment and a blank line are neither.
  assert.equal(PATCH_LIST.advanced(DSH_TEXT), 1);
  assert.equal(PATCH_LIST.advanced(DSH_TEXT.replace('    model: <旧模型>', '    model: <旧模型>\n    temperature: 0.2')), 2);
  assert.equal(PATCH_LIST.advanced('- id: agent-default-model\n  config:\n    model: m\n'), 0);
});

// What the console offers as a strength comes from the declaration; a value it does not
// list is the owner's own text and rides it as it stands.
test('a strength outside the declared list is read and written as it stands', () => {
  const text = 'model=<模型名>\nmodel_reasoning_effort=max\n';
  assert.equal(KEY_VALUE_LINES.parse(text)!.effort, 'max');
  assert.equal(KEY_VALUE_LINES.render({ provider: '', model: '<模型名>', effort: 'max' }, text), text);
});

// The owner fills the boxes in whatever order they like; the text has to read the same each
// time, or two tiers that say the same thing would look different in the ledger.
test('the boxes filled in any order write the same text', () => {
  const want = ['- id: agent-default-model', '  config:', '    provider: p', '    model: <模型名>', '    reasoningEffort: high', ''];
  const orders: TierValues[][] = [
    [{ provider: '', model: '<模型名>', effort: '' }, { provider: '', model: '<模型名>', effort: 'high' }, { provider: 'p', model: '<模型名>', effort: 'high' }],
    [{ provider: '', model: '', effort: 'high' }, { provider: 'p', model: '', effort: 'high' }, { provider: 'p', model: '<模型名>', effort: 'high' }],
    [{ provider: 'p', model: '', effort: '' }, { provider: 'p', model: '<模型名>', effort: 'high' }],
  ];
  for (const steps of orders) {
    let text = '';
    for (const values of steps) text = PATCH_LIST.render(values, text);
    assert.deepEqual(text.split('\n'), want, `${JSON.stringify(steps)}`);
  }
});

test('every adapter declares a form the console can find, with nothing a JSON answer cannot carry', () => {
  const adapters: [string, Adapter][] = [['claude', claudeAdapter], ['codex', codexAdapter], ['dsh', dshAdapter], ['gemini', geminiAdapter]];
  for (const [name, adapter] of adapters) {
    const form = adapter.tierForm;
    assert.ok(form, `${name} 没有声明档位表单`);
    assert.deepEqual([...form!.fields].sort(), name === 'dsh' ? ['effort', 'model', 'provider'] : ['effort', 'model'], `${name} 的表单字段`);
    assert.ok(form!.efforts.length > 0, `${name} 没有声明这个执行器接受的强度取值`);
    const spec = tierFormSpec(form!);
    assert.deepEqual(Object.keys(spec).sort(), ['efforts', 'fields', 'format'], `${name} 的声明里有带不走的东西`);
    assert.deepEqual(spec, JSON.parse(JSON.stringify(spec)), `${name} 的声明过不了 JSON`);
    assert.ok(shapeOf(spec), `${name} 的 shape 在控制台找不到：${spec.format}`);
  }
  assert.equal(shapeOf(undefined), undefined);
  assert.equal(shapeOf({ format: '没有这个形状', fields: ['model'], efforts: [] }), undefined);
});

// A form that could write a tier its own adapter refuses would put the refusal on the next
// save, after the owner has left the row: the form's own text has to be one the executor takes.
test('a tier the form writes is a tier the adapter itself takes', () => {
  const cases: [string, Adapter, string, TierValues][] = [
    // Not CLAUDE_TEXT: its permissions block is a setting no tier may carry (roles-and-tiers.md
    // §5), which the form keeps as it was and the adapter refuses on its own account.
    ['claude', claudeAdapter, CLAUDE_TEXT.replace('"permissions"', '"env"').replace('"defaultMode": "acceptEdits"', '"A": "1"'), PLAIN],
    ['codex', codexAdapter, CODEX_TEXT.replace('sandbox_mode=danger-full-access', 'model_verbosity=low'), PLAIN],
    ['dsh', dshAdapter, DSH_TEXT, WITH_PROVIDER],
    ['gemini', geminiAdapter, GEMINI_TEXT, PLAIN],
  ];
  for (const [name, adapter, kept, values] of cases) {
    for (const from of [kept, '']) {
      const text = adapter.tierForm!.render(values, from);
      assert.equal(adapter.checkTier!({ kind: 'content', text }), undefined, `${name}：表单写出来的档位执行器不收：${text}`);
    }
  }
});

test('Codex 表单读取带引号的模型和强度', () => {
  assert.deepEqual(KEY_VALUE_LINES.parse('model="example-model"\nmodel_reasoning_effort="high"\n'), { provider: '', model: 'example-model', effort: 'high' });
});
