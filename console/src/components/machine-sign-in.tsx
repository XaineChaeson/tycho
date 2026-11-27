// Signing one of the machines in to an executor of its own (docs/design/native-login.md, the
// Codex login): pick an online machine that has the executor, start the executor's own sign-in
// there, open the address it gives in your own browser and type its one-time code, and the
// machine is signed in. That is the machine's own login — tycho keeps nothing of it — so what
// follows in the same window is that login's tiers, as on the machines page.
//
// Leaving the steps while the sign-in is under way cancels it on the machine.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { SIGN_IN_STATE_TEXT, signInLive, type SignInView } from '@shared/sign-in.ts';
import { Callout, CopyButton, Field, Mono, Note, Problem } from '@/components/bits';
import { LoginEditor } from '@/components/login-form';
import { Button } from '@/components/ui/button';
import { Choice, Radio } from '@/components/ui/checkbox';
import { DialogActions } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { formOf, loginSettingsBody, newAccountForm, tierEditorOf, tierRefusal, type AccountForm, type TierProblem } from '@/lib/accounts';
import { api, messageOf, post, put } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { accountsQuery, PAGE } from '@/lib/queries';
import { isTychoDesktop, openExternalUrl } from '@/lib/utils';
import type { AccountsAndMachines, Machine } from '@/lib/types';

function renderWithMono(template: string, value: string): ReactNode {
  const idx = template.indexOf('\u0000');
  if (idx === -1) return template;
  return <>{template.slice(0, idx)}<Mono>{value}</Mono>{template.slice(idx + 1)}</>;
}

const SIGN_INS = '/api/sign-ins';
// How often a sign-in under way is asked about: the owner is watching it.
const SIGN_IN_POLL_MS = 1_000;
// After the sign-in: how often the page is read for the machine's fresh report, and for how
// long. Longer than the host's models question (node.modelListTimeoutMs, 30 seconds by
// default) plus a round of reports: a fresh sign-in makes that question reach the vendor.
const REPORT_POLL_MS = 1_000;
const REPORT_WAIT_MS = 45_000;

// The machines it can be done on now: here, and with the executor's command there.
export const signInMachines = (page: Pick<AccountsAndMachines, 'machines'>, executor: string): Machine[] =>
  page.machines.filter((machine) => machine.node.connected
    && (machine.node.executors?.executors ?? []).some((each) => each.executor === executor && each.installed && each.unusable === undefined));

