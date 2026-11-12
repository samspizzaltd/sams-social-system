const fs = require('fs');
const path = require('path');
const db = require('../database/db');
const claude = require('./claudeClient');
const recommendations = require('./recommendations');
const { PREP_DIR } = require('./autopilot');

// Analyze & name (owner 2026-11-12): "a special button where i add media, for
// the system to analyze it and name it properly so we can identify what
// content is in the video ... this should work for newly uploaded videos and
// or sounds and already uploaded ones".
//
// The system looks at a library item and gives it a plain name, a one-line
// summary and tags. The name it had before stays in original_title: harvest.js
// recognises videos it already used by that name, and the owner can restore it.
//
// Where the pictures come from:
// - a library video the autopilot analysed: its frames are already on the
//   server (autopilot PREP_DIR), so it is named right away - no PC needed;
// - the branded edit of such a video: it takes its video's name ("✨ ...");
// - everything else (sounds, photos, other videos and edits): a 'Describe' job
//   for the video worker on the owner's PC, which sends frames, a photo or a
//   spectrogram plus measurements back (saveInput). Claude cannot hear, so a
//   sound is named from its spectrogram, its measurements and the video it
//   came from - the song itself is never recognised, and the panel says so.
//
// Nothing here publishes anything; it only renames library items.

const NAME_DIR = path.join(__dirname, '..', '..', '..', 'name-inputs');
const AUTO_KEY = 'auto_name_media'; // 'on' (default) | 'off'
const SINCE_KEY = 'media_naming_since'; // automatic naming covers items added after this
const KINDS = ['video', 'rendered', 'photo', 'sound'];
const MAX_FRAMES = 8;

const state = {
  queue: [],
  inQueue: new Set(),
  running: false,
  current: null,
  done: 0,
  failed: 0,
  lastError: null,
  sweeping: false,
  timers: []
};

const cut = (s, max) => Array.from(String(s == null ? '' : s).replace(/\s+/g, ' ').trim()).slice(0, max).join('').trim();
const ageMs = (d) => (d ? Date.now() - new Date(d).getTime() : Infinity);

// ---------- settings ----------

async function setting(key) {
  const rows = await db.query('SELECT cfg_value FROM branding WHERE cfg_key = ?', [key]);
  return rows && rows.length ? rows[0].cfg_value : null;
}
async function setSetting(key, value) {
  return db.query('INSERT INTO branding (cfg_key, cfg_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE cfg_value = ?', [key, value, value]);
}
async function autoOn() {
  const v = await setting(AUTO_KEY);
  return v === null || v === '' ? true : v !== 'off';
}
// Set once, in the database's own clock (the same clock as media.created_at),
// so items that were in the library before this feature are named only when
// the owner asks.
async function since() {
  let v = await setting(SINCE_KEY);
  if (!v) {
    await db.query(
      "INSERT IGNORE INTO branding (cfg_key, cfg_value) SELECT ?, DATE_FORMAT(NOW(), '%Y-%m-%d %H:%i:%s')", [SINCE_KEY]
    );
    v = await setting(SINCE_KEY);
  }
  return v;
}

// ---------- inputs on disk ----------

function prepFrames(mediaId) {
  const dir = path.join(PREP_DIR, String(Number(mediaId)));
  try {
    return fs.readdirSync(dir).filter((n) => /^\d+\.jpg$/.test(n)).sort((a, b) => parseInt(a, 10) - parseInt(b, 10))
      .slice(0, MAX_FRAMES).map((n) => path.join(dir, n));
  } catch {
    return [];
  }
}
function inputDir(mediaId) {
  return path.join(NAME_DIR, String(Number(mediaId)));
}
function hasInput(mediaId) {
  return fs.existsSync(path.join(inputDir(mediaId), 'facts.json'));
}
function dropInput(mediaId) {
  fs.rmSync(inputDir(mediaId), { recursive: true, force: true });
}

