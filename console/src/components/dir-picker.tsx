// Remote directory browser & lightweight folder manager (browse + read-only file context +
// create folder + rename folder) backed by the online machine's Node channel.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Check, ChevronRight, CornerLeftUp, FileText, Folder, FolderPlus,
  GitBranch, Home, Pencil, RefreshCw, Search, X,
} from 'lucide-react';
import type { NodeBrowseDirsResult, NodeCreateDirResult, NodeDirEntry, NodeRenameDirResult } from '@shared/node-protocol.ts';
import { Mono, Note, Problem } from '@/components/bits';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox, Choice } from '@/components/ui/checkbox';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { api, messageOf, post, put } from '@/lib/api';

interface Crumb {
  label: string;
  path: string;
}

export function splitBreadcrumbs(fullPath: string, platform: string): Crumb[] {
  if (!fullPath) return [];
  const win = platform === 'win32' || /^[A-Za-z]:[\\/]/.test(fullPath);
  if (win) {
    const normalized = fullPath.replace(/\//g, '\\');
    const match = /^([A-Za-z]:\\)(.*)$/.exec(normalized);
    if (!match) return [{ label: fullPath, path: fullPath }];
    const root = match[1]!;
    const rest = match[2]!.split('\\').filter(Boolean);
    const crumbs: Crumb[] = [{ label: root, path: root }];
    let acc = root;
    for (const part of rest) {
      acc = acc.endsWith('\\') ? `${acc}${part}` : `${acc}\\${part}`;
      crumbs.push({ label: part, path: acc });
    }
    return crumbs;
  }
  const parts = fullPath.split('/').filter(Boolean);
  const crumbs: Crumb[] = [{ label: '/', path: '/' }];
  let acc = '';
  for (const part of parts) {
    acc = `${acc}/${part}`;
    crumbs.push({ label: part, path: acc });
  }
  return crumbs;
}

function DirPickerBody({ machineUid, machineName, initialPath, onSelect, onClose }: {
  machineUid: string;
  machineName: string;
  initialPath?: string;
  onSelect: (path: string) => void;
  onClose: () => void;
}) {
  const [targetPath, setTargetPath] = useState<string>(initialPath?.trim() ?? '');
  const [showHidden, setShowHidden] = useState(false);
  const [filter, setFilter] = useState('');
  const [data, setData] = useState<NodeBrowseDirsResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [renaming, setRenaming] = useState<NodeDirEntry | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [mutating, setMutating] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const reqSeqRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const showHiddenRef = useRef(showHidden);

  const load = useCallback(async (pathToLoad: string, hidden: boolean) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const seq = ++reqSeqRef.current;

    setLoading(true);
    setError(null);
    setActionError(null);
    try {
      const qs = new URLSearchParams();
      if (pathToLoad !== '') qs.set('path', pathToLoad);
      if (hidden) qs.set('show_hidden', '1');
      const query = qs.toString();
      const url = `/api/machines/${encodeURIComponent(machineUid)}/dirs${query ? `?${query}` : ''}`;
      const result = await api<NodeBrowseDirsResult>(url, { signal: controller.signal });
      if (seq !== reqSeqRef.current || controller.signal.aborted) return;
      setData(result);
      setTargetPath(result.path);
    } catch (err) {
      if (seq !== reqSeqRef.current || controller.signal.aborted) return;
      setError(messageOf(err));
    } finally {
      if (seq === reqSeqRef.current) {
        setLoading(false);
      }
    }
  }, [machineUid]);

  useEffect(() => () => {
    reqSeqRef.current += 1;
    abortRef.current?.abort();
  }, []);

  useEffect(() => {
    void load(initialPath?.trim() ?? '', showHiddenRef.current);
  }, [initialPath, load]);

  function handleToggleHidden(next: boolean): void {
    showHiddenRef.current = next;
    setShowHidden(next);
    void load(data?.path ?? targetPath, next);
  }

  function navigate(nextPath: string): void {
    setFilter('');
    setCreating(false);
    setRenaming(null);
    setActionError(null);
    void load(nextPath, showHidden);
  }

  async function handleCreate(): Promise<void> {
    if (!data || mutating) return;
    const trimmed = newName.trim();
    if (trimmed === '') {
      setActionError('请输入文件夹名称');
      return;
    }
    setMutating(true);
    setActionError(null);
    try {
      const created = await post<NodeCreateDirResult>(
        `/api/machines/${encodeURIComponent(machineUid)}/dirs`,
        { parent: data.path, name: trimmed },
      );
      setCreating(false);
      setNewName('');
      setFilter('');
      setMutating(false);
      await load(created.path, showHidden);
    } catch (err) {
      setActionError(messageOf(err));
      setMutating(false);
    }
  }

  async function handleRename(): Promise<void> {
    if (!renaming || !data || mutating) return;
    const trimmed = renameValue.trim();
    if (trimmed === '') {
      setActionError('请输入新的文件夹名称');
      return;
    }
    setMutating(true);
    setActionError(null);
    try {
      await put<NodeRenameDirResult>(
        `/api/machines/${encodeURIComponent(machineUid)}/dirs`,
        { path: renaming.path, name: trimmed },
      );
      setRenaming(null);
      setRenameValue('');
      setMutating(false);
      await load(data.path, showHidden);
    } catch (err) {
      setActionError(messageOf(err));
      setMutating(false);
    }
  }

  const crumbs = useMemo(
    () => (data ? splitBreadcrumbs(data.path, data.platform) : []),
    [data],
  );

  const visibleEntries = useMemo(() => {
    if (!data) return { dirs: [] as NodeDirEntry[], files: [] as NodeDirEntry[] };
    const needle = filter.trim().toLowerCase();
    const matched = needle === ''
      ? data.entries
      : data.entries.filter((entry) => entry.name.toLowerCase().includes(needle));
    return {
      dirs: matched.filter((entry) => entry.kind === 'dir'),
      files: matched.filter((entry) => entry.kind === 'file'),
    };
  }, [data, filter]);

  const busy = loading || mutating;

  return (
    <DialogContent
      className="max-w-[640px]"
      title={`选择 ${machineName} 上的目录`}
      description="点选进入子目录，支持新建与重命名文件夹；下方灰显列出同级文件便于确认目录内容。"
      footer={(
        <div className="flex w-full flex-wrap items-center gap-2">
          <Mono className="mr-auto min-w-0 flex-1 truncate text-xs text-muted-foreground" title={data?.path ?? targetPath}>
            {data?.path ?? (targetPath || '正在读取…')}
          </Mono>
          <Button type="button" variant="ghost" onClick={onClose}>取消</Button>
          <Button
            type="button"
            variant="primary"
            disabled={!data || busy}
            onClick={() => { if (data) { onSelect(data.path); onClose(); } }}
          >
            选择当前目录
          </Button>
        </div>
      )}
    >
      <div className="grid gap-3">
        <div className="flex flex-wrap items-center gap-1.5">
          <Button
            type="button"
            size="sm"
            variant="secondary"
            disabled={busy || !data}
            onClick={() => { if (data) navigate(data.home); }}
          >
            <Home className="size-3.5" />
            主目录
          </Button>
          {data?.roots.map((root) => (
            <Button
              key={root}
              type="button"
              size="sm"
              variant={data.path === root ? 'primary' : 'ghost'}
              className="font-mono text-xs"
              disabled={busy}
              onClick={() => navigate(root)}
            >
              {root}
            </Button>
          ))}
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={busy || !data?.parent}
            aria-label="返回上一级"
            onClick={() => { if (data?.parent) navigate(data.parent); }}
          >
            <CornerLeftUp className="size-3.5" />
            上一级
          </Button>
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            disabled={busy}
            aria-label="刷新目录"
            onClick={() => void load(data?.path ?? targetPath, showHidden)}
          >
            <RefreshCw className={`size-3.5 ${loading ? 'animate-spin' : ''}`} />
          </Button>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            className="ml-auto"
            disabled={busy || !data}
            onClick={() => {
              setRenaming(null);
              setActionError(null);
              setCreating((prev) => !prev);
              setNewName('');
            }}
          >
            <FolderPlus className="size-3.5" />
            新建文件夹
          </Button>
        </div>

        {crumbs.length > 0 ? (
          <nav aria-label="当前路径" className="flex flex-wrap items-center gap-0.5 rounded-lg border border-border bg-surface px-2.5 py-1.5 font-mono text-xs">
            {crumbs.map((crumb, index) => (
              <span key={crumb.path} className="inline-flex items-center gap-0.5">
                {index > 0 ? <ChevronRight className="size-3 text-faint" /> : null}
                <button
                  type="button"
                  disabled={busy || index === crumbs.length - 1}
                  className={index === crumbs.length - 1
                    ? 'font-medium text-foreground'
                    : 'rounded px-1 py-0.5 text-muted-foreground hover:bg-raised hover:text-foreground disabled:pointer-events-none'}
                  onClick={() => navigate(crumb.path)}
                >
                  {crumb.label}
                </button>
              </span>
            ))}
          </nav>
        ) : null}

        <div className="flex flex-wrap items-center gap-3">
          <div className="relative min-w-[180px] flex-1">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-faint" />
            <Input
              aria-label="过滤当前目录"
              className="pl-8 text-xs"
              placeholder="过滤当前目录…"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
            />
          </div>
          <Choice className="text-xs">
            <Checkbox
              aria-label="显示隐藏项"
              checked={showHidden}
              disabled={busy}
              onChange={(event) => handleToggleHidden(event.target.checked)}
            />
            显示隐藏项
          </Choice>
        </div>

        {creating ? (
          <div className="flex items-center gap-2 rounded-lg border border-border bg-surface p-2">
            <FolderPlus className="size-4 flex-none text-muted-foreground" />
            <Input
              aria-label="新文件夹名称"
              autoFocus
              className="h-8 text-xs"
              placeholder="输入新文件夹名称"
              value={newName}
              disabled={mutating}
              onChange={(event) => setNewName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') { event.preventDefault(); void handleCreate(); }
                if (event.key === 'Escape') { event.preventDefault(); setCreating(false); setActionError(null); }
              }}
            />
            <Button type="button" size="sm" variant="primary" disabled={mutating || newName.trim() === ''} onClick={() => void handleCreate()}>
              创建
            </Button>
            <Button type="button" size="icon-sm" variant="ghost" aria-label="取消新建" disabled={mutating} onClick={() => { setCreating(false); setActionError(null); }}>
              <X className="size-3.5" />
            </Button>
          </div>
        ) : null}

        {actionError ? <Problem role="alert">{actionError}</Problem> : null}

        {error ? (
          <div className="grid gap-2 rounded-lg border border-border bg-surface p-4">
            <Problem role="alert">{error}</Problem>
            <div className="flex flex-wrap gap-2">
              <Button type="button" size="sm" variant="secondary" disabled={loading} onClick={() => void load(targetPath, showHidden)}>重试</Button>
              {targetPath !== '' ? (
                <Button type="button" size="sm" variant="ghost" disabled={loading} onClick={() => navigate('')}>回到主目录</Button>
              ) : null}
            </div>
          </div>
        ) : (
          <div className="h-[320px] overflow-y-auto rounded-lg border border-border bg-surface">
            {loading && !data ? (
              <div className="flex h-full items-center justify-center">
                <Note>正在读取远程目录…</Note>
              </div>
            ) : visibleEntries.dirs.length === 0 && visibleEntries.files.length === 0 ? (
              <div className="flex h-full items-center justify-center p-4 text-center">
                <Note>
                  {filter.trim() !== ''
                    ? '没有匹配的文件夹或文件。'
                    : '这个文件夹是空的，可直接选择当前目录或新建子文件夹。'}
                </Note>
              </div>
            ) : (
              <ul aria-label="目录内容" className="divide-y divide-border/60">
                {visibleEntries.dirs.map((entry) => {
                  const isRenaming = renaming?.path === entry.path;
                  return (
                    <li key={entry.path} className="group flex items-center gap-2 px-3 py-1.5 hover:bg-raised">
                      {isRenaming ? (
                        <div className="flex w-full items-center gap-1.5">
                          <Folder className="size-4 flex-none text-muted-foreground" />
                          <Input
                            aria-label="重命名文件夹"
                            autoFocus
                            className="h-7 flex-1 text-xs"
                            value={renameValue}
                            disabled={mutating}
                            onChange={(event) => setRenameValue(event.target.value)}
                            onKeyDown={(event) => {
                              if (event.key === 'Enter') { event.preventDefault(); void handleRename(); }
                              if (event.key === 'Escape') { event.preventDefault(); setRenaming(null); setActionError(null); }
                            }}
                          />
                          <Button type="button" size="icon-sm" variant="primary" aria-label="确认重命名" disabled={mutating || renameValue.trim() === ''} onClick={() => void handleRename()}>
                            <Check className="size-3.5" />
                          </Button>
                          <Button type="button" size="icon-sm" variant="ghost" aria-label="取消重命名" disabled={mutating} onClick={() => { setRenaming(null); setActionError(null); }}>
                            <X className="size-3.5" />
                          </Button>
                        </div>
                      ) : (
                        <>
                          <button
                            type="button"
                            disabled={busy}
                            className="flex min-w-0 flex-1 items-center gap-2 text-left"
                            onClick={() => navigate(entry.path)}
                          >
                            <Folder className="size-4 flex-none text-accent-foreground/80" />
                            <span className="truncate text-sm">{entry.name}</span>
                            {entry.is_git ? (
                              <Badge tone="plain" className="ml-1 gap-1 text-[11px]">
                                <GitBranch className="size-3" />
                                git
                              </Badge>
                            ) : null}
                          </button>
                          <Button
                            type="button"
                            size="icon-sm"
                            variant="ghost"
                            className="opacity-70 hover:opacity-100"
                            aria-label={`重命名 ${entry.name}`}
                            disabled={busy}
                            onClick={() => {
                              setCreating(false);
                              setActionError(null);
                              setRenaming(entry);
                              setRenameValue(entry.name);
                            }}
                          >
                            <Pencil className="size-3.5" />
                          </Button>
                        </>
                      )}
                    </li>
                  );
                })}
                {visibleEntries.files.map((entry) => (
                  <li key={entry.path} className="flex items-center gap-2 px-3 py-1.5 text-muted-foreground/75">
                    <FileText className="size-4 flex-none" />
                    <span className="truncate text-xs">{entry.name}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {data?.truncated ? (
          <Note className="text-xs">目录项较多，已仅展示前 400 个子目录和 200 个文件。</Note>
        ) : null}
      </div>
    </DialogContent>
  );
}

export function DirPickerDialog({ open, machineUid, machineName, initialPath, onSelect, onOpenChange }: {
  open: boolean;
  machineUid: string;
  machineName: string;
  initialPath?: string;
  onSelect: (path: string) => void;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open ? (
        <DirPickerBody
          machineUid={machineUid}
          machineName={machineName}
          initialPath={initialPath}
          onSelect={onSelect}
          onClose={() => onOpenChange(false)}
        />
      ) : null}
    </Dialog>
  );
}
