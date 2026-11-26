// Guards against text from the Router or a Worker reaching the page as markup (raw HTML
// in it, a script link), a table or a code block left as the characters that wrote it or
// widening the page instead of scrolling in its own box, a half-streamed fence losing its
// text, an image loaded from elsewhere, and nothing to render showing the word "null", as
// well as rich KaTeX math, Mermaid diagrams, same-origin image lightboxes, and sandboxed
// interactive artifact previews.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, expect, test, vi } from 'vitest';
import { ReportArtifact } from '@/components/report-artifact';
import { projectFilesQuery, tasksQuery } from '@/lib/queries';
import type { ProjectFileSummary, Task } from '@/lib/types';
import { isSafeInlineImage, Markdown } from './markdown.tsx';

afterEach(() => {
  vi.unstubAllGlobals();
});

function makeProjectFile(over: Partial<ProjectFileSummary> & { id: string; name: string; mime: string }): ProjectFileSummary {
  return {
    project_id: 'p1',
    size: 1024,
    kind: 'artifact',
    origin: 'router',
    summary: null,
    message_id: null,
    created_at: '2026-11-20T08:00:00Z',
    updated_at: '2026-11-20T08:00:00Z',
    previewable: over.mime === 'text/html' || over.mime === 'image/svg+xml',
    is_image: /^image\/(?:png|jpeg|gif|webp)$/.test(over.mime),
    ...over,
  };
}

function replyWithFiles(source: string | null | undefined, projectId: string, files: ProjectFileSummary[]): HTMLElement {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(projectFilesQuery(projectId).queryKey, { files });
  return render(
    <QueryClientProvider client={client}>
      <Markdown text={source} projectId={projectId} />
    </QueryClientProvider>,
  ).container.querySelector('.prose')!;
}

function reply(source: string | null | undefined, projectId?: string): HTMLElement {
  return render(<Markdown text={source} projectId={projectId} />).container.querySelector('.prose')!;
}

test('raw HTML is dropped, never rendered', () => {
  const box = reply('前 <img src=x onerror="alert(1)"> 后\n\n<script>alert(1)</script>\n\n<b>粗</b>');
  expect(box.querySelector('img, script, b')).toBeNull();
  expect(box.textContent).toContain('前');
  expect(box.textContent).toContain('后');
  expect(box.innerHTML).not.toContain('onerror');
});

test('a table is a table, in a box of its own that scrolls sideways', () => {
  const box = reply('| 文件 | 职责 |\n|---|---|\n| `all.ts` | 注册三个适配器 |\n| `codex.ts` | Codex |');
  const table = box.querySelector('table')!;
  expect(table).not.toBeNull();
  expect([...table.querySelectorAll('th')].map((cell) => cell.textContent)).toEqual(['文件', '职责']);
  expect(table.querySelectorAll('tbody tr')).toHaveLength(2);
  expect(table.querySelector('td code')?.textContent).toBe('all.ts');
  expect(table.parentElement).toHaveClass('prose-table');
  expect(table.parentElement).toHaveAttribute('role', 'region');
  expect(box.textContent).not.toContain('|---|');
});

test('code blocks keep their lines; an unclosed one runs to the end while streaming', () => {
  expect(reply('```ts\nconst a = 1;\n\nconst b = 2;\n```').querySelector('pre code')?.textContent).toBe('const a = 1;\n\nconst b = 2;\n');
  const streaming = reply('前\n```\n还在写');
  expect(streaming.querySelector('p')?.textContent).toBe('前');
  expect(streaming.querySelector('pre code')?.textContent).toBe('还在写\n');
  expect(reply('`a**b**c`').querySelector('code')?.textContent).toBe('a**b**c');
});

