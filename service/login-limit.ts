// Anonymous device requests share the quota with failed link exchanges.
// A valid link is always checked first, independently of this quota.
// Keep at most a window's admitted failures, bounded by the total even under attack. The
// three numbers are settings (login.failWindowMs, login.failsPerSource, login.failsTotal),
// read at each use.
export interface LoginLimitPolicy {
  windowMs: () => number;
  perSource: () => number;
  total: () => number;
}

export function createLoginLimit(policy: LoginLimitPolicy, now: () => number = Date.now) {
  let failures: { at: number; source: string }[] = [];

  function recent(): { at: number; source: string }[] {
    failures = failures.filter(({ at }) => at > now() - policy.windowMs());
    return failures;
  }

  return {
    // True while failed replies for this source, or everyone together, are suppressed.
    closed(source: string): boolean {
      const kept = recent();
      return kept.length >= policy.total() || kept.filter((failure) => failure.source === source).length >= policy.perSource();
    },

    failed(source: string): void {
      recent().push({ at: now(), source });
    },
  };
}
