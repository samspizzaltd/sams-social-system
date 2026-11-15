const fs = require('fs');
const path = require('path');
const db = require('../database/db');
const brandConfig = require('./brandConfig');
const claude = require('./claudeClient');
const recommendations = require('./recommendations');
const trendSounds = require('./trendSounds');
const dayparts = require('./dayparts');

// Montages (owner 2026-11-14): "when adding small video clips I expect the
// system to put them together to create a video that is viral, choose good
// sound and then recommend - not choose one video to publish and that's it."
//
//  1. A short upload of the owner's (isClip) is analysed like any library
//     video (frames + its sound), then waits here instead of being posted alone.
//  2. When enough clips wait and none is still being analysed, Claude picks
//     the next montage from their descriptions (Analyze & name): 4-8 clips that
//     belong together, in story order (the eye-catcher first, the payoff last),
//     and a music track from the Sound Library that fits.
//  3. Claude then sees frames of each chosen clip (with their times), picks the
//     best moment of each and writes the hook, three hook pairs and captions.
//  4. cleanPlan() makes it safe: each moment inside its clip and 0.8-3.5 s
//     long, lengths snapped to the music's beat, 5-30 s in all and never
//     longer than the music.
//  5. A media row of kind 'montage' + its media_prep row carry it through the
//     usual MagicCut render and staging: the owner reviews and approves it like
//     any prepared video. NOTHING publishes from here. The clips' preps are
//     marked 'in_montage' (montage_id) and are never posted on their own.

const PREP_DIR = path.join(__dirname, '..', '..', '..', 'prep-frames');
const MIN_CLIPS = 4;
const MAX_CLIPS = 8;
const MIN_PART = 0.8; // seconds of one clip in the montage
const MAX_PART = 3.5;
const MIN_TOTAL = 5;
const MAX_TOTAL = 30;
const MIN_MUSIC_SECONDS = 8;
const MAX_CANDIDATES = 60; // clips described to the picker
const FRAMES_PER_CLIP = 2;
const PAUSE_AFTER_FAILURE_MS = 6 * 3600 * 1000;
const CAPTION_LIMIT = { instagram: 2200, facebook_page: 5000, tiktok: 2200, youtube: 5000 };
const MUSIC_TYPES = ['instrumental_music', 'music_with_vocals'];

const cut = (s, max) => Array.from(String(s || '').trim()).slice(0, max).join('').trim();
const noAngles = (s) => String(s || '').replace(/[<>]/g, '');
const round2 = (n) => Math.round(n * 100) / 100;
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), Math.max(lo, hi));

function note(msg) {
  console.log('[montage] ' + msg);
}

// ---------- what counts as a clip ----------

function montageOn(cfg) {
  return String((cfg && cfg.montage_enabled) || 'true').trim().toLowerCase() !== 'false';
}
// 30 s: phone clips run long sometimes (the 14 Nov batch had a 25 s one) and
// the owner wants every clip in a montage, never posted alone.
const CLIP_MAX_DEFAULT = 30;
function clipMaxSeconds(cfg) {
  const n = Number(cfg && cfg.montage_clip_max_seconds);
  return Number.isFinite(n) && n >= 3 && n <= 60 ? n : CLIP_MAX_DEFAULT;
}
// Montages began with the clips uploaded on 14 Nov 2026. Older uploads were
// ready-made videos: the sweep never takes those back (not even ones whose
// posts the owner dropped) and their sounds stay as they were.
const MONTAGE_ERA = '2026-11-13 18:00:00';
function parseJson(text, fallback) {
  try { return typeof text === 'string' ? JSON.parse(text || 'null') || fallback : (text || fallback); } catch { return fallback; }
}
function analysedSeconds(analysis) {
  const a = parseJson(analysis, {});
  const d = Number(a && a.duration);
  return Number.isFinite(d) ? d : null;
}
// kind/note of the library video + its measured length -> montage material?
function isClip(kind, note_, seconds, cfg) {
  return montageOn(cfg) && kind === 'video' && !/^harvest:/.test(String(note_ || '')) &&
    seconds !== null && seconds <= clipMaxSeconds(cfg);
}

// ---------- the clips waiting, and the music ----------

async function waitingClips(cfg) {
  const rows = await db.query(
    "SELECT p.media_id, p.analysis, m.kind, m.note, m.title, m.ai_summary, m.ai_tags, m.created_at" +
    " FROM media_prep p JOIN media m ON m.id = p.media_id WHERE p.status = 'analyzed' ORDER BY p.media_id ASC LIMIT 500"
  );
  if (rows === null) return null;
  return rows.map((r) => {
    const a = parseJson(r.analysis, {});
    return {
      media_id: Number(r.media_id),
      duration: Number(a.duration) || 0,
      width: Number(a.width) || null,
      height: Number(a.height) || null,
      has_audio: !!a.has_audio,
      frame_times: Array.isArray(a.frame_times) ? a.frame_times : null,
      kind: r.kind,
      note: r.note,
      title: cut(r.title, 120),
      summary: cut(r.ai_summary, 300),
      tags: cut(r.ai_tags, 200),
      created_at: r.created_at
    };
  }).filter((c) => isClip(c.kind, c.note, c.duration, cfg) && c.duration >= MIN_PART + 0.05 && framesOf(c.media_id).length);
}

function framesOf(mediaId) {
  const dir = path.join(PREP_DIR, String(mediaId));
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((n) => /^\d+\.jpg$/.test(n)).sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
}

