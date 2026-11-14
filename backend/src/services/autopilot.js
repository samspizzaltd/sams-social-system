const fs = require('fs');
const path = require('path');
const db = require('../database/db');
const brandConfig = require('./brandConfig');
const claude = require('./claudeClient');
const publicRoute = require('./publicRoute');
const trendSounds = require('./trendSounds');
const recommendations = require('./recommendations');

// Autopilot (owner request 2026-11-06): "I have provided you with many videos
// that are ready for publishing - add your magic when publishing them, and
// circulate the sounds that they have. And an on/off switch."
//
// What it does while the master switch is ON:
//  1. Every library video (kind 'video') that was never staged gets a
//     media_prep row and an 'Analyze' job for the render worker on the
//     owner's PC: it measures the video, grabs a few frames and pulls the
//     sound out into the Sound Library (media kind 'sound').
//  2. Once the Sound Library is complete for the batch, one prepared video at
//     a time is written up: Claude looks at the frames and writes the hook,
//     the end line and a caption per platform, and the next sound in the
//     circulation is picked (least-used first, never the same twice in a row).
//  3. A 'MagicCut' job renders the branded edit (hook, logo, end line, the
//     chosen sound baked in - platform APIs cannot attach in-app music).
//  4. The finished edit is staged in the publish queue as pending_review, one
//     row per connected platform. NOTHING publishes from here: every row still
//     waits for the owner's Approve (owner rule 2026-10-12). Approved
//     autopilot rows go out in the next free posting slot.
//
// The master switch also gates the publisher (scheduler.js): when OFF nothing
// is prepared and nothing is published; uploads already in flight are only
// watched to the end, because they cannot be called back.

const MEDIA_DIR = path.join(__dirname, '..', '..', '..', 'media');
// Frames live OUTSIDE the public media folder - they are working files.
const PREP_DIR = path.join(__dirname, '..', '..', '..', 'prep-frames');
const TBILISI_OFFSET_MS = 4 * 3600 * 1000; // Georgia has no DST
const CAPTION_LIMIT = { instagram: 2200, facebook_page: 5000, tiktok: 2200, youtube: 5000 };
const PLATFORMS = ['instagram', 'facebook_page', 'tiktok', 'youtube'];
const PLATFORM_SETTING = {
  instagram: 'platform_instagram_enabled',
  facebook_page: 'platform_facebook_enabled',
  tiktok: 'platform_tiktok_enabled',
  youtube: 'platform_youtube_enabled'
};
const MIN_SECONDS = 3; // Reels and TikTok both refuse anything shorter
const MIN_CLIP_SECONDS = 1; // shorter than this is no use even inside a montage
const STUCK_WRITING_MS = 10 * 60 * 1000;
const ANALYZE_BLOCKS_WRITING_MS = 30 * 60 * 1000;

// Montages (owner 2026-11-14): "when adding small video clips I expect the
// system to put them together to create a video that is viral, choose good
// sound and then recommend - not choose one video to publish and that's it."
// So while montages are on (default; branding montage_enabled = 'false' turns
// them off), a short upload of the owner's (not a harvested repost) is montage
// material: it is never written up and posted alone, and its own few seconds
// of audio (mostly kitchen noise) stay out of the sound circulation.
function montageOn(cfg) {
  return String((cfg && cfg.montage_enabled) || 'true').trim().toLowerCase() !== 'false';
}
function clipMaxSeconds(cfg) {
  const n = Number(cfg && cfg.montage_clip_max_seconds);
  return Number.isFinite(n) && n >= 3 && n <= 60 ? n : 20;
}
function analysedSeconds(analysis) {
  try {
    const a = typeof analysis === 'string' ? JSON.parse(analysis || '{}') : (analysis || {});
    const d = Number(a.duration);
    return Number.isFinite(d) ? d : null;
  } catch {
    return null;
  }
}
// kind/note of the library video + its measured length -> montage material?
function isClip(kind, note, seconds, cfg) {
  return montageOn(cfg) && kind === 'video' && !/^harvest:/.test(String(note || '')) &&
    seconds !== null && seconds <= clipMaxSeconds(cfg);
}

const state = {
  loopTicks: 0,
  loopBusy: false,
  lastLoopAt: null,
  workerSeenAt: null,
  activity: null,
  lastError: null
};

function note(msg) {
  state.activity = { at: new Date().toISOString(), text: msg };
  console.log('[autopilot] ' + msg);
}

// ---------- the master switch ----------

let onCache = { value: false, at: 0 };

// Read straight from the database with a 5 s cache - a kill switch must not
// lag a minute behind (brandConfig caches 60 s). Fails CLOSED: if the switch
// cannot be read, the system behaves as OFF.
async function isOn() {
  if (Date.now() - onCache.at < 5000) return onCache.value;
  const rows = await db.query("SELECT cfg_value FROM branding WHERE cfg_key = 'system_enabled'");
  const value = !!(rows && rows.length && String(rows[0].cfg_value).toLowerCase() === 'true');
  onCache = { value, at: Date.now() };
  return value;
}

async function setOn(enabled) {
  const r = await db.query(
    "INSERT INTO branding (cfg_key, cfg_value) VALUES ('system_enabled', ?) ON DUPLICATE KEY UPDATE cfg_value = VALUES(cfg_value)",
    [enabled ? 'true' : 'false']
  );
  if (r === null) return false;
  onCache = { value: !!enabled, at: Date.now() };
  brandConfig.invalidate();
  note('switched ' + (enabled ? 'ON' : 'OFF') + ' by the owner');
  return true;
}

function workerSeen() {
  state.workerSeenAt = Date.now();
}

// ---------- posting slots ----------

function parseSlots(text) {
  const out = [];
  for (const part of String(text || '').split(',')) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(part.trim());
    if (!m) continue;
    const h = Number(m[1]);
    const min = Number(m[2]);
    if (h > 23 || min > 59) continue;
    out.push(h * 60 + min);
  }
  const uniq = [...new Set(out)].sort((a, b) => a - b);
  return uniq.length ? uniq : [12 * 60 + 30, 19 * 60];
}

// Next posting slot (epoch ms) on `platform` that no other approved,
// publishing or published row already holds. One post per platform per slot.
async function nextFreeSlot(platform) {
  const cfg = await brandConfig.get();
  const slots = parseSlots(cfg.publish_slots);
  const now = Date.now();
  const taken = await db.query(
    "SELECT scheduled_at FROM publish_queue WHERE platform = ? AND scheduled_at IS NOT NULL AND scheduled_at > ?" +
    " AND status IN ('approved_publishing','publishing','published','unknown','in_drafts')",
    [platform, now - 3600 * 1000]
  );
  const held = new Set((taken || []).map((r) => Number(r.scheduled_at)));
  const tb = new Date(now + TBILISI_OFFSET_MS);
  for (let d = 0; d < 90; d++) {
    for (const minutes of slots) {
      const t = Date.UTC(tb.getUTCFullYear(), tb.getUTCMonth(), tb.getUTCDate() + d, 0, minutes) - TBILISI_OFFSET_MS;
      if (t <= now + 60 * 1000) continue;
      if (!held.has(t)) return t;
    }
  }
  return now; // 90 days fully booked - publish as soon as possible
}

// ---------- step 1: queue analysis of new library videos ----------

// Eligible (owner, 2026-11-06: "add your magic when publishing them"):
//  - a library video never staged, or
//  - one whose posts are only WAITING (pending_review / failed) - hand-staged
//    or harvested; its magic version replaces those waiting posts.
// Left alone unless the owner asks ("Add the magic" in the Library):
//  - anything already posted or on its way on any platform (no double posts),
//  - a video the owner dropped completely.
const ELIGIBLE_SQL =
  "FROM media m LEFT JOIN media_prep p ON p.media_id = m.id" +
  " WHERE m.kind = 'video' AND (m.url_path IS NOT NULL OR m.local_path IS NOT NULL) AND p.media_id IS NULL" +
  " AND NOT EXISTS (SELECT 1 FROM publish_queue q WHERE q.media_id = m.id" +
  "   AND q.status IN ('approved_publishing','publishing','published','unknown','in_drafts'))" +
  " AND (NOT EXISTS (SELECT 1 FROM publish_queue q WHERE q.media_id = m.id)" +
  "   OR EXISTS (SELECT 1 FROM publish_queue q WHERE q.media_id = m.id AND q.status IN ('pending_review','failed')))";

