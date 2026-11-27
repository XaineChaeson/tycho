// A project's code sources as the console edits them (docs/design/code-sources.md §4): an
// ordered list, the first item the default. A new item carries no id — the service makes one
// when the list is saved — so the controls only ever move whole items and change their fields.
import { useState } from 'react';
import { ArrowDown, ArrowUp, FolderOpen, Plus, X } from 'lucide-react';
import { t as translate } from '@shared/i18n.ts';
import { Note } from '@/components/bits';
import { DirPickerDialog } from '@/components/dir-picker';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Option, Select } from '@/components/ui/select';
import { useI18n } from '@/lib/i18n';
import { blankSource, moveItem, type DraftSource } from '@/lib/projects';

// What the two kinds mean, in the owner's words, wherever the list is edited.
export const CODE_SOURCE_HINT = translate('mach.source.hint');

export interface SourceMachine {
  uid: string;
  name: string;
}

export function SourceEditor({ label, items, machines, disabled, onChange }: {
  label?: string;
  items: DraftSource[];
  machines: SourceMachine[];
  disabled: boolean;
  onChange: (items: DraftSource[]) => void;
}) {
  const { t } = useI18n();
  const [browsingIndex, setBrowsingIndex] = useState<number | null>(null);
  const groupLabel = label ?? t('mach.source.label');
  const put = (index: number, next: DraftSource): void => onChange(items.map((item, at) => (at === index ? next : item)));
  const known = (uid: string): boolean => machines.some((machine) => machine.uid === uid);
  const browsingItem = browsingIndex !== null ? items[browsingIndex] : undefined;
  const browsingMachine = browsingItem?.kind === 'folder' ? machines.find((machine) => machine.uid === browsingItem.machine_uid) : undefined;

  return (
    <div role="group" aria-label={groupLabel} className="grid gap-2">
      {items.length ? (
        <ul aria-label={t('mach.source.listLabel')} className="grid gap-2">
          {items.map((item, index) => {
            // A folder on a machine that is not in the list: never started from the console,
            // or gone since. The item is kept and the owner picks a machine.
            const missing = item.kind === 'folder' && (item.machine_uid === '' || !known(item.machine_uid));
            const n = index + 1;
            return (
              <li key={index} className="grid gap-2 rounded-lg border border-border bg-raised px-3 py-2.5">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs text-faint tabular-nums">{n}</span>
                  {index === 0 ? <Badge tone="plain">{t('mach.source.defaultBadge')}</Badge> : null}
                  <Select
                    aria-label={t('mach.source.typeLabel', { n })}
                    wrapperClassName="flex"
                    value={item.kind}
                    disabled={disabled}
                    onChange={(event) => put(index, { ...blankSource(event.target.value as 'repo' | 'folder'), id: item.id })}
                  >
                    <Option value="repo">{t('mach.source.kindRepo')}</Option>
                    <Option value="folder">{t('mach.source.kindFolder')}</Option>
                  </Select>
                  <span className="ml-auto flex items-center gap-1">
                    <Button size="icon-sm" variant="ghost" disabled={disabled || index === 0} aria-label={t('mach.source.moveUpLabel', { n })} onClick={() => onChange(moveItem(items, index, index - 1))}><ArrowUp /></Button>
                    <Button size="icon-sm" variant="ghost" disabled={disabled || index === items.length - 1} aria-label={t('mach.source.moveDownLabel', { n })} onClick={() => onChange(moveItem(items, index, index + 1))}><ArrowDown /></Button>
                    <Button size="icon-sm" variant="ghost" disabled={disabled} aria-label={t('mach.source.removeLabel', { n })} onClick={() => onChange(items.filter((_, at) => at !== index))}><X /></Button>
                  </span>
                </div>
                {item.kind === 'repo' ? (
                  <Input
                    aria-label={t('mach.source.repoUrlLabel', { n })}
                    className="font-mono text-xs"
                    placeholder={t('mach.source.repoPlaceholder')}
                    value={item.url}
                    disabled={disabled}
                    onChange={(event) => put(index, { ...item, url: event.target.value })}
                  />
                ) : (
                  <div className="grid gap-2">
                    <Select
                      aria-label={t('mach.source.machineLabel', { n })}
                      wrapperClassName="flex"
                      value={item.machine_uid}
                      disabled={disabled}
                      onChange={(event) => put(index, { ...item, machine_uid: event.target.value })}
                    >
                      <Option value="">{t('mach.source.pickMachine')}</Option>
                      {item.machine_uid !== '' && !known(item.machine_uid) ? <Option value={item.machine_uid}>{t('mach.source.deletedMachine')}</Option> : null}
                      {machines.map((machine) => <Option key={machine.uid} value={machine.uid}>{machine.name}</Option>)}
                    </Select>
                    <div className="flex items-center gap-2">
                      <Input
                        aria-label={t('mach.source.folderLabel', { n })}
                        className="flex-1 font-mono text-xs"
                        placeholder={t('mach.source.folderPlaceholder')}
                        value={item.path}
                        disabled={disabled}
                        onChange={(event) => put(index, { ...item, path: event.target.value })}
                      />
                      <Button
                        type="button"
                        size="sm"
                        variant="secondary"
                        disabled={disabled || missing}
                        aria-label={t('mach.source.browseLabel', { n })}
                        onClick={() => setBrowsingIndex(index)}
                      >
                        <FolderOpen className="size-3.5" />
                        {t('mach.source.browse')}
                      </Button>
                    </div>
                    {missing ? (
                      <Note className="text-xs text-waiting-foreground">
                        {item.machine_uid === '' ? t('mach.source.missingMachine') : t('mach.source.goneMachine')}
                      </Note>
                    ) : null}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      ) : (
        <Note className="text-xs">{t('mach.source.empty')}</Note>
      )}
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" variant="secondary" disabled={disabled} onClick={() => onChange([...items, blankSource('repo')])}><Plus />{t('mach.source.addRepo')}</Button>
        <Button type="button" size="sm" variant="secondary" disabled={disabled} onClick={() => onChange([...items, blankSource('folder')])}><Plus />{t('mach.source.addFolder')}</Button>
      </div>
      {browsingIndex !== null && browsingItem?.kind === 'folder' && browsingMachine ? (
        <DirPickerDialog
          open
          machineUid={browsingMachine.uid}
          machineName={browsingMachine.name}
          initialPath={browsingItem.path}
          onSelect={(selectedPath) => put(browsingIndex, { ...browsingItem, path: selectedPath })}
          onOpenChange={(open) => { if (!open) setBrowsingIndex(null); }}
        />
      ) : null}
    </div>
  );
}
