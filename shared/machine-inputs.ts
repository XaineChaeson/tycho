// What a round may still read on its machine that its snapshot does not hold
// (docs/design/knowledge-and-skills.md §1.2, §4.1, §1.3). The executor's own configuration there
// applies as it is: the snapshot records what the machine could report of it, and says plainly
// what it could not. Kept out are only tycho's own knowledge outlets — the global instruction
// file the machine's client writes and the knowledge MCP — and, in a round that needs a view of
// its own, the executor's memory across tasks. Each is either kept out, and the snapshot records
// how, or said to be there; never left unsaid as if the snapshot held all of the round's input.
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

const CONFIG_LABELS: Record<ConfigKind, string> = {
  instructions: '全局指令文件',
  mcp: 'MCP 服务器',
  connectors: '随登录带来的远端连接器',
  skills: '技能',
  plugins: '插件',
};

export function machineInputsText(inputs: MachineInputs): string[] {
  const { instructions, memory, knowledge_mcp: mcp, config, external_entry: entry } = inputs;
  return [
    'off' in instructions
      ? `tycho 写在机器上的全局知识入口：这一轮不读（${instructions.off}）`
      : entry?.state === 'absent'
        ? '机器核实原生入口里没有 Tycho 投影'
        : entry?.state === 'present'
          ? `机器上的 Tycho 全局知识也可能被加载（${entry.conflicting ? '与快照的知识版本不一致' : '可能重复'}${entry.revisions.length ? `；入口修订 ${entry.revisions.join('、')}` : '；入口修订未知'}）`
          : entry?.state === 'unknown'
            ? `机器是否会加载 Tycho 的全局知识无法确认（${entry.why}）`
      : 'may_read' in instructions
        ? `这一轮可能读到 tycho 写在机器上的全局知识入口（${instructions.may_read}）`
        : `这一轮还会读到 tycho 写在机器上的全局知识入口（${instructions.reads}）`,
    ...(inputs.fixed_knowledge ? ['Tycho 知识按此轮快照的版本固定'] : []),
    'off' in memory
      ? `执行器自己跨任务的记忆：这一轮关掉了（${memory.off}）`
      : 'may_read' in memory
        ? `这一轮可能读到执行器自己跨任务的记忆（${memory.may_read}）`
        : memory.scope === 'none'
          ? '执行器没有自己跨任务的记忆'
          : memory.scope === 'task'
            ? '执行器自己的记忆只在这个任务之内'
            : memory.scope === 'shared'
              ? '执行器自己跨任务的记忆：照常读写'
              : `执行器有没有自己跨任务的记忆说不清${memory.why ? `（${memory.why}）` : ''}`,
    ...(mcp === undefined
      ? []
      : ['off' in mcp
        ? `机器上的知识 MCP：这一轮关掉了（${mcp.off}）`
        : 'absent' in mcp
          ? `机器上的知识 MCP：${mcp.absent}`
          : `这一轮可能用到机器上的知识 MCP（${mcp.may_use}）`]),
    ...(config === undefined
      ? []
      : [
          `机器上执行器自己的配置照常生效${config.asked_at ? `（机器 ${formatTime(config.asked_at)} 报告）` : ''}：`
          + config.kinds.map((each) => `${CONFIG_LABELS[each.kind]}${'names' in each ? (each.names.length === 0 ? '没有' : ` ${each.names.join('、')}`) : `未知（${each.unknown}）`}`).join('；'),
        ]),
  ];
}
