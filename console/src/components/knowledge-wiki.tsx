// Git-backed Domain LLM Wiki management panel (Knowledge › Domain Wiki tab):
// - Register/unregister Git Wiki vaults, trigger commit-pinned sync, run incremental lint
// - Full-text search via SQLite FTS5, browse indexed pages with frontmatter/backlinks/locked-sections
// - Manage explicit per-project grants (optional pinned commit & can_propose permission)
// - Review, approve (commits directly into Git), or reject pending Wiki update proposals
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { BookOpen, Check, GitCommitHorizontal, Link2, Lock, Plus, RefreshCw, Search, ShieldCheck, Trash2, X } from 'lucide-react';
import { useEffect, useId, useMemo, useState, type FormEvent } from 'react';
import {
  WIKI_PAGE_STATUS_LABELS,
  WIKI_PROPOSAL_STATUS_LABELS,
  type WikiLintReport,
  type WikiPage,
  type WikiProposal,
} from '@shared/wiki.ts';
import { Card, Empty, Field, Mono, Note, PRE, Problem, Rows, SectionTitle, Time } from '@/components/bits';
import { Markdown } from '@/components/markdown';
import { PageLead } from '@/components/page';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox, Choice } from '@/components/ui/checkbox';
import { Confirm, Sheet, SheetContent } from '@/components/ui/dialog';
import { Input, Textarea } from '@/components/ui/input';
import { Option, Select } from '@/components/ui/select';
import { api, del, messageOf, post } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { PAGE, WIKI, wikiQuery } from '@/lib/queries';
import type { WikiPageDetail, WikiSearchHit, WikiVaultSummary } from '@/lib/types';
import { cn } from '@/lib/utils';

const STATUS_TONE: Record<string, 'success' | 'waiting' | 'failed' | 'plain' | 'ended'> = {
  active: 'success',
  draft: 'plain',
  disputed: 'waiting',
  deprecated: 'ended',
  pending: 'waiting',
  applied: 'success',
  rejected: 'ended',
  stale: 'failed',
};

function RegisterVaultSheet({ onCreated, onClose }: { onCreated: (vaultId: string) => void; onClose: () => void }) {
  const { t } = useI18n();
  const nameId = useId();
  const pathId = useId();
  const branchId = useId();
  const descId = useId();
  const [name, setName] = useState('');
  const [repoPath, setRepoPath] = useState('');
  const [branch, setBranch] = useState('main');
  const [description, setDescription] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const nameInvalid = submitted && name.trim() === '';
  const pathInvalid = submitted && repoPath.trim() === '';

  async function handleSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setSubmitted(true);
    if (!name.trim() || !repoPath.trim()) {
      setError(t('know.bits.missingFields', {
        fields: [
          ...(!name.trim() ? [t('know.wiki.fieldName')] : []),
          ...(!repoPath.trim() ? [t('know.wiki.fieldRepoPath')] : []),
        ].join(t('know.listSep')),
      }));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const answer = await post<{ vault: { id: string } }>('/api/wiki/vaults', {
        name: name.trim(),
        repo_path: repoPath.trim(),
        branch: branch.trim() || 'main',
        description: description.trim(),
      });
      onCreated(answer.vault.id);
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet open onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
      <SheetContent
        title={t('know.wiki.createTitle')}
        description={t('know.wiki.createLead')}
        footer={(
          <>
            <Button type="submit" form="wiki-register-form" variant="primary" disabled={busy}>
              {busy ? t('know.wiki.creating') : t('know.wiki.createSubmit')}
            </Button>
            <Button type="button" variant="ghost" disabled={busy} onClick={onClose}>
              {t('common.cancel')}
            </Button>
          </>
        )}
      >
        <form id="wiki-register-form" noValidate onSubmit={(e) => void handleSubmit(e)} className="grid grid-cols-1 gap-4">
          <Field label={t('know.wiki.fieldName')} htmlFor={nameId}>
            <Input
              id={nameId}
              required
              aria-invalid={nameInvalid ? 'true' : 'false'}
              placeholder={t('know.wiki.fieldNamePlaceholder')}
              value={name}
              disabled={busy}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          <Field label={t('know.wiki.fieldRepoPath')} htmlFor={pathId}>
            <Input
              id={pathId}
              required
              aria-invalid={pathInvalid ? 'true' : 'false'}
              placeholder={t('know.wiki.fieldRepoPathPlaceholder')}
              value={repoPath}
              disabled={busy}
              onChange={(e) => setRepoPath(e.target.value)}
            />
          </Field>
          <Field label={t('know.wiki.fieldBranch')} htmlFor={branchId}>
            <Input
              id={branchId}
              value={branch}
              disabled={busy}
              onChange={(e) => setBranch(e.target.value)}
            />
          </Field>
          <Field label={t('know.wiki.fieldDesc')} htmlFor={descId}>
            <Textarea
              id={descId}
              rows={3}
              placeholder={t('know.wiki.fieldDescPlaceholder')}
              value={description}
              disabled={busy}
              onChange={(e) => setDescription(e.target.value)}
            />
          </Field>
          {error ? <Problem role="alert">{error}</Problem> : null}
        </form>
      </SheetContent>
    </Sheet>
  );
}

