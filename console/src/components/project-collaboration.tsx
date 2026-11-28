// Project Collaboration tab (Project › Collaboration):
// - Authorized Domain Wiki vaults linked to this project
// - Cross-project pinned read-only refs (incoming & outgoing) with explicit copy-delivery notice & revocation
// - Intra-project task artifact contracts (producer -> consumer) with delivery, blocking, and bounded clarification
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeftRight, BookOpen, FileCheck2, MessageSquareWarning, Plus, ShieldAlert, Trash2, X } from 'lucide-react';
import { useId, useMemo, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import {
  CROSS_PROJECT_REF_KINDS,
  CROSS_PROJECT_REF_KIND_LABELS,
  TASK_CONTRACT_STATUS_LABELS,
  type CrossProjectRef,
  type CrossProjectRefKind,
  type TaskContract,
} from '@shared/collaboration.ts';
import { Callout, Card, Empty, Field, Mono, Note, Problem, Rows, SectionTitle, Time } from '@/components/bits';
import { PageLead } from '@/components/page';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Confirm, Dialog, DialogContent, Sheet, SheetContent } from '@/components/ui/dialog';
import { Input, Textarea } from '@/components/ui/input';
import { Option, Select } from '@/components/ui/select';
import { del, messageOf, post } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { knowledgeQuery, projectCollaborationQuery, projectFilesQuery, projectsQuery, tasksQuery } from '@/lib/queries';
import type { Project, Task } from '@/lib/types';

const CONTRACT_TONE: Record<string, 'plain' | 'success' | 'waiting' | 'failed' | 'ended'> = {
  pending: 'plain',
  delivered: 'success',
  blocked: 'waiting',
  clarified: 'success',
  superseded: 'ended',
};

