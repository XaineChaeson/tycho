import { closeSync, existsSync, fsyncSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import type { SQLInputValue } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { isTierId, type TierId } from '../shared/tiers.ts';
import { NO_ROLE_REASON, ORCHESTRATE_ROLE_ID, PRESET_ROLES, VERIFY_ROLE_ID } from '../shared/roles.ts';
import { DEFAULT_GRANTS } from '../shared/grants.ts';
import { PENDING_MACHINE_UID, type Source } from '../shared/sources.ts';
import { machineRemote } from '../shared/remote.ts';
import { ulid } from './ids.ts';
import { bindProjectHomeGuard } from './project-home-guard.ts';
import { PROJECT_HOME_KEY_PREFIX, type ProjectHome, type ProjectOwnership } from './project-home.ts';

export const SCHEMA_VERSION = 48;
// 42 adds admitted Router calls and links their committed business changes.
// 41 is code sources (docs/design/code-sources.md; shared/sources.ts SOURCES_LEDGER_VERSION):
// a project's repo/code_dir columns become an ordered sources list, and a Task is pinned to the
// source it works on. The step reads each project's old columns before it drops them.
// The oldest ledger this program still takes forward. An older one needs a program from
// in between.
const OLDEST_VERSION = 4;
// A project's grants before the owner changes them, as SQL text.
const GRANTS_DEFAULT = JSON.stringify(DEFAULT_GRANTS);

const ROUTER_CALL_SCHEMA = `
CREATE TABLE IF NOT EXISTS router_call (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL REFERENCES message(id) ON DELETE CASCADE,
  message_ids_json TEXT NOT NULL,
  context_id TEXT REFERENCES router_context(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  started_at TEXT NOT NULL,
  request TEXT,
  result TEXT,
  result_state TEXT,
  receipt_at TEXT,
  finished_at TEXT,
  operation_key TEXT,
  operation_hash TEXT,
  operation_result TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS router_call_operation ON router_call(project_id, operation_key) WHERE operation_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS router_call_message ON router_call(message_id, id);

CREATE TABLE IF NOT EXISTS router_exchange (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES message(id) ON DELETE CASCADE,
  context_id TEXT NOT NULL REFERENCES router_context(id) ON DELETE CASCADE,
  phase TEXT NOT NULL CHECK (phase IN ('material', 'request')),
  started_at TEXT NOT NULL,
  input TEXT NOT NULL,
  template_hash TEXT NOT NULL REFERENCES router_template(hash),
  output TEXT,
  outcome TEXT,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS router_exchange_message ON router_exchange(message_id, id);
CREATE INDEX IF NOT EXISTS router_exchange_context ON router_exchange(context_id);

CREATE TABLE IF NOT EXISTS inbound_receipt_reply (
  fire_id TEXT PRIMARY KEY REFERENCES trigger_fire(id) ON DELETE CASCADE,
  text TEXT
);

CREATE TABLE IF NOT EXISTS router_template (
  hash TEXT PRIMARY KEY,
  text TEXT NOT NULL
);
`;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS project (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  name TEXT NOT NULL,
  logins_json TEXT NOT NULL DEFAULT '[]',
  -- The machines it may run on, by machine.uid; empty is any machine.
  machines_json TEXT NOT NULL DEFAULT '[]',
  spawn_machines INTEGER NOT NULL DEFAULT 0,
  login_mode TEXT NOT NULL DEFAULT 'selected',
  -- When the owner paused it; null while it runs.
  paused_at TEXT,
  -- What its Router may do without asking (shared/grants.ts).
  grants_json TEXT NOT NULL DEFAULT '${GRANTS_DEFAULT}',
  -- When the owner archived it; null while it is in sight (project-sessions, "项目的生命周期").
  archived_at TEXT,
  -- Where its code comes from, in order, the first being the default (docs/design/code-sources.md;
  -- shared/sources.ts Source).
  sources_json TEXT NOT NULL DEFAULT '[]',
  router_account TEXT,
  router_tier TEXT CHECK (router_tier IS NULL OR router_tier IN ('operate', 'execute', 'decide')),
  dispatch_order_json TEXT
);

-- A knowledge gate or curation Task belongs to no project (docs/design/knowledge-and-skills.md §3).
CREATE TABLE IF NOT EXISTS task (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  project_id TEXT REFERENCES project(id),
  parent_id TEXT REFERENCES task(id),
  title TEXT NOT NULL,
  goal TEXT NOT NULL,
  scope TEXT,
  acceptance TEXT,
  revision INTEGER NOT NULL DEFAULT 1,
  login_id TEXT,
  priority INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL,
  reason TEXT,
  wake_at TEXT,
  created_by TEXT NOT NULL,
  closed_at TEXT,
  role_id TEXT,
  tier_override TEXT,
  tier_reason TEXT,
  tier_escalated INTEGER NOT NULL DEFAULT 0,
  review_of_json TEXT,
  verdict_json TEXT,
  knowledge_json TEXT,
  trigger_fire_id TEXT,
  -- The skills the Task names, which its rounds are given in full (docs/design/knowledge-and-skills.md §4.1).
  skills_json TEXT,
  -- The merge round a Task was made as (service/land.ts): the parent it lands, the pull request
  -- and the reviewed commit; null for every other Task. Written when the Task is made, never edited.
  landing_json TEXT,
  -- The logins the Router asked to try first, in its order, with why (roles-and-tiers.md §11).
  prefer_json TEXT,
  -- The project source the Task works on, as it stood when the Task was pinned (shared/sources.ts
  -- TaskSource); null when its project names no source or the Task uses the default empty task directory.
  source_json TEXT,
  -- Optional target machine pinned on the Task (machine.id); null lets the dispatcher choose.
  machine_id TEXT
);

CREATE TABLE IF NOT EXISTS run (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  task_id TEXT NOT NULL REFERENCES task(id),
  task_revision INTEGER NOT NULL,
  login_id TEXT,
  login_name TEXT,
  host TEXT NOT NULL,
  session_ref TEXT,
  state TEXT NOT NULL,
  marker TEXT NOT NULL,
  exit_code INTEGER,
  exit_kind TEXT,
  receipt_json TEXT,
  snapshot_json TEXT NOT NULL,
  error_json TEXT,
  started_at TEXT,
  ended_at TEXT,
  last_progress_at TEXT,
  machine_id TEXT,
  node_id TEXT,
  artifacts_json TEXT,
  -- When the host's registered copies of this round were cleared after the work ended and its
  -- retention period passed (docs/design/phase1-design.md "已结束的工作"); null while they stand.
  releases_dropped_at TEXT,
  -- When this round's Task's code copy was cleared on the machine it ran on, by the same rule;
  -- null while it stands (or while no machine can be asked).
  code_dropped_at TEXT,
  settlement_digest TEXT,
  capture_result_json TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS run_one_active ON run(task_id) WHERE state != 'ended';

CREATE TABLE IF NOT EXISTS message (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  channel TEXT NOT NULL,
  external_id TEXT NOT NULL,
  thread TEXT,
  direction TEXT NOT NULL,
  actor TEXT,
  text TEXT NOT NULL,
  state TEXT,
  final INTEGER NOT NULL DEFAULT 0,
  at TEXT NOT NULL,
  project_id TEXT REFERENCES project(id),
  segment_id TEXT REFERENCES router_segment(id),
  basis TEXT,
  candidates_json TEXT,
  task_id TEXT REFERENCES task(id),
  attachments_json TEXT,
  reply_to_external_id TEXT,
  UNIQUE (channel, external_id)
);

CREATE INDEX IF NOT EXISTS message_by_project ON message(project_id, state);

CREATE TABLE IF NOT EXISTS input (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  task_id TEXT NOT NULL REFERENCES task(id),
  text TEXT NOT NULL,
  actor TEXT NOT NULL,
  message_id TEXT REFERENCES message(id),
  state TEXT NOT NULL,
  run_id TEXT REFERENCES run(id)
);

CREATE TABLE IF NOT EXISTS approval (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  task_id TEXT NOT NULL REFERENCES task(id),
  run_id TEXT REFERENCES run(id),
  task_revision INTEGER NOT NULL,
  questions_json TEXT NOT NULL,
  state TEXT NOT NULL,
  answers_json TEXT,
  answered_by TEXT,
  answered_via TEXT,
  decided_at TEXT,
  review_task_id TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS approval_one_open ON approval(task_id) WHERE state = 'open';

CREATE TABLE IF NOT EXISTS outbox (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  channel TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  state TEXT NOT NULL,
  tries INTEGER NOT NULL DEFAULT 0,
  next_at TEXT NOT NULL,
  error TEXT,
  first_failed_at TEXT
);

-- A project's Router conversation is a run of segments, one of them current
-- (docs/design/project-sessions.md §1).
CREATE TABLE IF NOT EXISTS router_segment (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES project(id),
  seq INTEGER NOT NULL,
  state TEXT NOT NULL,
  closed_at TEXT,
  UNIQUE (project_id, seq)
);

CREATE UNIQUE INDEX IF NOT EXISTS router_segment_one_current ON router_segment(project_id) WHERE state = 'current';

-- One executor context of a segment: what a Router process is started and resumed as. A row
-- with no segment is the old global Router's, kept as the read-only record (§6). live_at:
-- a process of it may still be running — set at a spawn, cleared only once a scan for its
-- marker found nothing, so a stop, an upgrade and a rollback know every marker to look for.
CREATE TABLE IF NOT EXISTS router_context (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  segment_id TEXT REFERENCES router_segment(id),
  project_id TEXT REFERENCES project(id),
  session_ref TEXT,
  pid INTEGER,
  marker TEXT NOT NULL,
  state TEXT NOT NULL,
  login_id TEXT,
  credential_ref TEXT,
  launch_json TEXT,
  live_at TEXT,
  last_turn_at TEXT,
  closed_at TEXT,
  closed_reason TEXT,
  material_json TEXT,
  knowledge_json TEXT,
  login_name TEXT,
  -- How large the context was at the last call the executor reported, in tokens.
  context_tokens INTEGER
);

CREATE UNIQUE INDEX IF NOT EXISTS router_context_one_open ON router_context(project_id) WHERE state = 'open';

-- The WeCom front desk's current project of one bot, chat and sender (project-sessions §1).
CREATE TABLE IF NOT EXISTS front_desk (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  bot TEXT NOT NULL,
  chat TEXT NOT NULL,
  sender TEXT NOT NULL,
  project_id TEXT REFERENCES project(id),
  UNIQUE (bot, chat, sender)
);

-- What reaches the owner by its level (§2.1): a waiting item while it may still be reminded
-- (last_at: when it last went out), a result while it is held for its project's window.
CREATE TABLE IF NOT EXISTS push (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  key TEXT NOT NULL UNIQUE,
  level TEXT NOT NULL,
  kind TEXT NOT NULL,
  project_id TEXT REFERENCES project(id),
  payload_json TEXT NOT NULL,
  state TEXT NOT NULL,
  reminded INTEGER NOT NULL DEFAULT 0,
  last_at TEXT
);

CREATE INDEX IF NOT EXISTS push_open ON push(state, level);

-- Triggers (docs/design/triggers.md §1): the rule, each accepted occurrence, and for a scheduled
-- rule how far its moments have been dealt with. "trigger" is a keyword, hence the names.
-- rejected_*: occurrences that were not accepted write no record, only these (§1). streak_*: the
-- refusals or failures of one kind in a row; problem_since: when that run became a problem the
-- owner is told about (§8), null while it is not one; alerted_at: when a signature problem of it
-- was last told, which bounds how often that is.
CREATE TABLE IF NOT EXISTS trigger_rule (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES project(id),
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL,
  source TEXT NOT NULL,
  params_json TEXT NOT NULL,
  instruction TEXT NOT NULL,
  missed TEXT NOT NULL,
  expires_at TEXT,
  push_final INTEGER NOT NULL,
  revision INTEGER NOT NULL,
  created_by TEXT NOT NULL,
  deleted_at TEXT,
  rejected_count INTEGER NOT NULL DEFAULT 0,
  rejected_at TEXT,
  rejected_reason TEXT,
  streak_reason TEXT,
  streak_count INTEGER NOT NULL DEFAULT 0,
  problem_since TEXT,
  alerted_at TEXT,
  broadcast_groups INTEGER NOT NULL DEFAULT 0,
  broadcast_group_ids_json TEXT NOT NULL DEFAULT '[]'
);

CREATE INDEX IF NOT EXISTS trigger_rule_by_project ON trigger_rule(project_id);

-- An inbound source (docs/design/triggers.md §2.2): one caller of the whole tycho, its
-- translator kind, the projects it may deliver to, and its note for the Router. Its keys and
-- the run of refusals that makes a problem the owner is told about (§8) hang off it as they
-- did off a per-project trigger. The secret itself is a file under secrets/triggers named by
-- the key's id; the ledger holds when a key stops verifying, so a restart never extends it.
CREATE TABLE IF NOT EXISTS inbound_source (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  projects_json TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  push_final INTEGER NOT NULL,
  enabled INTEGER NOT NULL,
  created_by TEXT NOT NULL,
  deleted_at TEXT,
  rejected_count INTEGER NOT NULL DEFAULT 0,
  rejected_at TEXT,
  rejected_reason TEXT,
  streak_reason TEXT,
  streak_count INTEGER NOT NULL DEFAULT 0,
  problem_since TEXT,
  -- For a full-queue problem: the project whose queue it is about, so draining that one ends it.
  streak_project_id TEXT,
  alerted_at TEXT,
  result_reply INTEGER NOT NULL DEFAULT 0 CHECK (result_reply IN (0,1)),
  broadcast_groups INTEGER NOT NULL DEFAULT 0,
  broadcast_group_ids_json TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS inbound_key (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES inbound_source(id),
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  retires_at TEXT
);

CREATE INDEX IF NOT EXISTS inbound_key_by_source ON inbound_key(source_id);

-- One accepted occurrence. Its identity is the trigger and the source's event id while it is
-- kept (released_at null), or, for an inbound source, the source, the project and the event id
-- (§2.2, §4); what it delivered is a message, whose text is the frozen rendering. A source
-- occurrence freezes no revision: a source has none, and its message is rendered as accepted.
CREATE TABLE IF NOT EXISTS trigger_fire (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  trigger_id TEXT REFERENCES trigger_rule(id),
  source_id TEXT REFERENCES inbound_source(id),
  project_id TEXT NOT NULL REFERENCES project(id),
  event_id TEXT NOT NULL,
  digest TEXT NOT NULL,
  scheduled_at TEXT,
  revision INTEGER,
  periodic INTEGER NOT NULL,
  data_json TEXT NOT NULL,
  message_id TEXT REFERENCES message(id),
  outcome TEXT NOT NULL,
  merged_into TEXT REFERENCES trigger_fire(id),
  merged_count INTEGER NOT NULL,
  merged_capped INTEGER NOT NULL DEFAULT 0,
  push_final INTEGER NOT NULL,
  keep_until TEXT NOT NULL,
  released_at TEXT,
  broadcast_groups INTEGER NOT NULL DEFAULT 0,
  broadcast_group_ids_json TEXT NOT NULL DEFAULT '[]',
  CHECK ((trigger_id IS NOT NULL) + (source_id IS NOT NULL) = 1)
);

CREATE UNIQUE INDEX IF NOT EXISTS trigger_fire_rule_identity ON trigger_fire(trigger_id, event_id) WHERE released_at IS NULL AND trigger_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS trigger_fire_source_identity ON trigger_fire(source_id, project_id, event_id) WHERE released_at IS NULL AND source_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS trigger_fire_by_message ON trigger_fire(message_id);
CREATE INDEX IF NOT EXISTS trigger_fire_by_time ON trigger_fire(created_at);
CREATE INDEX IF NOT EXISTS trigger_fire_by_source ON trigger_fire(source_id);

-- The last scheduled moment of a rule that was dealt with: only ever moves forward (§5).
CREATE TABLE IF NOT EXISTS trigger_cursor (
  trigger_id TEXT PRIMARY KEY REFERENCES trigger_rule(id),
  done_at TEXT NOT NULL
);

${ROUTER_CALL_SCHEMA}
CREATE TABLE IF NOT EXISTS change (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  at TEXT NOT NULL,
  actor TEXT NOT NULL,
  message_id TEXT REFERENCES message(id),
  task_id TEXT REFERENCES task(id),
  run_id TEXT REFERENCES run(id),
  action TEXT NOT NULL,
  detail_json TEXT,
  tool_call_id TEXT REFERENCES router_call(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS change_tool_call ON change(tool_call_id) WHERE tool_call_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS setting (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  key TEXT NOT NULL UNIQUE,
  value_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS account (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  executor TEXT NOT NULL,
  tiers_json TEXT NOT NULL,
  permission_mode TEXT,
  timeout_ms INTEGER,
  max_runs INTEGER,
  credential_ref TEXT,
  -- For an account that is a line to a model service: the line as its executor's adapter
  -- checked it, without its key (which credential_ref names). Null for any other account.
  provider_json TEXT,
  -- When the token this account holds now was stored; null when nothing recorded one
  -- (docs/design/native-login.md §2). A fact about the credential, not part of its configuration.
  credential_at TEXT
);

CREATE TABLE IF NOT EXISTS machine_login (
  id TEXT NOT NULL UNIQUE,
  machine_uid TEXT NOT NULL,
  machine_id TEXT NOT NULL,
  executor TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  tiers_json TEXT NOT NULL,
  permission_mode TEXT,
  timeout_ms INTEGER,
  max_runs INTEGER,
  PRIMARY KEY (machine_id, executor)
);

-- A machine's own login of one executor that the owner removed in this registration: the host
-- does not adopt it again while the machine keeps reporting it signed in. It is cleared by a
-- sign-in made through tycho, or by the owner setting the login up, and it goes with the
-- machine. A machine joined again is another registration (machine.uid) and inherits none.
CREATE TABLE IF NOT EXISTS machine_login_refusal (
  machine_uid TEXT NOT NULL,
  executor TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (machine_uid, executor)
);

CREATE TABLE IF NOT EXISTS machine (
  id TEXT PRIMARY KEY,
  -- One registration of a machine, never used again: what a project's machine list names, so
  -- that a machine joining later under a deleted machine's name is not in it (nodes.md §5.4).
  uid TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  host TEXT NOT NULL,
  note TEXT,
  node_id TEXT NOT NULL,
  token_hash TEXT,
  platform TEXT,
  joined_at TEXT,
  last_seen_at TEXT,
  source TEXT,
  ephemeral INTEGER NOT NULL DEFAULT 0,
  invite_id TEXT,
  claim_hash TEXT,
  drain_at TEXT,
  evidence_at TEXT,
  left_at TEXT,
  left_reason TEXT,
  destroyed_at TEXT,
  destroyed_by TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS machine_one_uid ON machine(uid);
CREATE UNIQUE INDEX IF NOT EXISTS machine_one_node ON machine(node_id);
CREATE UNIQUE INDEX IF NOT EXISTS machine_one_token ON machine(token_hash) WHERE token_hash IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS machine_one_claim ON machine(claim_hash) WHERE claim_hash IS NOT NULL;

CREATE TABLE IF NOT EXISTS machine_invite (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES project(id),
  task_id TEXT NOT NULL REFERENCES task(id),
  executors_json TEXT,
  expires_at TEXT NOT NULL,
  max_machines INTEGER NOT NULL,
  revoked_at TEXT
);

CREATE TABLE IF NOT EXISTS machine_material (
  hash TEXT PRIMARY KEY,
  invite_id TEXT NOT NULL REFERENCES machine_invite(id),
  run_id TEXT NOT NULL,
  handed_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT
);

CREATE INDEX IF NOT EXISTS machine_material_by_invite ON machine_material(invite_id);

CREATE TABLE IF NOT EXISTS login_state (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  rest_seq INTEGER,
  rest_until TEXT,
  rest_streak INTEGER NOT NULL DEFAULT 0,
  rest_reason TEXT,
  usage_json TEXT NOT NULL DEFAULT '{}',
  credential_rejected_ref TEXT,
  models_json TEXT NOT NULL DEFAULT '[]',
  models_at TEXT,
  auth_failed_at TEXT,
  identity_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS role (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  name TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL,
  default_tier TEXT NOT NULL,
  permission TEXT NOT NULL,
  deliverable TEXT NOT NULL,
  needs_review INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS knowledge (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  kind TEXT NOT NULL,
  revision INTEGER NOT NULL,
  state TEXT NOT NULL,
  retired_at TEXT,
  retired_by TEXT,
  retired_reason TEXT,
  replaced_by TEXT,
  retired_proposal_id TEXT
);

CREATE TABLE IF NOT EXISTS knowledge_proposal (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  kind TEXT NOT NULL,
  change_json TEXT NOT NULL,
  final_json TEXT,
  why_json TEXT NOT NULL,
  source TEXT NOT NULL,
  proposed_by TEXT NOT NULL,
  client_id TEXT NOT NULL,
  request_id TEXT,
  task_id TEXT REFERENCES task(id),
  run_id TEXT REFERENCES run(id),
  amended_from TEXT REFERENCES knowledge_proposal(id),
  next_id TEXT,
  digest TEXT NOT NULL,
  content_digest TEXT NOT NULL,
  final_digest TEXT,
  prior_rejection_id TEXT REFERENCES knowledge_proposal(id),
  gate_task_id TEXT REFERENCES task(id),
  gate_json TEXT,
  owner_reasons_json TEXT,
  state TEXT NOT NULL,
  state_reason TEXT,
  decided_at TEXT,
  decided_by TEXT,
  decided_via TEXT,
  decision_note TEXT,
  published_at TEXT,
  reviewed_at TEXT,
  reviewed_by TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS knowledge_proposal_request ON knowledge_proposal(client_id, request_id) WHERE request_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS knowledge_revision (
  knowledge_id TEXT NOT NULL REFERENCES knowledge(id),
  revision INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  title TEXT NOT NULL,
  when_to_use TEXT NOT NULL,
  body TEXT NOT NULL,
  projects_json TEXT,
  loading TEXT NOT NULL,
  roles_json TEXT NOT NULL,
  proposal_id TEXT NOT NULL REFERENCES knowledge_proposal(id),
  published_by TEXT NOT NULL,
  PRIMARY KEY (knowledge_id, revision)
);

CREATE TABLE IF NOT EXISTS knowledge_evidence (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  proposal_id TEXT NOT NULL REFERENCES knowledge_proposal(id),
  seq INTEGER NOT NULL,
  source TEXT NOT NULL,
  ref TEXT,
  location TEXT NOT NULL,
  excerpt TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  submitted_by TEXT NOT NULL,
  verified INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS knowledge_evidence_by_proposal ON knowledge_evidence(proposal_id);

CREATE TABLE IF NOT EXISTS knowledge_client (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  name TEXT NOT NULL,
  executor TEXT NOT NULL,
  grants_json TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  revoked_at TEXT
);

-- What an executor reported as used: one row per model of a Worker round, a Router turn or
-- a quota read (docs/design/usage.md). Exactly one of run_id, context_id and login_id says
-- whose use it was: a round's or a context's login is the one it ran as. The figures are the
-- executor's own, input not overlapping the cache; list_cost_usd only where it priced the use
-- at list prices. model_basis: 'reported' when the executor named the model, 'tier' when it is
-- the model the round's tier asked for. at: when it was recorded, a round's end for a round.
CREATE TABLE IF NOT EXISTS usage (
  id TEXT PRIMARY KEY,
  at TEXT NOT NULL,
  run_id TEXT REFERENCES run(id),
  context_id TEXT REFERENCES router_context(id),
  login_id TEXT,
  model TEXT,
  model_basis TEXT,
  -- Null on a row that stands for a unit which reported no figure at all: a round that started
  -- and said nothing has no count and no model, and the row keeps its duration instead
  -- (docs/design/usage.md §4). Zero is a figure the executor did report; null is the absence
  -- of one, and the two are never mixed.
  input_tokens INTEGER,
  output_tokens INTEGER,
  cache_read_tokens INTEGER,
  cache_write_tokens INTEGER,
  list_cost_usd REAL,
  -- How long the unit stood for, kept here when the round that knew it goes: a live round's
  -- duration is its start and end, and a deleted project's is what the deletion deposited.
  duration_ms INTEGER,
  -- What a row was before a project's deletion took the round or context it pointed at, and
  -- which unit that use belonged to: its figures and its count stay, and the usage page shows
  -- it as its own class rather than as a quota read (docs/design/usage.md §4).
  dropped_source TEXT,
  dropped_unit TEXT,
  -- At most one owner: deleting a project may leave a row of use with none, so that the
  -- totals stay and only the link to the round or context goes. A row that lost its owner
  -- this way says what it was in dropped_source, and names its unit in dropped_unit.
  CHECK ((run_id IS NOT NULL) + (context_id IS NOT NULL) + (login_id IS NOT NULL) <= 1),
  CHECK (dropped_source IS NULL OR (dropped_source IN ('run', 'router') AND dropped_unit IS NOT NULL AND run_id IS NULL AND context_id IS NULL))
);

CREATE INDEX IF NOT EXISTS usage_at ON usage(at);
CREATE INDEX IF NOT EXISTS usage_run ON usage(run_id) WHERE run_id IS NOT NULL;

-- What a deleted project left on disk: one row per Run whose host registrations or machine
-- code copy is not confirmed gone yet (project-sessions, "项目的生命周期"). It names no
-- project, Task or Run by foreign key: their rows are gone, and this is what keeps the
-- cleanup going after them. A null moment means that part is still to be removed;
-- releases_json are the registration directories the host holds for the round.
CREATE TABLE IF NOT EXISTS work_cleanup (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  project_id TEXT NOT NULL,
  project_name TEXT NOT NULL,
  run_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  machine_id TEXT,
  node_id TEXT,
  releases_json TEXT NOT NULL,
  releases_dropped_at TEXT,
  code_dropped_at TEXT,
  output_release_json TEXT
);

CREATE INDEX IF NOT EXISTS work_cleanup_by_run ON work_cleanup(run_id);
CREATE INDEX IF NOT EXISTS work_cleanup_pending ON work_cleanup(releases_dropped_at, code_dropped_at);

CREATE TABLE IF NOT EXISTS project_file (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id),
  name TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('upload', 'artifact', 'doc')),
  origin TEXT NOT NULL CHECK (origin IN ('owner', 'router', 'worker')),
  summary TEXT,
  message_id TEXT REFERENCES message(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS project_file_by_project ON project_file(project_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS project_files_cleanup (
  project_id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  project_name TEXT NOT NULL,
  dropped_at TEXT
);

CREATE INDEX IF NOT EXISTS project_files_cleanup_pending ON project_files_cleanup(dropped_at);

CREATE TABLE IF NOT EXISTS im_group_binding (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('wecom', 'weixin')),
  chat_id TEXT NOT NULL,
  chat_name TEXT NOT NULL DEFAULT '',
  project_id TEXT NOT NULL REFERENCES project(id),
  enabled INTEGER NOT NULL DEFAULT 1,
  trigger_mode TEXT NOT NULL DEFAULT 'mention_only' CHECK (trigger_mode IN ('mention_only', 'mention_or_rules')),
  allow_all_senders INTEGER NOT NULL DEFAULT 0,
  allowed_senders_json TEXT NOT NULL DEFAULT '[]',
  rule_keywords_json TEXT NOT NULL DEFAULT '[]',
  cooldown_seconds INTEGER NOT NULL DEFAULT 60,
  inline_context_count INTEGER NOT NULL DEFAULT 6,
  accept_media INTEGER NOT NULL DEFAULT 1,
  notify_events INTEGER NOT NULL DEFAULT 1,
  last_triggered_at TEXT,
  UNIQUE(channel, chat_id)
);
CREATE INDEX IF NOT EXISTS im_group_binding_by_project ON im_group_binding(project_id);

CREATE TABLE IF NOT EXISTS im_group_context (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  channel TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  external_id TEXT NOT NULL,
  actor TEXT NOT NULL,
  actor_name TEXT,
  text TEXT NOT NULL DEFAULT '',
  mentioned_bot INTEGER NOT NULL DEFAULT 0,
  reply_to_external_id TEXT,
  attachments_meta_json TEXT,
  message_id TEXT,
  project_id TEXT,
  UNIQUE(channel, chat_id, external_id)
);
CREATE INDEX IF NOT EXISTS im_group_context_by_chat ON im_group_context(channel, chat_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS im_group_context_by_msg ON im_group_context(message_id);
`;

// A Task as every reader gets it: its own columns, and the tier it runs on, derived here
// and nowhere else — the Task's override, or else the tier the round it reviews ran on (a
// review follows its product, roles-and-tiers.md §11.5), or else its role's default — with
// where that came from. Nothing stores a copy (docs/design/roles-and-tiers.md §3.3). Callers
// qualify their own conditions with `task.`: the role has an id and a created_at of its own.
export const TASK_SELECT = `SELECT task.*, COALESCE(task.tier_override, json_extract(task.review_of_json, '$.tier'), role.default_tier) AS tier, role.permission AS permission,
  CASE WHEN task.tier_override IS NOT NULL AND task.tier_escalated = 1 THEN 'escalated'
       WHEN task.tier_override IS NOT NULL THEN 'override'
       WHEN json_extract(task.review_of_json, '$.tier') IS NOT NULL THEN 'reviewed'
       WHEN role.id IS NOT NULL THEN 'default' END AS tier_source
  FROM task LEFT JOIN role ON role.id = task.role_id`;

// The preset roles, written into a new ledger and into one the step to version 16 brings
// forward: the ones this program declares, so both start from the same four.
function seedRoles(conn: DatabaseSync): void {
  const at = new Date().toISOString();
  const insert = conn.prepare(`INSERT INTO role (id, created_at, updated_at, name, description, default_tier, permission, deliverable, needs_review)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING`);
  for (const role of PRESET_ROLES) {
    insert.run(role.id, at, at, role.name, role.description, role.default_tier, role.permission, role.deliverable, role.needs_review ? 1 : 0);
  }
}

// The tier name the Router's old settings file becomes. Only a name: the value stays the
// file it was, which is how a tier written before content was kept in the ledger reads.
const ROUTER_TIER = 'default';

// Step 14's knowledge of the old tier names, kept with the step and nowhere else: the running
// program knows only the names in shared/tiers.ts. The two names the tiers had before, and
// what each becomes — the only guess made about an old name. A Map rather than an object:
// `constructor`, `toString` and `__proto__` are names a tier list can really hold, and none of
// them is one the mapping knows (docs/design/roles-and-tiers.md §8).
export const TIER_RENAMES: ReadonlyMap<string, TierId> = new Map<string, TierId>([
  ['cheap', 'execute'],
  ['strong', 'decide'],
]);

// The accounts that hold an old name together with the name it would become: a reference to
// it would mean one of two values, and which one the owner wrote is not this program's to pick.
const tierCollisionHolders = (accounts: readonly { id: string; tiers: Record<string, unknown> }[], name: string): string[] => {
  const to = TIER_RENAMES.get(name);
  return to === undefined ? [] : accounts.filter(({ tiers }) => Object.hasOwn(tiers, name) && Object.hasOwn(tiers, to)).map(({ id }) => id);
};

// The reason a Task the step could not map is parked with, as the owner reads it on the Task.
const collidedTierText = (name: string, accounts: readonly string[]): string =>
  `账号 ${accounts.join('、')} 同时有 ${name} 和 ${TIER_RENAMES.get(name)}，用哪一份由你定`;
const staleTierReason = (name: string): string => `旧档位名 ${name} 系统不再用，改一个档位再放行`;

// One step per version: MIGRATIONS[n] takes a ledger from version n to n + 1. A step is
// written in the words of the version it leads to and never reads SCHEMA, which moves on.
// `rebuilds`: the step makes again a table other tables refer to (SQLite's own way to change a
// column), which dropping the old one would refuse with foreign keys on; it runs with them off
// and checks itself that no reference broke. Every other step keeps them on.
type Migration = ((conn: DatabaseSync) => void) & { rebuilds?: true };

// A project's old code directory as its `origin` names it, when the machine may be handed that
// address: read from git, and null for a directory that is not a repository, has no origin, or
// cannot be asked (no git, no such directory). The migration degrades to a folder source alone.
function oldFolderRemote(dir: string): string | null {
  let scratch: string | undefined;
  try {
    // The answer goes to a file rather than a pipe: a confined process may not open one,
    // and a migration must degrade instead of failing there (tests/git-repo.ts does the same).
    scratch = mkdtempSync(join(tmpdir(), 'tycho-origin-'));
    const out = join(scratch, 'out');
    const fd = openSync(out, 'w');
    try {
      execFileSync('git', ['-C', dir, 'config', '--get', 'remote.origin.url'], { stdio: ['ignore', fd, 'ignore'], timeout: 5000, windowsHide: true });
    } finally {
      closeSync(fd);
    }
    return machineRemote(readFileSync(out, 'utf8').trim());
  } catch {
    return null;
  } finally {
    if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true });
  }
}

// A project's old remote as the migration may write it down when a machine cannot be handed it
// at all: the same parts machineRemote would drop are dropped here too, so the audit names what
// was thrown away without repeating a login, a password or a query string. Anything still not
// parseable as a URL is cut at its first `?` or `#` for the same reason.
function redactedRemote(value: string): string {
  const trimmed = value.trim();
  try {
    const parsed = new URL(trimmed);
    parsed.username = '';
    parsed.password = '';
    parsed.search = '';
    parsed.hash = '';
    return parsed.href;
  } catch {
    return trimmed.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^@/]*@/i, '$1').split(/[?#]/)[0]!;
  }
}

const MIGRATIONS: Record<number, Migration> = {
  // To 5: execution targets moved from config.json into the ledger.
  4: (conn) =>
    conn.exec(`CREATE TABLE target (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      executor TEXT NOT NULL,
      hosts_json TEXT NOT NULL,
      ssh_config TEXT,
      config_dir TEXT,
      tiers_json TEXT NOT NULL,
      permission_mode TEXT,
      timeout_ms INTEGER
    )`),
  // To 6: a target can have a ceiling on its Runs, and what the service has learned about
  // a target while using it (resting after a used-up quota, how much quota is used) is
  // kept beside it, apart from what the owner set. Tasks are left as they are: every one
  // of them names its target, which now reads as pinned to it.
  5: (conn) =>
    conn.exec(`ALTER TABLE target ADD COLUMN max_runs INTEGER;
    CREATE TABLE target_state (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      rest_seq INTEGER,
      rest_until TEXT,
      rest_streak INTEGER NOT NULL DEFAULT 0,
      rest_reason TEXT,
      usage_json TEXT NOT NULL DEFAULT '{}'
    )`),

  // To 7: keep each old target's ordered hosts on its account, so splitting identity
  // from connection cannot make a previously unavailable machine eligible.
  6: (conn) => {
    conn.exec(`CREATE TABLE account (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  executor TEXT NOT NULL,
  config_dir TEXT,
  tiers_json TEXT NOT NULL,
  permission_mode TEXT,
  timeout_ms INTEGER,
  max_runs INTEGER,
  machines_json TEXT NOT NULL DEFAULT '[]'
);
CREATE TABLE machine (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  host TEXT NOT NULL,
  ssh_config TEXT,
  note TEXT
);
ALTER TABLE target_state RENAME TO account_state;
ALTER TABLE project RENAME COLUMN allowed_targets_json TO accounts_json;
ALTER TABLE project ADD COLUMN machines_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE task RENAME COLUMN target_id TO account_id;
ALTER TABLE run RENAME COLUMN target_id TO account_id;
ALTER TABLE run ADD COLUMN machine_id TEXT`);
    type OldTarget = {
      id: string; created_at: string; updated_at: string; executor: string;
      hosts_json: string; ssh_config: string | null; config_dir: string | null;
      tiers_json: string; permission_mode: string | null; timeout_ms: number | null; max_runs: number | null;
    };
    const targets = conn.prepare('SELECT * FROM target ORDER BY rowid').all() as OldTarget[];
    const machines = new Map<string, string>();
    const names = new Set<string>();
    // Reserve literal host names so a disambiguated name cannot steal a later host's name.
    const hosts = new Set(targets.flatMap((target) => JSON.parse(target.hosts_json) as string[]));
    const machineKey = (host: string, sshConfig: string | null): string => JSON.stringify([host, sshConfig]);
    const insertMachine = conn.prepare('INSERT INTO machine (id, created_at, updated_at, host, ssh_config) VALUES (?, ?, ?, ?, ?)');
    const insertAccount = conn.prepare(
      'INSERT INTO account (id, created_at, updated_at, executor, config_dir, tiers_json, permission_mode, timeout_ms, max_runs, machines_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    for (const target of targets) {
      const machineIds: string[] = [];
      for (const host of JSON.parse(target.hosts_json) as string[]) {
        const key = machineKey(host, target.ssh_config);
        let id = machines.get(key);
        if (id === undefined) {
          id = host;
          if (names.has(id)) {
            const base = host + '@' + target.id;
            id = base;
            let suffix = 2;
            while (names.has(id) || hosts.has(id)) id = base + '@' + suffix++;
          }
          names.add(id);
          machines.set(key, id);
          insertMachine.run(id, target.created_at, target.updated_at, host, target.ssh_config);
        }
        machineIds.push(id);
      }
      insertAccount.run(target.id, target.created_at, target.updated_at, target.executor,
        target.config_dir, target.tiers_json, target.permission_mode, target.timeout_ms,
        target.max_runs, JSON.stringify(machineIds));
    }
    const targetById = new Map(targets.map((target) => [target.id, target]));
    const updateRun = conn.prepare('UPDATE run SET machine_id = ? WHERE id = ?');
    const runs = conn.prepare('SELECT id, account_id, host, snapshot_json FROM run').all() as {
      id: string; account_id: string; host: string; snapshot_json: string;
    }[];
    for (const run of runs) {
      const snapshot = JSON.parse(run.snapshot_json) as { target?: { ssh_config?: string | null } };
      // Runs predating target snapshots used the target's SSH identity too.
      const sshConfig = snapshot.target !== undefined
        ? snapshot.target.ssh_config ?? null
        : targetById.get(run.account_id)?.ssh_config ?? null;
      const id = machines.get(machineKey(run.host, sshConfig));
      if (id !== undefined) updateRun.run(id, run.id);
    }
    conn.exec('DROP TABLE target');
  },
  // To 8: a token is a file the ledger names by a number, never by the account, and a
  // rejection is a statement about one such number. Unreleased, so the step is written
  // as the final shape rather than as a second step on top of it.
  7: (conn) =>
    conn.exec(`ALTER TABLE account ADD COLUMN credential_ref TEXT;
ALTER TABLE account_state ADD COLUMN credential_rejected_ref TEXT`),

  // To 9: a tier's value is no longer only a place on the machine. Every old string,
  // wherever it was recorded, is wrapped as a `ref` with the string itself untouched, so
  // an account and a Run in flight keep naming exactly what they named before. Runs are
  // carried over with their accounts: a snapshot's recorded account is compared with the
  // account as it is now, and a Run whose record was left in the old shape could never
  // start again.
  8: (conn) => {
    const wrap = (value: unknown): unknown =>
      typeof value === 'string' ? { kind: 'ref', value } : value;
    const wrapTiers = (tiers: unknown): unknown =>
      tiers !== null && typeof tiers === 'object' && !Array.isArray(tiers)
        ? Object.fromEntries(Object.entries(tiers as Record<string, unknown>).map(([tier, value]) => [tier, wrap(value)]))
        : tiers;
    // Only where the key is: a snapshot older than accounts has no tiers to wrap, and
    // nothing about it may change.
    const wrapRecord = (record: unknown): unknown => {
      if (record === null || typeof record !== 'object' || Array.isArray(record)) return record;
      const held = record as Record<string, unknown>;
      return Object.hasOwn(held, 'tiers') ? { ...held, tiers: wrapTiers(held.tiers) } : record;
    };
    const accounts = conn.prepare('SELECT id, tiers_json FROM account ORDER BY rowid').all() as { id: string; tiers_json: string }[];
    const setTiers = conn.prepare('UPDATE account SET tiers_json = ? WHERE id = ?');
    for (const account of accounts) setTiers.run(JSON.stringify(wrapTiers(JSON.parse(account.tiers_json))), account.id);
    const runs = conn.prepare('SELECT id, snapshot_json FROM run ORDER BY rowid').all() as { id: string; snapshot_json: string }[];
    const setSnapshot = conn.prepare('UPDATE run SET snapshot_json = ? WHERE id = ?');
    for (const run of runs) {
      const snapshot = JSON.parse(run.snapshot_json) as Record<string, unknown>;
      // A Run written before accounts and machines were split names its tier the old way.
      if (typeof snapshot.tier_file === 'string' && snapshot.tier_value === undefined) {
        snapshot.tier_value = { kind: 'ref', value: snapshot.tier_file };
      }
      delete snapshot.tier_file;
      if (Object.hasOwn(snapshot, 'account')) snapshot.account = wrapRecord(snapshot.account);
      if (Object.hasOwn(snapshot, 'target')) snapshot.target = wrapRecord(snapshot.target);
      setSnapshot.run(JSON.stringify(snapshot), run.id);
    }
  },
  // To 10: the Router is bound to an account instead of to a login directory and a tier
  // file of its own. What the two settings named becomes an account, and the settings
  // point at it; the tier file becomes a `ref`, the one shape every tier value has had
  // since 9, so nothing is read off the machine. Both at their defaults leaves the binding
  // empty, which is what it always meant: this computer's own login and the CLI's own
  // default tier, behaviour unchanged.
  9: (conn) => {
    const row = conn.prepare(`SELECT value_json FROM setting WHERE key = 'tunables'`).get() as { value_json: string } | undefined;
    if (!row) return;
    const tunables = JSON.parse(row.value_json) as Record<string, unknown>;
    const was = (key: string): string => (typeof tunables[key] === 'string' ? (tunables[key] as string) : '');
    const configDir = was('router.configDir');
    const tierFile = was('router.tierFile');
    // Neither was ever set and neither is there to remove: the ledger is left as it is.
    if (configDir === '' && tierFile === '' && !('router.configDir' in tunables) && !('router.tierFile' in tunables)) return;
    const { 'router.configDir': _dir, 'router.tierFile': _tier, ...kept } = tunables;
    const next: Record<string, unknown> = { ...kept };
    if (configDir !== '' || tierFile !== '') {
      const tiers: Record<string, unknown> = tierFile === '' ? {} : { [ROUTER_TIER]: { kind: 'ref', value: tierFile } };
      const at = nowIso();
      const taken = new Set(conn.prepare('SELECT id FROM account').all().map(({ id }) => id as string));
      let id = 'router';
      for (let suffix = 2; taken.has(id); suffix += 1) id = `router@${suffix}`;
      // The executor is Claude Code: both old settings were its own, and no other adapter
      // can drive the Router.
      conn
        .prepare(
          `INSERT INTO account (id, created_at, updated_at, executor, machines_json, config_dir, tiers_json, permission_mode, timeout_ms, max_runs)
           VALUES (?, ?, ?, 'claude', '[]', ?, ?, NULL, NULL, NULL)`,
        )
        .run(id, at, at, configDir === '' ? null : configDir, JSON.stringify(tiers));
      next['router.account'] = id;
      if (tierFile !== '') next['router.tier'] = ROUTER_TIER;
    }
    conn.prepare(`UPDATE setting SET value_json = ? WHERE key = 'tunables'`).run(JSON.stringify(next));
  },
  // To 11: what an account's executor says about the models it may use, and when that was
  // last read successfully. Learned state beside the rest quota and usage: every account
  // starts with none, which is what the console's form reads as "nothing reported yet".
  10: (conn) =>
    conn.exec(`ALTER TABLE account_state ADD COLUMN models_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE account_state ADD COLUMN models_at TEXT`),
  // To 12: a project may name the checkout on this machine that its Tasks are handed as a
  // git bundle. Empty for every project there was: an empty value is what it means.
  11: (conn) => conn.exec(`ALTER TABLE project ADD COLUMN code_dir TEXT`),
  // To 13: a machine can be one whose client came back instead of one reached over SSH
  // (docs/design/nodes.md §5.4, §7), and a Run on such a machine is bound to that client's
  // own identity rather than to the name the owner reads (§7, §9). The identity fields are
  // filled in when the owner lets the machine in; a machine from before this version has
  // none and keeps its SSH fields for as long as it is reached that way. `host` stays: it is
  // what the owner and the pages call the machine, and a node's client reports its own name
  // into it. Runs from before this version have no node_id: their machine was named and not
  // identified, and the name is what is compared for them. A name can be deleted and taken
  // again; the identity cannot, so joining again under the same name must not hand the new
  // machine the old one's round — its account token included.
  12: (conn) =>
    conn.exec(`ALTER TABLE machine ADD COLUMN node_id TEXT;
ALTER TABLE machine ADD COLUMN token_hash TEXT;
ALTER TABLE machine ADD COLUMN platform TEXT;
ALTER TABLE machine ADD COLUMN joined_at TEXT;
ALTER TABLE machine ADD COLUMN last_seen_at TEXT;
ALTER TABLE machine ADD COLUMN source TEXT;
ALTER TABLE machine ADD COLUMN ephemeral INTEGER NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX IF NOT EXISTS machine_one_node ON machine(node_id) WHERE node_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS machine_one_token ON machine(token_hash) WHERE token_hash IS NOT NULL;
ALTER TABLE run ADD COLUMN node_id TEXT`),
  // To 14: a task may spawn machines (docs/design/nodes.md §1.3, §11 step 4). A project says
  // whether it may at all (off for every project there was); a quota the Router asked for
  // within that is a row of its own; each one-time material handed to a round is a row of
  // its own too, holding only its hash, the round it went to and whether it was used (one
  // machine each); a machine that came in with such a material points at its quota and keeps
  // the secret it claims with (hashed), and records its endings apart: when it stopped taking
  // work, when its evidence was all in, when its registration ended and why, and when — and
  // by which round — its instance was reported destroyed. Every machine there was has none of
  // these: it was let in by hand and is still here.
  13: (conn) =>
    conn.exec(`ALTER TABLE project ADD COLUMN spawn_machines INTEGER NOT NULL DEFAULT 0;
CREATE TABLE machine_invite (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES project(id),
  task_id TEXT NOT NULL REFERENCES task(id),
  executors_json TEXT,
  expires_at TEXT NOT NULL,
  max_machines INTEGER NOT NULL,
  revoked_at TEXT
);
CREATE TABLE machine_material (
  hash TEXT PRIMARY KEY,
  invite_id TEXT NOT NULL REFERENCES machine_invite(id),
  run_id TEXT NOT NULL,
  handed_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT
);
CREATE INDEX IF NOT EXISTS machine_material_by_invite ON machine_material(invite_id);
ALTER TABLE machine ADD COLUMN invite_id TEXT;
ALTER TABLE machine ADD COLUMN claim_hash TEXT;
ALTER TABLE machine ADD COLUMN drain_at TEXT;
ALTER TABLE machine ADD COLUMN evidence_at TEXT;
ALTER TABLE machine ADD COLUMN left_at TEXT;
ALTER TABLE machine ADD COLUMN left_reason TEXT;
ALTER TABLE machine ADD COLUMN destroyed_at TEXT;
ALTER TABLE machine ADD COLUMN destroyed_by TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS machine_one_claim ON machine(claim_hash) WHERE claim_hash IS NOT NULL`),
  // To 15: the tiers become two, named decide and execute
  // (docs/design/roles-and-tiers.md §2, §8). An account keeps every value it had; only the
  // two old names change, and a name the mapping does not know (`escalation`, a name the
  // owner invented, or the Router's own file name from an older layout) is left exactly as
  // it was — the console marks it and offers to move it, and this step does not guess what
  // it was for. An old name an account holds together with the name it would become is not
  // renamed anywhere either: the same reference would mean one of two values, and which one
  // the owner wrote is theirs to say. A Task naming one of the two old names is renamed with
  // it, ended or not; a Task that has not ended and whose name cannot be mapped waits for the
  // owner instead of being dispatched under a name the system no longer uses, and one that
  // still has a Run out there keeps its state — that Run is settled by the snapshot it ran
  // with, and the name stands in the way only when the Task next goes into the queue. A Task
  // that has ended keeps the name as the record of what it ran on. The Router's own tier is
  // renamed the same way when it maps, and left standing when it does not: that stops the
  // Router with the reason on the page, rather than running it on the CLI's own default tier
  // without a word. No tier's content changes by one byte.
  14: (conn) => {
    const stored = conn.prepare('SELECT id, tiers_json FROM account ORDER BY rowid').all() as { id: string; tiers_json: string }[];
    const accounts = stored.map((account) => ({ id: account.id, tiers: JSON.parse(account.tiers_json) as Record<string, unknown> }));
    // A name is renamed only when no account holds both it and the name it would become.
    // Said once, here: every row that names it follows the same answer.
    const collided = new Map<string, string[]>();
    for (const name of TIER_RENAMES.keys()) {
      const holders = tierCollisionHolders(accounts, name);
      if (holders.length > 0) collided.set(name, holders);
    }
    const rename = (name: string): string | undefined => (collided.has(name) ? undefined : TIER_RENAMES.get(name));
    // The tier list is built without a prototype, so a name every object has is kept as a
    // key of its own rather than written into the object's own prototype.
    const setTiers = conn.prepare('UPDATE account SET tiers_json = ? WHERE id = ?');
    for (const account of accounts) {
      const kept = Object.create(null) as Record<string, unknown>;
      for (const [name, value] of Object.entries(account.tiers)) kept[rename(name) ?? name] = value;
      setTiers.run(JSON.stringify(kept), account.id);
    }
    // A Run that has not ended is a round still out there: it is judged and settled by its
    // own snapshot, so its Task's state is not this step's to change.
    const live = new Set(
      (conn.prepare(`SELECT DISTINCT task_id FROM run WHERE state != 'ended'`).all() as { task_id: string }[]).map((run) => run.task_id),
    );
    const tasks = conn.prepare('SELECT id, tier, state FROM task ORDER BY rowid').all() as { id: string; tier: string | null; state: string }[];
    const setTier = conn.prepare('UPDATE task SET tier = ? WHERE id = ?');
    const park = conn.prepare(`UPDATE task SET state = 'waiting_person', reason = ?, wake_at = NULL WHERE id = ?`);
    for (const task of tasks) {
      if (task.tier === null) continue;
      const to = rename(task.tier);
      if (to !== undefined) {
        setTier.run(to, task.id);
        continue;
      }
      if (isTierId(task.tier) || task.state === 'done' || task.state === 'abandoned' || live.has(task.id)) continue;
      const holders = collided.get(task.tier);
      park.run(holders ? collidedTierText(task.tier, holders) : staleTierReason(task.tier), task.id);
    }
    const row = conn.prepare(`SELECT value_json FROM setting WHERE key = 'tunables'`).get() as { value_json: string } | undefined;
    if (!row) return;
    const tunables = JSON.parse(row.value_json) as Record<string, unknown>;
    const held = tunables['router.tier'];
    if (typeof held !== 'string') return;
    const to = rename(held);
    if (to !== undefined) conn.prepare(`UPDATE setting SET value_json = ? WHERE key = 'tunables'`).run(JSON.stringify({ ...tunables, 'router.tier': to }));
  },
  // To 16: a Task names a role, and its tier follows from it (docs/design/roles-and-tiers.md
  // §3, §8). The role table comes with the four presets. A Task's old tier is not a role and
  // says nothing about which one it was, so none is guessed: the column goes, and a Task
  // whose next step is the queue (queued, held, waiting on a timer, or waiting for the owner
  // with no question open) waits for the owner to pick one, with the reason on it. The rest
  // keep their state, and the queue's own guard stops them the moment they would go back
  // in: a round still out there is settled by the snapshot it ran with, a Task waiting to be
  // accepted can still be accepted, an open question is still answered first, and a draft
  // was never queued. An ended Task keeps no role, which is how the page tells it ran before
  // roles. Run snapshots are not touched.
  15: (conn) => {
    conn.exec(`CREATE TABLE role (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  name TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL,
  default_tier TEXT NOT NULL,
  permission TEXT NOT NULL,
  deliverable TEXT NOT NULL,
  needs_review INTEGER NOT NULL
);
ALTER TABLE task ADD COLUMN role_id TEXT;
ALTER TABLE task ADD COLUMN tier_override TEXT;
ALTER TABLE task ADD COLUMN tier_reason TEXT;`);
    seedRoles(conn);
    conn.prepare(
      `UPDATE task SET state = 'waiting_person', reason = ?, wake_at = NULL
       WHERE (state IN ('queued', 'held', 'waiting_timer')
              OR (state = 'waiting_person' AND NOT EXISTS (SELECT 1 FROM approval WHERE approval.task_id = task.id AND approval.state = 'open')))
         AND NOT EXISTS (SELECT 1 FROM run WHERE run.task_id = task.id AND run.state != 'ended')`,
    ).run(NO_ROLE_REASON);
    conn.exec('ALTER TABLE task DROP COLUMN tier');
  },
  // To 17: review (docs/design/roles-and-tiers.md §4, §6). A review Task carries what it is
  // bound to and the verdict it handed over; a Task the service moved to the decide tier
  // after a rejection says so, so that the Router cannot move it back. Nothing older is a
  // review or was escalated: the columns start empty, and no Task changes state. A Run gets
  // the files the host registered for it, null until it has: an older round has none known.
  // A question a review's rejection put to the owner names that review; an older one none.
  16: (conn) => {
    conn.exec(`ALTER TABLE task ADD COLUMN tier_escalated INTEGER NOT NULL DEFAULT 0;
ALTER TABLE task ADD COLUMN review_of_json TEXT;
ALTER TABLE task ADD COLUMN verdict_json TEXT;
ALTER TABLE run ADD COLUMN artifacts_json TEXT;
ALTER TABLE approval ADD COLUMN review_task_id TEXT;`);
  },
  // To 18: an account says what can be used and a machine says where; they meet at dispatch
  // (docs/design/accounts-machines-decoupled.md). An account is a login tycho keeps, so it
  // names no machines any more. An account that kept no login was a machine's own login
  // recorded twice: it becomes that login on each machine it named — every machine, for one
  // that named none — with its tiers, limits and what was learned using it. Whatever pointed
  // at it points at those logins now: a project's ordered list, a Task not yet ended that was
  // pinned to it (to its one login; one with several is let go, and its timeline says why),
  // and a round still out there. The Router runs on this computer, not on a machine: bound to
  // such an account, it goes back to this computer's own login and the executor's default
  // tier, and the change says so. Ended Tasks and Runs keep the name they had, and no
  // snapshot is touched: they are what ran. A machine login keeps no login directory of its
  // own: it is the executor's login where the machine's report asks about it.
  17: (conn) => {
    conn.exec(`ALTER TABLE project RENAME COLUMN accounts_json TO logins_json;
ALTER TABLE task RENAME COLUMN account_id TO login_id;
ALTER TABLE run RENAME COLUMN account_id TO login_id;
ALTER TABLE account_state RENAME TO login_state;
ALTER TABLE login_state ADD COLUMN auth_failed_at TEXT;
CREATE TABLE machine_login (
  machine_id TEXT NOT NULL,
  executor TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  tiers_json TEXT NOT NULL,
  permission_mode TEXT,
  timeout_ms INTEGER,
  max_runs INTEGER,
  PRIMARY KEY (machine_id, executor)
);`);
    const at = nowIso();
    const audit = conn.prepare(`INSERT INTO change (id, created_at, at, actor, task_id, action, detail_json) VALUES (?, ?, ?, 'migration', ?, 'login.migrate', ?)`);
    const machines = (conn.prepare('SELECT id FROM machine WHERE left_at IS NULL ORDER BY rowid').all() as { id: string }[]).map(({ id }) => id);
    const present = new Set(machines);
    const accounts = conn.prepare('SELECT * FROM account WHERE credential_ref IS NULL ORDER BY rowid').all() as {
      id: string; executor: string; machines_json: string; config_dir: string | null; tiers_json: string;
      permission_mode: string | null; timeout_ms: number | null; max_runs: number | null;
    }[];
    const insertLogin = conn.prepare(`INSERT INTO machine_login (machine_id, executor, created_at, updated_at, tiers_json, permission_mode, timeout_ms, max_runs)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (machine_id, executor) DO NOTHING`);
    const copyState = conn.prepare(`INSERT INTO login_state (id, created_at, rest_seq, rest_until, rest_streak, rest_reason, usage_json, models_json, models_at)
      SELECT ?, created_at, rest_seq, rest_until, rest_streak, rest_reason, usage_json, models_json, models_at FROM login_state WHERE id = ?
      ON CONFLICT (id) DO NOTHING`);
    // Old account id to the machine logins it became, in the order its machines were named.
    const merged = new Map<string, { machine: string; login: string }[]>();
    for (const account of accounts) {
      const named = JSON.parse(account.machines_json) as string[];
      const on = named.length === 0 ? machines : named.filter((id) => present.has(id));
      // Two such accounts of one executor on one machine were the same login: the first one
      // named keeps its settings, and the second one's references go to it too.
      for (const machine of on) {
        insertLogin.run(machine, account.executor, at, at, account.tiers_json, account.permission_mode, account.timeout_ms, account.max_runs);
        copyState.run(`${machine}/${account.executor}`, account.id);
      }
      merged.set(account.id, on.map((machine) => ({ machine, login: `${machine}/${account.executor}` })));
    }
    if (merged.size === 0) {
      conn.exec('ALTER TABLE account DROP COLUMN machines_json');
      return;
    }
    const inRange = (ids: readonly string[], id: string): boolean => ids.length === 0 || ids.includes(id);
    const projects = conn.prepare('SELECT id, logins_json, machines_json FROM project ORDER BY rowid').all() as { id: string; logins_json: string; machines_json: string }[];
    const setLogins = conn.prepare('UPDATE project SET logins_json = ? WHERE id = ?');
    for (const project of projects) {
      const from = JSON.parse(project.logins_json) as string[];
      const range = JSON.parse(project.machines_json) as string[];
      // A machine's login outside the project's machines could never run its work.
      const to = [...new Set(from.flatMap((id) => merged.get(id)?.filter(({ machine }) => inRange(range, machine)).map(({ login }) => login) ?? [id]))];
      if (JSON.stringify(to) === JSON.stringify(from)) continue;
      setLogins.run(JSON.stringify(to), project.id);
      audit.run(ulid(), at, at, null, JSON.stringify({ project_id: project.id, logins: { from, to } }));
    }
    const pinned = conn.prepare(`SELECT id, login_id FROM task WHERE login_id IS NOT NULL AND state NOT IN ('done', 'abandoned') ORDER BY rowid`).all() as { id: string; login_id: string }[];
    const pin = conn.prepare('UPDATE task SET login_id = ? WHERE id = ?');
    for (const task of pinned) {
      const logins = merged.get(task.login_id);
      if (logins === undefined) continue;
      const to = logins.length === 1 ? logins[0]!.login : null;
      pin.run(to, task.id);
      audit.run(ulid(), at, at, task.id, JSON.stringify({
        login_id: { from: task.login_id, to },
        reason: to === null
          ? `原来指定的账号 ${task.login_id} 没有自己的登录，用的是${logins.length === 0 ? '机器自己的登录，但它列的机器都不在了' : ` ${logins.length} 台机器各自的登录`}；现在不再指定，由派发在项目允许的登录里挑`
          : `原来指定的账号 ${task.login_id} 没有自己的登录，用的是机器 ${logins[0]!.machine} 自己的登录；现在指定那台机器上的这份登录`,
      }));
    }
    // A round still out there counts against, and rests, the login it is running as now.
    const live = conn.prepare(`SELECT id, login_id, machine_id FROM run WHERE state != 'ended' AND machine_id IS NOT NULL`).all() as { id: string; login_id: string; machine_id: string }[];
    const moveRun = conn.prepare('UPDATE run SET login_id = ? WHERE id = ?');
    for (const run of live) {
      const login = merged.get(run.login_id)?.find(({ machine }) => machine === run.machine_id)?.login;
      if (login !== undefined) moveRun.run(login, run.id);
    }
    const row = conn.prepare(`SELECT value_json FROM setting WHERE key = 'tunables'`).get() as { value_json: string } | undefined;
    const tunables = row === undefined ? {} : (JSON.parse(row.value_json) as Record<string, unknown>);
    // The Router bound to one of them stays bound to it: the binding then names an account
    // that is gone, and the Router stops until the owner binds one with a token. Clearing it
    // would read as the owner's choice to bind none, and run the Router on this computer's
    // own login and tier without anyone having chosen that.
    const bound = tunables['router.account'];
    if (typeof bound === 'string' && merged.has(bound)) {
      audit.run(ulid(), at, at, null, JSON.stringify({
        router_account: bound,
        reason: `负责人绑定的账号 ${bound} 没有自己的登录令牌，在这次迁移里并掉了；负责人停下，等你在设置里重新绑定一个带令牌的账号`,
      }));
    }
    // The account itself goes, and the change says what it became: a round of it that the
    // step could not move is then one whose login was removed, not one this ledger never held.
    const drop = conn.prepare('DELETE FROM account WHERE id = ?');
    const forget = conn.prepare('DELETE FROM login_state WHERE id = ?');
    for (const [id, logins] of merged) {
      drop.run(id);
      forget.run(id);
      audit.run(ulid(), at, at, null, JSON.stringify({ account_id: id, logins: logins.map(({ login }) => login) }));
    }
    conn.exec('ALTER TABLE account DROP COLUMN machines_json');
  },
  // To 19: knowledge (docs/design/knowledge-and-skills.md §1, §2, §8 step 1). Entries with
  // their immutable revisions, the proposals they come from with the evidence each carries,
  // and the clients the knowledge MCP lets in; a Task may be a knowledge gate or curation task
  // (§3, §5.3), which it says in a column of its own. An older ledger had none of these: the
  // tables start empty, no Task is one, and nothing that was there moves. Such a Task belongs to
  // no project, so a Task's project may be empty now: SQLite cannot loosen a column, so the
  // table is made again and its rows copied as they are (with foreign keys off for this step,
  // and a check that no reference broke on the way).
  18: Object.assign((conn: DatabaseSync) => {
    const broken = (): string => JSON.stringify(conn.prepare('PRAGMA foreign_key_check').all());
    const before = broken();
    conn.exec(`CREATE TABLE knowledge (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  kind TEXT NOT NULL,
  revision INTEGER NOT NULL,
  state TEXT NOT NULL,
  retired_at TEXT,
  retired_by TEXT,
  retired_reason TEXT,
  replaced_by TEXT,
  retired_proposal_id TEXT
);
CREATE TABLE knowledge_proposal (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  kind TEXT NOT NULL,
  change_json TEXT NOT NULL,
  final_json TEXT,
  why_json TEXT NOT NULL,
  source TEXT NOT NULL,
  proposed_by TEXT NOT NULL,
  client_id TEXT NOT NULL,
  request_id TEXT,
  task_id TEXT REFERENCES task(id),
  run_id TEXT REFERENCES run(id),
  amended_from TEXT REFERENCES knowledge_proposal(id),
  next_id TEXT,
  digest TEXT NOT NULL,
  content_digest TEXT NOT NULL,
  final_digest TEXT,
  prior_rejection_id TEXT REFERENCES knowledge_proposal(id),
  gate_task_id TEXT REFERENCES task(id),
  gate_json TEXT,
  owner_reasons_json TEXT,
  state TEXT NOT NULL,
  state_reason TEXT,
  decided_at TEXT,
  decided_by TEXT,
  decided_via TEXT,
  decision_note TEXT,
  published_at TEXT,
  reviewed_at TEXT,
  reviewed_by TEXT
);
CREATE UNIQUE INDEX knowledge_proposal_request ON knowledge_proposal(client_id, request_id) WHERE request_id IS NOT NULL;
CREATE TABLE knowledge_revision (
  knowledge_id TEXT NOT NULL REFERENCES knowledge(id),
  revision INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  title TEXT NOT NULL,
  when_to_use TEXT NOT NULL,
  body TEXT NOT NULL,
  projects_json TEXT,
  loading TEXT NOT NULL,
  roles_json TEXT NOT NULL,
  proposal_id TEXT NOT NULL REFERENCES knowledge_proposal(id),
  published_by TEXT NOT NULL,
  PRIMARY KEY (knowledge_id, revision)
);
CREATE TABLE knowledge_evidence (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  proposal_id TEXT NOT NULL REFERENCES knowledge_proposal(id),
  seq INTEGER NOT NULL,
  source TEXT NOT NULL,
  ref TEXT,
  location TEXT NOT NULL,
  excerpt TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  submitted_by TEXT NOT NULL,
  verified INTEGER NOT NULL
);
CREATE INDEX knowledge_evidence_by_proposal ON knowledge_evidence(proposal_id);
CREATE TABLE knowledge_client (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  name TEXT NOT NULL,
  executor TEXT NOT NULL,
  grants_json TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  revoked_at TEXT
);
CREATE TABLE task_next (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  project_id TEXT REFERENCES project(id),
  parent_id TEXT REFERENCES task(id),
  title TEXT NOT NULL,
  goal TEXT NOT NULL,
  scope TEXT,
  acceptance TEXT,
  revision INTEGER NOT NULL DEFAULT 1,
  login_id TEXT,
  priority INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL,
  reason TEXT,
  wake_at TEXT,
  created_by TEXT NOT NULL,
  closed_at TEXT,
  role_id TEXT,
  tier_override TEXT,
  tier_reason TEXT,
  tier_escalated INTEGER NOT NULL DEFAULT 0,
  review_of_json TEXT,
  verdict_json TEXT,
  knowledge_json TEXT
);
INSERT INTO task_next (id, created_at, project_id, parent_id, title, goal, scope, acceptance, revision, login_id, priority, state, reason, wake_at, created_by, closed_at, role_id, tier_override, tier_reason, tier_escalated, review_of_json, verdict_json) SELECT id, created_at, project_id, parent_id, title, goal, scope, acceptance, revision, login_id, priority, state, reason, wake_at, created_by, closed_at, role_id, tier_override, tier_reason, tier_escalated, review_of_json, verdict_json FROM task;
DROP TABLE task;
ALTER TABLE task_next RENAME TO task;`);
    if (broken() !== before) throw new Error('重建任务表后有引用对不上了，升级没有提交');
  }, { rebuilds: true as const }),
  // To 20: every project has its own Router (docs/design/project-sessions.md §6). The one
  // global session and its messages stay as the read-only old global record: no project's first
  // segment, never resumed. A message there whose project the ledger can tell — from what its
  // turn committed, or the Task an internal event is about — is linked to that project; one it
  // cannot tell stays in the record alone. A message nobody had taken yet was never part of that
  // conversation: an internal event goes to its Task's project, one about no project is kept as
  // not delivered, and anything the owner sent waits to be given a project. Every project keeps
  // its list of logins as it was, as "only these" — an empty list still dispatches nothing; only
  // a project made from now on starts with every login.
  19: (conn) => {
    const at = new Date().toISOString();
    conn.exec(`ALTER TABLE project ADD COLUMN login_mode TEXT NOT NULL DEFAULT 'selected';
CREATE TABLE router_segment (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES project(id),
  seq INTEGER NOT NULL,
  state TEXT NOT NULL,
  closed_at TEXT,
  UNIQUE (project_id, seq)
);
CREATE UNIQUE INDEX router_segment_one_current ON router_segment(project_id) WHERE state = 'current';
CREATE TABLE router_context (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  segment_id TEXT REFERENCES router_segment(id),
  project_id TEXT REFERENCES project(id),
  session_ref TEXT,
  pid INTEGER,
  marker TEXT NOT NULL,
  state TEXT NOT NULL,
  login_id TEXT,
  config_dir TEXT,
  credential_ref TEXT,
  launch_json TEXT,
  live_at TEXT,
  last_turn_at TEXT,
  closed_at TEXT,
  closed_reason TEXT,
  material_json TEXT,
  knowledge_json TEXT
);
CREATE UNIQUE INDEX router_context_one_open ON router_context(project_id) WHERE state = 'open';
ALTER TABLE message ADD COLUMN project_id TEXT REFERENCES project(id);
ALTER TABLE message ADD COLUMN segment_id TEXT REFERENCES router_segment(id);
ALTER TABLE message ADD COLUMN basis TEXT;
ALTER TABLE message ADD COLUMN candidates_json TEXT;
CREATE INDEX message_by_project ON message(project_id, state);
-- The WeCom front desk's current project of one bot, chat and sender (project-sessions §1).
CREATE TABLE front_desk (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  bot TEXT NOT NULL,
  chat TEXT NOT NULL,
  sender TEXT NOT NULL,
  project_id TEXT REFERENCES project(id),
  UNIQUE (bot, chat, sender)
);

-- What reaches the owner by its level (§2.1): a waiting item while it may still be reminded
-- (last_at: when it last went out), a result while it is held for its project's window.
CREATE TABLE push (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  key TEXT NOT NULL UNIQUE,
  level TEXT NOT NULL,
  kind TEXT NOT NULL,
  project_id TEXT REFERENCES project(id),
  payload_json TEXT NOT NULL,
  state TEXT NOT NULL,
  reminded INTEGER NOT NULL DEFAULT 0,
  last_at TEXT
);

CREATE INDEX push_open ON push(state, level);
`);
    // The old sessions, closed for good. A process of the open one, or of the newest, may still be
    // running after a crash: its marker stays one the service and a rollback scan for.
    const login = conn.prepare(`SELECT value_json FROM setting WHERE key = 'router_session_login'`).get() as { value_json: string } | undefined;
    const held = login === undefined ? undefined : JSON.parse(login.value_json) as { session_id: string; account?: string | null; config_dir?: string | null };
    const sessions = conn.prepare('SELECT * FROM router_session ORDER BY created_at, rowid').all() as { id: string; created_at: string; session_ref: string | null; pid: number | null; marker: string; state: string; last_turn_at: string | null }[];
    const keep = conn.prepare(`INSERT INTO router_context (id, created_at, session_ref, pid, marker, state, login_id, config_dir, live_at, last_turn_at, closed_at, closed_reason)
      VALUES (?, ?, ?, NULL, ?, 'closed', ?, ?, ?, ?, ?, '旧全局记录')`);
    sessions.forEach((row, index) => {
      const mine = held?.session_id === row.id;
      const maybeLive = row.state === 'open' || row.pid !== null || index === sessions.length - 1;
      keep.run(row.id, row.created_at, row.session_ref, row.marker, mine ? held?.account ?? null : null, mine ? held?.config_dir ?? null : null, maybeLive ? at : null, row.last_turn_at, at);
    });
    conn.exec(`DROP TABLE router_session; DELETE FROM setting WHERE key = 'router_session_login';`);

    // The old long-term rulings (knowledge §4.2): kept as they were, with the project their Task
    // is in, for the ledger to hand to the knowledge gate as proposals once it is open
    // (carryLegacyDecisions); the table and every reader of it go.
    const decisions = conn.prepare('SELECT * FROM decision ORDER BY rowid').all() as { id: string; created_at: string; task_id: string | null; scope_json: string | null; text: string }[];
    if (decisions.length > 0) {
      const projectOf = conn.prepare('SELECT project_id FROM task WHERE id = ?');
      const kept = decisions.map(({ id, created_at, task_id, scope_json, text }) => ({
        id, created_at, task_id, text,
        scope: scope_json === null ? null : JSON.parse(scope_json) as unknown,
        project_id: task_id === null ? null : ((projectOf.get(task_id) as { project_id: string | null } | undefined)?.project_id ?? null),
      }));
      conn.prepare(`INSERT INTO setting (id, created_at, key, value_json) VALUES (?, ?, 'legacy_decisions', ?)`).run(ulid(), at, JSON.stringify(kept));
    }
    conn.exec('DROP TABLE decision');

    // Which project a message is about, from the ledger's own objects only.
    const projectOfTask = conn.prepare('SELECT project_id FROM task WHERE id = ?');
    const taskProject = (taskId: unknown): string | null =>
      typeof taskId === 'string' ? ((projectOfTask.get(taskId) as { project_id: string | null } | undefined)?.project_id ?? null) : null;
    const committed = conn.prepare(`SELECT DISTINCT t.project_id AS project_id FROM change c JOIN task t ON t.id = c.task_id WHERE c.message_id = ? AND t.project_id IS NOT NULL`);
    const eventTask = (text: string): unknown => {
      try {
        return (JSON.parse(text.slice(text.lastIndexOf('\n') + 1)) as { task_id?: unknown }).task_id;
      } catch {
        return undefined;
      }
    };
    const inbound = conn.prepare(`SELECT id, channel, text, state FROM message WHERE direction = 'in' ORDER BY rowid`).all() as { id: string; channel: string; text: string; state: string | null }[];
    const set = conn.prepare('UPDATE message SET project_id = ?, basis = ?, state = ? WHERE id = ?');
    const linked = new Map<string, string | null>();
    let waiting = 0;
    for (const row of inbound) {
      const projects = row.channel === 'internal'
        ? [taskProject(eventTask(row.text))].filter((each): each is string => each !== null)
        : (committed.all(row.id) as { project_id: string }[]).map(({ project_id }) => project_id);
      const project = projects.length === 1 ? projects[0]! : null;
      if (row.state === 'received') {
        // Never taken: not part of the old conversation.
        if (row.channel === 'internal') set.run(project, project === null ? null : 'object', project === null ? 'ignored' : 'received', row.id);
        else {
          set.run(null, null, 'unassigned', row.id);
          waiting += 1;
        }
        continue;
      }
      linked.set(row.id, project);
      set.run(project, 'legacy', row.state, row.id);
    }
    const outbound = conn.prepare(`SELECT id, external_id FROM message WHERE direction = 'out' ORDER BY rowid`).all() as { id: string; external_id: string }[];
    const reply = conn.prepare(`UPDATE message SET project_id = ?, basis = 'legacy' WHERE id = ?`);
    for (const row of outbound) reply.run(row.external_id.startsWith('reply:') ? linked.get(row.external_id.slice(6)) ?? null : null, row.id);
    // Said only when there was something to move, as every step before.
    if (sessions.length > 0 || inbound.length > 0) conn.prepare(`INSERT INTO change (id, created_at, at, actor, action, detail_json) VALUES (?, ?, ?, 'migration', 'router.migrate', ?)`)
      .run(ulid(), at, at, JSON.stringify({ old_sessions: sessions.length, linked: [...linked.values()].filter((each) => each !== null).length, unlinked: [...linked.values()].filter((each) => each === null).length, waiting_for_project: waiting }));
  },
  // Triggers (docs/design/triggers.md): three new tables, and a Task remembers the occurrence whose
  // turn started its work, so that the events of that work set no trigger off (§4).
  // An internal message says which Task it is about, so that work started from it carries that
  // Task's trigger.
  20: (conn) => conn.exec(`ALTER TABLE task ADD COLUMN trigger_fire_id TEXT;
ALTER TABLE message ADD COLUMN task_id TEXT REFERENCES task(id);
CREATE TABLE trigger_rule (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES project(id),
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL,
  source TEXT NOT NULL,
  params_json TEXT NOT NULL,
  instruction TEXT NOT NULL,
  missed TEXT NOT NULL,
  expires_at TEXT,
  push_final INTEGER NOT NULL,
  revision INTEGER NOT NULL,
  created_by TEXT NOT NULL,
  deleted_at TEXT,
  rejected_count INTEGER NOT NULL DEFAULT 0,
  rejected_at TEXT,
  rejected_reason TEXT
);

CREATE INDEX trigger_rule_by_project ON trigger_rule(project_id);

CREATE TABLE trigger_fire (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  trigger_id TEXT NOT NULL REFERENCES trigger_rule(id),
  project_id TEXT NOT NULL REFERENCES project(id),
  event_id TEXT NOT NULL,
  digest TEXT NOT NULL,
  scheduled_at TEXT,
  revision INTEGER NOT NULL,
  periodic INTEGER NOT NULL,
  data_json TEXT NOT NULL,
  message_id TEXT REFERENCES message(id),
  outcome TEXT NOT NULL,
  merged_into TEXT REFERENCES trigger_fire(id),
  merged_count INTEGER NOT NULL,
  merged_capped INTEGER NOT NULL DEFAULT 0,
  push_final INTEGER NOT NULL,
  keep_until TEXT NOT NULL,
  released_at TEXT
);

CREATE UNIQUE INDEX trigger_fire_identity ON trigger_fire(trigger_id, event_id) WHERE released_at IS NULL;
CREATE INDEX trigger_fire_by_message ON trigger_fire(message_id);
CREATE INDEX trigger_fire_by_time ON trigger_fire(created_at);

CREATE TABLE trigger_cursor (
  trigger_id TEXT PRIMARY KEY REFERENCES trigger_rule(id),
  done_at TEXT NOT NULL
);`),
  // The per-project outside-source kind (docs/design/triggers.md §2.2, step 3): its keys, and the
  // run of refusals or failures that makes a problem the owner is told about (§8).
  21: (conn) => conn.exec(`ALTER TABLE trigger_rule ADD COLUMN streak_reason TEXT;
ALTER TABLE trigger_rule ADD COLUMN streak_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE trigger_rule ADD COLUMN problem_since TEXT;
ALTER TABLE trigger_rule ADD COLUMN alerted_at TEXT;
CREATE TABLE trigger_key (
  id TEXT PRIMARY KEY,
  trigger_id TEXT NOT NULL REFERENCES trigger_rule(id),
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  retires_at TEXT
);

CREATE INDEX trigger_key_by_trigger ON trigger_key(trigger_id);`),
  // Skills (docs/design/knowledge-and-skills.md §8 step 3): a Task may name skills, which its
  // rounds are given in full. An existing Task names none.
  22: (conn) => conn.exec('ALTER TABLE task ADD COLUMN skills_json TEXT'),
  // The Worker's SSH path is gone (docs/design/nodes.md §11 step 6): a machine is one whose
  // client joined. A machine that never did is removed the way the owner removes one — its own
  // logins with it, those logins out of every project's list, a line in the timeline — and its
  // rounds not yet ended are judged at the next start's inventory by the existing rule for a
  // removed machine (runner/runner.ts settleRemoved): nothing of them is taken. A project's
  // machine list names registrations rather than names from here on (machine.uid), so that a
  // machine joining later under a deleted machine's name is not in it; a name that matches no
  // machine left becomes a registration that matches none, so that the list keeps restricting
  // rather than turn into "any machine".
  23: (conn) => {
    const at = nowIso();
    const audit = conn.prepare(`INSERT INTO change (id, created_at, at, actor, action, detail_json) VALUES (?, ?, ?, 'migration', ?, ?)`);
    type Gone = { id: string; host: string; ssh_config: string | null; note: string | null };
    const gone = conn.prepare('SELECT id, host, ssh_config, note FROM machine WHERE node_id IS NULL ORDER BY rowid').all() as Gone[];
    const goneIds = new Set(gone.map(({ id }) => id));
    for (const machine of gone) {
      const logins = (conn.prepare('SELECT executor FROM machine_login WHERE machine_id = ? ORDER BY rowid').all(machine.id) as { executor: string }[])
        .map(({ executor }) => `${machine.id}/${executor}`);
      for (const login of logins) conn.prepare('DELETE FROM login_state WHERE id = ?').run(login);
      conn.prepare('DELETE FROM machine_login WHERE machine_id = ?').run(machine.id);
      conn.prepare('DELETE FROM machine WHERE id = ?').run(machine.id);
      audit.run(ulid(), at, at, 'machine.delete', JSON.stringify({
        machine_id: machine.id, machine: { host: machine.host, ssh_config: machine.ssh_config, note: machine.note }, logins,
        reason: '这台机器没有经客户端接入：机器只经客户端接入，没接入的机器在升级时移除',
      }));
    }
    conn.exec(`CREATE TABLE machine_next (
  id TEXT PRIMARY KEY,
  uid TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  host TEXT NOT NULL,
  note TEXT,
  node_id TEXT NOT NULL,
  token_hash TEXT,
  platform TEXT,
  joined_at TEXT,
  last_seen_at TEXT,
  source TEXT,
  ephemeral INTEGER NOT NULL DEFAULT 0,
  invite_id TEXT,
  claim_hash TEXT,
  drain_at TEXT,
  evidence_at TEXT,
  left_at TEXT,
  left_reason TEXT,
  destroyed_at TEXT,
  destroyed_by TEXT
)`);
    const kept = conn.prepare('SELECT id FROM machine ORDER BY rowid').all() as { id: string }[];
    const uidOf = new Map(kept.map(({ id }) => [id, ulid()]));
    const copy = conn.prepare(`INSERT INTO machine_next (id, uid, created_at, updated_at, host, note, node_id, token_hash, platform, joined_at, last_seen_at, source, ephemeral,
      invite_id, claim_hash, drain_at, evidence_at, left_at, left_reason, destroyed_at, destroyed_by)
      SELECT id, ?, created_at, updated_at, host, note, node_id, token_hash, platform, joined_at, last_seen_at, source, ephemeral,
      invite_id, claim_hash, drain_at, evidence_at, left_at, left_reason, destroyed_at, destroyed_by FROM machine WHERE id = ?`);
    for (const [id, uid] of uidOf) copy.run(uid, id);
    conn.exec(`DROP TABLE machine;
ALTER TABLE machine_next RENAME TO machine;
CREATE UNIQUE INDEX machine_one_uid ON machine(uid);
CREATE UNIQUE INDEX machine_one_node ON machine(node_id);
CREATE UNIQUE INDEX machine_one_token ON machine(token_hash) WHERE token_hash IS NOT NULL;
CREATE UNIQUE INDEX machine_one_claim ON machine(claim_hash) WHERE claim_hash IS NOT NULL;`);
    const projects = conn.prepare('SELECT id, logins_json, machines_json FROM project ORDER BY rowid').all() as { id: string; logins_json: string; machines_json: string }[];
    const update = conn.prepare('UPDATE project SET logins_json = ?, machines_json = ? WHERE id = ?');
    // A machine's own login a project names has to be one still held after this step: those of
    // the machines removed here, and those an older program left behind when it deleted a
    // machine, would otherwise let a machine joining later under that name in unasked.
    const held = new Set((conn.prepare('SELECT machine_id, executor FROM machine_login').all() as { machine_id: string; executor: string }[]).map(({ machine_id, executor }) => `${machine_id}/${executor}`));
    for (const project of projects) {
      const logins = JSON.parse(project.logins_json) as string[];
      const keptLogins = logins.filter((login) => !login.includes('/') || held.has(login));
      const dropped = logins.filter((login) => !keptLogins.includes(login));
      const removedHere = dropped.filter((login) => goneIds.has(login.slice(0, login.indexOf('/'))));
      const names = JSON.parse(project.machines_json) as string[];
      const missing = names.filter((name) => !uidOf.has(name));
      update.run(JSON.stringify(keptLogins), JSON.stringify(names.map((name) => uidOf.get(name) ?? ulid())), project.id);
      if (keptLogins.length === logins.length && missing.length === 0) continue;
      audit.run(ulid(), at, at, 'project.update', JSON.stringify({
        project_id: project.id,
        ...(dropped.length === 0 ? {} : { logins: { from: logins, to: keptLogins }, logins_removed: { machine_removed: removedHere, no_such_login: dropped.filter((login) => !removedHere.includes(login)) } }),
        ...(missing.length === 0 ? {} : { machines_gone: missing }),
        reason: '机器只经客户端接入：没接入的机器自己的登录、以及早已不存在的机器登录，从项目的允许登录里去掉；允许的机器里没接入的那几台不再匹配任何机器',
      }));
    }
  },
  24: (conn) => conn.exec(`ALTER TABLE login_state ADD COLUMN identity_json TEXT NOT NULL DEFAULT '{}'`),
  // To 26: names are labels, never references. A removed login cannot be selected by
  // creating another one with its name. Historical input snapshots remain byte for byte.
  25: Object.assign((conn: DatabaseSync) => {
    const at = nowIso();
    const brokenBefore = conn.prepare('PRAGMA foreign_key_check').all().length;
    const audit = conn.prepare(`INSERT INTO change (id, created_at, at, actor, task_id, run_id, action, detail_json) VALUES (?, ?, ?, 'migration', ?, ?, ?, ?)`);
    const note = (action: string, detail: { task_id?: string; run_id?: string; [key: string]: unknown }) => audit.run(ulid(), at, at, detail.task_id ?? null, detail.run_id ?? null, action, JSON.stringify(detail));
    const ids = new Map<string, string>();
    conn.exec(`CREATE TABLE account_next (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  executor TEXT NOT NULL,
  config_dir TEXT,
  tiers_json TEXT NOT NULL,
  permission_mode TEXT,
  timeout_ms INTEGER,
  max_runs INTEGER,
  credential_ref TEXT
);
CREATE TABLE machine_login_next (
  id TEXT NOT NULL UNIQUE,
  machine_uid TEXT NOT NULL,
  machine_id TEXT NOT NULL,
  executor TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  tiers_json TEXT NOT NULL,
  permission_mode TEXT,
  timeout_ms INTEGER,
  max_runs INTEGER,
  PRIMARY KEY (machine_id, executor)
);`);
    const accountCopy = conn.prepare(`INSERT INTO account_next SELECT ?, id, created_at, updated_at, executor, config_dir, tiers_json, permission_mode, timeout_ms, max_runs, credential_ref FROM account WHERE id = ?`);
    for (const { id: name } of conn.prepare('SELECT id FROM account ORDER BY rowid').all() as { id: string }[]) {
      const id = ulid();
      ids.set(name, id);
      accountCopy.run(id, name);
    }
    const ownCopy = conn.prepare(`INSERT INTO machine_login_next SELECT ?, ?, machine_id, executor, created_at, updated_at, tiers_json, permission_mode, timeout_ms, max_runs FROM machine_login WHERE machine_id = ? AND executor = ?`);
    const ownRows = conn.prepare(`SELECT l.machine_id, l.executor, m.uid FROM machine_login l LEFT JOIN machine m ON m.id = l.machine_id ORDER BY l.rowid`).all() as { machine_id: string; executor: string; uid: string | null }[];
    for (const own of ownRows) {
      const name = `${own.machine_id}/${own.executor}`;
      if (own.uid === null) {
        note('machine_login.delete', { login_id: name, login_name: name, machine_id: own.machine_id, reason: '这份登录的机器已不存在，清除悬空登录' });
        continue;
      }
      const id = ulid();
      ids.set(name, id);
      ownCopy.run(id, own.uid, own.machine_id, own.executor);
    }
    conn.exec(`DROP TABLE account; ALTER TABLE account_next RENAME TO account;
DROP TABLE machine_login; ALTER TABLE machine_login_next RENAME TO machine_login;`);

    // A local join proves the host's name only until that registration is deleted or
    // replaced. Never attach the host to a later remote join reusing the same name.
    const local = conn.prepare(`SELECT seq, detail_json FROM change WHERE action = 'machine.join_local' ORDER BY seq DESC LIMIT 1`).get() as { seq: number; detail_json: string } | undefined;
    if (local && !conn.prepare("SELECT 1 FROM setting WHERE key = 'host_machine_uid'").get()) {
      // Null records a local registration we could not recover. No setting means the
      // host never joined locally; a fresh installation has nothing to repair.
      let uid: string | null = null;
      const name = (JSON.parse(local.detail_json) as { machine_id?: unknown }).machine_id;
      if (typeof name === 'string') {
        const changed = conn.prepare(`SELECT 1 FROM change WHERE seq > ? AND action IN ('machine.delete', 'machine.join', 'machine.join_local') AND json_extract(detail_json, '$.machine_id') = ? LIMIT 1`).get(local.seq, name);
        const matches = conn.prepare('SELECT uid FROM machine WHERE id = ? AND left_at IS NULL').all(name) as { uid: string }[];
        if (!changed && matches.length === 1) {
          uid = matches[0]!.uid;
        }
      }
      conn.prepare("INSERT INTO setting (id, created_at, key, value_json) VALUES (?, ?, 'host_machine_uid', ?)").run(ulid(), at, JSON.stringify(uid));
      note('setting.update', { key: 'host_machine_uid', to: uid, machine_id: name, reason: uid === null ? '旧账本有本机接入记录，但无法确认仍有效的机器登记' : '根据仍有效的本机接入登记恢复主机机器绑定' });
    }

    const projects = conn.prepare('SELECT id, logins_json FROM project ORDER BY rowid').all() as { id: string; logins_json: string }[];
    for (const project of projects) {
      const from = JSON.parse(project.logins_json) as string[];
      const to = from.flatMap((name) => ids.has(name) ? [ids.get(name)!] : []);
      conn.prepare('UPDATE project SET logins_json = ? WHERE id = ?').run(JSON.stringify(to), project.id);
      if (from.some((name) => !ids.has(name))) note('project.update', { project_id: project.id, logins: { from, to }, logins_removed: from.filter((name) => !ids.has(name)), reason: '登录引用改用内部编号；已不存在的登录从允许清单中去掉' });
    }
    for (const task of conn.prepare('SELECT id, login_id FROM task WHERE login_id IS NOT NULL ORDER BY rowid').all() as { id: string; login_id: string }[]) {
      const to = ids.get(task.login_id) ?? null;
      conn.prepare('UPDATE task SET login_id = ? WHERE id = ?').run(to, task.id);
      if (to === null) note('task.update', { task_id: task.id, login_id: { from: task.login_id, to }, reason: '钉住的登录已不存在，清除悬空引用' });
    }

    // Ended rounds retain an identity even after the login is gone. Allocate one
    // historical id per old name; it can never refer to a newly created login.
    const historicalIds = new Map<string, string>();
    conn.exec(`CREATE TABLE run_next (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  task_id TEXT NOT NULL REFERENCES task(id),
  task_revision INTEGER NOT NULL,
  login_id TEXT,
  login_name TEXT,
  host TEXT NOT NULL,
  session_ref TEXT,
  state TEXT NOT NULL,
  marker TEXT NOT NULL,
  exit_code INTEGER,
  exit_kind TEXT,
  receipt_json TEXT,
  snapshot_json TEXT NOT NULL,
  error_json TEXT,
  started_at TEXT,
  ended_at TEXT,
  last_progress_at TEXT,
  machine_id TEXT,
  node_id TEXT,
  artifacts_json TEXT
);`);
    const runCopy = conn.prepare(`INSERT INTO run_next SELECT id, created_at, task_id, task_revision, ?, login_id, host, session_ref, state, marker, exit_code, exit_kind, receipt_json, snapshot_json, error_json, started_at, ended_at, last_progress_at, machine_id, node_id, artifacts_json FROM run WHERE id = ?`);
    for (const run of conn.prepare('SELECT id, login_id, state FROM run ORDER BY rowid').all() as { id: string; login_id: string; state: string }[]) {
      let to = ids.get(run.login_id) ?? null;
      if (to === null && run.state === 'ended') {
        to = historicalIds.get(run.login_id) ?? ulid();
        historicalIds.set(run.login_id, to);
      }
      runCopy.run(to, run.id);
      if (!ids.has(run.login_id)) note('run.update', { run_id: run.id, login_id: { from: run.login_id, to }, login_name: run.login_id, reason: run.state === 'ended' ? '已结束轮次的登录已不存在，保留独立的历史编号和名字' : '未结束轮次的登录已不存在，清除悬空引用、名字留作历史显示' });
    }
    conn.exec(`DROP TABLE run; ALTER TABLE run_next RENAME TO run;
CREATE UNIQUE INDEX run_one_active ON run(task_id) WHERE state != 'ended';
ALTER TABLE router_context ADD COLUMN login_name TEXT;`);
    for (const context of conn.prepare('SELECT id, login_id FROM router_context WHERE login_id IS NOT NULL ORDER BY rowid').all() as { id: string; login_id: string }[]) {
      const to = ids.get(context.login_id) ?? null;
      conn.prepare('UPDATE router_context SET login_id = ?, login_name = ? WHERE id = ?').run(to, context.login_id, context.id);
      if (to === null) note('router.context.update', { context_id: context.id, login_id: { from: context.login_id, to }, login_name: context.login_id, reason: '负责人上下文的登录已不存在，清除悬空引用、名字留作历史显示' });
    }
    const states = conn.prepare('SELECT * FROM login_state ORDER BY rowid').all();
    conn.exec('DELETE FROM login_state');
    const stateColumns = ['id', 'created_at', 'rest_seq', 'rest_until', 'rest_streak', 'rest_reason', 'usage_json', 'credential_rejected_ref', 'models_json', 'models_at', 'auth_failed_at', 'identity_json'];
    const stateCopy = conn.prepare(`INSERT INTO login_state (${stateColumns.join(', ')}) VALUES (${stateColumns.map(() => '?').join(', ')})`);
    for (const state of states) {
      const name = state.id as string;
      const id = ids.get(name);
      if (id) stateCopy.run(id, ...stateColumns.slice(1).map((column) => state[column] as SQLInputValue));
      else note('login.state.delete', { login_name: name, reason: '登录已不存在，清除悬空额度和身份状态' });
    }
    const settings = conn.prepare(`SELECT value_json FROM setting WHERE key = 'tunables'`).get() as { value_json: string } | undefined;
    if (settings) {
      const tunables = JSON.parse(settings.value_json) as Record<string, unknown>;
      for (const key of ['router.account', 'knowledge.logins'] as const) {
        const from = tunables[key];
        if (from === undefined) continue;
        const names = key === 'router.account' ? (typeof from === 'string' && from !== '' ? [from] : []) : from as string[];
        const held = names.flatMap((name) => ids.has(name) ? [ids.get(name)!] : []);
        const to = key === 'router.account' ? held[0] ?? '' : held;
        tunables[key] = to;
        if (names.some((name) => !ids.has(name))) note('setting.update', { key, from, to, logins_removed: names.filter((name) => !ids.has(name)), reason: '设置里的登录改用内部编号；已不存在的登录清除，空的负责人绑定使用主机自己的登录' });
      }
      conn.prepare(`UPDATE setting SET value_json = ? WHERE key = 'tunables'`).run(JSON.stringify(tunables));
    }
    // Waiting notices still query the login state when sent or reminded. Their nested
    // payloads (reminders and batches) are references too; delivery keys are opaque keys.
    for (const table of ['outbox', 'push']) {
      for (const row of conn.prepare(`SELECT id, payload_json FROM ${table} ORDER BY rowid`).all() as { id: string; payload_json: string }[]) {
        const removed: { field: string; name: string }[] = [];
        let changed = false;
        const rewrite = (value: unknown): unknown => {
          if (Array.isArray(value)) return value.map(rewrite);
          if (value === null || typeof value !== 'object') return value;
          const result: Record<string, unknown> = {};
          for (const [key, field] of Object.entries(value)) {
            if ((key === 'login_id' || key === 'account_id') && typeof field === 'string') {
              result[key] = ids.get(field) ?? null;
              changed = true;
              if (!ids.has(field)) {
                removed.push({ field: key, name: field });
                result[key === 'login_id' ? 'login_name' : 'account_name'] = field;
              }
            } else result[key] = rewrite(field);
          }
          return result;
        };
        const payload = rewrite(JSON.parse(row.payload_json));
        if (changed) conn.prepare(`UPDATE ${table} SET payload_json = ? WHERE id = ?`).run(JSON.stringify(payload), row.id);
        if (removed.length > 0) note(`${table}.update`, { [`${table}_id`]: row.id, logins_removed: removed, reason: '待发送或提醒的通知改用登录内部编号，清除已不存在登录的引用' });
      }
    }
    if (conn.prepare('PRAGMA foreign_key_check').all().length !== brokenBefore) throw new Error('登录编号迁移后有引用对不上了，升级没有提交');
  }, { rebuilds: true as const }),
  // To 27: what each round, Router turn and quota read used, as its executor reported it.
  // Nothing before it was kept, so the table starts empty.
  26: (conn) => conn.exec(`-- What an executor reported as used: one row per model of a Worker round, a Router turn or
-- a quota read (docs/design/usage.md). Exactly one of run_id, context_id and login_id says
-- whose use it was: a round's or a context's login is the one it ran as. The figures are the
-- executor's own, input not overlapping the cache; list_cost_usd only where it priced the use
-- at list prices. model_basis: 'reported' when the executor named the model, 'tier' when it is
-- the model the round's tier asked for. at: when it was recorded, a round's end for a round.
CREATE TABLE IF NOT EXISTS usage (
  id TEXT PRIMARY KEY,
  at TEXT NOT NULL,
  run_id TEXT REFERENCES run(id),
  context_id TEXT REFERENCES router_context(id),
  login_id TEXT,
  model TEXT,
  model_basis TEXT,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cache_read_tokens INTEGER NOT NULL,
  cache_write_tokens INTEGER NOT NULL,
  list_cost_usd REAL,
  CHECK ((run_id IS NOT NULL) + (context_id IS NOT NULL) + (login_id IS NOT NULL) = 1)
);

CREATE INDEX IF NOT EXISTS usage_at ON usage(at);
CREATE INDEX IF NOT EXISTS usage_run ON usage(run_id) WHERE run_id IS NOT NULL;
`),
  // To 28: an account may be a line to a model service (docs/design/native-login.md). Every
  // account there is stays what it was: none has a line.
  27: (conn) => conn.exec('ALTER TABLE account ADD COLUMN provider_json TEXT'),
  // To 29: a project can be paused on its own; a Router context remembers how large it grew,
  // so a long one is rebuilt from the ledger rather than resumed (project-sessions §3, §5).
  28: (conn) => conn.exec(`ALTER TABLE project ADD COLUMN paused_at TEXT;
ALTER TABLE router_context ADD COLUMN context_tokens INTEGER;`),
  // To 30: when the token an account holds now was stored, for the expected expiry of a login
  // whose vendor gives only a rough lifetime (docs/design/native-login.md §2, rulings J and L).
  // An account from before this step has no moment to go by, and none is guessed from the
  // audit: its expected expiry stays unknown until its token is stored again. The same step
  // takes dangling logins out of the projects that still name them: a deletion before this
  // version left the reference behind, where it matches nothing and only says "not any login".
  29: (conn) => {
    conn.exec('ALTER TABLE account ADD COLUMN credential_at TEXT');
    const held = new Set([
      ...(conn.prepare('SELECT id FROM account').all() as { id: string }[]).map((row) => row.id),
      ...(conn.prepare('SELECT id FROM machine_login').all() as { id: string }[]).map((row) => row.id),
    ]);
    // What a gone login went by, from the change that removed it: an account's deletion
    // records its name, a machine's own login the display name it had (the same reading the
    // live ledger makes). A reference that never had a row here was already dangling before
    // this version; its name was never kept, and saying so is better than a number.
    const accountName = conn.prepare(`SELECT json_extract(detail_json, '$.account.name') AS name FROM change
      WHERE action = 'account.delete' AND json_extract(detail_json, '$.account_id') = ? ORDER BY seq DESC LIMIT 1`);
    const machineName = conn.prepare(`SELECT COALESCE(json_extract(detail_json, '$.login_name'), json_extract(detail_json, '$.login.name')) AS name FROM change
      WHERE action = 'machine_login.delete' AND json_extract(detail_json, '$.login_id') = ? ORDER BY seq DESC LIMIT 1`);
    const nameOf = (id: string): string =>
      (accountName.get(id) as { name: string | null } | undefined)?.name
      ?? (machineName.get(id) as { name: string | null } | undefined)?.name
      ?? '已删除的登录';
    const update = conn.prepare('UPDATE project SET logins_json = ? WHERE id = ?');
    const audit = conn.prepare(`INSERT INTO change (id, created_at, at, actor, task_id, run_id, action, detail_json)
      VALUES (?, ?, ?, 'migration', NULL, NULL, 'project.update', ?)`);
    for (const project of conn.prepare('SELECT id, logins_json FROM project ORDER BY rowid').all() as { id: string; logins_json: string }[]) {
      const from = JSON.parse(project.logins_json) as string[];
      const gone = from.filter((id) => !held.has(id));
      if (gone.length === 0) continue;
      const to = from.filter((id) => held.has(id));
      update.run(JSON.stringify(to), project.id);
      const at = nowIso();
      audit.run(ulid(), at, at, JSON.stringify({
        project_id: project.id, logins: { from, to }, logins_removed: gone.map(nameOf),
        reason: '升级时清掉项目允许清单里已经不存在的登录',
      }));
    }
  },
  // To 31: what a project lets its Router do without asking (project-sessions, "负责人可以自己做的事").
  // Every project starts with what the Router could always do; written out, as history is.
  30: (conn) => conn.exec(`ALTER TABLE project ADD COLUMN grants_json TEXT NOT NULL DEFAULT '["accept"]'`),
  // To 32: an account replaces only the identity (merged-design §1.1): the machine's own
  // configuration applies, so neither an account nor a Router context names a configuration
  // directory any more. A value someone had filled in is kept in the audit, then dropped.
  31: (conn) => {
    const at = nowIso();
    const audit = conn.prepare(`INSERT INTO change (id, created_at, at, actor, action, detail_json) VALUES (?, ?, ?, 'migration', ?, ?)`);
    for (const { id, name, config_dir } of conn.prepare('SELECT id, name, config_dir FROM account WHERE config_dir IS NOT NULL ORDER BY rowid').all() as { id: string; name: string; config_dir: string }[]) {
      audit.run(ulid(), at, at, 'account.update', JSON.stringify({ account_id: id, name, config_dir_removed: config_dir, reason: '账号只替换身份，机器上执行器自己的配置照常生效：配置目录不再使用' }));
    }
    for (const { id, project_id, config_dir } of conn.prepare('SELECT id, project_id, config_dir FROM router_context WHERE config_dir IS NOT NULL ORDER BY rowid').all() as { id: string; project_id: string | null; config_dir: string }[]) {
      audit.run(ulid(), at, at, 'router_context.update', JSON.stringify({ context_id: id, project_id, config_dir_removed: config_dir, reason: '负责人的上下文只按登录判断换不换：配置目录不再使用' }));
    }
    // Only a round not yet started is compared with the login as it is now (startAllowed) and
    // may be moved to another machine (rehostRun): its snapshot's login no longer has the field,
    // so it goes whether it was empty or named a directory (that value is kept in the audit
    // above). The top-level field older snapshots carried has no reader either. A round that has
    // started, and an ended one, are records of what was sent: their snapshots stay as written.
    conn.exec(`UPDATE run SET snapshot_json = json_remove(snapshot_json, '$.login.config_dir', '$.config_dir')
  WHERE state = 'launching';
ALTER TABLE account DROP COLUMN config_dir;
ALTER TABLE router_context DROP COLUMN config_dir;`);
  },
  // To 33: a merge round is the ledger's own structure rather than words in its goal: the Task it
  // lands, the pull request and the reviewed commit (project-sessions, "负责人可以自己做的事").
  // A merge child from before this step is recognisable only by the words in its goal; carrying
  // those over was checked against the owner's own ledger, which has none (0), so every old Task
  // is null and the column is written by creating a Task and nothing else.
  32: (conn) => conn.exec('ALTER TABLE task ADD COLUMN landing_json TEXT'),

  // To 34: what a finished work left on disk is cleared once its retention period has passed
  // (docs/design/phase1-design.md "已结束的工作"). Only the two moments of that clearing are
  // added; no old row is backfilled, so nothing of an older ledger reads as already cleared.
  33: (conn) => conn.exec(`ALTER TABLE run ADD COLUMN releases_dropped_at TEXT;
ALTER TABLE run ADD COLUMN code_dropped_at TEXT`),

  // To 35: a project can be put away without deleting anything (project-sessions, "项目的生命周期").
  // It dispatches nothing and its Router takes nothing until it is restored, as a paused one.
  34: (conn) => conn.exec('ALTER TABLE project ADD COLUMN archived_at TEXT'),
  // To 36: a Task may ask for a few logins first, in an order of its own, with why
  // (roles-and-tiers.md §11): the Router's preference, kept beside the Task and never part of
  // what it asks (no new revision). No Task from before this step asked for one.
  35: (conn) => conn.exec('ALTER TABLE task ADD COLUMN prefer_json TEXT'),
  // To 37: the operate tier (roles-and-tiers.md §10). The preset verify role moves from the
  // execute tier to operate; a role the owner has changed is left as it is. No login is
  // given operate content: one without it runs operate work on its own execute content
  // (§10.3), so nothing changes for a login the owner has not filled in.
  36: (conn) => conn.prepare(`UPDATE role SET default_tier = 'operate', updated_at = ? WHERE id = ? AND default_tier = 'execute'`).run(nowIso(), VERIFY_ROLE_ID),
  // To 38: an archived project with history can be deleted (project-sessions, "项目的生命周期").
  // What it left on disk outlives its rows: work_cleanup names the round and its machine without
  // a foreign key, so the cleanup can still be asked for once the Task and Run are gone. A row
  // of use whose round or context is deleted keeps its figures and its day, and loses only the
  // link: the check becomes "at most one owner", so the total the usage page sums does not move;
  // dropped_source and dropped_unit keep what it was and how many units it stood for, so the
  // page shows it as a deleted project's use rather than as a quota read. Two more things a
  // deleted round took with it are kept the same way: how long it lasted (duration_ms), and the
  // fact that a round which never reported a figure is still a round — the four count columns
  // become nullable, so a row can say "this unit existed, for this long, with no figure".
  37: (conn) => conn.exec(`CREATE TABLE work_cleanup (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  project_id TEXT NOT NULL,
  project_name TEXT NOT NULL,
  run_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  machine_id TEXT,
  node_id TEXT,
  releases_json TEXT NOT NULL,
  releases_dropped_at TEXT,
  code_dropped_at TEXT
);
CREATE INDEX work_cleanup_by_run ON work_cleanup(run_id);
CREATE INDEX work_cleanup_pending ON work_cleanup(releases_dropped_at, code_dropped_at);
CREATE TABLE usage_next (
  id TEXT PRIMARY KEY,
  at TEXT NOT NULL,
  run_id TEXT REFERENCES run(id),
  context_id TEXT REFERENCES router_context(id),
  login_id TEXT,
  model TEXT,
  model_basis TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cache_read_tokens INTEGER,
  cache_write_tokens INTEGER,
  list_cost_usd REAL,
  duration_ms INTEGER,
  dropped_source TEXT,
  dropped_unit TEXT,
  CHECK ((run_id IS NOT NULL) + (context_id IS NOT NULL) + (login_id IS NOT NULL) <= 1),
  CHECK (dropped_source IS NULL OR (dropped_source IN ('run', 'router') AND dropped_unit IS NOT NULL AND run_id IS NULL AND context_id IS NULL))
);
INSERT INTO usage_next (id, at, run_id, context_id, login_id, model, model_basis, input_tokens, output_tokens,
  cache_read_tokens, cache_write_tokens, list_cost_usd) SELECT id, at, run_id, context_id, login_id, model, model_basis, input_tokens, output_tokens,
  cache_read_tokens, cache_write_tokens, list_cost_usd FROM usage;
DROP TABLE usage;
ALTER TABLE usage_next RENAME TO usage;
CREATE INDEX usage_at ON usage(at);
CREATE INDEX usage_run ON usage(run_id) WHERE run_id IS NOT NULL;`),

  // To 39: a machine's own login the owner removed in this registration is not adopted again
  // from that machine's reports (docs/design/accounts-machines-decoupled.md). Nothing is
  // backfilled: before this version no refusal was ever recorded.
  38: (conn) => conn.exec(`CREATE TABLE machine_login_refusal (
  machine_uid TEXT NOT NULL,
  executor TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (machine_uid, executor)
)`),

  // To 40: outside events come in through tycho-wide inbound sources rather than per-project
  // triggers (docs/design/triggers.md §2.2, step 4). Each old outside-source trigger becomes one
  // `tycho-v1` source that lets through only its own project: its fixed instruction is the
  // source's note, its keys and their retirement times move as they were, and its occurrence
  // records keep pointing at the same id, now a source. The table that counts occurrences and
  // its identity are rebuilt to tell a rule's from a source's. A step that resolves to nothing
  // on a ledger with none of them still creates the two tables: a version is its schema.
  39: Object.assign((conn: DatabaseSync) => {
    const at = nowIso();
    conn.exec(`CREATE TABLE inbound_source (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  projects_json TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  push_final INTEGER NOT NULL,
  enabled INTEGER NOT NULL,
  created_by TEXT NOT NULL,
  deleted_at TEXT,
  rejected_count INTEGER NOT NULL DEFAULT 0,
  rejected_at TEXT,
  rejected_reason TEXT,
  streak_reason TEXT,
  streak_count INTEGER NOT NULL DEFAULT 0,
  problem_since TEXT,
  streak_project_id TEXT,
  alerted_at TEXT
);
CREATE TABLE inbound_key (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES inbound_source(id),
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  retires_at TEXT
);
CREATE INDEX inbound_key_by_source ON inbound_key(source_id);`);
    const hooks = conn.prepare(`SELECT * FROM trigger_rule WHERE source = 'webhook' ORDER BY rowid`).all() as {
      id: string; created_at: string; updated_at: string; project_id: string; name: string; enabled: number; instruction: string;
      push_final: number; created_by: string; deleted_at: string | null; rejected_count: number; rejected_at: string | null;
      rejected_reason: string | null; streak_reason: string | null; streak_count: number; problem_since: string | null; alerted_at: string | null;
    }[];
    const insertSource = conn.prepare(`INSERT INTO inbound_source
      (id, created_at, updated_at, name, kind, projects_json, note, push_final, enabled, created_by, deleted_at,
       rejected_count, rejected_at, rejected_reason, streak_reason, streak_count, problem_since, streak_project_id, alerted_at)
      VALUES (?, ?, ?, ?, 'tycho-v1', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const hook of hooks) {
      insertSource.run(hook.id, hook.created_at, hook.updated_at, hook.name, JSON.stringify([hook.project_id]), hook.instruction,
        hook.push_final, hook.enabled, hook.created_by, hook.deleted_at, hook.rejected_count, hook.rejected_at, hook.rejected_reason,
        hook.streak_reason, hook.streak_count, hook.problem_since, hook.streak_reason === 'queue_full' ? hook.project_id : null, hook.alerted_at);
    }
    const keyRows = conn.prepare(`SELECT k.* FROM trigger_key k JOIN inbound_source s ON s.id = k.trigger_id ORDER BY k.rowid`).all() as {
      id: string; trigger_id: string; created_at: string; created_by: string; retires_at: string | null;
    }[];
    const insertKey = conn.prepare('INSERT INTO inbound_key (id, source_id, created_at, created_by, retires_at) VALUES (?, ?, ?, ?, ?)');
    for (const key of keyRows) insertKey.run(key.id, key.trigger_id, key.created_at, key.created_by, key.retires_at);
    // The occurrence records: an old outside-source trigger's become the source's, with the same
    // id and no revision; a rule's stay as they were.
    conn.exec(`CREATE TABLE trigger_fire_next (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  trigger_id TEXT REFERENCES trigger_rule(id),
  source_id TEXT REFERENCES inbound_source(id),
  project_id TEXT NOT NULL REFERENCES project(id),
  event_id TEXT NOT NULL,
  digest TEXT NOT NULL,
  scheduled_at TEXT,
  revision INTEGER,
  periodic INTEGER NOT NULL,
  data_json TEXT NOT NULL,
  message_id TEXT REFERENCES message(id),
  outcome TEXT NOT NULL,
  merged_into TEXT REFERENCES trigger_fire(id),
  merged_count INTEGER NOT NULL,
  merged_capped INTEGER NOT NULL DEFAULT 0,
  push_final INTEGER NOT NULL,
  keep_until TEXT NOT NULL,
  released_at TEXT,
  CHECK ((trigger_id IS NOT NULL) + (source_id IS NOT NULL) = 1)
);
INSERT INTO trigger_fire_next (id, created_at, trigger_id, source_id, project_id, event_id, digest, scheduled_at, revision, periodic, data_json, message_id, outcome, merged_into, merged_count, merged_capped, push_final, keep_until, released_at)
  SELECT id, created_at, CASE WHEN trigger_id IN (SELECT id FROM inbound_source) THEN NULL ELSE trigger_id END,
    CASE WHEN trigger_id IN (SELECT id FROM inbound_source) THEN trigger_id ELSE NULL END,
    project_id, event_id, digest, scheduled_at, CASE WHEN trigger_id IN (SELECT id FROM inbound_source) THEN NULL ELSE revision END,
    periodic, data_json, message_id, outcome, merged_into, merged_count, merged_capped, push_final, keep_until, released_at
  FROM trigger_fire;
DROP TABLE trigger_fire;
ALTER TABLE trigger_fire_next RENAME TO trigger_fire;
CREATE UNIQUE INDEX trigger_fire_rule_identity ON trigger_fire(trigger_id, event_id) WHERE released_at IS NULL AND trigger_id IS NOT NULL;
CREATE UNIQUE INDEX trigger_fire_source_identity ON trigger_fire(source_id, project_id, event_id) WHERE released_at IS NULL AND source_id IS NOT NULL;
CREATE INDEX trigger_fire_by_message ON trigger_fire(message_id);
CREATE INDEX trigger_fire_by_time ON trigger_fire(created_at);
CREATE INDEX trigger_fire_by_source ON trigger_fire(source_id);`);
    const moved = conn.prepare(`SELECT count(*) AS n FROM trigger_fire WHERE source_id IS NOT NULL`).get() as { n: number };
    conn.exec(`DROP TABLE trigger_key;
DELETE FROM trigger_cursor WHERE trigger_id IN (SELECT id FROM inbound_source);
DELETE FROM trigger_rule WHERE source = 'webhook';`);
    // The settings that governed the old kind now govern an inbound source, same values.
    const tunables = conn.prepare(`SELECT value_json FROM setting WHERE key = 'tunables'`).get() as { value_json: string } | undefined;
    if (tunables) {
      const settings = JSON.parse(tunables.value_json) as Record<string, unknown>;
      const renamed: Record<string, string> = { 'triggers.webhookSkewMs': 'triggers.inboundSkewMs', 'triggers.webhookRotateMs': 'triggers.inboundRotateMs' };
      let changed = false;
      for (const [from, to] of Object.entries(renamed)) {
        if (!Object.hasOwn(settings, from)) continue;
        settings[to] = settings[from];
        delete settings[from];
        changed = true;
      }
      if (changed) conn.prepare(`UPDATE setting SET value_json = ? WHERE key = 'tunables'`).run(JSON.stringify(settings));
    }
    // A notice waiting on a source's problem names it the same way it named the old trigger.
    if (hooks.length > 0) {
      const ids = new Set(hooks.map(({ id }) => id));
      for (const table of ['outbox', 'push']) {
        const rewrite = (value: unknown): unknown => {
          if (Array.isArray(value)) return value.map(rewrite);
          if (value === null || typeof value !== 'object') return value;
          const result: Record<string, unknown> = {};
          for (const [key, field] of Object.entries(value)) {
            if (key === 'trigger_id' && typeof field === 'string' && ids.has(field)) result.source_id = rewrite(field);
            else result[key] = rewrite(field);
          }
          return result;
        };
        for (const row of conn.prepare(`SELECT id, payload_json FROM ${table} ORDER BY rowid`).all() as { id: string; payload_json: string }[]) {
          const payload = rewrite(JSON.parse(row.payload_json));
          const text = JSON.stringify(payload);
          if (text !== row.payload_json) conn.prepare(`UPDATE ${table} SET payload_json = ? WHERE id = ?`).run(text, row.id);
        }
      }
    }
    if (hooks.length > 0) {
      conn.prepare(`INSERT INTO change (id, created_at, at, actor, action, detail_json) VALUES (?, ?, ?, 'migration', 'inbound.migrate', ?)`)
        .run(ulid(), at, at, JSON.stringify({ sources: hooks.length, keys: keyRows.length, fires: moved.n, reason: '按项目的外部来源触发器换成 tycho 级的入站来源：原触发器成为只放行原项目的 tycho-v1 来源，密钥和触发记录照旧' }));
    }
  }, { rebuilds: true as const }),

  // To 41: a project's code comes from an ordered list of sources instead of one host directory
  // (docs/design/code-sources.md §5; shared/sources.ts). Each old directory becomes a folder
  // source on the host's own machine registration — or, when none can be recovered, one whose
  // machine is still to be confirmed (PENDING_MACHINE_UID), which the project page asks the owner
  // to fill in — with a repository source after it when the directory's origin may be handed to a
  // machine. A project that named only a remote becomes one repository source when a machine may
  // be handed that address; one it may not (a local path, file://, another transport) becomes no
  // source at all, said in an audit that repeats no secret. Every Task not yet
  // over is pinned to the first source its project now has, and a Task of a project with none is
  // pinned to nothing (its rounds work in an empty Task directory).
  40: (conn) => {
    const at = nowIso();
    const audit = conn.prepare(`INSERT INTO change (id, created_at, at, actor, action, detail_json) VALUES (?, ?, ?, 'migration', 'project.update', ?)`);
    const host = conn.prepare(`SELECT value_json FROM setting WHERE key = 'host_machine_uid'`).get() as { value_json: string } | undefined;
    let hostUid: string | null = null;
    if (host !== undefined) {
      try {
        const uid = JSON.parse(host.value_json) as unknown;
        if (typeof uid === 'string' && uid !== '' && conn.prepare('SELECT 1 FROM machine WHERE uid = ?').get(uid)) hostUid = uid;
      } catch {
        hostUid = null;
      }
    }
    const projects = conn.prepare('SELECT id, repo, code_dir FROM project ORDER BY rowid').all() as
      { id: string; repo: string | null; code_dir: string | null }[];
    const pinned = new Map<string, Source[]>();
    conn.exec(`ALTER TABLE project ADD COLUMN sources_json TEXT NOT NULL DEFAULT '[]'`);
    const writeSources = conn.prepare('UPDATE project SET sources_json = ? WHERE id = ?');
    for (const project of projects) {
      const dir = project.code_dir === null ? '' : project.code_dir.trim();
      const remote = project.repo === null ? '' : project.repo.trim();
      const sources: Source[] = [];
      let dropped: string | null = null;
      if (dir !== '') {
        sources.push({ id: ulid(), kind: 'folder', machine_uid: hostUid ?? PENDING_MACHINE_UID, path: dir });
        const origin = oldFolderRemote(project.code_dir!);
        if (origin !== null) sources.push({ id: ulid(), kind: 'repo', url: origin });
      } else if (remote !== '') {
        const usable = machineRemote(remote);
        if (usable !== null) sources.push({ id: ulid(), kind: 'repo', url: usable });
        else dropped = redactedRemote(remote);
      }
      pinned.set(project.id, sources);
      writeSources.run(JSON.stringify(sources), project.id);
      if (dropped !== null) {
        audit.run(ulid(), at, at, JSON.stringify({
          project_id: project.id,
          sources_dropped: [{
            kind: 'repo',
            value: dropped,
            reason: '旧仓库地址机器用不了：只收 https、http、ssh 或 git 的网络地址，不能带秘密，也不是本机路径或 file://',
          }],
        }));
      }
    }
    conn.exec('ALTER TABLE project DROP COLUMN repo; ALTER TABLE project DROP COLUMN code_dir');
    conn.exec('ALTER TABLE task ADD COLUMN source_json TEXT');
    const setSource = conn.prepare('UPDATE task SET source_json = ? WHERE id = ?');
    for (const task of conn.prepare(`SELECT id, project_id FROM task WHERE state NOT IN ('done', 'abandoned') ORDER BY rowid`).all() as
      { id: string; project_id: string | null }[]) {
      const first = task.project_id === null ? undefined : pinned.get(task.project_id)?.[0];
      if (first === undefined) continue;
      setSource.run(JSON.stringify({ source_id: first.id, pinned: first }), task.id);
    }
  },
  41: (conn) => {
    conn.exec(ROUTER_CALL_SCHEMA + `
    ALTER TABLE inbound_source ADD COLUMN result_reply INTEGER NOT NULL DEFAULT 0 CHECK (result_reply IN (0,1));
    ALTER TABLE project ADD COLUMN router_account TEXT;
    ALTER TABLE project ADD COLUMN router_tier TEXT CHECK (router_tier IS NULL OR router_tier IN ('operate', 'execute', 'decide'));
    ALTER TABLE run ADD COLUMN settlement_digest TEXT;
    ALTER TABLE change ADD COLUMN tool_call_id TEXT REFERENCES router_call(id) ON DELETE SET NULL;
    CREATE INDEX change_tool_call ON change(tool_call_id) WHERE tool_call_id IS NOT NULL;
  `);
    const row = conn.prepare("SELECT value_json FROM setting WHERE key = 'tunables'").get() as { value_json: string } | undefined;
    const tunables = row ? JSON.parse(row.value_json) as Record<string, unknown> : {};
    if (!Object.hasOwn(tunables, 'knowledge.externalEntry')) {
      tunables['knowledge.externalEntry'] = true;
      conn.prepare("INSERT INTO setting (id, created_at, key, value_json) VALUES (?, ?, 'tunables', ?) ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json")
        .run(ulid(), nowIso(), JSON.stringify(tunables));
    }
  },
  42: (conn) => { conn.exec('ALTER TABLE run ADD COLUMN capture_result_json TEXT; ALTER TABLE work_cleanup ADD COLUMN output_release_json TEXT'); },
  43: (conn) => {
    const orchestrate = PRESET_ROLES.find((role) => role.id === ORCHESTRATE_ROLE_ID);
    if (!orchestrate) return;
    const at = nowIso();
    conn.prepare(`INSERT INTO role (id, created_at, updated_at, name, description, default_tier, permission, deliverable, needs_review)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING`)
      .run(orchestrate.id, at, at, orchestrate.name, orchestrate.description, orchestrate.default_tier, orchestrate.permission, orchestrate.deliverable, orchestrate.needs_review ? 1 : 0);
  },
  44: (conn) => {
    const cols = conn.prepare('PRAGMA table_info(message)').all() as { name: string }[];
    if (!cols.some((col) => col.name === 'attachments_json')) {
      conn.exec('ALTER TABLE message ADD COLUMN attachments_json TEXT');
    }
    conn.exec(`
      CREATE TABLE IF NOT EXISTS project_file (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES project(id),
        name TEXT NOT NULL,
        mime TEXT NOT NULL,
        size INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('upload', 'artifact', 'doc')),
        origin TEXT NOT NULL CHECK (origin IN ('owner', 'router', 'worker')),
        summary TEXT,
        message_id TEXT REFERENCES message(id),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS project_file_by_project ON project_file(project_id, updated_at DESC);
      CREATE TABLE IF NOT EXISTS project_files_cleanup (
        project_id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        project_name TEXT NOT NULL,
        dropped_at TEXT
      );
      CREATE INDEX IF NOT EXISTS project_files_cleanup_pending ON project_files_cleanup(dropped_at);
    `);
  },
  45: (conn) => {
    const hasColumn = (table: string, name: string): boolean =>
      (conn.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((col) => col.name === name);
    if (!hasColumn('message', 'reply_to_external_id')) {
      conn.exec('ALTER TABLE message ADD COLUMN reply_to_external_id TEXT');
    }
    if (!hasColumn('inbound_source', 'broadcast_groups')) {
      conn.exec('ALTER TABLE inbound_source ADD COLUMN broadcast_groups INTEGER NOT NULL DEFAULT 0');
    }
    if (!hasColumn('inbound_source', 'broadcast_group_ids_json')) {
      conn.exec(`ALTER TABLE inbound_source ADD COLUMN broadcast_group_ids_json TEXT NOT NULL DEFAULT '[]'`);
    }
    if (!hasColumn('trigger_rule', 'broadcast_groups')) {
      conn.exec('ALTER TABLE trigger_rule ADD COLUMN broadcast_groups INTEGER NOT NULL DEFAULT 0');
    }
    if (!hasColumn('trigger_rule', 'broadcast_group_ids_json')) {
      conn.exec(`ALTER TABLE trigger_rule ADD COLUMN broadcast_group_ids_json TEXT NOT NULL DEFAULT '[]'`);
    }
    if (!hasColumn('trigger_fire', 'broadcast_groups')) {
      conn.exec('ALTER TABLE trigger_fire ADD COLUMN broadcast_groups INTEGER NOT NULL DEFAULT 0');
    }
    if (!hasColumn('trigger_fire', 'broadcast_group_ids_json')) {
      conn.exec(`ALTER TABLE trigger_fire ADD COLUMN broadcast_group_ids_json TEXT NOT NULL DEFAULT '[]'`);
    }
    conn.exec(`
      CREATE TABLE IF NOT EXISTS im_group_binding (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        channel TEXT NOT NULL CHECK (channel IN ('wecom', 'weixin')),
        chat_id TEXT NOT NULL,
        chat_name TEXT NOT NULL DEFAULT '',
        project_id TEXT NOT NULL REFERENCES project(id),
        enabled INTEGER NOT NULL DEFAULT 1,
        trigger_mode TEXT NOT NULL DEFAULT 'mention_only' CHECK (trigger_mode IN ('mention_only', 'mention_or_rules')),
        allow_all_senders INTEGER NOT NULL DEFAULT 0,
        allowed_senders_json TEXT NOT NULL DEFAULT '[]',
        rule_keywords_json TEXT NOT NULL DEFAULT '[]',
        cooldown_seconds INTEGER NOT NULL DEFAULT 60,
        inline_context_count INTEGER NOT NULL DEFAULT 6,
        accept_media INTEGER NOT NULL DEFAULT 1,
        notify_events INTEGER NOT NULL DEFAULT 1,
        last_triggered_at TEXT,
        UNIQUE(channel, chat_id)
      );
      CREATE INDEX IF NOT EXISTS im_group_binding_by_project ON im_group_binding(project_id);
      CREATE TABLE IF NOT EXISTS im_group_context (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        channel TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        external_id TEXT NOT NULL,
        actor TEXT NOT NULL,
        actor_name TEXT,
        text TEXT NOT NULL DEFAULT '',
        mentioned_bot INTEGER NOT NULL DEFAULT 0,
        reply_to_external_id TEXT,
        attachments_meta_json TEXT,
        message_id TEXT,
        project_id TEXT,
        UNIQUE(channel, chat_id, external_id)
      );
      CREATE INDEX IF NOT EXISTS im_group_context_by_chat ON im_group_context(channel, chat_id, created_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS im_group_context_by_msg ON im_group_context(message_id);
    `);
  },
  46: (conn) => {
    const hasColumn = (table: string, name: string): boolean =>
      (conn.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((col) => col.name === name);
    if (!hasColumn('project', 'dispatch_order_json')) {
      conn.exec('ALTER TABLE project ADD COLUMN dispatch_order_json TEXT');
    }
  },
  47: (conn) => {
    const hasColumn = (table: string, name: string): boolean =>
      (conn.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((col) => col.name === name);
    if (!hasColumn('task', 'machine_id')) {
      conn.exec('ALTER TABLE task ADD COLUMN machine_id TEXT');
    }
  },
};

// The tables a ledger of each version cannot be without: what tells one from a file that
// merely carries its version. A new version adds its list here.
const V4_TABLES = ['project', 'task', 'run', 'message', 'input', 'approval', 'decision', 'outbox', 'router_session', 'change', 'setting'];
const LEDGER_TABLES: Record<number, readonly string[]> = {
  4: V4_TABLES,
  5: [...V4_TABLES, 'target'],
  6: [...V4_TABLES, 'target', 'target_state'],
  7: [...V4_TABLES, 'account', 'machine', 'account_state'],
  8: [...V4_TABLES, 'account', 'machine', 'account_state'],
  9: [...V4_TABLES, 'account', 'machine', 'account_state'],
  10: [...V4_TABLES, 'account', 'machine', 'account_state'],
  11: [...V4_TABLES, 'account', 'machine', 'account_state'],
  12: [...V4_TABLES, 'account', 'machine', 'account_state'],
  13: [...V4_TABLES, 'account', 'machine', 'account_state'],
  14: [...V4_TABLES, 'account', 'machine', 'account_state', 'machine_invite', 'machine_material'],
  15: [...V4_TABLES, 'account', 'machine', 'account_state', 'machine_invite', 'machine_material'],
  16: [...V4_TABLES, 'account', 'machine', 'account_state', 'machine_invite', 'machine_material', 'role'],
  17: [...V4_TABLES, 'account', 'machine', 'account_state', 'machine_invite', 'machine_material', 'role'],
  18: [...V4_TABLES, 'account', 'machine', 'machine_login', 'login_state', 'machine_invite', 'machine_material', 'role'],
  19: [...V4_TABLES, 'account', 'machine', 'machine_login', 'login_state', 'machine_invite', 'machine_material', 'role',
    'knowledge', 'knowledge_proposal', 'knowledge_revision', 'knowledge_evidence', 'knowledge_client'],
  20: [...V4_TABLES.filter((table) => table !== 'router_session' && table !== 'decision'), 'account', 'machine', 'machine_login', 'login_state', 'machine_invite', 'machine_material', 'role',
    'knowledge', 'knowledge_proposal', 'knowledge_revision', 'knowledge_evidence', 'knowledge_client', 'router_segment', 'router_context', 'front_desk', 'push'],
  21: [...V4_TABLES.filter((table) => table !== 'router_session' && table !== 'decision'), 'account', 'machine', 'machine_login', 'login_state', 'machine_invite', 'machine_material', 'role',
    'knowledge', 'knowledge_proposal', 'knowledge_revision', 'knowledge_evidence', 'knowledge_client', 'router_segment', 'router_context', 'front_desk', 'push',
    'trigger_rule', 'trigger_fire', 'trigger_cursor'],
  22: [...V4_TABLES.filter((table) => table !== 'router_session' && table !== 'decision'), 'account', 'machine', 'machine_login', 'login_state', 'machine_invite', 'machine_material', 'role',
    'knowledge', 'knowledge_proposal', 'knowledge_revision', 'knowledge_evidence', 'knowledge_client', 'router_segment', 'router_context', 'front_desk', 'push',
    'trigger_rule', 'trigger_fire', 'trigger_cursor', 'trigger_key'],
  23: [...V4_TABLES.filter((table) => table !== 'router_session' && table !== 'decision'), 'account', 'machine', 'machine_login', 'login_state', 'machine_invite', 'machine_material', 'role',
    'knowledge', 'knowledge_proposal', 'knowledge_revision', 'knowledge_evidence', 'knowledge_client', 'router_segment', 'router_context', 'front_desk', 'push',
    'trigger_rule', 'trigger_fire', 'trigger_cursor', 'trigger_key'],
  24: [...V4_TABLES.filter((table) => table !== 'router_session' && table !== 'decision'), 'account', 'machine', 'machine_login', 'login_state', 'machine_invite', 'machine_material', 'role',
    'knowledge', 'knowledge_proposal', 'knowledge_revision', 'knowledge_evidence', 'knowledge_client', 'router_segment', 'router_context', 'front_desk', 'push',
    'trigger_rule', 'trigger_fire', 'trigger_cursor', 'trigger_key'],
  25: [...V4_TABLES.filter((table) => table !== 'router_session' && table !== 'decision'), 'account', 'machine', 'machine_login', 'login_state', 'machine_invite', 'machine_material', 'role',
    'knowledge', 'knowledge_proposal', 'knowledge_revision', 'knowledge_evidence', 'knowledge_client', 'router_segment', 'router_context', 'front_desk', 'push',
    'trigger_rule', 'trigger_fire', 'trigger_cursor', 'trigger_key'],
  26: [...V4_TABLES.filter((table) => table !== 'router_session' && table !== 'decision'), 'account', 'machine', 'machine_login', 'login_state', 'machine_invite', 'machine_material', 'role',
    'knowledge', 'knowledge_proposal', 'knowledge_revision', 'knowledge_evidence', 'knowledge_client', 'router_segment', 'router_context', 'front_desk', 'push',
    'trigger_rule', 'trigger_fire', 'trigger_cursor', 'trigger_key'],
  27: [...V4_TABLES.filter((table) => table !== 'router_session' && table !== 'decision'), 'account', 'machine', 'machine_login', 'login_state', 'machine_invite', 'machine_material', 'role',
    'knowledge', 'knowledge_proposal', 'knowledge_revision', 'knowledge_evidence', 'knowledge_client', 'router_segment', 'router_context', 'front_desk', 'push',
    'trigger_rule', 'trigger_fire', 'trigger_cursor', 'trigger_key', 'usage'],
  28: [...V4_TABLES.filter((table) => table !== 'router_session' && table !== 'decision'), 'account', 'machine', 'machine_login', 'login_state', 'machine_invite', 'machine_material', 'role',
    'knowledge', 'knowledge_proposal', 'knowledge_revision', 'knowledge_evidence', 'knowledge_client', 'router_segment', 'router_context', 'front_desk', 'push',
    'trigger_rule', 'trigger_fire', 'trigger_cursor', 'trigger_key', 'usage'],
  29: [...V4_TABLES.filter((table) => table !== 'router_session' && table !== 'decision'), 'account', 'machine', 'machine_login', 'login_state', 'machine_invite', 'machine_material', 'role',
    'knowledge', 'knowledge_proposal', 'knowledge_revision', 'knowledge_evidence', 'knowledge_client', 'router_segment', 'router_context', 'front_desk', 'push',
    'trigger_rule', 'trigger_fire', 'trigger_cursor', 'trigger_key', 'usage'],
  30: [...V4_TABLES.filter((table) => table !== 'router_session' && table !== 'decision'), 'account', 'machine', 'machine_login', 'login_state', 'machine_invite', 'machine_material', 'role',
    'knowledge', 'knowledge_proposal', 'knowledge_revision', 'knowledge_evidence', 'knowledge_client', 'router_segment', 'router_context', 'front_desk', 'push',
    'trigger_rule', 'trigger_fire', 'trigger_cursor', 'trigger_key', 'usage'],
  31: [...V4_TABLES.filter((table) => table !== 'router_session' && table !== 'decision'), 'account', 'machine', 'machine_login', 'login_state', 'machine_invite', 'machine_material', 'role',
    'knowledge', 'knowledge_proposal', 'knowledge_revision', 'knowledge_evidence', 'knowledge_client', 'router_segment', 'router_context', 'front_desk', 'push',
    'trigger_rule', 'trigger_fire', 'trigger_cursor', 'trigger_key', 'usage'],
  32: [...V4_TABLES.filter((table) => table !== 'router_session' && table !== 'decision'), 'account', 'machine', 'machine_login', 'login_state', 'machine_invite', 'machine_material', 'role',
    'knowledge', 'knowledge_proposal', 'knowledge_revision', 'knowledge_evidence', 'knowledge_client', 'router_segment', 'router_context', 'front_desk', 'push',
    'trigger_rule', 'trigger_fire', 'trigger_cursor', 'trigger_key', 'usage'],
  33: [...V4_TABLES.filter((table) => table !== 'router_session' && table !== 'decision'), 'account', 'machine', 'machine_login', 'login_state', 'machine_invite', 'machine_material', 'role',
    'knowledge', 'knowledge_proposal', 'knowledge_revision', 'knowledge_evidence', 'knowledge_client', 'router_segment', 'router_context', 'front_desk', 'push',
    'trigger_rule', 'trigger_fire', 'trigger_cursor', 'trigger_key', 'usage'],
  34: [...V4_TABLES.filter((table) => table !== 'router_session' && table !== 'decision'), 'account', 'machine', 'machine_login', 'login_state', 'machine_invite', 'machine_material', 'role',
    'knowledge', 'knowledge_proposal', 'knowledge_revision', 'knowledge_evidence', 'knowledge_client', 'router_segment', 'router_context', 'front_desk', 'push',
    'trigger_rule', 'trigger_fire', 'trigger_cursor', 'trigger_key', 'usage'],
  35: [...V4_TABLES.filter((table) => table !== 'router_session' && table !== 'decision'), 'account', 'machine', 'machine_login', 'login_state', 'machine_invite', 'machine_material', 'role',
    'knowledge', 'knowledge_proposal', 'knowledge_revision', 'knowledge_evidence', 'knowledge_client', 'router_segment', 'router_context', 'front_desk', 'push',
    'trigger_rule', 'trigger_fire', 'trigger_cursor', 'trigger_key', 'usage'],
  36: [...V4_TABLES.filter((table) => table !== 'router_session' && table !== 'decision'), 'account', 'machine', 'machine_login', 'login_state', 'machine_invite', 'machine_material', 'role',
    'knowledge', 'knowledge_proposal', 'knowledge_revision', 'knowledge_evidence', 'knowledge_client', 'router_segment', 'router_context', 'front_desk', 'push',
    'trigger_rule', 'trigger_fire', 'trigger_cursor', 'trigger_key', 'usage'],
  37: [...V4_TABLES.filter((table) => table !== 'router_session' && table !== 'decision'), 'account', 'machine', 'machine_login', 'login_state', 'machine_invite', 'machine_material', 'role',
    'knowledge', 'knowledge_proposal', 'knowledge_revision', 'knowledge_evidence', 'knowledge_client', 'router_segment', 'router_context', 'front_desk', 'push',
    'trigger_rule', 'trigger_fire', 'trigger_cursor', 'trigger_key', 'usage'],
  38: [...V4_TABLES.filter((table) => table !== 'router_session' && table !== 'decision'), 'account', 'machine', 'machine_login', 'login_state', 'machine_invite', 'machine_material', 'role',
    'knowledge', 'knowledge_proposal', 'knowledge_revision', 'knowledge_evidence', 'knowledge_client', 'router_segment', 'router_context', 'front_desk', 'push',
    'trigger_rule', 'trigger_fire', 'trigger_cursor', 'trigger_key', 'usage', 'work_cleanup'],
  39: [...V4_TABLES.filter((table) => table !== 'router_session' && table !== 'decision'), 'account', 'machine', 'machine_login', 'login_state', 'machine_invite', 'machine_material', 'role',
    'knowledge', 'knowledge_proposal', 'knowledge_revision', 'knowledge_evidence', 'knowledge_client', 'router_segment', 'router_context', 'front_desk', 'push',
    'trigger_rule', 'trigger_fire', 'trigger_cursor', 'trigger_key', 'usage', 'work_cleanup', 'machine_login_refusal'],
  40: [...V4_TABLES.filter((table) => table !== 'router_session' && table !== 'decision'), 'account', 'machine', 'machine_login', 'login_state', 'machine_invite', 'machine_material', 'role',
    'knowledge', 'knowledge_proposal', 'knowledge_revision', 'knowledge_evidence', 'knowledge_client', 'router_segment', 'router_context', 'front_desk', 'push',
    'trigger_rule', 'trigger_fire', 'trigger_cursor', 'inbound_source', 'inbound_key', 'usage', 'work_cleanup', 'machine_login_refusal'],
  41: [...V4_TABLES.filter((table) => table !== 'router_session' && table !== 'decision'), 'account', 'machine', 'machine_login', 'login_state', 'machine_invite', 'machine_material', 'role',
    'knowledge', 'knowledge_proposal', 'knowledge_revision', 'knowledge_evidence', 'knowledge_client', 'router_segment', 'router_context', 'front_desk', 'push',
    'trigger_rule', 'trigger_fire', 'trigger_cursor', 'inbound_source', 'inbound_key', 'usage', 'work_cleanup', 'machine_login_refusal'],
  42: [...V4_TABLES.filter((table) => table !== 'router_session' && table !== 'decision'), 'account', 'machine', 'machine_login', 'login_state', 'machine_invite', 'machine_material', 'role',
    'knowledge', 'knowledge_proposal', 'knowledge_revision', 'knowledge_evidence', 'knowledge_client', 'router_segment', 'router_context', 'front_desk', 'push',
    'trigger_rule', 'trigger_fire', 'trigger_cursor', 'inbound_source', 'inbound_key', 'usage', 'work_cleanup', 'machine_login_refusal', 'router_call', 'router_exchange', 'router_template', 'inbound_receipt_reply'],
  43: [...V4_TABLES.filter((table) => table !== 'router_session' && table !== 'decision'), 'account', 'machine', 'machine_login', 'login_state', 'machine_invite', 'machine_material', 'role',
    'knowledge', 'knowledge_proposal', 'knowledge_revision', 'knowledge_evidence', 'knowledge_client', 'router_segment', 'router_context', 'front_desk', 'push',
    'trigger_rule', 'trigger_fire', 'trigger_cursor', 'inbound_source', 'inbound_key', 'usage', 'work_cleanup', 'machine_login_refusal', 'router_call', 'router_exchange', 'router_template', 'inbound_receipt_reply'],
  44: [...V4_TABLES.filter((table) => table !== 'router_session' && table !== 'decision'), 'account', 'machine', 'machine_login', 'login_state', 'machine_invite', 'machine_material', 'role',
    'knowledge', 'knowledge_proposal', 'knowledge_revision', 'knowledge_evidence', 'knowledge_client', 'router_segment', 'router_context', 'front_desk', 'push',
    'trigger_rule', 'trigger_fire', 'trigger_cursor', 'inbound_source', 'inbound_key', 'usage', 'work_cleanup', 'machine_login_refusal', 'router_call', 'router_exchange', 'router_template', 'inbound_receipt_reply'],
  45: [...V4_TABLES.filter((table) => table !== 'router_session' && table !== 'decision'), 'account', 'machine', 'machine_login', 'login_state', 'machine_invite', 'machine_material', 'role',
    'knowledge', 'knowledge_proposal', 'knowledge_revision', 'knowledge_evidence', 'knowledge_client', 'router_segment', 'router_context', 'front_desk', 'push',
    'trigger_rule', 'trigger_fire', 'trigger_cursor', 'inbound_source', 'inbound_key', 'usage', 'work_cleanup', 'machine_login_refusal', 'router_call', 'router_exchange', 'router_template', 'inbound_receipt_reply', 'project_file', 'project_files_cleanup'],
  46: [...V4_TABLES.filter((table) => table !== 'router_session' && table !== 'decision'), 'account', 'machine', 'machine_login', 'login_state', 'machine_invite', 'machine_material', 'role',
    'knowledge', 'knowledge_proposal', 'knowledge_revision', 'knowledge_evidence', 'knowledge_client', 'router_segment', 'router_context', 'front_desk', 'push',
    'trigger_rule', 'trigger_fire', 'trigger_cursor', 'inbound_source', 'inbound_key', 'usage', 'work_cleanup', 'machine_login_refusal', 'router_call', 'router_exchange', 'router_template', 'inbound_receipt_reply', 'project_file', 'project_files_cleanup', 'im_group_binding', 'im_group_context'],
  47: [...V4_TABLES.filter((table) => table !== 'router_session' && table !== 'decision'), 'account', 'machine', 'machine_login', 'login_state', 'machine_invite', 'machine_material', 'role',
    'knowledge', 'knowledge_proposal', 'knowledge_revision', 'knowledge_evidence', 'knowledge_client', 'router_segment', 'router_context', 'front_desk', 'push',
    'trigger_rule', 'trigger_fire', 'trigger_cursor', 'inbound_source', 'inbound_key', 'usage', 'work_cleanup', 'machine_login_refusal', 'router_call', 'router_exchange', 'router_template', 'inbound_receipt_reply', 'project_file', 'project_files_cleanup', 'im_group_binding', 'im_group_context'],
  48: [...V4_TABLES.filter((table) => table !== 'router_session' && table !== 'decision'), 'account', 'machine', 'machine_login', 'login_state', 'machine_invite', 'machine_material', 'role',
    'knowledge', 'knowledge_proposal', 'knowledge_revision', 'knowledge_evidence', 'knowledge_client', 'router_segment', 'router_context', 'front_desk', 'push',
    'trigger_rule', 'trigger_fire', 'trigger_cursor', 'inbound_source', 'inbound_key', 'usage', 'work_cleanup', 'machine_login_refusal', 'router_call', 'router_exchange', 'router_template', 'inbound_receipt_reply', 'project_file', 'project_files_cleanup', 'im_group_binding', 'im_group_context'],
};

interface MigrationHooks {
  // Crash injection, on either side of the commit that ends the step from version `from`.
  beforeMigrationCommit?: (from: number) => void;
  afterMigrationCommit?: (from: number) => void;
}

export function nowIso(): string {
  return new Date().toISOString();
}

// The transaction's outcome is unknown, so the connection has been retired.
export class RollbackError extends Error {
  override name = 'RollbackError';

  constructor(original: unknown, rollback: unknown) {
    super(`回滚失败：${String(rollback)}；原错误：${String(original)}`, { cause: original });
  }
}

export interface DbHooks extends MigrationHooks {
  beforeRollback?: () => void;
  // Crash injection: each gets the change actions of the transaction ending there.
  beforeCommit?: (actions: string[]) => void;
  // `retire` closes the connection, which a crash test does on the line after COMMIT.
  afterCommit?: (actions: string[], retire: () => void) => void;
}

interface DbOptions {
  projectHome?: ProjectHome;
  // Restore seals a private staging file, replacing the live ledger only after
  // the ordinary service lock is held. The final live open still requires authority.
  sealRestore?: boolean;
  // Told where the copy kept before an upgrade is. Absent means stderr.
  log?: (line: string) => void;
  // False for a file that is itself a copy of a ledger kept elsewhere, as a restore's
  // working file is of its backup.
  copyBeforeUpgrade?: boolean;
}

export class Db {
  #path: string;
  #conn: DatabaseSync;
  #hooks: DbHooks;
  #options: DbOptions;
  #actions: string[] = [];
  #parts = 0;
  #committed = new Set<() => void>();
  #news = false;
  #projectHomeGuard?: ReturnType<typeof bindProjectHomeGuard>;

  constructor(path: string, readOnly: boolean, hooks: DbHooks = {}, options: DbOptions = {}) {
    this.#path = path;
    this.#hooks = hooks;
    this.#options = options;
    this.#conn = connect(path, readOnly, hooks, options);
    this.bindProjectHome(readOnly);
  }

  private bindProjectHome(readOnly: boolean): void {
    this.#projectHomeGuard = undefined;
    if (readOnly) return;
    try {
      const home = this.#options.projectHome;
      if (home) {
        this.#projectHomeGuard = bindProjectHomeGuard(this.#conn, home);
        return;
      }
      if (!this.#options.sealRestore && this.#conn.prepare("SELECT 1 FROM setting WHERE key GLOB ? LIMIT 1").get(PROJECT_HOME_KEY_PREFIX + '*')) {
        throw new Error('账本记录了项目归属，但本服务的归属数据库未启用或已丢失，停止写入。请在当前归属服务恢复账本，或在确认原服务已停止后一起迁移它最新的 project-home/authority.db');
      }
    } catch (error) {
      this.#conn.close();
      throw error;
    }
  }

  get isOpen(): boolean {
    return this.#conn.isOpen;
  }

  run(sql: string, ...params: SQLInputValue[]): void {
    try {
      this.#conn.prepare(sql).run(...params);
    } catch (error) {
      // SQLite replaces errors thrown by a SQL function with a generic error. Keep
      // the typed refusal and destination for the caller that can report them.
      throw this.#projectHomeGuard?.takeRefusal() ?? error;
    }
  }

  installProjectOwnership(projectId: string, ownership: ProjectOwnership): void {
    const home = this.#options.projectHome;
    if (!home || !this.#conn.isTransaction) throw new Error('不在项目账本安装事务内');
    home.assertInstall(projectId, ownership);
    this.run(`INSERT INTO setting (id, created_at, key, value_json) VALUES (?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`,
      ulid(), nowIso(), PROJECT_HOME_KEY_PREFIX + projectId, JSON.stringify(ownership),
    );
  }

  mayWriteProject(projectId: string | null): boolean {
    const home = this.#options.projectHome;
    if (!home || projectId === null) return true;
    const row = this.get<{ value_json: string }>('SELECT value_json FROM setting WHERE key = ?', PROJECT_HOME_KEY_PREFIX + projectId);
    return home.describe(projectId, row && JSON.parse(row.value_json) as ProjectOwnership).phase === 'owned';
  }

  get<T>(sql: string, ...params: SQLInputValue[]): T | undefined {
    return this.#conn.prepare(sql).get(...params) as T | undefined;
  }

  all<T>(sql: string, ...params: SQLInputValue[]): T[] {
    return this.#conn.prepare(sql).all(...params) as T[];
  }

  noteAction(action: string): void {
    this.#actions.push(action);
  }

  // Inside a transaction, a part that may fail on its own without taking the rest with it: what
  // it wrote is undone up to here and its error goes on. Outside one, a transaction of its own.
  savepoint<T>(fn: () => T): T {
    const conn = this.#conn;
    if (!conn.isTransaction) return this.transaction(fn);
    this.#parts += 1;
    const name = `part${this.#parts}`;
    conn.exec(`SAVEPOINT ${name}`);
    try {
      const result = fn();
      conn.exec(`RELEASE ${name}`);
      return result;
    } catch (err) {
      conn.exec(`ROLLBACK TO ${name}`);
      conn.exec(`RELEASE ${name}`);
      throw err;
    }
  }

  // A nested call joins the outer transaction, so an operation can reuse
  // another one and still commit or roll back as a whole.
  transaction<T>(fn: () => T): T {
    const conn = this.#conn;
    if (conn.isTransaction) return fn();
    const commit = (): T => {
      conn.exec('BEGIN IMMEDIATE');
      this.#actions = [];
      this.#news = false;
      try {
        const result = fn();
        this.#hooks.beforeCommit?.(this.#actions);
        conn.exec('COMMIT');
        return result;
      } catch (err) {
        // SQLite may already have rolled back on an IO error.
        if (conn.isTransaction) {
          try {
            this.#hooks.beforeRollback?.();
            conn.exec('ROLLBACK');
          } catch (rollbackErr) {
            // Left open, the next write would join this transaction and report
            // success without committing. Closing discards it.
            try {
              conn.close();
            } catch {}
            throw new RollbackError(err, rollbackErr);
          }
        }
        throw err;
      }
    };
    const home = this.#options.projectHome;
    const result = home ? home.guardLedgerTransaction(commit) : commit();
    this.#hooks.afterCommit?.(this.#actions, () => this.close());
    // Only a transaction that recorded a change, or wrote learned state a page shows, is news:
    // the rest of learned state (when a machine was last heard from, a Run's progress, when a
    // console session was last used) is written often and tells no page anything.
    if (this.#actions.length > 0 || this.#news) {
      for (const listener of this.#committed) {
        try {
          listener();
        } catch {}
      }
    }
    return result;
  }

  // Learned state a page shows was written: its commit is news, though it records no change.
  noteNews(): void {
    this.#news = true;
  }

  // Told after each committed transaction that is news. The answer stops it.
  onCommit(listener: () => void): () => void {
    this.#committed.add(listener);
    return () => this.#committed.delete(listener);
  }

  // A connection that hit an IO error can stay unusable after the disk is back.
  reopen(): void {
    if (this.#conn.isOpen) this.#conn.close();
    this.#conn = connect(this.#path, false, this.#hooks, this.#options);
    this.bindProjectHome(false);
  }

  close(): void {
    if (this.#conn.isOpen) this.#conn.close();
  }
}

// A ledger read while its writer is confirmed gone: `tycho doctor` with no service running,
// a release reading the ledger of a service it stopped or of a candidate that died. Nothing
// beside the file is written, created or reset. A plain read-only connection would do both:
// one that finds no other connection resets the -shm a crashed writer left (on Windows the
// reset fails with "disk I/O error" for a moment after that writer is seen gone, while the
// system is still unmapping the file from it), and one that finds no -shm creates a -shm
// and a -wal and leaves them. So: with a -shm (or -wal) there, readonly_shm reads the WAL as
// it is; with neither, every commit is in the file itself and immutable reads just that.
// Both drop SQLite's locks and read marks, which is sound only because nobody writes: a
// reader that may meet a live writer opens plainly (peekLedger's 'live', the backup).
// A -wal without its -shm is not something SQLite leaves; it fails here, and the caller
// reports the ledger as unreadable. A copy that must stand alone is verifySnapshot's.
export function openStoppedLedger(path: string): DatabaseSync {
  const url = pathToFileURL(path);
  if (existsSync(`${path}-shm`) || existsSync(`${path}-wal`)) url.searchParams.set('readonly_shm', '1');
  else url.searchParams.set('immutable', '1');
  return new DatabaseSync(url, { readOnly: true });
}

function connect(path: string, readOnly: boolean, hooks: MigrationHooks = {}, options: DbOptions = {}): DatabaseSync {
  const conn = readOnly ? openStoppedLedger(path) : new DatabaseSync(path);
  try {
    // First, because even the journal mode pragma writes to the file.
    const version = ledgerVersion(conn);
    if (version === undefined && readOnly) throw new Error(NO_TABLES);
    if (version !== undefined && version < SCHEMA_VERSION && readOnly) {
      throw new Error(`数据库 schema 版本 ${version} 比程序的 ${SCHEMA_VERSION} 旧，只读打开不能升级它`);
    }
    // Once for all the steps of this open, and before the pragmas: the ledger has not
    // been written to when its copy is taken, nor when taking it fails.
    if (version !== undefined && version < SCHEMA_VERSION && options.copyBeforeUpgrade !== false) {
      const copy = copyBeforeUpgrade(conn, path, version);
      (options.log ?? console.error)(`升级账本前留了一份副本：${copy}（版本 ${version}，要退回旧版本程序时用它）`);
    }
    // The writer's durability: a reader of a stopped ledger writes nothing, and an immutable
    // connection (no -wal beside the file) answers journal_mode as delete.
    if (!readOnly) applyDurability(conn);
    if (version === undefined) applySchema(conn);
    else migrate(conn, version, SCHEMA_VERSION, MIGRATIONS, hooks);
    return conn;
  } catch (err) {
    conn.close();
    throw err;
  }
}

const NO_TABLES = '数据库里没有任何表';

// Undefined only for a file with no tables at all, which a writer may take for a new
// ledger. applySchema is atomic, so tables without a version are not ours to build on.
// A version this program can bring forward comes back as it is. One from a newer
// program, or older than any step kept here, is refused before anything is written.
function ledgerVersion(conn: DatabaseSync): number | undefined {
  const stored = readSchemaVersion(conn);
  if (stored === undefined && !hasTables(conn)) return undefined;
  const version = stored !== undefined && /^\d+$/.test(stored) ? Number(stored) : undefined;
  if (version !== undefined && version >= OLDEST_VERSION && version <= SCHEMA_VERSION) return version;
  const why = version !== undefined && version > SCHEMA_VERSION ? '账本比程序新，请升级程序' : '这个版本不能直接升级';
  throw new Error(`数据库 schema 版本 ${stored} 与程序的 ${SCHEMA_VERSION} 不一致：${why}`);
}

// The ledger as it stands, beside itself, before the first step touches it: the program
// that wrote it refuses the upgraded one, so this file is the way back. VACUUM INTO,
// because every open is synchronous and SQLite's backup is not; it reads the commits
// still in the -wal and writes a file that stands alone. The file gets its name only
// once it verifies as a ledger of the old version and is on disk, since the step's
// commit must not outlive it in a power failure. A file already under that name is the
// same ledger at an earlier upgrade from this version, and gives way.
function copyBeforeUpgrade(conn: DatabaseSync, path: string, version: number): string {
  const copy = `${path.replace(/\.db$/, '')}.before-v${version + 1}.db`;
  const partial = `${copy}.partial`;
  try {
    // What an attempt that died left: VACUUM INTO refuses a file that is not empty.
    rmSync(partial, { force: true });
    conn.prepare('VACUUM INTO ?').run(partial);
    if (verifySnapshot(partial).get('schema_version') !== String(version)) throw new Error('副本的版本和账本对不上');
    const fd = openSync(partial, 'r+');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(partial, copy);
  } catch (err) {
    // So that a full disk gets its space back. The next attempt clears it in any case.
    try {
      rmSync(partial, { force: true });
    } catch {}
    throw new Error(
      `升级账本（版本 ${version} → ${SCHEMA_VERSION}）之前要先留一份副本，这次没留成，所以没有升级，账本没有动：${(err as Error).message}。` +
        `常见的原因是磁盘满了，或者运行服务的用户写不了 ${dirname(path)}：腾出磁盘空间、放开权限后再启动；一时解决不了就先用旧版本程序`,
      { cause: err },
    );
  }
  return copy;
}

// Step by step, each in its own transaction together with the version it leaves behind:
// a crash leaves the ledger at a version some step ended at, and the next open goes on
// from there. Nothing is written when there is nothing to do.
export function migrate(
  conn: DatabaseSync,
  from: number,
  to: number,
  steps: Record<number, Migration>,
  hooks: MigrationHooks = {},
): void {
  for (let version = from; version < to; version += 1) {
    const step = steps[version];
    if (!step) throw new Error(`没有从 schema 版本 ${version} 升级的步骤`);
    // The pragma does nothing inside a transaction, so it is set around the step.
    if (step.rebuilds) conn.exec('PRAGMA foreign_keys = OFF');
    try {
      conn.exec('BEGIN IMMEDIATE');
      try {
        step(conn);
        conn.prepare(`UPDATE setting SET value_json = ? WHERE key = 'schema_version'`).run(JSON.stringify(version + 1));
        hooks.beforeMigrationCommit?.(version);
        conn.exec('COMMIT');
      } catch (err) {
        if (conn.isTransaction) conn.exec('ROLLBACK');
        throw err;
      }
    } finally {
      if (step.rebuilds && conn.isOpen) conn.exec('PRAGMA foreign_keys = ON');
    }
    hooks.afterMigrationCommit?.(version);
  }
}

// A file judged as it stands before anyone relies on it: a backup's copy, what a restore
// was handed, or the copy kept before an upgrade. Nothing is created or migrated.
// integrity_check alone would call an empty file ok, and the version row alone would call
// any file that has one a ledger, so the tables of that version are asked for as well.
// A ledger of an older version this program can bring forward verifies too: a backup
// taken before an upgrade stays restorable, and the restore's own open migrates its
// working copy. Immutable, because a copy keeps the WAL flag of its source and a plain
// read-only connection would leave a -wal and -shm beside it; so the file has to stand
// alone, with none of its commits still in a -wal. Returns its setting rows by key.
export function verifySnapshot(path: string): Map<string, string> {
  const url = pathToFileURL(path);
  url.searchParams.set('immutable', '1');
  const conn = new DatabaseSync(url, { readOnly: true });
  try {
    let version;
    try {
      version = ledgerVersion(conn);
      if (version === undefined) throw new Error(NO_TABLES);
    } catch (err) {
      throw new Error(`不是 tycho 账本：${(err as Error).message}`);
    }
    const expected = LEDGER_TABLES[version];
    // Ours to fix, not the file's fault: a version was added without its list.
    if (!expected) throw new Error(`程序里没有 schema 版本 ${version} 的表清单`);
    const present = new Set(conn.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all().map(({ name }) => name));
    const missing = expected.filter((name) => !present.has(name));
    if (missing.length > 0) throw new Error(`不是 tycho 账本：缺少表 ${missing.join('、')}`);
    const [row] = conn.prepare('PRAGMA integrity_check').all();
    if (row?.integrity_check !== 'ok') throw new Error(`integrity_check：${String(row?.integrity_check)}`);
    const rows = conn.prepare('SELECT key, value_json FROM setting').all() as { key: string; value_json: string }[];
    return new Map(rows.map(({ key, value_json: value }) => [key, value]));
  } finally {
    conn.close();
  }
}

function applyDurability(conn: DatabaseSync): void {
  conn.exec('PRAGMA synchronous=FULL');
  const { journal_mode: mode } = conn.prepare('PRAGMA journal_mode=WAL').get() as { journal_mode: string };
  const { synchronous } = conn.prepare('PRAGMA synchronous').get() as { synchronous: number };
  if (mode !== 'wal') throw new Error(`journal_mode 应为 wal，实际是 ${mode}`);
  if (synchronous !== 2) throw new Error(`synchronous 应为 FULL(2)，实际是 ${synchronous}`);
}

function applySchema(conn: DatabaseSync): void {
  conn.exec('BEGIN IMMEDIATE');
  try {
    conn.exec(SCHEMA);
    seedRoles(conn);
    conn
      .prepare('INSERT INTO setting (id, created_at, key, value_json) VALUES (?, ?, ?, ?) ON CONFLICT (key) DO NOTHING')
      .run(ulid(), nowIso(), 'schema_version', JSON.stringify(SCHEMA_VERSION));
    conn.exec('COMMIT');
  } catch (err) {
    if (conn.isTransaction) conn.exec('ROLLBACK');
    throw err;
  }
}

function hasTables(conn: DatabaseSync): boolean {
  return conn.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' LIMIT 1`).get() !== undefined;
}

function readSchemaVersion(conn: DatabaseSync): string | undefined {
  if (!conn.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'setting'`).get()) return undefined;
  const row = conn.prepare(`SELECT value_json FROM setting WHERE key = 'schema_version'`).get() as
    | { value_json: string }
    | undefined;
  return row?.value_json;
}

export interface Ctx {
  actor: string;
  toolCallId?: string;
  messageId?: string;
  // Every message of the turn, the first one in front and the events taken with it after it. Set
  // where a turn's truth hangs on more than one message (a merged turn of internal events); a
  // single-message turn may leave it unset. `messageId` stays the first: changes hang on it.
  messageIds?: string[];
}

export function writeChange(
  db: Db,
  action: string,
  ctx: Ctx,
  refs: { taskId?: string; runId?: string } = {},
  detail?: unknown,
): void {
  const at = nowIso();
  db.noteAction(action);
  db.run(
    `INSERT INTO change (id, created_at, at, actor, message_id, task_id, run_id, action, detail_json, tool_call_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ulid(),
    at,
    at,
    ctx.actor,
    ctx.messageId ?? null,
    refs.taskId ?? null,
    refs.runId ?? null,
    action,
    detail === undefined ? null : JSON.stringify(detail),
    ctx.toolCallId ?? null,
  );
}
