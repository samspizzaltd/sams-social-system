const db = require('../database/db');
const trendSounds = require('./trendSounds');

// Music by time of day (owner 2026-11-15): "for morning sounds use songs from
// Fairouz and for afternoon and evening time use trendy sounds".
//
// Every new video (a montage or a single edit) is made for ONE part of the day:
//  - morning: its posts take only the morning posting slots (before 13:00
//    Tbilisi - the 12:30 slot) and its Instagram post carries a Fairouz song;
//  - evening (afternoon and evening): only the later slots (19:00) and a
//    trending sound on Instagram.
// The owner approves exactly what he sees: the track is chosen when the video
// is made, and approving it books the next free slot of ITS part of the day.
// Only Instagram can add a licensed track - TikTok, YouTube and Facebook mute
// or claim a copied song - so the video file itself keeps Sound Library music,
// a different track from the videos just before it.

const MORNING_ENDS = 13 * 60; // minutes after midnight, Tbilisi
const FAIROUZ = /fairuz|fairouz|fayrouz|fayruz|feyrouz|فيروز/i;
const PARTS = ['morning', 'evening'];

function parse(text) {
  try { return (typeof text === 'string' ? JSON.parse(text || '{}') : text) || {}; } catch { return {}; }
}

// "12:30,19:00" -> [750, 1140] (minutes after midnight, sorted, no repeats).
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

const hhmm = (m) => String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');

function partOfMinutes(minutes) {
  return minutes < MORNING_ENDS ? 'morning' : 'evening';
}

function valid(daypart) {
  return PARTS.includes(daypart) ? daypart : null;
}

// The posting slots a video of this part of the day may take. With no slot of
// that part configured, any slot (the post must still go out).
function slotsFor(slots, daypart) {
  if (!valid(daypart)) return slots;
  const mine = slots.filter((m) => partOfMinutes(m) === daypart);
  return mine.length ? mine : slots;
}

function isFairouz(t) {
  return FAIROUZ.test(String((t && t.title) || '') + ' ' + String((t && t.artist) || ''));
}

// One line for the owner (shown with the video in the Publish Queue).
function label(daypart, publishSlots) {
  if (!valid(daypart)) return '';
  const times = slotsFor(parseSlots(publishSlots), daypart).map(hhmm).join(' / ');
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
// waiting (being made, in review, or approved but not out yet), so morning and
// evening slots fill evenly. On a tie, the other part than the latest video.
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
  if (n.morning !== n.evening) return n.morning < n.evening ? 'morning' : 'evening';
  const last = await db.query("SELECT copy_json FROM media_prep WHERE copy_json LIKE '%\"daypart\"%' ORDER BY updated_at DESC LIMIT 1");
  return last && last.length && parse(last[0].copy_json).daypart === 'morning' ? 'evening' : 'morning';
}

// Instagram tracks the latest posts carry (and videos being made right now).
async function recentIgTracks(count) {
  const ids = new Set();
  const q = await db.query(
    "SELECT post_options FROM publish_queue WHERE platform = 'instagram' AND post_options LIKE '%audio_id%' AND status <> 'dropped'" +
    ' ORDER BY id DESC LIMIT ' + Math.max(1, Math.floor(count))
  );
  for (const r of q || []) {
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
  const recent = await recentIgTracks(4);
  const fresh = list.filter((t) => !recent.has(String(t.audio_id)));
  if (fresh.length) list = fresh;
  // stable sort: among equally used tracks the trend order stays
  list = list.slice().sort((a, b) => (Number(a.uses) || 0) - (Number(b.uses) || 0));
  return list.slice(0, 12).map((t) => ({
    audio_id: String(t.audio_id), title: t.title, artist: t.artist, audio_type: t.audio_type,
    badge: t.badge, age_hours: t.age_hours, uses: Number(t.uses) || 0, watch_terms: t.watch_terms || []
  }));
}

// Sound Library tracks the latest videos were cut to - the next video gets another.
async function recentMusic(count) {
  const r = await db.query(
    "SELECT sound_media_id FROM media_prep WHERE sound_media_id IS NOT NULL AND status NOT IN ('failed','skipped')" +
    ' ORDER BY updated_at DESC LIMIT ' + Math.max(1, Math.floor(count))
  );
  return new Set((r || []).map((x) => Number(x.sound_media_id)));
}

module.exports = {
  MORNING_ENDS, parseSlots, partOfMinutes, slotsFor, isFairouz, label, valid,
  forPrep, next, igTracks, recentIgTracks, recentMusic
};
