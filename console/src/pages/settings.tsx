// 设置: how the service runs. One page per group, the groups down the side (a row that
// slides sideways on a phone), one search over all of them. Each item says what it is now,
// what it means behind 说明, and — only once something has been typed — offers to send or
// drop it.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useLayoutEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { normalizeLocale } from '@shared/i18n.ts';
import { changedByText, projectRouterErrors, routerLine, tierText } from '@shared/labels.ts';
import { loginName } from '@shared/logins.ts';
import { formatTime } from '@shared/time.ts';
import { TIER_IDS, isTierId, tierLabel, tierValueFrom, type TierId } from '@shared/tiers.ts';
import { Copyable, Fact, Facts, Note, Problem } from '@/components/bits';
import { GitHubSetup } from '@/components/github-setup';
import { PageBar } from '@/components/page';
import { PassphraseSetup } from '@/components/passphrase-setup';
import { ImChannelsPanel, type ImChannelsTab } from '@/components/im-channels-panel';
import { Button } from '@/components/ui/button';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import { Input } from '@/components/ui/input';
import { Option, Select } from '@/components/ui/select';
import { SkeletonPage } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { EARLIER_CHANGE, useChange } from '@/hooks/use-change';
import { del, messageOf, post, put } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { accountsQuery, settingsQuery, stateQuery } from '@/lib/queries';
import { isNumber, sameSetting, settingField, settingShown, settingValue, unitLabel, type LoginChoice } from '@/lib/settings';
import { loginChoices } from '@/lib/logins';
import type { Account, Setting, SettingsPage as Listing, Tier } from '@/lib/types';
import { cn } from '@/lib/utils';

// The three the Router reads only when it starts.
const ROUTER_START_KEYS = ['router.cli', 'router.account', 'router.tier'];
// Two of them are not typed but picked from what the service knows of accounts: the
// account that logs the Router in, and one of that account's tiers. Empty is this
// computer's own login and the executor's own default tier.
const ROUTER_ACCOUNT = 'router.account';
const ROUTER_TIER = 'router.tier';
const NO_ACCOUNT = '不绑定：用这台电脑自己的登录和默认档位';
const NO_TIER = '不指定，用执行器自己的默认档位';
// Rows of the settings page that are no item of the list. They share its one-save lock.
const SECRET = 'wecom.secret';
const RESTART = 'router.restart';
const CHANGE = ['settings-change'];
// How long a row says 已保存 after its answer landed.
const SAVED_MS = 2000;
// The page of what the service is, beside the groups of what can be changed.
const DEPLOYMENT = '部署信息';
const GITHUB = 'GitHub';
const LOGIN = '登录';
const IM_CHANNELS = '消息通道';
const LEGACY_WECOM = '企业微信';
const LEGACY_WEIXIN = '微信';
const SECRET_HELP = '企业微信智能机器人的 Secret。只能填，填了以后不会再显示。它单独存在服务所在的电脑上，不进账本，所以备份里也没有它。保存后马上按新值重连。';
// Values the owner reads as paths rather than prose.
const PATHS = ['file', 'directory', 'url'];

// By key: a row keeps what was typed and why it failed across the page's own reads.
interface Draft {
  field?: string | undefined;
  error?: string | undefined;
}

// `taken` is what an answer says of the page: the list for an item, less for the rows that are none.
type Save = <T>(key: string, request: () => Promise<T>, taken: (saved: T, page: Listing) => Partial<Listing>) => Promise<void>;

const listOf = (saved: { settings: Setting[] }): Partial<Listing> => ({ settings: saved.settings });

// A tier is one of the names in shared/tiers.ts, and only if the account the row is about
// can run it: an account that does not take a tier cannot be bound to it, and a name the
// system no longer uses is not one to bind the Router to (docs/design/roles-and-tiers.md
// §2, §10.3). An operate choice runs on the execute content when the account holds no
// operate content of its own, so it is offered there too.
const tiersOf = (accounts: Pick<Account, 'id' | 'tiers'>[] | undefined, bound: string): TierId[] => {
  const held: Record<string, Tier> = accounts?.find(({ id }) => id === bound)?.tiers ?? {};
  return TIER_IDS.filter((id) => tierValueFrom(held, id) !== undefined);
};

