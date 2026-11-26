// Execution accounts are objects the owner adds, changes and removes in the console. An
// account is a login tycho keeps (docs/design/accounts-machines-decoupled.md): it names no
// machine, and runs on any machine that is online and has its executor, its token handed to
// each round. The ledger keeps accounts; this is what decides a valid one, and what the
// Runner, the dispatcher and the tools ask for an account, at each use.
//
// An account's login token is a file the ledger names by a number. Writing the file is not
// what puts the token in use: the ledger's commit is, and it names the file it means. So the
// two can never disagree about which token is the account's, whatever crashes in between —
// what a crash leaves is a file nothing names, or a mark about a number the account no
// longer holds.
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { decodeCodexOAuth, isCodexOAuthSecret, MAX_CODEX_OAUTH_SECRET_CHARS } from '../adapters/codex-auth.ts';
import type { Executors, Provider, Tier } from '../adapters/types.ts';
import type { Account, AccountStore, Login } from '../runner/snapshot.ts';
import { tierFormSpec, type TierFormSpec } from '../shared/tier-form.ts';
import type { ProviderForm } from '../shared/provider-form.ts';
import { isTierId, tierOnlyText } from '../shared/tiers.ts';
import type { CredentialState, LoginStatus } from '../shared/labels.ts';
import { accountNameProblem, NO_CREDENTIAL_TEXT, takesTypedLogin, type AccountLoginWay } from '../shared/logins.ts';
import { InputError } from './errors.ts';
import { ulid } from './ids.ts';
import { unusableHere } from './readonly.ts';
import type { NodeExecutorStatus } from '../shared/node-protocol.ts';
import { credentialRejected, loginRefused } from './ledger.ts';
import type { Ctx, Ledger, AccountRecord } from './ledger.ts';
import { accountsSecretDir, accountCredentialFile, putSecret, readSecret } from './secrets.ts';
import { restingUntil, usageNow } from './ledger.ts';

// What a login may set per executor is the executor's own declaration, read here and in
// the console: this file knows no executor by name. The name's shape is declared in
// shared/logins.ts, which the ledger's default-name rule reads too.

// What a login carries whoever holds it, an account or a machine, as someone wrote it in
// the console or a tool. Every field is a claim until checked.
export interface LoginSettingsInput {
  tiers?: unknown;
  permissionMode?: unknown;
  timeoutMs?: unknown;
  maxRuns?: unknown;
}

// An account as someone wrote it. `credential` is the login token itself: required when the
// account is made, and replaces the one it holds when given later.
export interface AccountInput extends LoginSettingsInput {
  name?: unknown;
  executor?: unknown;
  credential?: unknown;
  // For an executor whose account is a line to a model service: the line, as the console's
  // form gathered it. Left out of a later write, the account keeps the line it has.
  provider?: unknown;
}

// What a form sends for a field left empty is the same as leaving it out. Read by this module
// and by the HTTP surface, so that both agree on what an account write names.
export const absent = (value: unknown): boolean => value === undefined || value === null || value === '';

function text(value: unknown, what: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new InputError(`${what}不能为空`);
  return value.trim();
}

// One tier as the owner wrote it: the executor's own text, which rides the snapshot. Whether
// the value is one the executor could be given at all is the adapter's own declaration, read
// here and again before a Run is created: the CLI would otherwise drop the tier and run on the
// machine's own without a word.
function tierOf(executors: Executors, executor: string, tier: string, value: unknown): Tier {
  const what = `档位 ${tier}`;
  if (value === null || typeof value !== 'object' || Array.isArray(value) || (value as { kind?: unknown }).kind !== 'content') {
    throw new InputError(`${what} 要写成 { "kind": "content", "text": "…" }：档位的内容由 tycho 随这一轮送到机器上`);
  }
  const body = (value as { text?: unknown }).text;
  if (typeof body !== 'string') throw new InputError(`${what} 的内容应为一段文字`);
  // As written: the text is the executor's own file, and a trim here would be a byte the
  // machine does not get.
  const held: Tier = { kind: 'content', text: body };
  const why = executors[executor]?.checkTier?.(held);
  if (why) throw new InputError(`${what}：${why}`);
  return held;
}

// Names are display labels and the Router's vocabulary, never stored references.
export function checkAccountName(id: string): string {
  const problem = accountNameProblem(id);
  if (problem !== null) throw new InputError(problem);
  return id;
}

function requireExecutor(executors: Executors, value: unknown): string {
  const executor = text(value, '执行器');
  if (!Object.hasOwn(executors, executor)) throw new InputError(`没有执行器 ${executor} 的适配器，可选：${Object.keys(executors).join('、')}`);
  return executor;
}