test('the rest of GitHub-flavoured Markdown reads as what it means', () => {
  expect(reply('# 标题').querySelector('h1')?.textContent).toBe('标题');
  expect(reply('1. 一\n2. 二').querySelectorAll('ol li')).toHaveLength(2);
  expect(reply('- 一\n* **二**').querySelector('ul li strong')?.textContent).toBe('二');
  expect(reply('~~删~~').querySelector('del')?.textContent).toBe('删');
  expect(reply('- [x] 做完').querySelector('input[type="checkbox"]')).toBeChecked();
  expect(reply('> 引用').querySelector('blockquote')?.textContent?.trim()).toBe('引用');
});

test('a link opens elsewhere and a script link goes nowhere; an image is a link, not loaded', () => {
  const link = reply('[看这里](https://example.com/a)').querySelector('a')!;
  expect(link).toHaveAttribute('href', 'https://example.com/a');
  expect(link).toHaveAttribute('rel', 'noreferrer noopener');
  expect(reply('[点](javascript:alert(1))').querySelector('a')?.getAttribute('href') ?? '').not.toMatch(/javascript/i);
  const image = reply('![图](https://example.com/x.png)');
  expect(image.querySelector('img')).toBeNull();
  expect(image.querySelector('a')).toHaveAttribute('href', 'https://example.com/x.png');
});

test('nothing to render is an empty block, not the word "null"', () => {
  for (const text of [null, undefined, '']) expect(reply(text).textContent).toBe('');
});

test('renders inline and display KaTeX math expressions', () => {
  const box = reply('质能方程 $E = mc^2$\n\n$$\na^2 + b^2 = c^2\n$$');
  const katexNodes = box.querySelectorAll('.katex');
  expect(katexNodes.length).toBeGreaterThanOrEqual(2);
  expect(box.querySelector('.katex-display')).not.toBeNull();
});

test('renders Mermaid code fence with card header and source toggle', () => {
  const box = reply('```mermaid\ngraph TD\nA-->B\n```');
  const card = box.querySelector('[data-slot="mermaid-block"]') as HTMLElement | null;
  expect(card).not.toBeNull();
  expect(within(card!).getByText('Mermaid 图表')).toBeInTheDocument();

  const toggle = within(card!).getByRole('button', { name: '查看源码' });
  fireEvent.click(toggle);

  expect(within(card!).getByRole('button', { name: '查看图表' })).toBeInTheDocument();
  expect(card!.querySelector('pre code')?.textContent).toBe('graph TD\nA-->B');
});

test('renders same-origin project image inline with lightbox while keeping external images as links', () => {
  const sameOrigin = reply('![截图](/api/projects/p1/files/f1/raw)');
  const img = sameOrigin.querySelector('img');
  expect(img).not.toBeNull();
  expect(img).toHaveAttribute('src', '/api/projects/p1/files/f1/raw');
  expect(img).toHaveAttribute('alt', '截图');

  fireEvent.click(img!.closest('button')!);
  const dialog = screen.getByRole('dialog');
  expect(within(dialog).getByRole('link', { name: '下载原图' })).toHaveAttribute('href', '/api/projects/p1/files/f1/raw');
  expect(within(dialog).getByRole('img', { name: '截图' })).toHaveAttribute('src', '/api/projects/p1/files/f1/raw');

  fireEvent.click(within(dialog).getByRole('button', { name: '关闭预览' }));
  expect(screen.queryByRole('dialog')).toBeNull();

  const external = reply('![外链](https://evil.test/x.png)');
  expect(external.querySelector('img')).toBeNull();
  const externalLink = external.querySelector('a');
  expect(externalLink).not.toBeNull();
  expect(externalLink).toHaveAttribute('href', 'https://evil.test/x.png');
});

