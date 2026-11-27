// Adding an account, in one window (docs/design/native-login.md §二): which executor it is
// for, how its login is obtained, then its tiers. It is not asked for a name: the service
// names a new account after who its login says it is, and the name can be changed on the
// account afterwards. What an executor offers is its own to say
// (its adapter's `accountLogin`, which the service hands over with whether each way can be
// done on this host now): the window draws the ways it is told, in the order it is told
// them, and knows no executor by name. An executor that offers none is listed all the same,
// with where its login lives instead: "why only this one" is answered where the question
// comes up.
//
// A new way to obtain a login is a name in shared/logins.ts, the adapter's declaration, and
// here its words in WAYS and its steps where the others are drawn.
import { useQueryClient } from '@tanstack/react-query';
import { useId, useRef, useState, type ReactNode, type RefObject } from 'react';
import { Link } from 'react-router';
import type { LoginView } from '@shared/claude-login.ts';
import type { CodexLoginView } from '@shared/codex-login.ts';
import { credentialText } from '@shared/labels.ts';
import type { AccountLoginWay } from '@shared/logins.ts';
import { Mono, Note, Problem } from '@/components/bits';
import { cancelHeld, ClaudeLoginSteps } from '@/components/claude-login';
import { cancelCodexHeld, CodexLoginSteps } from '@/components/codex-login';
import { LoginEditor } from '@/components/login-form';
import { MachineSignInSteps } from '@/components/machine-sign-in';
import { ProviderSteps } from '@/components/provider-steps';
import type { ProviderDraft } from '@shared/provider-form.ts';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Radio } from '@/components/ui/checkbox';
import { Dialog, DialogActions, DialogContent } from '@/components/ui/dialog';
import { newAccountForm, tierEditorOf, tierRefusal, type AccountForm, type TierProblem } from '@/lib/accounts';
import { messageOf } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { accountsQuery } from '@/lib/queries';
import type { AccountsAndMachines } from '@/lib/types';
import { cn } from '@/lib/utils';

type WayMeta = { title: string; note: string; go: string; lead: string; secret?: { label: string; help: string } };

// Each way a login is obtained, in the owner's words: what it is called, what picking it
// means, what the button that goes on says, and what the window says over its steps.
// `secret` is what the typed secret is called, where the way has the owner type one.
function waysMeta(t: (key: string) => string): Record<AccountLoginWay, WayMeta> {
  return {
    page: {
      title: t('acct.add.way.page.title'),
      note: t('acct.add.way.page.note'),
      go: t('acct.add.way.page.go'),
      lead: t('acct.add.way.page.lead'),
    },
    device: {
      title: t('acct.add.way.device.title'),
      note: t('acct.add.way.device.note'),
      go: t('acct.add.way.page.go'),
      lead: t('acct.add.way.device.lead'),
    },
    key: {
      title: t('acct.add.way.key.title'),
      note: t('acct.add.way.key.note'),
      go: t('acct.add.way.key.go'),
      lead: t('acct.add.way.key.lead'),
      secret: { label: credentialText.typed.label, help: credentialText.typed.help },
    },
    provider: {
      title: t('acct.add.way.provider.title'),
      note: t('acct.add.way.provider.note'),
      go: t('acct.add.way.key.go'),
      lead: t('acct.add.way.provider.lead'),
    },
    machine: {
      title: t('acct.add.way.machine.title'),
      note: t('acct.add.way.machine.note'),
      go: t('acct.add.way.key.go'),
      lead: t('acct.add.way.machine.lead'),
    },
  };
}

// One of a few things to pick from, each with a line that says what picking it means. The
// whole card is the target; one that cannot be picked says why in that same line.
function Pick({ name, checked, disabled = false, title, children, onPick }: {
  name: string; checked: boolean; disabled?: boolean; title: ReactNode; children: ReactNode; onPick: () => void;
}) {
  return (
    <label
      className={cn(
        'flex cursor-pointer items-start gap-3 rounded-lg border border-border px-3 py-2.5 transition-colors duration-100',
        'has-checked:border-brand-border has-checked:bg-brand-soft has-disabled:cursor-not-allowed has-disabled:bg-muted',
        disabled ? null : 'hover:not-has-checked:bg-hover',
      )}
    >
      <span className="mt-0.5 flex"><Radio name={name} checked={checked} disabled={disabled} onChange={onPick} /></span>
      <span className="grid min-w-0 gap-0.5">
        <span className={cn('flex flex-wrap items-center gap-2 text-sm font-medium', disabled ? 'text-muted-foreground' : null)}>{title}</span>
        <span className="text-xs text-muted-foreground">{children}</span>
      </span>
    </label>
  );
}

