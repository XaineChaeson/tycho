// Whether the parts of the service are working, always in sight at the foot of the side
// column. When everything is as it should be the whole thing is one line; a part that is
// not right opens out with what it means and a way to the place where it is put right.
import { useQuery } from '@tanstack/react-query';
import { t as translate } from '@shared/i18n.ts';
import { gatewayNote, projectRouterErrors, routerLine, type GatewayNote, type RouterState } from '@shared/labels.ts';
import { Dot, HashLink, Time, type Tone } from '@/components/bits';
import { useI18n } from '@/lib/i18n';
import { stateQuery } from '@/lib/queries';
import type { LaunchingRun, ServiceState, WecomState } from '@/lib/types';
import { cn } from '@/lib/utils';

interface Line {
  key: string;
  name: string;
  tone: Tone;
  text: string;
  detail?: string | undefined;
  href?: string | undefined;
  linkLabel?: string | undefined;
}

const line = (l: Line): Line => l;

// Pausing does not reach what already had the go-ahead: those Runs may still start, and
// which ones, where each was headed and whether its start was ever confirmed are facts
// the owner has to see on whatever page they are on. A paused dispatch is paused whatever
// else is wrong with it, so this rides along with the line's own words.
function afterPause(dispatch: ServiceState['dispatch'], launching: readonly LaunchingRun[]): string {
  if (!dispatch.paused) return '';
  const means = translate('core.health.pauseMeans');
  if (!launching.length) return means;
  const runs = launching.map((run) => {
    const where = [run.host, run.unconfirmed ? translate('core.health.unconfirmedMayStart') : null].filter(Boolean).join(translate('core.health.commaSep'));
    return `${run.task_title ?? run.id}${where ? translate('core.health.parenWrap', { value: where }) : ''}`;
  });
  return translate('core.health.pauseLaunching', { means, runs: runs.join(translate('core.health.listSep')) });
}

function routerLineOf(router: RouterState): Line {
  const name = translate('project.routerSpeaker');
  if (router.error) return line({ key: 'router', name, tone: 'failed', text: translate('core.health.routerStopped'), detail: routerLine(router), href: '#/settings/router.cli', linkLabel: translate('core.health.goSettings') });
  const failedProjects = projectRouterErrors(router);
  if (failedProjects.length > 0) {
    return line({
      key: 'router',
      name,
      tone: 'failed',
      text: failedProjects.length === 1 ? translate('core.health.routerProjectError') : translate('core.health.routerProjectsError', { count: failedProjects.length }),
      detail: routerLine(router),
      href: `#/projects/${encodeURIComponent(failedProjects[0]!.project_id)}/settings`,
      linkLabel: translate('core.health.goInspect'),
    });
  }
  if (router.restarting) return line({ key: 'router', name, tone: 'waiting', text: translate('core.health.routerRestarting'), detail: routerLine(router) });
  if (router.alive) return line({ key: 'router', name, tone: 'running', text: translate('core.health.routerRunning') });
  return line({ key: 'router', name, tone: 'ended', text: translate('core.health.routerIdle'), detail: translate('core.health.routerIdleDetail') });
}

function dispatchLineOf(dispatch: ServiceState['dispatch'], launching: readonly LaunchingRun[]): Line {
  const name = translate('core.health.dispatchName');
  if (dispatch.degraded) return line({ key: 'dispatch', name, tone: 'failed', text: translate('core.health.stopped'), detail: translate('core.health.dispatchDegradedDetail', { extra: afterPause(dispatch, launching) }).trim(), href: '#/' });
  if (dispatch.recovering) return line({ key: 'dispatch', name, tone: 'waiting', text: translate('core.health.dispatchRecovering'), detail: translate('core.health.dispatchRecoveringDetail', { extra: afterPause(dispatch, launching) }).trim() });
  if (dispatch.paused) return line({ key: 'dispatch', name, tone: 'waiting', text: translate('core.health.dispatchPaused'), detail: afterPause(dispatch, launching), href: '#/', linkLabel: translate('core.health.goResume') });
  return line({ key: 'dispatch', name, tone: 'running', text: translate('core.health.ok') });
}

