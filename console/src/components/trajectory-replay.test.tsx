// Saved evidence playback must never reissue commands. A rule simulation is a
// separate, explicit action over a visible frozen case, with failures left visible.
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import { deferred } from '@/test/harness';
import { TrajectoryReplay } from './trajectory-replay';

const frozen = { schema: 'tycho-ready-notice/v1', case_id: 'clean-owner-review', family: 'ready-notice', split: 'release', at: '2026-11-01', inputs: { variant: 'owner-review' }, expected: { state: 'ready', router_can_accept: false, delivered: ['work_ready'], saved_router_turns: 1 } };
type Call = { path: string; method: string; body?: unknown };
let calls: Call[];
let handler: (call: Call) => unknown;
beforeEach(() => {
  calls = [];
  handler = call => call.path.endsWith('/events') ? { events: [{ kind: 'text', text: '原始第一段' }, { kind: 'text', text: '原始第二段' }], first_index: 0 }
    : call.path === '/api/replay/cases' ? { family: 'ready-notice', cases: [frozen] }
    : { family: 'ready-notice', mode: 'isolated-rule-simulation', basis: { version: 'test-version', source_digest: 'test-digest' }, input: frozen, external_effects: 0, result: { failures: [], external_effects: 0, baseline: { router_turns: [['settlement']] }, candidate: { router_turns: [] } } };
  vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
    const call = { path: String(input), method: init?.method ?? 'GET', ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) };
    calls.push(call);
    return new Response(JSON.stringify(await handler(call)), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }));
});
const runs = [{ id: 'run-a', state: 'ended' }, { id: 'run-b', state: 'ended' }];

test('mount is factual reading; playback freezes one read and advancing never sends a command', async () => {
  render(<TrajectoryReplay runs={runs} />);
  expect(calls).toEqual([]);
  fireEvent.click(screen.getByRole('button', { name: '离线回放' }));
  await screen.findByText('已冻结 2 条录制事件');
  expect(screen.queryByText('原始第一段')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '下一步' }));
  await screen.findByText('原始第一段');
  fireEvent.click(screen.getByRole('button', { name: '下一步' }));
  await screen.findByText(/原始第二段/);
  expect(calls).toEqual([{ path: '/api/runs/run-b/events', method: 'GET' }]);
});

test('isolated rerun shows frozen input and issues exactly one explicit simulation', async () => {
  const pending = deferred<unknown>();
  const original = handler;
  handler = call => call.method === 'POST' ? pending.promise : original(call);
  render(<TrajectoryReplay runs={runs} />);
  fireEvent.click(screen.getByRole('button', { name: '隔离重跑' }));
  await screen.findByText('冻结案例');
  expect(calls.filter(c => c.method === 'POST')).toEqual([]);
  const button = screen.getByRole('button', { name: '执行隔离重跑' });
  act(() => { fireEvent.click(button); fireEvent.click(button); });
  await waitFor(() => expect(button).toBeDisabled());
  expect(calls.filter(c => c.method === 'POST')).toEqual([{ path: '/api/replay/run', method: 'POST', body: frozen }]);
  await act(async () => pending.resolve({ external_effects: 0, basis: { version: 'v', source_digest: 'sha' }, result: { failures: [], external_effects: 0, baseline: { router_turns: [['settlement']] }, candidate: { router_turns: [] } } }));
  await screen.findByText('隔离判定通过');
  expect(screen.getByText('外部副作用 0')).toBeInTheDocument();
  expect(screen.getByText(/规则交给负责人的回合：基线 1，候选 0/)).toBeInTheDocument();
});

test('recording gaps remain visible; a case draft is shown separately and cannot be run as a finalized case', async () => {
  handler = call => call.path.endsWith('/events') ? { events: [], first_index: 23, reason: '已过保留期' }
    : call.path.includes('/draft') ? { status: 'draft', missing: ['独立判定'] }
    : { family: 'ready-notice', cases: [frozen] };
  render(<TrajectoryReplay runs={runs} />);
  fireEvent.click(screen.getByRole('button', { name: '离线回放' }));
  await screen.findByText(/已过保留期/);
  expect(screen.getByText(/23/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '关闭' }));
  fireEvent.click(screen.getByRole('button', { name: '隔离重跑' }));
  await screen.findByText('冻结案例');
  fireEvent.click(screen.getByRole('button', { name: '读取本轮案例草稿' }));
  await screen.findByText(/独立判定/);
  expect(calls.filter(c => c.method === 'POST')).toEqual([]);
});

test('malformed custom case never posts; simulation failure remains distinct from factual task success', async () => {
  handler = call => call.method === 'POST' ? { external_effects: 0, basis: { version: 'v' }, result: { failures: ['两版结果不同'], external_effects: 0 } }
    : { family: 'ready-notice', cases: [frozen] };
  render(<TrajectoryReplay runs={runs} />);
  fireEvent.click(screen.getByRole('button', { name: '隔离重跑' }));
  await screen.findByText('冻结案例');
  fireEvent.change(screen.getByLabelText('已定稿案例 JSON'), { target: { value: 'invalid' } });
  fireEvent.click(screen.getByRole('button', { name: '执行隔离重跑' }));
  await screen.findByRole('alert');
  expect(calls.filter(c => c.method === 'POST')).toEqual([]);
  fireEvent.change(screen.getByLabelText('已定稿案例 JSON'), { target: { value: JSON.stringify(frozen) } });
  fireEvent.click(screen.getByRole('button', { name: '执行隔离重跑' }));
  await screen.findByText('两版结果不同');
  expect(screen.getByText('隔离判定未通过')).toBeInTheDocument();
});
