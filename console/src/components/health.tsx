// Whether the parts of the service are working, always in sight at the foot of the side
// column. When everything is as it should be the whole thing is one line; a part that is
// not right opens out with what it means and a way to the place where it is put right.
import { useQuery } from '@tanstack/react-query';
import { gatewayNote, projectRouterErrors, routerLine, type GatewayNote, type RouterState } from '@shared/labels.ts';
import { Dot, HashLink, Time, type Tone } from '@/components/bits';
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
  const means = '正在跑的不受影响，新的不再开始。';
  if (!launching.length) return means;
  const runs = launching.map((run) => {
    const where = [run.host, run.unconfirmed ? '启动未确认，仍可能迟到启动' : null].filter(Boolean).join('，');
    return `${run.task_title ?? run.id}${where ? `（${where}）` : ''}`;
  });
  return `${means}暂停前已取得启动资格、可能随后启动：${runs.join('、')}`;
}

function routerLineOf(router: RouterState): Line {
  if (router.error) return line({ key: 'router', name: '负责人', tone: 'failed', text: '已停摆', detail: routerLine(router), href: '#/settings/router.cli', linkLabel: '去设置' });
  const failedProjects = projectRouterErrors(router);
  if (failedProjects.length > 0) {
    return line({
      key: 'router',
      name: '负责人',
      tone: 'failed',
      text: failedProjects.length === 1 ? '项目异常' : `${failedProjects.length} 项异常`,
      detail: routerLine(router),
      href: `#/projects/${encodeURIComponent(failedProjects[0]!.project_id)}/settings`,
      linkLabel: '去检查',
    });
  }
  if (router.restarting) return line({ key: 'router', name: '负责人', tone: 'waiting', text: '重启中', detail: routerLine(router) });
  if (router.alive) return line({ key: 'router', name: '负责人', tone: 'running', text: '运行中' });
  return line({ key: 'router', name: '负责人', tone: 'ended', text: '未运行', detail: '有消息来时会自动启动。' });
}

function dispatchLineOf(dispatch: ServiceState['dispatch'], launching: readonly LaunchingRun[]): Line {
  if (dispatch.degraded) return line({ key: 'dispatch', name: '派发', tone: 'failed', text: '已停止', detail: `账本写入失败，服务处于降级模式。${afterPause(dispatch, launching)}`, href: '#/' });
  if (dispatch.recovering) return line({ key: 'dispatch', name: '派发', tone: 'waiting', text: '清点中', detail: `恢复清点结束前不派发、不处理消息、不发通知。${afterPause(dispatch, launching)}` });
  if (dispatch.paused) return line({ key: 'dispatch', name: '派发', tone: 'waiting', text: '已暂停', detail: afterPause(dispatch, launching), href: '#/', linkLabel: '去恢复' });
  return line({ key: 'dispatch', name: '派发', tone: 'running', text: '正常' });
}

function wecomLineOf(wecom: WecomState | null | undefined): Line {
  if (!wecom) return line({ key: 'wecom', name: '企业微信', tone: 'ended', text: '未接入', detail: '填上企业微信的机器人信息后，就能从手机发消息。', href: '#/settings/wecom.botId', linkLabel: '去设置' });
  if (wecom.error) return line({ key: 'wecom', name: '企业微信', tone: 'failed', text: '已停止', detail: wecom.error, href: '#/settings/wecom.botId', linkLabel: '去设置' });
  if (wecom.connected) return line({ key: 'wecom', name: '企业微信', tone: 'running', text: '已连接' });
  return line({ key: 'wecom', name: '企业微信', tone: 'waiting', text: '重连中', detail: '和企业微信断开了，正在自己重连。' });
}

export const gatewayLineOf = (gateway: ServiceState['gateway']): Line => {
  if (!gateway || gateway.state === 'off') return line({ key: 'gateway', name: '门牌', tone: 'ended', text: '未启用', detail: '还没有填对外地址，现在只能在这台电脑上打开控制台。', href: '#/settings/http.publicUrl', linkLabel: '去设置' });
  const note: GatewayNote | null = gatewayNote(gateway);
  if (gateway.state === 'connected') return line({ key: 'gateway', name: '门牌', tone: 'running', text: '已连接', detail: note?.text });
  if (gateway.state === 'down') return line({ key: 'gateway', name: '门牌', tone: 'failed', text: '连不上', detail: note?.text, href: note?.href, linkLabel: note?.label });
  return line({ key: 'gateway', name: '门牌', tone: 'waiting', text: '连接中', detail: note?.text });
};

export function healthLines(state: ServiceState | undefined): Line[] {
  if (!state) return [];
  return [routerLineOf(state.router), dispatchLineOf(state.dispatch, state.launching_runs ?? []), wecomLineOf(state.channels?.wecom), gatewayLineOf(state.gateway)];
}

// A line is right when nothing about it is being put right: a Router that is not running
// starts on the next message, an absent WeCom or gateway is a choice, not a fault.
const sound = ({ tone }: Line): boolean => tone === 'running' || tone === 'ended';

// Folded away, each part still has its say for a pointer that rests on the line.
const foldTitle = (lines: readonly Line[]): string => lines.map((each) => `${each.name}：${each.detail ?? each.text}`).join('；');

export function Health({ className }: { className?: string }) {
  const { data: state } = useQuery(stateQuery);
  if (!state) return null;
  const lines = healthLines(state);
  const trouble = lines.filter((each) => !sound(each));
  if (!trouble.length) {
    return (
      <p data-slot="health" title={foldTitle(lines)} className={cn('flex items-center gap-2 text-xs text-muted-foreground', className)}>
        <Dot tone="success" />
        一切正常
      </p>
    );
  }
  return (
    <div data-slot="health" aria-label="运行状况" className={cn('grid gap-1.5', className)}>
      {lines.map((each) => (
        <div key={each.key} className="text-xs">
          <p className="flex items-center gap-2">
            <Dot tone={each.tone === 'running' ? 'success' : each.tone} pulse={false} title={each.tone === 'failed' ? '有问题' : each.tone === 'waiting' ? '等一下会好' : '正常'} />
            <span className="font-medium">{each.name}</span>
            <span className={each.tone === 'failed' ? 'text-destructive' : 'text-muted-foreground'}>{each.text}</span>
          </p>
          {!sound(each) && each.detail ? (
            <p className="mt-0.5 pl-4 text-muted-foreground wrap-anywhere">
              {each.detail}
              {each.href ? <> <HashLink href={each.href}>{each.linkLabel ?? '去处理'}</HashLink></> : null}
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
  if (at === null) return null;
  return <Time at={at} prefix="更新于 " className={cn('text-2xs text-faint', className)} />;
}
