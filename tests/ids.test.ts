// Guards against: malformed ids and ids that do not sort by creation order,
// which would break "latest first" reads of the ledger.
import './guard.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ulid } from '../service/ids.ts';

test('ulid is 26 Crockford base32 characters', () => {
  assert.match(ulid(), /^[0-9A-HJKMNP-TV-Z]{26}$/);
});

test('ulid encodes time in its prefix', () => {
  const earlier = ulid(Date.now() + 1000);
  const later = ulid(Date.now() + 5000);
  assert.ok(earlier.slice(0, 10) < later.slice(0, 10));
});

test('ids generated in one burst stay strictly ordered and unique', () => {
  const ids = Array.from({ length: 2000 }, () => ulid());
  assert.deepEqual([...ids].sort(), ids);
  assert.equal(new Set(ids).size, ids.length);
});