function wecomLineOf(wecom: WecomState | null | undefined): Line {
  const name = translate('core.health.wecomName');
  if (!wecom) return line({ key: 'wecom', name, tone: 'ended', text: translate('core.health.wecomUnconfigured'), detail: translate('core.health.wecomUnconfiguredDetail'), href: '#/settings/wecom.botId', linkLabel: translate('core.health.goSettings') });
  if (wecom.error) return line({ key: 'wecom', name, tone: 'failed', text: translate('core.health.stopped'), detail: wecom.error, href: '#/settings/wecom.botId', linkLabel: translate('core.health.goSettings') });
  if (wecom.connected) return line({ key: 'wecom', name, tone: 'running', text: translate('core.health.connected') });
  return line({ key: 'wecom', name, tone: 'waiting', text: translate('core.health.reconnecting'), detail: translate('core.health.wecomReconnectingDetail') });
}

export const gatewayLineOf = (gateway: ServiceState['gateway']): Line => {
  const name = translate('core.health.gatewayName');
  if (!gateway || gateway.state === 'off') return line({ key: 'gateway', name, tone: 'ended', text: translate('core.health.gatewayOff'), detail: translate('core.health.gatewayOffDetail'), href: '#/settings/http.publicUrl', linkLabel: translate('core.health.goSettings') });
  const note: GatewayNote | null = gatewayNote(gateway);
  if (gateway.state === 'connected') return line({ key: 'gateway', name, tone: 'running', text: translate('core.health.connected'), detail: note?.text });
  if (gateway.state === 'down') return line({ key: 'gateway', name, tone: 'failed', text: translate('core.health.gatewayDown'), detail: note?.text, href: note?.href, linkLabel: note?.label });
  return line({ key: 'gateway', name, tone: 'waiting', text: translate('core.health.connecting'), detail: note?.text });
};

export function healthLines(state: ServiceState | undefined): Line[] {
  if (!state) return [];
  return [routerLineOf(state.router), dispatchLineOf(state.dispatch, state.launching_runs ?? []), wecomLineOf(state.channels?.wecom), gatewayLineOf(state.gateway)];
}

// A line is right when nothing about it is being put right: a Router that is not running
// starts on the next message, an absent WeCom or gateway is a choice, not a fault.
const sound = ({ tone }: Line): boolean => tone === 'running' || tone === 'ended';

// Folded away, each part still has its say for a pointer that rests on the line.
const foldTitle = (lines: readonly Line[]): string =>
  lines.map((each) => translate('core.health.foldItem', { name: each.name, value: each.detail ?? each.text })).join(translate('core.health.foldSep'));

export function Health({ className }: { className?: string }) {
  const { t } = useI18n();
  const { data: state } = useQuery(stateQuery);
  if (!state) return null;
  const lines = healthLines(state);
  const trouble = lines.filter((each) => !sound(each));
  if (!trouble.length) {
    return (
      <p data-slot="health" title={foldTitle(lines)} className={cn('flex items-center gap-2 text-xs text-muted-foreground', className)}>
        <Dot tone="success" />
        {t('health.allGood')}
      </p>
    );
  }
  return (
    <div data-slot="health" aria-label={t('core.health.ariaLabel')} className={cn('grid gap-1.5', className)}>
      {lines.map((each) => (
        <div key={each.key} className="text-xs">
          <p className="flex items-center gap-2">
            <Dot tone={each.tone === 'running' ? 'success' : each.tone} pulse={false} title={each.tone === 'failed' ? t('core.health.toneFailed') : each.tone === 'waiting' ? t('core.health.toneWaiting') : t('core.health.toneOk')} />
            <span className="font-medium">{each.name}</span>
            <span className={each.tone === 'failed' ? 'text-destructive' : 'text-muted-foreground'}>{each.text}</span>
          </p>
          {!sound(each) && each.detail ? (
            <p className="mt-0.5 pl-4 text-muted-foreground wrap-anywhere">
              {each.detail}
              {each.href ? <> <HashLink href={each.href}>{each.linkLabel ?? t('core.health.goHandle')}</HashLink></> : null}
            </p>
          ) : null}
        </div>
      ))}
    </div>
  );
}

// The side column also says when the console last heard from the service: a stale page
// looks like a quiet service otherwise.
export function LastHeard({ at, className }: { at: number | null; className?: string }) {
  const { t } = useI18n();
  if (at === null) return null;
  return <Time at={at} prefix={t('core.health.updatedPrefix')} className={cn('text-2xs text-faint', className)} />;
}