async function queueNewVideos() {
  const fresh = await db.query('SELECT m.id ' + ELIGIBLE_SQL + ' ORDER BY m.id ASC LIMIT 10');
  for (const row of fresh || []) {
    await db.query("INSERT IGNORE INTO media_prep (media_id, status) VALUES (?, 'queued')", [row.id]);
  }

  const queued = await db.query("SELECT media_id FROM media_prep WHERE status = 'queued' ORDER BY media_id ASC LIMIT 10");
  for (const p of queued || []) {
    const job = await db.query(
      "INSERT INTO render_jobs (template, params, media_ids, status) VALUES ('Analyze', ?, ?, 'queued')",
      [JSON.stringify({ prep_media_id: p.media_id }), String(p.media_id)]
    );
    if (!job || !job.insertId) continue;
    const flip = await db.query(
      "UPDATE media_prep SET status = 'analyzing', analyze_job_id = ?, error = NULL WHERE media_id = ? AND status = 'queued'",
      [job.insertId, p.media_id]
    );
    if (!flip || !flip.affectedRows) {
      // Lost a race (deploy overlap): the orphan job is harmless - its
      // analysis is ignored because the job id will not match - but remove it.
      await db.query("DELETE FROM render_jobs WHERE id = ? AND status = 'queued'", [job.insertId]);
      continue;
    }
    note('video #' + p.media_id + ': analysis queued for the render worker');
  }
}

// ---------- worker callback: analysis results ----------

// payload: {job_id, media_id, duration, width, height, has_audio, frames[], sound_media_id}
async function saveAnalysis(payload) {
  const mediaId = Number(payload.media_id);
  const jobId = Number(payload.job_id);
  if (!Number.isInteger(mediaId) || !Number.isInteger(jobId)) return { status: 400, error: 'media_id and job_id required' };

  const rows = await db.query('SELECT status, analyze_job_id FROM media_prep WHERE media_id = ?', [mediaId]);
  if (rows === null) return { status: 503, error: 'Database unavailable' };
  if (!rows.length) return { status: 404, error: 'No preparation for that video' };
  if (rows[0].status !== 'analyzing' || Number(rows[0].analyze_job_id) !== jobId) {
    return { status: 409, error: 'That analysis is no longer wanted (video was reset or skipped)' };
  }

  const duration = Number(payload.duration);
  const width = Number(payload.width) || null;
  const height = Number(payload.height) || null;
  if (!Number.isFinite(duration) || duration <= 0) return { status: 400, error: 'duration missing' };

  // Frames: JPEG only, at most 10, each at most 600 KB. Since 2026-11-11 the
  // worker also says WHEN each frame is (frame_times, seconds) - the writer
  // plans the cuts and the text timing from them.
  const frames = Array.isArray(payload.frames) ? payload.frames.slice(0, 10) : [];
  const times = Array.isArray(payload.frame_times) ? payload.frame_times : [];
  const dir = path.join(PREP_DIR, String(mediaId));
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  let kept = 0;
  const keptTimes = [];
  for (let i = 0; i < frames.length; i++) {
    const b64 = frames[i];
    if (typeof b64 !== 'string') continue;
    const buf = Buffer.from(b64, 'base64');
    if (buf.length < 100 || buf.length > 600 * 1024 || buf[0] !== 0xff || buf[1] !== 0xd8) continue;
    fs.writeFileSync(path.join(dir, kept + '.jpg'), buf);
    const t = Number(times[i]);
    keptTimes.push(Number.isFinite(t) && t >= 0 && t <= duration + 1 ? Math.round(t * 10) / 10 : null);
    kept++;
  }

  let soundId = null;
  if (payload.sound_media_id) {
    const s = await db.query("SELECT id FROM media WHERE id = ? AND kind = 'sound'", [Number(payload.sound_media_id)]);
    if (s && s.length) soundId = s[0].id;
  }

  const analysis = {
    duration: Math.round(duration * 100) / 100,
    width,
    height,
    has_audio: !!payload.has_audio,
    frames: kept,
    frame_times: keptTimes.every((t) => t !== null) ? keptTimes : null
  };

  const cfg = await brandConfig.get();
  const mrow = await db.query('SELECT kind, note FROM media WHERE id = ?', [mediaId]);
  const clip = !!(mrow && mrow.length) && isClip(mrow[0].kind, mrow[0].note, analysis.duration, cfg);
  // A montage clip's own audio does not join the circulation (see montageOn).
  if (clip && soundId) await db.query('UPDATE media SET circulate = 0 WHERE id = ?', [soundId]);

  if (duration < (clip ? MIN_CLIP_SECONDS : MIN_SECONDS)) {
    await db.query(
      "UPDATE media_prep SET status = 'skipped', analysis = ?, own_sound_id = ?, error = ? WHERE media_id = ? AND status = 'analyzing'",
      [JSON.stringify(analysis), soundId, 'Too short (' + analysis.duration + ' s) - Reels and TikTok need at least 3 seconds', mediaId]
    );
    return { status: 200, body: { ok: true, skipped: true } };
  }

  const upd = await db.query(
    "UPDATE media_prep SET status = 'analyzed', analysis = ?, own_sound_id = ?, error = NULL WHERE media_id = ? AND status = 'analyzing' AND analyze_job_id = ?",
    [JSON.stringify(analysis), soundId, mediaId, jobId]
  );
  if (upd === null) return { status: 503, error: 'Database unavailable' };
  if (!upd.affectedRows) return { status: 409, error: 'Preparation changed state - analysis ignored' };
  note('video #' + mediaId + ': analysed (' + analysis.duration + ' s, ' + kept + ' frames' +
    (clip ? ') - a short clip, kept for a montage' : (soundId ? ', sound #' + soundId + ' added to the circulation' : ', no usable sound') + ')'));
  return { status: 200, body: { ok: true, ...(clip ? { montage_clip: true } : {}) } };
}

// ---------- sound circulation ----------

// Least-used sound in circulation first; never the sound the previous edit
// used; prefer a sound from ANOTHER video so sounds travel between videos.
async function pickSound(prep) {
  const pool = await db.query(
    "SELECT m.id, m.title," +
    " (SELECT COUNT(*) FROM media_prep p WHERE p.sound_media_id = m.id AND p.sound_choice = 'rotated' AND p.status NOT IN ('failed','skipped')) AS uses" +
    " FROM media m WHERE m.kind = 'sound' AND m.circulate = 1 AND m.url_path IS NOT NULL ORDER BY m.id ASC"
  );
  if (!pool || !pool.length) return null;
  const last = await db.query(
    "SELECT sound_media_id FROM media_prep WHERE sound_media_id IS NOT NULL AND media_id <> ? ORDER BY updated_at DESC LIMIT 1",
    [prep.media_id]
  );
  const lastId = last && last.length ? Number(last[0].sound_media_id) : null;
  const ownId = prep.own_sound_id ? Number(prep.own_sound_id) : null;

  let candidates = pool.filter((s) => Number(s.id) !== lastId);
  if (!candidates.length) candidates = pool;
  const others = candidates.filter((s) => Number(s.id) !== ownId);
  if (others.length) candidates = others;
  candidates.sort((a, b) => Number(a.uses) - Number(b.uses) || Number(a.id) - Number(b.id));
  return candidates[0];
}

