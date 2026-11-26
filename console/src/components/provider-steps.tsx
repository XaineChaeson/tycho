// An account that is a line to a model service and its key (docs/design/native-login.md, the
// dsh account): which kind of line, the fields that kind asks, the key, and then the tiers —
// one form, saved as one account. What the fields are is the executor's own declaration
// (`provider_forms`), drawn here without knowing any executor by name. The tiers name a model
// on this line; which line that is the form writes into each tier itself, so it is not asked.
//
// "从线路读取" asks the line what it serves with the key typed here, and keeps nothing: it fills
// the list the tier rows pick from, and a line whose models are written by hand takes them as
// its own list.
import { useId, useState } from 'react';
import type { ProviderDraft, ProviderField, ProviderForm, ProviderLine, ProviderModelRow } from '@shared/provider-form.ts';
import { Field, Note, Problem } from '@/components/bits';
import { LoginEditor } from '@/components/login-form';
import { Button } from '@/components/ui/button';
import { Checkbox, Choice, Radio } from '@/components/ui/checkbox';
import { Input, Textarea } from '@/components/ui/input';
import { Option, Select } from '@/components/ui/select';
import { tierEditorOf, tierRefusal, withField, type AccountForm, type TierProblem } from '@/lib/accounts';
import { messageOf, post } from '@/lib/api';
import type { AccountModels, AccountsAndMachines } from '@/lib/types';

interface LineRead {
  models: { id: string; efforts?: string[] }[];
  at?: string;
  reason?: string;
}

const firstOf = (form: ProviderForm): ProviderLine => form.lines[0]!;

// What a field holds before the owner touches it.
function blankOf(field: ProviderField): unknown {
  if (field.kind === 'choice') return field.options[0]?.value ?? '';
  if (field.kind === 'models') return [{ id: '' }];
  return '';
}

export const draftOf = (line: ProviderLine): ProviderDraft =>
  ({ line: line.id, ...Object.fromEntries(line.fields.map((field) => [field.name, blankOf(field)])) });

// What is sent of a line as the form holds it, by its executor's form.
export const sendableLine = (draft: ProviderDraft, form: ProviderForm | undefined): ProviderDraft => {
  const line = form?.lines.find(({ id }) => id === draft.line);
  return line === undefined ? draft : sendable(draft, line);
};

// What is sent: model rows with no name are rows the owner has not filled in yet.
function sendable(draft: ProviderDraft, line: ProviderLine): ProviderDraft {
  const out: ProviderDraft = { line: draft.line };
  for (const field of line.fields) {
    const value = draft[field.name];
    if (field.kind === 'models') {
      out[field.name] = ((value as ProviderModelRow[] | undefined) ?? [])
        .filter((row) => row.id.trim() !== '')
        .map((row) => ({ id: row.id.trim(), ...(row.efforts?.length ? { efforts: row.efforts } : {}), ...(row.image ? { image: true } : {}) }));
    } else if (typeof value === 'string') {
      if (value.trim() !== '') out[field.name] = field.kind === 'more' ? value : value.trim();
    } else if (value !== undefined) {
      out[field.name] = value;
    }
  }
  return out;
}