test('renders tycho-file:// artifact links in an isolated sandboxed iframe only for previewable HTML/SVG metadata', () => {
  const box = replyWithFiles('[架构图](tycho-file://f1)', 'p1', [
    makeProjectFile({ id: 'f1', name: 'arch.svg', mime: 'image/svg+xml' }),
  ]);
  const iframe = box.querySelector('iframe');
  expect(iframe).not.toBeNull();
  expect(iframe).toHaveAttribute('sandbox', 'allow-scripts');
  expect(iframe!.getAttribute('sandbox')).not.toContain('allow-same-origin');
  expect(iframe!.getAttribute('src')).toMatch(/^\/api\/projects\/p1\/files\/f1\/preview\?theme=(light|dark)$/);
  expect(iframe).toHaveAttribute('title', '架构图');

  // Without metadata loaded, never mount an iframe blindly — render a safe download link.
  const unloaded = reply('[未知文件](tycho-file://f_unknown)', 'p1');
  expect(unloaded.querySelector('iframe')).toBeNull();
  const download = unloaded.querySelector('a');
  expect(download).toHaveAttribute('href', '/api/projects/p1/files/f_unknown/raw?download=1');

  const withoutProject = reply('[架构图](tycho-file://f1)');
  expect(withoutProject.querySelector('iframe')).toBeNull();
  expect(withoutProject.textContent).toContain('架构图');

  const invalidId = reply('[越权](tycho-file://../secret)', 'p1');
  expect(invalidId.querySelector('iframe')).toBeNull();
});

test('ArtifactFrame clamps resize messages from its own iframe and expands into a wide Sheet', () => {
  const box = replyWithFiles('[交互演示](tycho-file://demo_1)', 'p1', [
    makeProjectFile({ id: 'demo_1', name: 'demo.html', mime: 'text/html' }),
  ]);
  const iframe = box.querySelector('iframe') as HTMLIFrameElement;
  expect(iframe).not.toBeNull();

  // Unrelated message source must be ignored.
  fireEvent(window, new MessageEvent('message', {
    source: window,
    data: { type: 'tycho:artifact:resize', height: 500 },
  }));
  expect(iframe.style.height).toBe('360px');

  // Messages from the iframe's own contentWindow are accepted and clamped to [220, 560].
  fireEvent(window, new MessageEvent('message', {
    source: iframe.contentWindow,
    data: { type: 'tycho:artifact:resize', height: 900 },
  }));
  expect(iframe.style.height).toBe('560px');

  fireEvent(window, new MessageEvent('message', {
    source: iframe.contentWindow,
    data: { type: 'tycho:artifact:resize', height: 80 },
  }));
  expect(iframe.style.height).toBe('220px');

  // Expand into Sheet drawer and confirm the sheet iframe keeps the sandbox invariant
  // and clamps huge resize heights to 12000px.
  fireEvent.click(within(box).getByRole('button', { name: '展开查看' }));
  const sheet = screen.getByRole('dialog');
  const sheetIframe = sheet.querySelector('iframe') as HTMLIFrameElement;
  expect(sheetIframe).not.toBeNull();
  expect(sheetIframe).toHaveAttribute('sandbox', 'allow-scripts');
  expect(sheetIframe.getAttribute('sandbox')).not.toContain('allow-same-origin');

  fireEvent(window, new MessageEvent('message', {
    source: sheetIframe.contentWindow,
    data: { type: 'tycho:artifact:resize', height: 1e12 },
  }));
  expect(sheetIframe.style.height).toBe('12000px');

  fireEvent(window, new MessageEvent('message', {
    source: sheetIframe.contentWindow,
    data: { type: 'tycho:artifact:resize', height: 100 },
  }));
  expect(sheetIframe.style.height).toBe('560px');
});

test('allows raster data:image/ inline while blocking data:image/svg+xml', () => {
  const pngUri = 'data:image/png;base64,iVBORw0KGgo=';
  const svgUri = 'data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9YWxlcnQoMSk+PC9zdmc+';

  expect(isSafeInlineImage(pngUri)).toBe(true);
  expect(isSafeInlineImage(svgUri)).toBe(false);

  const pngBox = reply(`![像素图](${pngUri})`);
  const pngImg = pngBox.querySelector('img');
  expect(pngImg).not.toBeNull();
  expect(pngImg).toHaveAttribute('src', pngUri);

  const svgBox = reply(`![矢量图](${svgUri})`);
  expect(svgBox.querySelector('img')).toBeNull();
  expect(svgBox.querySelector('a')).toBeNull();
  expect(svgBox.textContent).toContain('矢量图');
});

