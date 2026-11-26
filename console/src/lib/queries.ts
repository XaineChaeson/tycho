// Every read of the console, by the key its answer is kept under. The side column, the
// question cards and the banner are read by the shell; what is under PAGE belongs to
// the page in view. Whatever is on screen is read again when the service says the ledger
// changed (live.ts); only what the ledger does not keep (whether a machine is connected,
// the self-check, the service's own state, what a Run is doing now) is also read on a clock.
import { api } from './api.ts';
import type { ExecutorFleetStatus } from '@shared/executor-updates.ts';
import type { AccountsAndMachines, Approval, DoctorCheck, ImGroupsPage, InboundPage, KnowledgeEntryPage, KnowledgePage, KnowledgeProposalPage, Overview, PendingJoin, Project, ProjectFileSummary, ProjectGroupsPage, Role, ServiceState, SettingsPage, Task, TaskPage, TriggersPage } from './types.ts';

// How often a read of what no event tells of is made again.
export const POLL_MS = 15_000;
export const PAGE = 'page';

export const tasksQuery = {
  queryKey: ['tasks'],
  queryFn: () => api<{ tasks: Task[]; children?: Task[] }>('/api/tasks?top=1'),
};

export const approvalsQuery = {
  queryKey: ['approvals'],
  queryFn: async () => (await api<{ approvals: Approval[] }>('/api/approvals')).approvals,
};

export const stateQuery = {
  queryKey: ['state'],
  queryFn: () => api<ServiceState>('/api/state'),
  refetchInterval: POLL_MS,
};

export const overviewQuery = {
  queryKey: [PAGE, 'overview'],
  queryFn: () => api<Overview>('/api/overview'),
  refetchInterval: POLL_MS,
};

export type Doctor = { checks: DoctorCheck[]; failure?: undefined } | { failure: string; checks?: undefined };

// The self-check rides along with the overview. That it cannot be read is a line of its
// own, never the overview's failure.
export const doctorQuery = {
  queryKey: [PAGE, 'doctor'],
  queryFn: (): Promise<Doctor> => api<{ checks: DoctorCheck[] }>('/api/doctor').catch((error: Error) => ({ failure: error.message })),
  refetchInterval: POLL_MS,
};

// With the Router as it is now, which the ledger does not keep: on the clock too.
export const settingsQuery = {
  queryKey: [PAGE, 'settings'],
  queryFn: () => api<SettingsPage>('/api/settings'),
  refetchInterval: POLL_MS,
};

// The console's two pages of logins and machines (账号 and 机器) read the same service
// answer: one query, so a page come to from the other one is already answered.
export const accountsQuery = {
  queryKey: [PAGE, 'accounts-and-machines'],
  queryFn: async (): Promise<AccountsAndMachines> => {
    const [accounts, machines] = await Promise.all([api<Omit<AccountsAndMachines, 'machines' | 'invites'>>('/api/accounts'), api<Pick<AccountsAndMachines, 'machines' | 'invites' | 'host_entry' | 'host_machine' | 'public_url'>>('/api/machines')]);
    return { ...accounts, ...machines };
  },
  refetchInterval: POLL_MS,
};

// One change at a time to what that read holds. The two pages that write it (账号 and 机器)
// share the lock: they write one list, so a change on either holds the other until its
// answer is in, exactly as one page's changes always held each other.
export const LOGINS_CHANGE = ['accounts-and-machines-change'];

// The machines asking to be let in. Read while the owner has that list open: the command on
// that machine sits there waiting for this answer.
export const nodeJoinsQuery = {
  queryKey: [PAGE, 'node-joins'],
  queryFn: async (): Promise<PendingJoin[]> => (await api<{ joins: PendingJoin[] }>('/api/node/joins')).joins,
  refetchInterval: POLL_MS,
};

export const executorUpdatesQuery = {
  queryKey: [PAGE, 'executor-updates'],
  queryFn: () => api<ExecutorFleetStatus>('/api/executors/updates'),
  refetchInterval: 5_000,
};

// A project's sources, logins and machines as the pages read them: on the clock too.
export const projectsQuery = {
  queryKey: [PAGE, 'projects'],
  queryFn: async (): Promise<Project[]> => (await api<{ projects: Project[] }>('/api/projects')).projects,
  refetchInterval: POLL_MS,
};

// With why a queued Task waits, which comes from which machines are connected now: on the clock too.
export const taskQuery = (id: string) => ({
  queryKey: [PAGE, 'task', id],
  queryFn: () => api<TaskPage>(`/api/tasks/${encodeURIComponent(id)}`),
  refetchInterval: POLL_MS,
});

export const rolesQuery = {
  queryKey: [PAGE, 'roles'],
  queryFn: async (): Promise<Role[]> => (await api<{ roles: Role[] }>('/api/roles')).roles,
};

// The knowledge page and its two detail pages are under one key: a decision, a retirement
// or a new proposal reads all three again.
export const KNOWLEDGE = [PAGE, 'knowledge'];

export const knowledgeQuery = {
  queryKey: KNOWLEDGE,
  queryFn: () => api<KnowledgePage>('/api/knowledge'),
};

export const proposalQuery = (id: string) => ({
  queryKey: [...KNOWLEDGE, 'proposal', id],
  queryFn: () => api<KnowledgeProposalPage>(`/api/knowledge/proposals/${encodeURIComponent(id)}`),
});

export const entryQuery = (id: string) => ({
  queryKey: [...KNOWLEDGE, 'entry', id],
  queryFn: () => api<KnowledgeEntryPage>(`/api/knowledge/entries/${encodeURIComponent(id)}`),
});

// A project's triggers and their recent occurrences (docs/design/triggers.md §7).
export const triggersQuery = (projectId: string) => ({
  queryKey: [PAGE, 'triggers', projectId],
  queryFn: () => api<TriggersPage>(`/api/projects/${encodeURIComponent(projectId)}/triggers`),
  refetchInterval: POLL_MS,
});

// The inbound sources of the whole tycho, their recent acceptances and what a caller sends
// (docs/design/triggers.md §2.2, §7). The reach of the internet is asked again on the clock.
export const inboundQuery = {
  queryKey: [PAGE, 'inbound'],
  queryFn: () => api<InboundPage>('/api/inbound'),
  refetchInterval: POLL_MS,
};

// A project's uploaded attachments, interactive artifacts and docs.
export const projectFilesQuery = (projectId: string) => ({
  queryKey: [PAGE, 'project-files', projectId],
  queryFn: () => api<{ files: ProjectFileSummary[] }>(`/api/projects/${encodeURIComponent(projectId)}/files`),
});

// Unified IM group bindings across all projects, plus recently discovered unbound groups.
export const imGroupsQuery = {
  queryKey: [PAGE, 'im-groups'],
  queryFn: () => api<ImGroupsPage>('/api/im/groups'),
  refetchInterval: POLL_MS,
};

// IM group bindings scoped to one project, plus recently discovered unbound groups.
export const projectGroupsQuery = (projectId: string) => ({
  queryKey: [PAGE, 'project-groups', projectId],
  queryFn: () => api<ProjectGroupsPage>(`/api/projects/${encodeURIComponent(projectId)}/groups`),
  refetchInterval: POLL_MS,
});
