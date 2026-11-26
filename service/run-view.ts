import type { RunRow } from './ledger.ts';

// History keeps the name that this round actually used. Both the HTTP view and the
// Router's tools translate quota references here; the ledger's evidence stays untouched.
export function runErrorView(
  run: Pick<RunRow, 'error_json' | 'login_id' | 'login_name'>,
  currentName: (id: string) => string | undefined,
) {
  const error = run.error_json === null ? null : JSON.parse(run.error_json);
  if (error?.quota) {
    const quota = error.quota;
    const id = quota.login_id ?? run.login_id;
    const name = run.login_name ?? quota.login_name ?? (id === null ? undefined : currentName(id)) ?? '已删除的登录';
    quota.login_name = name;
    quota.login_id = name;
  }
  return error;
}