test('renders cached non-previewable tycho-file:// links as inline image or download chip instead of a broken iframe', () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const files: ProjectFileSummary[] = [
    {
      id: 'doc1',
      project_id: 'p1',
      name: '配置说明.json',
      mime: 'application/json',
      size: 256,
      kind: 'doc',
      origin: 'router',
      summary: null,
      message_id: null,
      created_at: '2026-11-20T08:00:00Z',
      updated_at: '2026-11-20T08:00:00Z',
      previewable: false,
      is_image: false,
    },
    {
      id: 'img1',
      project_id: 'p1',
      name: '渲染图.png',
      mime: 'image/png',
      size: 1024,
      kind: 'upload',
      origin: 'owner',
      summary: null,
      message_id: null,
      created_at: '2026-11-20T08:00:00Z',
      updated_at: '2026-11-20T08:00:00Z',
      previewable: false,
      is_image: true,
    },
  ];
  client.setQueryData(projectFilesQuery('p1').queryKey, { files });

  const { container } = render(
    <QueryClientProvider client={client}>
      <Markdown
        projectId="p1"
        text={'下载 [配置文件](tycho-file://doc1)\n\n查看 [图片](tycho-file://img1)'}
      />
    </QueryClientProvider>,
  );

  expect(container.querySelector('iframe')).toBeNull();
  const downloadLink = container.querySelector('a[download="配置说明.json"]');
  expect(downloadLink).not.toBeNull();
  expect(downloadLink).toHaveAttribute('href', '/api/projects/p1/files/doc1/raw?download=1');
  expect(downloadLink!.textContent).toContain('配置文件');

  const inlineImg = container.querySelector('img');
  expect(inlineImg).not.toBeNull();
  expect(inlineImg).toHaveAttribute('src', '/api/projects/p1/files/img1/raw');
  expect(inlineImg).toHaveAttribute('alt', '图片');
});

test('ProjectFileLink reacts when projectFilesQuery resolves and never mounts iframe for PDF', async () => {
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
    const url = String(input);
    if (url === '/api/projects/p1/files') {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          files: [
            makeProjectFile({ id: 'live_html', name: 'panel.html', mime: 'text/html' }),
            makeProjectFile({ id: 'live_pdf', name: 'spec.pdf', mime: 'application/pdf', kind: 'doc', previewable: false }),
          ],
        }),
      };
    }
    throw new Error(`unexpected fetch: ${url}`);
  }));

  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const { container } = render(
    <QueryClientProvider client={client}>
      <Markdown
        projectId="p1"
        text={'[面板](tycho-file://live_html)\n\n[文档](tycho-file://live_pdf)'}
      />
    </QueryClientProvider>,
  );

  // Before metadata resolves, no iframe is mounted.
  expect(container.querySelector('iframe')).toBeNull();

  // After reactive query resolves, HTML upgrades to sandboxed iframe while PDF stays a download link.
  await waitFor(() => {
    const iframes = container.querySelectorAll('iframe');
    expect(iframes).toHaveLength(1);
    expect(iframes[0]).toHaveAttribute('title', '面板');
  });
  const pdfLink = container.querySelector('a[download="spec.pdf"]');
  expect(pdfLink).not.toBeNull();
  expect(pdfLink).toHaveAttribute('href', '/api/projects/p1/files/live_pdf/raw?download=1');
});