const IMAGE_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp' };
const looksLike = (buf, type) =>
  (type === 'image/jpeg' && buf[0] === 0xff && buf[1] === 0xd8) ||
  (type === 'image/png' && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) ||
  (type === 'image/gif' && buf.toString('ascii', 0, 3) === 'GIF') ||
  (type === 'image/webp' && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP');

// Only plain numbers / booleans / short strings from the worker's report, in
// known places - the server does not trust what arrives.
function cleanFacts(f) {
  const out = {};
  if (!f || typeof f !== 'object') return out;
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 100) / 100 : undefined);
  for (const k of ['duration', 'width', 'height', 'analysed_s', 'loudness_db', 'peak_db', 'silence_share', 'beat_bpm',
    'beat_strength', 'noisiness', 'voice_band_share', 'bass_share', 'brightness_hz', 'speech_rhythm']) {
    const v = num(f[k]);
    if (v !== undefined) out[k] = v;
  }
  if (typeof f.has_audio === 'boolean') out.has_audio = f.has_audio;
  if (f.too_short === true) out.too_short = true;
  if (f.audio && typeof f.audio === 'object') {
    const a = cleanFacts(f.audio);
    delete a.audio;
    if (Object.keys(a).length) out.audio = a;
  }
  return out;
}

// POST /api/media/describe-input - the video worker's report for one item.
// payload: {job_id, media_id, frames[], frame_times[], image:{type,data}, spectrogram, facts}
async function saveInput(payload) {
  const id = Number(payload && payload.media_id);
  const jobId = Number(payload && payload.job_id);
  if (!Number.isInteger(id) || !Number.isInteger(jobId)) return { status: 400, error: 'media_id and job_id required' };
  const rows = await db.query('SELECT id, kind, ai_status, ai_job_id FROM media WHERE id = ?', [id]);
  if (rows === null) return { status: 503, error: 'Database unavailable' };
  if (!rows.length) return { status: 404, error: 'Not in the library' };
  if (Number(rows[0].ai_job_id) !== jobId || !['queued', 'working'].includes(rows[0].ai_status)) {
    return { status: 409, error: 'That naming is no longer wanted' };
  }
  const dir = inputDir(id);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  let saved = 0;
  const frames = Array.isArray(payload.frames) ? payload.frames.slice(0, MAX_FRAMES) : [];
  const times = Array.isArray(payload.frame_times) ? payload.frame_times : [];
  const keptTimes = [];
  frames.forEach((b64, i) => {
    if (typeof b64 !== 'string') return;
    const buf = Buffer.from(b64, 'base64');
    if (buf.length < 100 || buf.length > 600 * 1024 || !looksLike(buf, 'image/jpeg')) return;
    fs.writeFileSync(path.join(dir, 'frame-' + keptTimes.length + '.jpg'), buf);
    const t = Number(times[i]);
    keptTimes.push(Number.isFinite(t) && t >= 0 ? Math.round(t * 10) / 10 : null);
    saved++;
  });
  const img = payload.image;
  if (img && typeof img.data === 'string' && IMAGE_TYPES[img.type]) {
    const buf = Buffer.from(img.data, 'base64');
    if (buf.length >= 100 && buf.length <= 3.75 * 1024 * 1024 && looksLike(buf, img.type)) {
      fs.writeFileSync(path.join(dir, 'image.' + IMAGE_TYPES[img.type]), buf);
      saved++;
    }
  }
  if (typeof payload.spectrogram === 'string') {
    const buf = Buffer.from(payload.spectrogram, 'base64');
    if (buf.length >= 100 && buf.length <= 1024 * 1024 && looksLike(buf, 'image/png')) {
      fs.writeFileSync(path.join(dir, 'spectrogram.png'), buf);
      saved++;
    }
  }
  if (!saved) {
    fs.rmSync(dir, { recursive: true, force: true });
    return { status: 400, error: 'Nothing usable in the report (no frames, photo or spectrogram)' };
  }
  fs.writeFileSync(path.join(dir, 'facts.json'), JSON.stringify({ facts: cleanFacts(payload.facts), frame_times: keptTimes }));
  enqueue(id);
  return { status: 202, body: { ok: true } };
}

function loadInput(m) {
  const dir = inputDir(m.id);
  if (hasInput(m.id)) {
    let meta = {};
    try { meta = JSON.parse(fs.readFileSync(path.join(dir, 'facts.json'), 'utf8')); } catch { meta = {}; }
    const names = fs.readdirSync(dir);
    const frames = names.filter((n) => /^frame-\d+\.jpg$/.test(n))
      .sort((a, b) => parseInt(a.slice(6), 10) - parseInt(b.slice(6), 10))
      .map((n, i) => ({ data: fs.readFileSync(path.join(dir, n)).toString('base64'), type: 'image/jpeg', time: (meta.frame_times || [])[i] }));
    const imgName = names.find((n) => /^image\.(jpg|png|gif|webp)$/.test(n));
    const ext = imgName ? imgName.split('.').pop() : null;
    const image = imgName
      ? { data: fs.readFileSync(path.join(dir, imgName)).toString('base64'), type: Object.keys(IMAGE_TYPES).find((t) => IMAGE_TYPES[t] === ext) }
      : null;
    const spectrogram = names.includes('spectrogram.png') ? fs.readFileSync(path.join(dir, 'spectrogram.png')).toString('base64') : null;
    return { frames, image, spectrogram, facts: meta.facts || {} };
  }
  return null;
}

