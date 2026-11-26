// A line diff for the owner to read a revision by: the longest run of lines both texts
// keep, and around it what went and what came. Removed lines come before the lines that
// took their place, as a reader expects of "was … now …".
export interface DiffLine {
  kind: 'same' | 'removed' | 'added';
  text: string;
}

const linesOf = (text: string): string[] => (text === '' ? [] : text.replace(/\r\n?/g, '\n').split('\n'));

export function diffLines(before: string, after: string): DiffLine[] {
  const a = linesOf(before);
  const b = linesOf(after);
  // kept[i][j]: how many lines a[i..] and b[j..] can keep in common.
  const kept = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      kept[i]![j] = a[i] === b[j] ? kept[i + 1]![j + 1]! + 1 : Math.max(kept[i + 1]![j]!, kept[i]![j + 1]!);
    }
  }
  const lines: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      lines.push({ kind: 'same', text: a[i]! });
      i += 1;
      j += 1;
    } else if (kept[i + 1]![j]! >= kept[i]![j + 1]!) {
      lines.push({ kind: 'removed', text: a[i]! });
      i += 1;
    } else {
      lines.push({ kind: 'added', text: b[j]! });
      j += 1;
    }
  }
  for (; i < a.length; i += 1) lines.push({ kind: 'removed', text: a[i]! });
  for (; j < b.length; j += 1) lines.push({ kind: 'added', text: b[j]! });
  return lines;
}
