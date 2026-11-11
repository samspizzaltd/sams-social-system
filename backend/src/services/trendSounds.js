const db = require('../database/db');

// Trending Sounds radar (owner, 2026-11-11: harvest the sounds that are hitting
// high trends, catch them as they START trending, and add them to the sounds
// only after he has reviewed and approved them).
//
// Source: Meta's Instagram Audio API (Facebook Login; changelog 1 June 2026):
//   GET /ig_audio?audio_type=music|original_sound&user_id=<ig user id>
// Without a search query it returns what is trending on Instagram right now -
// audio Meta has "authorized for third party use". Both lists are read every
// few hours and each sound's place in the list is kept (trend_sightings), so
// the panel can show which sounds just appeared, which climb, which hold and
// which fade.
//
// How these sounds may be used: ONLY attached to an Instagram Reel when it is
// published (audio_configuration on POST /{ig-user-id}/media - see
// metaPublish.igCreateContainer). The track is never copied into our video
// files: in TikTok / YouTube / Facebook videos a copied hit song gets muted or
// claimed, and TikTok business accounts may only use TikTok's Commercial Music
// Library. Nothing is offered to the autopilot before the owner approves it.

const GRAPH = 'https://graph.facebook.com/v26.0';
const TYPES = ['music', 'original_sound'];
const EVERY_MS = 6 * 3600 * 1000;
const FIRST_RUN_MS = 2 * 60 * 1000;
const MANUAL_COOLDOWN_MS = 10 * 60 * 1000;
const JUST_STARTED_MIN = 24 * 60;
const GONE_AFTER_MIN = 3 * 24 * 60;
const FRESH_DAYS = 7; // an approved sound is offered while it trended in the last 7 days
const KEEP_SIGHTINGS_DAYS = 45;
const BADGE_ORDER = { just_started: 0, climbing: 1, holding: 2, fading: 3, gone: 4 };

const state = { running: false, lastRun: null, lastManualAt: 0, timer: null, preferToken: 'page' };

const clip = (s, n) => (s == null ? null : Array.from(String(s)).slice(0, n).join(''));
const validId = (s) => /^[A-Za-z0-9_-]{3,64}$/.test(String(s || ''));

// The Instagram account (its id) and the tokens that may read the list: the
// Page token the Instagram account was connected with, then the owner's user
// token (Meta's page names a user token; the Page token is tried first because
// it never expires). Tokens are never logged or returned.
async function credentials() {
  const rows = await db.query(
    "SELECT platform, business_account_id, access_token FROM accounts WHERE platform IN ('instagram','meta_user') AND status = 'active' ORDER BY id DESC"
  );
  if (rows === null) return null;
  const ig = rows.find((r) => r.platform === 'instagram');
  const user = rows.find((r) => r.platform === 'meta_user');
  const list = [];
  if (ig && ig.access_token) list.push({ kind: 'page', token: ig.access_token });
  if (user && user.access_token) list.push({ kind: 'user', token: user.access_token });
  if (state.preferToken === 'user') list.reverse();
  return { igId: ig ? String(ig.business_account_id) : null, list };
}

