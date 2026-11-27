// Project files drawer: browse, filter, upload (click or drag-and-drop), preview (image
// lightbox or sandboxed HTML/SVG ArtifactFrame sheet), attach to composer, download, and delete.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AppWindow, Download, Eye, File as FileIcon, FileText, FolderOpen, Loader2, Paperclip, Search, Trash2, Upload } from 'lucide-react';
import { useMemo, useRef, useState, type ChangeEvent, type DragEvent } from 'react';
import { ArtifactFrame, ImageLightbox } from '@/components/artifact-preview';
import { Callout, Empty, Problem, Rows, Time } from '@/components/bits';
import { Badge, type BadgeTone } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Confirm, Sheet, SheetContent } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { del, messageOf, projectFileRawUrl, uploadProjectFile } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { projectFilesQuery } from '@/lib/queries';
import type { ProjectFileOrigin, ProjectFileSummary } from '@/lib/types';
import { cn } from '@/lib/utils';

type FileFilter = 'all' | 'artifact' | 'upload' | 'doc' | 'temp';

const FILTERS: { id: FileFilter; labelKey: string }[] = [
  { id: 'all', labelKey: 'proj.files.filterAll' },
  { id: 'artifact', labelKey: 'proj.files.filterArtifact' },
  { id: 'doc', labelKey: 'proj.files.filterDoc' },
  { id: 'upload', labelKey: 'proj.files.filterUpload' },
  { id: 'temp', labelKey: 'proj.files.filterTemp' },
];

export function isEphemeralProjectFile(file: ProjectFileSummary): boolean {
  // Ad-hoc chat screenshots/uploads bound to a single conversation message.
  if (file.kind === 'upload' && file.message_id !== null) return true;
  // Routine historical worker stage reports (.md/.txt) that are not visual artifacts/images.
  if (file.origin === 'worker' && file.kind === 'doc' && !file.previewable && !file.is_image) return true;
  return false;
}

export function isProjectLibraryFile(file: ProjectFileSummary): boolean {
  return !isEphemeralProjectFile(file);
}

const ORIGIN_LABEL_KEYS: Record<ProjectFileOrigin, string> = {
  owner: 'proj.files.originOwner',
  router: 'project.routerSpeaker',
  worker: 'quote.source.worker',
};

const ORIGIN_TONES: Record<ProjectFileOrigin, BadgeTone> = {
  owner: 'plain',
  router: 'running',
  worker: 'success',
};

export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) {
    const kb = bytes / 1024;
    return `${kb >= 100 ? Math.round(kb) : kb.toFixed(1).replace(/\.0$/, '')} KB`;
  }
  const mb = bytes / (1024 * 1024);
  return `${mb >= 100 ? Math.round(mb) : mb.toFixed(1).replace(/\.0$/, '')} MB`;
}

function isArtifactPreview(file: ProjectFileSummary): boolean {
  return file.previewable && (!file.is_image || /svg/i.test(file.mime));
}

function matchesFilter(file: ProjectFileSummary, filter: FileFilter): boolean {
  switch (filter) {
    case 'all':
      return isProjectLibraryFile(file);
    case 'artifact':
      return file.kind === 'artifact' || file.previewable;
    case 'upload':
      return file.kind === 'upload' && file.message_id === null;
    case 'doc':
      return file.kind === 'doc' && !isEphemeralProjectFile(file);
    case 'temp':
      return isEphemeralProjectFile(file);
  }
}

function FileThumbnail({
  projectId,
  file,
  onPreview,
  compact = false,
}: {
  projectId: string;
  file: ProjectFileSummary;
  onPreview: (file: ProjectFileSummary) => void;
  compact?: boolean;
}) {
  const { t } = useI18n();
  const sizeClass = compact ? 'size-8 rounded-md' : 'size-11 rounded-lg';
  const iconClass = compact ? 'size-4' : 'size-5';

  if (file.is_image && !isArtifactPreview(file)) {
    return (
      <button
        type="button"
        aria-label={t('proj.files.previewImageAria', { name: file.name })}
        onClick={() => onPreview(file)}
        className={cn(
          sizeClass,
          'flex-none cursor-zoom-in overflow-hidden border border-border bg-muted p-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
        )}
      >
        <img
          src={projectFileRawUrl(projectId, file.id)}
          alt={file.name}
          className="size-full object-cover"
        />
      </button>
    );
  }

  const isArtifact = isArtifactPreview(file) || file.kind === 'artifact';
  const Icon = isArtifact
    ? AppWindow
    : file.kind === 'doc'
      ? FileText
      : FileIcon;

  if (compact && isArtifactPreview(file)) {
    return (
      <button
        type="button"
        aria-label={t('proj.files.previewArtifactAria', { name: file.name })}
        onClick={() => onPreview(file)}
        className={cn(
          sizeClass,
          'flex flex-none items-center justify-center border border-border bg-muted text-brand-foreground transition-colors hover:bg-brand-soft/60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
        )}
      >
        <Icon className={iconClass} />
      </button>
    );
  }

  return (
    <span
      aria-hidden="true"
      className={cn(
        sizeClass,
        'flex flex-none items-center justify-center border border-border bg-muted',
        isArtifact ? 'text-brand-foreground' : 'text-muted-foreground',
      )}
    >
      <Icon className={iconClass} />
    </span>
  );
}