// Music the montage can be cut to: circulating sounds the Sound Library knows
// are music (Analyze & name facts) and that last long enough. Owner
// 2026-11-15: not the same track on every montage - the tracks the latest
// videos were cut to are left out (while others remain), least used first.
// minSeconds: only tracks at least this long (a new sound for a finished cut).
async function musicOptions(minSeconds, raw) {
  const rows = await db.query(
    "SELECT m.id, m.title, m.ai_facts, m.ai_tags," +
    " (SELECT COUNT(*) FROM media_prep p WHERE p.sound_media_id = m.id AND p.status NOT IN ('failed','skipped')) AS uses" +
    " FROM media m WHERE m.kind = 'sound' AND m.circulate = 1 AND m.url_path IS NOT NULL ORDER BY m.id ASC"
  );
  if (!rows) return [];
  const perf = (await db.query(
    "SELECT p.sound_media_id AS sid, COUNT(*) AS posts, ROUND(AVG(pm.views)) AS avg_views" +
    " FROM publish_queue q JOIN media_prep p ON p.media_id = q.prep_media_id JOIN post_metrics pm ON pm.queue_id = q.id" +
    " WHERE q.status = 'published' AND p.sound_media_id IS NOT NULL AND pm.views IS NOT NULL GROUP BY p.sound_media_id"
  )) || [];
  const perfBy = new Map(perf.map((r) => [Number(r.sid), r]));
  const out = [];
  for (const r of rows) {
    const f = parseJson(r.ai_facts, {}) || {};
    const seconds = Number(f.duration);
    if (!MUSIC_TYPES.includes(f.sound_type) || !(seconds >= MIN_MUSIC_SECONDS)) continue;
    const p = perfBy.get(Number(r.id));
    out.push({
      id: Number(r.id),
      title: cut(r.title, 100) || 'sound #' + r.id,
      seconds: round2(seconds),
      bpm: Number(f.beat_bpm) > 0 ? Math.round(Number(f.beat_bpm)) : null,
      beat_strength: Number(f.beat_strength) || 0,
      energy: f.energy || null,
      sound_type: f.sound_type,
      uses: Number(r.uses) || 0,
      posts: p ? Number(p.posts) : 0,
      avg_views: p && p.avg_views != null ? Number(p.avg_views) : null
    });
  }
  if (raw) return out;
  let list = minSeconds ? out.filter((m) => m.seconds >= minSeconds) : out;
  if (!list.length) list = out;
  const recent = await dayparts.recentMusic(3);
  const fresh = list.filter((m) => !recent.has(m.id));
  if (fresh.length) list = fresh;
  // least used first, then a clear beat and energy
  const energy = { upbeat: 2, medium: 1 };
  list.sort((a, b) => a.uses - b.uses || (energy[b.energy] || 0) - (energy[a.energy] || 0) || b.beat_strength - a.beat_strength);
  return list.slice(0, 15);
}

// ---------- the plan, made safe ----------

// One beat (or two, when the tempo reads double-time) - the length every part
// of the montage is a whole multiple of, so the cuts land on the music.
function beatUnit(music) {
  const bpm = music && Number(music.bpm);
  if (!(bpm >= 40 && bpm <= 240) || !(Number(music.beat_strength) >= 0.15)) return null;
  let unit = 60 / bpm;
  while (unit < 0.45) unit *= 2;
  return unit;
}

// clips: the chosen clips in montage order ({media_id, duration});
// moments: [{clip_id, start, end}] from the editor (may be missing/bad);
// music: musicOptions() entry or null. Returns null when no usable montage.
function cleanPlan(clips, moments, music) {
  const byId = new Map((Array.isArray(moments) ? moments : []).map((m) => [String(m && m.clip_id), m]));
  const unit = beatUnit(music);
  let segs = [];
  for (const c of clips) {
    const max = round2(Math.max(0, (Number(c.duration) || 0) - 0.05)); // the last frame must exist
    if (max < MIN_PART) continue;
    const m = byId.get(String(c.media_id));
    let from = m ? Number(m.start) : NaN;
    let to = m ? Number(m.end) : NaN;
    if (!(Number.isFinite(from) && Number.isFinite(to) && to > from)) {
      const len = Math.min(2.2, max); // no usable moment: the middle of the clip
      from = (max - len) / 2;
      to = from + len;
    }
    from = clamp(from, 0, max - MIN_PART);
    to = clamp(to, from + MIN_PART, Math.min(max, from + MAX_PART));
    let len = to - from;
    if (unit) {
      let n = Math.max(1, Math.round(len / unit));
      while (n > 1 && n * unit > MAX_PART + 1e-6) n--;
      while (n > 1 && n * unit > max + 1e-6) n--;
      while (n * unit < MIN_PART - 1e-6 && (n + 1) * unit <= Math.min(max, MAX_PART) + 1e-6) n++;
      len = Math.min(n * unit, max);
      if (from + len > max) from = Math.max(0, max - len); // keep the moment, slide back to fit
    }
    segs.push({ media_id: Number(c.media_id), from: round2(from), to: round2(from + len) });
  }
  if (segs.length < 3) return null;

  // The end line needs ~3 s over the last shot: hold its last frame for the rest.
  const lenOf = (s) => s.to - s.from;
  const holdFor = (list) => round2(Math.min(1.5, Math.max(0, 2.8 - lenOf(list[list.length - 1]))));
  const totalOf = (list) => round2(list.reduce((n, s) => n + lenOf(s), 0) + holdFor(list));
  const limit = Math.min(MAX_TOTAL, music ? Math.max(MIN_TOTAL, Number(music.seconds) - 0.2) : MAX_TOTAL);
  // Too long for the music / the platforms: drop shots from the middle, keep
  // the opener and the payoff.
  while (totalOf(segs) > limit && segs.length > 3) segs.splice(segs.length - 2, 1);
  if (totalOf(segs) > limit) {
    // still too long with three shots: shorten them (whole beats when on a beat)
    segs = segs.map((s) => {
      const target = Math.max(MIN_PART, lenOf(s) * (limit / totalOf(segs)) * 0.98);
      const len = unit ? Math.max(1, Math.floor(target / unit)) * unit : target;
      return { ...s, to: round2(s.from + Math.min(lenOf(s), len)) };
    });
  }
  const hold = holdFor(segs);
  const total = totalOf(segs);
  if (total < MIN_TOTAL || total > MAX_TOTAL + 0.01) return null;
  const hookEnd = round2(Math.min(3, Math.max(1.5, total * 0.3)));
  const endStart = round2(Math.max(hookEnd + 1, total - 3));
  return {
    montage: true,
    segments: segs,
    hold,
    hook_start: 0.2,
    hook_end: hookEnd,
    end_start: endStart,
    duration: total,
    beat: unit ? round2(unit) : null,
    bpm: music && music.bpm ? music.bpm : null
  };
}

// ---------- Claude, step 1: which clips, which music ----------

const PICK_SCHEMA_BASE = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'theme', 'clip_ids', 'sound_pick', 'reason'],
  properties: {
    title: { type: 'string' },
    theme: { type: 'string' },
    clip_ids: { type: 'array', items: { type: 'string' } },
    sound_pick: { type: 'string' },
    reason: { type: 'string' }
  }
};

