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
import { useI18n } from '@/lib/i18n';
import { PAGE } from '@/lib/queries';

export interface PassphraseStatus {
  enabled: boolean;
}

const PASSPHRASE_QUERY_KEY = [PAGE, 'auth-passphrase'] as const;
const MIN_LENGTH = 8;
const MAX_LENGTH = 128;

function validatePassphrase(passphrase: string, confirm: string, t: ReturnType<typeof useI18n>['t']): string | null {
  if (passphrase.length < MIN_LENGTH) {
    return t('set.pass.tooShort', { min: MIN_LENGTH });
  }
  if (passphrase.length > MAX_LENGTH) {
    return t('set.pass.tooLong', { max: MAX_LENGTH });
  }
  if (passphrase !== confirm) {
    return t('set.pass.mismatch');
  }
  return null;
}

export function PassphraseSetup() {
  const { t } = useI18n();
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
      <Card id="setting-auth.passphrase" className="mt-4 grid justify-items-start gap-3" aria-label={t('set.pass.title')}>
        <h3 className="text-sm font-semibold text-foreground">{t('set.pass.title')}</h3>
        <Problem role="alert">{messageOf(query.error)}</Problem>
        <Button size="sm" disabled={query.isFetching} onClick={() => void query.refetch()}>
          {t('set.retryRead')}
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

    const invalid = validatePassphrase(passphrase, confirm, t);
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
      setNotice(t('set.pass.saved'));
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
      setNotice(t('set.pass.disabledNotice'));
      queryClient.setQueryData<PassphraseStatus>(PASSPHRASE_QUERY_KEY, { enabled: false });
      await queryClient.invalidateQueries({ queryKey: PASSPHRASE_QUERY_KEY });
    } catch (err) {
      setDisableError(messageOf(err));
    } finally {
      setDisabling(false);
    }
  }

  const firstLabel = enabled ? t('set.pass.newLabel') : t('set.pass.ownerLabel');
  const secondLabel = enabled ? t('set.pass.confirmNewLabel') : t('set.pass.confirmLabel');

  return (
    <>
      <Card id="setting-auth.passphrase" className="mt-4 grid gap-3.5" aria-label={t('set.pass.title')}>
        <div className="grid gap-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold text-foreground">{t('set.pass.title')}</h3>
            <Badge tone={enabled ? 'success' : 'plain'}>{enabled ? t('set.pass.enabledBadge') : t('set.pass.disabledBadge')}</Badge>
          </div>
          <Note className="text-xs">{t('set.pass.explanation')}</Note>
        </div>

        {enabled ? (
          <div className="grid gap-3">
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-muted px-3 py-2.5">
              <div className="flex min-w-0 items-center gap-2 text-xs text-foreground">
                <Dot tone="success" />
                <span>{t('set.pass.configuredHint')}</span>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  size="sm"
                  aria-expanded={changing}
                  disabled={submitting || disabling || changing}
                  onClick={openChangeForm}
                >
                  {t('set.pass.changeBtn')}
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
                  {t('set.pass.disableBtn')}
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
                      placeholder={t('set.pass.placeholder')}
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
                      placeholder={t('set.pass.confirmPlaceholder')}
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
                    {submitting ? t('common.saving') : t('set.pass.saveNewBtn')}
                  </Button>
                  <Button variant="ghost" disabled={submitting} onClick={cancelChangeForm}>
                    {t('common.cancel')}
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
                  placeholder={t('set.pass.placeholder')}
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
                  placeholder={t('set.pass.confirmPlaceholder')}
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
                {submitting ? t('common.saving') : t('set.pass.enableBtn')}
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
        title={t('set.pass.disableConfirmTitle')}
        description={t('set.pass.disableConfirmDesc')}
        confirm={disabling ? t('set.pass.disabling') : t('set.pass.confirmDisable')}
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
