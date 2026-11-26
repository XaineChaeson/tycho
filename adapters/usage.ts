// A round's use, added up the same way for every executor: what each line of output adds,
// summed per model. The adapters say what a line adds; nothing here reads an executor's words.
import type { Usage } from './types.ts';

const keyOf = (usage: Usage): string => usage.model ?? '';

// One entry per model, the model-less use as one more. A list price is kept only where every
// part had one: a sum with a part the executor did not price would pass for the whole.
export function addUsage(total: readonly Usage[], more: readonly Usage[]): Usage[] {
  const byModel = new Map(total.map((each) => [keyOf(each), { ...each }]));
  for (const each of more) {
    const held = byModel.get(keyOf(each));
    if (!held) {
      byModel.set(keyOf(each), { ...each });
      continue;
    }
    held.inputTokens += each.inputTokens;
    held.outputTokens += each.outputTokens;
    held.cacheReadTokens += each.cacheReadTokens;
    held.cacheWriteTokens += each.cacheWriteTokens;
    if (held.listCostUsd !== undefined && each.listCostUsd !== undefined) held.listCostUsd += each.listCostUsd;
    else delete held.listCostUsd;
  }
  return [...byModel.values()];
}
