-- Recorded version 7 schema, before account credential rejection.

CREATE TABLE IF NOT EXISTS project (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  name TEXT NOT NULL,
  repo TEXT,
  accounts_json TEXT NOT NULL DEFAULT '[]',
  machines_json TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS task (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES project(id),
  parent_id TEXT REFERENCES task(id),
  title TEXT NOT NULL,
  goal TEXT NOT NULL,
  scope TEXT,
  acceptance TEXT,
  revision INTEGER NOT NULL DEFAULT 1,
  account_id TEXT,
  tier TEXT,
  priority INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL,
  reason TEXT,
  wake_at TEXT,
  created_by TEXT NOT NULL,
  closed_at TEXT
);

CREATE TABLE IF NOT EXISTS run (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  task_id TEXT NOT NULL REFERENCES task(id),
  task_revision INTEGER NOT NULL,
  account_id TEXT NOT NULL,
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
  machine_id TEXT
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
  UNIQUE (channel, external_id)
);

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
  decided_at TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS approval_one_open ON approval(task_id) WHERE state = 'open';

CREATE TABLE IF NOT EXISTS decision (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  task_id TEXT REFERENCES task(id),
  scope_json TEXT,
  text TEXT NOT NULL,
  at TEXT NOT NULL
);

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

CREATE TABLE IF NOT EXISTS router_session (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  session_ref TEXT,
  pid INTEGER,
  marker TEXT NOT NULL,
  state TEXT NOT NULL,
  last_turn_at TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS router_session_one_open ON router_session(state) WHERE state = 'open';

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
  detail_json TEXT
);

CREATE TABLE IF NOT EXISTS setting (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  key TEXT NOT NULL UNIQUE,
  value_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS account (
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

CREATE TABLE IF NOT EXISTS machine (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  host TEXT NOT NULL,
  ssh_config TEXT,
  note TEXT
);

CREATE TABLE IF NOT EXISTS account_state (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  rest_seq INTEGER,
  rest_until TEXT,
  rest_streak INTEGER NOT NULL DEFAULT 0,
  rest_reason TEXT,
  usage_json TEXT NOT NULL DEFAULT '{}'
);
