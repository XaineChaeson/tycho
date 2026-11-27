import { deviceLoginDecisionText, joinDecisionText, loginDurationText } from '@shared/labels.ts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound } from 'lucide-react';
import { useRef, useState } from 'react';
import { Callout, Problem } from '@/components/bits';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';
import { Sheet, SheetContent, SheetTrigger } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { api, messageOf, post } from '@/lib/api';
import { joinExpiryText } from '@/lib/machines';
import { accountsQuery, nodeJoinsQuery, PAGE, POLL_MS } from '@/lib/queries';

// What one six-digit number can stand for (docs/design/nodes.md §1.1 step 2): a device
// asking to log in, or a machine asking to join. The two keep their own numbers, so one
// code can name both; the service lists every match and the owner says which.
type Match =
  | { kind: 'device'; code: string; entry: 'inside' | 'outside'; device: string; created_at: number; expires_at: number }
  | { kind: 'machine'; code: string; name: string; platform: string; hostname: string; created_at: string; expires_at: string };

interface Durations {
  session_days: number;
  temporary_ms: number;
}

const BOTH = '这个号码同时对上了一台设备和一台机器：只放行你面前显示着这个数字的那一个。';

function AdmitForm() {
  const client = useQueryClient();
  // How long a device stays signed in is the sessions list's to say.
  const { data: durations } = useQuery({ queryKey: [PAGE, 'console-sessions'], queryFn: () => api<Durations>('/api/console-sessions'), refetchInterval: POLL_MS });
  const [code, setCode] = useState('');
  const [matches, setMatches] = useState<Match[]>([]);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const pending = useRef(false);

  async function hold(work: () => Promise<void>) {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setFailure(null);
    setNotice(null);
    try {
      await work();
    } catch (error) {
      setMatches([]);
      setFailure(messageOf(error));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }

  const lookup = () => hold(async () => {
    setMatches([]);
    setMatches((await post<{ matches: Match[] }>('/api/admissions/lookup', { code })).matches);
  });

  const decide = (match: Match, approve: boolean, temporary = false) => hold(async () => {
    if (match.kind === 'device') {
      const decision = await post<{ device: string; duration_ms?: number }>('/api/admissions/' + (approve ? 'approve' : 'reject'), {
        kind: 'device', code: match.code, ...(approve ? { temporary } : {}),
      });
      const lifetime = decision.duration_ms ?? (durations && (temporary ? durations.temporary_ms : durations.session_days * 86_400_000));
      setNotice(deviceLoginDecisionText(approve, decision.device, approve ? lifetime : undefined));
    } else {
      const decision = await post<{ name: string }>('/api/admissions/' + (approve ? 'approve' : 'reject'), { kind: 'machine', code: match.code });
      setNotice(joinDecisionText(approve, decision.name));
      // The machine page reads its lists again: one machine more, one request fewer.
      void client.invalidateQueries({ queryKey: accountsQuery.queryKey });
      void client.invalidateQueries({ queryKey: nodeJoinsQuery.queryKey });
    }
    // Only the one decided: the other match, when there were two, is still waiting.
    setMatches((all) => all.filter((each) => each !== match));
  });

  return (
    <section aria-label="放行" className="grid gap-5">
      <form className="grid gap-2" onSubmit={(event) => { event.preventDefault(); void lookup(); }}>
        <label htmlFor="admit-code" className="font-medium">六位数字</label>
        <div className="flex items-center gap-2">
          <Input
            id="admit-code"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]{6}"
            maxLength={6}
            required
            className="w-36 font-mono text-lg tracking-[0.3em]"
            value={code}
            disabled={busy}
            onChange={(event) => {
              setCode(event.target.value);
              setMatches([]);
              setFailure(null);
              setNotice(null);
            }}
          />
          <Button type="submit" variant="primary" disabled={busy || !/^[0-9]{6}$/.test(code)}>查找</Button>
        </div>
        <p className="text-xs text-muted-foreground">新设备的登录页上、或新机器的加入命令打印的那个数字。</p>
      </form>
      {failure ? <Problem role="alert">{failure}</Problem> : null}
      {notice ? <Callout tone="plain" role="status">{notice}</Callout> : null}
      {matches.length > 1 ? <p className="font-medium">{BOTH}</p> : null}
      {matches.map((match) => match.kind === 'device'
        ? <DeviceMatch key="device" match={match} durations={durations} busy={busy} onDecide={(approve, temporary) => void decide(match, approve, temporary)} />
        : <MachineMatch key="machine" match={match} busy={busy} onDecide={(approve) => void decide(match, approve)} />)}
    </section>
  );
}

