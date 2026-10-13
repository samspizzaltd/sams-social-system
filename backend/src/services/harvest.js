const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');
const { Readable, Transform } = require('stream');
const db = require('../database/db');
const metaPublish = require('./metaPublish');

// Harvest the account's own best-performing videos (>= minViews) from
// Instagram and the Facebook Page, download them into the media library and
// stage them in the publish review queue as pending_review. NOTHING here
// publishes - every staged row still waits for the owner's Approve tap
// (owner rule 2026-10-12). Owner request 2026-10-13: until new footage
// arrives, re-use the existing 5K+ view posts.

const GRAPH = 'https://graph.facebook.com/v26.0';
const MAX_DOWNLOAD_BYTES = 60 * 1024 * 1024; // matches the upload cap
const MEDIA_DIR = path.join(__dirname, '..', '..', '..', 'media');

const state = {
  running: false,
  startedAt: null,
  finishedAt: null,
  minViews: null,
  scanned: 0,
  staged: 0,
  viewLookupFailures: 0,
  downloadedBytes: 0,
  log: [],
  skipped: [],
  error: null
};

function note(msg) {
  state.log.push(msg);
  if (state.log.length > 200) state.log.shift();
  console.log('[harvest] ' + msg);
}

function status() {
  return { ...state, log: state.log.slice(-30), skipped: state.skipped.slice(-30) };
}

async function alreadyHarvested(platform, platformMediaId) {
  const tag = ('harvest:' + platform + ':' + platformMediaId + ' ')
    .replace(/[\\%_]/g, (ch) => '\\' + ch); // escape LIKE wildcards
  const rows = await db.query('SELECT id FROM media WHERE note LIKE ? LIMIT 1', [tag + '%']);
  return !!(rows && rows.length);
}

async function graphGet(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(30 * 1000) });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message);
  return j;
}

// Views for an IG media item. Metric names shifted across Graph versions -
// try the current one first, fall back quietly.
async function igViews(mediaId, token) {
  for (const metric of ['views', 'plays', 'video_views']) {
    try {
      const j = await graphGet(GRAPH + '/' + mediaId + '/insights?metric=' + metric + '&access_token=' + encodeURIComponent(token));
      const v = j.data && j.data[0] && j.data[0].values && j.data[0].values[0];
      if (v && typeof v.value === 'number') return v.value;
    } catch { /* next metric */ }
  }
  // A failed lookup is NOT 0 views - count it so a dead token or rate limit
  // does not masquerade as 'no qualifying videos'.
  state.viewLookupFailures++;
  return 0;
}

async function igCandidates(minViews) {
  const ig = await metaPublish.account('instagram');
  if (!ig) { note('Instagram not connected - skipping'); return []; }
  const out = [];
  let url = GRAPH + '/' + ig.business_account_id +
    '/media?fields=id,media_type,media_product_type,media_url,permalink,caption,timestamp&limit=50&access_token=' +
    encodeURIComponent(ig.access_token);
  for (let page = 0; page < 3 && url; page++) {
    const j = await graphGet(url);
    for (const m of j.data || []) {
      if (m.media_type !== 'VIDEO') continue;
      state.scanned++;
      const views = await igViews(m.id, ig.access_token);
      if (views < minViews) continue;
      if (!m.media_url) {
        state.skipped.push('IG ' + m.id + ' (' + views + ' views): no downloadable media_url');
        continue;
      }
      out.push({
        platform: 'instagram',
        id: m.id,
        views,
        downloadUrl: m.media_url,
        caption: m.caption || '',
        permalink: m.permalink || null,
        timestamp: m.timestamp || null
      });
    }
    url = j.paging && j.paging.next ? j.paging.next : null;
  }
  return out;
}

async function fbViews(videoId, token) {
  try {
    const j = await graphGet(GRAPH + '/' + videoId + '/video_insights/total_video_views?access_token=' + encodeURIComponent(token));
    const v = j.data && j.data[0] && j.data[0].values && j.data[0].values[0];
    if (v && typeof v.value === 'number') return v.value;
  } catch { /* fall through */ }
  state.viewLookupFailures++;
  return 0;
}

