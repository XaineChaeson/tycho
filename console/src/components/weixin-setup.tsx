import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import QRCode from 'qrcode';
import { Note, Problem } from '@/components/bits';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { api, messageOf } from '@/lib/api';
import { useI18n } from '@/lib/i18n';

interface WeixinStatus {
  state: 'disconnected' | 'waiting' | 'scanned' | 'pin_required' | 'connected' | 'expired' | 'error';
  qr?: string;
  bot_id?: string;
  user_id?: string;
  error?: string;
}
type Action = { type: 'login' | 'disconnect' } | { type: 'pin'; pin: string };
const KEY = ['weixin-status'];
const SCANNING = new Set<WeixinStatus['state']>(['waiting', 'scanned', 'pin_required']);
const LABEL_KEYS: Record<WeixinStatus['state'], string> = {
  disconnected: 'set.wx.state.disconnected',
  waiting: 'set.wx.state.waiting',
  scanned: 'set.wx.state.scanned',
  pin_required: 'set.wx.state.pin_required',
  connected: 'set.wx.state.connected',
  expired: 'set.wx.state.expired',
  error: 'set.wx.state.error',
};

function visibleStatus(status: WeixinStatus): WeixinStatus {
  const { qr, ...rest } = status;
  return SCANNING.has(status.state) ? { ...rest, qr } : rest;
}

function LoginQr({ content }: { content: string }) {
  const { t } = useI18n();
  const [image, setImage] = useState<string>();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    // The backend returns QR content, not necessarily an image URL. Encode locally.
    void QRCode.toDataURL(content, { width: 240, margin: 2, errorCorrectionLevel: 'M' })
      .then((data) => { if (active) setImage(data); })
      .catch(() => { if (active) setFailed(true); });
    return () => { active = false; };
  }, [content]);
  if (failed) return <Problem role="alert">{t('set.wx.qrFailed')}</Problem>;
  return image
    ? <img src={image} alt={t('set.wx.qrAlt')} width={240} height={240} className="max-w-full rounded-lg border border-border bg-white" />
    : <Note>{t('set.wx.qrGenerating')}</Note>;
}

export function WeixinSetup() {
  const { t } = useI18n();
  const client = useQueryClient();
  const [pin, setPin] = useState('');
  const mounted = useRef(true);
  const sending = useRef(false);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; controller.current?.abort(); };
  }, []);
  const mutation = useMutation({
    retry: false,
    onMutate: async (action: Action) => {
      // Cancel the pending status read before a write so its late answer cannot win.
      await client.cancelQueries({ queryKey: KEY });
      if (action.type !== 'pin') client.setQueryData<WeixinStatus>(KEY, (current) => current ? { ...current, qr: undefined } : current);
    },
    mutationFn: async (action: Action) => {
      const pending = new AbortController();
      controller.current = pending;
      try {
        return await api<WeixinStatus>(action.type === 'disconnect' ? '/api/weixin' : '/api/weixin/' + action.type, {
          method: action.type === 'disconnect' ? 'DELETE' : 'POST',
          signal: pending.signal,
          ...(action.type === 'pin' ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: action.pin }) } : {}),
        });
      } finally {
        if (controller.current === pending) controller.current = null;
      }
    },
    onSuccess: (status) => {
      if (mounted.current) {
        client.setQueryData(KEY, visibleStatus(status));
        setPin('');
      }
    },
    onSettled: () => { sending.current = false; },
  });
  const query = useQuery({
    queryKey: KEY,
    queryFn: async ({ signal }) => visibleStatus(await api<WeixinStatus>('/api/weixin', { signal })),
    enabled: !mutation.isPending,
    retry: false,
    staleTime: 2000,
    gcTime: 0,
    refetchOnMount: 'always',
    refetchOnWindowFocus: false,
    refetchIntervalInBackground: true,
    refetchInterval: (read) => read.state.data && SCANNING.has(read.state.data.state) ? 2000 : false,
  });
  const status = query.data;
  const error = mutation.error ? messageOf(mutation.error) : query.error ? messageOf(query.error) : status?.error;
  const busy = mutation.isPending;
  useEffect(() => { if (status?.state !== 'pin_required') setPin(''); }, [status?.state]);
  function send(action: Action): void {
    if (sending.current) return;
    sending.current = true;
    mutation.mutate(action);
  }
  function submitPin(event: FormEvent): void {
    event.preventDefault();
    if (pin.trim()) send({ type: 'pin', pin: pin.trim() });
  }

  return (
    <section className="grid gap-4 p-4" aria-label={t('set.wx.sectionLabel')}>
      <div className="grid gap-1">
        <h2 className="text-sm font-semibold">{t('set.wx.title')}</h2>
        <Note>{t('set.wx.desc1')}</Note>
        <Note>{t('set.wx.desc2')}</Note>
      </div>
      <p role="status" className="text-sm font-medium">{status ? t(LABEL_KEYS[status.state]) : query.isPending ? t('set.wx.loadingStatus') : t('set.wx.statusUnavailable')}</p>
      {error ? <div className="grid justify-items-start gap-2">
        <Problem role="alert">{error}</Problem>
        <Button size="sm" disabled={busy || query.isFetching} onClick={() => { mutation.reset(); void query.refetch({ cancelRefetch: false }); }}>{t('set.retryRead')}</Button>
      </div> : null}
      {status && SCANNING.has(status.state) && status.qr ? <LoginQr key={status.qr} content={status.qr} /> : null}
      {status?.state === 'pin_required' ? <form onSubmit={submitPin} className="grid max-w-sm gap-2">
        <label htmlFor="weixin-pin" className="text-sm">{t('set.wx.pinLabel')}</label>
        <Input id="weixin-pin" value={pin} onChange={(event) => setPin(event.target.value)} inputMode="numeric" autoComplete="one-time-code" disabled={busy} />
        <Button type="submit" variant="primary" disabled={busy || !pin.trim()}>{t('set.wx.pinConfirm')}</Button>
      </form> : null}
      {status?.state === 'connected' ? <dl className="grid gap-2 text-sm">
        {status.bot_id ? <div><dt className="text-muted-foreground">ClawBot</dt><dd className="break-all font-mono">{status.bot_id}</dd></div> : null}
        {status.user_id ? <div><dt className="text-muted-foreground">{t('set.wx.accountLabel')}</dt><dd className="break-all font-mono">{status.user_id}</dd></div> : null}
      </dl> : null}
      {status ? <div className="flex flex-wrap gap-2">
        <Button variant={status.state === 'disconnected' || status.state === 'expired' || status.state === 'error' ? 'primary' : 'secondary'} disabled={busy}
          onClick={() => send({ type: 'login' })}>
          {status.state === 'connected' ? t('set.wx.relogin') : SCANNING.has(status.state) || status.state === 'expired' ? t('set.wx.refreshQr') : t('set.wx.connect')}
        </Button>
        {status.state === 'connected' || SCANNING.has(status.state) ? <Button variant="danger" disabled={busy} onClick={() => send({ type: 'disconnect' })}>
          {status.state === 'connected' ? t('set.disconnect') : t('set.wx.cancelConnect')}
        </Button> : null}
      </div> : null}
      {busy ? <Note>{t('set.wx.processing')}</Note> : null}
    </section>
  );
}
