// Single-Source-of-Truth generator & drift checker for docs/reference/{cli,settings}.md.
// Usage:
//   node scripts/gen-docs-reference.ts          # regenerate docs/reference/cli.md & settings.md
//   node scripts/gen-docs-reference.ts --check  # fail with exit code 1 if committed files drift
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SETTINGS, type Definition } from '../service/settings.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REF_DIR = join(ROOT, 'docs', 'reference');
const CHECK = process.argv.includes('--check');

function escapeCell(text: string): string {
  return text.replaceAll('|', '\\|').replaceAll(/\r?\n/g, ' ').trim();
}

function formatDefault(def: Definition): string {
  if (def.type === 'duration') {
    const ms = def.default;
    if (ms === 0) return '`0`';
    if (def.unit === 'hours') return `\`${ms / 3_600_000}h\` (${ms} ms)`;
    if (def.unit === 'minutes') return `\`${ms / 60_000}m\` (${ms} ms)`;
    return `\`${ms / 1_000}s\` (${ms} ms)`;
  }
  if (def.type === 'logins') {
    return def.default.length === 0 ? '`[]`（默认顺序）' : `\`${JSON.stringify(def.default)}\``;
  }
  if (typeof def.default === 'string') {
    return def.default === '' ? '`""`（留空）' : `\`${def.default}\``;
  }
  return `\`${String(def.default)}\``;
}

function formatType(def: Definition): string {
  if (def.type === 'duration') return `duration (${def.unit})`;
  if (def.type === 'choice') return `choice (${def.choices.map((c) => `\`${c}\``).join(' / ')})`;
  return def.type;
}

function generateSettingsMarkdown(): string {
  const entries = Object.entries(SETTINGS) as [string, Definition][];
  const groups = new Map<string, [string, Definition][]>();
  for (const entry of entries) {
    const list = groups.get(entry[1].group) ?? [];
    list.push(entry);
    groups.set(entry[1].group, list);
  }

  const lines: string[] = [
    '<!-- AUTO-GENERATED from service/settings.ts by scripts/gen-docs-reference.ts. Do not edit manually. -->',
    '',
    '# 配置项参考（Settings Reference）',
    '',
    'Tycho 的全部运行配置均保存在主机账本中，通过控制台 **「设置」** 页面修改，无需手工维护配置文件。',
    '本文档由 `node scripts/gen-docs-reference.ts` 直接从 [service/settings.ts](../../service/settings.ts) 生成，确保键名、类型、默认值与重启要求与代码完全一致。',
    '',
    `> 共收录 **${entries.length}** 项配置，分为 **${groups.size}** 个分组。标有「需重启」的配置修改后需重启主机服务才会生效；其余配置保存后立即生效（或在对应组件下一次启动/轮询时生效）。`,
    '',
    '## 目录',
    '',
  ];

  for (const [group, items] of groups) {
    const anchor = group.toLowerCase().replaceAll(/\s+/g, '-');
    lines.push(`- [${group}](#${anchor})（${items.length} 项）`);
  }
  lines.push('');

  for (const [group, items] of groups) {
    lines.push(`## ${group}`, '');
    lines.push('| 配置键 | 名称 | 类型 | 默认值 | 生效 | 说明 |');
    lines.push('| --- | --- | --- | --- | --- | --- |');
    for (const [key, def] of items) {
      const effect = def.restart ? '需重启服务' : '即时 / 下次生效';
      const emptyNote = def.empty ? `（留空：${def.empty}）` : '';
      lines.push(
        `| \`${key}\` | ${escapeCell(def.title)} | ${escapeCell(formatType(def))} | ${formatDefault(def)} | ${effect} | ${escapeCell(def.help + emptyNote)} |`,
      );
    }
    lines.push('');
  }

  return `${lines.join('\n')}`;
}

function extractConstTemplate(filePath: string, constName: string): string {
  const src = readFileSync(filePath, 'utf8');
  const pattern = new RegExp(`const\\s+${constName}\\s*=\\s*\`([\\s\\S]*?)\`;`);
  const match = pattern.exec(src);
  if (!match?.[1]) {
    throw new Error(`Could not extract \`const ${constName} = \`...\` from ${filePath}`);
  }
  return match[1].trim();
}

function generateCliMarkdown(): string {
  const mainHelp = extractConstTemplate(join(ROOT, 'cli', 'main.ts'), 'HELP');
  const nodeHelp = extractConstTemplate(join(ROOT, 'node', 'cli.ts'), 'NODE_HELP');

  return [
    '<!-- AUTO-GENERATED from cli/main.ts and node/cli.ts by scripts/gen-docs-reference.ts. Do not edit manually. -->',
    '',
    '# CLI 命令参考（CLI Reference）',
    '',
    '本文档由 `node scripts/gen-docs-reference.ts` 直接从 [cli/main.ts](../../cli/main.ts) 与 [node/cli.ts](../../node/cli.ts) 提取，确保命令参数与 `tycho help` / `tycho node help` 保持完全一致。',
    '',
    '## 退出码约定',
    '',
    '| 退出码 | 含义 |',
    '| --- | --- |',
    '| `0` | 执行成功 |',
    '| `1` | 运行时错误（网络、权限、锁冲突、状态不满足等） |',
    '| `2` | 命令行参数或子命令用法错误 |',
    '',
    '## 环境变量',
    '',
    '| 变量 | 作用域 | 说明 |',
    '| --- | --- | --- |',
    '| `TYCHO_DATA` | Host / Node | 指定数据目录，默认 `~/.tycho/host` |',
    '| `TYCHO_PREFIX` | 安装器 | 指定程序安装目录，默认 `~/.tycho/app` |',
    '| `TYCHO_NO_MODIFY_PATH` | 安装器 | 设为非空值时不修改用户 shell PATH |',
    '| `TYCHO_RELEASE_URL` | 安装器 / 更新 | 自定义 `tycho.tar.gz` 下载地址 |',
    '| `TYCHO_NODE_DIST_URL` | 安装器 | 自定义 Node 24 二进制镜像（校验值仍从 nodejs.org 核验） |',
    '| `TYCHO_KNOWLEDGE_TOKEN` | Knowledge MCP | `tycho knowledge-mcp` 使用的知识访问令牌 |',
    '',
    '## 主命令（`tycho help`）',
    '',
    '```text',
    mainHelp,
    '```',
    '',
    '## 执行节点子命令（`tycho node help`）',
    '',
    '```text',
    nodeHelp,
    '```',
    '',
  ].join('\n');
}

function syncFile(path: string, expected: string): boolean {
  const normalized = expected.replaceAll('\r\n', '\n');
  if (CHECK) {
    let actual = '';
    try {
      actual = readFileSync(path, 'utf8').replaceAll('\r\n', '\n');
    } catch {
      console.error(`Missing generated doc: ${path}`);
      return false;
    }
    if (actual !== normalized) {
      console.error(`Drifted generated doc: ${path} (run \`npm run docs:gen\` to update)`);
      return false;
    }
    return true;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, normalized, 'utf8');
  console.log(`Generated ${path}`);
  return true;
}

const okCli = syncFile(join(REF_DIR, 'cli.md'), generateCliMarkdown());
const okSettings = syncFile(join(REF_DIR, 'settings.md'), generateSettingsMarkdown());

if (!okCli || !okSettings) {
  process.exit(1);
}
