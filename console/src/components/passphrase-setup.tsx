import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check } from 'lucide-react';
import { useId, useState, type FormEvent } from 'react';
import { Card, Dot, Note, Problem } from '@/components/bits';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Confirm } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { api, del, messageOf, put } from '@/lib/api';
import { PAGE } from '@/lib/queries';

export interface PassphraseStatus {
  enabled: boolean;
}

const PASSPHRASE_QUERY_KEY = [PAGE, 'auth-passphrase'] as const;
const MIN_LENGTH = 8;
const MAX_LENGTH = 128;
const EXPLANATION =
  '开启后，在微信浏览器、新浏览器或新设备打开登录页时，可直接输入主人口令进入控制台，无需每次找另一台设备输入 6 位放行码。口令仅以 scrypt 加盐哈希存放在主机私钥目录，6 位码放行仍可作为备用。';

function validatePassphrase(passphrase: string, confirm: string): string | null {
  if (passphrase.length < MIN_LENGTH) {
    return `主人口令至少需要 ${MIN_LENGTH} 位字符。`;
  }
  if (passphrase.length > MAX_LENGTH) {
    return `主人口令长度不能超过 ${MAX_LENGTH} 位字符。`;
  }
  if (passphrase !== confirm) {
    return '两次输入的口令不一致，请重新确认。';
  }
  return null;
}

