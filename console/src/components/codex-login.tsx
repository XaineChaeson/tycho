import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type RefObject } from 'react';
import {
  CODEX_LOGIN_FAIL_TEXT,
  CODEX_LOGIN_STATE_TEXT,
  CODEX_UNCONFIRMED_TEXT,
  codexLoginLive,
  duplicateCodexAccountText,
  type CodexLoginView,
} from '@shared/codex-login.ts';
import { Callout, CopyButton, Note, Problem } from '@/components/bits';
import type { LoginTarget } from '@/components/claude-login';
import { LoginEditor } from '@/components/login-form';
import { Button } from '@/components/ui/button';
import { Dialog, DialogActions, DialogContent } from '@/components/ui/dialog';
import { accountBody, newAccountForm, tierEditorOf, tierRefusal, type AccountForm, type TierProblem } from '@/lib/accounts';
import { api, messageOf, post } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { accountsQuery, PAGE } from '@/lib/queries';
import { isTychoDesktop, openExternalUrl } from '@/lib/utils';
import type { AccountsAndMachines } from '@/lib/types';

const LOGINS = '/api/codex-logins';
const LOGIN_POLL_MS = 1_000;
const EXECUTOR = 'codex';

const holding = (login: CodexLoginView | undefined): boolean =>
  login !== undefined && (codexLoginLive(login.state) || (login.state === 'signed_in' && !login.saved));
const moving = (login: CodexLoginView | undefined): boolean =>
  holding(login) || (login !== undefined && !login.ended);

export function cancelCodexHeld(login: CodexLoginView | undefined): void {
  if (login && holding(login)) void post(`${LOGINS}/${encodeURIComponent(login.id)}/cancel`).catch(() => undefined);
}

function Waiting({ children }: { children: string }) {
  return <p role="status" className="text-muted-foreground">{children}</p>;
}

