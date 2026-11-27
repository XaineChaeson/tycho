// What the project page and the new-project dialog do to a project's settings before
// anything is sent. All pure: the order of a project's code sources is the preference the
// service follows, so moving a source is an edit of the list, never of where the code is.
// A project's list of logins only says which may be used; which one comes first is the
// tier's global order, so the list has no order of its own (roles-and-tiers.md §11).
import { t } from '@shared/i18n.ts';
import type { Source } from '@shared/sources.ts';
import type { LoginMode, Project } from './types.ts';

// Moving one item of the ordered source list is an edit of that list.
export const moveItem = <T>(list: readonly T[], from: number, to: number): T[] => {
  if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) return [...list];
  const next = [...list];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved!);
  return next;
};

export const withoutName = (list: readonly string[], name: string): string[] => list.filter((each) => each !== name);

export const withName = (list: readonly string[], name: string): string[] => (list.includes(name) || name === '' ? [...list] : [...list, name]);

export const sameNames = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((each, index) => each === b[index]);

// A project's code source as the page edits it (docs/design/code-sources.md §1, §4): a new
// item carries no id — the service makes one when the list is saved — and is told apart
// from the others by where it stands. An existing item keeps the id it came with, so
// reordering or editing the list never moves a Task onto another source by accident.
export type DraftSource =
  | { id: string | null; kind: 'repo'; url: string }
  | { id: string | null; kind: 'folder'; machine_uid: string; path: string };

export const blankSource = (kind: 'repo' | 'folder'): DraftSource =>
  kind === 'repo' ? { id: null, kind, url: '' } : { id: null, kind, machine_uid: '', path: '' };

const draftSource = (source: Source): DraftSource => (source.kind === 'repo'
  ? { id: source.id, kind: 'repo', url: source.url }
  : { id: source.id, kind: 'folder', machine_uid: source.machine_uid, path: source.path });

export interface ProjectDraft {
  // A name is only shown; saving a changed one is one field of the same save.
  name: string;
  // The ordered code sources; the first is the project's default. Empty is a project whose
  // work runs in an empty task directory.
  sources: DraftSource[];
  // Every login there is, or only the listed ones (docs/design/project-sessions.md §1). The list
  // is kept under "every login" so that switching back finds it.
  loginMode: LoginMode;
  logins: string[];
  // By registration (machine.uid): a name can come to mean another machine before a save.
  machines: string[];
  // Deleted registrations are not in machines; only this explicit action clears them
  // when the owner leaves the visible selection unchanged.
  clearGoneMachines: boolean;
  spawnMachines: boolean;
  // What the Router may do without asking, as the switches show it.
  grants: string[];
  router?: Project["router"];
}

export const draftOf = (project: Project): ProjectDraft => ({
  name: project.name,
  sources: project.sources.map(draftSource),
  loginMode: project.login_mode,
  logins: [...project.logins],
  machines: project.machines.map(({ uid }) => uid),
  clearGoneMachines: false,
  spawnMachines: project.spawn_machines,
  grants: [...(project.grants ?? [])],
  router: project.router,
});

// The grants are a set: the order the switches were flipped in is not a change.
const sameSet = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((each) => b.includes(each));

// Only an edit of the selection or an explicit removal of deleted entries replaces the
// ledger's list. Saving another field must leave even an entirely deleted range intact.
export const machinesMoved = (project: Project, draft: ProjectDraft): boolean =>
  !sameNames(project.machines.map(({ uid }) => uid), draft.machines) || (draft.clearGoneMachines && (project.machines_gone ?? 0) > 0);

// The source list as it stands: same items in the same places, each still naming what the
// ledger holds. Ids decide which item is which, so an edit or a reorder is a change and a
// typed path with room around it is not.
const sourcesMoved = (project: Project, draft: ProjectDraft): boolean => {
  if (draft.sources.length !== project.sources.length) return true;
  return draft.sources.some((item, index) => {
    const held = project.sources[index]!;
    if (item.id !== held.id || item.kind !== held.kind) return true;
    if (item.kind === 'repo') return held.kind !== 'repo' || item.url.trim() !== held.url;
    return held.kind !== 'folder' || item.machine_uid !== held.machine_uid || item.path.trim() !== held.path;
  });
};

const routerMoved = (project: Project, draft: ProjectDraft): boolean =>
  project.router?.account !== draft.router?.account || project.router?.tier !== draft.router?.tier;

