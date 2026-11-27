// Hot-pluggable language pack manager rendered inside Settings (`ui.locale` / Service group).
// Lets the owner switch active locale, import a community JSON pack into `<dataDir>/locales/`,
// export a ready-to-translate JSON template, or delete/reset custom directory packs without restarting.
import { useQueryClient } from '@tanstack/react-query';
import { Check, Download, FolderOpen, Languages, Trash2, Upload } from 'lucide-react';
import { useRef, useState, type ChangeEvent } from 'react';
import { exportLocaleTemplate, type LocalePack } from '@shared/i18n.ts';
import { Callout, Mono, Note, Problem } from '@/components/bits';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { api, del, messageOf, post, put } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { settingsQuery, stateQuery } from '@/lib/queries';

function triggerJsonDownload(filename: string, payload: unknown): void {
  const blob = new Blob([JSON.stringify(payload, null, 2) + '\n'], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

export function LocalePackManager() {
  const { locale, packs, localesDir, setLocale, refreshPacks, t } = useI18n();
  const client = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function selectLocale(id: string): Promise<void> {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      setLocale(id);
      await put('/api/settings/ui.locale', { value: id });
      await Promise.all([
        client.invalidateQueries({ queryKey: stateQuery.queryKey }),
        client.invalidateQueries({ queryKey: settingsQuery.queryKey }),
      ]);
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy(false);
    }
  }

  async function handleFileChange(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const rawText = await file.text();
      let parsed: unknown;
      try {
        parsed = JSON.parse(rawText);
      } catch {
        throw new Error(t('locales.importInvalidJson'));
      }
      const res = await post<{ locale: LocalePack }>('/api/locales', parsed);
      await refreshPacks();
      setNotice(t('locales.importSuccess', { name: res.locale.nativeName, id: res.locale.id }));
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy(false);
    }
  }

  async function handleExportPack(id?: string): Promise<void> {
    setError(null);
    try {
      if (!id) {
        const template = exportLocaleTemplate(locale);
        triggerJsonDownload('tycho-locale-template.json', template);
        return;
      }
      const res = await api<{ pack: LocalePack; resolved_messages: Record<string, string> }>(
        `/api/locales/${encodeURIComponent(id)}`,
      );
      triggerJsonDownload(`${res.pack.id}.json`, {
        id: res.pack.id,
        name: res.pack.name,
        nativeName: res.pack.nativeName,
        shortLabel: res.pack.shortLabel,
        direction: res.pack.direction,
        ...(res.pack.fallback ? { fallback: res.pack.fallback } : {}),
        messages: res.resolved_messages,
      });
    } catch (caught) {
      setError(messageOf(caught));
    }
  }

  async function handleDeletePack(id: string, name: string): Promise<void> {
    if (!window.confirm(t('locales.deleteConfirm', { name, id }))) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await del<{ active?: string }>(`/api/locales/${encodeURIComponent(id)}`);
      await refreshPacks();
      if (res.active && res.active !== locale) setLocale(res.active);
      await Promise.all([
        client.invalidateQueries({ queryKey: stateQuery.queryKey }),
        client.invalidateQueries({ queryKey: settingsQuery.queryKey }),
      ]);
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      aria-label={t('locales.managerTitle')}
      className="mt-4 overflow-hidden rounded-xl border border-border bg-raised shadow-card"
    >
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-4 py-3">
        <div className="min-w-0 flex-1">
          <h3 className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
            <Languages className="size-4 text-primary" aria-hidden="true" />
            {t('locales.managerTitle')}
          </h3>
          <Note className="mt-0.5 text-xs">{t('locales.managerDesc')}</Note>
          {localesDir ? (
            <p className="mt-1.5 flex items-center gap-1.5 text-2xs text-faint">
              <FolderOpen className="size-3 flex-none" aria-hidden="true" />
              <span>{t('locales.dirLabel')}:</span>
              <Mono className="text-2xs">{localesDir}</Mono>
            </p>
          ) : null}
        </div>
        <div className="flex flex-none flex-wrap items-center gap-1.5">
          <input
            ref={fileRef}
            type="file"
            accept=".json,application/json"
            className="sr-only"
            aria-label={t('locales.importBtn')}
            onChange={(event) => void handleFileChange(event)}
          />
          <Button size="sm" variant="primary" disabled={busy} onClick={() => fileRef.current?.click()}>
            <Upload className="size-3.5" aria-hidden="true" />
            {t('locales.importBtn')}
          </Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void handleExportPack()}>
            <Download className="size-3.5" aria-hidden="true" />
            {t('locales.exportTemplateBtn')}
          </Button>
        </div>
      </div>

      {notice ? <Callout tone="plain" role="status" className="mx-4 mt-3 text-xs">{notice}</Callout> : null}
      {error ? <Problem role="alert" className="mx-4 mt-3 text-xs">{error}</Problem> : null}

      <ul className="divide-y divide-border">
        {packs.map((item) => {
          const active = item.id === locale;
          return (
            <li key={item.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5 text-sm">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-foreground">{item.nativeName}</span>
                  <span className="text-xs text-muted-foreground">{item.name}</span>
                  <Mono className="text-2xs text-faint">{item.id}</Mono>
                  {item.builtin ? (
                    <Badge tone="plain" className="px-1.5 py-0 text-2xs">
                      {item.has_override ? t('nav.overrideLocale') : t('nav.builtinLocale')}
                    </Badge>
                  ) : (
                    <Badge tone="running" className="px-1.5 py-0 text-2xs">{t('nav.customLocale')}</Badge>
                  )}
                  {active ? (
                    <Badge tone="success" className="px-1.5 py-0 text-2xs">
                      <Check className="mr-0.5 size-3" aria-hidden="true" />
                      {t('locales.activeBadge')}
                    </Badge>
                  ) : null}
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-muted-foreground">
                  <span className="inline-flex items-center gap-1.5 tabular-nums">
                    <span className="inline-block h-1.5 w-16 overflow-hidden rounded-full bg-muted">
                      <span
                        className="block h-full rounded-full bg-primary transition-[width]"
                        style={{ width: `${Math.min(100, Math.max(0, item.coverage))}%` }}
                      />
                    </span>
                    {t('locales.coverage', {
                      pct: item.coverage,
                      translated: item.translated_keys,
                      total: item.total_keys,
                    })}
                  </span>
                  {item.fallback ? <span>{t('locales.fallback', { id: item.fallback })}</span> : null}
                </div>
              </div>

              <div className="flex flex-none items-center gap-1.5">
                {!active ? (
                  <Button size="sm" variant="secondary" disabled={busy} onClick={() => void selectLocale(item.id)}>
                    {t('locales.useBtn')}
                  </Button>
                ) : null}
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => void handleExportPack(item.id)}
                >
                  <Download className="size-3.5" aria-hidden="true" />
                  {t('locales.exportPackBtn')}
                </Button>
                {!item.builtin || item.has_override ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-destructive hover:text-destructive"
                    disabled={busy}
                    onClick={() => void handleDeletePack(item.id, item.nativeName)}
                  >
                    <Trash2 className="size-3.5" aria-hidden="true" />
                    {item.builtin ? t('locales.resetOverrideBtn') : t('locales.deleteBtn')}
                  </Button>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
