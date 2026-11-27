// The knowledge page (docs/design/knowledge-and-skills.md §3), in five parts told apart by the
// address: what waits for the owner (a change to agree to, what took effect while the owner was
// away, old rulings that were not carried over), the unified catalog of entries and native skills,
// the effective-context budget preview, every proposal, and how knowledge MCP clients connect.
// An entry of the owner's own is written from any of them.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, CircleCheck, FolderSync, Plus, Search, Server, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import {
  GLOBAL_LABEL, GRANTS, GRANT_LABELS, OWNER_REASON_LABELS, PROPOSAL_STATE_LABELS, SOURCE_LABELS,
  type Grant,
} from '@shared/knowledge.ts';
import { Callout, Card, Chevron, CopyButton, Dot, Empty, Field, Mono, Note, Problem, Rows, SectionTitle, Time } from '@/components/bits';
import {
  BLANK_CANDIDATE, OwnerChangeForm, ROW_LINK, RetireDialog, changeSummary, entryPath, outputsScope, proposalPath,
  useKnowledgeAction,
} from '@/components/knowledge-bits';
import { KnowledgeCatalog } from '@/components/knowledge-catalog';
import { KnowledgeEffectivePanel } from '@/components/knowledge-effective';
import { PageBar, PageBody, PageLead, PageTabs } from '@/components/page';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox, Choice } from '@/components/ui/checkbox';
import { Confirm, Sheet, SheetContent } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Option, Select } from '@/components/ui/select';
import { api, messageOf, post } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { accountsQuery, knowledgeQuery } from '@/lib/queries';
import type { EntryReport, KnowledgeClient, KnowledgeEntry, KnowledgePage as Page, KnowledgeProposalRow, LegacyDecision } from '@/lib/types';
import { cn } from '@/lib/utils';

const VIEWS = ['pending', 'entries', 'effective', 'proposals', 'access'] as const;
type View = (typeof VIEWS)[number];
const isView = (value: string | null): value is View => value !== null && (VIEWS as readonly string[]).includes(value);

const shownChange = (row: KnowledgeProposalRow) => row.final ?? row.change;
const evidenceText = (row: KnowledgeProposalRow): string => `证据 ${row.evidence_count} 条（已核实 ${row.verified_count}）`;
const sourceText = (row: KnowledgeProposalRow): string => `${SOURCE_LABELS[row.source] ?? row.source} · ${row.proposed_by}`;

function Awaiting({ page }: { page: Page }) {
  if (!page.awaiting.length) return null;
  return (
    <section aria-label="等你点头">
      <SectionTitle count={page.awaiting.length} action={<Badge tone="waiting">阻塞生效</Badge>}>等你点头</SectionTitle>
      <Note className="-mt-1 mb-2 text-xs">把关已经通过，但这两种要你同意才生效。</Note>
      <Rows className="border-waiting-border">
        <ul className="divide-y divide-waiting-border">
          {page.awaiting.map((row) => (
            <li key={row.id}>
              <Link to={proposalPath(row.id)} className={cn(ROW_LINK, 'flex items-start gap-2 py-3')}>
                <span className="min-w-0 flex-1">
                  <span className="block font-semibold wrap-anywhere">{changeSummary(shownChange(row), page.entries)}</span>
                  {row.owner_reasons.map((reason) => <span key={reason} className="mt-1 block text-waiting-foreground wrap-anywhere">{OWNER_REASON_LABELS[reason]}</span>)}
                  <span className="mt-1 block text-xs text-muted-foreground wrap-anywhere">{`${outputsScope(page, shownChange(row))} · ${sourceText(row)} · ${evidenceText(row)}`}</span>
                </span>
                <Chevron className="mt-0.5" />
              </Link>
            </li>
          ))}
        </ul>
      </Rows>
    </section>
  );
}

// The entry a change in force wrote, when it wrote exactly one: what 直接改 and 退役 act on.
function soleEntry(row: KnowledgeProposalRow, entries: readonly KnowledgeEntry[]): KnowledgeEntry | undefined {
  const outputs = shownChange(row).outputs;
  if (outputs.length !== 1) return undefined;
  const id = outputs[0]!.knowledge_id ?? outputs[0]!.revises;
  return id === null ? undefined : entries.find((each) => each.id === id);
}

function ReviewRow({ row, page }: { row: KnowledgeProposalRow; page: Page }) {
  const action = useKnowledgeAction();
  const [retiring, setRetiring] = useState(false);
  const summary = changeSummary(shownChange(row), page.entries);
  const entry = soleEntry(row, page.entries);
  const live = entry?.state === 'active' ? entry : undefined;
  return (
    <li aria-label={summary} className="px-3.5 py-3">
      <div className="flex flex-wrap items-start gap-x-4 gap-y-2">
        <div className="min-w-[min(100%,18rem)] flex-1 text-sm">
          <Link to={proposalPath(row.id)} className="font-semibold wrap-anywhere">{summary}</Link>
          <p className="mt-1 text-xs text-muted-foreground wrap-anywhere">
            {`${outputsScope(page, shownChange(row))} · ${sourceText(row)} · ${evidenceText(row)} · `}
            <Time at={row.published_at} prefix="生效于 " />
          </p>
          {row.gate ? <p className="mt-1 text-xs text-muted-foreground wrap-anywhere">{`把关：${row.gate.reason}`}</p> : null}
        </div>
        <div className="flex flex-none flex-wrap items-center gap-1.5">
          <Button size="sm" disabled={action.busy} onClick={() => void action.run(() => post(`/api/knowledge/proposals/${encodeURIComponent(row.id)}/review`))}>标已审阅</Button>
          {live ? (
            <>
              <Button size="sm" asChild><Link to={`${entryPath(live.id)}?edit=1`}>直接改</Link></Button>
              <Button size="sm" variant="danger" disabled={action.busy} onClick={() => setRetiring(true)}>退役</Button>
            </>
          ) : shownChange(row).outputs.length > 1 ? (
            <Button size="sm" asChild><Link to={proposalPath(row.id)}>到提议页处理</Link></Button>
          ) : null}
        </div>
      </div>
      {action.error ? <Problem role="alert" className="mt-2">{action.error}</Problem> : null}
      {/* Against the revision on the page: one published meanwhile is refused. */}
      {retiring && live ? <RetireDialog entry={live} onClose={() => setRetiring(false)} /> : null}
    </li>
  );
}

