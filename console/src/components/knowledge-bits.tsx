// What the knowledge pages share: how a scope and a change are named, how evidence is shown,
// the fields an entry is written in, how a change to knowledge is sent, and the two things the
// owner does to an entry from more than one page: write a revision of it, and retire it.
import { useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useRef, useState } from 'react';
import {
  ANY_ROLE_LABEL, EVIDENCE_SOURCES, EVIDENCE_SOURCE_LABELS, GLOBAL_LABEL, KIND_LABELS, KNOWLEDGE_KINDS, LOADINGS, LOADING_LABELS, REVIEW_LABELS,
  SKILL_TEMPLATE, SKILL_TEMPLATE_TEXT, UNVERIFIED_TEXT, VERIFIED_TEXT, WHY_QUESTIONS, citation, scopeText, type EvidenceSource, type KnowledgeKind, type Loading,
} from '@shared/knowledge.ts';
import { t as tr } from '@shared/i18n.ts';
import { Field, Mono, Note, PRE, Problem, Rows, Time } from '@/components/bits';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox, Choice } from '@/components/ui/checkbox';
import { Dialog, DialogContent, Sheet, SheetContent } from '@/components/ui/dialog';
import { Input, Textarea } from '@/components/ui/input';
import { Segmented } from '@/components/ui/segmented';
import { Option, Select } from '@/components/ui/select';
import { messageOf, post } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { createRequestId } from '@/lib/ids';
import { KNOWLEDGE, PAGE } from '@/lib/queries';
import type { ChangeOutput, KnowledgeChange, KnowledgeEntry, KnowledgeEvidence, KnowledgePage, KnowledgeWhy } from '@/lib/types';
import { cn } from '@/lib/utils';

export const proposalPath = (id: string): string => `/knowledge/proposals/${encodeURIComponent(id)}`;
export const entryPath = (id: string): string => `/knowledge/entries/${encodeURIComponent(id)}`;

// A row of a list that is one link: the whole line is the target.
export const ROW_LINK = 'block px-3.5 py-2.5 text-sm no-underline transition-colors duration-100 hover:bg-muted focus-visible:-outline-offset-2';

// The names a scope is shown by. A project or role that is gone is shown by its id.
export type Names = Pick<KnowledgePage, 'projects' | 'roles'>;

export function scopeOf(names: Names | undefined, projectIds: readonly string[] | null, roles: readonly string[] | null): string {
  const projects = projectIds === null ? null : projectIds.map((id) => names?.projects.find((each) => each.id === id)?.name ?? id);
  return scopeText(projects, (roles ?? []).map((id) => names?.roles.find((each) => each.id === id)?.name ?? id));
}

export function rolesText(names: Names | undefined, roles: readonly string[]): string {
  return roles.length ? roles.map((id) => names?.roles.find((each) => each.id === id)?.name ?? id).join(tr('know.listSep')) : ANY_ROLE_LABEL;
}

export const reviewText = (reviewedAt: string | null): string => (reviewedAt === null ? REVIEW_LABELS.unreviewed : REVIEW_LABELS.reviewed);

export const kib = (bytes: number): string => `${(bytes / 1024).toFixed(1)} KiB`;

// How an entry of this kind reaches a round: knowledge by its loading; a skill always as a
// catalog line with its body read when needed (§1).
export const loadingText = (kind: KnowledgeKind, loading: Loading): string => (kind === 'skill' ? KIND_LABELS.skill : LOADING_LABELS[loading]);
export const skillLoadingText = (): string => tr('know.bits.skillLoadingText');

// Each output's scope and loading, as one line.
export const outputsScope = (names: Names | undefined, change: KnowledgeChange): string =>
  change.outputs.map((output) => `${scopeOf(names, output.project_ids, output.roles)} · ${loadingText(change.kind, output.loading)}`).join(tr('know.itemSep'));

