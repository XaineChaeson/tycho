import { afterEach, describe, expect, test, vi } from 'vitest';
import { createRequestId } from './ids';

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe('createRequestId', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test('uses crypto.randomUUID when available', () => {
    const randomUUID = vi.fn(() => '11111111-2222-4333-8444-555555555555');
    vi.stubGlobal('crypto', { randomUUID });
    expect(createRequestId()).toBe('11111111-2222-4333-8444-555555555555');
    expect(randomUUID).toHaveBeenCalledTimes(1);
  });

  test('falls back to crypto.getRandomValues UUIDv4 on non-secure LAN HTTP contexts', () => {
    const getRandomValues = vi.fn((buf: Uint8Array) => {
      for (let i = 0; i < buf.length; i += 1) buf[i] = i + 1;
      return buf;
    });
    vi.stubGlobal('crypto', { getRandomValues });
    const id = createRequestId();
    expect(id).toMatch(UUID_V4_RE);
    expect(getRandomValues).toHaveBeenCalledTimes(1);
  });

  test('falls back to timestamp + random id when crypto is unavailable', () => {
    vi.stubGlobal('crypto', undefined);
    const id = createRequestId();
    expect(id).toMatch(/^req-[0-9a-z]+-[0-9a-z]+$/);
  });
});