async function fbCandidates(minViews) {
  const page = await metaPublish.account('facebook_page');
  if (!page) { note('Facebook Page not connected - skipping'); return []; }
  const out = [];
  let url = GRAPH + '/' + page.business_account_id +
    '/videos?fields=id,description,source,permalink_url,created_time&limit=50&access_token=' +
    encodeURIComponent(page.access_token);
  for (let p = 0; p < 3 && url; p++) {
    const j = await graphGet(url);
    for (const v of j.data || []) {
      state.scanned++;
      const views = await fbViews(v.id, page.access_token);
      if (views < minViews) continue;
      if (!v.source) {
        state.skipped.push('FB ' + v.id + ' (' + views + ' views): no downloadable source');
        continue;
      }
      out.push({
        platform: 'facebook_page',
        id: v.id,
        views,
        downloadUrl: v.source,
        caption: v.description || '',
        permalink: v.permalink_url ? 'https://www.facebook.com' + v.permalink_url : null,
        timestamp: v.created_time || null
      });
    }
    url = j.paging && j.paging.next ? j.paging.next : null;
  }
  return out;
}

// Stream the CDN file to disk with a hard byte cap (shared hosting - never
// buffer a whole video in memory, never let a runaway download fill the disk).
async function downloadVideo(url) {
  // 5-minute hard timeout: a trickling CDN must not hold state.running forever.
  const resp = await fetch(url, { signal: AbortSignal.timeout(5 * 60 * 1000) });
  if (!resp.ok || !resp.body) throw new Error('download failed: HTTP ' + resp.status);
  const len = Number(resp.headers.get('content-length') || 0);
  if (len > MAX_DOWNLOAD_BYTES) throw new Error('file too large (' + Math.round(len / 1048576) + ' MB)');

  const filename = crypto.randomBytes(12).toString('hex') + '.mp4';
  const filePath = path.join(MEDIA_DIR, filename);
  let bytes = 0;
  const capStream = new Transform({
    transform(chunk, enc, cb) {
      bytes += chunk.length;
      if (bytes > MAX_DOWNLOAD_BYTES) return cb(new Error('file exceeded the 60 MB cap mid-download'));
      cb(null, chunk);
    }
  });
  try {
    await pipeline(Readable.fromWeb(resp.body), capStream, fs.createWriteStream(filePath));
  } catch (err) {
    fs.unlink(filePath, () => {});
    throw err;
  }
  return { filename, size: bytes };
}

const MEDIA_BUDGET_BYTES = (Number(process.env.MEDIA_BUDGET_MB) || 2048) * 1024 * 1024;

// Same storage budget the upload route enforces - a harvest run must not be
// the thing that fills the shared host's small disk.
async function overBudget() {
  const used = await db.query('SELECT COALESCE(SUM(size_bytes),0) AS used FROM media');
  if (used === null) return true; // DB down: refuse to download blind
  return Number(used[0].used) + MAX_DOWNLOAD_BYTES > MEDIA_BUDGET_BYTES;
}

// Delete files in MEDIA_DIR that no media row references (crash leftovers).
// Only files older than an hour, so an in-flight upload is never touched.
async function sweepOrphanFiles() {
  const rows = await db.query('SELECT filename FROM media WHERE filename IS NOT NULL');
  if (rows === null) return; // DB down - cannot tell orphans apart, skip
  const known = new Set(rows.map(r => r.filename));
  let names = [];
  try { names = fs.readdirSync(MEDIA_DIR); } catch { return; }
  const cutoff = Date.now() - 3600 * 1000;
  for (const name of names) {
    if (known.has(name)) continue;
    try {
      const st = fs.statSync(path.join(MEDIA_DIR, name));
      if (st.isFile() && st.mtimeMs < cutoff) {
        fs.unlinkSync(path.join(MEDIA_DIR, name));
        note('removed orphan file ' + name + ' (' + Math.round(st.size / 1048576) + ' MB)');
      }
    } catch { /* best effort */ }
  }
}

const CAPTION_LIMIT = { instagram: 2200, facebook_page: 5000 };

