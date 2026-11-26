import { loginName } from '@shared/logins.ts';
import type { Setting } from './types.ts';

const UNITS = { seconds: { ms: 1_000, label: '秒' }, minutes: { ms: 60_000, label: '分钟' }, hours: { ms: 3_600_000, label: '小时' } } as const;
const NUMBERS = ['duration', 'integer', 'port'];

export const isNumber = (item: Setting): boolean => NUMBERS.includes(item.type);
const unitOf = (item: Setting) => UNITS[item.unit ?? 'minutes'];
export type LoginChoice = { id: string; name: string; machine?: string; executor?: string; accountLabel?: string | null; routeLabel?: string | null };

// What the owner reads and types is in the item's own unit; the service speaks milliseconds.
export function settingShown(item: Setting, value: Setting['value'], logins: readonly LoginChoice[] = []): string {
  if (item.type === 'duration') return `${Number(value) / unitOf(item).ms} ${unitOf(item).label}`;
  if (item.type === 'boolean') return value ? '开' : '关';
  if (Array.isArray(value)) return value.length === 0 ? `空（${item.empty ?? '关闭'}）` : value.map((id) => {
    const login = logins.find((each) => each.id === id);
    return login ? loginName(login) : '已删除的登录';
  }).join('、');
  if (item.key === 'router.account' && value !== '') {
    const login = logins.find(({ id }) => id === value);
    return login ? (login.machine ? loginName(login) : login.name) : '已删除的账号';
  }
  return value === '' ? `空（${item.empty ?? '关闭'}）` : String(value);
}

// A list of logins is typed as names in order, separated by commas or blanks.
export function settingField(item: Setting, value: Setting['value'], logins: readonly LoginChoice[] = []): string {
  if (item.type === 'duration') return String(Number(value) / unitOf(item).ms);
  if (Array.isArray(value)) return value.map((id) => logins.find((each) => each.id === id)?.name ?? '已删除的登录').join(', ');
  return String(value);
}

// What cannot be read as a number goes as typed, for the service to refuse in its own words.
export function settingValue(item: Setting, field: string, logins: readonly LoginChoice[] = []): Setting['value'] {
  if (item.type === 'boolean') return field === 'true';
  if (item.type === 'logins') return field.split(/[\s,，、]+/).filter((name) => name !== '').map((name) => {
    const login = logins.find((each) => each.name === name);
    if (!login) throw new Error(`没有叫 ${name} 的登录：请填写当前账号或机器登录的名字`);
    return login.id;
  });
  if (!isNumber(item)) return field;
  const number = field.trim() === '' ? NaN : Number(field);
  if (Number.isNaN(number)) return field;
  return item.type === 'duration' ? Math.round(number * unitOf(item).ms) : number;
}

// Whether two values of an item are the same: a list is equal to another with the same names in order.
export const sameSetting = (a: Setting['value'], b: Setting['value']): boolean => JSON.stringify(a) === JSON.stringify(b);

export const unitLabel = (item: Setting): string | null => (item.type === 'duration' ? unitOf(item).label : null);