// What a login carries, checked the one way for an account and for a machine's own login:
// the two tiers by the executor's own reading, the permission modes its command takes, and
// two positive numbers.
export function checkLoginSettings(executor: string, input: LoginSettingsInput, executors: Executors): Pick<Login, 'tiers' | 'permissionMode' | 'timeoutMs' | 'maxRuns'> {
  const tierEntries = input.tiers !== null && typeof input.tiers === 'object' && !Array.isArray(input.tiers)
    ? Object.entries(input.tiers)
    : [];
  if (tierEntries.length === 0) throw new InputError('档位至少要填一个');
  // No prototype: a tier name comes from the Router, and "constructor" is not a tier.
  const tiers = Object.create(null) as Record<string, Tier>;
  for (const [tier, value] of tierEntries) {
    // The names are the interface between a Task and a login: a login may have only these
    // two, and only this many (docs/design/roles-and-tiers.md §2).
    if (!isTierId(tier)) throw new InputError(tierOnlyText(tier));
    tiers[tier] = tierOf(executors, executor, tier, value);
  }

  let permissionMode: string | undefined;
  if (!absent(input.permissionMode)) {
    const modes = executors[executor]?.permissionModes ?? [];
    if (modes.length === 0) {
      // Only the executors that have such modes are worth naming in the refusal.
      const named = Object.entries(executors).filter(([, each]) => (each.permissionModes?.length ?? 0) > 0).map(([name]) => name);
      throw new InputError(named.length === 0
        ? '没有执行器的命令有权限模式'
        : `权限模式只对 ${named.join('、')} 执行器有意义`);
    }
    if (typeof input.permissionMode !== 'string' || !modes.includes(input.permissionMode)) {
      throw new InputError(`权限模式应为 ${modes.join('、')} 之一`);
    }
    permissionMode = input.permissionMode;
  }

  const { timeoutMs } = input;
  if (!absent(timeoutMs) && (!Number.isInteger(timeoutMs) || (timeoutMs as number) < 1)) {
    throw new InputError('单次执行时限应为正整数');
  }

  const { maxRuns } = input;
  if (!absent(maxRuns) && (!Number.isInteger(maxRuns) || (maxRuns as number) < 1)) {
    throw new InputError('同时最多几轮执行应为正整数，不限就留空');
  }

  return {
    ...(permissionMode === undefined ? {} : { permissionMode }),
    tiers,
    ...(absent(timeoutMs) ? {} : { timeoutMs: timeoutMs as number }),
    ...(absent(maxRuns) ? {} : { maxRuns: maxRuns as number }),
  };
}

// The line of an account whose executor declares one: read by that executor's adapter, which
// alone knows its shape, and every tier checked against it — a tier that names another line,
// or turns a machine's stored credentials back on, would run as something else than this
// account. `held` is the line the account has now, kept when the write names none.
function lineOf(executor: string, input: AccountInput, tiers: Record<string, Tier>, executors: Executors, held: Provider | undefined): Provider | undefined {
  const declared = executors[executor]?.provider;
  if (!declared) {
    if (!absent(input.provider)) throw new InputError(`执行器 ${executor} 的账号没有线路这一说`);
    return undefined;
  }
  let provider = held;
  if (!absent(input.provider)) {
    const answer = declared.check(input.provider);
    if ('problem' in answer) throw new InputError(`线路：${answer.problem}`);
    provider = answer.provider;
  }
  if (provider === undefined) {
    if ((executors[executor]?.accountLogin ?? []).includes('key')) return undefined;
    throw new InputError(`执行器 ${executor} 的账号要有一条线路：它连到哪个模型服务`);
  }
  for (const [tier, value] of Object.entries(tiers)) {
    const why = declared.tierProblem(provider, value);
    if (why) throw new InputError(`档位 ${tier}：${why}`);
  }
  return provider;
}

// An account as the store keeps it. `machines` is refused by name: an account runs on any
// machine, and a list that would quietly be dropped is a list the owner thinks still holds.
// The name is optional for an account that does not exist yet: the ledger decides one in the
// transaction that writes the row (service/ledger.ts). `held`
// is the account as it stands, so that an edit which names no line keeps the one it has.
export function checkAccount(input: AccountInput, executors: Executors, held?: Pick<Account, 'executor' | 'provider'>): Omit<Account, 'id' | 'name'> & { name?: string } {
  if (Object.hasOwn(input, 'machines')) throw new InputError('账号不再列机器：带登录的账号在任何在线、装了这个执行器的机器上都能跑。要限定在哪儿跑，改项目允许的机器');
  const executor = requireExecutor(executors, input.executor);
  const settings = checkLoginSettings(executor, input, executors);
  const { tiers, ...rest } = settings;
  const provider = lineOf(executor, input, tiers, executors, held?.executor === executor ? held.provider : undefined);
  return {
    ...(absent(input.name) ? {} : { name: checkAccountName(text(input.name, '账号名字')) }),
    executor,
    ...rest,
    ...(provider === undefined ? {} : { provider }),
    tiers,
  };
}

