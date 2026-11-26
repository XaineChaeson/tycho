// What the console's tier form edits, and how each executor's own text is written from it.
// One implementation for both sides: an adapter declares a shape here and the console reads
// the same shape back by its name, so a form and a machine cannot come to say different
// things about a tier. Nothing here reassembles a value it did not have to — what the form
// cannot edit keeps the bytes the owner wrote.

export type TierFieldName = 'provider' | 'model' | 'effort';

// The values the form edits. Every one is a string, and '' means the text says nothing about
// it. What a value means is the executor's own business, and it is written as it stands.
export interface TierValues {
  provider: string;
  model: string;
  effort: string;
}

const NOTHING_SET: TierValues = { provider: '', model: '', effort: '' };

export interface TierShape {
  // Which shape this is: an adapter declares one, and the console finds it here by name.
  format: string;
  // The whole text for these values, with everything else kept from `kept`. A text this
  // shape cannot read is left as it stands: there is nothing the form could render from it.
  render(values: TierValues, kept: string): string;
  // What the form reads out of a text; undefined when the text says something this shape
  // cannot read. A blank text is not that: it reads as nothing set.
  parse(text: string): TierValues | undefined;
  // How many items in the text the form does not manage.
  advanced(text: string): number;
}

// An adapter's declaration: the shape, which values its form edits, and the strengths the
// executor's own command takes.
export interface TierForm extends TierShape {
  fields: readonly TierFieldName[];
  efforts: readonly string[];
}

// What the console is told of that declaration: the functions stay on this side.
export interface TierFormSpec {
  format: string;
  fields: TierFieldName[];
  efforts: string[];
}

export const tierFormSpec = ({ format, fields, efforts }: TierForm): TierFormSpec => ({
  format,
  fields: [...fields],
  efforts: [...efforts],
});

export const shapeOf = (spec: TierFormSpec | undefined): TierShape | undefined =>
  spec === undefined ? undefined : TIER_SHAPES[spec.format];

// The lines of a text as the console and the executor's own command both read them: a
// carriage return is the console's line ending, not part of a value.
const linesOf = (text: string): string[] => text.split('\n').map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));

// The lines that carry something, with the line they were written on.
export function valueLines(text: string): { at: number; line: string }[] {
  return linesOf(text)
    .map((line, index) => ({ at: index + 1, line }))
    .filter(({ line }) => line.trim() !== '');
}

const said = (value: unknown): string => (typeof value === 'string' ? value : '');

// A text the form wrote: a trailing blank line is a text file's ending, not a setting, and a
// text with nothing in it is nothing at all.
function written(lines: readonly string[]): string {
  const text = lines.join('\n').replace(/\n+$/, '');
  return text.trim() === '' ? '' : `${text}\n`;
}

// -- Settings JSON shapes (Claude Code: `effortLevel`; Gemini / agy: `effort`) --------------

// Which settings key holds which value of the form.
function settingsShape(format: string, effortKey: string): TierShape {
  const keys: readonly (readonly [TierFieldName, string])[] = [['model', 'model'], ['effort', effortKey]];
  return {
    format,
    render(values, kept) {
      if (kept.trim() !== '' && settingsOf(kept) === undefined) return kept;
      const settings = settingsOf(kept) ?? {};
      for (const [field, key] of keys) {
        const value = values[field].trim();
        if (value === '') delete settings[key];
        else settings[key] = value;
      }
      return `${JSON.stringify(settings, null, 2)}\n`;
    },
    parse(text) {
      if (text.trim() === '') return NOTHING_SET;
      const settings = settingsOf(text);
      if (settings === undefined) return undefined;
      return { provider: '', model: said(settings.model), effort: said(settings[effortKey]) };
    },
    advanced(text) {
      const settings = settingsOf(text);
      if (settings === undefined) return 0;
      return Object.keys(settings).filter((key) => !keys.some(([, name]) => name === key)).length;
    },
  };
}

function settingsOf(text: string): Record<string, unknown> | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

export const SETTINGS_JSON: TierShape = settingsShape('settings-json', 'effortLevel');
export const GEMINI_SETTINGS_JSON: TierShape = settingsShape('gemini-settings-json', 'effort');

// -- Codex: one `键=值` per line, one argument each as the CLI is handed them ---------------

const KEY_VALUE_KEYS: readonly (readonly [TierFieldName, string])[] = [['model', 'model'], ['effort', 'model_reasoning_effort']];