// What the Router's two rows offer: the empty choice, then what the service knows of
// accounts — the ones whose executor can be the Router, or the tiers the bound account can
// run (roles-and-tiers.md §10.3).
// `accounts` is undefined while that read is on its way or has failed. `empty` is what
// the service says an empty value stands for, so the row and its choice say one thing.
// `held` is the value in force: one this version will not take is offered back under its
// own name, marked as such, so the owner sees what the Router is stopped on.
function routerChoices(key: string, accounts: (Pick<Account, 'id' | 'name' | 'tiers' | 'executor' | 'can_route'> & { reason?: string })[] | undefined, bound: string, empty?: string, held = ''): [string, string][] {
  const none = empty ?? (key === ROUTER_ACCOUNT ? NO_ACCOUNT : NO_TIER);
  if (key === ROUTER_ACCOUNT) {
    return [['', none], ...(accounts ?? []).map(({ id, name, executor, can_route, reason }): [string, string] => [id, `${name}（${executor}${reason ? `，${reason}` : can_route ? '' : '，不支持负责人'}）`])];
  }
  const offered = tiersOf(accounts, bound);
  return [
    ['', none],
    ...offered.map((id): [string, string] => [id, tierLabel(id)]),
    // A value in force this account cannot offer: a name it cannot run is shown under its
    // own name, and a name the system no longer uses is marked as such.
    ...(held === '' || offered.includes(held as TierId)
      ? []
      : [[held, isTierId(held) ? held : `${held}（${tierText.stale}）`] as [string, string]]),
  ];
}

// One item: what it is called and what it is now on the left, with what it means behind
// 说明; the control on the right, and — only once something has been typed — the buttons
// that send or drop it. Enter in the box is the same as the 保存 button.
function Row({ id, label, current, summary, help, extra, control, actions, failure, onSubmit }: {
  id: string;
  label: string;
  current?: boolean;
  summary: ReactNode;
  help?: ReactNode;
  extra?: ReactNode;
  control: ReactNode;
  actions: ReactNode;
  failure?: string | undefined;
  onSubmit?: () => void;
}) {
  return (
    <form
      id={id}
      aria-current={current ? 'true' : undefined}
      className="scroll-my-4 border-b border-border px-4 py-3 transition-colors duration-300 last:border-b-0 aria-[current=true]:bg-brand-soft"
      onSubmit={(event: FormEvent) => {
        event.preventDefault();
        onSubmit?.();
      }}
    >
      <div className="grid gap-x-8 gap-y-2.5 wide:grid-cols-[minmax(0,1fr)_minmax(0,320px)]">
        <div className="min-w-0">
          <strong className="text-sm font-semibold">{label}</strong>
          <Note className="mt-0.5 text-xs">{summary}</Note>
          {extra}
          {help ? (
            <details className="mt-1 text-xs">
              <summary className="inline-flex min-h-6 cursor-pointer list-none items-center text-faint underline decoration-border-strong underline-offset-3 hover:text-foreground [&::-webkit-details-marker]:hidden">说明</summary>
              <div className="mt-1 text-muted-foreground wrap-anywhere">{help}</div>
            </details>
          ) : null}
        </div>
        <div className="flex flex-wrap content-start items-center gap-2">{control}{actions}</div>
      </div>
      {failure ? <Problem role="alert" className="mt-2">{failure}</Problem> : null}
    </form>
  );
}

