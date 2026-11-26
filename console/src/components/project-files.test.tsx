import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, expect, test, vi } from 'vitest';
import { App } from '@/app';
import { ItemView } from '@/components/conversation';
import { formatFileSize, ProjectFilesSheet } from '@/components/project-files';
import { uploadProjectFile } from '@/lib/api';
import { createLive } from '@/lib/live';
import type { Message, ProjectFileSummary } from '@/lib/types';
import { deferred, FakeEventSource, IDLE_STATE, P1_CONVERSATION } from '@/test/harness';

function makeFile(overrides: Partial<ProjectFileSummary> & { id: string; name: string }): ProjectFileSummary {
  return {
    project_id: 'p1',
    mime: 'application/octet-stream',
    size: 1024,
    kind: 'upload',
    origin: 'owner',
    summary: null,
    message_id: null,
    created_at: '2026-11-20T08:00:00Z',
    updated_at: '2026-11-20T08:00:00Z',
    previewable: false,
    is_image: false,
    ...overrides,
  };
}

function makeQueryClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

test('formatFileSize formats bytes, KB and MB cleanly', () => {
  expect(formatFileSize(0)).toBe('0 B');
  expect(formatFileSize(512)).toBe('512 B');
  expect(formatFileSize(1536)).toBe('1.5 KB');
  expect(formatFileSize(2048)).toBe('2 KB');
  expect(formatFileSize(2_621_440)).toBe('2.5 MB');
});