// A change in a line: what it puts out, then the entries it retires or has replaced. An entry
// it keeps is only context, and is left out.
export function changeSummary(change: KnowledgeChange, entries: readonly KnowledgeEntry[]): string {
  const titleOf = (id: string) => entries.find((each) => each.id === id)?.title ?? id;
  const isSkill = change.kind === 'skill';
  return [
    ...change.outputs.map((output) => {
      const key = output.revises === null
        ? (isSkill ? 'know.bits.changeAddSkill' : 'know.bits.changeAdd')
        : (isSkill ? 'know.bits.changeReviseSkill' : 'know.bits.changeRevise');
      return tr(key, { title: output.title });
    }),
    ...change.inputs
      .filter(({ disposition }) => disposition === 'retire' || disposition === 'replaced')
      .map((input) => tr(input.disposition === 'retire' ? 'know.bits.changeRetire' : 'know.bits.changeReplace', { title: titleOf(input.knowledge_id) })),
  ].join(tr('know.itemSep'));
}

// What a change is called: its first output, else the first entry it touches.
export const changeTitle = (change: KnowledgeChange, entries: readonly KnowledgeEntry[], fallback: string): string =>
  change.outputs[0]?.title ?? (change.inputs[0] ? entries.find((each) => each.id === change.inputs[0]!.knowledge_id)?.title ?? change.inputs[0].knowledge_id : fallback);

// A change to knowledge, sent one at a time. Whatever the answer, the knowledge pages read
// again: a refusal often means the change moved meanwhile (published, stale, superseded).
export function useKnowledgeAction() {
  const client = useQueryClient();
  const sending = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function run<T>(request: () => Promise<T>, done?: (answer: T) => void): Promise<void> {
    if (sending.current) return;
    sending.current = true;
    setBusy(true);
    setError(null);
    try {
      const answer = await request();
      done?.(answer);
    } catch (refused) {
      setError(messageOf(refused));
    } finally {
      sending.current = false;
      setBusy(false);
      void client.invalidateQueries({ queryKey: KNOWLEDGE });
      void client.invalidateQueries({ queryKey: [PAGE, 'knowledge-effective'] });
    }
  }
  return { busy, error, run, clear: () => setError(null) };
}

export type KnowledgeAction = ReturnType<typeof useKnowledgeAction>;

export function EvidenceList({ evidence }: { evidence: readonly KnowledgeEvidence[] }) {
  const { t } = useI18n();
  if (!evidence.length) return <Note>{t('know.bits.noEvidence')}</Note>;
  return (
    <Rows>
      <ol className="divide-y divide-border">
        {evidence.map((item) => (
          <li key={item.id} aria-label={t('know.bits.evidenceSeq', { seq: item.seq })} className="min-w-0 px-3.5 py-3">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={item.verified ? 'plain' : 'waiting'} className="whitespace-normal">{item.verified ? VERIFIED_TEXT : UNVERIFIED_TEXT}</Badge>
              <span className="text-sm font-semibold">{EVIDENCE_SOURCE_LABELS[item.source] ?? item.source}</span>
              {item.ref ? <Mono>{item.ref}</Mono> : null}
            </div>
            <p className="mt-1.5 text-sm wrap-anywhere">{t('know.bits.evidenceLocation', { location: item.location })}</p>
            <p className="mt-0.5 text-xs text-muted-foreground wrap-anywhere">
              <Time at={item.captured_at} prefix={t('know.bits.capturedPrefix')} />
              {t('know.bits.digestMid')}
              <code className="font-mono" title={item.sha256}>{item.sha256.slice(0, 12)}</code>
              {t('know.bits.submittedByMid', { by: item.submitted_by })}
            </p>
            <pre className={cn(PRE, 'mt-2')}>{item.excerpt}</pre>
          </li>
        ))}
      </ol>
    </Rows>
  );
}

// Default scope is global and default loading is on demand, matching the service.
// A skill has no loading to choose: it is always on demand.
export interface CandidateDraft {
  kind: KnowledgeKind;
  title: string;
  when_to_use: string;
  body: string;
  search_phrases: string;
  scope: '' | 'global' | 'projects';
  projects: string[];
  loading: Loading | '';
  roles: string[];
}

export const BLANK_CANDIDATE: CandidateDraft = { kind: 'knowledge', title: '', when_to_use: '', body: '', search_phrases: '', scope: 'global', projects: [], loading: 'on_demand', roles: [] };

// The same draft as another kind: a skill is always on demand; SKILL_TEMPLATE stays a placeholder.
export function asKind(draft: CandidateDraft, kind: KnowledgeKind): CandidateDraft {
  if (kind === draft.kind) return draft;
  if (kind === 'skill') return { ...draft, kind, loading: 'on_demand' };
  return { ...draft, kind, loading: draft.loading || 'on_demand' };
}