// What the writer may choose from for this video's sound (owner 2026-11-11:
// the system follows his Recommendations when it picks sounds). The hard rules
// stay here, in code - the same ones pickSound() applies: never the sound the
// previous edit used, a sound from ANOTHER video first (circulation), the
// owner's own "remake with its own / the next sound" choice wins, and a silent
// video gets a sound whenever there is one. In rotate mode the video's own
// audio is offered only when one of his sound recommendations could call for it.
// Instagram trending sounds: approved ones that trended in the last week
// (trendSounds.js) - Instagram adds the licensed track to the Instagram post.
async function soundOptions(prep, analysis, cfg, soundRecs) {
  const pool = (await db.query(
    "SELECT m.id, m.title," +
    " (SELECT COUNT(*) FROM media_prep p WHERE p.sound_media_id = m.id AND p.sound_choice = 'rotated' AND p.status NOT IN ('failed','skipped')) AS uses," +
    " (SELECT p2.copy_json FROM media_prep p2 WHERE p2.own_sound_id = m.id LIMIT 1) AS from_copy" +
    " FROM media m WHERE m.kind = 'sound' AND m.circulate = 1 AND m.url_path IS NOT NULL ORDER BY m.id ASC"
  )) || [];
  const last = await db.query(
    "SELECT sound_media_id FROM media_prep WHERE sound_media_id IS NOT NULL AND media_id <> ? ORDER BY updated_at DESC LIMIT 1",
    [prep.media_id]
  );
  const lastId = last && last.length ? Number(last[0].sound_media_id) : null;
  const ownId = prep.own_sound_id ? Number(prep.own_sound_id) : null;
  let rotation = pool.filter((s) => Number(s.id) !== lastId);
  if (!rotation.length) rotation = pool;
  const others = rotation.filter((s) => Number(s.id) !== ownId);
  if (others.length) rotation = others;

  // Real Instagram views per post for each sound (services/metrics.js).
  const perf = (await db.query(
    "SELECT p.sound_media_id AS sid, COUNT(*) AS posts, ROUND(AVG(pm.views)) AS avg_views" +
    " FROM publish_queue q JOIN media_prep p ON p.media_id = q.prep_media_id JOIN post_metrics pm ON pm.queue_id = q.id" +
    " WHERE q.status = 'published' AND q.platform = 'instagram' AND p.sound_media_id IS NOT NULL AND pm.views IS NOT NULL" +
    ' GROUP BY p.sound_media_id'
  )) || [];
  const perfBy = new Map(perf.map((r) => [Number(r.sid), r]));
  const describe = (s) => {
    let shows = '';
    try { shows = JSON.parse(s.from_copy || '{}').what_it_shows || ''; } catch { shows = ''; }
    const p = perfBy.get(Number(s.id));
    return {
      id: Number(s.id),
      title: s.title || 'sound #' + s.id,
      from: cut(shows, 160),
      uses: Number(s.uses) || 0,
      ig_posts: p ? Number(p.posts) : 0,
      ig_avg_views: p && p.avg_views != null ? Number(p.avg_views) : null
    };
  };

  const hasAudio = !!analysis.has_audio;
  const explicit = prep.sound_choice === 'own' || prep.sound_choice === 'rotated' ? prep.sound_choice : null;
  const ownMode = String(cfg.sound_mode || 'rotate').toLowerCase() === 'own';
  let allowOwn;
  let allowRotation;
  if (!hasAudio) {
    allowRotation = rotation.length > 0;
    allowOwn = !allowRotation;
  } else if (explicit === 'own' || (ownMode && explicit !== 'rotated')) {
    allowOwn = true;
    allowRotation = false;
  } else if (explicit === 'rotated') {
    allowRotation = rotation.length > 0;
    allowOwn = !allowRotation;
  } else {
    allowRotation = rotation.length > 0;
    allowOwn = !allowRotation || !!(soundRecs && soundRecs.length);
  }

  const trends = (await trendSounds.approvedFresh(10)) || [];
  return {
    hasAudio,
    allowOwn,
    rotation: allowRotation ? rotation.map(describe) : [],
    trends: trends.map((t) => ({
      audio_id: String(t.audio_id), title: t.title, artist: t.artist, audio_type: t.audio_type,
      badge: t.badge, age_hours: t.age_hours, uses: Number(t.uses) || 0, watch_terms: t.watch_terms || []
    }))
  };
}

const TREND_WORDS = {
  just_started: 'just started trending', climbing: 'climbing', holding: 'still trending', fading: 'fading', gone: 'no longer trending',
  watch: 'found by the owner\'s watch list'
};

// The writer's output schema for this video: the copy, plus the sound picks
// limited (enum) to what soundOptions() allows.
function copySchema(opts) {
  const s = JSON.parse(JSON.stringify(COPY_SCHEMA));
  if (!opts || !opts.sound) return s;
  const soundEnum = (opts.sound.allowOwn ? ['own'] : []).concat(opts.sound.rotation.map((r) => String(r.id)));
  s.properties.sound_pick = { type: 'string', enum: soundEnum.length ? soundEnum : ['own'] };
  s.properties.instagram_sound_pick = { type: 'string', enum: ['none'].concat(opts.sound.trends.map((t) => t.audio_id)) };
  s.properties.sound_reason = { type: 'string' };
  // Edit plan + two more hook pairs (editBrief). No numeric limits here -
  // structured outputs do not take them; cleanPlan() enforces the limits.
  const num = { type: 'number' };
  const str = { type: 'string' };
  const extra = {
    alt_hook_1: str, alt_end_line_1: str, alt_hook_2: str, alt_end_line_2: str,
    cut_1_start: num, cut_1_end: num, cut_2_start: num, cut_2_end: num, cut_3_start: num, cut_3_end: num,
    hook_start: num, hook_end: num, end_line_start: num, hold_end: num, edit_plan_note: str
  };
  Object.assign(s.properties, extra);
  s.required = s.required.concat(['sound_pick', 'instagram_sound_pick', 'sound_reason'], Object.keys(extra));
  return s;
}

// The sound part of the writer's brief.
function soundBrief(opts) {
  const o = opts.sound;
  const lines = ['', 'SOUND - pick ONE for this video (sound_pick):'];
  if (o.allowOwn) lines.push('- "own": keep the video\'s own audio' + (o.hasAudio ? '' : ' (this video is silent)'));
  for (const r of o.rotation) {
    lines.push('- "' + r.id + '": ' + r.title + (r.from ? ' - taken from a video showing: ' + r.from : '') +
      '; used ' + r.uses + ' time(s)' +
      (r.ig_posts ? '; Instagram posts with it averaged ' + r.ig_avg_views + ' views (' + r.ig_posts + ' post(s))' : ''));
  }
  if (o.allowOwn && o.rotation.length) {
    lines.push('Default to one of the circulated sounds (the owner wants sounds to travel between videos); pick "own" only when his sound recommendations call for it.');
  }
  lines.push('', 'INSTAGRAM TRENDING SOUND (instagram_sound_pick) - optional, for the Instagram post only: Instagram adds this licensed track on top of the video. Pick "none" or one id:');
  if (!o.trends.length) lines.push('- (none approved right now - pick "none")');
  for (const t of o.trends) {
    lines.push('- "' + t.audio_id + '": "' + (t.title || 'untitled') + '"' + (t.artist ? ' by ' + t.artist : '') +
      ' (' + (t.audio_type === 'original_sound' ? 'original sound' : 'music') + '; ' + (TREND_WORDS[t.badge] || t.badge) +
      (t.badge === 'just_started' ? ' ' + Math.round(t.age_hours) + ' h ago' : '') +
      (t.watch_terms && t.watch_terms.length ? '; matches the owner\'s watch list: ' + t.watch_terms.join(', ') : '') +
      '; used on ' + t.uses + ' of our posts)');
  }
  if (o.trends.length) lines.push('Prefer a sound that just started trending or is climbing and fits the mood of the video; pick "none" if none fits or the recommendations say so.');
  lines.push('', recommendations.promptBlock("The owner's sound recommendations:", opts.recs.sounds) || 'The owner has no sound recommendations yet.');
  lines.push('sound_reason: one short sentence for the owner saying why you picked these sounds.');
  return lines.join('\n');
}

// ---------- step 2: the copywriter ----------

const COPY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['what_it_shows', 'hook', 'end_line', 'instagram', 'facebook_page', 'tiktok', 'youtube_title', 'youtube_description'],
  properties: {
    what_it_shows: { type: 'string' },
    hook: { type: 'string' },
    end_line: { type: 'string' },
    instagram: { type: 'string' },
    facebook_page: { type: 'string' },
    tiktok: { type: 'string' },
    youtube_title: { type: 'string' },
    youtube_description: { type: 'string' }
  }
};

