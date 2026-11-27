import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';

// Installed releases have three numeric parts. Checkout builds explicitly say 开发版.
// Equality is intentional: a rollback also changes the service behind an open page.
const RELEASE = /^\d+\.\d+\.\d+$/;

export function ConsoleVersionNotice({ pageVersion, serviceVersion, onRefresh }: {
  pageVersion: string; serviceVersion?: string; onRefresh: () => void;
}) {
  const { t } = useI18n();
  if (!RELEASE.test(pageVersion) || !serviceVersion || !RELEASE.test(serviceVersion) || pageVersion === serviceVersion) return null;
  return (
    <div role="status" aria-label={t('core.versionNotice.ariaLabel')} className="flex flex-none flex-wrap items-center justify-center gap-x-3 gap-y-1.5 border-b border-waiting-border bg-waiting-soft px-4 py-2 text-center text-sm text-waiting-foreground">
      <div>
        <p className="font-medium">{t('core.versionNotice.title')}</p>
        <p>{t('core.versionNotice.body', { serviceVersion, pageVersion })}</p>
      </div>
      <Button size="sm" onClick={onRefresh}>{t('core.versionNotice.refresh')}</Button>
    </div>
  );
}
