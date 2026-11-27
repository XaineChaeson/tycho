// What a round may still read on its machine that its snapshot does not hold
// (docs/design/knowledge-and-skills.md §1.2, §4.1, §1.3). The executor's own configuration there
// applies as it is: the snapshot records what the machine could report of it, and says plainly
// what it could not. Kept out are only tycho's own knowledge outlets — the global instruction
// file the machine's client writes and the knowledge MCP — and, in a round that needs a view of
// its own, the executor's memory across tasks. Each is either kept out, and the snapshot records
// how, or said to be there; never left unsaid as if the snapshot held all of the round's input.
import { localeMap, t } from './i18n.ts';
import { formatTime } from './time.ts';
import type { EntryProjection } from './node-protocol.ts';

// The kinds of an executor's own configuration a machine may report (knowledge-and-skills.md
// §1.2): its global instruction files, MCP servers, the remote connectors that come with a
// login, skills and plugins. A kind no command of the executor's lists is unknown, never empty.
export const CONFIG_KINDS = ['instructions', 'mcp', 'connectors', 'skills', 'plugins'] as const;
export type ConfigKind = typeof CONFIG_KINDS[number];
export const isConfigKind = (value: unknown): value is ConfigKind => CONFIG_KINDS.includes(value as ConfigKind);

export interface MachineInputs {
  // `settings` are what the round's own settings file was given to keep the file out: `off` is
  // a way measured on this executor's version, `may_read` one given to a version it was not
  // measured on (or of no known version), which may not hold.
  instructions: { off: string; settings: Record<string, string[]> } | { may_read: string; settings: Record<string, string[]> } | { reads: string };
  // `off`: turned off for this round, and how. `scope`: left as the machine has it — what the
  // executor declares of it ('shared' read and written across tasks; 'unknown' it cannot say,
  // with why). `may_read`: a round that needed it off, which could not be made sure of.
  memory: { off: string } | { scope: 'none' | 'task' | 'shared' | 'unknown'; why?: string } | { may_read: string };
  // tycho's knowledge MCP (`tycho-knowledge`): turned off by name, not on the machine as far as
  // its report says, or maybe usable, with why. Absent in a round from before this was recorded.
  knowledge_mcp?: { off: string } | { absent: string } | { may_use: string };
  external_entry?: EntryProjection & { reported_at?: string; conflicting?: boolean };
  fixed_knowledge?: { require_absence: boolean };
  // The executor's own configuration on the machine, kind by kind: the names the machine's
  // report listed, or why the kind is unknown. `asked_at` is when the machine asked; absent when
  // it reported nothing at all. Absent in a round from before this was recorded.
  config?: { asked_at?: string; kinds: ({ kind: ConfigKind; names: string[] } | { kind: ConfigKind; unknown: string })[] };
}

const CONFIG_LABELS: Readonly<Record<ConfigKind, string>> = localeMap({
  instructions: 'sh.machineInputs.config.instructions',
  mcp: 'sh.machineInputs.config.mcp',
  connectors: 'sh.machineInputs.config.connectors',
  skills: 'sh.machineInputs.config.skills',
  plugins: 'sh.machineInputs.config.plugins',
});

export function machineInputsText(inputs: MachineInputs): string[] {
  const { instructions, memory, knowledge_mcp: mcp, config, external_entry: entry } = inputs;
  const listSep = t('sh.listSep');
  const instructionsLine = 'off' in instructions
    ? t('sh.machineInputs.instructions.off', { reason: instructions.off })
    : entry?.state === 'absent'
      ? t('sh.machineInputs.instructions.entryAbsent')
      : entry?.state === 'present'
        ? t('sh.machineInputs.instructions.entryPresent', {
            status: t(entry.conflicting ? 'sh.machineInputs.instructions.entryConflict' : 'sh.machineInputs.instructions.entryDuplicate'),
            revisionsPart: entry.revisions.length
              ? t('sh.machineInputs.instructions.entryRevisions', { revisions: entry.revisions.join(listSep) })
              : t('sh.machineInputs.instructions.entryRevisionsUnknown'),
          })
        : entry?.state === 'unknown'
          ? t('sh.machineInputs.instructions.entryUnknown', { why: entry.why })
          : 'may_read' in instructions
            ? t('sh.machineInputs.instructions.mayRead', { reason: instructions.may_read })
            : t('sh.machineInputs.instructions.reads', { reason: instructions.reads });

  const memoryLine = 'off' in memory
    ? t('sh.machineInputs.memory.off', { reason: memory.off })
    : 'may_read' in memory
      ? t('sh.machineInputs.memory.mayRead', { reason: memory.may_read })
      : memory.scope === 'none'
        ? t('sh.machineInputs.memory.none')
        : memory.scope === 'task'
          ? t('sh.machineInputs.memory.task')
          : memory.scope === 'shared'
            ? t('sh.machineInputs.memory.shared')
            : memory.why
              ? t('sh.machineInputs.memory.unknownWithWhy', { why: memory.why })
              : t('sh.machineInputs.memory.unknown');

  const configLine = config === undefined
    ? []
    : (() => {
        const items = config.kinds.map((each) => {
          const label = CONFIG_LABELS[each.kind];
          if ('names' in each) {
            return each.names.length === 0
              ? t('sh.machineInputs.config.itemNone', { label })
              : t('sh.machineInputs.config.itemNames', { label, names: each.names.join(listSep) });
          }
          return t('sh.machineInputs.config.itemUnknown', { label, why: each.unknown });
        }).join(t('sh.semicolonSep'));
        return [config.asked_at
          ? t('sh.machineInputs.config.withAskedAt', { at: formatTime(config.asked_at), items })
          : t('sh.machineInputs.config.plain', { items })];
      })();

  return [
    instructionsLine,
    ...(inputs.fixed_knowledge ? [t('sh.machineInputs.fixedKnowledge')] : []),
    memoryLine,
    ...(mcp === undefined
      ? []
      : ['off' in mcp
        ? t('sh.machineInputs.mcp.off', { reason: mcp.off })
        : 'absent' in mcp
          ? t('sh.machineInputs.mcp.absent', { reason: mcp.absent })
          : t('sh.machineInputs.mcp.mayUse', { reason: mcp.may_use })]),
    ...configLine,
  ];
}
