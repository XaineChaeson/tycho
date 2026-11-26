// Zero-dependency static Product Website + Multi-Page Documentation Reader generator.
// Builds `docs-site/` directly from the canonical Markdown files in `docs/` & repo root.
// Automatically deployed to GitHub Pages by `.github/workflows/docs-pages.yml`.
import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'docs-site');
const REPO_URL = 'https://github.com/XaineChaeson/tycho';

interface DocSpec {
  slug: string;
  group: string;
  title: string;
  source: string; // repo-relative path
}

const DOC_PAGES: DocSpec[] = [
  { slug: 'quickstart', group: '入门与部署', title: '5 分钟快速上手', source: 'docs/guide/quickstart.md' },
  { slug: 'remote-access', group: '入门与部署', title: '4 种部署与公网 VPS', source: 'docs/guide/remote-access.md' },
  { slug: 'clients', group: '入门与部署', title: '桌面端与手机 PWA', source: 'docs/clients.md' },

  { slug: 'architecture', group: '架构与调度', title: '核心架构与安全边界', source: 'docs/guide/architecture.md' },
  { slug: 'accounts-and-nodes', group: '架构与调度', title: '账号池、三档与机器', source: 'docs/guide/accounts-and-nodes.md' },
  { slug: 'operations', group: '架构与调度', title: '生产运维手册', source: 'docs/guide/operations.md' },

  { slug: 'extensibility', group: '扩展与自动化', title: '扩展与插件开发', source: 'docs/guide/extensibility.md' },
  { slug: 'channels-and-triggers', group: '扩展与自动化', title: 'IM 通道与事件触发器', source: 'docs/guide/channels-and-triggers.md' },
  { slug: 'knowledge-and-skills', group: '扩展与自动化', title: '知识库、技能与 MCP', source: 'docs/guide/knowledge-and-skills.md' },
  { slug: 'quota-plugins', group: '扩展与自动化', title: '本机额度探针插件', source: 'docs/quota-plugins.md' },
  { slug: 'executor-updaters', group: '扩展与自动化', title: '多机执行器自动升级', source: 'docs/executor-updaters.md' },

  { slug: 'cli', group: '参考与治理', title: 'CLI 命令参考', source: 'docs/reference/cli.md' },
  { slug: 'settings', group: '参考与治理', title: '全量配置项参考', source: 'docs/reference/settings.md' },
  { slug: 'troubleshooting', group: '参考与治理', title: '故障排查手册', source: 'docs/reference/troubleshooting.md' },
  { slug: 'security', group: '参考与治理', title: '安全模型与披露', source: 'SECURITY.md' },
  { slug: 'contributing', group: '参考与治理', title: '参与贡献', source: 'CONTRIBUTING.md' },
  { slug: 'changelog', group: '参考与治理', title: '变更日志', source: 'CHANGELOG.md' },
];

const SOURCE_TO_SLUG = new Map<string, string>(
  DOC_PAGES.map((p) => [p.source.replaceAll('\\', '/'), p.slug]),
);

function escapeHtml(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function slugifyHeading(text: string): string {
  const plain = text
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[*_~]/g, '')
    .trim()
    .toLowerCase();
  return plain
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '') || 'section';
}

