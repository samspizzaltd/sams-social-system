const db = require('../database/db');
const brandConfig = require('./brandConfig');
const trendSounds = require('./trendSounds');

// Music by time of day (owner 2026-11-15): "for morning sounds use songs from
// Fairouz and for afternoon and evening time use trendy sounds".
//
// Every new video (a montage or a single edit) is made for ONE part of the day:
//  - morning: its posts take only the morning posting window and its Instagram
//    post carries a Fairouz song;
//  - evening (afternoon and evening): only the later windows and a trending
//    sound on Instagram.
// The owner approves exactly what he sees: the track is chosen when the video
// is made, and approving it books the next free slot of ITS part of the day.
// Only Instagram can add a licensed track - TikTok, YouTube and Facebook mute
// or claim a copied song - so the video file itself keeps Sound Library music,
// a different track from the videos just before it.
//
// Posting windows (owner 2026-11-16): "three posts daily - the first one
// between 9:30 and 10:00 for all platforms, the second between 12:45 and 13:00
// and the third wave between 16:00 and 19:00". publish_slots holds windows
// ("09:30-10:00,12:45-13:00,16:00-19:00"; a plain "10:00" is a window of one
// moment). One post per platform per window per day. Inside a window the
// platforms go one after another, spread evenly from its start to its end:
// Instagram first, then Facebook, TikTok and YouTube (09:30 / 09:40 / 09:50 /
// 10:00) - the same times every day, shown on every post in the queue.

const MORNING_ENDS = 12 * 60; // noon, Tbilisi: 12:45 is an afternoon post (owner 2026-11-15: 12:30 is not "morning")
const FAIROUZ = /fairuz|fairouz|fayrouz|fayruz|feyrouz|فيروز/i;
const PARTS = ['morning', 'evening'];
// The order the platforms go out in, inside every window.
const PLATFORM_ORDER = ['instagram', 'facebook_page', 'tiktok', 'youtube'];
const DEFAULT_SLOTS = '09:30-10:00,12:45-13:00,16:00-19:00';
const TBILISI_OFFSET_MS = 4 * 3600 * 1000; // Georgia has no DST

function parse(text) {
  try { return (typeof text === 'string' ? JSON.parse(text || '{}') : text) || {}; } catch { return {}; }
}

const toMinutes = (h, m) => {
  const hh = Number(h);
  const mm = Number(m);
  return hh <= 23 && mm <= 59 ? hh * 60 + mm : null;
};

// One comma part: "16:00-19:00" (also with an en dash or spaces) or "10:00".
// Returns {start, end} in minutes after midnight, or null when it is not one.
function parseWindowPart(part) {
  const m = /^(\d{1,2}):(\d{2})(?:\s*[-\u2013\u2014]\s*(\d{1,2}):(\d{2}))?$/.exec(String(part || '').trim());
  if (!m) return null;
  const start = toMinutes(m[1], m[2]);
  const end = m[3] ? toMinutes(m[3], m[4]) : start;
  if (start === null || end === null || end < start) return null;
  return { start, end };
}

function windowsFrom(text) {
  const out = [];
  for (const part of String(text || '').split(',')) {
    const w = parseWindowPart(part);
    if (w) out.push(w);
  }
  out.sort((a, b) => a.start - b.start || a.end - b.end);
  // Overlapping windows would let one platform post twice at once - keep the first.
  const clean = [];
  for (const w of out) if (!clean.length || w.start > clean[clean.length - 1].end) clean.push(w);
  return clean;
}

// "09:30-10:00,12:45-13:00,16:00-19:00" -> [{start: 570, end: 600}, ...]
// (sorted). Nothing usable -> the owner's three waves.
function parseWindows(text) {
  const w = windowsFrom(text);
  return w.length ? w : windowsFrom(DEFAULT_SLOTS);
}

// Why a typed value cannot be used (Settings), or null when it is fine.
function checkSlotsText(text) {
  const parts = String(text || '').split(',').map((x) => x.trim()).filter(Boolean);
  if (!parts.length) return 'Give at least one posting window, e.g. ' + DEFAULT_SLOTS;
  for (const x of parts) {
    if (!parseWindowPart(x)) return '"' + x + '" is not a time (HH:MM) or a window (HH:MM-HH:MM, the end not before the start)';
  }
  if (windowsFrom(text).length !== parts.length) return 'Two of the windows overlap - one post per platform per window, so keep them apart';
  return null;
}

// The start of every window (minutes after midnight, sorted) - for older callers.
function parseSlots(text) {
  return parseWindows(text).map((w) => w.start);
}

const hhmm = (m) => String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');

// "09:30–10:00", or "10:00" for a window of one moment.
function windowLabel(w) {
  return w.end > w.start ? hhmm(w.start) + '\u2013' + hhmm(w.end) : hhmm(w.start);
}

