CREATE TABLE account (
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

CREATE TABLE approval (
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

CREATE TABLE change (
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

CREATE TABLE im_group_binding (
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

CREATE TABLE im_group_context (
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

CREATE TABLE inbound_key (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES inbound_source(id),
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  retires_at TEXT
);

CREATE TABLE inbound_receipt_reply (
  fire_id TEXT PRIMARY KEY REFERENCES trigger_fire(id) ON DELETE CASCADE,
  text TEXT
);

CREATE TABLE inbound_source (
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

CREATE TABLE input (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  task_id TEXT NOT NULL REFERENCES task(id),
  text TEXT NOT NULL,
  actor TEXT NOT NULL,
  message_id TEXT REFERENCES message(id),
  state TEXT NOT NULL,
  run_id TEXT REFERENCES run(id)
);

CREATE TABLE knowledge (
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

CREATE TABLE knowledge_client (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  name TEXT NOT NULL,
  executor TEXT NOT NULL,
  grants_json TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  revoked_at TEXT
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

CREATE TABLE login_state (
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

CREATE TABLE machine (
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

CREATE TABLE machine_login (
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

CREATE TABLE machine_login_refusal (
  machine_uid TEXT NOT NULL,
  executor TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (machine_uid, executor)
);

CREATE TABLE machine_material (
  hash TEXT PRIMARY KEY,
  invite_id TEXT NOT NULL REFERENCES machine_invite(id),
  run_id TEXT NOT NULL,
  handed_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT
);

CREATE TABLE message (
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

CREATE TABLE outbox (
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

CREATE TABLE project (
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
  grants_json TEXT NOT NULL DEFAULT '["accept"]',
  -- When the owner archived it; null while it is in sight (project-sessions, "项目的生命周期").
  archived_at TEXT,
  -- Where its code comes from, in order, the first being the default (docs/design/code-sources.md;
  -- shared/sources.ts Source).
  sources_json TEXT NOT NULL DEFAULT '[]',
  router_account TEXT,
  router_tier TEXT CHECK (router_tier IS NULL OR router_tier IN ('operate', 'execute', 'decide')),
  dispatch_order_json TEXT
);

CREATE TABLE project_file (
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

CREATE TABLE project_files_cleanup (
  project_id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  project_name TEXT NOT NULL,
  dropped_at TEXT
);

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

CREATE TABLE role (
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

CREATE TABLE router_call (
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

CREATE TABLE router_exchange (
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

CREATE TABLE router_segment (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES project(id),
  seq INTEGER NOT NULL,
  state TEXT NOT NULL,
  closed_at TEXT,
  UNIQUE (project_id, seq)
);

CREATE TABLE router_template (
  hash TEXT PRIMARY KEY,
  text TEXT NOT NULL
);

CREATE TABLE run (
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

CREATE TABLE setting (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  key TEXT NOT NULL UNIQUE,
  value_json TEXT NOT NULL
);

CREATE TABLE task (
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

CREATE TABLE trigger_cursor (
  trigger_id TEXT PRIMARY KEY REFERENCES trigger_rule(id),
  done_at TEXT NOT NULL
);

CREATE TABLE trigger_fire (
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
  rejected_reason TEXT,
  streak_reason TEXT,
  streak_count INTEGER NOT NULL DEFAULT 0,
  problem_since TEXT,
  alerted_at TEXT,
  broadcast_groups INTEGER NOT NULL DEFAULT 0,
  broadcast_group_ids_json TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE usage (
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

CREATE TABLE work_cleanup (
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

CREATE UNIQUE INDEX approval_one_open ON approval(task_id) WHERE state = 'open';

CREATE INDEX change_tool_call ON change(tool_call_id) WHERE tool_call_id IS NOT NULL;

CREATE INDEX im_group_binding_by_project ON im_group_binding(project_id);

CREATE INDEX im_group_context_by_chat ON im_group_context(channel, chat_id, created_at DESC, id DESC);

CREATE INDEX im_group_context_by_msg ON im_group_context(message_id);

CREATE INDEX inbound_key_by_source ON inbound_key(source_id);

CREATE INDEX knowledge_evidence_by_proposal ON knowledge_evidence(proposal_id);

CREATE UNIQUE INDEX knowledge_proposal_request ON knowledge_proposal(client_id, request_id) WHERE request_id IS NOT NULL;

CREATE INDEX machine_material_by_invite ON machine_material(invite_id);

CREATE UNIQUE INDEX machine_one_claim ON machine(claim_hash) WHERE claim_hash IS NOT NULL;

CREATE UNIQUE INDEX machine_one_node ON machine(node_id);

CREATE UNIQUE INDEX machine_one_token ON machine(token_hash) WHERE token_hash IS NOT NULL;

CREATE UNIQUE INDEX machine_one_uid ON machine(uid);

CREATE INDEX message_by_project ON message(project_id, state);

CREATE INDEX project_file_by_project ON project_file(project_id, updated_at DESC);

CREATE INDEX project_files_cleanup_pending ON project_files_cleanup(dropped_at);

CREATE INDEX push_open ON push(state, level);

CREATE INDEX router_call_message ON router_call(message_id, id);

CREATE UNIQUE INDEX router_call_operation ON router_call(project_id, operation_key) WHERE operation_key IS NOT NULL;

CREATE UNIQUE INDEX router_context_one_open ON router_context(project_id) WHERE state = 'open';

CREATE INDEX router_exchange_context ON router_exchange(context_id);

CREATE INDEX router_exchange_message ON router_exchange(message_id, id);

CREATE UNIQUE INDEX router_segment_one_current ON router_segment(project_id) WHERE state = 'current';

CREATE UNIQUE INDEX run_one_active ON run(task_id) WHERE state != 'ended';

CREATE INDEX trigger_fire_by_message ON trigger_fire(message_id);

CREATE INDEX trigger_fire_by_source ON trigger_fire(source_id);

CREATE INDEX trigger_fire_by_time ON trigger_fire(created_at);

CREATE UNIQUE INDEX trigger_fire_rule_identity ON trigger_fire(trigger_id, event_id) WHERE released_at IS NULL AND trigger_id IS NOT NULL;

CREATE UNIQUE INDEX trigger_fire_source_identity ON trigger_fire(source_id, project_id, event_id) WHERE released_at IS NULL AND source_id IS NOT NULL;

CREATE INDEX trigger_rule_by_project ON trigger_rule(project_id);

CREATE INDEX usage_at ON usage(at);

CREATE INDEX usage_run ON usage(run_id) WHERE run_id IS NOT NULL;

CREATE INDEX work_cleanup_by_run ON work_cleanup(run_id);

CREATE INDEX work_cleanup_pending ON work_cleanup(releases_dropped_at, code_dropped_at);
