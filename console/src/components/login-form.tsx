// The form of a login, wherever it is edited: an account on the accounts page, or a
// machine's own login on its machine (docs/design/accounts-machines-decoupled.md — the two
// carry the same tiers and limits, so they are one component and one set of words).
// The values the form shows are read out of the text every time a row is drawn, so the text
// stays the one thing that is true (docs/design/roles-and-tiers.md §8).
import { useId, useState, type ReactNode } from 'react';
import { credentialText, modelText, tierText } from '@shared/labels.ts';
import { TIERS, isTierId, tierDecl, tierLabel, type TierDecl, type TierId } from '@shared/tiers.ts';
import type { TierFieldName } from '@shared/tier-form.ts';
import { Details, Field, Mono, Note, Problem } from '@/components/bits';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input, Textarea } from '@/components/ui/input';
import { Option, Select } from '@/components/ui/select';
import {
  blankTier, defaultEffortOf, effortChoices, effortUnsupported, modelChoices, modelMissing, modelsFor, tierEditorOf,
  type AccountForm, type TierEditor, type TierProblem, type TierRow,
} from '@/lib/accounts';
import type { Account, AccountModels, AccountsAndMachines, MachineCheck, MachineLogin, Tier } from '@/lib/types';

// What one login's card is doing while the page is open: its open form, why the last change
// failed, what the last save found wrong with the tier rows, and the last connection test.
// The page's own reads leave these alone; leaving the page forgets them.
export interface LoginDraft {
  form: AccountForm | null;
  error: string | null;
  tierProblem: TierProblem | null;
  saving: boolean;
  retrying: boolean;
  confirm: boolean;
  checking: boolean;
  // The one machine a test asked; `unchecked` says why none was asked.
  check: { at: number; machine?: MachineCheck | null; unchecked?: string; failure?: string; modelsFailure?: string } | null;
}

export const BLANK_LOGIN: LoginDraft = { form: null, error: null, tierProblem: null, saving: false, retrying: false, confirm: false, checking: false, check: null };

// The tiers a login holds, as the owner reads them everywhere: the tier's name, whether
// it is the executor's own text or a place on the machine, and a name the ledger still keeps
// from an older layout marked as one the system no longer uses. The whole text is what the
// badge says on hover, so the card stays readable and nothing is hidden.
export function TierBadges({ tiers, editor }: {
  tiers: Record<string, Tier> | undefined;
  // How this login's executor writes a tier: with it, the badge also says which model and
  // strength the tier names, read out of its text.
  editor?: TierEditor | undefined;
}) {
  const names = Object.keys(tiers ?? {});
  if (names.length === 0) return null;
  return (
    <span className="flex flex-wrap gap-1.5">
      {names.map((name) => {
        const tier = tiers![name]!;
        const values = editor?.parse(tier.text);
        return (
          <Badge key={name} tone="plain" title={tier.text} className="whitespace-normal wrap-anywhere">
            <span className="text-foreground">{tierLabel(name)}</span>
            {values?.model ? <span className="font-mono font-normal">{[values.model, values.effort].filter(Boolean).join(' · ')}</span> : null}
            {/* A name from an older layout: the page says so, and the form is where it is settled. */}
            {isTierId(name) ? null : <span className="text-waiting-foreground">{tierText.stale}</span>}
          </Badge>
        );
      })}
    </span>
  );
}

const TIER_BOX = 'grid gap-2.5 rounded-lg border p-3';

interface RouteChoice {
  id: string;
  label?: string;
  source?: 'account' | 'api-key' | 'custom';
}

