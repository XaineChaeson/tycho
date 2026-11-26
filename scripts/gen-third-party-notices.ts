// Generates THIRD_PARTY_NOTICES.txt deterministically from console/package-lock.json
// and desktop/src-tauri/Cargo.lock (when present).
//
// Usage:
//   node scripts/gen-third-party-notices.ts           # write THIRD_PARTY_NOTICES.txt
//   node scripts/gen-third-party-notices.ts --check   # verify THIRD_PARTY_NOTICES.txt is up to date
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isEntry } from '../service/entry.ts';

interface LockPackage {
  version?: string;
  license?: string;
  dev?: boolean;
}

interface PackageEntry {
  name: string;
  version: string;
  license: string;
}

interface CargoEntry {
  name: string;
  version: string;
}

// Known upstream licenses for lockfile entries whose package-lock metadata omits "license".
const KNOWN_NPM_LICENSES: Record<string, string> = {
  khroma: 'MIT',
};

function packageNameFromLockKey(key: string): string {
  const marker = 'node_modules/';
  const last = key.lastIndexOf(marker);
  return last === -1 ? key : key.slice(last + marker.length);
}

function readConsoleProdDeps(root: string): PackageEntry[] {
  const lockPath = join(root, 'console', 'package-lock.json');
  if (!existsSync(lockPath)) return [];
  const lock = JSON.parse(readFileSync(lockPath, 'utf8')) as { packages?: Record<string, LockPackage> };
  const packages = lock.packages ?? {};
  const seen = new Map<string, PackageEntry>();
  for (const [key, pkg] of Object.entries(packages)) {
    if (!key || pkg.dev === true) continue;
    const name = packageNameFromLockKey(key);
    const version = pkg.version ?? '0.0.0';
    const license = pkg.license ?? KNOWN_NPM_LICENSES[name] ?? 'UNKNOWN';
    const id = `${name}@${version}`;
    if (!seen.has(id)) {
      seen.set(id, { name, version, license });
    }
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name, 'en') || a.version.localeCompare(b.version, 'en'));
}

function readCargoCrates(root: string): CargoEntry[] {
  const lockPath = join(root, 'desktop', 'src-tauri', 'Cargo.lock');
  if (!existsSync(lockPath)) return [];
  const raw = readFileSync(lockPath, 'utf8');
  const seen = new Map<string, CargoEntry>();
  const blocks = raw.split(/^\[\[package\]\]\s*$/m).slice(1);
  for (const block of blocks) {
    const nameMatch = /^name\s*=\s*"([^"]+)"/m.exec(block);
    const versionMatch = /^version\s*=\s*"([^"]+)"/m.exec(block);
    if (!nameMatch || !versionMatch) continue;
    const name = nameMatch[1]!;
    const version = versionMatch[1]!;
    if (name === 'tycho-desktop') continue;
    const id = `${name}@${version}`;
    if (!seen.has(id)) {
      seen.set(id, { name, version });
    }
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name, 'en') || a.version.localeCompare(b.version, 'en'));
}

