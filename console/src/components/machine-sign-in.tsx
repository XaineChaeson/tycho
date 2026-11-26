// Signing one of the machines in to an executor of its own (docs/design/native-login.md, the
// Codex login): pick an online machine that has the executor, start the executor's own sign-in
// there, open the address it gives in your own browser and type its one-time code, and the
// machine is signed in. That is the machine's own login — tycho keeps nothing of it — so what
// follows in the same window is that login's tiers, as on the machines page.
//
// Leaving the steps while the sign-in is under way cancels it on the machine.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useRef, useState } from 'react';
import { SIGN_IN_STATE_TEXT, signInLive, type SignInView } from '@shared/sign-in.ts';
import { Callout, CopyButton, Field, Mono, Note, Problem } from '@/components/bits';
import { LoginEditor } from '@/components/login-form';
import { Button } from '@/components/ui/button';
import { Choice, Radio } from '@/components/ui/checkbox';
import { DialogActions } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { formOf, loginSettingsBody, newAccountForm, tierEditorOf, tierRefusal, type AccountForm, type TierProblem } from '@/lib/accounts';
import { api, messageOf, post, put } from '@/lib/api';
import { accountsQuery, PAGE } from '@/lib/queries';
import { isTychoDesktop, openExternalUrl } from '@/lib/utils';
import type { AccountsAndMachines, Machine } from '@/lib/types';

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
        {fixedMachine ? <Note>将在 {fixedMachine.id} 上重新登录 {executor}；这会更换那台机器上执行器自己的登录。登录期间这份登录不接新任务。</Note> : machines.length ? (
          <fieldset className="grid gap-1">
            <legend className="mb-1 text-sm font-medium">在哪台机器上登录</legend>
            {machines.map((each) => (
              <Choice key={each.id}>
                <Radio name={`${id}-machine`} checked={machineId === each.id} disabled={starting} onChange={() => setMachineId(each.id)} />
                <Mono>{each.id}</Mono>
                {each.logins?.some((login) => login.executor === executor && (login.signed_in ?? login.configured)) ? <span className="text-xs text-muted-foreground">已经登录过；再登录会换掉那台机器上的这份登录</span> : null}
              </Choice>
            ))}
          </fieldset>
        ) : (
          <Callout tone="waiting">现在没有在线、装了 <Mono>{executor}</Mono> 的机器。先让一台机器的客户端连上来，再回到这里。</Callout>
        )}
        <Note className="text-xs">登录留在那台机器上，是它自己的 {executor} 登录：和在那台机器上敲登录命令是一回事。共用同一个 Home 的机器会一起用上它。</Note>
        {fixedMachine && machines.length === 0 ? <Callout tone="waiting">这台机器没有在线，或没有报告可用的 {executor}；请先让机器连上并报告执行器。</Callout> : null}
        {error ? <Problem role="alert">{error}</Problem> : null}
        <DialogActions>
          <Button variant="ghost" disabled={starting} onClick={onBack}>{fixedMachine ? '取消' : '上一步'}</Button>
          <Button type="submit" variant="primary" disabled={starting || machineId === null || machines.length === 0}>{starting ? '正在发起' : '开始登录'}</Button>
        </DialogActions>
      </form>
    );
  }

  return (
    <div className="grid gap-4">
      <p role="status" className={view.state === 'failed' ? 'text-failed-foreground' : undefined}>
        {`${machine?.id ?? view.machine} 上的 ${executor}：${SIGN_IN_STATE_TEXT[view.state]}`}{view.state === 'failed' && view.reason ? `。${view.reason}` : ''}
      </p>
      {view.state === 'starting' ? <Note>正在那台机器上启动登录，等它给出验证网址…</Note> : null}
      {view.state === 'waiting' && view.url && view.code ? (
        <Callout tone="plain" className="grid gap-3">
          <p>在你自己的浏览器里打开这个网址，登录想用的账号，再输入下面的一次性用户码。</p>
          <div className="flex flex-wrap items-center gap-2">
            <Button asChild variant="primary">
              <a href={view.url} target="_blank" rel="noopener noreferrer">打开验证页</a>
            </Button>
            <CopyButton value={view.url} label="复制网址" />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-lg tracking-widest">{view.code}</span>
            <CopyButton value={view.code} label="复制用户码" />
          </div>
          <Note className="text-xs">只输入你自己在这里发起的用户码。授权完成后这里会自动变成“已登录”。</Note>
        </Callout>
      ) : null}
      {view.state === 'waiting' && view.url && view.accepts_code ? (
        <form className="grid gap-3" onSubmit={(event) => { event.preventDefault(); void submitCode(); }}>
          <Callout tone="plain" className="grid gap-3">
            <p>点下面的按钮在浏览器里登录官方账号完成授权，再把页面给出的授权码（或跳转后的完整网址）贴到这里。</p>
            <div className="flex flex-wrap items-center gap-2">
              <Button asChild variant="primary">
                <a href={view.url} target="_blank" rel="noopener noreferrer">打开授权页</a>
              </Button>
              <CopyButton value={view.url} label="复制网址" />
            </div>
            <Field htmlFor={`${id}-code`} label="授权码" hint="支持粘贴授权码，或浏览器跳转后的完整回调网址。">
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
            <Button variant="ghost" disabled={submittingCode} onClick={() => void cancel()}>取消这次登录</Button>
            <Button type="submit" variant="primary" disabled={submittingCode || codeInput.trim() === ''}>{submittingCode ? '正在提交' : '提交授权码'}</Button>
          </DialogActions>
        </form>
      ) : null}
      {view.state === 'exchanging' ? <Note role="status">正在那台机器上向官方验证授权码…</Note> : null}
      {signInLive(view.state) && !(view.state === 'waiting' && view.accepts_code) ? (
        <DialogActions><Button variant="ghost" onClick={() => void cancel()}>取消这次登录</Button></DialogActions>
      ) : null}
      {view.state === 'failed' || view.state === 'cancelled' ? (
        <DialogActions>
          {!fixedMachine ? <Button variant="ghost" onClick={() => { setSignIn(null); setError(null); }}>换一台机器</Button> : null}
          <Button variant="primary" disabled={starting} onClick={() => void start()}>再试一次</Button>
        </DialogActions>
      ) : null}
      {view.state === 'done' ? (
        <>
          <Callout tone="plain">
            <p className="font-semibold">已登录。填好下面的档位保存后即可接活。</p>
            <Note className="mt-1 text-xs">模型留空就是机器上这个执行器自己的默认；之后也可以随时在“机器”页修改。</Note>
          </Callout>
          {!fresh && !gaveUp ? <Note role="status">正在等那台机器报告登录后能用的模型…</Note> : null}
          {!fresh && gaveUp ? <Note className="text-xs text-waiting-foreground">那台机器还没报告登录后的模型，下面的列表可能是它没登录时的旧列表；不在列表里的模型可以手填。</Note> : null}
          {fresh || gaveUp ? <LoginEditor
            onMachine
            own={own}
            form={form}
            saving={saving}
            busy={busy || saving}
            page={page}
            problem={tierProblem}
            cancelLabel="稍后再填"
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
