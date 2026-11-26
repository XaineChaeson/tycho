CREATE TABLE project (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  name TEXT NOT NULL,
  repo TEXT,
  allowed_targets_json TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE task (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES project(id),
  parent_id TEXT REFERENCES task(id),
  title TEXT NOT NULL,
  goal TEXT NOT NULL,
  scope TEXT,
  acceptance TEXT,
  revision INTEGER NOT NULL DEFAULT 1,
  target_id TEXT,
  tier TEXT,
  priority INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL,
  reason TEXT,
  wake_at TEXT,
  created_by TEXT NOT NULL,
  closed_at TEXT
);

CREATE TABLE run (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  task_id TEXT NOT NULL REFERENCES task(id),
  task_revision INTEGER NOT NULL,
  target_id TEXT NOT NULL,
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
  last_progress_at TEXT
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
  UNIQUE (channel, external_id)
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
  decided_at TEXT
);

CREATE UNIQUE INDEX approval_one_open ON approval(task_id) WHERE state = 'open';

CREATE TABLE decision (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  task_id TEXT REFERENCES task(id),
  scope_json TEXT,
  text TEXT NOT NULL,
  at TEXT NOT NULL
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

CREATE TABLE router_session (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  session_ref TEXT,
  pid INTEGER,
  marker TEXT NOT NULL,
  state TEXT NOT NULL,
  last_turn_at TEXT
);

CREATE UNIQUE INDEX router_session_one_open ON router_session(state) WHERE state = 'open';

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
