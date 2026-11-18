/**
 * Meeting bot -> Google Calendar bridge (Google Apps Script web app).
 *
 * Deploy: Execute as "Me", Who has access "Anyone".
 * Script properties (Project Settings -> Script properties):
 *   BOT_SECRET   required. Long random string; the Worker sends the same value.
 *   CALENDAR_ID  optional. Defaults to "primary" (the deploying account's main calendar).
 * Advanced service: Services (+) -> Google Calendar API (v3) -> Add.
 *
 * Every meeting organizer deploys their OWN copy, so events are created and owned by their own Google account.
 * All copies use the same BOT_SECRET (the one stored as the Worker secret).
 *
 * The request body is JSON: { secret, action: "ping" | "create" | "update" | "cancel", eventId, ... }.
 * The Worker chooses eventId (random, a-v and 0-9 only), so retrying a create never duplicates.
 * Every response is HTTP 200 with JSON: { ok: true, ... } or { ok: false, error }.
 */

var MAX_GUESTS = 100;
var EVENT_ID_RE = /^[a-v0-9]{5,100}$/;
var EMAIL_RE = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;

function doGet() {
  return json_({ ok: true, service: 'meeting-calendar-bridge' });
}

function doPost(e) {
  var lock = LockService.getScriptLock();
  var locked = false;
  try {
    var req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    var props = PropertiesService.getScriptProperties();
    var expected = props.getProperty('BOT_SECRET') || '';
    if (!expected || !safeEqual_(String(req.secret || ''), expected)) {
      return json_({ ok: false, error: 'unauthorized' });
    }
    locked = lock.tryLock(20000);
    if (!locked) return json_({ ok: false, error: 'busy, retry' });

    var calendarId = props.getProperty('CALENDAR_ID') || 'primary';
    if (req.action === 'ping') {
      // Used by "/calendar connect" to prove the URL, secret and authorization all work.
      return json_({ ok: true, account: Calendar.Calendars.get(calendarId).id });
    }
    if (!EVENT_ID_RE.test(String(req.eventId || ''))) {
      return json_({ ok: false, error: 'eventId must be 5-100 chars of a-v and 0-9' });
    }
    if (req.action === 'create') return json_(createEvent_(calendarId, req));
    if (req.action === 'update') return json_(updateEvent_(calendarId, req));
    if (req.action === 'cancel') return json_(cancelEvent_(calendarId, req));
    return json_({ ok: false, error: 'unknown action' });
  } catch (err) {
    return json_({ ok: false, error: String((err && err.message) || err).slice(0, 300) });
  } finally {
    if (locked) lock.releaseLock();
  }
}

/** Run this once from the editor to grant calendar access (Run -> setup). */
function setup() {
  var id = PropertiesService.getScriptProperties().getProperty('CALENDAR_ID') || 'primary';
  var cal = Calendar.Calendars.get(id);
  Logger.log('Authorized. Events will be created on: ' + cal.summary + ' (' + cal.id + ')');
}

// ---------------------------------------------------------------- actions

function createEvent_(calendarId, req) {
  var resource = buildResource_(req, true);
  var opts = { conferenceDataVersion: 1, sendUpdates: req.sendInvites === false ? 'none' : 'all' };
  var ev;
  var created = true;
  try {
    ev = Calendar.Events.insert(resource, calendarId, opts);
  } catch (err) {
    if (!/already exists|duplicate/i.test(String(err && err.message))) throw err;
    // Retry of a create that already succeeded: return the existing event.
    ev = Calendar.Events.get(calendarId, req.eventId);
    created = false;
    if (ev.status === 'cancelled') return { ok: false, error: 'event id was used by a deleted event' };
  }
  ev = waitForMeet_(calendarId, ev, req.meet !== false);
  return result_(ev, created);
}

function updateEvent_(calendarId, req) {
  var existing;
  try {
    existing = Calendar.Events.get(calendarId, req.eventId);
  } catch (err) {
    return { ok: false, error: 'event not found: ' + String((err && err.message) || err).slice(0, 120) };
  }
  if (existing.status === 'cancelled') return { ok: false, error: 'event was deleted' };

  var patch = buildResource_(req, false);
  // Only touch the guest list when it really changed, so RSVPs are kept.
  var have = emailSet_((existing.attendees || []).filter(function (a) { return !a.self && !a.organizer; }));
  var want = emailSet_(patch.attendees || []);
  if (setsEqual_(have, want)) delete patch.attendees;

  // Without conferenceDataVersion=1 a patch can drop the Meet link, so always send it.
  var opts = { conferenceDataVersion: 1, sendUpdates: req.sendInvites === false ? 'none' : 'all' };
  var ev = Calendar.Events.patch(patch, calendarId, req.eventId, opts);
  return result_(ev, false);
}

