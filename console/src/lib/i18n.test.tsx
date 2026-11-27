import { afterEach, describe, expect, test } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { zhCN } from '@/locales/zh-CN';
import { en } from '@/locales/en';
import { open } from '@/test/harness';

describe('internationalization (zh-CN / en)', () => {
  afterEach(() => {
    localStorage.removeItem('tycho.locale');
    document.documentElement.lang = 'zh-CN';
  });

  test('zh-CN and en dictionaries maintain exact key parity with non-empty values', () => {
    const zhKeys = Object.keys(zhCN).sort();
    const enKeys = Object.keys(en).sort();
    expect(enKeys).toEqual(zhKeys);
    for (const key of zhKeys) {
      expect(zhCN[key as keyof typeof zhCN].trim().length, `zhCN[${key}]`).toBeGreaterThan(0);
      expect(en[key as keyof typeof en].trim().length, `en[${key}]`).toBeGreaterThan(0);
    }
  });

  test('clicking the sidebar language toggle switches UI chrome to English and persists ui.locale', async () => {
    const { user, calls } = open('#/', (call) => {
      if (call.method === 'PUT' && call.path === '/api/settings/ui.locale') return { ok: true };
      return undefined;
    });

    // Starts in Simplified Chinese by default
    expect(await screen.findByRole('link', { name: '总览' })).toBeInTheDocument();
    expect(document.documentElement.lang).toBe('zh-CN');

    // Toggle to English
    await user.click(screen.getByRole('button', { name: /切换语言|Switch language/ }));

    expect(await screen.findByRole('link', { name: 'Overview' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Accounts' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Machines' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Settings' })).toBeInTheDocument();
    expect(document.documentElement.lang).toBe('en');
    expect(localStorage.getItem('tycho.locale')).toBe('en');

    await waitFor(() => {
      expect(calls).toContainEqual({
        path: '/api/settings/ui.locale',
        method: 'PUT',
        body: { value: 'en' },
      });
    });
  });

  test('server state.locale synchronizes console language on load', async () => {
    open('#/', (call) => {
      if (call.path === '/api/state') {
        return {
          locale: 'en',
          router: { alive: true, error: null, host_error: null, restarting: false, turn: null, projects: [] },
          dispatch: { degraded: false, recovering: false, paused: null },
          channels: { wecom: null },
          gateway: { state: 'off', since: null, error: null },
          launching_runs: [],
        };
      }
      return undefined;
    });

    expect(await screen.findByRole('link', { name: 'Overview' })).toBeInTheDocument();
    expect(document.documentElement.lang).toBe('en');
  });
});