function SettingRow({ item, current, draft, saving, saved, busy, save, edit, accounts, logins, bound }: {
  item: Setting;
  current: boolean;
  draft: Draft;
  saving: string | null;
  saved: string | null;
  busy: boolean;
  save: Save;
  edit: (key: string, field: string) => void;
  // What the Router's account and tier rows pick from: undefined while that read is on
  // its way or has failed, when there is nothing to bind.
  accounts?: (Pick<Account, 'id' | 'name' | 'tiers' | 'executor' | 'can_route'> & { reason?: string })[] | undefined;
  logins: LoginChoice[];
  // The account the tier row is about: the account row's draft, or the account saved.
  bound: string;
}) {
  const { t, bi } = useI18n();
  const path = `/api/settings/${encodeURIComponent(item.key)}`;
  const field = draft.field ?? settingField(item, item.value, logins);
  const mine = saving === item.key;
  // The Router's account and tier are picked, not typed: what they offer is the empty
  // choice and what the service knows of accounts. A tier belongs to an account, so with
  // none bound, or one that has no tiers, the row has nothing to offer but empty.
  const picked = item.key === ROUTER_ACCOUNT || item.key === ROUTER_TIER;
  const held = typeof item.value === 'string' ? item.value : '';
  const localeChoiceLabel = (choice: string): string => (choice === 'en' ? 'English (en)' : choice === 'zh-CN' ? '简体中文 (zh-CN)' : choice);
  const options = picked ? routerChoices(item.key, accounts, bound, item.empty, held)
    : item.type === 'choice' ? (item.choices ?? []).map((choice): [string, string] => [choice, item.key === 'ui.locale' ? localeChoiceLabel(choice) : choice])
      : null;
  // Closed when there is nothing to pick from: no tier of the bound account, and nothing
  // in force either (an older name is shown so it can be seen and cleared).
  const closed = item.key === ROUTER_TIER && tiersOf(accounts, bound).length === 0 && held === '';
  const dirty = draft.field !== undefined && draft.field !== settingField(item, item.value, logins);
  const away = !sameSetting(item.value, item.default);
  // A stored value this version will not take is nowhere to be seen as the current value,
  // so it has no "away from the default" to show: it is put back by the same small button.
  const clearable = away || (item.stored && !item.overridden);
  // The tier row is the one item whose value is a name the page shows in its own words: the
  // summary and the choice say the same thing (docs/design/roles-and-tiers.md §2).
  const shownValue = (): string => {
    if (item.key === 'ui.locale' && typeof item.value === 'string') return localeChoiceLabel(item.value);
    const text = settingShown(item, item.value, logins);
    return item.key === ROUTER_TIER && typeof item.value === 'string' && item.value !== '' ? tierLabel(item.value) : text;
  };
  const facts = [`${bi('现在：', 'Current: ')}${shownValue()}`];
  if (away) facts.push(`${bi('默认：', 'Default: ')}${item.key === 'ui.locale' && typeof item.default === 'string' ? localeChoiceLabel(item.default) : settingShown(item, item.default, logins)}`);
  if (item.restart) facts.push(bi('重启后生效（需重启 Tycho 服务进程）', 'Requires Tycho service restart'));
  if (item.updated_at) facts.push(`${formatTime(item.updated_at)} ${changedByText(item.updated_by ?? '')}`);
  const unit = unitLabel(item);
  return (
    <Row
      id={`setting-${item.key}`}
      label={item.key === 'ui.locale' ? t('settings.languageTitle') : item.title}
      current={current}
      summary={facts.join(' · ')}
      help={item.key === 'ui.locale' ? t('settings.languageHint') : item.help}
      extra={
        <>
          {/* The operate tier is offered, not refused: the owner may want it anyway
              (roles-and-tiers.md §10.3). */}
          {item.key === ROUTER_TIER && field === 'operate' ? <Note className="mt-1 text-xs text-waiting-foreground">负责人的活全是判断，不建议用操作档。</Note> : null}
          {item.stored && !item.overridden
            ? <Note className="mt-1 text-xs text-waiting-foreground">账本里存着一个这个版本不接受的值，现在按默认值生效。点“恢复默认”可以把它清掉。</Note>
            : null}
        </>
      }
      failure={draft.error}
      onSubmit={() => { if (dirty) void save(item.key, () => put<{ settings: Setting[] }>(path, { value: settingValue(item, field, logins) }), listOf); }}
      control={
        item.type === 'boolean' ? (
          <Switch
            aria-label={item.title}
            disabled={busy}
            checked={item.value === true}
            onCheckedChange={(on) => {
              void save(item.key, () => put<{ settings: Setting[] }>(path, { value: on }), listOf);
            }}
          />
        ) : options ? (
          <Select aria-label={item.title} wrapperClassName="min-w-24 flex-1" className="w-full" value={field} disabled={mine || closed} onChange={(event) => edit(item.key, event.target.value)}>
            {options.map(([value, shown]) => <Option key={value} value={value} disabled={item.key === ROUTER_ACCOUNT && accounts?.find(({ id }) => id === value)?.can_route === false}>{shown}</Option>)}
          </Select>
        ) : (
          // Text, not number: what cannot be read as one goes to the service as typed.
          <Input
            aria-label={item.title}
            className={cn('w-auto min-w-24 flex-1', PATHS.includes(item.type) && 'font-mono text-xs', isNumber(item) && 'max-w-32 tabular-nums')}
            inputMode={isNumber(item) ? 'decimal' : undefined}
            value={field}
            disabled={mine}
            onChange={(event) => edit(item.key, event.target.value)}
          />
        )
      }
      actions={
        <>
          {unit ? <span className="text-sm text-muted-foreground">{unit}</span> : null}
          {item.type === 'boolean' && mine ? <span className="text-xs text-muted-foreground">{bi('保存中', 'Saving')}</span> : null}
          {item.type !== 'boolean' && dirty ? (
            <>
              {/* The one send path: Enter in the box and this button are the same submit. */}
              <Button type="submit" variant="primary" disabled={busy}>{mine ? bi('保存中', 'Saving') : t('common.save')}</Button>
              <Button variant="ghost" disabled={mine} onClick={() => edit(item.key, settingField(item, item.value, logins))}>{bi('撤销', 'Revert')}</Button>
            </>
          ) : null}
          {clearable ? (
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => void save(item.key, () => del<{ settings: Setting[] }>(path), listOf)}>{bi('恢复默认', 'Reset default')}</Button>
          ) : null}
          {saved === item.key ? <span role="status" className="text-xs text-success-foreground">{t('common.saved')}</span> : null}
        </>
      }
    />
  );
}

