#!/usr/bin/env node
/**
 * Mechanical Open-Source Hygiene Gate for Tycho.
 *
 * Zero-dependency Node 24 TypeScript script (`node scripts/check-oss-hygiene.ts`):
 *   1. Scans tracked text files (`git ls-files -z`) for personal/internal leaks.
 *   2. Scans non-test tracked text files for real private key headers or live secret tokens.
 *   3. Verifies root `LICENSE` and `THIRD_PARTY_NOTICES.txt` exist (error under `--strict`
 *      or by default; pass `--warn-notices` to downgrade missing notice files to warnings).
 *   4. Verifies all relative Markdown links in `README.md`, `README.zh-CN.md`,
 *      `docs/guide/*.md`, and `docs/reference/*.md` resolve to existing files.
 *
 * Exits 0 on clean pass, 1 with file:line diagnostics on failure.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SELF_REL = 'scripts/check-oss-hygiene.ts';

interface PatternRule {
  readonly name: string;
  readonly regex: RegExp;
  readonly skipTests?: boolean;
}

const FORBIDDEN_PATTERNS: readonly PatternRule[] = [
  { name: 'personal-name', regex: /wanzhong/i },
  { name: 'personal-handle', regex: /xuewz/i },
  { name: 'workstation-host', regex: /DP-DM-XUEWZ/i },
  { name: 'private-linux-host', regex: /xaineubuntu/i },
  { name: 'private-domain', regex: /xainechaeson\.top/i },
  { name: 'personal-email', regex: /xainechaeson@/i },
  { name: 'internal-org-ivocap', regex: /ivocap/i },
  { name: 'internal-domain-tianyan', regex: /tianyancapital/i },
  { name: 'internal-tool-quantumlab', regex: /quantumlab/i },
  { name: 'internal-plugin-repo', regex: /team-skills/i },
  { name: 'internal-gateway-id', regex: /tylocal/i },
  { name: 'internal-gateway-label', regex: /ty_local/i },
  { name: 'office-subnet', regex: /10\.110\.120\./ },
  { name: 'internal-hash-marker', regex: /ce020760/i },
  // Non-fixture secret/private-key checks outside tests/
  {
    name: 'private-key-header',
    regex: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----/,
    skipTests: true,
  },
  { name: 'github-classic-token', regex: /\bghp_[A-Za-z0-9]{36}\b/, skipTests: true },
  { name: 'github-fine-grained-token', regex: /\bgithub_pat_[A-Za-z0-9_]{22,}\b/, skipTests: true },
  { name: 'anthropic-api-key', regex: /\bsk-ant-api03-[A-Za-z0-9_-]{20,}\b/, skipTests: true },
  { name: 'openai-project-key', regex: /\bsk-proj-[A-Za-z0-9_-]{20,}\b/, skipTests: true },
  { name: 'aws-access-key-id', regex: /\bAKIA[0-9A-Z]{16}\b/, skipTests: true },
  { name: 'slack-token', regex: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/, skipTests: true },
];

const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.icns', '.bmp',
  '.woff', '.woff2', '.ttf', '.eot', '.otf',
  '.zip', '.tar', '.gz', '.tgz', '.bz2', '.xz', '.7z',
  '.pdf', '.exe', '.dll', '.so', '.dylib', '.bin', '.db', '.sqlite', '.asar',
]);

interface Finding {
  readonly file: string;
  readonly line?: number;
  readonly rule: string;
  readonly detail: string;
}

function listTrackedFiles(root: string): string[] {
  const out = execFileSync('git', ['ls-files', '-z'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return out.split('\0').filter(Boolean);
}

function isLikelyBinary(buf: Buffer): boolean {
  const limit = Math.min(buf.length, 8192);
  for (let i = 0; i < limit; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

function isTestPath(relPath: string): boolean {
  const norm = relPath.replace(/\\/g, '/');
  return (
    norm.startsWith('tests/') ||
    norm.includes('/__tests__/') ||
    /\.test\.[cm]?[jt]sx?$/.test(norm) ||
    /\.spec\.[cm]?[jt]sx?$/.test(norm)
  );
}

function scanTrackedFiles(root: string, findings: Finding[]): number {
  const tracked = listTrackedFiles(root);
  let scanned = 0;

  for (const relRaw of tracked) {
    const rel = relRaw.replace(/\\/g, '/');
    if (rel === SELF_REL) continue;
    if (BINARY_EXTENSIONS.has(extname(rel).toLowerCase())) continue;

    const abs = join(root, rel);
    if (!existsSync(abs)) continue;
    const stat = statSync(abs);
    if (!stat.isFile()) continue;

    const buf = readFileSync(abs);
    if (isLikelyBinary(buf)) continue;

    scanned++;
    const text = buf.toString('utf8');
    const inTests = isTestPath(rel);
    const activeRules = FORBIDDEN_PATTERNS.filter((r) => !(r.skipTests && inTests));

    // Fast pre-check per rule across whole file before line splitting
    const triggered = activeRules.filter((r) => r.regex.test(text));
    if (triggered.length === 0) continue;

    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      for (const rule of triggered) {
        const match = rule.regex.exec(line);
        if (match) {
          const snippet = line.trim().slice(0, 140);
          findings.push({
            file: rel,
            line: i + 1,
            rule: rule.name,
            detail: `matched "${match[0]}" in: ${snippet}`,
          });
        }
      }
    }
  }

  return scanned;
}

function checkRequiredNoticeFiles(root: string, findings: Finding[], warnings: Finding[], warnOnly: boolean): void {
  for (const name of ['LICENSE', 'THIRD_PARTY_NOTICES.txt']) {
    if (!existsSync(join(root, name))) {
      const item: Finding = {
        file: name,
        rule: 'required-oss-file',
        detail: `required root file "${name}" is missing`,
      };
      if (warnOnly) warnings.push(item);
      else findings.push(item);
    }
  }
}

function collectMarkdownFilesToCheck(root: string): string[] {
  const targets: string[] = [];
  for (const top of ['README.md', 'README.zh-CN.md']) {
    if (existsSync(join(root, top))) targets.push(top);
  }
  for (const dir of ['docs/guide', 'docs/reference']) {
    const absDir = join(root, dir);
    if (!existsSync(absDir)) continue;
    for (const entry of readdirSync(absDir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
        targets.push(`${dir}/${entry.name}`);
      }
    }
  }
  return targets;
}

function stripInlineCode(line: string): string {
  return line.replace(/`[^`]*`/g, (m) => ' '.repeat(m.length));
}

function extractRelativeLinkPath(rawTarget: string): string | null {
  let target = rawTarget.trim();
  if (!target) return null;
  if (target.startsWith('<') && target.endsWith('>')) {
    target = target.slice(1, -1).trim();
  } else {
    // Strip optional markdown title: path "title" or path 'title'
    const spaceIdx = target.search(/\s+["']/);
    if (spaceIdx >= 0) target = target.slice(0, spaceIdx).trim();
  }
  if (!target || target.startsWith('#')) return null;
  if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(target)) return null;

  const hashIdx = target.indexOf('#');
  if (hashIdx >= 0) target = target.slice(0, hashIdx);
  const queryIdx = target.indexOf('?');
  if (queryIdx >= 0) target = target.slice(0, queryIdx);
  if (!target) return null;

  try {
    return decodeURIComponent(target);
  } catch {
    return target;
  }
}

function checkMarkdownLinks(root: string, findings: Finding[]): number {
  const mdFiles = collectMarkdownFilesToCheck(root);
  const linkRe = /!?\[[^\]]*\]\(([^)\r\n]+)\)/g;
  let checkedLinks = 0;

  for (const rel of mdFiles) {
    const abs = join(root, rel);
    const lines = readFileSync(abs, 'utf8').split(/\r?\n/);
    let inFence = false;
    let fenceChar = '';

    for (let i = 0; i < lines.length; i++) {
      const rawLine = lines[i]!;
      const fenceMatch = /^\s*(`{3,}|~{3,})/.exec(rawLine);
      if (fenceMatch) {
        const ch = fenceMatch[1]![0]!;
        if (!inFence) {
          inFence = true;
          fenceChar = ch;
        } else if (ch === fenceChar) {
          inFence = false;
          fenceChar = '';
        }
        continue;
      }
      if (inFence) continue;

      const cleaned = stripInlineCode(rawLine);
      linkRe.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = linkRe.exec(cleaned)) !== null) {
        const relTarget = extractRelativeLinkPath(match[1]!);
        if (!relTarget) continue;
        checkedLinks++;
        const resolved = relTarget.startsWith('/')
          ? join(root, relTarget.slice(1))
          : resolve(dirname(abs), relTarget);
        if (!existsSync(resolved)) {
          findings.push({
            file: rel,
            line: i + 1,
            rule: 'broken-markdown-link',
            detail: `relative link target "${relTarget}" does not exist (resolved to ${relative(root, resolved).replace(/\\/g, '/')})`,
          });
        }
      }
    }
  }

  return checkedLinks;
}

function main(): void {
  const args = new Set(process.argv.slice(2));
  const strict = args.has('--strict');
  const warnNotices = args.has('--warn-notices') && !strict;

  const findings: Finding[] = [];
  const warnings: Finding[] = [];

  const scannedFiles = scanTrackedFiles(REPO_ROOT, findings);
  checkRequiredNoticeFiles(REPO_ROOT, findings, warnings, warnNotices);
  const checkedLinks = checkMarkdownLinks(REPO_ROOT, findings);

  for (const w of warnings) {
    const loc = w.line !== undefined ? `${w.file}:${w.line}` : w.file;
    console.warn(`[WARN] ${loc} (${w.rule}): ${w.detail}`);
  }

  if (findings.length > 0) {
    for (const f of findings) {
      const loc = f.line !== undefined ? `${f.file}:${f.line}` : f.file;
      console.error(`[FAIL] ${loc} (${f.rule}): ${f.detail}`);
    }
    console.error(
      `\nOSS hygiene check FAILED: ${findings.length} issue(s) found across ${scannedFiles} tracked file(s) and ${checkedLinks} markdown link(s).`,
    );
    process.exit(1);
  }

  console.log(
    `OSS hygiene check PASSED: ${scannedFiles} tracked text file(s) scanned, ${checkedLinks} relative markdown link(s) verified, 0 issues.`,
  );
}

main();
