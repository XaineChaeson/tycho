// Zero-dependency static Product Website + Stripe-style Documentation Portal generator.
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
  summary: string;
  source: string;
}

const DOC_PAGES: DocSpec[] = [
  { slug: 'quickstart', group: '入门与部署', title: '5 分钟快速上手', summary: '1 行安装、启动主机、接入本机节点并跑通首条任务。', source: 'docs/guide/quickstart.md' },
  { slug: 'remote-access', group: '入门与部署', title: '4 种部署与公网 VPS', summary: '本机、公网 HTTPS VPS、Tailscale 与穿透代理 WSS :443 隧道。', source: 'docs/guide/remote-access.md' },
  { slug: 'clients', group: '入门与部署', title: '桌面端与手机 PWA', summary: '3.6 MB Tauri v2 三端桌面壳与 iOS/Android 独立 PWA。', source: 'docs/clients.md' },

  { slug: 'architecture', group: '架构与调度', title: '核心架构与安全边界', summary: '零依赖 SQLite 账本、单活跃轮次约束与 OS 用户隔离边界。', source: 'docs/guide/architecture.md' },
  { slug: 'accounts-and-nodes', group: '架构与调度', title: '账号池、三档与机器', summary: '统一账号池、决策/执行/操作三档路由与 5h/7d 自动切号。', source: 'docs/guide/accounts-and-nodes.md' },
  { slug: 'operations', group: '架构与调度', title: '生产运维手册', summary: 'systemd / launchd 自启、备份恢复、多实例隔离与平滑升级。', source: 'docs/guide/operations.md' },

  { slug: 'extensibility', group: '扩展与自动化', title: '扩展与插件开发', summary: '开放 tycho-v1 双向签名 IM 协议、主题包与扩展契约。', source: 'docs/guide/extensibility.md' },
  { slug: 'channels-and-triggers', group: '扩展与自动化', title: 'IM 通道与事件触发器', summary: '企微长连接、个人微信、飞书桥接，以及 Cron / 内部事件 / Webhook。', source: 'docs/guide/channels-and-triggers.md' },
  { slug: 'knowledge-and-skills', group: '扩展与自动化', title: '知识库、技能与 MCP', summary: '跨机 SKILL.md 全网镜像与外部 CLI 挂载 Knowledge MCP。', source: 'docs/guide/knowledge-and-skills.md' },
  { slug: 'quota-plugins', group: '扩展与自动化', title: '本机额度探针插件', summary: '通过 ~/.tycho/quota-probes/ 无缝对接私有网关或企业计费接口。', source: 'docs/quota-plugins.md' },
  { slug: 'executor-updaters', group: '扩展与自动化', title: '多机执行器自动升级', summary: '跨机空闲探测并安全升级 Claude Code、Codex、agy 与 dsh。', source: 'docs/executor-updaters.md' },

  { slug: 'cli', group: '参考与治理', title: 'CLI 命令参考', summary: '由 cli/main.ts 自动生成的全量命令、子命令与退出码。', source: 'docs/reference/cli.md' },
  { slug: 'settings', group: '参考与治理', title: '全量配置项参考', summary: '由 service/settings.ts 自动生成的 112 项配置、默认值与生效时机。', source: 'docs/reference/settings.md' },
  { slug: 'troubleshooting', group: '参考与治理', title: '故障排查手册', summary: 'tycho doctor 诊断与常见网络、登录、额度异常排错。', source: 'docs/reference/troubleshooting.md' },
  { slug: 'security', group: '参考与治理', title: '安全模型与披露', summary: '信任边界声明、凭据落盘保护与漏洞响应流程。', source: 'SECURITY.md' },
  { slug: 'contributing', group: '参考与治理', title: '参与贡献', summary: '本地开发、测试命令、代码结构导览与 PR 规范。', source: 'CONTRIBUTING.md' },
  { slug: 'changelog', group: '参考与治理', title: '变更日志', summary: '服务端与桌面客户端版本演进记录。', source: 'CHANGELOG.md' },
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
  if (rel === 'docs/README.md' || rel === 'docs/deploy.md') return 'index.html';
  if (rel.startsWith('docs/assets/')) return `../assets/${rel.slice('docs/assets/'.length)}`;
  if (rel.startsWith('assets/')) return `../assets/${rel.slice('assets/'.length)}`;
  return `${REPO_URL}/blob/main/${rel}${hash ? `#${hash}` : ''}`;
}

