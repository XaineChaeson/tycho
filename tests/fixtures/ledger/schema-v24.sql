-- Recorded version 24 schema, as the program wrote a new ledger.
-- Input to the version 25 identity migration.
CREATE TABLE project (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  name TEXT NOT NULL,
  repo TEXT,
  logins_json TEXT NOT NULL DEFAULT '[]',
  -- The machines it may run on, by machine.uid; empty is any machine.
  machines_json TEXT NOT NULL DEFAULT '[]',
  code_dir TEXT,
  spawn_machines INTEGER NOT NULL DEFAULT 0,
  login_mode TEXT NOT NULL DEFAULT 'selected'
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
  skills_json TEXT
);

CREATE TABLE run (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  task_id TEXT NOT NULL REFERENCES task(id),
  task_revision INTEGER NOT NULL,
  login_id TEXT NOT NULL,
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
);

CREATE UNIQUE INDEX run_one_active ON run(task_id) WHERE state != 'ended';

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
  UNIQUE (channel, external_id)
);

CREATE INDEX message_by_project ON message(project_id, state);

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

CREATE UNIQUE INDEX approval_one_open ON approval(task_id) WHERE state = 'open';

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
  alerted_at TEXT
);

CREATE INDEX trigger_rule_by_project ON trigger_rule(project_id);

CREATE TABLE trigger_key (
  id TEXT PRIMARY KEY,
  trigger_id TEXT NOT NULL REFERENCES trigger_rule(id),
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  retires_at TEXT
);

CREATE INDEX trigger_key_by_trigger ON trigger_key(trigger_id);

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
  detail_json TEXT
);

CREATE TABLE setting (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  key TEXT NOT NULL UNIQUE,
  value_json TEXT NOT NULL
);

CREATE TABLE account (
  id TEXT PRIMARY KEY,
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

CREATE UNIQUE INDEX machine_one_uid ON machine(uid);

CREATE UNIQUE INDEX machine_one_node ON machine(node_id);

CREATE UNIQUE INDEX machine_one_token ON machine(token_hash) WHERE token_hash IS NOT NULL;

CREATE UNIQUE INDEX machine_one_claim ON machine(claim_hash) WHERE claim_hash IS NOT NULL;

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

CREATE INDEX machine_material_by_invite ON machine_material(invite_id);

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
  auth_failed_at TEXT
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
