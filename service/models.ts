// What an account's executor reports about the models it may use: when the service asks,
// what it keeps of the answer, and what the owner is told when the answer moves. The list is
// learned state, kept beside the account's rest and usage: a query that fails leaves the
// last answer standing, with the time it was read, so an old list is never taken for a
// fresh one and a good list is never wiped by a timeout. What a machine's own login may use
// is not here: its machine reports it with the rest of what it says of its executors
// (docs/design/nodes.md §1.2), and the service neither asks nor keeps it.
//
// Nothing here knows an executor by name: the adapter declares how to ask, this decides
// when. A query never touches a Run: it is not dispatch, and one login that cannot be
// reached says nothing about another.
import type { Executors, ModelInfo, Provider } from '../adapters/types.ts';
import type { Login } from '../runner/snapshot.ts';
import { loginName } from '../shared/logins.ts';
import type { ExecutorIdentity } from '../shared/logins.ts';
import type { Ledger } from './ledger.ts';
import type { Notify } from './notify.ts';

const HIDDEN = '[已隐藏]';

const scrubbed = (text: string, secret: string | undefined): string =>
  secret === undefined || secret === '' ? text : text.split(secret).join(HIDDEN);

export interface ModelReadOptions {
  executors: Executors;
  timeoutMs: number;
  fetch?: typeof fetch;
  now?: () => number;
  // For executors whose model catalog is queried via a local CLI command (e.g. Codex) rather
  // than an HTTP endpoint, read the freshest catalog already reported by an online machine.
  machineModels?: (executor: string) => { models: ModelInfo[]; at: string } | null;
}

export type ModelRead = { identity: ExecutorIdentity } & (
  | { ok: true; models: ModelInfo[]; at: string }
  | { ok: false; reason: string; status?: number });

