import { shapeOf, type TierFieldName, type TierFormSpec, type TierShape } from '@shared/tier-form.ts';
import type { ProviderDraft } from '@shared/provider-form.ts';
import { modelText, tierText } from '@shared/labels.ts';
import { formatTime } from '@shared/time.ts';
import { TIER_IDS, isTierId } from '@shared/tiers.ts';
import type { AccountModels, MachineCheck, Account, Tier } from './types.ts';

const MINUTE_MS = 60_000;

// One row of the tier list: the name of the tier, whether it is the executor's own text or
// a place on the machine, and that text or place as it was written. Nothing here is
// reassembled: the text is the executor's own file, and a trim would be a byte it never
// gets. The values the form edits are read out of that text each time the row is drawn, so
// what is saved is always what the text says.
export interface TierRow {
  name: string;
  value: string;
  // Whether this login holds the tier at all. The form draws all tiers whatever the login
  // holds, so a blank row alone cannot tell "this login does not take it" from "it takes it,
  // and its content is empty" — which is a real value for dsh, whose tiers are the empty text.
  // Absent is the same as false: a blank row of a login that did not have it.
  held?: boolean;
}

// What the page needs of a tier: the shape of the executor's text, and which values its own
// declaration edits. Undefined when the executor declares no form, and then a row is its
// raw text only.
export type TierEditor = TierShape & { fields: readonly TierFieldName[]; efforts: readonly string[] };

export const tierEditorOf = (forms: Record<string, TierFormSpec>, executor: string): TierEditor | undefined => {
  const spec = forms[executor];
  const shape = shapeOf(spec);
  return spec === undefined || shape === undefined ? undefined : { ...shape, fields: spec.fields, efforts: spec.efforts };
};

// An account as its form holds it: each field is the text in its box, the tiers as rows,
// the time limit in minutes. `credential` is the login token a new account is made with;
// it is typed, sent once and never read back. A machine's own login is the same form with
// no name or token: those are the machine's.
export interface AccountForm {
  name: string;
  executor: string;
  tiers: TierRow[];
  permission_mode: string;
  timeout: string;
  max_runs: string;
  credential: string;
}

const rowOf = (name: string, tier: Tier): TierRow => ({ name, value: tier.text, held: true });

// A row that says nothing. The fixed rows start this way, and an empty one is an account
// that does not take that tier.
export const blankTier = (row: TierRow): boolean => row.value.trim() === '';

// The rows of the form, in the one order there is: the tiers, always all present — a name
// the account does not hold is a blank row — and then any name the ledger still keeps from
// an older layout, marked as such by its not being one of the tiers.
export const tierRowsOf = (tiers: Record<string, Tier> | undefined): TierRow[] => [
  ...TIER_IDS.map((id) => (tiers?.[id] === undefined ? { name: id, value: '', held: false } : rowOf(id, tiers[id]!))),
  ...Object.entries(tiers ?? {}).filter(([name]) => !isTierId(name)).map(([name, tier]) => rowOf(name, tier)),
];

export const formOf = (account: Partial<Omit<Account, 'credential' | 'id'>> & { executor: string }): AccountForm => ({
  name: account.name ?? '',
  executor: account.executor,
  credential: '',
  tiers: tierRowsOf(account.tiers),
  permission_mode: account.permission_mode ?? '',
  timeout: account.timeout_ms == null ? '' : String(account.timeout_ms / MINUTE_MS),
  max_runs: account.max_runs == null ? '' : String(account.max_runs),
});

// The form a new account opens with: the fixed rows, blank. What their content is, is the
// executor's own; the model is the one thing the owner must know, so it is left for them to
// type — and a row left blank is an account that does not take that tier.
export const newAccountForm = (executor: string): AccountForm =>
  ({ ...formOf({ executor }), tiers: TIER_IDS.map((id) => ({ name: id, value: '', held: false })) });

// What stops the tier rows from becoming a mapping, said with the row it is about: a name
// the system no longer uses would be refused by the service, two rows of one name would
// keep the last of them and quietly lose the other. Both are the owner's to fix; `at` is the
// row a message belongs beside, null when it is about the list itself. A blank row is not a
// problem: it is an account that does not take that tier. A row with no model is not either:
// the model left out is the executor's own default, which is how a login the host adopted from
// a machine's report starts.
export interface TierProblem {
  at: number | null;
  message: string;
}

export function tierRefusal(rows: readonly TierRow[], editor: TierEditor | undefined): TierProblem | null {
  const seen = new Map<string, number>();
  for (const [index, row] of rows.entries()) {
    const name = row.name.trim();
    if (name === '') return { at: null, message: `第 ${index + 1} 个档位没有名字：填上名字，或者把这一行删掉` };
    if (!isTierId(name)) return { at: index, message: `${tierText.stale}：${tierText.staleNote}` };
    const first = seen.get(name);
    if (first !== undefined) return { at: null, message: `第 ${index + 1} 个档位和第 ${first + 1} 个都叫 ${name}：档位名不能重复` };
    seen.set(name, index);
    if (blankTier(row) || editor === undefined) continue;
    if (editor.parse(row.value) === undefined) return { at: index, message: tierText.unreadable };
  }
  return null;
}

// The models the account's own executor reported it may use, as the form offers them: the
// ones it lists, with the ones it hides left out. Empty until something has been read, and
// then the form takes a model typed by hand — which is also what keeps an alias the
// executor accepts usable.
export function modelChoices(models: AccountModels | undefined): string[] {
  return (models?.list ?? []).filter((model) => model.hidden !== true).map((model) => model.id);
}