export const draftOf = (output: Pick<ChangeOutput, 'title' | 'when_to_use' | 'body' | 'project_ids' | 'loading' | 'roles' | 'search_phrases'>, kind: KnowledgeKind = 'knowledge'): CandidateDraft => ({
  kind,
  title: output.title,
  when_to_use: output.when_to_use,
  body: output.body,
  search_phrases: (output.search_phrases ?? []).join(', '),
  scope: output.project_ids === null ? 'global' : 'projects',
  projects: output.project_ids ?? [],
  loading: output.loading,
  roles: output.roles,
});

// What the service takes: null for 全局, else the projects ticked, as the service keeps them.
const projectIdsOf = (draft: CandidateDraft): string[] | null => (draft.scope === 'global' ? null : [...draft.projects].sort());

function parseSearchPhrases(raw: string): string[] {
  return raw
    .split(/[\n,，]+/)
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 3);
}

export const candidateBody = (draft: CandidateDraft) => {
  const searchPhrases = parseSearchPhrases(draft.search_phrases);
  return {
    title: draft.title.trim(),
    when_to_use: draft.when_to_use.trim(),
    body: draft.body.trim(),
    ...(searchPhrases.length > 0 ? { search_phrases: searchPhrases } : {}),
    project_ids: projectIdsOf(draft),
    ...(draft.kind === 'skill' ? {} : { loading: draft.loading }),
    roles: draft.roles,
  };
};

export const sameCandidate = (a: CandidateDraft, b: CandidateDraft): boolean => JSON.stringify(candidateBody(a)) === JSON.stringify(candidateBody(b));

export const candidateMissing = (draft: CandidateDraft): string[] => [
  ...(draft.title.trim() ? [] : [tr('know.field.title')]),
  ...(draft.body.trim() ? [] : [tr('know.field.body')]),
  ...(draft.scope === '' ? [tr('know.field.scope')] : draft.scope === 'projects' && draft.projects.length === 0 ? [tr('know.bits.missingScopeProjects')] : []),
  ...(draft.kind === 'skill' || draft.loading ? [] : [tr('know.field.loading')]),
];

function Ticks({ legend, items, picked, disabled, onChange }: {
  legend: string;
  items: readonly { id: string; name: string }[];
  picked: readonly string[];
  disabled: boolean;
  onChange: (picked: string[]) => void;
}) {
  return (
    <fieldset className="min-w-0">
      <legend className="sr-only">{legend}</legend>
      <ul className="flex flex-wrap gap-x-5">
        {items.map((item) => (
          <li key={item.id}>
            <Choice>
              <Checkbox
                checked={picked.includes(item.id)}
                disabled={disabled}
                onChange={(event) => onChange(event.target.checked ? [...picked, item.id] : picked.filter((each) => each !== item.id))}
              />
              {item.name}
            </Choice>
          </li>
        ))}
      </ul>
    </fieldset>
  );
}

// A long text stops growing where it would push the rest of the form off the screen. Where one
// starts taller than a line, the height is forced (`!`): the field's own least height is a size
// of this theme that the class merger does not know to drop.
const LONG = 'max-h-[45vh] overflow-y-auto';

