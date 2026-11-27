// CI internationalization hygiene gate (`npm run check:i18n`):
// 1. Validates all built-in JSON language packs in `shared/locales/{zh-CN,en}/*.json`:
//    - identical namespace files & exact key parity
//    - non-empty string values
//    - matching `{placeholder}` variables across locales
//    - zero duplicate keys across namespace files within a locale
// 2. Lexes TypeScript / TSX source files in `shared/` and `console/src/` (ignoring comments,
//    tests, test fixtures, `shared/locales/`, and explicit `i18n-ignore` lines) to reject:
//    - hardcoded CJK UI copy in string literals, template literals, and JSX text
//    - forbidden inline dual-language helpers `bi(...)` and `pickLocale(...)`
//
// Usage:
//   node scripts/check-i18n.ts [--summary] [path1 path2 ...]
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const LOCALES_ROOT = join(ROOT, 'shared', 'locales');
const BUILTIN_LOCALES = ['zh-CN', 'en'] as const;
const CJK_RE = /[\u4e00-\u9fff]/;
const PLACEHOLDER_RE = /\{([a-zA-Z0-9_]+)\}/g;
const ALLOW_DIRECTIVE = 'i18n-ignore';

interface Violation {
  file: string;
  line: number;
  kind: 'hardcoded-cjk' | 'forbidden-bi' | 'pack-error';
  message: string;
}

function placeholdersOf(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(PLACEHOLDER_RE)) {
    if (match[1]) found.add(match[1]);
  }
  return [...found].sort();
}