const cut = (s, max) => Array.from(String(s || '').trim()).slice(0, max).join('').trim();
const noAngles = (s) => String(s || '').replace(/[<>]/g, '');

function fallbackCopy(media) {
  const title = String(media.title || '').replace(/\.(mp4|mov|webm)$/i, '').replace(/[_-]+/g, ' ').trim();
  // Phone and app file names ("IMG 1234", "WhatsApp Video 2026 01 03 at…")
  // say nothing - only a title with real words is worth using.
  const cameraName = /^(img|vid|video|pxl|mvimg|dsc|mov|whatsapp|screen|screenshot|snapchat|telegram|inshot|capcut|signal)\b/i.test(title) ||
    /\d{4}/.test(title) || !/[a-zა-ჿЀ-ӿ؀-ۿ]{3,}/i.test(title);
  const useful = title && !cameraName ? title : "Fresh from Sam's kitchen";
  const caption = useful + "\n\n📍 Sam's, 100 Mirian Mepe St, Tbilisi\n#tbilisi #tbilisifood #samspizza";
  return {
    what_it_shows: '(Claude was unavailable - template captions, please edit before approving)',
    hook: '',
    end_line: '100 Mirian Mepe St', // the lockup under it already says Sam's
    instagram: caption,
    facebook_page: caption,
    tiktok: caption,
    youtube_title: cut(noAngles(useful), 90) + ' #Shorts',
    youtube_description: noAngles(caption)
  };
}

// opts (optional): { sound: soundOptions(), recs: {captions, editing, sounds} }
// - with it the writer also picks the sound(s) and follows the owner's
// Recommendations. Returns { copy, writer, picks } (picks null = no pick made).
async function writeCopy(prep, media, opts) {
  const dir = path.join(PREP_DIR, String(prep.media_id));
  const frames = [];
  if (fs.existsSync(dir)) {
    for (const f of fs.readdirSync(dir).filter((n) => /^\d+\.jpg$/.test(n)).sort()) {
      frames.push(fs.readFileSync(path.join(dir, f)).toString('base64'));
    }
  }
  if (!frames.length) return { copy: fallbackCopy(media), writer: 'template', picks: null };

  const cfg = await brandConfig.get();
  const analysis = JSON.parse(prep.analysis || '{}');
  const voice = await brandConfig.voiceLine();
  const audience = await brandConfig.audienceLine();
  const style = await brandConfig.styleLine();

  const system =
    "You write social media posts for Sam's (Sam's Pizza Ltd, brand line \"More Than Pizza\"), a restaurant at " +
    '100 Mirian Mepe St, Tbilisi, Georgia. ' + voice + ' ' + audience + (style ? ' ' + style : '') +
    ' Hard rules: describe ONLY what is visible in the frames. Never invent prices, discounts, offers, opening hours,' +
    ' delivery promises, awards, rankings or ingredients you cannot see. No "best in Tbilisi" style claims.' +
    ' The file name you are given is a hint at most and may be meaningless.' +
    (opts && opts.recs
      ? (() => {
        const lines = [...new Set([].concat(opts.recs.editing || [], opts.recs.captions || []))];
        const block = recommendations.promptBlock(
          "\n\nThe owner's recommendations for the hook, end line and captions - follow them unless they break a hard rule above:", lines);
        return block || '';
      })()
      : '');

  // Each frame is labelled with its time, so the writer can plan the edit.
  const times = frameTimes(analysis, frames.length);
  const content = [];
  frames.forEach((data, i) => {
    if (times) content.push({ type: 'text', text: 'Frame ' + (i + 1) + ' - at ' + times[i] + ' s:' });
    content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data } });
  });
  content.push({
    type: 'text',
    text:
      'These are ' + frames.length + ' frames, in order, from a ' + (Math.round((analysis.duration || 0) * 10) / 10) +
      '-second vertical video Sam\'s wants to post as a Reel / TikTok / YouTube Short. File name: "' +
      cut(media.title || '', 120) + '".\n\n' +
      'Write:\n' +
      '- what_it_shows: one plain sentence for the owner describing the video.\n' +
      '- hook: on-screen text for the first 2-3 seconds, max 6 words, makes people stop scrolling. No hashtags, no emoji.\n' +
      '- end_line: on-screen text for the last 3 seconds, max 6 words (e.g. an invitation to come by). No hashtags.\n' +
      '- instagram: the Instagram caption - a strong first line, 1-3 short lines, then 4-7 relevant hashtags (include #tbilisi).\n' +
      '- facebook_page: the Facebook caption - friendly, 1-3 short lines, at most 3 hashtags.\n' +
      '- tiktok: the TikTok caption - short and punchy, then 3-6 hashtags (include #tbilisi and #fyp).\n' +
      '- youtube_title: max 90 characters, ends with #Shorts.\n' +
      '- youtube_description: 1-3 lines plus the address line "Sam\'s - 100 Mirian Mepe St, Tbilisi".\n' +
      'Write in English unless the style notes say otherwise.' +
      (cfg.music_notes ? ' Music approach (for context): ' + cfg.music_notes : '') +
      (opts && opts.sound ? '\n' + editBrief(analysis, times) + '\n' + soundBrief(opts) : '')
  });

  const out = await claude.generateJSON({ system, prompt: content, schema: copySchema(opts), maxTokens: 4000, effort: 'medium' });
  if (!out) return { copy: fallbackCopy(media), writer: 'template', picks: null };

  const copy = {
    what_it_shows: cut(out.what_it_shows, 300),
    hook: cut(out.hook, 60),
    end_line: cut(out.end_line, 48),
    instagram: cut(out.instagram, CAPTION_LIMIT.instagram),
    facebook_page: cut(out.facebook_page, CAPTION_LIMIT.facebook_page),
    tiktok: cut(out.tiktok, CAPTION_LIMIT.tiktok),
    youtube_title: cut(noAngles(out.youtube_title).replace(/\s+/g, ' '), 100),
    youtube_description: cut(noAngles(out.youtube_description), 4900)
  };
  for (const k of ['instagram', 'facebook_page', 'tiktok', 'youtube_title', 'youtube_description']) {
    if (!copy[k]) copy[k] = fallbackCopy(media)[k];
  }
  if (opts && opts.sound) {
    // Three hook + end-line pairs: the best one goes into the edit, the owner
    // can switch to another in the review (usePair).
    const alts = [[out.alt_hook_1, out.alt_end_line_1], [out.alt_hook_2, out.alt_end_line_2]]
      .map(([h, e]) => ({ hook: cut(h, 60), end_line: cut(e, 48) }))
      .filter((p) => p.hook && p.end_line && !(p.hook === copy.hook && p.end_line === copy.end_line));
    copy.hook_options = [{ hook: copy.hook, end_line: copy.end_line }].concat(alts);
    copy.chosen_pair = 0;
  }
  const picks = opts && opts.sound
    ? { sound: String(out.sound_pick || ''), instagram: String(out.instagram_sound_pick || ''), reason: cut(out.sound_reason, 240), plan: out }
    : null;
  return { copy, writer: 'claude', picks };
}

// When each frame was taken. The 2026-11-11 worker sends the times; older
// analyses had 4 frames at fixed points of the video.
function frameTimes(analysis, count) {
  if (Array.isArray(analysis.frame_times) && analysis.frame_times.length === count) return analysis.frame_times;
  const d = Number(analysis.duration) || 0;
  if (count === 4 && d > 0) return [0.12, 0.38, 0.62, 0.88].map((f) => Math.round(d * f * 10) / 10);
  return null;
}