async function graphGet(path, igId, token) {
  const url = GRAPH + path + (path.includes('?') ? '&' : '?') + 'user_id=' + encodeURIComponent(igId) +
    '&access_token=' + encodeURIComponent(token);
  try {
    const r = await fetch(url);
    const j = await r.json().catch(() => null);
    if (!j) return { ok: false, error: 'HTTP ' + r.status + ' (no JSON)' };
    if (j.error) return { ok: false, error: String(j.error.message || 'Graph error'), code: j.error.code };
    return { ok: true, body: j };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// Tries each token until one works; remembers which one did.
async function graphWithAnyToken(path, creds) {
  let firstError = null;
  for (const t of creds.list) {
    const r = await graphGet(path, creds.igId, t.token);
    if (r.ok) {
      state.preferToken = t.kind;
      return r;
    }
    if (!firstError) firstError = r.error;
  }
  return { ok: false, error: firstError || 'no token available' };
}

function mapItem(x, type) {
  if (!x || typeof x !== 'object') return null;
  const id = String(x.audio_id || x.id || '');
  if (!validId(id)) return null;
  const t = x.audio_type === 'original_sound' || type === 'original_sound' ? 'original_sound' : 'music';
  return {
    audio_id: id,
    audio_type: t,
    title: clip(x.title, 300),
    artist: clip(t === 'music' ? x.display_artist : (x.ig_username ? '@' + x.ig_username : x.display_artist), 300),
    duration_ms: Number.isFinite(Number(x.duration_in_ms)) ? Math.round(Number(x.duration_in_ms)) : null,
    cover_url: clip(x.cover_artwork_thumbnail_uri || x.cover_artwork_thumbnail_url || x.profile_picture_url || null, 2000),
    preview_url: clip(x.download_url || null, 2000),
    preview_link: clip(x.on_platform_audio_preview_link || null, 2000),
    ads_eligible: x.is_ads_eligible === true ? 1 : x.is_ads_eligible === false ? 0 : null
  };
}

// One read of both trending lists. Single-flight; never throws.
async function run(trigger) {
  if (state.running) return state.lastRun;
  state.running = true;
  const started = Date.now();
  const report = { at: new Date().toISOString(), trigger, ms: 0, lists: {}, error: null };
  try {
    const creds = await credentials();
    if (creds === null) throw new Error('database unavailable');
    if (!creds.igId || !creds.list.length) throw new Error('Instagram is not connected (Settings → Platform Connections)');
    const nowRow = await db.query('SELECT NOW() AS t');
    if (!nowRow) throw new Error('database unavailable');
    const runAt = nowRow[0].t;
    for (const type of TYPES) {
      const r = await graphWithAnyToken('/ig_audio?audio_type=' + type, creds);
      if (!r.ok) {
        report.lists[type] = { ok: false, error: clip(r.error, 300) };
        continue;
      }
      const raw = Array.isArray(r.body.audio) ? r.body.audio : Array.isArray(r.body.data) ? r.body.data : [];
      const items = raw.map((x) => mapItem(x, type)).filter(Boolean);
      let fresh = 0;
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        const pos = i + 1;
        const have = await db.query('SELECT audio_id FROM trend_sounds WHERE audio_id = ?', [it.audio_id]);
        if (have === null) throw new Error('database unavailable');
        if (have.length) {
          await db.query(
            'UPDATE trend_sounds SET title = ?, artist = ?, duration_ms = ?, cover_url = COALESCE(?, cover_url),' +
            ' preview_url = COALESCE(?, preview_url), preview_link = COALESCE(?, preview_link), ads_eligible = ?,' +
            ' last_seen_at = ?, last_position = ?, best_position = LEAST(COALESCE(best_position, ?), ?), times_seen = times_seen + 1' +
            ' WHERE audio_id = ?',
            [it.title, it.artist, it.duration_ms, it.cover_url, it.preview_url, it.preview_link, it.ads_eligible,
              runAt, pos, pos, pos, it.audio_id]
          );
        } else {
          await db.query(
            'INSERT INTO trend_sounds (audio_id, audio_type, title, artist, duration_ms, cover_url, preview_url, preview_link,' +
            ' ads_eligible, first_seen_at, last_seen_at, first_position, best_position, last_position, times_seen)' +
            ' VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)',
            [it.audio_id, it.audio_type, it.title, it.artist, it.duration_ms, it.cover_url, it.preview_url, it.preview_link,
              it.ads_eligible, runAt, runAt, pos, pos, pos]
          );
          fresh++;
        }
        await db.query('INSERT INTO trend_sightings (run_at, audio_id, audio_type, position) VALUES (?,?,?,?)',
          [runAt, it.audio_id, it.audio_type, pos]);
      }
      report.lists[type] = { ok: true, seen: items.length, new: fresh };
    }
    await db.query('DELETE FROM trend_sightings WHERE run_at < NOW() - INTERVAL ' + KEEP_SIGHTINGS_DAYS + ' DAY');
    const okLists = Object.values(report.lists).filter((l) => l.ok);
    if (!okLists.length) report.error = 'Instagram did not return the trending lists: ' + Object.values(report.lists).map((l) => l.error).join(' / ');
  } catch (err) {
    report.error = clip(err.message, 300);
  } finally {
    report.ms = Date.now() - started;
    state.lastRun = report;
    state.running = false;
  }
  if (report.error) console.warn('[trends] ' + report.error);
  else console.log('[trends] read: ' + TYPES.map((t) => t + ' ' + (report.lists[t].ok ? report.lists[t].seen + ' (' + report.lists[t].new + ' new)' : 'failed')).join(', '));
  return report;
}

function requestRun() {
  if (state.running) return { started: false, running: true };
  const wait = state.lastManualAt + MANUAL_COOLDOWN_MS - Date.now();
  if (wait > 0) return { started: false, retry_in_s: Math.ceil(wait / 1000) };
  state.lastManualAt = Date.now();
  run('manual').catch(() => {});
  return { started: true };
}

const BASE_SELECT =
  'SELECT t.*,' +
  ' TIMESTAMPDIFF(MINUTE, t.first_seen_at, NOW()) AS age_min,' +
  ' TIMESTAMPDIFF(MINUTE, t.last_seen_at, NOW()) AS unseen_min,' +
  ' (t.last_seen_at >= (SELECT MAX(s.run_at) FROM trend_sightings s WHERE s.audio_type = t.audio_type)) AS in_latest,' +
  ' (t.first_seen_at <= (SELECT MIN(s2.run_at) FROM trend_sightings s2) + INTERVAL 1 MINUTE) AS since_start' +
  ' FROM trend_sounds t';

// just_started: appeared in the last 24 h (and was NOT already there when
// watching began); climbing: 3+ places higher than where it entered;
// holding: still in the list; fading: dropped out of the latest list;
// gone: not seen for 3 days.
function withBadge(r) {
  let badge;
  if (!Number(r.in_latest)) badge = Number(r.unseen_min) > GONE_AFTER_MIN ? 'gone' : 'fading';
  else if (Number(r.age_min) <= JUST_STARTED_MIN && !Number(r.since_start)) badge = 'just_started';
  else if (r.first_position != null && r.last_position != null && Number(r.first_position) - Number(r.last_position) >= 3) badge = 'climbing';
  else badge = 'holding';
  return {
    audio_id: r.audio_id,
    platform: r.platform,
    audio_type: r.audio_type,
    title: r.title,
    artist: r.artist,
    duration_ms: r.duration_ms,
    cover_url: r.cover_url,
    preview_url: r.preview_url,
    preview_link: r.preview_link,
    ads_eligible: r.ads_eligible == null ? null : !!Number(r.ads_eligible),
    status: r.status,
    badge,
    first_seen_at: r.first_seen_at,
    last_seen_at: r.last_seen_at,
    age_hours: Math.round(Number(r.age_min) / 6) / 10,
    unseen_hours: Math.round(Number(r.unseen_min) / 6) / 10,
    first_position: r.first_position,
    best_position: r.best_position,
    last_position: r.last_position,
    times_seen: r.times_seen,
    uses: r.uses,
    decided_at: r.decided_at
  };
}

const byTrend = (a, b) => BADGE_ORDER[a.badge] - BADGE_ORDER[b.badge] ||
  Number(a.last_position || 999) - Number(b.last_position || 999) || String(a.audio_id).localeCompare(String(b.audio_id));

async function list(status) {
  const where = status === 'all' ? '' : ' WHERE t.status = ?';
  const rows = await db.query(BASE_SELECT + where + ' ORDER BY t.last_seen_at DESC LIMIT 300', status === 'all' ? [] : [status]);
  if (rows === null) return null;
  return rows.map(withBadge).sort(byTrend);
}

async function counts() {
  const rows = await db.query('SELECT status, COUNT(*) AS n FROM trend_sounds GROUP BY status');
  const out = { new: 0, approved: 0, rejected: 0 };
  for (const r of rows || []) out[r.status] = Number(r.n);
  return out;
}

async function decide(audioId, status) {
  if (!validId(audioId) || !['new', 'approved', 'rejected'].includes(status)) return { status: 400, error: 'Unknown sound or decision' };
  const r = await db.query('UPDATE trend_sounds SET status = ?, decided_at = NOW() WHERE audio_id = ?', [status, String(audioId)]);
  if (r === null) return { status: 503, error: 'Database unavailable' };
  if (!r.affectedRows) return { status: 404, error: 'Not found' };
  return { status: 200 };
}

// Approved sounds that trended in the last FRESH_DAYS - what the autopilot may
// put on an Instagram post. Best trend first, least used first.
async function approvedFresh(limit) {
  const rows = await db.query(
    BASE_SELECT + " WHERE t.status = 'approved' AND t.last_seen_at > NOW() - INTERVAL " + FRESH_DAYS + ' DAY'
  );
  if (rows === null) return null;
  return rows.map(withBadge)
    .sort((a, b) => BADGE_ORDER[a.badge] - BADGE_ORDER[b.badge] || Number(a.uses) - Number(b.uses) || byTrend(a, b))
    .slice(0, limit || 12);
}

async function approvedById(audioId) {
  if (!validId(audioId)) return null;
  const rows = await db.query("SELECT audio_id, audio_type, title, artist FROM trend_sounds WHERE audio_id = ? AND status = 'approved'", [String(audioId)]);
  return rows && rows.length ? rows[0] : null;
}

async function markUsed(audioId) {
  if (!validId(audioId)) return;
  await db.query('UPDATE trend_sounds SET uses = uses + 1 WHERE audio_id = ?', [String(audioId)]);
}

// A fresh preview link (Instagram's preview URLs expire after ~1.5 days).
async function refreshPreview(audioId) {
  if (!validId(audioId)) return { status: 400, error: 'Unknown sound' };
  const have = await db.query('SELECT audio_id FROM trend_sounds WHERE audio_id = ?', [String(audioId)]);
  if (have === null) return { status: 503, error: 'Database unavailable' };
  if (!have.length) return { status: 404, error: 'Not found' };
  const creds = await credentials();
  if (!creds || !creds.igId || !creds.list.length) return { status: 409, error: 'Instagram is not connected' };
  const r = await graphWithAnyToken('/' + encodeURIComponent(String(audioId)), creds);
  if (!r.ok) return { status: 502, error: 'Instagram: ' + clip(r.error, 200) };
  const it = mapItem(r.body, r.body.audio_type);
  if (!it) return { status: 502, error: 'Instagram returned no details for this sound' };
  await db.query('UPDATE trend_sounds SET preview_url = COALESCE(?, preview_url), cover_url = COALESCE(?, cover_url) WHERE audio_id = ?',
    [it.preview_url, it.cover_url, String(audioId)]);
  return { status: 200, preview_url: it.preview_url, preview_link: it.preview_link };
}

function start() {
  if (state.timer) return;
  setTimeout(() => { run('boot').catch(() => {}); }, FIRST_RUN_MS);
  state.timer = setInterval(() => { run('timer').catch(() => {}); }, EVERY_MS);
}

function status() {
  return {
    running: state.running,
    last_run: state.lastRun,
    every_hours: EVERY_MS / 3600000,
    fresh_days: FRESH_DAYS,
    manual_cooldown_s: Math.max(0, Math.ceil((state.lastManualAt + MANUAL_COOLDOWN_MS - Date.now()) / 1000))
  };
}

module.exports = {
  run, requestRun, list, counts, decide, approvedFresh, approvedById, markUsed, refreshPreview, start, status,
  _state: state // test harness
};
