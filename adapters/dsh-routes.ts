// Unified DeepSeek Harness (dsh) route discovery and desktop/headless reconciliation.
//
// Why this exists:
// DeepSeek Harness keeps separate profile patch files under `$DSH_HOME/profiles/`:
//   - `desktop/cordis.patch.yml` (edited by the DeepSeek Harness desktop app)
//   - `headless/cordis.patch.yml` (booted by `dsh --profile headless`, used by Tycho CLI)
// Both share `$DSH_HOME/.credentials.yaml`. Without unification, custom gateways/models added
// in Desktop or official DeepSeek account/API-key channels don't align with headless CLI runs.
//
// This module:
//   1. Discovers ALL real channels & models configured on the machine across headless dump,
//      desktop `cordis.patch.yml`, and `.credentials.yaml` (presence-only; zero secrets read).
//   2. Generates minimal runtime patch overlays so selecting any discovered channel in Tycho
//      (deepseek-account / deepseek-official / custom gateway) activates cleanly in headless
//      without mutating the user's hand-edited `headless/cordis.patch.yml`.
//   3. Extracts ONLY the `llm-pi-ai` provider block from `desktop/cordis.patch.yml` when present,
//      so custom gateways & models added in Desktop are immediately runnable by headless workers.
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ExecutorRouteOption } from '../shared/logins.ts';
import { PATCH_LIST } from '../shared/tier-form.ts';
import { parseDshCredentialRefs, parseDshPlatformGrant } from './dsh-machine-quota.ts';
import type { ModelInfo } from './types.ts';

export const DSH_ACCOUNT_ROUTE = 'deepseek-account';
export const DSH_OFFICIAL_ROUTE = 'deepseek-official';