function highlightCode(raw: string, lang: string): string {
  const l = lang.toLowerCase();
  return raw.split('\n').map((line) => {
    const esc = escapeHtml(line);
    if (['bash', 'sh', 'shell', 'zsh', 'powershell', 'ps1', 'nginx', 'yaml', 'yml'].includes(l)) {
      if (/^\s*#/.test(line)) return `<span class="tok-com">${esc}</span>`;
      return esc
        .replace(/(#.*)$/, '<span class="tok-com">$1</span>')
        .replace(/(&quot;[^&]*?&quot;|'[^']*?')/g, '<span class="tok-str">$1</span>')
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
    if (['ts', 'typescript', 'js', 'javascript', 'mjs'].includes(l)) {
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

    // Standard Markdown image ![alt](src)
    const mdImg = /^!\[([^\]]*)\]\(([^)]+)\)$/.exec(trimmed);
    if (mdImg) {
      const src = resolveDocLink(mdImg[2]!.trim(), currentSource);
      out.push(`<p class="doc-fig"><img src="${escapeHtml(src)}" alt="${escapeHtml(mdImg[1]!)}" /></p>`);
      i++;
      continue;
    }

    // Raw HTML image paragraph / details pass-through (multi-line safe, rewriting asset paths)
    if (trimmed.startsWith('<p align="center">') || trimmed.startsWith('<img ') || trimmed === '</p>' || trimmed.startsWith('<details') || trimmed.startsWith('</details>') || trimmed.startsWith('<summary>')) {
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
      && !/^(#{1,4}\s|```|>|---+$|[-*]\s|\d+\.\s|!\[|<p |<\/p>|<img |<details|<\/details>|<summary>)/.test(lines[i]!.trim())
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

// FOUC-free native color-scheme meta bootstrapper (modern-web-guidance: dark-mode-toggle)
const THEME_HEAD_SNIPPET = `<meta name="color-scheme" content="light dark" />
<script>try{const s=localStorage.getItem('color-scheme');if(s==='light'||s==='dark')document.querySelector('meta[name="color-scheme"]').content=s;}catch{}</script>`;

// Dual-First-Class Apple Gallery Light (#FFFFFF / #F5F5F7) × Linear Studio Obsidian Dark (#000000 / #0A0A0C)
const SHARED_CSS = `
:root {
  color-scheme: light dark;
  --bg: light-dark(#FFFFFF, #000000);
  --surface: light-dark(#F5F5F7, #0B0B0E);
  --surface-2: light-dark(#ECEEF2, #141418);
  --surface-elev: light-dark(#FFFFFF, #111115);
  --nav-bg: light-dark(rgba(255,255,255,0.82), rgba(0,0,0,0.78));
  --code-bg: #0A0A0D;
  --border: light-dark(rgba(0,0,0,0.08), rgba(255,255,255,0.09));
  --border-strong: light-dark(rgba(0,0,0,0.16), rgba(255,255,255,0.18));
  --ink: light-dark(#1D1D1F, #F5F5F7);
  --ink-2: light-dark(#424245, #C7C7CC);
  --muted: light-dark(#6E6E73, #8E8E93);
  --faint: light-dark(#86868B, #636366);
  --accent: light-dark(#0071E3, #2997FF);
  --accent-soft: light-dark(rgba(0,113,227,0.08), rgba(41,151,255,0.13));
  --green: light-dark(#047857, #30D158);
  --green-soft: light-dark(rgba(4,120,87,0.09), rgba(48,209,88,0.13));
  --amber: light-dark(#B45309, #FF9F0A);
  --amber-soft: light-dark(rgba(180,83,9,0.10), rgba(255,159,10,0.14));
  --shadow-frame: light-dark(0 30px 90px rgba(0,0,0,0.14), 0 40px 100px rgba(0,0,0,0.85));
  --shadow-card: light-dark(0 12px 32px rgba(0,0,0,0.06), 0 18px 46px rgba(0,0,0,0.55));
  --font-sans: -apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Inter', 'PingFang SC', 'Microsoft YaHei UI', system-ui, sans-serif;
  --font-mono: 'SF Mono', 'JetBrains Mono', 'Cascadia Mono', Consolas, ui-monospace, monospace;

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
  font-family: var(--font-sans);
  font-feature-settings: "cv02", "cv03", "cv04", "ss03";
  background: var(--bg); color: var(--ink);
  line-height: 1.6; -webkit-font-smoothing: antialiased;
}
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
.mono { font-family: var(--font-mono); }

/* Minimal Apple / Linear Frosted Topbar */
.topbar {
  position: sticky; top: 0; z-index: 50; height: 54px;
  backdrop-filter: saturate(180%) blur(20px); -webkit-backdrop-filter: saturate(180%) blur(20px);
  background: var(--nav-bg);
  border-bottom: 1px solid var(--border);
}
.topbar-in {
  max-width: 1280px; height: 100%; margin: 0 auto; padding: 0 24px;
  display: flex; align-items: center; justify-content: space-between; gap: 16px;
}
.brand { display: flex; align-items: center; gap: 9px; font-weight: 700; font-size: 15.5px; letter-spacing: -0.02em; color: var(--ink); }
.brand:hover { text-decoration: none; }
.brand img { width: 22px; height: 22px; border-radius: 6px; }
.brand-sub { font-size: 12px; font-weight: 500; color: var(--muted); }
.nav-mid { display: flex; align-items: center; gap: 28px; font-size: 13px; }
.nav-mid a { color: var(--muted); font-weight: 500; transition: color .15s; }
.nav-mid a:hover, .nav-mid a.active { color: var(--ink); text-decoration: none; }
.nav-r { display: flex; align-items: center; gap: 8px; }

/* Restrained Studio Buttons */
.btn {
  cursor: pointer; border: 1px solid var(--border); background: transparent; color: var(--ink);
  padding: 6px 13px; border-radius: 999px; font-size: 12.5px; font-weight: 500; font-family: inherit;
  display: inline-flex; align-items: center; gap: 6px; transition: background .15s, border-color .15s, opacity .15s;
}
.btn:hover { background: var(--surface); border-color: var(--border-strong); text-decoration: none; }
.btn-lg { padding: 11px 22px; font-size: 14.5px; font-weight: 600; }
.btn-solid { background: var(--ink); color: var(--bg); border-color: transparent; font-weight: 600; }
.btn-solid:hover { opacity: 0.86; background: var(--ink); color: var(--bg); }
.btn-accent { background: var(--accent); color: #FFFFFF; border-color: transparent; font-weight: 600; }
.btn-accent:hover { opacity: 0.9; background: var(--accent); color: #FFFFFF; }
.link-arrow { display: inline-flex; align-items: center; gap: 4px; font-size: 14.5px; font-weight: 500; color: var(--accent); }
.link-arrow:hover { text-decoration: underline; }
.kbd { font-family: var(--font-mono); font-size: 10.5px; padding: 1px 5px; border-radius: 4px; background: var(--surface); border: 1px solid var(--border); color: var(--muted); }

/* Syntax-highlighted Code Blocks */
.code-block {
  border-radius: 14px; overflow: hidden; border: 1px solid var(--border-strong);
  background: var(--code-bg); margin: 18px 0;
}
.code-head {
  display: flex; justify-content: space-between; align-items: center;
  padding: 8px 14px; border-bottom: 1px solid rgba(255,255,255,0.08);
  background: rgba(255,255,255,0.02); font-size: 11px; color: #8E8E93;
}
.code-lang { text-transform: uppercase; letter-spacing: 0.06em; font-weight: 600; }
.copy-btn {
  cursor: pointer; background: rgba(255,255,255,0.07); color: #D1D1D6;
  border: 1px solid rgba(255,255,255,0.12); border-radius: 6px;
  padding: 3px 9px; font-size: 11px; font-family: var(--font-mono); transition: background .15s, color .15s;
}
.copy-btn:hover { color: #FFF; background: rgba(255,255,255,0.16); }
.code-block pre { padding: 15px 17px; overflow-x: auto; font-family: var(--font-mono); font-size: 12.5px; line-height: 1.65; color: #E5E5EA; }
.code-block pre code { background: transparent; padding: 0; border: 0; color: inherit; font-size: inherit; border-radius: 0; }
.tok-com { color: #636366; font-style: italic; }
.tok-str { color: #6EE7B7; }
.tok-kw { color: #60A5FA; font-weight: 600; }
.tok-flg { color: #C4B5FD; }
.tok-key { color: #93C5FD; }
.tok-num { color: #FCD34D; }

/* Native Animated Accordions (modern-web-guidance: accordion) */
details.d { border-bottom: 1px solid var(--border); }
details.d:first-child { border-top: 1px solid var(--border); }
details.d > summary {
  cursor: pointer; list-style: none; padding: 20px 4px; font-weight: 600; font-size: 15.5px;
  display: flex; align-items: center; gap: 12px; color: var(--ink);
}
details.d > summary::-webkit-details-marker { display: none; }
details.d > summary::before {
  content: ""; inline-size: 0.95em; block-size: 0.95em; flex-shrink: 0;
  background-color: var(--muted);
  -webkit-mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Cpath fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round' d='M4 6l4 4 4-4'/%3E%3C/svg%3E") no-repeat center / contain;
  mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Cpath fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round' d='M4 6l4 4 4-4'/%3E%3C/svg%3E") no-repeat center / contain;
  rotate: -90deg;
}
details.d[open] > summary::before { rotate: 0deg; background-color: var(--accent); }
details.d::details-content {
  interpolate-size: allow-keywords;
  overflow: clip;
  contain: layout;
}
details.d:not([open])::details-content { block-size: 0; }
@media (prefers-reduced-motion: no-preference) {
  details.d > summary::before { transition: rotate 0.22s ease, background-color 0.2s ease; }
  details.d::details-content {
    transition: block-size, content-visibility, display;
    transition-duration: 0.28s;
    transition-timing-function: ease-in-out;
    transition-behavior: allow-discrete;
  }
}
details.d .db { padding: 0 4px 22px 28px; font-size: 14px; color: var(--muted); display: flex; flex-direction: column; gap: 12px; max-width: 760px; }

/* Native Modal Command Search Dialog (modern-web-guidance: dialog) */
dialog.s-dialog {
  width: min(620px, 92vw); margin: 11vh auto auto; padding: 0;
  border-radius: 16px; border: 1px solid var(--border-strong);
  background: var(--surface-elev); color: var(--ink);
  box-shadow: var(--shadow-frame); overflow: hidden;
}
dialog.s-dialog:modal { overscroll-behavior: contain; }
dialog.s-dialog::backdrop {
  background: rgba(0, 0, 0, 0.54);
  backdrop-filter: blur(8px);
  overflow: hidden;
  overscroll-behavior: contain;
}
.s-head { display: flex; align-items: center; gap: 10px; padding: 14px 16px; border-bottom: 1px solid var(--border); }
.s-head input { flex: 1; border: 0; background: transparent; color: var(--ink); font-size: 15px; font-family: inherit; outline: none; }
.s-close { cursor: pointer; border: 1px solid var(--border); background: var(--surface); color: var(--muted); border-radius: 6px; padding: 3px 8px; font-size: 11px; font-family: var(--font-mono); }
.s-res { max-height: 380px; overflow-y: auto; padding: 8px; display: flex; flex-direction: column; gap: 3px; }
.s-res a { padding: 10px 12px; border-radius: 10px; display: flex; flex-direction: column; gap: 3px; color: var(--ink); transition: background .12s; }
.s-res a:hover, .s-res a.sel { background: var(--surface); text-decoration: none; }
.s-res-top { display: flex; justify-content: space-between; align-items: center; gap: 8px; font-size: 14px; }
.s-res-g { font-size: 11px; font-weight: 500; color: var(--muted); }
.s-res small { font-size: 12px; color: var(--muted); line-height: 1.45; }
.s-foot { padding: 8px 14px; border-top: 1px solid var(--border); background: var(--surface); font-size: 11px; color: var(--faint); display: flex; justify-content: space-between; }

/* Subtle Decorative Scroll Reveal (modern-web-guidance: scroll-entry-exit-effects) */
@media (prefers-reduced-motion: no-preference) {
  @supports ((animation-timeline: view()) and (animation-range: entry)) {
    @keyframes act-reveal {
      from { opacity: 0.88; transform: translateY(18px); }
      to { opacity: 1; transform: translateY(0); }
    }
    .reveal {
      animation: act-reveal auto linear backwards;
      animation-timeline: view();
      animation-range: entry 0% entry 24%;
    }
  }
}
`;

function renderSharedScript(searchIndexUrl: string, docPrefix: string): string {
  return `
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
  btn.title = dark ? 'Switch to light mode' : 'Switch to dark mode';
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

document.querySelectorAll('[data-open-search]').forEach(b => b.addEventListener('click', openSearch));
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
    <input id="s-input" type="search" autofocus placeholder="搜索文档、配置键、CLI 命令或协议..." autocomplete="off" />
    <button id="s-close" class="s-close" type="button">ESC</button>
  </div>
  <div class="s-res" id="s-res"></div>
  <div class="s-foot"><span>↑↓ 选择 · Enter 跳转</span><span class="mono">Tycho Docs</span></div>
</dialog>`;

// ============================================================================
// 5-ACT APPLE × LINEAR PRODUCT LANDING PAGE
// ============================================================================
function renderLandingPage(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
${THEME_HEAD_SNIPPET}
<title>Tycho — Orchestrate Your Native AI Coding Agents</title>
<meta name="description" content="Turn your native Claude Code, Codex, Gemini, and dsh CLIs into one self-hosted engineering team — across every machine, account, IM, and device." />
<link rel="icon" type="image/svg+xml" href="assets/tycho-logo.svg" />
<style>${SHARED_CSS}
/* Macro Apple Whitespace & Studio Layout */
.act { max-width: 1200px; margin: 0 auto; padding: 128px 24px 0; }
.act-narrow { max-width: 820px; margin: 0 auto; text-align: center; }
.act-kicker { font-size: 12px; font-weight: 600; letter-spacing: 0.04em; color: var(--muted); margin-bottom: 12px; display: block; }
.act-h { font-size: clamp(30px, 4vw, 48px); font-weight: 700; letter-spacing: -0.035em; line-height: 1.12; color: var(--ink); text-wrap: balance; }
.act-p { font-size: clamp(16px, 1.6vw, 19px); color: var(--muted); line-height: 1.58; margin-top: 16px; text-wrap: pretty; }

/* ACT 1: HERO */
.hero { max-width: 1240px; margin: 0 auto; padding: 92px 24px 0; text-align: center; }
.hero h1 {
  font-size: clamp(38px, 5.4vw, 66px); font-weight: 750; letter-spacing: -0.042em; line-height: 1.07;
  max-width: 19ch; margin: 0 auto 20px; color: var(--ink); text-wrap: balance;
}
.hero .lead {
  font-size: clamp(17px, 1.8vw, 21px); color: var(--muted); max-width: 700px; margin: 0 auto 30px; line-height: 1.55; text-wrap: balance;
}
.hero-actions { display: flex; justify-content: center; align-items: center; gap: 18px; flex-wrap: wrap; margin-bottom: 26px; }
.cmd-strip {
  display: inline-flex; align-items: center; gap: 10px; max-width: 100%;
  padding: 6px 8px 6px 14px; border-radius: 999px;
  background: var(--surface); border: 1px solid var(--border);
  margin-bottom: 54px;
}
.os-sw { display: inline-flex; gap: 2px; background: var(--surface-2); padding: 2px; border-radius: 999px; }
.os-btn {
  cursor: pointer; border: 0; background: transparent; color: var(--muted);
  font-size: 11px; font-weight: 600; padding: 3px 9px; border-radius: 999px; font-family: inherit;
}
.os-btn.on { background: var(--surface-elev); color: var(--ink); box-shadow: 0 1px 3px rgba(0,0,0,0.12); }
.cmd-text { font-family: var(--font-mono); font-size: 12px; color: var(--ink-2); overflow-x: auto; white-space: nowrap; max-width: 56vw; }
.cmd-copy {
  cursor: pointer; border: 0; background: transparent; color: var(--accent);
  font-size: 12px; font-weight: 600; padding: 4px 10px; border-radius: 999px; font-family: inherit;
}
.cmd-copy:hover { background: var(--accent-soft); }

/* Grand Hero Stage */
.stage-frame {
  border-radius: 22px; overflow: hidden;
  background: #07080C; border: 1px solid var(--border-strong);
  box-shadow: var(--shadow-frame);
}
.stage-frame img { width: 100%; display: block; }
.stage-bar {
  display: flex; justify-content: space-between; align-items: center; gap: 16px; flex-wrap: wrap;
  margin-top: 20px; padding: 0 6px;
}
.seg {
  display: inline-flex; gap: 4px; flex-wrap: wrap;
  padding: 4px; border-radius: 999px; background: var(--surface); border: 1px solid var(--border);
}
.seg button {
  cursor: pointer; border: 0; background: transparent; color: var(--muted);
  padding: 6px 14px; border-radius: 999px; font-size: 12.5px; font-weight: 500; font-family: inherit;
  transition: background .15s, color .15s;
}
.seg button:hover { color: var(--ink); }
.seg button.on { background: var(--surface-elev); color: var(--ink); font-weight: 600; box-shadow: 0 1px 4px rgba(0,0,0,0.14); }
.stage-caption { font-size: 13.5px; color: var(--muted); text-align: left; flex: 1; min-width: 260px; }
.stage-caption strong { color: var(--ink); font-weight: 600; margin-right: 6px; }

/* ACT 2: INTERACTIVE ACCOUNTS & 3-TIER SIMULATOR */
.split-2 { display: grid; grid-template-columns: minmax(0, 0.86fr) minmax(0, 1.14fr); gap: 56px; align-items: center; }
.clean-list { list-style: none; margin: 28px 0 28px; border-top: 1px solid var(--border); }
.clean-list li { padding: 14px 0; border-bottom: 1px solid var(--border); font-size: 14.5px; color: var(--ink-2); display: flex; justify-content: space-between; gap: 12px; }
.clean-list li span:last-child { color: var(--muted); font-size: 13px; text-align: right; }

.sim-panel {
  border-radius: 22px; padding: 28px;
  background: var(--surface); border: 1px solid var(--border);
  box-shadow: var(--shadow-card); display: flex; flex-direction: column; gap: 20px;
}
.sim-top { display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; }
.sim-tiers { display: inline-flex; gap: 4px; padding: 3px; border-radius: 10px; background: var(--surface-2); }
.t-btn {
  cursor: pointer; border: 0; background: transparent; color: var(--muted);
  padding: 6px 13px; border-radius: 8px; font-size: 12.5px; font-weight: 600; font-family: inherit;
}
.t-btn.on { background: var(--surface-elev); color: var(--ink); box-shadow: 0 1px 4px rgba(0,0,0,0.12); }
.cap-toggle {
  cursor: pointer; border: 1px solid var(--border-strong); background: var(--surface-elev); color: var(--ink);
  padding: 6px 12px; border-radius: 999px; font-size: 12px; font-weight: 600; font-family: inherit;
  display: inline-flex; align-items: center; gap: 7px;
}
.cap-toggle.hot { border-color: var(--amber); color: var(--amber); background: var(--amber-soft); }
.sim-cards { display: flex; flex-direction: column; gap: 10px; }
.acc-row {
  padding: 15px 16px; border-radius: 14px; border: 1px solid var(--border);
  background: var(--surface-elev); display: flex; flex-direction: column; gap: 9px;
  transition: border-color .2s, opacity .2s, transform .2s;
}
.acc-row.active { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
.acc-row.resting { opacity: 0.56; }
.acc-head { display: flex; justify-content: space-between; align-items: center; gap: 8px; font-size: 13.5px; }
.acc-tag { font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 999px; }
.acc-tag.live { background: var(--green-soft); color: var(--green); }
.acc-tag.rest { background: var(--amber-soft); color: var(--amber); }
.acc-tag.standby { background: var(--surface-2); color: var(--muted); }
.meter { height: 5px; border-radius: 99px; background: var(--surface-2); overflow: hidden; }
.meter > i { display: block; height: 100%; border-radius: 99px; transition: width .35s ease, background .25s ease; }
.sim-foot {
  padding-top: 14px; border-top: 1px solid var(--border);
  display: flex; justify-content: space-between; align-items: center; gap: 10px; flex-wrap: wrap;
  font-size: 12px; color: var(--muted);
}

/* ACT 3: OUTBOUND FLEET CONSTELLATION */
.blueprint {
  margin-top: 44px; border-radius: 22px; overflow: hidden;
  background: #08090D; border: 1px solid var(--border-strong);
  box-shadow: var(--shadow-frame); padding: 34px 28px 24px; color: #F5F5F7;
}
.bp-meta { display: flex; justify-content: space-between; align-items: center; font-size: 11.5px; color: #8E8E93; margin-bottom: 18px; }
.dep-dock {
  margin-top: 28px; display: grid; grid-template-columns: minmax(0, 0.85fr) minmax(0, 1.15fr); gap: 24px;
  align-items: start; text-align: left;
  padding: 26px; border-radius: 18px; background: var(--surface); border: 1px solid var(--border);
}
.dep-dock .code-block { margin: 0; }
.dep-dock .code-block pre { font-size: 12px; }

/* ACT 4: EVERYWHERE CLIENTS & IM GALLERY */
.showcase-full {
  margin-top: 44px; border-radius: 22px; overflow: hidden;
  border: 1px solid var(--border-strong); background: #07080C; box-shadow: var(--shadow-frame);
}
.showcase-full img { width: 100%; display: block; }
.duo-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin-top: 20px; }
.duo-card {
  padding: 32px; border-radius: 20px; background: var(--surface); border: 1px solid var(--border);
  display: flex; flex-direction: column; justify-content: space-between; gap: 20px;
}
.duo-card h3 { font-size: 22px; font-weight: 700; letter-spacing: -0.025em; margin-bottom: 8px; }
.duo-card p { font-size: 14.5px; color: var(--muted); line-height: 1.62; }
.flow-mini {
  border-radius: 14px; background: var(--surface-elev); border: 1px solid var(--border);
  padding: 16px; display: flex; flex-direction: column; gap: 10px; font-size: 12.5px;
}
.flow-item { display: flex; justify-content: space-between; align-items: center; gap: 10px; padding: 8px 11px; border-radius: 9px; background: var(--surface); }

/* ACT 5: APPLE SPEC GRID + QUIET APPENDIX + CLOSE */
.spec-grid {
  margin-top: 44px; display: grid; grid-template-columns: repeat(3, 1fr);
  border-top: 1px solid var(--border);
}
.spec-cell {
  padding: 30px 24px 30px 0; border-bottom: 1px solid var(--border);
  display: flex; flex-direction: column; gap: 6px;
}
.spec-cell b { font-size: 28px; font-weight: 750; letter-spacing: -0.03em; color: var(--ink); }
.spec-cell strong { font-size: 14.5px; font-weight: 600; color: var(--ink); }
.spec-cell span { font-size: 13.5px; color: var(--muted); line-height: 1.55; }

.appendix { max-width: 860px; margin: 88px auto 0; padding: 0 24px; }
.close-band {
  max-width: 1152px; margin: 120px auto 80px; padding: 64px 32px; border-radius: 26px; text-align: center;
  background: var(--surface); border: 1px solid var(--border);
}
.close-band h2 { font-size: clamp(28px, 3.8vw, 42px); font-weight: 750; letter-spacing: -0.035em; margin-bottom: 12px; }
.close-band p { font-size: 16.5px; color: var(--muted); max-width: 560px; margin: 0 auto 28px; }

footer {
  max-width: 1200px; margin: 0 auto; padding: 28px 24px 56px;
  border-top: 1px solid var(--border); display: flex; justify-content: space-between; flex-wrap: wrap; gap: 14px;
  font-size: 12.5px; color: var(--muted);
}

@media (max-width: 960px) {
  .act { padding-top: 88px; }
  .split-2, .dep-dock, .duo-grid { grid-template-columns: 1fr; gap: 28px; }
  .spec-grid { grid-template-columns: repeat(2, 1fr); }
  .nav-mid { display: none; }
}
@media (max-width: 560px) {
  .spec-grid { grid-template-columns: 1fr; }
  .cmd-strip { border-radius: 14px; flex-wrap: wrap; justify-content: center; }
}
</style>
</head>
<body>
<header class="topbar">
  <div class="topbar-in">
    <a class="brand" href="index.html">
      <img src="assets/tycho-logo-512.png" alt="Tycho" />
      <span>tycho</span>
    </a>
    <nav class="nav-mid">
      <a href="#accounts" data-i18n="nav_acc">调度与额度</a>
      <a href="#fleet" data-i18n="nav_flt">多机与部署</a>
      <a href="#everywhere" data-i18n="nav_cli">客户端与 IM</a>
      <a href="docs/index.html" data-i18n="nav_docs">文档中心</a>
    </nav>
    <div class="nav-r">
      <button class="btn" data-open-search type="button" aria-label="Search docs"><span data-i18n="nav_search">搜索</span> <span class="kbd">Ctrl K</span></button>
      <button class="btn" id="lang-btn" type="button">EN</button>
      <button class="btn" id="theme-btn" type="button" aria-label="Toggle color theme">☀</button>
      <a class="btn btn-solid" href="${REPO_URL}" target="_blank" rel="noreferrer">GitHub ↗</a>
    </div>
  </div>
</header>

<!-- ACT 1: HERO & GRAND VISUAL CENTERPIECE -->
<section class="hero">
  <h1 data-i18n="h1">把你手头的原生 AI CLI，编排成一支工程团队。</h1>
  <p class="lead" data-i18n="lead">直接调度你已订阅的 Claude Code、Codex、Gemini 与 dsh —— 一本零依赖 SQLite 账本，统筹每一台机器、每一份额度与每一端设备。</p>

  <div class="hero-actions">
    <a class="btn btn-lg btn-accent" href="docs/quickstart.html" data-i18n="cta_start">5 分钟开始使用</a>
    <a class="link-arrow" href="docs/index.html" data-i18n="cta_docs">探索文档中心 ›</a>
  </div>

  <div class="cmd-strip">
    <div class="os-sw">
      <button class="os-btn on" data-os="unix" type="button">macOS / Linux</button>
      <button class="os-btn" data-os="win" type="button">Windows</button>
    </div>
    <span class="cmd-text" id="inst-cmd">curl -fsSL https://github.com/XaineChaeson/tycho/releases/latest/download/install.sh | bash</span>
    <button class="cmd-copy" id="copy-inst" type="button">Copy</button>
  </div>

  <div class="stage-frame">
    <img id="stage-img" src="assets/preview-console.png" alt="Tycho Control Plane Preview" />
  </div>
  <div class="stage-bar">
    <div class="stage-caption">
      <strong id="cap-title"></strong><span id="cap-desc"></span>
      <a id="cap-link" href="docs/quickstart.html" style="margin-left:8px;white-space:nowrap"></a>
    </div>
    <div class="seg" role="tablist" aria-label="Product showcase views">
      <button class="on" data-view="console" type="button" data-i18n="v_con">指挥台</button>
      <button data-view="accounts" type="button" data-i18n="v_acc">额度池</button>
      <button data-view="channels" type="button" data-i18n="v_ch">IM 与触发</button>
      <button data-view="clients" type="button" data-i18n="v_cl">多端</button>
      <button data-view="arch" type="button" data-i18n="v_arch">架构</button>
    </div>
  </div>
</section>

<!-- ACT 2: BYOS NATIVE CLIS & INTERACTIVE 3-TIER SIMULATOR -->
<section class="act reveal" id="accounts">
  <div class="split-2">
    <div>
      <span class="act-kicker" data-i18n="a2_k">原生执行器 · 统一账号池</span>
      <h2 class="act-h" data-i18n="a2_h">你的订阅，全功率释放。</h2>
      <p class="act-p" data-i18n="a2_p">无需改换按量 API Key，不丢原有的 MCP、钩子与 Git 凭据。把不同厂商与多份订阅统一编入三档路由，额度触限前自动优雅切号。</p>
      <ul class="clean-list">
        <li><span data-i18n="a2_l1">原生 CLI 透传</span><span class="mono">claude · codex · agy · dsh</span></li>
        <li><span data-i18n="a2_l2">多窗口配额遥测</span><span data-i18n="a2_r2">5h / 7d 实时感知 · P1→P2 顺延</span></li>
        <li><span data-i18n="a2_l3">私有计费探针插件</span><span class="mono">~/.tycho/quota-probes/*.mjs</span></li>
      </ul>
      <a class="link-arrow" href="docs/accounts-and-nodes.html" data-i18n="a2_more">深入了解账号池与三档路由 ›</a>
    </div>

    <div class="sim-panel" aria-label="Interactive 3-tier routing simulator">
      <div class="sim-top">
        <div class="sim-tiers" id="sim-tiers">
          <button class="t-btn on" data-tier="decide" type="button" data-i18n="sim_dec">决策档</button>
          <button class="t-btn" data-tier="execute" type="button" data-i18n="sim_exe">执行档</button>
          <button class="t-btn" data-tier="operate" type="button" data-i18n="sim_ope">操作档</button>
        </div>
        <button class="cap-toggle" id="cap-toggle" type="button" data-i18n="sim_btn">模拟 P1 触限</button>
      </div>
      <div class="sim-cards" id="sim-cards"></div>
      <div class="sim-foot">
        <span id="sim-note"></span>
        <span class="mono" style="color:var(--ink)">Zero-Token Downtime</span>
      </div>
    </div>
  </div>
</section>

<!-- ACT 3: OUTBOUND FLEET & PUBLIC VPS -->
<section class="act reveal" id="fleet">
  <div class="act-narrow">
    <span class="act-kicker" data-i18n="a3_k">零入站 SSH · 4 种部署拓扑</span>
    <h2 class="act-h" data-i18n="a3_h">一台主机，调度每一台机器。</h2>
    <p class="act-p" data-i18n="a3_p">无论算力在公司内网工作站、家里 Windows 主机还是 MacBook，节点通过出站长连主动接入；主机可常驻公网云服务器 VPS，也可以留在内网经 WSS :443 隧道对外提供服务。</p>
  </div>

  <div class="blueprint">
    <div class="bp-meta mono">
      <span>[fig. 01 — outbound control plane]</span>
      <span style="color:#30D158">● 4 Worker Nodes · 0 Inbound Ports</span>
    </div>
    <svg viewBox="0 0 1080 260" width="100%" style="display:block" aria-label="Outbound node constellation">
      <defs>
        <linearGradient id="g-line" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stop-color="#2997FF" stop-opacity="0.25"/>
          <stop offset="100%" stop-color="#30D158" stop-opacity="0.95"/>
        </linearGradient>
      </defs>
      <!-- Left workers -->
      <g font-family="SF Mono, JetBrains Mono, monospace">
        <rect x="20" y="22" width="230" height="48" rx="11" fill="#12141A" stroke="rgba(255,255,255,0.14)"/>
        <circle cx="42" cy="46" r="4" fill="#30D158"/>
        <text x="58" y="42" fill="#F5F5F7" font-size="13" font-weight="600">linux-gpu-01</text>
        <text x="58" y="58" fill="#8E8E93" font-size="10.5">codex · claude · office LAN</text>

        <rect x="20" y="106" width="230" height="48" rx="11" fill="#12141A" stroke="rgba(255,255,255,0.14)"/>
        <circle cx="42" cy="130" r="4" fill="#30D158"/>
        <text x="58" y="126" fill="#F5F5F7" font-size="13" font-weight="600">macbook-pro</text>
        <text x="58" y="142" fill="#8E8E93" font-size="10.5">claude · agy · roaming</text>

        <rect x="20" y="190" width="230" height="48" rx="11" fill="#12141A" stroke="rgba(255,255,255,0.14)"/>
        <circle cx="42" cy="214" r="4" fill="#30D158"/>
        <text x="58" y="210" fill="#F5F5F7" font-size="13" font-weight="600">win-workstation</text>
        <text x="58" y="226" fill="#8E8E93" font-size="10.5">codex · dsh · home NAT</text>
      </g>

      <!-- Outbound beams -->
      <path d="M254 46 C335 46, 355 130, 430 130" fill="none" stroke="url(#g-line)" stroke-width="2" stroke-dasharray="5 5"/>
      <path d="M254 130 L430 130" fill="none" stroke="url(#g-line)" stroke-width="2" stroke-dasharray="5 5"/>
      <path d="M254 214 C335 214, 355 130, 430 130" fill="none" stroke="url(#g-line)" stroke-width="2" stroke-dasharray="5 5"/>
      <text x="336" y="114" text-anchor="middle" fill="#8E8E93" font-size="10.5" font-family="SF Mono, JetBrains Mono, monospace">outbound HTTPS / WSS :443 →</text>

      <!-- Center Tycho Host -->
      <rect x="434" y="64" width="256" height="132" rx="18" fill="#101827" stroke="#2997FF" stroke-width="1.6"/>
      <text x="562" y="106" text-anchor="middle" fill="#F5F5F7" font-size="18" font-weight="700">Tycho Host</text>
      <text x="562" y="130" text-anchor="middle" fill="#2997FF" font-size="11.5" font-family="SF Mono, JetBrains Mono, monospace">Node 24 · node:sqlite · SSE</text>
      <text x="562" y="156" text-anchor="middle" fill="#8E8E93" font-size="11">Public VPS · Localhost · Tailnet · Tunnel</text>

      <!-- Right Access Surfaces -->
      <path d="M694 130 C760 130, 775 60, 830 60" fill="none" stroke="rgba(255,255,255,0.22)" stroke-width="1.6"/>
      <path d="M694 130 L830 130" fill="none" stroke="rgba(255,255,255,0.22)" stroke-width="1.6"/>
      <path d="M694 130 C760 130, 775 200, 830 200" fill="none" stroke="rgba(255,255,255,0.22)" stroke-width="1.6"/>

      <g font-family="SF Mono, JetBrains Mono, monospace">
        <rect x="834" y="36" width="226" height="46" rx="11" fill="#12141A" stroke="rgba(255,255,255,0.14)"/>
        <text x="854" y="64" fill="#F5F5F7" font-size="12.5">Desktop (3.6 MB) · Web</text>
        <rect x="834" y="107" width="226" height="46" rx="11" fill="#12141A" stroke="rgba(255,255,255,0.14)"/>
        <text x="854" y="135" fill="#F5F5F7" font-size="12.5">iOS / Android PWA</text>
        <rect x="834" y="178" width="226" height="46" rx="11" fill="#12141A" stroke="rgba(255,255,255,0.14)"/>
        <text x="854" y="206" fill="#F5F5F7" font-size="12.5">WeCom · WeChat · Feishu</text>
      </g>
    </svg>
  </div>

  <div style="text-align:center;margin-top:26px">
    <div class="seg" id="dep-tabs">
      <button class="on" data-mode="vps" type="button" data-i18n="t_vps">公网云服务器 VPS</button>
      <button data-mode="local" type="button" data-i18n="t_loc">本机 90 秒试用</button>
      <button data-mode="mesh" type="button" data-i18n="t_mesh">Tailscale / 局域网</button>
      <button data-mode="tunnel" type="button" data-i18n="t_tun">NAT 反向隧道 WSS :443</button>
    </div>
  </div>

  <div class="dep-dock">
    <div>
      <h3 id="dep-title" style="font-size:20px;font-weight:700;letter-spacing:-0.02em;margin-bottom:8px"></h3>
      <p id="dep-desc" style="font-size:14.5px;color:var(--muted);line-height:1.62;margin-bottom:18px"></p>
      <a class="link-arrow" href="docs/remote-access.html" data-i18n="d_more">查看完整 4 种拓扑部署指南 ›</a>
    </div>
    <div class="code-block">
      <div class="code-head"><span class="mono code-lang">bash</span><button class="copy-btn" id="copy-dep" type="button">Copy</button></div>
      <pre><code id="dep-code"></code></pre>
    </div>
  </div>
</section>

<!-- ACT 4: EVERYWHERE CLIENTS, IM & PLUGIN TRIGGERS -->
<section class="act reveal" id="everywhere">
  <div class="act-narrow">
    <span class="act-kicker" data-i18n="a4_k">多端原生体验 · 开放协作生态</span>
    <h2 class="act-h" data-i18n="a4_h">不在电脑前，依然尽在掌控。</h2>
    <p class="act-p" data-i18n="a4_p">3.6 MB 桌面壳与手机独立 PWA 让你随时一键审批交付；内置企微、微信、飞书与开放签名协议，让团队在熟悉的聊天群里直接驱动项目闭环。</p>
  </div>

  <div class="showcase-full">
    <img src="assets/preview-clients.png" alt="Tycho 3.6 MB Desktop, Mobile PWA, JSON Themes and SKILL.md Mirror" />
  </div>

  <div class="duo-grid">
    <div class="duo-card">
      <div>
        <h3 data-i18n="im_h">随意接入任何 IM 平台</h3>
        <p data-i18n="im_p">开箱内置企微长连接与个人微信 iLink，附飞书桥接参考实现；任何平台均可通过 <code>tycho-v1</code> 双向 HMAC 协议在 10 分钟内接入，支持群快慢分流且绝不泄露私有控制台。</p>
      </div>
      <div class="flow-mini mono">
        <div class="flow-item"><span>WeCom WS · WeChat QR · Feishu</span><span style="color:var(--green)">Built-in</span></div>
        <div class="flow-item"><span>POST /inbound/:src (HMAC-SHA256)</span><span style="color:var(--accent)">Signed</span></div>
        <div class="flow-item"><span>GET /result/:fireId (Public Reply Only)</span><span style="color:var(--muted)">Isolated</span></div>
      </div>
      <a class="link-arrow" href="docs/extensibility.html" data-i18n="im_a">阅读开放 IM 双向协议 ›</a>
    </div>

    <div class="duo-card">
      <div>
        <h3 data-i18n="tr_h">3 类插件级事件触发器</h3>
        <p data-i18n="tr_p">不止被动响应指令：用显式 IANA 时区 Cron 定时巡检，用 SQLite 事务内生命周期事件自动串联审阅与发布，或接入 GitHub / 自定义签名 Webhook 并自动播报绑定群聊。</p>
      </div>
      <div class="flow-mini mono">
        <div class="flow-item"><span>0 9 * * 1-5 · Asia/Shanghai</span><span style="color:var(--amber)">Cron</span></div>
        <div class="flow-item"><span>task.ready → Auto Cross-Review</span><span style="color:var(--green)">Atomic</span></div>
        <div class="flow-item"><span>GitHub PR → Broadcast #eng-ops</span><span style="color:var(--accent)">Webhook</span></div>
      </div>
      <a class="link-arrow" href="docs/channels-and-triggers.html" data-i18n="tr_a">阅读 IM 与触发器指南 ›</a>
    </div>
  </div>
</section>

<!-- ACT 5: APPLE-STYLE ENGINEERING SPEC GRID + QUIET TECHNICAL APPENDIX -->
<section class="act reveal" id="specs">
  <div class="act-narrow">
    <span class="act-kicker" data-i18n="a5_k">工程底气</span>
    <h2 class="act-h" data-i18n="a5_h">没有沉重全家桶，为长期托付而造。</h2>
  </div>

  <div class="spec-grid">
    <div class="spec-cell"><b class="mono">0</b><strong data-i18n="sp1_t">运行时外部依赖</strong><span data-i18n="sp1_d">纯 Node 24 + 内置 node:sqlite，无需 Docker、Redis 或外部数据库。</span></div>
    <div class="spec-cell"><b class="mono">3.6 MB</b><strong data-i18n="sp2_t">轻量 Tauri v2 桌面端</strong><span data-i18n="sp2_d">Windows 绿色单文件与 macOS 通用包，拒绝 Electron 臃肿，支持手机 PWA。</span></div>
    <div class="spec-cell"><b class="mono">4 CLIs</b><strong data-i18n="sp3_t">原生执行器与空闲自动升级</strong><span data-i18n="sp3_d">透传 Claude Code、Codex、Gemini (agy) 与 dsh，支持跨机空闲升级 CLI。</span></div>
    <div class="spec-cell"><b class="mono">SKILL.md</b><strong data-i18n="sp4_t">跨机技能全网自动镜像</strong><span data-i18n="sp4_d">主机维护一份标准技能包，自动同步至每一台接入的执行机器。</span></div>
    <div class="spec-cell"><b class="mono">MCP</b><strong data-i18n="sp5_t">受限 Knowledge MCP</strong><span data-i18n="sp5_d">外部独立 CLI 可通过节点令牌安全挂载项目知识库，不越界。</span></div>
    <div class="spec-cell"><b class="mono">MIT</b><strong data-i18n="sp6_t">透明开源与热插拔主题</strong><span data-i18n="sp6_d">数据全归自己；把 JSON 放入 &lt;dataDir&gt;/themes/ 即可热重载控制台皮肤。</span></div>
  </div>
</section>

<section class="appendix" aria-labelledby="appx-h">
  <h3 id="appx-h" style="font-size:13px;font-weight:600;color:var(--muted);margin-bottom:14px;letter-spacing:0.04em" data-i18n="appx_t">技术契约速览</h3>
  <details class="d">
    <summary data-i18n="q1_t">为什么不做云端 SaaS，而是零依赖单账本自托管？</summary>
    <div class="db"><p data-i18n="q1_p">代码库、CLI 登录凭据与项目知识留在你自己的机器与 OS 用户隔离边界内。先记意图再派发，单活跃轮次由 SQLite 唯一索引约束，崩溃重启后如实核对机器现场。</p><a class="link-arrow" href="docs/architecture.html" data-i18n="q1_a">阅读核心架构与安全边界 ›</a></div>
  </details>
  <details class="d">
    <summary data-i18n="q2_t">如何把我们团队私有的计费网关或内部 IM 接进来？</summary>
    <div class="db"><p data-i18n="q2_p">无需 Fork 主仓库：私有计费把脚本放进 ~/.tycho/quota-probes/ 按 stdin/stdout JSON 契约输出额度；内部 IM 实现 2 个 HMAC-SHA256 接口即可双向闭环。</p><a class="link-arrow" href="docs/quota-plugins.html" data-i18n="q2_a">查看插件开发规范 ›</a></div>
  </details>
  <details class="d">
    <summary data-i18n="q3_t">需要预装 Node.js 24、root 权限或 Docker 吗？</summary>
    <div class="db"><p data-i18n="q3_p">都不需要。一键安装脚本仅以日常普通用户运行；若本机缺少 Node &gt;= 24.3.0，会自动隔离准备一份仅归 Tycho 使用的私有运行时。</p><a class="link-arrow" href="docs/quickstart.html" data-i18n="q3_a">查看 5 分钟快速上手 ›</a></div>
  </details>
</section>

<section class="close-band reveal">
  <h2 data-i18n="cl_h">带上你的原生 CLI，立即开始。</h2>
  <p data-i18n="cl_p">90 秒本机跑通，5 分钟部署公网 24×7 控制面。17 篇工程文档与全量 112 项配置参考已就绪。</p>
  <div class="hero-actions" style="margin-bottom:0">
    <a class="btn btn-lg btn-accent" href="docs/index.html" data-i18n="cl_b1">进入文档中心</a>
    <a class="btn btn-lg" href="${REPO_URL}/releases" target="_blank" rel="noreferrer" data-i18n="cl_b2">下载 v0.2.1 &amp; 桌面端</a>
  </div>
</section>

<footer>
  <div><strong>Tycho</strong> · v0.2.1 · MIT License</div>
  <div style="display:flex;gap:20px;flex-wrap:wrap">
    <a href="docs/index.html">Docs Home</a>
    <a href="docs/quickstart.html">Quickstart</a>
    <a href="docs/remote-access.html">Public VPS</a>
    <a href="docs/cli.html">CLI Reference</a>
    <a href="docs/settings.html">Settings</a>
    <a href="docs/security.html">Security</a>
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
    console: { img: 'assets/preview-console.png', title: '项目指挥台', desc: '总控拆解任务并跨机派发给 Codex 执行与 Claude 审阅，SSE 实时流式呈现。', href: 'docs/quickstart.html' },
    accounts: { img: 'assets/preview-accounts.png', title: '统一账号池', desc: '5h / 7d 实时配额遥测，三档优先级路由与私有计费探针插件。', href: 'docs/accounts-and-nodes.html' },
    channels: { img: 'assets/preview-channels.png', title: 'IM 与事件触发器', desc: '企微 / 微信 / 飞书与开放签名协议，配合 Cron / 事务内事件 / Webhook。', href: 'docs/channels-and-triggers.html' },
    clients: { img: 'assets/preview-clients.png', title: '多端客户端与主题', desc: '3.6 MB 桌面壳、iOS/Android 独立 PWA、热插拔 JSON 主题与 SKILL.md 镜像。', href: 'docs/clients.html' },
    arch: { img: 'assets/diagram-architecture.png', title: '系统架构全景', desc: '一本零依赖 SQLite 账本统筹决策、出站算力、账号池与外部扩展。', href: 'docs/architecture.html' },
  },
  en: {
    console: { img: 'assets/preview-console.png', title: 'Mission Control', desc: 'Project router dispatches work across machines (Codex execute + Claude review) over live SSE.', href: 'docs/quickstart.html' },
    accounts: { img: 'assets/preview-accounts.png', title: 'Unified Accounts Pool', desc: '5h / 7d quota telemetry, 3-tier priority routing, and local billing probe plugins.', href: 'docs/accounts-and-nodes.html' },
    channels: { img: 'assets/preview-channels.png', title: 'IM & Event Triggers', desc: 'WeCom, WeChat, Feishu & open HMAC protocol paired with Cron, ledger events & webhooks.', href: 'docs/channels-and-triggers.html' },
    clients: { img: 'assets/preview-clients.png', title: 'Everywhere Clients & Themes', desc: '3.6 MB desktop shell, standalone mobile PWA, drop-in JSON themes & SKILL.md mirror.', href: 'docs/clients.html' },
    arch: { img: 'assets/diagram-architecture.png', title: 'System Architecture', desc: 'One zero-dependency SQLite ledger orchestrating routing, outbound nodes, and open integrations.', href: 'docs/architecture.html' },
  },
};
const DEPS = {
  zh: {
    vps: { title: '公网云服务器 / VPS 24×7 托管', desc: '在带公网 HTTPS 域名的 Linux 云主机常驻运行，Nginx / Caddy 反代 127.0.0.1:8787（关闭 proxy_buffering 保障 SSE），随时接入全部工作站、桌面端与手机 PWA。', code: 'curl -fsSL https://github.com/XaineChaeson/tycho/releases/latest/download/install.sh | bash\\ntycho service install && loginctl enable-linger "$USER"\\n\\n# 任意远程机器接入（无需开放入站端口）：\\ntycho node join --to https://tycho.example.com' },
    local: { title: '本机 90 秒快速试用', desc: '零配置直接在自己电脑跑通完整闭环，回环地址接入自动放行。', code: 'tycho run --open\\n# 另开终端接入本机算力：\\ntycho node join --to http://127.0.0.1:8787' },
    mesh: { title: 'Tailscale / WireGuard / 局域网', desc: '零公网暴露，在私有组网内互通全部设备与算力节点。', code: '# 设置 http.host = 0.0.0.0 与公网地址为 Tailnet 域名后：\\ntycho stop && tycho service start\\ntycho node join --to https://my-host.tailnet.ts.net' },
    tunnel: { title: 'NAT 反向隧道（支持 WSS :443 穿透代理）', desc: '主机留在公司/家庭内网零开放端口，主动外连公网中转机；22 端口受限时自动走内置 WSS :443。', code: 'ssh-keygen -t ed25519 -f ~/.tycho/gateway_ed25519 -N ""\\n# 控制台「设置 › 门牌」填入 gateway.ssh = tycho-gw@relay 与端口\\ntycho doctor' },
  },
  en: {
    vps: { title: 'Public Cloud Server / VPS (24×7 Hub)', desc: 'Run Host 24×7 on any Linux VPS behind Nginx/Caddy HTTPS (with proxy_buffering off for SSE) and join workstations, Desktop & Mobile PWA from anywhere.', code: 'curl -fsSL https://github.com/XaineChaeson/tycho/releases/latest/download/install.sh | bash\\ntycho service install && loginctl enable-linger "$USER"\\n\\n# Join any remote machine (zero inbound ports):\\ntycho node join --to https://tycho.example.com' },
    local: { title: 'Localhost Solo Start (90s)', desc: 'Zero-config local loop on a single workstation; loopback joins auto-approve.', code: 'tycho run --open\\n# Second terminal:\\ntycho node join --to http://127.0.0.1:8787' },
    mesh: { title: 'Tailscale / WireGuard / LAN Mesh', desc: 'Zero public exposure; bind inside your private Tailnet or LAN firewall.', code: '# Set http.host = 0.0.0.0 and publicUrl to your Tailnet host:\\ntycho stop && tycho service start\\ntycho node join --to https://my-host.tailnet.ts.net' },
    tunnel: { title: 'NAT Reverse Tunnel (WSS :443 Proxy-Safe)', desc: 'Keep Host behind corporate or home NAT with zero inbound ports; built-in SSH-over-WSS :443 traverses HTTPS_PROXY.', code: 'ssh-keygen -t ed25519 -f ~/.tycho/gateway_ed25519 -N ""\\n# Enter gateway.ssh = tycho-gw@relay in Settings › Gateway\\ntycho doctor' },
  },
};
const SIM_DATA = {
  decide: [
    { p: 'P1', name: 'Gemini Ultra', sub: 'gemini-2.5-pro · 7d window', pct: 16, capPct: 100 },
    { p: 'P2', name: 'Work Codex Pro', sub: 'gpt-5.4 · xhigh · 5h window', pct: 24, capPct: 24 },
    { p: 'P3', name: 'Claude Max', sub: 'claude-opus-4 · 5h window', pct: 19, capPct: 19 },
  ],
  execute: [
    { p: 'P1', name: 'Work Codex Pro', sub: 'gpt-5.4 · high · 5h window', pct: 32, capPct: 100 },
    { p: 'P2', name: 'Claude Max', sub: 'claude-sonnet-4 · 5h window', pct: 22, capPct: 22 },
    { p: 'P3', name: 'Custom Gateway Plugin', sub: '~/.tycho/quota-probes/gw.mjs', pct: 54, capPct: 54 },
  ],
  operate: [
    { p: 'P1', name: 'Work Codex Mini', sub: 'gpt-5.4-mini · fast triage', pct: 12, capPct: 100 },
    { p: 'P2', name: 'Gemini Flash', sub: 'agy · verification & lint', pct: 9, capPct: 9 },
    { p: 'P3', name: 'Local dsh Route', sub: 'machine-local login', pct: 18, capPct: 18 },
  ],
};
const TXT = {
  zh: { nav_acc:'调度与额度', nav_flt:'多机与部署', nav_cli:'客户端与 IM', nav_docs:'文档中心', nav_search:'搜索', h1:'把你手头的原生 AI CLI，编排成一支工程团队。', lead:'直接调度你已订阅的 Claude Code、Codex、Gemini 与 dsh —— 一本零依赖 SQLite 账本，统筹每一台机器、每一份额度与每一端设备。', cta_start:'5 分钟开始使用', cta_docs:'探索文档中心 ›', v_con:'指挥台', v_acc:'额度池', v_ch:'IM 与触发', v_cl:'多端', v_arch:'架构', a2_k:'原生执行器 · 统一账号池', a2_h:'你的订阅，全功率释放。', a2_p:'无需改换按量 API Key，不丢原有的 MCP、钩子与 Git 凭据。把不同厂商与多份订阅统一编入三档路由，额度触限前自动优雅切号。', a2_l1:'原生 CLI 透传', a2_l2:'多窗口配额遥测', a2_r2:'5h / 7d 实时感知 · P1→P2 顺延', a2_l3:'私有计费探针插件', a2_more:'深入了解账号池与三档路由 ›', sim_dec:'决策档', sim_exe:'执行档', sim_ope:'操作档', a3_k:'零入站 SSH · 4 种部署拓扑', a3_h:'一台主机，调度每一台机器。', a3_p:'无论算力在公司内网工作站、家里 Windows 主机还是 MacBook，节点通过出站长连主动接入；主机可常驻公网云服务器 VPS，也可以留在内网经 WSS :443 隧道对外提供服务。', t_vps:'公网云服务器 VPS', t_loc:'本机 90 秒试用', t_mesh:'Tailscale / 局域网', t_tun:'NAT 反向隧道 WSS :443', d_more:'查看完整 4 种拓扑部署指南 ›', a4_k:'多端原生体验 · 开放协作生态', a4_h:'不在电脑前，依然尽在掌控。', a4_p:'3.6 MB 桌面壳与手机独立 PWA 让你随时一键审批交付；内置企微、微信、飞书与开放签名协议，让团队在熟悉的聊天群里直接驱动项目闭环。', im_h:'随意接入任何 IM 平台', im_p:'开箱内置企微长连接与个人微信 iLink，附飞书桥接参考实现；任何平台均可通过 tycho-v1 双向 HMAC 协议在 10 分钟内接入，支持群快慢分流且绝不泄露私有控制台。', im_a:'阅读开放 IM 双向协议 ›', tr_h:'3 类插件级事件触发器', tr_p:'不止被动响应指令：用显式 IANA 时区 Cron 定时巡检，用 SQLite 事务内生命周期事件自动串联审阅与发布，或接入 GitHub / 自定义签名 Webhook 并自动播报绑定群聊。', tr_a:'阅读 IM 与触发器指南 ›', a5_k:'工程底气', a5_h:'没有沉重全家桶，为长期托付而造。', sp1_t:'运行时外部依赖', sp1_d:'纯 Node 24 + 内置 node:sqlite，无需 Docker、Redis 或外部数据库。', sp2_t:'轻量 Tauri v2 桌面端', sp2_d:'Windows 绿色单文件与 macOS 通用包，拒绝 Electron 臃肿，支持手机 PWA。', sp3_t:'原生执行器与空闲自动升级', sp3_d:'透传 Claude Code、Codex、Gemini (agy) 与 dsh，支持跨机空闲升级 CLI。', sp4_t:'跨机技能全网自动镜像', sp4_d:'主机维护一份标准技能包，自动同步至每一台接入的执行机器。', sp5_t:'受限 Knowledge MCP', sp5_d:'外部独立 CLI 可通过节点令牌安全挂载项目知识库，不越界。', sp6_t:'透明开源与热插拔主题', sp6_d:'数据全归自己；把 JSON 放入 <dataDir>/themes/ 即可热重载控制台皮肤。', appx_t:'技术契约速览', q1_t:'为什么不做云端 SaaS，而是零依赖单账本自托管？', q1_p:'代码库、CLI 登录凭据与项目知识留在你自己的机器与 OS 用户隔离边界内。先记意图再派发，单活跃轮次由 SQLite 唯一索引约束，崩溃重启后如实核对机器现场。', q1_a:'阅读核心架构与安全边界 ›', q2_t:'如何把我们团队私有的计费网关或内部 IM 接进来？', q2_p:'无需 Fork 主仓库：私有计费把脚本放进 ~/.tycho/quota-probes/ 按 stdin/stdout JSON 契约输出额度；内部 IM 实现 2 个 HMAC-SHA256 接口即可双向闭环。', q2_a:'查看插件开发规范 ›', q3_t:'需要预装 Node.js 24、root 权限或 Docker 吗？', q3_p:'都不需要。一键安装脚本仅以日常普通用户运行；若本机缺少 Node >= 24.3.0，会自动隔离准备一份仅归 Tycho 使用的私有运行时。', q3_a:'查看 5 分钟快速上手 ›', cl_h:'带上你的原生 CLI，立即开始。', cl_p:'90 秒本机跑通，5 分钟部署公网 24×7 控制面。17 篇工程文档与全量 112 项配置参考已就绪。', cl_b1:'进入文档中心', cl_b2:'下载 v0.2.1 & 桌面端' },
  en: { nav_acc:'Accounts', nav_flt:'Fleet & Deploy', nav_cli:'Clients & IM', nav_docs:'Docs', nav_search:'Search', h1:'Turn your native AI CLIs into one engineering team.', lead:'Orchestrate your existing Claude Code, Codex, Gemini, and dsh subscriptions across every machine, account, and device — backed by one zero-dependency SQLite ledger.', cta_start:'Get Started in 5 Min', cta_docs:'Explore Docs Portal ›', v_con:'Console', v_acc:'Quotas', v_ch:'IM & Triggers', v_cl:'Clients', v_arch:'Architecture', a2_k:'BYOS NATIVE CLIS · UNIFIED ACCOUNTS', a2_h:'Every subscription, at full power.', a2_p:'No forced API-key migration, no lost MCPs or Git hooks. Pool every provider and login across three routing tiers with automatic quota failover.', a2_l1:'100% Native CLI Passthrough', a2_l2:'Multi-Window Telemetry', a2_r2:'5h / 7d live tracking · P1→P2 failover', a2_l3:'Private Billing Plugins', a2_more:'Read Accounts & 3-Tier Guide ›', sim_dec:'Decide', sim_exe:'Execute', sim_ope:'Operate', a3_k:'ZERO INBOUND SSH · 4 TOPOLOGIES', a3_h:'One control plane, every machine.', a3_p:'Keep workstations behind corporate or home NAT with zero open ports. Nodes dial out over HTTPS or proxy-safe WSS :443 to your public VPS or private Host.', t_vps:'Public Cloud VPS', t_loc:'Localhost (90s)', t_mesh:'Tailscale / LAN', t_tun:'NAT Tunnel WSS :443', d_more:'Read Full 4-Topology Guide ›', a4_k:'EVERYWHERE CLIENTS · OPEN INTEGRATIONS', a4_h:'Stay in command, away from your desk.', a4_p:'Approve work from a 3.6 MB desktop shell or standalone mobile PWA — or drive projects straight from WeCom, WeChat, Feishu, or any custom IM.', im_h:'Plug in any IM platform', im_p:'Built-in WeCom WS, Personal WeChat iLink, and Feishu bridge; connect Slack, Discord, or internal chat in 10 minutes via signed tycho-v1 HMAC with zero console leaks.', im_a:'Read Open IM Protocol ›', tr_h:'Three plugin-grade trigger families', tr_p:'Schedule IANA-timezone Cron jobs, chain atomic SQLite lifecycle events (ready / accepted / merged), or verify GitHub & custom webhooks with group broadcast.', tr_a:'Read Channels & Triggers Guide ›', a5_k:'BUILT FOR LONGEVITY', a5_h:'Zero bloat. Crafted to trust 24×7.', sp1_t:'Runtime Dependencies', sp1_d:'Pure Node 24 + built-in node:sqlite. No Docker, Redis, or external DB required.', sp2_t:'Native Tauri v2 Desktop', sp2_d:'Portable Windows exe & universal macOS DMG without Electron overhead, plus mobile PWA.', sp3_t:'Native CLIs + Fleet Updater', sp3_d:'Drives real Claude Code, Codex, Gemini (agy) & dsh with idle-safe fleet CLI upgrades.', sp4_t:'Auto-Mirrored SKILL.md Fleet', sp4_d:'Keep one skill catalog on Host and mirror automatically to every worker node.', sp5_t:'Scoped Knowledge MCP', sp5_d:'Attach project knowledge to external CLIs via node tokens with strict boundaries.', sp6_t:'MIT Open Source & JSON Themes', sp6_d:'Own your ledger and data; drop JSON packs into <dataDir>/themes/ for hot reload.', appx_t:'ENGINEERING FAQ', q1_t:'Why a self-hosted SQLite ledger instead of a cloud wrapper?', q1_p:'Your repos, CLI logins, and project knowledge stay inside your own OS user boundary. Intent is persisted first, one active round per task is enforced by SQLite uniqueness, and restarts reconcile reality.', q1_a:'Read Architecture & Security ›', q2_t:'How do I plug in our private billing gateway or custom IM?', q2_p:'No fork needed: drop a script into ~/.tycho/quota-probes/ emitting standard JSON windows, or implement two HMAC-SHA256 endpoints for any chat platform.', q2_a:'Read Plugin Contracts ›', q3_t:'Do I need Node.js 24, root access, or Docker?', q3_p:'None of them. The installer runs as your normal user and provisions an isolated Node 24 runtime for Tycho automatically if needed.', q3_a:'Read 5-Minute Quickstart ›', cl_h:'Bring your CLIs. Own your control plane.', cl_p:'90 seconds locally, 5 minutes on your public VPS. 17 engineering guides and 112 auto-generated settings await.', cl_b1:'Open Docs Portal', cl_b2:'Download v0.2.1 & Desktop' },
};

let lang = 'zh', mode = 'vps', view = 'console', simTier = 'decide', capHit = false;

function renderSim() {
  const rows = SIM_DATA[simTier];
  const btn = document.getElementById('cap-toggle');
  btn.classList.toggle('hot', capHit);
  btn.textContent = capHit
    ? (lang === 'zh' ? '✓ 已触发 P1 歇息（点此恢复）' : '✓ P1 Resting (Click to reset)')
    : (lang === 'zh' ? '模拟 P1 触限切号' : 'Simulate P1 Cap');

  document.getElementById('sim-cards').innerHTML = rows.map((r, i) => {
    const pct = capHit && i === 0 ? r.capPct : r.pct;
    const isActive = (!capHit && i === 0) || (capHit && i === 1);
    const isRest = capHit && i === 0;
    const tagCls = isActive ? 'live' : (isRest ? 'rest' : 'standby');
    const tagTxt = isActive ? (lang === 'zh' ? '当前路由中' : 'Active Route') : (isRest ? (lang === 'zh' ? '触限歇息' : 'Resting') : (lang === 'zh' ? '顺延待命' : 'Standby'));
    const barColor = isRest ? 'var(--amber)' : (isActive ? 'var(--accent)' : 'var(--muted)');
    return '<div class="acc-row ' + (isActive ? 'active' : (isRest ? 'resting' : '')) + '">'
      + '<div class="acc-head"><div><strong class="mono" style="margin-right:8px">' + r.p + '</strong><strong>' + r.name + '</strong><span style="color:var(--muted);margin-left:8px;font-size:12px">' + r.sub + '</span></div><span class="acc-tag ' + tagCls + '">' + tagTxt + '</span></div>'
      + '<div class="meter"><i style="width:' + pct + '%;background:' + barColor + '"></i></div>'
      + '</div>';
  }).join('');

  document.getElementById('sim-note').textContent = capHit
    ? (lang === 'zh' ? 'P1 已自动进入歇息，下一轮无缝由 P2 承接' : 'P1 resting automatically — next round routes to P2 seamlessly')
    : (lang === 'zh' ? 'P1 额度健康，按优先级优先调度' : 'P1 healthy — routed by tier priority');
}

function syncView() {
  const v = VIEWS[lang][view];
  document.getElementById('stage-img').src = v.img;
  document.getElementById('cap-title').textContent = v.title;
  document.getElementById('cap-desc').textContent = v.desc;
  const link = document.getElementById('cap-link');
  link.href = v.href;
  link.textContent = lang === 'zh' ? '阅读详情 ›' : 'Read guide ›';
}
function syncDep() {
  const d = DEPS[lang][mode];
  document.getElementById('dep-title').textContent = d.title;
  document.getElementById('dep-desc').textContent = d.desc;
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
  renderSim();
}

document.querySelectorAll('.os-btn').forEach(b => b.addEventListener('click', () => {
  document.querySelectorAll('.os-btn').forEach(x => x.classList.toggle('on', x === b));
  document.getElementById('inst-cmd').textContent = INST[b.dataset.os];
}));
document.querySelectorAll('[data-view]').forEach(b => b.addEventListener('click', () => {
  view = b.dataset.view;
  document.querySelectorAll('[data-view]').forEach(x => x.classList.toggle('on', x === b));
  syncView();
}));
document.getElementById('sim-tiers').addEventListener('click', e => {
  const b = e.target.closest('[data-tier]'); if (!b) return;
  simTier = b.dataset.tier;
  document.querySelectorAll('#sim-tiers [data-tier]').forEach(x => x.classList.toggle('on', x === b));
  renderSim();
});
document.getElementById('cap-toggle').addEventListener('click', () => { capHit = !capHit; renderSim(); });
document.getElementById('dep-tabs').addEventListener('click', e => {
  const b = e.target.closest('[data-mode]'); if (!b) return;
  mode = b.dataset.mode;
  document.querySelectorAll('#dep-tabs [data-mode]').forEach(x => x.classList.toggle('on', x === b));
  syncDep();
});
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

// ============================================================================
// STRIPE-STYLE TASK-ORIENTED DOCUMENTATION PORTAL HOME (/docs/index.html)
// ============================================================================
function renderDocsHome(): string {
  const groups = new Map<string, DocSpec[]>();
  for (const p of DOC_PAGES) {
    const arr = groups.get(p.group) ?? [];
    arr.push(p);
    groups.set(p.group, arr);
  }
  const groupSections = [...groups.entries()].map(([g, items], gi) => `
    <div class="dir-group">
      <div class="dir-head"><span class="mono" style="color:var(--accent)">0${gi + 1}</span><h3>${escapeHtml(g)}</h3></div>
      <div class="dir-cards">
        ${items.map((it) => `<a class="dir-card" href="${it.slug}.html"><strong>${escapeHtml(it.title)}</strong><span>${escapeHtml(it.summary)}</span></a>`).join('')}
      </div>
    </div>`).join('');

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
${THEME_HEAD_SNIPPET}
<title>文档中心 — Tycho Docs</title>
<link rel="icon" type="image/svg+xml" href="../assets/tycho-logo.svg" />
<style>${SHARED_CSS}
.dh-hero { max-width: 980px; margin: 0 auto; padding: 72px 24px 48px; text-align: center; }
.dh-hero h1 { font-size: clamp(32px, 4.4vw, 48px); font-weight: 750; letter-spacing: -0.038em; margin-bottom: 12px; }
.dh-hero p { font-size: 16.5px; color: var(--muted); max-width: 600px; margin: 0 auto 28px; }
.dh-search {
  cursor: pointer; width: min(560px, 100%); margin: 0 auto; padding: 13px 18px;
  border-radius: 14px; border: 1px solid var(--border-strong); background: var(--surface);
  color: var(--muted); font-size: 14.5px; font-family: inherit;
  display: flex; justify-content: space-between; align-items: center; gap: 12px;
  transition: border-color .15s, background .15s;
}
.dh-search:hover { border-color: var(--accent); background: var(--surface-elev); }

.dh-wrap { max-width: 1180px; margin: 0 auto; padding: 12px 24px 96px; }
.jtbd-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px; margin-bottom: 64px; }
.jtbd {
  padding: 24px; border-radius: 18px; background: var(--surface); border: 1px solid var(--border);
  color: var(--ink); display: flex; flex-direction: column; gap: 10px;
  transition: transform .16s, border-color .16s;
}
.jtbd:hover { transform: translateY(-2px); border-color: var(--accent); text-decoration: none; }
.jtbd-tag { font-size: 11px; font-weight: 600; color: var(--accent); }
.jtbd h2 { font-size: 17.5px; font-weight: 700; letter-spacing: -0.02em; }
.jtbd p { font-size: 13.5px; color: var(--muted); line-height: 1.58; flex: 1; }
.jtbd-go { font-size: 13px; font-weight: 600; color: var(--accent); }

.vis-strip { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; margin-bottom: 72px; }
.vis-card {
  border-radius: 16px; overflow: hidden; border: 1px solid var(--border); background: var(--surface);
  color: var(--ink); display: flex; flex-direction: column; transition: border-color .16s, transform .16s;
}
.vis-card:hover { border-color: var(--accent); transform: translateY(-2px); text-decoration: none; }
.vis-card img { width: 100%; aspect-ratio: 16 / 9.6; object-fit: cover; background: #07080C; display: block; }
.vis-card div { padding: 14px 16px; }
.vis-card strong { display: block; font-size: 14.5px; margin-bottom: 3px; }
.vis-card span { font-size: 12.5px; color: var(--muted); }

.dir-group { margin-bottom: 44px; }
.dir-head { display: flex; align-items: baseline; gap: 10px; margin-bottom: 14px; padding-bottom: 10px; border-bottom: 1px solid var(--border); }
.dir-head h3 { font-size: 18px; font-weight: 700; letter-spacing: -0.02em; }
.dir-cards { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; }
.dir-card {
  padding: 16px 18px; border-radius: 13px; border: 1px solid var(--border); background: var(--surface);
  color: var(--ink); display: flex; flex-direction: column; gap: 5px; transition: border-color .15s, background .15s;
}
.dir-card:hover { border-color: var(--accent); background: var(--surface-elev); text-decoration: none; }
.dir-card strong { font-size: 14.5px; font-weight: 650; }
.dir-card span { font-size: 12.5px; color: var(--muted); line-height: 1.5; }

@media (max-width: 980px) { .jtbd-grid { grid-template-columns: repeat(2, 1fr); } .vis-strip, .dir-cards { grid-template-columns: repeat(2, 1fr); } .nav-mid { display: none; } }
@media (max-width: 560px) { .jtbd-grid, .vis-strip, .dir-cards { grid-template-columns: 1fr; } }
</style>
</head>
<body>
<header class="topbar">
  <div class="topbar-in">
    <a class="brand" href="../index.html">
      <img src="../assets/tycho-logo-512.png" alt="Tycho" />
      <span>tycho</span>
      <span class="brand-sub">/ docs</span>
    </a>
    <nav class="nav-mid">
      <a href="../index.html">产品首页</a>
      <a class="active" href="index.html">文档门户</a>
      <a href="quickstart.html">快速上手</a>
      <a href="cli.html">CLI 参考</a>
      <a href="settings.html">配置项</a>
    </nav>
    <div class="nav-r">
      <button class="btn" data-open-search type="button">搜索 <span class="kbd">Ctrl K</span></button>
      <button class="btn" id="theme-btn" type="button" aria-label="Toggle color theme">☀</button>
      <a class="btn btn-solid" href="${REPO_URL}" target="_blank" rel="noreferrer">GitHub ↗</a>
    </div>
  </div>
</header>

<section class="dh-hero">
  <h1>Tycho 文档中心</h1>
  <p>按你的当前目标直接进入对应路径 —— 17 篇工程指南与自动生成的精确参考，全程零障碍落地。</p>
  <button class="dh-search" data-open-search type="button">
    <span style="display:flex;align-items:center;gap:10px">
      <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="7" cy="7" r="4.8"/><path d="M11 11l3 3" stroke-linecap="round"/></svg>
      搜索快速上手、公网 VPS、HMAC 协议、CLI 或 112 项配置...
    </span>
    <span class="kbd">Ctrl K</span>
  </button>
</section>

<main class="dh-wrap">
  <div class="jtbd-grid">
    <a class="jtbd" href="quickstart.html">
      <span class="jtbd-tag mono">START HERE · 5 MIN</span>
      <h2>首次在本机跑通</h2>
      <p>无需 root、无需 Docker、无需预装 Node 24。1 行命令装好并亲眼看到原生执行器跑完首条任务。</p>
      <span class="jtbd-go">5 分钟快速上手 ›</span>
    </a>
    <a class="jtbd" href="remote-access.html">
      <span class="jtbd-tag mono">PRODUCTION · 4 MODES</span>
      <h2>部署公网 VPS 与多机算力</h2>
      <p>公网 HTTPS 反代（含 SSE 配置）、Tailscale 私有组网，以及穿透代理的 NAT 反向隧道 WSS :443。</p>
      <span class="jtbd-go">4 种部署拓扑手册 ›</span>
    </a>
    <a class="jtbd" href="channels-and-triggers.html">
      <span class="jtbd-tag mono">INTEGRATE · OPEN</span>
      <h2>接入 IM、触发器与插件</h2>
      <p>配置企微长连接、个人微信与飞书，或接入 Cron、事务内生命周期事件、Webhook 与私有额度探针。</p>
      <span class="jtbd-go">IM 与自动化指南 ›</span>
    </a>
    <a class="jtbd" href="settings.html">
      <span class="jtbd-tag mono">REFERENCE · AUTO-SYNCED</span>
      <h2>查 CLI 命令与 112 项配置</h2>
      <p>直接由源码生成的命令与配置参考，附完整症状→修复故障排查表与安全信任边界。</p>
      <span class="jtbd-go">全量配置项参考 ›</span>
    </a>
  </div>

  <div class="vis-strip">
    <a class="vis-card" href="architecture.html">
      <img src="../assets/diagram-architecture.png" alt="Architecture diagram" />
      <div><strong>核心架构与安全边界</strong><span>一张图看懂 SQLite 单账本、出站算力网与信任边界</span></div>
    </a>
    <a class="vis-card" href="channels-and-triggers.html">
      <img src="../assets/preview-channels.png" alt="IM and triggers preview" />
      <div><strong>双向签名 IM 与事件触发器</strong><span>群快慢分流、严禁泄露控制台与 3 类触发流水线</span></div>
    </a>
    <a class="vis-card" href="clients.html">
      <img src="../assets/preview-clients.png" alt="Clients and PWA preview" />
      <div><strong>3.6 MB 桌面端与手机 PWA</strong><span>三端桌面壳下载、iOS/Android 免商店安装与主题包</span></div>
    </a>
  </div>

  ${groupSections}
</main>

${SEARCH_DIALOG_HTML}
<script>${renderSharedScript('../search-index.json', '')}</script>
</body>
</html>`;
}

// ============================================================================
// INDIVIDUAL DOC PAGE READER (/docs/<slug>.html)
// ============================================================================
function renderDocPage(spec: DocSpec, index: number, htmlBody: string, headings: Heading[], minutes: number): string {
  const groups = new Map<string, DocSpec[]>();
  for (const p of DOC_PAGES) {
    const arr = groups.get(p.group) ?? [];
    arr.push(p);
    groups.set(p.group, arr);
  }
  const sidebarHtml = `
    <div style="margin-bottom:14px">
      <a class="sb-home" href="index.html">← 返回文档门户</a>
    </div>` + [...groups.entries()].map(([g, items], gi) => `
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
  position: fixed; left: 0; top: 54px; z-index: 60;
  width: 100%; height: 2px; pointer-events: none;
  background: var(--accent);
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

.doc-layout { max-width: 1320px; margin: 0 auto; display: grid; grid-template-columns: 252px minmax(0, 1fr) 224px; gap: 44px; padding: 32px 24px 96px; }
.sidebar { position: sticky; top: 82px; align-self: start; max-height: calc(100vh - 106px); overflow-y: auto; padding-right: 10px; }
.sb-home { display: inline-block; font-size: 12.5px; font-weight: 600; color: var(--muted); padding: 4px 6px; border-radius: 7px; }
.sb-home:hover { color: var(--ink); background: var(--surface); text-decoration: none; }
.sb-group.sep { border-top: 1px solid var(--border); margin-top: 15px; padding-top: 15px; }
.sb-head { font-size: 0.875rem; font-weight: 700; color: var(--ink); margin-bottom: 7px; padding-left: 4px; }
.sb-list { margin-left: 0.5rem; border-left: 1px solid var(--border); display: flex; flex-direction: column; gap: 2px; padding-left: 10px; }
.sb-link { display: block; padding: 5.5px 10px; border-radius: 8px; font-size: 0.835rem; color: var(--muted); transition: background .12s, color .12s; }
.sb-link:hover { color: var(--ink); background: var(--surface); text-decoration: none; }
.sb-link.active { color: var(--accent); background: var(--accent-soft); font-weight: 600; }

.doc-meta {
  display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap;
  padding-bottom: 14px; margin-bottom: 22px; border-bottom: 1px solid var(--border); font-size: 12.5px; color: var(--muted);
}
.crumb { display: flex; align-items: center; gap: 7px; }
.crumb b { color: var(--ink); font-weight: 600; }
.meta-r { display: flex; align-items: center; gap: 14px; }
.mob-menu-btn { display: none; }

/* Stripe / Apple Reading Typography */
.prose { max-width: 74ch; min-width: 0; }
.prose h1 { font-size: clamp(28px, 3.4vw, 36px); font-weight: 750; letter-spacing: -0.035em; line-height: 1.18; margin-bottom: 20px; }
.prose h2 { font-size: 22px; font-weight: 700; letter-spacing: -0.025em; margin: 44px 0 14px; padding-top: 22px; border-top: 1px solid var(--border); scroll-margin-top: 80px; }
.prose h3 { font-size: 17px; font-weight: 650; margin: 26px 0 9px; scroll-margin-top: 80px; }
.prose h4 { font-size: 15px; font-weight: 650; margin: 18px 0 6px; }
.prose p { margin: 12px 0; color: var(--ink-2); font-size: 15px; line-height: 1.78; }
.prose ul, .prose ol { margin: 12px 0 18px 22px; color: var(--ink-2); font-size: 15px; line-height: 1.76; }
.prose li { margin: 6px 0; }
.prose code { font-family: var(--font-mono); font-size: 0.85em; padding: 2px 6px; border-radius: 6px; background: var(--surface); border: 1px solid var(--border); color: var(--ink); overflow-wrap: break-word; word-break: normal; }
.prose pre code { background: transparent; border: 0; padding: 0; color: inherit; font-size: inherit; border-radius: 0; }
.prose hr { border: 0; border-top: 1px solid var(--border); margin: 32px 0; }
.prose img { max-width: 100%; border-radius: 16px; border: 1px solid var(--border-strong); margin: 18px 0; box-shadow: var(--shadow-card); }
.prose blockquote { border-left: 3px solid var(--border-strong); padding: 6px 16px; margin: 18px 0; color: var(--muted); background: var(--surface); border-radius: 0 10px 10px 0; }

.callout { border-radius: 13px; border: 1px solid var(--border); padding: 14px 16px; margin: 20px 0; background: var(--surface); }
.callout-tip { border-left: 3px solid var(--green); }
.callout-tip .callout-title { color: var(--green); }
.callout-important, .callout-note { border-left: 3px solid var(--accent); }
.callout-important .callout-title, .callout-note .callout-title { color: var(--accent); }
.callout-warning, .callout-caution { border-left: 3px solid var(--amber); }
.callout-warning .callout-title, .callout-caution .callout-title { color: var(--amber); }
.callout-title { display: flex; align-items: center; gap: 7px; font-size: 11.5px; font-weight: 700; letter-spacing: 0.06em; margin-bottom: 6px; }
.callout p { margin: 4px 0; font-size: 14px; }

.table-scroll { max-width: 100%; overflow-x: auto; border: 1px solid var(--border); border-radius: 13px; margin: 20px 0; background: var(--surface-elev); }
.table-scroll table { width: 100%; border-collapse: collapse; font-size: 13.5px; }
.table-scroll th, .table-scroll td { padding: 10px 14px; border-bottom: 1px solid var(--border); text-align: left; vertical-align: top; }
.table-scroll tr:last-child td { border-bottom: 0; }
.table-scroll th { background: var(--surface); font-weight: 600; font-size: 12.5px; color: var(--muted); white-space: nowrap; }
.table-scroll td:first-child { min-width: 7rem; }
.table-scroll td:first-child code { white-space: nowrap; }
.prose details { border: 1px solid var(--border); border-radius: 12px; padding: 12px 16px; margin: 16px 0; background: var(--surface); }
.prose summary { cursor: pointer; font-weight: 600; font-size: 14.5px; }

.toc { position: sticky; top: 82px; align-self: start; max-height: calc(100vh - 106px); overflow-y: auto; border-left: 1px solid var(--border); padding-left: 14px; }
.toc-t { font-size: 11.5px; font-weight: 700; color: var(--ink); margin-bottom: 10px; letter-spacing: 0.04em; }
.toc-l { display: block; padding: 4px 0; line-height: 1.42; color: var(--muted); overflow-wrap: anywhere; transition: color .14s; }
.toc-2 { font-size: 0.81rem; font-weight: 500; }
.toc-3 { font-size: 0.76rem; padding-left: 12px; color: var(--faint); }
.toc-l:hover, .toc-l.on { color: var(--accent); text-decoration: none; font-weight: 600; }

.pager { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; margin-top: 52px; padding-top: 26px; border-top: 1px solid var(--border); }
.pager a { padding: 15px 18px; border-radius: 13px; border: 1px solid var(--border); background: var(--surface); display: flex; flex-direction: column; gap: 3px; color: var(--ink); transition: border-color .15s; }
.pager a:hover { border-color: var(--accent); text-decoration: none; }
.pager small { font-size: 11.5px; color: var(--faint); }

@media (max-width: 1140px) { .doc-layout { grid-template-columns: 236px minmax(0, 1fr); } .toc { display: none; } }
@media (max-width: 820px) {
  .doc-layout { grid-template-columns: 1fr; padding-top: 18px; }
  .mob-menu-btn { display: inline-flex; }
  .sidebar { display: none; position: static; max-height: none; border: 1px solid var(--border); border-radius: 14px; padding: 16px; background: var(--surface); margin-bottom: 16px; }
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
      <span class="brand-sub">/ docs</span>
    </a>
    <nav class="nav-mid">
      <a href="../index.html">产品首页</a>
      <a href="index.html">文档门户</a>
      <a href="quickstart.html">快速上手</a>
      <a href="cli.html">CLI 参考</a>
      <a href="settings.html">配置项</a>
    </nav>
    <div class="nav-r">
      <button class="btn mob-menu-btn" id="mob-menu-btn" type="button">目录</button>
      <button class="btn" data-open-search type="button">搜索 <span class="kbd">Ctrl K</span></button>
      <button class="btn" id="theme-btn" type="button" aria-label="Toggle color theme">☀</button>
      <a class="btn btn-solid" href="${REPO_URL}" target="_blank" rel="noreferrer">GitHub ↗</a>
    </div>
  </div>
</header>

<div class="doc-layout">
  <aside class="sidebar" id="doc-sidebar">${sidebarHtml}</aside>
  <article class="prose">
    <div class="doc-meta">
      <div class="crumb"><a href="../index.html">Tycho</a><span>/</span><a href="index.html">文档</a><span>/</span><b>${escapeHtml(spec.group)}</b></div>
      <div class="meta-r">
        <span>约 ${minutes} 分钟阅读</span>
        <a href="${editUrl}" target="_blank" rel="noreferrer">查看源码 ↗</a>
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
if (!CSS.supports('animation-timeline', 'scroll()')) {
  const bar = document.getElementById('read-progress');
  window.addEventListener('scroll', () => {
    const max = document.documentElement.scrollHeight - window.innerHeight;
    if (bar && max > 0) bar.style.transform = 'scaleX(' + Math.min(1, Math.max(0, window.scrollY / max)) + ')';
  }, { passive: true });
}
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
writeFileSync(join(OUT, 'docs', 'index.html'), renderDocsHome(), 'utf8');

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

console.log(`Built Apple/Linear website + Stripe Docs Home in ${OUT}: index.html + docs/index.html + ${DOC_PAGES.length} doc pages`);
