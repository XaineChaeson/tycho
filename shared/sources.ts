// A project's code sources (docs/design/code-sources.md): where a Task's code comes from, what a
// round is told about it, and what a round hands back. Declared here once, in the shape the four
// blocks build against, so that none of them waits for another and their merges do not fight
// over names.
//
// Who lands what:
//   A (ledger, dispatch): Source, TaskSource, TaskSourceState, taskSourceState, parseSources,
//      SOURCES_LEDGER_VERSION. Ledger 41 replaces a project's repo/code_dir columns with an
//      ordered sources list and gives a Task the source it is pinned to; a Task whose pinned
//      source is gone stops with the reason, as when a login is taken away.
//   B (dispatch, machine): snapshotSourceOf and the snapshot's `source` field
//      (runner/snapshot.ts). The machine clones a repository or works in a folder already on it;
//      what a round is told no longer carries a bundle or a base commit.
//   C (review, landing): Delivery, ReviewedCommit, and the reviewed-commit field on ReviewOf.
//      A review is bound to the commit a round reported and checked where it lives; landing
//      merges that commit, or the round's pull request at it.
//   D (console): sourceLabel, the project page's ordered list, and the Task page's source.
//
// What goes, by block, following §6 of the design:
//   B (done): runner/repo.ts's bundle packing and repoProblem host check, service/round-bundle.ts,
//     the dispatch staging, the bundleLimitBytes setting, node/unpack.ts (replaced by
//     node/source.ts), and the snapshot's repo/bundle/base fields are gone; the snapshot
//     carries `source` instead, and node/source.ts prepares the machine's working directory.
//   C removes service/merge.ts (merging into the host's checkout), its endpoint, and the parts of
//     accept.ts/releases.ts that exist only for a bundle; the artifact registration itself stays
//     (releases other than code still use it).
//   D removes the Task page's integrate button and the project's code_dir input.
//   A replaces the project's repo/code_dir columns with the sources list, and adds the source a
//     Task is pinned to, in the 41 migration.
//
// The node protocol rises with this (NODE_PROTOCOL in shared/node-protocol.ts): a client that
// does not speak it takes no round at all, and so none that has a source. B changes that
// constant.

import { t } from './i18n.ts';
import { machineRemote, remoteHasSecret } from './remote.ts';

// The ledger version this shape lands in. The constant is the agreement between blocks; A moves
// service/db.ts's SCHEMA_VERSION and package.json's tycho.ledger to it, and adds the migration.
export const SOURCES_LEDGER_VERSION = 41;

// A folder source the 41 migration could not name a machine for: the project had a code
// directory, but no local machine registration could be recovered for the host. It is written
// as an empty machine id — never a valid one — so the project page can ask the owner to pick
// the machine, and nothing dispatches to it until they do. parseSources refuses it as input:
// saving the list is how the owner confirms the machine.
export const PENDING_MACHINE_UID = '';

// One place a project's code can come from. `id` is stable for the life of the project and is
// what a Task pins: the ledger makes it with a ULID (service/ids.ts) when the item is added, and
// never reuses one, not even for an item that replaces a removed one. A position-derived id
// ("s1", "s2") would name a different source the moment one before it is removed or moved, and a
// Task pinned to it would silently start working somewhere else; a ULID survives every edit of
// the list and says nothing about where the item sits.
//
// A repository's `url` is stored as machineRemote (shared/remote.ts) returns it — the address the
// machine is given, with any secret and query removed — so a stored source is already the form
// the machine may use. An address that carries a login, a password or a query string is refused
// at the entry (parseSources, remoteHasSecret) rather than stored with those parts quietly
// dropped: what the owner typed and what the machine gets must not differ without a word. A
// folder's `machine_uid` is that machine's registration id (machine.uid), not the ledger row's;
// `path` is the folder as that machine names it.
export type Source =
  | { id: string; kind: 'repo'; url: string }
  | { id: string; kind: 'folder'; machine_uid: string; path: string };

// What a Task is pinned to: the id it names and the source as the project held it when the Task
// was made. The copy is never used to run anything; it is what the Task page and a stop reason
// show when the project's list has since changed or lost it. A Task of a project with no source
// at all is pinned to null: its rounds work in an empty Task directory.
export interface TaskSource {
  source_id: string;
  pinned: Source;
}

// How a pin stands against the project's list now:
//   current — the source of that id is still there, unchanged;
//   changed — the id is there but what it names is not (kind, url, machine or path differ);
//   removed — no source of that id is in the list.
export type TaskSourceState = 'current' | 'changed' | 'removed';

