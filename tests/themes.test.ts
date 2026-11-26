import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { deleteDirectoryTheme, listDirectoryThemes, saveDirectoryTheme, themesDirOf } from '../service/themes.ts';

test('directory theme plugins: save, list, drop-in JSON, reject unsafe CSS & path traversal, and delete', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'tycho-themes-'));
  try {
    // Missing directory returns empty list cleanly
    assert.deepEqual(listDirectoryThemes(dataDir), []);

    // Save valid theme pack atomically
    const saved = saveDirectoryTheme(dataDir, {
      id: 'aurora-emerald',
      name: '翡翠极光',
      badge: 'EMERALD',
      description: '自建翡翠色主题',
      swatches: ['#060B09', '#0E1714', '#10B981'],
      tokens: {
        '--primary': 'light-dark(#047857, #10B981)',
        '--background': 'light-dark(#FFFFFF, #0D1613)',
        '--injected': 'url(javascript:alert(1))', // stripped by allowlist
      },
    });
    assert.equal(saved.ok, true);
    if (!saved.ok) return;
    assert.equal(saved.pack.id, 'aurora-emerald');
    assert.equal(saved.pack.file, 'aurora-emerald.json');
    assert.equal(saved.pack.tokens['--injected'], undefined);

    // Reject builtin name collision & CSS injection values
    const collision = saveDirectoryTheme(dataDir, { id: 'hud', name: '伪装', tokens: { '--primary': '#000' } });
    assert.equal(collision.ok, false);

    const unsafe = saveDirectoryTheme(dataDir, {
      id: 'bad-css',
      name: '恶意样式',
      tokens: { '--primary': 'red; background: url(https://evil.test)' },
    });
    assert.equal(unsafe.ok, false);

    // Drop-in malformed JSON file in themes dir is gracefully ignored
    writeFileSync(join(themesDirOf(dataDir), 'broken.json'), '{not-valid-json', 'utf8');
    // Drop-in valid JSON file without explicit id uses filename stem
    writeFileSync(
      join(themesDirOf(dataDir), 'tokyo-night.json'),
      JSON.stringify({ name: '东京夜色', tokens: { '--primary': '#7AA2F7' } }),
      'utf8',
    );

    const listed = listDirectoryThemes(dataDir);
    assert.deepEqual(listed.map((p) => p.id), ['aurora-emerald', 'tokyo-night']);
    assert.equal(listed[1]!.name, '东京夜色');

    // Path traversal deletion is rejected
    assert.equal(deleteDirectoryTheme(dataDir, '../outside'), false);
    assert.equal(deleteDirectoryTheme(dataDir, 'aurora-emerald'), true);
    assert.deepEqual(listDirectoryThemes(dataDir).map((p) => p.id), ['tokyo-night']);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