// One request with a token, whether or not an account has been saved yet. The adapter
// owns the protocol; every caller gets the same parsing, timeout and secret-safe reason.
// `provider`: for an account that is a line to a model service, the line. What it lists is the
// answer, as the owner wrote it; a line that lists nothing is asked the way its executor's
// adapter says, with the line's key.
export async function readModels({ executor, token, provider, executors, timeoutMs, fetch: doFetch = fetch, now = Date.now, machineModels }: ModelReadOptions & { executor: string; token?: string; provider?: Provider }): Promise<ModelRead> {
  const identity: ExecutorIdentity = {};
  // Only normalized facts may leave here. A server echoing a token is not an identity.
  const remember = (facts: ExecutorIdentity): void => {
    const value = facts.organizationId;
    if (value && (!token || !value.includes(token))) identity.organizationId = value;
  };
  try {
    const declaration = executors[executor];
    if (!declaration) throw new Error(`没有执行器 ${executor} 的适配器`);
    const line = provider === undefined ? undefined : declaration.provider;
    if (provider !== undefined && line === undefined) throw new Error(`执行器 ${executor} 的账号没有线路这一说`);
    if (line !== undefined) {
      const listed = line.models(provider!);
      if (listed !== undefined) {
        return { ok: true, models: listed, at: new Date(now()).toISOString(), identity };
      }
      if (token === undefined || token === '') throw new Error('没有这条线路的密钥，问不了它提供哪些模型');
      const asked = line.discover(provider!, token);
      if (asked === undefined) throw new Error('这条线路问不了它提供哪些模型，请手填');
      const response = await doFetch(asked.url, { headers: asked.headers, signal: AbortSignal.timeout(timeoutMs) });
      if (!response.ok) throw new Error(`${asked.url} 回答 HTTP ${response.status}`);
      const models = asked.parse(await response.text());
      if (models.length === 0) throw new Error('这条线路没有报出任何模型');
      return { ok: true, models, at: new Date(now()).toISOString(), identity };
    }
    if (!declaration.listModels) throw new Error(`执行器 ${executor} 不上报模型`);
    const query = declaration.listModels(token === undefined || token === '' ? {} : { token });
    if (query.kind === 'command') {
      const reported = machineModels?.(executor);
      if (reported && reported.models.length > 0) {
        return { ok: true, models: reported.models, at: reported.at, identity };
      }
      throw new Error('这个执行器的模型要在机器上问，由机器自己报告');
    }
    const response = await doFetch(query.url, { headers: query.headers, signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return { ok: false, identity, status: response.status, reason: scrubbed(`${query.url} 回答 HTTP ${response.status}`, token) };
    if (query.identity) remember(query.identity(response.headers));
    const models = query.parse(await response.text());
    if (models.length === 0) throw new Error('执行器没有报出任何模型');
    return { ok: true, models, at: new Date(now()).toISOString(), identity };
  } catch (err) {
    return { ok: false, reason: scrubbed(err instanceof Error ? err.message : String(err), token), identity };
  }
}

interface ModelsView {
  list: ModelInfo[];
  at: string | null;
  // A query is on its way right now. The page says so rather than showing an older list as
  // if it were this moment's.
  refreshing: boolean;
}

export type RefreshResult =
  | { ok: true; models: ModelInfo[]; added: ModelInfo[]; gone: ModelInfo[] }
  | { ok: false; reason: string; status?: number };

export interface ModelsOptions {
  ledger: Pick<Ledger, 'loginState' | 'noteModels' | 'noteIdentity' | 'transaction' | 'accountCredentialRef'>;
  // Every login the periodic round asks about, read at each round: the accounts.
  logins: () => Login[];
  executors: Executors;
  // An account's login token. Read at each query, never kept.
  token?: (loginId: string) => string | undefined;
  notify?: Pick<Notify, 'modelsAdded' | 'modelsGone'>;
  fetch?: typeof fetch;
  now?: () => number;
  // How old a list may be before the periodic round asks again. The round comes when the
  // first account falls due by it; a change is taken up by reschedule().
  refreshMs: () => number;
  // How long one query over HTTP may take: the wait a connection test gives a machine. An
  // answer that has not come by then is not one the owner is still waiting for.
  timeoutMs: number;
  // True while the service is taking stock: nothing is asked then.
  recovering?: () => boolean;
  // Optional machine-reported catalog resolver for CLI-queried executors (e.g. Codex).
  machineModels?: (executor: string) => { models: ModelInfo[]; at: string } | null;
  log?: (line: string) => void;
}

export function createModels({
  ledger, logins, executors, token, notify, fetch: doFetch = fetch, now = Date.now,
  refreshMs, timeoutMs, recovering, machineModels, log = (line) => console.error(line),
}: ModelsOptions) {
  // A query already on its way, by account: whoever asks meanwhile waits for that one
  // instead of sending a second.
  const inFlight = new Map<string, { ref: string | null; result: Promise<RefreshResult> }>();
  // The reason the periodic round last failed for an account, so one account out of reach
  // is said once rather than at every tick.
  const lastFailure = new Map<string, string>();
  // When a query to an account last went out, whoever sent it and whatever came of it: one
  // that failed is asked again by the round an interval later, not at once and not in a
  // loop. The owner asking on a page is not held back by it.
  const attempted = new Map<string, { ref: string | null; at: number }>();
  let timer: NodeJS.Timeout | undefined;
  let started = false;
  let stopped = false;
  let inRound = false;

  // The models the account's tiers name, read the way that executor writes a tier: what is
  // in a `ref` tier is a place on the machine, and says nothing about a model.
  function usedModels(account: Login): Set<string> {
    const form = executors[account.executor]?.tierForm;
    const used = new Set<string>();
    if (!form) return used;
    for (const tier of Object.values(account.tiers)) {
      if (tier.kind !== 'content') continue;
      const model = form.parse(tier.text)?.model.trim() ?? '';
      if (model !== '') used.add(model);
    }
    return used;
  }

  async function run(account: Login, ref: string | null): Promise<RefreshResult> {
    const secret = token?.(account.id);
    const refused = (text: string): RefreshResult => ({ ok: false, reason: scrubbed(text, secret) });
    const answer = await readModels({ executor: account.executor, token: secret, provider: account.provider, executors, timeoutMs, fetch: doFetch, now, ...(machineModels ? { machineModels } : {}) });
    if (ledger.accountCredentialRef(account.id) !== ref) return refused('读取模型期间账号凭据已更换');
    if (!answer.ok) {
      try { ledger.noteIdentity(account.id, answer.identity); }
      catch (err) { return refused(err instanceof Error ? err.message : String(err)); }
      return answer;
    }
    const { models, at } = answer;

    const before = ledger.loginState(account.id);
    // Without an earlier answer there is nothing this one differs from: the first read of
    // an account fills the list in and tells nobody.
    const baseline = before.models_at !== null;
    const had = new Set(before.models.map((model) => model.id));
    const has = new Set(models.map((model) => model.id));
    const used = usedModels(account);
    const added = baseline ? models.filter((model) => !had.has(model.id)) : [];
    const gone = baseline ? before.models.filter((model) => !has.has(model.id) && used.has(model.id)) : [];
    // The list and what it makes the owner hear go together: a crash leaves both or
    // neither, never a list that moved without a word. A ledger that cannot be written is
    // a reason like any other, and the degraded mode it puts the service in is said by the
    // ledger itself.
    try {
      ledger.transaction(() => {
        ledger.noteModels(account.id, models, at);
        ledger.noteIdentity(account.id, answer.identity);
        for (const model of added) notify?.modelsAdded(account.id, model);
        for (const model of gone) notify?.modelsGone(account.id, model);
      });
    } catch (err) {
      return refused(err instanceof Error ? err.message : String(err));
    }
    return { ok: true, models, added, gone };
  }

  // The moment a login's list falls due: an interval after it was last read or last
  // asked. One never read and never tried is due now.
  function dueAt(loginId: string, at: number): number {
    const learned = ledger.loginState(loginId);
    const read = learned.models_at === null ? Number.NaN : Date.parse(learned.models_at);
    const attempt = attempted.get(loginId);
    const tried = attempt?.ref === ledger.accountCredentialRef(loginId) ? attempt.at : -Infinity;
    const last = Math.max(Number.isNaN(read) ? -Infinity : read, tried);
    return last === -Infinity ? at : last + refreshMs();
  }

  // One timer, set for the first login to fall due. Nothing is set while the service is
  // taking stock: whoever ends that starts the round again.
  function reschedule(): void {
    clearTimeout(timer);
    timer = undefined;
    if (!started || inRound || recovering?.()) return;
    const at = now();
    let next: number | undefined;
    for (const login of logins()) next = Math.min(next ?? Infinity, dueAt(login.id, at));
    if (next === undefined) return;
    timer = setTimeout(() => {
      timer = undefined;
      refreshDue().catch((err: unknown) => log(`模型列表的定时查询失败：${String(err)}`));
    }, Math.max(0, next - at));
    // A service that is only waiting for the next round has nothing left to do.
    timer.unref();
  }

  // One query per account at a time: a page's check and the periodic round asking at the
  // same moment share the answer instead of sending two.
  function begin(account: Login): Promise<RefreshResult> {
    const ref = ledger.accountCredentialRef(account.id);
    const running = inFlight.get(account.id);
    if (running?.ref === ref) return running.result;
    attempted.set(account.id, { ref, at: now() });
    const asking = run(account, ref).finally(() => {
      if (inFlight.get(account.id)?.result === asking) inFlight.delete(account.id);
      // An answer moves when this account next falls due, and an account saved since the
      // timer was set may be the first one now.
      reschedule();
    });
    inFlight.set(account.id, { ref, result: asking });
    return asking;
  }

  // One round of the periodic query: every account whose list is older than the setting,
  // one after another, and one that cannot be reached does not stop the others.
  async function refreshDue(): Promise<void> {
    if (recovering?.() || inRound) return;
    inRound = true;
    try {
      await round();
    } finally {
      inRound = false;
      reschedule();
    }
  }

  async function round(): Promise<void> {
    const at = now();
    for (const account of logins()) {
      // Looked at again before each query: stock-taking or a stop may have begun while
      // the one before was out.
      if (stopped || recovering?.()) return;
      if (dueAt(account.id, at) > at) continue;
      const result = await begin(account);
      if (result.ok) {
        lastFailure.delete(account.id);
        continue;
      }
      if (lastFailure.get(account.id) === result.reason) continue;
      lastFailure.set(account.id, result.reason);
      log(`${loginName(account)} 的模型列表没读到：${result.reason}；还用上次读到的`);
    }
  }

  return {
    // What the pages show: the last answer that was read, when, and whether another is on
    // its way.
    state(accountId: string): ModelsView {
      const learned = ledger.loginState(accountId);
      return { list: learned.models, at: learned.models_at, refreshing: inFlight.has(accountId) };
    },

    // Never rejects: a query that cannot be made is a reason the caller can show.
    refresh: (account: Login): Promise<RefreshResult> => begin(account),

    // A line the owner is still writing, asked with the key in the form or the one the account
    // holds: what it serves, kept nowhere. Never rejects.
    readLine: (executor: string, provider: Provider, key: string | undefined): Promise<ModelRead> =>
      readModels({ executor, provider, executors, timeoutMs, fetch: doFetch, now, ...(key === undefined ? {} : { token: key }) }),

    refreshDue,

    start(): void {
      started = true;
      stopped = false;
      reschedule();
    },

    // Sets the timer again by what the setting and the lists say now; nothing before start().
    reschedule,

    stop(): void {
      started = false;
      stopped = true;
      clearTimeout(timer);
      timer = undefined;
    },
  };
}

export type Models = ReturnType<typeof createModels>;