const modelOf = (models: AccountModels | undefined, id: string) => (models?.list ?? []).find((model) => model.id === id);

// Whether the model a tier names is one this account's list does not have. A list never
// read says nothing about it, so nothing is marked then.
export function modelMissing(models: AccountModels | undefined, model: string): boolean {
  return model.trim() !== '' && (models?.list.length ?? 0) > 0 && modelOf(models, model) === undefined;
}

// The strengths to offer for the model a tier names: the ones its own entry takes, and the
// executor's own declaration when the list says nothing about that model.
export function effortChoices(models: AccountModels | undefined, model: string, declared: readonly string[]): string[] {
  const efforts = modelOf(models, model)?.efforts;
  return efforts && efforts.length > 0 ? [...efforts] : [...declared];
}

// The strength the executor uses when a tier names none, when it said so for this model.
export const defaultEffortOf = (models: AccountModels | undefined, model: string): string | undefined =>
  modelOf(models, model)?.defaultEffort;

// What the account's card says about the models, and when they were read: an old list is
// never shown as a fresh one, and a query on its way says so rather than looking stuck.
export function modelsLine(models: AccountModels | undefined, now: number = Date.now()): string {
  const asked = models?.refreshing ? `${modelText.refreshing} ` : '';
  if (!models || models.at === null) return `${asked}${modelText.notRead}：${modelText.ask}`;
  const listed = models.list.filter((model) => model.hidden !== true).length;
  return `${asked}${modelText.count(listed)}${modelText.readAt(formatTime(models.at, new Date(now)))}`;
}

// The account a form is being edited on, as far as its models go: a form whose executor has
// been changed is about another executor's account, and that account's list says nothing
// about this one.
export const modelsFor = (account: Account | undefined, executor: string): AccountModels | undefined =>
  account !== undefined && account.executor === executor ? account.models : undefined;

// An empty box is "not set". A time limit and a ceiling that are no number go as typed,
// for the service to refuse in its own words. `permissionModes` is what the chosen
// executor's command takes, from the page: a mode it does not take is not sent, so
// switching executor drops the field the way the form drops it. A tier goes as the kind it
// is: content is the executor's own text, sent as written, and a ref is the place it
// names, trimmed the way a path or name is. A blank row is left out entirely: that is what
// an account that does not take this tier holds.
// What a login carries whoever holds it: the tiers, the permission mode and the two limits.
// A machine's own login is saved with this and nothing else.
// A blank row is left out only when the login does not hold it: a tier the login holds with
// an empty text (how a machine's dsh login runs on its own configuration) is sent as it is.
export function loginSettingsBody(form: AccountForm, permissionModes: readonly string[] = []) {
  const minutes = form.timeout.trim();
  const most = form.max_runs.trim();
  return {
    tiers: Object.fromEntries(
      form.tiers
        .filter((row) => !(blankTier(row) && row.held !== true))
        .map((row) => [row.name.trim(), { kind: 'content', text: row.value }]),
    ),
    permission_mode: permissionModes.includes(form.permission_mode) ? form.permission_mode : null,
    timeout_ms: minutes === '' ? null : Number.isNaN(Number(minutes)) ? minutes : Math.round(Number(minutes) * MINUTE_MS),
    max_runs: most === '' ? null : Number.isNaN(Number(most)) ? most : Number(most),
  };
}

// An account's: the executor besides, the token when one was typed — a
// new account is made with it, and an existing one keeps the one it holds without it — and the
// line, for an account that is one (left out, an existing account keeps the line it has).
export function accountBody(form: AccountForm, permissionModes: readonly string[] = [], provider?: ProviderDraft) {
  return {
    name: form.name.trim(),
    executor: form.executor,
    ...loginSettingsBody(form, permissionModes),
    ...(form.credential === '' ? {} : { credential: form.credential }),
    ...(provider === undefined ? {} : { provider }),
  };
}

// The rows with one field said for each that names a model: what the line an account is decides,
// and the owner is not asked. A blank row stays blank — a tier the account does not take.
export function withField(rows: readonly TierRow[], editor: TierEditor | undefined, field: TierFieldName, value: string): TierRow[] {
  if (!editor || !editor.fields.includes(field)) return [...rows];
  return rows.map((row) => {
    if (blankTier(row)) return row;
    const values = editor.parse(row.value);
    return values === undefined || values[field] === value ? row : { ...row, value: editor.render({ ...values, [field]: value }, row.value) };
  });
}

export function checkLine({ machine_id: id, host, reachable, error, version, logged_in: login }: MachineCheck): string {
  const facts = [version, login == null ? null : login ? '已登录' : '没有登录'].filter(Boolean);
  const name = id && id !== host ? `${id}（${host}）` : host;
  return `${name}：${reachable ? '连得上' : '连不上'}${error ? `，${error}` : ''}${facts.map((fact) => ` · ${fact}`).join('')}`;
}

export const checkFine = (answer: MachineCheck): boolean =>
  answer.reachable && !answer.error && answer.logged_in !== false;

// The list with the account a save answered with: in the place of the one it was, or added.
export const withAccount = (accounts: Account[], account: Account): Account[] =>
  accounts.some((each) => each.id === account.id) ? accounts.map((each) => (each.id === account.id ? account : each)) : [...accounts, account];
