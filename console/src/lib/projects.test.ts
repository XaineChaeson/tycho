// Guards the project page's edits before anything is sent: a code source moved from a
// position that is not there, a name added twice, a name removed from the middle, a save
// offered when nothing moved, and a code source list that is only whitespace or differs from
// the one the service holds being taken for no edit at all — with a new source going without
// an id for the service to make one. And the switch that lets its tasks spawn
// machines: flipped and not taken for an edit, or sent with every save so that saving the
// lists writes it too. And the login mode (project-sessions §1): switched and switched back
// taken for an edit, a list sent without the mode it was chosen under, or a mode sent with a
// save that did not switch it.
import { expect, test } from 'vitest';
import { blankSource, changed, draftOf, moveItem, newProjectBody, projectBody, sameNames, withName, withProject, withoutName, type DraftSource } from './projects.ts';
import type { SourceView } from '@shared/sources.ts';
import type { Project } from './types.ts';

const repoSource = (id: string, url: string): SourceView => ({ id, kind: 'repo', url, default: false, label: `仓库 ${url}` });
const folderSource = (id: string, machine: string, path: string): SourceView => ({ id, kind: 'folder', machine_uid: machine, path, default: false, label: `${machine} 上的 ${path}` });

const project = (over: Partial<Project> = {}): Project => ({
  id: 'p', name: '试跑',
  sources: [
    { ...repoSource('s1', 'https://example.com/repo.git'), default: true },
    folderSource('s2', 'uid-h1', '/work/app'),
  ],
  login_mode: 'selected', logins: ['t2', 'h1/codex'], machines: [{ uid: 'uid-h1', name: 'h1' }], spawn_machines: false, moving: 0, waiting: 0, ...over,
});

test('moving a source is the whole edit: the order changes, nothing else does', () => {
  expect(moveItem(['a', 'b', 'c'], 2, 0)).toEqual(['c', 'a', 'b']);
  expect(moveItem(['a', 'b', 'c'], 0, 1)).toEqual(['b', 'a', 'c']);
  // Nowhere to move is not a move.
  expect(moveItem(['a', 'b'], 0, -1)).toEqual(['a', 'b']);
  expect(moveItem(['a', 'b'], 1, 2)).toEqual(['a', 'b']);
  expect(moveItem(['a', 'b'], 1, 1)).toEqual(['a', 'b']);
  expect(moveItem([1, 2, 3], 0, 2)).toEqual([2, 3, 1]);
});
test('adding never makes a second entry; removing takes the one name', () => {
  expect(withName(['a'], 'b')).toEqual(['a', 'b']);
  expect(withName(['a'], 'a')).toEqual(['a']);
  expect(withName(['a'], '')).toEqual(['a']);
  expect(withoutName(['a', 'b', 'a'], 'a')).toEqual(['b']);
});

test('nothing to save when neither list moved', () => {
  const p = project();
  expect(changed(p, draftOf(p))).toBe(false);
  // The list is storage order, but a different list is a different list.
  expect(changed(p, { ...draftOf(p), logins: ['h1/codex', 't2'] })).toBe(true);
  expect(changed(p, { ...draftOf(p), machines: [] })).toBe(true);
  expect(sameNames(['a', 'b'], ['a', 'b'])).toBe(true);
  expect(sameNames(['a', 'b'], ['b', 'a'])).toBe(false);
});

// A new source is a row with no id; the service makes one. Its kind decides which fields
// count, so a path typed into a folder row and an address into a repository row are edits
// of the same list.
test('a source list is an edit on its own: a new item, an emptied list, a reorder or a changed field', () => {
  const p = project();
  const held = draftOf(p);
  expect(changed(p, held)).toBe(false);
  expect(changed(p, { ...held, sources: [...held.sources, blankSource('repo')] })).toBe(true);
  expect(changed(p, { ...held, sources: [] })).toBe(true);
  expect(changed(p, { ...held, sources: moveItem(held.sources, 1, 0) })).toBe(true);
  const retyped = held.sources.map((source, index): DraftSource => (index === 1 ? { ...blankSource('repo'), id: source.id } : source));
  expect(changed(p, { ...held, sources: retyped })).toBe(true);
  // Whitespace around a path or an address is not an edit: the service holds the trimmed value.
  const spaced = held.sources.map((source, index): DraftSource => (index === 1 && source.kind === 'folder' ? { ...source, path: '  /work/app  ' } : source));
  expect(changed(p, { ...held, sources: spaced })).toBe(false);
  expect(blankSource('folder')).toEqual({ id: null, kind: 'folder', machine_uid: '', path: '' });
});

test('the sources go only when the list moved, existing items with their id and new ones without', () => {
  const p = project();
  const held = draftOf(p);
  expect(projectBody(p, held)).toEqual({});
  const added = [...held.sources, blankSource('folder')];
  expect(projectBody(p, { ...held, sources: added }).sources).toEqual([
    { id: 's1', kind: 'repo', url: 'https://example.com/repo.git' },
    { id: 's2', kind: 'folder', machine_uid: 'uid-h1', path: '/work/app' },
    { kind: 'folder', machine_uid: '', path: '' },
  ]);
  // Emptied: the empty list goes, so the service stores no source at all.
  expect(projectBody(p, { ...held, sources: [] })).toEqual({ sources: [] });
  // Trimmed on the way out, as it was compared.
  const trimmed = held.sources.map((source, index): DraftSource => (index === 0 && source.kind === 'repo' ? { ...source, url: '  https://example.com/other.git  ' } : source));
  expect(projectBody(p, { ...held, sources: trimmed }).sources).toEqual([
    { id: 's1', kind: 'repo', url: 'https://example.com/other.git' },
    { id: 's2', kind: 'folder', machine_uid: 'uid-h1', path: '/work/app' },
  ]);
});