async function inputFromPrep(m) {
  const files = prepFrames(m.id);
  if (!files.length) return null;
  const p = await db.query('SELECT analysis, copy_json FROM media_prep WHERE media_id = ?', [m.id]);
  let analysis = {};
  let shows = '';
  if (p && p.length) {
    try { analysis = JSON.parse(p[0].analysis || '{}'); } catch { analysis = {}; }
    try { shows = JSON.parse(p[0].copy_json || '{}').what_it_shows || ''; } catch { shows = ''; }
  }
  const times = Array.isArray(analysis.frame_times) && analysis.frame_times.length === files.length ? analysis.frame_times : [];
  return {
    frames: files.map((f, i) => ({ data: fs.readFileSync(f).toString('base64'), type: 'image/jpeg', time: times[i] })),
    image: null,
    spectrogram: null,
    facts: cleanFacts({ duration: Number(analysis.duration), width: Number(analysis.width), height: Number(analysis.height), has_audio: analysis.has_audio === undefined ? undefined : !!analysis.has_audio }),
    earlier: shows && !/Claude was unavailable/.test(shows) ? cut(shows, 400) : ''
  };
}

// ---------- the request / the path ----------

async function request(mediaId) {
  const id = Number(mediaId);
  if (!Number.isInteger(id) || id < 1) return { status: 400, error: 'Invalid media id' };
  const rows = await db.query('SELECT * FROM media WHERE id = ?', [id]);
  if (rows === null) return { status: 503, error: 'Database unavailable' };
  if (!rows.length) return { status: 404, error: 'Not in the library' };
  const m = rows[0];
  if (!KINDS.includes(m.kind)) return { status: 400, error: 'This kind of item cannot be named' };
  if (['queued', 'working'].includes(m.ai_status) && ageMs(m.ai_requested_at) < 30 * 60 * 1000) {
    return { status: 200, body: { ok: true, already: true, ai_status: m.ai_status } };
  }
  // An older Describe job for it that the PC has not started is not needed any more.
  if (m.ai_job_id) await db.query("DELETE FROM render_jobs WHERE id = ? AND status = 'queued' AND template = 'Describe'", [m.ai_job_id]);
  const upd = await db.query(
    "UPDATE media SET original_title = COALESCE(original_title, title), ai_status = 'queued', ai_error = NULL," +
    ' ai_job_id = NULL, ai_requested_at = NOW() WHERE id = ?', [id]
  );
  if (upd === null) return { status: 503, error: 'Database unavailable' };
  m.ai_status = 'queued';
  m.ai_job_id = null;
  m.original_title = m.original_title || m.title;
  const step = await advance(m);
  return { status: 200, body: { ok: true, ai_status: step === 'done' ? 'done' : 'queued', step } };
}

// What happens next for a queued item. Returns a short word for the panel/tests.
async function advance(m) {
  const id = Number(m.id);
  if (state.inQueue.has(id)) return 'naming';
  if (hasInput(id)) { enqueue(id); return 'naming'; }
  if (m.kind === 'video' && prepFrames(id).length) { enqueue(id); return 'naming'; }

  // The branded edit of a library video takes its video's name.
  if (m.kind === 'rendered') {
    const src = await db.query('SELECT media_id FROM media_prep WHERE output_media_id = ? LIMIT 1', [id]);
    if (src && src.length) {
      const s = await db.query('SELECT * FROM media WHERE id = ?', [src[0].media_id]);
      const v = s && s.length ? s[0] : null;
      // A name the owner typed for the video is used as it is - never renamed behind his back.
      if (v && (v.ai_status === 'done' || v.title_source === 'owner')) { await inherit(m, v); return 'done'; }
      if (v && v.ai_status !== 'failed') {
        if (!['queued', 'working'].includes(v.ai_status)) await request(v.id);
        return 'waiting-for-video';
      }
    }
  }
  // A library video the autopilot is analysing right now: its frames come soon.
  if (m.kind === 'video') {
    const p = await db.query(
      "SELECT media_id FROM media_prep WHERE media_id = ? AND status IN ('queued','analyzing') AND updated_at > NOW() - INTERVAL 30 MINUTE", [id]
    );
    if (p && p.length) return 'waiting-for-analysis';
  }
  // The video worker on the owner's PC.
  if (m.ai_job_id) {
    const j = await db.query('SELECT status, error, updated_at FROM render_jobs WHERE id = ?', [m.ai_job_id]);
    if (j === null) return 'waiting-for-worker';
    if (j.length) {
      if (j[0].status === 'failed') {
        await fail(id, 'The video worker could not read it: ' + cut(j[0].error || 'unknown error', 200));
        return 'failed';
      }
      if (j[0].status === 'done' && ageMs(j[0].updated_at) > 3 * 60 * 1000) {
        await fail(id, 'The report from your PC never arrived - press Analyze & name again');
        return 'failed';
      }
      return 'waiting-for-worker';
    }
  }
  const job = await db.query(
    "INSERT INTO render_jobs (template, params, media_ids, status) VALUES ('Describe', ?, ?, 'queued')",
    [JSON.stringify({ describe_media_id: id }), String(id)]
  );
  if (job === null) return 'waiting-for-worker';
  await db.query("UPDATE media SET ai_job_id = ? WHERE id = ? AND ai_status = 'queued'", [job.insertId, id]);
  return 'waiting-for-worker';
}