// Every control is named by its own label, not by the caption over it: what is typed into it
// never becomes part of its name.
// `chooseKind`: a new entry, whose kind is still to be chosen; an entry's kind never changes.
export function CandidateFields({ draft, names, disabled, onChange, chooseKind = false }: { draft: CandidateDraft; names: Names; disabled: boolean; onChange: (draft: CandidateDraft) => void; chooseKind?: boolean }) {
  const { t } = useI18n();
  const skill = draft.kind === 'skill';
  const scopes = [{ value: 'global', label: GLOBAL_LABEL }, { value: 'projects', label: t('know.bits.scopeProjects') }] as const;
  const kinds = KNOWLEDGE_KINDS.map((value) => ({ value, label: KIND_LABELS[value] }));
  const loadingChoices = LOADINGS.map((value) => ({ value, label: LOADING_LABELS[value] }));
  return (
    <div className="grid grid-cols-1 gap-4">
      {chooseKind ? (
        <Field label={t('know.field.kind')} hint={t('know.bits.kindHint')}>
          <div>
            <Segmented label={t('know.field.kind')} value={draft.kind} options={kinds} disabled={disabled} onChange={(kind) => onChange(asKind(draft, kind))} />
          </div>
        </Field>
      ) : null}
      <Field label={t('know.field.title')}>
        <Input aria-label={t('know.field.title')} value={draft.title} disabled={disabled} onChange={(event) => onChange({ ...draft, title: event.target.value })} />
      </Field>
      <Field label={t('know.bits.whenToUseOptional')}>
        <Textarea aria-label={t('know.field.whenToUse')} rows={2} className={LONG} placeholder={t('know.bits.whenToUsePlaceholder')} value={draft.when_to_use} disabled={disabled} onChange={(event) => onChange({ ...draft, when_to_use: event.target.value })} />
      </Field>
      <Field label={skill ? t('know.bits.skillBodyLabel', { template: SKILL_TEMPLATE_TEXT }) : t('know.bits.knowledgeBodyLabel')}>
        <Textarea aria-label={t('know.field.body')} rows={skill ? 12 : 6} className={cn(LONG, 'min-h-28!')} placeholder={skill ? SKILL_TEMPLATE : t('know.bits.knowledgeBodyPlaceholder')} value={draft.body} disabled={disabled} onChange={(event) => onChange({ ...draft, body: event.target.value })} />
      </Field>
      <Field label={t('know.bits.searchPhrasesLabel')} hint={t('know.bits.searchPhrasesHint')}>
        <Input aria-label={t('know.bits.searchPhrasesLabel')} placeholder={t('know.bits.searchPhrasesPlaceholder')} value={draft.search_phrases} disabled={disabled} onChange={(event) => onChange({ ...draft, search_phrases: event.target.value })} />
      </Field>
      <Field label={t('know.field.scope')} hint={draft.scope === 'global' ? t('know.bits.globalScopeHint') : undefined}>
        <div>
          <Segmented label={t('know.field.scope')} value={draft.scope} options={scopes} disabled={disabled} onChange={(scope) => onChange({ ...draft, scope })} />
        </div>
        {draft.scope === 'projects' ? (
          names.projects.length
            ? <Ticks legend={t('know.bits.projectsLegend')} items={names.projects} picked={draft.projects} disabled={disabled} onChange={(projects) => onChange({ ...draft, projects })} />
            : <Note className="text-xs">{t('know.noProjects')}</Note>
        ) : null}
      </Field>
      {skill ? <Note className="text-xs">{t('know.bits.skillLoadingText')}</Note> : (
        <Field label={t('know.field.loading')} hint={t('know.bits.loadingHelp')}>
          <div>
            <Segmented label={t('know.field.loading')} value={draft.loading} options={loadingChoices} disabled={disabled} onChange={(loading) => onChange({ ...draft, loading })} />
          </div>
        </Field>
      )}
      <Field label={t('know.field.role')} hint={t('know.bits.rolesHint', { anyRole: ANY_ROLE_LABEL })}>
        <Ticks legend={t('know.bits.rolesLegend')} items={names.roles} picked={draft.roles} disabled={disabled} onChange={(roles) => onChange({ ...draft, roles })} />
      </Field>
    </div>
  );
}

interface EvidenceDraft {
  key: number;
  source: EvidenceSource;
  ref: string;
  location: string;
  excerpt: string;
}

const WHY_KEYS = Object.keys(WHY_QUESTIONS) as (keyof KnowledgeWhy)[];

// Optional answers ("why") and evidence the owner may attach; never blocks submission.
function useSupport() {
  const keys = useRef(1);
  const blank = (): EvidenceDraft => ({ key: keys.current++, source: 'owner', ref: '', location: '', excerpt: '' });
  const [why, setWhy] = useState<KnowledgeWhy>({ when: '', changes: '', generalizes: '' });
  const [evidence, setEvidence] = useState<EvidenceDraft[]>(() => [blank()]);
  return {
    why, setWhy, evidence, setEvidence, blank,
    payload: () => {
      const filledWhy = { when: why.when.trim(), changes: why.changes.trim(), generalizes: why.generalizes.trim() };
      const hasWhy = WHY_KEYS.some((key) => filledWhy[key] !== '');
      const filledEvidence = evidence
        .filter((row) => row.ref.trim() !== '' || row.location.trim() !== '' || row.excerpt.trim() !== '')
        .map((row) => ({
          source: row.source,
          ...(row.ref.trim() ? { ref: row.ref.trim() } : {}),
          location: row.location.trim(),
          excerpt: row.excerpt.trim(),
        }));
      return {
        ...(hasWhy ? { why: filledWhy } : {}),
        ...(filledEvidence.length > 0 ? { evidence: filledEvidence } : {}),
      };
    },
  };
}

