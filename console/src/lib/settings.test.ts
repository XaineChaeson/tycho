// Guards the list of logins a setting holds (the knowledge logins) against: its order lost
// between what the owner types and what is sent, an empty box sent as one empty name instead of
// "none named", the names shown as raw ids or as one run-together string, and an untouched
// list read as changed because two equal lists are two objects.
import { expect, test } from 'vitest';
import { sameSetting, settingField, settingShown, settingValue } from './settings.ts';
import type { Setting } from './types.ts';

const item: Setting = {
  key: 'knowledge.logins', group: '知识', title: '知识任务用哪些登录', help: '', type: 'logins', empty: '你所有的登录都能用',
  default: [], value: ['g2', 'h1/claude'], restart: false, stored: true, overridden: true, updated_at: null, updated_by: null,
};
const logins = [
  ...['g1', 'g2', 'g3'].map((name) => ({ id: name, name })),
  { id: 'h1/claude', name: 'h1/claude', machine: 'h1', executor: 'claude' },
];

test('a list of logins is typed in order, separated as people do, and sent in that order', () => {
  expect(settingField(item, item.value, logins)).toBe('g2, h1/claude');
  expect(settingValue(item, ' g2，h1/claude、g1  g3 ', logins)).toEqual(['g2', 'h1/claude', 'g1', 'g3']);
  expect(settingValue(item, '  ')).toEqual([]);
});

test('it is shown by the logins’ names, or by what an empty list means', () => {
  expect(settingShown(item, item.value, logins)).toBe('账号 g2、机器 h1 上的 claude 登录');
  expect(settingShown(item, [])).toBe('空（你所有的登录都能用）');
});

test('login names in the setting resolve to current ids and an unknown name is refused', () => {
  const current = [{ id: '01LOGINUID', name: '账号名字' }];
  expect(settingField(item, ['01LOGINUID'], current)).toBe('账号名字');
  expect(settingValue(item, '账号名字', current)).toEqual(['01LOGINUID']);
  expect(() => settingValue(item, '不存在', current)).toThrow('没有叫 不存在 的登录');
});

test('two equal lists are the same value', () => {
  expect(sameSetting(['a', 'b'], ['a', 'b'])).toBe(true);
  expect(sameSetting(['a', 'b'], ['b', 'a'])).toBe(false);
  expect(sameSetting(3, 3)).toBe(true);
});
