import { valueLines } from '../shared/tier-form.ts';
import type { TierForm, TierValues } from '../shared/tier-form.ts';
import type { TierId } from '../shared/tiers.ts';

// One tier's value: the executor's own configuration text, which rides the snapshot to the
// machine. `kind` is the stored shape's tag; no other kind is a tier.
export type Tier = { kind: 'content'; text: string };

// A tier's text becomes one file in a snapshot and, for Codex, one argument of one command
// line per line: room for any settings file, short of what a shell or an argument list
// takes badly.
const MAX_TIER_CHARS = 20_000;

// The checks that hold for every executor's own text, whichever one it is: a tier empty
// enough to say nothing, and a text too long for the file or the argument list it becomes.
// What the executor makes of the text is the adapter's own declaration.
export function checkTierText(text: string): string | undefined {
  if (text.trim() === '') return '内容不能为空';
  if (text.length > MAX_TIER_CHARS) return `内容太长（最多 ${MAX_TIER_CHARS} 个字）`;
  return undefined;
}

// The lines of a Codex tier, as the CLI is handed them, with the line they were written
// on: a carriage return is the console's line ending, not part of a value. Blank lines
// carry nothing and are left out, so a text file's trailing newline is not a mistake. The
// console reads the same lines through the same rule, in `shared/tier-form.ts`.
export function codexLines(text: string): { at: number; line: string }[] {
  return valueLines(text);
}

// The `键=值` pairs of a Codex tier, in the words it was written in: the value is the
// CLI's own (TOML, or the literal it falls back to) and is never reassembled here. The
// validator below reads the same lines, so what it lets through is what runs.
export function codexSettings(text: string): { key: string; value: string }[] {
  return codexLines(text).flatMap(({ line }) => {
    const equal = line.indexOf('=');
    return equal <= 0 || line.slice(0, equal).trim() === '' ? [] : [{ key: line.slice(0, equal), value: line.slice(equal + 1) }];
  });
}

// The tiers a machine's own login starts with, as its adapter declares them: its own form
// writes each tier's text from the values declared for it. A tier that declares no value at
// all is the empty text — nothing tycho adds, so the machine's own configuration runs — which
// is what dsh needs: its patch replaces the whole `config`, so writing a strength alone would
// drop the provider and model it is configured with.
export function ownLoginTiersOf(adapter: { tierForm?: TierForm; ownLoginTiers?: Partial<Record<TierId, Partial<TierValues>>> }): Record<string, Tier> | undefined {
  const { tierForm, ownLoginTiers } = adapter;
  if (tierForm === undefined || ownLoginTiers === undefined) return undefined;
  return Object.fromEntries(Object.entries(ownLoginTiers).map(([tier, declared]) => {
    const values: TierValues = { provider: '', model: '', effort: '', ...declared };
    const said = [values.provider, values.model, values.effort].some((value) => value.trim() !== '');
    return [tier, { kind: 'content', text: said ? tierForm.render(values, '') : '' }];
  }));
}
