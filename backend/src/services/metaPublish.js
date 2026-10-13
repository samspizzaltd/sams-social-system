const db = require('../database/db');

// Shared Meta publishing helpers used by the publish queue finisher.
// All functions return { ok, ... } and never throw to the caller.

const GRAPH = 'https://graph.facebook.com/v26.0';

async function account(platform) {
  const rows = await db.query(
    'SELECT business_account_id, access_token FROM accounts WHERE platform = ? AND status = ? ORDER BY id DESC LIMIT 1',
    [platform, 'active']
  );
  return rows && rows.length ? rows[0] : null;
}

// ---------- Instagram Reels ----------

async function igCreateContainer(videoUrl, caption) {
  const ig = await account('instagram');
  if (!ig) return { ok: false, error: 'Instagram not connected' };
  try {
    const params = new URLSearchParams({
      media_type: 'REELS',
      video_url: videoUrl,
      caption: String(caption || '').slice(0, 2200),
      access_token: ig.access_token
    });
    const r = await fetch(GRAPH + '/' + ig.business_account_id + '/media', { method: 'POST', body: params });
    const j = await r.json();
    if (!j.id) return { ok: false, error: (j.error && j.error.message) || 'container creation failed' };
    return { ok: true, creationId: j.id };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// Returns {ok, done, error?, mediaId?, permalink?, maybePublished?}
// maybePublished=true means the publish request itself was SENT but its
// outcome is unknown (connection died, unparseable response). The caller must
// NOT turn that into a retryable failure - retrying would double-publish.
async function igTryPublish(creationId) {
  const ig = await account('instagram');
  if (!ig) return { ok: false, error: 'Instagram not connected' };

  // Status poll: failures here are clean - nothing was published yet.
  let sj;
  try {
    const st = await fetch(GRAPH + '/' + creationId + '?fields=status_code,status&access_token=' + encodeURIComponent(ig.access_token));
    sj = await st.json();
  } catch (err) {
    return { ok: false, error: 'status poll failed: ' + err.message };
  }
  if (sj.error) return { ok: false, error: sj.error.message };
  if (sj.status_code === 'ERROR') return { ok: false, error: 'processing failed: ' + (sj.status || '') };
  if (sj.status_code === 'EXPIRED') return { ok: false, error: 'container expired before publish' };
  if (sj.status_code === 'PUBLISHED') {
    // Already live (an earlier publish call landed but its result was lost).
    return { ok: true, done: true, mediaId: null, permalink: null, alreadyPublished: true };
  }
  if (sj.status_code !== 'FINISHED') return { ok: true, done: false };

  // Publish: from here on, an ambiguous outcome must never become retryable.
  let j;
  try {
    const params = new URLSearchParams({ creation_id: creationId, access_token: ig.access_token });
    const r = await fetch(GRAPH + '/' + ig.business_account_id + '/media_publish', { method: 'POST', body: params });
    j = await r.json();
  } catch (err) {
    return { ok: false, maybePublished: true, error: 'publish outcome unknown: ' + err.message };
  }
  if (!j.id) {
    // A parsed Graph error means Meta rejected the publish - that IS retryable.
    if (j.error && j.error.message) return { ok: false, error: j.error.message };
    return { ok: false, maybePublished: true, error: 'publish returned an unrecognized response' };
  }

  let permalink = null;
  try {
    const p = await fetch(GRAPH + '/' + j.id + '?fields=permalink&access_token=' + encodeURIComponent(ig.access_token));
    permalink = (await p.json()).permalink || null;
  } catch { /* permalink is cosmetic */ }
  return { ok: true, done: true, mediaId: j.id, permalink };
}

// ---------- Facebook Page Reels (3-phase, via file_url) ----------

async function pageStartReel(videoUrl) {
  const page = await account('facebook_page');
  if (!page) return { ok: false, error: 'Facebook Page not connected' };
  try {
    const start = await fetch(GRAPH + '/' + page.business_account_id + '/video_reels', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ upload_phase: 'start', access_token: page.access_token })
    });
    const sj = await start.json();
    if (!sj.video_id) return { ok: false, error: (sj.error && sj.error.message) || 'start phase failed' };

    const up = await fetch('https://rupload.facebook.com/video-upload/v26.0/' + sj.video_id, {
      method: 'POST',
      headers: { Authorization: 'OAuth ' + page.access_token, file_url: videoUrl }
    });
    const uj = await up.json();
    if (!uj.success) return { ok: false, error: (uj.debug_info && uj.debug_info.message) || 'upload phase failed' };

    return { ok: true, creationId: sj.video_id };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function pageTryPublish(videoId, caption) {
  const page = await account('facebook_page');
  if (!page) return { ok: false, error: 'Facebook Page not connected' };

  // Status poll: failures here are clean - nothing was published yet.
  let sj;
  try {
    const st = await fetch(GRAPH + '/' + videoId + '?fields=status&access_token=' + encodeURIComponent(page.access_token));
    sj = await st.json();
  } catch (err) {
    return { ok: false, error: 'status poll failed: ' + err.message };
  }
  if (sj.error) return { ok: false, error: sj.error.message };
  const phase = sj.status && sj.status.uploading_phase && sj.status.uploading_phase.status;
  if (phase !== 'complete') return { ok: true, done: false }; // unreadable status = keep waiting, never publish blind

  // Finish (= publish): an ambiguous outcome must never become retryable.
  let fj;
  try {
    const fin = await fetch(GRAPH + '/' + page.business_account_id + '/video_reels', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        upload_phase: 'finish',
        video_id: videoId,
        video_state: 'PUBLISHED',
        description: String(caption || '').slice(0, 5000),
        access_token: page.access_token
      })
    });
    fj = await fin.json();
  } catch (err) {
    return { ok: false, maybePublished: true, error: 'publish outcome unknown: ' + err.message };
  }
  if (fj.error) return { ok: false, error: fj.error.message };
  return { ok: true, done: true, mediaId: videoId, permalink: 'https://www.facebook.com/reel/' + videoId };
}

module.exports = { account, igCreateContainer, igTryPublish, pageStartReel, pageTryPublish };
