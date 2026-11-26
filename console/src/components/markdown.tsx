// What the Router or a Worker writes, read as GitHub-flavoured Markdown by react-markdown.
// Raw HTML in it is dropped, never rendered (no rehype-raw): it reaches the page as the
// elements Markdown itself makes and nothing else. Tables, display math and code blocks each
// scroll sideways on their own, so wide content never widens the page.
import 'katex/dist/katex.min.css';
import { QueryClientContext, useQuery } from '@tanstack/react-query';
import { Download, FileText } from 'lucide-react';
import { createContext, Fragment, isValidElement, useContext, useMemo, useState, type ComponentProps, type ReactNode } from 'react';
import ReactMarkdown, {
  defaultUrlTransform,
  type Components,
  type ExtraProps,
  type UrlTransform,
} from 'react-markdown';
import { Link, useInRouterContext } from 'react-router';
import rehypeKatex from 'rehype-katex';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import { ArtifactFrame, ImageLightbox, MermaidBlock } from '@/components/artifact-preview';
import { StatusDot } from '@/components/bits';
import { Badge } from '@/components/ui/badge';
import { projectFileRawUrl } from '@/lib/api';
import { projectFilesQuery, tasksQuery } from '@/lib/queries';
import type { ProjectFileSummary, Task } from '@/lib/types';
import { cn } from '@/lib/utils';

type HastElement = NonNullable<ExtraProps['node']>;

const REMARK_PLUGINS = [remarkGfm, remarkMath];
const REHYPE_PLUGINS = [rehypeKatex];

const SAME_ORIGIN_PROJECT_IMAGE = /^\/api\/projects\/[^/]+\/files\/[^/]+\/raw(?:\?|$)/;
const SAFE_DATA_IMAGE = /^data:image\/(?:png|jpeg|gif|webp);base64,/i;
const FILE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const TYCHO_FILE_SCHEME = 'tycho-file://';
const TASK_ULID_PATTERN = /\b([0-9A-HJKMNP-TV-Z]{26})\b/g;
const EXACT_TASK_ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const MAX_TASK_PILL_TITLE_CHARS = 24;
const EMPTY_TASK_MAP: ReadonlyMap<string, Task> = new Map();

const InsidePreContext = createContext(false);
const InsideLinkContext = createContext(false);

function truncatePillTitle(title: string): string {
  const chars = [...title];
  if (chars.length <= MAX_TASK_PILL_TITLE_CHARS) return title;
  return `${chars.slice(0, MAX_TASK_PILL_TITLE_CHARS).join('')}…`;
}

function taskPillHref(task: Task): string {
  if (task.project_id) {
    return `/projects/${encodeURIComponent(task.project_id)}?thread=${encodeURIComponent(task.id)}`;
  }
  return `/task/${encodeURIComponent(task.id)}`;
}

function InlineTaskPill({ task }: { task: Task }) {
  const inRouter = useInRouterContext();
  const to = taskPillHref(task);
  const label = truncatePillTitle(task.title || task.id);
  const className = 'mx-0.5 inline-flex max-w-full items-center gap-1 rounded-full border border-border bg-muted/80 px-2 py-0.5 align-baseline text-xs leading-4 font-medium text-foreground no-underline transition-colors duration-100 hover:border-brand-border hover:bg-brand-soft/60 hover:text-brand-foreground';
  const body = (
    <>
      <StatusDot state={task.summary?.dot ?? task.state} className="size-3" />
      <span className="truncate">{label}</span>
    </>
  );

  if (inRouter) {
    return (
      <Link to={to} data-task-pill={task.id} title={task.title || task.id} className={className}>
        {body}
      </Link>
    );
  }
  return (
    <a href={`#${to}`} data-task-pill={task.id} title={task.title || task.id} className={className}>
      {body}
    </a>
  );
}

function linkifyText(text: string, taskMap: ReadonlyMap<string, Task>): ReactNode {
  TASK_ULID_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null = null;
  let lastIndex = 0;
  let parts: ReactNode[] | null = null;

  while ((match = TASK_ULID_PATTERN.exec(text)) !== null) {
    const ulid = match[1]!;
    const task = taskMap.get(ulid);
    if (!task) continue;
    if (!parts) parts = [];
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }
    parts.push(<InlineTaskPill key={`${ulid}:${match.index}`} task={task} />);
    lastIndex = match.index + ulid.length;
  }

  if (!parts) return text;
  if (lastIndex < text.length) parts.push(text.slice(lastIndex));
  return parts;
}

