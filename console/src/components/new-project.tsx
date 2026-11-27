// "新建项目" (docs/design/project-sessions.md §5, docs/design/code-sources.md §4): only the name
// has to be filled; where the code comes from is up to a few optional sources; the rest is
// under "高级". A new project runs on every login. Made, it is opened: its conversation is
// where the owner goes next.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { Details, Field, Mono, Problem } from '@/components/bits';
import { CODE_SOURCE_HINT, SourceEditor } from '@/components/source-list';
import { Button } from '@/components/ui/button';
import { Checkbox, Choice } from '@/components/ui/checkbox';
import { Dialog, DialogActions, DialogContent } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { messageOf, post } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { newProjectBody, withName, withoutName, type NewProjectDraft } from '@/lib/projects';
import { accountsQuery, projectsQuery } from '@/lib/queries';
import type { Project } from '@/lib/types';

const BLANK: NewProjectDraft = { name: '', sources: [], machines: [], spawnMachines: false };

function NewProjectForm({ onMade }: { onMade: (project: Project) => void }) {
  const { t } = useI18n();
  const { data: options } = useQuery(accountsQuery);
  const [draft, setDraft] = useState<NewProjectDraft>(BLANK);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const machines = options?.machines.map(({ uid, id }) => ({ uid, name: id })) ?? [];

  async function create(): Promise<void> {
    setSaving(true);
    setError(null);
    try {
      const { project } = await post<{ project: Project }>('/api/projects', newProjectBody(draft));
      onMade(project);
    } catch (refused) {
      setError(messageOf(refused));
      setSaving(false);
    }
  }

  return (
    <form className="grid gap-4" onSubmit={(event) => { event.preventDefault(); void create(); }}>
      <Field label={t('proj.form.nameLabel')} htmlFor="new-project-name">
        <Input id="new-project-name" aria-label={t('proj.form.nameLabel')} autoFocus value={draft.name} disabled={saving} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
      </Field>
      <Field label={t('proj.new.codeLabel')} hint={t('proj.new.codeHint', { hint: CODE_SOURCE_HINT })}>
        <SourceEditor items={draft.sources} machines={machines} disabled={saving} onChange={(sources) => setDraft({ ...draft, sources })} />
      </Field>
      <Details id="new-project-more" title={t('proj.new.advanced')}>
        <div className="grid gap-3 pt-1 pl-5">
          <p className="text-xs text-muted-foreground">{t('proj.new.advancedHint')}</p>
          {machines.length ? (
            <ul aria-label={t('proj.new.machinesAria')} className="grid">
              {machines.map(({ uid, name }) => (
                <li key={uid}>
                  <Choice>
                    <Checkbox checked={draft.machines.includes(uid)} disabled={saving}
                      onChange={(event) => setDraft({ ...draft, machines: event.target.checked ? withName(draft.machines, uid) : withoutName(draft.machines, uid) })} />
                    <Mono>{name}</Mono>
                  </Choice>
                </li>
              ))}
            </ul>
          ) : null}
          <Choice>
            <Switch aria-label={t('proj.new.spawnAria')} checked={draft.spawnMachines} disabled={saving} onCheckedChange={(on) => setDraft({ ...draft, spawnMachines: on })} />
            {t('proj.settings.spawnLabel')}
          </Choice>
        </div>
      </Details>
      {error ? <Problem role="alert">{error}</Problem> : null}
      <DialogActions>
        <Button type="submit" variant="primary" disabled={saving || draft.name.trim() === ''}>{saving ? t('proj.new.creating') : t('proj.new.create')}</Button>
      </DialogActions>
    </form>
  );
}

export function NewProjectDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useI18n();
  const client = useQueryClient();
  const navigate = useNavigate();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open ? (
        <DialogContent title={t('nav.newProject')} description={t('proj.new.description')}>
          <NewProjectForm
            onMade={(project) => {
              void client.invalidateQueries({ queryKey: projectsQuery.queryKey });
              onOpenChange(false);
              void navigate(`/projects/${encodeURIComponent(project.id)}`);
            }}
          />
        </DialogContent>
      ) : null}
    </Dialog>
  );
}
