// Guards the version a console page shows: a page packed for a release showing the
// checkout's major.minor, or calling itself a development build; a page built any other
// way (npm run build, the dev server, the tests) passing for a release.
import { expect, test } from 'vitest';
import { RELEASE_VERSION_ENV } from '../../shared/version.ts';
import { bakedVersion } from './build-version.ts';

test('a build the packer runs shows the release version it hands over, as it is', () => {
  expect(bakedVersion({ [RELEASE_VERSION_ENV]: '0.1.276' }, '0.1')).toBe('0.1.276');
});

test('any other build is the checkout: its major.minor, said to be a development build', () => {
  expect(bakedVersion({}, '0.1')).toBe('0.1 开发版');
  expect(bakedVersion({ [RELEASE_VERSION_ENV]: '' }, '0.1')).toBe('0.1 开发版');
  expect(bakedVersion({ TYCHO_VERSION: '0.0.1' }, '0.1')).toBe('0.1 开发版');
});
