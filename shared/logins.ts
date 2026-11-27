// A login is whose identity a round runs as (docs/design/accounts-machines-decoupled.md): an
// account, the login tycho keeps and hands to a round on any machine, or a machine's own
// login of one executor, which runs on that machine only. References are opaque ledger ids;
// names belong only to display and the Router boundary. Never infer kind from an id.

import { onLocaleChange, t } from './i18n.ts';

export type LoginDisplay = string | { name: string; machine?: string; executor?: string };

type LoginRef =
  | { kind: 'account'; account: string }
  | { kind: 'machine'; machine: string; executor: string };

export const machineLoginName = (machine: string, executor: string): string => `${machine}/${executor}`;

export function parseLoginName(name: string): LoginRef {
  const at = name.lastIndexOf('/');
  if (at < 0) return { kind: 'account', account: name };
  return { kind: 'machine', machine: name.slice(0, at), executor: name.slice(at + 1) };
}

// The console page a login is set up on, by its kind: an account on 账号, a machine's own
// login on 机器. A notice's words and its link both come from here.
export function loginPage(login: LoginDisplay): { path: '/accounts' | '/machines'; name: string } {
  const machine = typeof login === 'string' ? parseLoginName(login).kind === 'machine' : login.machine !== undefined;
  return machine
    ? { path: '/machines', name: t('sh.logins.page.machines') }
    : { path: '/accounts', name: t('sh.logins.page.accounts') };
}

// A login in the owner's words, for every sentence that names one.
export function loginName(login: LoginDisplay): string {
  if (typeof login !== 'string') {
    return login.machine === undefined
      ? t('sh.logins.name.account', { name: login.name })
      : t('sh.logins.name.machine', { machine: login.machine, executor: login.executor ?? '' });
  }
  const ref = parseLoginName(login);
  return ref.kind === 'account'
    ? t('sh.logins.name.account', { name: ref.account })
    : t('sh.logins.name.machine', { machine: ref.machine, executor: ref.executor });
}

// A tier a login holds in a shape no round can be given any more: the name of a file or a
// profile on the machine, which programs before content-only tiers wrote (2026-11-10). It is
// not a tier, and nothing dispatches on it; it is kept as a fact of the login, read out of the
// ledger in one place, so that the pages and the self-check say what it was, why it does not
// work, and where to fill it in again, rather than the tier just not being there.
export interface RetiredTier {
  tier: string;
  // What it named, as it was stored.
  was: string;
  text: string;
}

// Where such a login stands, on its card: never "usable" while it holds one.
export let RETIRED_TIER_STANDING: string = t('sh.logins.retiredTierStanding');

export function retiredTier(loginId: string, tier: string, was: string, label: string): RetiredTier {
  const { name } = loginPage(loginId);
  return {
    tier, was,
    text: t('sh.logins.retiredTier', { login: loginName(loginId), label, was, page: name }),
  };
}

// Why the Router stopped after the step to version 18: the account it was bound to kept no
// token and was folded into a machine's own login, which the Router cannot run as.
export const foldedRouterText = (accountId: string): string =>
  t('sh.logins.foldedRouter', { accountId });

// How the login an account is made of is obtained (docs/design/native-login.md): on the
// executor's own page, through a login session this host runs ('page'); as an API key the
// owner types ('key'); as a line to a model service and its key ('provider'); or on one of the
// machines, as that machine's own login ('machine' — the one way that makes no account: the
// window says so). An executor's adapter declares which of these it offers, in the order they
// are offered, and the console's "添加账号" window is drawn from that: a new way is a name
// here, a declaration on the adapter, and its steps in the window. A login of the other ways
// is never typed into a page (docs/design/native-login.md §5).
export const ACCOUNT_LOGIN_WAYS = ['page', 'device', 'key', 'provider', 'machine'] as const;
export type AccountLoginWay = (typeof ACCOUNT_LOGIN_WAYS)[number];
// One way as the accounts page is told of it: whether it can be done on this host now, and
// why not when it cannot.
export interface AccountLoginOffer {
  way: AccountLoginWay;
  available: boolean;
  why?: string;
}

// Whether a page may hand a login of this executor: only where one of its ways has the owner
// type the secret itself. The others obtain it elsewhere, so its credential reaches the ledger
// through that way and never through an account form (docs/design/native-login.md §5).
export const takesTypedLogin = (ways: readonly AccountLoginWay[]): boolean =>
  ways.some((way) => way === 'key' || way === 'provider');