// Write-only: the service never sends the Secret back. The box holds what is being
// typed and nothing else, and all that is known of the stored one is whether there is one.
function SecretRow({ current, set, draft, saving, busy, save, edit }: {
  current: boolean;
  set: boolean;
  draft: Draft;
  saving: string | null;
  busy: boolean;
  save: Save;
  edit: (key: string, field: string) => void;
}) {
  const mine = saving === SECRET;
  const typed = (draft.field ?? '') !== '';
  return (
    <Row
      id={`setting-${SECRET}`}
      current={current}
      label="Secret"
      summary={`现在：${set ? '已设置' : '未设置'}`}
      help={SECRET_HELP}
      failure={draft.error}
      control={
        <Input
          type="password"
          autoComplete="new-password"
          aria-label="Secret"
          className="w-auto min-w-24 flex-1 font-mono text-xs"
          placeholder={set ? '填新的来替换' : ''}
          value={draft.field ?? ''}
          disabled={mine}
          onChange={(event) => edit(SECRET, event.target.value)}
        />
      }
      actions={
        typed ? (
          <>
            <Button type="submit" variant="primary" disabled={busy}>{mine ? '保存中' : '保存'}</Button>
            <Button variant="ghost" disabled={mine} onClick={() => edit(SECRET, '')}>撤销</Button>
          </>
        ) : null
      }
      onSubmit={() => { if (typed) void save(SECRET, () => put<{ secret_set: boolean }>('/api/wecom/secret', { secret: draft.field ?? '' }), (wecom) => ({ wecom })); }}
    />
  );
}

const routerHelp = (page: Listing): string => {
  const names = page.settings.filter(({ key }) => ROUTER_START_KEYS.includes(key)).map(({ title }) => title).join('、');
  return `${names}这几项改了以后，下次启动负责人时才生效。点“重启负责人”，负责人就按现在的设置重新启动。`;
};

function RouterPanel({ current, page, draft, busy, save }: {
  current: boolean;
  page: Listing;
  draft: Draft;
  busy: boolean;
  save: Save;
}) {
  const { router: state } = page;
  // The answer is the Router's new state: restarting, and the turn it waits for if any.
  const restart = (): Promise<void> => save(
    RESTART,
    () => post<{ waiting_for_turn: string | null }>('/api/router/restart'),
    ({ waiting_for_turn: turn }, current) => ({ router: { ...current.router, restarting: true, turn } }),
  );
  return (
    <Row
      id={`setting-${RESTART}`}
      current={current}
      label="负责人进程"
      summary={(state.error || projectRouterErrors(state).length > 0) && !state.restarting ? <span className="text-destructive">{routerLine(state)}</span> : <>{routerLine(state)}</>}
      help={routerHelp(page)}
      failure={draft.error}
      control={<></>}
      actions={<Button type="submit" disabled={busy || state.restarting}>重启负责人</Button>}
      onSubmit={() => { if (!busy && !state.restarting) void restart(); }}
    />
  );
}

// What a place on the page is found by: every item of the list, and the two rows that are
// none, each in the group it is drawn in.
interface Entry {
  key: string;
  title: string;
  help: string;
  group: string;
}

const imGroupOf = (settings: Setting[]): string | null => {
  if (settings.some((item) => item.group === IM_CHANNELS)) return IM_CHANNELS;
  if (settings.some((item) => item.group === LEGACY_WECOM)) return LEGACY_WECOM;
  return null;
};

function imTabFor(place: string | undefined, marked: string | undefined): ImChannelsTab {
  if (place === LEGACY_WECOM || marked === SECRET || marked?.startsWith('wecom.')) return 'wecom';
  if (place === LEGACY_WEIXIN || marked === 'im.weixin.setup') return 'weixin';
  if (marked === 'im.groups') return 'groups';
  return 'overview';
}