// One part of a long form, set off from the part above it.
export const FORM_PART = 'grid min-w-0 grid-cols-1 gap-3 rounded-lg border border-border p-3.5';
export const FORM_LEGEND = 'px-1 text-sm font-semibold';

function SupportFields({ support, disabled }: { support: ReturnType<typeof useSupport>; disabled: boolean }) {
  const { t } = useI18n();
  const { why, setWhy, evidence, setEvidence, blank } = support;
  const edit = (key: number, change: Partial<EvidenceDraft>) => setEvidence((rows) => rows.map((row) => (row.key === key ? { ...row, ...change } : row)));
  return (
    <>
      <div className="grid grid-cols-1 gap-4">
        <Note className="text-xs">{t('know.bits.supportOptionalNote')}</Note>
        {WHY_KEYS.map((key) => (
          <Field key={key} label={t('know.bits.optionalLabel', { label: WHY_QUESTIONS[key] })}>
            <Textarea aria-label={WHY_QUESTIONS[key]} rows={2} className={LONG} value={why[key]} disabled={disabled} onChange={(event) => setWhy({ ...why, [key]: event.target.value })} />
          </Field>
        ))}
      </div>
      <div className="grid grid-cols-1 gap-3">
        {evidence.map((row, index) => (
          <fieldset key={row.key} className={FORM_PART}>
            <legend className={FORM_LEGEND}>{t('know.bits.evidenceSeq', { seq: index + 1 })}</legend>
            <div className="flex flex-wrap gap-2">
              <Select aria-label={t('know.bits.evidenceSourceLabel')} value={row.source} disabled={disabled} onChange={(event) => edit(row.key, { source: event.target.value as EvidenceSource })}>
                {EVIDENCE_SOURCES.map((source) => <Option key={source} value={source}>{EVIDENCE_SOURCE_LABELS[source]}</Option>)}
              </Select>
              <Input aria-label={t('know.bits.evidenceRefLabel')} className="min-w-40 flex-1" placeholder={t('know.bits.evidenceRefPlaceholder')} value={row.ref} disabled={disabled} onChange={(event) => edit(row.key, { ref: event.target.value })} />
            </div>
            <Input aria-label={t('know.bits.evidenceLocationLabel')} placeholder={t('know.bits.evidenceLocationPlaceholder')} value={row.location} disabled={disabled} onChange={(event) => edit(row.key, { location: event.target.value })} />
            <Textarea aria-label={t('know.bits.evidenceExcerptLabel')} rows={3} className={cn(LONG, 'min-h-16!')} placeholder={t('know.bits.evidenceExcerptPlaceholder')} value={row.excerpt} disabled={disabled} onChange={(event) => edit(row.key, { excerpt: event.target.value })} />
            <div>
              <Button size="sm" variant="ghost" disabled={disabled} onClick={() => setEvidence((rows) => rows.filter((each) => each.key !== row.key))}>{t('know.bits.removeEvidence')}</Button>
            </div>
          </fieldset>
        ))}
        <div>
          <Button size="sm" disabled={disabled} onClick={() => setEvidence((rows) => [...rows, blank()])}><Plus />{evidence.length ? t('know.bits.addAnotherEvidence') : t('know.bits.addEvidence')}</Button>
        </div>
      </div>
    </>
  );
}

// A drawer that holds paragraphs the owner typed: a stray click on the page behind it does not
// throw them away. Escape, its close button and 取消 still do.
export const keepDraft = { onInteractOutside: (event: Event): void => event.preventDefault() };

