import { fullTime } from '@shared/time.ts';
import { useQuery } from '@tanstack/react-query';
import { MonitorSmartphone, RefreshCw } from 'lucide-react';
import { useRef, useState } from 'react';
import { Callout, Problem } from '@/components/bits';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';
import { Confirm, Sheet, SheetContent, SheetTrigger } from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { api, messageOf, post, session } from '@/lib/api';
import { PAGE, POLL_MS } from '@/lib/queries';

interface ConsoleDevice {
  id: string;
  device: string;
  entry: 'inside' | 'outside';
  method: 'link' | 'device' | 'wecom' | 'weixin' | 'passphrase' | (string & {}) | null;
  created_at: string;
  last_seen_at: string;
  expires_at: string;
  current: boolean;
}

interface Devices {
  sessions: ConsoleDevice[];
  session_days: number;
  temporary_ms: number;
}

const SESSIONS = '/api/console-sessions';
const METHOD_KEYS: Record<string, string> = {
  link: 'core.devices.method.link',
  device: 'core.devices.method.device',
  wecom: 'core.devices.method.wecom',
  weixin: 'core.devices.method.weixin',
  passphrase: 'core.devices.method.passphrase',
};

function DeviceManager() {
  const { t } = useI18n();
  const { data, error, isPending, isFetching, refetch } = useQuery({ queryKey: [PAGE, 'console-sessions'], queryFn: () => api<Devices>(SESSIONS), refetchInterval: POLL_MS });
  const [confirmation, setConfirmation] = useState<ConsoleDevice | 'others' | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const pending = useRef(false);

  async function revoke() {
    if (!confirmation || pending.current) return;
    const target = confirmation;
    pending.current = true;
    setBusy(true);
    setFailure(null);
    setNotice(null);
    setConfirmation(null);
    try {
      if (target !== 'others' && target.current) {
        await post('/api/logout');
        session.toLogin();
      } else {
        await post(target === 'others' ? SESSIONS + '/revoke-others' : SESSIONS + '/' + encodeURIComponent(target.id) + '/revoke');
        setNotice(target === 'others' ? t('core.devices.revokedOthers') : t('core.devices.revokedOne', { device: target.device }));
        await refetch();
      }
    } catch (error) {
      setFailure(messageOf(error));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }

  const others = confirmation === 'others';
  const selected = typeof confirmation === 'object' ? confirmation : null;
  const current = selected?.current ?? false;
  return (
    <div className="grid gap-4">
      <section aria-label={t('core.devices.sectionTitle')} className="grid min-w-0 gap-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="font-semibold">{t('core.devices.sectionTitle')}</h2>
          <Button variant="ghost" size="sm" disabled={isFetching || busy} onClick={() => { void refetch(); }}><RefreshCw />{t('core.devices.refresh')}</Button>
        </div>
        {isPending ? <Skeleton className="h-28" /> : null}
        {error ? <Problem role="alert">{messageOf(error)}</Problem> : null}
        {failure ? <Problem role="alert">{failure}</Problem> : null}
        {notice ? <Callout tone="plain" role="status">{notice}</Callout> : null}
        {data?.sessions.map((device) => {
          const methodKey = device.method ? METHOD_KEYS[device.method] : undefined;
          const methodLabel = methodKey ? t(methodKey) : device.method;
          return (
            <section key={device.id} aria-label={device.device} className="grid min-w-0 gap-2 rounded-lg border border-border p-3.5 wrap-anywhere">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="min-w-0 font-medium">{device.device}</h3>
                {device.current ? <Badge tone="plain">{t('core.devices.thisDevice')}</Badge> : null}
              </div>
              <p className="text-muted-foreground">
                {device.entry === 'outside' ? t('core.admit.entryOutside') : t('core.admit.entryInside')}
                {methodLabel ? ' · ' + methodLabel : ''}
              </p>
              <dl className="grid gap-0.5 text-xs text-muted-foreground tabular-nums">
                <div><dt className="inline">{t('core.devices.signedInAt')}</dt><dd className="inline">{fullTime(device.created_at)}</dd></div>
                <div><dt className="inline">{t('core.devices.lastSeenAt')}</dt><dd className="inline">{fullTime(device.last_seen_at)}</dd></div>
                <div><dt className="inline">{t('core.devices.expiresAt')}</dt><dd className="inline">{fullTime(device.expires_at)}</dd></div>
              </dl>
              <Button size="sm" className="mt-1 justify-self-start" disabled={busy} onClick={() => setConfirmation(device)}>{device.current ? t('core.devices.logout') : t('core.devices.revoke')}</Button>
            </section>
          );
        })}
        {data ? <Button className="justify-self-start" disabled={busy || !data.sessions.some((device) => !device.current)} onClick={() => setConfirmation('others')}>{t('core.devices.revokeOthers')}</Button> : null}
      </section>
      <Confirm
        open={confirmation !== null}
        title={others ? t('core.devices.confirmOthersTitle') : current ? t('core.devices.confirmCurrentTitle') : t('core.devices.confirmOneTitle')}
        description={others ? t('core.devices.confirmOthersDesc') : current ? t('core.devices.confirmCurrentDesc') : t('core.devices.confirmOneDesc', { device: selected?.device ?? '' })}
        confirm={current ? t('core.devices.confirmLogout') : t('core.devices.confirmRevoke')}
        onConfirm={() => { void revoke(); }}
        onCancel={() => setConfirmation(null)}
      />
    </div>
  );
}

export function DeviceLogin() {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild><Button variant="ghost" size="sm" className="gap-1 px-1.5"><MonitorSmartphone />{t('nav.devices')}</Button></SheetTrigger>
      <SheetContent title={t('nav.devices')} description={t('core.devices.sheetDesc')} className="w-[min(440px,100%)]">
        {open ? <DeviceManager /> : null}
      </SheetContent>
    </Sheet>
  );
}
