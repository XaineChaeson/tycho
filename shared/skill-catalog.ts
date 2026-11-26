// Shared contract for Tycho's native skills/ directory catalog, top-level Registry Map bindings,
// and Project x Role effective context preview. Zero runtime dependencies.
import type { Loading } from './knowledge.ts';

export const SKILL_REGISTRY_SETTING_KEY = 'skill_registry';
export const ENTRY_MACHINES_SETTING_KEY = 'knowledge_entry_machines';
export const TASK_TIMEOUTS_SETTING_KEY = 'task_timeouts';

// Non-invasive top-level binding for a <slug>/SKILL.md discovered in Tycho's skills/ directory.
export interface SkillRegistryBinding {
  enabled: boolean;
  loading: Loading;
  // null = global (applies to every project); string[] = explicit project IDs.
  project_ids: string[] | null;
  // Empty array = applies to any role.
  roles: string[];
  // null = all machines; string[] = explicit machine IDs allowed to receive/use this skill.
  // Empty array [] = fail-closed (no machine matched, e.g. after its sole bound machine was deleted).
  machine_ids: string[] | null;
}

export type SkillRegistryMap = Record<string, SkillRegistryBinding>;
// Per-ledger-entry machine distribution scope (null = all machines; string[] = explicit machine IDs).
export type EntryMachinesMap = Record<string, string[] | null>;

export const DEFAULT_SKILL_BINDING: Readonly<SkillRegistryBinding> = {
  enabled: true,
  loading: 'on_demand',
  project_ids: null,
  roles: [],
  machine_ids: null,
};

// Deterministic filesystem-safe Entry ID for a directory skill (no ':' so Windows snapshot paths stay valid).
export const directorySkillId = (slug: string): string => `dir-${slug}`;

export const isDirectorySkillId = (id: string): boolean => id.startsWith('dir-');

// One standard <slug>/SKILL.md discovered under Tycho's native skills/ directory.
export interface DirectorySkill {
  slug: string;
  id: string;
  name: string;
  description: string;
  body: string;
  bytes: number;
  sha256: string;
  rel_path: string;
  binding: SkillRegistryBinding;
  // Set when this SKILL.md was materialized by Tycho from a ledger entry; null otherwise.
  managed_ledger_id: string | null;
}

export interface IgnoredSkillEntry {
  name: string;
  reason: string;
}

export interface SkillDirectoryScan {
  dir: string;
  skills: DirectorySkill[];
  ignored: IgnoredSkillEntry[];
}

export interface EffectiveContextItem {
  id: string;
  title: string;
  when_to_use: string;
  loading: Loading;
  origin: 'directory' | 'ledger';
  kind: 'knowledge' | 'skill';
  project_ids: string[] | null;
  roles: string[];
  machine_ids: string[] | null;
  revision: number | null;
  slug: string | null;
  bytes: number;
}

export interface EffectiveContextReport {
  project_id: string | null;
  project_name: string | null;
  role_id: string | null;
  role_name: string | null;
  machine_id: string | null;
  machine_host: string | null;
  resident: EffectiveContextItem[];
  on_demand: EffectiveContextItem[];
  budget: {
    brief_bytes: number;
    brief_limit_bytes: number;
    snapshot_bytes: number;
    snapshot_limit_bytes: number;
    over_limit: string | null;
  };
}