function ToReview({ page }: { page: Page }) {
  const action = useKnowledgeAction();
  if (!page.to_review.length) return null;
  return (
    <section aria-label="待阅">
      <SectionTitle
        count={page.to_review.length}
        action={(
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone="plain">已自动生效 · 非阻塞</Badge>
            <Button
              size="sm"
              disabled={action.busy}
              onClick={() => void action.run(() => post('/api/knowledge/proposals/review-all'))}
            >
              {action.busy ? '处理中…' : '全部标已审阅'}
            </Button>
          </div>
        )}
      >
        待阅（已生效、你还没看过）
      </SectionTitle>
      <Note className="-mt-1 mb-2 text-xs">这些把关通过就生效了。看过的标已审阅；不对的直接改或退役，也可以跟负责人说一句让它提修订。</Note>
      {action.error ? <Problem role="alert" className="mb-2">{action.error}</Problem> : null}
      <Rows>
        <ul className="divide-y divide-border">{page.to_review.map((row) => <ReviewRow key={row.id} row={row} page={page} />)}</ul>
      </Rows>
    </section>
  );
}

// The old rulings the upgrade could not carry over (project-sessions §6): nothing reads them any
// more, so they are put where the owner sees them, with why, instead of sitting unseen.
function Legacy({ page }: { page: Page }) {
  if (!page.legacy.length) return null;
  const projectName = (id: string) => page.projects.find((project) => project.id === id)?.name ?? id;
  const scope = (row: LegacyDecision) => (row.project_id === null ? GLOBAL_LABEL : `项目 ${projectName(row.project_id)}`);
  const title = `没能转成提议的旧裁定（${page.legacy.length}）`;
  return (
    <Callout tone="waiting" role="region" aria-label={title} title={title}>
      <Note className="mt-1 text-xs">升级时旧负责人记下的这些长期裁定没能转成知识提议，现在不进任何负责人的输入。还要它的，照着原文“自己写一条”。</Note>
      <ul className="mt-2.5 divide-y divide-waiting-border border-t border-waiting-border">
        {page.legacy.map((row) => (
          <li key={row.id} aria-label={row.text} className="py-2.5 last:pb-0">
            <span className="block font-semibold whitespace-pre-wrap wrap-anywhere">{row.text}</span>
            <span className="mt-1 block text-xs text-muted-foreground wrap-anywhere">
              {scope(row)} · 记于 <Time at={row.created_at} />
            </span>
            <span className="mt-1 block text-waiting-foreground wrap-anywhere">{row.problem === null ? '还没转成提议：下次启动服务时再转' : `没转成的原因：${row.problem}`}</span>
          </li>
        ))}
      </ul>
    </Callout>
  );
}

function Pending({ page }: { page: Page }) {
  const nothing = !page.awaiting.length && !page.to_review.length && !page.legacy.length;
  return (
    <>
      <PageLead>经验（知识：据什么判断；技能：怎样完成一件事）进入以后每一轮工作的输入。</PageLead>
      {nothing ? (
        <Empty icon={<CircleCheck />} title="没有等你处理的知识">要你点头的提议、已经生效而你还没看过的，会出现在这里。</Empty>
      ) : (
        <div className="grid grid-cols-1 gap-8">
          <div aria-label="待处理概览" className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-surface/60 px-3.5 py-2.5 text-xs">
            {page.awaiting.length > 0 ? (
              <Badge tone="waiting">{`阻塞审批：等你点头 ${page.awaiting.length}`}</Badge>
            ) : (
              <Badge tone="success">当前无阻塞审批</Badge>
            )}
            {page.to_review.length > 0 ? (
              <Badge tone="plain">{`非阻塞待阅 ${page.to_review.length}`}</Badge>
            ) : null}
            {page.legacy.length > 0 ? (
              <Badge tone="waiting">{`旧裁定 ${page.legacy.length}`}</Badge>
            ) : null}
          </div>
          <Awaiting page={page} />
          <ToReview page={page} />
          <Legacy page={page} />
        </div>
      )}
    </>
  );
}