async function inherit(edit, video) {
  const title = cut('✨ ' + String(video.title || '').replace(/^✨\s*/, ''), 255);
  await db.query(
    "UPDATE media SET original_title = COALESCE(original_title, title), title = ?, ai_summary = ?, ai_tags = ?, ai_facts = ?," +
    " ai_status = 'done', ai_error = NULL, ai_named_at = NOW(), title_source = 'ai' WHERE id = ?",
    [title, video.ai_summary || null, video.ai_tags || null, JSON.stringify({ edit_of: Number(video.id) }), edit.id]
  );
}

async function fail(id, msg) {
  state.failed++;
  state.lastError = 'item #' + id + ': ' + msg;
  dropInput(id);
  await db.query("UPDATE media SET ai_status = 'failed', ai_error = ? WHERE id = ?", [cut(msg, 300), id]);
}

// Many at once: what was never named (or failed) - videos first, so sounds and
// edits can use their video's name. Names the owner typed are left alone.
async function requestMany(scope) {
  const all = scope === 'all';
  const rows = await db.query(
    "SELECT id FROM media WHERE kind IN ('video','rendered','photo','sound')" +
    " AND (title_source IS NULL OR title_source <> 'owner')" +
    " AND (ai_status IS NULL OR ai_status NOT IN ('queued','working'))" +
    (all ? '' : " AND (ai_status IS NULL OR ai_status = 'failed')") +
    " ORDER BY FIELD(kind,'video','photo','rendered','sound'), id ASC LIMIT 500"
  );
  if (rows === null) return { status: 503, error: 'Database unavailable' };
  let queued = 0;
  for (const r of rows) {
    const x = await request(r.id);
    if (x.body && x.body.ok && !x.body.already) queued++;
  }
  return { status: 200, body: { ok: true, queued } };
}

// The owner's own name (or the old one back). A naming still running for the
// item is called off, so it cannot overwrite what he typed.
async function setTitle(mediaId, body) {
  const id = Number(mediaId);
  if (!Number.isInteger(id) || id < 1) return { status: 400, error: 'Invalid media id' };
  const rows = await db.query('SELECT id, title, original_title FROM media WHERE id = ?', [id]);
  if (rows === null) return { status: 503, error: 'Database unavailable' };
  if (!rows.length) return { status: 404, error: 'Not in the library' };
  let title;
  if (body && body.restore === true) {
    if (!rows[0].original_title) return { status: 400, error: 'This item still has its first name' };
    title = rows[0].original_title;
  } else {
    title = cut(String((body && body.title) || '').replace(/[<>]/g, ''), 255);
    if (title.length < 2) return { status: 400, error: 'Type a name of at least 2 characters' };
  }
  const r = await db.query(
    "UPDATE media SET original_title = COALESCE(original_title, title), title = ?, title_source = 'owner'," +
    " ai_status = CASE WHEN ai_status IN ('queued','working') THEN NULL ELSE ai_status END WHERE id = ?",
    [title, id]
  );
  if (r === null) return { status: 503, error: 'Database unavailable' };
  dropInput(id);
  return { status: 200, body: { ok: true, title } };
}