// The edit-plan part of the writer's brief (owner 2026-11-11: "a timestamped
// edit plan showing where to cut, when the text appears, when to reveal the
// payoff, and how long to hold the closing shot", and three hook + end-line
// pairs). The numbers are checked by cleanPlan() before anything uses them.
function editBrief(analysis, times) {
  const d = Math.round((Number(analysis.duration) || 0) * 10) / 10;
  return [
    '',
    'EDIT PLAN - the original video is ' + d + ' s long' + (times ? ' (the frame times are above)' : '') + '. Plan the edit:',
    '- cut_1_start/cut_1_end, cut_2_start/cut_2_end, cut_3_start/cut_3_end: the parts of the ORIGINAL video to KEEP, in order, in seconds (use -1 for both numbers of a part you do not need). ' +
      'Cut slow starts, shaky or empty moments; keep the food at its best; when you are not sure a moment is weak, keep it. The edit must stay at least 5 s long. ' +
      'To keep the whole video: cut_1 = 0 to ' + d + ' and the other parts -1.',
    '- On the EDITED video (after the cuts): hook_start and hook_end - the hook shows for 1.5-3 s right at the start; ' +
      'end_line_start - when the payoff and the end line appear (usually the last 2-4 s); hold_end - 0 to 2.5 s to hold the closing shot still at the very end.',
    '- edit_plan_note: one or two short sentences for the owner - what you cut and why, and where the payoff is.',
    'HOOK OPTIONS: hook + end_line are your BEST pair (they go into the edit). alt_hook_1 + alt_end_line_1 and alt_hook_2 + alt_end_line_2 are two more, clearly different pairs. ' +
      'Each end line pays off its own hook. Same rules for all six: max 6 words, no hashtags, no emoji.'
  ].join('\n');
}

const round1 = (n) => Math.round(n * 10) / 10;

// The writer's edit plan, made safe: parts inside the video, in order, not
// overlapping, at least 1 s each and together at least 5 s (else the whole
// video), a hold of at most 2.5 s, and text times that fit the edited length.
// null = no usable plan (the edit then keeps the standard timing).
function cleanPlan(out, analysis) {
  const d = Number(analysis && analysis.duration) || 0;
  if (!out || !(d > 0)) return null;
  const max = round1(Math.max(0, d - 0.1)); // the last kept frame must exist
  const segs = [[out.cut_1_start, out.cut_1_end], [out.cut_2_start, out.cut_2_end], [out.cut_3_start, out.cut_3_end]]
    .map(([a, b]) => [Number(a), Number(b)])
    .filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b) && a >= 0 && b > a)
    .map(([a, b]) => [round1(Math.max(0, a)), round1(Math.min(max, b))])
    .filter(([a, b]) => b - a >= 1)
    .sort((x, y) => x[0] - y[0]);
  const merged = [];
  for (const s of segs) {
    const last = merged[merged.length - 1];
    if (last && s[0] <= last[1] + 0.2) last[1] = Math.max(last[1], s[1]);
    else merged.push([s[0], s[1]]);
  }
  const kept = round1(merged.reduce((n, s) => n + (s[1] - s[0]), 0));
  const whole = !merged.length || kept < Math.min(5, d * 0.6) ||
    (merged.length === 1 && merged[0][0] <= 0.3 && merged[0][1] >= max - 0.3);
  const parts = whole ? [[0, max]] : merged;
  const keptLen = whole ? max : kept;
  const holdRaw = Number(out.hold_end);
  const hold = Number.isFinite(holdRaw) ? Math.min(2.5, Math.max(0, round1(holdRaw))) : 0;
  const total = round1(keptLen + hold);
  if (total < 3 || total > 180) return null;
  const hsRaw = Number(out.hook_start);
  const hs = Number.isFinite(hsRaw) ? Math.min(1.5, Math.max(0, round1(hsRaw))) : 0;
  const heRaw = Number(out.hook_end);
  let he = Number.isFinite(heRaw) ? round1(heRaw) : hs + 2.8;
  he = round1(Math.min(Math.max(he, hs + 1.2), hs + 3.5, total * 0.6));
  const esRaw = Number(out.end_line_start);
  let es = Number.isFinite(esRaw) ? round1(esRaw) : total - 3;
  es = round1(Math.min(Math.max(es, he + 1), total - 1.5));
  if (es < he + 0.5) es = round1(Math.max(he + 0.5, total - 1.5));
  return {
    cut: !whole,
    segments: parts.map(([from, to]) => ({ from, to })),
    hold,
    hook_start: hs,
    hook_end: he,
    end_start: es,
    duration: total,
    note: cut(out.edit_plan_note, 300)
  };
}

// Prepared videos the owner has not looked at yet (the review buffer). A video
// counts while it is being written/rendered, or staged with posts waiting for
// review and NONE of its posts approved yet - so a video that is already out
// on some platforms (e.g. a YouTube post sent back for its visibility choice,
// youtubeReturn.js) does not hold up the next library videos.
async function preparingCount() {
  const r = await db.query(
    "SELECT COUNT(*) AS n FROM media_prep p WHERE p.status IN ('writing','rendering')" +
    " OR (p.status = 'staged' AND EXISTS (SELECT 1 FROM publish_queue q WHERE q.prep_media_id = p.media_id AND q.status = 'pending_review')" +
    "   AND NOT EXISTS (SELECT 1 FROM publish_queue q2 WHERE q2.prep_media_id = p.media_id" +
    "     AND q2.status IN ('approved_publishing','publishing','published','unknown','in_drafts')))"
  );
  return r && r.length ? Number(r[0].n) : null;
}