// Why a page cannot be handed a login of this executor: the ways its adapter declares obtain
// it somewhere else.
export const typedLoginRefusal = (executor: string): string =>
  t('sh.logins.typedLoginRefusal', { executor });

// Why an account cannot be made without a login: that is all an account is.
export let NO_CREDENTIAL_TEXT: string = t('sh.logins.noCredential');

// An account's name is a display label, never a reference (docs/design/accounts-machines-
// decoupled.md): short, and free of characters that would read as path or URL syntax. One
// declaration, read by the owner-input check (service/accounts.ts) and by the numbering the
// ledger gives a new account's default name (service/ledger.ts), so the two cannot disagree.
export const ACCOUNT_NAME_MAX_CHARS = 64;
// Ordinary spaces inside a name are fine (the ledger's own default names have them, as in
// "codex 账号 2"); other whitespace, and an edge space a page would not show, are not.
export const BAD_NAME_CHARS = /[\t\n\r\v\f/\\?#%\u0000-\u001f]/;
export const accountNameProblem = (name: string): string | null => {
  if (name === '' || name === '.' || name === '..') return t('sh.logins.nameEmpty');
  if (name.length > ACCOUNT_NAME_MAX_CHARS || name !== name.trim() || BAD_NAME_CHARS.test(name)) {
    return t('sh.logins.nameRule', { max: ACCOUNT_NAME_MAX_CHARS });
  }
  return null;
};

export let HOST_MACHINE_UNKNOWN_TEXT: string = t('sh.logins.hostMachineUnknown');

onLocaleChange(() => {
  RETIRED_TIER_STANDING = t('sh.logins.retiredTierStanding');
  NO_CREDENTIAL_TEXT = t('sh.logins.noCredential');
  HOST_MACHINE_UNKNOWN_TEXT = t('sh.logins.hostMachineUnknown');
});

export const LOGIN_ALIASES_SETTING_KEY = 'login_display_aliases';

export function parseLoginAliases(raw: string | undefined | null): Record<string, string> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      const k = key.trim();
      const v = typeof value === 'string' ? value.trim() : '';
      if (k !== '' && v !== '' && v.length <= ACCOUNT_NAME_MAX_CHARS) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

export interface ExecutorRouteOption {
  id: string;
  label?: string;
  source?: 'account' | 'api-key' | 'custom';
}

// Facts learned from an executor, never owner configuration. Only the organization
// identifies matching subscriptions; the optional short label is for display.
export interface ExecutorIdentity {
  organizationId?: string | null;
  // Opaque owner of quota on this machine; null means the probe confirmed it cleared.
  quotaOwner?: string | null;
  accountLabel?: string | null;
  // Normalized subscription tier label when reported (e.g. Plus, Pro, Max, Team).
  planLabel?: string | null;
  routeLabel?: string | null;
  // Auto-discovered model routes/providers available on this machine (e.g. dsh channels).
  routes?: ExecutorRouteOption[] | null;
}

// A short handle or privacy-masked email handle (e.g. `alice` or `alice@e***.com`).
export const accountLabelOf = (value: unknown): string | undefined =>
  typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._+*@-]{0,79}$/.test(value) ? value : undefined;

export const planLabelOf = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const clean = value.trim();
  return /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,31}$/.test(clean) ? clean : undefined;
};

// Format an email into a privacy-safe yet clearly distinguishable handle:
// `alice@example.com` -> `alice@e***.com`
export function maskEmailIdentity(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  const parts = trimmed.split('@');
  if (parts.length !== 2) return undefined;
  const [local, domain] = [parts[0]!, parts[1]!];
  if (!local || !domain || !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/.test(local)) return undefined;
  const labels = domain.toLowerCase().split('.').filter(Boolean);
  if (labels.length === 0) return accountLabelOf(local);
  const first = labels[0]!;
  const tld = labels.length > 1 ? `.${labels.at(-1)!}` : '';
  const maskedDomain = first.length <= 1 ? `${first}***${tld}` : `${first[0]}***${tld}`;
  return accountLabelOf(`${local}@${maskedDomain}`);
}

export function emailAccountLabel(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const [handle, domain, ...extra] = value.split('@');
  return domain && extra.length === 0 ? accountLabelOf(handle) : undefined;
}

export function organizationIdOf(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const id = value.trim().toLowerCase();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id) ? id : undefined;
}