function linkifyChildren(children: ReactNode, taskMap: ReadonlyMap<string, Task>): ReactNode {
  if (typeof children === 'string') return linkifyText(children, taskMap);
  if (Array.isArray(children)) {
    return children.map((child, index) => (
      typeof child === 'string'
        ? <Fragment key={index}>{linkifyText(child, taskMap)}</Fragment>
        : child
    ));
  }
  return children;
}

function TaskLinkified({
  children,
  taskMap,
}: {
  children: ReactNode;
  taskMap: ReadonlyMap<string, Task>;
}) {
  const insideLink = useContext(InsideLinkContext);
  if (insideLink || taskMap.size === 0) return <>{children}</>;
  return <>{linkifyChildren(children, taskMap)}</>;
}

function InlineCode({
  children,
  taskMap,
  ...props
}: ComponentProps<'code'> & { taskMap: ReadonlyMap<string, Task> }) {
  const insidePre = useContext(InsidePreContext);
  const insideLink = useContext(InsideLinkContext);
  if (!insidePre && !insideLink && taskMap.size > 0) {
    const raw = extractText(children).trim();
    if (EXACT_TASK_ULID_PATTERN.test(raw)) {
      const task = taskMap.get(raw);
      if (task) return <InlineTaskPill task={task} />;
    }
  }
  return <code {...props}>{children}</code>;
}

export function isSafeInlineImage(src: string | undefined): boolean {
  if (!src) return false;
  if (SAME_ORIGIN_PROJECT_IMAGE.test(src) && !/\/\.\.(?:\/|$)/.test(src)) return true;
  if (SAFE_DATA_IMAGE.test(src) || src.startsWith('blob:')) return true;
  return false;
}

const safeUrlTransform: UrlTransform = (url, key, node) => {
  if (key === 'href' && node.tagName === 'a' && url.startsWith(TYCHO_FILE_SCHEME)) {
    return url;
  }
  if (key === 'src' && node.tagName === 'img' && (SAFE_DATA_IMAGE.test(url) || url.startsWith('blob:'))) {
    return url;
  }
  return defaultUrlTransform(url);
};

function extractText(children: ReactNode): string {
  if (typeof children === 'string' || typeof children === 'number') return String(children);
  if (Array.isArray(children)) return children.map(extractText).join('');
  if (isValidElement<{ children?: ReactNode }>(children)) return extractText(children.props.children);
  return '';
}

function getMermaidSource(node: HastElement | undefined): string | null {
  if (!node || node.children.length !== 1) return null;
  const child = node.children[0];
  if (!child || child.type !== 'element' || child.tagName !== 'code') return null;
  const rawClass: unknown = child.properties?.className;
  const classes = Array.isArray(rawClass)
    ? rawClass.map(String)
    : typeof rawClass === 'string'
      ? rawClass.split(/\s+/)
      : [];
  if (!classes.includes('language-mermaid')) return null;

  let text = '';
  for (const part of child.children) {
    if (part.type === 'text') text += part.value;
  }
  return text.replace(/\n$/, '');
}

function parseTychoFileId(href: unknown): string | null {
  if (typeof href !== 'string' || !href.startsWith(TYCHO_FILE_SCHEME)) return null;
  const fileId = href.slice(TYCHO_FILE_SCHEME.length).trim();
  return FILE_ID_PATTERN.test(fileId) ? fileId : null;
}

function hasRenderableArtifactLink(node: HastElement | undefined, projectId: string | undefined): boolean {
  if (!node || !projectId) return false;
  for (const child of node.children) {
    if (child.type !== 'element') continue;
    if (child.tagName === 'a' && parseTychoFileId(child.properties?.href) !== null) {
      return true;
    }
    if (hasRenderableArtifactLink(child, projectId)) return true;
  }
  return false;
}

function InlineImage({ src, alt }: { src: string; alt?: string }) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        className="my-2 inline-block cursor-zoom-in rounded-lg border-0 bg-transparent p-0 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        aria-label={alt ? `放大查看图片：${alt}` : '放大查看图片'}
        onClick={() => setOpen(true)}
      >
        <img
          src={src}
          alt={alt ?? ''}
          className="max-h-80 max-w-full rounded-lg border border-border object-contain"
        />
      </button>
      <ImageLightbox src={src} alt={alt} open={open} onOpenChange={setOpen} />
    </>
  );
}