function cleanRouteId(val: string | undefined): string {
  const trimmed = val?.trim() ?? '';
  const unquoted = /^(['"])(.*)\1$/.exec(trimmed);
  return unquoted ? unquoted[2]!.trim() : trimmed;
}

function useMemoRoutes(
  discovered: readonly RouteChoice[],
  defaultRoute: string | null | undefined,
  rows: readonly TierRow[],
  editor: TierEditor | undefined,
): RouteChoice[] {
  const out: RouteChoice[] = [];
  const seen = new Set<string>();
  const add = (choice: RouteChoice) => {
    const id = cleanRouteId(choice.id);
    if (!id || seen.has(id)) return;
    seen.add(id);
    out.push({
      id,
      ...(choice.label && choice.label !== id ? { label: choice.label } : {}),
      ...(choice.source ? { source: choice.source } : {}),
    });
  };
  for (const item of discovered) add(item);
  if (defaultRoute) add({ id: defaultRoute });
  if (editor?.fields.includes('provider')) {
    for (const row of rows) {
      const p = editor.parse(row.value)?.provider;
      if (p) add({ id: p });
    }
  }
  return out;
}

// The tier list is the names in shared/tiers.ts, in their one order (low to high), then any
// name the ledger still keeps from an older layout. A row is filled in with the values the
// executor's own declaration names — a model, a strength, and for dsh the provider — and
// only what that declaration cannot hold is left to the raw text under "高级". What the
// owner may pick a model from is what that login's executor reported it can use. A row left
// blank is a login that does not take that tier; a name the system no longer uses cannot be
// saved, so it stands marked with the one action that settles it.
function Tiers({ owner, rows, editor: declared, hidden = [], models, routeOptions = [], defaultRoute = null, problem, disabled, onChange }: {
  owner: string;
  rows: TierRow[];
  // What the chosen executor's text is made of; undeclared, a row is its raw text only.
  editor: TierEditor | undefined;
  // Fields the login itself decides (an account's line), which a row does not ask.
  hidden?: readonly TierFieldName[];
  // What this login's executor reported it may use. Undefined when nothing has been read,
  // and then a model is typed by hand.
  models: AccountModels | undefined;
  // Auto-discovered routes/channels reported by the machine (e.g. dsh desktop+headless unified routes).
  routeOptions?: readonly RouteChoice[];
  defaultRoute?: string | null;
  problem: TierProblem | null;
  disabled: boolean;
  onChange: (rows: TierRow[]) => void;
}) {
  const editor = declared && hidden.length > 0 ? { ...declared, fields: declared.fields.filter((field) => !hidden.includes(field)) } : declared;
  const [routeInput, setRouteInput] = useState('');
  const showQuickRoute = Boolean(editor && editor.fields.includes('provider'));
  const applyProviderToAll = (providerValue: string): void => {
    if (!editor) return;
    const clean = cleanRouteId(providerValue);
    onChange(rows.map((row) => {
      if (!isTierId(row.name)) return row;
      const parsed = editor.parse(row.value);
      if (parsed === undefined) return row;
      if (blankTier(row) && clean === '') return row;
      const next = editor.render({ ...parsed, provider: clean }, row.value);
      return { ...row, value: next, held: row.value.trim() === '' ? row.held : next.trim() !== '' };
    }));
  };
  const quickChoices = useMemoRoutes(routeOptions, defaultRoute, rows, editor);
  const activeProviders = new Set(
    editor?.fields.includes('provider')
      ? rows
        .filter((r) => isTierId(r.name) && !blankTier(r))
        .map((r) => cleanRouteId(editor.parse(r.value)?.provider))
        .filter(Boolean)
      : [],
  );
  const singleActiveProvider = activeProviders.size === 1 ? [...activeProviders][0] : null;
  // The move the owner has asked for onto a row that already holds something: said before
  // it happens, and done on the second click on the same row.
  const [moving, setMoving] = useState<{ at: number; to: TierId } | null>(null);
  const at = (index: number, change: Partial<TierRow>): void =>
    onChange(rows.map((each, where) => (where === index ? { ...each, ...change } : each)));
  // A name the system no longer uses moves onto the tier it names: the content is not
  // touched on the way, and the row it came from is gone. What the target held is
  // replaced, so if it held anything the owner is told first — and told again for the tier
  // the next click is actually about: the consent is for this row onto this tier, and
  // aiming at the other one asks afresh rather than reusing it.
  const move = (index: number, to: TierId): void => {
    const target = rows.findIndex((each) => each.name === to);
    const from = rows[index]!;
    const held = rows[target]!;
    if (!blankTier(held) && !(moving?.at === index && moving.to === to)) {
      setMoving({ at: index, to });
      return;
    }
    setMoving(null);
    onChange(rows.flatMap((row, where) =>
      where === index ? [] : where === target ? [{ ...row, value: from.value }] : [row]));
  };
  const remove = (index: number): void => {
    setMoving(null);
    onChange(rows.filter((_, where) => where !== index));
  };
  return (
    <fieldset className="grid gap-2.5">
      <legend className="mb-1 text-sm font-semibold">{tierText.legend}</legend>
      <Note className="text-xs">{tierText.note}</Note>
      {showQuickRoute ? (
        <div className="grid gap-2 rounded-lg border border-border/80 bg-muted/40 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs font-medium text-foreground">快捷设置线路（一键应用到全部档位，或清空以跟随本机默认）</span>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <Input
              aria-label="统一线路名"
              placeholder="输入任意线路名，如 deepseek 或自定义网关名…"
              className="h-8 min-w-44 flex-1 font-mono text-xs"
              value={routeInput}
              disabled={disabled}
              onChange={(event) => setRouteInput(event.target.value)}
            />
            <Button
              type="button"
              size="sm"
              variant="secondary"
              disabled={disabled || routeInput.trim() === ''}
              onClick={() => { applyProviderToAll(routeInput.trim()); setRouteInput(''); }}
            >
              应用到全部档位
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={disabled}
              onClick={() => applyProviderToAll('')}
            >
              跟随本机默认
            </Button>
          </div>
          {quickChoices.length > 0 ? (
            <div className="flex flex-wrap items-center gap-1.5 text-xs">
              <span className="text-faint">本机自动识别渠道：</span>
              {quickChoices.map((choice) => {
                const isActive = singleActiveProvider === choice.id;
                return (
                  <button
                    key={choice.id}
                    type="button"
                    disabled={disabled}
                    title={`一键切换全部档位到 ${choice.id}`}
                    onClick={() => applyProviderToAll(choice.id)}
                    className={`cursor-pointer inline-flex items-center gap-1 rounded border px-2 py-0.5 text-2xs transition-colors disabled:opacity-50 ${
                      isActive
                        ? 'border-primary bg-primary/10 text-primary font-medium'
                        : 'border-border bg-background text-foreground hover:border-primary'
                    }`}
                  >
                    {choice.label ? <span>{choice.label}</span> : null}
                    <span className="font-mono opacity-80">{choice.id}</span>
                  </button>
                );
              })}
            </div>
          ) : null}
        </div>
      ) : null}
      {models?.reason ? <Note className="text-xs text-waiting-foreground">{modelText.listMissing(models.reason)}</Note> : null}
      {rows.map((row, index) => {
        const decl = tierDecl(row.name);
        const place = index + 1;
        const rowProblem = problem?.at === index ? problem.message : null;
        if (decl === undefined) {
          return (
            <div key={`${row.name}:${index}`} role="group" aria-label={`第 ${place} 个档位`} className={`${TIER_BOX} border-waiting-border bg-waiting-soft`}>
              <div className="flex flex-wrap items-center gap-2">
                <Mono>{row.name}</Mono>
                <Note className="text-xs">{tierText.stale}：{tierText.staleNote}</Note>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {TIERS.map((tier) => (
                  <Button
                    key={tier.id}
                    size="sm"
                    disabled={disabled}
                    aria-label={`把第 ${place} 个档位${tierText.moveTo(tier.label)}`}
                    onClick={() => move(index, tier.id)}
                  >
                    {tierText.moveTo(tier.label)}
                  </Button>
                ))}
                <Button size="sm" variant="danger" disabled={disabled} onClick={() => remove(index)}>{tierText.remove}</Button>
              </div>
              {moving?.at === index ? <Note className="text-waiting-foreground">{tierText.overwrite(tierLabel(moving.to))}</Note> : null}
              {rowProblem ? <Problem role="alert">{rowProblem}</Problem> : null}
            </div>
          );
        }
        return (
          <TierRowEditor
            key={row.name}
            owner={owner}
            place={place}
            row={row}
            decl={decl}
            editor={editor}
            models={models}
            problem={rowProblem}
            disabled={disabled}
            onChange={(change) => at(index, change)}
          />
        );
      })}
    </fieldset>
  );
}

// What a tier's model is chosen from. The login's executor says which models it may use,
// and that list is what the form offers. A model outside it — an alias the executor still
// accepts, or one it has stopped reporting — is kept as it stands and can be typed by hand:
// a choice that could not hold what the owner already wrote would leave the tier unfixable.
// So a tier that names no model yet opens as the list, and typing by hand is the way out of
// it, picked from the list itself. With no list read, the box is the plain one it always was.
// No model is called a single space: the choice that leaves the list.
const BY_HAND = ' ';

function ModelField({ value, models, disabled, onChange }: {
  value: string;
  models: AccountModels | undefined;
  disabled: boolean;
  onChange: (model: string) => void;
}) {
  // The owner is typing a name the list does not hold: asked for from the list, or simply
  // done in the box. It holds while the box is emptied on the way to another name.
  const [typing, setTyping] = useState(false);
  const choices = modelChoices(models);
  if (choices.length === 0) {
    return <Input className="font-mono text-xs" value={value} disabled={disabled} onChange={(change) => onChange(change.target.value)} />;
  }
  if (choices.includes(value) || (value === '' && !typing)) {
    return (
      <Select
        wrapperClassName="flex"
        className="font-mono text-xs"
        value={value}
        disabled={disabled}
        onChange={(change) => {
          if (change.target.value === BY_HAND) setTyping(true);
          else onChange(change.target.value);
        }}
      >
        {/* Blank is a choice too: a tier that names no model is one this login does not take. */}
        <Option value="">{value === '' ? modelText.pick : modelText.none}</Option>
        {choices.map((model) => <Option key={model} value={model}>{model}</Option>)}
        <Option value={BY_HAND}>{modelText.typeByHand}</Option>
      </Select>
    );
  }
  return (
    <div className="grid gap-1.5">
      {/* Asked for from the list a moment ago: the box takes the focus the list had. */}
      <Input aria-label={modelText.handWritten} autoFocus={typing} className="font-mono text-xs" value={value} disabled={disabled} onChange={(change) => { setTyping(true); onChange(change.target.value); }} />
      <Select aria-label={modelText.pick} wrapperClassName="flex" value="" disabled={disabled} onChange={(change) => { if (change.target.value !== '') { setTyping(false); onChange(change.target.value); } }}>
        <Option value="">{modelText.pick}</Option>
        {choices.map((model) => <Option key={model} value={model}>{model}</Option>)}
      </Select>
    </div>
  );
}

// One of the tiers: what the page calls it and what it is for, and what this login
// holds for it. A text the shape cannot read is shown as what it is, never as an empty line
// that saving would then write over.
function TierRowEditor({ owner, place, row, decl, editor, models, problem, disabled, onChange }: {
  owner: string;
  place: number;
  row: TierRow;
  decl: TierDecl;
  editor: TierEditor | undefined;
  models: AccountModels | undefined;
  problem: string | null;
  disabled: boolean;
  onChange: (change: Partial<TierRow>) => void;
}) {
  const values = editor ? editor.parse(row.value) : undefined;
  const advanced = editor ? editor.advanced(row.value) : 0;
  const blank = blankTier(row);
  const set = (field: TierFieldName, value: string): void => {
    if (!editor || !values) return;
    const next = editor.render({ ...values, [field]: value }, row.value);
    onChange({ value: next, held: row.value.trim() === '' ? row.held : next.trim() !== '' });
  };
  // The strengths to offer, and the one the executor uses when the tier names none: both
  // follow the model the row stands on now.
  const efforts = effortChoices(models, values?.model ?? '', editor?.efforts ?? []);
  const noEffortSupported = effortUnsupported(models, values?.model ?? '');
  const effortMismatch = Boolean(values?.effort) && (
    noEffortSupported
    || (efforts.length > 0 && !efforts.includes(values!.effort))
  );
  const fallback = defaultEffortOf(models, values?.model ?? '');
  return (
    <div role="group" aria-label={`第 ${place} 个档位`} className={`${TIER_BOX} border-border`}>
      <div>
        <div className="flex flex-wrap items-baseline gap-x-2">
          <strong className="text-sm font-semibold">{decl.label}</strong>
          <Note className="text-xs">{decl.use}</Note>
        </div>
        <Note className="mt-0.5 text-xs">{blank ? (row.held ? tierText.blankHeld : decl.id === 'operate' ? tierText.blankOperate : tierText.blank) : `${tierText.legend}内容：${decl.recommend}`}</Note>
      </div>
      {editor ? (
        values === undefined ? <Note>{tierText.unreadable}</Note> : (
          <>
            <div className="grid gap-2.5 sm:grid-cols-2">
              {editor.fields.map((field) => (
                <label key={field} className="grid gap-1">
                  <span className="text-xs text-muted-foreground">{tierText[field]}</span>
                  {field === 'effort' ? (
                    <Select wrapperClassName="flex" value={values.effort} disabled={disabled || (noEffortSupported && values.effort === '')} onChange={(change) => set(field, change.target.value)}>
                      <Option value="">{noEffortSupported ? '该模型不支持推理强度' : fallback === undefined ? tierText.effortAny : modelText.defaultEffort(fallback)}</Option>
                      {/* A strength the model does not list is the owner's own: it stays, and is offered back. */}
                      {[...new Set([...efforts, values.effort])].filter((effort) => effort !== '').map((effort) => (
                        <Option key={effort} value={effort}>{effort}</Option>
                      ))}
                    </Select>
                  ) : field === 'model' ? (
                    <ModelField value={values.model} models={models} disabled={disabled} onChange={(model) => set(field, model)} />
                  ) : (
                    <Input className="font-mono text-xs" value={values[field]} disabled={disabled} onChange={(change) => set(field, change.target.value)} />
                  )}
                </label>
              ))}
            </div>
            {modelMissing(models, values.model) ? <Note className="text-xs text-waiting-foreground">{modelText.missing}</Note> : null}
            {effortMismatch ? (
              <Note className="text-xs text-waiting-foreground">
                {noEffortSupported
                  ? `当前模型不支持推理强度，建议清空「${values.effort}」改为留空。`
                  : `推理强度「${values.effort}」不在当前模型已探测的支持列表（${efforts.join(' / ')}）中，派发时可能被执行器拒绝。`}
              </Note>
            ) : null}
          </>
        )
      ) : null}
      <Details id={`tier-raw:${owner}:${place}`} summaryClassName="min-h-7 text-xs" title={<>{tierText.advanced}{advanced > 0 ? ` · ${tierText.advancedNote(advanced)}` : ''}</>}>
        <Textarea
          aria-label={`第 ${place} 个档位的内容`}
          className="mt-1 max-h-[50vh] overflow-y-auto font-mono text-xs"
          rows={6}
          spellCheck={false}
          value={row.value}
          disabled={disabled}
          onChange={(change) => onChange({ value: change.target.value, held: row.value.trim() === '' ? row.held : change.target.value.trim() !== '' })}
        />
      </Details>
      {problem ? <Problem role="alert">{problem}</Problem> : null}
    </div>
  );
}

// One form for both kinds of login. An account has a name, which the service gives a new one
// and the owner may change on one that exists; a new account's executor and login are chosen
// before this form opens, so only what tycho adds to it — the tiers, the permission mode
// and the limits — is here. A machine's own login is the machine's executor as it is signed in
// there, and the same applies.
// The form carries its own 保存 and 取消: wherever it stands (a drawer, a window), submitting
// it is the same one request.
export function LoginEditor({ account, own, onMachine = own !== undefined, signedIn, chosen, models, form, saving, busy, page, problem, cancelLabel = '取消', secret, before, hidden, onEdit, onSave, onCancel }: {
  account?: Account | undefined;
  // The machine's own login this form is about, instead of an account.
  own?: MachineLogin | undefined;
  // A machine's own login, also one the page has not read yet (just signed in): only what
  // tycho adds to it is asked.
  onMachine?: boolean;
  // A new account whose login was just done in the login window: its executor is that
  // login's and its token is held by the service, so neither is asked for again.
  signedIn?: boolean;
  // A new account whose executor was picked before this form opened: its name is the
  // service's to choose, so the form does not ask for one.
  chosen?: boolean;
  // The unsaved login's list, read with its token held on the service.
  models?: AccountModels | undefined;
  form: AccountForm;
  saving: boolean;
  busy: boolean;
  page: AccountsAndMachines;
  // What the last save found wrong with the tier rows, beside the row it is about.
  problem: TierProblem | null;
  // What leaving the form without saving is called where it stands: a step back, in a window of steps.
  cancelLabel?: string;
  // What the secret a new account is made with is called: the way it was obtained says
  // (add-account.tsx). Null: that way asks for it itself, in `before`.
  secret?: { label: string; help: string } | null | undefined;
  // What the way it was obtained asks before the secret: an account's line.
  before?: ReactNode;
  // Tier fields the login itself decides, which the rows do not ask.
  hidden?: readonly TierFieldName[] | undefined;
  onEdit: (name: keyof AccountForm, value: string | TierRow[]) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const prefix = useId();
  // Which fields there are depends on the executor chosen: only an executor whose own
  // command takes permission modes has that field, and it offers the ones it takes.
  const permissionModes = page.permission_modes[form.executor] ?? [];
  const box = (name: Exclude<keyof AccountForm, 'tiers'>) => ({
    id: `${prefix}-${name}`,
    value: form[name],
    disabled: saving,
    onChange: (event: { target: { value: string } }) => onEdit(name, event.target.value),
  });
  return (
    <form
      className="grid gap-6"
      onSubmit={(event) => {
        event.preventDefault();
        onSave();
      }}
    >
      {/* A new account is not asked for a name: the service names it, and it is changed here later. */}
      {onMachine || signedIn ? null : <fieldset className="grid gap-4">
        <legend className="mb-3 text-sm font-semibold">基本</legend>
        {chosen ? null : (
          <Field htmlFor={`${prefix}-name`} label="名字" hint="可以随时改名，项目和任务仍然使用同一份登录。">
            <Input {...box('name')} />
          </Field>
        )}
        {before}
        {account || signedIn || secret === null ? null : (
          <Field htmlFor={`${prefix}-credential`} label={secret?.label ?? credentialText.typed.label} hint={secret?.help ?? credentialText.typed.help}>
            <Input id={`${prefix}-credential`} type="password" autoComplete="new-password" value={form.credential} disabled={saving}
              onChange={(event) => onEdit('credential', event.target.value)} />
          </Field>
        )}
        <Note className="text-xs">账号可以在任何在线、装了这个执行器的机器上跑，每轮把这份登录交给那一轮。项目和任务可以再限定用哪几台机器。</Note>
      </fieldset>}

      <Tiers
        owner={own?.id ?? account?.id ?? form.name ?? '新账号'}
        rows={form.tiers}
        editor={tierEditorOf(page.tier_forms, form.executor)}
        hidden={hidden}
        // The login's own list, and only while the form is still about that login's
        // executor: what another executor reported says nothing about this one.
        models={models ?? (own ? own.models : modelsFor(account, form.executor))}
        routeOptions={own?.routes ?? []}
        defaultRoute={own?.route_label ?? null}
        problem={problem}
        disabled={saving}
        onChange={(rows) => onEdit('tiers', rows)}
      />

      {/* 不常用的项收在这里：需要时才打开，日常改的是上面那几项。 */}
      <Details id={`login-more:${own?.id ?? account?.id ?? 'new'}`} title="更多设置">
        <div className="grid gap-4 pt-2">
          {permissionModes.length > 0 ? (
            <Field htmlFor={`${prefix}-permission_mode`} label="权限模式" hint="不填就用这个执行器跑 Worker 时的默认模式。">
              <Select wrapperClassName="flex" {...box('permission_mode')}>
                <Option value="">默认</Option>
                {permissionModes.map((mode) => <Option key={mode} value={mode}>{mode}</Option>)}
              </Select>
            </Field>
          ) : null}
          <Field htmlFor={`${prefix}-timeout`} label="单次执行时限" hint="单位是分钟。可以不填，不填就按设置页的“单次执行时限”。">
            <Input {...box('timeout')} inputMode="decimal" />
          </Field>
          <Field
            htmlFor={`${prefix}-max_runs`}
            label="同时最多几轮执行"
            hint="可以不填，不填就不限。到了这个数，新的任务先等着，有一轮结束就接着派；没指定登录的任务会换到项目里别的登录上。"
          >
            <Input {...box('max_runs')} inputMode="numeric" />
          </Field>
        </div>
      </Details>

      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" variant="primary" disabled={busy}>{saving ? '保存中' : '保存'}</Button>
        <Button variant="ghost" disabled={saving} onClick={onCancel}>{cancelLabel}</Button>
      </div>
    </form>
  );
}