function validateBuiltinPacks(violations: Violation[]): Set<string> {
  const byLocale = new Map<string, Map<string, { value: string; file: string }>>();
  const namespacesByLocale = new Map<string, string[]>();

  for (const locale of BUILTIN_LOCALES) {
    const dir = join(LOCALES_ROOT, locale);
    const files = readdirSync(dir)
      .filter((name) => name.endsWith('.json'))
      .sort();
    namespacesByLocale.set(locale, files);
    const map = new Map<string, { value: string; file: string }>();
    byLocale.set(locale, map);

    for (const file of files) {
      const fullPath = join(dir, file);
      const rel = relative(ROOT, fullPath).replace(/\\/g, '/');
      let parsed: unknown;
      try {
        parsed = JSON.parse(readFileSync(fullPath, 'utf8'));
      } catch (err) {
        violations.push({
          file: rel,
          line: 1,
          kind: 'pack-error',
          message: `Invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
        });
        continue;
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        violations.push({ file: rel, line: 1, kind: 'pack-error', message: 'Namespace file must be a JSON object.' });
        continue;
      }
      for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof value !== 'string') {
          violations.push({ file: rel, line: 1, kind: 'pack-error', message: `Key "${key}" must map to a string.` });
          continue;
        }
        if (value.trim() === '') {
          violations.push({ file: rel, line: 1, kind: 'pack-error', message: `Key "${key}" cannot be empty.` });
          continue;
        }
        const prev = map.get(key);
        if (prev) {
          violations.push({
            file: rel,
            line: 1,
            kind: 'pack-error',
            message: `Duplicate key "${key}" (already defined in ${prev.file}).`,
          });
          continue;
        }
        map.set(key, { value, file: rel });
      }
    }
  }

  const canonicalLocale = BUILTIN_LOCALES[0];
  const canonicalNamespaces = namespacesByLocale.get(canonicalLocale) ?? [];
  const canonicalMap = byLocale.get(canonicalLocale) ?? new Map();

  for (const locale of BUILTIN_LOCALES.slice(1)) {
    const ns = namespacesByLocale.get(locale) ?? [];
    if (JSON.stringify(ns) !== JSON.stringify(canonicalNamespaces)) {
      violations.push({
        file: `shared/locales/${locale}`,
        line: 1,
        kind: 'pack-error',
        message: `Namespace files mismatch: expected [${canonicalNamespaces.join(', ')}], got [${ns.join(', ')}].`,
      });
    }
    const targetMap = byLocale.get(locale) ?? new Map();
    for (const [key, entry] of canonicalMap) {
      const other = targetMap.get(key);
      if (!other) {
        violations.push({
          file: `shared/locales/${locale}`,
          line: 1,
          kind: 'pack-error',
          message: `Missing translation key "${key}" (defined in ${entry.file}).`,
        });
        continue;
      }
      const p1 = placeholdersOf(entry.value);
      const p2 = placeholdersOf(other.value);
      if (JSON.stringify(p1) !== JSON.stringify(p2)) {
        violations.push({
          file: other.file,
          line: 1,
          kind: 'pack-error',
          message: `Placeholder mismatch for "${key}": ${canonicalLocale} has {${p1.join(', ')}} but ${locale} has {${p2.join(', ')}}.`,
        });
      }
    }
    for (const [key, other] of targetMap) {
      if (!canonicalMap.has(key)) {
        violations.push({
          file: other.file,
          line: 1,
          kind: 'pack-error',
          message: `Extra key "${key}" not present in canonical ${canonicalLocale} pack.`,
        });
      }
    }
  }

  return new Set(canonicalMap.keys());
}

function collectSourceFiles(targets: readonly string[]): string[] {
  const out: string[] = [];
  function walk(targetPath: string): void {
    const stat = statSync(targetPath, { throwIfNoEntry: false });
    if (!stat) return;
    if (stat.isFile()) {
      const rel = relative(ROOT, targetPath).replace(/\\/g, '/');
      if (!/\.(ts|tsx)$/.test(rel)) return;
      if (/\.test\.tsx?$/.test(rel)) return;
      if (rel.startsWith('shared/locales/')) return;
      if (rel.startsWith('console/src/test/')) return;
      if (rel.startsWith('console/e2e/')) return;
      out.push(targetPath);
      return;
    }
    if (!stat.isDirectory()) return;
    for (const entry of readdirSync(targetPath, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.git') continue;
      walk(join(targetPath, entry.name));
    }
  }
  for (const target of targets) {
    walk(resolve(ROOT, target));
  }
  return out.sort();
}

// Strips // and /* */ comments (including JSX {/* ... */}) while preserving exact line count
// and keeping strings, templates, and regex literals intact so line numbers map 1:1 back.
const REGEX_PREV_CHAR_RE = /[=([,:;!&|?{}~^+\-*%<>]/;
const REGEX_PREV_WORD_RE = /^(?:return|case|throw|in|of|typeof|void|delete|await|yield|else|do)$/;

function stripCommentsPreserveLines(source: string): string {
  const out: string[] = [];
  let i = 0;
  const n = source.length;
  let state: 'code' | 'single' | 'double' | 'template' | 'regex' | 'line-comment' | 'block-comment' = 'code';
  let regexInClass = false;
  let lastNonWs = '';
  let lastWord = '';
  const templateBraceDepth: number[] = [];

  while (i < n) {
    const ch = source[i]!;
    const next = i + 1 < n ? source[i + 1]! : '';

    if (state === 'line-comment') {
      if (ch === '\n') {
        out.push('\n');
        state = 'code';
      } else {
        out.push(' ');
      }
      i += 1;
      continue;
    }

    if (state === 'block-comment') {
      if (ch === '*' && next === '/') {
        out.push('  ');
        i += 2;
        state = 'code';
      } else {
        out.push(ch === '\n' ? '\n' : ' ');
        i += 1;
      }
      continue;
    }

    if (state === 'regex') {
      out.push(ch);
      if (ch === '\\' && next && next !== '\n') {
        out.push(next);
        i += 2;
        continue;
      }
      if (ch === '[' && !regexInClass) {
        regexInClass = true;
      } else if (ch === ']' && regexInClass) {
        regexInClass = false;
      } else if ((ch === '/' && !regexInClass) || ch === '\n') {
        state = 'code';
        regexInClass = false;
        lastNonWs = '/';
        lastWord = '';
      }
      i += 1;
      continue;
    }

    if (state === 'single' || state === 'double') {
      const quote = state === 'single' ? "'" : '"';
      out.push(ch);
      if (ch === '\\' && next) {
        out.push(next);
        i += 2;
        continue;
      }
      if (ch === quote || ch === '\n') {
        state = 'code';
        lastNonWs = quote;
        lastWord = '';
      }
      i += 1;
      continue;
    }

    if (state === 'template') {
      out.push(ch);
      if (ch === '\\' && next) {
        out.push(next);
        i += 2;
        continue;
      }
      if (ch === '$' && next === '{') {
        out.push('{');
        i += 2;
        templateBraceDepth.push(1);
        state = 'code';
        lastNonWs = '{';
        lastWord = '';
        continue;
      }
      if (ch === '`') {
        state = 'code';
        lastNonWs = '`';
        lastWord = '';
      }
      i += 1;
      continue;
    }

    // state === 'code'
    if (ch === '/' && next === '/') {
      out.push('  ');
      i += 2;
      state = 'line-comment';
      continue;
    }
    if (ch === '/' && next === '*') {
      out.push('  ');
      i += 2;
      state = 'block-comment';
      continue;
    }
    if (
      ch === '/'
      && next !== '/'
      && next !== '*'
      && (lastNonWs === '' || REGEX_PREV_CHAR_RE.test(lastNonWs) || REGEX_PREV_WORD_RE.test(lastWord))
    ) {
      out.push(ch);
      state = 'regex';
      regexInClass = false;
      i += 1;
      continue;
    }
    if (ch === "'") {
      out.push(ch);
      state = 'single';
      i += 1;
      continue;
    }
    if (ch === '"') {
      out.push(ch);
      state = 'double';
      i += 1;
      continue;
    }
    if (ch === '`') {
      out.push(ch);
      state = 'template';
      i += 1;
      continue;
    }
    if (templateBraceDepth.length > 0) {
      if (ch === '{') {
        templateBraceDepth[templateBraceDepth.length - 1]! += 1;
      } else if (ch === '}') {
        templateBraceDepth[templateBraceDepth.length - 1]! -= 1;
        if (templateBraceDepth[templateBraceDepth.length - 1] === 0) {
          templateBraceDepth.pop();
          out.push(ch);
          state = 'template';
          i += 1;
          continue;
        }
      }
    }
    if (/[a-zA-Z0-9_$]/.test(ch)) {
      lastWord = /[a-zA-Z0-9_$]/.test(lastNonWs) ? `${lastWord}${ch}` : ch;
      lastNonWs = ch;
    } else if (!/\s/.test(ch)) {
      lastWord = '';
      lastNonWs = ch;
    }
    out.push(ch);
    i += 1;
  }

  return out.join('');
}

const FORBIDDEN_HELPER_RE = /\b(bi|pickLocale)\s*\(/;

function scanSourceFile(fullPath: string, violations: Violation[]): void {
  const raw = readFileSync(fullPath, 'utf8');
  const rawLines = raw.split('\n');
  const stripped = stripCommentsPreserveLines(raw);
  const codeLines = stripped.split('\n');
  const rel = relative(ROOT, fullPath).replace(/\\/g, '/');

  for (let idx = 0; idx < codeLines.length; idx += 1) {
    const line = codeLines[idx]!;
    const rawLine = rawLines[idx] ?? '';
    const prevRawLine = idx > 0 ? (rawLines[idx - 1] ?? '') : '';
    if (rawLine.includes(ALLOW_DIRECTIVE) || prevRawLine.includes(ALLOW_DIRECTIVE)) continue;

    const helperMatch = FORBIDDEN_HELPER_RE.exec(line);
    if (helperMatch) {
      violations.push({
        file: rel,
        line: idx + 1,
        kind: 'forbidden-bi',
        message: `Forbidden hardcoded bilingual helper "${helperMatch[1]}(...)": use t('key', params) with JSON language packs.`,
      });
    }

    if (CJK_RE.test(line)) {
      const trimmed = line.trim();
      const snippet = trimmed.length > 64 ? `${trimmed.slice(0, 63)}…` : trimmed;
      violations.push({
        file: rel,
        line: idx + 1,
        kind: 'hardcoded-cjk',
        message: `Hardcoded CJK UI string in code: ${snippet}`,
      });
    }
  }
}

const args = process.argv.slice(2);
const strictSummaryOnly = args.includes('--summary');
const pathArgs = args.filter((arg) => !arg.startsWith('--'));
const scanTargets = pathArgs.length > 0 ? pathArgs : ['shared', 'console/src'];

const violations: Violation[] = [];
const canonicalKeys = validateBuiltinPacks(violations);
const files = collectSourceFiles(scanTargets);
for (const file of files) {
  scanSourceFile(file, violations);
}

if (violations.length === 0) {
  console.log(`i18n check PASSED: ${canonicalKeys.size} canonical key(s) verified across ${BUILTIN_LOCALES.join(', ')}; ${files.length} source file(s) scanned with 0 hardcoded CJK / bi() violations.`);
  process.exit(0);
}

const byFile = new Map<string, number>();
for (const v of violations) {
  byFile.set(v.file, (byFile.get(v.file) ?? 0) + 1);
}

if (strictSummaryOnly) {
  const sorted = [...byFile.entries()].sort((a, b) => b[1] - a[1]);
  console.error(`i18n check FAILED: ${violations.length} violation(s) across ${sorted.length} file(s):`);
  for (const [file, count] of sorted) {
    console.error(`  ${String(count).padStart(4)}  ${file}`);
  }
} else {
  console.error(`i18n check FAILED: ${violations.length} violation(s) across ${byFile.size} file(s):`);
  for (const v of violations.slice(0, 120)) {
    console.error(`  ${v.file}:${v.line} [${v.kind}] ${v.message}`);
  }
  if (violations.length > 120) {
    console.error(`  ... and ${violations.length - 120} more (pass --summary or specific file paths).`);
  }
}
process.exit(1);