async function writeNext() {
  // Wait until every queued video has been analysed, so the Sound Library is
  // complete and the circulation has every sound to choose from.
  const analyzing = await db.query(
    "SELECT COUNT(*) AS n FROM media_prep WHERE status IN ('queued','analyzing') AND updated_at > NOW() - INTERVAL 30 MINUTE"
  );
  if (!analyzing || Number(analyzing[0].n) > 0) return;

  const cfg = await brandConfig.get();
  const buffer = Math.max(1, Math.min(30, Number(cfg.autoprep_buffer) || 5));
  const inFlight = await preparingCount();
  if (inFlight === null || inFlight >= buffer) return;

  // The next analysed video - short clips wait for a montage instead (montageOn).
  const next = await db.query(
    "SELECT p.*, m.kind AS m_kind, m.note AS m_note FROM media_prep p LEFT JOIN media m ON m.id = p.media_id" +
    " WHERE p.status = 'analyzed' ORDER BY p.media_id ASC LIMIT 300"
  );
  const prep = (next || []).find((p) => {
    const s = analysedSeconds(p.analysis);
    // under 3 s = only ever montage material (kept for when montages are on)
    return !isClip(p.m_kind, p.m_note, s, cfg) && (s === null || s >= MIN_SECONDS);
  });
  if (!prep) return;
  const claim = await db.query("UPDATE media_prep SET status = 'writing' WHERE media_id = ? AND status = 'analyzed'", [prep.media_id]);
  if (!claim || !claim.affectedRows) return;

  const mediaRows = await db.query('SELECT * FROM media WHERE id = ?', [prep.media_id]);
  if (!mediaRows || !mediaRows.length) {
    await db.query("UPDATE media_prep SET status = 'failed', error = 'The library video was removed' WHERE media_id = ?", [prep.media_id]);
    return;
  }
  const media = mediaRows[0];
  note('video #' + prep.media_id + ': writing the hook and captions');

  const analysis = JSON.parse(prep.analysis || '{}');
  const recs = {
    captions: await recommendations.forArea('captions'),
    editing: await recommendations.forArea('editing'),
    sounds: await recommendations.forArea('sounds')
  };
  const options = await soundOptions(prep, analysis, cfg, recs.sounds);
  const { copy, writer, picks } = await writeCopy(prep, media, { sound: options, recs });

  // The writer's sound pick, checked against what was offered. Without a
  // valid pick (Claude unavailable) the rotation rules decide, as before.
  let choice = null;
  let sound = null;
  const offered = new Map(options.rotation.map((r) => [String(r.id), r]));
  if (picks && picks.sound === 'own' && options.allowOwn) {
    choice = 'own';
  } else if (picks && offered.has(picks.sound)) {
    choice = 'rotated';
    sound = { id: offered.get(picks.sound).id, title: offered.get(picks.sound).title };
  }
  if (!choice) {
    choice = prep.sound_choice || (String(cfg.sound_mode || 'rotate').toLowerCase() === 'own' ? 'own' : 'rotated');
    if (choice === 'rotated') {
      sound = await pickSound(prep);
      if (!sound) choice = 'own';
    }
    if (choice === 'own' && !analysis.has_audio) {
      // A silent video gets a circulated sound if there is one at all.
      sound = await pickSound(prep);
      if (sound) choice = 'rotated';
    }
  }

  // Instagram trending sound (approved by the owner; Instagram adds the
  // licensed track to the Instagram post only - trendSounds.js).
  const trendById = new Map(options.trends.map((t) => [t.audio_id, t]));
  let igTrend = null;
  if (picks) {
    if (picks.instagram && picks.instagram !== 'none' && trendById.has(picks.instagram)) igTrend = trendById.get(picks.instagram);
  } else {
    // No writer pick: the freshest approved sound that just started or climbs.
    igTrend = options.trends.find((t) => t.badge === 'just_started' || t.badge === 'climbing') || null;
  }
  if (igTrend) copy.ig_audio = { audio_id: igTrend.audio_id, title: igTrend.title, artist: igTrend.artist, audio_type: igTrend.audio_type };
  if (picks && picks.reason) copy.sound_reason = picks.reason;

  // The writer's edit plan, checked (cleanPlan). Cuts and a held closing shot
  // go to MagicCut as segments; the text times apply either way.
  const plan = picks ? cleanPlan(picks.plan, analysis) : null;
  if (plan) copy.edit_plan = plan;
  const params = {
    prep_media_id: prep.media_id,
    hook: copy.hook,
    end_line: copy.end_line,
    sound: choice,
    duration: plan ? plan.duration : analysis.duration,
    width: analysis.width,
    height: analysis.height,
    output_title: '✨ ' + cut(media.title || ('video #' + media.id), 120),
    ...(plan ? { hook_start: plan.hook_start, hook_end: plan.hook_end, end_start: plan.end_start } : {}),
    ...(plan && (plan.cut || plan.hold > 0) ? { segments: plan.segments, hold: plan.hold } : {})
  };
  const mediaIds = [prep.media_id].concat(sound ? [sound.id] : []).join(',');
  const job = await db.query(
    "INSERT INTO render_jobs (template, params, media_ids, status) VALUES ('MagicCut', ?, ?, 'queued')",
    [JSON.stringify(params), mediaIds]
  );
  if (!job || !job.insertId) {
    await db.query("UPDATE media_prep SET status = 'analyzed' WHERE media_id = ? AND status = 'writing'", [prep.media_id]);
    return;
  }
  await db.query(
    "UPDATE media_prep SET status = 'rendering', render_job_id = ?, sound_media_id = ?, sound_choice = ?, copy_json = ?, writer = ?, error = NULL" +
    " WHERE media_id = ? AND status = 'writing'",
    [job.insertId, sound ? sound.id : null, choice, JSON.stringify(copy), writer, prep.media_id]
  );
  note('video #' + prep.media_id + ': edit queued (' + (sound ? 'sound: ' + (sound.title || '#' + sound.id) : 'its own sound') +
    (copy.ig_audio ? '; Instagram: trending "' + (copy.ig_audio.title || copy.ig_audio.audio_id) + '"' : '') + ')');
}

// ---------- worker callback: a job finished ----------

async function connectedPlatforms() {
  const cfg = await brandConfig.get();
  const rows = await db.query(
    "SELECT DISTINCT platform FROM accounts WHERE status = 'active' AND platform IN ('instagram','facebook_page','tiktok','youtube')"
  );
  const active = new Set((rows || []).map((r) => r.platform));
  return PLATFORMS.filter((p) => active.has(p) && String(cfg[PLATFORM_SETTING[p]] || '').toLowerCase() !== 'false');
}

async function stage(prep, outputMediaId) {
  const copy = JSON.parse(prep.copy_json || '{}');
  const platforms = await connectedPlatforms();
  // A platform where the owner already approved (or posted) the raw version
  // of this video meanwhile - or an earlier autopilot version of it (a remake
  // after some posts were approved) - gets no second copy.
  const taken = await db.query(
    "SELECT DISTINCT platform FROM publish_queue WHERE ((media_id = ? AND prep_media_id IS NULL) OR prep_media_id = ?)" +
    " AND status IN ('approved_publishing','publishing','published','unknown','in_drafts')",
    [prep.media_id, prep.media_id]
  );
  const takenSet = new Set((taken || []).map((r) => r.platform));
  const staged = [];
  for (const platform of platforms) {
    if (takenSet.has(platform)) continue;
    const caption = platform === 'youtube' ? copy.youtube_description : copy[platform];
    if (!caption) continue;
    let opts = null;
    if (platform === 'youtube') opts = JSON.stringify({ title: copy.youtube_title });
    const igAudio = platform === 'instagram' && copy.ig_audio && copy.ig_audio.audio_id ? copy.ig_audio : null;
    if (igAudio) {
      opts = JSON.stringify({
        ig_audio: Object.assign({}, igAudio, {
          audio_volume: 100,
          // MagicCut mutes the clip when it lays a circulated sound under it,
          // so then the edit's own track is music - keep it low under the trend.
          video_volume: prep.sound_choice === 'own' ? 35 : 10,
          fallback: true
        })
      });
    }
    const r = await db.query(
      "INSERT INTO publish_queue (platform, media_id, caption, status, post_options, prep_media_id) VALUES (?,?,?,'pending_review',?,?)",
      [platform, outputMediaId, String(caption).slice(0, CAPTION_LIMIT[platform]), opts, prep.media_id]
    );
    if (r && r.insertId) {
      staged.push(platform);
      if (igAudio) await trendSounds.markUsed(igAudio.audio_id);
    }
  }
  if (staged.length) {
    // The raw version's waiting posts (hand-staged or harvested) give way.
    await db.query(
      "UPDATE publish_queue SET status = 'dropped', error = 'replaced by the autopilot version'" +
      " WHERE media_id = ? AND prep_media_id IS NULL AND status IN ('pending_review','failed')",
      [prep.media_id]
    );
  }
  const err = platforms.length ? null : 'No platform is connected - connect one in Settings → Platform Connections, then press "Prepare again"';
  await db.query('UPDATE media_prep SET error = ? WHERE media_id = ?', [err, prep.media_id]);
  note('video #' + prep.media_id + ': ready for your review on ' + (staged.length ? staged.join(', ') : 'no platform'));
}

async function onJobStatus(jobId, status, outputMediaId, error) {
  jobId = Number(jobId);
  if (!Number.isInteger(jobId)) return;
  try {
    if (status === 'failed') {
      await db.query(
        "UPDATE media_prep SET status = 'failed', error = ? WHERE analyze_job_id = ? AND status = 'analyzing'",
        ['Analysis failed on the PC: ' + String(error || 'unknown error').slice(0, 900), jobId]
      );
      await db.query(
        "UPDATE media_prep SET status = 'failed', error = ? WHERE render_job_id = ? AND status = 'rendering'",
        ['Edit failed on the PC: ' + String(error || 'unknown error').slice(0, 900), jobId]
      );
      return;
    }
    if (status !== 'done') return;
    // The worker posts the analysis BEFORE marking the job done; a job that
    // finished while its prep still waits for analysis lost that call.
    await db.query(
      "UPDATE media_prep SET status = 'failed', error = 'The analysis never reached the server - press Prepare again' WHERE analyze_job_id = ? AND status = 'analyzing'",
      [jobId]
    );
    const rows = await db.query("SELECT * FROM media_prep WHERE render_job_id = ? AND status = 'rendering'", [jobId]);
    if (!rows || !rows.length) return;
    const out = Number(outputMediaId);
    if (!Number.isInteger(out) || out < 1) {
      await db.query("UPDATE media_prep SET status = 'failed', error = 'The edit finished without a video' WHERE media_id = ?", [rows[0].media_id]);
      return;
    }
    const claim = await db.query(
      "UPDATE media_prep SET status = 'staged', output_media_id = ? WHERE media_id = ? AND status = 'rendering' AND render_job_id = ?",
      [out, rows[0].media_id, jobId]
    );
    if (!claim || !claim.affectedRows) return;
    await stage(rows[0], out);
  } catch (err) {
    state.lastError = 'job hook: ' + err.message;
    console.warn('[autopilot] job hook failed: ' + err.message);
  }
}