// Nothing to save when nothing moved, the code sources included. What is sent is what the
// service reads back; an empty source list clears them all, exactly as the ledger holds it.
export const changed = (project: Project, draft: ProjectDraft): boolean =>
  draft.name.trim() !== project.name
  || sourcesMoved(project, draft) || draft.loginMode !== project.login_mode || !sameNames(project.logins, draft.logins)
  || machinesMoved(project, draft)
  || draft.spawnMachines !== project.spawn_machines
  || !sameSet(draft.grants, project.grants ?? []) || routerMoved(project, draft);

// One source as the service takes it: an existing item goes with the id it is pinned by,
// and a new one without, so the service makes its ULID. Only what the shape holds is sent.
const sourceBody = (source: DraftSource): Record<string, unknown> => (source.kind === 'repo'
  ? { ...(source.id === null ? {} : { id: source.id }), kind: 'repo', url: source.url.trim() }
  : { ...(source.id === null ? {} : { id: source.id }), kind: 'folder', machine_uid: source.machine_uid, path: source.path.trim() });

// What a save sends. The mode and the list only when one of them was edited, and a list always
// with the mode it was chosen under: a list sent alone chooses "only these"
// (docs/design/project-sessions.md §1), which a save of the sources must not do to a project
// on every login. The machines only when their choice moved, like the logins: a page opened
// before a machine was deleted and joined again under its name must not put its old choice
// back by a save of another field. The sources go only when the list moved; the spawn switch
// only when it was flipped, so a save of the lists records no change to it.
export const projectBody = (project: Project, draft: ProjectDraft): Record<string, unknown> => {
  const listMoved = !sameNames(project.logins, draft.logins);
  return {
    ...(draft.name.trim() === project.name ? {} : { name: draft.name.trim() }),
    ...(listMoved || draft.loginMode !== project.login_mode ? { login_mode: draft.loginMode } : {}),
    ...(listMoved ? { logins: draft.logins } : {}),
    ...(machinesMoved(project, draft) ? { machines: draft.machines } : {}),
    ...(sourcesMoved(project, draft) ? { sources: draft.sources.map(sourceBody) } : {}),
    ...(draft.spawnMachines === project.spawn_machines ? {} : { spawn_machines: draft.spawnMachines }),
    ...(sameSet(draft.grants, project.grants ?? []) ? {} : { grants: draft.grants }),
    ...(routerMoved(project, draft) ? { router: draft.router } : {}),
  };
};

// What the answer makes of the list: the project as the service now has it.
export const withProject = (projects: readonly Project[], saved: Project): Project[] =>
  projects.some((each) => each.id === saved.id) ? projects.map((each) => (each.id === saved.id ? saved : each)) : [...projects, saved];

// The projects in sight: an archived one is out of the side column, the palette and every
// project picker, but its own pages still open (project-sessions, "项目的生命周期").
export const activeProjects = <T extends Pick<Project, 'archived_at'>>(projects: readonly T[]): T[] =>
  projects.filter(({ archived_at }) => archived_at == null);

// What "新建项目" sends (docs/design/project-sessions.md §5): a name, and the code sources for a
// project that has any; what is under "高级" only when it was set.
export interface NewProjectDraft {
  name: string;
  sources: DraftSource[];
  // By registration (machine.uid).
  machines: string[];
  spawnMachines: boolean;
}

export const newProjectBody = (draft: NewProjectDraft): Record<string, unknown> => ({
  name: draft.name.trim(),
  ...(draft.sources.length === 0 ? {} : { sources: draft.sources.map(sourceBody) }),
  ...(draft.machines.length === 0 ? {} : { machines: draft.machines }),
  ...(draft.spawnMachines ? { spawn_machines: true } : {}),
});

// A project's machine list that names machines deleted since: they match nothing, so a list
// of only them lets the project run nowhere, which is not what an empty list means.
export const machinesGoneText = (gone: number, left: number): string =>
  t(left === 0 ? 'proj.settings.machinesGoneNoneLeft' : 'proj.settings.machinesGoneSomeLeft', { gone });

export const archivedProjectIds = (projects: readonly Pick<Project, 'id' | 'archived_at'>[]): Set<string> =>
  new Set(projects.filter((project) => project.archived_at != null).map((project) => project.id));
