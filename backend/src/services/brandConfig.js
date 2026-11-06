const db = require('../database/db');

// Owner-editable brand + audience configuration, stored in the branding table
// and edited from the control panel. Agents call get() when composing prompts
// so changes apply on the next cycle without a restart.

const DEFAULTS = {
  brand_voice:
    'Write like a real restaurant, not a marketing agency. Warm, direct, a little playful. ' +
    'No corporate filler, no excessive exclamation marks, no invented awards or claims.',
  posting_cadence: '',
  auto_approve_threshold: 'off', // owner reviews every draft unless a number is set
  audience_location: 'Tbilisi, Georgia',
  audience_age: '18-40',
  audience_gender: 'all',
  audience_notes: '',
  style_notes: '',
  music_notes: '',
  auto_cycle_enabled: 'false',
  auto_cycle_times: '09:30',
  auto_cycle_days: 'all',
  // Autopilot (2026-11-06). The master switch itself (system_enabled) is read
  // by services/autopilot.js directly, never through this 60 s cache.
  publish_slots: '12:30,19:00', // Tbilisi times; one post per platform per slot
  sound_mode: 'rotate', // rotate = circulate the library's sounds; own = keep each video's sound
  autoprep_buffer: '5' // prepared videos allowed to wait for review at once
};

let cache = null;
let cacheAt = 0;
const TTL_MS = 60 * 1000;

async function get() {
  const now = Date.now();
  if (cache && now - cacheAt < TTL_MS) return cache;

  const merged = Object.assign({}, DEFAULTS);
  const rows = await db.query('SELECT cfg_key, cfg_value FROM branding');
  if (rows) {
    for (const r of rows) {
      if (r.cfg_value !== null && r.cfg_value !== '') merged[r.cfg_key] = r.cfg_value;
    }
    // Only a successful read is cached; a DB outage retries next call.
    cache = merged;
    cacheAt = now;
  }
  return merged;
}

// One sentence the agents can drop into any prompt.
async function audienceLine() {
  const c = await get();
  const gender = c.audience_gender && c.audience_gender !== 'all'
    ? c.audience_gender
    : 'all genders';
  let line = 'Target audience: ' + gender + ', ages ' + c.audience_age +
    ', located in ' + c.audience_location + '.';
  if (c.audience_notes) line += ' ' + c.audience_notes;
  return line;
}

async function voiceLine() {
  const c = await get();
  return c.brand_voice;
}

// Observed posting style of the real accounts - injected into writer prompts.
async function styleLine() {
  const c = await get();
  const parts = [];
  if (c.style_notes) parts.push('Proven content style: ' + c.style_notes);
  if (c.posting_cadence) parts.push('Posting schedule: ' + c.posting_cadence);
  if (c.music_notes) parts.push('Music approach: ' + c.music_notes);
  return parts.join(' ');
}

function invalidate() {
  cache = null;
}

module.exports = { get, audienceLine, voiceLine, styleLine, invalidate, DEFAULTS };
