// Rich visual previews rendered inside Markdown and drawers: full-size image lightbox,
// lazily loaded Mermaid diagrams with strict SVG sanitization, and sandboxed HTML/SVG
// artifact frames with theme synchronization and auto-height messaging.
import { AppWindow, Download, Maximize2, RefreshCw, RotateCcw, X, ZoomIn, ZoomOut } from 'lucide-react';
import { Dialog as DialogPrimitive } from 'radix-ui';
import { useCallback, useEffect, useId, useRef, useState, type PointerEvent, type ReactNode, type WheelEvent } from 'react';
import { CopyButton } from '@/components/bits';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';

type ResolvedTheme = 'light' | 'dark';

function resolveTheme(): ResolvedTheme {
  if (typeof document !== 'undefined') {
    const explicit = document.documentElement.dataset.theme;
    if (explicit === 'dark' || explicit === 'light') return explicit;
  }
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  return 'light';
}

function useResolvedTheme(): ResolvedTheme {
  const [theme, setTheme] = useState<ResolvedTheme>(resolveTheme);

  useEffect(() => {
    const sync = () => setTheme(resolveTheme());
    sync();

    const observer = typeof MutationObserver === 'function'
      ? new MutationObserver(sync)
      : null;
    observer?.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });

    const media = typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-color-scheme: dark)')
      : null;
    media?.addEventListener?.('change', sync);

    return () => {
      observer?.disconnect();
      media?.removeEventListener?.('change', sync);
    };
  }, []);

  return theme;
}

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 5;
const ZOOM_STEP = 0.25;

function clampZoom(value: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(value * 100) / 100));
}