test('ProjectFilesSheet lists files with origin badges, filters, uploads with X-File-Name, attaches, previews sandboxed artifact, and deletes via Confirm', async () => {
  const user = userEvent.setup();
  let files: ProjectFileSummary[] = [
    makeFile({
      id: 'f-img',
      name: '首页截图.png',
      mime: 'image/png',
      size: 2048,
      kind: 'upload',
      origin: 'owner',
      is_image: true,
      summary: '设计稿参考',
    }),
    makeFile({
      id: 'f-art',
      name: '架构演示.html',
      mime: 'text/html',
      size: 4096,
      kind: 'artifact',
      origin: 'worker',
      previewable: true,
      summary: '交互式系统拓扑',
    }),
    makeFile({
      id: 'f-doc',
      name: '方案说明.md',
      mime: 'text/markdown',
      size: 512,
      kind: 'doc',
      origin: 'router',
    }),
  ];

  const requests: { url: string; method: string; headers?: Record<string, string>; body?: BodyInit | null }[] = [];

  vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const headers = init?.headers && !(init.headers instanceof Headers) && !Array.isArray(init.headers)
      ? (init.headers as Record<string, string>)
      : undefined;
    requests.push({ url, method, headers, body: init?.body });

    if (method === 'GET' && url === '/api/projects/p1/files') {
      return { ok: true, status: 200, json: async () => ({ files }) };
    }
    if (method === 'POST' && url === '/api/projects/p1/files') {
      const uploaded = makeFile({
        id: 'f-new',
        name: decodeURIComponent(headers?.['X-File-Name'] ?? 'uploaded.txt'),
        mime: headers?.['X-File-Mime'] ?? headers?.['Content-Type'] ?? 'text/plain',
        size: 12,
        kind: 'upload',
        origin: 'owner',
      });
      files = [uploaded, ...files];
      return { ok: true, status: 201, json: async () => ({ file: uploaded }) };
    }
    if (method === 'DELETE' && url === '/api/projects/p1/files/f-doc') {
      files = files.filter((file) => file.id !== 'f-doc');
      return { ok: true, status: 200, json: async () => ({ deleted: true }) };
    }
    return { ok: false, status: 404, json: async () => ({ error: `unexpected ${method} ${url}` }) };
  }));

  const onAttach = vi.fn();
  const client = makeQueryClient();

  render(
    <QueryClientProvider client={client}>
      <ProjectFilesSheet
        projectId="p1"
        open={true}
        onOpenChange={() => {}}
        onAttachToComposer={onAttach}
      />
    </QueryClientProvider>,
  );

  // Lists files with origin badges
  expect(await screen.findByText('首页截图.png')).toBeInTheDocument();
  expect(screen.getByText('架构演示.html')).toBeInTheDocument();
  expect(screen.getByText('方案说明.md')).toBeInTheDocument();
  expect(screen.getByText('主人')).toBeInTheDocument();
  expect(screen.getByText('执行者')).toBeInTheDocument();
  expect(screen.getByText('负责人')).toBeInTheDocument();
  expect(screen.getByText('交互式系统拓扑')).toBeInTheDocument();

  // Filter by 交互产物
  await user.click(screen.getByRole('button', { name: /交互产物/ }));
  expect(screen.getByText('架构演示.html')).toBeInTheDocument();
  expect(screen.queryByText('首页截图.png')).toBeNull();
  expect(screen.queryByText('方案说明.md')).toBeNull();

  // Filter by 上传附件
  await user.click(screen.getByRole('button', { name: /上传附件/ }));
  expect(screen.getByText('首页截图.png')).toBeInTheDocument();
  expect(screen.queryByText('架构演示.html')).toBeNull();

  // Back to 项目资料 (default curated library view)
  await user.click(screen.getByRole('button', { name: /项目资料/ }));
  expect(screen.getByText('架构演示.html')).toBeInTheDocument();

  // Upload a file via POST /api/projects/p1/files with encoded X-File-Name
  const fileInput = screen.getByLabelText('选择要上传的文件') as HTMLInputElement;
  const uploadFile = new File(['hello world!'], '测试报告.txt', { type: 'text/plain' });
  await user.upload(fileInput, uploadFile);

  await waitFor(() => expect(screen.getByText('测试报告.txt')).toBeInTheDocument());
  const postCall = requests.find((req) => req.method === 'POST' && req.url === '/api/projects/p1/files');
  expect(postCall).toBeDefined();
  expect(postCall!.headers?.['X-File-Name']).toBe(encodeURIComponent('测试报告.txt'));
  expect(postCall!.headers?.['Content-Type']).toBe('application/octet-stream');
  expect(postCall!.headers?.['X-File-Mime']).toBe('text/plain');

  // Click 引用 callback on 首页截图.png
  const imgRow = screen.getByText('首页截图.png').closest('.flex.flex-col') as HTMLElement;
  await user.click(within(imgRow).getByRole('button', { name: '引用' }));
  expect(onAttach).toHaveBeenCalledTimes(1);
  expect(onAttach).toHaveBeenCalledWith(expect.objectContaining({ id: 'f-img', name: '首页截图.png' }));

  // Open ArtifactFrame preview for 架构演示.html and verify sandbox invariant
  const artRow = screen.getByText('架构演示.html').closest('.flex.flex-col') as HTMLElement;
  await user.click(within(artRow).getByRole('button', { name: '预览' }));
  const dialogs = await screen.findAllByRole('dialog');
  const previewDialog = dialogs.find((dialog) => dialog.querySelector('iframe') !== null);
  expect(previewDialog).toBeDefined();
  const iframe = previewDialog!.querySelector('iframe')!;
  expect(iframe).toHaveAttribute('sandbox', 'allow-scripts');
  expect(iframe.getAttribute('sandbox')).not.toContain('allow-same-origin');
  expect(iframe.getAttribute('src')).toMatch(/^\/api\/projects\/p1\/files\/f-art\/preview\?theme=(light|dark)$/);

  // Close the artifact preview sheet
  await user.click(within(previewDialog!).getByRole('button', { name: '关闭' }));
  await waitFor(() => {
    expect(document.querySelector('iframe')).toBeNull();
  });

  // Delete 方案说明.md via confirmation dialog
  const docRow = screen.getByText('方案说明.md').closest('.flex.flex-col') as HTMLElement;
  await user.click(within(docRow).getByRole('button', { name: '删除' }));
  const confirmDialog = await screen.findByRole('alertdialog');
  expect(confirmDialog).toHaveTextContent('方案说明.md');
  await user.click(within(confirmDialog).getByRole('button', { name: '删除' }));

  await waitFor(() => expect(screen.queryByText('方案说明.md')).toBeNull());
  expect(requests.some((req) => req.method === 'DELETE' && req.url === '/api/projects/p1/files/f-doc')).toBe(true);
});

