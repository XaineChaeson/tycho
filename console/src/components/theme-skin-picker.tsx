// Pluggable theme skin switcher & host directory theme plugin manager in the Shell bottom dock.
import { Check, FolderCog, Palette, Plus, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/input';
import { Tooltip } from '@/components/ui/menu';
import { useI18n } from '@/lib/i18n';
import {
  getHostThemesDir,
  getSampleThemePackJson,
  installThemePack,
  listThemePacks,
  readThemeSkin,
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
  const { t } = useI18n();
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
                  <span className="ml-auto font-mono text-2xs text-faint">{t('core.themePicker.dirPlugin')}</span>
                ) : null}
              </span>
            </button>
            {!pack.builtin ? (
              <button
                type="button"
                aria-label={t('core.themePicker.deleteAria', { name: pack.name })}
                title={t('core.themePicker.deleteTitle')}
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
  const { t } = useI18n();
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
  const sampleJson = getSampleThemePackJson();

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
      <Tooltip text={t('core.themePicker.tooltip', { name: activePack?.name ?? t('core.theme.pack.hud.name') })}>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t('core.themePicker.switchLabel')}
          onClick={openPicker}
          className="flex-none text-muted-foreground hover:text-foreground"
        >
          <Palette className="size-3.5" aria-hidden="true" />
        </Button>
      </Tooltip>

      <Dialog open={open} onOpenChange={(next) => { setOpen(next); if (!next) { setImportOpen(false); setImportError(null); } }}>
        <DialogContent
          title={t('core.themePicker.dialogTitle')}
          description={t('core.themePicker.dialogDesc')}
          className="max-w-[600px]"
        >
          <div className="space-y-4" role="radiogroup" aria-label={t('core.themePicker.groupAria')}>
            <section className="space-y-2">
              <h3 className="font-mono text-2xs font-semibold tracking-wider text-muted-foreground uppercase">
                {t('core.themePicker.sectionHybrid')}
              </h3>
              <PackGrid packs={hybridPacks} activeId={activeId} onSelect={selectPack} onRemove={handleRemove} />
            </section>

            <section className="space-y-2">
              <h3 className="font-mono text-2xs font-semibold tracking-wider text-muted-foreground uppercase">
                {t('core.themePicker.sectionSignature')}
              </h3>
              <PackGrid packs={signaturePacks} activeId={activeId} onSelect={selectPack} onRemove={handleRemove} />
            </section>

            {customPacks.length > 0 ? (
              <section className="space-y-2">
                <h3 className="font-mono text-2xs font-semibold tracking-wider text-muted-foreground uppercase">
                  {t('core.themePicker.sectionCustom')}
                </h3>
                <PackGrid packs={customPacks} activeId={activeId} onSelect={selectPack} onRemove={handleRemove} />
              </section>
            ) : null}

            <div className="space-y-2 border-t border-border pt-3">
              {hostDir ? (
                <div className="flex items-center gap-1.5 rounded-md border border-border bg-muted/60 px-2.5 py-1.5 text-2xs text-muted-foreground">
                  <FolderCog className="size-3.5 flex-none text-primary" aria-hidden="true" />
                  <span className="min-w-0 flex-1 truncate">
                    {t('core.themePicker.pluginDirPrefix')}<code className="font-mono text-foreground">{hostDir}</code>{t('core.themePicker.pluginDirSuffix')}
                  </span>
                </div>
              ) : null}

              {!importOpen ? (
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs text-muted-foreground">{t('core.themePicker.importHint')}</span>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => { setImportOpen(true); setImportError(null); }}
                  >
                    <Plus className="size-3.5" aria-hidden="true" />
                    {t('core.themePicker.importBtn')}
                  </Button>
                </div>
              ) : (
                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-medium text-foreground">{t('core.themePicker.pasteJson')}</span>
                    <button
                      type="button"
                      onClick={() => { setDraft(sampleJson); setImportError(null); }}
                      className="text-xs text-link hover:underline"
                    >
                      {t('core.themePicker.fillSample')}
                    </button>
                  </div>
                  <Textarea
                    aria-label={t('core.themePicker.jsonAria')}
                    rows={7}
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                    placeholder={sampleJson}
                    className="font-mono text-xs"
                  />
                  {importError ? <p role="alert" className="text-xs text-destructive">{importError}</p> : null}
                  <div className="flex justify-end gap-2">
                    <Button size="sm" variant="ghost" disabled={busy} onClick={() => { setImportOpen(false); setImportError(null); }}>
                      {t('common.cancel')}
                    </Button>
                    <Button size="sm" variant="primary" disabled={busy} onClick={() => { void handleImport(); }}>
                      {busy ? t('core.themePicker.installing') : t('core.themePicker.installAndUse')}
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
