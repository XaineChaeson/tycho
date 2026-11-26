// Guards the line diff the owner reads before approving a revision against: a line that
// stayed being shown as removed and added again; a changed line shown only as its new
// text, hiding what it replaced; lines reordered or lost, so that the old or the new text
// cannot be read back from the diff; an empty side drawn as one empty line; and Windows
// line ends making every line differ.
import { expect, test } from 'vitest';
import { diffLines, type DiffLine } from './line-diff.ts';

const before = (lines: DiffLine[]): string => lines.filter((line) => line.kind !== 'added').map((line) => line.text).join('\n');
const after = (lines: DiffLine[]): string => lines.filter((line) => line.kind !== 'removed').map((line) => line.text).join('\n');

test('lines that stayed are the same, a changed line is its old text removed and its new text added', () => {
  expect(diffLines('结论\n依据：一次\n边界', '结论\n依据：三次\n边界')).toEqual([
    { kind: 'same', text: '结论' },
    { kind: 'removed', text: '依据：一次' },
    { kind: 'added', text: '依据：三次' },
    { kind: 'same', text: '边界' },
  ]);
});

test('either text can be read back from the diff, whatever moved', () => {
  const old = 'a\nb\nc\nd\ne';
  const next = 'b\nx\nd\ne\nf\na';
  const lines = diffLines(old, next);
  expect(before(lines)).toBe(old);
  expect(after(lines)).toBe(next);
  // As few lines changed as the two texts allow: b, d and e are kept.
  expect(lines.filter((line) => line.kind === 'same').map((line) => line.text)).toEqual(['b', 'd', 'e']);
});

test('an empty side has no lines, and line ends do not count as a difference', () => {
  expect(diffLines('', '新的一行')).toEqual([{ kind: 'added', text: '新的一行' }]);
  expect(diffLines('旧的一行', '')).toEqual([{ kind: 'removed', text: '旧的一行' }]);
  expect(diffLines('', '')).toEqual([]);
  expect(diffLines('一\r\n二', '一\n二')).toEqual([{ kind: 'same', text: '一' }, { kind: 'same', text: '二' }]);
});
