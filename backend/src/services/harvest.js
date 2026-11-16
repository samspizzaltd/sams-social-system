const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');
const { Readable, Transform } = require('stream');
const db = require('../database/db');
const metaPublish = require('./metaPublish');
const tiktokBusiness = require('./tiktokBusiness');
const youtubePublish = require('./youtubePublish');

// Harvest the account's own best-performing videos (>= minViews) from
// Instagram and the Facebook Page, download them into the media library and
// stage them in the publish review queue as pending_review.
// TikTok and YouTube are scanned too (owner 2026-11-16: "add YouTube and
// TikTok to the places where harvesting can happen"), but neither hands a
// video file to apps - TikTok's business interface gives the post link,
// YouTube's API has no download at all - and taking the file any other way
// breaks their rules (and could cost the connections). Their top videos are
// LISTED for the owner (state.manual) with the link; he saves the file
// (YouTube Studio -> Download; for TikTok best the original from his phone,
// as TikTok's own download adds its logo) and uploads it next to the item,
// which stages it like the others (stageUpload). NOTHING here
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
  // TikTok / YouTube top videos the owner saves and uploads himself
  manual: [],
  // check only (dry_run): nothing downloaded or staged, the Instagram/Facebook finds are counted
  dryRun: false,
  wouldStage: 0,
  error: null
};

function note(msg) {
  state.log.push(msg);
  if (state.log.length > 200) state.log.shift();
  console.log('[harvest] ' + msg);
}

function status() {
  return { ...state, log: state.log.slice(-30), skipped: state.skipped.slice(-30), manual: state.manual.slice(0, 25) };
}

async function alreadyHarvested(platform, platformMediaId) {
  const tag = ('harvest:' + platform + ':' + platformMediaId + ' ')
    .replace(/[\\%_]/g, (ch) => '\\' + ch); // escape LIKE wildcards
  const rows = await db.query('SELECT id FROM media WHERE note LIKE ? LIMIT 1', [tag + '%']);
  return !!(rows && rows.length);
}