async function systemLine() {
  const voice = await brandConfig.voiceLine();
  const audience = await brandConfig.audienceLine();
  const style = await brandConfig.styleLine();
  return "You are the video editor and copywriter for Sam's (Sam's Pizza Ltd, brand line \"More Than Pizza\"), a restaurant at " +
    '100 Mirian Mepe St, Tbilisi, Georgia. You build short, fast-cut montages for Instagram Reels, TikTok and YouTube Shorts ' +
    "from the restaurant's own short phone clips. " + voice + ' ' + audience + (style ? ' ' + style : '') +
    ' Hard rules: describe ONLY what the clips show. Never invent prices, discounts, offers, opening hours, delivery promises,' +
    ' awards, rankings or ingredients you cannot see. No "best in Tbilisi" style claims.';
}

async function recentDrops() {
  const rows = await db.query(
    "SELECT p.copy_json FROM media_prep p JOIN media m ON m.id = p.media_id WHERE m.kind = 'montage' AND p.status = 'skipped'" +
    ' ORDER BY p.updated_at DESC LIMIT 5'
  );
  return (rows || []).map((r) => parseJson(r.copy_json, {}) || {}).filter((c) => c.montage)
    .map((c) => (c.montage.title || '') + ' (clips ' + (c.montage.clips || []).map((x) => x.id).join(', ') + ')');
}

async function pick(clips, music, recs) {
  const ids = clips.map((c) => String(c.media_id));
  const schema = JSON.parse(JSON.stringify(PICK_SCHEMA_BASE));
  schema.properties.clip_ids.items = { type: 'string', enum: ids };
  schema.properties.sound_pick = { type: 'string', enum: ['own'].concat(music.map((m) => String(m.id))) };
  const drops = await recentDrops();
  const lines = [
    'Short clips from Sam\'s waiting to be put together (id, length, what each shows):'
  ];
  for (const c of clips) {
    lines.push('- clip ' + c.media_id + ' (' + round2(c.duration) + ' s, ' + (c.width && c.height && c.width > c.height ? 'horizontal' : 'vertical') + '): ' +
      (c.title || 'untitled') + (c.summary ? ' - ' + c.summary : '') + (c.tags ? ' [' + c.tags + ']' : ''));
  }
  lines.push('', 'Music in the Sound Library (sound_pick):');
  if (!music.length) lines.push('- (no music long enough - pick "own")');
  for (const m of music) {
    lines.push('- "' + m.id + '": ' + m.title + ' - ' + m.seconds + ' s' + (m.bpm ? ', about ' + m.bpm + ' bpm' : '') +
      (m.energy ? ', ' + m.energy : '') + (m.sound_type === 'music_with_vocals' ? ', with vocals' : '') +
      '; used ' + m.uses + ' time(s)' + (m.posts ? '; our posts with it averaged ' + m.avg_views + ' views' : ''));
  }
  lines.push('- "own": no music - the clips keep their own sound (only when no music fits)');
  if (drops.length) lines.push('', 'Montages the owner turned down recently - do not repeat them:', ...drops.map((d) => '- ' + d));
  const recLines = [].concat(recs.editing || [], recs.sounds || []);
  const recBlock = recommendations.promptBlock("The owner's recommendations for editing and sounds:", recLines);
  if (recBlock) lines.push('', recBlock);
  lines.push(
    '',
    'Pick the NEXT montage - ONE short video that can go viral:',
    '- clip_ids: ' + MIN_CLIPS + '-' + MAX_CLIPS + ' clips (5-7 is best) that belong together - one theme: a dish being made, a meal coming together, the kitchen at work, a full table, the place itself. ' +
      'In story order: open with the most eye-catching shot (movement, steam, a pour, a cut, cheese), build up, and end on the payoff (the finished plate, a full table, the storefront).',
    '- Leave out clips that do not fit the theme - they wait for a later montage. Never use a clip twice.',
    '- sound_pick: the music that fits the mood - prefer an upbeat track with a clear beat that lasts as long as the montage (about 1.5-3 s per clip). ' +
      'Every montage gets its own track: the ones the latest videos used are not in the list; among good fits take the one used least.',
    '- title: max 6 words, for the owner. theme: one sentence. reason: one short sentence why these clips and this music.'
  );
  const out = await claude.generateJSON({ system: await systemLine(), prompt: lines.join('\n'), schema, maxTokens: 1500, effort: 'medium' });
  if (!out) return null;
  const known = new Map(clips.map((c) => [String(c.media_id), c]));
  const chosen = [...new Set((out.clip_ids || []).map(String))].filter((id) => known.has(id)).slice(0, MAX_CLIPS).map((id) => known.get(id));
  if (chosen.length < 3) return null;
  // "own" = the clips keep their sound; anything off the list = the least used track
  const sound = String(out.sound_pick) === 'own' ? null : (music.find((m) => String(m.id) === String(out.sound_pick)) || music[0] || null);
  return { title: cut(out.title, 60), theme: cut(out.theme, 300), clips: chosen, music: sound, reason: cut(out.reason, 300) };
}

// Without Claude: the clips in upload order, the most promising music.
function fallbackPick(clips, music) {
  const chosen = clips.slice(0, Math.min(6, clips.length));
  return { title: "Fresh from Sam's kitchen", theme: '', clips: chosen, music: music[0] || null, reason: '(Claude was unavailable - clips in upload order, the first music in the list)' };
}

// ---------- Claude, step 2: the best moments + the copy ----------

function editSchema(ids, trends) {
  const igIds = trends.map((t) => String(t.audio_id));
  const str = { type: 'string' };
  return {
    type: 'object',
    additionalProperties: false,
    required: ['what_it_shows', 'hook', 'end_line', 'alt_hook_1', 'alt_end_line_1', 'alt_hook_2', 'alt_end_line_2',
      'instagram', 'facebook_page', 'tiktok', 'youtube_title', 'youtube_description', 'moments', 'instagram_sound_pick', 'edit_plan_note'],
    properties: {
      what_it_shows: str, hook: str, end_line: str,
      alt_hook_1: str, alt_end_line_1: str, alt_hook_2: str, alt_end_line_2: str,
      instagram: str, facebook_page: str, tiktok: str, youtube_title: str, youtube_description: str,
      moments: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['clip_id', 'start', 'end'],
          properties: { clip_id: { type: 'string', enum: ids }, start: { type: 'number' }, end: { type: 'number' } }
        }
      },
      // music by time of day: one of the part-of-day tracks whenever there are any
      instagram_sound_pick: { type: 'string', enum: igIds.length ? igIds : ['none'] },
      edit_plan_note: str
    }
  };
}

