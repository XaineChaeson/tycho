// The Router's preference for one Task (docs/design/roles-and-tiers.md §11): a few logins to
// try first, in the order named, and why. It narrows nothing: the project's list still says
// which logins the Task may use, and the tier's global order is what it falls back to.
// Referenced by ledger id; names belong only to the tool boundary and the pages.
export interface TaskPrefer {
  login_ids: string[];
  reason: string;
}

// A stored preference as the service reads it. A value written by an older program, or one
// whose shape is not this one, says nothing: the Task falls back to the tier's order.
export function parseTaskPrefer(json: string | null | undefined): TaskPrefer | null {
  if (json === null || json === undefined || json === '') return null;
  try {
    const raw = JSON.parse(json) as { login_ids?: unknown; reason?: unknown };
    const ids = raw.login_ids;
    if (!Array.isArray(ids) || ids.length === 0 || ids.some((id) => typeof id !== 'string' || id === '')) return null;
    return { login_ids: [...new Set(ids as string[])], reason: typeof raw.reason === 'string' ? raw.reason : '' };
  } catch {
    return null;
  }
}

// Which of the three groups placed a Run (roles-and-tiers.md §11.3). `same_executor` is a
// review's degraded fallback; it is not one of the ordinary groups.
export type PlacedBy = 'prefer' | 'spread' | 'order' | 'pinned' | 'same_executor';