const MATCH = 'grid gap-2 rounded-lg border border-border p-4';
const CODE = 'font-mono text-2xl font-semibold tracking-[0.25em]';

function DeviceMatch({ match, durations, busy, onDecide }: {
  match: Extract<Match, { kind: 'device' }>;
  durations: Durations | undefined;
  busy: boolean;
  onDecide: (approve: boolean, temporary?: boolean) => void;
}) {
  const minutes = Math.max(0, Math.floor((Date.now() - match.created_at) / 60_000));
  return (
    <section aria-label="等待放行的设备" className={MATCH}>
      <h2 className="text-xs text-muted-foreground">新设备登录</h2>
      <p className={CODE}>{match.code}</p>
      <p className="font-medium wrap-anywhere">{match.device}</p>
      <p className="text-muted-foreground">{match.entry === 'outside' ? '从外面' : '在主机这台电脑上'}{' · '}{minutes ? minutes + ' 分钟前发起' : '刚刚发起'}</p>
      <p>只有你自己面前那台设备上显示着同样的数字时才放行。</p>
      <div className="mt-1 flex flex-wrap gap-2">
        {durations ? <>
          <Button variant="primary" className="h-auto max-w-full whitespace-normal wrap-anywhere" disabled={busy} onClick={() => onDecide(true)}>放行，保持 {durations.session_days} 天</Button>
          <Button className="h-auto max-w-full whitespace-normal wrap-anywhere" disabled={busy} onClick={() => onDecide(true, true)}>放行，只保持 {loginDurationText(durations.temporary_ms)}</Button>
        </> : <p className="text-muted-foreground">读取登录保持时间后才能放行。</p>}
        <Button variant="danger" disabled={busy} onClick={() => onDecide(false)}>不是我</Button>
      </div>
    </section>
  );
}

function MachineMatch({ match, busy, onDecide }: {
  match: Extract<Match, { kind: 'machine' }>;
  busy: boolean;
  onDecide: (approve: boolean) => void;
}) {
  return (
    <section aria-label="等待放行的机器" className={MATCH}>
      <h2 className="text-xs text-muted-foreground">新机器加入</h2>
      <p className={CODE}>{match.code}</p>
      <p className="font-medium wrap-anywhere">{match.name}</p>
      <p className="text-muted-foreground wrap-anywhere">{match.platform} · {match.hostname}</p>
      <p className="text-muted-foreground">{joinExpiryText(match.expires_at)}</p>
      <p>只有你自己面前那台机器上显示着同样的数字时才放行。</p>
      <div className="mt-1 flex flex-wrap gap-2">
        <Button variant="primary" disabled={busy} onClick={() => onDecide(true)}>放行</Button>
        <Button variant="danger" disabled={busy} onClick={() => onDecide(false)}>拒绝</Button>
      </div>
    </section>
  );
}

// The one way to let something in by its six digits, from the foot of the side column.
export function Admit() {
  const { t, bi } = useI18n();
  const [open, setOpen] = useState(false);
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild><Button variant="ghost" size="sm" className="gap-1 px-1.5"><KeyRound />{t('nav.admit')}</Button></SheetTrigger>
      <SheetContent title={t('nav.admit')} description={bi('放行一台新设备登录控制台，或者一台新机器加入。', 'Approve a new device sign-in or connect a new machine.')} className="w-[min(440px,100%)]">
        {open ? <AdmitForm /> : null}
      </SheetContent>
    </Sheet>
  );
}
