import { DatabaseSync } from 'node:sqlite';

// Each entry moves the database up one version (PRAGMA user_version).
// Never edit a shipped migration; append a new one.
const MIGRATIONS: string[] = [
  `
  CREATE TABLE companies (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    careers_url TEXT,
    ats TEXT,
    board_token TEXT,
    company_type TEXT,
    last_checked_at TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );

  CREATE TABLE jobs (
    id INTEGER PRIMARY KEY,
    source TEXT NOT NULL,
    source_id TEXT NOT NULL,
    company_id INTEGER REFERENCES companies(id),
    company_name TEXT NOT NULL,
    title TEXT NOT NULL,
    location TEXT,
    experience_min REAL,
    experience_max REAL,
    skills TEXT NOT NULL DEFAULT '[]',
    description TEXT,
    url TEXT,
    posted_at TEXT,
    first_seen_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
    fingerprint TEXT NOT NULL,
    UNIQUE (source, source_id)
  );
  CREATE INDEX jobs_fingerprint ON jobs (fingerprint);

  CREATE TABLE scores (
    id INTEGER PRIMARY KEY,
    job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    profile_hash TEXT NOT NULL,
    total REAL NOT NULL,
    parts TEXT NOT NULL DEFAULT '{}',
    fit_notes TEXT,
    gaps TEXT NOT NULL DEFAULT '[]',
    scored_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    UNIQUE (job_id, profile_hash)
  );

  CREATE TABLE resume_versions (
    id INTEGER PRIMARY KEY,
    file_hash TEXT NOT NULL UNIQUE,
    profile_hash TEXT NOT NULL,
    block_ids TEXT NOT NULL DEFAULT '[]',
    model TEXT,
    prompt_version TEXT,
    path TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );

  CREATE TABLE applications (
    id INTEGER PRIMARY KEY,
    job_id INTEGER NOT NULL REFERENCES jobs(id),
    stage TEXT NOT NULL CHECK (stage IN
      ('drafted', 'applied', 'call', 'screening', 'interview', 'offer', 'rejected', 'no_reply', 'withdrawn')),
    channel TEXT NOT NULL,
    resume_version_id INTEGER REFERENCES resume_versions(id),
    applied_at TEXT,
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    offered_ctc_lpa REAL,
    -- Learning-loop features, saved at apply time.
    role_match TEXT,
    seniority_match TEXT,
    company_type TEXT,
    skill_overlap REAL,
    days_since_posting INTEGER,
    location TEXT
  );
  CREATE INDEX applications_job ON applications (job_id);

  CREATE TABLE ratings (
    id INTEGER PRIMARY KEY,
    job_id INTEGER NOT NULL REFERENCES jobs(id),
    verdict TEXT NOT NULL CHECK (verdict IN ('good', 'bad')),
    rated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );

  CREATE TABLE interviews (
    id INTEGER PRIMARY KEY,
    application_id INTEGER NOT NULL REFERENCES applications(id),
    held_on TEXT NOT NULL,
    round_type TEXT NOT NULL,
    questions TEXT NOT NULL DEFAULT '[]',
    rating INTEGER CHECK (rating BETWEEN 1 AND 5),
    notes TEXT
  );

  CREATE TABLE events (
    id INTEGER PRIMARY KEY,
    at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    kind TEXT NOT NULL,
    job_id INTEGER,
    application_id INTEGER,
    data TEXT NOT NULL DEFAULT '{}'
  );
  CREATE TRIGGER events_no_update BEFORE UPDATE ON events
    BEGIN SELECT RAISE(ABORT, 'events is append-only'); END;
  CREATE TRIGGER events_no_delete BEFORE DELETE ON events
    BEGIN SELECT RAISE(ABORT, 'events is append-only'); END;
  `,
  `
  -- Instruction-like lines the posting guard found, shown to the user.
  ALTER TABLE jobs ADD COLUMN guard_flags TEXT NOT NULL DEFAULT '[]';
  CREATE INDEX jobs_company ON jobs (company_id, source, status);
  `,
];

export const SCHEMA_VERSION = MIGRATIONS.length;

export function schemaVersion(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number };
  return row.user_version;
}

export function openDb(path: string, { migrate = true } = {}): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
  if (migrate) migrateDb(db);
  return db;
}

export function migrateDb(db: DatabaseSync): void {
  const current = schemaVersion(db);
  if (current > SCHEMA_VERSION) {
    throw new Error(`database is at version ${current}, newer than this offerstar (${SCHEMA_VERSION}); update offerstar`);
  }
  for (let v = current; v < SCHEMA_VERSION; v++) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[v]!);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
}