function isPreviewableArtifactMime(mime: string | null | undefined): boolean {
  if (!mime) return false;
  const base = mime.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  return base === 'text/html' || base === 'image/svg+xml';
}

function isRasterImageMime(mime: string | null | undefined): boolean {
  if (!mime) return false;
  const base = mime.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  return base === 'image/png' || base === 'image/jpeg' || base === 'image/gif' || base === 'image/webp';
}

function ProjectFileLinkView({
  projectId,
  fileId,
  label,
  cached,
}: {
  projectId: string;
  fileId: string;
  label: string;
  cached: ProjectFileSummary | undefined;
}) {
  if (cached && isPreviewableArtifactMime(cached.mime)) {
    return (
      <ArtifactFrame
        projectId={projectId}
        fileId={fileId}
        title={label || cached.name || undefined}
        mime={cached.mime}
        mode="inline"
      />
    );
  }

  if (cached && (cached.is_image || isRasterImageMime(cached.mime))) {
    return <InlineImage src={projectFileRawUrl(projectId, fileId)} alt={label || cached.name} />;
  }

  const displayName = label || cached?.name || fileId;
  return (
    <a
      href={projectFileRawUrl(projectId, fileId, true)}
      download={cached?.name || true}
      className="my-1 inline-flex items-center gap-1.5 rounded-lg border border-border bg-muted/50 px-2.5 py-1 text-xs font-medium text-foreground no-underline transition-colors hover:bg-muted"
    >
      <FileText className="size-3.5 flex-none text-muted-foreground" aria-hidden="true" />
      <span className="max-w-[260px] truncate">{displayName}</span>
      <Download className="size-3.5 flex-none text-muted-foreground" aria-hidden="true" />
    </a>
  );
}

function ProjectFileLinkWithQuery({
  projectId,
  fileId,
  label,
  knownFile,
}: {
  projectId: string;
  fileId: string;
  label: string;
  knownFile: ProjectFileSummary | undefined;
}) {
  const { data } = useQuery({
    ...projectFilesQuery(projectId),
    enabled: Boolean(projectId) && !knownFile,
  });
  const cached = knownFile ?? data?.files.find((file) => file.id === fileId);
  return <ProjectFileLinkView projectId={projectId} fileId={fileId} label={label} cached={cached} />;
}

function ProjectFileLink({
  projectId,
  fileId,
  label,
  files,
}: {
  projectId: string;
  fileId: string;
  label: string;
  files?: readonly ProjectFileSummary[];
}) {
  const knownFile = files?.find((file) => file.id === fileId);
  const client = useContext(QueryClientContext);
  if (client) {
    return (
      <ProjectFileLinkWithQuery
        projectId={projectId}
        fileId={fileId}
        label={label}
        knownFile={knownFile}
      />
    );
  }
  return <ProjectFileLinkView projectId={projectId} fileId={fileId} label={label} cached={knownFile} />;
}

