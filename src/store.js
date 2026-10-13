// All database access lives in this file. SQLite through the node:sqlite module that
// ships with Node.js - no native dependency, one file on the data volume, and it can
// be backed up while the service runs (sqlite3 .backup).

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ValidationError } from './sites.js';

// AUTOINCREMENT: an id is never handed out twice, so a new site cannot inherit the
// statistics of a deleted one.
const MIGRATIONS = [
  `CREATE TABLE site (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     name TEXT NOT NULL UNIQUE,
     recipient TEXT,
     subject_prefix TEXT NOT NULL DEFAULT '',
     success_url TEXT,
     error_url TEXT,
     submit_per_hour INTEGER NOT NULL DEFAULT 200,
     enabled INTEGER NOT NULL DEFAULT 1,
     note TEXT NOT NULL DEFAULT '',
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   );
   CREATE TABLE site_origin (
     origin TEXT PRIMARY KEY,
     site_id INTEGER NOT NULL REFERENCES site(id) ON DELETE CASCADE
   );
   CREATE INDEX site_origin_site ON site_origin(site_id);
   CREATE TABLE used_challenge (
     nonce TEXT PRIMARY KEY,
     expires_at INTEGER NOT NULL
   ) WITHOUT ROWID;
   CREATE INDEX used_challenge_expires ON used_challenge(expires_at);
   CREATE TABLE stat (
     hour INTEGER NOT NULL,
     site_id INTEGER NOT NULL,
     event TEXT NOT NULL,
     count INTEGER NOT NULL,
     PRIMARY KEY (hour, site_id, event)
   ) WITHOUT ROWID;
   CREATE INDEX stat_site ON stat(site_id, hour);`,
  // the newsletter list behind /subscribe - all three set or none
  `ALTER TABLE site ADD COLUMN subscribe_url TEXT;
   ALTER TABLE site ADD COLUMN subscribe_workspace TEXT;
   ALTER TABLE site ADD COLUMN subscribe_lists TEXT;`,
  // other lists for the language a sign-up comes with, as JSON - NULL without a list
  `ALTER TABLE site ADD COLUMN subscribe_language_lists TEXT;`,
];

// site_id 0 in `stat` stands for a request that matched no site
export const NO_SITE = 0;

function migrate(db) {
  const current = db.prepare('PRAGMA user_version').get().user_version;
  if (current > MIGRATIONS.length) {
    throw new Error(`database schema ${current} is newer than this version of the service (${MIGRATIONS.length}) - refusing to start`);
  }
  for (let version = current; version < MIGRATIONS.length; version++) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[version]);
      db.exec(`PRAGMA user_version = ${version + 1}`);
      db.exec('COMMIT');
    }
    catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
}

