import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, beforeEach, vi } from 'vitest';
import { session } from '@/lib/api';
import { FakeEventSource, sources } from './harness.tsx';

export type { FakeEventSource };

beforeEach(() => {
  FakeEventSource.autoOpen = true;
  sources.length = 0;
  window.location.hash = '';
  // What one test told this browser to stop repeating is not another test's business.
  localStorage.clear();
  sessionStorage.clear();
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} }));
  vi.spyOn(session, 'toLogin').mockImplementation(() => {});
  Element.prototype.scrollIntoView = vi.fn();
  // jsdom lays nothing out, so nothing is ever resized: Radix's scroll area only observes.
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
});

afterEach(() => {
  cleanup();
  // A test that held the clock gives it back.
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
