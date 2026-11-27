// The tiers, and the only names an account's tier list, a Task or the Router's own tier may
// use. Declared once here: the service and the console both read this, so a page can never
// offer a name the service would refuse, and the page never invents a second name for one
// tier. What a tier *holds* — the model and the strength — is the executor's own, and lives
// in that account's value for the name.
//
// From "按职能派发，档位由职能推出" (docs/design/roles-and-tiers.md §2): the name says what
// the work is for, not how hard it is. Later steps pick the tier from the work's role; this
// step only fixes the names and their meanings.
//
// The order is the one thing the names carry besides their meaning: from the cheapest work
// (operate) to the one that thinks the most (decide). It is used in exactly two places: the
// next tier an escalation goes to (§10.3) and the substitute a login without operate content
// gets (§10.2).
import { onLocaleChange, t } from './i18n.ts';

export const TIER_IDS = ['operate', 'execute', 'decide'] as const;

export type TierId = (typeof TIER_IDS)[number];

export interface TierDecl {
  id: TierId;
  // What the page calls it.
  label: string;
  // One sentence: what this tier is for.
  use: string;
  // What its content should be, without naming a model: the strength belongs to the tier's
  // content, and a tier is not "everything at maximum".
  recommend: string;
}

export const TIERS: readonly TierDecl[] = [
  {
    id: 'operate',
    get label(): string { return t('sh.tiers.operate.label'); },
    get use(): string { return t('sh.tiers.operate.use'); },
    get recommend(): string { return t('sh.tiers.operate.recommend'); },
  },
  {
    id: 'execute',
    get label(): string { return t('sh.tiers.execute.label'); },
    get use(): string { return t('sh.tiers.execute.use'); },
    get recommend(): string { return t('sh.tiers.execute.recommend'); },
  },
  {
    id: 'decide',
    get label(): string { return t('sh.tiers.decide.label'); },
    get use(): string { return t('sh.tiers.decide.use'); },
    get recommend(): string { return t('sh.tiers.decide.recommend'); },
  },
];

export const isTierId = (name: string): name is TierId => (TIER_IDS as readonly string[]).includes(name);

export const tierDecl = (name: string): TierDecl | undefined => TIERS.find((tier) => tier.id === name);

// An account may hold a name the system no longer uses: what it was is all that can be said
// of it, and every page says the same thing about it.
export const tierLabel = (name: string): string => tierDecl(name)?.label ?? name;

const computeTierNamesText = (): string =>
  TIERS.map((tier) => t('sh.tiers.nameWithId', { label: tier.label, id: tier.id })).join(t('sh.listSep'));

const TIER_COUNT_KEYS = ['sh.tiers.count.0', 'sh.tiers.count.1', 'sh.tiers.count.2', 'sh.tiers.count.3', 'sh.tiers.count.4', 'sh.tiers.count.5'] as const;
const computeTierCountText = (): string => {
  const key = TIER_COUNT_KEYS[TIER_IDS.length];
  return key ? t(key) : String(TIER_IDS.length);
};

// The names as the owner reads them, for a refusal: "操作档（operate）、执行档（execute）、决策档（decide）".
export let tierNamesText: string = computeTierNamesText();

// How many names there are, in the owner's words. Written out rather than taken from the
// array's length so that the sentence reads as Chinese; a tier added to TIERS adds its word
// here once, instead of every refusal saying the old number.
export let TIER_COUNT_TEXT: string = computeTierCountText();

onLocaleChange(() => {
  tierNamesText = computeTierNamesText();
  TIER_COUNT_TEXT = computeTierCountText();
});

// Why a name outside them cannot be used: one sentence, so an account, a Task and the
// Router's own tier all refuse in the same words. A name an older layout left standing is
// told the same thing: what it was is the migration's business (service/db.ts), not the
// running program's.
export const tierOnlyText = (name: string): string =>
  t('sh.tiers.onlyText', { names: tierNamesText, count: TIER_COUNT_TEXT, name });

// A held content tier uses the executor's own configuration even when its text is empty.
// An omitted tier is absent; only an absent operate tier takes the execute content.
export const hasTierValue = (value: { kind: string; text: string } | undefined): boolean => value !== undefined && value.kind === 'content';

// The value a login would be given for a tier, and which tier it is: an operate-tier round
// runs on the login's own execute content when it holds no operate content of its own
// (roles-and-tiers.md §10.3). One substitution, upwards one step: a login without execute
// content does not take the cheaper operate content, and the decide tier never substitutes.
// The pick, the snapshot and the tool checks all ask here, so a login is never "missing" a
// tier the service would have run it on.
export interface TierValue<T> {
  value: T;
  // The tier the value is: the task's own, or `execute` for an operate round on a login with
  // no operate content.
  from: TierId;
}

export function tierValueFrom<T extends { kind: string; text: string }>(
  tiers: Readonly<Record<string, T | undefined>>,
  tier: string,
): TierValue<T> | undefined {
  if (!isTierId(tier)) return undefined;
  const held = (name: TierId): T | undefined => {
    const value = Object.hasOwn(tiers, name) ? tiers[name] : undefined;
    return hasTierValue(value) ? value : undefined;
  };
  const own = held(tier);
  if (own !== undefined) return { value: own, from: tier };
  if (tier !== 'operate') return undefined;
  const execute = held('execute');
  return execute === undefined ? undefined : { value: execute, from: 'execute' };
}

// What a page says when a round runs on a substitute (roles-and-tiers.md §10.3): the tier it
// ran as, and the one its content came from.
export const tierSubstituteText = (from: string): string => t('sh.tiers.substitute', { label: tierLabel(from) });