function entriesOf(page: Listing): Entry[] {
  const groupOf = (key: string): string | undefined => page.settings.find((item) => item.key === key)?.group;
  const rows: Entry[] = page.settings.map(({ key, title, help, group }) => ({ key, title, help, group }));
  const secret = groupOf('wecom.botId');
  const router = groupOf('router.cli');
  if (secret) rows.push({ key: SECRET, title: 'Secret', help: SECRET_HELP, group: secret });
  if (router) rows.push({ key: RESTART, title: '负责人进程', help: routerHelp(page), group: router });
  const imGroup = imGroupOf(page.settings);
  if (imGroup) {
    rows.push(
      {
        key: 'im.permissions',
        title: '通道权限矩阵',
        help: '按通道控制企业微信与微信的项目对话、主动通知和放行控制台登录权限。',
        group: imGroup,
      },
      {
        key: 'im.weixin.setup',
        title: '微信连接',
        help: '使用手机微信扫码连接 ClawBot，开启微信私聊对话、群聊绑定与控制台登录放行。',
        group: imGroup,
      },
      {
        key: 'im.groups',
        title: '群聊绑定',
        help: '将企业微信或微信群绑定到指定项目，配置 @ 触发、关键词快通道、发送者白名单与告警播报。',
        group: imGroup,
      },
    );
  }
  if (page.settings.some((item) => item.group === LOGIN)) {
    rows.push({
      key: 'auth.passphrase',
      title: '主人口令直登',
      help: '开启后，在微信浏览器、新浏览器或新设备打开登录页时，可直接输入主人口令进入控制台。',
      group: LOGIN,
    });
  }
  rows.push({
    key: 'github.integration',
    title: 'GitHub 集成',
    help: '连接 GitHub 账号（PAT 或 Device Flow），为任务按轮次自动注入临时凭据并查询 PR 与 CI 状态。',
    group: GITHUB,
  });
  return rows;
}

const placeLink = (place: string): string => `/settings/${encodeURIComponent(place)}`;