interface AccountsOptions {
  ledger: Pick<Ledger, 'listAccounts' | 'getAccount' | 'putAccount' | 'renameAccount' | 'deleteAccount' | 'loginState' | 'accountCredentialRef' | 'recordAccountCredential'>;
  // The executors that have an adapter, by name, with what each of them declares. Read at
  // each check, so nothing here has to be told about an executor separately.
  executors: Executors;
  // The executors whose login tycho can keep and hand to a round. Only these can be an
  // account: any other executor's login is a machine's own.
  credentialExecutors?: readonly string[];
  // The executors whose adapter can drive the Router itself.
  routingExecutors?: readonly string[];
  dataDir?: string;
  log?: (line: string) => void;
}

// What the service has learned about a login by using it, as opposed to what the owner
// set. The console shows it and the Router is told it; whoever needs it asks here, so the
// two cannot come to say different things.
export function loginStatus(
  ledger: Pick<Ledger, 'loginState' | 'listActiveRuns' | 'accountCredentialRef'>,
  login: Pick<Login, 'id' | 'maxRuns'>,
  now: number = Date.now(),
): LoginStatus {
  const learned = ledger.loginState(login.id);
  const rest = restingUntil(learned, now);
  // The number the login holds now: an account's rejection names the token the executor
  // refused, and a replaced token is not that one any more. A machine's own login has no
  // number; its refusal is the moment its machine reported it.
  const ref = ledger.accountCredentialRef(login.id);
  return {
    active_runs: ledger.listActiveRuns().filter((run) => run.login_id === login.id).length,
    max_runs: login.maxRuns ?? null,
    rest: rest === undefined ? null : { until: new Date(rest).toISOString(), reason: learned.rest_reason },
    usage: usageNow(learned, now).map(({ window, used, resets_at, at }) => ({ window, used, resets_at, at })),
    ...(loginRefused(learned, ref) ? { rejected: true } : {}),
  };
}

const TOKEN_TEXT = '登录的密钥应为一段不含空白的文字';

