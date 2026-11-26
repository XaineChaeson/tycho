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
import { Field, Mono, Note, PRE, Problem, Rows, Time } from '@/components/bits';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox, Choice } from '@/components/ui/checkbox';
import { Dialog, DialogContent, Sheet, SheetContent } from '@/components/ui/dialog';
import { Input, Textarea } from '@/components/ui/input';
import { Segmented } from '@/components/ui/segmented';
import { Option, Select } from '@/components/ui/select';
import { messageOf, post } from '@/lib/api';
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
  return roles.length ? roles.map((id) => names?.roles.find((each) => each.id === id)?.name ?? id).join('、') : ANY_ROLE_LABEL;
}

export const reviewText = (reviewedAt: string | null): string => (reviewedAt === null ? REVIEW_LABELS.unreviewed : REVIEW_LABELS.reviewed);

export const kib = (bytes: number): string => `${(bytes / 1024).toFixed(1)} KiB`;

// How an entry of this kind reaches a round: knowledge by its loading; a skill always as a
// catalog line with its body read when needed (§1).
export const loadingText = (kind: KnowledgeKind, loading: Loading): string => (kind === 'skill' ? KIND_LABELS.skill : LOADING_LABELS[loading]);
export const SKILL_LOADING_TEXT = '技能：每一轮只给目录，正文是快照里的文件；任务点名时全文进说明';

// Each output's scope and loading, as one line.
export const outputsScope = (names: Names | undefined, change: KnowledgeChange): string =>
  change.outputs.map((output) => `${scopeOf(names, output.project_ids, output.roles)} · ${loadingText(change.kind, output.loading)}`).join('；');

// A change in a line: what it puts out, then the entries it retires or has replaced. An entry
// it keeps is only context, and is left out.
export function changeSummary(change: KnowledgeChange, entries: readonly KnowledgeEntry[]): string {
  const titleOf = (id: string) => entries.find((each) => each.id === id)?.title ?? id;
  const kind = change.kind === 'skill' ? KIND_LABELS.skill : '';
  return [
    ...change.outputs.map((output) => `${output.revises === null ? '新增' : '修订'}${kind} ${output.title}`),
    ...change.inputs.filter(({ disposition }) => disposition === 'retire' || disposition === 'replaced')
      .map((input) => `${input.disposition === 'retire' ? '退役' : '取代'} ${titleOf(input.knowledge_id)}`),
  ].join('；');
}

// What a change is called: its first output, else the first entry it touches.
export const changeTitle = (change: KnowledgeChange, entries: readonly KnowledgeEntry[], fallback: string): string =>
  change.outputs[0]?.title ?? (change.inputs[0] ? entries.find((each) => each.id === change.inputs[0]!.knowledge_id)?.title ?? change.inputs[0].knowledge_id : fallback);

