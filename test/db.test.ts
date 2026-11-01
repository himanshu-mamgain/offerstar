import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openDb, SCHEMA_VERSION, schemaVersion } from '../src/db.ts';
import { tempPaths } from './helpers.ts';

test('migrations create every table and set the version', async () => {
  const { db: path } = await tempPaths();
  const db = openDb(path);
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[]).map((r) => r.name);

  assert.deepEqual(tables, ['applications', 'companies', 'events', 'interviews', 'jobs', 'ratings', 'resume_versions', 'scores']);
  assert.equal(schemaVersion(db), SCHEMA_VERSION);
  db.close();

  // Reopening runs no migration twice.
  const again = openDb(path);
  assert.equal(schemaVersion(again), SCHEMA_VERSION);
  again.close();
});

test('events are append-only', async () => {
  const { db: path } = await tempPaths();
  const db = openDb(path);
  db.prepare("INSERT INTO events (kind) VALUES ('scan')").run();

  assert.throws(() => db.prepare("UPDATE events SET kind = 'other'").run(), /append-only/);
  assert.throws(() => db.prepare('DELETE FROM events').run(), /append-only/);
  db.close();
});

test('stages and ratings are constrained', async () => {
  const { db: path } = await tempPaths();
  const db = openDb(path);
  db.prepare(
    "INSERT INTO jobs (source, source_id, company_name, title, first_seen_at, last_seen_at, fingerprint) VALUES ('greenhouse', '1', 'Acme', 'Engineer', 'now', 'now', 'f')",
  ).run();

  assert.throws(() => db.prepare("INSERT INTO applications (job_id, stage, channel) VALUES (1, 'ghosted', 'career-page')").run(), /CHECK/);
  assert.throws(() => db.prepare("INSERT INTO ratings (job_id, verdict) VALUES (1, 'maybe')").run(), /CHECK/);
  assert.throws(() => db.prepare("INSERT INTO applications (job_id, stage, channel) VALUES (99, 'applied', 'naukri')").run(), /FOREIGN KEY/);
  db.close();
});