function ModelRows({ id, field, rows, disabled, onChange }: {
  id: string;
  field: Extract<ProviderField, { kind: 'models' }>;
  rows: ProviderModelRow[];
  disabled: boolean;
  onChange: (rows: ProviderModelRow[]) => void;
}) {
  const at = (index: number, change: Partial<ProviderModelRow>): void => onChange(rows.map((row, where) => (where === index ? { ...row, ...change } : row)));
  return (
    <fieldset className="grid gap-2">
      <legend className="mb-1 text-sm font-medium">{field.label}</legend>
      {field.hint ? <Note className="text-xs">{field.hint}</Note> : null}
      {rows.map((row, index) => (
        <div key={index} role="group" aria-label={`第 ${index + 1} 个模型`} className="grid gap-2 rounded-lg border border-border p-2.5">
          <div className="flex items-center gap-2">
            <Input aria-label={`第 ${index + 1} 个模型的名字`} id={index === 0 ? id : undefined} className="font-mono text-xs" value={row.id} disabled={disabled} onChange={(event) => at(index, { id: event.target.value })} />
            {rows.length > 1 ? <Button size="sm" variant="ghost" disabled={disabled} onClick={() => onChange(rows.filter((_, where) => where !== index))}>删除</Button> : null}
          </div>
          <div className="flex flex-wrap gap-x-3">
            {field.efforts.map((effort) => (
              <Choice key={effort} className="min-h-7 text-xs">
                <Checkbox
                  checked={row.efforts?.includes(effort) ?? false}
                  disabled={disabled}
                  onChange={(event) => at(index, { efforts: event.target.checked ? [...(row.efforts ?? []), effort] : (row.efforts ?? []).filter((each) => each !== effort) })}
                />
                {effort}
              </Choice>
            ))}
            {field.image ? (
              <Choice className="min-h-7 text-xs">
                <Checkbox checked={row.image === true} disabled={disabled} onChange={(event) => at(index, { image: event.target.checked })} />
                {field.image}
              </Choice>
            ) : null}
          </div>
        </div>
      ))}
      <Button size="sm" className="justify-self-start" disabled={disabled} onClick={() => onChange([...rows, { id: '' }])}>再加一个模型</Button>
    </fieldset>
  );
}

// The line's own fields, the kind of line first.
export function LineFields({ form, draft, disabled, onChange }: {
  form: ProviderForm;
  draft: ProviderDraft;
  disabled: boolean;
  onChange: (draft: ProviderDraft) => void;
}) {
  const id = useId();
  const line = form.lines.find((each) => each.id === draft.line) ?? firstOf(form);
  const set = (name: string, value: unknown): void => onChange({ ...draft, [name]: value });
  return (
    <div className="grid gap-4">
      {form.lines.length > 1 ? (
        <fieldset className="grid gap-1">
          <legend className="mb-1 text-sm font-medium">线路</legend>
          {form.lines.map((each) => (
            <Choice key={each.id} className="items-start">
              <span className="mt-0.5 flex"><Radio name={`${id}-line`} checked={line.id === each.id} disabled={disabled} onChange={() => onChange(draftOf(each))} /></span>
              <span className="grid">
                <span className="font-medium">{each.label}</span>
                {each.hint ? <span className="text-xs text-muted-foreground">{each.hint}</span> : null}
              </span>
            </Choice>
          ))}
        </fieldset>
      ) : null}
      {line.fields.map((field) => {
        const fieldId = `${id}-${field.name}`;
        if (field.kind === 'models') {
          return <ModelRows key={field.name} id={fieldId} field={field} rows={(draft[field.name] as ProviderModelRow[] | undefined) ?? [{ id: '' }]} disabled={disabled} onChange={(rows) => set(field.name, rows)} />;
        }
        return (
          <Field key={field.name} htmlFor={fieldId} label={field.label} hint={field.hint}>
            {field.kind === 'choice' ? (
              <Select id={fieldId} wrapperClassName="flex" value={String(draft[field.name] ?? '')} disabled={disabled} onChange={(event) => set(field.name, event.target.value)}>
                {field.options.map((option) => <Option key={option.value} value={option.value}>{option.label}</Option>)}
              </Select>
            ) : field.kind === 'more' ? (
              <Textarea id={fieldId} rows={4} spellCheck={false} className="font-mono text-xs" value={String(draft[field.name] ?? '')} disabled={disabled} onChange={(event) => set(field.name, event.target.value)} />
            ) : (
              <Input id={fieldId} className="font-mono text-xs" placeholder={field.placeholder} value={String(draft[field.name] ?? '')} disabled={disabled} onChange={(event) => set(field.name, event.target.value)} />
            )}
          </Field>
        );
      })}
    </div>
  );
}

