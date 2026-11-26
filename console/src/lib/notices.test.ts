// Guards the advice an owner told this browser to stop repeating: a dismissal that is
// not kept, one that is counted twice, and a stored value from another version taken as
// a dismissal.
import { expect, test } from 'vitest';
import { hiddenNotices, hideNotice } from './notices.ts';

test('advice told to stop repeating stays told, once each', () => {
  expect(hiddenNotices().size).toBe(0);
  hideNotice('backup');
  hideNotice('backup');
  expect([...hiddenNotices()]).toEqual(['backup']);
  hideNotice('wecom');
  expect([...hiddenNotices()]).toEqual(['backup', 'wecom']);
});

test('what is not a list of names is read as nothing dismissed, not as a crash', () => {
  localStorage.setItem('tycho.notices.hidden', '不是 JSON');
  expect(hiddenNotices().size).toBe(0);
  localStorage.setItem('tycho.notices.hidden', '[1, "backup", null]');
  expect([...hiddenNotices()]).toEqual(['backup']);
});
