import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addDaysLocal,
  canonicalTimeZone,
  localParts,
  parseDate,
  parseTime,
  zonedToUtc,
} from '../src/time.js';

const CHI = 'America/Chicago';
const iso = (ms) => new Date(ms).toISOString();

test('canonicalTimeZone accepts valid zones case-insensitively and rejects junk', () => {
  assert.equal(canonicalTimeZone('america/chicago'), 'America/Chicago');
  assert.equal(canonicalTimeZone(' Asia/Karachi '), 'Asia/Karachi');
  assert.equal(canonicalTimeZone('Mars/Olympus'), null);
  assert.equal(canonicalTimeZone(''), null);
  assert.equal(canonicalTimeZone(undefined), null);
});

test('zonedToUtc: ordinary winter and summer times', () => {
  // Chicago is UTC-6 in January (CST) and UTC-5 in July (CDT)
  assert.equal(iso(zonedToUtc({ y: 2026, m: 1, d: 15, h: 15, mi: 0 }, CHI).ms), '2026-01-15T21:00:00.000Z');
  assert.equal(iso(zonedToUtc({ y: 2026, m: 7, d: 15, h: 15, mi: 0 }, CHI).ms), '2026-07-15T20:00:00.000Z');
  // Karachi is UTC+5 all year
  assert.equal(iso(zonedToUtc({ y: 2026, m: 7, d: 15, h: 15, mi: 0 }, 'Asia/Karachi').ms), '2026-07-15T10:00:00.000Z');
});

test('zonedToUtc: spring-forward gap is reported, not silently mis-converted', () => {
  // 2026-03-08 02:30 does not exist in Chicago
  const r = zonedToUtc({ y: 2026, m: 3, d: 8, h: 2, mi: 30 }, CHI);
  assert.equal(r.ok, false);
  assert.equal(r.gap, true);
  // shifted forward past the gap = 03:30 CDT = 08:30Z
  assert.equal(iso(r.shiftedMs), '2026-03-08T08:30:00.000Z');
});

test('zonedToUtc: fall-back repeated hour picks the first occurrence and flags it', () => {
  // 2026-11-01 01:30 happens twice in Chicago (CDT then CST)
  const r = zonedToUtc({ y: 2026, m: 11, d: 1, h: 1, mi: 30 }, CHI);
  assert.equal(r.ok, true);
  assert.equal(r.ambiguous, true);
  assert.equal(iso(r.ms), '2026-11-01T06:30:00.000Z'); // CDT, UTC-5
});

test('zonedToUtc round-trips through localParts', () => {
  for (const tz of ['America/Chicago', 'Europe/London', 'Asia/Kolkata', 'Australia/Sydney', 'UTC']) {
    const r = zonedToUtc({ y: 2026, m: 6, d: 10, h: 9, mi: 45 }, tz);
    assert.equal(r.ok, true);
    assert.deepEqual(
      { ...localParts(r.ms, tz) },
      { y: 2026, m: 6, d: 10, h: 9, mi: 45, s: 0 },
      tz,
    );
  }
});

test('addDaysLocal keeps the wall-clock time across DST changes', () => {
  // Weekly 15:00 Chicago meeting on Sun 2026-11-01 (before fall-back is that day at 2am, so 15:00 is CST)
  const start = zonedToUtc({ y: 2026, m: 10, d: 25, h: 15, mi: 0 }, CHI).ms; // CDT
  const next = addDaysLocal(start, CHI, 7); // Nov 1, after the clocks went back
  assert.deepEqual(
    { ...localParts(next, CHI) },
    { y: 2026, m: 11, d: 1, h: 15, mi: 0, s: 0 },
  );
  assert.equal(iso(next - start), '1970-01-08T01:00:00.000Z'); // 7 days + 1 hour in UTC terms
});

test('addDaysLocal moves a meeting that lands in the spring gap past it', () => {
  const start = zonedToUtc({ y: 2026, m: 3, d: 1, h: 2, mi: 30 }, CHI).ms;
  const next = addDaysLocal(start, CHI, 7); // Mar 8 02:30 does not exist
  assert.equal(localParts(next, CHI).h, 3);
});

test('parseDate: ISO, today, tomorrow, and impossible dates', () => {
  const now = Date.UTC(2026, 10, 17, 23, 30); // 2026-11-17 23:30Z = 17:30 in Chicago, already Nov 18 in Karachi
  assert.deepEqual(parseDate('2026-12-25', CHI, now), { ok: true, y: 2026, m: 12, d: 25 });
  assert.deepEqual(parseDate('today', CHI, now), { ok: true, y: 2026, m: 11, d: 17 });
  assert.deepEqual(parseDate('Tomorrow', CHI, now), { ok: true, y: 2026, m: 11, d: 18 });
  assert.deepEqual(parseDate('today', 'Asia/Karachi', now), { ok: true, y: 2026, m: 11, d: 18 });
  assert.equal(parseDate('2026-02-30', CHI, now).ok, false);
  assert.equal(parseDate('12/25/2026', CHI, now).ok, false);
  assert.equal(parseDate('', CHI, now).ok, false);
});

test('parseTime: 24h and am/pm forms', () => {
  assert.deepEqual(parseTime('15:00'), { ok: true, h: 15, mi: 0 });
  assert.deepEqual(parseTime('3pm'), { ok: true, h: 15, mi: 0 });
  assert.deepEqual(parseTime('3:45 PM'), { ok: true, h: 15, mi: 45 });
  assert.deepEqual(parseTime('12am'), { ok: true, h: 0, mi: 0 });
  assert.deepEqual(parseTime('12pm'), { ok: true, h: 12, mi: 0 });
  assert.deepEqual(parseTime('9'), { ok: true, h: 9, mi: 0 });
  assert.equal(parseTime('24:00').ok, false);
  assert.equal(parseTime('13pm').ok, false);
  assert.equal(parseTime('10:75').ok, false);
  assert.equal(parseTime('noon').ok, false);
});