// ---------- owner actions ----------

// Make a fresh version of one video (optionally forcing its own sound or the
// next circulated one). Pending rows of the old version are withdrawn; rows
// already approved or published are left alone.
async function prepareAgain(mediaId, sound) {
  const rows = await db.query('SELECT * FROM media_prep WHERE media_id = ?', [mediaId]);
  if (rows === null) return { status: 503, error: 'Database unavailable' };
  const choice = sound === 'own' ? 'own' : sound === 'rotate' ? 'rotated' : null;
  if (!rows.length) {
    const m = await db.query("SELECT id FROM media WHERE id = ? AND kind = 'video'", [mediaId]);
    if (!m || !m.length) return { status: 404, error: 'Not a library video' };
    const ins = await db.query("INSERT IGNORE INTO media_prep (media_id, status, sound_choice) VALUES (?, 'queued', ?)", [mediaId, choice]);
    if (ins === null) return { status: 503, error: 'Database unavailable' };
    // Its raw waiting posts stay until the prepared version is ready - then
    // stage() replaces them.
    return { status: 200, body: { ok: true, status: 'queued' } };
  }
  const p = rows[0];
  if (['writing', 'rendering', 'analyzing'].includes(p.status)) {
    return { status: 409, error: 'This video is being worked on right now - try again when it is ready' };
  }
  await db.query(
    "UPDATE publish_queue SET status = 'dropped', error = 'replaced by a newer version' WHERE prep_media_id = ? AND status = 'pending_review'",
    [mediaId]
  );
  const hasFrames = fs.existsSync(path.join(PREP_DIR, String(mediaId)));
  const nextStatus = p.analysis && hasFrames ? 'analyzed' : 'queued';
  await db.query(
    'UPDATE media_prep SET status = ?, sound_choice = ?, render_job_id = NULL, output_media_id = NULL, error = NULL WHERE media_id = ?',
    [nextStatus, choice, mediaId]
  );
  return { status: 200, body: { ok: true, status: nextStatus } };
}

// The owner picks another of the writer's hook + end-line pairs: the same
// edit (sound, cuts, timing) is rendered again with that text - no new
// writing - and the waiting posts are replaced when it is ready. Refused once
// any post of this version is approved or out (a new version would post twice).
async function usePair(mediaId, index) {
  const i = Number(index);
  const rows = await db.query('SELECT * FROM media_prep WHERE media_id = ?', [mediaId]);
  if (rows === null) return { status: 503, error: 'Database unavailable' };
  if (!rows.length) return { status: 404, error: 'No preparation for that video' };
  const p = rows[0];
  if (p.status !== 'staged') return { status: 409, error: 'This video is not waiting for review right now - try again when it is ready' };
  let copy = {};
  try { copy = JSON.parse(p.copy_json || '{}'); } catch { copy = {}; }
  const options = Array.isArray(copy.hook_options) ? copy.hook_options : [];
  if (!Number.isInteger(i) || i < 0 || i >= options.length) return { status: 400, error: 'No such hook option' };
  if (Number(copy.chosen_pair || 0) === i) return { status: 409, error: 'That pair is already in the video' };
  const out = await db.query(
    "SELECT COUNT(*) AS n FROM publish_queue WHERE prep_media_id = ? AND status IN ('approved_publishing','publishing','published','unknown','in_drafts')",
    [mediaId]
  );
  if (out === null) return { status: 503, error: 'Database unavailable' };
  if (Number(out[0].n) > 0) return { status: 409, error: 'Some posts of this video are already approved or out - a new version would post twice' };
  const job = await db.query('SELECT params, media_ids FROM render_jobs WHERE id = ?', [p.render_job_id]);
  if (!job || !job.length) return { status: 409, error: 'The last edit job is gone - use Remake instead' };
  let params = {};
  try { params = JSON.parse(job[0].params || '{}'); } catch { params = {}; }
  params.hook = options[i].hook;
  params.end_line = options[i].end_line;
  copy.hook = options[i].hook;
  copy.end_line = options[i].end_line;
  copy.chosen_pair = i;
  const ins = await db.query(
    "INSERT INTO render_jobs (template, params, media_ids, status) VALUES ('MagicCut', ?, ?, 'queued')",
    [JSON.stringify(params), job[0].media_ids]
  );
  if (!ins || !ins.insertId) return { status: 503, error: 'Database unavailable' };
  const upd = await db.query(
    "UPDATE media_prep SET status = 'rendering', render_job_id = ?, output_media_id = NULL, copy_json = ?, error = NULL WHERE media_id = ? AND status = 'staged'",
    [ins.insertId, JSON.stringify(copy), mediaId]
  );
  if (!upd || !upd.affectedRows) return { status: 409, error: 'The video changed meanwhile - reload' };
  await db.query(
    "UPDATE publish_queue SET status = 'dropped', error = 'replaced by a newer version' WHERE prep_media_id = ? AND status = 'pending_review'",
    [mediaId]
  );
  note('video #' + mediaId + ': re-editing with hook option ' + (i + 1));
  return { status: 200, body: { ok: true, status: 'rendering' } };
}

async function skip(mediaId) {
  // Works in every state: an edit still being written or rendered simply
  // finishes into the library unused (its job hook only acts on 'rendering').
  const rows = await db.query('SELECT status FROM media_prep WHERE media_id = ?', [mediaId]);
  if (rows === null) return { status: 503, error: 'Database unavailable' };
  if (rows.length) {
    await db.query("UPDATE media_prep SET status = 'skipped', error = 'Skipped by the owner' WHERE media_id = ?", [mediaId]);
  } else {
    await db.query("INSERT IGNORE INTO media_prep (media_id, status, error) VALUES (?, 'skipped', 'Skipped by the owner')", [mediaId]);
  }
  await db.query(
    "UPDATE publish_queue SET status = 'dropped', error = 'video skipped by the owner' WHERE prep_media_id = ? AND status = 'pending_review'",
    [mediaId]
  );
  return { status: 200, body: { ok: true, status: 'skipped' } };
}

function forgetFrames(mediaId) {
  fs.rmSync(path.join(PREP_DIR, String(Number(mediaId))), { recursive: true, force: true });
}

// ---------- the loop ----------

async function sweep() {
  // A writer that died mid-call (restart) goes back to the start of its step.
  await db.query(
    "UPDATE media_prep SET status = 'analyzed' WHERE status = 'writing' AND updated_at < NOW() - INTERVAL 10 MINUTE"
  );
  // Jobs the owner deleted from the Render Queue must not strand a prep.
  await db.query(
    "UPDATE media_prep p LEFT JOIN render_jobs r ON r.id = p.analyze_job_id SET p.status = 'queued'" +
    " WHERE p.status = 'analyzing' AND r.id IS NULL"
  );
  await db.query(
    "UPDATE media_prep p LEFT JOIN render_jobs r ON r.id = p.render_job_id SET p.status = 'analyzed'" +
    " WHERE p.status = 'rendering' AND r.id IS NULL"
  );
}

// One-time (2026-11-14, montages): sounds already taken from short clips leave
// the circulation - a few seconds of kitchen noise is not a sound to post with.
// The owner can put any of them back in the Sound Library.
async function clipSoundsOffOnce() {
  const cfg = await brandConfig.get();
  if (!montageOn(cfg)) return;
  const done = await db.query("SELECT cfg_value FROM branding WHERE cfg_key = 'montage_clip_sounds_off'");
  if (done === null || done.length) return;
  // Only the clips uploaded from 14 Nov 2026 on (the first batch of clips) -
  // older uploads were ready-made videos whose music the owner may want.
  const rows = await db.query(
    "SELECT p.own_sound_id, p.analysis, m.kind, m.note FROM media_prep p JOIN media m ON m.id = p.media_id" +
    " WHERE p.own_sound_id IS NOT NULL AND m.created_at >= '2026-11-13 18:00:00'"
  );
  if (rows === null) return;
  const ids = [...new Set(rows.filter((r) => isClip(r.kind, r.note, analysedSeconds(r.analysis), cfg)).map((r) => Number(r.own_sound_id)))];
  if (ids.length) {
    const upd = await db.query('UPDATE media SET circulate = 0 WHERE kind = \'sound\' AND id IN (' + ids.map(() => '?').join(',') + ')', ids);
    if (upd === null) return;
  }
  await db.query(
    "INSERT INTO branding (cfg_key, cfg_value) VALUES ('montage_clip_sounds_off', ?) ON DUPLICATE KEY UPDATE cfg_value = VALUES(cfg_value)",
    [JSON.stringify({ at: new Date().toISOString(), sounds: ids.length })]
  );
  if (ids.length) note(ids.length + ' sounds taken from short clips left the sound circulation (kitchen noise - montages get music)');
}

