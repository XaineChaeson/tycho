import { fullTime } from '@shared/time.ts';
import { useQuery } from '@tanstack/react-query';
import { MonitorSmartphone, RefreshCw } from 'lucide-react';
import { useRef, useState } from 'react';
import { Callout, Problem } from '@/components/bits';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
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
const METHODS: Record<string, string> = {
  link: '一次性链接',
  device: '被另一台设备放行',
  wecom: '在企业微信里放行',
  weixin: '在微信里放行',
  passphrase: '口令登录',
};

function DeviceManager() {
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
        setNotice(target === 'others' ? '其他设备已全部退出' : '已让这台设备退出：' + target.device);
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
      <section aria-label="已登录的设备" className="grid min-w-0 gap-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="font-semibold">已登录的设备</h2>
          <Button variant="ghost" size="sm" disabled={isFetching || busy} onClick={() => { void refetch(); }}><RefreshCw />刷新设备</Button>
        </div>
        {isPending ? <Skeleton className="h-28" /> : null}
        {error ? <Problem role="alert">{messageOf(error)}</Problem> : null}
        {failure ? <Problem role="alert">{failure}</Problem> : null}
        {notice ? <Callout tone="plain" role="status">{notice}</Callout> : null}
        {data?.sessions.map((device) => (
          <section key={device.id} aria-label={device.device} className="grid min-w-0 gap-2 rounded-lg border border-border p-3.5 wrap-anywhere">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="min-w-0 font-medium">{device.device}</h3>
              {device.current ? <Badge tone="plain">这一台</Badge> : null}
            </div>
            <p className="text-muted-foreground">{device.entry === 'outside' ? '从外面' : '在主机这台电脑上'}{device.method ? ' · ' + (METHODS[device.method] ?? device.method) : ''}</p>
            <dl className="grid gap-0.5 text-xs text-muted-foreground tabular-nums">
              <div><dt className="inline">登录：</dt><dd className="inline">{fullTime(device.created_at)}</dd></div>
              <div><dt className="inline">最近使用：</dt><dd className="inline">{fullTime(device.last_seen_at)}</dd></div>
              <div><dt className="inline">到期：</dt><dd className="inline">{fullTime(device.expires_at)}</dd></div>
            </dl>
            <Button size="sm" className="mt-1 justify-self-start" disabled={busy} onClick={() => setConfirmation(device)}>{device.current ? '注销' : '让它退出'}</Button>
          </section>
        ))}
        {data ? <Button className="justify-self-start" disabled={busy || !data.sessions.some((device) => !device.current)} onClick={() => setConfirmation('others')}>全部退出，只留这一台</Button> : null}
      </section>
      <Confirm
        open={confirmation !== null}
        title={others ? '让其他设备全部退出？' : current ? '注销这一台？' : '让这台设备退出？'}
        description={others ? '其他设备会立即失效，只有这一台继续保持登录。' : current ? '这一台会返回登录页，再次使用需要重新登录。' : (selected?.device ?? '') + ' 会立即失效，再次使用需要重新登录。'}
        confirm={current ? '确认注销' : '确认退出'}
        onConfirm={() => { void revoke(); }}
        onCancel={() => setConfirmation(null)}
      />
    </div>
  );
}

export function DeviceLogin() {
  const [open, setOpen] = useState(false);
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild><Button variant="ghost" size="sm" className="gap-1 px-1.5"><MonitorSmartphone />设备</Button></SheetTrigger>
      <SheetContent title="设备" description="查看和管理已登录的设备。放行新设备在侧栏的“放行”里。" className="w-[min(440px,100%)]">
        {open ? <DeviceManager /> : null}
      </SheetContent>
    </Sheet>
  );
}
