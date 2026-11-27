import { t } from '@shared/i18n.ts';
import type { ProjectFileKind, ProjectFileSummary } from './types.ts';

// The answer goes with the error: a refusal can say more than its sentence, such as
// that it only wants to be asked again with consent.
export class ApiError extends Error {
  status: number;
  body: Record<string, unknown>;

  constructor(message: string, status: number, body: Record<string, unknown>) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

// Where an expired login sends the page. A member, so a test can stand in for it.
export const session = {
  toLogin(): void {
    window.location.assign('/login');
  },
};

export async function api<T = unknown>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  if (response.status === 401) {
    session.toLogin();
    throw new ApiError(t('core.api.loginRequired'), 401, {});
  }
  // Empty command acknowledgements are valid; every other successful API response
  // must really be JSON. A proxy page or truncated body is an error, not cached data.
  if (response.status === 204) return {} as T;
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    if (response.ok) throw new ApiError(t('core.api.unreadableResponse'), response.status, {});
  }
  if (!response.ok) {
    const detail = body !== null && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {};
    throw new ApiError(typeof detail.error === 'string' ? detail.error : t('core.api.requestFailed', { status: response.status }), response.status, detail);
  }
  return body as T;
}

const json = (method: string) => <T = unknown>(path: string, body: unknown = {}): Promise<T> =>
  api<T>(path, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

export const post = json('POST');
export const put = json('PUT');
export const del = <T = unknown>(path: string, body?: unknown): Promise<T> =>
  api<T>(path, body === undefined
    ? { method: 'DELETE' }
    : { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

export const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export function uploadProjectFile(
  projectId: string,
  file: File,
  options?: { kind?: ProjectFileKind; summary?: string },
): Promise<{ file: ProjectFileSummary }> {
  return api<{ file: ProjectFileSummary }>(`/api/projects/${encodeURIComponent(projectId)}/files`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      'X-File-Name': encodeURIComponent(file.name),
      ...(file.type ? { 'X-File-Mime': file.type } : {}),
      ...(options?.kind ? { 'X-File-Kind': options.kind } : {}),
      ...(options?.summary ? { 'X-File-Summary': encodeURIComponent(options.summary) } : {}),
    },
    body: file,
  });
}

export function projectFileRawUrl(projectId: string, fileId: string, download = false): string {
  const base = `/api/projects/${encodeURIComponent(projectId)}/files/${encodeURIComponent(fileId)}/raw`;
  return download ? `${base}?download=1` : base;
}