// Frame times as the analysis recorded them (older analyses: 4 fixed points).
function timesFor(clip, count) {
  if (Array.isArray(clip.frame_times) && clip.frame_times.length === count) return clip.frame_times;
  if (count === 4 && clip.duration > 0) return [0.12, 0.38, 0.62, 0.88].map((f) => round2(clip.duration * f));
  return null;
}

async function edit(picked, recs, trends, daypart) {
  const content = [];
  for (const c of picked.clips) {
    const files = framesOf(c.media_id);
    const times = timesFor(c, files.length);
    // two frames spread over the clip (more for longer clips would cost a lot)
    const idx = files.length <= FRAMES_PER_CLIP ? files.map((_, i) => i)
      : [Math.floor(files.length * 0.3), Math.floor(files.length * 0.7)];
    content.push({ type: 'text', text: 'Clip ' + c.media_id + ' - ' + round2(c.duration) + ' s long - ' + (c.title || 'untitled') + ':' });
    for (const i of idx) {
      if (times) content.push({ type: 'text', text: 'at ' + times[i] + ' s:' });
      content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: fs.readFileSync(path.join(PREP_DIR, String(c.media_id), files[i])).toString('base64') } });
    }
  }
  const capRecs = recommendations.promptBlock("The owner's recommendations for the hook, end line and captions:", [].concat(recs.editing || [], recs.captions || []));
  const morning = daypart === 'morning';
  const trendLines = trends.length
    ? ['', 'INSTAGRAM SOUND (instagram_sound_pick) - Instagram adds this licensed track on top of the Instagram post only. ' +
      (morning
        ? 'This montage goes out in the MORNING slot, and the owner wants a Fairouz song on morning posts - pick the Fairouz track whose mood fits it best:'
        : 'This montage goes out in the AFTERNOON/EVENING slot, and the owner wants a trending sound on those posts - pick the trending track that fits it best:')]
      .concat(trends.map((t) => '- "' + t.audio_id + '": "' + (t.title || 'untitled') + '"' + (t.artist ? ' by ' + t.artist : '') +
        ' (' + (t.badge || 'trending') + '; used on ' + (Number(t.uses) || 0) + ' of our posts)'))
      .concat(['Among good fits, take the one used least.'])
    : ['', 'instagram_sound_pick: "none" (no ' + (morning ? 'Fairouz song' : 'trending sound') + ' approved right now).'];
  content.push({
    type: 'text',
    text: [
      'These clips, in this order, become ONE montage for Reels / TikTok / Shorts: "' + picked.title + '"' + (picked.theme ? ' - ' + picked.theme : '') + '.',
      picked.music ? 'It is cut to music: "' + picked.music.title + '"' + (picked.music.bpm ? ', about ' + picked.music.bpm + ' bpm' : '') + ', ' + picked.music.seconds + ' s.' : 'It keeps the clips\' own sound.',
      '',
      'moments: for EVERY clip, the best ' + MIN_PART + '-' + MAX_PART + ' s of it (start/end in seconds of that clip, using the frame times): the most appetising, most moving part - the pour, the cut, the steam, the stretch of cheese. The whole montage should stay around 10-20 s.',
      'what_it_shows: one plain sentence for the owner describing the montage.',
      'hook: on-screen text for the first 2-3 seconds, max 6 words, makes people stop scrolling. end_line: on-screen text for the last 3 seconds, max 6 words (an invitation to come by). ' +
        'alt_hook_1/alt_end_line_1 and alt_hook_2/alt_end_line_2: two more, clearly different pairs. No hashtags, no emoji in any of the six.',
      'instagram: a strong first line, 1-3 short lines, then 4-7 relevant hashtags (include #tbilisi). facebook_page: friendly, 1-3 short lines, at most 3 hashtags. ' +
        'tiktok: short and punchy, then 3-6 hashtags (include #tbilisi and #fyp). youtube_title: max 90 characters, ends with #Shorts. youtube_description: 1-3 lines plus "Sam\'s - 100 Mirian Mepe St, Tbilisi".',
      'edit_plan_note: one or two short sentences for the owner - the story of the cut and where the payoff is.',
      'Write in English unless the style notes say otherwise.'
    ].concat(capRecs ? ['', capRecs] : [], trendLines).join('\n')
  });
  const ids = picked.clips.map((c) => String(c.media_id));
  return claude.generateJSON({ system: await systemLine(), prompt: content, schema: editSchema(ids, trends), maxTokens: 4000, effort: 'medium' });
}

function fallbackCopy() {
  const caption = "Fresh from Sam's kitchen\n\n📍 Sam's, 100 Mirian Mepe St, Tbilisi\n#tbilisi #tbilisifood #samspizza";
  return {
    what_it_shows: '(Claude was unavailable - template captions, please edit before approving)',
    hook: 'Straight from our kitchen',
    end_line: '100 Mirian Mepe St',
    instagram: caption,
    facebook_page: caption,
    tiktok: caption + ' #fyp',
    youtube_title: "Fresh from Sam's kitchen #Shorts",
    youtube_description: caption
  };
}

// ---------- the planner (called by autopilot.tick) ----------

let lastFailureAt = 0;