// The pairs of such a text, or nothing when a line is not one: the CLI is handed one
// argument per line, so a line that is not a pair is not something the form can edit.
function pairsOf(text: string): { key: string; value: string }[] | undefined {
  const pairs: { key: string; value: string }[] = [];
  for (const { line } of valueLines(text)) {
    const equal = line.indexOf('=');
    const key = equal < 0 ? '' : line.slice(0, equal).trim();
    if (key === '') return undefined;
    pairs.push({ key, value: line.slice(equal + 1).trim() });
  }
  return pairs;
}

export const KEY_VALUE_LINES: TierShape = {
  format: 'key-value-lines',
  render(values, kept) {
    if (kept.trim() !== '' && pairsOf(kept) === undefined) return kept;
    const wanted = new Map(KEY_VALUE_KEYS.map(([field, key]) => [key, values[field].trim()]));
    const writtenKeys = new Set<string>();
    const out: string[] = [];
    for (const line of kept.trim() === '' ? [] : linesOf(kept)) {
      const equal = line.indexOf('=');
      const key = equal < 0 ? '' : line.slice(0, equal).trim();
      if (!wanted.has(key)) {
        out.push(line);
        continue;
      }
      writtenKeys.add(key);
      const value = wanted.get(key)!;
      if (value !== '') out.push(`${key}=${value}`);
    }
    for (const [key, value] of wanted) if (value !== '' && !writtenKeys.has(key)) out.push(`${key}=${value}`);
    return written(out);
  },
  parse(text) {
    if (text.trim() === '') return NOTHING_SET;
    const pairs = pairsOf(text);
    if (pairs === undefined) return undefined;
    const value = (key: string): string => {
      const raw = pairs.find((pair) => pair.key === key)?.value ?? '';
      try { const parsed: unknown = JSON.parse(raw); return typeof parsed === 'string' ? parsed : raw; } catch { return raw; }
    };
    return { provider: '', model: value('model'), effort: value('model_reasoning_effort') };
  },
  advanced(text) {
    const pairs = pairsOf(text);
    if (pairs === undefined) return 0;
    return pairs.filter((pair) => !KEY_VALUE_KEYS.some(([, key]) => key === pair.key)).length;
  },
};

// -- dsh: one YAML patch list, whose `agent-default-model` entry the form edits ------------

// The one entry the form edits. Everything else in the list belongs to the owner.
const AGENT_MODEL = 'agent-default-model';
// Which setting of that entry's `config:` holds which value of the form. dsh replaces a
// patch's whole `config` block rather than merging it, so a tier carries all three itself.
const PATCH_KEYS: readonly (readonly [TierFieldName, string])[] = [['provider', 'provider'], ['model', 'model'], ['effort', 'reasoningEffort']];

interface PatchEntry {
  head: number;
  end: number;
  id: string;
}