// The owner writes an entry, new or a revision of one in force: it is a change like any other,
// with its answers and evidence, and takes effect at once (§3: the owner is its own gate).
// It is a drawer beside the page, there while it is mounted: each time it opens is a new form.
export function OwnerChangeForm({ label, lead, names, initial, edits = false, chooseKind = false, wrap, onSaved, onClose }: {
  label: string;
  lead: string;
  names: Names;
  initial: CandidateDraft;
  // A new entry: its kind is chosen on the form.
  chooseKind?: boolean;
  // An edit of an entry: saving it unchanged would make a revision that changes nothing.
  edits?: boolean;
  // The change around the one output this form writes.
  wrap: (output: ReturnType<typeof candidateBody>) => Record<string, unknown>;
  onSaved: (answer: { id: string }) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  // Made once, when the form opens: a submit sent twice, or again after a refusal, is the
  // same change to the service.
  const [requestId] = useState(() => createRequestId());
  const [draft, setDraft] = useState<CandidateDraft>(initial);
  const support = useSupport();
  const action = useKnowledgeAction();
  const unchanged = edits && sameCandidate(draft, initial);
  const missing = candidateMissing(draft);
  const save = () => action.run(
    () => post<{ id: string }>('/api/knowledge/proposals', { kind: draft.kind, ...wrap(candidateBody(draft)), ...support.payload(), request_id: requestId }),
    onSaved,
  );
  return (
    <Sheet open onOpenChange={(open) => { if (!open && !action.busy) onClose(); }}>
      <SheetContent
        title={label}
        description={lead}
        {...keepDraft}
        footer={(
          <>
            {missing.length ? <Note className="basis-full text-xs">{t('know.bits.missingFields', { fields: missing.join(t('know.listSep')) })}</Note> : unchanged ? <Note className="basis-full text-xs">{t('know.bits.nothingChanged')}</Note> : null}
            {action.error ? <Problem role="alert" className="basis-full">{action.error}</Problem> : null}
            <Button variant="primary" disabled={action.busy || missing.length > 0 || unchanged} onClick={() => void save()}>{action.busy ? t('know.saving') : t('know.bits.saveAndPublish')}</Button>
            <Button variant="ghost" disabled={action.busy} onClick={onClose}>{t('common.cancel')}</Button>
          </>
        )}
      >
        <div className="grid grid-cols-1 gap-6">
          <CandidateFields draft={draft} names={names} disabled={action.busy} onChange={setDraft} chooseKind={chooseKind} />
          <SupportFields support={support} disabled={action.busy} />
        </div>
      </SheetContent>
    </Sheet>
  );
}

// Retiring an entry: why, what replaces it where the page can say (`others`), and the one
// press that does it. It is there while it is mounted.
export function RetireDialog({ entry, others, onClose }: {
  entry: KnowledgeEntry;
  // The entries that could replace it. Left out, no replacement is asked for or sent.
  others?: readonly KnowledgeEntry[];
  onClose: () => void;
}) {
  const { t } = useI18n();
  const action = useKnowledgeAction();
  const [reason, setReason] = useState('');
  const [replacedBy, setReplacedBy] = useState('');
  const retire = () => action.run(
    // Against the revision the owner is looking at: one published meanwhile is refused.
    () => post(`/api/knowledge/entries/${encodeURIComponent(entry.id)}/retire`, { reason: reason.trim(), ...(others ? { replaced_by: replacedBy || null } : {}), revision: entry.revision }),
    onClose,
  );
  return (
    <Dialog open onOpenChange={(open) => { if (!open && !action.busy) onClose(); }}>
      <DialogContent
        title={t('know.retire.title', { title: entry.title })}
        description={t('know.retire.desc')}
        footer={(
          <>
            <Button variant="ghost" disabled={action.busy} onClick={onClose}>{t('common.cancel')}</Button>
            <Button variant="danger-solid" disabled={action.busy} onClick={() => void retire()}>{action.busy ? t('know.retire.busy') : t('know.retire.confirm')}</Button>
          </>
        )}
      >
        <div className="grid grid-cols-1 gap-3">
          <Textarea aria-label={t('know.retire.reasonLabel')} rows={3} className={cn(LONG, 'min-h-16!')} placeholder={t('know.retire.reasonPlaceholder')} value={reason} disabled={action.busy} onChange={(event) => setReason(event.target.value)} />
          {others ? (
            <Select aria-label={t('know.retire.replacedByLabel')} wrapperClassName="flex" value={replacedBy} disabled={action.busy} onChange={(event) => setReplacedBy(event.target.value)}>
              <Option value="">{t('know.retire.noReplacement')}</Option>
              {others.map((other) => <Option key={other.id} value={other.id}>{t('know.retire.replacementOption', { title: other.title, ref: citation(other.id, other.revision) })}</Option>)}
            </Select>
          ) : null}
          {action.error ? <Problem role="alert">{action.error}</Problem> : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
