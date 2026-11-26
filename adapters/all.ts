// The executors this program ships, in one place. The service hands them to the accounts,
// the dispatcher, the Runner and the pages, and a machine's client asks the same set about
// itself (docs/design/nodes.md §1.2): which executors exist is this program's own fact, not
// something a setting or a machine decides. An account names one of these and nothing else.
import { claudeAdapter } from './claude.ts';
import { codexAdapter } from './codex.ts';
import { dshAdapter } from './dsh.ts';
import { geminiAdapter } from './gemini.ts';
import type { Adapter } from './types.ts';

export const ADAPTERS: Record<string, Adapter> = { claude: claudeAdapter, codex: codexAdapter, dsh: dshAdapter, gemini: geminiAdapter };
