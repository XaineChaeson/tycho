// Guards the side column's account of the service: a part that is not right read as
// normal, 一切正常 said while something is wrong, a fault with no way to the place it is
// put right, and an ordinary absence (no WeCom, no gateway) counted as a fault.
import { expect, test } from 'vitest';
import { gatewayLineOf, healthLines } from './health.tsx';
import { IDLE_STATE } from '@/test/harness';
import type { ServiceState } from '@/lib/types';

const state = (over: Partial<ServiceState> = {}): ServiceState => ({ ...IDLE_STATE, ...over } as ServiceState);
const shown = (over: Partial<ServiceState> = {}) => healthLines(state(over)).map(({ name, tone, text }) => [name, tone, text]);

test('every part says how it stands, and an absence is not a fault', () => {
  expect(shown()).toEqual([
    ['负责人', 'running', '运行中'],
    ['派发', 'running', '正常'],
    ['企业微信', 'ended', '未接入'],
    ['门牌', 'ended', '未启用'],
  ]);
  // A Router that is not running starts on the next message: moving, not broken.
  expect(healthLines(state({ router: { alive: false, error: null, restarting: false, turn: null } }))[0]).toMatchObject({ tone: 'ended', text: '未运行' });
});

test('a fault is a fault, and carries the way to the place it is put right', () => {
  const lines = healthLines(state({
    router: { alive: false, error: '在 PATH 里没有找到 claude', restarting: false, turn: null },
    dispatch: { degraded: true, recovering: false, paused: null },
    channels: { wecom: { error: '没有设置 Secret' } },
    gateway: { state: 'down', since: null, error: 'Connection refused' },
  }));
  expect(lines.map(({ name, tone }) => [name, tone])).toEqual([['负责人', 'failed'], ['派发', 'failed'], ['企业微信', 'failed'], ['门牌', 'failed']]);
  expect(lines.every(({ href }) => Boolean(href))).toBe(true);
  expect(lines[0]!.detail).toMatch(/负责人已停摆/);
  expect(lines[2]!.detail).toBe('没有设置 Secret');
  expect(lines[3]!.detail).toMatch(/门牌：连不上，正在重试：Connection refused/);
});

test('a gateway that is connecting is a wait, and one that is connected needs nothing said', () => {
  expect(gatewayLineOf({ state: 'connecting', since: null, error: 'refused' })).toMatchObject({ tone: 'waiting', text: '连接中' });
  const up = gatewayLineOf({ state: 'connected', since: '2026-11-06T01:02:00.000Z', error: null });
  expect(up).toMatchObject({ tone: 'running', text: '已连接' });
  expect(up.detail).toMatch(/门牌：已连接/);
});

test('a pause says what it means and what it does not reach: the Runs that may still start', () => {
  const paused = { degraded: false, recovering: false, paused: true };
  const lined = healthLines(state({
    dispatch: paused,
    launching_runs: [{ id: 'r1', task_id: 't1', task_title: '探针', host: 'h1', unconfirmed: true }, { id: 'r2', task_id: 't2', task_title: '回归', host: 'h2' }],
  }));
  expect(lined[1]).toMatchObject({ name: '派发', tone: 'waiting', text: '已暂停' });
  expect(lined[1]!.detail).toContain('暂停前已取得启动资格、可能随后启动：探针（h1，启动未确认，仍可能迟到启动）、回归（h2）');
  // Nothing on its way: the pause says only what it means.
  expect(healthLines(state({ dispatch: paused, launching_runs: [] }))[1]!.detail).toBe('正在跑的不受影响，新的不再开始。');
  // A ledger that stopped accepts writes says both: a paused dispatch is paused whatever
  // else is wrong with it, and what it does not reach is still coming.
  const stopped = healthLines(state({ dispatch: { ...paused, degraded: true }, launching_runs: [{ id: 'r1', task_id: 't1', task_title: '探针', host: 'h1', unconfirmed: true }] }));
  expect(stopped[1]).toMatchObject({ tone: 'failed', text: '已停止' });
  expect(stopped[1]!.detail).toContain('账本写入失败');
  expect(stopped[1]!.detail).toContain('暂停前已取得启动资格、可能随后启动：探针（h1，启动未确认，仍可能迟到启动）');
});

test('a project-level router failure is surfaced instead of reporting 一切正常', () => {
  const lines = healthLines(state({
    router: {
      alive: false,
      error: null,
      restarting: false,
      turn: null,
      projects: [{ project_id: 'p-alert', alive: false, error: '负责人启动失败：找不到 agy' }],
    },
  }));
  expect(lines[0]).toMatchObject({
    name: '负责人',
    tone: 'failed',
    text: '项目异常',
    href: '#/projects/p-alert/settings',
    linkLabel: '去检查',
  });
  expect(lines[0]!.detail).toContain('负责人启动失败：找不到 agy');
});