function PanZoomLightbox({
  open,
  onOpenChange,
  title,
  slot,
  actions,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  slot: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const dragStart = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);

  useEffect(() => {
    if (open) {
      setScale(1);
      setOffset({ x: 0, y: 0 });
      setDragging(false);
    }
  }, [open]);

  function resetView() {
    setScale(1);
    setOffset({ x: 0, y: 0 });
  }

  function handleWheel(event: WheelEvent<HTMLDivElement>) {
    event.preventDefault();
    const delta = event.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP;
    setScale((prev) => clampZoom(prev + delta));
  }

  function handlePointerDown(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setDragging(true);
    dragStart.current = { x: event.clientX, y: event.clientY, ox: offset.x, oy: offset.y };
  }

  function handlePointerMove(event: PointerEvent<HTMLDivElement>) {
    if (!dragging || !dragStart.current) return;
    setOffset({
      x: dragStart.current.ox + (event.clientX - dragStart.current.x),
      y: dragStart.current.oy + (event.clientY - dragStart.current.y),
    });
  }

  function handlePointerUp(event: PointerEvent<HTMLDivElement>) {
    if (!dragging) return;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    setDragging(false);
    dragStart.current = null;
  }

  function handleDoubleClick() {
    if (scale === 1 && offset.x === 0 && offset.y === 0) {
      setScale(2);
    } else {
      resetView();
    }
  }

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-overlay data-[state=open]:animate-fade-in" />
        <DialogPrimitive.Content
          data-slot={slot}
          aria-describedby={undefined}
          className={cn(
            'fixed top-1/2 left-1/2 z-50 flex h-[92vh] w-[94vw] max-w-[94vw] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden',
            'rounded-2xl bg-raised text-sm shadow-dialog data-[state=open]:animate-rise-in',
          )}
        >
          <header className="flex flex-none flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2.5">
            <DialogPrimitive.Title className="min-w-0 truncate text-sm font-semibold">
              {title}
            </DialogPrimitive.Title>
            <div className="flex flex-none flex-wrap items-center gap-1">
              <div className="mr-1 inline-flex items-center gap-0.5 rounded-lg border border-border bg-muted/60 px-1 py-0.5 text-xs">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="size-6 min-h-0"
                  aria-label="缩小"
                  title="缩小"
                  onClick={() => setScale((prev) => clampZoom(prev - ZOOM_STEP))}
                >
                  <ZoomOut className="size-3.5" aria-hidden="true" />
                </Button>
                <span className="min-w-[44px] text-center font-mono text-2xs tabular-nums text-muted-foreground">
                  {`${Math.round(scale * 100)}%`}
                </span>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="size-6 min-h-0"
                  aria-label="放大"
                  title="放大"
                  onClick={() => setScale((prev) => clampZoom(prev + ZOOM_STEP))}
                >
                  <ZoomIn className="size-3.5" aria-hidden="true" />
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 min-h-0 px-1.5 text-2xs"
                  aria-label="重置缩放"
                  title="重置缩放与位置"
                  onClick={resetView}
                >
                  <RotateCcw className="size-3" aria-hidden="true" />
                  重置
                </Button>
              </div>
              {actions}
              <DialogPrimitive.Close asChild>
                <Button variant="ghost" size="sm" aria-label="关闭预览">
                  <X className="size-3.5" aria-hidden="true" />
                  关闭预览
                </Button>
              </DialogPrimitive.Close>
            </div>
          </header>
          <div
            onWheel={handleWheel}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerUp}
            onDoubleClick={handleDoubleClick}
            className={cn(
              'relative flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-canvas/60 p-6 select-none',
              dragging ? 'cursor-grabbing' : 'cursor-grab',
            )}
          >
            <div
              style={{
                transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})`,
                transformOrigin: 'center center',
              }}
              className={cn(!dragging && 'transition-transform duration-100 ease-out')}
            >
              {children}
            </div>
            <span className="pointer-events-none absolute right-3 bottom-2.5 rounded-md border border-border/70 bg-raised/85 px-2 py-0.5 text-2xs text-muted-foreground">
              滚轮缩放 · 拖拽平移 · 双击放大/复位
            </span>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

export interface ImageLightboxProps {
  src: string;
  alt?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ImageLightbox({ src, alt, open, onOpenChange }: ImageLightboxProps) {
  const label = alt?.trim() || '图片预览';

  return (
    <PanZoomLightbox
      open={open}
      onOpenChange={onOpenChange}
      title={label}
      slot="image-lightbox"
      actions={(
        <Button variant="ghost" size="sm" asChild>
          <a href={src} download>
            <Download className="size-3.5" aria-hidden="true" />
            下载原图
          </a>
        </Button>
      )}
    >
      <img
        src={src}
        alt={alt ?? ''}
        draggable={false}
        className="max-h-[78vh] max-w-[86vw] object-contain"
      />
    </PanZoomLightbox>
  );
}

// Mermaid's initialize/render mutate module-level state; serialize renders so multiple
// diagrams on the same page never race on theme configuration or SVG generation.
let mermaidQueue: Promise<void> = Promise.resolve();
let mermaidRenderSeq = 0;

function enqueueMermaidRender<T>(task: () => Promise<T>): Promise<T> {
  const result = mermaidQueue.then(task, task);
  mermaidQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

export interface MermaidBlockProps {
  code: string;
}

export function MermaidBlock({ code }: MermaidBlockProps) {
  const theme = useResolvedTheme();
  const baseId = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showSource, setShowSource] = useState(false);
  const [lightboxOpen, setLightboxOpen] = useState(false);

  function downloadSvg() {
    if (!svg || typeof URL === 'undefined' || typeof Blob === 'undefined') return;
    const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'diagram.svg';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  useEffect(() => {
    let cancelled = false;
    const trimmed = code.trim();
    if (!trimmed) {
      setSvg(null);
      setError('Mermaid 图表内容为空。');
      return;
    }

    const renderId = `tycho-mermaid-${baseId}-${++mermaidRenderSeq}`;
    setError(null);

    void enqueueMermaidRender(async () => {
      try {
        const mod = await import('mermaid');
        const mermaid = mod.default;
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          theme: theme === 'dark' ? 'dark' : 'default',
        });
        const rendered = await mermaid.render(renderId, trimmed);
        if (!cancelled) {
          if (rendered.svg && rendered.svg.includes('<svg')) {
            setSvg(rendered.svg);
            setError(null);
          } else {
            setSvg(null);
            setError('无法渲染 Mermaid 图表，已回退为源码显示。');
          }
        }
      } catch {
        // Mermaid may leave a detached error container in document.body on parse failure.
        if (typeof document !== 'undefined') {
          document.getElementById(`d${renderId}`)?.remove();
          document.getElementById(renderId)?.remove();
        }
        if (!cancelled) {
          setSvg(null);
          setError('无法渲染 Mermaid 图表，已回退为源码显示。');
        }
      }
    });

    return () => {
      cancelled = true;
    };
  }, [baseId, code, theme]);

  return (
    <div
      data-slot="mermaid-block"
      className="my-3 overflow-hidden rounded-xl border border-border bg-raised shadow-card"
    >
      <div className="flex items-center justify-between gap-2 border-b border-border/70 bg-muted/60 px-3 py-1.5 text-xs">
        <span className="font-medium text-muted-foreground">Mermaid 图表</span>
        <div className="flex items-center gap-1">
          {svg && !error ? (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 min-h-0 px-2 text-xs"
              onClick={() => setLightboxOpen(true)}
            >
              <Maximize2 className="size-3" aria-hidden="true" />
              全屏缩放
            </Button>
          ) : null}
          <Button
            variant="ghost"
            size="sm"
            className="h-6 min-h-0 px-2 text-xs"
            onClick={() => setShowSource((prev) => !prev)}
          >
            {showSource ? '查看图表' : '查看源码'}
          </Button>
          <CopyButton value={code} label="复制源码" />
        </div>
      </div>

      {showSource ? (
        <pre className="m-0 overflow-x-auto bg-code p-3 font-mono text-xs leading-relaxed">
          <code>{code}</code>
        </pre>
      ) : error ? (
        <div className="divide-y divide-border">
          <p className="m-0 px-3 py-2 text-xs text-muted-foreground">{error}</p>
          <pre className="m-0 overflow-x-auto bg-code p-3 font-mono text-xs leading-relaxed">
            <code>{code}</code>
          </pre>
        </div>
      ) : svg ? (
        <>
          <div
            role="button"
            tabIndex={0}
            aria-label="点击全屏缩放查看 Mermaid 图表"
            title="点击全屏缩放查看"
            onClick={() => setLightboxOpen(true)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                setLightboxOpen(true);
              }
            }}
            className="cursor-zoom-in overflow-x-auto p-4 text-center transition-colors hover:bg-muted/25"
            // Safe: mermaid.initialize uses securityLevel: 'strict' (DOMPurify-sanitized SVG).
            dangerouslySetInnerHTML={{ __html: svg }}
          />
          <PanZoomLightbox
            open={lightboxOpen}
            onOpenChange={setLightboxOpen}
            title="Mermaid 图表"
            slot="mermaid-lightbox"
            actions={(
              <Button variant="ghost" size="sm" onClick={downloadSvg}>
                <Download className="size-3.5" aria-hidden="true" />
                下载 SVG
              </Button>
            )}
          >
            <div
              className="rounded-xl bg-raised p-6 shadow-card [&_svg]:h-auto [&_svg]:max-w-none"
              // Safe: DOMPurify-sanitized SVG from mermaid securityLevel='strict'.
              dangerouslySetInnerHTML={{ __html: svg }}
            />
          </PanZoomLightbox>
        </>
      ) : (
        <div className="px-4 py-6 text-center text-xs text-muted-foreground" role="status">
          正在渲染图表…
        </div>
      )}
    </div>
  );
}

export interface ArtifactFrameProps {
  projectId: string;
  fileId: string;
  title?: string;
  mime?: string;
  /** Inline card mode vs full drawer mode */
  mode?: 'inline' | 'sheet';
}

function artifactFormatLabel(mime?: string, title?: string): 'SVG' | 'HTML' {
  if (mime && /svg/i.test(mime)) return 'SVG';
  if (title && /\.svg$/i.test(title.trim())) return 'SVG';
  return 'HTML';
}

const INLINE_MIN_HEIGHT = 220;
const INLINE_DEFAULT_HEIGHT = 360;
const INLINE_MAX_HEIGHT = 560;
const SHEET_MIN_HEIGHT = 560;
const SHEET_MAX_HEIGHT = 12000;

export function ArtifactFrame({
  projectId,
  fileId,
  title,
  mime,
  mode = 'inline',
}: ArtifactFrameProps) {
  const theme = useResolvedTheme();
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [srcTheme, setSrcTheme] = useState<ResolvedTheme>(theme);
  const [inlineHeight, setInlineHeight] = useState<number>(INLINE_DEFAULT_HEIGHT);
  const [sheetHeight, setSheetHeight] = useState<number | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);

  const previewPath = `/api/projects/${encodeURIComponent(projectId)}/files/${encodeURIComponent(fileId)}/preview`;
  const downloadPath = `/api/projects/${encodeURIComponent(projectId)}/files/${encodeURIComponent(fileId)}/raw?download=1`;
  const src = `${previewPath}?theme=${srcTheme}`;
  const displayTitle = title?.trim() || '交互式预览';
  const iframeTitle = title?.trim() || '交互式产物预览';
  const formatLabel = artifactFormatLabel(mime, title);

  const postTheme = useCallback((nextTheme: ResolvedTheme) => {
    iframeRef.current?.contentWindow?.postMessage(
      { type: 'tycho:artifact:theme', theme: nextTheme },
      '*',
    );
  }, []);

  useEffect(() => {
    postTheme(theme);
  }, [postTheme, theme]);

  useEffect(() => {
    function handleMessage(event: MessageEvent) {
      if (event.source !== iframeRef.current?.contentWindow) return;
      const payload = event.data as { type?: unknown; height?: unknown } | null;
      if (!payload || typeof payload !== 'object') return;
      if (payload.type !== 'tycho:artifact:resize') return;
      if (typeof payload.height !== 'number' || !Number.isFinite(payload.height)) return;

      const measured = Math.ceil(payload.height);
      if (mode === 'sheet') {
        setSheetHeight(Math.min(Math.max(measured, SHEET_MIN_HEIGHT), SHEET_MAX_HEIGHT));
      } else {
        setInlineHeight(Math.min(Math.max(measured, INLINE_MIN_HEIGHT), INLINE_MAX_HEIGHT));
      }
    }

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [mode]);

  function handleRefresh() {
    setSrcTheme(theme);
    setReloadKey((k) => k + 1);
  }

  if (mode === 'sheet') {
    return (
      <div data-slot="artifact-frame" className="flex min-h-0 flex-1 flex-col">
        <div className="flex flex-none items-center justify-between gap-2 border-b border-border bg-muted/60 px-4 py-2 text-xs">
          <div className="flex items-center gap-2">
            <AppWindow className="size-3.5 flex-none text-brand-foreground" aria-hidden="true" />
            <Badge tone="plain">{formatLabel}</Badge>
          </div>
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="sm" className="h-7 min-h-0 px-2 text-xs" onClick={handleRefresh}>
              <RefreshCw className="size-3.5" aria-hidden="true" />
              刷新
            </Button>
            <Button variant="ghost" size="sm" className="h-7 min-h-0 px-2 text-xs" asChild>
              <a href={downloadPath} download>
                <Download className="size-3.5" aria-hidden="true" />
                下载
              </a>
            </Button>
          </div>
        </div>
        <iframe
          key={reloadKey}
          ref={iframeRef}
          // Security invariant: never add allow-same-origin here so previewed artifacts stay opaque-origin isolated.
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          src={src}
          title={iframeTitle}
          style={sheetHeight !== null ? { height: `${sheetHeight}px` } : undefined}
          className="block min-h-[70vh] w-full flex-1 border-0 bg-background"
          onLoad={() => postTheme(theme)}
        />
      </div>
    );
  }

  return (
    <>
      <div
        data-slot="artifact-frame"
        className="my-3 overflow-hidden rounded-xl border border-border bg-raised shadow-card"
      >
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/70 bg-muted/60 px-3 py-1.5 text-xs">
          <div className="flex min-w-0 items-center gap-2">
            <AppWindow className="size-3.5 flex-none text-brand-foreground" aria-hidden="true" />
            <span className="truncate font-medium text-foreground">{displayTitle}</span>
            <Badge tone="plain">{formatLabel}</Badge>
          </div>
          <div className="flex flex-none items-center gap-1">
            <Button variant="ghost" size="sm" className="h-6 min-h-0 px-2 text-xs" onClick={handleRefresh}>
              <RefreshCw className="size-3" aria-hidden="true" />
              刷新
            </Button>
            <Button variant="ghost" size="sm" className="h-6 min-h-0 px-2 text-xs" onClick={() => setSheetOpen(true)}>
              <Maximize2 className="size-3" aria-hidden="true" />
              展开查看
            </Button>
            <Button variant="ghost" size="sm" className="h-6 min-h-0 px-2 text-xs" asChild>
              <a href={downloadPath} download>
                <Download className="size-3" aria-hidden="true" />
                下载
              </a>
            </Button>
          </div>
        </div>
        <iframe
          key={reloadKey}
          ref={iframeRef}
          // Security invariant: never add allow-same-origin here so previewed artifacts stay opaque-origin isolated.
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          src={src}
          title={iframeTitle}
          style={{ height: `${inlineHeight}px` }}
          className="block w-full border-0 bg-background"
          onLoad={() => postTheme(theme)}
        />
      </div>

      <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
        {sheetOpen ? (
          <SheetContent
            title={displayTitle}
            className="w-[min(1240px,96vw)] max-w-none"
            bodyClassName="flex flex-col p-0"
          >
            <ArtifactFrame
              projectId={projectId}
              fileId={fileId}
              title={title}
              mime={mime}
              mode="sheet"
            />
          </SheetContent>
        ) : null}
      </Sheet>
    </>
  );
}
