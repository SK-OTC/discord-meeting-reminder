// Timezone-safe date/time helpers built on Intl only (no dependencies).
// All "ms" values are UTC epoch milliseconds; "sec" values are epoch seconds.

const MS_DAY = 86_400_000;
const fmtCache = new Map();

function partsFormatter(tz) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    fmtCache.set(tz, f);
  }
  return f;
}

/** Wall-clock parts of a UTC instant in a zone. */
export function localParts(ms, tz) {
  const out = {};
  for (const p of partsFormatter(tz).formatToParts(new Date(ms))) {
    if (p.type !== 'literal') out[p.type] = Number(p.value);
  }
  return { y: out.year, m: out.month, d: out.day, h: out.hour % 24, mi: out.minute, s: out.second };
}

/** Offset (zone wall clock minus UTC) in ms at a given instant. */
export function offsetMs(tz, ms) {
  const t = Math.floor(ms / 1000) * 1000;
  const p = localParts(t, tz);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - t;
}

/** Friendly country/region names mapped to a representative IANA zone. */
export const PLACE_ZONES = [
  ['Nigeria', 'Africa/Lagos'],
  ['Brazil', 'America/Sao_Paulo'],
  ['South Africa', 'Africa/Johannesburg'],
  ['Ethiopia', 'Africa/Addis_Ababa'],
  ['Jordan', 'Asia/Amman'],
  ['China', 'Asia/Shanghai'],
  ['Spain', 'Europe/Madrid'],
  ['Colombia', 'America/Bogota'],
  ['Italy', 'Europe/Rome'],
  ['Vancouver', 'America/Vancouver'],
  ['Alberta', 'America/Edmonton'],
  ['Vietnam', 'Asia/Ho_Chi_Minh'],
  ['Thailand', 'Asia/Bangkok'],
  ['Qatar', 'Asia/Qatar'],
  ['Mexico', 'America/Mexico_City'],
];

function placeZone(s) {
  const key = s.toLowerCase().replace(/[\s_]+/g, ' ');
  return PLACE_ZONES.find(([name]) => name.toLowerCase() === key)?.[1] ?? null;
}

/**
 * Fixed offsets like "UTC+3", "GMT-5:30", "+0530", "+3" -> "+03:00" (no daylight saving).
 * Returns null if the input is not an offset (or is out of range).
 */
function parseOffset(s) {
  const m = /^(?:utc|gmt)?\s*([+-])\s*(\d{1,2})(?::?([0-5]\d))?$/i.exec(s);
  if (!m) return null;
  const hours = Number(m[2]);
  const mins = Number(m[3] ?? 0);
  if (hours > 14 || (hours === 14 && mins > 0)) return null;
  return `${m[1]}${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}`;
}

/** Returns the canonical IANA name for a zone string (or a place name like "Nigeria"), or null if invalid. */
export function canonicalTimeZone(input) {
  if (typeof input !== 'string') return null;
  let s = input.trim();
  if (!s) return null;
  s = placeZone(s) ?? parseOffset(s) ?? s;
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: s }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

/**
 * Convert a wall-clock time in a zone to a UTC instant.
 * - Normal time:        { ok: true, ms }
 * - Repeated hour (DST fall-back): { ok: true, ms, ambiguous: true } using the FIRST occurrence
 * - Skipped hour (DST spring-forward): { ok: false, gap: true, shiftedMs } where shiftedMs is
 *   the wall time moved forward past the gap
 */
export function zonedToUtc({ y, m, d, h, mi }, tz) {
  const guess = Date.UTC(y, m - 1, d, h, mi, 0);
  const offsets = new Set([offsetMs(tz, guess - MS_DAY), offsetMs(tz, guess + MS_DAY)]);
  const matches = [];
  for (const o of offsets) {
    const utc = guess - o;
    const lp = localParts(utc, tz);
    if (lp.y === y && lp.m === m && lp.d === d && lp.h === h && lp.mi === mi) matches.push(utc);
  }
  if (matches.length) {
    return { ok: true, ms: Math.min(...matches), ambiguous: matches.length > 1 };
  }
  return { ok: false, gap: true, shiftedMs: guess - offsetMs(tz, guess - MS_DAY) };
}

/**
 * Move an instant by whole calendar days while keeping the same wall-clock time in the zone
 * (so a weekly 3pm meeting stays at 3pm across DST changes).
 */
export function addDaysLocal(ms, tz, days) {
  const lp = localParts(ms, tz);
  const next = new Date(Date.UTC(lp.y, lp.m - 1, lp.d + days));
  const r = zonedToUtc(
    { y: next.getUTCFullYear(), m: next.getUTCMonth() + 1, d: next.getUTCDate(), h: lp.h, mi: lp.mi },
    tz,
  );
  return r.ok ? r.ms : r.shiftedMs;
}

/** Parses "YYYY-MM-DD", "today", or "tomorrow" (relative to `nowMs` in the zone). */
export function parseDate(input, tz, nowMs) {
  const s = String(input ?? '').trim().toLowerCase();
  if (s === 'today' || s === 'tomorrow') {
    const lp = localParts(nowMs, tz);
    const d = new Date(Date.UTC(lp.y, lp.m - 1, lp.d + (s === 'tomorrow' ? 1 : 0)));
    return { ok: true, y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() };
  }
  const match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (!match) return { ok: false };
  const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const check = new Date(Date.UTC(y, m - 1, d));
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== m - 1 || check.getUTCDate() !== d) {
    return { ok: false };
  }
  return { ok: true, y, m, d };
}

/** Parses "14:30", "2:30pm", "2 pm", "14". */
export function parseTime(input) {
  const match = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i.exec(String(input ?? '').trim());
  if (!match) return { ok: false };
  let h = Number(match[1]);
  const mi = match[2] === undefined ? 0 : Number(match[2]);
  const meridiem = match[3]?.toLowerCase();
  if (mi > 59) return { ok: false };
  if (meridiem) {
    if (h < 1 || h > 12) return { ok: false };
    if (meridiem === 'am') h = h === 12 ? 0 : h;
    else h = h === 12 ? 12 : h + 12;
  } else if (h > 23) {
    return { ok: false };
  }
  return { ok: true, h, mi };
}

/** Discord timestamp markup, e.g. <t:1700000000:F>. Renders in each viewer's own timezone. */
export function discordTimestamp(sec, style = 'F') {
  return `<t:${sec}:${style}>`;
}

/** Human-readable wall-clock label, e.g. "Fri, Nov 20, 2026, 3:00 PM". */
export function formatLocal(ms, tz) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(ms));
}

let zoneList;
/** All IANA zones the runtime knows (plus UTC). */
export function allTimeZones() {
  if (!zoneList) {
    try {
      zoneList = Intl.supportedValuesOf('timeZone');
    } catch {
      zoneList = [];
    }
    if (!zoneList.includes('UTC')) zoneList = ['UTC', ...zoneList];
  }
  return zoneList;
}

/**
 * The timezone to send to Google Calendar. IANA names (including ones resolved from a place name)
 * are sent as they are. A fixed offset such as "+03:00" (what UTC+3 becomes) has no IANA name and
 * Google needs one for weekly series, so it is sent as "UTC": a fixed offset never changes, so the
 * same UTC time is also the same local time.
 */
export function bridgeTimeZone(tz) {
  return /^[+-]\d\d:\d\d$/.test(String(tz)) ? 'UTC' : tz;
}