test('Conversation ItemView renders mine image thumbnail with lightbox, file chip, and reply tycho-file:// artifact iframe without duplicating cited attachments', async () => {
  const user = userEvent.setup();
  const imageAttachment = makeFile({
    id: 'img1',
    name: '报错截图.png',
    mime: 'image/png',
    size: 3072,
    is_image: true,
  });
  const docAttachment = makeFile({
    id: 'pdf1',
    name: '接口规范.pdf',
    mime: 'application/pdf',
    size: 51200,
    kind: 'doc',
  });
  const citedArtifact = makeFile({
    id: 'art1',
    name: '性能面板.html',
    mime: 'text/html',
    size: 8192,
    kind: 'artifact',
    origin: 'router',
    previewable: true,
  });
  const extraArtifact = makeFile({
    id: 'art2',
    name: '依赖图.svg',
    mime: 'image/svg+xml',
    size: 2048,
    kind: 'artifact',
    origin: 'worker',
    previewable: true,
  });

  render(
    <MemoryRouter>
      <div>
        <ItemView
          projectId="p1"
          item={{
            key: 'in:m1',
            kind: 'mine',
            text: '帮我看看这个报错',
            attachments: [imageAttachment, docAttachment],
          }}
        />
        <ItemView
          projectId="p1"
          item={{
            key: 'out:r1',
            kind: 'reply',
            id: 'r1',
            text: '已生成可视化面板：[性能面板](tycho-file://art1)',
            attachments: [citedArtifact, extraArtifact],
            incomplete: false,
          }}
        />
      </div>
    </MemoryRouter>,
  );

  // Mine image thumbnail + clickable lightbox
  const thumb = screen.getByAltText('报错截图.png');
  expect(thumb).toHaveAttribute('src', '/api/projects/p1/files/img1/raw');
  await user.click(thumb.closest('button')!);
  const lightbox = await screen.findByRole('dialog');
  expect(within(lightbox).getByRole('img', { name: '报错截图.png' })).toHaveAttribute('src', '/api/projects/p1/files/img1/raw');
  await user.click(within(lightbox).getByRole('button', { name: '关闭预览' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

  // Mine file chip + download link
  expect(screen.getByText('接口规范.pdf')).toBeInTheDocument();
  expect(screen.getByText('50 KB')).toBeInTheDocument();
  expect(screen.getByRole('link', { name: '下载 接口规范.pdf' })).toHaveAttribute('href', '/api/projects/p1/files/pdf1/raw?download=1');

  // Reply renders tycho-file://art1 via Markdown AND non-cited art2 via ReplyAttachments, without duplicating art1
  const iframes = Array.from(document.querySelectorAll('iframe'));
  expect(iframes).toHaveLength(2);
  const srcs = iframes.map((frame) => frame.getAttribute('src') ?? '');
  expect(srcs.filter((src) => src.includes('/files/art1/preview'))).toHaveLength(1);
  expect(srcs.filter((src) => src.includes('/files/art2/preview'))).toHaveLength(1);
  for (const frame of iframes) {
    expect(frame).toHaveAttribute('sandbox', 'allow-scripts');
    expect(frame.getAttribute('sandbox')).not.toContain('allow-same-origin');
  }
});

test('createLive manages per-project attachment drafts, sends empty-text attachment messages, and restores attachments on failure', async () => {
  let failSend = false;
  const postedBodies: unknown[] = [];

  vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (method === 'POST' && url === '/api/messages') {
      postedBodies.push(JSON.parse(String(init?.body ?? '{}')));
      if (failSend) {
        return { ok: false, status: 503, json: async () => ({ error: '账本不可用' }) };
      }
      return { ok: true, status: 200, json: async () => ({ id: 'msg-1' }) };
    }
    return { ok: true, status: 200, json: async () => ({ messages: [] }) };
  }));

  const client = makeQueryClient();
  const live = createLive({ client });
  live.focusOn({ project: 'p1', segment: 's1' });

  const f1 = makeFile({ id: 'f1', project_id: 'p1', name: 'a.png', is_image: true, mime: 'image/png' });
  const f2 = makeFile({ id: 'f2', project_id: 'p2', name: 'b.pdf', mime: 'application/pdf' });

  live.addAttachment(f1);
  live.addAttachment(f1); // deduped
  expect(live.getState().attachments).toHaveLength(1);

  // Per-project draft isolation
  live.focusOn({ project: 'p2', segment: 's2' });
  expect(live.getState().attachments).toEqual([]);
  live.addAttachment(f2);
  expect(live.getState().attachments.map((f) => f.id)).toEqual(['f2']);

  live.focusOn({ project: 'p1', segment: 's1' });
  expect(live.getState().attachments.map((f) => f.id)).toEqual(['f1']);

  // Failure preserves attachments
  failSend = true;
  expect(await live.send()).toBe(false);
  expect(live.getState().attachments.map((f) => f.id)).toEqual(['f1']);
  expect(live.getState().refused).toBe('账本不可用');

  // Success sends attachment_ids even with empty text and clears draft attachments
  failSend = false;
  expect(await live.send()).toBe(true);
  expect(postedBodies.at(-1)).toEqual({ text: '', project_id: 'p1', attachment_ids: ['f1'] });
  expect(live.getState().attachments).toEqual([]);

  // Removing attachment works
  live.addAttachment(f1);
  live.removeAttachment('f1');
  expect(live.getState().attachments).toEqual([]);
});