function buildComponents(
  projectId: string | undefined,
  files: readonly ProjectFileSummary[] | undefined,
  taskMap: ReadonlyMap<string, Task>,
): Components {
  const wrapText = (children: ReactNode): ReactNode =>
    taskMap.size > 0 ? <TaskLinkified taskMap={taskMap}>{children}</TaskLinkified> : children;

  return {
    table: ({ node: _node, ...props }) => (
      <div className="prose-table" role="region" aria-label="表格" tabIndex={0}>
        <table {...props} />
      </div>
    ),
    p: ({ node, children, ...props }) => {
      const body = wrapText(children);
      if (hasRenderableArtifactLink(node, projectId)) {
        return <div className="mb-2.5" {...props}>{body}</div>;
      }
      return <p {...props}>{body}</p>;
    },
    li: ({ node: _node, children, ...props }) => <li {...props}>{wrapText(children)}</li>,
    td: ({ node: _node, children, ...props }) => <td {...props}>{wrapText(children)}</td>,
    th: ({ node: _node, children, ...props }) => <th {...props}>{wrapText(children)}</th>,
    blockquote: ({ node: _node, children, ...props }) => <blockquote {...props}>{wrapText(children)}</blockquote>,
    strong: ({ node: _node, children, ...props }) => <strong {...props}>{wrapText(children)}</strong>,
    em: ({ node: _node, children, ...props }) => <em {...props}>{wrapText(children)}</em>,
    del: ({ node: _node, children, ...props }) => <del {...props}>{wrapText(children)}</del>,
    h1: ({ node: _node, children, ...props }) => <h1 {...props}>{wrapText(children)}</h1>,
    h2: ({ node: _node, children, ...props }) => <h2 {...props}>{wrapText(children)}</h2>,
    h3: ({ node: _node, children, ...props }) => <h3 {...props}>{wrapText(children)}</h3>,
    h4: ({ node: _node, children, ...props }) => <h4 {...props}>{wrapText(children)}</h4>,
    h5: ({ node: _node, children, ...props }) => <h5 {...props}>{wrapText(children)}</h5>,
    h6: ({ node: _node, children, ...props }) => <h6 {...props}>{wrapText(children)}</h6>,
    code: ({ node: _node, children, ...props }) => (
      <InlineCode taskMap={taskMap} {...props}>{children}</InlineCode>
    ),
    pre: ({ node, children, ...props }) => {
      const mermaidSource = getMermaidSource(node);
      if (mermaidSource !== null) {
        return <MermaidBlock code={mermaidSource} />;
      }
      return (
        <InsidePreContext value={true}>
          <pre {...props}>{children}</pre>
        </InsidePreContext>
      );
    },
    a: ({ node: _node, href, children, ...props }) => {
      if (typeof href === 'string' && href.startsWith(TYCHO_FILE_SCHEME)) {
        const fileId = parseTychoFileId(href);
        const label = extractText(children).trim();
        if (projectId && fileId) {
          return <ProjectFileLink projectId={projectId} fileId={fileId} label={label} files={files} />;
        }
        return (
          <Badge tone="plain" className="align-middle">
            {label || href.slice(TYCHO_FILE_SCHEME.length).trim() || '产物'}
          </Badge>
        );
      }
      return (
        <InsideLinkContext value={true}>
          <a {...props} href={href} target="_blank" rel="noreferrer noopener">
            {children}
          </a>
        </InsideLinkContext>
      );
    },
    // Same-origin project file images, raster data:image/ and blob: render inline with lightbox;
    // external URLs stay plain links so third-party images are never auto-fetched.
    img: ({ src, alt }) => {
      if (typeof src === 'string' && isSafeInlineImage(src)) {
        return <InlineImage src={src} alt={alt} />;
      }
      return typeof src === 'string' && src
        ? <a href={src} target="_blank" rel="noreferrer noopener">{alt || src}</a>
        : <>{alt}</>;
    },
  };
}

function MarkdownView({
  text,
  className,
  projectId,
  files,
  taskMap,
}: {
  text: string | null | undefined;
  className?: string;
  projectId?: string;
  files?: readonly ProjectFileSummary[];
  taskMap: ReadonlyMap<string, Task>;
}) {
  const components = useMemo(() => buildComponents(projectId, files, taskMap), [projectId, files, taskMap]);

  return (
    <div className={cn('prose', className)}>
      <ReactMarkdown
        remarkPlugins={REMARK_PLUGINS}
        rehypePlugins={REHYPE_PLUGINS}
        components={components}
        urlTransform={safeUrlTransform}
        skipHtml
      >
        {String(text ?? '')}
      </ReactMarkdown>
    </div>
  );
}

function MarkdownWithTasks({
  text,
  className,
  projectId,
  files,
}: {
  text: string | null | undefined;
  className?: string;
  projectId?: string;
  files?: readonly ProjectFileSummary[];
}) {
  // Subscribe passively to the tasks cache populated by Shell without issuing new requests.
  const { data } = useQuery({
    ...tasksQuery,
    enabled: false,
    retry: false,
  });

  const taskMap = useMemo<ReadonlyMap<string, Task>>(() => {
    const tasks = data?.tasks ?? [];
    const children = data?.children ?? [];
    if (tasks.length === 0 && children.length === 0) return EMPTY_TASK_MAP;
    const map = new Map<string, Task>();
    for (const task of tasks) map.set(task.id, task);
    for (const child of children) map.set(child.id, child);
    return map;
  }, [data?.tasks, data?.children]);

  return <MarkdownView text={text} className={className} projectId={projectId} files={files} taskMap={taskMap} />;
}

export function Markdown({
  text,
  className,
  projectId,
  files,
}: {
  text: string | null | undefined;
  className?: string;
  projectId?: string;
  files?: readonly ProjectFileSummary[];
}) {
  const client = useContext(QueryClientContext);
  if (client) {
    return <MarkdownWithTasks text={text} className={className} projectId={projectId} files={files} />;
  }
  return <MarkdownView text={text} className={className} projectId={projectId} files={files} taskMap={EMPTY_TASK_MAP} />;
}