async function planNext({ preparingCount }) {
  const cfg = await brandConfig.get();
  if (!montageOn(cfg)) return;
  // A broken render must not turn into a Claude call every minute.
  const paused = await db.query("SELECT cfg_value FROM branding WHERE cfg_key = 'montage_paused_until'");
  if (paused && paused.length && Number(paused[0].cfg_value) > Date.now()) return;
  // Wait until every queued video has been analysed (the whole batch is in).
  const analyzing = await db.query(
    "SELECT COUNT(*) AS n FROM media_prep WHERE status IN ('queued','analyzing') AND updated_at > NOW() - INTERVAL 30 MINUTE"
  );
  if (!analyzing || Number(analyzing[0].n) > 0) return;
  const buffer = Math.max(1, Math.min(30, Number(cfg.autoprep_buffer) || 5));
  const inFlight = await preparingCount();
  if (inFlight === null || inFlight >= buffer) return;

  const all = await waitingClips(cfg);
  if (!all || all.length < MIN_CLIPS) return;
  const clips = all.slice(0, MAX_CANDIDATES);
  note('planning a montage from ' + clips.length + ' waiting clips');

  const recs = {
    captions: await recommendations.forArea('captions'),
    editing: await recommendations.forArea('editing'),
    sounds: await recommendations.forArea('sounds')
  };
  const music = await musicOptions();
  let picked = await pick(clips, music, recs);
  let writer = 'claude';
  if (!picked) { picked = fallbackPick(clips, music); writer = 'template'; }

  // Music by time of day (dayparts.js): this montage is made for one part of
  // the day - a Fairouz song (morning) or a trending sound on Instagram.
  const daypart = await dayparts.next();
  const trends = await dayparts.igTracks(daypart);
  const out = writer === 'claude' ? await edit(picked, recs, trends, daypart) : null;
  if (!out) writer = 'template';
  const plan = cleanPlan(picked.clips, out && out.moments, picked.music) || cleanPlan(picked.clips, null, picked.music);
  if (!plan) {
    note('no usable montage from the picked clips - trying again later');
    return;
  }
  const used = new Set(plan.segments.map((s) => s.media_id));
  const clipsUsed = picked.clips.filter((c) => used.has(c.media_id));

  const base = fallbackCopy();
  const copy = out ? {
    what_it_shows: cut(out.what_it_shows, 300),
    hook: cut(out.hook, 60),
    end_line: cut(out.end_line, 48),
    instagram: cut(out.instagram, CAPTION_LIMIT.instagram) || base.instagram,
    facebook_page: cut(out.facebook_page, CAPTION_LIMIT.facebook_page) || base.facebook_page,
    tiktok: cut(out.tiktok, CAPTION_LIMIT.tiktok) || base.tiktok,
    youtube_title: cut(noAngles(out.youtube_title).replace(/\s+/g, ' '), 100) || base.youtube_title,
    youtube_description: cut(noAngles(out.youtube_description), 4900) || base.youtube_description
  } : base;
  const pairs = out
    ? [[out.hook, out.end_line], [out.alt_hook_1, out.alt_end_line_1], [out.alt_hook_2, out.alt_end_line_2]]
      .map(([h, e]) => ({ hook: cut(h, 60), end_line: cut(e, 48) })).filter((p) => p.hook && p.end_line)
    : [{ hook: copy.hook, end_line: copy.end_line }];
  copy.hook_options = pairs.filter((p, i) => pairs.findIndex((q) => q.hook === p.hook && q.end_line === p.end_line) === i);
  copy.chosen_pair = 0;
  copy.daypart = daypart;
  copy.sound_reason = [dayparts.label(daypart, cfg.publish_slots), picked.reason || ''].filter(Boolean).join(' ');
  // no valid pick (Claude down / off the list): the least used track of this part of the day
  const ig = (out && trends.find((t) => t.audio_id === String(out.instagram_sound_pick))) || trends[0] || null;
  if (ig) copy.ig_audio = { audio_id: ig.audio_id, title: ig.title, artist: ig.artist, audio_type: ig.audio_type };
  const titleOf = new Map(clipsUsed.map((c) => [c.media_id, c.title]));
  copy.montage = {
    title: picked.title,
    theme: picked.theme,
    clips: plan.segments.map((s) => ({ id: s.media_id, title: titleOf.get(s.media_id) || '', from: s.from, to: s.to })),
    music: picked.music ? { id: picked.music.id, title: picked.music.title, bpm: picked.music.bpm } : null,
    beat: plan.beat
  };
  copy.edit_plan = {
    cut: true, segments: plan.segments.map((s) => ({ from: s.from, to: s.to, media_id: s.media_id })), hold: plan.hold,
    hook_start: plan.hook_start, hook_end: plan.hook_end, end_start: plan.end_start, duration: plan.duration,
    note: cut(out && out.edit_plan_note, 300)
  };

  // The montage itself: a media row (never a library video) + its prep.
  const title = picked.title || "Fresh from Sam's kitchen";
  const ids = clipsUsed.map((c) => c.media_id);
  const mIns = await db.query("INSERT INTO media (kind, title, note) VALUES ('montage', ?, ?)", [cut('Montage: ' + title, 250), 'montage:' + ids.join(',')]);
  if (!mIns || !mIns.insertId) return;
  const montageId = mIns.insertId;
  const claim = await db.query(
    "UPDATE media_prep SET status = 'in_montage', montage_id = ? WHERE status = 'analyzed' AND media_id IN (" + ids.map(() => '?').join(',') + ')',
    [montageId].concat(ids)
  );
  if (!claim || claim.affectedRows !== ids.length) {
    // Lost a race (a clip changed meanwhile): undo, try again next minute.
    await release(montageId);
    await db.query("DELETE FROM media WHERE id = ? AND kind = 'montage'", [montageId]);
    return;
  }
  const clipInfo = new Map(clipsUsed.map((c) => [c.media_id, c]));
  const params = renderParams(montageId, plan, clipInfo, copy, picked.music, title);
  const mediaIds = ids.concat(picked.music ? [picked.music.id] : []).join(',');
  const analysis = { duration: plan.duration, width: 1080, height: 1920, has_audio: true, frames: 0, montage: true, clips: ids };
  const job = await db.query("INSERT INTO render_jobs (template, params, media_ids, status) VALUES ('MagicCut', ?, ?, 'queued')", [JSON.stringify(params), mediaIds]);
  const prep = job && job.insertId ? await db.query(
    "INSERT INTO media_prep (media_id, status, render_job_id, sound_media_id, sound_choice, analysis, copy_json, writer) VALUES (?, 'rendering', ?, ?, ?, ?, ?, ?)",
    [montageId, job.insertId, picked.music ? picked.music.id : null, picked.music ? 'rotated' : 'own', JSON.stringify(analysis), JSON.stringify(copy), writer]
  ) : null;
  if (!prep) {
    if (job && job.insertId) await db.query("DELETE FROM render_jobs WHERE id = ? AND status = 'queued'", [job.insertId]);
    await release(montageId);
    await db.query("DELETE FROM media WHERE id = ? AND kind = 'montage'", [montageId]);
    return;
  }
  note('montage #' + montageId + ' "' + title + '": ' + ids.length + ' clips, ' + plan.duration + ' s' +
    (picked.music ? ', music "' + picked.music.title + '"' + (plan.bpm ? ' cut on the beat (' + plan.bpm + ' bpm)' : '') : ', the clips\' own sound') +
    ' - edit queued for the render worker');
  return { montage_id: montageId, clips: ids, plan };
}