test('ProjectPage opens ProjectFilesSheet from header button, attaches to Composer, supports image paste upload, and sends attachment_ids', async () => {
  const user = userEvent.setup();
  const initialFile = makeFile({
    id: 'f-existing',
    name: '已有设计图.png',
    mime: 'image/png',
    size: 4096,
    is_image: true,
  });
  let files: ProjectFileSummary[] = [initialFile];
  const sentMessages: unknown[] = [];

  vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const headers = init?.headers && !(init.headers instanceof Headers) && !Array.isArray(init.headers)
      ? (init.headers as Record<string, string>)
      : undefined;

    if (method === 'GET' && url === '/api/summary') return { ok: true, status: 200, json: async () => ({ since: '2026-11-20T00:00:00Z', delivered: 0, running: 0, waiting: 0 }) };
    if (method === 'GET' && url === '/api/state') return { ok: true, status: 200, json: async () => IDLE_STATE };
    if (method === 'GET' && url === '/api/tasks?top=1') return { ok: true, status: 200, json: async () => ({ tasks: [], children: [] }) };
    if (method === 'GET' && url === '/api/approvals') return { ok: true, status: 200, json: async () => ({ approvals: [] }) };
    if (method === 'GET' && url === '/api/projects') return { ok: true, status: 200, json: async () => ({ projects: [] }) };
    if (method === 'GET' && url === '/api/projects/p1/conversation') return { ok: true, status: 200, json: async () => P1_CONVERSATION };
    if (method === 'GET' && url === '/api/messages?segment=s1&limit=50') return { ok: true, status: 200, json: async () => ({ messages: [] }) };
    if (method === 'GET' && url === '/api/projects/p1/files') return { ok: true, status: 200, json: async () => ({ files }) };
    if (method === 'POST' && url === '/api/projects/p1/files') {
      const pasted = makeFile({
        id: 'f-pasted',
        name: decodeURIComponent(headers?.['X-File-Name'] ?? 'paste.png'),
        mime: headers?.['X-File-Mime'] ?? headers?.['Content-Type'] ?? 'image/png',
        size: 100,
        is_image: true,
      });
      files = [pasted, ...files];
      return { ok: true, status: 201, json: async () => ({ file: pasted }) };
    }
    if (method === 'POST' && url === '/api/messages') {
      sentMessages.push(JSON.parse(String(init?.body ?? '{}')));
      return { ok: true, status: 200, json: async () => ({ id: 'm-sent' }) };
    }
    return { ok: false, status: 404, json: async () => ({ error: `unexpected ${method} ${url}` }) };
  }));

  window.location.hash = '#/projects/p1';
  render(<App />);

  // Header shows 项目文件 button with count pill
  const filesButton = await screen.findByRole('button', { name: /项目文件/ });
  await waitFor(() => expect(filesButton).toHaveTextContent('1'));

  // Open drawer and attach existing file to composer
  await user.click(filesButton);
  const sheet = await screen.findByRole('dialog');
  expect(within(sheet).getByText('已有设计图.png')).toBeInTheDocument();
  await user.click(within(sheet).getByRole('button', { name: '引用' }));

  // Drawer closes and attachment strip shows in composer
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(screen.getByRole('button', { name: '移除附件 已有设计图.png' })).toBeInTheDocument();

  // Paste an image into composer textarea
  const textarea = screen.getByRole('textbox', { name: '给负责人发消息' });
  const pastedFile = new File(['pngdata'], 'clip.png', { type: 'image/png' });
  fireEvent.paste(textarea, {
    clipboardData: {
      items: [{ kind: 'file', getAsFile: () => pastedFile }],
      files: [pastedFile],
      getData: () => '',
    },
  });

  await waitFor(() => expect(screen.getByRole('button', { name: '移除附件 clip.png' })).toBeInTheDocument());

  // Remove the first attachment, then send attachment-only message
  await user.click(screen.getByRole('button', { name: '移除附件 已有设计图.png' }));
  expect(screen.queryByRole('button', { name: '移除附件 已有设计图.png' })).toBeNull();

  await user.click(screen.getByRole('button', { name: '发送' }));
  await waitFor(() => expect(sentMessages).toEqual([
    { text: '', project_id: 'p1', attachment_ids: ['f-pasted'] },
  ]));
});

