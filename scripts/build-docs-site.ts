// Zero-dependency static Product Website + Multi-Page Documentation Portal generator.
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
  source: string;
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
  if (rel === 'docs/README.md' || rel === 'docs/deploy.md') return 'quickstart.html';
  if (rel.startsWith('docs/assets/')) return `../assets/${rel.slice('docs/assets/'.length)}`;
  if (rel.startsWith('assets/')) return `../assets/${rel.slice('assets/'.length)}`;
  return `${REPO_URL}/blob/main/${rel}${hash ? `#${hash}` : ''}`;
}

// Lightweight zero-dep syntax highlighter operating strictly on escaped HTML lines.
function highlightCode(raw: string, lang: string): string {
  const l = lang.toLowerCase();
  return raw.split('\n').map((line) => {
    const esc = escapeHtml(line);
    if (l === 'bash' || l === 'sh' || l === 'shell' || l === 'zsh' || l === 'powershell' || l === 'ps1' || l === 'nginx' || l === 'yaml' || l === 'yml') {
      if (/^\s*#/.test(line)) return `<span class="tok-com">${esc}</span>`;
      return esc
        .replace(/(#.*)$/, '<span class="tok-com">$1</span>')
        .replace(/(&quot;[^&]*?&quot;|&#39;[^']*?&#39;|'[^']*?')/g, '<span class="tok-str">$1</span>')
        .replace(/\b(curl|irm|iex|bash|tycho|node|npm|ssh|ssh-keygen|loginctl|systemctl|git|docker|sudo|export|set|proxy_pass|proxy_buffering|proxy_http_version|location|server)\b/g, '<span class="tok-kw">$1</span>')
        .replace(/(^|\s)(--?[a-zA-Z0-9_-]+)/g, '$1<span class="tok-flg">$2</span>');
    }
    if (l === 'json' || l === 'jsonc') {
      return esc
        .replace(/(&quot;[^&]+?&quot;)(\s*:)/g, '<span class="tok-key">$1</span>$2')
        .replace(/(:\s*)(&quot;[^&]*?&quot;)/g, '$1<span class="tok-str">$2</span>')
        .replace(/\b(true|false|null)\b/g, '<span class="tok-kw">$1</span>')
        .replace(/(:\s*)(-?\d+(?:\.\d+)?)/g, '$1<span class="tok-num">$2</span>');
    }
    if (l === 'ts' || l === 'typescript' || l === 'js' || l === 'javascript' || l === 'mjs') {
      if (/^\s*\/\//.test(line)) return `<span class="tok-com">${esc}</span>`;
      return esc
        .replace(/(&quot;[^&]*?&quot;|'[^']*?'|`[^`]*?`)/g, '<span class="tok-str">$1</span>')
        .replace(/\b(import|export|from|const|let|var|async|await|function|return|if|else|for|of|try|catch|new|interface|type)\b/g, '<span class="tok-kw">$1</span>')
        .replace(/\b(\d+)\b/g, '<span class="tok-num">$1</span>');
    }
    return esc;
  }).join('\n');
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

function estimateMinutes(md: string): number {
  const cjk = (md.match(/[\u4e00-\u9fff]/g) ?? []).length;
  const words = (md.replace(/[\u4e00-\u9fff]/g, ' ').match(/[A-Za-z0-9_]+/g) ?? []).length;
  return Math.max(1, Math.round(cjk / 380 + words / 220));
}

const CALLOUT_ICONS: Record<string, string> = {
  tip: '<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M8 1.5a4.5 4.5 0 0 0-2.6 8.18c.38.28.6.7.6 1.17V11.5h4v-.65c0-.47.22-.89.6-1.17A4.5 4.5 0 0 0 8 1.5ZM6.5 13h3v1a1.5 1.5 0 0 1-3 0v-1Z"/></svg>',
  note: '<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13Zm0 3a.9.9 0 1 1 0 1.8.9.9 0 0 1 0-1.8ZM7.25 7.5h1.5v4h-1.5v-4Z"/></svg>',
  important: '<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13Zm-.75 3.25h1.5v4.5h-1.5v-4.5Zm0 5.75h1.5v1.5h-1.5V10.5Z"/></svg>',
  warning: '<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M7.13 2.25a1 1 0 0 1 1.74 0l5.6 9.75A1 1 0 0 1 13.6 13.5H2.4a1 1 0 0 1-.87-1.5l5.6-9.75ZM7.25 6v3.5h1.5V6h-1.5Zm0 4.5V12h1.5v-1.5h-1.5Z"/></svg>',
  caution: '<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M7.13 2.25a1 1 0 0 1 1.74 0l5.6 9.75A1 1 0 0 1 13.6 13.5H2.4a1 1 0 0 1-.87-1.5l5.6-9.75ZM7.25 6v3.5h1.5V6h-1.5Zm0 4.5V12h1.5v-1.5h-1.5Z"/></svg>',
};

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

    if (trimmed.startsWith('<p align="center">') || trimmed.startsWith('<details') || trimmed.startsWith('</details>') || trimmed.startsWith('<summary>')) {
      const rewritten = line.replace(/src="([^"]+)"/g, (_m, src: string) => `src="${escapeHtml(resolveDocLink(src, currentSource))}"`);
      out.push(rewritten);
      i++;
      continue;
    }

    const fence = /^```([a-zA-Z0-9_-]*)/.exec(trimmed);
    if (fence) {
      const lang = fence[1] || 'text';
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.trim().startsWith('```')) {
        codeLines.push(lines[i]!);
        i++;
      }
      i++;
      const rawCode = codeLines.join('\n');
      out.push(
        `<div class="code-block"><div class="code-head"><span class="mono code-lang">${escapeHtml(lang)}</span><button class="copy-btn" type="button">Copy</button></div><pre><code>${highlightCode(rawCode, lang)}</code></pre></div>`,
      );
      continue;
    }

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
        out.push(`<div class="callout callout-${kind}"><div class="callout-title mono">${CALLOUT_ICONS[kind] ?? ''}${alertMatch[1]}</div>${body}</div>`);
      } else {
        out.push(`<blockquote>${qLines.map((l) => `<p>${renderInline(l, currentSource)}</p>`).join('')}</blockquote>`);
      }
      continue;
    }

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

// FOUC-free native color-scheme meta bootstrapper (follows modern-web-guidance `dark-mode-toggle`)
const THEME_HEAD_SNIPPET = `<meta name="color-scheme" content="light dark" />
<script>try{const s=localStorage.getItem('color-scheme');if(s==='light'||s==='dark')document.querySelector('meta[name="color-scheme"]').content=s;}catch{}</script>`;

const SHARED_CSS = `
:root {
  color-scheme: light dark;
  --bg: light-dark(#F8FAFC, #060911);
  --bg-elev: light-dark(#FFFFFF, #0C1220);
  --surface: light-dark(#FFFFFF, #0D1424);
  --surface-2: light-dark(#F1F5F9, #131D33);
  --surface-glass: light-dark(rgba(255,255,255,0.78), rgba(10,15,28,0.78));
  --code-bg: #070B14;
  --border: light-dark(rgba(15,23,42,0.10), rgba(148,163,184,0.15));
  --border-strong: light-dark(rgba(15,23,42,0.22), rgba(148,163,184,0.30));
  --ink: light-dark(#0F172A, #F1F5F9);
  --ink-2: light-dark(#334155, #CBD5E1);
  --muted: light-dark(#475569, #94A3B8);
  --faint: light-dark(#64748B, #64748B);
  --accent: light-dark(#0284C7, #38BDF8);
  --accent-2: light-dark(#4F46E5, #818CF8);
  --accent-soft: light-dark(rgba(2,132,199,0.09), rgba(56,189,248,0.12));
  --green: light-dark(#059669, #34D399);
  --green-soft: light-dark(rgba(5,150,105,0.10), rgba(52,211,153,0.12));
  --amber: light-dark(#D97706, #FBBF24);
  --amber-soft: light-dark(rgba(217,119,6,0.10), rgba(251,191,36,0.12));
  --purple: light-dark(#7C3AED, #C4B5FD);
  --shadow-lg: light-dark(0 24px 60px rgba(15,23,42,0.12), 0 30px 80px rgba(0,0,0,0.62));
  --glow-1: light-dark(rgba(14,165,233,0.14), rgba(56,189,248,0.18));
  --glow-2: light-dark(rgba(99,102,241,0.10), rgba(99,102,241,0.16));
  --grid-dot: light-dark(rgba(15,23,42,0.07), rgba(148,163,184,0.10));
  --font-sans: 'Inter', 'PingFang SC', 'Microsoft YaHei UI', system-ui, -apple-system, sans-serif;
  --font-mono: 'JetBrains Mono', 'Cascadia Mono', Consolas, ui-monospace, monospace;

  &:has(> head > meta[name="color-scheme"][content="dark"]) {
    color-scheme: dark;
  }
  &:has(> head > meta[name="color-scheme"][content="light"]) {
    color-scheme: light;
  }
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

/* Topbar */
.topbar {
  position: sticky; top: 0; z-index: 50; height: 60px;
  backdrop-filter: blur(16px); -webkit-backdrop-filter: blur(16px);
  background: var(--surface-glass);
  border-bottom: 1px solid var(--border);
}
.topbar-in {
  max-width: 1320px; height: 100%; margin: 0 auto; padding: 0 24px;
  display: flex; align-items: center; justify-content: space-between; gap: 16px;
}
.brand { display: flex; align-items: center; gap: 10px; font-weight: 800; font-size: 16px; letter-spacing: -0.02em; color: var(--ink); }
.brand:hover { text-decoration: none; }
.brand img { width: 26px; height: 26px; border-radius: 7px; box-shadow: 0 2px 10px rgba(56,189,248,0.25); }
.ver-pill { font-size: 10.5px; font-weight: 600; padding: 2px 7px; border-radius: 999px; background: var(--accent-soft); color: var(--accent); border: 1px solid color-mix(in srgb, var(--accent) 26%, transparent); }
.nav-mid { display: flex; align-items: center; gap: 24px; font-size: 13.5px; }
.nav-mid a { color: var(--muted); font-weight: 500; transition: color .15s; }
.nav-mid a:hover, .nav-mid a.active { color: var(--ink); text-decoration: none; }
.nav-r { display: flex; align-items: center; gap: 8px; }

/* Buttons */
.btn {
  cursor: pointer; border: 1px solid var(--border); background: var(--surface); color: var(--ink);
  padding: 7px 13px; border-radius: 9px; font-size: 13px; font-weight: 600; font-family: inherit;
  display: inline-flex; align-items: center; gap: 7px; transition: transform .14s, border-color .15s, background .15s, box-shadow .15s;
}
.btn:hover { border-color: var(--border-strong); background: var(--surface-2); text-decoration: none; }
.btn-pri {
  background: linear-gradient(135deg, var(--accent), var(--accent-2));
  color: #FFFFFF; border-color: transparent;
  box-shadow: 0 6px 20px color-mix(in srgb, var(--accent) 32%, transparent);
}
.btn-pri:hover { opacity: 0.94; transform: translateY(-1px); background: linear-gradient(135deg, var(--accent), var(--accent-2)); color: #FFFFFF; }
.btn-ink { background: var(--ink); color: var(--bg); border-color: transparent; }
.btn-ink:hover { opacity: 0.9; background: var(--ink); color: var(--bg); }
.kbd { font-family: var(--font-mono); font-size: 10.5px; padding: 1px 5px; border-radius: 5px; background: var(--surface-2); border: 1px solid var(--border); color: var(--faint); }

/* Syntax-highlighted dark code blocks */
.code-block {
  border-radius: 12px; overflow: hidden; border: 1px solid rgba(148,163,184,0.18);
  background: var(--code-bg); margin: 16px 0;
  box-shadow: 0 12px 32px rgba(0,0,0,0.22);
}
.code-head {
  display: flex; justify-content: space-between; align-items: center;
  padding: 8px 14px; border-bottom: 1px solid rgba(148,163,184,0.14);
  background: rgba(255,255,255,0.02); font-size: 11px; color: #94A3B8;
}
.code-lang { text-transform: uppercase; letter-spacing: 0.06em; font-weight: 600; }
.copy-btn {
  cursor: pointer; background: rgba(148,163,184,0.12); color: #CBD5E1;
  border: 1px solid rgba(148,163,184,0.22); border-radius: 6px;
  padding: 3px 9px; font-size: 11px; font-family: var(--font-mono); transition: background .15s, color .15s;
}
.copy-btn:hover { color: #FFF; background: rgba(148,163,184,0.24); border-color: rgba(148,163,184,0.42); }
.code-block pre { padding: 14px 16px; overflow-x: auto; font-family: var(--font-mono); font-size: 12.5px; line-height: 1.65; color: #E2E8F0; }
.code-block pre code { background: transparent; padding: 0; border: 0; color: inherit; font-size: inherit; border-radius: 0; }
.tok-com { color: #64748B; font-style: italic; }
.tok-str { color: #86EFAC; }
.tok-kw { color: #7DD3FC; font-weight: 600; }
.tok-flg { color: #C4B5FD; }
.tok-key { color: #93C5FD; }
.tok-num { color: #FCD34D; }

/* Native Animated Accordions (modern-web-guidance: accordion) */
details.d {
  border-radius: 13px; border: 1px solid var(--border); background: var(--surface);
  transition: border-color .18s, box-shadow .18s;
}
details.d[open] { border-color: color-mix(in srgb, var(--accent) 40%, var(--border)); box-shadow: 0 12px 32px rgba(0,0,0,0.12); }
details.d > summary {
  cursor: pointer; list-style: none; padding: 16px 18px; font-weight: 600; font-size: 14.5px;
  display: flex; align-items: center; gap: 10px; color: var(--ink);
}
details.d > summary::-webkit-details-marker { display: none; }
details.d > summary::before {
  content: ""; inline-size: 1em; block-size: 1em; flex-shrink: 0;
  background-color: var(--accent);
  -webkit-mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Cpath fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round' d='M4 6l4 4 4-4'/%3E%3C/svg%3E") no-repeat center / contain;
  mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Cpath fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round' d='M4 6l4 4 4-4'/%3E%3C/svg%3E") no-repeat center / contain;
  rotate: -90deg;
}
details.d[open] > summary::before { rotate: 0deg; }
details.d::details-content {
  interpolate-size: allow-keywords;
  overflow: clip;
  contain: layout;
}
details.d:not([open])::details-content { block-size: 0; }
@media (prefers-reduced-motion: no-preference) {
  details.d > summary::before { transition: rotate 0.22s ease; }
  details.d::details-content {
    transition: block-size, content-visibility, display;
    transition-duration: 0.28s;
    transition-timing-function: ease-in-out;
    transition-behavior: allow-discrete;
  }
}
details.d .db {
  padding: 0 18px 18px 42px; font-size: 13.5px; color: var(--muted);
  display: flex; flex-direction: column; gap: 10px;
}

/* Native Modal Command Search Dialog (modern-web-guidance: dialog) */
dialog.s-dialog {
  width: min(640px, 92vw); margin: 10vh auto auto; padding: 0;
  border-radius: 16px; border: 1px solid var(--border-strong);
  background: var(--bg-elev); color: var(--ink);
  box-shadow: var(--shadow-lg); overflow: hidden;
}
dialog.s-dialog:modal { overscroll-behavior: contain; }
dialog.s-dialog::backdrop {
  background: rgba(2, 6, 23, 0.68);
  backdrop-filter: blur(6px);
  overflow: hidden;
  overscroll-behavior: contain;
}
.s-head { display: flex; align-items: center; gap: 10px; padding: 14px 16px; border-bottom: 1px solid var(--border); }
.s-head input {
  flex: 1; border: 0; background: transparent; color: var(--ink);
  font-size: 15px; font-family: inherit; outline: none;
}
.s-close {
  cursor: pointer; border: 1px solid var(--border); background: var(--surface-2); color: var(--muted);
  border-radius: 7px; padding: 3px 8px; font-size: 11px; font-family: var(--font-mono);
}
.s-res { max-height: 380px; overflow-y: auto; padding: 8px; display: flex; flex-direction: column; gap: 4px; }
.s-res a {
  padding: 10px 13px; border-radius: 10px; display: flex; flex-direction: column; gap: 3px;
  color: var(--ink); border: 1px solid transparent; transition: background .12s, border-color .12s;
}
.s-res a:hover, .s-res a.sel { background: var(--accent-soft); border-color: color-mix(in srgb, var(--accent) 30%, transparent); text-decoration: none; }
.s-res-top { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
.s-res-g { font-size: 10.5px; font-weight: 600; color: var(--accent); padding: 1px 7px; border-radius: 999px; background: var(--accent-soft); }
.s-res small { font-size: 12px; color: var(--muted); line-height: 1.45; }
.s-foot { padding: 8px 14px; border-top: 1px solid var(--border); background: var(--surface-2); font-size: 11px; color: var(--faint); display: flex; justify-content: space-between; }
`;

// Shared JS for native dark-mode-toggle (system + override + cross-tab storage sync) & native <dialog> command search
function renderSharedScript(searchIndexUrl: string, docPrefix: string): string {
  return `
// Two-state color-scheme toggle (modern-web-guidance: dark-mode-toggle)
const metaCS = document.querySelector('meta[name="color-scheme"]');
const osDarkMQ = window.matchMedia('(prefers-color-scheme: dark)');
function currentRenderedDark() {
  const c = metaCS.content;
  if (c === 'dark') return true;
  if (c === 'light') return false;
  return osDarkMQ.matches;
}
function syncThemeBtn() {
  const btn = document.getElementById('theme-btn');
  if (!btn) return;
  const dark = currentRenderedDark();
  btn.textContent = dark ? '☀' : '☾';
  btn.title = dark ? 'Switch to light theme' : 'Switch to dark theme';
}
document.getElementById('theme-btn')?.addEventListener('click', () => {
  const target = currentRenderedDark() ? 'light' : 'dark';
  const sys = osDarkMQ.matches ? 'dark' : 'light';
  try {
    if (target !== sys) {
      localStorage.setItem('color-scheme', target);
      metaCS.content = target;
    } else {
      localStorage.removeItem('color-scheme');
      metaCS.content = 'light dark';
    }
  } catch {
    metaCS.content = target;
  }
  syncThemeBtn();
});
window.addEventListener('storage', (e) => {
  if (e.key === 'color-scheme') {
    metaCS.content = (e.newValue === 'light' || e.newValue === 'dark') ? e.newValue : 'light dark';
    syncThemeBtn();
  }
});
osDarkMQ.addEventListener('change', syncThemeBtn);
syncThemeBtn();

// Native <dialog closedby="any"> command search with Safari fallback
const sDialog = document.getElementById('s-modal');
const sInput = document.getElementById('s-input');
const sRes = document.getElementById('s-res');
let searchData = null;
let selIdx = 0;

if (sDialog && !('closedBy' in HTMLDialogElement.prototype)) {
  const outside = (e, d) => {
    const r = d.getBoundingClientRect();
    return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
  };
  let pressedOutside = false;
  sDialog.addEventListener('pointerdown', (e) => { pressedOutside = outside(e, sDialog); });
  sDialog.addEventListener('pointerup', (e) => { if (pressedOutside && outside(e, sDialog)) sDialog.close(); });
}

function renderSearch(q) {
  const term = q.trim().toLowerCase();
  const hits = (searchData || []).filter(item =>
    !term || item.title.toLowerCase().includes(term) || item.group.toLowerCase().includes(term) || item.text.toLowerCase().includes(term)
  ).slice(0, 10);
  selIdx = 0;
  sRes.innerHTML = hits.length
    ? hits.map((h, idx) => '<a href="${docPrefix}' + h.slug + '.html" class="' + (idx === 0 ? 'sel' : '') + '"><div class="s-res-top"><strong>' + h.title + '</strong><span class="s-res-g">' + h.group + '</span></div><small>' + h.excerpt + '</small></a>').join('')
    : '<div style="padding:18px;text-align:center;font-size:13px;color:var(--muted)">没有匹配项 · No results</div>';
}

async function openSearch() {
  if (!sDialog) return;
  if (!sDialog.open) sDialog.showModal();
  sInput.focus();
  sInput.select();
  if (!searchData) {
    try { searchData = await (await fetch('${searchIndexUrl}')).json(); } catch { searchData = []; }
  }
  renderSearch(sInput.value);
}

document.getElementById('search-btn')?.addEventListener('click', openSearch);
document.getElementById('s-close')?.addEventListener('click', () => sDialog.close());
sInput?.addEventListener('input', () => renderSearch(sInput.value));
sInput?.addEventListener('keydown', (e) => {
  const links = [...sRes.querySelectorAll('a')];
  if (!links.length) return;
  if (e.key === 'ArrowDown') { e.preventDefault(); selIdx = (selIdx + 1) % links.length; }
  else if (e.key === 'ArrowUp') { e.preventDefault(); selIdx = (selIdx - 1 + links.length) % links.length; }
  else if (e.key === 'Enter') { e.preventDefault(); links[selIdx]?.click(); return; }
  else return;
  links.forEach((a, i) => a.classList.toggle('sel', i === selIdx));
  links[selIdx]?.scrollIntoView({ block: 'nearest' });
});
window.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); openSearch(); }
});
`;
}

const SEARCH_DIALOG_HTML = `<dialog id="s-modal" class="s-dialog" closedby="any" aria-label="Search Tycho documentation">
  <div class="s-head">
    <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" style="color:var(--faint);flex-shrink:0" aria-hidden="true"><circle cx="7" cy="7" r="4.8"/><path d="M11 11l3 3" stroke-linecap="round"/></svg>
    <input id="s-input" type="search" autofocus placeholder="搜索文档标题、配置键、CLI 命令或协议..." autocomplete="off" />
    <button id="s-close" class="s-close" type="button">ESC</button>
  </div>
  <div class="s-res" id="s-res"></div>
  <div class="s-foot"><span>↑↓ 选择 · Enter 跳转</span><span class="mono">Tycho Docs Search</span></div>
</dialog>`;

function renderLandingPage(): string {
  const groupCounts = new Map<string, { first: string; count: number; items: string[] }>();
  for (const p of DOC_PAGES) {
    const g = groupCounts.get(p.group) ?? { first: p.slug, count: 0, items: [] };
    g.count++;
    if (g.items.length < 3) g.items.push(p.title);
    groupCounts.set(p.group, g);
  }
  const docHubCards = [...groupCounts.entries()].map(([g, info], idx) => `
    <a class="hub-card" href="docs/${info.first}.html">
      <div class="hub-top"><span class="mono hub-idx">0${idx + 1}</span><span class="hub-cnt">${info.count} 篇</span></div>
      <h3>${escapeHtml(g)}</h3>
      <p>${info.items.map(escapeHtml).join(' · ')}</p>
      <span class="hub-go">进入阅读 →</span>
    </a>`).join('');

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
${THEME_HEAD_SNIPPET}
<title>Tycho — Self-Hosted AI Agent Control Plane</title>
<meta name="description" content="Self-hosted orchestration control plane for native AI coding agents (Claude Code, Codex, Gemini, dsh) with zero-dependency SQLite ledger, multi-machine outbound fleet, pluggable IMs, and 3.6 MB desktop & PWA clients." />
<link rel="icon" type="image/svg+xml" href="assets/tycho-logo.svg" />
<style>${SHARED_CSS}
/* Atmospheric Hero Backdrop */
.hero-wrap {
  position: relative; overflow: hidden;
  background-image:
    radial-gradient(ellipse 70% 55% at 50% -10%, var(--glow-1), transparent 70%),
    radial-gradient(ellipse 45% 45% at 85% 15%, var(--glow-2), transparent 65%),
    radial-gradient(var(--grid-dot) 1px, transparent 1px);
  background-size: 100% 100%, 100% 100%, 24px 24px;
}
.hero { max-width: 1060px; margin: 0 auto; padding: 72px 24px 36px; text-align: center; position: relative; }
.eyebrow {
  display: inline-flex; align-items: center; gap: 9px; padding: 5px 14px; border-radius: 999px;
  border: 1px solid color-mix(in srgb, var(--accent) 30%, var(--border));
  background: var(--surface-glass); backdrop-filter: blur(8px);
  font-size: 12px; font-weight: 600; color: var(--ink-2); margin-bottom: 22px;
}
.eyebrow .pulse { width: 8px; height: 8px; border-radius: 50%; background: var(--green); box-shadow: 0 0 0 4px var(--green-soft); }
.hero h1 {
  font-size: clamp(36px, 5.2vw, 60px); font-weight: 850; letter-spacing: -0.04em; line-height: 1.12;
  margin-bottom: 18px; text-wrap: balance;
  background: linear-gradient(135deg, var(--ink) 38%, var(--accent) 82%, var(--accent-2) 100%);
  -webkit-background-clip: text; background-clip: text; color: transparent;
}
.hero p.lead { font-size: 17.5px; color: var(--muted); max-width: 680px; margin: 0 auto 28px; line-height: 1.68; }

/* Install Pill */
.install-pill {
  max-width: 740px; margin: 0 auto 24px; border-radius: 13px; border: 1px solid var(--border-strong);
  background: var(--surface); overflow: hidden; text-align: left;
  box-shadow: 0 14px 40px rgba(0,0,0,0.14);
}
.ip-tabs { display: flex; justify-content: space-between; align-items: center; padding: 7px 12px; border-bottom: 1px solid var(--border); background: var(--surface-2); }
.ip-tabs .copy-btn { background: var(--surface); color: var(--muted); border-color: var(--border); }
.ip-tabs .copy-btn:hover { color: var(--ink); border-color: var(--border-strong); }
.ip-tabs .tg { display: flex; gap: 5px; }
.ip-tab { cursor: pointer; border: 1px solid transparent; background: transparent; color: var(--muted); font-size: 12px; font-weight: 600; padding: 4px 11px; border-radius: 7px; font-family: inherit; }
.ip-tab.on { background: var(--surface); color: var(--ink); border-color: var(--border); box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
.ip-cmd { padding: 13px 16px; font-family: var(--font-mono); font-size: 12.5px; color: var(--ink); overflow-x: auto; white-space: nowrap; }
.hero-cta { display: flex; justify-content: center; gap: 10px; flex-wrap: wrap; }

/* 5-View Interactive Product Theater */
.stage { max-width: 1180px; margin: 0 auto 56px; padding: 14px 24px 0; }
.stage-tabs { display: flex; justify-content: center; gap: 6px; flex-wrap: wrap; margin-bottom: 16px; }
.vtab {
  cursor: pointer; border: 1px solid var(--border); background: var(--surface); color: var(--muted);
  padding: 7px 14px; border-radius: 999px; font-size: 12.5px; font-weight: 600; font-family: inherit;
  transition: all .16s;
}
.vtab:hover { color: var(--ink); border-color: var(--border-strong); }
.vtab.on { background: var(--ink); color: var(--bg); border-color: transparent; box-shadow: 0 6px 18px rgba(0,0,0,0.2); }
.stage-shell {
  border-radius: 18px; overflow: hidden; border: 1px solid var(--border-strong);
  background: #060912; box-shadow: var(--shadow-lg);
}
.stage-shell img { width: 100%; display: block; transition: opacity .18s ease; }
.stage-cap {
  display: flex; justify-content: space-between; align-items: center; gap: 16px; flex-wrap: wrap;
  padding: 13px 20px; background: var(--surface); border-top: 1px solid var(--border); font-size: 13px;
}
.stage-cap strong { color: var(--ink); margin-right: 8px; }
.stage-cap span { color: var(--muted); }

/* Metric Proof Ribbon */
.metrics {
  max-width: 1180px; margin: 0 auto 82px; padding: 0 24px;
  display: grid; grid-template-columns: repeat(4, 1fr); gap: 14px;
}
.met {
  padding: 20px 22px; border-radius: 14px; border: 1px solid var(--border); background: var(--surface);
  display: flex; flex-direction: column; gap: 4px;
}
.met b { font-size: 30px; font-weight: 850; letter-spacing: -0.03em; background: linear-gradient(135deg, var(--ink), var(--accent)); -webkit-background-clip: text; background-clip: text; color: transparent; }
.met strong { font-size: 13.5px; color: var(--ink); }
.met span { font-size: 12px; color: var(--muted); }

/* Shared Section Chrome */
.sec { max-width: 1180px; margin: 0 auto 88px; padding: 0 24px; }
.sec-h { margin-bottom: 28px; display: flex; justify-content: space-between; align-items: flex-end; gap: 16px; flex-wrap: wrap; }
.sec-kicker { font-size: 11.5px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: var(--accent); margin-bottom: 6px; display: block; }
.sec-h h2 { font-size: clamp(24px, 3vw, 32px); font-weight: 800; letter-spacing: -0.03em; line-height: 1.18; }
.sec-h p { font-size: 15px; color: var(--muted); max-width: 660px; margin-top: 6px; }

/* Asymmetric 12-Col Bento Showcase */
.bento { display: grid; grid-template-columns: repeat(12, 1fr); gap: 16px; }
.bcard {
  padding: 24px; border-radius: 16px; border: 1px solid var(--border); background: var(--surface);
  display: flex; flex-direction: column; justify-content: space-between; gap: 16px;
  transition: border-color .18s, transform .18s;
}
.bcard:hover { border-color: color-mix(in srgb, var(--accent) 42%, var(--border)); transform: translateY(-2px); }
.span-7 { grid-column: span 7; }
.span-6 { grid-column: span 6; }
.span-5 { grid-column: span 5; }
.b-tag { font-size: 11px; font-weight: 700; color: var(--accent); letter-spacing: 0.05em; }
.bcard h3 { font-size: 18px; font-weight: 750; letter-spacing: -0.02em; margin-top: 4px; }
.bcard p { font-size: 13.5px; color: var(--muted); line-height: 1.62; margin-top: 6px; }

/* Embedded Live Mini-Widgets inside Bento Cards */
.mini-box {
  border-radius: 12px; border: 1px solid var(--border); background: var(--surface-2);
  padding: 13px 14px; display: flex; flex-direction: column; gap: 9px;
}
.chip-row { display: flex; gap: 7px; flex-wrap: wrap; }
.chip {
  font-size: 11.5px; font-weight: 600; padding: 4px 10px; border-radius: 8px;
  background: var(--surface); border: 1px solid var(--border); color: var(--ink-2);
}
.chip.ok { border-color: color-mix(in srgb, var(--green) 40%, transparent); color: var(--green); background: var(--green-soft); }
.chip.acc { border-color: color-mix(in srgb, var(--accent) 40%, transparent); color: var(--accent); background: var(--accent-soft); }
.trace-line { display: flex; align-items: center; gap: 8px; font-size: 11.5px; color: var(--ink-2); flex-wrap: wrap; }
.trace-step { padding: 4px 9px; border-radius: 7px; background: var(--surface); border: 1px solid var(--border); font-weight: 600; }
.trace-step.done { border-color: color-mix(in srgb, var(--green) 42%, transparent); color: var(--green); }
.q-row { display: flex; flex-direction: column; gap: 5px; font-size: 12px; }
.q-head { display: flex; justify-content: space-between; color: var(--ink-2); font-weight: 600; }
.q-bar { height: 7px; border-radius: 99px; background: var(--surface); overflow: hidden; border: 1px solid var(--border); }
.q-fill { height: 100%; border-radius: 99px; }

/* Live Interactive Mini Theme Preview inside Bento Card 6 */
.theme-demo {
  border-radius: 11px; padding: 12px 14px; border: 1px solid var(--border);
  display: flex; flex-direction: column; gap: 10px; transition: background .2s, color .2s, border-color .2s;
}
.td-swatches { display: flex; gap: 7px; flex-wrap: wrap; }
.td-btn {
  cursor: pointer; border: 1px solid var(--border-strong); background: var(--surface); color: var(--ink);
  padding: 4px 10px; border-radius: 8px; font-size: 11.5px; font-weight: 600; font-family: inherit;
  display: inline-flex; align-items: center; gap: 6px;
}
.td-btn.on { outline: 2px solid var(--accent); outline-offset: 1px; }
.td-dot { width: 11px; height: 11px; border-radius: 50%; }

/* Comparison Matrix */
.cmp-wrap {
  border-radius: 16px; border: 1px solid var(--border); background: var(--surface); overflow-x: auto;
  box-shadow: 0 12px 34px rgba(0,0,0,0.08);
}
.cmp { width: 100%; border-collapse: collapse; font-size: 13.5px; min-width: 680px; }
.cmp th, .cmp td { padding: 13px 16px; border-bottom: 1px solid var(--border); text-align: left; }
.cmp tr:last-child td { border-bottom: 0; }
.cmp th { background: var(--surface-2); font-size: 12.5px; font-weight: 700; color: var(--muted); }
.cmp th.ty, .cmp td.ty { background: color-mix(in srgb, var(--accent) 7%, var(--surface)); font-weight: 600; color: var(--ink); }
.cmp .ok { color: var(--green); font-weight: 700; }
.cmp .no { color: var(--faint); }

/* Deployment Workbench */
.dep-tabs { display: flex; gap: 7px; flex-wrap: wrap; margin-bottom: 16px; }
.dep-grid {
  display: grid; grid-template-columns: minmax(0, 0.85fr) minmax(0, 1.15fr); gap: 24px;
  padding: 26px; border-radius: 16px; border: 1px solid var(--border); background: var(--surface);
  box-shadow: 0 12px 34px rgba(0,0,0,0.08);
}
.dep-list { list-style: none; display: flex; flex-direction: column; gap: 9px; font-size: 13.5px; color: var(--ink-2); margin: 14px 0 18px; }
.dep-list li { display: flex; gap: 8px; }
.dep-list li::before { content: '→'; color: var(--accent); font-weight: 700; flex-shrink: 0; }
.dep-grid .code-block pre { font-size: 12px; }

/* Protocol Accordions */
.acc-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; align-items: start; }
.mini-pre {
  background: var(--code-bg); color: #CBD5E1; border-radius: 9px; padding: 10px 12px;
  font-family: var(--font-mono); font-size: 11.5px; overflow-x: auto; border: 1px solid rgba(148,163,184,0.16);
}

/* Doc Hub Cards */
.hub-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 14px; }
.hub-card {
  padding: 20px; border-radius: 14px; border: 1px solid var(--border); background: var(--surface);
  color: var(--ink); display: flex; flex-direction: column; gap: 8px;
  transition: transform .16s, border-color .16s;
}
.hub-card:hover { transform: translateY(-2px); border-color: var(--accent); text-decoration: none; }
.hub-top { display: flex; justify-content: space-between; align-items: center; }
.hub-idx { font-size: 11px; color: var(--accent); font-weight: 700; }
.hub-cnt { font-size: 11px; color: var(--muted); background: var(--surface-2); padding: 2px 8px; border-radius: 999px; }
.hub-card h3 { font-size: 16px; font-weight: 750; }
.hub-card p { font-size: 12.5px; color: var(--muted); line-height: 1.55; flex: 1; }
.hub-go { font-size: 12.5px; font-weight: 600; color: var(--accent); margin-top: 4px; }

/* Final CTA */
.cta-band {
  max-width: 1132px; margin: 0 auto 72px; padding: 42px 32px; border-radius: 20px; text-align: center;
  border: 1px solid color-mix(in srgb, var(--accent) 34%, var(--border));
  background:
    radial-gradient(ellipse 65% 80% at 50% 0%, var(--glow-1), transparent 72%),
    var(--surface);
  box-shadow: var(--shadow-lg);
}
.cta-band h2 { font-size: clamp(24px, 3.2vw, 34px); font-weight: 850; letter-spacing: -0.03em; margin-bottom: 10px; }
.cta-band p { font-size: 15px; color: var(--muted); max-width: 580px; margin: 0 auto 24px; }

footer {
  max-width: 1180px; margin: 0 auto; padding: 28px 24px 56px;
  border-top: 1px solid var(--border); display: flex; justify-content: space-between; flex-wrap: wrap; gap: 14px;
  font-size: 13px; color: var(--muted);
}

@media (max-width: 980px) {
  .metrics, .hub-grid { grid-template-columns: repeat(2, 1fr); }
  .span-7, .span-6, .span-5 { grid-column: span 12; }
  .dep-grid, .acc-grid { grid-template-columns: 1fr; }
  .nav-mid { display: none; }
}
@media (max-width: 560px) {
  .metrics, .hub-grid { grid-template-columns: 1fr; }
}
</style>
</head>
<body>
<header class="topbar">
  <div class="topbar-in">
    <a class="brand" href="index.html">
      <img src="assets/tycho-logo-512.png" alt="Tycho" />
      <span>tycho</span>
      <span class="ver-pill mono">v0.2.1</span>
    </a>
    <nav class="nav-mid">
      <a href="#theater" data-i18n="nav_ui">界面展示</a>
      <a href="#bento" data-i18n="nav_feat">核心优势</a>
      <a href="#compare" data-i18n="nav_cmp">架构对比</a>
      <a href="#deploy" data-i18n="nav_dep">部署拓扑</a>
      <a href="docs/quickstart.html" data-i18n="nav_docs">文档中心</a>
    </nav>
    <div class="nav-r">
      <button class="btn" id="search-btn" type="button"><span data-i18n="nav_search">搜索</span> <span class="kbd">Ctrl K</span></button>
      <button class="btn" id="lang-btn" type="button">EN</button>
      <button class="btn" id="theme-btn" type="button" aria-label="Toggle color theme">☀</button>
      <a class="btn btn-ink" href="${REPO_URL}" target="_blank" rel="noreferrer">GitHub ↗</a>
    </div>
  </div>
</header>

<div class="hero-wrap">
  <section class="hero">
    <div class="eyebrow"><span class="pulse"></span><span data-i18n="eyebrow">v0.2.1 开源首发 · 零运行时依赖 · Node 24 + SQLite · MIT License</span></div>
    <h1 data-i18n="h1">为原生 AI Coding Agent 打造的<br/>自托管编排控制面</h1>
    <p class="lead" data-i18n="lead">直接调度你已有的 Claude Code、Codex、Gemini (agy) 与 dsh —— 用一本零依赖 SQLite 账本统一接管多台算力机、多份订阅额度、任意 IM 通道与多端原生客户端。</p>

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
      <a class="btn btn-pri" href="docs/quickstart.html" data-i18n="cta_docs">5 分钟快速上手 →</a>
      <a class="btn" href="${REPO_URL}/releases/tag/app-v0.2.0" target="_blank" rel="noreferrer" data-i18n="cta_cli">下载 3.6 MB 桌面端 &amp; PWA</a>
      <a class="btn" href="docs/remote-access.html" data-i18n="cta_vps">公网云服务器部署</a>
    </div>
  </section>

  <section class="stage" id="theater">
    <div class="stage-tabs" role="tablist" aria-label="Product UI Views">
      <button class="vtab on" data-view="console" type="button" data-i18n="v_con">项目指挥台</button>
      <button class="vtab" data-view="accounts" type="button" data-i18n="v_acc">多号额度池</button>
      <button class="vtab" data-view="channels" type="button" data-i18n="v_ch">IM 与事件触发器</button>
      <button class="vtab" data-view="clients" type="button" data-i18n="v_cl">3.6 MB 桌面端 &amp; PWA</button>
      <button class="vtab" data-view="arch" type="button" data-i18n="v_arch">系统架构全景</button>
    </div>
    <div class="stage-shell">
      <img id="stage-img" src="assets/preview-console.png" alt="Tycho Product Preview" />
      <div class="stage-cap">
        <div><strong id="cap-title"></strong><span id="cap-desc"></span></div>
        <a id="cap-link" href="docs/quickstart.html" style="font-weight:600;white-space:nowrap">查看详情 →</a>
      </div>
    </div>
  </section>
</div>

<section class="metrics">
  <div class="met"><b class="mono">0</b><strong data-i18n="m1_t">运行时外部依赖</strong><span data-i18n="m1_d">纯 Node 24 + 内置 node:sqlite，无需 Docker/Redis/Postgres</span></div>
  <div class="met"><b class="mono">3.6 MB</b><strong data-i18n="m2_t">轻量 Tauri v2 桌面端</strong><span data-i18n="m2_d">拒绝 Electron 臃肿；另含 iOS/Android 零安装 PWA</span></div>
  <div class="met"><b class="mono">4 CLIs</b><strong data-i18n="m3_t">100% 透传原生执行器</strong><span data-i18n="m3_d">Claude Code · Codex · Gemini (agy) · dsh 官方生态全保留</span></div>
  <div class="met"><b class="mono">4 Modes</b><strong data-i18n="m4_t">零入站 SSH 部署拓扑</strong><span data-i18n="m4_d">本机 · 公网 VPS · Tailscale · 穿透代理 WSS :443 隧道</span></div>
</section>

<section class="sec" id="bento">
  <div class="sec-h">
    <div>
      <span class="sec-kicker mono">WHY TYCHO</span>
      <h2 data-i18n="b_h">为工程级多机编排而生，而不是又一个聊天套壳</h2>
      <p data-i18n="b_p">保留你原本付费订阅的原生 CLI 与全部工具链，把持久化账本、多机算力、多号额度容错、IM 协作与插件触发做到开箱即用。</p>
    </div>
  </div>

  <div class="bento">
    <div class="bcard span-7">
      <div>
        <span class="b-tag mono">01 / BYOS NATIVE CLIS + SQLITE LEDGER</span>
        <h3 data-i18n="b1_t">100% 透传原生 CLI，一本零依赖 SQLite 账本管全链路</h3>
        <p data-i18n="b1_p">不强迫你换 API Key，也不魔改执行器。每条任务先记意图再派发，数据库唯一索引锁死单活跃轮次，崩溃重启如实核对机器现场；支持多机空闲自动升级 CLI。</p>
      </div>
      <div class="mini-box">
        <div class="chip-row mono">
          <span class="chip acc">claude-code</span>
          <span class="chip acc">openai-codex</span>
          <span class="chip acc">gemini (agy)</span>
          <span class="chip acc">dsh</span>
          <span class="chip ok">Idle Fleet Auto-Update</span>
        </div>
        <div class="trace-line mono">
          <span class="trace-step">1. Intent Recorded</span><span>→</span>
          <span class="trace-step">2. codex @ linux-gpu-01</span><span>→</span>
          <span class="trace-step">3. claude cross-review</span><span>→</span>
          <span class="trace-step done">✓ Settled in SQLite</span>
        </div>
      </div>
    </div>

    <div class="bcard span-5">
      <div>
        <span class="b-tag mono">02 / UNIFIED ACCOUNTS &amp; QUOTA PLUGINS</span>
        <h3 data-i18n="b2_t">多号三档池 + 5h/7d 自动歇息切号</h3>
        <p data-i18n="b2_p">集中托管 OAuth 与单机登录统一编池，按「决策 / 执行 / 操作」三档路由，P1 触限自动顺延 P2；支持 drop-in <code>~/.tycho/quota-probes/*.mjs</code> 私有计费插件。</p>
      </div>
      <div class="mini-box">
        <div class="q-row">
          <div class="q-head"><span>P1 · Work Codex (5h)</span><span class="mono" style="color:var(--green)">18%</span></div>
          <div class="q-bar"><div class="q-fill" style="width:18%;background:var(--green)"></div></div>
        </div>
        <div class="q-row">
          <div class="q-head"><span>P2 · Gemini Ultra (7d)</span><span class="mono" style="color:var(--accent)">16%</span></div>
          <div class="q-bar"><div class="q-fill" style="width:16%;background:var(--accent)"></div></div>
        </div>
        <div class="q-row">
          <div class="q-head"><span>P3 · Custom Gateway Plugin</span><span class="mono" style="color:var(--amber)">\$108 / \$200</span></div>
          <div class="q-bar"><div class="q-fill" style="width:54%;background:var(--amber)"></div></div>
        </div>
      </div>
    </div>

    <div class="bcard span-5">
      <div>
        <span class="b-tag mono">03 / OUTBOUND FLEET · ZERO INBOUND SSH</span>
        <h3 data-i18n="b3_t">工作站零开放端口，主动外连公网或内网主机</h3>
        <p data-i18n="b3_p">不管算力机在公司内网、家里 Windows 台式机还是 MacBook，运行 <code>tycho node join</code> 主动出站长连，NAT 与企业代理下自动走内置 SSH-over-WSS <code>:443</code>。</p>
      </div>
      <div class="mini-box" style="align-items:center">
        <svg viewBox="0 0 360 112" width="100%" style="max-width:360px" aria-label="Outbound node topology">
          <rect x="6" y="10" width="110" height="28" rx="7" fill="var(--surface)" stroke="var(--border-strong)"/>
          <text x="61" y="28" text-anchor="middle" fill="var(--ink)" font-size="11" font-family="var(--font-mono)">linux-gpu-01</text>
          <rect x="6" y="44" width="110" height="28" rx="7" fill="var(--surface)" stroke="var(--border-strong)"/>
          <text x="61" y="62" text-anchor="middle" fill="var(--ink)" font-size="11" font-family="var(--font-mono)">macbook-pro</text>
          <rect x="6" y="78" width="110" height="28" rx="7" fill="var(--surface)" stroke="var(--border-strong)"/>
          <text x="61" y="96" text-anchor="middle" fill="var(--ink)" font-size="11" font-family="var(--font-mono)">win-desktop</text>
          <path d="M118 24 C165 24, 175 56, 224 56" fill="none" stroke="var(--accent)" stroke-width="1.8" stroke-dasharray="4 3"/>
          <path d="M118 58 L224 56" fill="none" stroke="var(--green)" stroke-width="1.8" stroke-dasharray="4 3"/>
          <path d="M118 92 C165 92, 175 56, 224 56" fill="none" stroke="var(--accent-2)" stroke-width="1.8" stroke-dasharray="4 3"/>
          <rect x="226" y="28" width="128" height="58" rx="11" fill="var(--accent-soft)" stroke="var(--accent)" stroke-width="1.5"/>
          <text x="290" y="53" text-anchor="middle" fill="var(--ink)" font-size="12" font-weight="700">Tycho Host</text>
          <text x="290" y="70" text-anchor="middle" fill="var(--accent)" font-size="10" font-family="var(--font-mono)">HTTPS / WSS :443</text>
        </svg>
      </div>
    </div>

    <div class="bcard span-7">
      <div>
        <span class="b-tag mono">04 / PLUGGABLE IMS &amp; EVENT TRIGGERS</span>
        <h3 data-i18n="b4_t">随意接入任何 IM 平台，插件级事件触发自动闭环</h3>
        <p data-i18n="b4_p">内置企业微信长连接、个人微信 iLink 扫码与飞书桥接，并开放 <code>tycho-v1</code> 双向 HMAC 协议（群聊快慢分流 + 严禁泄露私有控制台）；原生支持 IANA 时区 Cron、SQLite 事务内生命周期事件与签名 Webhook。</p>
      </div>
      <div class="mini-box">
        <div class="chip-row">
          <span class="chip ok">企微长连接 WS</span>
          <span class="chip ok">个人微信 iLink</span>
          <span class="chip acc">飞书 Bridge (tycho-v1)</span>
          <span class="chip">Slack / Discord / Telegram</span>
        </div>
        <div class="chip-row mono">
          <span class="chip">CRON · Asia/Shanghai</span>
          <span class="chip">EVENT · ready / accepted / merged</span>
          <span class="chip">WEBHOOK · HMAC + Broadcast Groups</span>
        </div>
      </div>
    </div>

    <div class="bcard span-6">
      <div>
        <span class="b-tag mono">05 / SHARED BRAIN · SKILLS &amp; KNOWLEDGE MCP</span>
        <h3 data-i18n="b5_t">主机一份 SKILL.md 镜像全网，外部 CLI 直挂 Knowledge MCP</h3>
        <p data-i18n="b5_p">标准 <code>SKILL.md</code> 技能包放在主机即可自动同步到全部接入节点；外部独立的 Claude / Codex 会话也能通过受限节点令牌挂载项目知识库，绝不越权。</p>
      </div>
      <div class="mini-box mono" style="font-size:12px">
        <div style="display:flex;justify-content:space-between;color:var(--green)"><span>✓ Skills Mirror</span><span>3/3 Nodes Synced</span></div>
        <div style="color:var(--ink-2)">$ tycho knowledge-mcp --node</div>
      </div>
    </div>

    <div class="bcard span-6">
      <div>
        <span class="b-tag mono">06 / EVERYWHERE CLIENTS &amp; HOT-RELOAD THEMES</span>
        <h3 data-i18n="b6_t">3.6 MB 桌面壳 · 手机 PWA · 扔 JSON 即换主题</h3>
        <p data-i18n="b6_p">Windows 绿色单文件 3.67 MB、macOS Universal 3.59 MB、iOS/Android 免商店 PWA；把主题 JSON 丢进 <code>&lt;dataDir&gt;/themes/</code> 控制台热加载切换，点下面色板实时体验：</p>
      </div>
      <div class="theme-demo" id="theme-demo" style="background:#0B1120;color:#F1F5F9;border-color:rgba(56,189,248,0.35)">
        <div style="display:flex;justify-content:space-between;align-items:center;font-size:12px">
          <strong class="mono" id="td-name">themes/midnight.json</strong>
          <span class="mono" id="td-badge" style="color:#38BDF8">● Hot-Reloaded</span>
        </div>
        <div class="td-swatches">
          <button class="td-btn on" type="button" data-td="midnight"><span class="td-dot" style="background:#38BDF8"></span>Midnight</button>
          <button class="td-btn" type="button" data-td="nordic"><span class="td-dot" style="background:#0284C7"></span>Nordic</button>
          <button class="td-btn" type="button" data-td="ember"><span class="td-dot" style="background:#F97316"></span>Ember</button>
          <button class="td-btn" type="button" data-td="forest"><span class="td-dot" style="background:#10B981"></span>Forest</button>
        </div>
      </div>
    </div>
  </div>
</section>

<section class="sec" id="compare">
  <div class="sec-h">
    <div>
      <span class="sec-kicker mono">ARCHITECTURAL EDGE</span>
      <h2 data-i18n="c_h">对比：为什么不是裸 tmux，也不是普通 AI 套壳？</h2>
      <p data-i18n="c_p">一张表看清 Tycho 在工程可靠性、订阅复用、多机协作与扩展性上的真实差距。</p>
    </div>
  </div>
  <div class="cmp-wrap">
    <table class="cmp">
      <thead>
        <tr>
          <th data-i18n="c_col1">工程维度</th>
          <th data-i18n="c_col2">裸终端 / tmux / SSH</th>
          <th data-i18n="c_col3">常见 AI GUI 套壳</th>
          <th class="ty">Tycho Control Plane</th>
        </tr>
      </thead>
      <tbody>
        <tr><td data-i18n="c_r1">保留官方 CLI 订阅 &amp; 本地 MCP/Git</td><td data-i18n="c_1a">✓ 保留</td><td class="no" data-i18n="c_1b">✕ 往往强依赖按量 API Key</td><td class="ty" data-i18n="c_1c">✓ 100% 透传原生 CLI 与工具生态</td></tr>
        <tr><td data-i18n="c_r2">持久化任务账本 &amp; 崩溃后对账</td><td class="no" data-i18n="c_2a">✕ 断网/重启即丢上下文</td><td class="no" data-i18n="c_2b">△ 仅聊天记录，无执行约束</td><td class="ty" data-i18n="c_2c">✓ 零依赖 SQLite 账本 + 单活跃轮次唯一锁</td></tr>
        <tr><td data-i18n="c_r3">跨机算力调度（无入站 SSH）</td><td class="no" data-i18n="c_3a">✕ 手工开多窗口管理</td><td class="no" data-i18n="c_3b">✕ 仅限本机单机</td><td class="ty" data-i18n="c_3c">✓ 节点主动外连 + 公网 VPS / Tailscale / WSS :443</td></tr>
        <tr><td data-i18n="c_r4">多账号额度监控 &amp; 自动歇息切号</td><td class="no" data-i18n="c_4a">✕ 触发限流人工手动切</td><td class="no" data-i18n="c_4b">✕ 无统一三档配额路由</td><td class="ty" data-i18n="c_4c">✓ 5h/7d 遥测 + P1→P2 顺延 + 私有计费插件</td></tr>
        <tr><td data-i18n="c_r5">IM 协作 &amp; 插件级事件触发</td><td class="no" data-i18n="c_5a">✕ 无</td><td class="no" data-i18n="c_5b">✕ 封闭难扩展</td><td class="ty" data-i18n="c_5c">✓ 企微/微信/飞书 + 开放签名协议 + Cron/事件/Webhook</td></tr>
        <tr><td data-i18n="c_r6">桌面与移动端随时审批</td><td class="no" data-i18n="c_6a">✕ 手机 SSH 体验极差</td><td class="no" data-i18n="c_6b">△ 200 MB+ Electron 重壳</td><td class="ty" data-i18n="c_6c">✓ 3.6 MB Tauri 桌面壳 + iOS/Android 独立 PWA</td></tr>
      </tbody>
    </table>
  </div>
</section>

<section class="sec" id="deploy">
  <div class="sec-h">
    <div>
      <span class="sec-kicker mono">DEPLOYMENT TOPOLOGIES</span>
      <h2 data-i18n="d_h">4 种部署拓扑，从本机 90 秒试用到公网 24×7 托管</h2>
      <p data-i18n="d_p">无需 root、无需 Docker、无需预装 Node 24。点击切换对应拓扑查看完整命令与最佳实践。</p>
    </div>
  </div>
  <div class="dep-tabs" id="dep-tabs">
    <button class="btn btn-pri" data-mode="vps" type="button" data-i18n="t_vps">公网云服务器 VPS（推荐）</button>
    <button class="btn" data-mode="local" type="button" data-i18n="t_loc">本机 90 秒试用</button>
    <button class="btn" data-mode="mesh" type="button" data-i18n="t_mesh">Tailscale / 局域网</button>
    <button class="btn" data-mode="tunnel" type="button" data-i18n="t_tun">NAT 反向隧道 / WSS :443</button>
  </div>
  <div class="dep-grid">
    <div>
      <h3 id="dep-title" style="font-size:20px;font-weight:750;margin-bottom:8px"></h3>
      <p id="dep-desc" style="font-size:14px;color:var(--muted)"></p>
      <ul class="dep-list" id="dep-steps"></ul>
      <a class="btn" href="docs/remote-access.html" data-i18n="d_more">查看完整 4 种拓扑部署手册 →</a>
    </div>
    <div class="code-block" style="margin:0">
      <div class="code-head"><span class="mono code-lang" id="dep-lang">bash</span><button class="copy-btn" id="copy-dep" type="button">Copy</button></div>
      <pre><code id="dep-code"></code></pre>
    </div>
  </div>
</section>

<section class="sec" id="protocols" aria-labelledby="proto-heading">
  <div class="sec-h">
    <div>
      <span class="sec-kicker mono">OPEN PROTOCOLS &amp; EXTENSIBILITY</span>
      <h2 id="proto-heading" data-i18n="p_h">开放协议与插件接口深潜</h2>
      <p data-i18n="p_p">点击展开平滑查看精确签名规范、插件输入输出契约与安全信任边界。</p>
    </div>
  </div>
  <div class="acc-grid">
    <details class="d">
      <summary data-i18n="d1_t">开放 IM 双向签名协议（企微 / 微信 / 飞书 / Slack / Discord）</summary>
      <div class="db">
        <p data-i18n="d1_p">通过 POST /inbound/:src 投递 HMAC-SHA256 签名事件（支持群快慢分流与上下文），经 GET /inbound/:src/result/:id 仅回读总控明确发布的公开答复，绝不泄露私有控制台。</p>
        <pre class="mini-pre">HMAC-SHA256(secret, "v1\\n" + ts + "\\n" + eventId + "\\n" + project + "\\n" + rawBody)</pre>
        <a href="docs/extensibility.html" data-i18n="d1_a">查看完整协议与飞书参考实现 →</a>
      </div>
    </details>
    <details class="d">
      <summary data-i18n="d2_t">3 类插件级事件触发器（Cron · 内部事件 · 签名 Webhook）</summary>
      <div class="db">
        <p data-i18n="d2_p">支持显式 IANA 时区 Cron、SQLite 事务内生命周期事件（ready / accepted / merged / released）及 GitHub / tycho-v1 签名 Webhook，支持自动播报绑定群聊。</p>
        <pre class="mini-pre">trigger: { kind: "internal_event", event: "task.ready", broadcast_groups: true }</pre>
        <a href="docs/channels-and-triggers.html" data-i18n="d2_a">查看触发器完整指南 →</a>
      </div>
    </details>
    <details class="d">
      <summary data-i18n="d3_t">本机即插即用额度探针插件（~/.tycho/quota-probes/）</summary>
      <div class="db">
        <p data-i18n="d3_p">无需改源码即可对接私有网关或企业内部计费接口：脚本从 stdin 读取内置结果并向 stdout 输出标准化预算窗口 JSON，密钥全程留在节点本地。</p>
        <pre class="mini-pre">{ "windows": [{ "label": "Monthly Budget", "used_pct": 42, "resets_at": "..." }] }</pre>
        <a href="docs/quota-plugins.html" data-i18n="d3_a">查看额度探针插件规范 →</a>
      </div>
    </details>
    <details class="d">
      <summary data-i18n="d4_t">跨机 SKILL.md 同步、Knowledge MCP、主题包与安全边界</summary>
      <div class="db">
        <p data-i18n="d4_p">主机一份技能包自动镜像全网节点；外部 CLI 可通过 tycho knowledge-mcp --node 挂载受限知识工具；以 OS 用户与机器隔离为主要安全边界。</p>
        <pre class="mini-pre">tycho knowledge-mcp --node   # Scoped read/write via worker node token</pre>
        <a href="docs/security.html" data-i18n="d4_a">查看安全模型与信任边界 →</a>
      </div>
    </details>
  </div>
</section>

<section class="sec" id="docs-hub">
  <div class="sec-h">
    <div>
      <span class="sec-kicker mono">DOCUMENTATION PORTAL</span>
      <h2 data-i18n="dh_h">完整 17 篇中文工程文档，全站 Ctrl+K 秒查</h2>
      <p data-i18n="dh_p">从 5 分钟首跑、公网 VPS 部署、账号池三档路由到 112 项配置全量代码生成参考，开箱即读。</p>
    </div>
    <a class="btn" href="docs/quickstart.html" data-i18n="dh_all">浏览全部文档 →</a>
  </div>
  <div class="hub-grid">${docHubCards}</div>
</section>

<section class="cta-band">
  <h2 data-i18n="cta_h">带上你已有的 CLI，掌控自己的 AI 工程控制面</h2>
  <p data-i18n="cta_p">开源 MIT 协议 · 零运行时依赖 · 90 秒本机跑通，5 分钟接入公网与全端设备。</p>
  <div class="hero-cta">
    <a class="btn btn-pri" href="docs/quickstart.html" data-i18n="cta_b1">立即开始部署 →</a>
    <a class="btn" href="${REPO_URL}/releases" target="_blank" rel="noreferrer" data-i18n="cta_b2">查看 v0.2.1 &amp; 桌面端下载</a>
    <a class="btn" href="${REPO_URL}" target="_blank" rel="noreferrer">GitHub Star ↗</a>
  </div>
</section>

<footer>
  <div><strong>Tycho</strong> · v0.2.1 · MIT License · Zero Runtime Dependencies</div>
  <div style="display:flex;gap:18px;flex-wrap:wrap">
    <a href="docs/quickstart.html">Quickstart</a>
    <a href="docs/remote-access.html">Public VPS</a>
    <a href="docs/cli.html">CLI Reference</a>
    <a href="docs/settings.html">Settings (112)</a>
    <a href="docs/security.html">Security</a>
    <a href="${REPO_URL}/releases" target="_blank" rel="noreferrer">Releases</a>
  </div>
</footer>

${SEARCH_DIALOG_HTML}

<script>
const INST = {
  unix: 'curl -fsSL https://github.com/XaineChaeson/tycho/releases/latest/download/install.sh | bash',
  win: 'irm https://github.com/XaineChaeson/tycho/releases/latest/download/install.ps1 | iex',
};
const VIEWS = {
  zh: {
    console: { img: 'assets/preview-console.png', title: '项目指挥台', desc: '总控拆解任务并跨机派发给 Codex 执行与 Claude 审阅，全过程 SSE 实时流式呈现并落盘 SQLite。', href: 'docs/quickstart.html' },
    accounts: { img: 'assets/preview-accounts.png', title: '统一账号池与三档路由', desc: '集中托管与单机登录统一编池，实时追踪 5h/7d 窗口与私有计费插件，P1 触限自动顺延 P2。', href: 'docs/accounts-and-nodes.html' },
    channels: { img: 'assets/preview-channels.png', title: '随意接 IM 与插件级触发器', desc: '企微 / 个人微信 / 飞书与开放 HMAC 协议双向接入（群快慢分流 + 严禁泄露控制台），配合 Cron / 生命周期事件 / Webhook。', href: 'docs/channels-and-triggers.html' },
    clients: { img: 'assets/preview-clients.png', title: '3.6 MB 桌面壳 · 手机 PWA · 热插拔主题', desc: 'Windows/macOS/Linux 原生轻量桌面壳（Origin-only 安全落盘）+ iOS/Android 独立 PWA + JSON 主题包与 SKILL.md 全网镜像。', href: 'docs/clients.html' },
    arch: { img: 'assets/diagram-architecture.png', title: '零依赖核心架构全景', desc: '一本 SQLite 账本统筹总控决策、出站多机算力、多号三档池与外部 IM/Webhook 扩展边界。', href: 'docs/architecture.html' },
  },
  en: {
    console: { img: 'assets/preview-console.png', title: 'Mission Control', desc: 'Project router dispatches bounded work across machines (Codex execute + Claude review), streamed via SSE and settled in SQLite.', href: 'docs/quickstart.html' },
    accounts: { img: 'assets/preview-accounts.png', title: 'Unified Accounts & 3-Tier Routing', desc: 'Pool managed OAuth and machine logins with live 5h/7d telemetry, private billing plugins, and automatic P1→P2 failover.', href: 'docs/accounts-and-nodes.html' },
    channels: { img: 'assets/preview-channels.png', title: 'Pluggable IMs & Event Triggers', desc: 'WeCom WS, Personal WeChat QR, Feishu & open HMAC protocol (fast/slow group routing, zero console leaks) + Cron, internal events & webhooks.', href: 'docs/channels-and-triggers.html' },
    clients: { img: 'assets/preview-clients.png', title: '3.6 MB Desktop · Mobile PWA · JSON Themes', desc: 'Lightweight Tauri v2 desktop shells (origin-only storage), standalone iOS/Android PWA, hot-reload themes & SKILL.md fleet mirror.', href: 'docs/clients.html' },
    arch: { img: 'assets/diagram-architecture.png', title: 'Zero-Dep System Architecture', desc: 'One Node 24 + SQLite ledger unifying project routing, outbound worker nodes, quota failover, and open integration boundaries.', href: 'docs/architecture.html' },
  },
};
const DEPS = {
  zh: {
    vps: { title: '公网云服务器 / VPS 24×7 托管', desc: '在带公网 HTTPS 域名的 Linux 云主机常驻运行，随时接入工作站、笔记本、3.6 MB 桌面端与手机 PWA。', steps: ['普通用户运行 install.sh 并启用 tycho service install 与 loginctl enable-linger。', 'Nginx / Caddy 反代 127.0.0.1:8787（务必设置 proxy_buffering off 保障 SSE）。', '控制台设置对外地址后，任意机器 tycho node join --to https://tycho.example.com。'], code: 'curl -fsSL https://github.com/XaineChaeson/tycho/releases/latest/download/install.sh \\\\\\n  | bash\\ntycho service install && loginctl enable-linger "$USER"\\n\\n# 任意远程机器接入（无需开放入站端口）：\\ntycho node join --to https://tycho.example.com\\ntycho node service install' },
    local: { title: '本机 90 秒快速试用', desc: '零配置直接在自己电脑跑通闭环，回环接入自动放行。', steps: ['本机已装并登录至少一个 CLI（codex / claude / agy / dsh）。', 'tycho run --open 启动在 http://127.0.0.1:8787 并自动打开登录页。', '另开终端运行 tycho node join --to http://127.0.0.1:8787。'], code: 'tycho run --open\\n# 另开终端接入本机算力：\\ntycho node join --to http://127.0.0.1:8787' },
    mesh: { title: 'Tailscale / WireGuard / 局域网', desc: '零公网暴露，仅在私有组网内互通全部设备与节点。', steps: ['控制台「设置 › 服务」设 http.host = 0.0.0.0（防火墙仅放行组网网卡）。', '将 http.publicUrl 设为 https://<host>.tailnet.ts.net 并重启主机。', '组网内其他机器直接 tycho node join --to https://<host>.tailnet.ts.net。'], code: 'tycho stop && tycho service start\\ntycho node join --to https://my-host.tailnet.ts.net' },
    tunnel: { title: 'NAT 反向隧道门牌（支持 WSS :443）', desc: '主机留在内网零入站端口，主动外连公网轻量中转机；22 端口受限时可走 WSS :443 穿透 HTTPS_PROXY。', steps: ['公网中转机配置受限 SSH 用户（MaxSessions 0 + permitlisten="127.0.0.1:18787"）。', '主机生成专用 ed25519 私钥并在控制台「设置 › 门牌」填入。', '无需重启自动拉起隧道，tycho doctor 验证已连接。'], code: 'ssh-keygen -t ed25519 -f ~/.tycho/gateway_ed25519 -N ""\\n# 控制台「设置 › 门牌」：gateway.ssh = tycho-gw@relay | remotePort = 18787' },
  },
  en: {
    vps: { title: 'Public Cloud Server / VPS (24×7 Hub)', desc: 'Run Host 24×7 on any Linux VPS behind Nginx/Caddy HTTPS and join workstations, MacBooks, Desktop & Mobile PWA from anywhere.', steps: ['Install as a normal user and enable systemd linger.', 'Reverse-proxy 127.0.0.1:8787 over HTTPS with proxy_buffering off for SSE.', 'Set Public URL in Settings, then join any remote machine via tycho node join.'], code: 'curl -fsSL https://github.com/XaineChaeson/tycho/releases/latest/download/install.sh \\\\\\n  | bash\\ntycho service install && loginctl enable-linger "$USER"\\n\\n# Join any remote workstation (zero inbound ports):\\ntycho node join --to https://tycho.example.com\\ntycho node service install' },
    local: { title: 'Localhost Solo Start (90s)', desc: 'Zero-config local start on one workstation; loopback joins auto-approve.', steps: ['Have at least one native CLI logged in (codex / claude / agy / dsh).', 'Run tycho run --open to sign in at http://127.0.0.1:8787.', 'Join in a second terminal with tycho node join --to http://127.0.0.1:8787.'], code: 'tycho run --open\\n# Second terminal:\\ntycho node join --to http://127.0.0.1:8787' },
    mesh: { title: 'Tailscale / WireGuard / LAN Mesh', desc: 'Zero public exposure; bind inside your private Tailnet or LAN firewall.', steps: ['Set http.host = 0.0.0.0 and http.publicUrl = https://<host>.tailnet.ts.net.', 'Restart Host via tycho stop && tycho service start.', 'Join peers over your Tailnet URL.'], code: 'tycho stop && tycho service start\\ntycho node join --to https://my-host.tailnet.ts.net' },
    tunnel: { title: 'NAT Reverse-Tunnel Gateway (WSS :443)', desc: 'Keep Host behind corporate/home NAT with zero inbound ports; built-in SSH-over-WebSocket :443 traverses HTTPS_PROXY.', steps: ['Configure a locked-down SSH user (MaxSessions 0, permitlisten) on a relay VPS.', 'Generate a dedicated ed25519 key on Host and enter it in Settings › Gateway.', 'Tunnel connects live without restarting Host; verify with tycho doctor.'], code: 'ssh-keygen -t ed25519 -f ~/.tycho/gateway_ed25519 -N ""\\n# Settings › Gateway: gateway.ssh = tycho-gw@relay | remotePort = 18787' },
  },
};
const THEMES_DEMO = {
  midnight: { name: 'themes/midnight.json', bg: '#0B1120', fg: '#F1F5F9', acc: '#38BDF8', bd: 'rgba(56,189,248,0.38)' },
  nordic: { name: 'themes/nordic-ice.json', bg: '#F8FAFC', fg: '#0F172A', acc: '#0284C7', bd: 'rgba(2,132,199,0.35)' },
  ember: { name: 'themes/ember-term.json', bg: '#18100C', fg: '#FEF3C7', acc: '#F97316', bd: 'rgba(249,115,22,0.42)' },
  forest: { name: 'themes/forest-mono.json', bg: '#091511', fg: '#ECFDF5', acc: '#10B981', bd: 'rgba(16,185,129,0.40)' },
};
const TXT = {
  zh: { nav_ui:'界面展示', nav_feat:'核心优势', nav_cmp:'架构对比', nav_dep:'部署拓扑', nav_docs:'文档中心', nav_search:'搜索', eyebrow:'v0.2.1 开源首发 · 零运行时依赖 · Node 24 + SQLite · MIT License', h1:'为原生 AI Coding Agent 打造的自托管编排控制面', lead:'直接调度你已有的 Claude Code、Codex、Gemini (agy) 与 dsh —— 用一本零依赖 SQLite 账本统一接管多台算力机、多份订阅额度、任意 IM 通道与多端原生客户端。', cta_docs:'5 分钟快速上手 →', cta_cli:'下载 3.6 MB 桌面端 & PWA', cta_vps:'公网云服务器部署', v_con:'项目指挥台', v_acc:'多号额度池', v_ch:'IM 与事件触发器', v_cl:'3.6 MB 桌面端 & PWA', v_arch:'系统架构全景', m1_t:'运行时外部依赖', m1_d:'纯 Node 24 + 内置 node:sqlite，无需 Docker/Redis/Postgres', m2_t:'轻量 Tauri v2 桌面端', m2_d:'拒绝 Electron 臃肿；另含 iOS/Android 零安装 PWA', m3_t:'100% 透传原生执行器', m3_d:'Claude Code · Codex · Gemini (agy) · dsh 官方生态全保留', m4_t:'零入站 SSH 部署拓扑', m4_d:'本机 · 公网 VPS · Tailscale · 穿透代理 WSS :443 隧道', b_h:'为工程级多机编排而生，而不是又一个聊天套壳', b_p:'保留你原本付费订阅的原生 CLI 与全部工具链，把持久化账本、多机算力、多号额度容错、IM 协作与插件触发做到开箱即用。', b1_t:'100% 透传原生 CLI，一本零依赖 SQLite 账本管全链路', b1_p:'不强迫你换 API Key，也不魔改执行器。每条任务先记意图再派发，数据库唯一索引锁死单活跃轮次，崩溃重启如实核对机器现场；支持多机空闲自动升级 CLI。', b2_t:'多号三档池 + 5h/7d 自动歇息切号', b2_p:'集中托管 OAuth 与单机登录统一编池，按「决策 / 执行 / 操作」三档路由，P1 触限自动顺延 P2；支持 drop-in ~/.tycho/quota-probes/*.mjs 私有计费插件。', b3_t:'工作站零开放端口，主动外连公网或内网主机', b3_p:'不管算力机在公司内网、家里 Windows 台式机还是 MacBook，运行 tycho node join 主动出站长连，NAT 与企业代理下自动走内置 SSH-over-WSS :443。', b4_t:'随意接入任何 IM 平台，插件级事件触发自动闭环', b4_p:'内置企业微信长连接、个人微信 iLink 扫码与飞书桥接，并开放 tycho-v1 双向 HMAC 协议（群聊快慢分流 + 严禁泄露私有控制台）；原生支持 IANA 时区 Cron、SQLite 事务内生命周期事件与签名 Webhook。', b5_t:'主机一份 SKILL.md 镜像全网，外部 CLI 直挂 Knowledge MCP', b5_p:'标准 SKILL.md 技能包放在主机即可自动同步到全部接入节点；外部独立的 Claude / Codex 会话也能通过受限节点令牌挂载项目知识库，绝不越权。', b6_t:'3.6 MB 桌面壳 · 手机 PWA · 扔 JSON 即换主题', b6_p:'Windows 绿色单文件 3.67 MB、macOS Universal 3.59 MB、iOS/Android 免商店 PWA；把主题 JSON 丢进 <dataDir>/themes/ 控制台热加载切换，点下面色板实时体验：', c_h:'对比：为什么不是裸 tmux，也不是普通 AI 套壳？', c_p:'一张表看清 Tycho 在工程可靠性、订阅复用、多机协作与扩展性上的真实差距。', c_col1:'工程维度', c_col2:'裸终端 / tmux / SSH', c_col3:'常见 AI GUI 套壳', c_r1:'保留官方 CLI 订阅 & 本地 MCP/Git', c_1a:'✓ 保留', c_1b:'✕ 往往强依赖按量 API Key', c_1c:'✓ 100% 透传原生 CLI 与工具生态', c_r2:'持久化任务账本 & 崩溃后对账', c_2a:'✕ 断网/重启即丢上下文', c_2b:'△ 仅聊天记录，无执行约束', c_2c:'✓ 零依赖 SQLite 账本 + 单活跃轮次唯一锁', c_r3:'跨机算力调度（无入站 SSH）', c_3a:'✕ 手工开多窗口管理', c_3b:'✕ 仅限本机单机', c_3c:'✓ 节点主动外连 + 公网 VPS / Tailscale / WSS :443', c_r4:'多账号额度监控 & 自动歇息切号', c_4a:'✕ 触发限流人工手动切', c_4b:'✕ 无统一三档配额路由', c_4c:'✓ 5h/7d 遥测 + P1→P2 顺延 + 私有计费插件', c_r5:'IM 协作 & 插件级事件触发', c_5a:'✕ 无', c_5b:'✕ 封闭难扩展', c_5c:'✓ 企微/微信/飞书 + 开放签名协议 + Cron/事件/Webhook', c_r6:'桌面与移动端随时审批', c_6a:'✕ 手机 SSH 体验极差', c_6b:'△ 200 MB+ Electron 重壳', c_6c:'✓ 3.6 MB Tauri 桌面壳 + iOS/Android 独立 PWA', d_h:'4 种部署拓扑，从本机 90 秒试用到公网 24×7 托管', d_p:'无需 root、无需 Docker、无需预装 Node 24。点击切换对应拓扑查看完整命令与最佳实践。', t_vps:'公网云服务器 VPS（推荐）', t_loc:'本机 90 秒试用', t_mesh:'Tailscale / 局域网', t_tun:'NAT 反向隧道 / WSS :443', d_more:'查看完整 4 种拓扑部署手册 →', p_h:'开放协议与插件接口深潜', p_p:'点击展开平滑查看精确签名规范、插件输入输出契约与安全信任边界。', d1_t:'开放 IM 双向签名协议（企微 / 微信 / 飞书 / Slack / Discord）', d1_p:'通过 POST /inbound/:src 投递 HMAC-SHA256 签名事件（支持群快慢分流与上下文），经 GET /inbound/:src/result/:id 仅回读总控明确发布的公开答复，绝不泄露私有控制台。', d1_a:'查看完整协议与飞书参考实现 →', d2_t:'3 类插件级事件触发器（Cron · 内部事件 · 签名 Webhook）', d2_p:'支持显式 IANA 时区 Cron、SQLite 事务内生命周期事件（ready / accepted / merged / released）及 GitHub / tycho-v1 签名 Webhook，支持自动播报绑定群聊。', d2_a:'查看触发器完整指南 →', d3_t:'本机即插即用额度探针插件（~/.tycho/quota-probes/）', d3_p:'无需改源码即可对接私有网关或企业内部计费接口：脚本从 stdin 读取内置结果并向 stdout 输出标准化预算窗口 JSON，密钥全程留在节点本地。', d3_a:'查看额度探针插件规范 →', d4_t:'跨机 SKILL.md 同步、Knowledge MCP、主题包与安全边界', d4_p:'主机一份技能包自动镜像全网节点；外部 CLI 可通过 tycho knowledge-mcp --node 挂载受限知识工具；以 OS 用户与机器隔离为主要安全边界。', d4_a:'查看安全模型与信任边界 →', dh_h:'完整 17 篇中文工程文档，全站 Ctrl+K 秒查', dh_p:'从 5 分钟首跑、公网 VPS 部署、账号池三档路由到 112 项配置全量代码生成参考，开箱即读。', dh_all:'浏览全部文档 →', cta_h:'带上你已有的 CLI，掌控自己的 AI 工程控制面', cta_p:'开源 MIT 协议 · 零运行时依赖 · 90 秒本机跑通，5 分钟接入公网与全端设备。', cta_b1:'立即开始部署 →', cta_b2:'查看 v0.2.1 & 桌面端下载' },
  en: { nav_ui:'UI Tour', nav_feat:'Capabilities', nav_cmp:'Compare', nav_dep:'Deploy', nav_docs:'Docs', nav_search:'Search', eyebrow:'v0.2.1 Public Release · Zero Runtime Dependencies · Node 24 + SQLite · MIT', h1:'A self-hosted control plane for native AI coding agents', lead:'Orchestrate Claude Code, OpenAI Codex, Gemini (agy), and dsh across every machine, account, IM, and device — backed by one zero-dependency SQLite ledger.', cta_docs:'5-Minute Quickstart →', cta_cli:'Desktop (3.6 MB) & PWA', cta_vps:'Public VPS Guide', v_con:'Mission Control', v_acc:'Accounts & Quotas', v_ch:'IM & Triggers', v_cl:'Desktop & PWA', v_arch:'Architecture', m1_t:'Runtime Dependencies', m1_d:'Pure Node 24 + built-in node:sqlite; zero Docker/Redis/Postgres', m2_t:'Tauri v2 Desktop Shell', m2_d:'No Electron bloat, plus zero-install iOS & Android PWA', m3_t:'100% Native CLIs', m3_d:'Keep your real Claude Code, Codex, Gemini (agy) & dsh subscriptions', m4_t:'Zero-Inbound Topologies', m4_d:'Localhost · Public VPS · Tailscale · NAT-traversal WSS :443', b_h:'Built as an engineering control plane, not another chat wrapper', b_p:'Keep your existing CLI subscriptions, MCPs, and Git credentials while gaining a durable ledger, outbound fleet routing, quota failover, and open integrations.', b1_t:'100% Native CLI Passthrough on One SQLite Ledger', b1_p:'No forced API-key switching. Persist intent before dispatching, enforce one active round per task via SQLite uniqueness, reconcile reality after crashes, and idle-upgrade CLIs fleet-wide.', b2_t:'3-Tier Accounts Pool & Automatic Quota Failover', b2_p:'Unify managed OAuth and machine sign-ins across Decide / Execute / Operate tiers, rest & failover P1→P2 on 5h/7d caps, and drop in ~/.tycho/quota-probes/*.mjs billing plugins.', b3_t:'Outbound Worker Fleet, Zero Inbound SSH Ports', b3_p:'Join office workstations, home Windows rigs, or MacBooks via tycho node join over outbound HTTPS or built-in SSH-over-WSS :443 through HTTPS_PROXY.', b4_t:'Pluggable IM Channels & Plugin-Grade Triggers', b4_p:'WeCom WS, Personal WeChat iLink QR, Feishu bridge, and open signed tycho-v1 HMAC protocol (fast/slow routing, zero console leaks), plus IANA-TZ Cron, atomic ledger events & HMAC webhooks.', b5_t:'Auto-Mirrored SKILL.md Fleet & Scoped Knowledge MCP', b5_p:'Keep one SKILL.md catalog on Host and mirror automatically to every node; attach scoped project knowledge to external CLIs via tycho knowledge-mcp --node.', b6_t:'3.6 MB Desktop · Mobile PWA · Hot-Reload JSON Themes', b6_p:'3.67 MB Windows portable exe, 3.59 MB macOS Universal DMG, iOS/Android standalone PWA; drop theme JSONs into <dataDir>/themes/ — preview swatches live below:', c_h:'Why Tycho over raw tmux or toy AI GUI wrappers?', c_p:'An honest side-by-side breakdown across durability, subscription reuse, multi-machine ops, and extensibility.', c_col1:'Capability', c_col2:'Raw Terminal / tmux / SSH', c_col3:'Generic AI GUI Wrappers', c_r1:'Keep native CLI subscriptions & MCPs', c_1a:'✓ Native', c_1b:'✕ Often forces pay-per-token API keys', c_1c:'✓ 100% passthrough of official CLIs & MCPs', c_r2:'Durable task ledger & crash reconciliation', c_2a:'✕ Lost on disconnect or reboot', c_2b:'△ Chat logs only, no execution invariants', c_2c:'✓ Zero-dep SQLite ledger + single active round lock', c_r3:'Multi-machine outbound fleet (no inbound SSH)', c_3a:'✕ Manual SSH panes per machine', c_3b:'✕ Single-machine only', c_3c:'✓ Outbound node join across VPS, Tailnet & WSS :443', c_r4:'Multi-account quota telemetry & P1→P2 failover', c_4a:'✕ Manual switching on rate limits', c_4b:'✕ No unified 3-tier quota routing', c_4c:'✓ 5h/7d telemetry + P1→P2 failover + billing plugins', c_r5:'Pluggable IM channels & event triggers', c_5a:'✕ None', c_5b:'✕ Closed & hard to extend', c_5c:'✓ WeCom/WeChat/Feishu + open HMAC IM + Cron/Events/Webhooks', c_r6:'Lightweight desktop & mobile approval', c_6a:'✕ Painful mobile SSH UX', c_6b:'△ 200 MB+ Electron wrapper', c_6c:'✓ 3.6 MB Tauri shell + standalone iOS/Android PWA', d_h:'Four deployment topologies, localhost to public cloud', d_p:'No root, no Docker, no Node pre-install required. Switch topologies for ready-to-paste commands.', t_vps:'Public Cloud VPS (Recommended)', t_loc:'Localhost (90s)', t_mesh:'Tailscale / LAN', t_tun:'NAT Tunnel / WSS :443', d_more:'Read Full 4-Topology Guide →', p_h:'Open protocols & plugin contracts', p_p:'Expand any accordion smoothly for exact HMAC formulas, plugin JSON contracts, and security boundaries.', d1_t:'Open bidirectional IM protocol (WeCom / WeChat / Feishu / Slack / Discord)', d1_p:'Deliver HMAC-SHA256 signed events via POST /inbound/:src (with fast/slow group routing), and read back only explicitly published replies via GET /inbound/:src/result/:id — zero console exposure.', d1_a:'Read protocol spec & Feishu bridge →', d2_t:'Three plugin-grade trigger families (Cron · Internal Events · Signed Webhooks)', d2_p:'Explicit IANA-timezone Cron, transactional SQLite lifecycle events (ready / accepted / merged / released), and GitHub or tycho-v1 HMAC webhooks with optional IM broadcast.', d2_a:'Read triggers guide →', d3_t:'Drop-in local quota probe plugins (~/.tycho/quota-probes/)', d3_p:'Integrate private gateways or corporate billing endpoints without forking: read built-in JSON on stdin and emit normalized quota windows on stdout while keeping keys local.', d3_a:'Read quota plugin contract →', d4_t:'SKILL.md fleet mirror, Knowledge MCP, JSON themes & security boundary', d4_p:'One Host skill pack mirrors across every worker; external CLIs attach scoped Knowledge MCP via tycho knowledge-mcp --node; OS users & machines form the primary boundary.', d4_a:'Read security model & boundaries →', dh_h:'17 engineering guides, searchable instantly with Ctrl+K', dh_p:'From 5-minute quickstart and public VPS setup to 3-tier routing and 112 auto-generated settings.', dh_all:'Browse All Docs →', cta_h:'Bring your native CLIs. Own your AI control plane.', cta_p:'MIT Licensed · Zero Runtime Dependencies · 90s locally, 5 minutes on your public VPS.', cta_b1:'Get Started Now →', cta_b2:'Download v0.2.1 & Desktop' },
};

let lang = 'zh', mode = 'vps', view = 'console';
function syncView() {
  const v = VIEWS[lang][view];
  const img = document.getElementById('stage-img');
  img.src = v.img;
  document.getElementById('cap-title').textContent = v.title;
  document.getElementById('cap-desc').textContent = v.desc;
  const link = document.getElementById('cap-link');
  link.href = v.href;
  link.textContent = lang === 'zh' ? '查看专题文档 →' : 'Read guide →';
}
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
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const k = el.getAttribute('data-i18n');
    if (TXT[lang][k]) el.textContent = TXT[lang][k];
  });
  syncView();
  syncDep();
}
document.querySelectorAll('.ip-tab').forEach(b => b.addEventListener('click', () => {
  document.querySelectorAll('.ip-tab').forEach(x => x.classList.toggle('on', x === b));
  document.getElementById('inst-cmd').textContent = INST[b.dataset.os];
}));
document.querySelectorAll('[data-view]').forEach(b => b.addEventListener('click', () => {
  view = b.dataset.view;
  document.querySelectorAll('[data-view]').forEach(x => x.classList.toggle('on', x === b));
  syncView();
}));
document.getElementById('dep-tabs').addEventListener('click', e => {
  const b = e.target.closest('[data-mode]'); if (!b) return;
  mode = b.dataset.mode;
  document.querySelectorAll('#dep-tabs [data-mode]').forEach(x => x.classList.toggle('btn-pri', x === b));
  syncDep();
});
document.querySelectorAll('[data-td]').forEach(b => b.addEventListener('click', () => {
  const t = THEMES_DEMO[b.dataset.td];
  document.querySelectorAll('[data-td]').forEach(x => x.classList.toggle('on', x === b));
  const box = document.getElementById('theme-demo');
  box.style.background = t.bg;
  box.style.color = t.fg;
  box.style.borderColor = t.bd;
  document.getElementById('td-name').textContent = t.name;
  document.getElementById('td-badge').style.color = t.acc;
}));
document.getElementById('lang-btn').addEventListener('click', () => { lang = lang === 'zh' ? 'en' : 'zh'; syncLang(); });
const bindCopy = (btnId, srcId) => document.getElementById(btnId).addEventListener('click', async () => {
  const btn = document.getElementById(btnId);
  try { await navigator.clipboard.writeText(document.getElementById(srcId).textContent); btn.textContent = 'Copied'; } catch {}
  setTimeout(() => { btn.textContent = 'Copy'; }, 1400);
});
bindCopy('copy-inst', 'inst-cmd');
bindCopy('copy-dep', 'dep-code');
syncLang();
${renderSharedScript('search-index.json', 'docs/')}
</script>
</body>
</html>`;
}

function renderDocPage(spec: DocSpec, index: number, htmlBody: string, headings: Heading[], minutes: number): string {
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
    ? headings.map((h) => `<a class="toc-l toc-${h.level}" href="#${h.id}" data-toc="${h.id}">${escapeHtml(h.text)}</a>`).join('')
    : '<span style="font-size:12px;color:var(--faint)">本页无子章节</span>';

  const prev = index > 0 ? DOC_PAGES[index - 1] : null;
  const next = index < DOC_PAGES.length - 1 ? DOC_PAGES[index + 1] : null;
  const editUrl = `${REPO_URL}/blob/main/${spec.source}`;

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
${THEME_HEAD_SNIPPET}
<title>${escapeHtml(spec.title)} — Tycho Docs</title>
<link rel="icon" type="image/svg+xml" href="../assets/tycho-logo.svg" />
<style>${SHARED_CSS}
/* Scroll Reading Progress Indicator (modern-web-guidance: scroll-progress-indicator) */
#read-progress {
  position: fixed; left: 0; top: 60px; z-index: 60;
  width: 100%; height: 2.5px; pointer-events: none;
  background: linear-gradient(90deg, var(--accent), var(--accent-2), var(--green));
  transform-origin: 0 50%; transform: scaleX(0);
}
@media (prefers-reduced-motion: no-preference) {
  @supports (animation-timeline: scroll()) {
    @keyframes grow-progress {
      from { transform: scaleX(0); }
      to { transform: scaleX(1); }
    }
    #read-progress {
      animation: grow-progress auto linear;
      animation-timeline: scroll();
    }
  }
}

.doc-layout { max-width: 1340px; margin: 0 auto; display: grid; grid-template-columns: 256px minmax(0, 1fr) 232px; gap: 38px; padding: 28px 24px 88px; }
/* CJK-safe robust two-level sidebar */
.sidebar { position: sticky; top: 86px; align-self: start; max-height: calc(100vh - 110px); overflow-y: auto; padding-right: 10px; }
.sb-group.sep { border-top: 1px solid var(--border); margin-top: 15px; padding-top: 15px; }
.sb-head { font-size: 0.875rem; font-weight: 750; color: var(--ink); margin-bottom: 7px; padding-left: 4px; }
.sb-list { margin-left: 0.55rem; border-left: 1px solid var(--border); display: flex; flex-direction: column; gap: 2px; padding-left: 10px; }
.sb-link { display: block; padding: 5.5px 10px; border-radius: 7px; font-size: 0.835rem; color: var(--muted); transition: background .12s, color .12s; }
.sb-link:hover { color: var(--ink); background: var(--surface-2); text-decoration: none; }
.sb-link.active { color: var(--accent); background: var(--accent-soft); font-weight: 650; box-shadow: inset 2.5px 0 0 var(--accent); }

/* Doc Meta Banner */
.doc-meta {
  display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap;
  padding-bottom: 14px; margin-bottom: 18px; border-bottom: 1px solid var(--border); font-size: 12.5px; color: var(--muted);
}
.crumb { display: flex; align-items: center; gap: 7px; }
.crumb b { color: var(--accent); font-weight: 650; }
.meta-r { display: flex; align-items: center; gap: 12px; }
.mob-menu-btn { display: none; }

/* Prose */
.prose { max-width: 78ch; min-width: 0; }
.prose h1 { font-size: clamp(26px, 3.2vw, 34px); font-weight: 850; letter-spacing: -0.035em; line-height: 1.18; margin-bottom: 18px; }
.prose h2 { font-size: 21.5px; font-weight: 750; letter-spacing: -0.02em; margin: 38px 0 13px; padding-top: 18px; border-top: 1px solid var(--border); scroll-margin-top: 84px; }
.prose h3 { font-size: 16.5px; font-weight: 700; margin: 24px 0 8px; scroll-margin-top: 84px; }
.prose h4 { font-size: 14.5px; font-weight: 700; margin: 16px 0 6px; }
.prose p { margin: 11px 0; color: var(--ink-2); font-size: 14.8px; line-height: 1.72; }
.prose ul, .prose ol { margin: 10px 0 16px 22px; color: var(--ink-2); font-size: 14.8px; line-height: 1.7; }
.prose li { margin: 6px 0; }
.prose code { font-family: var(--font-mono); font-size: 0.85em; padding: 2px 6px; border-radius: 6px; background: var(--surface-2); border: 1px solid var(--border); color: var(--ink); overflow-wrap: break-word; word-break: normal; }
.prose pre code { background: transparent; border: 0; padding: 0; color: inherit; font-size: inherit; border-radius: 0; }
.prose hr { border: 0; border-top: 1px solid var(--border); margin: 28px 0; }
.prose img { max-width: 100%; border-radius: 14px; border: 1px solid var(--border-strong); margin: 14px 0; box-shadow: 0 14px 36px rgba(0,0,0,0.18); }
.prose blockquote { border-left: 3px solid var(--accent); padding: 6px 16px; margin: 16px 0; color: var(--muted); background: var(--surface); border-radius: 0 10px 10px 0; }

/* Iconified Callouts */
.callout { border-radius: 12px; border: 1px solid var(--border); padding: 14px 16px; margin: 18px 0; background: var(--surface); }
.callout-tip { border-left: 3.5px solid var(--green); background: color-mix(in srgb, var(--green) 6%, var(--surface)); }
.callout-tip .callout-title { color: var(--green); }
.callout-important, .callout-note { border-left: 3.5px solid var(--accent); background: color-mix(in srgb, var(--accent) 6%, var(--surface)); }
.callout-important .callout-title, .callout-note .callout-title { color: var(--accent); }
.callout-warning, .callout-caution { border-left: 3.5px solid var(--amber); background: color-mix(in srgb, var(--amber) 7%, var(--surface)); }
.callout-warning .callout-title, .callout-caution .callout-title { color: var(--amber); }
.callout-title { display: flex; align-items: center; gap: 7px; font-size: 11.5px; font-weight: 750; letter-spacing: 0.06em; margin-bottom: 6px; }
.callout p { margin: 4px 0; font-size: 13.8px; }

/* Protected Scrollable Tables */
.table-scroll { max-width: 100%; overflow-x: auto; border: 1px solid var(--border); border-radius: 12px; margin: 18px 0; background: var(--surface); box-shadow: 0 4px 16px rgba(0,0,0,0.05); }
.table-scroll table { width: 100%; border-collapse: collapse; font-size: 13.5px; }
.table-scroll th, .table-scroll td { padding: 10px 14px; border-bottom: 1px solid var(--border); text-align: left; vertical-align: top; }
.table-scroll tr:last-child td { border-bottom: 0; }
.table-scroll tr:hover td { background: color-mix(in srgb, var(--accent) 3%, transparent); }
.table-scroll th { background: var(--surface-2); font-weight: 650; font-size: 12.5px; color: var(--muted); white-space: nowrap; }
.table-scroll td:first-child { min-width: 7rem; }
.table-scroll td:first-child code { white-space: nowrap; }
.prose details { border: 1px solid var(--border); border-radius: 11px; padding: 11px 15px; margin: 14px 0; background: var(--surface); }
.prose summary { cursor: pointer; font-weight: 650; font-size: 14px; }

/* Sticky Right TOC with Scroll-Spy */
.toc { position: sticky; top: 86px; align-self: start; max-height: calc(100vh - 110px); overflow-y: auto; border-left: 1px solid var(--border); padding-left: 14px; }
.toc-t { font-size: 11.5px; font-weight: 750; color: var(--ink); margin-bottom: 10px; letter-spacing: 0.05em; }
.toc-l { display: block; padding: 4px 0; line-height: 1.42; color: var(--muted); overflow-wrap: anywhere; transition: color .14s; }
.toc-2 { font-size: 0.81rem; font-weight: 500; }
.toc-3 { font-size: 0.76rem; padding-left: 12px; color: var(--faint); }
.toc-l:hover, .toc-l.on { color: var(--accent); text-decoration: none; font-weight: 600; }

.pager { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; margin-top: 46px; padding-top: 24px; border-top: 1px solid var(--border); }
.pager a { padding: 14px 16px; border-radius: 12px; border: 1px solid var(--border); background: var(--surface); display: flex; flex-direction: column; gap: 3px; color: var(--ink); transition: border-color .15s, transform .15s; }
.pager a:hover { border-color: var(--accent); transform: translateY(-1px); text-decoration: none; }
.pager small { font-size: 11.5px; color: var(--faint); }

@media (max-width: 1140px) { .doc-layout { grid-template-columns: 236px minmax(0, 1fr); } .toc { display: none; } }
@media (max-width: 820px) {
  .doc-layout { grid-template-columns: 1fr; padding-top: 18px; }
  .mob-menu-btn { display: inline-flex; }
  .sidebar { display: none; position: static; max-height: none; border: 1px solid var(--border); border-radius: 12px; padding: 16px; background: var(--surface); margin-bottom: 16px; }
  .sidebar.open { display: block; }
  .nav-mid { display: none; }
}
</style>
</head>
<body>
<div id="read-progress" aria-hidden="true"></div>
<header class="topbar">
  <div class="topbar-in">
    <a class="brand" href="../index.html">
      <img src="../assets/tycho-logo-512.png" alt="Tycho" />
      <span>tycho</span>
      <span class="ver-pill mono">docs</span>
    </a>
    <nav class="nav-mid">
      <a href="../index.html">产品首页</a>
      <a class="active" href="quickstart.html">文档中心</a>
      <a href="remote-access.html">公网部署</a>
      <a href="cli.html">CLI 参考</a>
      <a href="settings.html">配置项</a>
    </nav>
    <div class="nav-r">
      <button class="btn mob-menu-btn" id="mob-menu-btn" type="button">目录</button>
      <button class="btn" id="search-btn" type="button">搜索 <span class="kbd">Ctrl K</span></button>
      <button class="btn" id="theme-btn" type="button" aria-label="Toggle color theme">☀</button>
      <a class="btn" href="${REPO_URL}" target="_blank" rel="noreferrer">GitHub ↗</a>
    </div>
  </div>
</header>

<div class="doc-layout">
  <aside class="sidebar" id="doc-sidebar">${sidebarHtml}</aside>
  <article class="prose">
    <div class="doc-meta">
      <div class="crumb"><a href="../index.html">Tycho</a><span>/</span><b>${escapeHtml(spec.group)}</b></div>
      <div class="meta-r">
        <span>约 ${minutes} 分钟阅读</span>
        <a href="${editUrl}" target="_blank" rel="noreferrer">在 GitHub 查看源码 ↗</a>
      </div>
    </div>
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

${SEARCH_DIALOG_HTML}

<script>
document.getElementById('mob-menu-btn')?.addEventListener('click', () => {
  document.getElementById('doc-sidebar')?.classList.toggle('open');
});
document.querySelectorAll('.code-block .copy-btn').forEach(btn => {
  btn.addEventListener('click', async () => {
    const code = btn.closest('.code-block').querySelector('pre code').textContent;
    try { await navigator.clipboard.writeText(code); btn.textContent = 'Copied'; } catch {}
    setTimeout(() => { btn.textContent = 'Copy'; }, 1400);
  });
});

// Fallback for scroll-progress-indicator when CSS scroll() is unavailable
if (!CSS.supports('animation-timeline', 'scroll()')) {
  const bar = document.getElementById('read-progress');
  window.addEventListener('scroll', () => {
    const max = document.documentElement.scrollHeight - window.innerHeight;
    if (bar && max > 0) bar.style.transform = 'scaleX(' + Math.min(1, Math.max(0, window.scrollY / max)) + ')';
  }, { passive: true });
}

// Active TOC scroll-spy
const tocLinks = [...document.querySelectorAll('[data-toc]')];
if (tocLinks.length && 'IntersectionObserver' in window) {
  const map = new Map(tocLinks.map(a => [a.getAttribute('data-toc'), a]));
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (e.isIntersecting) {
        tocLinks.forEach(a => a.classList.remove('on'));
        map.get(e.target.id)?.classList.add('on');
      }
    }
  }, { rootMargin: '-80px 0px -70% 0px' });
  document.querySelectorAll('.prose h2[id], .prose h3[id]').forEach(h => io.observe(h));
}