// The clips of a montage go back to the pool (a remake, a skip, a failure).
async function release(montageId) {
  return db.query("UPDATE media_prep SET status = 'analyzed', montage_id = NULL WHERE montage_id = ? AND status = 'in_montage'", [montageId]);
}

async function isMontage(mediaId) {
  const r = await db.query("SELECT id FROM media WHERE id = ? AND kind = 'montage'", [mediaId]);
  return !!(r && r.length);
}

// Owner: "Make another montage" / skip it. Its waiting posts are withdrawn,
// its clips go back to the pool, the planner makes a new one (it is told
// about skipped montages so it does not repeat them).
async function dissolve(montageId, reason) {
  await db.query(
    "UPDATE publish_queue SET status = 'dropped', error = ? WHERE prep_media_id = ? AND status IN ('pending_review','failed')",
    [reason, montageId]
  );
  await db.query("UPDATE media_prep SET status = 'skipped', error = ? WHERE media_id = ?", [reason, montageId]);
  await release(montageId);
  note('montage #' + montageId + ': ' + reason + ' - its clips go back to the pool');
}

// Render params for a montage plan (the planner and a new-sound cut share it).
function renderParams(montageId, plan, clipInfo, copy, music, title) {
  return {
    prep_media_id: montageId,
    montage: true,
    clips: plan.segments.map((s) => ({
      media_id: s.media_id, from: s.from, to: s.to,
      width: clipInfo.get(s.media_id).width, height: clipInfo.get(s.media_id).height
    })),
    hold: plan.hold,
    hook: copy.hook,
    end_line: copy.end_line,
    sound: music ? 'rotated' : 'own',
    duration: plan.duration,
    width: 1080,
    height: 1920,
    hook_start: plan.hook_start,
    hook_end: plan.hook_end,
    end_start: plan.end_start,
    output_title: cut('✨ Montage: ' + title, 120)
  };
}

// Tracks of videos being made, waiting for review or approved but not out yet
// (montagesOnly: of montages only).
async function tracksInUse(montagesOnly) {
  const r = await db.query(
    "SELECT p.sound_media_id FROM media_prep p JOIN media m ON m.id = p.media_id WHERE p.sound_media_id IS NOT NULL" +
    (montagesOnly ? " AND m.kind = 'montage'" : '') +
    " AND (p.status IN ('writing','rendering') OR (p.status = 'staged' AND EXISTS (SELECT 1 FROM publish_queue q" +
    " WHERE q.prep_media_id = p.media_id AND q.status IN ('pending_review','approved_publishing'))))"
  );
  return new Set((r || []).map((x) => Number(x.sound_media_id)));
}

// The liveliest upbeat track long enough for a cut (owner 2026-11-15: "give
// the falafel an upbeat track instead"): first one no upcoming video uses, then
// one no upcoming montage uses (a single edit may share it). Never avoidId.
async function upbeatTrack(minSeconds, avoidId) {
  const pool = (await musicOptions(0, true)).filter((m) => m.energy === 'upbeat' && m.seconds >= minSeconds && m.id !== avoidId);
  for (const montagesOnly of [false, true]) {
    const used = await tracksInUse(montagesOnly);
    const free = pool.filter((m) => !used.has(m.id));
    if (free.length) return free.sort((a, b) => b.beat_strength - a.beat_strength || a.uses - b.uses)[0];
  }
  return null;
}

// New sounds for a finished montage that still waits for review: another
// Sound Library track for the video (not the one it had, not one the latest
// videos used, long enough for the cut) and the Instagram track of its part of
// the day. Same clips, same moments (re-snapped to the new beat), same hook and
// captions. Its waiting posts give way to the new cut. Returns true when queued.
// opts.upbeat: only the music changes, to an upbeat track (upbeatTrack); the
// Instagram track and the part of the day stay.
async function resound(row, cfg, opts) {
  const only = !!(opts && opts.upbeat);
  const copy = parseJson(row.copy_json, {}) || {};
  const m = copy.montage;
  if (!m || !Array.isArray(m.clips) || m.clips.length < 3) return false;
  const crow = await db.query("SELECT media_id, analysis FROM media_prep WHERE montage_id = ? AND status = 'in_montage'", [row.media_id]);
  if (!crow) return false;
  const info = new Map(crow.map((c) => {
    const a = parseJson(c.analysis, {}) || {};
    return [Number(c.media_id), { media_id: Number(c.media_id), duration: Number(a.duration) || 0, width: Number(a.width) || null, height: Number(a.height) || null }];
  }));
  const clips = m.clips.map((c) => info.get(Number(c.id))).filter(Boolean);
  if (clips.length < 3) return false;
  const oldMusic = m.music ? Number(m.music.id) : null;
  const length = Number(copy.edit_plan && copy.edit_plan.duration) || 0;
  // the cut was made for upbeat music: the liveliest track among the least used
  // ones that are not recent (musicOptions) and long enough
  const energy = { upbeat: 2, medium: 1 };
  const track = only
    ? await upbeatTrack(length ? length + 0.2 : 0, oldMusic)
    : (await musicOptions(length ? length + 0.2 : 0))
      .sort((a, b) => (energy[b.energy] || 0) - (energy[a.energy] || 0) || b.beat_strength - a.beat_strength || a.uses - b.uses)
      .find((x) => x.id !== oldMusic) || null;
  if (!track) return false;
  const moments = m.clips.map((c) => ({ clip_id: String(c.id), start: Number(c.from), end: Number(c.to) }));
  const plan = cleanPlan(clips, moments, track);
  if (!plan) return false;
  const daypart = dayparts.valid(copy.daypart) || await dayparts.next();
  const ig = only ? copy.ig_audio || null : (await dayparts.igTracks(daypart))[0] || null;

  copy.daypart = daypart;
  if (ig) copy.ig_audio = { audio_id: ig.audio_id, title: ig.title, artist: ig.artist, audio_type: ig.audio_type };
  else delete copy.ig_audio;
  copy.sound_reason = [dayparts.label(daypart, cfg.publish_slots), 'New ' + (only ? 'upbeat ' : '') + 'music for this cut: "' + track.title + '".'].join(' ');
  const titleOf = new Map(m.clips.map((c) => [Number(c.id), c.title || '']));
  copy.montage = Object.assign({}, m, {
    clips: plan.segments.map((s) => ({ id: s.media_id, title: titleOf.get(s.media_id) || '', from: s.from, to: s.to })),
    music: { id: track.id, title: track.title, bpm: track.bpm },
    beat: plan.beat
  });
  copy.edit_plan = Object.assign({}, copy.edit_plan || {}, {
    cut: true, segments: plan.segments.map((s) => ({ from: s.from, to: s.to, media_id: s.media_id })), hold: plan.hold,
    hook_start: plan.hook_start, hook_end: plan.hook_end, end_start: plan.end_start, duration: plan.duration
  });
  delete copy.render_retried;

  const title = m.title || "Fresh from Sam's kitchen";
  const params = renderParams(row.media_id, plan, info, copy, track, title);
  const ids = [...new Set(plan.segments.map((s) => s.media_id))];
  const job = await db.query("INSERT INTO render_jobs (template, params, media_ids, status) VALUES ('MagicCut', ?, ?, 'queued')", [JSON.stringify(params), ids.concat([track.id]).join(',')]);
  if (!job || !job.insertId) return false;
  const analysis = { duration: plan.duration, width: 1080, height: 1920, has_audio: true, frames: 0, montage: true, clips: ids };
  const upd = await db.query(
    "UPDATE media_prep SET status = 'rendering', render_job_id = ?, sound_media_id = ?, sound_choice = 'rotated', analysis = ?, copy_json = ?, error = NULL" +
    " WHERE media_id = ? AND status = 'staged'",
    [job.insertId, track.id, JSON.stringify(analysis), JSON.stringify(copy), row.media_id]
  );
  if (!upd || !upd.affectedRows) {
    await db.query("DELETE FROM render_jobs WHERE id = ? AND status = 'queued'", [job.insertId]);
    return false;
  }
  await db.query(
    "UPDATE publish_queue SET status = 'dropped', error = 'new sounds for this montage - a new cut is on its way' WHERE prep_media_id = ? AND status IN ('pending_review','failed')",
    [row.media_id]
  );
  note('montage #' + row.media_id + ': new sounds (' + daypart + ') - music "' + track.title + '"' + (ig ? ', Instagram "' + (ig.title || ig.audio_id) + '"' : '') + ' - cut again');
  return true;
}

