// Signing in to a Claude account on Claude's own page (docs/design/native-login.md §二 "Claude"
// and "等待、失败、取消"): getting ready, then a button to the authorization page and a box for
// the code it gives, then "已登录" — and for a new account the tiers, after which the account
// is made. A code that is not accepted ends the attempt, and "重新授权" starts a new one with a
// new address. Leaving the steps cancels. What failed is said in one of a few fixed reasons;
// the CLI's own output never reaches the page.
//
// The steps are one of the ways the "添加账号" window obtains a login (add-account.tsx), and the
// whole of the window that signs an existing account in again.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useRef, useState, type RefObject } from 'react';
import { FAIL_TEXT, LOGIN_STATE_TEXT, UNCONFIRMED_TEXT, duplicateAccountText, loginLive, type LoginView } from '@shared/claude-login.ts';
import { Callout, CopyButton, Details, Field, Note, PRE, Problem } from '@/components/bits';
import { LoginEditor } from '@/components/login-form';
import { Button } from '@/components/ui/button';
import { Dialog, DialogActions, DialogContent } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { accountBody, newAccountForm, tierEditorOf, tierRefusal, type AccountForm, type TierProblem } from '@/lib/accounts';
import { api, messageOf, post } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { accountsQuery, PAGE } from '@/lib/queries';
import { isTychoDesktop, openExternalUrl } from '@/lib/utils';
import type { AccountLoginOffer } from '@shared/logins.ts';
import type { AccountsAndMachines } from '@/lib/types';

// What the steps are for: a new account, which the service names after who the login says
// it is, or a new login on one that exists.
export type LoginTarget = { mode: 'new' } | { mode: 'relogin'; account: string; name: string };

const LOGINS = '/api/claude-logins';
// How often a login in progress is asked about: the owner is watching it.
const LOGIN_POLL_MS = 1_000;
const EXECUTOR = 'claude';

// Whether an executor's account is signed in to on the executor's own page, as the executor
// declares it, and whether this host can do that now. Undefined for an executor that offers
// no such way.
export const pageLoginOf = (page: Pick<AccountsAndMachines, 'account_logins'>, executor: string): AccountLoginOffer | undefined =>
  page.account_logins?.[executor]?.find(({ way }) => way === 'page');

// Still holding something the service would have to let go of when the window closes.
const holding = (login: LoginView | undefined): boolean => login !== undefined && (loginLive(login.state) || (login.state === 'signed_in' && !login.saved));
const moving = (login: LoginView | undefined): boolean => holding(login) || (login !== undefined && !login.ended);

export function cancelHeld(login: LoginView | undefined): void {
  if (login && holding(login)) void post(`${LOGINS}/${encodeURIComponent(login.id)}/cancel`).catch(() => undefined);
}

// Where the login stands, while there is nothing for the owner to do but wait.
function Waiting({ children }: { children: string }) {
  return <p role="status" className="text-muted-foreground">{children}</p>;
}