// The groups, one page each: down the side on a wide screen, a row that slides sideways on a
// phone. It stands outside the part of the page that scrolls, so it is always in sight.
function GroupNav({ groups, current, dirtyGroups }: { groups: string[]; current: string; dirtyGroups?: ReadonlySet<string> }) {
  const box = useRef<HTMLElement>(null);
  // A link straight to a group far along the row (or down the column) finds it slid into
  // sight. Not scrollIntoView: that would move every scrolling box around it too.
  useEffect(() => {
    const view = box.current;
    const link = view?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!link || !view) return;
    const [at, around] = [link.getBoundingClientRect(), view.getBoundingClientRect()];
    if (at.left < around.left || at.right > around.right) view.scrollLeft += at.left - around.left - 16;
    if (at.top < around.top || at.bottom > around.bottom) view.scrollTop += at.top - around.top - 8;
  }, [current]);
  return (
    <nav ref={box} aria-label="设置分组" className="min-h-0 min-w-0 overflow-auto px-3 pb-2 shell:px-0 shell:pb-0">
      <ul className="flex gap-0.5 shell:flex-col">
        {groups.map((group) => {
          const isDirty = dirtyGroups?.has(group) ?? false;
          return (
            <li key={group} className="flex-none">
              <Link
                to={placeLink(group)}
                aria-current={group === current ? 'page' : undefined}
                data-dirty={isDirty ? 'true' : undefined}
                className="flex min-h-hit items-center gap-1.5 rounded-md px-2.5 text-sm whitespace-nowrap text-muted-foreground no-underline transition-colors duration-100 hover:bg-hover hover:text-foreground focus-visible:-outline-offset-2 aria-[current=page]:bg-brand-soft aria-[current=page]:font-medium aria-[current=page]:text-brand-foreground"
              >
                {group}
                {isDirty ? (
                  <span aria-hidden="true" data-slot="dirty-dot" title="有未保存改动" className="ml-auto size-1.5 flex-none rounded-full bg-primary" />
                ) : null}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

// One box over every group: what matches by name, meaning or key, under the group it is
// in. Picking one opens its group at it.
function SettingsSearch({ entries, groups, onPick }: { entries: Entry[]; groups: string[]; onPick: (key: string) => void }) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const needle = query.trim().toLowerCase();
  const found = entries.filter((entry) => [entry.title, entry.help, entry.key].some((text) => text.toLowerCase().includes(needle)));
  return (
    <div
      className="relative"
      onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}
    >
      {/* Its own filter: cmdk's matches the value alone, and ranks. */}
      <Command shouldFilter={false} label="搜索设置">
        <CommandInput
          aria-label="搜索设置"
          placeholder="搜设置：名称、说明或键名"
          wrapperClassName="rounded-md border border-input bg-background px-2.5 shadow-xs focus-within:border-ring focus-within:outline-[3px] focus-within:outline-ring/20"
          value={query}
          onValueChange={(next) => { setQuery(next); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onClick={() => setOpen(true)}
          onKeyDown={(event) => { if (event.key === 'Escape') setOpen(false); }}
        />
        {open && needle ? (
          <CommandList
            label="搜索结果"
            className="absolute inset-x-0 top-full z-20 mt-1 min-w-64 rounded-lg bg-raised p-1 shadow-pop"
            // The box keeps the keyboard while a result is pressed.
            onMouseDown={(event) => event.preventDefault()}
          >
            <CommandEmpty>没有匹配“{query.trim()}”的设置。</CommandEmpty>
            {groups.map((group) => {
              const items = found.filter((entry) => entry.group === group);
              return items.length ? (
                <CommandGroup key={group} heading={group}>
                  {items.map((entry) => (
                    <CommandItem key={entry.key} value={entry.key} className="flex-col items-start gap-0" onSelect={() => { setOpen(false); onPick(entry.key); }}>
                      <span>{entry.title}</span>
                      <span className="text-xs text-faint wrap-anywhere">{group} · <span className="font-mono">{entry.key}</span></span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              ) : null;
            })}
          </CommandList>
        ) : null}
      </Command>
    </div>
  );
}

export function SettingsPage() {
  const { setLocale, t, bi } = useI18n();
  const queryClient = useQueryClient();
  // A group, or one item: a link to an item opens its group at it.
  const { place } = useParams();
  const navigate = useNavigate();
  const { data, isPending, error } = useQuery(settingsQuery);
  // What the Router's account and tier rows pick from, read for those two rows alone:
  // the page is drawn from its own read and does not wait for this one, and a failure
  // here leaves them offering nothing to bind.
  const { data: accounts } = useQuery(accountsQuery);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  // How many times a search result was picked: picking the item already marked brings it
  // into view again.
  const [picks, setPicks] = useState(0);
  // One save at a time for the whole page: each answer is then the list as the service
  // left it, and no other answer can arrive out of order to undo it.
  const change = useChange<Listing>({ mutationKey: CHANGE, queryKey: settingsQuery.queryKey });
  // A page opened at one item brings it into view once, when it first exists.
  const revealed = useRef<string | null>(null);
  const flash = useRef<number | undefined>(undefined);

  const entries = data ? entriesOf(data) : [];
  const imGroup = data ? imGroupOf(data.settings) : null;
  const groups = data ? [...new Set(data.settings.map(({ group }) => group)), DEPLOYMENT] : [];
  const marked = entries.find(({ key }) => key === place)?.key;
  const legacyImPlace = imGroup !== null && (place === LEGACY_WECOM || place === LEGACY_WEIXIN || place === IM_CHANNELS);
  const current = entries.find(({ key }) => key === marked)?.group
    ?? (place === GITHUB
      ? GITHUB
      : legacyImPlace
        ? imGroup
        : place !== undefined && groups.includes(place)
          ? place
          : groups[0] ?? '');
  const reveal = marked ? `${marked}#${picks}` : null;

  useEffect(() => () => window.clearTimeout(flash.current), []);

  // Each group opens at its head. Before the item a link points at is brought into view,
  // which runs after this.
  const scroller = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (scroller.current) scroller.current.scrollTop = 0;
  }, [current]);

  useEffect(() => {
    if (!reveal) {
      revealed.current = null;
      return;
    }
    if (revealed.current === reveal) return;
    const row = document.getElementById(`setting-${marked}`);
    if (!row) return;
    revealed.current = reveal;
    row.scrollIntoView({ block: 'center' });
  }, [reveal, marked]);

  const patch = (key: string, draft: Draft): void => setDrafts((all) => ({ ...all, [key]: { ...all[key], ...draft } }));
  const edit = (key: string, field: string): void => patch(key, { field });

  const save: Save = async (key, request, taken) => {
    if (!change.free()) return;
    setSaving(key);
    patch(key, { error: undefined });
    try {
      let nextLocale: string | undefined;
      await change.send(request, (page, answer) => {
        const patchResult = taken(answer, page);
        if (key === 'ui.locale' && patchResult.settings) {
          const found = patchResult.settings.find((item) => item.key === 'ui.locale');
          if (typeof found?.value === 'string') nextLocale = found.value;
        }
        return { ...page, ...patchResult };
      });
      if (key === 'ui.locale') {
        if (nextLocale) setLocale(normalizeLocale(nextLocale));
        void queryClient.invalidateQueries({ queryKey: stateQuery.queryKey });
      }
      // In one step with releasing the lock: the row is never open on the old value.
      setDrafts(({ [key]: _saved, ...rest }) => rest);
      setSaved(key);
      window.clearTimeout(flash.current);
      flash.current = window.setTimeout(() => setSaved(null), SAVED_MS);
    } catch (failure) {
      patch(key, { error: messageOf(failure) });
    } finally {
      setSaving(null);
    }
  };

  const allLogins = loginChoices(accounts);
  const dirtyGroups = new Set<string>();
  for (const item of data?.settings ?? []) {
    if (item.type === 'boolean') continue;
    const draft = drafts[item.key];
    if (draft?.field !== undefined && draft.field !== settingField(item, item.value, allLogins)) {
      dirtyGroups.add(item.group);
    }
  }
  if ((drafts[SECRET]?.field ?? '') !== '') {
    const secretGroup = data?.settings.find((item) => item.key === 'wecom.botId')?.group;
    if (secretGroup) dirtyGroups.add(secretGroup);
  }
  const hasUnsavedDrafts = dirtyGroups.size > 0;

  useEffect(() => {
    if (!hasUnsavedDrafts) return undefined;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [hasUnsavedDrafts]);

  if (!data) {
    return (
      <>
        <PageBar title={t('settings.title')} />
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pt-5 shell:px-6">
          {error ? <Problem role="alert" className="mb-3">{error.message}</Problem> : null}
          {isPending ? <SkeletonPage /> : null}
        </div>
      </>
    );
  }

  const row = { saving, saved, busy: change.busy, save, edit };
  const all = data.settings;
  // The account the tier row is about: the account row's draft while it is being edited,
  // otherwise the account the list says is saved.
  const accountItem = all.find(({ key }) => key === ROUTER_ACCOUNT);
  const bound = drafts[ROUTER_ACCOUNT]?.field ?? (accountItem ? settingField(accountItem, accountItem.value) : '');
  const items = all.filter((item) => item.group === current);
  const has = (key: string): boolean => items.some((item) => item.key === key);
  const isImGroup = imGroup !== null && current === imGroup;
  const wecomItems = isImGroup ? items.filter((item) => !item.key.startsWith('im.')) : [];
  const wecomConfigured = Boolean(
    data.wecom.secret_set || all.some((item) => item.key === 'wecom.botId' && typeof item.value === 'string' && item.value.trim() !== ''),
  );
  const capabilityErrors = Object.fromEntries(
    Object.entries(drafts).map(([key, draft]) => [key, draft.error]),
  );
  const routerAccounts = accounts
    ? [
        ...accounts.accounts,
        ...accounts.machines.flatMap((machine) => (machine.logins ?? [])
          .filter((login) => login.configured && login.id !== null && (login.can_route || login.id === bound))
          .map((login) => ({
            id: login.id!,
            name: loginName(login),
            executor: login.executor,
            tiers: login.tiers,
            can_route: login.can_route,
            ...(login.router_reason ? { reason: login.router_reason } : {}),
          }))),
      ]
    : undefined;

  return (
    <>
      <PageBar title={t('settings.title')} />
      {/* The search and the groups stand still and only the group's own page scrolls: down
          the side on a wide screen, across the top on a phone. */}
      <div className="flex min-h-0 flex-1 flex-col wrap-anywhere shell:flex-row">
        <div className="flex flex-none flex-col gap-2 border-b border-border pt-3 shell:w-[232px] shell:gap-3 shell:border-r shell:border-b-0 shell:p-3">
          <div className="px-3 shell:px-0">
            <SettingsSearch
              entries={entries}
              groups={[...groups, GITHUB]}
              onPick={(key) => { setPicks((n) => n + 1); void navigate(placeLink(key)); }}
            />
          </div>
          <div className="flex min-h-0 min-w-0 items-center shell:flex-col shell:items-stretch shell:gap-2">
            <GroupNav groups={groups} current={current} dirtyGroups={dirtyGroups} />
            <nav aria-label={bi('外部集成', 'Integrations')} className="flex flex-none items-center pr-3 pb-2 shell:flex-col shell:items-stretch shell:border-t shell:border-border shell:px-0 shell:pt-2 shell:pb-0">
              <span className="hidden px-2.5 pb-1 text-2xs font-medium tracking-wide text-faint uppercase shell:block">{bi('外部集成', 'Integrations')}</span>
              <Link
                to={placeLink(GITHUB)}
                aria-current={current === GITHUB ? 'page' : undefined}
                className="flex min-h-hit items-center rounded-md px-2.5 text-sm whitespace-nowrap text-muted-foreground no-underline transition-colors duration-100 hover:bg-hover hover:text-foreground focus-visible:-outline-offset-2 aria-[current=page]:bg-brand-soft aria-[current=page]:font-medium aria-[current=page]:text-brand-foreground"
              >
                {GITHUB}
              </Link>
            </nav>
          </div>
        </div>
        <div ref={scroller} data-scroll="" className="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain">
          <div className="max-w-[880px] px-4 pt-5 pb-10 shell:px-6">
            {error ? <Problem role="alert" className="mb-3">{error.message}</Problem> : null}
            {/* A save sent before the owner left and came back: no row here says it is being saved. */}
            {change.busy && saving === null ? <Note role="status" className="mb-3">{EARLIER_CHANGE}</Note> : null}
            <section aria-label={current}>
              <h2 className="text-xl font-semibold tracking-[-0.01em]">{current}</h2>
              {isImGroup ? (
                <ImChannelsPanel
                  initialTab={imTabFor(place, marked)}
                  navSeq={`${place ?? ''}#${picks}`}
                  settings={items}
                  wecomConfigured={wecomConfigured}
                  busy={change.busy}
                  saving={saving}
                  saved={saved}
                  errors={capabilityErrors}
                  onToggleCapability={(key, nextValue) => {
                    const path = `/api/settings/${encodeURIComponent(key)}`;
                    void save(key, () => put<{ settings: Setting[] }>(path, { value: nextValue }), listOf);
                  }}
                  wecomConfig={(
                    <div className="overflow-hidden rounded-xl bg-raised shadow-card">
                      {wecomItems.map((item) => (
                        <SettingRow
                          key={item.key}
                          item={item}
                          current={marked === item.key}
                          accounts={routerAccounts}
                          logins={allLogins}
                          bound={bound}
                          {...row}
                          draft={drafts[item.key] ?? {}}
                        />
                      ))}
                      {has('wecom.botId') ? (
                        <SecretRow
                          current={marked === SECRET}
                          set={data.wecom.secret_set}
                          {...row}
                          draft={drafts[SECRET] ?? {}}
                        />
                      ) : null}
                    </div>
                  )}
                />
              ) : current === GITHUB ? <GitHubSetup /> : current === DEPLOYMENT ? (
                <>
                  <Note className="mt-1 mb-4">这些是服务现在实际的情况，只能看，不能在这里改。</Note>
                  <Facts className="rounded-xl bg-raised p-4 shadow-card">
                    {data.deployment.map(({ title, value }) => <Fact key={title} label={title}><Copyable value={value} /></Fact>)}
                  </Facts>
                </>
              ) : (
                <>
                  <Note className="mt-1 mb-4">
                    {has('router.cli')
                      ? '改完即时生效；负责人的路径、账号与档位需点下方“重启负责人”，标着“重启后生效”的需重启 Tycho 服务进程。'
                      : '改完即时生效；标着“重启后生效”的需重启 Tycho 服务进程后生效。'}
                  </Note>
                  <div className="overflow-hidden rounded-xl bg-raised shadow-card">
                    {items.map((item) => <SettingRow key={item.key} item={item} current={marked === item.key} accounts={routerAccounts} logins={allLogins} bound={bound} {...row} {...{ draft: drafts[item.key] ?? {} }} />)}
                    {has('wecom.botId') ? <SecretRow current={marked === SECRET} set={data.wecom.secret_set} {...row} {...{ draft: drafts[SECRET] ?? {} }} /> : null}
                    {has('router.cli') ? <RouterPanel current={marked === RESTART} page={data} {...row} {...{ draft: drafts[RESTART] ?? {} }} /> : null}
                  </div>
                  {current === LOGIN ? <PassphraseSetup /> : null}
                </>
              )}
            </section>
          </div>
        </div>
      </div>
    </>
  );
}