// One time (owner 2026-11-15: "the same sound is being used for all of them"):
// montages made before music by time of day that still wait for review get
// new sounds. Approved ones stay exactly as the owner approved them. The flag
// is set once none is left to do (one still rendering waits for its turn).
async function resoundOldOnce(cfg) {
  if (!montageOn(cfg)) return;
  const flag = await db.query("SELECT cfg_value FROM branding WHERE cfg_key = 'montage_resound_dayparts'");
  if (flag === null || (flag.length && flag[0].cfg_value === 'done')) return;
  const old = " FROM media_prep p JOIN media m ON m.id = p.media_id WHERE m.kind = 'montage' AND p.copy_json NOT LIKE '%\"daypart\"%'" +
    " AND NOT EXISTS (SELECT 1 FROM publish_queue q WHERE q.prep_media_id = p.media_id" +
    " AND q.status IN ('approved_publishing','publishing','published','unknown','in_drafts'))";
  const rows = await db.query('SELECT p.media_id, p.copy_json' + old + " AND p.status = 'staged'" +
    " AND EXISTS (SELECT 1 FROM publish_queue w WHERE w.prep_media_id = p.media_id AND w.status = 'pending_review') ORDER BY p.media_id ASC");
  if (rows === null) return;
  let done = 0;
  for (const r of rows) if (await resound(r, cfg)) done++;
  if (done) note(done + ' waiting montage(s) got new sounds (music by time of day) - same clips and text, cut again');
  const left = await db.query('SELECT COUNT(*) AS n' + old + " AND p.status IN ('rendering','staged')");
  if (left && left.length && Number(left[0].n) === 0) {
    await db.query("INSERT INTO branding (cfg_key, cfg_value) VALUES ('montage_resound_dayparts', 'done') ON DUPLICATE KEY UPDATE cfg_value = 'done'");
  }
}

// The owner asks for new sounds on one montage (POST /api/prep/:id/new-sounds),
// also one he already approved: another Sound Library track and the Instagram
// track of its part of the day, same clips, cut and text. Its posts that are
// not out yet are withdrawn; the new cut comes back to his review queue (a
// platform where it is already out gets no second copy). Refused while one of
// its posts is being published.
async function newSounds(montageId, opts) {
  const rows = await db.query(
    "SELECT p.media_id, p.status, p.copy_json FROM media_prep p JOIN media m ON m.id = p.media_id WHERE p.media_id = ? AND m.kind = 'montage'",
    [montageId]
  );
  if (rows === null) return { status: 503, error: 'Database unavailable' };
  if (!rows.length) return { status: 404, error: 'Not a montage' };
  if (rows[0].status !== 'staged') return { status: 409, error: 'This montage is being made right now - try again when it is ready' };
  const busy = await db.query(
    "SELECT COUNT(*) AS n FROM publish_queue WHERE prep_media_id = ? AND (status = 'publishing' OR (status = 'approved_publishing' AND creation_id IS NOT NULL))",
    [montageId]
  );
  if (!busy || Number(busy[0].n) > 0) return { status: 409, error: 'A post of this montage is being published right now - try again in a few minutes' };
  const ok = await resound(rows[0], await brandConfig.get(), opts);
  if (!ok) return { status: 409, error: opts && opts.upbeat ? 'No upbeat track fits this montage right now' : 'No other music fits this montage right now' };
  await db.query(
    "UPDATE publish_queue SET status = 'dropped', error = 'new sounds for this montage - a new cut is on its way'" +
    " WHERE prep_media_id = ? AND status = 'approved_publishing' AND creation_id IS NULL",
    [montageId]
  );
  return { status: 200, body: { ok: true, status: 'rendering' } };
}