async function stageCandidate(c) {
  if (await alreadyHarvested(c.platform, c.id)) {
    state.skipped.push(c.platform + ' ' + c.id + ': already harvested earlier');
    return;
  }
  if (await overBudget()) {
    throw new Error('media storage budget reached (' + Math.round(MEDIA_BUDGET_BYTES / 1048576) + ' MB) - delete old files first');
  }
  const dl = await downloadVideo(c.downloadUrl);
  state.downloadedBytes += dl.size;
  const title = ('Repost ' + (c.views >= 1000 ? Math.round(c.views / 1000) + 'K' : c.views) + ' views - ' +
    (c.caption ? c.caption.split('\n')[0] : c.platform)).slice(0, 255);
  const noteText = ('harvest:' + c.platform + ':' + c.id + ' | ' + c.views + ' views | ' + (c.permalink || '')).slice(0, 500);

  const media = await db.query(
    'INSERT INTO media (kind, title, filename, url_path, size_bytes, note) VALUES (?,?,?,?,?,?)',
    ['video', title, dl.filename, '/media/' + dl.filename, dl.size, noteText]
  );
  if (media === null) {
    fs.unlink(path.join(MEDIA_DIR, dl.filename), () => {});
    throw new Error('database unavailable while saving ' + c.platform + ' ' + c.id);
  }

  const caption = (c.caption && c.caption.trim())
    ? c.caption.slice(0, CAPTION_LIMIT[c.platform])
    : "Sam's - More Than Pizza 🍕";
  const q = await db.query(
    'INSERT INTO publish_queue (platform, media_id, caption, status) VALUES (?,?,?,?)',
    [c.platform, media.insertId, caption, 'pending_review']
  );
  if (q === null) {
    await db.query('DELETE FROM media WHERE id = ?', [media.insertId]);
    fs.unlink(path.join(MEDIA_DIR, dl.filename), () => {});
    throw new Error('database unavailable while staging ' + c.platform + ' ' + c.id);
  }
  state.staged++;
  note('staged ' + c.platform + ' ' + c.id + ' (' + c.views + ' views, ' + Math.round(dl.size / 1048576) + ' MB)');
}

async function runHarvest(minViews, limit) {
  state.running = true;
  state.startedAt = new Date().toISOString();
  state.finishedAt = null;
  state.minViews = minViews;
  state.scanned = 0;
  state.staged = 0;
  state.viewLookupFailures = 0;
  state.downloadedBytes = 0;
  state.log = [];
  state.skipped = [];
  state.error = null;
  try {
    await sweepOrphanFiles();
    note('scanning Instagram + Facebook for videos with >= ' + minViews + ' views (most recent ~150 posts per platform)');
    const [ig, fb] = [await igCandidates(minViews), await fbCandidates(minViews)];
    const all = [...ig, ...fb].sort((a, b) => b.views - a.views).slice(0, limit);
    note('found ' + (ig.length + fb.length) + ' qualifying videos (IG ' + ig.length + ', FB ' + fb.length + '), taking top ' + all.length);
    for (const c of all) {
      try {
        await stageCandidate(c);
      } catch (err) {
        state.skipped.push(c.platform + ' ' + c.id + ': ' + err.message);
      }
    }
    let doneMsg = 'done - ' + state.staged + ' staged for your review, ' + state.skipped.length + ' skipped';
    if (state.viewLookupFailures > 0) {
      doneMsg += ' | WARNING: ' + state.viewLookupFailures + ' view lookups failed (token/permission/rate limit?) - real numbers may be higher';
    }
    note(doneMsg);
  } catch (err) {
    state.error = err.message;
    note('FAILED: ' + err.message);
  } finally {
    state.running = false;
    state.finishedAt = new Date().toISOString();
  }
}

// Fire-and-forget starter (the Apache proxy cuts requests at 60s, so the
// HTTP route returns immediately and the panel polls status()).
function start(minViews, limit) {
  if (state.running) return { ok: false, error: 'A harvest is already running' };
  runHarvest(minViews, limit); // intentionally not awaited
  return { ok: true };
}

module.exports = { start, status };