const LOADING_HELP = '常驻：每一轮都全文带上，只给每次都必须遵守的方法。按需：只给标题和什么时候用，用到时再读正文。';

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
  if (!evidence.length) return <Note>没有证据。</Note>;
  return (
    <Rows>
      <ol className="divide-y divide-border">
        {evidence.map((item) => (
          <li key={item.id} aria-label={`证据 ${item.seq}`} className="min-w-0 px-3.5 py-3">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={item.verified ? 'plain' : 'waiting'} className="whitespace-normal">{item.verified ? VERIFIED_TEXT : UNVERIFIED_TEXT}</Badge>
              <span className="text-sm font-semibold">{EVIDENCE_SOURCE_LABELS[item.source] ?? item.source}</span>
              {item.ref ? <Mono>{item.ref}</Mono> : null}
            </div>
            <p className="mt-1.5 text-sm wrap-anywhere">{`位置：${item.location}`}</p>
            <p className="mt-0.5 text-xs text-muted-foreground wrap-anywhere">
              <Time at={item.captured_at} prefix="采集于 " />
              {' · 摘要 '}
              <code className="font-mono" title={item.sha256}>{item.sha256.slice(0, 12)}</code>
              {` · 提交者 ${item.submitted_by}`}
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
  scope: '' | 'global' | 'projects';
  projects: string[];
  loading: Loading | '';
  roles: string[];
}

export const BLANK_CANDIDATE: CandidateDraft = { kind: 'knowledge', title: '', when_to_use: '', body: '', scope: 'global', projects: [], loading: 'on_demand', roles: [] };

// The same draft as another kind: a skill is always on demand; SKILL_TEMPLATE stays a placeholder.
export function asKind(draft: CandidateDraft, kind: KnowledgeKind): CandidateDraft {
  if (kind === draft.kind) return draft;
  if (kind === 'skill') return { ...draft, kind, loading: 'on_demand' };
  return { ...draft, kind, loading: draft.loading || 'on_demand' };
}

export const draftOf = (output: Pick<ChangeOutput, 'title' | 'when_to_use' | 'body' | 'project_ids' | 'loading' | 'roles'>, kind: KnowledgeKind = 'knowledge'): CandidateDraft => ({
  kind,
  title: output.title,
  when_to_use: output.when_to_use,
  body: output.body,
  scope: output.project_ids === null ? 'global' : 'projects',
  projects: output.project_ids ?? [],
  loading: output.loading,
  roles: output.roles,
});

// What the service takes: null for 全局, else the projects ticked, as the service keeps them.
const projectIdsOf = (draft: CandidateDraft): string[] | null => (draft.scope === 'global' ? null : [...draft.projects].sort());

export const candidateBody = (draft: CandidateDraft) => ({
  title: draft.title.trim(),
  when_to_use: draft.when_to_use.trim(),
  body: draft.body.trim(),
  project_ids: projectIdsOf(draft),
  ...(draft.kind === 'skill' ? {} : { loading: draft.loading }),
  roles: draft.roles,
});

export const sameCandidate = (a: CandidateDraft, b: CandidateDraft): boolean => JSON.stringify(candidateBody(a)) === JSON.stringify(candidateBody(b));

export const candidateMissing = (draft: CandidateDraft): string[] => [
  ...(draft.title.trim() ? [] : ['标题']),
  ...(draft.body.trim() ? [] : ['正文']),
  ...(draft.scope === '' ? ['作用域'] : draft.scope === 'projects' && draft.projects.length === 0 ? ['作用域里的项目'] : []),
  ...(draft.kind === 'skill' || draft.loading ? [] : ['加载方式']),
];

const SCOPES = [{ value: 'global', label: GLOBAL_LABEL }, { value: 'projects', label: '一组项目' }] as const;
const KINDS = KNOWLEDGE_KINDS.map((value) => ({ value, label: KIND_LABELS[value] }));
const LOADING_CHOICES = LOADINGS.map((value) => ({ value, label: LOADING_LABELS[value] }));

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
  const skill = draft.kind === 'skill';
  return (
    <div className="grid grid-cols-1 gap-4">
      {chooseKind ? (
        <Field label="类型" hint="知识写据什么判断；技能写怎样完成一件事，执行者照着做。">
          <div>
            <Segmented label="类型" value={draft.kind} options={KINDS} disabled={disabled} onChange={(kind) => onChange(asKind(draft, kind))} />
          </div>
        </Field>
      ) : null}
      <Field label="标题">
        <Input aria-label="标题" value={draft.title} disabled={disabled} onChange={(event) => onChange({ ...draft, title: event.target.value })} />
      </Field>
      <Field label="什么时候用（可选）">
        <Textarea aria-label="什么时候用" rows={2} className={LONG} placeholder="可选：下次遇到什么情形该想起它" value={draft.when_to_use} disabled={disabled} onChange={(event) => onChange({ ...draft, when_to_use: event.target.value })} />
      </Field>
      <Field label={skill ? `正文（参考结构：${SKILL_TEMPLATE_TEXT}）` : '正文：结论、依据和边界'}>
        <Textarea aria-label="正文" rows={skill ? 12 : 6} className={cn(LONG, 'min-h-28!')} placeholder={skill ? SKILL_TEMPLATE : '结论是什么，凭什么这么说，到哪里为止不成立'} value={draft.body} disabled={disabled} onChange={(event) => onChange({ ...draft, body: event.target.value })} />
      </Field>
      <Field label="作用域" hint={draft.scope === 'global' ? '全局知识会进每个项目的工作。' : undefined}>
        <div>
          <Segmented label="作用域" value={draft.scope} options={SCOPES} disabled={disabled} onChange={(scope) => onChange({ ...draft, scope })} />
        </div>
        {draft.scope === 'projects' ? (
          names.projects.length
            ? <Ticks legend="项目" items={names.projects} picked={draft.projects} disabled={disabled} onChange={(projects) => onChange({ ...draft, projects })} />
            : <Note className="text-xs">还没有项目。</Note>
        ) : null}
      </Field>
      {skill ? <Note className="text-xs">{SKILL_LOADING_TEXT}</Note> : (
        <Field label="加载方式" hint={LOADING_HELP}>
          <div>
            <Segmented label="加载方式" value={draft.loading} options={LOADING_CHOICES} disabled={disabled} onChange={(loading) => onChange({ ...draft, loading })} />
          </div>
        </Field>
      )}
      <Field label="职能" hint={`只给哪些职能用；一个都不勾就是${ANY_ROLE_LABEL}。`}>
        <Ticks legend="职能" items={names.roles} picked={draft.roles} disabled={disabled} onChange={(roles) => onChange({ ...draft, roles })} />
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
  const { why, setWhy, evidence, setEvidence, blank } = support;
  const edit = (key: number, change: Partial<EvidenceDraft>) => setEvidence((rows) => rows.map((row) => (row.key === key ? { ...row, ...change } : row)));
  return (
    <>
      <div className="grid grid-cols-1 gap-4">
        <Note className="text-xs">以下补充说明与证据均可选，不填也可直接保存。</Note>
        {WHY_KEYS.map((key) => (
          <Field key={key} label={`${WHY_QUESTIONS[key]}（可选）`}>
            <Textarea aria-label={WHY_QUESTIONS[key]} rows={2} className={LONG} value={why[key]} disabled={disabled} onChange={(event) => setWhy({ ...why, [key]: event.target.value })} />
          </Field>
        ))}
      </div>
      <div className="grid grid-cols-1 gap-3">
        {evidence.map((row, index) => (
          <fieldset key={row.key} className={FORM_PART}>
            <legend className={FORM_LEGEND}>{`证据 ${index + 1}`}</legend>
            <div className="flex flex-wrap gap-2">
              <Select aria-label="来源" value={row.source} disabled={disabled} onChange={(event) => edit(row.key, { source: event.target.value as EvidenceSource })}>
                {EVIDENCE_SOURCES.map((source) => <Option key={source} value={source}>{EVIDENCE_SOURCE_LABELS[source]}</Option>)}
              </Select>
              <Input aria-label="来源编号" className="min-w-40 flex-1" placeholder="Run、任务、提交或消息的编号；没有就空着" value={row.ref} disabled={disabled} onChange={(event) => edit(row.key, { ref: event.target.value })} />
            </div>
            <Input aria-label="位置" placeholder="在哪儿：文件和版本、对话的时间、哪条命令（可选）" value={row.location} disabled={disabled} onChange={(event) => edit(row.key, { location: event.target.value })} />
            <Textarea aria-label="摘录" rows={3} className={cn(LONG, 'min-h-16!')} placeholder="实际的原文片段，不是路径或链接；凭据不要摘进来（可选）" value={row.excerpt} disabled={disabled} onChange={(event) => edit(row.key, { excerpt: event.target.value })} />
            <div>
              <Button size="sm" variant="ghost" disabled={disabled} onClick={() => setEvidence((rows) => rows.filter((each) => each.key !== row.key))}>删掉这条</Button>
            </div>
          </fieldset>
        ))}
        <div>
          <Button size="sm" disabled={disabled} onClick={() => setEvidence((rows) => [...rows, blank()])}><Plus />{evidence.length ? '再加一条证据' : '添加证据'}</Button>
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
            {missing.length ? <Note className="basis-full text-xs">{`还差：${missing.join('、')}`}</Note> : unchanged ? <Note className="basis-full text-xs">还没改什么。</Note> : null}
            {action.error ? <Problem role="alert" className="basis-full">{action.error}</Problem> : null}
            <Button variant="primary" disabled={action.busy || missing.length > 0 || unchanged} onClick={() => void save()}>{action.busy ? '保存中' : '保存并生效'}</Button>
            <Button variant="ghost" disabled={action.busy} onClick={onClose}>取消</Button>
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
        title={`退役 ${entry.title}`}
        description="退役后它不再进任何一轮的输入，历史和证据都留着。"
        footer={(
          <>
            <Button variant="ghost" disabled={action.busy} onClick={onClose}>取消</Button>
            <Button variant="danger-solid" disabled={action.busy} onClick={() => void retire()}>{action.busy ? '退役中' : '确认退役'}</Button>
          </>
        )}
      >
        <div className="grid grid-cols-1 gap-3">
          <Textarea aria-label="退役理由" rows={3} className={cn(LONG, 'min-h-16!')} placeholder="退役理由（可选，例如为什么不再成立或不再有用）" value={reason} disabled={action.busy} onChange={(event) => setReason(event.target.value)} />
          {others ? (
            <Select aria-label="替代它的条目" wrapperClassName="flex" value={replacedBy} disabled={action.busy} onChange={(event) => setReplacedBy(event.target.value)}>
              <Option value="">没有替代它的</Option>
              {others.map((other) => <Option key={other.id} value={other.id}>{`${other.title}（${citation(other.id, other.revision)}）`}</Option>)}
            </Select>
          ) : null}
          {action.error ? <Problem role="alert">{action.error}</Problem> : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
