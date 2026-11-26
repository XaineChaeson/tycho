// The advice the owner has told the console to stop repeating. Kept in this browser and
// nowhere else: it is not a fact about the service, and another browser may want it.
const KEY = 'tycho.notices.hidden';

function read(): string[] {
  try {
    const held = JSON.parse(localStorage.getItem(KEY) ?? '[]') as unknown;
    return Array.isArray(held) ? held.filter((each): each is string => typeof each === 'string') : [];
  } catch {
    return [];
  }
}

export const hiddenNotices = (): Set<string> => new Set(read());

export function hideNotice(id: string): void {
  try {
    localStorage.setItem(KEY, JSON.stringify([...new Set([...read(), id])]));
  } catch {
    // A browser that refuses storage repeats the advice; nothing else is lost.
  }
}