function Proposals({ page }: { page: Page }) {
  return (
    <section aria-label="提议">
      <PageLead>别处提的先过一道把关，通过就生效，你事后看；全局常驻的、改你写过或审过的，要你点头才生效。</PageLead>
      {page.proposals.length ? (
        <Rows>
          <ul className="divide-y divide-border">
            {page.proposals.map((row) => (
              <li key={row.id}>
                <Link to={proposalPath(row.id)} className={ROW_LINK}>
                  <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <Badge tone={row.state === 'awaiting_owner' ? 'waiting' : row.state === 'gating' ? 'running' : 'ended'}>{PROPOSAL_STATE_LABELS[row.state]}</Badge>
                    <span className="min-w-0 font-medium wrap-anywhere">{changeSummary(shownChange(row), page.entries)}</span>
                  </span>
                  <span className="mt-1 block text-xs text-muted-foreground wrap-anywhere">
                    {`${sourceText(row)} · ${evidenceText(row)} · `}
                    <Time at={row.created_at} />
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </Rows>
      ) : <Empty title="还没有提议" />}
    </section>
  );
}

function SkillDirectoryCard({ dir }: { dir: string | undefined }) {
  return (
    <Card aria-label="技能目录" className="px-4 py-3.5">
      <div className="flex flex-col gap-3 shell:flex-row shell:items-center shell:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <span className="mt-0.5 flex size-9 flex-none items-center justify-center rounded-lg bg-brand-soft text-brand-foreground" aria-hidden="true">
            <FolderSync className="size-4" />
          </span>
          <div className="min-w-0">
            <h2 className="text-sm font-semibold">主机技能目录（事实源）</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Host 读取 <Mono>&lt;技能名&gt;/SKILL.md</Mono> 只读目录（兼容软链/联接）；各节点按「可用机器」范围增量镜像同步。
            </p>
          </div>
        </div>
        {dir ? (
          <div className="flex max-w-full flex-none items-center gap-1.5 rounded-lg border border-border bg-code py-1 pr-1.5 pl-3">
            <Mono className="truncate text-xs">{dir}</Mono>
            <CopyButton value={dir} />
          </div>
        ) : null}
      </div>
    </Card>
  );
}

function ClientRow({ client }: { client: KnowledgeClient }) {
  const action = useKnowledgeAction();
  const [token, setToken] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const revoked = client.revoked_at !== null;
  const path = `/api/knowledge/clients/${encodeURIComponent(client.id)}`;
  return (
    <li aria-label={client.name} className="px-3.5 py-3 text-sm">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className={cn('font-semibold wrap-anywhere', revoked && 'text-muted-foreground')}>{client.name}</span>
        <Mono>{client.executor}</Mono>
        {client.grants.map((grant) => <Badge key={grant} tone="plain">{GRANT_LABELS[grant] ?? grant}</Badge>)}
        {revoked ? <Badge tone="ended">已吊销 <Time at={client.revoked_at} /></Badge> : null}
        <Time at={client.created_at} prefix="签发于 " className="text-xs text-faint" />
        {revoked ? null : (
          <span className="ml-auto flex flex-none items-center gap-0.5">
            {token ? null : (
              <Button size="sm" variant="ghost" disabled={action.busy} onClick={() => void action.run(() => api<{ token: string }>(`${path}/token`), (answer) => setToken(answer.token))}>显示令牌</Button>
            )}
            <Button size="sm" variant="danger" disabled={action.busy} onClick={() => { action.clear(); setConfirm(true); }}>吊销</Button>
          </span>
        )}
      </div>
      {token && !revoked ? (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Mono>{token}</Mono>
          <CopyButton value={token} />
          <Button size="sm" variant="ghost" onClick={() => setToken(null)}>藏起来</Button>
        </div>
      ) : null}
      {action.error && !confirm ? <Problem role="alert" className="mt-2">{action.error}</Problem> : null}
      <Confirm
        open={confirm}
        title={`吊销 ${client.name} 的令牌？`}
        description="吊销后这个令牌就用不了了。"
        confirm={`确认吊销 ${client.name}`}
        busy={action.busy}
        error={confirm ? action.error : null}
        onConfirm={() => void action.run(() => post(`${path}/revoke`), () => { setToken(null); setConfirm(false); })}
        onCancel={() => { setConfirm(false); action.clear(); }}
      />
    </li>
  );
}

// A new client: who it is, which executor it runs, what it may do. It is there while it is mounted.
function IssueSheet({ executors, onIssued, onClose }: { executors: readonly string[]; onIssued: (issued: { name: string; token: string }) => void; onClose: () => void }) {
  const action = useKnowledgeAction();
  const [name, setName] = useState('');
  const [executor, setExecutor] = useState('');
  const [grants, setGrants] = useState<Grant[]>(['read']);
  const issue = () => action.run(
    // In the order the grants are declared, whatever order they were ticked in.
    () => post<{ client: KnowledgeClient; token: string }>('/api/knowledge/clients', { name: name.trim(), executor, grants: GRANTS.filter((grant) => grants.includes(grant)) }),
    (answer) => onIssued({ name: answer.client.name, token: answer.token }),
  );
  return (
    <Sheet open onOpenChange={(open) => { if (!open && !action.busy) onClose(); }}>
      <SheetContent
        title="签发一个"
        footer={(
          <>
            <Button variant="primary" disabled={action.busy || !name.trim() || !executor || grants.length === 0} onClick={() => void issue()}>{action.busy ? '签发中' : '签发'}</Button>
            <Button variant="ghost" disabled={action.busy} onClick={onClose}>取消</Button>
          </>
        )}
      >
        <div className="grid grid-cols-1 gap-4">
          <Field label="名字">
            <Input aria-label="客户端名字" placeholder="例如 笔记本上的 Claude" value={name} disabled={action.busy} onChange={(event) => setName(event.target.value)} />
          </Field>
          <Field label="执行器">
            <Select aria-label="执行器" wrapperClassName="flex" value={executor} disabled={action.busy} onChange={(event) => setExecutor(event.target.value)}>
              <Option value="" disabled>它用的是哪个执行器</Option>
              {executors.map((each) => <Option key={each} value={each}>{each}</Option>)}
            </Select>
          </Field>
          <Field label="授权">
            <div className="flex flex-wrap gap-x-5">
              {GRANTS.map((grant) => (
                <Choice key={grant}>
                  <Checkbox
                    checked={grants.includes(grant)}
                    disabled={action.busy}
                    onChange={(event) => setGrants(event.target.checked ? [...grants, grant] : grants.filter((each) => each !== grant))}
                  />
                  {GRANT_LABELS[grant]}
                </Choice>
              ))}
            </div>
          </Field>
          {action.error ? <Problem role="alert">{action.error}</Problem> : null}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function Clients({ clients, executors }: { clients: readonly KnowledgeClient[]; executors: readonly string[] }) {
  const [issuing, setIssuing] = useState(false);
  // The token just issued: said once here, and after that only on asking for it by its row.
  const [issued, setIssued] = useState<{ name: string; token: string } | null>(null);
  const mcpSnippet = issued
    ? JSON.stringify({
        mcpServers: {
          'tycho-knowledge': {
            command: 'tycho',
            args: ['knowledge-mcp'],
            env: {
              TYCHO_KNOWLEDGE_TOKEN: issued.token,
            },
          },
        },
      }, null, 2)
    : null;
  return (
    <section aria-label="知识 MCP 客户端">
      <SectionTitle action={<Button size="sm" onClick={() => setIssuing(true)}><Plus />签发一个</Button>}>动态知识与经验回流（知识 MCP）</SectionTitle>
      <Note className="-mt-1 mb-3 text-xs">可选：供 Tycho 外部会话按项目读取知识或经 <Mono>propose_learning</Mono> 回流经验；静态技能包已由目录与节点镜像承载。</Note>
      {issued ? (
        <Callout tone="waiting" role="status" className="mb-3 grid gap-2">
          <p className="wrap-anywhere">{`给 ${issued.name} 的令牌：`}</p>
          <div className="flex flex-wrap items-center gap-2">
            <Mono>{issued.token}</Mono>
            <CopyButton value={issued.token} />
          </div>
          {mcpSnippet ? (
            <div className="grid gap-1.5">
              <div className="flex items-center justify-between gap-2">
                <Note className="text-xs">可复制的 MCP 配置片段（stdio）：</Note>
                <CopyButton value={mcpSnippet} />
              </div>
              <pre className="overflow-x-auto rounded-md border border-border bg-card p-2.5 font-mono text-xs leading-relaxed text-foreground">{mcpSnippet}</pre>
              <Note className="text-xs">如在已接入本机的远端节点机器上使用，请将 args 改为 <Mono>["knowledge-mcp", "--node"]</Mono>。</Note>
            </div>
          ) : null}
          <Note className="text-xs">只在这里显示；配置方法见部署文档</Note>
          <div><Button size="sm" onClick={() => setIssued(null)}>收起</Button></div>
        </Callout>
      ) : null}
      {clients.length ? (
        <Rows>
          <ul className="divide-y divide-border">{clients.map((client) => <ClientRow key={client.id} client={client} />)}</ul>
        </Rows>
      ) : <Note>还没有签发过。</Note>}
      {issuing ? <IssueSheet executors={executors} onIssued={(made) => { setIssued(made); setIssuing(false); }} onClose={() => setIssuing(false)} /> : null}
    </section>
  );
}

const ENTRY_STATE_META: Record<string, { label: string; tone: 'success' | 'waiting' | 'failed' | 'plain' }> = {
  written: { label: '已写入', tone: 'success' },
  cleared: { label: '已清理', tone: 'plain' },
  unconfirmed: { label: '加载未确认', tone: 'waiting' },
  covered: { label: '被覆盖', tone: 'waiting' },
  occupied: { label: '被占用未改', tone: 'failed' },
  failed: { label: '写入失败', tone: 'failed' },
};

const NORMAL_ENTRY_STATES = new Set(['written', 'cleared']);
const REDUNDANT_CLEARED_NOTE = '没有要写的全局常驻知识';

interface KnowledgeMachineTarget {
  id: string;
  label: string;
  isHost: boolean;
  connected: boolean;
  entry: EntryReport | null | undefined;
  localSkills: readonly { slug: string; name?: string | null; description?: string | null }[];
  issueCount: number;
  writtenCount: number;
}

function summarizeReport(report: EntryReport | null | undefined): { issueCount: number; writtenCount: number } {
  if (!report) return { issueCount: 0, writtenCount: 0 };
  let issueCount = 0;
  let writtenCount = 0;
  for (const item of report.executors) {
    if (!NORMAL_ENTRY_STATES.has(item.state)) issueCount += 1;
    if (item.state === 'written') writtenCount += 1;
  }
  return { issueCount, writtenCount };
}

type EntryRepairAction = 'coexist' | 'backup_takeover' | 'resync';

interface EntryRepairResponse {
  status: { executor: string; path: string; state: string; note?: string };
  backup_path?: string;
  report: EntryReport;
}

interface PendingRepairConfirm {
  executor: string;
  path: string;
  action: 'coexist' | 'backup_takeover';
}

const RESYNC_ENTRY_STATES = new Set(['failed', 'covered', 'unconfirmed']);

function repairConfirmCopy(targetLabel: string, pending: PendingRepairConfirm): { title: string; description: string; confirm: string; danger: boolean } {
  if (pending.action === 'coexist') {
    return {
      title: `在 ${targetLabel} 的 ${pending.executor} 入口启用区块共存？`,
      description: `将在 ${pending.path} 末尾追加带起止标记的 Tycho 受管区块，原有个人规则全文保留；后续更新或清空只改该区块。`,
      confirm: '确认区块共存',
      danger: false,
    };
  }
  return {
    title: `备份并接管 ${targetLabel} 的 ${pending.executor} 入口？`,
    description: `将把 ${pending.path} 重命名为同目录的 .pre-tycho-*.bak 备份文件（可随时恢复），随后由 Tycho 接管全局知识入口。`,
    confirm: '确认备份并接管',
    danger: true,
  };
}

function repairSuccessText(executor: string, action: EntryRepairAction, backupPath?: string): string {
  if (action === 'coexist') return `已为 ${executor} 启用区块共存`;
  if (action === 'backup_takeover') {
    return backupPath ? `已接管 ${executor} 入口（原文件已备份至 ${backupPath}）` : `已接管 ${executor} 入口`;
  }
  return `已重新同步 ${executor} 入口`;
}

function EntryTable({
  targetId,
  targetLabel,
  online,
  report,
  onRepaired,
}: {
  targetId: string;
  targetLabel: string;
  online: boolean;
  report: EntryReport | null | undefined;
  onRepaired: () => void;
}) {
  const [pendingConfirm, setPendingConfirm] = useState<PendingRepairConfirm | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const targetRef = useRef(targetId);
  targetRef.current = targetId;

  useEffect(() => {
    setPendingConfirm(null);
    setBusyKey(null);
    setError(null);
    setNotice(null);
  }, [targetId]);

  const runRepair = async (executor: string, action: EntryRepairAction): Promise<void> => {
    if (busyKey !== null) return;
    const requestedTarget = targetId;
    setBusyKey(`${executor}:${action}`);
    setError(null);
    setNotice(null);
    try {
      const answer = await post<EntryRepairResponse>('/api/knowledge/entry/repair', {
        target: requestedTarget,
        executor,
        action,
      });
      onRepaired();
      if (targetRef.current === requestedTarget) {
        setPendingConfirm(null);
        setNotice(repairSuccessText(executor, action, answer.backup_path));
      }
    } catch (err) {
      if (targetRef.current === requestedTarget) {
        setError(messageOf(err));
      }
    } finally {
      if (targetRef.current === requestedTarget) {
        setBusyKey(null);
      }
    }
  };

  if (!report || report.executors.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border px-3.5 py-4 text-xs text-muted-foreground">
        尚未上报全局知识入口状态
      </div>
    );
  }

  const isBusy = busyKey !== null;
  const confirmCopy = pendingConfirm ? repairConfirmCopy(targetLabel, pendingConfirm) : null;

  return (
    <div className="grid gap-2">
      {notice ? (
        <div
          role="status"
          className="flex items-start justify-between gap-2 rounded-lg border border-success-border bg-success-soft px-3 py-2 text-xs text-success-foreground"
        >
          <span className="min-w-0 flex-1 wrap-anywhere">{notice}</span>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="关闭提示"
            className="-my-1 -mr-1 size-6 text-success-foreground hover:not-disabled:bg-success/15 hover:not-disabled:text-success-foreground"
            onClick={() => setNotice(null)}
          >
            <X className="size-3.5" />
          </Button>
        </div>
      ) : null}
      {error && !pendingConfirm ? <Problem role="alert" className="text-xs">{error}</Problem> : null}
      <ul className="divide-y divide-border/70 overflow-hidden rounded-lg border border-border bg-surface/40">
        {report.executors.map((item) => {
          const meta = ENTRY_STATE_META[item.state] ?? { label: item.state, tone: 'plain' as const };
          const abnormal = !NORMAL_ENTRY_STATES.has(item.state);
          const showNote = Boolean(item.note) && (abnormal || !(item.state === 'cleared' && item.note === REDUNDANT_CLEARED_NOTE));
          const isOccupied = item.state === 'occupied';
          const canResync = RESYNC_ENTRY_STATES.has(item.state);
          const hasActions = isOccupied || canResync;
          const stripText = showNote
            ? item.note
            : isOccupied
              ? '这里已有非 Tycho 生成的内容，尚未修改'
              : canResync
                ? '可重新同步以更新全局知识入口'
                : null;
          return (
            <li key={item.executor} aria-label={item.executor} className="px-3.5 py-2.5 text-xs">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                <Mono className="w-16 flex-none font-semibold text-foreground">{item.executor}</Mono>
                <div className="flex min-w-0 flex-1 items-center gap-1">
                  <span title={item.path} className="truncate font-mono text-[11px] text-muted-foreground">{item.path}</span>
                  <CopyButton value={item.path} className="opacity-70 hover:opacity-100" />
                </div>
                <Badge tone={meta.tone} className="flex-none">{meta.label}</Badge>
              </div>
              {showNote || hasActions ? (
                <div
                  className={cn(
                    'mt-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-2 rounded-md px-2.5 py-1.5 text-xs',
                    meta.tone === 'failed'
                      ? 'bg-failed-soft/70 text-failed-foreground'
                      : meta.tone === 'waiting'
                        ? 'bg-waiting-soft/70 text-waiting-foreground'
                        : 'bg-hover/60 text-muted-foreground',
                  )}
                >
                  <p className="min-w-0 flex-1 wrap-anywhere">
                    {stripText}
                    {!online && hasActions ? (
                      <span className="ml-2 text-faint">机器离线，上线后可修复</span>
                    ) : null}
                  </p>
                  {hasActions ? (
                    <div className="flex flex-none flex-wrap items-center gap-1.5">
                      {isOccupied ? (
                        <>
                          <Button
                            size="sm"
                            variant="primary"
                            disabled={!online || isBusy}
                            onClick={() => {
                              setError(null);
                              setPendingConfirm({ executor: item.executor, path: item.path, action: 'coexist' });
                            }}
                          >
                            区块共存
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={!online || isBusy}
                            onClick={() => {
                              setError(null);
                              setPendingConfirm({ executor: item.executor, path: item.path, action: 'backup_takeover' });
                            }}
                          >
                            备份并接管
                          </Button>
                        </>
                      ) : (
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={!online || isBusy}
                          onClick={() => void runRepair(item.executor, 'resync')}
                        >
                          {busyKey === `${item.executor}:resync` ? '同步中…' : '重新同步'}
                        </Button>
                      )}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
      <Confirm
        open={pendingConfirm !== null}
        title={confirmCopy?.title ?? ''}
        description={confirmCopy?.description}
        confirm={confirmCopy?.confirm ?? ''}
        danger={confirmCopy?.danger ?? false}
        busy={isBusy}
        error={pendingConfirm ? error : null}
        onConfirm={() => {
          if (pendingConfirm) void runRepair(pendingConfirm.executor, pendingConfirm.action);
        }}
        onCancel={() => {
          setPendingConfirm(null);
          setError(null);
        }}
      />
    </div>
  );
}

function LocalSkillsPanel({ machineId, skills }: { machineId: string; skills: KnowledgeMachineTarget['localSkills'] }) {
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    setQuery('');
    setExpanded(new Set());
  }, [machineId]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return skills;
    return skills.filter((skill) =>
      skill.slug.toLowerCase().includes(q)
      || (skill.name?.toLowerCase().includes(q) ?? false)
      || (skill.description?.toLowerCase().includes(q) ?? false),
    );
  }, [query, skills]);

  const allExpanded = filtered.length > 0 && filtered.every((skill) => expanded.has(skill.slug));
  const toggleAll = () => {
    if (allExpanded) {
      setExpanded(new Set());
    } else {
      setExpanded(new Set(filtered.map((skill) => skill.slug)));
    }
  };
  const toggleOne = (slug: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(slug)) next.delete(slug); else next.add(slug);
      return next;
    });
  };

  return (
    <div className="grid gap-2.5 border-t border-border/70 pt-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <h4 className="text-xs font-semibold text-foreground">本机私有技能</h4>
          <span className="rounded-full bg-hover px-1.5 text-xs leading-[18px] font-medium text-muted-foreground tabular-nums">{skills.length}</span>
          <span className="hidden text-xs text-faint sm:inline">仅本机可读，不由 Host 托管</span>
        </div>
        <div className="ml-auto flex items-center gap-1.5">
          {skills.length >= 4 ? (
            <div className="relative">
              <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-faint" aria-hidden="true" />
              <Input
                aria-label="筛选本机私有技能"
                placeholder="筛选技能…"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                className="h-7 w-40 pl-7 text-xs"
              />
            </div>
          ) : null}
          <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={toggleAll}>
            {allExpanded ? '全部收起' : '全部展开'}
          </Button>
        </div>
      </div>
      {filtered.length > 0 ? (
        <ul className="max-h-[340px] divide-y divide-border/70 overflow-y-auto rounded-lg border border-border bg-surface/40 text-xs">
          {filtered.map((skill) => {
            const open = expanded.has(skill.slug);
            return (
              <li key={skill.slug}>
                <button
                  type="button"
                  aria-expanded={open}
                  onClick={() => toggleOne(skill.slug)}
                  className="flex w-full items-start gap-2 px-3 py-2 text-left transition-colors hover:bg-hover/60"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-baseline gap-2">
                      <Mono className="font-semibold text-foreground">{skill.slug}</Mono>
                      {skill.name && skill.name !== skill.slug ? <span className="text-muted-foreground">{skill.name}</span> : null}
                    </div>
                    {skill.description ? (
                      <p className={cn('mt-0.5 text-muted-foreground wrap-anywhere', !open && 'line-clamp-1')}>
                        {skill.description}
                      </p>
                    ) : null}
                  </div>
                  {skill.description ? (
                    <ChevronDown
                      aria-hidden="true"
                      className={cn('mt-0.5 size-3.5 flex-none text-faint transition-transform duration-150', open && 'rotate-180')}
                    />
                  ) : null}
                </button>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="rounded-lg border border-dashed border-border px-3 py-3 text-center text-xs text-muted-foreground">
          没有匹配“{query}”的私有技能
        </p>
      )}
    </div>
  );
}

type MachineKnowledgeFilter = 'all' | 'issues' | 'skills';

function MachineKnowledgeSection() {
  const queryClient = useQueryClient();
  const { data } = useQuery({ ...accountsQuery, retry: false });
  const [filter, setFilter] = useState<MachineKnowledgeFilter>('all');
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const targets = useMemo<KnowledgeMachineTarget[]>(() => {
    if (!data) return [];
    const list: KnowledgeMachineTarget[] = [];
    if (data.host_entry) {
      const stats = summarizeReport(data.host_entry);
      list.push({
        id: '__host__',
        label: '主机本机',
        isHost: true,
        connected: true,
        entry: data.host_entry,
        localSkills: [],
        ...stats,
      });
    }
    for (const machine of data.machines) {
      const stats = summarizeReport(machine.node.entry);
      list.push({
        id: machine.uid,
        label: machine.id,
        isHost: false,
        connected: machine.node.connected,
        entry: machine.node.entry,
        localSkills: machine.node.local_skills ?? [],
        ...stats,
      });
    }
    return list;
  }, [data]);

  const issueTargetsCount = useMemo(() => targets.filter((each) => each.issueCount > 0).length, [targets]);
  const skillTargetsCount = useMemo(() => targets.filter((each) => each.localSkills.length > 0).length, [targets]);
  const totalIssues = useMemo(() => targets.reduce((sum, each) => sum + each.issueCount, 0), [targets]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return targets.filter((target) => {
      if (filter === 'issues' && target.issueCount === 0) return false;
      if (filter === 'skills' && target.localSkills.length === 0) return false;
      if (q && !target.label.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [targets, filter, query]);

  useEffect(() => {
    if (visible.length === 0) return;
    if (selectedId && visible.some((each) => each.id === selectedId)) return;
    const firstWithIssue = visible.find((each) => each.issueCount > 0);
    setSelectedId((firstWithIssue ?? visible[0]!).id);
  }, [visible, selectedId]);

  if (!data || targets.length === 0) return null;

  const selected = visible.find((each) => each.id === selectedId) ?? visible[0] ?? null;

  const handleRailKeyDown = (event: React.KeyboardEvent<HTMLUListElement>) => {
    if (visible.length <= 1) return;
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const index = visible.findIndex((each) => each.id === selected?.id);
    const next = event.key === 'ArrowDown'
      ? visible[(index + 1 + visible.length) % visible.length]!
      : visible[(index - 1 + visible.length) % visible.length]!;
    setSelectedId(next.id);
  };

  return (
    <section id="machine-knowledge" aria-label="各机器知识同步与本机私有技能" className="grid gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-sm font-semibold">各机器同步与本机私有技能</h2>
            <span className="rounded-full bg-hover px-1.5 text-xs leading-[18px] font-medium text-muted-foreground tabular-nums">{targets.length}</span>
            {totalIssues > 0
              ? <Badge tone="failed">{`${totalIssues} 项入口需处理`}</Badge>
              : <Badge tone="success">全部入口正常</Badge>}
          </div>
          <Note className="mt-0.5 text-xs">按机器聚焦查看全局常驻知识入口的写入状态，以及节点上报的非托管本机私有技能。</Note>
        </div>
        {targets.length > 1 ? (
          <div role="group" aria-label="筛选机器知识状态" className="flex flex-wrap items-center gap-1 rounded-lg border border-border bg-surface/60 p-0.5 text-xs">
            {([
              ['all', `全部 ${targets.length}`],
              ['issues', `有异常 ${issueTargetsCount}`],
              ['skills', `含私有技能 ${skillTargetsCount}`],
            ] as const).map(([key, label]) => (
              <button
                key={key}
                type="button"
                aria-pressed={filter === key}
                onClick={() => setFilter(key)}
                className={cn(
                  'rounded-md px-2.5 py-1 font-medium transition-colors',
                  filter === key
                    ? 'bg-raised text-foreground shadow-xs'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {label}
              </button>
            ))}
          </div>
        ) : null}
      </div>

      <div className="grid grid-cols-1 items-start gap-4 shell:grid-cols-[232px_minmax(0,1fr)] wide:grid-cols-[268px_minmax(0,1fr)]">
        <aside aria-label="机器知识清单" className="overflow-hidden rounded-xl bg-raised shadow-card shell:sticky shell:top-4">
          {targets.length > 4 ? (
            <div className="border-b border-border/70 p-2.5">
              <div className="relative">
                <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-faint" aria-hidden="true" />
                <Input
                  aria-label="搜索机器"
                  placeholder="搜索机器…"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  className="h-8 pl-8 text-xs"
                />
              </div>
            </div>
          ) : null}
          {visible.length > 0 ? (
            <ul className="divide-y divide-border/60" onKeyDown={handleRailKeyDown}>
              {visible.map((target) => {
                const active = selected?.id === target.id;
                const dotTone = target.issueCount > 0 ? 'failed' : target.connected ? 'success' : 'waiting';
                const statusText = target.issueCount > 0
                  ? `${target.issueCount} 项入口异常`
                  : target.writtenCount > 0
                    ? `已写入 ${target.writtenCount} 个`
                    : target.entry?.executors.length
                      ? '入口已清理'
                      : '未上报入口';
                return (
                  <li key={target.id}>
                    <button
                      type="button"
                      aria-current={active ? 'true' : undefined}
                      aria-label={`选择机器 ${target.label}`}
                      onClick={() => setSelectedId(target.id)}
                      className={cn(
                        'relative flex w-full flex-col gap-1 px-3.5 py-2.5 text-left transition-colors hover:bg-hover/60',
                        active && 'bg-brand-soft/45 hover:bg-brand-soft/55',
                      )}
                    >
                      {active ? <span aria-hidden="true" className="absolute inset-y-2 left-0 w-[3px] rounded-r-full bg-primary" /> : null}
                      <div className="flex items-center gap-2">
                        <Dot tone={dotTone} />
                        <span className={cn('min-w-0 flex-1 truncate text-sm', active ? 'font-semibold text-foreground' : 'font-medium text-foreground')}>
                          {target.label}
                        </span>
                        {target.isHost ? <Badge tone="plain" className="text-[10px]">Host</Badge> : null}
                      </div>
                      <div className="flex items-center justify-between gap-2 pl-4 text-xs">
                        <span className={cn('truncate', target.issueCount > 0 ? 'font-medium text-failed-foreground' : 'text-muted-foreground')}>
                          {statusText}
                        </span>
                        {target.localSkills.length > 0 ? (
                          <span className="flex-none rounded-full bg-hover px-1.5 text-[11px] leading-[17px] text-muted-foreground tabular-nums">
                            {`${target.localSkills.length} 技能`}
                          </span>
                        ) : null}
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : (
            <div className="px-4 py-8 text-center text-xs text-muted-foreground">
              当前筛选下没有机器
            </div>
          )}
        </aside>

        {selected ? (
          <Card aria-label={`${selected.label} 的知识状态`} className="grid gap-4 p-5">
            <div className="flex flex-wrap items-center gap-2 border-b border-border/70 pb-3.5">
              <span className="flex size-8 flex-none items-center justify-center rounded-lg bg-surface text-muted-foreground" aria-hidden="true">
                <Server className="size-4" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="text-base font-semibold">{selected.label}</h3>
                  {selected.isHost
                    ? <Badge tone="plain">Host</Badge>
                    : <Badge tone={selected.connected ? 'success' : 'waiting'}>{selected.connected ? '在线' : '离线'}</Badge>}
                  {selected.issueCount > 0 ? <Badge tone="failed">{`${selected.issueCount} 项入口需处理`}</Badge> : null}
                </div>
                {selected.entry?.at ? (
                  <p className="mt-0.5 text-xs text-faint">
                    <Time at={selected.entry.at} prefix="入口上报于 " />
                  </p>
                ) : null}
              </div>
            </div>

            <div className="grid gap-2">
              <div className="flex items-center justify-between gap-2">
                <h4 className="text-xs font-semibold text-foreground">全局常驻知识入口</h4>
                {selected.entry?.executors.length ? (
                  <span className="text-xs text-faint tabular-nums">{`${selected.entry.executors.length} 个执行器`}</span>
                ) : null}
              </div>
              <EntryTable
                targetId={selected.isHost ? 'host' : selected.id}
                targetLabel={selected.label}
                online={selected.connected}
                report={selected.entry}
                onRepaired={() => { void queryClient.invalidateQueries({ queryKey: accountsQuery.queryKey }); }}
              />
            </div>

            {selected.localSkills.length > 0 ? (
              <LocalSkillsPanel machineId={selected.id} skills={selected.localSkills} />
            ) : !selected.isHost ? (
              <div className="border-t border-border/70 pt-3 text-xs text-faint">
                本机未上报非托管私有技能
              </div>
            ) : null}
          </Card>
        ) : (
          <Card className="flex min-h-40 items-center justify-center text-sm text-muted-foreground">
            调整筛选条件以查看机器知识同步状态
          </Card>
        )}
      </div>
    </section>
  );
}

function Access({ page }: { page: Page }) {
  return (
    <div className="grid grid-cols-1 gap-7">
      <SkillDirectoryCard dir={page.skills_dir ?? page.skill_folder} />
      <MachineKnowledgeSection />
      <Clients clients={page.clients} executors={page.executors} />
    </div>
  );
}

export function KnowledgePage() {
  const { t, bi } = useI18n();
  const { data, isPending, error } = useQuery(knowledgeQuery);
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const askedView = params.get('view');
  const pendingCount = data ? data.awaiting.length + data.to_review.length + data.legacy.length : 0;
  const view: View = isView(askedView) ? askedView : (data && pendingCount === 0 ? 'entries' : 'pending');
  const [writing, setWriting] = useState(false);
  const [createdNotice, setCreatedNotice] = useState<{ proposalId: string } | null>(null);
  const handleSelectedChange = useCallback((id: string | null) => {
    setParams((prev) => {
      if (prev.get('select') === id) return prev;
      const next = new URLSearchParams(prev);
      if (id === null) {
        next.delete('select');
      } else {
        next.set('select', id);
      }
      return next;
    }, { replace: true });
  }, [setParams]);
  return (
    <>
      <PageBar title={t('knowledge.title')} actions={data ? <Button variant="primary" onClick={() => setWriting(true)}><Plus />{bi('自己写一条', 'New entry')}</Button> : null}>
        <PageTabs
          label={bi('知识的哪一部分', 'Knowledge views')}
          tabs={[
            { to: '/knowledge?view=pending', label: bi('待处理', 'Pending'), current: view === 'pending', count: data ? pendingCount : undefined },
            { to: '/knowledge?view=entries', label: bi('条目', 'Entries'), current: view === 'entries' },
            { to: '/knowledge?view=effective', label: bi('生效预览', 'Effective preview'), current: view === 'effective' },
            { to: '/knowledge?view=proposals', label: bi('提议', 'Proposals'), current: view === 'proposals' },
            { to: '/knowledge?view=access', label: bi('接入', 'Access'), current: view === 'access' },
          ]}
        />
      </PageBar>
      <PageBody width={view === 'entries' || view === 'access' ? 'wide' : 'default'} loading={isPending} failure={error?.message}>
        {createdNotice ? (
          <div
            role="status"
            className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-success-border bg-success-soft px-3.5 py-2.5 text-sm text-success-foreground"
          >
            <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span>新条目已保存并直接生效。</span>
              <Link to={proposalPath(createdNotice.proposalId)} className="underline">查看变更记录</Link>
            </span>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="关闭提示"
              className="-my-1 -mr-1 size-6 text-success-foreground hover:not-disabled:bg-success/15 hover:not-disabled:text-success-foreground"
              onClick={() => setCreatedNotice(null)}
            >
              <X className="size-3.5" />
            </Button>
          </div>
        ) : null}
        {data ? (
          view === 'entries' ? (
            <KnowledgeCatalog
              entries={data.entries}
              directorySkills={data.directory_skills ?? []}
              ignoredSkills={data.ignored_skills ?? []}
              skillsDir={data.skills_dir ?? data.skill_folder}
              projects={data.projects}
              roles={data.roles}
              machines={data.machines ?? []}
              entryMachines={data.entry_machines ?? {}}
              initialQuery={params.get('q') ?? ''}
              initialSelectedId={params.get('select')}
              onSelectedChange={handleSelectedChange}
            />
          ) : view === 'effective' ? (
            <KnowledgeEffectivePanel projects={data.projects} roles={data.roles} machines={data.machines ?? []} />
          ) : view === 'proposals' ? (
            <Proposals page={data} />
          ) : view === 'access' ? (
            <Access page={data} />
          ) : (
            <Pending page={data} />
          )
        ) : null}
      </PageBody>
      {writing && data ? (
        <OwnerChangeForm
          label="新建条目"
          lead="你自己写的不用把关，保存就直接生效，算已审阅。"
          names={data}
          initial={BLANK_CANDIDATE}
          chooseKind
          wrap={(output) => ({ outputs: [output] })}
          onSaved={(answer) => {
            const created = answer as { id: string; knowledge_id?: string; entry_id?: string; entry_ids?: string[] };
            const createdEntryId = created.knowledge_id ?? created.entry_id ?? created.entry_ids?.[0];
            setWriting(false);
            if (createdEntryId) {
              void navigate(entryPath(createdEntryId));
            } else {
              setCreatedNotice({ proposalId: answer.id });
              if (view !== 'entries') void navigate('/knowledge?view=entries');
            }
          }}
          onClose={() => setWriting(false)}
        />
      ) : null}
    </>
  );
}