test('uploadProjectFile always sends application/octet-stream with X-File-Mime and encoded X-File-Name even for JSON files', async () => {
  const captured: { url: string; method?: string; headers?: Record<string, string> }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init?: RequestInit) => {
    const headers = init?.headers && !(init.headers instanceof Headers) && !Array.isArray(init.headers)
      ? (init.headers as Record<string, string>)
      : undefined;
    captured.push({ url: String(input), method: init?.method, headers });
    return {
      ok: true,
      status: 201,
      json: async () => ({ file: makeFile({ id: 'f-json', name: '配置.json', mime: 'application/json' }) }),
    };
  }));

  const jsonFile = new File(['{"a":1}'], '配置.json', { type: 'application/json' });
  await uploadProjectFile('p1', jsonFile);

  const untypedFile = new File(['rawbytes'], 'blob.bin', { type: '' });
  await uploadProjectFile('p1', untypedFile);

  expect(captured).toHaveLength(2);
  expect(captured[0]).toMatchObject({
    url: '/api/projects/p1/files',
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      'X-File-Name': encodeURIComponent('配置.json'),
      'X-File-Mime': 'application/json',
    },
  });
  expect(captured[1]!.headers?.['Content-Type']).toBe('application/octet-stream');
  expect(captured[1]!.headers?.['X-File-Name']).toBe(encodeURIComponent('blob.bin'));
  expect(captured[1]!.headers).not.toHaveProperty('X-File-Mime');
});

test('createLive routes late addAttachment to its own project draft without polluting another focused project', () => {
  const client = makeQueryClient();
  const live = createLive({ client });

  live.focusOn({ project: 'p1', segment: 's1' });
  const f1 = makeFile({ id: 'f-p1-a', project_id: 'p1', name: 'a.png', is_image: true, mime: 'image/png' });
  live.addAttachment(f1);

  // Switch focus to project B while project A still has an upload completing.
  live.focusOn({ project: 'p2', segment: 's2' });
  const fLate = makeFile({ id: 'f-p1-late', project_id: 'p1', name: 'late.png', is_image: true, mime: 'image/png' });
  live.addAttachment(fLate);

  // Project B's draft must stay completely clean.
  expect(live.getState().attachments).toEqual([]);

  // Switching back to project A reveals both attachments intact.
  live.focusOn({ project: 'p1', segment: 's1' });
  expect(live.getState().attachments.map((f) => f.id)).toEqual(['f-p1-a', 'f-p1-late']);
});