function toSite(row, origins) {
  return {
    id: row.id,
    name: row.name,
    origins,
    recipient: row.recipient,
    subscription: row.subscribe_url === null
      ? null
      : {
        url: row.subscribe_url,
        workspaceId: row.subscribe_workspace,
        listIds: row.subscribe_lists.split(','),
        languageLists: JSON.parse(row.subscribe_language_lists ?? '{}'),
      },
    subjectPrefix: row.subject_prefix,
    successUrl: row.success_url,
    errorUrl: row.error_url,
    submitPerHour: row.submit_per_hour,
    enabled: row.enabled === 1,
    note: row.note,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class Store {
  #db;
  #statements;

  constructor(dataDir) {
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      this.#db = new DatabaseSync(path.join(dataDir, 'altcha.db'), { timeout: 5000 });
    }
    catch (e) {
      throw new Error(`cannot open the database in ${dataDir} - the directory has to be writable for the user the service runs as (${e.message})`);
    }
    this.#db.exec('PRAGMA journal_mode = WAL');
    this.#db.exec('PRAGMA synchronous = NORMAL');
    this.#db.exec('PRAGMA foreign_keys = ON');
    // temporary tables in memory, so the container's file system can stay read-only
    this.#db.exec('PRAGMA temp_store = MEMORY');
    migrate(this.#db);

    const db = this.#db;
    this.#statements = {
      sites: db.prepare('SELECT * FROM site ORDER BY name'),
      site: db.prepare('SELECT * FROM site WHERE id = ?'),
      siteByName: db.prepare('SELECT * FROM site WHERE name = ?'),
      siteByOrigin: db.prepare('SELECT s.* FROM site s JOIN site_origin o ON o.site_id = s.id WHERE o.origin = ?'),
      origins: db.prepare('SELECT origin FROM site_origin WHERE site_id = ? ORDER BY origin'),
      allOrigins: db.prepare('SELECT origin, site_id FROM site_origin ORDER BY origin'),
      originOwner: db.prepare('SELECT s.name FROM site_origin o JOIN site s ON s.id = o.site_id WHERE o.origin = ? AND o.site_id <> ?'),
      insertSite: db.prepare(`INSERT INTO site (name, recipient, subscribe_url, subscribe_workspace, subscribe_lists, subscribe_language_lists, subject_prefix,
                                                success_url, error_url, submit_per_hour, enabled, note, created_at, updated_at)
                              VALUES (:name, :recipient, :subscribeUrl, :subscribeWorkspace, :subscribeLists, :subscribeLanguageLists, :subjectPrefix,
                                      :successUrl, :errorUrl, :submitPerHour, :enabled, :note, :now, :now)`),
      updateSite: db.prepare(`UPDATE site SET name = :name, recipient = :recipient, subscribe_url = :subscribeUrl, subscribe_workspace = :subscribeWorkspace,
                              subscribe_lists = :subscribeLists, subscribe_language_lists = :subscribeLanguageLists, subject_prefix = :subjectPrefix,
                              success_url = :successUrl, error_url = :errorUrl,
                              submit_per_hour = :submitPerHour, enabled = :enabled, note = :note, updated_at = :now
                              WHERE id = :id`),
      deleteSite: db.prepare('DELETE FROM site WHERE id = ?'),
      deleteOrigins: db.prepare('DELETE FROM site_origin WHERE site_id = ?'),
      insertOrigin: db.prepare('INSERT INTO site_origin (origin, site_id) VALUES (?, ?)'),
      markUsed: db.prepare('INSERT OR IGNORE INTO used_challenge (nonce, expires_at) VALUES (?, ?)'),
      purgeUsed: db.prepare('DELETE FROM used_challenge WHERE expires_at < ?'),
      countUsed: db.prepare('SELECT COUNT(*) AS n FROM used_challenge'),
      addStat: db.prepare(`INSERT INTO stat (hour, site_id, event, count) VALUES (?, ?, ?, ?)
                           ON CONFLICT (hour, site_id, event) DO UPDATE SET count = count + excluded.count`),
      // CAST: bound JavaScript numbers arrive as REAL, and REAL division would yield fractional buckets
      statBuckets: db.prepare(`SELECT (hour - CAST(:from AS INTEGER)) / CAST(:bucket AS INTEGER) AS bucket, event, SUM(count) AS n FROM stat
                               WHERE hour >= :from AND hour < :to AND (:site IS NULL OR site_id = :site)
                               GROUP BY bucket, event`),
      statBySite: db.prepare('SELECT site_id, event, SUM(count) AS n FROM stat WHERE hour >= ? GROUP BY site_id, event'),
      lastActivity: db.prepare('SELECT site_id, MAX(hour) AS hour FROM stat GROUP BY site_id'),
      purgeStats: db.prepare('DELETE FROM stat WHERE hour < ?'),
      pageCount: db.prepare('PRAGMA page_count'),
      pageSize: db.prepare('PRAGMA page_size'),
      ping: db.prepare('SELECT 1 AS ok'),
    };
    this.file = path.join(dataDir, 'altcha.db');
  }

  #withOrigins(row) {
    return row === undefined ? null : toSite(row, this.#statements.origins.all(row.id).map((r) => r.origin));
  }

  listSites() {
    const byId = new Map();
    for (const row of this.#statements.allOrigins.all()) {
      byId.set(row.site_id, [...(byId.get(row.site_id) ?? []), row.origin]);
    }
    return this.#statements.sites.all().map((row) => toSite(row, byId.get(row.id) ?? []));
  }

  getSite(id) {
    return this.#withOrigins(this.#statements.site.get(id));
  }

  getSiteByName(name) {
    return this.#withOrigins(this.#statements.siteByName.get(name));
  }

  getSiteByOrigin(origin) {
    return this.#withOrigins(this.#statements.siteByOrigin.get(origin));
  }

  // Name and origins are unique across sites. Checked here so the API can say which
  // field collides instead of passing on a bare constraint error.
  #assertUnique(site, id) {
    const errors = {};
    const sameName = this.#statements.siteByName.get(site.name);
    if (sameName !== undefined && sameName.id !== id) {
      errors.name = 'another site already uses this name';
    }
    for (const origin of site.origins) {
      const owner = this.#statements.originOwner.get(origin, id ?? -1);
      if (owner !== undefined) {
        errors.origins = `${origin} already belongs to site '${owner.name}'`;
        break;
      }
    }
    if (Object.keys(errors).length > 0) {
      throw new ValidationError(errors);
    }
  }

  #params(site) {
    return {
      name: site.name,
      recipient: site.recipient,
      subscribeUrl: site.subscription?.url ?? null,
      subscribeWorkspace: site.subscription?.workspaceId ?? null,
      subscribeLists: site.subscription?.listIds.join(',') ?? null,
      subscribeLanguageLists: site.subscription === null ? null : JSON.stringify(site.subscription.languageLists),
      subjectPrefix: site.subjectPrefix,
      successUrl: site.successUrl,
      errorUrl: site.errorUrl,
      submitPerHour: site.submitPerHour,
      enabled: site.enabled ? 1 : 0,
      note: site.note,
      now: new Date().toISOString(),
    };
  }

  #transaction(work) {
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.#db.exec('COMMIT');
      return result;
    }
    catch (e) {
      this.#db.exec('ROLLBACK');
      throw e;
    }
  }

  createSite(site) {
    const id = this.#transaction(() => {
      this.#assertUnique(site, null);
      const newId = Number(this.#statements.insertSite.run(this.#params(site)).lastInsertRowid);
      for (const origin of site.origins) {
        this.#statements.insertOrigin.run(origin, newId);
      }
      return newId;
    });
    return this.getSite(id);
  }

  updateSite(id, site) {
    const found = this.#transaction(() => {
      if (this.#statements.site.get(id) === undefined) {
        return false;
      }
      this.#assertUnique(site, id);
      this.#statements.updateSite.run({ ...this.#params(site), id });
      this.#statements.deleteOrigins.run(id);
      for (const origin of site.origins) {
        this.#statements.insertOrigin.run(origin, id);
      }
      return true;
    });
    return found ? this.getSite(id) : null;
  }

  deleteSite(id) {
    return this.#statements.deleteSite.run(id).changes > 0;
  }

  // Atomic: of two submissions racing with the same challenge, exactly one inserts.
  markChallengeUsed(nonce, expiresAt) {
    return this.#statements.markUsed.run(nonce, expiresAt).changes === 1;
  }

  purgeExpiredChallenges(nowSeconds) {
    return this.#statements.purgeUsed.run(nowSeconds).changes;
  }

  countSpentChallenges() {
    return this.#statements.countUsed.get().n;
  }

  // rows: [{ hour, siteId, event, count }] - one transaction for a whole flush
  addStats(rows) {
    if (rows.length === 0) {
      return;
    }
    this.#transaction(() => {
      for (const row of rows) {
        this.#statements.addStat.run(row.hour, row.siteId, row.event, row.count);
      }
    });
  }

  // Sums per bucket and event between two hours; site null means all sites.
  statBuckets(fromHour, toHour, bucketHours, siteId) {
    return this.#statements.statBuckets.all({ from: fromHour, to: toHour, bucket: bucketHours, site: siteId });
  }

  statBySite(fromHour) {
    return this.#statements.statBySite.all(fromHour);
  }

  lastActivityBySite() {
    return new Map(this.#statements.lastActivity.all().map((row) => [row.site_id, row.hour]));
  }

  purgeStats(beforeHour) {
    return this.#statements.purgeStats.run(beforeHour).changes;
  }

  sizeBytes() {
    const pages = this.#statements.pageCount.get().page_count * this.#statements.pageSize.get().page_size;
    let wal = 0;
    try {
      wal = fs.statSync(this.file + '-wal').size;
    }
    catch (e) {
      wal = 0;
    }
    return pages + wal;
  }

  ping() {
    return this.#statements.ping.get().ok === 1;
  }

  close() {
    this.#db.close();
  }
}