// A Task's source as one page and the Router's tools read it: the one projection the service
// writes (service/ledger.ts taskSourceViewOf) and the console's Task declares, so that the two
// cannot drift apart without the compiler saying so. `source` is the pin itself, `source_state`
// how it stands against the project's list now, and `source_label` how the owner reads the pin
// (sourceLabel, with the machine's name resolved where the service can). All null for a Task of
// a project with no source at all.
export interface TaskSourceView {
  source: TaskSource | null;
  source_state: TaskSourceState | null;
  source_label: string | null;
}

// A short, stable reading of what a source holds, with no dependency and the same answer on the
// host and on a machine: FNV-1a over the content. The content half of the binding identity, so
// that the whole identity is one token a directory name can carry.
function contentFingerprint(source: Source): string {
  const text = source.kind === 'repo' ? `repo\u0000${source.url}` : `folder\u0000${source.machine_uid}\u0000${source.path}`;
  let hash = 0x811c9dc5;
  for (let at = 0; at < text.length; at += 1) {
    hash ^= text.charCodeAt(at);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

// The identity of a source as a Task is bound to it: the project's id for the item and what the
// item held when the Task was pinned to it. The same id re-pointed at another address, machine or
// folder is another binding — a round of the first must never be taken as the second's work, and
// a machine must never reuse the first's checkout for it (§8.7, §8.11). This is the one function
// the dispatcher's machine fixation, the Runner's machine exemption, the review's evidence
// comparison (service/review.ts sourceAgrees) and the machine's checkout directory name
// (`tasks/<task>/<binding key>/`) all read; nothing compares by id or by address alone.
export function bindingKey(source: Source): string {
  return `${source.id}-${contentFingerprint(source)}`;
}

// The one reading of a pin, for the dispatcher, the review binding and the Task page alike: a
// `removed` pin names nothing the project has, so the Task stops and says so (the Router may
// move it with update_task; a round already running is not affected), and a `changed` pin is
// still the source of that id, which no longer holds what the Task was made with — the page
// says what differs, and the next round goes on with the pinned snapshot (§8.11); only a pin
// that can no longer be executed (removed, or a folder whose machine is still to be confirmed)
// stops the Task. Null when the Task has no source, which is not a state to show.
export function taskSourceState(sources: Source[], pinned: TaskSource | null): TaskSourceState | null {
  if (pinned === null) return null;
  const now = sources.find((source) => source.id === pinned.source_id);
  if (now === undefined) return 'removed';
  return bindingKey(now) === bindingKey(pinned.pinned) ? 'current' : 'changed';
}

// Where one round's code comes from, as the snapshot records it (Snapshot.source): a repository
// for that round's machine to clone (branch is the one it works on, when the host knows it,
// and `commit` the one a review round is checked out at), or a folder on that round's machine,
// which the executor works in directly. The machine is the snapshot's own: a folder source
// never travels to another one. This replaces the snapshot's `repo` (its base commit) and the
// bundle fetched beside the snapshot; rounds from before it keep the old fields until B
// removes them, and no round has both.
//
// `commit` is the one addition the review path needs and the contract did not carry: the
// design (§2) has a review machine clone the repository and check out the commit the reviewed
// round handed over, and `branch` alone cannot name it. A first round and every writable one
// leave it out: they work on the branch as the machine cloned it.
//
// `binding_key` is the binding identity (bindingKey) of the source this round was prepared for.
// It is carried, rather than derived on the machine, so that the machine names its checkout after
// the very binding the host will hold the round's evidence against: a Task repinned to another
// source, or to the same id re-pointed elsewhere (update_task, §8.7), gets another directory
// rather than a second repository re-pointed under the first one's uncommitted work. A round
// without one is a snapshot nobody wrote, and is refused rather than run somewhere shared.
export type SnapshotSource =
  | { kind: 'repo'; url: string; binding_key: string; branch?: string; commit?: string }
  | { kind: 'folder'; path: string; binding_key: string };

// What a round's receipt says it delivered, as one shape for settlement, the review binding and
// the landing: the receipt's `artifacts` of kind branch, commit and pr, at most one each. The
// receipt format itself does not change (runner/snapshot.ts RECEIPT_SPEC); C reads it into this
// and refuses a second item of the same kind, and the pull request's address is still checked by
// shared/pull-request.ts alone.
export interface Delivery {
  branch?: string;
  commit?: string;
  pr?: string;
}

// What a review is bound to instead of a bundle (docs/design/code-sources.md §2): the commit the
// reviewed round handed over and how it was checked. For a repository, `commit` was pushed to
// `url` on `branch`, and the round's own machine read that branch's head with git ls-remote at
// the end of the round; the host binds it to what the receipt reported, and never asks the remote
// itself. For a folder, `commit` is HEAD as that machine read it when the round ended, `path` is
// the folder it read, and `url` means nothing. The ledger fills it when it makes the binding
// (ReviewOf.reviewed, A's file); the review brief and the landing read it (C), and the landing
// matches the pull request to this commit.
export interface ReviewedCommit {
  source_kind: 'repo' | 'folder';
  commit: string;
  branch?: string;
  url?: string;
  // A folder source's own path on the machine that read it, so that the review's brief names the
  // folder the commit is in (the reviewer reads it there, §8 第 3 条). Absent in a binding made
  // before this field, and never set for a repository.
  path?: string;
}

// A source as the Router's get_project answer shows it: the source itself, whether it is the
// project's default, and the one label a page uses (sourceLabel). A renders it; D's project page
// shows the same list, and the console is the only place it is edited.
export type SourceView = Source & { default: boolean; label: string };

// A (ledger): the project's sources as the console hands them in, checked whole and normalized.
// Input is the ordered list; every item already carries its id (the caller assigns a ULID to a
// new item before this is called, so one rule names sources), ids are unique and non-empty, a
// repo's url must survive machineRemote and carry no secret (an address with a login, a password
// or a query string is refused, never stored with those parts dropped), and is stored as
// machineRemote returns it; a folder needs a machine id and a path. A refusal throws a plain
// Error whose message is already the owner's words and never repeats a secret: this
// file is shared and does not import service/, so the ledger's entry turns it into InputError.
// Nothing downstream re-checks what this accepted.
export function parseSources(input: unknown): Source[] {
  if (!Array.isArray(input)) throw new Error(t('sh.sources.err.notList'));
  const seen = new Set<string>();
  return input.map((value, index) => {
    const at = t('sh.sources.itemAt', { index: index + 1 });
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(t('sh.sources.err.notObject', { at }));
    const item = value as Record<string, unknown>;
    const id = typeof item.id === 'string' ? item.id.trim() : '';
    if (id === '') throw new Error(t('sh.sources.err.missingId', { at }));
    if (seen.has(id)) throw new Error(t('sh.sources.err.duplicateId', { id }));
    seen.add(id);
    if (item.kind === 'repo') {
      const url = typeof item.url === 'string' ? item.url.trim() : '';
      if (url === '') throw new Error(t('sh.sources.err.repoMissingUrl', { at }));
      if (remoteHasSecret(url)) throw new Error(t('sh.sources.err.repoHasSecret', { at }));
      const remote = machineRemote(url);
      if (remote === null) throw new Error(t('sh.sources.err.repoBadUrl', { at }));
      return { id, kind: 'repo', url: remote };
    }
    if (item.kind === 'folder') {
      const machineUid = typeof item.machine_uid === 'string' ? item.machine_uid.trim() : '';
      if (machineUid === '') throw new Error(t('sh.sources.err.folderMissingMachine', { at }));
      const path = typeof item.path === 'string' ? item.path.trim() : '';
      if (path === '') throw new Error(t('sh.sources.err.folderMissingPath', { at }));
      return { id, kind: 'folder', machine_uid: machineUid, path };
    }
    throw new Error(t('sh.sources.err.badKind', { at }));
  });
}

// The source a Task gets when it names none: the first. Null when the project names none, and
// then its rounds work in an empty Task directory.
export function defaultSource(sources: Source[]): Source | null {
  return sources[0] ?? null;
}

// The repositories a project names, in order. What a GitHub inbound event is routed by: the
// caller sends a repository's `owner/name`, and the projects that name that repository are the
// ones it reaches (docs/design/triggers.md §2.2). A project naming none — only folders — is
// reached by no GitHub event, which its page says instead of leaving the row blank.
export function repoUrlsOf(sources: readonly Source[]): string[] {
  return sources.flatMap((source) => (source.kind === 'repo' ? [source.url] : []));
}

// B (dispatch, machine): the source as one round is told about it. The branch a repository round
// works on is what its machine cloned, so B fills it where it knows it; this maps a source to the
// round's own shape. A review round adds the commit it checks out.
export function snapshotSourceOf(source: Source): SnapshotSource {
  const binding_key = bindingKey(source);
  if (source.kind === 'repo') return { kind: 'repo', url: source.url, binding_key };
  return { kind: 'folder', path: source.path, binding_key };
}

// D (console), and the Router's get_project answer: how the owner reads one source — the
// repository's address, or the machine and the folder. When the folder's machine is gone the
// caller passes no name, and the label says so instead of showing a registration id, which is
// not the owner's word for anything.
export function sourceLabel(source: Source, machineName?: string): string {
  if (source.kind === 'repo') return t('sh.sources.label.repo', { url: source.url });
  return machineName === undefined
    ? t('sh.sources.label.folderDeletedMachine', { path: source.path })
    : t('sh.sources.label.folderMachine', { machine: machineName, path: source.path });
}
