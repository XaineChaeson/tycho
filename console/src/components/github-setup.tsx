import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, ExternalLink } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { Card, CopyButton, Dot, Note, Problem, Time } from '@/components/bits';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Confirm } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Segmented } from '@/components/ui/segmented';
import { Skeleton } from '@/components/ui/skeleton';
import { api, del, messageOf, post } from '@/lib/api';
import { translate, useI18n } from '@/lib/i18n';
import { PAGE } from '@/lib/queries';

export interface GitHubConnection {
  login: string;
  name: string | null;
  avatar_url: string | null;
  mode: 'pat' | 'device';
  scopes: string[];
  connected_at: string;
  checked_at: string;
}

export interface GitHubStatus {
  connected: boolean;
  connection: GitHubConnection | null;
  client_id: string | null;
}

interface DeviceStartResponse {
  session_id: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

interface DevicePollResponse {
  state: 'pending' | 'connected' | 'expired' | 'denied' | 'error';
  connection?: GitHubConnection;
  error?: string;
}

type AuthTab = 'pat' | 'device';

const GITHUB_QUERY_KEY = [PAGE, 'github'] as const;
const PAT_CREATE_URL = 'https://github.com/settings/personal-access-tokens/new?description=Tycho';

export function GitHubSetup() {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: GITHUB_QUERY_KEY,
    queryFn: () => api<GitHubStatus>('/api/github'),
  });

  const [tab, setTab] = useState<AuthTab>('pat');
  const [token, setToken] = useState('');
  const [patSubmitting, setPatSubmitting] = useState(false);
  const [patError, setPatError] = useState<string | null>(null);

  const [clientIdDraft, setClientIdDraft] = useState<string | null>(null);
  const [startingDevice, setStartingDevice] = useState(false);
  const [deviceSession, setDeviceSession] = useState<DeviceStartResponse | null>(null);
  const [deviceError, setDeviceError] = useState<string | null>(null);

  const [checking, setChecking] = useState(false);
  const [checkValid, setCheckValid] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);

  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [disconnectError, setDisconnectError] = useState<string | null>(null);

  const authOptions: readonly { value: AuthTab; label: string }[] = [
    { value: 'pat', label: t('set.gh.authPat') },
    { value: 'device', label: t('set.gh.authDevice') },
  ];

  // Poll the active Device Flow session sequentially; unmount or cancel aborts and stops the timer.
  useEffect(() => {
    if (!deviceSession) return;
    let active = true;
    let timer: number | undefined;
    let controller: AbortController | null = null;
    const delayMs = Math.max(deviceSession.interval, 5) * 1000;

    const schedule = (): void => {
      if (!active) return;
      timer = window.setTimeout(() => { void pollOnce(); }, delayMs);
    };

    const pollOnce = async (): Promise<void> => {
      if (!active) return;
      const pending = new AbortController();
      controller = pending;
      try {
        const result = await api<DevicePollResponse>('/api/github/device/poll', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ session_id: deviceSession.session_id }),
          signal: pending.signal,
        });
        if (!active) return;
        if (result.state === 'pending') {
          schedule();
          return;
        }
        if (result.state === 'connected') {
          setDeviceSession(null);
          setDeviceError(null);
          if (result.connection) {
            queryClient.setQueryData<GitHubStatus>(GITHUB_QUERY_KEY, (prev) => ({
              connected: true,
              connection: result.connection ?? null,
              client_id: prev?.client_id ?? null,
            }));
          }
          await queryClient.invalidateQueries({ queryKey: GITHUB_QUERY_KEY });
          return;
        }
        setDeviceSession(null);
        if (result.state === 'expired') {
          setDeviceError(result.error ?? translate('set.gh.deviceExpired'));
        } else if (result.state === 'denied') {
          setDeviceError(result.error ?? translate('set.gh.deviceDenied'));
        } else {
          setDeviceError(result.error ?? translate('set.gh.authFailed'));
        }
      } catch (err) {
        if (!active || pending.signal.aborted) return;
        setDeviceSession(null);
        setDeviceError(messageOf(err));
      } finally {
        if (controller === pending) controller = null;
      }
    };

    schedule();
    return () => {
      active = false;
      window.clearTimeout(timer);
      controller?.abort();
    };
  }, [deviceSession, queryClient]);

  if (query.isPending) {
    return (
      <div className="mt-4">
        <Skeleton className="h-36 w-full rounded-xl" />
      </div>
    );
  }

  if (query.error && !query.data) {
    return (
      <Card className="mt-4 grid justify-items-start gap-3">
        <Problem role="alert">{messageOf(query.error)}</Problem>
        <Button size="sm" disabled={query.isFetching} onClick={() => void query.refetch()}>
          {t('set.retryRead')}
        </Button>
      </Card>
    );
  }

  const data = query.data;
  const connection = data?.connected ? data.connection : null;
  const clientId = clientIdDraft ?? data?.client_id ?? '';

  function switchTab(next: AuthTab): void {
    setTab(next);
    setPatError(null);
    setDeviceError(null);
    if (next !== 'device') setDeviceSession(null);
  }

  async function submitPat(event: FormEvent): Promise<void> {
    event.preventDefault();
    const trimmed = token.trim();
    if (!trimmed || patSubmitting) return;
    setPatSubmitting(true);
    setPatError(null);
    try {
      const result = await post<{ connection: GitHubConnection }>('/api/github/pat', { token: trimmed });
      setToken('');
      setCheckValid(false);
      setCheckError(null);
      queryClient.setQueryData<GitHubStatus>(GITHUB_QUERY_KEY, (prev) => ({
        connected: true,
        connection: result.connection,
        client_id: prev?.client_id ?? null,
      }));
      await queryClient.invalidateQueries({ queryKey: GITHUB_QUERY_KEY });
    } catch (err) {
      setPatError(messageOf(err));
    } finally {
      setPatSubmitting(false);
    }
  }

  async function startDeviceFlow(event: FormEvent): Promise<void> {
    event.preventDefault();
    const trimmed = clientId.trim();
    if (!trimmed || startingDevice) return;
    setStartingDevice(true);
    setDeviceError(null);
    try {
      const started = await post<DeviceStartResponse>('/api/github/device/start', { client_id: trimmed });
      setDeviceSession(started);
    } catch (err) {
      setDeviceError(messageOf(err));
    } finally {
      setStartingDevice(false);
    }
  }

  function cancelDeviceFlow(): void {
    setDeviceSession(null);
    setDeviceError(null);
  }

  async function checkConnection(): Promise<void> {
    if (checking || disconnecting) return;
    setChecking(true);
    setCheckValid(false);
    setCheckError(null);
    try {
      const result = await post<{ connection: GitHubConnection }>('/api/github/check', {});
      queryClient.setQueryData<GitHubStatus>(GITHUB_QUERY_KEY, (prev) => ({
        connected: true,
        connection: result.connection,
        client_id: prev?.client_id ?? null,
      }));
      setCheckValid(true);
    } catch (err) {
      setCheckError(messageOf(err));
    } finally {
      setChecking(false);
    }
  }

  async function disconnect(): Promise<void> {
    if (disconnecting) return;
    setDisconnecting(true);
    setDisconnectError(null);
    try {
      await del<{ disconnected: true }>('/api/github');
      setConfirmDisconnect(false);
      setCheckValid(false);
      setCheckError(null);
      queryClient.setQueryData<GitHubStatus>(GITHUB_QUERY_KEY, (prev) => ({
        connected: false,
        connection: null,
        client_id: prev?.client_id ?? null,
      }));
      await queryClient.invalidateQueries({ queryKey: GITHUB_QUERY_KEY });
    } catch (err) {
      setDisconnectError(messageOf(err));
    } finally {
      setDisconnecting(false);
    }
  }

  if (connection) {
    return (
      <>
        <Card className="mt-4 grid gap-4" aria-label={t('set.gh.statusAria')}>
          <div className="flex flex-wrap items-center gap-2.5">
            <Dot tone="success" />
            <span
              aria-hidden="true"
              className="flex size-7 flex-none items-center justify-center rounded-full border border-border bg-muted text-xs font-semibold text-foreground uppercase select-none"
            >
              {(connection.login.trim().charAt(0) || '?').toUpperCase()}
            </span>
            <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
              <strong className="text-sm font-semibold text-foreground">@{connection.login}</strong>
              {connection.name ? <span className="text-sm text-muted-foreground">{connection.name}</span> : null}
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              <Badge tone="success">{t('set.connected')}</Badge>
              <Badge tone="plain">{connection.mode === 'pat' ? 'PAT' : 'Device Flow'}</Badge>
            </div>
          </div>

          {connection.scopes.length > 0 ? (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-xs text-muted-foreground">{t('set.gh.scopes')}</span>
              {connection.scopes.map((scope) => (
                <Badge key={scope} tone="plain" className="font-mono text-2xs">
                  {scope}
                </Badge>
              ))}
            </div>
          ) : null}

          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span>{t('set.gh.connectedAt')} <Time at={connection.connected_at} /></span>
            <span aria-hidden="true">·</span>
            <span>{t('set.gh.checkedAt')} <Time at={connection.checked_at} /></span>
          </div>

          <Note className="text-xs">{t('set.gh.capabilityNote')}</Note>

          <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
            <Button disabled={checking || disconnecting} onClick={() => void checkConnection()}>
              {checking ? t('set.gh.testing') : t('set.gh.testConnection')}
            </Button>
            <Button
              variant="danger"
              disabled={checking || disconnecting}
              onClick={() => {
                setDisconnectError(null);
                setConfirmDisconnect(true);
              }}
            >
              {t('set.disconnect')}
            </Button>
            {checkValid ? (
              <span role="status" className="inline-flex items-center gap-1 text-xs font-medium text-success-foreground">
                <Check className="size-3.5" aria-hidden="true" />
                {t('set.gh.connectionValid')}
              </span>
            ) : null}
          </div>

          {checkError ? <Problem role="alert">{checkError}</Problem> : null}
        </Card>

        <Confirm
          open={confirmDisconnect}
          title={t('set.gh.disconnectTitle')}
          description={t('set.gh.disconnectDesc')}
          confirm={disconnecting ? t('set.gh.disconnecting') : t('set.gh.confirmDisconnect')}
          danger
          busy={disconnecting}
          error={disconnectError}
          onConfirm={() => void disconnect()}
          onCancel={() => setConfirmDisconnect(false)}
        />
      </>
    );
  }

  return (
    <>
      <Note className="mt-1 mb-4">{t('set.gh.capabilityNote')}</Note>
      <Card className="grid gap-4" aria-label={t('set.gh.connectAria')}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Segmented label={t('set.gh.authMethodLabel')} value={tab} options={authOptions} onChange={switchTab} />
        </div>

        {tab === 'pat' ? (
          <div className="grid gap-3">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
              <span>{t('set.gh.patHint')}</span>
              <a
                href={PAT_CREATE_URL}
                target="_blank"
                rel="noreferrer noopener"
                className="inline-flex items-center gap-1 font-medium text-link hover:underline"
              >
                {t('set.gh.patCreateLink')}
                <ExternalLink className="size-3.5" aria-hidden="true" />
              </a>
            </div>
            <form onSubmit={(event) => void submitPat(event)} className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <Input
                type="password"
                autoComplete="off"
                aria-label="GitHub Token"
                placeholder={t('set.gh.patPlaceholder')}
                className="flex-1 font-mono text-xs"
                value={token}
                disabled={patSubmitting}
                onChange={(event) => {
                  setToken(event.target.value);
                  if (patError) setPatError(null);
                }}
              />
              <Button type="submit" variant="primary" disabled={patSubmitting || !token.trim()}>
                {patSubmitting ? t('set.gh.verifying') : t('set.gh.verifyAndConnect')}
              </Button>
            </form>
            {patError ? <Problem role="alert">{patError}</Problem> : null}
          </div>
        ) : (
          <div className="grid gap-3">
            {deviceSession ? (
              <div className="grid gap-3">
                <Note className="text-xs">{t('set.gh.deviceCopyHint')}</Note>
                <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-code px-4 py-3">
                  <code className="font-mono text-2xl font-semibold tracking-[0.14em] text-foreground select-all">
                    {deviceSession.user_code}
                  </code>
                  <CopyButton value={deviceSession.user_code} label={t('set.gh.copyDeviceCode')} />
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Button variant="primary" asChild>
                    <a href={deviceSession.verification_uri} target="_blank" rel="noreferrer noopener">
                      {t('set.gh.openAuthPage')}
                      <ExternalLink className="size-3.5" aria-hidden="true" />
                    </a>
                  </Button>
                  <Button variant="ghost" onClick={cancelDeviceFlow}>
                    {t('common.cancel')}
                  </Button>
                </div>
                <div role="status" className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Dot tone="running" />
                  <span>{t('set.gh.waitingBrowserAuth')}</span>
                </div>
              </div>
            ) : (
              <>
                <Note className="text-xs">{t('set.gh.deviceClientIdHint')}</Note>
                <form onSubmit={(event) => void startDeviceFlow(event)} className="flex flex-col gap-2 sm:flex-row sm:items-center">
                  <Input
                    aria-label="GitHub OAuth Client ID"
                    placeholder={t('set.gh.deviceClientIdPlaceholder')}
                    className="flex-1 font-mono text-xs"
                    value={clientId}
                    disabled={startingDevice}
                    onChange={(event) => {
                      setClientIdDraft(event.target.value);
                      if (deviceError) setDeviceError(null);
                    }}
                  />
                  <Button type="submit" variant="primary" disabled={startingDevice || !clientId.trim()}>
                    {startingDevice ? t('set.gh.requestingCode') : t('set.gh.getDeviceCode')}
                  </Button>
                </form>
              </>
            )}
            {deviceError ? <Problem role="alert">{deviceError}</Problem> : null}
          </div>
        )}
      </Card>
    </>
  );
}
