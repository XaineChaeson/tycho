// The whole console on a stand-in service: every request the pages make goes to the
// test's handler, and the stream is one the test opens, feeds and breaks by hand.
import { act, render } from '@testing-library/react';
import { StrictMode } from 'react';
import userEvent from '@testing-library/user-event';
import { vi } from 'vitest';
import { App } from '@/app';

export interface Call {
  path: string;
  method: string;
  body: unknown;
}

// What the service answers a request with. Nothing returned means "as an idle service
// would"; a thrown `refusal` is an error answer.
export type Handler = (call: Call) => unknown;

// Every stream the console has opened, oldest first.
export const sources: FakeEventSource[] = [];

// What jsdom does not have and the console uses.
export class FakeEventSource {
  url: string;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  listeners = new Map<string, ((event: { data: string }) => void)[]>();

  constructor(url: string) {
    this.url = url;
    sources.push(this);
    // As a browser does: the connection opens after the caller has set its handlers.
    queueMicrotask(() => { if (FakeEventSource.autoOpen) this.open(); });
  }

  // Whether a stream connects by itself, the first time and again after a break. A
  // test that turns this off makes each connection by hand, with `open`.
  static autoOpen = true;
  // How long a browser waits before it connects a broken stream again.
  static RECONNECT_MS = 3000;

  // The connection is made. A stream that was closed never connects again.
  open(): void {
    if (!this.closed) this.onopen?.();
  }

  // The connection breaks. As a browser does, the stream says so and then connects
  // again by itself, unless whoever listens has closed it.
  fail(): void {
    if (this.closed) return;
    this.onerror?.();
    if (FakeEventSource.autoOpen) setTimeout(() => this.open(), FakeEventSource.RECONNECT_MS);
  }

  addEventListener(type: string, listener: (event: { data: string }) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  emit(type: string, data: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener({ data: JSON.stringify(data) });
  }

  close(): void {
    this.closed = true;
  }
}

export function refusal(text: string, status = 400, body: Record<string, unknown> = {}): Error {
  return Object.assign(new Error(text), { status, body: { error: text, ...body } });
}

export const IDLE_STATE = {
  dispatch: { degraded: false, recovering: false, paused: false },
  router: { alive: true, error: null, restarting: false, turn: null },
  channels: { wecom: null },
  launching_runs: [],
  restore: null,
};

export const P1_CONVERSATION = {
  project: { id: 'p1', name: '试跑' },
  segments: [{ id: 's1', seq: 1, state: 'current', created_at: '2026-11-05T00:00:00Z', closed_at: null }],
  segment: 's1', writable: true, contexts: [], legacy: 0, busy: null,
};

// A service with nothing in it and nothing wrong.
const IDLE: Record<string, () => unknown> = {
  'GET /api/summary': () => ({ since: '2026-11-05T00:00:00Z', delivered: 0, running: 0, waiting: 0 }),
  'GET /api/messages?limit=50': () => ({ messages: [] }),
  'GET /api/tasks?top=1': () => ({ tasks: [], children: [] }),
  'GET /api/approvals': () => ({ approvals: [] }),
  'GET /api/projects': () => ({ projects: [] }),
  // One project, p1, whose conversation is its first segment, s1: where the conversation tests talk.
  'GET /api/projects/p1/conversation': () => P1_CONVERSATION,
  'GET /api/messages?segment=s1&limit=50': () => ({ messages: [] }),
  'GET /api/messages/unassigned': () => ({ messages: [] }),
  'GET /api/state': () => IDLE_STATE,
  // The overview is the page the console opens on: with nothing in the service it says so.
  'GET /api/overview': () => ({ counts: { waiting: 0, moving: 0, ready: 0 }, approvals: [], moving: [], recent: [], state: IDLE_STATE }),
  'GET /api/doctor': () => ({ checks: [] }),
};

const TURN_CHANGES = /^\/api\/messages\/[^/]+\/changes$/;
// A project with no trigger.
const TRIGGERS = /^\/api\/projects\/[^/]+\/triggers$/;
export const NO_TRIGGERS = { triggers: [], recent: [], zone: 'Asia/Shanghai', min_interval_ms: 300_000 };

export function serve(handler: Handler = () => undefined) {
  // What changed something, in order; and every address read.
  const calls: Call[] = [];
  const reads: string[] = [];
  // Addresses asked and not answered yet.
  const waiting: string[] = [];
  vi.stubGlobal('fetch', async (path: string, init?: RequestInit) => {
    const call: Call = { path, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined };
    if (call.method === 'GET') reads.push(path); else calls.push(call);
    waiting.push(path);
    try {
      let answer = await handler(call);
      if (answer === undefined) {
        // A turn nothing is said about committed nothing.
        const idle = IDLE[`${call.method} ${path}`]
          ?? (call.method === 'GET' && TURN_CHANGES.test(path) ? () => ({ changes: [], tasks: [] }) : undefined)
          ?? (call.method === 'GET' && TRIGGERS.test(path) ? () => NO_TRIGGERS : undefined);
        if (!idle) throw refusal(`没有这个接口：${call.method} ${path}`, 404);
        answer = idle();
      }
      return { status: 200, ok: true, json: async () => answer };
    } catch (error) {
      const { status = 500, body = { error: (error as Error).message } } = error as { status?: number; body?: unknown };
      return { status, ok: false, json: async () => body };
    } finally {
      waiting.splice(waiting.indexOf(path), 1);
    }
  });
  // How many requests the service has not answered yet: all of them, or those to one address.
  return { calls, reads, waiting: (path?: string): number => waiting.filter((asked) => path === undefined || asked === path).length };
}

// Opens the console at an address, as the address bar would, and as the browser's
// entry does: under StrictMode, which mounts everything twice.
export function open(hash: string, handler?: Handler) {
  window.location.hash = hash;
  const service = serve(handler);
  const user = userEvent.setup();
  const view = render(<StrictMode><App /></StrictMode>);
  return { ...service, user, ...view };
}

// For a test that has to show that an answer changes nothing: there is no result to wait
// for. It takes the clock into its own hands before it opens the console, and `pass`
// then runs everything that is due, and whatever that makes due, until nothing is: the
// answer has gone as far as it ever will. With a time, the clock moves on that far.
export function holdClock(): void {
  vi.useFakeTimers({ shouldAdvanceTime: true });
}

export const pass = (ms = 0): Promise<void> => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

// The address bar, later on.
export async function go(hash: string): Promise<void> {
  await act(async () => {
    window.location.hash = hash;
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    window.dispatchEvent(new PopStateEvent('popstate'));
  });
}

export function deferred<T = unknown>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

// The stream the shell listens on.
export const shellStream = (): FakeEventSource => sources.findLast((source) => source.url === '/api/stream')!;