// One time (2026-11-15): two montages of one batch got the same Sound Library
// track (their times tied to the second before recentMusic looked at the whole
// queue). Of waiting montages that share a track the older keeps it, the newer
// gets new sounds (same cut, same part of the day). One still rendering waits.
async function dedupeMusicOnce(cfg) {
  if (!montageOn(cfg)) return;
  const flag = await db.query("SELECT cfg_value FROM branding WHERE cfg_key = 'montage_dedupe_music'");
  if (flag === null || (flag.length && flag[0].cfg_value === 'done')) return;
  const rows = await db.query(
    "SELECT p.media_id, p.status, p.sound_media_id, p.copy_json FROM media_prep p JOIN media m ON m.id = p.media_id" +
    " WHERE m.kind = 'montage' AND p.sound_media_id IS NOT NULL AND (p.status = 'rendering' OR (p.status = 'staged'" +
    " AND EXISTS (SELECT 1 FROM publish_queue w WHERE w.prep_media_id = p.media_id AND w.status = 'pending_review')))" +
    " AND NOT EXISTS (SELECT 1 FROM publish_queue q WHERE q.prep_media_id = p.media_id" +
    " AND q.status IN ('approved_publishing','publishing','published','unknown','in_drafts'))" +
    ' ORDER BY p.media_id ASC'
  );
  if (rows === null) return;
  const seen = new Set();
  let pending = 0;
  for (const r of rows) {
    const sid = Number(r.sound_media_id);
    if (!seen.has(sid)) { seen.add(sid); continue; }
    if (r.status !== 'staged' || !(await resound(r, cfg))) pending++;
  }
  if (!pending) {
    await db.query("INSERT INTO branding (cfg_key, cfg_value) VALUES ('montage_dedupe_music', 'done') ON DUPLICATE KEY UPDATE cfg_value = 'done'");
  }
}

// A montage's render failed: one more try with the same plan, then the clips
// go back and planning pauses for a while (no Claude call loop on a broken PC).
async function onRenderFailed(montageId, error) {
  const rows = await db.query('SELECT copy_json, render_job_id FROM media_prep WHERE media_id = ?', [montageId]);
  if (!rows || !rows.length) return;
  const copy = parseJson(rows[0].copy_json, {}) || {};
  if (!copy.render_retried) {
    const job = await db.query('SELECT params, media_ids FROM render_jobs WHERE id = ?', [rows[0].render_job_id]);
    if (job && job.length) {
      copy.render_retried = true;
      const ins = await db.query("INSERT INTO render_jobs (template, params, media_ids, status) VALUES ('MagicCut', ?, ?, 'queued')", [job[0].params, job[0].media_ids]);
      if (ins && ins.insertId) {
        await db.query("UPDATE media_prep SET status = 'rendering', render_job_id = ?, copy_json = ?, error = NULL WHERE media_id = ?", [ins.insertId, JSON.stringify(copy), montageId]);
        note('montage #' + montageId + ': the edit failed on the PC (' + String(error || '').slice(0, 120) + ') - trying once more');
        return;
      }
    }
  }
  await db.query("UPDATE media_prep SET status = 'failed', error = ? WHERE media_id = ?", ['Edit failed on the PC: ' + String(error || 'unknown error').slice(0, 900), montageId]);
  await release(montageId);
  lastFailureAt = Date.now();
  await db.query(
    "INSERT INTO branding (cfg_key, cfg_value) VALUES ('montage_paused_until', ?) ON DUPLICATE KEY UPDATE cfg_value = VALUES(cfg_value)",
    [String(Date.now() + PAUSE_AFTER_FAILURE_MS)]
  );
  note('montage #' + montageId + ': the edit failed twice - clips back in the pool, montages paused for 6 h');
}

// Every tick (montages on): a short clip that was written up ALONE before
// montages existed, with none of its posts approved, goes back to the pool -
// its waiting posts are withdrawn. Clips skipped as "too short" (under 3 s)
// are montage material now. Montage preps whose render job vanished dissolve.
async function sweep(cfg) {
  if (!montageOn(cfg)) return;
  const singles = await db.query(
    "SELECT p.media_id, p.analysis, m.kind, m.note FROM media_prep p JOIN media m ON m.id = p.media_id" +
    " WHERE p.status = 'staged' AND m.kind = 'video' AND m.created_at >= ?" +
    " AND NOT EXISTS (SELECT 1 FROM publish_queue q WHERE q.prep_media_id = p.media_id" +
    "   AND q.status IN ('approved_publishing','publishing','published','unknown','in_drafts'))",
    [MONTAGE_ERA]
  );
  let back = 0;
  for (const s of singles || []) {
    if (!isClip(s.kind, s.note, analysedSeconds(s.analysis), cfg) || !framesOf(s.media_id).length) continue;
    await db.query(
      "UPDATE publish_queue SET status = 'dropped', error = 'this clip goes into a montage instead' WHERE prep_media_id = ? AND status IN ('pending_review','failed')",
      [s.media_id]
    );
    const r = await db.query(
      "UPDATE media_prep SET status = 'analyzed', render_job_id = NULL, output_media_id = NULL, error = NULL WHERE media_id = ? AND status = 'staged'",
      [s.media_id]
    );
    if (r && r.affectedRows) back++;
  }
  const short = await db.query(
    "SELECT p.media_id, p.analysis, m.kind, m.note FROM media_prep p JOIN media m ON m.id = p.media_id" +
    " WHERE p.status = 'skipped' AND p.error LIKE 'Too short%' AND m.kind = 'video' AND m.created_at >= ?",
    [MONTAGE_ERA]
  );
  for (const s of short || []) {
    const sec = analysedSeconds(s.analysis);
    if (sec === null || sec < MIN_PART + 0.05 || !isClip(s.kind, s.note, sec, cfg) || !framesOf(s.media_id).length) continue;
    const r = await db.query("UPDATE media_prep SET status = 'analyzed', error = NULL WHERE media_id = ? AND status = 'skipped'", [s.media_id]);
    if (r && r.affectedRows) back++;
  }
  if (back) note(back + ' short clip(s) moved into the montage pool');
  // a montage prep whose job the owner deleted (autopilot.sweep sets it back to 'analyzed')
  const lost = await db.query("SELECT p.media_id FROM media_prep p JOIN media m ON m.id = p.media_id WHERE m.kind = 'montage' AND p.status = 'analyzed'");
  for (const l of lost || []) await dissolve(l.media_id, 'its edit job was deleted');
}

async function counts(cfg) {
  const clips = await waitingClips(cfg);
  const inMontage = await db.query("SELECT COUNT(*) AS n FROM media_prep WHERE status = 'in_montage'");
  return { clips_waiting: clips ? clips.length : null, clips_in_montages: inMontage && inMontage.length ? Number(inMontage[0].n) : null };
}

module.exports = {
  montageOn, clipMaxSeconds, analysedSeconds, isClip, MONTAGE_ERA,
  planNext, release, dissolve, isMontage, onRenderFailed, sweep, counts, resoundOldOnce, dedupeMusicOnce, newSounds,
  MIN_CLIPS, MAX_CLIPS,
  _cleanPlan: cleanPlan, // tests
  _beatUnit: beatUnit // tests
};