function GrantRefSheet({
  projectId,
  otherProjects,
  onGranted,
  onClose,
}: {
  projectId: string;
  otherProjects: readonly Project[];
  onGranted: () => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const { data: filesData } = useQuery(projectFilesQuery(projectId));
  const { data: knowledgeData } = useQuery(knowledgeQuery);
  const targetId = useId();
  const kindId = useId();
  const pickId = useId();
  const sourceIdInput = useId();
  const versionId = useId();
  const titleId = useId();
  const summaryId = useId();

  const [targetProjectId, setTargetProjectId] = useState(otherProjects[0]?.id ?? '');
  const [refKind, setRefKind] = useState<CrossProjectRefKind>('project_file');
  const [sourceRefId, setSourceRefId] = useState('');
  const [pinnedVersion, setPinnedVersion] = useState('');
  const [title, setTitle] = useState('');
  const [summary, setSummary] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const projectKnowledge = useMemo(
    () => (knowledgeData?.entries ?? []).filter((e) => e.state === 'active' && (e.project_ids === null || e.project_ids.includes(projectId))),
    [knowledgeData, projectId],
  );
  const projectFiles = filesData?.files ?? [];

  async function handleSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setSubmitted(true);
    if (!targetProjectId || !sourceRefId.trim()) {
      setError(t('know.bits.missingFields', {
        fields: [
          ...(!targetProjectId ? [t('proj.collab.grantTargetProject')] : []),
          ...(!sourceRefId.trim() ? [t('proj.collab.grantSourceManual')] : []),
        ].join(t('know.listSep')),
      }));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await post(`/api/projects/${encodeURIComponent(projectId)}/refs`, {
        target_project_id: targetProjectId,
        ref_kind: refKind,
        source_ref_id: sourceRefId.trim(),
        ...(pinnedVersion.trim() ? { pinned_version: pinnedVersion.trim() } : {}),
        ...(title.trim() ? { title: title.trim() } : {}),
        ...(summary.trim() ? { summary: summary.trim() } : {}),
      });
      onGranted();
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet open onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
      <SheetContent
        title={t('proj.collab.grantTitle')}
        footer={(
          <>
            <Button type="submit" form="grant-ref-form" variant="primary" disabled={busy}>
              {busy ? t('proj.collab.granting') : t('proj.collab.grantSubmit')}
            </Button>
            <Button type="button" variant="ghost" disabled={busy} onClick={onClose}>
              {t('common.cancel')}
            </Button>
          </>
        )}
      >
        <form id="grant-ref-form" noValidate onSubmit={(e) => void handleSubmit(e)} className="grid grid-cols-1 gap-4">
          <Callout tone="waiting" role="note">
            <div className="flex items-start gap-2 text-xs">
              <ShieldAlert className="mt-0.5 size-4 flex-none" aria-hidden="true" />
              <span>{t('proj.collab.grantCopyWarning')}</span>
            </div>
          </Callout>

          <Field label={t('proj.collab.grantTargetProject')} htmlFor={targetId}>
            <Select
              id={targetId}
              wrapperClassName="flex"
              value={targetProjectId}
              disabled={busy}
              aria-invalid={submitted && !targetProjectId ? 'true' : 'false'}
              onChange={(e) => setTargetProjectId(e.target.value)}
            >
              <Option value="">{t('proj.collab.grantTargetPlaceholder')}</Option>
              {otherProjects.map((p) => <Option key={p.id} value={p.id}>{p.name}</Option>)}
            </Select>
          </Field>

          <Field label={t('proj.collab.grantKind')} htmlFor={kindId}>
            <Select
              id={kindId}
              wrapperClassName="flex"
              value={refKind}
              disabled={busy}
              onChange={(e) => {
                setRefKind(e.target.value as CrossProjectRefKind);
                setSourceRefId('');
              }}
            >
              {CROSS_PROJECT_REF_KINDS.map((kind) => (
                <Option key={kind} value={kind}>{CROSS_PROJECT_REF_KIND_LABELS[kind]}</Option>
              ))}
            </Select>
          </Field>

          {refKind === 'project_file' && projectFiles.length > 0 ? (
            <Field label={t('proj.collab.grantSourceItem')} htmlFor={pickId}>
              <Select
                id={pickId}
                wrapperClassName="flex"
                value={sourceRefId}
                disabled={busy}
                onChange={(e) => {
                  const id = e.target.value;
                  setSourceRefId(id);
                  const chosen = projectFiles.find((f) => f.id === id);
                  if (chosen && !title.trim()) setTitle(chosen.name);
                }}
              >
                <Option value="">{t('proj.collab.grantSourcePlaceholder')}</Option>
                {projectFiles.map((f) => <Option key={f.id} value={f.id}>{f.name}</Option>)}
              </Select>
            </Field>
          ) : null}

          {refKind === 'knowledge' && projectKnowledge.length > 0 ? (
            <Field label={t('proj.collab.grantSourceItem')} htmlFor={pickId}>
              <Select
                id={pickId}
                wrapperClassName="flex"
                value={sourceRefId}
                disabled={busy}
                onChange={(e) => {
                  const id = e.target.value;
                  setSourceRefId(id);
                  const chosen = projectKnowledge.find((k) => k.id === id);
                  if (chosen) {
                    if (!title.trim()) setTitle(chosen.title);
                    if (!pinnedVersion.trim()) setPinnedVersion(`rev:${chosen.revision}`);
                  }
                }}
              >
                <Option value="">{t('proj.collab.grantSourcePlaceholder')}</Option>
                {projectKnowledge.map((k) => <Option key={k.id} value={k.id}>{`${k.title} (v${k.revision})`}</Option>)}
              </Select>
            </Field>
          ) : null}

          <Field label={t('proj.collab.grantSourceManual')} htmlFor={sourceIdInput}>
            <Input
              id={sourceIdInput}
              required
              aria-invalid={submitted && !sourceRefId.trim() ? 'true' : 'false'}
              placeholder={t('proj.collab.grantSourcePlaceholder')}
              value={sourceRefId}
              disabled={busy}
              onChange={(e) => setSourceRefId(e.target.value)}
            />
          </Field>

          <Field label={t('proj.collab.grantVersion')} htmlFor={versionId}>
            <Input
              id={versionId}
              placeholder={t('proj.collab.grantVersionPlaceholder')}
              value={pinnedVersion}
              disabled={busy}
              onChange={(e) => setPinnedVersion(e.target.value)}
            />
          </Field>

          <Field label={t('proj.collab.grantTitleField')} htmlFor={titleId}>
            <Input id={titleId} value={title} disabled={busy} onChange={(e) => setTitle(e.target.value)} />
          </Field>

          <Field label={t('proj.collab.grantSummaryField')} htmlFor={summaryId}>
            <Textarea id={summaryId} rows={2} value={summary} disabled={busy} onChange={(e) => setSummary(e.target.value)} />
          </Field>

          {error ? <Problem role="alert">{error}</Problem> : null}
        </form>
      </SheetContent>
    </Sheet>
  );
}

function CreateContractSheet({
  projectId,
  projectTasks,
  onCreated,
  onClose,
}: {
  projectId: string;
  projectTasks: readonly Task[];
  onCreated: () => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const producerIdField = useId();
  const consumerIdField = useId();
  const nameField = useId();
  const pathField = useId();

  const [producerTaskId, setProducerTaskId] = useState(projectTasks[0]?.id ?? '');
  const [consumerTaskId, setConsumerTaskId] = useState(projectTasks[1]?.id ?? '');
  const [contractName, setContractName] = useState('');
  const [artifactPath, setArtifactPath] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setSubmitted(true);
    if (!producerTaskId || !consumerTaskId || !contractName.trim() || !artifactPath.trim()) {
      setError(t('know.bits.missingFields', {
        fields: [
          ...(!producerTaskId ? [t('proj.collab.contractProducer')] : []),
          ...(!consumerTaskId ? [t('proj.collab.contractConsumer')] : []),
          ...(!contractName.trim() ? [t('proj.collab.contractName')] : []),
          ...(!artifactPath.trim() ? [t('proj.collab.contractPath')] : []),
        ].join(t('know.listSep')),
      }));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await post(`/api/projects/${encodeURIComponent(projectId)}/contracts`, {
        producer_task_id: producerTaskId,
        consumer_task_id: consumerTaskId,
        contract_name: contractName.trim(),
        artifact_path: artifactPath.trim(),
      });
      onCreated();
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet open onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
      <SheetContent
        title={t('proj.collab.contractCreateTitle')}
        footer={(
          <>
            <Button type="submit" form="create-contract-form" variant="primary" disabled={busy}>
              {t('proj.collab.contractCreateSubmit')}
            </Button>
            <Button type="button" variant="ghost" disabled={busy} onClick={onClose}>
              {t('common.cancel')}
            </Button>
          </>
        )}
      >
        <form id="create-contract-form" noValidate onSubmit={(e) => void handleSubmit(e)} className="grid grid-cols-1 gap-4">
          <Field label={t('proj.collab.contractProducer')} htmlFor={producerIdField}>
            <Select id={producerIdField} wrapperClassName="flex" value={producerTaskId} disabled={busy} onChange={(e) => setProducerTaskId(e.target.value)}>
              {projectTasks.map((task) => <Option key={task.id} value={task.id}>{task.title}</Option>)}
            </Select>
          </Field>
          <Field label={t('proj.collab.contractConsumer')} htmlFor={consumerIdField}>
            <Select id={consumerIdField} wrapperClassName="flex" value={consumerTaskId} disabled={busy} onChange={(e) => setConsumerTaskId(e.target.value)}>
              {projectTasks.map((task) => <Option key={task.id} value={task.id}>{task.title}</Option>)}
            </Select>
          </Field>
          <Field label={t('proj.collab.contractName')} htmlFor={nameField}>
            <Input
              id={nameField}
              required
              aria-invalid={submitted && !contractName.trim() ? 'true' : 'false'}
              placeholder={t('proj.collab.contractNamePlaceholder')}
              value={contractName}
              disabled={busy}
              onChange={(e) => setContractName(e.target.value)}
            />
          </Field>
          <Field label={t('proj.collab.contractPath')} htmlFor={pathField}>
            <Input
              id={pathField}
              required
              aria-invalid={submitted && !artifactPath.trim() ? 'true' : 'false'}
              placeholder={t('proj.collab.contractPathPlaceholder')}
              value={artifactPath}
              disabled={busy}
              onChange={(e) => setArtifactPath(e.target.value)}
            />
          </Field>
          {error ? <Problem role="alert">{error}</Problem> : null}
        </form>
      </SheetContent>
    </Sheet>
  );
}

type ContractModal =
  | { kind: 'deliver'; contract: TaskContract }
  | { kind: 'block'; contract: TaskContract }
  | { kind: 'clarify'; contract: TaskContract; clarificationId: string }
  | null;

export function ProjectCollaboration({ projectId }: { projectId: string }) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const { data, isPending, error } = useQuery(projectCollaborationQuery(projectId));
  const { data: allProjects } = useQuery(projectsQuery);
  const { data: tasksData } = useQuery(tasksQuery);

  const [grantOpen, setGrantOpen] = useState(false);
  const [createContractOpen, setCreateContractOpen] = useState(false);
  const [revokeTarget, setRevokeTarget] = useState<CrossProjectRef | null>(null);
  const [deleteContractTarget, setDeleteContractTarget] = useState<TaskContract | null>(null);
  const [modal, setModal] = useState<ContractModal>(null);
  const [modalText, setModalText] = useState('');
  const [modalBusy, setModalBusy] = useState(false);
  const [modalError, setModalError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const projectName = (id: string) => (allProjects ?? []).find((p) => p.id === id)?.name ?? id;
  const otherProjects = useMemo(
    () => (allProjects ?? []).filter((p) => p.id !== projectId && p.archived_at == null),
    [allProjects, projectId],
  );
  const projectTasks = useMemo(() => {
    const top = (tasksData?.tasks ?? []).filter((task) => task.project_id === projectId);
    const children = (tasksData?.children ?? []).filter((task) => task.project_id === projectId);
    return [...top, ...children];
  }, [tasksData, projectId]);
  const taskTitle = (id: string) => projectTasks.find((task) => task.id === id)?.title ?? id.slice(0, 10);

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: projectCollaborationQuery(projectId).queryKey });
  };

  async function handleRevokeRef(ref: CrossProjectRef): Promise<void> {
    setModalBusy(true);
    setModalError(null);
    try {
      await post(`/api/collaboration/refs/${encodeURIComponent(ref.id)}/revoke`, {});
      setRevokeTarget(null);
      refresh();
    } catch (err) {
      setModalError(messageOf(err));
    } finally {
      setModalBusy(false);
    }
  }

  async function handleDeleteContract(contract: TaskContract): Promise<void> {
    setModalBusy(true);
    setModalError(null);
    try {
      await del(`/api/projects/${encodeURIComponent(projectId)}/contracts/${encodeURIComponent(contract.id)}`);
      setDeleteContractTarget(null);
      refresh();
    } catch (err) {
      setModalError(messageOf(err));
    } finally {
      setModalBusy(false);
    }
  }

  async function submitContractModal(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!modal || !modalText.trim()) return;
    setModalBusy(true);
    setModalError(null);
    try {
      const base = `/api/projects/${encodeURIComponent(projectId)}/contracts/${encodeURIComponent(modal.contract.id)}`;
      if (modal.kind === 'deliver') {
        await post(`${base}/deliver`, { artifact_path: modal.contract.artifact_path, delivery_summary: modalText.trim() });
      } else if (modal.kind === 'block') {
        await post(`${base}/block`, { question: modalText.trim() });
      } else {
        await post(`${base}/clarify`, { clarification_id: modal.clarificationId, answer: modalText.trim() });
      }
      setModal(null);
      setModalText('');
      refresh();
    } catch (err) {
      setModalError(messageOf(err));
    } finally {
      setModalBusy(false);
    }
  }

  if (isPending) return <Note>{t('common.loading')}</Note>;
  if (error) return <Problem role="alert">{error.message}</Problem>;

  const wikiVaults = data?.wiki_vaults ?? [];
  const incomingRefs = data?.incoming_refs ?? [];
  const outgoingRefs = data?.outgoing_refs ?? [];
  const contracts = data?.contracts ?? [];

  return (
    <div className="grid grid-cols-1 gap-8">
      <PageLead className="mb-0">{t('proj.collab.lead')}</PageLead>

      {notice ? (
        <div role="status" aria-live="polite" className="flex items-start justify-between gap-2 rounded-lg border border-success-border bg-success-soft px-3.5 py-2.5 text-xs text-success-foreground">
          <span>{notice}</span>
          <Button type="button" size="icon-sm" variant="ghost" aria-label={t('know.dismissNotice')} onClick={() => setNotice(null)}>
            <X className="size-3.5" />
          </Button>
        </div>
      ) : null}

      <section aria-label={t('proj.collab.wikiTitle')} className="grid gap-2.5">
        <SectionTitle
          count={wikiVaults.length}
          action={<Link to="/knowledge?view=wiki" className="text-xs text-link no-underline hover:underline">{t('proj.collab.wikiManageLink')}</Link>}
        >
          {t('proj.collab.wikiTitle')}
        </SectionTitle>
        <Note className="-mt-1 text-xs">{t('proj.collab.wikiHint')}</Note>
        {wikiVaults.length > 0 ? (
          <Rows>
            <ul className="divide-y divide-border">
              {wikiVaults.map((vault) => (
                <li key={vault.id} className="flex flex-wrap items-center gap-2 px-3.5 py-2.5 text-xs">
                  <BookOpen className="size-4 text-muted-foreground" aria-hidden="true" />
                  <span className="text-sm font-semibold text-foreground">{vault.name}</span>
                  <Badge tone={vault.grant.can_propose ? 'waiting' : 'plain'}>
                    {vault.grant.can_propose ? t('know.wiki.grantCanProposeBadge') : t('know.wiki.grantReadOnly')}
                  </Badge>
                  <span className="text-muted-foreground">{t('know.wiki.pagesCount', { count: vault.page_count })}</span>
                  {vault.effective_commit ? <Mono className="text-[11px]">{vault.effective_commit.slice(0, 8)}</Mono> : null}
                </li>
              ))}
            </ul>
          </Rows>
        ) : (
          <Note className="text-xs">{t('proj.collab.wikiEmpty')}</Note>
        )}
      </section>

      <section aria-label={t('proj.collab.refsTitle')} className="grid gap-3">
        <SectionTitle
          count={incomingRefs.length + outgoingRefs.length}
          action={(
            <Button type="button" size="sm" variant="primary" disabled={otherProjects.length === 0} onClick={() => setGrantOpen(true)}>
              <Plus className="size-3.5" aria-hidden="true" />
              {t('proj.collab.grantRefBtn')}
            </Button>
          )}
        >
          {t('proj.collab.refsTitle')}
        </SectionTitle>
        <Note className="-mt-1 text-xs">{t('proj.collab.refsHint')}</Note>

        <div className="grid grid-cols-1 gap-4 wide:grid-cols-2">
          <Card className="grid gap-2.5 p-4">
            <h3 className="text-xs font-semibold text-foreground">{t('proj.collab.incomingTitle')}</h3>
            {incomingRefs.length > 0 ? (
              <ul className="divide-y divide-border/70 text-xs">
                {incomingRefs.map((ref) => (
                  <li key={ref.id} className="grid gap-1 py-2.5 first:pt-0 last:pb-0">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Badge tone="plain">{CROSS_PROJECT_REF_KIND_LABELS[ref.ref_kind] ?? ref.ref_kind}</Badge>
                      <span className="font-semibold text-foreground wrap-anywhere">{ref.title}</span>
                      {ref.revoked_at ? <Badge tone="ended">{t('proj.collab.refRevoked')}</Badge> : null}
                    </div>
                    <div className="flex flex-wrap items-center gap-x-2 text-muted-foreground">
                      <span>{t('proj.collab.refFrom', { project: projectName(ref.source_project_id) })}</span>
                      <span>·</span>
                      <Mono className="text-[11px]">{t('proj.collab.refVersion', { version: ref.pinned_version })}</Mono>
                      <span>·</span>
                      <Mono className="text-[11px]">{ref.content_sha256.slice(0, 10)}</Mono>
                    </div>
                    {ref.summary ? <p className="text-muted-foreground wrap-anywhere">{ref.summary}</p> : null}
                  </li>
                ))}
              </ul>
            ) : (
              <Note className="text-xs">{t('proj.collab.noIncomingRefs')}</Note>
            )}
          </Card>

          <Card className="grid gap-2.5 p-4">
            <h3 className="text-xs font-semibold text-foreground">{t('proj.collab.outgoingTitle')}</h3>
            {outgoingRefs.length > 0 ? (
              <ul className="divide-y divide-border/70 text-xs">
                {outgoingRefs.map((ref) => (
                  <li key={ref.id} className="grid gap-1 py-2.5 first:pt-0 last:pb-0">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Badge tone="plain">{CROSS_PROJECT_REF_KIND_LABELS[ref.ref_kind] ?? ref.ref_kind}</Badge>
                      <span className="font-semibold text-foreground wrap-anywhere">{ref.title}</span>
                      {ref.revoked_at ? (
                        <Badge tone="ended">{t('proj.collab.refRevoked')}</Badge>
                      ) : (
                        <Button
                          type="button"
                          size="sm"
                          variant="danger"
                          className="ml-auto h-6 px-2 text-xs"
                          onClick={() => setRevokeTarget(ref)}
                        >
                          {t('proj.collab.refRevokeBtn')}
                        </Button>
                      )}
                    </div>
                    <div className="flex flex-wrap items-center gap-x-2 text-muted-foreground">
                      <span>{t('proj.collab.refTo', { project: projectName(ref.target_project_id) })}</span>
                      <span>·</span>
                      <Mono className="text-[11px]">{t('proj.collab.refVersion', { version: ref.pinned_version })}</Mono>
                      <span>·</span>
                      <Time at={ref.created_at} />
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <Note className="text-xs">{t('proj.collab.noOutgoingRefs')}</Note>
            )}
          </Card>
        </div>
      </section>

      <section aria-label={t('proj.collab.contractsTitle')} className="grid gap-3">
        <SectionTitle
          count={contracts.length}
          action={(
            <Button type="button" size="sm" variant="primary" disabled={projectTasks.length < 2} onClick={() => setCreateContractOpen(true)}>
              <Plus className="size-3.5" aria-hidden="true" />
              {t('proj.collab.createContractBtn')}
            </Button>
          )}
        >
          {t('proj.collab.contractsTitle')}
        </SectionTitle>
        <Note className="-mt-1 text-xs">{t('proj.collab.contractsHint')}</Note>
        {projectTasks.length < 2 && contracts.length === 0 ? (
          <Note className="text-xs">{t('proj.collab.contractNeedTwoTasks')}</Note>
        ) : contracts.length === 0 ? (
          <Empty icon={<ArrowLeftRight />} title={t('proj.collab.noContracts')} />
        ) : (
          <Rows>
            <ul className="divide-y divide-border">
              {contracts.map((contract) => (
                <li key={contract.id} className="grid gap-2 px-3.5 py-3 text-xs">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone={CONTRACT_TONE[contract.status] ?? 'plain'}>
                      {TASK_CONTRACT_STATUS_LABELS[contract.status] ?? contract.status}
                    </Badge>
                    <span className="text-sm font-semibold text-foreground">{contract.contract_name}</span>
                    <Badge tone="plain">{t('proj.collab.contractVersionBadge', { version: contract.registered_version })}</Badge>
                    <Mono className="text-[11px]">{contract.artifact_path}</Mono>
                    <div className="ml-auto flex flex-wrap items-center gap-1">
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        className="h-7 text-xs"
                        onClick={() => { setModal({ kind: 'deliver', contract }); setModalText(''); setModalError(null); }}
                      >
                        <FileCheck2 className="size-3.5" aria-hidden="true" />
                        {t('proj.collab.contractDeliverBtn')}
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        className="h-7 text-xs"
                        onClick={() => { setModal({ kind: 'block', contract }); setModalText(''); setModalError(null); }}
                      >
                        <MessageSquareWarning className="size-3.5" aria-hidden="true" />
                        {t('proj.collab.contractBlockBtn')}
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="danger"
                        className="h-7 text-xs"
                        onClick={() => setDeleteContractTarget(contract)}
                      >
                        <Trash2 className="size-3.5" aria-hidden="true" />
                        {t('proj.collab.contractDeleteBtn')}
                      </Button>
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2 text-muted-foreground">
                    <span>{`${t('proj.collab.contractProducer')}: `}</span>
                    <Link to={`/task/${encodeURIComponent(contract.producer_task_id)}`} className="font-medium text-foreground underline">
                      {taskTitle(contract.producer_task_id)}
                    </Link>
                    <span>→</span>
                    <span>{`${t('proj.collab.contractConsumer')}: `}</span>
                    <Link to={`/task/${encodeURIComponent(contract.consumer_task_id)}`} className="font-medium text-foreground underline">
                      {taskTitle(contract.consumer_task_id)}
                    </Link>
                  </div>
                  {contract.delivery_summary ? (
                    <p className="text-foreground wrap-anywhere">{contract.delivery_summary}</p>
                  ) : null}
                  {contract.clarifications.length > 0 ? (
                    <div className="grid gap-1.5 rounded-lg border border-border bg-surface/60 p-2.5">
                      <div className="font-semibold text-muted-foreground">
                        {t('proj.collab.contractClarifications', { count: contract.clarifications.length })}
                      </div>
                      {contract.clarifications.map((c) => (
                        <div key={c.id} className="grid gap-1 border-t border-border/60 pt-1.5 first:border-t-0 first:pt-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-medium text-foreground wrap-anywhere">{`Q: ${c.question}`}</span>
                            <Mono className="text-[11px]">{`v${c.contract_version}`}</Mono>
                            {!c.answer ? (
                              <Button
                                type="button"
                                size="sm"
                                variant="primary"
                                className="ml-auto h-6 px-2 text-xs"
                                onClick={() => { setModal({ kind: 'clarify', contract, clarificationId: c.id }); setModalText(''); setModalError(null); }}
                              >
                                {t('proj.collab.contractClarifyBtn')}
                              </Button>
                            ) : null}
                          </div>
                          {c.answer ? (
                            <p className="text-success-foreground wrap-anywhere">{`A: ${c.answer}`}</p>
                          ) : (
                            <span className="text-waiting-foreground">{t('proj.collab.contractUnanswered')}</span>
                          )}
                        </div>
                      ))}
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          </Rows>
        )}
      </section>

      {grantOpen ? (
        <GrantRefSheet
          projectId={projectId}
          otherProjects={otherProjects}
          onGranted={() => {
            setGrantOpen(false);
            setNotice(t('proj.collab.grantCreatedNotice'));
            refresh();
          }}
          onClose={() => setGrantOpen(false)}
        />
      ) : null}

      {createContractOpen ? (
        <CreateContractSheet
          projectId={projectId}
          projectTasks={projectTasks}
          onCreated={() => {
            setCreateContractOpen(false);
            refresh();
          }}
          onClose={() => setCreateContractOpen(false)}
        />
      ) : null}

      <Dialog open={modal !== null} onOpenChange={(open) => { if (!open && !modalBusy) setModal(null); }}>
        <DialogContent
          title={
            modal?.kind === 'deliver'
              ? t('proj.collab.contractDeliverBtn')
              : modal?.kind === 'block'
                ? t('proj.collab.contractBlockBtn')
                : t('proj.collab.contractClarifyBtn')
          }
          footer={(
            <>
              <Button type="button" variant="ghost" disabled={modalBusy} onClick={() => setModal(null)}>{t('common.cancel')}</Button>
              <Button type="submit" form="contract-action-form" variant="primary" disabled={modalBusy || !modalText.trim()}>
                {t('common.confirm')}
              </Button>
            </>
          )}
        >
          <form id="contract-action-form" onSubmit={(e) => void submitContractModal(e)} className="grid gap-3">
            <Textarea
              rows={3}
              aria-label={
                modal?.kind === 'deliver'
                  ? t('proj.collab.contractDeliverSummary')
                  : modal?.kind === 'block'
                    ? t('proj.collab.contractQuestion')
                    : t('proj.collab.contractAnswer')
              }
              placeholder={
                modal?.kind === 'deliver'
                  ? t('proj.collab.contractDeliverSummaryPlaceholder')
                  : modal?.kind === 'block'
                    ? t('proj.collab.contractQuestionPlaceholder')
                    : t('proj.collab.contractAnswerPlaceholder')
              }
              value={modalText}
              disabled={modalBusy}
              onChange={(e) => setModalText(e.target.value)}
            />
            {modalError ? <Problem role="alert">{modalError}</Problem> : null}
          </form>
        </DialogContent>
      </Dialog>

      <Confirm
        open={revokeTarget !== null}
        title={revokeTarget ? t('proj.collab.refRevokeConfirmTitle', { title: revokeTarget.title }) : ''}
        description={t('proj.collab.refRevokeConfirmDesc')}
        confirm={t('proj.collab.refRevokeConfirmBtn')}
        danger
        busy={modalBusy}
        error={revokeTarget ? modalError : null}
        onConfirm={() => { if (revokeTarget) void handleRevokeRef(revokeTarget); }}
        onCancel={() => { setRevokeTarget(null); setModalError(null); }}
      />

      <Confirm
        open={deleteContractTarget !== null}
        title={deleteContractTarget ? t('proj.collab.contractDeleteConfirmTitle', { name: deleteContractTarget.contract_name }) : ''}
        description={t('proj.collab.contractDeleteConfirmDesc')}
        confirm={t('common.delete')}
        danger
        busy={modalBusy}
        error={deleteContractTarget ? modalError : null}
        onConfirm={() => { if (deleteContractTarget) void handleDeleteContract(deleteContractTarget); }}
        onCancel={() => { setDeleteContractTarget(null); setModalError(null); }}
      />
    </div>
  );
}