// Was this video used before? (2026-11-11) The first library videos were
// downloaded by hand with the Instagram shortcode in the file name, and the
// system's own new posts are on the account too - neither may come back as a
// "repost". Returns a reason string, false, or null when the database is down.
const likeEsc = (s) => String(s).replace(/[\\%_]/g, (ch) => '\\' + ch);
function shortcodeOf(permalink) {
  const m = /instagram\.com\/(?:reel|reels|p|tv)\/([A-Za-z0-9_-]{5,})/.exec(String(permalink || ''));
  return m ? m[1] : null;
}
async function usedBefore(c) {
  const code = c.platform === 'instagram' ? shortcodeOf(c.permalink) : null;
  const own = await db.query(
    'SELECT id FROM publish_queue WHERE published_media_id = ? OR (permalink IS NOT NULL AND permalink LIKE ?) LIMIT 1',
    [String(c.id), '%' + likeEsc(code || c.id) + '%']
  );
  if (own === null) return null;
  if (own.length) return 'one of the posts this system published';
  if (code) {
    const pat = '%' + likeEsc(code) + '%';
    // original_title: the name before Analyze & name renamed it (mediaNamer.js).
    const lib = await db.query('SELECT id FROM media WHERE title LIKE ? OR original_title LIKE ? OR filename LIKE ? OR note LIKE ? LIMIT 1', [pat, pat, pat, pat]);
    if (lib === null) return null;
    if (lib.length) return 'already in the library (' + code + ')';
  }
  return false;
}
// The same clip posted on Instagram AND Facebook: same caption start.
function captionKey(caption) {
  const k = String(caption || '').toLowerCase().replace(/#[^\s#]+/g, ' ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().slice(0, 60);
  return k.length >= 12 ? k : null;
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

// ---------- TikTok + YouTube: found here, file from the owner ----------

function cleanLink(url) {
  const u = String(url || '').split('?')[0];
  return /^https:\/\/(www\.)?(tiktok\.com|youtube\.com|youtu\.be)\//.test(u) ? u : null;
}

async function ttCandidates(minViews) {
  if (!(await tiktokBusiness.account())) { note('TikTok (business) not connected - skipping'); return []; }
  const r = await tiktokBusiness.listVideos(8);
  if (!r.ok) {
    state.viewLookupFailures++;
    note('TikTok: could not read all videos - ' + r.error);
  }
  const out = [];
  for (const v of r.videos || []) {
    state.scanned++;
    const views = Number(v.video_views);
    if (!Number.isFinite(views)) { state.viewLookupFailures++; continue; }
    if (views < minViews || !v.item_id) continue;
    out.push({
      platform: 'tiktok',
      id: String(v.item_id),
      views,
      downloadUrl: null, // TikTok gives no file to apps
      caption: v.caption || '',
      title: String(v.caption || '').split('\n')[0],
      permalink: cleanLink(v.share_url),
      thumbnail: v.thumbnail_url || null,
      timestamp: v.create_time ? new Date(Number(v.create_time) * 1000).toISOString() : null
    });
  }
  return out;
}

async function ytCandidates(minViews) {
  if (!(await youtubePublish.account())) { note('YouTube not connected - skipping'); return []; }
  const r = await youtubePublish.listUploads(150);
  if (!r.ok) {
    state.viewLookupFailures++;
    note('YouTube: could not read the uploads - ' + r.error);
  }
  const out = [];
  for (const v of r.videos || []) {
    state.scanned++;
    if (v.views < minViews) continue;
    out.push({
      platform: 'youtube',
      id: v.id,
      views: v.views,
      downloadUrl: null, // YouTube's API has no download
      caption: '', // YouTube text is not kept (Google's 30-day data rule)
      title: v.title || '',
      permalink: 'https://www.youtube.com/shorts/' + v.id,
      thumbnail: v.thumbnail || null,
      timestamp: v.published_at || null
    });
  }
  return out;
}

// Caption keys of videos harvested in earlier runs (title "Repost 12K views -
// <first caption line>", or its name before Analyze & name renamed it), so a
// TikTok copy of an Instagram reel harvested last week is not listed again.
async function harvestedCaptionKeys() {
  const rows = await db.query("SELECT title, original_title FROM media WHERE note LIKE 'harvest:%' LIMIT 2000");
  const keys = new Set();
  for (const r of rows || []) {
    const t = String(r.original_title || r.title || '');
    const k = captionKey(t.replace(/^Repost[^-]*-\s*/, ''));
    if (k) keys.add(k);
  }
  return keys;
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
    // TikTok's URL-verification signature file (tiktokBusiness.js) is not
    // media, and TikTok may check it again - never an orphan.
    if (/\.txt$/i.test(name)) continue;
    try {
      const st = fs.statSync(path.join(MEDIA_DIR, name));
      if (st.isFile() && st.mtimeMs < cutoff) {
        fs.unlinkSync(path.join(MEDIA_DIR, name));
        note('removed orphan file ' + name + ' (' + Math.round(st.size / 1048576) + ' MB)');
      }
    } catch { /* best effort */ }
  }
}

const CAPTION_LIMIT = { instagram: 2200, facebook_page: 5000, tiktok: 2200, youtube: 5000 };

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

async function runHarvest(minViews, limit, dryRun) {
  state.running = true;
  state.startedAt = new Date().toISOString();
  state.finishedAt = null;
  state.minViews = minViews;
  state.dryRun = !!dryRun;
  state.wouldStage = 0;
  state.scanned = 0;
  state.staged = 0;
  state.viewLookupFailures = 0;
  state.downloadedBytes = 0;
  state.log = [];
  state.skipped = [];
  state.manual = [];
  state.error = null;
  try {
    await sweepOrphanFiles();
    note('scanning Instagram, Facebook, TikTok and YouTube for videos with >= ' + minViews + ' views (most recent ~150 posts per platform)');
    const [ig, fb] = [await igCandidates(minViews), await fbCandidates(minViews)];
    // One of these two failing must not stop the Instagram/Facebook harvest.
    const quietly = async (fn, name) => {
      try { return await fn(minViews); } catch (err) { state.viewLookupFailures++; note(name + ' scan failed: ' + err.message); return []; }
    };
    const tt = await quietly(ttCandidates, 'TikTok');
    const yt = await quietly(ytCandidates, 'YouTube');
    // Leave out what was used before BEFORE taking the top N, so old library
    // videos and our own new posts do not use up the places (2026-11-11).
    const all = [];
    const captions = new Set();
    for (const c of [...ig, ...fb].sort((a, b) => b.views - a.views)) {
      if (all.length >= limit) break;
      if (await alreadyHarvested(c.platform, c.id)) { state.skipped.push(c.platform + ' ' + c.id + ': already harvested earlier'); continue; }
      const used = await usedBefore(c);
      if (used === null) throw new Error('database unavailable while checking ' + c.platform + ' ' + c.id);
      if (used) { state.skipped.push(c.platform + ' ' + c.id + ' (' + c.views + ' views): ' + used); continue; }
      const key = captionKey(c.caption);
      if (key && captions.has(key)) { state.skipped.push(c.platform + ' ' + c.id + ': the same video as another candidate (same caption)'); continue; }
      if (key) captions.add(key);
      all.push(c);
    }
    // TikTok + YouTube: listed for the owner to save and upload (no file
    // through their APIs) - not the ones this system posted, not a copy of an
    // Instagram/Facebook video harvested now or earlier.
    const earlier = await harvestedCaptionKeys();
    for (const c of [...tt, ...yt].sort((a, b) => b.views - a.views)) {
      if (state.manual.length >= limit) break;
      if (await alreadyHarvested(c.platform, c.id)) { state.skipped.push(c.platform + ' ' + c.id + ': already harvested earlier'); continue; }
      const used = await usedBefore(c);
      if (used === null) throw new Error('database unavailable while checking ' + c.platform + ' ' + c.id);
      if (used) { state.skipped.push(c.platform + ' ' + c.id + ' (' + c.views + ' views): ' + used); continue; }
      const key = captionKey(c.caption);
      if (key && (captions.has(key) || earlier.has(key))) { state.skipped.push(c.platform + ' ' + c.id + ': the same video as an Instagram/Facebook repost (same caption)'); continue; }
      if (key) captions.add(key);
      state.manual.push({
        platform: c.platform, id: c.id, views: c.views, title: String(c.title || '').slice(0, 140),
        permalink: c.permalink, thumbnail: c.thumbnail, timestamp: c.timestamp,
        caption: String(c.caption || '').slice(0, CAPTION_LIMIT[c.platform])
      });
    }
    note('found ' + (ig.length + fb.length + tt.length + yt.length) + ' qualifying videos (IG ' + ig.length + ', FB ' + fb.length +
      ', TikTok ' + tt.length + ', YouTube ' + yt.length + '), taking ' + all.length + ' not used before; ' + state.manual.length +
      ' TikTok/YouTube video(s) listed for you to save and upload');
    for (const c of all) {
      if (dryRun) {
        state.wouldStage++;
        note('check only - would stage ' + c.platform + ' ' + c.id + ' (' + c.views + ' views)');
        continue;
      }
      try {
        await stageCandidate(c);
      } catch (err) {
        state.skipped.push(c.platform + ' ' + c.id + ': ' + err.message);
      }
    }
    let doneMsg = 'done' + (dryRun ? ' (check only) - ' + state.wouldStage + ' would be staged, ' : ' - ' + state.staged + ' staged for your review, ') + state.manual.length + ' to save from TikTok/YouTube, ' + state.skipped.length + ' skipped';
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

// The owner's saved copy of a TikTok / YouTube top video (multer already
// wrote it to the media folder): into the library as a harvested repost and
// staged for review on that platform - like a downloaded Instagram reel. The
// autopilot then makes its edit for every platform. Returns {status, ...};
// on an error the caller removes the file.
const ID_OK = { tiktok: /^\d{5,30}$/, youtube: /^[A-Za-z0-9_-]{11}$/ };
const DEFAULT_CAPTION = "Sam's - More Than Pizza 🍕";
async function stageUpload(file, platform, id) {
  platform = String(platform || '');
  id = String(id || '');
  if (!ID_OK[platform]) return { status: 400, error: 'platform must be tiktok or youtube' };
  if (!ID_OK[platform].test(id)) return { status: 400, error: 'That is not a ' + platform + ' video id' };
  if (!file || !/^video\//.test(String(file.mimetype || ''))) return { status: 400, error: 'Pick the saved video file (MP4 or MOV)' };
  const before = await alreadyHarvested(platform, id);
  if (before) return { status: 409, error: 'This ' + (platform === 'tiktok' ? 'TikTok' : 'YouTube') + ' video is in the library already' };
  const item = state.manual.find((x) => x.platform === platform && x.id === id) || null;
  const name = String(file.originalname || '').replace(/\.[A-Za-z0-9]{2,4}$/, '').slice(0, 120);
  const k = item && item.views >= 1000 ? Math.round(item.views / 1000) + 'K' : item ? String(item.views) : '';
  // YouTube: nothing from its API is kept (title, numbers) - the file name is his own.
  const title = (platform === 'tiktok'
    ? 'Repost ' + (k ? k + ' views ' : '') + '- ' + ((item && item.title) || name || 'TikTok video')
    : 'Repost from YouTube - ' + (name || id)).slice(0, 255);
  const noteText = ('harvest:' + platform + ':' + id + ' | ' + (platform === 'tiktok' && item ? item.views + ' views | ' : 'uploaded by you | ') +
    (platform === 'tiktok' ? ((item && item.permalink) || '') : 'https://www.youtube.com/shorts/' + id)).slice(0, 500);
  const media = await db.query(
    'INSERT INTO media (kind, title, filename, url_path, size_bytes, note) VALUES (?,?,?,?,?,?)',
    ['video', title, file.filename, '/media/' + file.filename, file.size, noteText]
  );
  if (media === null) return { status: 503, error: 'Database unavailable' };
  const caption = platform === 'tiktok' && item && item.caption.trim() ? item.caption.slice(0, CAPTION_LIMIT.tiktok) : DEFAULT_CAPTION;
  const q = await db.query(
    'INSERT INTO publish_queue (platform, media_id, caption, status) VALUES (?,?,?,?)',
    [platform, media.insertId, caption, 'pending_review']
  );
  if (q === null) {
    await db.query('DELETE FROM media WHERE id = ?', [media.insertId]);
    return { status: 503, error: 'Database unavailable' };
  }
  state.manual = state.manual.filter((x) => !(x.platform === platform && x.id === id));
  note('staged ' + platform + ' ' + id + ' from your upload (library #' + media.insertId + ')');
  return { status: 201, ok: true, media_id: media.insertId, queue_id: q.insertId };
}

// Fire-and-forget starter (the Apache proxy cuts requests at 60s, so the
// HTTP route returns immediately and the panel polls status()).
function start(minViews, limit, dryRun) {
  if (state.running) return { ok: false, error: 'A harvest is already running' };
  runHarvest(minViews, limit, dryRun); // intentionally not awaited
  return { ok: true };
}

module.exports = { start, status, stageUpload, _usedBefore: usedBefore, _captionKey: captionKey, _state: state };