function resolveDocLink(href: string, currentSource: string): string {
  if (/^(https?:|mailto:|#)/i.test(href)) return href;
  const [rawPath, hash] = href.split('#');
  const currentDir = dirname(join(ROOT, currentSource));
  const abs = resolve(currentDir, rawPath!);
  const rel = relative(ROOT, abs).replaceAll('\\', '/');
  const mappedSlug = SOURCE_TO_SLUG.get(rel);
  if (mappedSlug) return `${mappedSlug}.html${hash ? `#${hash}` : ''}`;
  if (rel === 'docs/README.md' || rel === 'docs/deploy.md') return `quickstart.html`;
  if (rel.startsWith('docs/assets/')) return `../assets/${rel.slice('docs/assets/'.length)}`;
  if (rel.startsWith('assets/')) return `../assets/${rel.slice('assets/'.length)}`;
  return `${REPO_URL}/blob/main/${rel}${hash ? `#${hash}` : ''}`;
}

function renderInline(text: string, currentSource: string): string {
  const codeSlots: string[] = [];
  let s = text.replace(/`([^`]+)`/g, (_m, code: string) => {
    const idx = codeSlots.length;
    codeSlots.push(`<code>${escapeHtml(code)}</code>`);
    return `\u0000CODE${idx}\u0000`;
  });
  s = escapeHtml(s);
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, label: string, href: string) => {
    const resolved = resolveDocLink(href.trim(), currentSource);
    const ext = /^https?:\/\//i.test(resolved) ? ' target="_blank" rel="noreferrer"' : '';
    return `<a href="${escapeHtml(resolved)}"${ext}>${label}</a>`;
  });
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*])\*([^*]+)\*(?!\*)/g, '$1<em>$2</em>');
  s = s.replace(/\u0000CODE(\d+)\u0000/g, (_m, i: string) => codeSlots[Number(i)]!);
  return s;
}

interface Heading { level: number; id: string; text: string }

function parseMarkdown(md: string, currentSource: string): { html: string; headings: Heading[]; excerpt: string } {
  const lines = md.replace(/\r\n/g, '\n').replace(/^<!--[\s\S]*?-->\s*/gm, '').split('\n');
  const out: string[] = [];
  const headings: Heading[] = [];
  const usedIds = new Map<string, number>();
  let excerpt = '';
  let i = 0;

  const uniqueId = (raw: string): string => {
    const base = slugifyHeading(raw);
    const n = usedIds.get(base) ?? 0;
    usedIds.set(base, n + 1);
    return n === 0 ? base : `${base}-${n}`;
  };

  while (i < lines.length) {
    const line = lines[i]!;
    const trimmed = line.trim();

    if (trimmed === '') { i++; continue; }
    if (/^---+$/.test(trimmed)) { out.push('<hr />'); i++; continue; }

    // Raw HTML image paragraph / details pass-through (rewriting asset paths)
    if (trimmed.startsWith('<p align="center">') || trimmed.startsWith('<details') || trimmed.startsWith('</details>') || trimmed.startsWith('<summary>')) {
      const rewritten = line.replace(/src="([^"]+)"/g, (_m, src: string) => `src="${escapeHtml(resolveDocLink(src, currentSource))}"`);
      out.push(rewritten);
      i++;
      continue;
    }

    // Fenced code block
    const fence = /^```([a-zA-Z0-9_-]*)/.exec(trimmed);
    if (fence) {
      const lang = fence[1] || 'text';
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.trim().startsWith('```')) {
        codeLines.push(lines[i]!);
        i++;
      }
      i++; // skip closing fence
      const rawCode = codeLines.join('\n');
      out.push(
        `<div class="code-block"><div class="code-head"><span class="mono">${escapeHtml(lang)}</span><button class="copy-btn" type="button">Copy</button></div><pre><code>${escapeHtml(rawCode)}</code></pre></div>`,
      );
      continue;
    }

    // Headings
    const hm = /^(#{1,4})\s+(.+)$/.exec(trimmed);
    if (hm) {
      const level = hm[1]!.length;
      const rawTitle = hm[2]!.trim();
      const id = uniqueId(rawTitle);
      const plainTitle = rawTitle.replace(/`([^`]+)`/g, '$1').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
      if (level === 2 || level === 3) headings.push({ level, id, text: plainTitle });
      out.push(`<h${level} id="${id}">${renderInline(rawTitle, currentSource)}</h${level}>`);
      i++;
      continue;
    }

    // Blockquote / GitHub Callout
    if (trimmed.startsWith('>')) {
      const qLines: string[] = [];
      while (i < lines.length && lines[i]!.trim().startsWith('>')) {
        qLines.push(lines[i]!.trim().replace(/^>\s?/, ''));
        i++;
      }
      const first = qLines[0] ?? '';
      const alertMatch = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]$/.exec(first);
      if (alertMatch) {
        const kind = alertMatch[1]!.toLowerCase();
        const body = qLines.slice(1).map((l) => `<p>${renderInline(l, currentSource)}</p>`).join('');
        out.push(`<div class="callout callout-${kind}"><div class="callout-title mono">${alertMatch[1]}</div>${body}</div>`);
      } else {
        out.push(`<blockquote>${qLines.map((l) => `<p>${renderInline(l, currentSource)}</p>`).join('')}</blockquote>`);
      }
      continue;
    }

    // Table
    if (trimmed.includes('|') && i + 1 < lines.length && /^\|?[\s:-]+\|[\s|:-]+$/.test(lines[i + 1]!.trim())) {
      const splitRow = (row: string) => row.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map((c) => c.trim().replaceAll('\\|', '|'));
      const headers = splitRow(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i]!.trim().includes('|') && lines[i]!.trim() !== '') {
        rows.push(splitRow(lines[i]!));
        i++;
      }
      out.push(
        `<div class="table-scroll"><table><thead><tr>${headers.map((h) => `<th>${renderInline(h, currentSource)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${renderInline(c, currentSource)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`,
      );
      continue;
    }

    // Unordered / Ordered list
    if (/^[-*]\s+/.test(trimmed) || /^\d+\.\s+/.test(trimmed)) {
      const ordered = /^\d+\.\s+/.test(trimmed);
      const tag = ordered ? 'ol' : 'ul';
      const items: string[] = [];
      while (i < lines.length) {
        const l = lines[i]!;
        const m = ordered ? /^\s*\d+\.\s+(.+)$/.exec(l) : /^\s*[-*]\s+(.+)$/.exec(l);
        if (!m) break;
        items.push(`<li>${renderInline(m[1]!, currentSource)}</li>`);
        i++;
      }
      out.push(`<${tag}>${items.join('')}</${tag}>`);
      continue;
    }

    // Paragraph
    const pLines: string[] = [];
    while (
      i < lines.length
      && lines[i]!.trim() !== ''
      && !/^(#{1,4}\s|```|>|---+$|[-*]\s|\d+\.\s|<p |<details|<\/details>|<summary>)/.test(lines[i]!.trim())
    ) {
      pLines.push(lines[i]!.trim());
      i++;
    }
    const text = pLines.join(' ');
    if (!excerpt && text.length > 20) excerpt = text.replace(/`([^`]+)`/g, '$1').replace(/\*\*/g, '').slice(0, 180);
    out.push(`<p>${renderInline(text, currentSource)}</p>`);
  }

  return { html: out.join('\n'), headings, excerpt };
}

const SHARED_CSS = `
:root {
  --bg: #080B12;
  --surface: #0D121D;
  --surface-2: #121927;
  --code-bg: #05080F;
  --border: rgba(148, 163, 184, 0.14);
  --border-strong: rgba(148, 163, 184, 0.28);
  --ink: #F1F5F9;
  --ink-2: #CBD5E1;
  --muted: #8B9BB4;
  --faint: #64748B;
  --accent: #38BDF8;
  --accent-soft: rgba(56, 189, 248, 0.1);
  --green: #34D399;
  --amber: #FBBF24;
  --font-sans: 'Inter', 'PingFang SC', 'Microsoft YaHei UI', system-ui, -apple-system, sans-serif;
  --font-mono: 'JetBrains Mono', 'Cascadia Mono', Consolas, ui-monospace, monospace;
}
[data-theme="light"] {
  --bg: #F8FAFC;
  --surface: #FFFFFF;
  --surface-2: #F1F5F9;
  --code-bg: #0B1120;
  --border: rgba(15, 23, 42, 0.1);
  --border-strong: rgba(15, 23, 42, 0.22);
  --ink: #0F172A;
  --ink-2: #334155;
  --muted: #475569;
  --faint: #64748B;
  --accent: #0284C7;
  --accent-soft: rgba(2, 132, 199, 0.08);
  --green: #059669;
  --amber: #D97706;
}
* { box-sizing: border-box; margin: 0; padding: 0; }
html { scroll-behavior: smooth; }
body {
  font-family: var(--font-sans); background: var(--bg); color: var(--ink);
  line-height: 1.65; -webkit-font-smoothing: antialiased;
}
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
.mono { font-family: var(--font-mono); }
.topbar {
  position: sticky; top: 0; z-index: 50; height: 56px;
  backdrop-filter: blur(12px);
  background: color-mix(in srgb, var(--bg) 86%, transparent);
  border-bottom: 1px solid var(--border);
}
.topbar-in {
  max-width: 1320px; height: 100%; margin: 0 auto; padding: 0 24px;
  display: flex; align-items: center; justify-content: space-between; gap: 16px;
}
.brand { display: flex; align-items: center; gap: 9px; font-weight: 700; font-size: 15.5px; color: var(--ink); }
.brand:hover { text-decoration: none; }
.brand img { width: 24px; height: 24px; border-radius: 6px; }
.nav-mid { display: flex; align-items: center; gap: 22px; font-size: 13.5px; }
.nav-mid a { color: var(--muted); font-weight: 500; }
.nav-mid a:hover, .nav-mid a.active { color: var(--ink); text-decoration: none; }
.nav-r { display: flex; align-items: center; gap: 8px; }
.btn {
  cursor: pointer; border: 1px solid var(--border); background: var(--surface); color: var(--ink);
  padding: 6px 11px; border-radius: 7px; font-size: 12.5px; font-weight: 500; font-family: inherit;
  display: inline-flex; align-items: center; gap: 6px; transition: border-color .15s, background .15s;
}
.btn:hover { border-color: var(--border-strong); background: var(--surface-2); text-decoration: none; }
.btn-pri { background: var(--ink); color: var(--bg); border-color: transparent; font-weight: 600; }
.btn-pri:hover { opacity: 0.9; background: var(--ink); color: var(--bg); }
.code-block { border-radius: 10px; overflow: hidden; border: 1px solid var(--border); background: var(--code-bg); margin: 14px 0; }
.code-head { display: flex; justify-content: space-between; align-items: center; padding: 7px 13px; border-bottom: 1px solid rgba(148,163,184,0.14); font-size: 11px; color: #94A3B8; }
.copy-btn { cursor: pointer; background: rgba(148,163,184,0.12); color: #CBD5E1; border: 1px solid rgba(148,163,184,0.2); border-radius: 5px; padding: 2px 8px; font-size: 11px; font-family: var(--font-mono); }
.copy-btn:hover { color: #FFF; border-color: rgba(148,163,184,0.4); }
.code-block pre { padding: 13px 15px; overflow-x: auto; font-family: var(--font-mono); font-size: 12.5px; line-height: 1.6; color: #E2E8F0; }
.code-block code { background: none; padding: 0; border: 0; color: inherit; font-size: inherit; }
`;

function renderLandingPage(): string {
  return `<!doctype html>
<html lang="zh-CN" data-theme="dark">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Tycho — Self-Hosted AI Agent Control Plane</title>
<link rel="icon" type="image/svg+xml" href="assets/tycho-logo.svg" />
<style>${SHARED_CSS}
.hero { max-width: 1040px; margin: 0 auto; padding: 76px 24px 44px; text-align: center; }
.hero h1 { font-size: clamp(34px, 5vw, 54px); font-weight: 800; letter-spacing: -0.035em; line-height: 1.12; margin-bottom: 16px; }
.hero p.lead { font-size: 17px; color: var(--muted); max-width: 650px; margin: 0 auto 28px; line-height: 1.65; }
.install-pill {
  max-width: 720px; margin: 0 auto 24px; border-radius: 11px; border: 1px solid var(--border);
  background: var(--surface); overflow: hidden; text-align: left;
}
.ip-tabs { display: flex; justify-content: space-between; align-items: center; padding: 6px 12px; border-bottom: 1px solid var(--border); background: var(--surface-2); }
.ip-tabs .copy-btn { background: var(--surface); color: var(--muted); border-color: var(--border); }
.ip-tabs .copy-btn:hover { color: var(--ink); border-color: var(--border-strong); }
.ip-tabs .tg { display: flex; gap: 4px; }
.ip-tab { cursor: pointer; border: 0; background: transparent; color: var(--muted); font-size: 12px; font-weight: 600; padding: 4px 10px; border-radius: 6px; font-family: inherit; }
.ip-tab.on { background: var(--surface); color: var(--ink); border: 1px solid var(--border); }
.ip-cmd { padding: 12px 16px; font-family: var(--font-mono); font-size: 12.5px; color: var(--ink); overflow-x: auto; white-space: nowrap; }
.hero-cta { display: flex; justify-content: center; gap: 10px; flex-wrap: wrap; }
.stage { max-width: 1120px; margin: 0 auto 72px; padding: 0 24px; }
.stage-tabs { display: flex; justify-content: center; gap: 6px; margin-bottom: 14px; }
.stage-frame { border-radius: 16px; overflow: hidden; border: 1px solid var(--border); background: #05080F; }
.stage-frame img { width: 100%; display: block; }
.sec { max-width: 1120px; margin: 0 auto 76px; padding: 0 24px; }
.sec-h { margin-bottom: 26px; }
.sec-h h2 { font-size: 26px; font-weight: 700; letter-spacing: -0.025em; margin-bottom: 6px; }
.sec-h p { font-size: 14.5px; color: var(--muted); max-width: 680px; }
.grid-3 { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; }
.feat { padding: 20px 22px; border-radius: 12px; border: 1px solid var(--border); background: var(--surface); display: flex; flex-direction: column; gap: 8px; }
.feat h3 { font-size: 15px; font-weight: 700; }
.feat p { font-size: 13.5px; color: var(--muted); line-height: 1.6; }
.feat .ftag { font-size: 11px; color: var(--faint); font-family: var(--font-mono); }
.dep-grid { display: grid; grid-template-columns: minmax(0, 0.84fr) minmax(0, 1.16fr); gap: 22px; padding: 24px; border-radius: 14px; border: 1px solid var(--border); background: var(--surface); }
.dep-grid .code-block pre { font-size: 12px; }
.dep-tabs { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 14px; }
.dep-list { list-style: none; display: flex; flex-direction: column; gap: 8px; font-size: 13.5px; color: var(--ink-2); margin: 12px 0 16px; }
.dep-list li::before { content: '– '; color: var(--faint); }
.acc-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
details.d { border-radius: 11px; border: 1px solid var(--border); background: var(--surface); }
details.d[open] { border-color: var(--border-strong); }
details.d summary { cursor: pointer; list-style: none; padding: 15px 18px; font-weight: 600; font-size: 14px; display: flex; justify-content: space-between; align-items: center; }
details.d summary::-webkit-details-marker { display: none; }
details.d summary::after { content: '+'; font-family: var(--font-mono); color: var(--muted); }
details.d[open] summary::after { content: '−'; }
details.d .db { padding: 0 18px 16px; border-top: 1px solid var(--border); padding-top: 13px; font-size: 13.5px; color: var(--muted); display: flex; flex-direction: column; gap: 10px; }
footer { max-width: 1120px; margin: 0 auto; padding: 28px 24px 56px; border-top: 1px solid var(--border); display: flex; justify-content: space-between; flex-wrap: wrap; gap: 12px; font-size: 13px; color: var(--muted); }
@media (max-width: 900px) { .grid-3, .dep-grid, .acc-grid { grid-template-columns: 1fr; } .nav-mid { display: none; } }
</style>
</head>
<body>
<header class="topbar">
  <div class="topbar-in">
    <a class="brand" href="index.html"><img src="assets/tycho-logo-512.png" alt="Tycho" /><span>tycho</span></a>
    <nav class="nav-mid">
      <a href="#features" data-i18n="nav_feat">特性</a>
      <a href="#deploy" data-i18n="nav_dep">部署拓扑</a>
      <a href="#protocols" data-i18n="nav_ext">IM 与插件</a>
      <a href="docs/quickstart.html" data-i18n="nav_docs">文档</a>
    </nav>
    <div class="nav-r">
      <button class="btn" id="lang-btn" type="button">EN</button>
      <button class="btn" id="theme-btn" type="button">☀ / ☾</button>
      <a class="btn btn-pri" href="${REPO_URL}" target="_blank" rel="noreferrer">GitHub ↗</a>
    </div>
  </div>
</header>

<section class="hero">
  <h1 data-i18n="h1">自托管的原生 AI Agent 编排控制面</h1>
  <p class="lead" data-i18n="lead">直接编排你已有的 Claude Code、Codex、Gemini (agy) 与 dsh —— 用一本零依赖 SQLite 账本统一调度多台机器、多份订阅、任意 IM 与多端客户端。</p>

  <div class="install-pill">
    <div class="ip-tabs">
      <div class="tg">
        <button class="ip-tab on" data-os="unix" type="button">macOS / Linux</button>
        <button class="ip-tab" data-os="win" type="button">Windows (PowerShell)</button>
      </div>
      <button class="copy-btn" id="copy-inst" type="button">Copy</button>
    </div>
    <div class="ip-cmd" id="inst-cmd">curl -fsSL https://github.com/XaineChaeson/tycho/releases/latest/download/install.sh | bash</div>
  </div>

  <div class="hero-cta">
    <a class="btn btn-pri" href="docs/quickstart.html" data-i18n="cta_docs">阅读文档</a>
    <a class="btn" href="docs/clients.html" data-i18n="cta_cli">下载 3.6 MB 桌面端 &amp; PWA</a>
    <a class="btn" href="docs/remote-access.html" data-i18n="cta_vps">公网云服务器部署</a>
  </div>
</section>

<section class="stage">
  <div class="stage-tabs">
    <button class="btn" data-view="console" type="button" data-i18n="v_con">项目指挥台</button>
    <button class="btn" data-view="accounts" type="button" data-i18n="v_acc">统一账号池与额度</button>
    <button class="btn" data-view="arch" type="button" data-i18n="v_arch">系统架构</button>
  </div>
  <div class="stage-frame"><img id="stage-img" src="assets/preview-console.png" alt="Tycho UI Preview" /></div>
</section>

<section class="sec" id="features">
  <div class="sec-h">
    <h2 data-i18n="f_h">做编排控制面，不造又一个玩具套壳</h2>
    <p data-i18n="f_p">保留原生 CLI 生态与订阅额度，把持久化账本、多机外连、配额容错与插件化扩展做到工程级可靠。</p>
  </div>
  <div class="grid-3">
    <div class="feat"><span class="ftag">01 / BYOS NATIVE CLIS</span><h3 data-i18n="f1_t">100% 透传原生执行器</h3><p data-i18n="f1_p">直接驱动 Claude Code、Codex、Gemini (agy) 与 dsh，保留官方订阅、工具链与 MCP，支持多机空闲自动升级 CLI。</p></div>
    <div class="feat"><span class="ftag">02 / SQLITE LEDGER</span><h3 data-i18n="f2_t">零依赖单账本引擎</h3><p data-i18n="f2_p">纯 Node 24 + node:sqlite，零运行时依赖。先记意图再执行，单活跃轮次唯一约束，崩溃重启如实核对现场。</p></div>
    <div class="feat"><span class="ftag">03 / OUTBOUND FLEET</span><h3 data-i18n="f3_t">零入站 SSH 多机算力</h3><p data-i18n="f3_p">节点通过 tycho node join 主动外连，支持本机、公网 VPS、Tailscale 与穿透代理的 SSH/WSS :443 隧道。</p></div>
    <div class="feat"><span class="ftag">04 / ACCOUNTS &amp; QUOTAS</span><h3 data-i18n="f4_t">多号额度池与插件探针</h3><p data-i18n="f4_p">集中托管与单机登录统一按三档路由，5h/7d 自动歇息切号；支持 ~/.tycho/quota-probes/*.mjs 私有计费插件。</p></div>
    <div class="feat"><span class="ftag">05 / IM &amp; TRIGGERS</span><h3 data-i18n="f5_t">随意接 IM 与插件触发器</h3><p data-i18n="f5_p">内置企微长连接、个人微信扫码与飞书桥接，开放签名协议接任意 IM；支持 Cron、事务内生命周期事件与 Webhook。</p></div>
    <div class="feat"><span class="ftag">06 / SKILLS &amp; CLIENTS</span><h3 data-i18n="f6_t">跨机技能同步与全端访问</h3><p data-i18n="f6_p">主机 SKILL.md 自动镜像全网节点；外部 CLI 可挂 Knowledge MCP；支持 3.6 MB 桌面壳、手机 PWA 与热插拔主题包。</p></div>
  </div>
</section>

<section class="sec" id="deploy">
  <div class="sec-h">
    <h2 data-i18n="d_h">4 种部署拓扑，从本机试用到公网 24×7</h2>
    <p data-i18n="d_p">无需 root、无需 Docker、无需预装 Node 24。点击切换对应拓扑查看完整命令。</p>
  </div>
  <div class="dep-tabs" id="dep-tabs">
    <button class="btn btn-pri" data-mode="vps" type="button" data-i18n="t_vps">公网云服务器 VPS（推荐）</button>
    <button class="btn" data-mode="local" type="button" data-i18n="t_loc">本机 90 秒试用</button>
    <button class="btn" data-mode="mesh" type="button" data-i18n="t_mesh">Tailscale / 局域网</button>
    <button class="btn" data-mode="tunnel" type="button" data-i18n="t_tun">NAT 反向隧道 / WSS :443</button>
  </div>
  <div class="dep-grid">
    <div>
      <h3 id="dep-title" style="font-size:18px;margin-bottom:8px"></h3>
      <p id="dep-desc" style="font-size:13.5px;color:var(--muted)"></p>
      <ul class="dep-list" id="dep-steps"></ul>
      <a class="btn" href="docs/remote-access.html" data-i18n="d_more">查看完整部署手册 →</a>
    </div>
    <div class="code-block" style="margin:0">
      <div class="code-head"><span class="mono" id="dep-lang">bash</span><button class="copy-btn" id="copy-dep" type="button">Copy</button></div>
      <pre><code id="dep-code"></code></pre>
    </div>
  </div>
</section>

<section class="sec" id="protocols">
  <div class="sec-h">
    <h2 data-i18n="p_h">折叠深潜：协议、插件与安全模型</h2>
    <p data-i18n="p_p">主屏保持克制，按需展开查看精确签名协议、插件接口与站内专题链接。</p>
  </div>
  <div class="acc-grid">
    <details class="d"><summary data-i18n="d1_t">开放 IM 双向签名协议（企微 / 微信 / 飞书 / Slack / Discord）</summary><div class="db"><p data-i18n="d1_p">通过 POST /inbound/:src 投递 HMAC-SHA256 签名事件（支持群快慢分流与上下文），经 GET /inbound/:src/result/:id 仅回读总控明确发布的公开答复，绝不泄露私有控制台。</p><a href="docs/extensibility.html" data-i18n="d1_a">查看完整协议与飞书参考实现 →</a></div></details>
    <details class="d"><summary data-i18n="d2_t">3 类插件级事件触发器（Cron · 内部事件 · 签名 Webhook）</summary><div class="db"><p data-i18n="d2_p">支持显式 IANA 时区 Cron、SQLite 事务内生命周期事件（ready / accepted / merged / released）及 GitHub / tycho-v1 签名 Webhook，支持自动播报绑定群聊。</p><a href="docs/channels-and-triggers.html" data-i18n="d2_a">查看触发器指南 →</a></div></details>
    <details class="d"><summary data-i18n="d3_t">本机即插即用额度探针插件（~/.tycho/quota-probes/）</summary><div class="db"><p data-i18n="d3_p">无需改源码即可对接私有网关或企业内部计费接口：脚本从 stdin 读取内置结果并向 stdout 输出标准化预算窗口 JSON，密钥全程留在节点本地。</p><a href="docs/quota-plugins.html" data-i18n="d3_a">查看插件规范 →</a></div></details>
    <details class="d"><summary data-i18n="d4_t">跨机 SKILL.md 同步、Knowledge MCP、主题包与安全边界</summary><div class="db"><p data-i18n="d4_p">主机一份技能包自动镜像全网节点；外部 CLI 可通过 tycho knowledge-mcp --node 挂载受限知识工具；以 OS 用户与机器隔离为主要安全边界。</p><a href="docs/security.html" data-i18n="d4_a">查看安全模型与信任边界 →</a></div></details>
  </div>
</section>

<footer>
  <div><strong>Tycho</strong> · MIT License · Zero Runtime Dependencies</div>
  <div style="display:flex;gap:18px;flex-wrap:wrap">
    <a href="docs/quickstart.html">Docs</a>
    <a href="docs/cli.html">CLI Reference</a>
    <a href="docs/settings.html">Settings</a>
    <a href="docs/security.html">Security</a>
    <a href="${REPO_URL}/releases" target="_blank" rel="noreferrer">Releases</a>
  </div>
</footer>

<script>
const INST = {
  unix: 'curl -fsSL https://github.com/XaineChaeson/tycho/releases/latest/download/install.sh | bash',
  win: 'irm https://github.com/XaineChaeson/tycho/releases/latest/download/install.ps1 | iex',
};
const VIEWS = {
  console: 'assets/preview-console.png',
  accounts: 'assets/preview-accounts.png',
  arch: 'assets/diagram-architecture.png',
};
const DEPS = {
  zh: {
    vps: { title: '公网云服务器 / VPS 24×7 托管', desc: '在带公网 HTTPS 域名的 Linux 云主机常驻运行，随时接入工作站、笔记本、桌面端与手机 PWA。', steps: ['普通用户运行 install.sh 并启用 tycho service install 与 loginctl enable-linger。', 'Nginx / Caddy 反代 127.0.0.1:8787（务必设置 proxy_buffering off 保障 SSE）。', '控制台设置对外地址后，任意机器 tycho node join --to https://tycho.example.com。'], code: 'curl -fsSL https://github.com/XaineChaeson/tycho/releases/latest/download/install.sh \\\\\\n  | bash\\ntycho service install && loginctl enable-linger "$USER"\\n\\n# 任意远程机器接入：\\ntycho node join --to https://tycho.example.com\\ntycho node service install' },
    local: { title: '本机 90 秒快速试用', desc: '零配置直接在自己电脑跑通闭环，回环接入自动放行。', steps: ['本机已装并登录至少一个 CLI（codex / claude / agy / dsh）。', 'tycho run --open 启动在 http://127.0.0.1:8787 并自动打开登录页。', '另开终端运行 tycho node join --to http://127.0.0.1:8787。'], code: 'tycho run --open\\n# 另开终端：\\ntycho node join --to http://127.0.0.1:8787' },
    mesh: { title: 'Tailscale / WireGuard / 局域网', desc: '零公网暴露，仅在私有组网内互通全部设备与节点。', steps: ['控制台「设置 › 服务」设 http.host = 0.0.0.0（防火墙仅放行组网网卡）。', '将 http.publicUrl 设为 https://<host>.tailnet.ts.net 并重启主机。', '组网内其他机器直接 tycho node join --to https://<host>.tailnet.ts.net。'], code: 'tycho stop && tycho service start\\ntycho node join --to https://my-host.tailnet.ts.net' },
    tunnel: { title: 'NAT 反向隧道门牌（支持 WSS :443）', desc: '主机留在内网零入站端口，主动外连公网轻量中转机；22 端口受限时可走 WSS :443 穿透 HTTPS_PROXY。', steps: ['公网中转机配置受限 SSH 用户（MaxSessions 0 + permitlisten="127.0.0.1:18787"）。', '主机生成专用 ed25519 私钥并在控制台「设置 › 门牌」填入。', '无需重启自动拉起隧道，tycho doctor 验证已连接。'], code: 'ssh-keygen -t ed25519 -f ~/.tycho/gateway_ed25519 -N ""\\n# 控制台「设置 › 门牌」：gateway.ssh = tycho-gw@relay | remotePort = 18787' },
  },
  en: {
    vps: { title: 'Public Cloud Server / VPS (24×7 Hub)', desc: 'Run Host 24×7 on any Linux VPS behind Nginx/Caddy HTTPS and join workstations, MacBooks, Desktop & Mobile PWA from anywhere.', steps: ['Install as a normal user and enable systemd linger.', 'Reverse-proxy 127.0.0.1:8787 over HTTPS with proxy_buffering off for SSE.', 'Set Public URL in Settings, then join any remote machine via tycho node join.'], code: 'curl -fsSL https://github.com/XaineChaeson/tycho/releases/latest/download/install.sh \\\\\\n  | bash\\ntycho service install && loginctl enable-linger "$USER"\\n\\n# On any remote machine:\\ntycho node join --to https://tycho.example.com\\ntycho node service install' },
    local: { title: 'Localhost Solo Start (90s)', desc: 'Zero-config local start on one workstation; loopback joins auto-approve.', steps: ['Have at least one native CLI logged in (codex / claude / agy / dsh).', 'Run tycho run --open to sign in at http://127.0.0.1:8787.', 'Join in a second terminal with tycho node join --to http://127.0.0.1:8787.'], code: 'tycho run --open\\n# Second terminal:\\ntycho node join --to http://127.0.0.1:8787' },
    mesh: { title: 'Tailscale / WireGuard / LAN Mesh', desc: 'Zero public exposure; bind inside your private Tailnet or LAN firewall.', steps: ['Set http.host = 0.0.0.0 and http.publicUrl = https://<host>.tailnet.ts.net.', 'Restart Host via tycho stop && tycho service start.', 'Join peers over your Tailnet URL.'], code: 'tycho stop && tycho service start\\ntycho node join --to https://my-host.tailnet.ts.net' },
    tunnel: { title: 'NAT Reverse-Tunnel Gateway (WSS :443)', desc: 'Keep Host behind corporate/home NAT with zero inbound ports; built-in SSH-over-WebSocket :443 traverses HTTPS_PROXY.', steps: ['Configure a locked-down SSH user (MaxSessions 0, permitlisten) on a relay VPS.', 'Generate a dedicated ed25519 key on Host and enter it in Settings › Gateway.', 'Tunnel connects live without restarting Host; verify with tycho doctor.'], code: 'ssh-keygen -t ed25519 -f ~/.tycho/gateway_ed25519 -N ""\\n# Settings › Gateway: gateway.ssh = tycho-gw@relay | remotePort = 18787' },
  },
};
const TXT = {
  zh: { nav_feat:'特性', nav_dep:'部署拓扑', nav_ext:'IM 与插件', nav_docs:'文档', h1:'自托管的原生 AI Agent 编排控制面', lead:'直接编排你已有的 Claude Code、Codex、Gemini (agy) 与 dsh —— 用一本零依赖 SQLite 账本统一调度多台机器、多份订阅、任意 IM 与多端客户端。', cta_docs:'阅读文档', cta_cli:'下载 3.6 MB 桌面端 & PWA', cta_vps:'公网云服务器部署', v_con:'项目指挥台', v_acc:'统一账号池与额度', v_arch:'系统架构', f_h:'做编排控制面，不造又一个玩具套壳', f_p:'保留原生 CLI 生态与订阅额度，把持久化账本、多机外连、配额容错与插件化扩展做到工程级可靠。', f1_t:'100% 透传原生执行器', f1_p:'直接驱动 Claude Code、Codex、Gemini (agy) 与 dsh，保留官方订阅、工具链与 MCP，支持多机空闲自动升级 CLI。', f2_t:'零依赖单账本引擎', f2_p:'纯 Node 24 + node:sqlite，零运行时依赖。先记意图再执行，单活跃轮次唯一约束，崩溃重启如实核对现场。', f3_t:'零入站 SSH 多机算力', f3_p:'节点通过 tycho node join 主动外连，支持本机、公网 VPS、Tailscale 与穿透代理的 SSH/WSS :443 隧道。', f4_t:'多号额度池与插件探针', f4_p:'集中托管与单机登录统一按三档路由，5h/7d 自动歇息切号；支持 ~/.tycho/quota-probes/*.mjs 私有计费插件。', f5_t:'随意接 IM 与插件触发器', f5_p:'内置企微长连接、个人微信扫码与飞书桥接，开放签名协议接任意 IM；支持 Cron、事务内生命周期事件与 Webhook。', f6_t:'跨机技能同步与全端访问', f6_p:'主机 SKILL.md 自动镜像全网节点；外部 CLI 可挂 Knowledge MCP；支持 3.6 MB 桌面壳、手机 PWA 与热插拔主题包。', d_h:'4 种部署拓扑，从本机试用到公网 24×7', d_p:'无需 root、无需 Docker、无需预装 Node 24。点击切换对应拓扑查看完整命令。', t_vps:'公网云服务器 VPS（推荐）', t_loc:'本机 90 秒试用', t_mesh:'Tailscale / 局域网', t_tun:'NAT 反向隧道 / WSS :443', d_more:'查看完整部署手册 →', p_h:'折叠深潜：协议、插件与安全模型', p_p:'主屏保持克制，按需展开查看精确签名协议、插件接口与站内专题链接。', d1_t:'开放 IM 双向签名协议（企微 / 微信 / 飞书 / Slack / Discord）', d1_p:'通过 POST /inbound/:src 投递 HMAC-SHA256 签名事件（支持群快慢分流与上下文），经 GET /inbound/:src/result/:id 仅回读总控明确发布的公开答复，绝不泄露私有控制台。', d1_a:'查看完整协议与飞书参考实现 →', d2_t:'3 类插件级事件触发器（Cron · 内部事件 · 签名 Webhook）', d2_p:'支持显式 IANA 时区 Cron、SQLite 事务内生命周期事件（ready / accepted / merged / released）及 GitHub / tycho-v1 签名 Webhook，支持自动播报绑定群聊。', d2_a:'查看触发器指南 →', d3_t:'本机即插即用额度探针插件（~/.tycho/quota-probes/）', d3_p:'无需改源码即可对接私有网关或企业内部计费接口：脚本从 stdin 读取内置结果并向 stdout 输出标准化预算窗口 JSON，密钥全程留在节点本地。', d3_a:'查看插件规范 →', d4_t:'跨机 SKILL.md 同步、Knowledge MCP、主题包与安全边界', d4_p:'主机一份技能包自动镜像全网节点；外部 CLI 可通过 tycho knowledge-mcp --node 挂载受限知识工具；以 OS 用户与机器隔离为主要安全边界。', d4_a:'查看安全模型与信任边界 →' },
  en: { nav_feat:'Features', nav_dep:'Deploy', nav_ext:'IM & Plugins', nav_docs:'Docs', h1:'A self-hosted control plane for native AI coding agents', lead:'Orchestrate Claude Code, OpenAI Codex, Gemini (agy), and dsh across every machine, account, IM, and device — backed by one zero-dependency SQLite ledger.', cta_docs:'Read Documentation', cta_cli:'Desktop (3.6 MB) & PWA', cta_vps:'Public VPS Guide', v_con:'Mission Control', v_acc:'Accounts & Quotas', v_arch:'Architecture', f_h:'Orchestrator, not another toy harness', f_p:'Keep your real CLI subscriptions and tools intact while gaining a durable ledger, outbound multi-machine routing, quota failover, and open extensibility.', f1_t:'100% Native CLI Passthrough', f1_p:'Drives real Claude Code, Codex, Gemini (agy) & dsh with native MCPs, Git creds, and idle-safe fleet CLI upgrades.', f2_t:'Zero-Dep SQLite Ledger', f2_p:'Pure Node 24 + node:sqlite with zero runtime dependencies. Persist intent first; reconcile reality honestly after crashes.', f3_t:'Outbound Fleet, No Inbound SSH', f3_p:'Worker machines join via tycho node join across Localhost, Public VPS, Tailscale, or NAT-traversal WSS :443 tunnels.', f4_t:'Accounts Pool & Quota Plugins', f4_p:'3 fixed tiers with 5h/7d telemetry and P1→P2 failover, plus drop-in ~/.tycho/quota-probes/*.mjs local billing plugins.', f5_t:'Pluggable IMs & Event Triggers', f5_p:'WeCom WS, Personal WeChat QR, Feishu bridge, open signed IM protocol, Cron, ledger lifecycle events & HMAC webhooks.', f6_t:'Shared Brain & Everywhere Clients', f6_p:'Auto-mirrored SKILL.md bundles, scoped Knowledge MCP, 3.6 MB Tauri Desktop, iOS/Android PWA & hot-reload JSON themes.', d_h:'Four deployment topologies, localhost to public cloud', d_p:'No root, no Docker, no Node pre-install required. Switch modes for copy-paste commands.', t_vps:'Public Cloud VPS (Recommended)', t_loc:'Localhost (90s)', t_mesh:'Tailscale / LAN', t_tun:'NAT Tunnel / WSS :443', d_more:'Full Deployment Guide →', p_h:'Technical deep dives: protocols, plugins & security', p_p:'Keep the overview calm; expand any drawer for exact specs and in-site doc links.', d1_t:'Open bidirectional IM protocol (WeCom / WeChat / Feishu / Slack / Discord)', d1_p:'Deliver HMAC-SHA256 signed events via POST /inbound/:src (with fast/slow group routing), and read back only explicitly published replies via GET /inbound/:src/result/:id — zero console exposure.', d1_a:'Read protocol spec & Feishu bridge →', d2_t:'Three plugin-grade trigger families (Cron · Internal Events · Signed Webhooks)', d2_p:'Explicit IANA-timezone Cron, transactional SQLite lifecycle events (ready / accepted / merged / released), and GitHub or tycho-v1 HMAC webhooks with optional IM broadcast.', d2_a:'Read triggers guide →', d3_t:'Drop-in local quota probe plugins (~/.tycho/quota-probes/)', d3_p:'Integrate private gateways or corporate billing endpoints without forking: read built-in JSON on stdin and emit normalized quota windows on stdout while keeping keys local.', d3_a:'Read quota plugin contract →', d4_t:'SKILL.md fleet mirror, Knowledge MCP, JSON themes & security boundary', d4_p:'One Host skill pack mirrors across every worker; external CLIs attach scoped Knowledge MCP via tycho knowledge-mcp --node; OS users & machines form the primary boundary.', d4_a:'Read security model & boundaries →' },
};
let lang = 'zh', mode = 'vps';
const savedLandingTheme = localStorage.getItem('tycho-docs-theme');
if (savedLandingTheme) document.documentElement.setAttribute('data-theme', savedLandingTheme);
function syncDep() {
  const d = DEPS[lang][mode];
  document.getElementById('dep-title').textContent = d.title;
  document.getElementById('dep-desc').textContent = d.desc;
  document.getElementById('dep-steps').innerHTML = d.steps.map(s => '<li>' + s + '</li>').join('');
  document.getElementById('dep-code').textContent = d.code;
}
function syncLang() {
  document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
  document.getElementById('lang-btn').textContent = lang === 'zh' ? 'EN' : '中文';
  document.querySelectorAll('[data-i18n]').forEach(el => { const k = el.getAttribute('data-i18n'); if (TXT[lang][k]) el.textContent = TXT[lang][k]; });
  syncDep();
}
document.querySelectorAll('.ip-tab').forEach(b => b.addEventListener('click', () => {
  document.querySelectorAll('.ip-tab').forEach(x => x.classList.toggle('on', x === b));
  document.getElementById('inst-cmd').textContent = INST[b.dataset.os];
}));
document.querySelectorAll('[data-view]').forEach(b => b.addEventListener('click', () => {
  document.querySelectorAll('[data-view]').forEach(x => x.classList.toggle('btn-pri', x === b));
  document.getElementById('stage-img').src = VIEWS[b.dataset.view];
}));
document.querySelector('[data-view="console"]').classList.add('btn-pri');
document.getElementById('dep-tabs').addEventListener('click', e => {
  const b = e.target.closest('[data-mode]'); if (!b) return;
  mode = b.dataset.mode;
  document.querySelectorAll('#dep-tabs [data-mode]').forEach(x => x.classList.toggle('btn-pri', x === b));
  syncDep();
});
document.getElementById('lang-btn').addEventListener('click', () => { lang = lang === 'zh' ? 'en' : 'zh'; syncLang(); });
document.getElementById('theme-btn').addEventListener('click', () => { const r = document.documentElement; const next = r.getAttribute('data-theme') === 'dark' ? 'light' : 'dark'; r.setAttribute('data-theme', next); localStorage.setItem('tycho-docs-theme', next); });
const bindCopy = (btnId, srcId) => document.getElementById(btnId).addEventListener('click', async () => {
  const btn = document.getElementById(btnId);
  try { await navigator.clipboard.writeText(document.getElementById(srcId).textContent); btn.textContent = 'Copied'; } catch {}
  setTimeout(() => { btn.textContent = 'Copy'; }, 1400);
});
bindCopy('copy-inst', 'inst-cmd');
bindCopy('copy-dep', 'dep-code');
syncLang();
</script>
</body>
</html>`;
}

function renderDocPage(spec: DocSpec, index: number, htmlBody: string, headings: Heading[]): string {
  const groups = new Map<string, DocSpec[]>();
  for (const p of DOC_PAGES) {
    const arr = groups.get(p.group) ?? [];
    arr.push(p);
    groups.set(p.group, arr);
  }
  const sidebarHtml = [...groups.entries()].map(([g, items], gi) => `
    <div class="sb-group${gi > 0 ? ' sep' : ''}">
      <div class="sb-head">${escapeHtml(g)}</div>
      <div class="sb-list">
        ${items.map((it) => `<a class="sb-link${it.slug === spec.slug ? ' active' : ''}" href="${it.slug}.html">${escapeHtml(it.title)}</a>`).join('')}
      </div>
    </div>`).join('');

  const tocHtml = headings.length > 0
    ? headings.map((h) => `<a class="toc-l toc-${h.level}" href="#${h.id}">${escapeHtml(h.text)}</a>`).join('')
    : '<span style="font-size:12px;color:var(--faint)">No subsections</span>';

  const prev = index > 0 ? DOC_PAGES[index - 1] : null;
  const next = index < DOC_PAGES.length - 1 ? DOC_PAGES[index + 1] : null;

  return `<!doctype html>
<html lang="zh-CN" data-theme="dark">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(spec.title)} — Tycho Docs</title>
<link rel="icon" type="image/svg+xml" href="../assets/tycho-logo.svg" />
<style>${SHARED_CSS}
.doc-layout { max-width: 1320px; margin: 0 auto; display: grid; grid-template-columns: 248px minmax(0, 1fr) 220px; gap: 36px; padding: 28px 24px 80px; }
/* CJK-safe robust sidebar hierarchy (docs-architect Lens 3) */
.sidebar { position: sticky; top: 84px; align-self: start; max-height: calc(100vh - 108px); overflow-y: auto; padding-right: 8px; }
.sb-group.sep { border-top: 1px solid var(--border); margin-top: 14px; padding-top: 14px; }
.sb-head { font-size: 0.875rem; font-weight: 700; color: var(--ink); margin-bottom: 6px; padding-left: 4px; }
.sb-list { margin-left: 0.55rem; border-left: 1px solid var(--border); display: flex; flex-direction: column; gap: 2px; padding-left: 10px; }
.sb-link { display: block; padding: 5px 9px; border-radius: 6px; font-size: 0.835rem; color: var(--muted); transition: background .12s, color .12s; }
.sb-link:hover { color: var(--ink); background: var(--surface-2); text-decoration: none; }
.sb-link.active { color: var(--accent); background: var(--accent-soft); font-weight: 600; box-shadow: inset 2px 0 0 var(--accent); }
/* Prose */
.prose { max-width: 78ch; min-width: 0; }
.prose h1 { font-size: 30px; font-weight: 800; letter-spacing: -0.03em; line-height: 1.2; margin-bottom: 16px; }
.prose h2 { font-size: 21px; font-weight: 700; letter-spacing: -0.02em; margin: 34px 0 12px; padding-top: 14px; border-top: 1px solid var(--border); scroll-margin-top: 76px; }
.prose h3 { font-size: 16.5px; font-weight: 700; margin: 22px 0 8px; scroll-margin-top: 76px; }
.prose h4 { font-size: 14.5px; font-weight: 700; margin: 16px 0 6px; }
.prose p { margin: 10px 0; color: var(--ink-2); font-size: 14.5px; }
.prose ul, .prose ol { margin: 10px 0 14px 22px; color: var(--ink-2); font-size: 14.5px; }
.prose li { margin: 5px 0; }
.prose code { font-family: var(--font-mono); font-size: 0.86em; padding: 1.5px 5px; border-radius: 5px; background: var(--surface-2); border: 1px solid var(--border); color: var(--ink); overflow-wrap: break-word; word-break: normal; }
.prose pre code { background: transparent; border: 0; padding: 0; color: inherit; font-size: inherit; border-radius: 0; }
.prose hr { border: 0; border-top: 1px solid var(--border); margin: 26px 0; }
.prose img { max-width: 100%; border-radius: 12px; border: 1px solid var(--border); margin: 12px 0; }
.prose blockquote { border-left: 3px solid var(--border-strong); padding: 4px 14px; margin: 14px 0; color: var(--muted); }
.callout { border-radius: 10px; border: 1px solid var(--border); padding: 12px 15px; margin: 16px 0; background: var(--surface); }
.callout-tip { border-left: 3px solid var(--green); }
.callout-important, .callout-note { border-left: 3px solid var(--accent); }
.callout-warning, .callout-caution { border-left: 3px solid var(--amber); }
.callout-title { font-size: 11px; font-weight: 700; letter-spacing: 0.06em; color: var(--ink); margin-bottom: 4px; }
.callout p { margin: 4px 0; font-size: 13.5px; }
/* Protected scrollable tables (docs-architect Lens 3) */
.table-scroll { max-width: 100%; overflow-x: auto; border: 1px solid var(--border); border-radius: 10px; margin: 16px 0; background: var(--surface); }
.table-scroll table { width: 100%; border-collapse: collapse; font-size: 13.5px; }
.table-scroll th, .table-scroll td { padding: 9px 13px; border-bottom: 1px solid var(--border); text-align: left; vertical-align: top; }
.table-scroll tr:last-child td { border-bottom: 0; }
.table-scroll th { background: var(--surface-2); font-weight: 600; font-size: 12.5px; color: var(--muted); white-space: nowrap; }
.table-scroll td:first-child { min-width: 7rem; }
.table-scroll td:first-child code { white-space: nowrap; }
.prose details { border: 1px solid var(--border); border-radius: 9px; padding: 10px 14px; margin: 14px 0; background: var(--surface); }
.prose summary { cursor: pointer; font-weight: 600; font-size: 14px; }
/* Right TOC */
.toc { position: sticky; top: 84px; align-self: start; max-height: calc(100vh - 108px); overflow-y: auto; border-left: 1px solid var(--border); padding-left: 14px; }
.toc-t { font-size: 11.5px; font-weight: 700; color: var(--ink); margin-bottom: 8px; letter-spacing: 0.04em; }
.toc-l { display: block; padding: 3.5px 0; line-height: 1.4; color: var(--muted); overflow-wrap: anywhere; }
.toc-2 { font-size: 0.81rem; font-weight: 500; }
.toc-3 { font-size: 0.76rem; padding-left: 11px; color: var(--faint); }
.toc-l:hover { color: var(--ink); text-decoration: none; }
.pager { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-top: 42px; padding-top: 22px; border-top: 1px solid var(--border); }
.pager a { padding: 12px 15px; border-radius: 10px; border: 1px solid var(--border); background: var(--surface); display: flex; flex-direction: column; gap: 2px; color: var(--ink); }
.pager a:hover { border-color: var(--border-strong); text-decoration: none; }
.pager small { font-size: 11px; color: var(--faint); }
/* Search Modal */
.s-modal { display: none; position: fixed; inset: 0; z-index: 90; background: rgba(0,0,0,0.62); backdrop-filter: blur(4px); align-items: flex-start; justify-content: center; padding-top: 10vh; }
.s-modal.open { display: flex; }
.s-box { width: min(600px, 92vw); border-radius: 14px; border: 1px solid var(--border-strong); background: var(--surface); overflow: hidden; box-shadow: 0 24px 60px rgba(0,0,0,0.6); }
.s-box input { width: 100%; padding: 14px 18px; border: 0; border-bottom: 1px solid var(--border); background: transparent; color: var(--ink); font-size: 15px; font-family: inherit; outline: none; }
.s-res { max-height: 360px; overflow-y: auto; padding: 8px; display: flex; flex-direction: column; gap: 4px; }
.s-res a { padding: 9px 12px; border-radius: 8px; display: flex; flex-direction: column; gap: 2px; color: var(--ink); }
.s-res a:hover { background: var(--surface-2); text-decoration: none; }
.s-res small { font-size: 12px; color: var(--muted); }
@media (max-width: 1120px) { .doc-layout { grid-template-columns: 230px minmax(0, 1fr); } .toc { display: none; } }
@media (max-width: 820px) { .doc-layout { grid-template-columns: 1fr; } .sidebar { position: static; max-height: none; border-bottom: 1px solid var(--border); padding-bottom: 16px; } .nav-mid { display: none; } }
</style>
</head>
<body>
<header class="topbar">
  <div class="topbar-in">
    <a class="brand" href="../index.html"><img src="../assets/tycho-logo-512.png" alt="Tycho" /><span>tycho</span><span class="mono" style="font-size:11px;color:var(--faint)">docs</span></a>
    <nav class="nav-mid">
      <a href="../index.html">首页</a>
      <a class="active" href="quickstart.html">文档</a>
      <a href="cli.html">CLI</a>
      <a href="settings.html">配置项</a>
    </nav>
    <div class="nav-r">
      <button class="btn" id="search-btn" type="button">搜索 <span class="mono" style="font-size:10.5px;color:var(--faint)">Ctrl K</span></button>
      <button class="btn" id="theme-btn" type="button">☀ / ☾</button>
      <a class="btn" href="${REPO_URL}" target="_blank" rel="noreferrer">GitHub ↗</a>
    </div>
  </div>
</header>

<div class="doc-layout">
  <aside class="sidebar">${sidebarHtml}</aside>
  <article class="prose">
    ${htmlBody}
    <nav class="pager">
      ${prev ? `<a href="${prev.slug}.html"><small>← 上一篇</small><strong>${escapeHtml(prev.title)}</strong></a>` : '<div></div>'}
      ${next ? `<a href="${next.slug}.html" style="text-align:right"><small>下一篇 →</small><strong>${escapeHtml(next.title)}</strong></a>` : '<div></div>'}
    </nav>
  </article>
  <aside class="toc">
    <div class="toc-t">本页目录</div>
    ${tocHtml}
  </aside>
</div>

<div class="s-modal" id="s-modal">
  <div class="s-box">
    <input id="s-input" type="search" placeholder="搜索文档标题、配置键或命令..." autocomplete="off" />
    <div class="s-res" id="s-res"></div>
  </div>
</div>

<script>
const savedTheme = localStorage.getItem('tycho-docs-theme');
if (savedTheme) document.documentElement.setAttribute('data-theme', savedTheme);
document.getElementById('theme-btn').addEventListener('click', () => {
  const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('tycho-docs-theme', next);
});
document.querySelectorAll('.code-block .copy-btn').forEach(btn => {
  btn.addEventListener('click', async () => {
    const code = btn.closest('.code-block').querySelector('pre code').textContent;
    try { await navigator.clipboard.writeText(code); btn.textContent = 'Copied'; } catch {}
    setTimeout(() => { btn.textContent = 'Copy'; }, 1400);
  });
});
let searchData = null;
const modal = document.getElementById('s-modal');
const input = document.getElementById('s-input');
const resEl = document.getElementById('s-res');
async function openSearch() {
  modal.classList.add('open');
  input.focus();
  if (!searchData) {
    try { searchData = await (await fetch('../search-index.json')).json(); } catch { searchData = []; }
  }
  renderSearch(input.value);
}
function renderSearch(q) {
  const term = q.trim().toLowerCase();
  const hits = (searchData || []).filter(item => !term || item.title.toLowerCase().includes(term) || item.group.toLowerCase().includes(term) || item.text.toLowerCase().includes(term)).slice(0, 12);
  resEl.innerHTML = hits.length
    ? hits.map(h => '<a href="' + h.slug + '.html"><strong>' + h.title + '</strong><small>' + h.group + ' · ' + h.excerpt + '</small></a>').join('')
    : '<div style="padding:14px;font-size:13px;color:var(--muted)">没有匹配项</div>';
}
document.getElementById('search-btn').addEventListener('click', openSearch);
modal.addEventListener('click', e => { if (e.target === modal) modal.classList.remove('open'); });
input.addEventListener('input', () => renderSearch(input.value));
window.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); openSearch(); }
  if (e.key === 'Escape') modal.classList.remove('open');
});
</script>
</body>
</html>`;
}

// Build pipeline
rmSync(OUT, { recursive: true, force: true });
mkdirSync(join(OUT, 'docs'), { recursive: true });
mkdirSync(join(OUT, 'assets'), { recursive: true });

// Copy brand logo & clean UI previews
for (const f of ['tycho-logo-512.png', 'tycho-logo.svg']) {
  copyFileSync(join(ROOT, 'assets', f), join(OUT, 'assets', f));
}
for (const f of readdirSync(join(ROOT, 'docs', 'assets'))) {
  copyFileSync(join(ROOT, 'docs', 'assets', f), join(OUT, 'assets', f));
}

// Write landing page
writeFileSync(join(OUT, 'index.html'), renderLandingPage(), 'utf8');

// Render all docs & build search index
const searchIndex: { slug: string; group: string; title: string; excerpt: string; text: string }[] = [];
for (let i = 0; i < DOC_PAGES.length; i++) {
  const spec = DOC_PAGES[i]!;
  const raw = readFileSync(join(ROOT, spec.source), 'utf8');
  const { html, headings, excerpt } = parseMarkdown(raw, spec.source);
  writeFileSync(join(OUT, 'docs', `${spec.slug}.html`), renderDocPage(spec, i, html, headings), 'utf8');
  searchIndex.push({
    slug: spec.slug,
    group: spec.group,
    title: spec.title,
    excerpt,
    text: raw.slice(0, 6000),
  });
}
writeFileSync(join(OUT, 'search-index.json'), JSON.stringify(searchIndex), 'utf8');
writeFileSync(join(OUT, '.nojekyll'), '', 'utf8');

console.log(`Built static website in ${OUT}: index.html + ${DOC_PAGES.length} doc pages + search-index.json`);