// A Describe job failed on the PC (routes/media.js calls this).
async function onJobStatus(jobId, status, error) {
  if (status !== 'failed') return;
  const rows = await db.query("SELECT id FROM media WHERE ai_job_id = ? AND ai_status = 'queued'", [Number(jobId)]);
  for (const r of rows || []) await fail(r.id, 'The video worker could not read it: ' + cut(error || 'unknown error', 200));
}

// ---------- asking Claude ----------

const VIDEO_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'summary', 'tags', 'content_type', 'on_screen_text'],
  properties: {
    title: { type: 'string' },
    summary: { type: 'string' },
    tags: { type: 'array', items: { type: 'string' } },
    content_type: {
      type: 'string',
      enum: ['food_close_up', 'cooking', 'plating_or_serving', 'menu_or_promo_text', 'venue_or_shop_front', 'people', 'mixed', 'other']
    },
    on_screen_text: { type: 'string' }
  }
};
const SOUND_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'summary', 'tags', 'sound_type', 'energy', 'confidence'],
  properties: {
    title: { type: 'string' },
    summary: { type: 'string' },
    tags: { type: 'array', items: { type: 'string' } },
    sound_type: {
      type: 'string',
      enum: ['music_with_vocals', 'instrumental_music', 'speech_or_voice_over', 'kitchen_or_room_sounds', 'mixed', 'silence', 'unclear']
    },
    energy: { type: 'string', enum: ['calm', 'medium', 'upbeat', 'unclear'] },
    confidence: { type: 'string', enum: ['low', 'medium', 'high'] }
  }
};

const pct = (v) => Math.round(Number(v) * 100) + '%';
function shape(f) {
  const w = Number(f.width);
  const h = Number(f.height);
  if (!w || !h) return '';
  return (h > w * 1.1 ? 'vertical' : w > h * 1.1 ? 'horizontal' : 'square') + ' (' + w + 'x' + h + ')';
}
function soundLines(a) {
  const lines = [];
  if (a.loudness_db !== undefined) lines.push('- typical loudness ' + a.loudness_db + ' dBFS, peak ' + a.peak_db + ' dBFS; silent ' + pct(a.silence_share || 0) + ' of the time');
  if (a.beat_bpm) lines.push('- beat: about ' + a.beat_bpm + ' per minute, strength ' + a.beat_strength + ' (0-1; above about 0.4 usually means a clear, regular beat such as drums)');
  if (a.noisiness !== undefined) lines.push('- noisiness ' + a.noisiness + ' (0-1; low = tones such as music or a voice, high = noise such as sizzling or traffic)');
  if (a.voice_band_share !== undefined) lines.push('- share of the sound in the voice range 300-3400 Hz: ' + pct(a.voice_band_share) + '; below 150 Hz (bass, drums): ' + pct(a.bass_share || 0));
  if (a.speech_rhythm !== undefined) lines.push('- loudness wobble at the speed of syllables (3-7 per second): ' + a.speech_rhythm + ' (0-1; speech is often above about 0.35)');
  return lines;
}

async function context(m) {
  const ctx = { notes: [], source: null, harvested: null };
  try {
    ctx.notes = await recommendations.forArea('other');
  } catch { ctx.notes = []; }
  const note = String(m.note || '');
  const from = /^sound-from:(\d+)$/.exec(note);
  if (from) {
    const s = await db.query('SELECT m.id, m.title, m.ai_summary, p.copy_json FROM media m LEFT JOIN media_prep p ON p.media_id = m.id WHERE m.id = ?', [Number(from[1])]);
    if (s && s.length) {
      let shows = '';
      try { shows = JSON.parse(s[0].copy_json || '{}').what_it_shows || ''; } catch { shows = ''; }
      ctx.source = { id: Number(s[0].id), title: cut(s[0].title, 120), about: cut(s[0].ai_summary || (/Claude was unavailable/.test(shows) ? '' : shows), 300) };
    }
  }
  const hv = /^harvest:(instagram|facebook_page):\S+ \| (\d+) views/.exec(note);
  if (hv) ctx.harvested = { platform: hv[1] === 'instagram' ? 'Instagram' : 'Facebook', views: Number(hv[2]) };
  return ctx;
}