test('ReportArtifact forwards projectId to Markdown so tycho-file:// links resolve inside report sheet', async () => {
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
    const url = String(input);
    if (url === '/api/runs/r1/report?ref=report.md') {
      return {
        ok: true,
        status: 200,
        json: async () => ({ source: 'registered', text: '查看 [报告图](tycho-file://rep_html)' }),
      };
    }
    if (url === '/api/projects/p1/files') {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          files: [makeProjectFile({ id: 'rep_html', name: 'chart.html', mime: 'text/html' })],
        }),
      };
    }
    throw new Error(`unexpected fetch: ${url}`);
  }));

  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ReportArtifact
        runId="r1"
        projectId="p1"
        report={{ kind: 'file', ref: 'report.md', name: 'report.md' }}
      />
    </QueryClientProvider>,
  );

  fireEvent.click(screen.getByRole('button', { name: '查看报告 report.md' }));
  const sheet = await screen.findByRole('dialog');
  await waitFor(() => {
    const iframe = sheet.querySelector('iframe');
    expect(iframe).not.toBeNull();
    expect(iframe).toHaveAttribute('title', '报告图');
  });
});

test('transforms known 26-char task ULIDs in prose and inline code into clickable readable task pills without mangling unknown tokens or code blocks', () => {
  const knownProjectTaskId = '01M88Z38TSA2BK1D7688AWPJXH';
  const knownChildTaskId = '01M88Z38TSA2BK1D7688AWPJXK';
  const unknownUlid = '01M88Z38TSA2BK1D7688AWPJZZ';
  const longTitle = '这是一个超过二十四个字符长度的开发任务标题应该被优雅截断显示';

  const tasks: Task[] = [
    {
      id: knownProjectTaskId,
      project_id: 'p1',
      title: longTitle,
      state: 'running',
      source: null,
      source_state: null,
      source_label: null,
      summary: { dot: 'running', text: '', counts: {}, leaf: true },
    },
  ];
  const children: Task[] = [
    {
      id: knownChildTaskId,
      project_id: null,
      title: '无项目子任务',
      state: 'ready',
      source: null,
      source_state: null,
      source_label: null,
      summary: { dot: 'ready', text: '', counts: {}, leaf: true },
    },
  ];

  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(tasksQuery.queryKey, { tasks, children });

  const { container } = render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <Markdown
          text={[
            `目前开发任务（${knownProjectTaskId}）正在运行中，子任务 \`${knownChildTaskId}\` 待验收，无关令牌 ${unknownUlid} 保持原样。`,
            '',
            '```',
            knownProjectTaskId,
            '```',
          ].join('\n')}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );

  const projectPill = container.querySelector(`a[data-task-pill="${knownProjectTaskId}"]`);
  expect(projectPill).not.toBeNull();
  expect(projectPill).toHaveAttribute('href', `/projects/p1?thread=${knownProjectTaskId}`);
  expect(projectPill).toHaveAttribute('title', longTitle);
  expect(projectPill!.textContent).toBe(`${[...longTitle].slice(0, 24).join('')}…`);
  expect(projectPill!.querySelector('svg[data-state="running"]')).not.toBeNull();

  const childPill = container.querySelector(`a[data-task-pill="${knownChildTaskId}"]`);
  expect(childPill).not.toBeNull();
  expect(childPill).toHaveAttribute('href', `/task/${knownChildTaskId}`);
  expect(childPill!.textContent).toBe('无项目子任务');

  // Unknown 26-char token stays plain text, and fenced code block is never converted.
  expect(container.querySelector(`a[data-task-pill="${unknownUlid}"]`)).toBeNull();
  expect(container.textContent).toContain(unknownUlid);
  expect(container.querySelector('pre code')?.textContent?.trim()).toBe(knownProjectTaskId);
  expect(container.querySelector('pre a')).toBeNull();

  // Outside QueryClientProvider, Markdown still renders cleanly without crashing.
  const bare = reply(`任务 ${knownProjectTaskId} 原样渲染`);
  expect(bare.querySelector('[data-task-pill]')).toBeNull();
  expect(bare.textContent).toContain(knownProjectTaskId);
});