function cancelEvent_(calendarId, req) {
  try {
    Calendar.Events.remove(calendarId, req.eventId, { sendUpdates: req.sendInvites === false ? 'none' : 'all' });
  } catch (err) {
    if (!/deleted|not found|404|410|gone/i.test(String(err && err.message))) throw err;
  }
  return { ok: true, eventId: req.eventId, cancelled: true };
}

// ---------------------------------------------------------------- helpers

function buildResource_(req, isCreate) {
  var title = String(req.title || '').trim();
  if (!title || title.length > 200) throw new Error('title must be 1-200 chars');
  var startSec = Number(req.startSec);
  var durationMin = Number(req.durationMin);
  if (!isFinite(startSec) || startSec <= 0) throw new Error('startSec must be unix seconds');
  if (!isFinite(durationMin) || durationMin < 5 || durationMin > 1440) throw new Error('durationMin must be 5-1440');
  var tz = String(req.timezone || '');
  try {
    Utilities.formatDate(new Date(), tz, 'z');
  } catch (e) {
    throw new Error('unknown timezone: ' + tz);
  }
  var guests = Array.isArray(req.guests) ? req.guests : [];
  if (guests.length > MAX_GUESTS) throw new Error('too many guests (max ' + MAX_GUESTS + ')');
  var seen = {};
  var attendees = [];
  guests.forEach(function (g) {
    var email = String(g || '').trim().toLowerCase();
    if (!EMAIL_RE.test(email)) throw new Error('bad email: ' + email.slice(0, 60));
    if (!seen[email]) {
      seen[email] = true;
      attendees.push({ email: email });
    }
  });

  var resource = {
    summary: title,
    description: String(req.description || '').slice(0, 4000),
    location: req.location ? String(req.location).slice(0, 200) : '',
    start: { dateTime: new Date(startSec * 1000).toISOString(), timeZone: tz },
    end: { dateTime: new Date((startSec + durationMin * 60) * 1000).toISOString(), timeZone: tz },
    attendees: attendees,
    guestsCanModify: false,
    guestsCanInviteOthers: false
  };
  if (req.repeat === 'weekly') resource.recurrence = ['RRULE:FREQ=WEEKLY'];
  if (isCreate) {
    resource.id = req.eventId;
    if (req.meet !== false) {
      resource.conferenceData = {
        createRequest: { requestId: 'r-' + req.eventId, conferenceSolutionKey: { type: 'hangoutsMeet' } }
      };
    }
  }
  return resource;
}

function waitForMeet_(calendarId, ev, wantMeet) {
  var tries = 0;
  while (
    wantMeet &&
    tries < 4 &&
    !ev.hangoutLink &&
    ev.conferenceData &&
    ev.conferenceData.createRequest &&
    ev.conferenceData.createRequest.status &&
    ev.conferenceData.createRequest.status.statusCode === 'pending'
  ) {
    Utilities.sleep(700);
    ev = Calendar.Events.get(calendarId, ev.id);
    tries++;
  }
  return ev;
}

function result_(ev, created) {
  var meet = ev.hangoutLink || '';
  if (!meet && ev.conferenceData && ev.conferenceData.entryPoints) {
    ev.conferenceData.entryPoints.forEach(function (p) {
      if (!meet && p.entryPointType === 'video') meet = p.uri;
    });
  }
  return { ok: true, eventId: ev.id, meetLink: meet, htmlLink: ev.htmlLink || '', created: created };
}

function emailSet_(list) {
  var out = {};
  list.forEach(function (a) { if (a.email) out[String(a.email).toLowerCase()] = true; });
  return out;
}

function setsEqual_(a, b) {
  var ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every(function (k) { return b[k]; });
}

function safeEqual_(a, b) {
  var diff = a.length ^ b.length;
  var n = Math.max(a.length, b.length);
  for (var i = 0; i < n; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