function buildAsk(m, input, ctx) {
  const system =
    "You name the items in the media library of Sam's (Sam's Pizza Ltd, brand line \"More Than Pizza\"), a restaurant at " +
    '100 Mirian Mepe St, Tbilisi, Georgia, that serves pizza and Middle Eastern food. The owner uses these names to find his ' +
    'videos, photos and sounds quickly, so a name must say plainly what is in the item. Rules: describe only what you can see - ' +
    'or, for a sound, what the measurements and the spectrogram show; never invent dish names, ingredients, prices, people\'s ' +
    'names, places or claims; when you are not sure what a dish is, describe it plainly (for example "wrap sliced on a board"); ' +
    'no emoji, no hashtags, no marketing words such as "delicious" or "amazing"; write in English.' +
    recommendations.promptBlock("\n\nThe owner's notes - use them when they help you name what you see:", ctx.notes);
  const oldName = cut(m.original_title || m.title || '', 160);
  const f = input.facts || {};
  const content = [];

  if (m.kind === 'sound') {
    if (input.spectrogram) content.push({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: input.spectrogram } });
    const lines = soundLines(f);
    const dur = Number(f.duration) || Number(f.analysed_s) || 0;
    content.push({
      type: 'text',
      text:
        'This is a sound in the library (' + (Math.round(dur * 10) / 10) + ' seconds' +
        (Number(f.analysed_s) && dur > Number(f.analysed_s) + 1 ? '; the first ' + Math.round(f.analysed_s) + ' seconds were measured' : '') + '). ' +
        (input.spectrogram
          ? 'You cannot hear it, so you get its spectrogram (left to right = time, a white tick every second and a taller one every ' +
            '5 seconds; bottom to top = pitch from 60 Hz to 8 kHz on a log scale, faint lines at 250 Hz, 1 kHz and 4 kHz; brighter = louder)' +
            ' and these measurements:\n'
          : 'You cannot hear it; these are its measurements:\n') +
        (lines.length ? lines.join('\n') : '- (no measurements - the sound was too short)') + '\n' +
        'Typical signs in the picture: a steady beat shows as evenly spaced vertical stripes; singing shows as wavy horizontal ' +
        'lines that hold; speech shows as short broken patches with gaps; sizzling or room noise shows as an even haze.\n' +
        (ctx.source ? 'It was taken from the video "' + ctx.source.title + '"' + (ctx.source.about ? ' - ' + ctx.source.about : '') + '.\n' : '') +
        'Its current name is "' + oldName + '" - often just a file name; use it only as a hint.\n\n' +
        'Write:\n' +
        '- title: at most 60 characters, what the sound is, plainly (for example "Upbeat music with a steady beat and singing", ' +
        '"Kitchen sizzle and voices", "Calm instrumental music"). Never name a song, an artist or a language unless the current ' +
        'name or the video says it.\n' +
        '- summary: one or two sentences; say what is clear and what is a guess.\n' +
        '- tags: 3 to 8 short lowercase tags (for example music, vocals, steady beat, upbeat, about 120 bpm, kitchen).\n' +
        '- sound_type, energy and confidence: your best reading.'
    });
    return { system, content, schema: SOUND_SCHEMA };
  }

  const isPhoto = m.kind === 'photo' || (!input.frames.length && input.image);
  if (isPhoto && input.image) {
    content.push({ type: 'image', source: { type: 'base64', media_type: input.image.type, data: input.image.data } });
  } else {
    input.frames.forEach((fr, i) => {
      if (fr.time !== undefined && fr.time !== null) content.push({ type: 'text', text: 'Frame ' + (i + 1) + ' - at ' + fr.time + ' s:' });
      content.push({ type: 'image', source: { type: 'base64', media_type: fr.type || 'image/jpeg', data: fr.data } });
    });
  }
  const audio = f.audio && f.audio.beat_bpm !== undefined
    ? ' Its soundtrack: ' + (f.audio.beat_strength >= 0.4 ? 'a clear beat (about ' + f.audio.beat_bpm + ' per minute)' : 'no strong beat') +
      ', ' + (f.audio.speech_rhythm >= 0.35 && f.audio.voice_band_share >= 0.5 ? 'possibly speech' : 'probably music or background sound') + ' (measured, not heard).'
    : '';
  const what = isPhoto
    ? 'This is a photo in the library' + (shape(f) ? ', ' + shape(f) : '') + '.'
    : 'These are ' + input.frames.length + ' frames, in order, from a ' + (Math.round((Number(f.duration) || 0) * 10) / 10) + '-second ' +
      (shape(f) || '') + ' video in the library' + (f.has_audio === false ? ', silent' : f.has_audio ? ', with sound' : '') + '.' + audio;
  content.push({
    type: 'text',
    text:
      what +
      (m.kind === 'rendered'
        ? ' It is a branded edit the system made: the captions and the Sam\'s logo were added by the system, so name it after the food and the scene, not the added text.'
        : '') +
      (ctx.harvested ? ' It was first posted on ' + ctx.harvested.platform + ' (' + ctx.harvested.views + ' views).' : '') +
      '\nIts current name is "' + oldName + '" - often just a file name or the first line of an old caption; use it only as a hint.' +
      (input.earlier ? '\nAn earlier description of it: "' + input.earlier + '"' : '') +
      '\n\nWrite:\n' +
      '- title: at most 60 characters, what the ' + (isPhoto ? 'photo' : 'video') + ' shows with the main subject first (for example ' +
      '"Hummus plated with chickpeas and olive oil, close-up" or "Pizza out of the oven and sliced").\n' +
      '- summary: one or two sentences - ' + (isPhoto ? 'what is in the picture.' : 'what happens, in order.') + '\n' +
      '- tags: 3 to 8 short lowercase tags - dishes, actions, place, shot type (for example hummus, plating, kitchen, close-up).\n' +
      '- content_type: the closest kind.\n' +
      '- on_screen_text: words that are visible, copied as written; empty if none.'
  });
  return { system, content, schema: VIDEO_SCHEMA };
}