export function ProviderSteps({ form, page, busy, onEdit, onCreate, onBack, onDone }: {
  form: AccountForm;
  page: AccountsAndMachines;
  busy: boolean;
  onEdit: (form: AccountForm) => void;
  // Makes the account. Throws what the service refused it with.
  onCreate: (form: AccountForm, provider: ProviderDraft) => Promise<void>;
  onBack: () => void;
  onDone: () => void;
}) {
  const id = useId();
  const declared = page.provider_forms?.[form.executor];
  const [draft, setDraft] = useState<ProviderDraft>(() => (declared ? draftOf(firstOf(declared)) : { line: '' }));
  const [read, setRead] = useState<LineRead | null>(null);
  const [reading, setReading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tierProblem, setTierProblem] = useState<TierProblem | null>(null);
  if (!declared) return <Problem role="alert">这个执行器的账号没有线路可填</Problem>;
  const line = declared.lines.find((each) => each.id === draft.line) ?? firstOf(declared);
  const editor = tierEditorOf(page.tier_forms, form.executor);
  // What the tiers pick a model from: what was read from the line, else the models written here.
  const written = line.fields.filter((field) => field.kind === 'models')
    .flatMap((field) => ((draft[field.name] as ProviderModelRow[] | undefined) ?? []).filter((row) => row.id.trim() !== '').map((row) => ({ id: row.id.trim(), efforts: row.efforts ?? [] })));
  const models: AccountModels | undefined = read?.models.length
    ? { list: read.models, at: read.at ?? null, refreshing: reading }
    : written.length ? { list: written, at: null, refreshing: false }
      : read?.reason ? { list: [], at: null, refreshing: false, reason: read.reason } : undefined;

  async function readLine(): Promise<void> {
    setReading(true);
    try {
      const answer = await post<LineRead>('/api/account-lines/models', { executor: form.executor, provider: sendable(draft, line), ...(form.credential === '' ? {} : { key: form.credential }) });
      setRead(answer);
      // A line whose models are written by hand takes what it serves as its list, to tick strengths on.
      const rows = line.fields.find((field) => field.kind === 'models');
      if (rows && answer.models.length > 0 && written.length === 0) {
        setDraft((current) => ({ ...current, [rows.name]: answer.models.map((model) => ({ id: model.id, ...(model.efforts?.length ? { efforts: model.efforts } : {}) })) }));
      }
    } catch (refused) {
      setRead({ models: [], reason: messageOf(refused) });
    } finally {
      setReading(false);
    }
  }

  async function save(): Promise<void> {
    const problem = tierRefusal(form.tiers, editor);
    if (form.credential === '') {
      setError(`先填${declared!.key.label}`);
      return;
    }
    if (problem) {
      setTierProblem(problem.at === null ? null : problem);
      setError(problem.at === null ? problem.message : null);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onCreate({ ...form, tiers: withField(form.tiers, editor, 'provider', line.route) }, sendable(draft, line));
      onDone();
    } catch (refused) {
      setError(messageOf(refused));
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <LoginEditor
        chosen
        form={form}
        saving={saving}
        busy={busy || saving || reading}
        page={page}
        problem={tierProblem}
        models={models}
        cancelLabel="上一步"
        secret={null}
        hidden={['provider']}
        before={(
          <div className="grid gap-4">
            <LineFields form={declared} draft={draft} disabled={saving} onChange={(next) => { setDraft(next); setRead(null); }} />
            <Field htmlFor={`${id}-key`} label={declared.key.label} hint={declared.key.hint}>
              <Input id={`${id}-key`} type="password" autoComplete="new-password" value={form.credential} disabled={saving}
                onChange={(event) => { onEdit({ ...form, credential: event.target.value }); setRead(null); }} />
            </Field>
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" disabled={reading || saving} onClick={() => void readLine()}>{reading ? '正在读取' : '从线路读取模型'}</Button>
              <Note className="text-xs">{read?.reason ? `没读到：${read.reason}` : read?.models.length ? `读到 ${read.models.length} 个模型，档位里可以直接选` : '用填好的地址和密钥问一次这条线路；主机够不着的内网地址就手填。'}</Note>
            </div>
          </div>
        )}
        onEdit={(field, value) => {
          onEdit({ ...form, [field]: value });
          if (field === 'tiers') setTierProblem(null);
        }}
        onSave={() => void save()}
        onCancel={() => { setError(null); onBack(); }}
      />
      {error ? <Problem role="alert" className="mt-3">{error}</Problem> : null}
    </>
  );
}
