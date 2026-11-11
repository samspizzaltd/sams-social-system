const db = require('../database/db');

// The owner's Recommendations (Content Studio, owner 2026-11-11): free-text
// guidance the autopilot takes into account when it picks the sound for a video
// and writes the hook, end line and captions. Each one says where it applies:
//   sounds   - choosing the sound (our circulated sounds, Instagram trending)
//   editing  - the on-screen hook and end line of the edit
//   captions - captions, hashtags and YouTube titles
//   other    - everything the system writes
// Hard rules (no invented prices, offers, claims...) always win over them.

const AREAS = ['sounds', 'editing', 'captions', 'other'];
const MAX_LEN = 1000;
const MAX_ACTIVE_IN_PROMPT = 40;

function cleanAreas(a) {
  const raw = Array.isArray(a) ? a : String(a || '').split(',');
  const list = raw.map((s) => String(s).trim().toLowerCase()).filter((s) => AREAS.includes(s));
  return [...new Set(list)];
}

function cleanBody(b) {
  return String(b || '').replace(/\r\n/g, '\n').trim();
}

const shape = (r) => ({
  id: r.id,
  body: r.body,
  areas: cleanAreas(r.areas),
  active: !!Number(r.active),
  created_at: r.created_at,
  updated_at: r.updated_at
});

async function list() {
  const rows = await db.query('SELECT * FROM recommendations ORDER BY active DESC, id DESC LIMIT 500');
  return rows === null ? null : rows.map(shape);
}

function validate(body, areas) {
  if (!body) return 'Write the recommendation first';
  if (Array.from(body).length > MAX_LEN) return 'Keep it under ' + MAX_LEN + ' characters';
  if (!areas.length) return 'Pick where it applies (sounds, editing, captions or other)';
  return null;
}

async function create(input) {
  const body = cleanBody(input && input.body);
  const areas = cleanAreas(input && input.areas);
  const bad = validate(body, areas);
  if (bad) return { status: 400, error: bad };
  const r = await db.query('INSERT INTO recommendations (body, areas, active) VALUES (?,?,?)',
    [body, areas.join(','), input && input.active === false ? 0 : 1]);
  if (r === null) return { status: 503, error: 'Database unavailable' };
  return { status: 201, id: r.insertId };
}

async function update(id, input) {
  const rows = await db.query('SELECT * FROM recommendations WHERE id = ?', [id]);
  if (rows === null) return { status: 503, error: 'Database unavailable' };
  if (!rows.length) return { status: 404, error: 'Not found' };
  const cur = shape(rows[0]);
  const body = input && input.body !== undefined ? cleanBody(input.body) : cur.body;
  const areas = input && input.areas !== undefined ? cleanAreas(input.areas) : cur.areas;
  const active = input && input.active !== undefined ? !!input.active : cur.active;
  const bad = validate(body, areas);
  if (bad) return { status: 400, error: bad };
  const r = await db.query('UPDATE recommendations SET body = ?, areas = ?, active = ? WHERE id = ?',
    [body, areas.join(','), active ? 1 : 0, id]);
  if (r === null) return { status: 503, error: 'Database unavailable' };
  return { status: 200 };
}

async function remove(id) {
  const r = await db.query('DELETE FROM recommendations WHERE id = ?', [id]);
  if (r === null) return { status: 503, error: 'Database unavailable' };
  if (!r.affectedRows) return { status: 404, error: 'Not found' };
  return { status: 200 };
}

// Active recommendations for one area ('other' ones apply everywhere).
async function forArea(area) {
  const rows = await db.query('SELECT body, areas FROM recommendations WHERE active = 1 ORDER BY id ASC LIMIT ' + MAX_ACTIVE_IN_PROMPT);
  if (!rows) return [];
  return rows
    .filter((r) => { const a = cleanAreas(r.areas); return a.includes(area) || a.includes('other'); })
    .map((r) => cleanBody(r.body).replace(/\s+/g, ' '));
}

function promptBlock(heading, lines) {
  if (!lines || !lines.length) return '';
  return heading + '\n' + lines.map((l) => '- ' + l).join('\n');
}

module.exports = { AREAS, list, create, update, remove, forArea, promptBlock, cleanAreas };