function VaultGrantsCard({
  vault,
  projects,
  onChanged,
}: {
  vault: WikiVaultSummary;
  projects: readonly { id: string; name: string }[];
  onChanged: () => void;
}) {
  const { t } = useI18n();
  const projectSelectId = useId();
  const commitInputId = useId();
  const [projectId, setProjectId] = useState('');
  const [pinnedCommit, setPinnedCommit] = useState('');
  const [canPropose, setCanPropose] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const projectName = (id: string) => projects.find((p) => p.id === id)?.name ?? id;

  async function saveGrant(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!projectId) {
      setError(t('know.wiki.grantProjectPlaceholder'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await post(`/api/wiki/vaults/${encodeURIComponent(vault.id)}/grants`, {
        project_id: projectId,
        ...(pinnedCommit.trim() ? { pinned_commit: pinnedCommit.trim() } : { pinned_commit: null }),
        can_propose: canPropose,
      });
      setProjectId('');
      setPinnedCommit('');
      setCanPropose(false);
      onChanged();
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  }

  async function revoke(pid: string): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await del(`/api/wiki/vaults/${encodeURIComponent(vault.id)}/grants/${encodeURIComponent(pid)}`);
      onChanged();
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="grid gap-3 p-4">
      <div>
        <h3 className="text-sm font-semibold">{t('know.wiki.grantsTitle')}</h3>
        <Note className="mt-0.5 text-xs">{t('know.wiki.grantsHint')}</Note>
      </div>

      {vault.grants.length > 0 ? (
        <Rows>
          <ul className="divide-y divide-border">
            {vault.grants.map((grant) => (
              <li key={grant.project_id} className="flex flex-wrap items-center gap-2 px-3 py-2 text-xs">
                <span className="font-medium text-foreground">{projectName(grant.project_id)}</span>
                <Badge tone={grant.can_propose ? 'waiting' : 'plain'}>
                  {grant.can_propose ? t('know.wiki.grantCanProposeBadge') : t('know.wiki.grantReadOnly')}
                </Badge>
                {grant.pinned_commit ? (
                  <Mono className="text-[11px]">{grant.pinned_commit.slice(0, 8)}</Mono>
                ) : null}
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="ml-auto h-7 text-xs"
                  disabled={busy}
                  onClick={() => void revoke(grant.project_id)}
                >
                  {t('know.wiki.grantRevoke')}
                </Button>
              </li>
            ))}
          </ul>
        </Rows>
      ) : (
        <Note className="text-xs">{t('know.wiki.noGrants')}</Note>
      )}

      {projects.length > 0 ? (
        <form onSubmit={(e) => void saveGrant(e)} className="grid gap-3 border-t border-border/70 pt-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label={t('know.wiki.grantProjectLabel')} htmlFor={projectSelectId}>
              <Select
                id={projectSelectId}
                wrapperClassName="flex"
                value={projectId}
                disabled={busy}
                onChange={(e) => setProjectId(e.target.value)}
              >
                <Option value="">{t('know.wiki.grantProjectPlaceholder')}</Option>
                {projects.map((p) => <Option key={p.id} value={p.id}>{p.name}</Option>)}
              </Select>
            </Field>
            <Field label={t('know.wiki.grantCommitLabel')} htmlFor={commitInputId}>
              <Input
                id={commitInputId}
                placeholder={t('know.wiki.grantCommitPlaceholder')}
                value={pinnedCommit}
                disabled={busy}
                onChange={(e) => setPinnedCommit(e.target.value)}
              />
            </Field>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Choice>
              <Checkbox checked={canPropose} disabled={busy} onChange={(e) => setCanPropose(e.target.checked)} />
              {t('know.wiki.grantCanPropose')}
            </Choice>
            <Button type="submit" size="sm" variant="primary" disabled={busy}>
              {t('know.wiki.grantSubmit')}
            </Button>
          </div>
          {error ? <Problem role="alert" className="text-xs">{error}</Problem> : null}
        </form>
      ) : null}
    </Card>
  );
}

function WikiProposalRow({
  proposal,
  vaultName,
  onDecided,
}: {
  proposal: WikiProposal;
  vaultName: string;
  onDecided: (notice: string) => void;
}) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function decide(action: 'approve' | 'reject'): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const answer = await post<{ proposal: WikiProposal }>(`/api/wiki/proposals/${encodeURIComponent(proposal.id)}/decide`, {
        action,
        ...(action === 'reject' && reason.trim() ? { reason: reason.trim() } : {}),
      });
      onDecided(
        action === 'approve'
          ? t('know.wiki.proposalApprovedNotice', { commit: (answer.proposal.applied_commit ?? '').slice(0, 8) })
          : t('know.wiki.proposalRejectedNotice'),
      );
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="grid gap-2 px-3.5 py-3 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={STATUS_TONE[proposal.status] ?? 'plain'}>
          {WIKI_PROPOSAL_STATUS_LABELS[proposal.status] ?? proposal.status}
        </Badge>
        <span className="text-sm font-semibold text-foreground wrap-anywhere">{proposal.title}</span>
        <Mono className="text-[11px]">{`${vaultName}/${proposal.path}`}</Mono>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="ml-auto h-7 text-xs"
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? t('common.collapse') : t('common.expand')}
        </Button>
      </div>
      <p className="text-muted-foreground">
        {`${proposal.proposed_by} · `}
        {t('know.wiki.proposalBase', { commit: proposal.base_commit.slice(0, 8), version: proposal.base_mutation_version })}
        {proposal.applied_commit ? ` · ${t('know.wiki.proposalApplied', { commit: proposal.applied_commit.slice(0, 8) })}` : ''}
        {' · '}
        <Time at={proposal.created_at} />
      </p>
      {proposal.status_reason ? (
        <p className="text-waiting-foreground wrap-anywhere">{proposal.status_reason}</p>
      ) : null}
      {proposal.rationale ? (
        <p className="text-foreground wrap-anywhere">{`${t('know.wiki.proposalRationale')}: ${proposal.rationale}`}</p>
      ) : null}
      {expanded ? (
        <pre className={cn(PRE, 'max-h-72 overflow-y-auto text-xs')}>{proposal.new_content}</pre>
      ) : null}
      {proposal.status === 'pending' ? (
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <Button type="button" size="sm" variant="primary" disabled={busy} onClick={() => void decide('approve')}>
            <Check className="size-3.5" aria-hidden="true" />
            {t('know.wiki.proposalApprove')}
          </Button>
          <Input
            aria-label={t('know.wiki.proposalRejectReasonPlaceholder')}
            placeholder={t('know.wiki.proposalRejectReasonPlaceholder')}
            value={reason}
            disabled={busy}
            onChange={(e) => setReason(e.target.value)}
            className="h-8 max-w-xs text-xs"
          />
          <Button type="button" size="sm" variant="danger" disabled={busy} onClick={() => void decide('reject')}>
            {t('know.wiki.proposalReject')}
          </Button>
        </div>
      ) : null}
      {error ? <Problem role="alert">{error}</Problem> : null}
    </li>
  );
}