export function createAccounts({ ledger, executors, credentialExecutors = [], routingExecutors = [], dataDir, log = console.error }: AccountsOptions) {
  // The file a number names. `dataDir` absent is a service that does not keep tokens.
  const fileOf = (ref: string): string => {
    if (!dataDir) throw new InputError('凭据保管不可用');
    return accountCredentialFile(dataDir, ref);
  };
  // The ledger names a credential, but only its file can supply it. Backups deliberately
  // omit those files, so a restored reference alone does not make a usable login.
  const credentialState = (id: string): CredentialState => {
    const ref = ledger.accountCredentialRef(id);
    if (dataDir !== undefined && (ref === null || readSecret(fileOf(ref)) === '')) return 'missing';
    return credentialRejected(ledger.loginState(id), ref) ? 'rejected' : 'set';
  };
  const isSignedIn = (account: Pick<AccountRecord, 'id' | 'executor'>): boolean => {
    const ref = ledger.accountCredentialRef(account.id);
    if (ref?.startsWith('oauth-') === true) return true;
    const ways = credentialExecutors.includes(account.executor) ? executors[account.executor]?.accountLogin ?? [] : [];
    return ways.length > 0 && !takesTypedLogin(ways);
  };
  const view = (account: AccountRecord): AccountRecord => ({
    ...account,
    canRoute: routingExecutors.includes(account.executor),
    signedIn: isSignedIn(account),
    credential: credentialState(account.id),
  });
  // A file no account names is nobody's. Removing it is best effort: what matters is that
  // the ledger does not name it, and a start removes what is left.
  const dropFile = (ref: string, whose: string): void => {
    try {
      rmSync(fileOf(ref), { force: true });
    } catch {
      log(`${whose}的旧凭据文件没删掉，下次启动再清理`);
    }
  };
  // The token written to a file of its own, before any ledger write names it.
  const stage = (executor: string, value: unknown): string => {
    if (!credentialExecutors.includes(executor)) {
      throw new InputError(`执行器 ${executor} 的登录不能交给 tycho 保管：它只能是机器自己的登录。机器报告已登录后，它自动成为那台机器自己的登录，带好默认档位，马上能派活`);
    }
    if (typeof value !== 'string' || value === '' || /[\s\0]/.test(value)) throw new InputError(TOKEN_TEXT);
    const oauth = isCodexOAuthSecret(value);
    if (oauth && decodeCodexOAuth(value) === undefined) throw new InputError('Codex 授权凭据格式无效');
    const ref = oauth ? `oauth-${randomUUID()}` : randomUUID();
    putSecret(fileOf(ref), value, undefined, oauth ? MAX_CODEX_OAUTH_SECRET_CHARS : undefined);
    return ref;
  };
  return {
    credentialState,
    executors: Object.keys(executors),
    canRoute: (executor: string): boolean => routingExecutors.includes(executor),
    credentialExecutors,
    // How an account of each executor gets its login, by executor, as each declares it: none
    // for an executor whose login tycho cannot keep.
    accountLogins: (): Record<string, readonly AccountLoginWay[]> =>
      Object.fromEntries(Object.keys(executors).map((id) => [id, credentialExecutors.includes(id) ? executors[id]!.accountLogin ?? [] : []])),

    // A machine's report of its executors as this host reads it (nodes.md §1.2): whether the
    // executor offers a read-only way at all, and, by this host's own lowest version, why it
    // takes no work there — a client older than the host would not know to say so.
    judgeReport: (status: NodeExecutorStatus): NodeExecutorStatus & { read_only_offered: boolean } => {
      const unusable = unusableHere(status, executors[status.executor]?.minVersion);
      return { ...status, ...(unusable === undefined || !status.installed ? {} : { unusable }), read_only_offered: executors[status.executor] !== undefined };
    },

    // Whether this executor can be asked for the quota of its own login there
    // (docs/design/usage.md §3): a fact of its adapter, read here so that the usage page and
    // the refresh that page offers ask the same question. False is "这个执行器不提供用量".
    machineQuotaOffered: (executor: string): boolean => executors[executor]?.machineQuota !== undefined,

    // The permission modes each executor takes, by executor, for the console: an executor
    // whose command has none of its own is left out.
    permissionModes: (): Record<string, string[]> => {
      const modes: Record<string, string[]> = {};
      for (const [name, each] of Object.entries(executors)) if (each.permissionModes?.length) modes[name] = [...each.permissionModes];
      return modes;
    },

    // How each executor's tier is written and read, by executor, for the console's form: an
    // executor that declares no form is shown as its raw text. The functions stay here.
    tierForms: (): Record<string, TierFormSpec> => {
      const forms: Record<string, TierFormSpec> = {};
      for (const [name, each] of Object.entries(executors)) if (each.tierForm) forms[name] = tierFormSpec(each.tierForm);
      return forms;
    },

    // What the console asks to define a line, by executor, for an executor whose account is one.
    providerForms: (): Record<string, ProviderForm> => {
      const forms: Record<string, ProviderForm> = {};
      for (const [name, each] of Object.entries(executors)) if (each.provider) forms[name] = each.provider.form;
      return forms;
    },

    // A line as someone wrote it, read by its executor's adapter: the same check a save makes.
    checkLine(executor: string, value: unknown): Provider {
      const declared = executors[requireExecutor(executors, executor)]?.provider;
      if (!declared) throw new InputError(`执行器 ${executor} 的账号没有线路这一说`);
      const answer = declared.check(value);
      if ('problem' in answer) throw new InputError(`线路：${answer.problem}`);
      return answer.provider;
    },

    // The file is written first and the ledger names it second: until that commit the
    // account is still on what it was on. A commit that fails leaves the new file
    // unnamed — it is not deleted here, because a failure *after* the commit must not
    // take away the file the ledger now names — and the next start removes it.
    setCredential(id: string, value: unknown, ctx: Ctx): void {
      const account = ledger.getAccount(id);
      if (!account) throw new InputError('账号不存在：' + id);
      const ref = stage(account.executor, value);
      const before = ledger.accountCredentialRef(id);
      ledger.recordAccountCredential(id, ref, ctx);
      if (before !== null && before !== ref) dropFile(before, `账号 ${id}`);
    },

    // What a start does: a file under the accounts directory that no account names is
    // either a crash's leftover or a draft of the older, account-named layout.
    cleanCredentials(): void {
      if (!dataDir) return;
      const dir = accountsSecretDir(dataDir);
      if (!existsSync(dir)) return;
      const retained = new Set(ledger.listAccounts().flatMap((account) => {
        const ref = ledger.accountCredentialRef(account.id);
        return ref === null ? [] : [ref];
      }));
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory() || retained.has(entry.name)) continue;
        try { rmSync(join(dir, entry.name), { force: true }); }
        catch { log('账号凭据的孤儿文件没删掉，下次启动再清理'); }
      }
    },

    // Replaces the stored secret bytes in place while keeping the same `ref` in the ledger,
    // used strictly by the Host token refresher when rotating an access/refresh token pair
    // of the same OAuth login so in-flight Runs keep matching `snapshot.credential_ref`.
    refreshCredential(id: string, expectedRef: string, value: string): boolean {
      if (!dataDir || !expectedRef) return false;
      if (ledger.accountCredentialRef(id) !== expectedRef) return false;
      const oauth = isCodexOAuthSecret(value);
      if (oauth && decodeCodexOAuth(value) === undefined) return false;
      putSecret(fileOf(expectedRef), value, undefined, oauth ? MAX_CODEX_OAUTH_SECRET_CHARS : undefined);
      if (ledger.accountCredentialRef(id) !== expectedRef) {
        dropFile(expectedRef, `账号 ${id}`);
        return false;
      }
      return true;
    },

    // The token the account uses now, with the number that names it, for the one caller
    // that must hand it to an executor. Undefined when the file is gone: a number without a
    // file names nothing, and is not something to start with.
    credentialOf(id: string): { ref: string; value: string } | undefined {
      if (!dataDir) return undefined;
      const ref = ledger.accountCredentialRef(id);
      if (ref === null) return undefined;
      const value = readSecret(fileOf(ref));
      return value === '' ? undefined : { ref, value };
    },

    // Read through to the ledger on every call: whoever holds the store never holds a
    // copy, so a change shows at the next use.
    get: (id: string): AccountRecord | undefined => { const account = ledger.getAccount(id); return account && view(account); },
    list: (): AccountRecord[] => ledger.listAccounts().map(view),

    // A new account comes with its token, in the one write that makes it: there is no
    // moment at which it stands without one. A token given to an account that exists
    // replaces the one it holds, in the same write as the rest.
    put(input: AccountInput & { id?: string }, ctx: Ctx): { account: AccountRecord; created: boolean } {
      const existing = input.id === undefined ? undefined : ledger.getAccount(input.id);
      if (input.id !== undefined && !existing) throw new InputError('账号不存在：' + input.id);
      const renameOnly = existing !== undefined && Object.keys(input).every((field) => field === 'id' || field === 'name');
      if (renameOnly) {
        // A rename is the owner's word for the name it becomes: a name already taken is
        // refused here, not numbered as a new account's default is (service/ledger.ts).
        if (absent(input.name)) throw new InputError('改名字要填新的名字');
        const name = checkAccountName(text(input.name, '账号名字'));
        ledger.renameAccount(existing.id, name, ctx);
        return { account: view(ledger.getAccount(existing.id)!), created: false };
      }
      const account: Omit<Account, 'name'> & { name?: string } = { ...checkAccount(input, executors, existing), id: existing?.id ?? ulid() };
      // An edit that sends no name keeps the one it has — but an empty one is a rename to
      // nothing, and is refused rather than quietly ignored. A new account with no name gets
      // the ledger's default.
      if (account.name === undefined && input.name !== undefined && existing) throw new InputError('账号的名字不能为空');
      if (account.name === undefined && existing) account.name = existing.name;
      const before = existing ? ledger.accountCredentialRef(existing.id) : null;
      if (!existing && absent(input.credential)) throw new InputError(NO_CREDENTIAL_TEXT);
      const ref = absent(input.credential) ? undefined : stage(account.executor, input.credential);
      const { created } = ledger.putAccount(account, ctx, ref);
      if (before !== null && ref !== undefined && before !== ref) dropFile(before, `账号 ${account.name ?? account.id}`);
      return { account: view(ledger.getAccount(account.id)!), created };
    },

    // The projects the login was removed from come back, with what each has left: the answer
    // the console shows (docs/design/native-login.md §2).
    remove(id: string, ctx: Ctx, options: { confirmed?: boolean } = {}): { projects: { id: string; name: string; remaining: number }[] } {
      const ref = ledger.accountCredentialRef(id);
      const { projects } = ledger.deleteAccount(id, ctx, options);
      if (ref !== null) dropFile(ref, `账号 ${id}`);
      return { projects };
    },
  } satisfies AccountStore & Record<string, unknown>;
}

export type Accounts = ReturnType<typeof createAccounts>;
