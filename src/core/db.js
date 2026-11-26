import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const MIGRATIONS = [
  {
    version: 1,
    sql: `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS prompts (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS prompt_variants (
  id TEXT PRIMARY KEY,
  prompt_id TEXT NOT NULL REFERENCES prompts(id),
  label TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(prompt_id, label)
);
CREATE TABLE IF NOT EXISTS prompt_versions (
  id TEXT PRIMARY KEY,
  variant_id TEXT NOT NULL REFERENCES prompt_variants(id),
  version_number INTEGER NOT NULL,
  content TEXT NOT NULL,
  variables_json TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(variant_id, version_number)
);
CREATE TABLE IF NOT EXISTS cases (
  id TEXT PRIMARY KEY,
  content_hash TEXT NOT NULL UNIQUE,
  input_json TEXT NOT NULL,
  expected_json TEXT,
  meta_json TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS test_sets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS test_set_versions (
  id TEXT PRIMARY KEY,
  test_set_id TEXT NOT NULL REFERENCES test_sets(id),
  version_number INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  case_count INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(test_set_id, version_number)
);
CREATE TABLE IF NOT EXISTS test_set_cases (
  test_set_version_id TEXT NOT NULL REFERENCES test_set_versions(id),
  case_id TEXT NOT NULL REFERENCES cases(id),
  position INTEGER NOT NULL,
  PRIMARY KEY(test_set_version_id, case_id)
);
CREATE TABLE IF NOT EXISTS model_profiles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  provider_type TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS model_config_versions (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES model_profiles(id),
  version_number INTEGER NOT NULL,
  model_id TEXT NOT NULL,
  base_url TEXT,
  credential_ref TEXT,
  params_json TEXT NOT NULL,
  pricing_json TEXT,
  content_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(profile_id, version_number)
);
CREATE TABLE IF NOT EXISTS evaluation_profiles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS evaluation_profile_versions (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES evaluation_profiles(id),
  version_number INTEGER NOT NULL,
  config_json TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(profile_id, version_number)
);
CREATE TABLE IF NOT EXISTS snapshots (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  object_ref TEXT NOT NULL,
  spec_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  snapshot_id TEXT NOT NULL REFERENCES snapshots(id),
  snapshot_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  parent_run_id TEXT,
  stop_reason TEXT,
  request_hash TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS trials (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  variant_version_id TEXT NOT NULL,
  case_version_id TEXT NOT NULL,
  model_config_version_id TEXT NOT NULL,
  repetition_index INTEGER NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  trial_status TEXT NOT NULL,
  output_validity TEXT NOT NULL,
  evaluation_status TEXT NOT NULL,
  comparison_eligible INTEGER NOT NULL,
  ineligibility_reasons_json TEXT NOT NULL,
  truncated INTEGER NOT NULL DEFAULT 0,
  output_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_trials_run ON trials(run_id);
CREATE TABLE IF NOT EXISTS attempts (
  id TEXT PRIMARY KEY,
  trial_id TEXT NOT NULL REFERENCES trials(id),
  attempt_number INTEGER NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  original_model_config_version_id TEXT NOT NULL,
  actual_model_config_version_id TEXT NOT NULL,
  original_model_id TEXT NOT NULL,
  actual_model_id TEXT NOT NULL,
  fallback_used INTEGER NOT NULL,
  cross_model_substitution INTEGER NOT NULL,
  billing_state TEXT NOT NULL,
  response_ref TEXT,
  normalized_usage_json TEXT,
  error_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_attempts_trial ON attempts(trial_id);
CREATE TABLE IF NOT EXISTS evaluation_versions (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  profile_version_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS evaluations (
  id TEXT PRIMARY KEY,
  trial_id TEXT NOT NULL REFERENCES trials(id),
  evaluation_version_id TEXT NOT NULL,
  status TEXT NOT NULL,
  scores_json TEXT,
  overall_score REAL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_evaluations_trial ON evaluations(trial_id);
CREATE TABLE IF NOT EXISTS reports (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  template_version_id TEXT NOT NULL,
  snapshot_hash TEXT NOT NULL,
  evaluation_version_ids_json TEXT NOT NULL,
  format TEXT NOT NULL,
  language TEXT NOT NULL,
  status TEXT NOT NULL,
  content_hash TEXT,
  path TEXT,
  generated_at TEXT NOT NULL,
  evidence_state TEXT,
  redactions_json TEXT,
  error_json TEXT,
  template_json TEXT
);
CREATE TABLE IF NOT EXISTS run_events (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  type TEXT NOT NULL,
  payload_json TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(run_id, seq)
);
CREATE TABLE IF NOT EXISTS idempotency (
  key TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  actor TEXT,
  payload_json TEXT,
  created_at TEXT NOT NULL
);
`,
  },
  {
    version: 2,
    sql: `
CREATE TABLE IF NOT EXISTS experiment_drafts (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  name TEXT,
  step INTEGER NOT NULL DEFAULT 1,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_drafts_project ON experiment_drafts(project_id, updated_at);
CREATE TABLE IF NOT EXISTS import_previews (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  set_name TEXT,
  format TEXT NOT NULL,
  mapping_json TEXT,
  records_json TEXT NOT NULL,
  errors_json TEXT NOT NULL,
  columns_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_previews_project ON import_previews(project_id, created_at);
`,
  },
  {
    version: 3,
    sql: `
CREATE TABLE IF NOT EXISTS test_set_origins (
  test_set_version_id TEXT PRIMARY KEY,
  library_id TEXT NOT NULL,
  library_version INTEGER NOT NULL,
  source_project_id TEXT,
  source_project_name TEXT,
  source_test_set_version_id TEXT,
  license TEXT,
  sensitive INTEGER NOT NULL DEFAULT 0,
  imported_at TEXT NOT NULL
);
`,
  },
  {
    version: 4,
    sql: `
CREATE TABLE IF NOT EXISTS dialogue_turns (
  id TEXT PRIMARY KEY,
  trial_id TEXT NOT NULL REFERENCES trials(id),
  round INTEGER NOT NULL,
  role TEXT NOT NULL,
  model_config_version_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  content TEXT NOT NULL,
  usage_json TEXT,
  termination_reason TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_dialogue_turns_trial ON dialogue_turns(trial_id, round, id);
`,
  },
  {
    version: 5,
    sql: `
CREATE TABLE IF NOT EXISTS prompt_suggestions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  prompt_version_id TEXT NOT NULL,
  model_config_version_id TEXT NOT NULL,
  status TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_prompt_suggestions_run ON prompt_suggestions(run_id, created_at);
CREATE INDEX IF NOT EXISTS idx_prompt_suggestions_prompt ON prompt_suggestions(prompt_version_id, created_at);
`,
  },
];

export function openDatabase(dbPath) {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');
  migrate(db);
  return db;
}

function migrate(db) {
  const current = db.prepare('PRAGMA user_version').get().user_version ?? 0;
  for (const migration of MIGRATIONS) {
    if (migration.version <= current) continue;
    db.exec('BEGIN');
    try {
      db.exec(migration.sql);
      db.exec(`PRAGMA user_version = ${migration.version}`);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
}

export function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* 忽略回滚失败，保留原始错误 */
    }
    throw error;
  }
}

export function getMeta(db, key) {
  return db.prepare('SELECT value FROM meta WHERE key = ?').get(key)?.value ?? null;
}

export function setMeta(db, key, value) {
  db.prepare('INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(
    key,
    String(value),
  );
}

export function integrityCheck(db) {
  try {
    const rows = db.prepare('PRAGMA integrity_check').all();
    return rows.map((row) => Object.values(row)[0]);
  } catch (error) {
    return [`error: ${error.message}`];
  }
}
