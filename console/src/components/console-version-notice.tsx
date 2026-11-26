import { Button } from '@/components/ui/button';

// Installed releases have three numeric parts. Checkout builds explicitly say 开发版.
// Equality is intentional: a rollback also changes the service behind an open page.
const RELEASE = /^\d+\.\d+\.\d+$/;

export function ConsoleVersionNotice({ pageVersion, serviceVersion, onRefresh }: {
  pageVersion: string; serviceVersion?: string; onRefresh: () => void;
}) {
  if (!RELEASE.test(pageVersion) || !serviceVersion || !RELEASE.test(serviceVersion) || pageVersion === serviceVersion) return null;
  return (
    <div role="status" aria-label="页面版本提示" className="flex flex-none flex-wrap items-center justify-center gap-x-3 gap-y-1.5 border-b border-waiting-border bg-waiting-soft px-4 py-2 text-center text-sm text-waiting-foreground">
      <div>
        <p className="font-medium">服务版本已变化，页面需要刷新。</p>
        <p>{`读到服务版本 ${serviceVersion}，此页面为 ${pageVersion}。请先保存未发送的内容，再刷新页面。`}</p>
      </div>
      <Button size="sm" onClick={onRefresh}>刷新页面</Button>
    </div>
  );
}