function Steps({ page, busy, seen, seenCodex, onCreate, onClose }: {
  page: AccountsAndMachines;
  busy: boolean;
  seen: RefObject<LoginView | undefined>;
  seenCodex: RefObject<CodexLoginView | undefined>;
  onCreate: (form: AccountForm, provider?: ProviderDraft) => Promise<void>;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const id = useId();
  const wayInfo = waysMeta(t);
  // An executor that offers a way to obtain its login can be an account; those come first,
  // the rest after them with where their login lives. When an executor already offers a
  // host-managed subscription login ('page' or 'device'), 'machine' is only for re-signing on
  // the Machines page; when it has none (e.g. Gemini / agy), 'machine' is offered first here.
  const waysOf = (executor: string) => {
    const raw = page.account_logins?.[executor] ?? [];
    return raw.some((each) => each.way === 'page' || each.way === 'device')
      ? raw.filter((each) => each.way !== 'machine')
      : raw;
  };
  const accountable = page.executors.filter((each) => waysOf(each).length > 0);
  const executors = [...accountable, ...page.executors.filter((each) => !accountable.includes(each))];
  const onMachines = executors.filter((each) => !accountable.includes(each));
  const [form, setForm] = useState<AccountForm>(() => newAccountForm(accountable[0] ?? ''));
  const [step, setStep] = useState<'choose' | AccountLoginWay>('choose');
  const [picked, setPicked] = useState<AccountLoginWay | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tierProblem, setTierProblem] = useState<TierProblem | null>(null);
  const [saving, setSaving] = useState(false);
  const ways = waysOf(form.executor);
  const open = ways.filter(({ available }) => available);
  // The way the owner picked, while it can still be done; otherwise the first the executor
  // offers that this host can do.
  const way = (open.find((each) => each.way === picked) ?? open[0])?.way;
  const can = way !== undefined;

  function next(): void {
    setError(null);
    if (way !== undefined) setStep(way);
  }

  async function save(): Promise<void> {
    const refused = form.credential === '' ? t('acct.add.fillSecretFirst', { label: credentialText.typed.label }) : null;
    // What is wrong with a tier row is said beside that row; the form stays as it was typed.
    const problem = refused ? null : tierRefusal(form.tiers, tierEditorOf(page.tier_forms, form.executor));
    if (refused || problem) {
      const beside = problem !== null && problem.at !== null;
      setError(refused ?? (beside ? null : problem!.message));
      setTierProblem(beside ? problem : null);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onCreate(form);
      onClose();
    } catch (refusal) {
      setError(messageOf(refusal));
    } finally {
      setSaving(false);
    }
  }

  return (
    <DialogContent className="max-w-[560px]" title={t('accounts.addAccount')} description={step === 'choose' ? t('acct.add.chooseLead') : wayInfo[step].lead}>
      {step === 'choose' ? (
        <form className="grid gap-5" onSubmit={(event) => { event.preventDefault(); next(); }}>
          <fieldset className="grid gap-2">
            <legend className="mb-2 text-sm font-medium">{t('acct.executorTitle')}</legend>
            <div className="grid gap-2">
              {executors.map((each) => (
                <Pick
                  key={each}
                  name={`${id}-executor`}
                  checked={form.executor === each}
                  disabled={!accountable.includes(each)}
                  title={<Mono>{each}</Mono>}
                  // The tiers are written the executor's own way: another executor starts them blank.
                  onPick={() => { setForm(newAccountForm(each)); setPicked(null); setTierProblem(null); }}
                >
                  {accountable.includes(each) ? t('acct.add.executorAccountable') : t('acct.add.executorMachineOnly')}
                </Pick>
              ))}
            </div>
            {onMachines.length ? (
              <Note className="text-xs">
                {t('acct.add.onMachinesPrefix', { executors: onMachines.join(t('acct.listSep')) })}
                <Link to="/machines" className="mx-0.5">{t('nav.machines')}</Link>
                {t('acct.add.onMachinesSuffix')}
              </Note>
            ) : null}
          </fieldset>

          {ways.length ? (
            <fieldset className="grid gap-2">
              <legend className="mb-2 text-sm font-medium">{t('acct.add.howToSignIn')}</legend>
              <div className="grid gap-2">
                {ways.map((each, at) => (
                  <Pick
                    key={each.way}
                    name={`${id}-way`}
                    checked={way === each.way}
                    disabled={!each.available}
                    // The executor lists its ways best first: with more than one to pick from, that is said.
                    title={<>{wayInfo[each.way].title}{at === 0 && each.available && ways.length > 1 ? <Badge tone="running">{t('acct.add.recommended')}</Badge> : null}</>}
                    onPick={() => setPicked(each.way)}
                  >
                    {each.available ? wayInfo[each.way].note : each.why ?? t('acct.add.hostUnavailable')}
                  </Pick>
                ))}
              </div>
            </fieldset>
          ) : null}

          {error ? <Problem role="alert">{error}</Problem> : null}
          <DialogActions>
            <Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
            <Button type="submit" variant="primary" disabled={!can}>{way === undefined ? t('acct.add.way.key.go') : wayInfo[way].go}</Button>
          </DialogActions>
        </form>
      ) : null}

      {step === 'page' ? (
        <ClaudeLoginSteps
          target={{ mode: 'new' }}
          page={page}
          seen={seen}
          onDone={onClose}
          onBack={() => setStep('choose')}
        />
      ) : null}

      {step === 'device' ? (
        <CodexLoginSteps
          target={{ mode: 'new' }}
          page={page}
          seen={seenCodex}
          onDone={onClose}
          onBack={() => setStep('choose')}
        />
      ) : null}

      {step === 'provider' ? (
        <ProviderSteps form={form} page={page} busy={busy} onEdit={setForm} onCreate={onCreate} onBack={() => setStep('choose')} onDone={onClose} />
      ) : null}

      {step === 'machine' ? (
        <MachineSignInSteps
          executor={form.executor}
          page={page}
          busy={busy}
          onBack={() => setStep('choose')}
          onDone={onClose}
        />
      ) : null}

      {step === 'key' ? (
        <>
          <LoginEditor
            chosen
            form={form}
            saving={saving}
            busy={busy || saving}
            page={page}
            problem={tierProblem}
            cancelLabel={t('acct.action.prevStep')}
            secret={wayInfo[step].secret}
            onEdit={(field, value) => {
              setForm((current) => ({ ...current, [field]: value }));
              // A row changed: what the last save found wrong was about the row as it was typed.
              if (field === 'tiers') setTierProblem(null);
            }}
            onSave={() => void save()}
            onCancel={() => { setError(null); setStep('choose'); }}
          />
          {error ? <Problem role="alert" className="mt-3">{error}</Problem> : null}
        </>
      ) : null}
    </DialogContent>
  );
}

// Closing the window is cancelling: a login on its way is let go of, and the page reads its
// accounts again for the one that may have been made.
export function AddAccountWindow({ open, page, busy, onCreate, onClose }: {
  open: boolean;
  page: AccountsAndMachines;
  // A change to the logins is on its way: nothing is saved until it has answered.
  busy: boolean;
  // Makes the account from a typed secret, and the line for an account that is one. Throws
  // what the service refused it with.
  onCreate: (form: AccountForm, provider?: ProviderDraft) => Promise<void>;
  onClose: () => void;
}) {
  const client = useQueryClient();
  const seen = useRef<LoginView | undefined>(undefined);
  const seenCodex = useRef<CodexLoginView | undefined>(undefined);
  const close = (): void => {
    const login = seen.current;
    const codexLogin = seenCodex.current;
    seen.current = undefined;
    seenCodex.current = undefined;
    cancelHeld(login);
    cancelCodexHeld(codexLogin);
    void client.invalidateQueries({ queryKey: accountsQuery.queryKey });
    onClose();
  };
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) close(); }}>
      {open ? <Steps page={page} busy={busy} seen={seen} seenCodex={seenCodex} onCreate={onCreate} onClose={close} /> : null}
    </Dialog>
  );
}