function cleanResult(m, out, facts) {
  // Emoji go, with the invisible parts they are built from (variation
  // selectors, joiners, skin tones, keycaps, flag letters).
  let title = cut(String(out.title || '').replace(/[<>"#*_]/g, '')
    .replace(/[\p{Extended_Pictographic}\u{FE0E}\u{FE0F}\u{200D}\u{20E3}\u{1F3FB}-\u{1F3FF}\u{1F1E6}-\u{1F1FF}]/gu, ''), 80)
    .replace(/^[\s\-–—:·.,]+|[\s\-–—:·.,]+$/g, '');
  if (Array.from(title).length < 3) return null;
  if (m.kind === 'rendered' && /^✨/.test(String(m.original_title || m.title || ''))) title = '✨ ' + title;
  const tags = [...new Set((Array.isArray(out.tags) ? out.tags : [])
    .map((t) => cut(String(t).toLowerCase().replace(/^#+/, '').replace(/,/g, ' '), 30))
    .filter((t) => Array.from(t).length >= 2))].slice(0, 8);
  const more = {};
  for (const k of ['content_type', 'sound_type', 'energy', 'confidence']) if (typeof out[k] === 'string' && out[k]) more[k] = out[k];
  if (typeof out.on_screen_text === 'string' && out.on_screen_text.trim()) more.on_screen_text = cut(out.on_screen_text, 200);
  return {
    title,
    summary: cut(out.summary, 600) || null,
    tags: tags.length ? tags.join(', ') : null,
    facts: JSON.stringify(Object.assign({}, facts || {}, more)).slice(0, 4000)
  };
}

function enqueue(id) {
  id = Number(id);
  if (state.inQueue.has(id)) return;
  state.inQueue.add(id);
  state.queue.push(id);
  kick();
}

function kick() {
  if (state.running) return;
  state.running = true;
  (async () => {
    while (state.queue.length) {
      const id = state.queue.shift();
      state.current = id;
      try {
        await nameOne(id);
      } catch (err) {
        await fail(id, 'Naming error: ' + err.message).catch(() => {});
      } finally {
        state.inQueue.delete(id);
      }
    }
    state.current = null;
    state.running = false;
  })();
}

async function nameOne(id) {
  const rows = await db.query('SELECT * FROM media WHERE id = ?', [id]);
  if (rows === null) { state.lastError = 'database unavailable while naming #' + id; return; }
  if (!rows.length) { dropInput(id); return; }
  const m = rows[0];
  if (!['queued', 'working'].includes(m.ai_status)) { dropInput(id); return; } // called off meanwhile
  await db.query("UPDATE media SET ai_status = 'working' WHERE id = ?", [id]);
  const input = loadInput(m) || (m.kind === 'video' ? await inputFromPrep(m) : null);
  if (!input || (!input.frames.length && !input.image && !input.spectrogram && m.kind !== 'sound')) {
    await fail(id, 'Nothing to look at - press Analyze & name again');
    return;
  }
  const ctx = await context(m);
  const ask = buildAsk(m, input, ctx);
  const out = await claude.generateJSON({ system: ask.system, prompt: ask.content, schema: ask.schema, maxTokens: 2000, effort: 'low' });
  if (!out) {
    const why = claude.status().lastError;
    await fail(id, 'Claude could not name it' + (why ? ' (' + cut(why, 140) + ')' : ''));
    return;
  }
  const r = cleanResult(m, out, input.facts);
  if (!r) { await fail(id, 'Claude gave no usable name - press Analyze & name again'); return; }
  const upd = await db.query(
    "UPDATE media SET title = ?, ai_summary = ?, ai_tags = ?, ai_facts = ?, ai_status = 'done', ai_error = NULL," +
    " ai_named_at = NOW(), title_source = 'ai' WHERE id = ? AND ai_status = 'working'",
    [r.title, r.summary, r.tags, r.facts, id]
  );
  dropInput(id);
  if (!upd || !upd.affectedRows) return; // the owner typed a name meanwhile - his wins
  state.done++;
  // Its branded edits that wait for this name take it now.
  if (m.kind === 'video') {
    const edits = await db.query(
      "SELECT e.* FROM media_prep p JOIN media e ON e.id = p.output_media_id WHERE p.media_id = ? AND e.ai_status = 'queued'", [id]
    );
    const named = { id, title: r.title, ai_summary: r.summary, ai_tags: r.tags };
    for (const e of edits || []) await inherit(e, named);
  }
}

// ---------- the sweep ----------

async function sweep() {
  if (state.sweeping) return;
  state.sweeping = true;
  try {
    if (await autoOn()) {
      const from = await since();
      const fresh = from && await db.query(
        "SELECT id FROM media WHERE ai_status IS NULL AND title_source IS NULL AND created_at >= ?" +
        " AND kind IN ('video','rendered','photo','sound') ORDER BY FIELD(kind,'video','photo','rendered','sound'), id ASC LIMIT 10", [from]
      );
      for (const r of fresh || []) await request(r.id);
    }
    const waiting = await db.query("SELECT * FROM media WHERE ai_status IN ('queued','working') ORDER BY id ASC LIMIT 200");
    for (const m of waiting || []) {
      if (state.inQueue.has(Number(m.id))) continue;
      if (m.ai_status === 'working') {
        // A restart cut a naming short: try again from what is on disk.
        if (hasInput(m.id) || (m.kind === 'video' && prepFrames(m.id).length)) enqueue(m.id);
        else await fail(m.id, 'Interrupted - press Analyze & name again');
        continue;
      }
      await advance(m);
    }
    // Reports nobody needs any more (item removed, renamed by hand...).
    let dirs = [];
    try { dirs = fs.readdirSync(NAME_DIR); } catch { dirs = []; }
    for (const d of dirs) {
      if (!/^\d+$/.test(d) || state.inQueue.has(Number(d))) continue;
      const r = await db.query("SELECT id FROM media WHERE id = ? AND ai_status IN ('queued','working')", [Number(d)]);
      if (r && !r.length) dropInput(d);
    }
  } catch (err) {
    state.lastError = 'sweep: ' + err.message;
  } finally {
    state.sweeping = false;
  }
}

function start() {
  if (state.timers.length) return;
  state.timers.push(setTimeout(() => sweep(), 20 * 1000));
  state.timers.push(setInterval(() => sweep(), 60 * 1000));
}

async function status() {
  const counts = {};
  const rows = await db.query("SELECT COALESCE(ai_status, 'never') AS s, COUNT(*) AS n FROM media WHERE kind IN ('video','rendered','photo','sound') GROUP BY s");
  for (const r of rows || []) counts[r.s] = Number(r.n);
  const owner = await db.query("SELECT COUNT(*) AS n FROM media WHERE title_source = 'owner'");
  return {
    auto: await autoOn(),
    since: await since(),
    running: state.running,
    current: state.current,
    waiting_in_line: state.queue.length,
    named_this_run: state.done,
    failed_this_run: state.failed,
    last_error: state.lastError,
    counts,
    named_by_owner: owner && owner.length ? Number(owner[0].n) : 0
  };
}

async function setAuto(on) {
  const r = await setSetting(AUTO_KEY, on ? 'on' : 'off');
  if (r === null) return { status: 503, error: 'Database unavailable' };
  if (on) await since();
  return { status: 200, body: { ok: true, auto: !!on } };
}

module.exports = {
  request, requestMany, setTitle, saveInput, onJobStatus, status, setAuto, sweep, start,
  NAME_DIR,
  _buildAsk: buildAsk, // test harness
  _cleanResult: cleanResult, // test harness
  _state: state, // test harness
  _advance: advance // test harness
};
