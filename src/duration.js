// One parser for "how long" options, so `reminder` and `duration` behave the same way:
// a plain number means HOURS, add `min` for minutes, `1h30min` and `1.5` work.

export const REMINDER_HELP =
  '`reminder` should look like `2h`, `1h30min` or `15min`. A plain number means hours, so add `min` for minutes. Use `0` for no reminder (24h at most).';

export const DURATION_HELP =
  '`duration` should look like `1h`, `90min` or `1h30min`. A plain number means hours, so add `min` for minutes. It must be between 15 minutes and 2 hours.';

/** "2h", "1h30min", "90min", "1.5" (hours) -> whole minutes, or null if it can't be understood. */
export function parseSpan(value) {
  const s = String(value).trim().toLowerCase().replace(/\s+/g, '');
  let minutes;
  if (/^\d+(\.\d+)?$/.test(s)) {
    minutes = Math.round(parseFloat(s) * 60);
  } else {
    const m = /^(?:(\d+(?:\.\d+)?)(?:h|hr|hrs|hour|hours))?(?:(\d+)(?:m|min|mins|minute|minutes))?$/.exec(s);
    if (!m || (m[1] === undefined && m[2] === undefined)) return null;
    minutes = Math.round(parseFloat(m[1] ?? '0') * 60) + Number(m[2] ?? 0);
  }
  return Number.isFinite(minutes) ? minutes : null;
}

/** Returns { ok: true, minutes } (minutes undefined when the option was not given) or { ok: false, message }. */
export function parseReminder(value) {
  if (value === undefined) return { ok: true, minutes: undefined };
  const s = String(value).trim().toLowerCase();
  if (['none', 'off', 'no'].includes(s)) return { ok: true, minutes: 0 };
  const minutes = parseSpan(value);
  if (minutes === null || minutes < 0 || minutes > 1440) return { ok: false, message: REMINDER_HELP };
  return { ok: true, minutes };
}

export const MIN_DURATION_MIN = 15;
export const MAX_DURATION_MIN = 120;
export const DEFAULT_DURATION_MIN = 60;

export function parseDuration(value) {
  if (value === undefined) return { ok: true, minutes: undefined };
  const minutes = parseSpan(value);
  if (minutes === null || minutes < MIN_DURATION_MIN || minutes > MAX_DURATION_MIN) {
    return { ok: false, message: DURATION_HELP };
  }
  return { ok: true, minutes };
}