export function PassphraseSetup() {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: PASSPHRASE_QUERY_KEY,
    queryFn: () => api<PassphraseStatus>('/api/auth/passphrase'),
  });

  const primaryId = useId();
  const confirmId = useId();

  const [passphrase, setPassphrase] = useState('');
  const [confirm, setConfirm] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [changing, setChanging] = useState(false);
  const [confirmDisable, setConfirmDisable] = useState(false);
  const [disabling, setDisabling] = useState(false);
  const [disableError, setDisableError] = useState<string | null>(null);

  if (query.isPending) {
    return (
      <div id="setting-auth.passphrase" className="mt-4">
        <Skeleton className="h-36 w-full rounded-xl" />
      </div>
    );
  }

  if (query.error && !query.data) {
    return (
      <Card id="setting-auth.passphrase" className="mt-4 grid justify-items-start gap-3" aria-label="主人口令直登">
        <h3 className="text-sm font-semibold text-foreground">主人口令直登</h3>
        <Problem role="alert">{messageOf(query.error)}</Problem>
        <Button size="sm" disabled={query.isFetching} onClick={() => void query.refetch()}>
          重试读取
        </Button>
      </Card>
    );
  }

  const enabled = query.data?.enabled === true;

  function openChangeForm(): void {
    setChanging(true);
    setPassphrase('');
    setConfirm('');
    setFormError(null);
    setNotice(null);
  }

  function cancelChangeForm(): void {
    setChanging(false);
    setPassphrase('');
    setConfirm('');
    setFormError(null);
  }

  async function submitPassphrase(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (submitting || disabling) return;

    const invalid = validatePassphrase(passphrase, confirm);
    if (invalid) {
      setFormError(invalid);
      setNotice(null);
      return;
    }

    const nextPassphrase = passphrase;
    // Clear password inputs immediately on submit so secrets never linger in state or DOM.
    setPassphrase('');
    setConfirm('');
    setFormError(null);
    setNotice(null);
    setSubmitting(true);

    try {
      await put<PassphraseStatus>('/api/auth/passphrase', { passphrase: nextPassphrase });
      setChanging(false);
      setNotice('主人口令已保存');
      queryClient.setQueryData<PassphraseStatus>(PASSPHRASE_QUERY_KEY, { enabled: true });
      await queryClient.invalidateQueries({ queryKey: PASSPHRASE_QUERY_KEY });
    } catch (err) {
      setFormError(messageOf(err));
    } finally {
      setSubmitting(false);
    }
  }

  async function disablePassphrase(): Promise<void> {
    if (disabling || submitting) return;
    setDisabling(true);
    setDisableError(null);
    setNotice(null);

    try {
      await del<PassphraseStatus>('/api/auth/passphrase');
      setConfirmDisable(false);
      setChanging(false);
      setPassphrase('');
      setConfirm('');
      setFormError(null);
      setNotice('已关闭口令登录');
      queryClient.setQueryData<PassphraseStatus>(PASSPHRASE_QUERY_KEY, { enabled: false });
      await queryClient.invalidateQueries({ queryKey: PASSPHRASE_QUERY_KEY });
    } catch (err) {
      setDisableError(messageOf(err));
    } finally {
      setDisabling(false);
    }
  }

  const firstLabel = enabled ? '新口令' : '主人口令';
  const secondLabel = enabled ? '确认新口令' : '确认口令';

  return (
    <>
      <Card id="setting-auth.passphrase" className="mt-4 grid gap-3.5" aria-label="主人口令直登">
        <div className="grid gap-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold text-foreground">主人口令直登</h3>
            <Badge tone={enabled ? 'success' : 'plain'}>{enabled ? '已开启' : '未开启'}</Badge>
          </div>
          <Note className="text-xs">{EXPLANATION}</Note>
        </div>

        {enabled ? (
          <div className="grid gap-3">
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-muted px-3 py-2.5">
              <div className="flex min-w-0 items-center gap-2 text-xs text-foreground">
                <Dot tone="success" />
                <span>已设置主人口令，可在新浏览器或新设备登录页直接输入进入。</span>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  size="sm"
                  aria-expanded={changing}
                  disabled={submitting || disabling || changing}
                  onClick={openChangeForm}
                >
                  更换口令
                </Button>
                <Button
                  size="sm"
                  variant="danger"
                  disabled={submitting || disabling}
                  onClick={() => {
                    setDisableError(null);
                    setConfirmDisable(true);
                  }}
                >
                  关闭口令登录
                </Button>
              </div>
            </div>

            {changing ? (
              <form onSubmit={(event) => void submitPassphrase(event)} className="grid gap-3 border-t border-border pt-3">
                <div className="grid gap-2.5 sm:grid-cols-2">
                  <div className="grid gap-1">
                    <label htmlFor={primaryId} className="text-xs font-medium text-muted-foreground">
                      {firstLabel}
                    </label>
                    <Input
                      id={primaryId}
                      type="password"
                      autoComplete="new-password"
                      aria-label={firstLabel}
                      placeholder="至少 8 位字符（支持空格和中文）"
                      value={passphrase}
                      disabled={submitting}
                      onChange={(event) => {
                        setPassphrase(event.target.value);
                        if (formError) setFormError(null);
                        if (notice) setNotice(null);
                      }}
                    />
                  </div>
                  <div className="grid gap-1">
                    <label htmlFor={confirmId} className="text-xs font-medium text-muted-foreground">
                      {secondLabel}
                    </label>
                    <Input
                      id={confirmId}
                      type="password"
                      autoComplete="new-password"
                      aria-label={secondLabel}
                      placeholder="再输入一次确认"
                      value={confirm}
                      disabled={submitting}
                      onChange={(event) => {
                        setConfirm(event.target.value);
                        if (formError) setFormError(null);
                        if (notice) setNotice(null);
                      }}
                    />
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Button type="submit" variant="primary" disabled={submitting}>
                    {submitting ? '保存中…' : '保存新口令'}
                  </Button>
                  <Button variant="ghost" disabled={submitting} onClick={cancelChangeForm}>
                    取消
                  </Button>
                </div>
                {formError ? <Problem role="alert">{formError}</Problem> : null}
              </form>
            ) : null}
          </div>
        ) : (
          <form onSubmit={(event) => void submitPassphrase(event)} className="grid gap-3">
            <div className="grid gap-2.5 sm:grid-cols-2">
              <div className="grid gap-1">
                <label htmlFor={primaryId} className="text-xs font-medium text-muted-foreground">
                  {firstLabel}
                </label>
                <Input
                  id={primaryId}
                  type="password"
                  autoComplete="new-password"
                  aria-label={firstLabel}
                  placeholder="至少 8 位字符（支持空格和中文）"
                  value={passphrase}
                  disabled={submitting}
                  onChange={(event) => {
                    setPassphrase(event.target.value);
                    if (formError) setFormError(null);
                    if (notice) setNotice(null);
                  }}
                />
              </div>
              <div className="grid gap-1">
                <label htmlFor={confirmId} className="text-xs font-medium text-muted-foreground">
                  {secondLabel}
                </label>
                <Input
                  id={confirmId}
                  type="password"
                  autoComplete="new-password"
                  aria-label={secondLabel}
                  placeholder="再输入一次确认"
                  value={confirm}
                  disabled={submitting}
                  onChange={(event) => {
                    setConfirm(event.target.value);
                    if (formError) setFormError(null);
                    if (notice) setNotice(null);
                  }}
                />
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button type="submit" variant="primary" disabled={submitting}>
                {submitting ? '保存中…' : '开启口令登录'}
              </Button>
            </div>
            {formError ? <Problem role="alert">{formError}</Problem> : null}
          </form>
        )}

        {notice ? (
          <p role="status" className="inline-flex items-center gap-1.5 text-xs font-medium text-success-foreground">
            <Check className="size-3.5 flex-none" aria-hidden="true" />
            <span>{notice}</span>
          </p>
        ) : null}
      </Card>

      <Confirm
        open={confirmDisable}
        title="关闭主人口令直登？"
        description="关闭后将清除已保存的主人口令。之后在新浏览器或新设备打开登录页时，需通过 6 位放行码完成放行。"
        confirm={disabling ? '关闭中…' : '确认关闭'}
        danger
        busy={disabling}
        error={disableError}
        onConfirm={() => void disablePassphrase()}
        onCancel={() => {
          setConfirmDisable(false);
          setDisableError(null);
        }}
      />
    </>
  );
}