export interface ProjectFilesPanelProps {
  projectId: string;
  onAttachToComposer?: (file: ProjectFileSummary) => void;
  compact?: boolean;
}

export function ProjectFilesPanel({
  projectId,
  onAttachToComposer,
  compact = false,
}: ProjectFilesPanelProps) {
  const { t } = useI18n();
  const client = useQueryClient();
  const query = useQuery(projectFilesQuery(projectId));
  const files = query.data?.files ?? [];

  const fileInputRef = useRef<HTMLInputElement>(null);
  const dragDepthRef = useRef(0);
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [filter, setFilter] = useState<FileFilter>('all');
  const [search, setSearch] = useState('');
  const [lightboxFile, setLightboxFile] = useState<ProjectFileSummary | null>(null);
  const [artifactFile, setArtifactFile] = useState<ProjectFileSummary | null>(null);
  const [deletingFile, setDeletingFile] = useState<ProjectFileSummary | null>(null);
  const [deletingBusy, setDeletingBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [cleaningTemp, setCleaningTemp] = useState(false);

  const tempFiles = useMemo(() => files.filter(isEphemeralProjectFile), [files]);

  const visibleFiles = useMemo(() => {
    const keyword = search.trim().toLowerCase();
    return files.filter((file) => {
      if (!matchesFilter(file, filter)) return false;
      if (!keyword) return true;
      return file.name.toLowerCase().includes(keyword) || (file.summary ?? '').toLowerCase().includes(keyword);
    });
  }, [files, filter, search]);

  const filterCounts = useMemo(
    () => ({
      all: files.filter(isProjectLibraryFile).length,
      artifact: files.filter((file) => matchesFilter(file, 'artifact')).length,
      upload: files.filter((file) => matchesFilter(file, 'upload')).length,
      doc: files.filter((file) => matchesFilter(file, 'doc')).length,
      temp: tempFiles.length,
    }),
    [files, tempFiles.length],
  );

  async function clearTempFiles(): Promise<void> {
    if (cleaningTemp || tempFiles.length === 0) return;
    setCleaningTemp(true);
    setDeleteError(null);
    try {
      for (const file of tempFiles) {
        await del(`/api/projects/${encodeURIComponent(projectId)}/files/${encodeURIComponent(file.id)}`);
      }
      await client.invalidateQueries({ queryKey: projectFilesQuery(projectId).queryKey });
    } catch (err) {
      setDeleteError(messageOf(err));
    } finally {
      setCleaningTemp(false);
    }
  }

  async function handleFilesUpload(list: File[]): Promise<void> {
    if (list.length === 0 || uploading) return;
    setUploading(true);
    setUploadError(null);
    let uploadedAny = false;
    const errors: string[] = [];
    try {
      for (const file of list) {
        try {
          await uploadProjectFile(projectId, file, { kind: 'upload' });
          uploadedAny = true;
        } catch (err) {
          errors.push(t('proj.files.uploadFileError', { name: file.name, reason: messageOf(err) }));
        }
      }
      if (uploadedAny) {
        await client.invalidateQueries({ queryKey: projectFilesQuery(projectId).queryKey });
      }
      if (errors.length > 0) {
        setUploadError(errors.join(t('proj.files.errorSep')));
      }
    } finally {
      setUploading(false);
    }
  }

  function onInputChange(event: ChangeEvent<HTMLInputElement>): void {
    const selected = event.target.files ? Array.from(event.target.files) : [];
    event.target.value = '';
    void handleFilesUpload(selected);
  }

  function onDragEnter(event: DragEvent<HTMLDivElement>): void {
    event.preventDefault();
    dragDepthRef.current += 1;
    setDragging(true);
  }

  function onDragOver(event: DragEvent<HTMLDivElement>): void {
    event.preventDefault();
  }

  function onDragLeave(event: DragEvent<HTMLDivElement>): void {
    event.preventDefault();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setDragging(false);
  }

  function onDrop(event: DragEvent<HTMLDivElement>): void {
    event.preventDefault();
    dragDepthRef.current = 0;
    setDragging(false);
    const dropped = event.dataTransfer.files ? Array.from(event.dataTransfer.files) : [];
    void handleFilesUpload(dropped);
  }

  function openPreview(file: ProjectFileSummary): void {
    if (isArtifactPreview(file)) {
      setArtifactFile(file);
    } else if (file.is_image) {
      setLightboxFile(file);
    }
  }

  async function confirmDelete(): Promise<void> {
    if (!deletingFile || deletingBusy) return;
    setDeletingBusy(true);
    setDeleteError(null);
    try {
      await del(`/api/projects/${encodeURIComponent(projectId)}/files/${encodeURIComponent(deletingFile.id)}`);
      await client.invalidateQueries({ queryKey: projectFilesQuery(projectId).queryKey });
      setDeletingFile(null);
    } catch (err) {
      setDeleteError(messageOf(err));
    } finally {
      setDeletingBusy(false);
    }
  }

  const showSearch = compact ? files.length > 0 : files.length >= 5;

  return (
    <>
      <div
        data-slot="project-files-dropzone"
        onDragEnter={onDragEnter}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        className={cn(
          'flex min-h-full flex-col rounded-xl transition-colors duration-100',
          compact ? 'gap-2.5' : 'gap-4',
          dragging && (compact
            ? 'border-2 border-dashed border-primary bg-brand-soft/25 p-2'
            : 'border-2 border-dashed border-primary bg-brand-soft/25 p-3'),
        )}
      >
        {/* Upload bar */}
        <div
          className={cn(
            'flex items-center justify-between gap-2 border border-dashed border-border-strong bg-muted/40',
            compact ? 'rounded-lg px-2.5 py-2' : 'flex-wrap rounded-xl px-3.5 py-2.5',
          )}
        >
          <div className="min-w-0 truncate text-xs text-muted-foreground">
            {uploading ? (
              <span className="inline-flex items-center gap-1.5 text-foreground">
                <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                {compact ? t('proj.files.uploadingCompact') : t('proj.files.uploadingFull')}
              </span>
            ) : dragging ? (
              <span className="font-medium text-brand-foreground">
                {compact ? t('proj.files.dropCompact') : t('proj.files.dropFull')}
              </span>
            ) : (
              compact ? t('proj.files.uploadPromptCompact') : t('proj.files.uploadPromptFull')
            )}
          </div>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="sr-only"
            aria-label={t('proj.files.selectFilesAria')}
            onChange={onInputChange}
          />
          <Button
            variant="secondary"
            size="sm"
            disabled={uploading}
            className={compact ? 'min-h-7 px-2 text-xs' : undefined}
            onClick={() => fileInputRef.current?.click()}
          >
            {uploading ? <Loader2 className="size-3.5 animate-spin" aria-hidden="true" /> : <Upload className="size-3.5" aria-hidden="true" />}
            {compact ? t('proj.files.uploadBtnCompact') : t('proj.files.uploadBtnFull')}
          </Button>
        </div>

        {uploadError ? (
          <Callout tone="failed" role="alert" title={t('proj.files.uploadFailedTitle')} className={compact ? 'px-2.5 py-2' : undefined}>
            <p className="mt-1 text-xs">{uploadError}</p>
          </Callout>
        ) : null}

        {query.error ? (
          <Problem role="alert" className={compact ? 'text-xs' : undefined}>{query.error.message}</Problem>
        ) : null}

        {/* Filter bar & optional search */}
        <div className={cn('flex flex-col', compact ? 'gap-1.5' : 'gap-2')}>
          <div
            className={cn('flex flex-wrap items-center', compact ? 'gap-1' : 'gap-1.5')}
            role="group"
            aria-label={t('proj.files.filterGroupAria')}
          >
            {FILTERS.map((item) => {
              const active = filter === item.id;
              const count = filterCounts[item.id];
              if (item.id === 'temp' && count === 0 && !active) return null;
              return (
                <Button
                  key={item.id}
                  variant="secondary"
                  size="sm"
                  aria-pressed={active}
                  onClick={() => setFilter(item.id)}
                  className={cn(
                    'rounded-full',
                    compact && 'min-h-6 gap-1 px-2 py-0.5 text-2xs',
                  )}
                >
                  {t(item.labelKey)}
                  {count > 0 ? <span className="text-2xs opacity-75 tabular-nums">{count}</span> : null}
                </Button>
              );
            })}
            {filter === 'temp' && tempFiles.length > 0 ? (
              <Button
                variant="ghost"
                size="sm"
                disabled={cleaningTemp}
                onClick={() => void clearTempFiles()}
                className={cn(
                  'ml-auto text-destructive hover:text-destructive',
                  compact && 'min-h-6 px-2 py-0.5 text-2xs',
                )}
              >
                <Trash2 className="size-3" aria-hidden="true" />
                {cleaningTemp ? t('proj.files.cleaningTemp') : t('proj.files.clearAllTemp', { count: tempFiles.length })}
              </Button>
            ) : null}
          </div>

          {showSearch ? (
            <div className="relative">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-faint" aria-hidden="true" />
              <Input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder={compact ? t('proj.files.searchCompact') : t('proj.files.searchFull')}
                aria-label={t('proj.files.searchAria')}
                className={cn('pl-8 text-xs', compact && 'h-7 min-h-7 py-1')}
              />
            </div>
          ) : null}
        </div>

        {/* File list */}
        {query.isPending ? (
          <div className="flex flex-col gap-2" aria-hidden="true">
            <Skeleton className={compact ? 'h-12 w-full' : 'h-16 w-full'} />
            <Skeleton className={compact ? 'h-12 w-full' : 'h-16 w-full'} />
            <Skeleton className={compact ? 'h-12 w-full' : 'h-16 w-full'} />
          </div>
        ) : visibleFiles.length > 0 ? (
          <Rows className={compact ? 'rounded-lg' : undefined}>
            {visibleFiles.map((file) => {
              const canPreview = file.is_image || file.previewable;
              if (compact) {
                return (
                  <div key={file.id} className="group/file flex items-start gap-2 px-2.5 py-2 transition-colors hover:bg-muted/60">
                    <FileThumbnail projectId={projectId} file={file} onPreview={openPreview} compact />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        {canPreview ? (
                          <button
                            type="button"
                            onClick={() => openPreview(file)}
                            title={file.name}
                            className="min-w-0 truncate text-left text-xs font-medium text-foreground hover:text-link focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring"
                          >
                            {file.name}
                          </button>
                        ) : (
                          <span className="min-w-0 truncate text-xs font-medium text-foreground" title={file.name}>
                            {file.name}
                          </span>
                        )}
                      </div>
                      <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-2xs text-muted-foreground">
                        <Badge tone={ORIGIN_TONES[file.origin]} className="min-h-4 px-1.5 py-0 text-2xs leading-3.5">
                          {t(ORIGIN_LABEL_KEYS[file.origin])}
                        </Badge>
                        <span className="tabular-nums">{formatFileSize(file.size)}</span>
                        <span aria-hidden="true">·</span>
                        <Time at={file.created_at} />
                      </div>
                      {file.summary ? (
                        <p className="mt-0.5 line-clamp-1 text-2xs text-muted-foreground">{file.summary}</p>
                      ) : null}
                      <div className="mt-1 flex items-center gap-0.5">
                        {canPreview ? (
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label={t('proj.files.previewNamed', { name: file.name })}
                            title={t('proj.files.preview')}
                            className="size-6"
                            onClick={() => openPreview(file)}
                          >
                            <Eye className="size-3.5" aria-hidden="true" />
                          </Button>
                        ) : null}
                        {onAttachToComposer ? (
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label={t('proj.files.attachNamed', { name: file.name })}
                            title={t('proj.files.attachTooltip')}
                            className="size-6"
                            onClick={() => onAttachToComposer(file)}
                          >
                            <Paperclip className="size-3.5" aria-hidden="true" />
                          </Button>
                        ) : null}
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          className="size-6"
                          title={t('proj.files.download')}
                          asChild
                        >
                          <a
                            href={projectFileRawUrl(projectId, file.id, true)}
                            download={file.name}
                            aria-label={t('proj.files.downloadNamed', { name: file.name })}
                          >
                            <Download className="size-3.5" aria-hidden="true" />
                          </a>
                        </Button>
                        <Button
                          variant="danger"
                          size="icon-sm"
                          aria-label={t('proj.files.deleteNamed', { name: file.name })}
                          title={t('common.delete')}
                          className="ml-auto size-6"
                          onClick={() => {
                            setDeleteError(null);
                            setDeletingFile(file);
                          }}
                        >
                          <Trash2 className="size-3.5" aria-hidden="true" />
                        </Button>
                      </div>
                    </div>
                  </div>
                );
              }

              return (
                <div key={file.id} className="flex flex-col gap-2.5 px-3.5 py-3 sm:flex-row sm:items-center">
                  <div className="flex min-w-0 flex-1 items-start gap-3">
                    <FileThumbnail projectId={projectId} file={file} onPreview={openPreview} />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="min-w-0 truncate text-sm font-medium text-foreground" title={file.name}>
                          {file.name}
                        </span>
                        <Badge tone={ORIGIN_TONES[file.origin]}>{t(ORIGIN_LABEL_KEYS[file.origin])}</Badge>
                      </div>
                      <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
                        <span className="tabular-nums">{formatFileSize(file.size)}</span>
                        <span aria-hidden="true">·</span>
                        <Time at={file.created_at} />
                      </div>
                      {file.summary ? (
                        <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{file.summary}</p>
                      ) : null}
                    </div>
                  </div>
                  <div className="flex flex-none flex-wrap items-center gap-1 sm:justify-end">
                    {canPreview ? (
                      <Button variant="ghost" size="sm" onClick={() => openPreview(file)}>
                        <Eye className="size-3.5" aria-hidden="true" />
                        {t('proj.files.preview')}
                      </Button>
                    ) : null}
                    {onAttachToComposer ? (
                      <Button variant="ghost" size="sm" onClick={() => onAttachToComposer(file)}>
                        <Paperclip className="size-3.5" aria-hidden="true" />
                        {t('quote.action')}
                      </Button>
                    ) : null}
                    <Button variant="ghost" size="sm" asChild>
                      <a href={projectFileRawUrl(projectId, file.id, true)} download={file.name}>
                        <Download className="size-3.5" aria-hidden="true" />
                        {t('proj.files.download')}
                      </a>
                    </Button>
                    <Button
                      variant="danger"
                      size="sm"
                      onClick={() => {
                        setDeleteError(null);
                        setDeletingFile(file);
                      }}
                    >
                      <Trash2 className="size-3.5" aria-hidden="true" />
                      {t('common.delete')}
                    </Button>
                  </div>
                </div>
              );
            })}
          </Rows>
        ) : files.length === 0 ? (
          <Empty
            icon={<FolderOpen />}
            title={t('proj.files.emptyTitle')}
            className={compact ? 'px-4 py-6' : undefined}
          >
            {compact ? t('proj.files.emptyDescCompact') : t('proj.files.emptyDescFull')}
          </Empty>
        ) : (
          <Empty
            icon={<Search />}
            title={t('proj.files.noMatchTitle')}
            className={compact ? 'px-4 py-6' : undefined}
          >
            {t('proj.files.noMatchDesc')}
          </Empty>
        )}
      </div>

      {lightboxFile ? (
        <ImageLightbox
          src={projectFileRawUrl(projectId, lightboxFile.id)}
          alt={lightboxFile.name}
          open={true}
          onOpenChange={(next) => { if (!next) setLightboxFile(null); }}
        />
      ) : null}

      <Sheet open={artifactFile !== null} onOpenChange={(next) => { if (!next) setArtifactFile(null); }}>
        {artifactFile ? (
          <SheetContent
            title={artifactFile.name}
            className="w-[min(960px,95vw)] max-w-none"
            bodyClassName="flex flex-col p-0"
          >
            <ArtifactFrame
              projectId={projectId}
              fileId={artifactFile.id}
              title={artifactFile.name}
              mime={artifactFile.mime}
              mode="sheet"
            />
          </SheetContent>
        ) : null}
      </Sheet>

      <Confirm
        open={deletingFile !== null}
        title={t('proj.files.deleteDialogTitle')}
        description={deletingFile ? t('proj.files.deleteDialogDesc', { name: deletingFile.name }) : undefined}
        confirm={deletingBusy ? t('proj.files.deleting') : t('common.delete')}
        busy={deletingBusy}
        error={deleteError}
        onConfirm={() => void confirmDelete()}
        onCancel={() => {
          setDeletingFile(null);
          setDeleteError(null);
        }}
      />
    </>
  );
}

export interface ProjectFilesSheetProps {
  projectId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAttachToComposer?: (file: ProjectFileSummary) => void;
}

export function ProjectFilesSheet({
  projectId,
  open,
  onOpenChange,
  onAttachToComposer,
}: ProjectFilesSheetProps) {
  const { t } = useI18n();
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        title={t('project.files')}
        description={t('proj.files.sheetDesc')}
        className="w-[min(620px,95vw)] max-w-none"
        bodyClassName="flex flex-col gap-4"
      >
        <ProjectFilesPanel projectId={projectId} onAttachToComposer={onAttachToComposer} />
      </SheetContent>
    </Sheet>
  );
}