export function MachineSignInSteps({ executor, page, busy, onBack, onDone, fixedMachine }: {
  executor: string;
  page: AccountsAndMachines;
  busy: boolean;
  onBack: () => void;
  onDone: () => void;
  fixedMachine?: Machine;
}) {
  const { t } = useI18n();
  const id = useId();
  const client = useQueryClient();
  const machines = signInMachines(page, executor).filter((machine) => !fixedMachine || machine.uid === fixedMachine.uid);
  const [machineId, setMachineId] = useState<string | null>(fixedMachine?.id ?? machines[0]?.id ?? null);
  const [signIn, setSignIn] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [codeInput, setCodeInput] = useState('');
  const [submittingCode, setSubmittingCode] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [tierProblem, setTierProblem] = useState<TierProblem | null>(null);
  const reportAtBefore = useRef<string | undefined>(undefined);
  const { data } = useQuery({
    queryKey: [PAGE, 'sign-in', signIn],
    queryFn: () => api<{ sign_in: SignInView }>(`${SIGN_INS}/${encodeURIComponent(signIn!)}`),
    enabled: signIn !== null,
    refetchInterval: (query) => (query.state.data && !signInLive(query.state.data.sign_in.state) ? false : SIGN_IN_POLL_MS),
  });
  const view = signIn === null ? undefined : data?.sign_in;
  const autoOpenedUrl = useRef<string | null>(null);
  useEffect(() => {
    if (view?.state !== 'waiting' || !view.url || !isTychoDesktop()) return;
    if (autoOpenedUrl.current === view.url) return;
    autoOpenedUrl.current = view.url;
    openExternalUrl(view.url);
  }, [view?.state, view?.url]);
  // What to cancel when the steps go away: the sign-in as last read, while it is under way.
  const live = useRef<SignInView | undefined>(undefined);
  useEffect(() => { live.current = view && signInLive(view.state) ? view : undefined; }, [view]);
  // Whether these steps are still open: a start answered after they closed is cancelled at once.
  const active = useRef(false);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      const held = live.current;
      if (held) void post(`${SIGN_INS}/${encodeURIComponent(held.id)}/cancel`).catch(() => undefined);
    };
  }, []);
  const machine = page.machines.find((each) => each.id === (view?.machine ?? machineId));
  // The models a signed-out executor lists are its own command's built-in ones, which can lag
  // far behind what the account may use; signed in, it asks its vendor. So the tiers wait for
  // the machine to report the executor signed in — it looks again as the sign-in ends — and
  // the page is read again until then, for a while: past that, the list stands as it is, said so.
  const reported = machine?.node.executors?.executors.find((each) => each.executor === executor);
  const own = machine?.logins?.find((login) => login.executor === executor);
  // Executors with a `loginStatus` probe flip `logged_in` to true; executors without one (`logged_in === null`,
  // e.g. `agy`) are ready once the post-sign-in executor report arrives or models are already listed.
  const fresh = reported?.logged_in === null
    ? (machine?.node.executors?.at !== undefined && machine.node.executors.at !== reportAtBefore.current) || (own?.models?.list.length ?? 0) > 0
    : reported?.logged_in === true;
  const [gaveUp, setGaveUp] = useState(false);
  const done = view?.state === 'done';
  useEffect(() => {
    if (!done || fresh) return;
    const again = setInterval(() => void client.invalidateQueries({ queryKey: accountsQuery.queryKey }), REPORT_POLL_MS);
    const enough = setTimeout(() => setGaveUp(true), REPORT_WAIT_MS);
    return () => { clearInterval(again); clearTimeout(enough); };
  }, [done, fresh, client]);
  // The machine's login as it stands is where the form starts: a login the host adopted from
  // the machine's report already has its tiers, and the owner edits those. Only a machine
  // that reports no login for this executor starts from a blank form.
  const [form, setForm] = useState<AccountForm>(() => (own ? { ...formOf(own), executor } : newAccountForm(executor)));
  const seeded = useRef(false);
  // The report that carries the login arrives after the sign-in ends: what the host adopted
  // is what the form then shows, once.
  useEffect(() => {
    if (!done || !own?.configured || seeded.current) return;
    seeded.current = true;
    setForm({ ...formOf(own), executor });
  }, [done, own, executor]);

  async function start(): Promise<void> {
    if (machineId === null) return;
    reportAtBefore.current = page.machines.find((each) => each.id === machineId)?.node.executors?.at;
    setStarting(true);
    setCodeInput('');
    setGaveUp(false);
    setError(null);
    try {
      const answer = await post<{ sign_in: SignInView }>(SIGN_INS, { machine: machineId, executor, ...(fixedMachine ? { machine_uid: fixedMachine.uid } : {}) });
      if (!active.current) {
        void post(`${SIGN_INS}/${encodeURIComponent(answer.sign_in.id)}/cancel`).catch(() => undefined);
        return;
      }
      live.current = answer.sign_in;
      client.setQueryData([PAGE, 'sign-in', answer.sign_in.id], answer);
      setSignIn(answer.sign_in.id);
    } catch (refused) {
      setError(messageOf(refused));
    } finally {
      setStarting(false);
    }
  }

  async function submitCode(): Promise<void> {
    if (!view) return;
    const value = codeInput;
    setCodeInput('');
    setSubmittingCode(true);
    setError(null);
    try {
      const answer = await post<{ sign_in: SignInView }>(`${SIGN_INS}/${encodeURIComponent(view.id)}/code`, { code: value });
      client.setQueryData([PAGE, 'sign-in', view.id], answer);
    } catch (refused) {
      setError(messageOf(refused));
    } finally {
      setSubmittingCode(false);
    }
  }

  async function cancel(): Promise<void> {
    if (!view) return;
    const answer = await post<{ sign_in: SignInView }>(`${SIGN_INS}/${encodeURIComponent(view.id)}/cancel`).catch((refused: unknown) => {
      setError(messageOf(refused));
      return undefined;
    });
    if (answer) client.setQueryData([PAGE, 'sign-in', view.id], answer);
  }

  // The machine's own login of this executor: its tiers, saved under its machine.
  async function save(): Promise<void> {
    if (!machine) return;
    const problem = tierRefusal(form.tiers, tierEditorOf(page.tier_forms, executor));
    if (problem) {
      setTierProblem(problem.at === null ? null : problem);
      setError(problem.at === null ? problem.message : null);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await put(`/api/machines/${encodeURIComponent(machine.uid)}/logins/${encodeURIComponent(executor)}`, loginSettingsBody(form, page.permission_modes[executor] ?? []));
      await client.invalidateQueries({ queryKey: accountsQuery.queryKey });
      onDone();
    } catch (refused) {
      setError(messageOf(refused));
    } finally {
      setSaving(false);
    }
  }

  if (view === undefined) {
    return (
      <form className="grid gap-4" onSubmit={(event) => { event.preventDefault(); void start(); }}>
        {fixedMachine ? <Note>{t('mach.signIn.fixedNote', { machine: fixedMachine.id, executor })}</Note> : machines.length ? (
          <fieldset className="grid gap-1">
            <legend className="mb-1 text-sm font-medium">{t('mach.signIn.whichMachine')}</legend>
            {machines.map((each) => (
              <Choice key={each.id}>
                <Radio name={`${id}-machine`} checked={machineId === each.id} disabled={starting} onChange={() => setMachineId(each.id)} />
                <Mono>{each.id}</Mono>
                {each.logins?.some((login) => login.executor === executor && (login.signed_in ?? login.configured)) ? <span className="text-xs text-muted-foreground">{t('mach.signIn.alreadySignedIn')}</span> : null}
              </Choice>
            ))}
          </fieldset>
        ) : (
          <Callout tone="waiting">{renderWithMono(t('mach.signIn.noOnlineMachine', { executor: '\u0000' }), executor)}</Callout>
        )}
        <Note className="text-xs">{t('mach.signIn.staysOnMachine', { executor })}</Note>
        {fixedMachine && machines.length === 0 ? <Callout tone="waiting">{t('mach.signIn.fixedUnavailable', { executor })}</Callout> : null}
        {error ? <Problem role="alert">{error}</Problem> : null}
        <DialogActions>
          <Button variant="ghost" disabled={starting} onClick={onBack}>{fixedMachine ? t('common.cancel') : t('mach.signIn.prevStep')}</Button>
          <Button type="submit" variant="primary" disabled={starting || machineId === null || machines.length === 0}>{starting ? t('mach.signIn.starting') : t('mach.signIn.start')}</Button>
        </DialogActions>
      </form>
    );
  }

  return (
    <div className="grid gap-4">
      <p role="status" className={view.state === 'failed' ? 'text-failed-foreground' : undefined}>
        {view.state === 'failed' && view.reason
          ? t('mach.signIn.statusFailed', { machine: machine?.id ?? view.machine, executor, state: SIGN_IN_STATE_TEXT[view.state], reason: view.reason })
          : t('mach.signIn.statusLine', { machine: machine?.id ?? view.machine, executor, state: SIGN_IN_STATE_TEXT[view.state] })}
      </p>
      {view.state === 'starting' ? <Note>{t('mach.signIn.waitingUrl')}</Note> : null}
      {view.state === 'waiting' && view.url && view.code ? (
        <Callout tone="plain" className="grid gap-3">
          <p>{t('mach.signIn.deviceInstructions')}</p>
          <div className="flex flex-wrap items-center gap-2">
            <Button asChild variant="primary">
              <a href={view.url} target="_blank" rel="noopener noreferrer">{t('mach.signIn.openVerifyPage')}</a>
            </Button>
            <CopyButton value={view.url} label={t('mach.signIn.copyUrl')} />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-lg tracking-widest">{view.code}</span>
            <CopyButton value={view.code} label={t('mach.signIn.copyUserCode')} />
          </div>
          <Note className="text-xs">{t('mach.signIn.deviceSafetyNote')}</Note>
        </Callout>
      ) : null}
      {view.state === 'waiting' && view.url && view.accepts_code ? (
        <form className="grid gap-3" onSubmit={(event) => { event.preventDefault(); void submitCode(); }}>
          <Callout tone="plain" className="grid gap-3">
            <p>{t('mach.signIn.oauthInstructions')}</p>
            <div className="flex flex-wrap items-center gap-2">
              <Button asChild variant="primary">
                <a href={view.url} target="_blank" rel="noopener noreferrer">{t('mach.signIn.openAuthPage')}</a>
              </Button>
              <CopyButton value={view.url} label={t('mach.signIn.copyUrl')} />
            </div>
            <Field htmlFor={`${id}-code`} label={t('mach.signIn.authCodeLabel')} hint={t('mach.signIn.authCodeHint')}>
              <Input
                id={`${id}-code`}
                autoComplete="off"
                spellCheck={false}
                className="font-mono text-xs"
                value={codeInput}
                disabled={submittingCode}
                onChange={(event) => setCodeInput(event.target.value)}
              />
            </Field>
          </Callout>
          <DialogActions>
            <Button variant="ghost" disabled={submittingCode} onClick={() => void cancel()}>{t('mach.signIn.cancelAttempt')}</Button>
            <Button type="submit" variant="primary" disabled={submittingCode || codeInput.trim() === ''}>{submittingCode ? t('mach.signIn.submittingCode') : t('mach.signIn.submitCode')}</Button>
          </DialogActions>
        </form>
      ) : null}
      {view.state === 'exchanging' ? <Note role="status">{t('mach.signIn.exchanging')}</Note> : null}
      {signInLive(view.state) && !(view.state === 'waiting' && view.accepts_code) ? (
        <DialogActions><Button variant="ghost" onClick={() => void cancel()}>{t('mach.signIn.cancelAttempt')}</Button></DialogActions>
      ) : null}
      {view.state === 'failed' || view.state === 'cancelled' ? (
        <DialogActions>
          {!fixedMachine ? <Button variant="ghost" onClick={() => { setSignIn(null); setError(null); }}>{t('mach.signIn.switchMachine')}</Button> : null}
          <Button variant="primary" disabled={starting} onClick={() => void start()}>{t('mach.signIn.tryAgain')}</Button>
        </DialogActions>
      ) : null}
      {view.state === 'done' ? (
        <>
          <Callout tone="plain">
            <p className="font-semibold">{t('mach.signIn.doneTitle')}</p>
            <Note className="mt-1 text-xs">{t('mach.signIn.doneNote')}</Note>
          </Callout>
          {!fresh && !gaveUp ? <Note role="status">{t('mach.signIn.waitingModels')}</Note> : null}
          {!fresh && gaveUp ? <Note className="text-xs text-waiting-foreground">{t('mach.signIn.staleModels')}</Note> : null}
          {fresh || gaveUp ? <LoginEditor
            onMachine
            own={own}
            form={form}
            saving={saving}
            busy={busy || saving}
            page={page}
            problem={tierProblem}
            cancelLabel={t('mach.signIn.fillLater')}
            onEdit={(field, value) => {
              setForm((current) => ({ ...current, [field]: value }));
              if (field === 'tiers') setTierProblem(null);
            }}
            onSave={() => void save()}
            onCancel={onDone}
          /> : null}
        </>
      ) : null}
      {error ? <Problem role="alert">{error}</Problem> : null}
    </div>
  );
}
