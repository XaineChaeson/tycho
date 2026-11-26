// What the two pages that show logins — 账号 and 机器 — are tested against: the stand-in
// service answer, the accounts and machines it holds, and the way a test asks a page for a
// card, a control or a tier row. The two pages read one answer and write one list, so the
// fixtures are shared; each page's own tests open it at its own address. A card only says how
// its account or machine stands; what changes it opens over the page — a form in a drawer, a
// short form in a window, a question before a removal — so a test asks for the card and for
// what is open about it separately. While something is open the page behind it is hidden from
// a screen reader and still there: the cards are looked up as hidden ones too. This is test
// support, not a test: what each page guards is written at the top of its own file.
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { expect, vi } from 'vitest';
import { TIER_IDS, type TierId } from '@shared/tiers.ts';
import { open, shellStream, type Call } from './harness';
import type { AccountLoginOffer } from '@shared/logins.ts';
import type { MachineNode } from '@/lib/types';

export const ADD = '添加账号';
export const PAGE_LOGIN_UNSUPPORTED = '此主机暂不支持在控制台登录';
export const LIST = '/api/accounts';
export const JOINS = '/api/node/joins';

export const GPU = {
  id: 'gpu', name: 'gpu', executor: 'claude', credential: 'set',
  tiers: { decide: { kind: 'content' as const, text: '{"model":"<决策模型>"}' }, execute: { kind: 'content' as const, text: '{"model":"<执行模型>"}' } }, permission_mode: 'acceptEdits', timeout_ms: 5_400_000,
  created_at: '2026-11-05T00:00:00Z', updated_at: '2026-11-05T00:00:00Z', queued_tasks: 4,
};
export const CX = {
  id: 'cx', name: 'cx', executor: 'claude', credential: 'set', tiers: { decide: { kind: 'content' as const, text: '{"model":"<模型丙>"}' } }, permission_mode: null, timeout_ms: null,
  created_at: '2026-11-05T00:00:00Z', updated_at: '2026-11-05T00:00:00Z', queued_tasks: 0,
};
// What the service answers: the executors it has, the permission modes each one's own
// command takes, how a tier of each is written and read, and which of them can hold a login
// token. Only claude takes a token, so every account here is a claude one; codex and dsh are
// machines' own logins. The tier forms here stand in for the adapters' own declarations, which the
// service hands over as data; tests/targets.test.ts checks that it really does.
export const TIER_FORMS = {
  claude: { format: 'settings-json', fields: ['model', 'effort'], efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  codex: { format: 'key-value-lines', fields: ['model', 'effort'], efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  dsh: { format: 'patch-list', fields: ['provider', 'model', 'effort'], efforts: ['low', 'medium', 'high', 'max'] },
};
export const accountsPage = (...accounts: object[]) => ({
  accounts,
  // Each tier's dispatch order as the service sends it: the accounts in this stand-in, in
  // the order given. A test about the order passes its own.
  dispatch_order: {
    operate: accounts.map((account) => (account as { id: string }).id),
    execute: accounts.map((account) => (account as { id: string }).id),
    decide: accounts.map((account) => (account as { id: string }).id),
  },
  executors: ['claude', 'codex', 'dsh'],
  permission_modes: { claude: ['bypassPermissions', 'acceptEdits', 'default', 'plan'], dsh: ['read-only', 'workspace-write', 'danger-full-access'] },
  tier_forms: TIER_FORMS,
  credential_executors: ['claude'],
  // How an account of each executor gets its login, as the executor declares it. The pages
  // know no executor by name, so this stand-in is free to say its one account executor takes
  // a typed key beside the sign-in this host cannot run: that is what the tests of a typed
  // secret's form walk. Which executor really offers which way is the service's to say
  // (tests/claude-login-http.test.ts).
  account_logins: { claude: [{ way: 'page', available: false, why: PAGE_LOGIN_UNSUPPORTED }, { way: 'key', available: true }], codex: [], dsh: [] } as Record<string, AccountLoginOffer[]>,
});
export const ACCOUNTS_PAGE = accountsPage(GPU, CX);

// A machine's own login as the machines list carries it: signed in there, and set up with
// a tier unless said otherwise.
export const own = (machine: string, executor: string, over: object = {}) => ({
  id: (over as { configured?: boolean }).configured === false ? null : ('01K' + [...machine + executor].map((letter) => String(letter.charCodeAt(0)).padStart(3, '0')).join('')).slice(0, 26).padEnd(26, '0'),
  name: `${machine}/${executor}`, kind: 'machine', machine, executor, signed_in: true, configured: true, tiers: { decide: { kind: 'content', text: 'model=<模型名>\n' } },
  permission_mode: null, timeout_ms: null, max_runs: null, status: { active_runs: 0, max_runs: null, rest: null, usage: [] }, queued_tasks: 0,
  refused: false, usable_here: true, ...over,
});
// A machine holding the given own logins, and what the service answers a change to one of them with.
export const onB1 = (...logins: object[]) => () => MACHINES.map((each) => (each.id === 'b1' ? { ...each, logins } : each));
export const ownSaved = (...logins: object[]) => () => ({ machine: onB1(...logins)()[3] });

// A machine that ran the join command and waits: the request as the service lists it, and
// one of the machines it turns into once let in.
export const JOIN = { code: '482913', name: 'mac-mini-01', platform: 'darwin 24.5.0', hostname: 'mac-mini-01.local', created_at: '2026-11-06T10:20:00.000Z', expires_at: '2026-11-06T10:35:00.000Z' };
export const WINDOWS = { ...JOIN, code: '104377', name: 'build-02', platform: 'win32 10.0.26100', hostname: 'build-02' };
export const nodeMachine = (id: string, node: Partial<MachineNode> = {}) => ({
  id, uid: `uid-${id}`, host: `${id}.local`, note: null,
  node: {
    node_id: 'a'.repeat(16), platform: 'darwin 24.5.0', joined_at: '2026-11-06T09:00:00.000Z', last_seen_at: '2026-11-06T10:35:00.000Z',
    connected: false, reported_runs: 0, reported_unknown: 0, source: null, ephemeral: false, scope: null, ends: null, executors: null, ...node,
  },
});
// Every machine joined by its own client; these have said nothing yet about their executors.
export const MACHINES = ['a1', 'a2', 'a3', 'b1', 'h1', 'h2', 'b2', '-x'].map((id) => ({ ...nodeMachine(id), host: id }));

// What the service reports an account's executor may use: two models the form may offer and
// one the executor hides, and per model what strengths it takes. Nothing here is a model
// name the code knows: it is what this account's own executor answered.
export const MODELS = {
  at: '2026-11-05T01:00:00.000Z',
  refreshing: false,
  list: [
    { id: '<模型甲>', name: '<模型甲>', efforts: ['low', 'high'], defaultEffort: 'high' },
    { id: '<模型乙>' },
    { id: '<隐藏的>', hidden: true },
  ],
};
// b1's own codex login, whose tiers name models, with the list its executor reported.
export const TIERED = own('b1', 'codex', {
  tiers: { decide: { kind: 'content', text: 'model=<模型甲>\n' }, execute: { kind: 'content', text: 'model=<别名>\n' } },
  models: MODELS,
});
export const CODEX = 'b1 上的 codex 登录';
// An account from before the names were fixed: it holds one of them and a name the
// ledger still keeps, which is what the form has to let the owner settle.
export const LEGACY = {
  ...CX, id: 'legacy', name: 'legacy',
  tiers: { decide: { kind: 'content' as const, text: '{\n  "model": "<模型甲>"\n}\n' }, old: { kind: 'content' as const, text: '{"model":"<旧模型>"}' } },
};

// The machines a task spawned, and the quotas they came in under (nodes.md §1.3).
export const SPAWNED_ENDS = {
  material: { live: 0, live_until: null, ended_at: '2026-11-06T10:05:00.000Z', ended_why: 'used' },
  drain_at: '2026-11-06T10:20:00.000Z', evidence_at: null, left_at: '2026-11-06T10:30:00.000Z', left_reason: 'leave', destroyed_at: null, destroyed_by: null, lost_rounds: 0,
} as NonNullable<MachineNode['ends']>;
export const SOURCE = { task_id: 't-9', run_id: 'r-41', round: 3 };
export const spawned = (id: string, ends: Partial<NonNullable<MachineNode['ends']>> = {}) =>
  nodeMachine(id, { connected: true, source: SOURCE, ephemeral: true, scope: { project_id: 'p1', executors: ['claude'] }, ends: { ...SPAWNED_ENDS, ...ends } });
export const INVITE = {
  id: 'inv-1', created_at: '2026-11-06T10:00:00.000Z', project_id: 'p1', task_id: 't-9', executors: ['claude'], expires_at: '2099-01-01T10:50:00.000Z',
  max_machines: 2, used: 1, revoked_at: null, last_handed_at: '2026-11-06T10:02:00.000Z', last_run_id: 'r-41',
  material: { live: 1, live_until: '2099-01-01T10:45:00.000Z', ended_at: null, ended_why: null }, machines: ['builder'],
};
export const REVOKED = {
  ...INVITE, id: 'inv-0', task_id: 't-8', executors: null, used: 0, revoked_at: '2026-11-06T09:00:00.000Z',
  material: { live: 0, live_until: null, ended_at: '2026-11-06T09:00:00.000Z', ended_why: 'revoked' }, machines: [],
};

// A list that says which read of it this is, as one more account under that name: a test
// that has to see the page drawn again from a later read waits for that read's number.
export function numbered(page: () => ReturnType<typeof accountsPage> = () => ACCOUNTS_PAGE) {
  let reads = 0;
  return {
    read: () => ({ ...page(), accounts: [...page().accounts, { ...CX, id: `read-${reads += 1}`, name: `第 ${reads} 次读到` }] }),
    drawn: (read: number) => screen.findByRole('region', { name: `第 ${read} 次读到`, hidden: true }),
  };
}
// What the service answers a PUT with: the account as it now is, the token it was sent kept
// and never read back. A new account sent without a name is named by the service.
export const SERVICE_NAMED = '服务起的名字';
export const saved = ({ path, body }: Call, created = false) => {
  const { credential: _token, ...target } = body as { credential?: string; name?: string };
  return { created, account: {
    name: SERVICE_NAMED, ...target, id: path === '/api/accounts' ? '01K00000000000000000000009' : decodeURIComponent(path.slice('/api/accounts/'.length)), credential: 'set', created_at: '2026-11-05T00:00:00Z', updated_at: '2026-11-05T02:00:00Z',
    queued_tasks: 0,
  } };
};
// The gpu account after its time limit is set to an hour, as the service answers it.
export const NARROWED = { ...GPU, timeout_ms: 3_600_000 };
export const unreadable = (): never => { throw new Error('读不到账号'); };

// A page on a service that answers every change with `answer`, every read of the list with
// `read`, and the machines it has with `readMachines`; `readJoins` is what the machines
// asking to be let in reported, and `readInvites` the quotas tasks asked for.
export interface LoginsApp {
  user: ReturnType<typeof open>['user'];
  calls: Call[];
  reads: string[];
  waiting: (path?: string) => number;
  unmount: () => void;
  target: (name: string) => HTMLElement | null;
  form: (name: string) => HTMLElement | null;
  main: () => HTMLElement;
  more: (name: string) => HTMLButtonElement | null;
  menu: (name: string) => Promise<HTMLElement>;
  pick: (name: string, label: string) => Promise<void>;
  question: () => HTMLElement | null;
  decide: (label: string) => Promise<void>;
  remove: (name: string, label?: string) => Promise<void>;
  tokenWindow: (name: string) => HTMLElement | null;
  control:(name: string, label: string) => HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | null;
  tiersOf: (name: string) => string[];
  tierRows: (name: string) => HTMLElement[];
  modelOf: (name: string, index: number) => HTMLInputElement | HTMLSelectElement;
  modelOptions: (name: string, index: number) => string[];
  effortOf: (name: string, index: number) => HTMLSelectElement;
  providerOf: (name: string, index: number) => HTMLInputElement | null;
  rawOf: (name: string, index: number) => HTMLTextAreaElement | null;
  row: (name: string, index: number) => HTMLElement;
  editing: (name: string) => boolean;
  button: (name: string, label: string) => HTMLButtonElement | null;
  add: () => HTMLButtonElement | null;
  addByKey: () => Promise<void>;
  type: (name: string, label: string, value: string) => void;
  click: (name: string, label: string) => Promise<void>;
  submit: (name: string) => Promise<void>;
  done: () => Promise<void>;
  listReads: () => number;
  reread: () => Promise<void>;
  shown: () => Promise<HTMLElement>;
  ready: () => Promise<void>;
  joinsButton: () => HTMLButtonElement | null;
  joinsCard: () => HTMLElement | null;
  openJoins: () => Promise<HTMLElement>;
  closeJoins: () => Promise<void>;
  joinEntry: (name: string) => HTMLElement;
}

// Opens one of the two pages. `title` is the page's own heading, which is what a test waits
// for before it looks at anything.
export async function loginsApp({ hash, title, answer = (call) => (call.method === 'PUT' || call.method === 'POST' ? saved(call) : {}), read = () => ACCOUNTS_PAGE, readMachines = () => MACHINES, readJoins = () => [], readInvites = () => [], readHostEntry = () => null, publicUrl = null }: {
  hash: string;
  title: string;
  answer?: (call: Call) => unknown;
  read?: () => unknown;
  readMachines?: () => unknown[];
  readJoins?: () => unknown[];
  readInvites?: () => unknown[];
  // What the service did with the global entry for its own executors (knowledge §4.3).
  readHostEntry?: () => unknown;
  publicUrl?: string | null;
}): Promise<LoginsApp> {
  // Opening the page reads the list twice: on arriving, and again once the console is
  // connected. Both are answered from one call of `read`, so a test counts its own.
  let asked = 0;
  let opening: () => unknown = read;
  const app = open(hash, (call) => {
    if (call.method !== 'GET') return answer(call);
    if (call.path === '/api/machines') return { machines: readMachines(), invites: readInvites(), host_entry: readHostEntry(), public_url: publicUrl };
    if (call.path === JOINS) return { protocol: 1, joins: readJoins() };
    if (call.path !== LIST) return undefined;
    asked += 1;
    if (asked === 1) {
      try {
        const page = read();
        opening = () => page;
      } catch (error) {
        opening = () => { throw error; };
      }
    }
    return asked <= 2 ? opening() : read();
  });
  // A card or a block by the name over it: an account, a machine, a section of the page, and
  // a machine's own login (its executor's block on that machine's card). In the Master-Detail
  // machines view, asking for another machine selects it in the left fleet rail first.
  const queryTarget = (name: string): HTMLElement | null =>
    screen.queryByRole('region', { name, hidden: true }) ?? screen.queryByRole('listitem', { name, hidden: true }) ?? screen.queryByRole('group', { name, hidden: true });
  const target = (name: string): HTMLElement | null => {
    const direct = queryTarget(name);
    if (direct) return direct;
    const machineId = /^机器 (.+)$/.exec(name)?.[1] ?? /^(.+) 上的 .+$/.exec(name)?.[1];
    if (machineId) {
      const selectBtn = screen.queryByRole('button', { name: `选择机器 ${machineId}`, hidden: true });
      if (selectBtn) {
        fireEvent.click(selectBtn);
        return queryTarget(name);
      }
    }
    return null;
  };
  // The drawer its form is open in: an account's ("修改 <名字>"), the one a new account is
  // made in, or a machine's own login's, which is named as its block is.
  const form = (name: string): HTMLElement | null =>
    screen.queryByRole('dialog', { name: name === ADD ? ADD : `修改 ${name}` }) ?? screen.queryByRole('dialog', { name });
  // The page itself, also while something is open over it.
  const main = (): HTMLElement => screen.getByRole('main', { hidden: true });
  // A box is looked for in the form when one is open, and on the card otherwise.
  const control = (name: string, label: string) => within(form(name) ?? target(name)!).queryByLabelText<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(label);
  // A button of the form that is open about it, or else one on its card.
  const button = (name: string, label: string): HTMLButtonElement | null => {
    const open = form(name);
    const card = target(name);
    return (open ? within(open).queryByRole<HTMLButtonElement>('button', { name: label }) : null)
      ?? (card ? within(card).queryByRole<HTMLButtonElement>('button', { name: label, hidden: true }) : null);
  };
  // The one way in for a new account.
  const add = () => screen.queryByRole<HTMLButtonElement>('button', { name: ADD, hidden: true });
  // Opens the window a new account is made in and walks it to the form a typed key is saved
  // from: the executor and the way are picked first. On these pages' stand-in service the host
  // cannot sign in on the executor's own page, so the key is the way.
  const addByKey = async (): Promise<void> => {
    await app.user.click(add()!);
    await app.user.click(within(form(ADD)!).getByRole('button', { name: '下一步' }));
    await within(form(ADD)!).findByLabelText('API 密钥');
  };
  // The less common actions of a card are behind its "更多": every one of them is a change,
  // so the button that opens them is what is held while another change is on its way.
  const more = (name: string) => button(name, '更多');
  const menu = async (name: string): Promise<HTMLElement> => {
    // Held while a change is on its way, and for the moment after its answer.
    await waitFor(() => expect(more(name)).toBeEnabled());
    await app.user.click(more(name)!);
    return screen.findByRole('menu');
  };
  const pick = async (name: string, label: string): Promise<void> => {
    await app.user.click(within(await menu(name)).getByRole('menuitem', { name: label }));
  };
  // The question asked before something is removed, and the click that answers it.
  const question = (): HTMLElement | null => screen.queryByRole('alertdialog');
  const decide = async (label: string): Promise<void> => { await app.user.click(within(question()!).getByRole('button', { name: label })); };
  // Removing an account or a machine as the owner does: the action in its menu, then yes.
  const remove = async (name: string, label = '删除'): Promise<void> => {
    await pick(name, label);
    await decide(`确认删除 ${name.replace(/^机器 /, '')}`);
  };
  const tokenWindow = (name: string): HTMLElement | null => screen.queryByRole('dialog', { name: `更换 ${name} 的 API 密钥` });
  // The tiers are the fixed rows — operate, execute, decide, in that order — followed by any
  // name the ledger still keeps from an older layout, which shows its name and the buttons that
  // settle it rather than any boxes. The tests read and write them the way the owner does.
  const tierRows = (name: string): HTMLElement[] => within(form(name)!).queryAllByRole('group', { name: /^第 \d+ 个档位$/ });
  const row = (name: string, index: number): HTMLElement => tierRows(name)[index]!;
  // The fixed rows are always the first ones, in their one order.
  const fixed = (index: number): TierId | undefined => (index < TIER_IDS.length ? TIER_IDS[index] : undefined);
  const modelOf = (name: string, index: number): HTMLInputElement | HTMLSelectElement => within(row(name, index)).getByLabelText('模型');
  // What the model box offers, when it is the dropdown the account's list makes it.
  const modelOptions = (name: string, index: number): string[] => [...(modelOf(name, index) as HTMLSelectElement).options].map((option) => option.value);
  const effortOf = (name: string, index: number): HTMLSelectElement => within(row(name, index)).getByLabelText('推理强度');
  const providerOf = (name: string, index: number): HTMLInputElement | null => within(row(name, index)).queryByLabelText('服务方');
  const rawOf = (name: string, index: number): HTMLTextAreaElement | null => within(row(name, index)).queryByLabelText(`第 ${index + 1} 个档位的内容`);
  // What the page shows of each tier row, in order: the fixed rows are the tier they
  // are, with the model and the strength their text holds, and a name the system no longer
  // uses is that name alone (its content is not the page's to show).
  const tiersOf = (name: string): string[] => tierRows(name).map((element, index) => {
    const id = fixed(index);
    const inside = within(element);
    const model = inside.queryByLabelText<HTMLInputElement | HTMLSelectElement>('模型');
    if (model !== null) return `${id ?? ''}=${model.value}@${inside.getByLabelText<HTMLSelectElement>('推理强度').value}`;
    return element.querySelector('code')?.textContent ?? '';
  });
  // What the owner does to the tiers: one line per tier, `档位名=模型`. The names are the
  // two the page shows, and a line selects the tier it names.
  const setTiers = (name: string, text: string): void => {
    for (const line of text.split('\n').map((each) => each.trim()).filter(Boolean)) {
      const [tier = '', rest = ''] = line.split('=');
      const [model = '', effort = ''] = rest.split('@');
      const at = TIER_IDS.indexOf(tier.trim() as TierId);
      expect(at, `档位名只能是 ${TIER_IDS.join('、')}：${line}`).toBeGreaterThanOrEqual(0);
      fireEvent.change(modelOf(name, at), { target: { value: model } });
      if (effort !== '') fireEvent.change(effortOf(name, at), { target: { value: effort } });
    }
  };
  // Whether this target's form is open. What a closed form leaves behind is what the page
  // shows of the target itself.
  const editing = (name: string): boolean => form(name) !== null;
  const type = (name: string, label: string, value: string) => {
    if (label === '档位') { setTiers(name, value); return; }
    fireEvent.change(control(name, label)!, { target: { value } });
  };
  const click = async (name: string, label: string): Promise<void> => { await app.user.click(button(name, label)!); };
  const submit = (name: string) => click(name, '保存');
  const listReads = () => app.reads.filter((path) => path === LIST).length;
  // No change this page sent is on its way: its answer, or its refusal, is on the page.
  const done = () => waitFor(() => expect(screen.queryByRole('button', { name: /^(保存中|删除中)$/ })).toBeNull());
  // What makes the page read itself again without anyone asking: the service saying that
  // the ledger changed. Back once the read has been asked for; its answer is the test's to wait for.
  const reread = async () => {
    const before = listReads();
    act(() => shellStream().emit('changed', {}));
    await waitFor(() => expect(listReads()).toBe(before + 1));
  };
  // The page is there, with whatever it last read.
  const shown = () => screen.findByRole('heading', { level: 1, name: title });
  // The page is there and every read of the list so far has been answered.
  const ready = async () => {
    await shown();
    await waitFor(() => {
      expect(listReads()).toBeGreaterThanOrEqual(2);
      expect(app.waiting(LIST)).toBe(0);
    });
  };
  await ready();
  // The machines asking to be let in are listed in the window that says how to bring a
  // machine in, under its steps: their list reads only while that window is open.
  const joinsButton = () => screen.queryByRole<HTMLButtonElement>('button', { name: '接入一台机器' });
  const joinsCard = () => screen.queryByRole('region', { name: '等着放行的机器' });
  const openJoins = async (): Promise<HTMLElement> => {
    await app.user.click(joinsButton()!);
    return joinsCard()!;
  };
  const closeJoins = async (): Promise<void> => {
    await app.user.click(within(screen.getByRole('dialog', { name: '接入一台机器' })).getByRole('button', { name: '关闭' }));
  };
  const joinEntry = (name: string): HTMLElement => within(joinsCard()!).getByText(name).closest('li')!;
  return {
    ...app, target, form, main, more, menu, pick, question, decide, remove, tokenWindow, control, tiersOf, tierRows, modelOf, modelOptions, effortOf, providerOf, rawOf, row, editing, button, add, addByKey, type, click, submit, done,
    listReads, reread, shown, ready, joinsButton, joinsCard, openJoins, closeJoins, joinEntry,
  };
}

// The accounts page: the logins tycho keeps itself.
export const accountsApp = (
  answer?: (call: Call) => unknown,
  read?: () => unknown,
): Promise<LoginsApp> => {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query.includes('1024px'),
    media: query,
    addEventListener() {},
    removeEventListener() {},
  }));
  return loginsApp({ hash: '#/accounts', title: '账号', ...(answer === undefined ? {} : { answer }), ...(read === undefined ? {} : { read }) });
};

// The machines page: Master-Detail split view on desktop viewports.
export const machinesApp = (
  answer?: (call: Call) => unknown,
  read?: () => unknown,
  readMachines?: () => unknown[],
  readJoins?: () => unknown[],
  readInvites?: () => unknown[],
  readHostEntry?: () => unknown,
  publicUrl?: string | null,
): Promise<LoginsApp> => {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query.includes('1024px'),
    media: query,
    addEventListener() {},
    removeEventListener() {},
  }));
  return loginsApp({
    hash: '#/machines', title: '机器',
    ...(answer === undefined ? {} : { answer }),
    ...(read === undefined ? {} : { read }),
    ...(readMachines === undefined ? {} : { readMachines }),
    ...(readJoins === undefined ? {} : { readJoins }),
    ...(readInvites === undefined ? {} : { readInvites }),
    ...(readHostEntry === undefined ? {} : { readHostEntry }),
    ...(publicUrl === undefined ? {} : { publicUrl }),
  });
};
