import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { ThemeSkinPicker } from '@/components/theme-skin-picker';
import { applyThemeSkin } from '@/lib/theme';

describe('ThemeSkinPicker', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute('data-skin');
    applyThemeSkin('hud');
    vi.restoreAllMocks();
  });

  test('switches between all 9 built-in skins and persists data-skin attribute', async () => {
    const user = userEvent.setup();
    render(<ThemeSkinPicker />);

    await user.click(screen.getByRole('button', { name: '切换界面主题' }));
    const dialog = await screen.findByRole('dialog', { name: '界面主题与目录插件' });

    expect(within(dialog).getByRole('radio', { name: /测控星盘/ })).toHaveAttribute('aria-checked', 'true');

    for (const [label, id] of [
      [/信号橙工坊/, 'tactile'],
      [/星仪暗夜/, 'linear'],
      [/极光玻璃/, 'glass'],
      [/合成器控制台/, 'te'],
      [/燕麦书房/, 'paper'],
      [/琥珀暗房/, 'quant'],
      [/苏黎世墨印/, 'swiss'],
      [/天仪经典/, 'classic'],
    ] as const) {
      await user.click(within(dialog).getByRole('radio', { name: label }));
      expect(document.documentElement.getAttribute('data-skin')).toBe(id);
      expect(localStorage.getItem('tycho.skin')).toBe(id);
    }
  });

  test('imports a custom JSON theme pack, applies sanitized CSS variables, and allows deletion', async () => {
    const user = userEvent.setup();
    render(<ThemeSkinPicker />);

    await user.click(screen.getByRole('button', { name: '切换界面主题' }));
    const dialog = await screen.findByRole('dialog', { name: '界面主题与目录插件' });

    await user.click(within(dialog).getByRole('button', { name: '导入主题包' }));
    await user.click(within(dialog).getByRole('button', { name: '填入示例模板' }));
    await user.click(within(dialog).getByRole('button', { name: '安装并启用' }));

    await waitFor(() => {
      expect(within(dialog).getByRole('radio', { name: /翡翠终端/ })).toHaveAttribute('aria-checked', 'true');
    });
    expect(document.documentElement.getAttribute('data-skin')).toBe('custom');
    expect(document.documentElement.style.getPropertyValue('--primary')).toContain('#10B981');

    // Delete custom theme pack reverts cleanly to default hud
    await user.click(within(dialog).getByRole('button', { name: '删除主题 翡翠终端' }));
    await waitFor(() => {
      expect(within(dialog).queryByRole('radio', { name: /翡翠终端/ })).toBeNull();
    });
    expect(document.documentElement.getAttribute('data-skin')).toBeNull();
    expect(document.documentElement.style.getPropertyValue('--primary')).toBe('');
  });
});