function entryId(head: string): string {
  const found = /^-\s*id:\s*(.*)$/.exec(head);
  if (found === null) return '';
  return found[1]!.replace(/\s+#.*$/, '').trim().replace(/^(['"])(.*)\1$/, '$2');
}

// The top-level entries of a patch list: a line of its own that begins with `-`. A text whose
// first meaningful line is not one is not a patch list at all — dsh refuses it too, so the
// form does not read values out of it.
function patchEntries(lines: readonly string[]): PatchEntry[] | undefined {
  const first = lines.map((line) => line.trim()).find((line) => line !== '' && line !== '---' && !line.startsWith('#'));
  if (first === undefined) return [];
  if (!first.startsWith('-')) return undefined;
  const heads = lines.flatMap((line, at) => (/^-(?:\s|$)/.test(line) ? [at] : []));
  return heads.map((head, index) => ({ head, end: heads[index + 1] ?? lines.length, id: entryId(lines[head]!) }));
}

// Where an entry's `config:` block starts and how deep its keys are written.
function configOf(lines: readonly string[], { head, end }: PatchEntry): { at: number; indent: number } | undefined {
  for (let at = head + 1; at < end; at += 1) {
    const found = /^(\s+)config:\s*(?:#.*)?$/.exec(lines[at]!);
    if (found) return { at, indent: found[1]!.length };
  }
  return undefined;
}

function unquoteYamlScalar(raw: string): string {
  const cleaned = raw.replace(/\s+#.*$/, '').trim();
  const match = /^(['"])(.*)\1$/.exec(cleaned);
  return match ? match[2]!.trim() : cleaned;
}

// The setting one line of a `config:` block holds: the direct children of that block are the
// settings, and anything deeper belongs to one of them.
function settingIn(line: string, configIndent: number): { key: string; value: string } | undefined {
  const found = /^(\s+)([^\s:#][^:]*):(?:\s*(.*))?$/.exec(line);
  if (found === null || found[1]!.length !== configIndent + 2) return undefined;
  return { key: found[2]!.trim(), value: unquoteYamlScalar(found[3] ?? '') };
}

export const PATCH_LIST: TierShape = {
  format: 'patch-list',
  render(values, kept) {
    const lines = kept.trim() === '' ? [] : linesOf(kept);
    const entries = patchEntries(lines);
    if (kept.trim() !== '' && entries === undefined) return kept;
    const cleanVal = (raw: string): string => unquoteYamlScalar(raw);
    const wanted = new Map(PATCH_KEYS.map(([field, key]) => [key, cleanVal(values[field])]));
    const entry = entries!.find((each) => each.id === AGENT_MODEL);
    if (entry === undefined) {
      // No entry to keep: one is written at the end of the list, from the values alone.
      const body = [...lines];
      while (body.length > 0 && body[body.length - 1]!.trim() === '') body.pop();
      const block = ['- id: agent-default-model', '  config:', ...PATCH_KEYS.filter(([field]) => cleanVal(values[field]) !== '').map(([field, key]) => `    ${key}: ${cleanVal(values[field])}`)];
      return written([...body, ...(body.length > 0 ? [''] : []), ...block]);
    }
    const config = configOf(lines, entry);
    const spots = new Map<string, number>();
    const out: string[] = [];
    let insertAt = -1;
    let indent = '    ';
    for (const [at, line] of lines.entries()) {
      if (config !== undefined && at > config.at && at < entry.end) {
        const setting = settingIn(line, config.indent);
        if (setting !== undefined && wanted.has(setting.key)) {
          indent = /^\s*/.exec(line)![0];
          const value = wanted.get(setting.key)!;
          if (value !== '') {
            spots.set(setting.key, out.length);
            out.push(`${indent}${setting.key}: ${value}`);
          }
          continue;
        }
      }
      out.push(line);
      if (at === (config?.at ?? entry.head)) {
        // A key the text does not have yet goes right under `config:`, which is written
        // first when the entry has none.
        if (config === undefined) out.push('  config:');
        insertAt = out.length;
      }
    }
    // A key the text did not have goes where the declaration puts it, so the text reads the
    // same whichever box the owner filled in first.
    PATCH_KEYS.forEach(([field, key], place) => {
      const value = cleanVal(values[field]);
      if (value === '' || spots.has(key)) return;
      const later = PATCH_KEYS.slice(place + 1).map(([, next]) => spots.get(next)).filter((each): each is number => each !== undefined);
      const earlier = PATCH_KEYS.slice(0, place).map(([, before]) => spots.get(before)).filter((each): each is number => each !== undefined);
      const at = later.length > 0 ? Math.min(...later) : earlier.length > 0 ? Math.max(...earlier) + 1 : insertAt;
      if (at < 0) return;
      out.splice(at, 0, `${indent}${key}: ${value}`);
      for (const [other, where] of spots) if (where >= at) spots.set(other, where + 1);
      spots.set(key, at);
    });
    return written(out);
  },
  parse(text) {
    if (text.trim() === '') return NOTHING_SET;
    const lines = linesOf(text);
    const entries = patchEntries(lines);
    if (entries === undefined) return undefined;
    const values = { ...NOTHING_SET };
    const entry = entries.find((each) => each.id === AGENT_MODEL);
    if (entry === undefined) return values;
    const config = configOf(lines, entry);
    if (config === undefined) return values;
    for (let at = config.at + 1; at < entry.end; at += 1) {
      const setting = settingIn(lines[at]!, config.indent);
      if (setting === undefined) continue;
      const field = PATCH_KEYS.find(([, key]) => key === setting.key);
      if (field) values[field[0]] = setting.value;
    }
    return values;
  },
  advanced(text) {
    const lines = linesOf(text);
    const entries = patchEntries(lines);
    if (entries === undefined) return 0;
    let count = entries.filter((each) => each.id !== AGENT_MODEL).length;
    const entry = entries.find((each) => each.id === AGENT_MODEL);
    if (entry === undefined) return count;
    const config = configOf(lines, entry);
    if (config === undefined) return count;
    for (let at = config.at + 1; at < entry.end; at += 1) {
      const setting = settingIn(lines[at]!, config.indent);
      if (setting !== undefined && !PATCH_KEYS.some(([, key]) => key === setting.key)) count += 1;
    }
    return count;
  },
};

const TIER_SHAPES: Record<string, TierShape> = {
  [SETTINGS_JSON.format]: SETTINGS_JSON,
  [GEMINI_SETTINGS_JSON.format]: GEMINI_SETTINGS_JSON,
  [KEY_VALUE_LINES.format]: KEY_VALUE_LINES,
  [PATCH_LIST.format]: PATCH_LIST,
};
