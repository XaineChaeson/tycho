// Canonical built-in JSON language packs shared across Service, Runner, Shared, and Console.
// Each built-in locale is split into domain-scoped JSON files for maintainable diffs and merged
// into a single flat LocalePack matching the exact schema of hot-plugged `<dataDir>/locales/*.json`.
import zhCore from './zh-CN/core.json' with { type: 'json' };
import zhShared from './zh-CN/shared.json' with { type: 'json' };
import zhProject from './zh-CN/project.json' with { type: 'json' };
import zhTask from './zh-CN/task.json' with { type: 'json' };
import zhAccounts from './zh-CN/accounts.json' with { type: 'json' };
import zhMachines from './zh-CN/machines.json' with { type: 'json' };
import zhKnowledge from './zh-CN/knowledge.json' with { type: 'json' };
import zhSettings from './zh-CN/settings.json' with { type: 'json' };

import enCore from './en/core.json' with { type: 'json' };
import enShared from './en/shared.json' with { type: 'json' };
import enProject from './en/project.json' with { type: 'json' };
import enTask from './en/task.json' with { type: 'json' };
import enAccounts from './en/accounts.json' with { type: 'json' };
import enMachines from './en/machines.json' with { type: 'json' };
import enKnowledge from './en/knowledge.json' with { type: 'json' };
import enSettings from './en/settings.json' with { type: 'json' };

export const BUILTIN_ZH_CN_MESSAGES = {
  ...zhCore,
  ...zhShared,
  ...zhProject,
  ...zhTask,
  ...zhAccounts,
  ...zhMachines,
  ...zhKnowledge,
  ...zhSettings,
} as const;

export type MessageKey = keyof typeof BUILTIN_ZH_CN_MESSAGES;

export const BUILTIN_EN_MESSAGES: Record<string, string> = {
  ...enCore,
  ...enShared,
  ...enProject,
  ...enTask,
  ...enAccounts,
  ...enMachines,
  ...enKnowledge,
  ...enSettings,
};

export const CANONICAL_LOCALE_KEYS: readonly string[] = Object.keys(BUILTIN_ZH_CN_MESSAGES);

export interface BuiltinLocaleMeta {
  id: string;
  name: string;
  nativeName: string;
  shortLabel: string;
  direction: 'ltr' | 'rtl';
  fallback?: string;
  messages: Record<string, string>;
}

export const BUILTIN_LOCALE_DEFINITIONS: readonly BuiltinLocaleMeta[] = [
  {
    id: 'zh-CN',
    name: 'Chinese (Simplified)',
    nativeName: '简体中文',
    shortLabel: '中',
    direction: 'ltr',
    messages: BUILTIN_ZH_CN_MESSAGES,
  },
  {
    id: 'en',
    name: 'English',
    nativeName: 'English',
    shortLabel: 'EN',
    direction: 'ltr',
    fallback: 'zh-CN',
    messages: BUILTIN_EN_MESSAGES,
  },
];
