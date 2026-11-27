import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  DEFAULT_LOCALE,
  getActiveLocale,
  replaceDirectoryLocalePacks,
  setActiveLocale,
  t,
  validateLocalePack,
} from '../shared/i18n.ts';
import { localesDirOf } from '../service/locales.ts';
import { consoleApp } from './console-helpers.ts';

const json = async (response: Response): Promise<any> => response.json();

test('validateLocalePack enforces BCP-47 id, required metadata, non-empty messages, and prototype safety', () => {
  assert.equal(validateLocalePack(null).ok, false);
  assert.equal(validateLocalePack({ id: '../bad', name: 'Bad', nativeName: 'Bad', messages: { a: '1' } }).ok, false);
  assert.equal(validateLocalePack({ id: 'ja', name: '', nativeName: '', messages: { a: '1' } }).ok, false);
  assert.equal(validateLocalePack({ id: 'ja', name: 'Japanese', nativeName: '日本語', messages: {} }).ok, false);

  const valid = validateLocalePack({
    id: 'zh_tw',
    name: 'Chinese (Traditional)',
    nativeName: '繁體中文',
    fallback: 'zh-CN',
    messages: {
      'nav.overview': '總覽',
      __proto__: 'evil',
      constructor: 'evil',
    },
  });
  assert.equal(valid.ok, true);
  if (valid.ok) {
    assert.equal(valid.pack.id, 'zh-TW');
    assert.equal(valid.pack.fallback, 'zh-CN');
    assert.equal(valid.pack.messages['nav.overview'], '總覽');
    assert.equal(Object.prototype.hasOwnProperty.call(valid.pack.messages, '__proto__'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(valid.pack.messages, 'constructor'), false);
  }
});

test('hot-pluggable /api/locales supports upload, directory drop-in, template export, switching ui.locale, and deletion', async (tCtx) => {
  tCtx.after(() => {
    replaceDirectoryLocalePacks([]);
    setActiveLocale(DEFAULT_LOCALE);
  });

  const { f, get, send } = await consoleApp(tCtx);

  // 1. Lists built-in zh-CN and en packs out of the box.
  const initial = await json(await get('/api/locales'));
  assert.equal(initial.active, 'zh-CN');
  assert.ok(initial.locales.some((item: any) => item.id === 'zh-CN' && item.builtin === true));
  assert.ok(initial.locales.some((item: any) => item.id === 'en' && item.builtin === true));

  // 2. Template endpoint exports all canonical keys ready for translation.
  const template = await json(await get('/api/locales/template?base=en'));
  assert.equal(template.id, 'xx');
  assert.equal(template.messages['nav.overview'], 'Overview');

  // 3. POST /api/locales hot-plugs a brand-new Japanese pack into <dataDir>/locales/ja.json with zero restart.
  const uploaded = await send('POST', '/api/locales', {
    id: 'ja',
    name: 'Japanese',
    nativeName: '日本語',
    shortLabel: 'JA',
    fallback: 'en',
    messages: {
      'nav.overview': '概要',
      'nav.accounts': 'アカウント',
    },
  });
  assert.equal(uploaded.status, 200);
  const uploadBody = await json(uploaded);
  assert.equal(uploadBody.locale.id, 'ja');
  assert.equal(existsSync(join(localesDirOf(f.dir), 'ja.json')), true);

  // 4. GET /api/locales/ja resolves missing keys via fallback ('en').
  const jaDetail = await json(await get('/api/locales/ja'));
  assert.equal(jaDetail.resolved_messages['nav.overview'], '概要');
  assert.equal(jaDetail.resolved_messages['nav.machines'], 'Machines');

  // 5. PUT /api/settings/ui.locale accepts the hot-plugged locale ID and switches active runtime locale.
  const switched = await send('PUT', '/api/settings/ui.locale', { value: 'ja' });
  assert.equal(switched.status, 200);
  assert.equal(getActiveLocale(), 'ja');
  assert.equal(t('nav.overview'), '概要');
  assert.equal(t('nav.machines'), 'Machines');

  // 6. Direct filesystem drop-in into <dataDir>/locales/ko.json is immediately discovered by GET /api/locales.
  mkdirSync(localesDirOf(f.dir), { recursive: true });
  writeFileSync(
    join(localesDirOf(f.dir), 'ko.json'),
    JSON.stringify({
      id: 'ko',
      name: 'Korean',
      nativeName: '한국어',
      fallback: 'en',
      messages: { 'nav.overview': '개요' },
    }),
    'utf8',
  );
  const afterDrop = await json(await get('/api/locales'));
  assert.ok(afterDrop.locales.some((item: any) => item.id === 'ko' && item.builtin === false));

  // 7. Deleting an active custom pack removes the file and gracefully falls back.
  const removed = await send('DELETE', '/api/locales/ja');
  assert.equal(removed.status, 200);
  assert.equal(existsSync(join(localesDirOf(f.dir), 'ja.json')), false);
  const afterDelete = await json(await get('/api/locales'));
  assert.equal(afterDelete.locales.some((item: any) => item.id === 'ja'), false);
});
