import test from 'node:test';
import assert from 'node:assert/strict';
import { COMMANDS } from '../src/definitions.js';

// Discord rejects the whole registration if any of these structural rules is broken, and the
// registration script is the one step that cannot be exercised without a real Discord app.
function checkOptions(options, where) {
  assert.ok(options.length <= 25, `${where}: at most 25 options`);
  let seenOptional = false;
  const names = new Set();
  for (const o of options) {
    assert.match(o.name, /^[-_\p{L}\p{N}]{1,32}$/u, `${where}: option name "${o.name}"`);
    assert.equal(o.name, o.name.toLowerCase(), `${where}: option names are lowercase`);
    assert.ok(o.description && o.description.length <= 100, `${where}.${o.name}: description 1-100 chars`);
    assert.ok(!names.has(o.name), `${where}: duplicate option ${o.name}`);
    names.add(o.name);
    if (o.required) assert.equal(seenOptional, false, `${where}.${o.name}: required options must come first`);
    else seenOptional = true;
    if (o.choices) {
      assert.ok(o.choices.length <= 25);
      assert.ok(!o.autocomplete, `${where}.${o.name}: choices and autocomplete are mutually exclusive`);
    }
    if (o.options) checkOptions(o.options, `${where}.${o.name}`);
  }
}

const byName = (name) => COMMANDS.find((c) => c.name === name);
const optionNames = (name) => (byName(name).options ?? []).map((o) => o.name);

test('command definitions satisfy Discord registration rules', () => {
  assert.deepEqual(COMMANDS.map((c) => c.name), [
    'new-meeting', 'update-meeting', 'cancel-meeting', 'upcoming-meetings',
    'add-update-preset', 'meeting-presets', 'delete-preset',
    'add-team', 'remove-team-member', 'show-teams', 'delete-team',
    'calendar', 'set-timezone',
  ]);
  const seen = new Set();
  for (const c of COMMANDS) {
    assert.match(c.name, /^[-_\p{L}\p{N}]{1,32}$/u, `command name "${c.name}"`);
    assert.equal(c.name, c.name.toLowerCase());
    assert.ok(!seen.has(c.name), `duplicate command ${c.name}`);
    seen.add(c.name);
    assert.ok(c.description.length >= 1 && c.description.length <= 100, `${c.name}: description 1-100 chars`);
    checkOptions(c.options ?? [], c.name);
  }
  assert.ok(COMMANDS.length <= 100);
  // the old grouped commands are gone
  assert.equal(byName('meeting-time'), undefined);
  assert.equal(byName('guests'), undefined);
});

test('only /calendar still has subcommands', () => {
  for (const c of COMMANDS) {
    const hasSubs = (c.options ?? []).some((o) => o.type === 1);
    assert.equal(hasSubs, c.name === 'calendar', c.name);
  }
  assert.deepEqual(optionNames('calendar'), ['connect', 'disconnect', 'status']);
});

test('every option the handlers read exists in the definitions', () => {
  for (const n of ['name', 'date', 'time', 'channel', 'location', 'reminder', 'timezone', 'repeat', 'ping', 'ping_5', 'duration', 'team', 'calendar', 'meet', 'reuse']) {
    assert.ok(optionNames('new-meeting').includes(n), `new-meeting.${n}`);
  }
  for (const n of ['name', 'new_name', 'date', 'time', 'channel', 'location', 'reminder', 'timezone', 'repeat', 'ping', 'duration', 'team', 'calendar', 'meet']) {
    assert.ok(optionNames('update-meeting').includes(n), `update-meeting.${n}`);
  }
  for (const n of ['name', 'time', 'channel', 'location', 'reminder', 'timezone', 'repeat', 'ping', 'duration', 'team', 'calendar', 'meet']) {
    assert.ok(optionNames('add-update-preset').includes(n), `add-update-preset.${n}`);
  }
  assert.deepEqual(optionNames('cancel-meeting'), ['name']);
  assert.deepEqual(optionNames('delete-preset'), ['name']);
  assert.deepEqual(optionNames('add-team'), ['team', 'emails']);
  assert.deepEqual(optionNames('remove-team-member'), ['team', 'emails']);
  assert.deepEqual(optionNames('show-teams'), ['team']);
  assert.deepEqual(optionNames('delete-team'), ['team']);
});

test('new-meeting: only name and date are required, so a saved time can be reused; name autocompletes', () => {
  const create = byName('new-meeting').options;
  assert.deepEqual(create.filter((o) => o.required).map((o) => o.name), ['name', 'date']);
  assert.equal(create.find((o) => o.name === 'name').autocomplete, true);
});