const OFFICIAL_MODELS: readonly ModelInfo[] = [
  { id: 'deepseek-v4.1-flash', name: 'DeepSeek-V4.1-Flash', efforts: ['off', 'low', 'medium', 'high', 'max'] },
  { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro', efforts: ['off', 'low', 'medium', 'high', 'max'] },
];

function unquote(value: string): string {
  const cleaned = value.replace(/\s+#.*$/, '').trim();
  const match = /^(['"])(.*)\1$/.exec(cleaned);
  return match ? match[2]!.trim() : cleaned;
}

export function resolveDshHome(env: NodeJS.ProcessEnv = process.env, homeDir?: string): string {
  const custom = env.DSH_HOME?.trim();
  if (custom) return custom;
  const home = homeDir ?? env.USERPROFILE ?? env.HOME ?? homedir();
  return join(home, '.dsh');
}

interface ParsedEntryState {
  disabled: boolean;
  present: boolean;
}

interface ParsedCustomProvider {
  id: string;
  displayName?: string;
  models: ModelInfo[];
}

// Parse custom `llm-pi-ai` providers (id, displayName, and models) plus entry enablement
// from either `dsh --profile headless --dump-config` or `cordis.patch.yml`.
export function parseDshYamlRoutes(yamlText: string): {
  defaultProvider: string | null;
  entries: Record<string, ParsedEntryState>;
  customProviders: ParsedCustomProvider[];
} {
  const lines = yamlText.split(/\r?\n/);
  let defaultProvider: string | null = null;
  const entries: Record<string, ParsedEntryState> = {};
  const customProviders: ParsedCustomProvider[] = [];

  let entryId: string | null = null;
  let inProviders = false;
  let providersIndent = -1;
  let currentProvider: (ParsedCustomProvider & { indent: number }) | null = null;
  let inModels = false;
  let modelsIndent = -1;
  let currentModel: { id: string; name?: string; efforts: string[]; indent: number } | null = null;
  let inEfforts = false;
  let effortsIndent = -1;

  const flushModel = () => {
    if (currentModel && currentModel.id && currentProvider) {
      const exists = currentProvider.models.some((m) => m.id === currentModel!.id);
      if (!exists) {
        currentProvider.models.push({
          id: currentModel.id,
          ...(currentModel.name && currentModel.name !== currentModel.id ? { name: currentModel.name } : {}),
          ...(currentModel.efforts.length > 0 ? { efforts: currentModel.efforts } : {}),
        });
      }
    }
    currentModel = null;
    inEfforts = false;
    effortsIndent = -1;
  };

  const flushProvider = () => {
    flushModel();
    if (currentProvider) {
      const existing = customProviders.find((p) => p.id === currentProvider!.id);
      if (existing) {
        if (currentProvider.displayName && !existing.displayName) existing.displayName = currentProvider.displayName;
        for (const m of currentProvider.models) {
          if (!existing.models.some((x) => x.id === m.id)) existing.models.push(m);
        }
      } else {
        customProviders.push({
          id: currentProvider.id,
          ...(currentProvider.displayName ? { displayName: currentProvider.displayName } : {}),
          models: currentProvider.models,
        });
      }
    }
    currentProvider = null;
    inModels = false;
    modelsIndent = -1;
  };

  for (const raw of lines) {
    const trimmed = raw.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const indent = /^\s*/.exec(raw)![0].length;

    const topEntry = /^-\s+id:\s*(.+)$/.exec(raw);
    if (topEntry) {
      flushProvider();
      entryId = unquote(topEntry[1]!);
      entries[entryId] = { present: true, disabled: false };
      inProviders = false;
      providersIndent = -1;
      continue;
    }

    if (entryId && indent === 2) {
      const dis = /^disabled:\s*(.+)$/.exec(trimmed);
      if (dis) {
        const val = unquote(dis[1]!).toLowerCase();
        if (val === 'true') entries[entryId]!.disabled = true;
        else if (val === 'false') entries[entryId]!.disabled = false;
      }
    }

    if (entryId === 'agent-default-model') {
      const prov = /^provider:\s*(.+)$/.exec(trimmed);
      if (prov) {
        const val = unquote(prov[1]!);
        if (val) defaultProvider = val;
      }
      continue;
    }

    if (entryId !== 'llm-pi-ai') continue;

    if (!inProviders) {
      if (/^providers:\s*$/.test(trimmed)) {
        inProviders = true;
        providersIndent = indent;
      }
      continue;
    }

    if (indent <= providersIndent) {
      flushProvider();
      inProviders = false;
      continue;
    }

    if (currentProvider && indent <= currentProvider.indent) {
      flushProvider();
    }

    if (!currentProvider) {
      const provHeader = /^([A-Za-z0-9._-]+):\s*$/.exec(trimmed);
      if (provHeader) {
        currentProvider = { id: provHeader[1]!, models: [], indent };
      }
      continue;
    }

    if (inEfforts && indent <= effortsIndent) {
      inEfforts = false;
      effortsIndent = -1;
    }
    if (inModels && indent <= modelsIndent) {
      flushModel();
      inModels = false;
      modelsIndent = -1;
    }

    if (!inModels) {
      const dn = /^displayName:\s*(.+)$/.exec(trimmed);
      if (dn) {
        currentProvider.displayName = unquote(dn[1]!);
        continue;
      }
      if (/^models:\s*$/.test(trimmed)) {
        inModels = true;
        modelsIndent = indent;
      }
      continue;
    }

    if (inEfforts && currentModel) {
      const eff = /^(['"]?[\w.-]+['"]?):\s*(.*)$/.exec(trimmed);
      if (eff) {
        const key = unquote(eff[1]!);
        if (key && !currentModel.efforts.includes(key)) currentModel.efforts.push(key);
      }
      continue;
    }

    const item = /^-\s*(.*)$/.exec(trimmed);
    if (item && (!currentModel || indent <= currentModel.indent)) {
      flushModel();
      const rest = item[1]!;
      const pair = /^([\w.-]+):\s*(.*)$/.exec(rest);
      if (pair && pair[1] === 'id') {
        currentModel = { id: unquote(pair[2]!), efforts: [], indent };
      } else if (!pair && rest.trim()) {
        currentModel = { id: unquote(rest), efforts: [], indent };
      } else {
        currentModel = { id: '', efforts: [], indent };
      }
      continue;
    }

    if (currentModel && indent > currentModel.indent) {
      const idMatch = /^id:\s*(.+)$/.exec(trimmed);
      if (idMatch) {
        currentModel.id = unquote(idMatch[1]!);
        continue;
      }
      const nameMatch = /^name:\s*(.+)$/.exec(trimmed);
      if (nameMatch) {
        currentModel.name = unquote(nameMatch[1]!);
        continue;
      }
      if (/^reasoningEfforts:\s*$/.test(trimmed)) {
        inEfforts = true;
        effortsIndent = indent;
      }
    }
  }

  flushProvider();
  return { defaultProvider, entries, customProviders };
}

export interface DshLocalDiscovery {
  defaultRoute: string | null;
  routes: ExecutorRouteOption[];
  models: ModelInfo[];
}

// Discover all real channels & models available to dsh on this machine by unifying:
//   - headless dump (`dsh --profile headless --dump-config`)
//   - desktop profile patch (`$DSH_HOME/profiles/desktop/cordis.patch.yml`, if present)
//   - shared credentials presence (`$DSH_HOME/.credentials.yaml` + env, zero secrets read)
export function discoverLocalDshRoutesAndModels(
  headlessDump: string,
  options: { env?: NodeJS.ProcessEnv; homeDir?: string } = {},
): DshLocalDiscovery {
  const env = options.env ?? process.env;
  const isolatedTest = options.homeDir === undefined && !env.DSH_HOME?.trim() && Boolean(env.TYCHO_TEST_CACHE || env.NODE_TEST_CONTEXT);
  const dshHome = isolatedTest ? null : resolveDshHome(env, options.homeDir);

  const headless = parseDshYamlRoutes(headlessDump);
  let desktop: ReturnType<typeof parseDshYamlRoutes> | null = null;
  if (dshHome) {
    const desktopPatchPath = join(dshHome, 'profiles', 'desktop', 'cordis.patch.yml');
    if (existsSync(desktopPatchPath)) {
      try {
        desktop = parseDshYamlRoutes(readFileSync(desktopPatchPath, 'utf8'));
      } catch { /* ignore unreadable desktop patch */ }
    }
  }

  let hasAccountGrant = false;
  let hasApiKey = !isolatedTest && Boolean(env.DEEPSEEK_API_KEY?.trim());
  if (dshHome) {
    const credsPath = join(dshHome, '.credentials.yaml');
    if (existsSync(credsPath)) {
      try {
        const credsYaml = readFileSync(credsPath, 'utf8');
        hasAccountGrant = parseDshPlatformGrant(credsYaml) !== null;
        const refs = parseDshCredentialRefs(credsYaml);
        if (refs.DEEPSEEK_API_KEY?.trim()) hasApiKey = true;
      } catch { /* ignore unreadable credentials */ }
    }
  }

  const routes: ExecutorRouteOption[] = [];
  const seenRoute = new Set<string>();
  const addRoute = (opt: ExecutorRouteOption) => {
    const id = opt.id.trim();
    if (!id || seenRoute.has(id)) return;
    seenRoute.add(id);
    routes.push({
      id,
      ...(opt.label && opt.label !== id ? { label: opt.label } : {}),
      ...(opt.source ? { source: opt.source } : {}),
    });
  };

  const models: ModelInfo[] = [];
  const addModel = (m: ModelInfo) => {
    if (!m.id.trim()) return;
    const existing = models.find((x) => x.id === m.id);
    if (!existing) {
      models.push({ ...m });
    } else if ((!existing.efforts || existing.efforts.length === 0) && m.efforts && m.efforts.length > 0) {
      existing.efforts = [...m.efforts];
    }
  };

  // 1) Official DeepSeek Account subscription channel
  const accountEnabledInHeadless = headless.entries['llm-deepseek-account']?.present && !headless.entries['llm-deepseek-account']?.disabled;
  if (hasAccountGrant || accountEnabledInHeadless) {
    addRoute({ id: DSH_ACCOUNT_ROUTE, label: 'DeepSeek 账号', source: 'account' });
    for (const m of OFFICIAL_MODELS) addModel(m);
  }

  // 2) Official DeepSeek API Key channel
  const officialEnabledInHeadless = headless.entries['llm-deepseek']?.present && !headless.entries['llm-deepseek']?.disabled;
  if (hasApiKey || officialEnabledInHeadless) {
    addRoute({ id: DSH_OFFICIAL_ROUTE, label: 'DeepSeek (API Key)', source: 'api-key' });
    for (const m of OFFICIAL_MODELS) addModel(m);
  }

  // 3) Custom `llm-pi-ai` providers merged across headless + desktop
  const customMap = new Map<string, ParsedCustomProvider>();
  for (const list of [headless.customProviders, desktop?.customProviders ?? []]) {
    for (const p of list) {
      const prev = customMap.get(p.id);
      if (!prev) {
        customMap.set(p.id, { id: p.id, ...(p.displayName ? { displayName: p.displayName } : {}), models: [...p.models] });
      } else {
        if (!prev.displayName && p.displayName) prev.displayName = p.displayName;
        for (const m of p.models) {
          if (!prev.models.some((x) => x.id === m.id)) prev.models.push(m);
        }
      }
    }
  }
  for (const custom of customMap.values()) {
    addRoute({ id: custom.id, ...(custom.displayName ? { label: custom.displayName } : {}), source: 'custom' });
    for (const m of custom.models) addModel(m);
  }

  const defaultRoute = headless.defaultProvider ?? desktop?.defaultProvider ?? null;
  if (defaultRoute && !seenRoute.has(defaultRoute)) {
    addRoute({ id: defaultRoute, source: 'custom' });
  }

  return { defaultRoute, routes, models };
}

// Extract ONLY the `- id: llm-pi-ai` patch entry from `$DSH_HOME/profiles/desktop/cordis.patch.yml`
// so headless workers automatically inherit custom gateways & models configured in DeepSeek Harness Desktop.
export function extractDesktopProvidersPatch(
  options: { env?: NodeJS.ProcessEnv; homeDir?: string } = {},
): string | null {
  const dshHome = resolveDshHome(options.env, options.homeDir);
  const desktopPatchPath = join(dshHome, 'profiles', 'desktop', 'cordis.patch.yml');
  if (!existsSync(desktopPatchPath)) return null;
  let text: string;
  try {
    text = readFileSync(desktopPatchPath, 'utf8');
  } catch {
    return null;
  }
  const lines = text.split(/\r?\n/);
  const heads = lines.flatMap((line, idx) => (/^-(?:\s|$)/.test(line) ? [idx] : []));
  for (let i = 0; i < heads.length; i += 1) {
    const start = heads[i]!;
    const end = heads[i + 1] ?? lines.length;
    const match = /^-\s*id:\s*(.+)$/.exec(lines[start]!);
    if (!match || unquote(match[1]!) !== 'llm-pi-ai') continue;
    const slice = lines.slice(start, end);
    while (slice.length > 0 && slice[slice.length - 1]!.trim() === '') slice.pop();
    if (slice.length > 0) return `${slice.join('\n')}\n`;
  }
  return null;
}

// Augment a machine-local `dsh` tier patch at snapshot materialization time so selecting
// `deepseek-account`, `deepseek-official`, or a custom provider works seamlessly in `headless`
// even when `headless/cordis.patch.yml` disabled official routes or credentials by default.
export function dshTierOverlayText(tierText: string, managedAccount: boolean): string {
  if (managedAccount || tierText.trim() === '') return tierText;
  const parsed = PATCH_LIST.parse(tierText);
  const provider = parsed?.provider.trim() ?? '';
  if (!provider) return tierText;

  const existingIds = new Set(
    tierText
      .split(/\r?\n/)
      .map((line) => /^-\s*id:\s*(.+)$/.exec(line))
      .filter((m): m is RegExpExecArray => m !== null)
      .map((m) => unquote(m[1]!)),
  );

  const additions: string[] = [];
  const ensureEnabled = (id: string) => {
    if (!existingIds.has(id)) {
      additions.push(`- id: ${id}\n  disabled: false`);
    }
  };

  ensureEnabled('credentials');
  if (provider === DSH_ACCOUNT_ROUTE) {
    ensureEnabled('deepseek-account');
    ensureEnabled('llm-deepseek-account');
  } else if (provider === DSH_OFFICIAL_ROUTE) {
    ensureEnabled('llm-deepseek');
  }

  if (additions.length === 0) return tierText;
  const trimmed = tierText.replace(/\s+$/, '');
  return `${trimmed}\n${additions.join('\n')}\n`;
}