export function CodexLoginSteps({ target, page, seen, onDone, onBack }: {
  target: LoginTarget;
  page: AccountsAndMachines;
  seen: RefObject<CodexLoginView | undefined>;
  onDone: () => void;
  onBack?: (() => void) | undefined;
}) {
  const { t } = useI18n();
  const client = useQueryClient();
  const active = useRef(false);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      cancelCodexHeld(seen.current);
      seen.current = undefined;
      void client.invalidateQueries({ queryKey: accountsQuery.queryKey });
    };
  }, [client, seen]);

  const [id, setId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<AccountForm | null>(null);
  const [tierProblem, setTierProblem] = useState<TierProblem | null>(null);

  const { data } = useQuery({
    queryKey: [PAGE, 'codex-login', id],
    queryFn: () => api<{ login: CodexLoginView }>(`${LOGINS}/${encodeURIComponent(id!)}`),
    enabled: id !== null,
    refetchInterval: (query) => (moving(query.state.data?.login) ? LOGIN_POLL_MS : false),
  });
  const login = id === null ? undefined : data?.login;
  useEffect(() => { seen.current = login; }, [login, seen]);
  const autoOpenedUrl = useRef<string | null>(null);
  useEffect(() => {
    if (login?.state !== 'waiting' || !login.url || !isTychoDesktop()) return;
    if (autoOpenedUrl.current === login.url) return;
    autoOpenedUrl.current = login.url;
    openExternalUrl(login.url);
  }, [login?.state, login?.url]);

  const ready = login?.state === 'signed_in' && login.mode === 'new' && !login.saved && login.duplicate === null && !login.models.refreshing;
  useEffect(() => {
    if (ready) setForm((current) => current ?? newAccountForm(EXECUTOR));
  }, [ready]);

  const begun = useRef(false);
  useEffect(() => {
    if (begun.current) return;
    begun.current = true;
    void start();
  }, []);

  async function start(): Promise<void> {
    setBusy(true);
    setError(null);
    setForm(null);
    try {
      const answer = await post<{ login: CodexLoginView }>(
        LOGINS,
        target.mode === 'relogin' ? { account: target.account, mode: target.mode } : { mode: target.mode },
      );
      if (!active.current) {
        cancelCodexHeld(answer.login);
        return;
      }
      seen.current = answer.login;
      client.setQueryData([PAGE, 'codex-login', answer.login.id], answer);
      setId(answer.login.id);
    } catch (refused) {
      setError(messageOf(refused));
    } finally {
      setBusy(false);
    }
  }

  async function cancel(): Promise<void> {
    if (!login) return;
    setBusy(true);
    try {
      const answer = await post<{ login: CodexLoginView }>(`${LOGINS}/${encodeURIComponent(login.id)}/cancel`);
      client.setQueryData([PAGE, 'codex-login', login.id], answer);
      seen.current = answer.login;
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
    const { executor: _executor, name: _name, ...body } = accountBody(form, page.permission_modes[EXECUTOR] ?? []);
    setBusy(true);
    setError(null);
    try {
      const answer = await post<{ login: CodexLoginView }>(`${LOGINS}/${encodeURIComponent(login.id)}/save`, body);
      client.setQueryData([PAGE, 'codex-login', login.id], { login: answer.login });
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
        {error ? <Problem role="alert">{error}</Problem> : <Waiting>{`${CODEX_LOGIN_STATE_TEXT.starting}…`}</Waiting>}
        {error ? (
          <DialogActions>
            {onBack ? <Button variant="ghost" disabled={busy} onClick={onBack}>{t('acct.action.prevStep')}</Button> : null}
            <Button variant="primary" disabled={busy} onClick={() => void start()}>{t('acct.oauth.reauthorize')}</Button>
          </DialogActions>
        ) : null}
      </div>
    );
  }

  const again = <Button variant="primary" disabled={busy} onClick={() => void start()}>{t('acct.oauth.reauthorize')}</Button>;

  return (
    <div className="grid gap-4">
      {login.state === 'starting' ? <Waiting>{t('acct.codex.waitingDeviceCode', { starting: CODEX_LOGIN_STATE_TEXT.starting })}</Waiting> : null}
      {login.state === 'waiting' && login.url && login.code ? (
        <Callout tone="plain" className="grid gap-3">
          <p>{t('acct.codex.devicePrompt')}</p>
          <div className="flex flex-wrap items-center gap-2">
            <Button asChild variant="primary">
              <a href={login.url} target="_blank" rel="noopener noreferrer">{t('acct.codex.openVerifyPage')}</a>
            </Button>
            <CopyButton value={login.url} label={t('acct.oauth.copyUrl')} />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-lg tracking-widest">{login.code}</span>
            <CopyButton value={login.code} label={t('acct.codex.copyUserCode')} />
          </div>
          <Note className="text-xs">{t('acct.codex.autoRenewNote')}</Note>
        </Callout>
      ) : null}
      {codexLoginLive(login.state) ? (
        <DialogActions>
          {onBack ? <Button variant="ghost" disabled={busy} onClick={() => { void cancel(); onBack(); }}>{t('acct.action.prevStep')}</Button> : null}
          <Button variant="ghost" disabled={busy} onClick={() => void cancel()}>{t('acct.codex.cancelLogin')}</Button>
        </DialogActions>
      ) : null}
      {login.state === 'signed_in' && login.mode === 'new' ? (
        <div className="grid gap-1">
          {login.models.refreshing ? <Note>{t('acct.codex.loadingModels')}</Note>
            : login.identity.accountLabel ? <Note>{t('acct.codex.accountIdentity', { label: login.identity.accountLabel })}</Note>
              : <Note>{t('acct.codex.chatgptAuthorized')}</Note>}
          {login.duplicate !== null ? <Problem>{t('acct.sentencePeriod', { text: duplicateCodexAccountText(login.duplicate) })}</Problem> : null}
        </div>
      ) : null}
      {login.state === 'signed_in' && login.mode === 'relogin' ? (
        <>
          <p role="status">{t('acct.oauth.reloginDone', { signedIn: CODEX_LOGIN_STATE_TEXT.signed_in })}</p>
          <DialogActions><Button variant="primary" onClick={onDone}>{t('acct.action.done')}</Button></DialogActions>
        </>
      ) : null}
      {login.state === 'signed_in' && login.mode === 'new' && !login.saved ? (
        <>
          <Callout tone="plain">
            <p role="status" className="font-semibold">
              {login.duplicate === null
                ? t('acct.oauth.signedInFillTiers', { signedIn: CODEX_LOGIN_STATE_TEXT.signed_in })
                : t('acct.sentencePeriod', { text: CODEX_LOGIN_STATE_TEXT.signed_in })}
            </p>
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
          <Problem role="alert">{CODEX_LOGIN_FAIL_TEXT[login.reason]}</Problem>
          <DialogActions>{again}</DialogActions>
        </>
      ) : null}
      {login.state === 'cancelled' ? (
        <>
          <p role="status">{CODEX_LOGIN_STATE_TEXT.cancelled}</p>
          <DialogActions>{again}</DialogActions>
        </>
      ) : null}
      {login.unconfirmed ? <Note className="text-xs">{CODEX_UNCONFIRMED_TEXT}</Note> : null}
      {error ? <Problem role="alert">{error}</Problem> : null}
    </div>
  );
}

export function CodexReloginWindow({ target, page, onClose }: {
  target: Extract<LoginTarget, { mode: 'relogin' }> | null;
  page: AccountsAndMachines;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const client = useQueryClient();
  const seen = useRef<CodexLoginView | undefined>(undefined);
  const close = (): void => {
    const login = seen.current;
    seen.current = undefined;
    cancelCodexHeld(login);
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
          <CodexLoginSteps target={target} page={page} seen={seen} onDone={close} />
        </DialogContent>
      ) : null}
    </Dialog>
  );
}