${renderSharedScript('../search-index.json', '')}
</script>
</body>
</html>`;
}

// Build pipeline
rmSync(OUT, { recursive: true, force: true });
mkdirSync(join(OUT, 'docs'), { recursive: true });
mkdirSync(join(OUT, 'assets'), { recursive: true });

for (const f of ['tycho-logo-512.png', 'tycho-logo.svg']) {
  copyFileSync(join(ROOT, 'assets', f), join(OUT, 'assets', f));
}
for (const f of readdirSync(join(ROOT, 'docs', 'assets'))) {
  copyFileSync(join(ROOT, 'docs', 'assets', f), join(OUT, 'assets', f));
}

writeFileSync(join(OUT, 'index.html'), renderLandingPage(), 'utf8');

const searchIndex: { slug: string; group: string; title: string; excerpt: string; text: string }[] = [];
for (let i = 0; i < DOC_PAGES.length; i++) {
  const spec = DOC_PAGES[i]!;
  const raw = readFileSync(join(ROOT, spec.source), 'utf8');
  const { html, headings, excerpt } = parseMarkdown(raw, spec.source);
  writeFileSync(join(OUT, 'docs', `${spec.slug}.html`), renderDocPage(spec, i, html, headings, estimateMinutes(raw)), 'utf8');
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

console.log(`Built flagship static website in ${OUT}: index.html + ${DOC_PAGES.length} doc pages + search-index.json`);