export function KnowledgeWikiPanel() {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const { data, isPending, error } = useQuery(wikiQuery);
  const [selectedVaultId, setSelectedVaultId] = useState<string | null>(null);
  const [selectedPageId, setSelectedPageId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<WikiVaultSummary | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [linting, setLinting] = useState(false);
  const [lintReport, setLintReport] = useState<WikiLintReport | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [searchInput, setSearchInput] = useState('');
  const [searchHits, setSearchHits] = useState<WikiSearchHit[] | null>(null);
  const [searching, setSearching] = useState(false);

  const vaults = data?.vaults ?? [];
  const projects = data?.projects ?? [];
  const proposals = data?.proposals ?? [];

  useEffect(() => {
    if (vaults.length === 0) {
      setSelectedVaultId(null);
      return;
    }
    if (!selectedVaultId || !vaults.some((v) => v.id === selectedVaultId)) {
      setSelectedVaultId(vaults[0]!.id);
    }
  }, [vaults, selectedVaultId]);

  const activeVault = vaults.find((v) => v.id === selectedVaultId) ?? vaults[0] ?? null;

  const pagesQuery = useQuery({
    queryKey: [PAGE, 'wiki-pages', activeVault?.id],
    enabled: activeVault !== null,
    queryFn: () => api<{ pages: WikiPage[] }>(`/api/wiki/vaults/${encodeURIComponent(activeVault!.id)}/pages`),
  });
  const pages = pagesQuery.data?.pages ?? [];

  useEffect(() => {
    setLintReport(null);
    setSelectedPageId(null);
  }, [activeVault?.id]);

  useEffect(() => {
    if (pages.length === 0) {
      setSelectedPageId(null);
      return;
    }
    if (!selectedPageId || !pages.some((p) => p.page_id === selectedPageId)) {
      setSelectedPageId(pages[0]!.page_id);
    }
  }, [pages, selectedPageId]);

  const pageDetailQuery = useQuery({
    queryKey: [PAGE, 'wiki-page-detail', activeVault?.id, selectedPageId],
    enabled: activeVault !== null && selectedPageId !== null,
    queryFn: () => api<WikiPageDetail>(
      `/api/wiki/vaults/${encodeURIComponent(activeVault!.id)}/page?page_id=${encodeURIComponent(selectedPageId!)}`,
    ),
  });

  const vaultProposals = useMemo(
    () => (activeVault ? proposals.filter((p) => p.vault_id === activeVault.id) : proposals),
    [proposals, activeVault],
  );

  const refreshAll = () => {
    void queryClient.invalidateQueries({ queryKey: WIKI });
    if (activeVault) {
      void queryClient.invalidateQueries({ queryKey: [PAGE, 'wiki-pages', activeVault.id] });
      void queryClient.invalidateQueries({ queryKey: [PAGE, 'wiki-page-detail', activeVault.id] });
    }
  };

  async function handleSync(vault: WikiVaultSummary): Promise<void> {
    setSyncing(true);
    setActionError(null);
    setNotice(null);
    try {
      const result = await post<{
        commit: string;
        indexed: number;
        added: string[];
        updated: string[];
        removed: string[];
        lint: WikiLintReport;
      }>(`/api/wiki/vaults/${encodeURIComponent(vault.id)}/sync`, {});
      setLintReport(result.lint);
      setNotice(t('know.wiki.syncSuccess', {
        commit: result.commit.slice(0, 8),
        indexed: result.indexed,
        added: result.added.length,
        updated: result.updated.length,
        removed: result.removed.length,
      }));
      refreshAll();
    } catch (err) {
      setActionError(messageOf(err));
    } finally {
      setSyncing(false);
    }
  }

  async function handleLint(vault: WikiVaultSummary): Promise<void> {
    setLinting(true);
    setActionError(null);
    try {
      const report = await api<WikiLintReport>(`/api/wiki/vaults/${encodeURIComponent(vault.id)}/lint`);
      setLintReport(report);
    } catch (err) {
      setActionError(messageOf(err));
    } finally {
      setLinting(false);
    }
  }

  async function handleSearch(event: FormEvent): Promise<void> {
    event.preventDefault();
    const q = searchInput.trim();
    if (!q) {
      setSearchHits(null);
      return;
    }
    setSearching(true);
    setActionError(null);
    try {
      const qs = new URLSearchParams({ q });
      if (activeVault) qs.set('vault_id', activeVault.id);
      const res = await api<{ hits: WikiSearchHit[] }>(`/api/wiki/search?${qs.toString()}`);
      setSearchHits(res.hits);
    } catch (err) {
      setActionError(messageOf(err));
    } finally {
      setSearching(false);
    }
  }

  async function handleDeleteVault(vault: WikiVaultSummary): Promise<void> {
    setActionError(null);
    try {
      await del(`/api/wiki/vaults/${encodeURIComponent(vault.id)}`);
      setDeleteTarget(null);
      refreshAll();
    } catch (err) {
      setActionError(messageOf(err));
    }
  }

  if (isPending) {
    return <Note>{t('common.loading')}</Note>;
  }
  if (error) {
    return <Problem role="alert">{error.message}</Problem>;
  }

  return (
    <div className="grid grid-cols-1 gap-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <PageLead className="mb-0">{t('know.wiki.lead')}</PageLead>
        <Button type="button" size="sm" variant="primary" onClick={() => setCreating(true)}>
          <Plus className="size-4" aria-hidden="true" />
          {t('know.wiki.addVaultBtn')}
        </Button>
      </div>

      {notice ? (
        <div role="status" aria-live="polite" className="flex items-start justify-between gap-2 rounded-lg border border-success-border bg-success-soft px-3.5 py-2.5 text-xs text-success-foreground">
          <span className="wrap-anywhere">{notice}</span>
          <Button type="button" size="icon-sm" variant="ghost" aria-label={t('know.dismissNotice')} onClick={() => setNotice(null)}>
            <X className="size-3.5" />
          </Button>
        </div>
      ) : null}
      {actionError ? <Problem role="alert">{actionError}</Problem> : null}

      {vaults.length === 0 ? (
        <Empty icon={<BookOpen />} title={t('know.wiki.emptyTitle')}>
          {t('know.wiki.emptyBody')}
        </Empty>
      ) : (
        <div className="grid grid-cols-1 items-start gap-5 shell:grid-cols-[260px_minmax(0,1fr)]">
          <aside aria-label={t('know.wiki.vaultsAria')} className="grid gap-3">
            <Rows>
              <ul className="divide-y divide-border">
                {vaults.map((vault) => {
                  const active = activeVault?.id === vault.id;
                  return (
                    <li key={vault.id}>
                      <button
                        type="button"
                        aria-current={active ? 'true' : undefined}
                        onClick={() => setSelectedVaultId(vault.id)}
                        className={cn(
                          'flex w-full flex-col gap-1 px-3.5 py-2.5 text-left transition-colors hover:bg-hover/60',
                          active && 'bg-brand-soft/45 hover:bg-brand-soft/55',
                        )}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="truncate text-sm font-semibold text-foreground">{vault.name}</span>
                          {vault.pending_proposals > 0 ? (
                            <Badge tone="waiting">{t('know.wiki.pendingCount', { count: vault.pending_proposals })}</Badge>
                          ) : null}
                        </div>
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
                          <span>{t('know.wiki.pagesCount', { count: vault.page_count })}</span>
                          <span>·</span>
                          <Mono className="text-[11px]">{vault.published_commit ? vault.published_commit.slice(0, 8) : t('know.wiki.unsynced')}</Mono>
                        </div>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </Rows>
          </aside>

          {activeVault ? (
            <div className="grid min-w-0 gap-5">
              <Card className="grid gap-3 p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h2 className="text-base font-semibold text-foreground">{activeVault.name}</h2>
                    {activeVault.description ? <p className="mt-0.5 text-xs text-muted-foreground">{activeVault.description}</p> : null}
                    <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                      <Mono className="text-[11px]">{activeVault.repo_path}</Mono>
                      <span>{`${t('know.wiki.branchLabel')}: ${activeVault.branch}`}</span>
                      <span className="inline-flex items-center gap-1">
                        <GitCommitHorizontal className="size-3.5" aria-hidden="true" />
                        {`${t('know.wiki.commitLabel')}: `}
                        <Mono className="text-[11px]">{activeVault.published_commit ? activeVault.published_commit.slice(0, 8) : t('know.wiki.unsynced')}</Mono>
                      </span>
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Button type="button" size="sm" disabled={syncing} onClick={() => void handleSync(activeVault)}>
                      <RefreshCw className={cn('size-3.5', syncing && 'animate-spin')} aria-hidden="true" />
                      {syncing ? t('know.wiki.syncing') : t('know.wiki.syncBtn')}
                    </Button>
                    <Button type="button" size="sm" variant="ghost" disabled={linting} onClick={() => void handleLint(activeVault)}>
                      <ShieldCheck className="size-3.5" aria-hidden="true" />
                      {linting ? t('know.wiki.linting') : t('know.wiki.lintBtn')}
                    </Button>
                    <Button type="button" size="sm" variant="danger" onClick={() => setDeleteTarget(activeVault)}>
                      <Trash2 className="size-3.5" aria-hidden="true" />
                      {t('know.wiki.deleteVaultBtn')}
                    </Button>
                  </div>
                </div>
                {activeVault.sync_error ? <Problem role="alert" className="text-xs">{activeVault.sync_error}</Problem> : null}

                {lintReport ? (
                  <div role="status" aria-live="polite" className="grid gap-2 rounded-lg border border-border bg-surface/60 p-3 text-xs">
                    <div className="font-semibold text-foreground">
                      {t('know.wiki.lintTitle', { checked: lintReport.checked_pages })}
                    </div>
                    {lintReport.issues.length === 0 ? (
                      <p className="text-success-foreground">{t('know.wiki.lintClean')}</p>
                    ) : (
                      <ul className="grid gap-1.5">
                        {lintReport.issues.map((issue, idx) => (
                          <li key={`${issue.page_id}:${issue.code}:${idx}`} className="flex flex-wrap items-start gap-2">
                            <Badge tone={issue.severity === 'error' ? 'failed' : 'waiting'}>
                              {issue.severity === 'error' ? t('know.wiki.lintSeverityError') : t('know.wiki.lintSeverityWarn')}
                            </Badge>
                            <Mono className="text-[11px]">{issue.path}</Mono>
                            <span className="text-foreground wrap-anywhere">{issue.message}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                ) : null}

                <form role="search" aria-label={t('know.wiki.searchAria')} onSubmit={(e) => void handleSearch(e)} className="flex flex-wrap items-center gap-2">
                  <div className="relative min-w-0 flex-1">
                    <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-faint" aria-hidden="true" />
                    <Input
                      type="search"
                      aria-label={t('know.wiki.searchAria')}
                      placeholder={t('know.wiki.searchPlaceholder')}
                      value={searchInput}
                      onChange={(e) => setSearchInput(e.target.value)}
                      className="pl-8 text-xs"
                    />
                  </div>
                  <Button type="submit" size="sm" disabled={searching}>{t('know.wiki.searchBtn')}</Button>
                  {searchHits !== null ? (
                    <Button type="button" size="sm" variant="ghost" onClick={() => { setSearchInput(''); setSearchHits(null); }}>
                      {t('know.wiki.clearSearch')}
                    </Button>
                  ) : null}
                </form>

                {searchHits !== null ? (
                  <div className="grid gap-2 border-t border-border/70 pt-3 text-xs">
                    <div className="font-semibold text-muted-foreground">{t('know.wiki.searchHits', { count: searchHits.length })}</div>
                    {searchHits.length === 0 ? (
                      <Note className="text-xs">{t('know.wiki.searchEmpty')}</Note>
                    ) : (
                      <ul className="divide-y divide-border rounded-lg border border-border">
                        {searchHits.map((hit) => (
                          <li key={`${hit.vault_id}:${hit.page_id}`}>
                            <button
                              type="button"
                              onClick={() => setSelectedPageId(hit.page_id)}
                              className="flex w-full flex-col gap-0.5 px-3 py-2 text-left hover:bg-hover/60"
                            >
                              <div className="flex flex-wrap items-center gap-2">
                                <span className="font-semibold text-foreground">{hit.title}</span>
                                <Mono className="text-[11px]">{hit.path}</Mono>
                                <Badge tone={STATUS_TONE[hit.status] ?? 'plain'}>{WIKI_PAGE_STATUS_LABELS[hit.status] ?? hit.status}</Badge>
                              </div>
                              {hit.summary ? <span className="line-clamp-2 text-muted-foreground">{hit.summary}</span> : null}
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                ) : null}
              </Card>

              <div className="grid grid-cols-1 items-start gap-4 wide:grid-cols-[240px_minmax(0,1fr)]">
                <Card className="grid gap-2 p-3">
                  <div className="flex items-center justify-between px-1">
                    <h3 className="text-xs font-semibold text-foreground">{t('know.wiki.pagesTitle')}</h3>
                    <span className="text-xs text-muted-foreground tabular-nums">{pages.length}</span>
                  </div>
                  {pages.length === 0 ? (
                    <Note className="px-1 text-xs">{t('know.wiki.noPages')}</Note>
                  ) : (
                    <ul className="max-h-[420px] divide-y divide-border/60 overflow-y-auto text-xs">
                      {pages.map((page) => {
                        const active = page.page_id === selectedPageId;
                        return (
                          <li key={page.page_id}>
                            <button
                              type="button"
                              aria-current={active ? 'true' : undefined}
                              onClick={() => setSelectedPageId(page.page_id)}
                              className={cn(
                                'flex w-full flex-col gap-0.5 rounded-md px-2 py-1.5 text-left hover:bg-hover/60',
                                active && 'bg-brand-soft/45 font-semibold',
                              )}
                            >
                              <span className="truncate text-foreground">{page.title}</span>
                              <span className="truncate font-mono text-[11px] text-muted-foreground">{page.path}</span>
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </Card>

                <Card className="grid min-w-0 gap-3 p-4">
                  {pageDetailQuery.data ? (
                    <>
                      <div className="flex flex-wrap items-center gap-2 border-b border-border/70 pb-2.5">
                        <h3 className="text-base font-semibold text-foreground">{pageDetailQuery.data.title}</h3>
                        <Badge tone={STATUS_TONE[pageDetailQuery.data.status] ?? 'plain'}>
                          {WIKI_PAGE_STATUS_LABELS[pageDetailQuery.data.status] ?? pageDetailQuery.data.status}
                        </Badge>
                        {pageDetailQuery.data.locked_sections.length > 0 ? (
                          <Badge tone="waiting">
                            <Lock className="mr-1 size-3" aria-hidden="true" />
                            {t('know.wiki.lockedBadge', { count: pageDetailQuery.data.locked_sections.length })}
                          </Badge>
                        ) : null}
                      </div>
                      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                        <Mono className="text-[11px]">{pageDetailQuery.data.path}</Mono>
                        {pageDetailQuery.data.owner ? <span>{`${t('know.wiki.metaOwner')}: ${pageDetailQuery.data.owner}`}</span> : null}
                        {pageDetailQuery.data.scope ? <span>{`${t('know.wiki.metaScope')}: ${pageDetailQuery.data.scope}`}</span> : null}
                        <span>{`${t('know.wiki.metaVersion')}: v${pageDetailQuery.data.mutation_version}`}</span>
                      </div>
                      <div className="min-w-0 text-sm">
                        <Markdown text={pageDetailQuery.data.body} />
                      </div>
                      {(pageDetailQuery.data.backlinks.length > 0 || pageDetailQuery.data.links.length > 0) ? (
                        <div className="grid gap-2 border-t border-border/70 pt-3 text-xs">
                          {pageDetailQuery.data.backlinks.length > 0 ? (
                            <div className="flex flex-wrap items-center gap-1.5">
                              <Link2 className="size-3.5 text-muted-foreground" aria-hidden="true" />
                              <span className="font-medium text-muted-foreground">
                                {t('know.wiki.backlinksTitle', { count: pageDetailQuery.data.backlinks.length })}:
                              </span>
                              {pageDetailQuery.data.backlinks.map((id) => (
                                <Button key={id} type="button" size="sm" variant="ghost" className="h-6 px-2 font-mono text-[11px]" onClick={() => setSelectedPageId(id)}>
                                  {id}
                                </Button>
                              ))}
                            </div>
                          ) : null}
                          {pageDetailQuery.data.links.length > 0 ? (
                            <div className="flex flex-wrap items-center gap-1.5">
                              <span className="font-medium text-muted-foreground">
                                {t('know.wiki.linksTitle', { count: pageDetailQuery.data.links.length })}:
                              </span>
                              {pageDetailQuery.data.links.map((link) => (
                                <Mono key={link} className="text-[11px]">{link}</Mono>
                              ))}
                            </div>
                          ) : null}
                        </div>
                      ) : null}
                    </>
                  ) : (
                    <Note className="text-xs">{t('know.wiki.readerEmpty')}</Note>
                  )}
                </Card>
              </div>

              <VaultGrantsCard vault={activeVault} projects={projects} onChanged={refreshAll} />

              <section aria-label={t('know.wiki.proposalsTitle')}>
                <SectionTitle count={vaultProposals.length}>{t('know.wiki.proposalsTitle')}</SectionTitle>
                {vaultProposals.length > 0 ? (
                  <Rows>
                    <ul className="divide-y divide-border">
                      {vaultProposals.map((proposal) => (
                        <WikiProposalRow
                          key={proposal.id}
                          proposal={proposal}
                          vaultName={activeVault.name}
                          onDecided={(msg) => {
                            setNotice(msg);
                            refreshAll();
                          }}
                        />
                      ))}
                    </ul>
                  </Rows>
                ) : (
                  <Note className="text-xs">{t('know.wiki.proposalsEmpty')}</Note>
                )}
              </section>
            </div>
          ) : null}
        </div>
      )}

      {creating ? (
        <RegisterVaultSheet
          onCreated={(vaultId) => {
            setCreating(false);
            setSelectedVaultId(vaultId);
            refreshAll();
          }}
          onClose={() => setCreating(false)}
        />
      ) : null}

      <Confirm
        open={deleteTarget !== null}
        title={deleteTarget ? t('know.wiki.deleteConfirmTitle', { name: deleteTarget.name }) : ''}
        description={t('know.wiki.deleteConfirmDesc')}
        confirm={t('know.wiki.deleteConfirmBtn')}
        danger
        onConfirm={() => { if (deleteTarget) void handleDeleteVault(deleteTarget); }}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}