async function tick() {
  state.loopTicks++;
  if (state.loopBusy) return;
  state.loopBusy = true;
  try {
    state.lastLoopAt = Date.now();
    if (!(await isOn())) return;
    await sweep();
    await clipSoundsOffOnce();
    await queueNewVideos();
    await writeNext();
  } catch (err) {
    state.lastError = err.message;
    console.warn('[autopilot] tick failed: ' + err.message);
  } finally {
    state.loopBusy = false;
  }
}

function start() {
  setInterval(tick, 60 * 1000);
  setTimeout(tick, 15 * 1000);
  console.log('[autopilot] loop running (does nothing while the master switch is OFF)');
}

// ---------- dashboard status ----------

async function count(sql, params) {
  const r = await db.query(sql, params || []);
  return r && r.length ? Number(r[0].n) : null;
}

async function status(schedulerStatus) {
  const cfg = await brandConfig.get();
  const on = await isOn();
  const switchRow = await db.query("SELECT updated_at FROM branding WHERE cfg_key = 'system_enabled'");
  // Posts for a platform that does not show this system's posts publicly yet
  // wait (publicRoute.js): they are counted apart, never as "scheduled".
  const routes = await publicRoute.routes();
  const waitingFor = await publicRoute.waitingPlatforms(routes);
  const goesOut = waitingFor.length
    ? ' AND (q.creation_id IS NOT NULL OR q.platform NOT IN (' + waitingFor.map(() => '?').join(',') + '))'
    : '';
  const nextUp = await db.query(
    "SELECT q.id, q.platform, q.scheduled_at, m.title AS media_title FROM publish_queue q LEFT JOIN media m ON m.id = q.media_id" +
    " WHERE q.status = 'approved_publishing'" + goesOut + ' ORDER BY COALESCE(q.scheduled_at, 0) ASC, q.id ASC LIMIT 1',
    waitingFor
  );
  const waitingRows = waitingFor.length
    ? await db.query(
      "SELECT platform, COUNT(*) AS n FROM publish_queue WHERE status = 'approved_publishing' AND creation_id IS NULL" +
      ' AND platform IN (' + waitingFor.map(() => '?').join(',') + ') GROUP BY platform',
      waitingFor
    )
    : [];
  const waitingRoute = {};
  for (const r of waitingRows || []) waitingRoute[r.platform] = Number(r.n);
  const last = await db.query(
    "SELECT id, platform, permalink, published_at FROM publish_queue WHERE status = 'published' ORDER BY published_at DESC, id DESC LIMIT 1"
  );
  const connected = await connectedPlatforms();
  const now = Date.now();
  return {
    enabled: on,
    changed_at: switchRow && switchRow.length ? switchRow[0].updated_at : null,
    server_time: new Date(now).toISOString(),
    publisher_last_tick_s: schedulerStatus && schedulerStatus.lastFinisherTickAt
      ? Math.round((now - schedulerStatus.lastFinisherTickAt) / 1000) : null,
    worker_last_seen_s: state.workerSeenAt ? Math.round((now - state.workerSeenAt) / 1000) : null,
    claude: claude.status().available,
    connected,
    // connected platforms that do not show this system's posts publicly yet
    waiting_platforms: connected.filter((p) => waitingFor.includes(p)),
    // how each platform's posts go out: direct | drafts (TikTok) | wait
    routes,
    settings: {
      publish_slots: parseSlots(cfg.publish_slots).map((m) => String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0')),
      sound_mode: String(cfg.sound_mode || 'rotate'),
      autoprep_buffer: Number(cfg.autoprep_buffer) || 5
    },
    counts: {
      library_waiting: await count('SELECT COUNT(*) AS n ' + ELIGIBLE_SQL),
      analysed_waiting: await count("SELECT COUNT(*) AS n FROM media_prep WHERE status = 'analyzed'"),
      preparing: await count("SELECT COUNT(*) AS n FROM media_prep WHERE status IN ('queued','analyzing','writing','rendering')"),
      failed: await count("SELECT COUNT(*) AS n FROM media_prep WHERE status = 'failed'"),
      awaiting_review: await count("SELECT COUNT(*) AS n FROM publish_queue WHERE status = 'pending_review'"),
      scheduled: await count("SELECT COUNT(*) AS n FROM publish_queue q WHERE q.status = 'approved_publishing'" + goesOut, waitingFor),
      // {tiktok: n, youtube: m} - approved posts waiting for the platform to
      // allow public posting from this system (see publicRoute.js)
      waiting_route: waitingRoute,
      // in the owner's TikTok drafts, waiting for him to post them in the app
      in_drafts: await count("SELECT COUNT(*) AS n FROM publish_queue WHERE status = 'in_drafts'"),
      publishing: await count("SELECT COUNT(*) AS n FROM publish_queue WHERE status = 'publishing'"),
      published_24h: await count("SELECT COUNT(*) AS n FROM publish_queue WHERE status = 'published' AND published_at > NOW() - INTERVAL 1 DAY"),
      published_total: await count("SELECT COUNT(*) AS n FROM publish_queue WHERE status = 'published'"),
      sounds_circulating: await count("SELECT COUNT(*) AS n FROM media WHERE kind = 'sound' AND circulate = 1")
    },
    next_up: nextUp && nextUp.length ? nextUp[0] : null,
    last_published: last && last.length ? last[0] : null,
    activity: state.activity,
    last_error: state.lastError
  };
}

// Library videos that sit in the publish queue without the autopilot
// (staged by hand or harvested) - the Library offers "Add the magic" on them.
async function handStaged() {
  const rows = await db.query(
    "SELECT q.media_id," +
    " MAX(q.status IN ('approved_publishing','publishing','published','unknown','in_drafts')) AS out_or_going," +
    " MAX(q.status IN ('pending_review','failed')) AS waiting" +
    " FROM publish_queue q JOIN media m ON m.id = q.media_id LEFT JOIN media_prep p ON p.media_id = q.media_id" +
    " WHERE m.kind = 'video' AND p.media_id IS NULL GROUP BY q.media_id"
  );
  const posted = [];
  const dropped = [];
  for (const r of rows || []) {
    if (Number(r.out_or_going)) posted.push(Number(r.media_id));
    else if (!Number(r.waiting)) dropped.push(Number(r.media_id));
  }
  return { posted, dropped };
}

async function listPreps() {
  return db.query(
    "SELECT p.media_id, p.status, p.error, p.writer, p.sound_choice, p.sound_media_id, p.own_sound_id, p.output_media_id," +
    " p.copy_json, p.analysis, p.updated_at, m.title AS media_title, s.title AS sound_title, s.url_path AS sound_url" +
    " FROM media_prep p LEFT JOIN media m ON m.id = p.media_id LEFT JOIN media s ON s.id = p.sound_media_id" +
    " ORDER BY p.media_id DESC LIMIT 300"
  );
}

module.exports = {
  isOn, setOn, workerSeen, nextFreeSlot, parseSlots,
  saveAnalysis, onJobStatus, prepareAgain, usePair, skip, forgetFrames,
  start, status, listPreps, handStaged, PREP_DIR,
  tick, // exported for the test harness
  _preparingCount: preparingCount, // test harness
  _cleanPlan: cleanPlan // test harness
};