// Minutes after midnight when this platform posts inside window w: spread
// evenly from the start (Instagram) to the end (YouTube).
function platformMinute(w, platform) {
  const i = PLATFORM_ORDER.indexOf(platform);
  if (i <= 0 || w.end <= w.start) return w.start;
  return w.start + Math.round((i * (w.end - w.start)) / (PLATFORM_ORDER.length - 1));
}

function partOfMinutes(minutes) {
  return minutes < MORNING_ENDS ? 'morning' : 'evening';
}

function valid(daypart) {
  return PARTS.includes(daypart) ? daypart : null;
}

// The posting slots a video of this part of the day may take. With no slot of
// that part configured, any slot (the post must still go out). Works on
// minutes (older callers) and on windows ({start, end}).
function slotsFor(slots, daypart) {
  if (!valid(daypart)) return slots;
  const at = (x) => (typeof x === 'number' ? x : x.start);
  const mine = slots.filter((x) => partOfMinutes(at(x)) === daypart);
  return mine.length ? mine : slots;
}

// Midnight (Tbilisi) of the day `t` falls on, as epoch ms.
function dayStart(t) {
  const d = new Date(Number(t) + TBILISI_OFFSET_MS);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - TBILISI_OFFSET_MS;
}

// Which window of its day a posting time falls in: "<midnight ms>#<index>",
// or null when it is outside every window. One post per platform per key.
function windowKey(t, windows) {
  const day0 = dayStart(t);
  const minute = (Number(t) - day0) / 60000;
  for (let i = 0; i < windows.length; i++) {
    if (minute >= windows[i].start && minute <= windows[i].end) return day0 + '#' + i;
  }
  return null;
}

// The earliest posting time for `platform` later than `after` (epoch ms) in
// one of `allowed` (the windows of one part of the day, taken from `windows`)
// whose key is not in `held` - or null when 90 days are full.
function firstFreeTime(platform, windows, allowed, held, after) {
  const base = dayStart(after);
  for (let d = 0; d < 92; d++) {
    const day0 = base + d * 86400000; // Georgia keeps +04:00 all year
    for (const w of allowed) {
      const t = day0 + platformMinute(w, platform) * 60000;
      if (t <= after) continue;
      if (!held.has(day0 + '#' + windows.indexOf(w))) return t;
    }
  }
  return null;
}

// Every window with its part of the day and each platform's time - for the
// panel ("Instagram 09:30, Facebook 09:40 ...").
function waves(text) {
  return parseWindows(text).map((w) => ({
    window: windowLabel(w),
    part: partOfMinutes(w.start),
    times: Object.fromEntries(PLATFORM_ORDER.map((x) => [x, hhmm(platformMinute(w, x))]))
  }));
}

function isFairouz(t) {
  return FAIROUZ.test(String((t && t.title) || '') + ' ' + String((t && t.artist) || ''));
}

// One line for the owner (shown with the video in the Publish Queue).
function label(daypart, publishSlots) {
  if (!valid(daypart)) return '';
  const times = slotsFor(parseWindows(publishSlots), daypart).map(windowLabel).join(' / ');
  return daypart === 'morning'
    ? 'Morning post (' + times + '): a Fairouz song on Instagram.'
    : 'Afternoon/evening post (' + times + '): a trending sound on Instagram.';
}

// The part of the day a prepared video was made for (null: made before the rule).
async function forPrep(prepMediaId) {
  if (!prepMediaId) return null;
  const r = await db.query('SELECT copy_json FROM media_prep WHERE media_id = ?', [prepMediaId]);
  return r && r.length ? valid(parse(r[0].copy_json).daypart) : null;
}

// The part of the day for the next new video: the one with fewer videos
// waiting (being made, in review, or approved but not out yet) for each of its
// posting windows - with one morning window and two later ones a day, two
// afternoon/evening videos are made for every morning one, so every window
// fills. On a tie, the other part than the latest video.
async function next() {
  const rows = await db.query(
    "SELECT p.copy_json FROM media_prep p WHERE p.copy_json LIKE '%\"daypart\"%' AND (p.status IN ('writing','rendering')" +
    " OR (p.status = 'staged' AND EXISTS (SELECT 1 FROM publish_queue q WHERE q.prep_media_id = p.media_id" +
    " AND q.status IN ('pending_review','approved_publishing'))))"
  );
  const n = { morning: 0, evening: 0 };
  for (const r of rows || []) {
    const d = valid(parse(r.copy_json).daypart);
    if (d) n[d]++;
  }
  const cfg = await brandConfig.get();
  const per = { morning: 0, evening: 0 };
  for (const w of parseWindows(cfg && cfg.publish_slots)) per[partOfMinutes(w.start)]++;
  if (!per.morning) return 'evening';
  if (!per.evening) return 'morning';
  const share = { morning: n.morning / per.morning, evening: n.evening / per.evening };
  if (share.morning !== share.evening) return share.morning < share.evening ? 'morning' : 'evening';
  const last = await db.query("SELECT copy_json FROM media_prep WHERE copy_json LIKE '%\"daypart\"%' ORDER BY updated_at DESC LIMIT 1");
  return last && last.length && parse(last[0].copy_json).daypart === 'morning' ? 'evening' : 'morning';
}

