import { afterEach, describe, expect, test } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { BUILTIN_EN_MESSAGES, BUILTIN_ZH_CN_MESSAGES } from '@shared/locales/index.ts';
import { registerLocalePack, replaceDirectoryLocalePacks, setActiveLocale, t } from '@shared/i18n.ts';
import { open } from '@/test/harness';

describe('hot-pluggable internationalization engine', () => {
  afterEach(() => {
    localStorage.removeItem('tycho.locale');
    replaceDirectoryLocalePacks([]);
    setActiveLocale('zh-CN');
    document.documentElement.lang = 'zh-CN';
    document.documentElement.dir = 'ltr';
  });

  test('built-in zh-CN and en JSON packs maintain exact key parity with non-empty values', () => {
    const zhKeys = Object.keys(BUILTIN_ZH_CN_MESSAGES).sort();
    const enKeys = Object.keys(BUILTIN_EN_MESSAGES).sort();
    expect(enKeys).toEqual(zhKeys);
    for (const key of zhKeys) {
      expect(BUILTIN_ZH_CN_MESSAGES[key as keyof typeof BUILTIN_ZH_CN_MESSAGES].trim().length, `zh-CN[${key}]`).toBeGreaterThan(0);
      expect(BUILTIN_EN_MESSAGES[key]!.trim().length, `en[${key}]`).toBeGreaterThan(0);
    }
  });

  test('hot-plugging a new language pack at runtime switches UI dynamically with automatic fallback', () => {
    registerLocalePack({
      id: 'ja',
      name: 'Japanese',
      nativeName: '日本語',
      shortLabel: 'JA',
      direction: 'ltr',
      fallback: 'en',
      messages: {
        'nav.overview': '概要',
        'nav.accounts': 'アカウント',
      },
    });
    setActiveLocale('ja');
    expect(t('nav.overview')).toBe('概要');
    expect(t('nav.accounts')).toBe('アカウント');
    // Unprovided key falls back cleanly to fallback ('en')
    expect(t('nav.machines')).toBe('Machines');
  });

  test('selecting English from the sidebar language menu switches UI chrome and persists ui.locale', async () => {
    const { user, calls } = open('#/', (call) => {
      if (call.method === 'PUT' && call.path === '/api/settings/ui.locale') return { ok: true };
      return undefined;
    });

    expect(await screen.findByRole('link', { name: '总览' })).toBeInTheDocument();
    expect(document.documentElement.lang).toBe('zh-CN');

    await user.click(screen.getByRole('button', { name: /切换语言|Switch language/ }));
    await user.click(await screen.findByRole('menuitem', { name: /English/ }));

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