export function generateThirdPartyNotices(root: string): string {
  const npmDeps = readConsoleProdDeps(root);
  const cargoCrates = readCargoCrates(root);

  const licenseCounts = new Map<string, number>();
  for (const dep of npmDeps) {
    licenseCounts.set(dep.license, (licenseCounts.get(dep.license) ?? 0) + 1);
  }
  const summaryLines = [...licenseCounts.entries()]
    .sort((a, b) => a[0].localeCompare(b[0], 'en'))
    .map(([license, count]) => `  - ${license}: ${count}`);

  const oflFonts = npmDeps.filter((dep) => dep.license === 'OFL-1.1');
  const eplDeps = npmDeps.filter((dep) => dep.license.includes('EPL-2.0'));

  const sections: string[] = [
    '================================================================================',
    'TYCHO THIRD-PARTY SOFTWARE NOTICES AND INFORMATION',
    '================================================================================',
    '',
    'Tycho is licensed under the MIT License (see LICENSE).',
    'This file lists third-party components bundled into Tycho releases (the built',
    'web console in console/dist/ and, for desktop builds, the Tauri desktop shell)',
    'along with applicable license notices.',
    '',
    'Generated deterministically by: node scripts/gen-third-party-notices.ts',
    '',
    '--------------------------------------------------------------------------------',
    '1. KEY LICENSE NOTICES FOR BUNDLED ASSETS & DEPENDENCIES',
    '--------------------------------------------------------------------------------',
    '',
    '### SIL Open Font License 1.1 (OFL-1.1) — Bundled Fonts',
    '',
    'The Tycho web console bundles the following variable font packages under the',
    'SIL Open Font License, Version 1.1:',
    ...oflFonts.map((dep) => `  - ${dep.name}@${dep.version}`),
    '',
    '  - Inter: Copyright (c) The Inter Project Authors (https://github.com/rsms/inter)',
    '  - JetBrains Mono: Copyright (c) JetBrains s.r.o. (https://www.jetbrains.com/lp/mono/)',
    '  - Noto Sans SC: Copyright (c) Google LLC / Adobe Systems Incorporated',
    '',
    'Permission is hereby granted, free of charge, to any person obtaining a copy',
    'of the Font Software, to use, study, copy, merge, embed, modify, redistribute,',
    'and sell modified and unmodified copies of the Font Software, subject to the',
    'following conditions:',
    '  1) Neither the Font Software nor any of its individual components, in',
    '     Original or Modified Versions, may be sold by itself.',
    '  2) Original or Modified Versions of the Font Software may be bundled,',
    '     redistributed and/or sold with any software, provided that each copy',
    '     contains the above copyright notice and this license.',
    '  3) No Modified Version of the Font Software may use the Reserved Font',
    '     Name(s) unless explicit written permission is granted by the Copyright',
    '     Holder.',
    '  4) The name(s) of the Copyright Holder(s) or the Author(s) of the Font',
    '     Software shall not be used to promote, endorse or advertise any Modified',
    '     Version, except to acknowledge the contribution(s) of the Copyright',
    '     Holder(s) and the Author(s) or with their explicit written permission.',
    '  5) The Font Software, modified or unmodified, in part or in whole, must be',
    '     distributed entirely under this license, and must not be distributed',
    '     under any other license.',
    'Full license text: https://openfontlicense.org/open-font-license-official-text/',
    '',
    '### Eclipse Public License 2.0 (EPL-2.0)',
    '',
    'The following bundled dependencies are dual-licensed under EPL-2.0 and elected',
    'by Tycho under the Eclipse Public License 2.0:',
    ...eplDeps.map((dep) => `  - ${dep.name}@${dep.version} (${dep.license})`),
    'Source code for elkjs is available at: https://github.com/kieler/elkjs',
    'Full license text: https://www.eclipse.org/legal/epl-2.0/',
    '',
    '### Apache License 2.0',
    '',
    'Dependencies licensed under Apache-2.0 (including dual-licensed packages such as',
    'dompurify under MPL-2.0 OR Apache-2.0, elected under Apache-2.0) are distributed',
    'in accordance with the Apache License, Version 2.0:',
    'https://www.apache.org/licenses/LICENSE-2.0',
    '',
    '### MIT / ISC / BSD / 0BSD / Unlicense',
    '',
    'All remaining bundled JavaScript/CSS dependencies are distributed under',
    'permissive licenses (MIT, ISC, BSD-2-Clause, BSD-3-Clause, 0BSD, Unlicense).',
    'Full upstream copyright and permission notices are preserved in each upstream',
    'package repository and in the MIT-licensed release bundle:',
    '  Permission is hereby granted, free of charge, to any person obtaining a copy',
    '  of this software and associated documentation files (the "Software"), to deal',
    '  in the Software without restriction, including without limitation the rights',
    '  to use, copy, modify, merge, publish, distribute, sublicense, and/or sell',
    '  copies of the Software, and to permit persons to whom the Software is',
    '  furnished to do so, subject to the following conditions:',
    '  The above copyright notice and this permission notice shall be included in all',
    '  copies or substantial portions of the Software.',
    '  THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR',
    '  IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,',
    '  FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.',
    '',
    '--------------------------------------------------------------------------------',
    `2. BUNDLED WEB CONSOLE PRODUCTION DEPENDENCIES (${npmDeps.length} packages)`,
    '--------------------------------------------------------------------------------',
    '',
    'License breakdown:',
    ...summaryLines,
    '',
    ...npmDeps.map((dep) => `${dep.name}@${dep.version} — ${dep.license}`),
  ];

  if (cargoCrates.length > 0) {
    sections.push(
      '',
      '--------------------------------------------------------------------------------',
      `3. DESKTOP SHELL (TAURI / RUST) DEPENDENCIES (${cargoCrates.length} crates)`,
      '--------------------------------------------------------------------------------',
      '',
      'Pinned in desktop/src-tauri/Cargo.lock (predominantly MIT / Apache-2.0):',
      '',
      ...cargoCrates.map((crate) => `${crate.name}@${crate.version}`),
    );
  }

  sections.push('');
  return sections.join('\n');
}

if (isEntry(import.meta.filename)) {
  const root = join(import.meta.dirname, '..');
  const outPath = join(root, 'THIRD_PARTY_NOTICES.txt');
  const check = process.argv.includes('--check');
  const generated = generateThirdPartyNotices(root);
  if (check) {
    const existing = existsSync(outPath) ? readFileSync(outPath, 'utf8').replace(/\r\n/g, '\n') : '';
    if (existing !== generated) {
      console.error('THIRD_PARTY_NOTICES.txt is out of date. Run: node scripts/gen-third-party-notices.ts');
      process.exit(1);
    }
    console.log('THIRD_PARTY_NOTICES.txt is up to date.');
  } else {
    writeFileSync(outPath, generated, 'utf8');
    console.log(`Wrote ${outPath}`);
  }
}