// Instagram tracks the latest posts carry, every post waiting for review, and
// videos being made right now - no two videos in the queue share a track.
// upcoming: also every approved Instagram post that is not out yet.
async function recentIgTracks(count, upcoming) {
  const ids = new Set();
  const q = await db.query(
    "SELECT post_options FROM publish_queue WHERE platform = 'instagram' AND post_options LIKE '%audio_id%' AND status <> 'dropped'" +
    ' ORDER BY id DESC LIMIT ' + Math.max(1, Math.floor(count))
  );
  const waiting = await db.query(
    "SELECT post_options FROM publish_queue WHERE platform = 'instagram' AND post_options LIKE '%audio_id%' AND status IN (" +
    (upcoming ? "'pending_review','approved_publishing'" : "'pending_review'") + ')'
  );
  for (const r of (q || []).concat(waiting || [])) {
    const a = parse(r.post_options).ig_audio;
    if (a && a.audio_id) ids.add(String(a.audio_id));
  }
  const p = await db.query("SELECT copy_json FROM media_prep WHERE status IN ('writing','rendering') AND copy_json LIKE '%ig_audio%'");
  for (const r of p || []) {
    const a = parse(r.copy_json).ig_audio;
    if (a && a.audio_id) ids.add(String(a.audio_id));
  }
  return ids;
}

// The Instagram tracks a video of this part of the day may carry: approved
// Fairouz songs in the morning, approved trending sounds (not Fairouz) later.
// Least used first, and none of the tracks the latest posts carry while there
// is another one to choose.
async function igTracks(daypart) {
  const all = (await trendSounds.approvedFresh(500)) || [];
  let list = valid(daypart) === 'morning'
    ? all.filter(isFairouz)
    : all.filter((t) => t.source === 'trending' && !isFairouz(t));
  // first none that an upcoming post already carries, else none waiting for review
  for (const upcoming of [true, false]) {
    const busy = await recentIgTracks(4, upcoming);
    const fresh = list.filter((t) => !busy.has(String(t.audio_id)));
    if (fresh.length) { list = fresh; break; }
  }
  // stable sort: among equally used tracks the trend order stays
  list = list.slice().sort((a, b) => (Number(a.uses) || 0) - (Number(b.uses) || 0));
  return list.slice(0, 12).map((t) => ({
    audio_id: String(t.audio_id), title: t.title, artist: t.artist, audio_type: t.audio_type,
    badge: t.badge, age_hours: t.age_hours, uses: Number(t.uses) || 0, watch_terms: t.watch_terms || []
  }));
}

// Sound Library tracks the next video must not use: the ones the latest videos
// were cut to, every track of a video being made or waiting for review, and the
// tracks of montages approved but not out yet - no two upcoming videos share a
// track (2026-11-15: two montages of one batch got the same track when their
// times tied to the second).
async function recentMusic(count) {
  const last = await db.query(
    "SELECT sound_media_id FROM media_prep WHERE sound_media_id IS NOT NULL AND status NOT IN ('failed','skipped')" +
    ' ORDER BY updated_at DESC, media_id DESC LIMIT ' + Math.max(1, Math.floor(count))
  );
  const waiting = await db.query(
    "SELECT p.sound_media_id FROM media_prep p JOIN media m ON m.id = p.media_id WHERE p.sound_media_id IS NOT NULL" +
    " AND (p.status IN ('writing','rendering') OR (p.status = 'staged' AND EXISTS (SELECT 1 FROM publish_queue q" +
    " WHERE q.prep_media_id = p.media_id AND (q.status = 'pending_review' OR (m.kind = 'montage' AND q.status = 'approved_publishing')))))"
  );
  return new Set((last || []).concat(waiting || []).map((x) => Number(x.sound_media_id)));
}

module.exports = {
  MORNING_ENDS, PLATFORM_ORDER, DEFAULT_SLOTS, parseSlots, parseWindows, checkSlotsText, windowLabel, platformMinute,
  windowKey, dayStart, firstFreeTime, waves, partOfMinutes, slotsFor, isFairouz, label, valid,
  forPrep, next, igTracks, recentIgTracks, recentMusic
};