test('the answer puts the project as the service now has it', () => {
  const listed = [project(), project({ id: 'q', name: '别的' })];
  expect(withProject(listed, project({ logins: ['t1'] }))[0]!.logins).toEqual(['t1']);
  expect(withProject(listed, project({ id: 'gone', name: '新' })).map(({ id }) => id)).toEqual(['p', 'q', 'gone']);
});

test('the spawn switch is an edit of its own, and goes only in a save that flips it', () => {
  const p = project();
  expect(draftOf(p).spawnMachines).toBe(false);
  expect(changed(p, { ...draftOf(p), spawnMachines: true })).toBe(true);
  // The logins go only when they were edited: sending a list chooses "only these".
  expect(projectBody(p, draftOf(p))).toEqual({});
  expect(projectBody(p, { ...draftOf(p), spawnMachines: true })).toEqual({ spawn_machines: true });
  expect(projectBody(p, { ...draftOf(p), logins: ['h1/codex'] })).toEqual({ login_mode: 'selected', logins: ['h1/codex'] });
  const on = project({ spawn_machines: true });
  expect(projectBody(on, { ...draftOf(on), spawnMachines: false })).toEqual({ spawn_machines: false });
});

test('the login mode is an edit of its own; switched back is no edit; a list goes with its mode', () => {
  const p = project();
  expect(draftOf(p).loginMode).toBe('selected');
  const every = { ...draftOf(p), loginMode: 'all' as const };
  expect(changed(p, every)).toBe(true);
  expect(projectBody(p, every)).toEqual({ login_mode: 'all' });
  expect(changed(p, { ...every, loginMode: 'selected' })).toBe(false);
  // A list edited and then every login chosen: both go, so the list is kept as edited.
  expect(projectBody(p, { ...every, logins: ['h1/codex'] })).toEqual({ login_mode: 'all', logins: ['h1/codex'] });
  const all = project({ login_mode: 'all' });
  expect(projectBody(all, { ...draftOf(all), loginMode: 'selected' })).toEqual({ login_mode: 'selected' });
  // Another field saved on a project of every login says nothing of its mode.
  expect(projectBody(all, { ...draftOf(all), spawnMachines: true })).toEqual({ spawn_machines: true });
  expect(projectBody(p, { ...draftOf(p), logins: [] })).toEqual({ login_mode: 'selected', logins: [] });
});

// A page opened before a machine was deleted and joined again under its name holds the old
// registration. A save of another field must not send it back: the choice of machines goes
// only when it moved, as the logins do. Deleted entries alone are not an edit.
test('the choice of machines is sent only when it moved, by registration', () => {
  const p = project();
  expect(projectBody(p, { ...draftOf(p), spawnMachines: true })).not.toHaveProperty('machines');
  expect(projectBody(p, { ...draftOf(p), machines: ['uid-h1', 'uid-h2'] }).machines).toEqual(['uid-h1', 'uid-h2']);
  expect(projectBody(p, { ...draftOf(p), machines: [] }).machines).toEqual([]);
  const stale = project({ machines: [], machines_gone: 1 });
  expect(changed(stale, draftOf(stale))).toBe(false);
  for (const edit of [{ spawnMachines: true }, { loginMode: 'all' as const }, { logins: ['t2'] }]) {
    expect(projectBody(stale, { ...draftOf(stale), ...edit })).not.toHaveProperty('machines');
  }
});

// What the Router may do without asking: a set the owner edits like any field, sent only when it
// moved, and not by an older service's page that never showed it.
test('the grants are an edit of their own, as a set, and go only in a save that moves them', () => {
  const p = project({ grants: ['accept'] });
  expect(draftOf(p).grants).toEqual(['accept']);
  expect(changed(p, { ...draftOf(p), grants: ['accept', 'integrate'] })).toBe(true);
  expect(projectBody(p, { ...draftOf(p), grants: ['accept', 'integrate'] })).toEqual({ grants: ['accept', 'integrate'] });
  expect(projectBody(p, { ...draftOf(p), grants: [] })).toEqual({ grants: [] });
  const both = project({ grants: ['accept', 'release'] });
  expect(changed(both, { ...draftOf(both), grants: ['release', 'accept'] })).toBe(false);
  const older = project();
  expect(draftOf(older).grants).toEqual([]);
  expect(projectBody(older, draftOf(older))).toEqual({});
});

// docs/design/code-sources.md §4: a project may be made with no source at all, and each new
// source goes without an id so the service makes one.
test('a new project sends the sources it was given, and nothing when it was given none', () => {
  expect(newProjectBody({ name: '  新项目  ', sources: [], machines: [], spawnMachines: false })).toEqual({ name: '新项目' });
  const sources: DraftSource[] = [
    { id: null, kind: 'repo', url: '  https://example.com/repo.git  ' },
    { id: null, kind: 'folder', machine_uid: 'uid-h1', path: '  /work/app  ' },
  ];
  expect(newProjectBody({ name: '新项目', sources, machines: [], spawnMachines: false })).toEqual({
    name: '新项目',
    sources: [
      { kind: 'repo', url: 'https://example.com/repo.git' },
      { kind: 'folder', machine_uid: 'uid-h1', path: '/work/app' },
    ],
  });
});
