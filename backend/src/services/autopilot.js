const fs = require('fs');
const path = require('path');
const db = require('../database/db');
const brandConfig = require('./brandConfig');
const claude = require('./claudeClient');
const publicRoute = require('./publicRoute');

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
const STUCK_WRITING_MS = 10 * 60 * 1000;
const ANALYZE_BLOCKS_WRITING_MS = 30 * 60 * 1000;

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

  // Frames: JPEG only, at most 6, each at most 600 KB.
  const frames = Array.isArray(payload.frames) ? payload.frames.slice(0, 6) : [];
  const dir = path.join(PREP_DIR, String(mediaId));
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  let kept = 0;
  for (const b64 of frames) {
    if (typeof b64 !== 'string') continue;
    const buf = Buffer.from(b64, 'base64');
    if (buf.length < 100 || buf.length > 600 * 1024 || buf[0] !== 0xff || buf[1] !== 0xd8) continue;
    fs.writeFileSync(path.join(dir, kept + '.jpg'), buf);
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
    frames: kept
  };

  if (duration < MIN_SECONDS) {
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
  note('video #' + mediaId + ': analysed (' + analysis.duration + ' s, ' + kept + ' frames' + (soundId ? ', sound #' + soundId + ' added to the circulation' : ', no usable sound') + ')');
  return { status: 200, body: { ok: true } };
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

async function writeCopy(prep, media) {
  const dir = path.join(PREP_DIR, String(prep.media_id));
  const frames = [];
  if (fs.existsSync(dir)) {
    for (const f of fs.readdirSync(dir).filter((n) => /^\d+\.jpg$/.test(n)).sort()) {
      frames.push(fs.readFileSync(path.join(dir, f)).toString('base64'));
    }
  }
  if (!frames.length) return { copy: fallbackCopy(media), writer: 'template' };

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
    ' The file name you are given is a hint at most and may be meaningless.';

  const content = frames.map((data) => ({
    type: 'image',
    source: { type: 'base64', media_type: 'image/jpeg', data }
  }));
  content.push({
    type: 'text',
    text:
      'These are ' + frames.length + ' frames, in order, from a ' + Math.round(analysis.duration || 0) +
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
      (cfg.music_notes ? ' Music approach (for context): ' + cfg.music_notes : '')
  });

  const out = await claude.generateJSON({ system, prompt: content, schema: COPY_SCHEMA, maxTokens: 4000, effort: 'medium' });
  if (!out) return { copy: fallbackCopy(media), writer: 'template' };

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
  return { copy, writer: 'claude' };
}

async function preparingCount() {
  const r = await db.query(
    "SELECT COUNT(*) AS n FROM media_prep p WHERE p.status IN ('writing','rendering')" +
    " OR (p.status = 'staged' AND EXISTS (SELECT 1 FROM publish_queue q WHERE q.prep_media_id = p.media_id AND q.status = 'pending_review'))"
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

  const next = await db.query("SELECT * FROM media_prep WHERE status = 'analyzed' ORDER BY media_id ASC LIMIT 1");
  if (!next || !next.length) return;
  const prep = next[0];
  const claim = await db.query("UPDATE media_prep SET status = 'writing' WHERE media_id = ? AND status = 'analyzed'", [prep.media_id]);
  if (!claim || !claim.affectedRows) return;

  const mediaRows = await db.query('SELECT * FROM media WHERE id = ?', [prep.media_id]);
  if (!mediaRows || !mediaRows.length) {
    await db.query("UPDATE media_prep SET status = 'failed', error = 'The library video was removed' WHERE media_id = ?", [prep.media_id]);
    return;
  }
  const media = mediaRows[0];
  note('video #' + prep.media_id + ': writing the hook and captions');

  const { copy, writer } = await writeCopy(prep, media);

  const analysis = JSON.parse(prep.analysis || '{}');
  let choice = prep.sound_choice || (String(cfg.sound_mode || 'rotate').toLowerCase() === 'own' ? 'own' : 'rotated');
  let sound = null;
  if (choice === 'rotated') {
    sound = await pickSound(prep);
    if (!sound) choice = 'own';
  }
  if (choice === 'own' && !analysis.has_audio) {
    // A silent video gets a circulated sound if there is one at all.
    sound = await pickSound(prep);
    if (sound) choice = 'rotated';
  }

  const params = {
    prep_media_id: prep.media_id,
    hook: copy.hook,
    end_line: copy.end_line,
    sound: choice,
    duration: analysis.duration,
    width: analysis.width,
    height: analysis.height,
    output_title: '✨ ' + cut(media.title || ('video #' + media.id), 120)
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
  note('video #' + prep.media_id + ': edit queued (' + (sound ? 'sound: ' + (sound.title || '#' + sound.id) : 'its own sound') + ')');
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
  // of this video meanwhile gets no second copy.
  const taken = await db.query(
    "SELECT DISTINCT platform FROM publish_queue WHERE media_id = ? AND prep_media_id IS NULL" +
    " AND status IN ('approved_publishing','publishing','published','unknown','in_drafts')",
    [prep.media_id]
  );
  const takenSet = new Set((taken || []).map((r) => r.platform));
  const staged = [];
  for (const platform of platforms) {
    if (takenSet.has(platform)) continue;
    const caption = platform === 'youtube' ? copy.youtube_description : copy[platform];
    if (!caption) continue;
    const opts = platform === 'youtube' ? JSON.stringify({ title: copy.youtube_title }) : null;
    const r = await db.query(
      "INSERT INTO publish_queue (platform, media_id, caption, status, post_options, prep_media_id) VALUES (?,?,?,'pending_review',?,?)",
      [platform, outputMediaId, String(caption).slice(0, CAPTION_LIMIT[platform]), opts, prep.media_id]
    );
    if (r && r.insertId) staged.push(platform);
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

async function tick() {
  state.loopTicks++;
  if (state.loopBusy) return;
  state.loopBusy = true;
  try {
    state.lastLoopAt = Date.now();
    if (!(await isOn())) return;
    await sweep();
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
  saveAnalysis, onJobStatus, prepareAgain, skip, forgetFrames,
  start, status, listPreps, handStaged, PREP_DIR,
  tick // exported for the test harness
};
