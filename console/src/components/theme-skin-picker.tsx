// Pluggable theme skin switcher & host directory theme plugin manager in the Shell bottom dock.
import { Check, FolderCog, Palette, Plus, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/input';
import { Tooltip } from '@/components/ui/menu';
import {
  getHostThemesDir,
  installThemePack,
  listThemePacks,
  readThemeSkin,
  SAMPLE_THEME_PACK_JSON,
  saveThemeSkin,
  subscribeThemePacks,
  syncDirectoryThemePacks,
  uninstallThemePack,
  type ThemePack,
} from '@/lib/theme';
import { cn } from '@/lib/utils';

function PackGrid({
  packs,
  activeId,
  onSelect,
  onRemove,
}: {
  packs: readonly ThemePack[];
  activeId: string;
  onSelect: (id: string) => void;
  onRemove: (pack: ThemePack) => void;
}) {
  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
      {packs.map((pack) => {
        const selected = pack.id === activeId;
        return (
          <div
            key={pack.id}
            className={cn(
              'group relative flex flex-col rounded-lg border transition-colors',
              selected
                ? 'border-primary bg-brand-soft/60 ring-1 ring-primary/30'
                : 'border-border bg-background hover:border-border-strong hover:bg-muted/50',
            )}
          >
            <button
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => onSelect(pack.id)}
              className="flex flex-1 flex-col gap-1 p-2.5 text-left"
            >
              <div className="flex w-full items-center justify-between gap-2">
                <span className="flex min-w-0 items-center gap-1.5 text-sm font-semibold text-foreground">
                  <span className="truncate">{pack.name}</span>
                  <span className="flex-none rounded-xs border border-border bg-muted px-1 font-mono text-2xs font-medium text-muted-foreground">
                    {pack.badge}
                  </span>
                </span>
                {selected ? <Check className="size-3.5 flex-none text-primary" aria-hidden="true" /> : null}
              </div>
              <span className="text-xs leading-snug text-muted-foreground">{pack.description}</span>
              <span className="mt-1 flex items-center gap-1.5" aria-hidden="true">
                {pack.swatches.map((hex, i) => (
                  <span
                    key={i}
                    className="size-3.5 rounded-xs border border-border-strong/70"
                    style={{ background: hex }}
                  />
                ))}
                {pack.source === 'directory' ? (
                  <span className="ml-auto font-mono text-2xs text-faint">目录插件</span>
                ) : null}
              </span>
            </button>
            {!pack.builtin ? (
              <button
                type="button"
                aria-label={`删除主题 ${pack.name}`}
                title="删除自定义主题包"
                onClick={() => onRemove(pack)}
                className="absolute right-2 bottom-2 rounded-xs p-1 text-faint opacity-75 transition-opacity hover:bg-failed-soft hover:text-destructive hover:opacity-100"
              >
                <Trash2 className="size-3.5" aria-hidden="true" />
              </button>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

export function ThemeSkinPicker() {
  const [open, setOpen] = useState(false);
  const [packs, setPacks] = useState<ThemePack[]>(listThemePacks);
  const [activeId, setActiveId] = useState<string>(readThemeSkin);
  const [hostDir, setHostDir] = useState<string | null>(getHostThemesDir);
  const [importOpen, setImportOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);

  useEffect(() => subscribeThemePacks(() => {
    setPacks(listThemePacks());
    setActiveId(readThemeSkin());
    setHostDir(getHostThemesDir());
  }), []);

  const activePack = packs.find((p) => p.id === activeId) ?? packs[0];
  const hybridPacks = packs.filter((p) => p.group === 'hybrid');
  const signaturePacks = packs.filter((p) => p.group === 'signature');
  const customPacks = packs.filter((p) => p.group === 'custom');

  const openPicker = (): void => {
    setPacks(listThemePacks());
    setActiveId(readThemeSkin());
    setHostDir(getHostThemesDir());
    setOpen(true);
    void syncDirectoryThemePacks();
  };

  const selectPack = (id: string): void => {
    saveThemeSkin(id);
    setActiveId(id);
  };

  const handleImport = async (): Promise<void> => {
    setBusy(true);
    try {
      const res = await installThemePack(draft);
      if (!res.ok) {
        setImportError(res.error);
        return;
      }
      setImportError(null);
      setDraft('');
      setImportOpen(false);
      setPacks(listThemePacks());
      setActiveId(readThemeSkin());
      setHostDir(getHostThemesDir());
    } finally {
      setBusy(false);
    }
  };

  const handleRemove = (pack: ThemePack): void => {
    void uninstallThemePack(pack).then(() => {
      setPacks(listThemePacks());
      setActiveId(readThemeSkin());
    });
  };

  return (
    <>
      <Tooltip text={`切换界面主题（当前：${activePack?.name ?? '测控星盘'}）`}>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="切换界面主题"
          onClick={openPicker}
          className="flex-none text-muted-foreground hover:text-foreground"
        >
          <Palette className="size-3.5" aria-hidden="true" />
        </Button>
      </Tooltip>

      <Dialog open={open} onOpenChange={(next) => { setOpen(next); if (!next) { setImportOpen(false); setImportError(null); } }}>
        <DialogContent
          title="界面主题与目录插件"
          description="内置 9 套特色主题（均支持浅色 / 深色模式即时切换），也支持主机目录 JSON 主题插件跨设备自动同步。"
          className="max-w-[600px]"
        >
          <div className="space-y-4" role="radiogroup" aria-label="界面主题">
            <section className="space-y-2">
              <h3 className="font-mono text-2xs font-semibold tracking-wider text-muted-foreground uppercase">
                高密度工作台
              </h3>
              <PackGrid packs={hybridPacks} activeId={activeId} onSelect={selectPack} onRemove={handleRemove} />
            </section>

            <section className="space-y-2">
              <h3 className="font-mono text-2xs font-semibold tracking-wider text-muted-foreground uppercase">
                个性主题风格
              </h3>
              <PackGrid packs={signaturePacks} activeId={activeId} onSelect={selectPack} onRemove={handleRemove} />
            </section>

            {customPacks.length > 0 ? (
              <section className="space-y-2">
                <h3 className="font-mono text-2xs font-semibold tracking-wider text-muted-foreground uppercase">
                  已安装主题插件
                </h3>
                <PackGrid packs={customPacks} activeId={activeId} onSelect={selectPack} onRemove={handleRemove} />
              </section>
            ) : null}

            <div className="space-y-2 border-t border-border pt-3">
              {hostDir ? (
                <div className="flex items-center gap-1.5 rounded-md border border-border bg-muted/60 px-2.5 py-1.5 text-2xs text-muted-foreground">
                  <FolderCog className="size-3.5 flex-none text-primary" aria-hidden="true" />
                  <span className="min-w-0 flex-1 truncate">
                    插件目录：<code className="font-mono text-foreground">{hostDir}</code>（放入 .json 跨设备自动生效）
                  </span>
                </div>
              ) : null}

              {!importOpen ? (
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs text-muted-foreground">导入的 JSON 主题包会自动写入主机插件目录，Web 与桌面端同步可见</span>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => { setImportOpen(true); setImportError(null); }}
                  >
                    <Plus className="size-3.5" aria-hidden="true" />
                    导入主题包
                  </Button>
                </div>
              ) : (
                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-medium text-foreground">粘贴主题包 JSON</span>
                    <button
                      type="button"
                      onClick={() => { setDraft(SAMPLE_THEME_PACK_JSON); setImportError(null); }}
                      className="text-xs text-link hover:underline"
                    >
                      填入示例模板
                    </button>
                  </div>
                  <Textarea
                    aria-label="主题包 JSON"
                    rows={7}
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                    placeholder={SAMPLE_THEME_PACK_JSON}
                    className="font-mono text-xs"
                  />
                  {importError ? <p role="alert" className="text-xs text-destructive">{importError}</p> : null}
                  <div className="flex justify-end gap-2">
                    <Button size="sm" variant="ghost" disabled={busy} onClick={() => { setImportOpen(false); setImportError(null); }}>
                      取消
                    </Button>
                    <Button size="sm" variant="primary" disabled={busy} onClick={() => { void handleImport(); }}>
                      {busy ? '安装中…' : '安装并启用'}
                    </Button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
