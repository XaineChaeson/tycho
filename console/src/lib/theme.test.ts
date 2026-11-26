// Guards the browser's own colour choice: a choice that is not stored, one that pins the
// scheme without leaving the other behind, 跟随系统 not taking its mark off, and a value
// from another version read as a choice at all.
import { expect, test } from 'vitest';
import { applyTheme, readTheme, saveTheme } from './theme.ts';

test('跟随系统 is the absence of a choice; 浅色 and 深色 are stored in this browser', () => {
  expect(readTheme()).toBe('system');
  saveTheme('dark');
  expect(localStorage.getItem('tycho.theme')).toBe('dark');
  expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  expect(readTheme()).toBe('dark');
  saveTheme('light');
  expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  expect(localStorage.getItem('tycho.theme')).toBe('light');
});

test('going back to 跟随系统 takes the mark off, so the system decides again', () => {
  applyTheme('dark');
  document.documentElement.setAttribute('data-theme', 'dark');
  saveTheme('system');
  expect(localStorage.getItem('tycho.theme')).toBeNull();
  expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
  expect(readTheme()).toBe('system');
});

test('a value this version does not know reads as 跟随系统', () => {
  localStorage.setItem('tycho.theme', 'sepia');
  expect(readTheme()).toBe('system');
});
