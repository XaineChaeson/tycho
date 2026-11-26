// A project's code sources as the console edits them (docs/design/code-sources.md §4): an
// ordered list, the first item the default. A new item carries no id — the service makes one
// when the list is saved — so the controls only ever move whole items and change their fields.
import { useState } from 'react';
import { ArrowDown, ArrowUp, FolderOpen, Plus, X } from 'lucide-react';
import { Note } from '@/components/bits';
import { DirPickerDialog } from '@/components/dir-picker';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Option, Select } from '@/components/ui/select';
import { blankSource, moveItem, type DraftSource } from '@/lib/projects';

// What the two kinds mean, in the owner's words, wherever the list is edited.
export const CODE_SOURCE_HINT = '仓库：干活的机器自己拉一份，改完推分支、开 PR。机器上的文件夹：活只派到那台机器，直接在那个文件夹里改。';

export interface SourceMachine {
  uid: string;
  name: string;
}

export function SourceEditor({ label = '代码来源', items, machines, disabled, onChange }: {
  label?: string;
  items: DraftSource[];
  machines: SourceMachine[];
  disabled: boolean;
  onChange: (items: DraftSource[]) => void;
}) {
  const [browsingIndex, setBrowsingIndex] = useState<number | null>(null);
  const nth = (index: number): string => `第 ${index + 1} 个来源`;
  const put = (index: number, next: DraftSource): void => onChange(items.map((item, at) => (at === index ? next : item)));
  const known = (uid: string): boolean => machines.some((machine) => machine.uid === uid);
  const browsingItem = browsingIndex !== null ? items[browsingIndex] : undefined;
  const browsingMachine = browsingItem?.kind === 'folder' ? machines.find((machine) => machine.uid === browsingItem.machine_uid) : undefined;

  return (
    <div role="group" aria-label={label} className="grid gap-2">
      {items.length ? (
        <ul aria-label="代码来源（按顺序）" className="grid gap-2">
          {items.map((item, index) => {
            // A folder on a machine that is not in the list: never started from the console,
            // or gone since. The item is kept and the owner picks a machine.
            const missing = item.kind === 'folder' && (item.machine_uid === '' || !known(item.machine_uid));
            return (
              <li key={index} className="grid gap-2 rounded-lg border border-border bg-raised px-3 py-2.5">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs text-faint tabular-nums">{index + 1}</span>
                  {index === 0 ? <Badge tone="plain">默认</Badge> : null}
                  <Select
                    aria-label={`${nth(index)}的类型`}
                    wrapperClassName="flex"
                    value={item.kind}
                    disabled={disabled}
                    onChange={(event) => put(index, { ...blankSource(event.target.value as 'repo' | 'folder'), id: item.id })}
                  >
                    <Option value="repo">仓库地址</Option>
                    <Option value="folder">机器上的文件夹</Option>
                  </Select>
                  <span className="ml-auto flex items-center gap-1">
                    <Button size="icon-sm" variant="ghost" disabled={disabled || index === 0} aria-label={`把${nth(index)}往前挪`} onClick={() => onChange(moveItem(items, index, index - 1))}><ArrowUp /></Button>
                    <Button size="icon-sm" variant="ghost" disabled={disabled || index === items.length - 1} aria-label={`把${nth(index)}往后挪`} onClick={() => onChange(moveItem(items, index, index + 1))}><ArrowDown /></Button>
                    <Button size="icon-sm" variant="ghost" disabled={disabled} aria-label={`去掉${nth(index)}`} onClick={() => onChange(items.filter((_, at) => at !== index))}><X /></Button>
                  </span>
                </div>
                {item.kind === 'repo' ? (
                  <Input
                    aria-label={`${nth(index)}的仓库地址`}
                    className="font-mono text-xs"
                    placeholder="例如 https://github.com/me/project.git"
                    value={item.url}
                    disabled={disabled}
                    onChange={(event) => put(index, { ...item, url: event.target.value })}
                  />
                ) : (
                  <div className="grid gap-2">
                    <Select
                      aria-label={`${nth(index)}的机器`}
                      wrapperClassName="flex"
                      value={item.machine_uid}
                      disabled={disabled}
                      onChange={(event) => put(index, { ...item, machine_uid: event.target.value })}
                    >
                      <Option value="">选一台机器</Option>
                      {item.machine_uid !== '' && !known(item.machine_uid) ? <Option value={item.machine_uid}>已删除的机器</Option> : null}
                      {machines.map((machine) => <Option key={machine.uid} value={machine.uid}>{machine.name}</Option>)}
                    </Select>
                    <div className="flex items-center gap-2">
                      <Input
                        aria-label={`${nth(index)}的文件夹`}
                        className="flex-1 font-mono text-xs"
                        placeholder="例如 /home/me/project"
                        value={item.path}
                        disabled={disabled}
                        onChange={(event) => put(index, { ...item, path: event.target.value })}
                      />
                      <Button
                        type="button"
                        size="sm"
                        variant="secondary"
                        disabled={disabled || missing}
                        aria-label={`浏览${nth(index)}的文件夹`}
                        onClick={() => setBrowsingIndex(index)}
                      >
                        <FolderOpen className="size-3.5" />
                        浏览
                      </Button>
                    </div>
                    {missing ? (
                      <Note className="text-xs text-waiting-foreground">
                        {item.machine_uid === '' ? '这一项还没选机器：选一台，活才知道派到哪儿。' : '这一项记的机器不在了：选一台机器。'}
                      </Note>
                    ) : null}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      ) : (
        <Note className="text-xs">没有代码来源：这个项目的活会在空的任务目录里干。</Note>
      )}
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" variant="secondary" disabled={disabled} onClick={() => onChange([...items, blankSource('repo')])}><Plus />加一个仓库</Button>
        <Button type="button" size="sm" variant="secondary" disabled={disabled} onClick={() => onChange([...items, blankSource('folder')])}><Plus />加一个机器上的文件夹</Button>
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