export function ClaudeLoginSteps({ target, page, seen, onDone, onBack }: {
  target: LoginTarget;
  page: AccountsAndMachines;
  // The login as last read, for the window to cancel when it closes.
  seen: RefObject<LoginView | undefined>;
  onDone: () => void;
  // Back to where the way was picked, when a login could not even be started.
  onBack?: (() => void) | undefined;
}) {
  const { t } = useI18n();
  const prefix = useId();
  const client = useQueryClient();
  const active = useRef(false);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      cancelHeld(seen.current);
      seen.current = undefined;
      void client.invalidateQueries({ queryKey: accountsQuery.queryKey });
    };
  }, [client, seen]);
  const [id, setId] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<AccountForm | null>(null);
  const [tierProblem, setTierProblem] = useState<TierProblem | null>(null);
  const { data } = useQuery({
    queryKey: [PAGE, 'claude-login', id],
    queryFn: () => api<{ login: LoginView }>(`${LOGINS}/${encodeURIComponent(id!)}`),
    enabled: id !== null,
    refetchInterval: (query) => (moving(query.state.data?.login) ? LOGIN_POLL_MS : false),
  });
  const login = id === null ? undefined : data?.login;
  useEffect(() => { seen.current = login; }, [login, seen]);
  const autoOpenedUrl = useRef<string | null>(null);
  useEffect(() => {
    if ((login?.state !== 'preparing' && login?.state !== 'waiting_code') || !login.url || !isTychoDesktop()) return;
    if (autoOpenedUrl.current === login.url) return;
    autoOpenedUrl.current = login.url;
    openExternalUrl(login.url);
  }, [login?.state, login?.url]);
  // A new account's tiers are asked for as soon as there is something to pick them from:
  // the login is in, it is nobody's duplicate, and its models have been read or given up on.
  const ready = login?.state === 'signed_in' && login.mode === 'new' && !login.saved && login.duplicate === null && !login.models.refreshing;
  useEffect(() => {
    if (ready) setForm((current) => current ?? newAccountForm(EXECUTOR));
  }, [ready]);
  // Nothing is left to ask first: the login starts as the steps open, once.
  const begun = useRef(false);
  useEffect(() => {
    if (begun.current) return;
    begun.current = true;
    void start();
  }, []);

  async function start(): Promise<void> {
    setBusy(true);
    setError(null);
    setCode('');
    setForm(null);
    try {
      const answer = await post<{ login: LoginView }>(LOGINS, target.mode === 'relogin' ? { account: target.account, mode: target.mode } : { mode: target.mode });
      // The request belongs to this mounted attempt. A late answer still names a live
      // service session, even when the window (or the whole page) has gone away.
      if (!active.current) {
        cancelHeld(answer.login);
        return;
      }
      seen.current = answer.login;
      client.setQueryData([PAGE, 'claude-login', answer.login.id], answer);
      setId(answer.login.id);
    } catch (refused) {
      setError(messageOf(refused));
    } finally {
      setBusy(false);
    }
  }

  async function submit(): Promise<void> {
    if (!login) return;
    const value = code;
    // Forgotten before the answer, refused or not: the code is one use only.
    setCode('');
    setBusy(true);
    setError(null);
    try {
      const answer = await post<{ login: LoginView }>(`${LOGINS}/${encodeURIComponent(login.id)}/code`, { code: value });
      client.setQueryData([PAGE, 'claude-login', login.id], answer);
    } catch (refused) {
      setError(messageOf(refused));
    } finally {
      setBusy(false);
    }
  }

  async function save(): Promise<void> {
    if (!login || !form) return;
    if (login.models.refreshing || login.duplicate !== null) return;
    const problem = tierRefusal(form.tiers, tierEditorOf(page.tier_forms, EXECUTOR));
    if (problem) {
      setTierProblem(problem.at === null ? null : problem);
      setError(problem.at === null ? problem.message : null);
      return;
    }
    // The name, the executor and the token are the login's: only the tiers and the limits go.
    const { executor: _executor, name: _name, ...body } = accountBody(form, page.permission_modes[EXECUTOR] ?? []);
    setBusy(true);
    setError(null);
    try {
      const answer = await post<{ login: LoginView }>(`${LOGINS}/${encodeURIComponent(login.id)}/save`, body);
      client.setQueryData([PAGE, 'claude-login', login.id], { login: answer.login });
      // Before the window closes: it must not cancel a login that has just been saved.
      seen.current = answer.login;
      await client.invalidateQueries({ queryKey: accountsQuery.queryKey });
      onDone();
    } catch (refused) {
      setError(messageOf(refused));
    } finally {
      setBusy(false);
    }
  }

  if (login === undefined) {
    return (
      <div className="grid gap-4">
        {error ? <Problem role="alert">{error}</Problem> : <Waiting>{`${LOGIN_STATE_TEXT.preparing}…`}</Waiting>}
        {error ? (
          <DialogActions>
            {onBack ? <Button variant="ghost" disabled={busy} onClick={onBack}>{t('acct.action.prevStep')}</Button> : null}
            <Button variant="primary" disabled={busy} onClick={() => void start()}>{t('acct.oauth.reauthorize')}</Button>
          </DialogActions>
        ) : null}
      </div>
    );
  }

  const again = (
    <Button variant="primary" disabled={busy} onClick={() => void start()}>{t('acct.oauth.reauthorize')}</Button>
  );
  // Opens in a tab of its own: the window stays where the code is to be pasted.
  const authorize = login.url ? (
    <Button asChild variant="primary" className="justify-self-start">
      <a href={login.url} target="_blank" rel="noopener noreferrer">{t('acct.claude.goAuthorize')}</a>
    </Button>
  ) : null;
  return (
    <div className="grid gap-4">
      {login.state === 'preparing' ? <Waiting>{login.url ? t('acct.claude.waitingCliReady') : t('acct.claude.waitingUrl', { preparing: LOGIN_STATE_TEXT.preparing })}</Waiting> : null}
      {(login.state === 'preparing' || login.state === 'waiting_code') && login.url ? (
        <Callout tone="plain" className="flex items-start gap-2 text-xs">
          <p className="min-w-0 flex-1 text-muted-foreground">{t('acct.claude.incognitoHint')}</p>
          <CopyButton value={login.url} label={t('acct.oauth.copyUrl')} />
        </Callout>
      ) : null}
      {login.state === 'preparing' ? authorize : null}
      {login.state === 'waiting_code' && login.url ? (
        <form className="grid gap-4" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
          <p>{t('acct.claude.pasteCodePrompt')}</p>
          {authorize}
          <Field htmlFor={`${prefix}-code`} label={t('acct.claude.codeLabel')} hint={t('acct.claude.codeHint')}>
            <Input id={`${prefix}-code`} autoComplete="off" spellCheck={false} className="font-mono text-xs" value={code} disabled={busy} onChange={(event) => setCode(event.target.value)} />
          </Field>
          <DialogActions>
            <Button type="submit" variant="primary" disabled={busy || code.trim() === ''}>{t('acct.claude.submitCode')}</Button>
          </DialogActions>
        </form>
      ) : null}
      {login.state === 'exchanging' ? <Waiting>{`${LOGIN_STATE_TEXT.exchanging}…`}</Waiting> : null}
      {login.state === 'signed_in' && login.mode === 'new' ? (
        <div className="grid gap-1">
          {login.models.refreshing ? <Note>{t('acct.claude.loadingModels')}</Note>
            : login.identity.organizationId ? <Note>{t('acct.claude.orgId', { id: login.identity.organizationId })}</Note>
              : <Note>{t('acct.claude.unknownAccount')}</Note>}
          {login.duplicate !== null ? <Problem>{t('acct.sentencePeriod', { text: duplicateAccountText(login.duplicate) })}</Problem> : null}
        </div>
      ) : null}
      {login.state === 'signed_in' && login.mode === 'relogin' ? (
        <>
          <p role="status">{t('acct.oauth.reloginDone', { signedIn: LOGIN_STATE_TEXT.signed_in })}</p>
          <DialogActions><Button variant="primary" onClick={onDone}>{t('acct.action.done')}</Button></DialogActions>
        </>
      ) : null}
      {login.state === 'signed_in' && login.mode === 'new' && !login.saved ? (
        <>
          <Callout tone="plain">
            <p role="status" className="font-semibold">
              {login.duplicate === null
                ? t('acct.oauth.signedInFillTiers', { signedIn: LOGIN_STATE_TEXT.signed_in })
                : t('acct.sentencePeriod', { text: LOGIN_STATE_TEXT.signed_in })}
            </p>
            {/* The name the service gives it, once it has read who this login is. */}
            {login.duplicate === null && !login.models.refreshing && login.name ? (
              <p className="mt-1">
                {t('acct.oauth.autoNamePrefix')}
                <strong className="font-semibold">{login.name}</strong>
                {t('acct.oauth.autoNameSuffix')}
              </p>
            ) : null}
            <Note className="mt-1 text-xs">{t('acct.oauth.ephemeralTokenNote')}</Note>
          </Callout>
          {login.duplicate !== null ? <DialogActions>{again}</DialogActions> : form ? (
            <LoginEditor
              signedIn
              models={login.models}
              form={form}
              saving={busy}
              busy={busy || login.models.refreshing}
              page={page}
              problem={tierProblem}
              onEdit={(field, value) => {
                setForm((current) => (current ? { ...current, [field]: value } : current));
                if (field === 'tiers') setTierProblem(null);
              }}
              onSave={() => void save()}
              onCancel={onDone}
            />
          ) : null}
        </>
      ) : null}
      {login.state === 'signed_in' && login.mode === 'new' && login.saved ? <p role="status">{t('acct.oauth.accountCreated', { name: login.name })}</p> : null}
      {login.state === 'failed' && login.reason ? (
        <>
          <Problem role="alert">{FAIL_TEXT[login.reason]}</Problem>
          {login.shape ? (
            <Details id={`claude-login-shape:${login.id}`} title={t('acct.claude.screenShapeTitle')}>
              <pre className={PRE}>{login.shape}</pre>
            </Details>
          ) : null}
          <DialogActions>{again}</DialogActions>
        </>
      ) : null}
      {login.state === 'cancelled' ? (
        <>
          <p role="status">{LOGIN_STATE_TEXT.cancelled}</p>
          <DialogActions>{again}</DialogActions>
        </>
      ) : null}
      {login.unconfirmed ? <Note className="text-xs">{UNCONFIRMED_TEXT}</Note> : null}
      {error ? <Problem role="alert">{error}</Problem> : null}
    </div>
  );
}

// Signing an account in again, in a window of its own. Closing it is cancelling: whatever the
// login still holds is let go of. The page reads its accounts again, for a token that was replaced.
export function ReloginWindow({ target, page, onClose }: { target: Extract<LoginTarget, { mode: 'relogin' }> | null; page: AccountsAndMachines; onClose: () => void }) {
  const { t } = useI18n();
  const client = useQueryClient();
  const seen = useRef<LoginView | undefined>(undefined);
  const close = (): void => {
    const login = seen.current;
    seen.current = undefined;
    cancelHeld(login);
    void client.invalidateQueries({ queryKey: accountsQuery.queryKey });
    onClose();
  };
  return (
    <Dialog open={target !== null} onOpenChange={(open) => { if (!open) close(); }}>
      {target ? (
        <DialogContent
          className="max-w-[560px]"
          title={t('acct.oauth.reloginTitle', { name: target.name })}
          description={t('acct.oauth.reloginDesc')}
        >
          <ClaudeLoginSteps target={target} page={page} seen={seen} onDone={close} />
        </DialogContent>
      ) : null}
    </Dialog>
  );
}
