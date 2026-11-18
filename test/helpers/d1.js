// A Cloudflare D1-compatible wrapper around node:sqlite so the real SQL (including the
// partial unique index, UPDATE ... RETURNING and batch transactions) runs in tests.
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const migrationsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../migrations');

// node:sqlite returns null-prototype row objects; D1 returns plain objects.
const plain = (row) => (row ? { ...row } : row);

function statement(sqlite, sql, params) {
  return {
    bind: (...p) => statement(sqlite, sql, p),
    async first() {
      return plain(sqlite.prepare(sql).get(...params)) ?? null;
    },
    async all() {
      return { results: sqlite.prepare(sql).all(...params).map(plain) };
    },
    async run() {
      const r = sqlite.prepare(sql).run(...params);
      return { meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
    },
  };
}

export function createTestDb() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON');
  for (const file of readdirSync(migrationsDir).sort()) {
    sqlite.exec(readFileSync(path.join(migrationsDir, file), 'utf8'));
  }
  return {
    prepare: (sql) => statement(sqlite, sql, []),
    async batch(statements) {
      sqlite.exec('BEGIN');
      try {
        const out = [];
        for (const s of statements) out.push(await s.run());
        sqlite.exec('COMMIT');
        return out;
      } catch (e) {
        sqlite.exec('ROLLBACK');
        throw e;
      }
    },
    sql: (query, ...p) => sqlite.prepare(query).all(...p).map(plain), // test convenience
  };
}

/** Fake Discord client that records posts and returns scripted results. */
export function createFakeDiscord(script = []) {
  const posts = [];
  const followups = [];
  const edits = [];
  const queue = [...script];
  const next = () => (queue.length ? queue.shift() : { ok: true });
  return {
    posts,
    followups,
    edits,
    async postMessage(channelId, payload) {
      posts.push({ channelId, ...payload });
      return next();
    },
    async sendFollowup(appId, token, payload) {
      followups.push({ appId, token, ...payload });
      return next();
    },
    async editOriginal(appId, token, payload) {
      edits.push({ appId, token, ...payload });
      return next();
    },
  };
}

/**
 * Fake Google Calendar bridge. Replies come from `script` (consumed in order) or, when that is empty,
 * from a default that behaves like Code.gs. `onCall` runs before the reply, so a test can change the
 * database while a call to Google is "in flight".
 */
export function createFakeBridge({ script = [], onCall } = {}) {
  const calls = [];
  const queue = [...script];
  return {
    calls,
    async call(url, payload) {
      calls.push({ url, ...payload });
      if (onCall) await onCall(payload, calls.length);
      if (queue.length) return queue.shift();
      if (payload.action === 'ping') return { ok: true, account: 'pm@gmail.com' };
      if (payload.action === 'cancel') return { ok: true, eventId: payload.eventId, cancelled: true };
      return {
        ok: true,
        eventId: payload.eventId,
        meetLink: payload.action === 'create' ? 'https://meet.google.com/abc-defg-hij' : '',
        htmlLink: 'https://calendar.google.com/event?eid=x',
        created: payload.action === 'create',
      };
    },
  };
}
