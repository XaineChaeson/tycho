import { useEffect, useState } from 'react';
import { ExternalLink, RefreshCw } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { api, messageOf } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { formatTime } from '@shared/time.ts';
import type { DirectoryPeer, DirectoryView } from '@shared/project-directory.ts';

function PeerProjects({ peer }: { peer: DirectoryPeer }) {
  const { t } = useI18n();
  const origin = new URL(peer.origin);
  return (
    <li className="rounded-lg border border-border bg-raised p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="font-medium">{peer.environment}</h3>
        <Badge tone={peer.status === 'online' ? 'success' : 'plain'}>{peer.status === 'online' ? t('common.online') : t('common.offline')}</Badge>
        <a className="ml-auto inline-flex items-center gap-1 text-sm text-accent hover:underline" href={origin.href} target="_blank" rel="noreferrer">
          {t('proj.dir.openService')} <ExternalLink size={13} aria-hidden />
        </a>
      </div>
      {peer.status === 'offline' && peer.observed_at
        ? <p className="mt-1 text-xs text-faint">{t('proj.dir.lastReadAt', { at: formatTime(peer.observed_at) })}</p>
        : null}
      {peer.projects.length
        ? <ul className="mt-3 grid gap-2 border-t border-border pt-3">
            {peer.projects.map((project) => (
              <li key={project.id}>
                <a className="text-sm hover:text-accent hover:underline" href={new URL('/#/projects/' + encodeURIComponent(project.id), origin).href} target="_blank" rel="noreferrer">
                  {project.name}<span className="sr-only"> · {peer.environment}</span>
                </a>
              </li>
            ))}
          </ul>
        : <p className="mt-2 text-sm text-faint">{peer.status === 'offline' ? t('proj.dir.noCachedCatalog') : t('proj.dir.noBrowsableProjects')}</p>}
    </li>
  );
}

export function ProjectDirectory() {
  const { t } = useI18n();
  const [view, setView] = useState<DirectoryView>();
  const [error, setError] = useState('');
  const [attempt, refresh] = useState(0);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    const controller = new AbortController();
    void api<DirectoryView>('/api/project-directory', { signal: controller.signal })
      .then((directory) => {
        if (!controller.signal.aborted) {
          setView(directory);
          setError('');
        }
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) setError(messageOf(reason));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [attempt]);

  if (!error && !view?.peers.length) return null;
  return (
    <section className="mt-8" aria-labelledby="remote-project-heading">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 id="remote-project-heading" className="text-base font-semibold">{t('proj.dir.otherEnvsHeading')}</h2>
        <Button variant="ghost" size="sm" disabled={loading} onClick={() => { setLoading(true); refresh((n) => n + 1); }}>
          <RefreshCw size={14} aria-hidden /> {t('proj.dir.refreshCatalog')}
        </Button>
      </div>
      {error ? <p role="status" className="mb-3 text-sm text-faint">{error}</p> : null}
      <ul className="grid gap-3 sm:grid-cols-2">{view?.peers.map((peer) => <PeerProjects key={peer.service_id} peer={peer} />)}</ul>
    </section>
  );
}