test('createLive preserves existing message attachments across unhydrated SSE status updates and scopes optimistic matching', async () => {
  const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
  const f1 = makeFile({ id: 'f-att', project_id: 'p1', name: '设计图.png', is_image: true, mime: 'image/png' });
  const sendAnswer = deferred<{ id: string }>();

  vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (method === 'GET' && url === '/api/summary') {
      return { ok: true, status: 200, json: async () => ({ delivered: 0, running: 0, waiting: 0 }) };
    }
    if (method === 'GET' && url === '/api/messages?segment=s1&limit=50') {
      const initialRow: Message = {
        id: 'm-old',
        direction: 'in',
        channel: 'console',
        external_id: 'x-old',
        text: '相同文本',
        state: 'received',
        project_id: 'p1',
        segment_id: 's1',
        attachments: [f1],
      };
      return { ok: true, status: 200, json: async () => ({ messages: [initialRow] }) };
    }
    if (method === 'POST' && url === '/api/messages') {
      const body = await sendAnswer.promise;
      return { ok: true, status: 200, json: async () => body };
    }
    if (method === 'GET' && url.endsWith('/changes')) {
      return { ok: true, status: 200, json: async () => ({ changes: [], tasks: [] }) };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  }));

  let stream!: FakeEventSource;
  const client = makeQueryClient();
  const live = createLive({
    client,
    open: (url) => {
      stream = new FakeEventSource(url);
      return stream;
    },
  });

  live.focusOn({ project: 'p1', segment: 's1' });
  live.start();
  await tick();
  await tick();

  // Initial snapshot loaded with attachment on m-old.
  expect(live.getState().messages.get('m-old')?.attachments?.map((a) => a.id)).toEqual(['f-att']);

  // Start sending a new message with the SAME text and attachment on p1.
  live.type('相同文本');
  live.addAttachment(f1);
  const pending = live.send();
  expect(live.getState().sending).toBe('相同文本');

  // Unhydrated status update (`processing`, attachments omitted) for existing m-old:
  // 1) Must preserve m-old's attachments;
  // 2) Must NOT reconcile the newly sent optimistic bubble!
  stream.emit('message', {
    id: 'm-old',
    direction: 'in',
    channel: 'console',
    external_id: 'x-old',
    text: '相同文本',
    state: 'processing',
    project_id: 'p1',
    segment_id: 's1',
  } satisfies Message);

  expect(live.getState().messages.get('m-old')?.state).toBe('processing');
  expect(live.getState().messages.get('m-old')?.attachments?.map((a) => a.id)).toEqual(['f-att']);
  expect(live.getState().sending).toBe('相同文本');

  // A new message from ANOTHER project with the same text must NOT reconcile p1's send.
  stream.emit('message', {
    id: 'm-other-proj',
    direction: 'in',
    channel: 'console',
    external_id: 'x-other',
    text: '相同文本',
    state: 'received',
    project_id: 'p2',
    segment_id: 's2',
    attachments: [f1],
  } satisfies Message);
  expect(live.getState().sending).toBe('相同文本');

  // The real new row on p1 with matching attachment reconciles the optimistic bubble.
  stream.emit('message', {
    id: 'm-new',
    direction: 'in',
    channel: 'console',
    external_id: 'x-new',
    text: '相同文本',
    state: 'received',
    project_id: 'p1',
    segment_id: 's1',
    attachments: [f1],
  } satisfies Message);
  expect(live.getState().sending).toBeNull();

  sendAnswer.resolve({ id: 'm-new' });
  expect(await pending).toBe(true);
  live.stop();
});
