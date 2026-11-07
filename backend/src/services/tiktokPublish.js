const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const db = require('../database/db');

// TikTok Content Posting API client used by the publish-queue finisher.
// Same contract as metaPublish: every function returns { ok, ... } and never
// throws to the caller. Nothing here runs unless the owner approved the
// specific queue row (owner rule 2026-10-12).
//
// THE COMMITMENT POINT IS THE UPLOAD. A TikTok direct post publishes by
// itself once the uploaded bytes finish processing - there is NO separate
// publish call (unlike Instagram/Facebook). Everything in this file and in
// the scheduler's tiktok handling follows from that:
//  - init alone is safe (a publish_id with no bytes never publishes), so
//    init failures are plainly retryable;
//  - the publish_id must be persisted BEFORE the upload starts (the caller
//    passes persistId for that); if it cannot be saved, we abort pre-upload;
//  - once the upload has started, NO failure may become a retryable 'failed':
//    only TikTok's own status=FAILED (definitive: true) is safe to retry.

const API = 'https://open.tiktokapis.com/v2';
const MEDIA_DIR = path.join(__dirname, '..', '..', '..', 'media');

function appCreds() {
  return {
    key: process.env.TIKTOK_CLIENT_KEY,
    secret: process.env.TIKTOK_CLIENT_SECRET
  };
}

// ---------- account + token refresh ----------

// TikTok rotates refresh tokens, so refreshes must be single-flight: two
// concurrent refreshes with the same token invalidate each other. The panel
// routes and the finisher all call account(), so this latch matters daily.
let refreshInFlight = null;

async function readAccountRow() {
  const rows = await db.query(
    "SELECT id, business_account_id, access_token, refresh_token, expires_at FROM accounts WHERE platform = 'tiktok' AND status = 'active' ORDER BY id DESC LIMIT 1"
  );
  return rows && rows.length ? rows[0] : null;
}

async function doRefresh(acc) {
  const creds = appCreds();
  if (!creds.key || !creds.secret || !acc.refresh_token) return null;
  let j;
  try {
    const r = await fetch(API + '/oauth/token/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_key: creds.key,
        client_secret: creds.secret,
        grant_type: 'refresh_token',
        refresh_token: acc.refresh_token
      }),
      signal: AbortSignal.timeout(30 * 1000)
    });
    j = await r.json();
  } catch (err) {
    console.warn('[tiktok] token refresh error (transient): ' + err.message);
    return null; // network blip - next caller retries
  }
  if (!j.access_token) {
    // Only a DEFINITIVE grant failure may kill the connection. A transient
    // 5xx/429 JSON body must not - and neither may losing a rotation race
    // (guarded by the conditional UPDATE below).
    const errCode = String(j.error || '').toLowerCase();
    if (errCode === 'invalid_grant') {
      await db.query(
        "UPDATE accounts SET status = 'expired' WHERE id = ? AND refresh_token = ?",
        [acc.id, acc.refresh_token]
      );
      console.warn('[tiktok] refresh token no longer valid - account marked expired');
    } else {
      console.warn('[tiktok] token refresh rejected (transient?): ' + JSON.stringify(j).slice(0, 200));
    }
    return null;
  }
  const expiresAt = new Date(Date.now() + (j.expires_in || 86400) * 1000);
  // Conditional on the OLD refresh token: if someone rotated meanwhile, do
  // not clobber their valid pair - just re-read the row.
  const saved = await db.query(
    'UPDATE accounts SET access_token = ?, refresh_token = ?, expires_at = ? WHERE id = ? AND refresh_token = ?',
    [j.access_token, j.refresh_token || acc.refresh_token, expiresAt, acc.id, acc.refresh_token]
  );
  if (!saved) return null; // DB down - never use a rotated token we could not persist
  if (!saved.affectedRows) return readAccountRow(); // lost the race - the winner's row is fine
  return { ...acc, access_token: j.access_token };
}

async function account() {
  const acc = await readAccountRow();
  if (!acc) return null;
  const expMs = acc.expires_at ? new Date(String(acc.expires_at).replace(' ', 'T')).getTime() : 0;
  if (expMs - Date.now() > 10 * 60 * 1000) return acc;

  if (!refreshInFlight) {
    refreshInFlight = doRefresh(acc).finally(() => { refreshInFlight = null; });
  }
  const refreshed = await refreshInFlight;
  // Whatever happened, the row is the source of truth now.
  return refreshed || readAccountRow().then((row) => {
    if (!row) return null;
    const ms = row.expires_at ? new Date(String(row.expires_at).replace(' ', 'T')).getTime() : 0;
    return ms > Date.now() ? row : null;
  });
}

async function apiPost(token, pathname, body) {
  const r = await fetch(API + pathname, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + token,
      'Content-Type': 'application/json; charset=UTF-8'
    },
    body: JSON.stringify(body || {}),
    signal: AbortSignal.timeout(30 * 1000)
  });
  return r.json();
}

// Creator info: TikTok's UX rules require showing this (nickname, allowed
// privacy levels, interaction availability) before the owner approves a post.
async function creatorInfo() {
  const acc = await account();
  if (!acc) return { ok: false, error: 'TikTok not connected' };
  try {
    const j = await apiPost(acc.access_token, '/post/publish/creator_info/query/');
    if (!j.data || (j.error && j.error.code !== 'ok')) {
      return { ok: false, error: (j.error && j.error.message) || 'creator info query failed' };
    }
    return { ok: true, creator: j.data };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

const ALLOWED_PRIVACY = ['PUBLIC_TO_EVERYONE', 'MUTUAL_FOLLOW_FRIENDS', 'FOLLOWER_OF_CREATOR', 'SELF_ONLY'];

// Phase 1: init the direct post, persist the publish_id via persistId(id)
// (MUST succeed before any byte is uploaded), then upload the file.
// Returns:
//   { ok:true, creationId, uploadWarning? }  - upload done or ambiguous (poll decides)
//   { ok:false, error }                      - nothing uploaded, SAFE to retry
//   { ok:false, error, abortedPreUpload }    - init ok but id not saved; SAFE to retry
async function startPost(filename, caption, options, persistId) {
  const acc = await account();
  if (!acc) return { ok: false, error: 'TikTok not connected' };

  const filePath = path.join(MEDIA_DIR, path.basename(filename || ''));
  let size;
  try {
    size = fs.statSync(filePath).size;
  } catch {
    return { ok: false, error: 'video file missing on the server' };
  }
  if (!size || size > 60 * 1024 * 1024) {
    return { ok: false, error: 'video must be between 1 byte and 60 MB for TikTok upload' };
  }

  const opts = options || {};
  const privacy = ALLOWED_PRIVACY.includes(opts.privacy_level) ? opts.privacy_level : 'SELF_ONLY';

  // Init. A publish_id with no uploaded bytes never publishes, so every
  // failure up to here - thrown, garbled, rejected - is plainly retryable.
  let init;
  try {
    init = await apiPost(acc.access_token, '/post/publish/video/init/', {
      post_info: {
        title: String(caption || '').slice(0, 2200),
        privacy_level: privacy,
        disable_comment: !!opts.disable_comment,
        disable_duet: !!opts.disable_duet,
        disable_stitch: !!opts.disable_stitch
      },
      source_info: {
        source: 'FILE_UPLOAD',
        video_size: size,
        chunk_size: size,
        total_chunk_count: 1
      }
    });
  } catch (err) {
    return { ok: false, error: 'init failed: ' + err.message };
  }
  if (!init.data || !init.data.publish_id || (init.error && init.error.code !== 'ok')) {
    const msg = (init.error && init.error.message) || 'init returned an unrecognized response';
    // TikTok answers an unaudited app with a bare link to its guidelines -
    // say what actually went wrong. An app that has not passed TikTok's
    // Direct Post audit may only post to a PRIVATE TikTok account (code
    // unaudited_client_can_only_post_to_private_accounts) - "Only me" on the
    // post is not enough when the account itself is public.
    if (/integration guidelines|content-sharing-guidelines/i.test(msg) || (init.error && init.error.code === 'unaudited_client_can_only_post_to_private_accounts')) {
      return {
        ok: false,
        error: privacy === 'SELF_ONLY'
          ? 'TikTok refused: an app TikTok has not approved may only post to a PRIVATE TikTok account, and this account is public. Nothing was posted. (TikTok said: ' + msg + ')'
          : 'TikTok refused: an app TikTok has not approved may only post "Only me" videos, and only to a private account. Nothing was posted. (TikTok said: ' + msg + ')'
      };
    }
    return { ok: false, error: msg };
  }

  // Persist the id BEFORE uploading: if the process dies mid-upload, the
  // sweeper must know this row is committed territory, not safe to retry.
  const persisted = persistId ? await persistId(init.data.publish_id) : true;
  if (!persisted) {
    return { ok: false, abortedPreUpload: true, error: 'could not record the publish id - aborted before any upload, safe to approve again' };
  }

  // Upload: from the first byte onward this row is committed.
  const warning = await putVideo(init.data.upload_url, filePath, size);
  return warning
    ? { ok: true, creationId: init.data.publish_id, uploadWarning: warning }
    : { ok: true, creationId: init.data.publish_id };
}

// PUT the whole file to TikTok's upload_url. Streams it (no 60 MB sync read on
// the memory-capped shared host). Returns null on success, else a warning -
// the outcome of a started upload is never "safe to retry".
async function putVideo(uploadUrl, filePath, size) {
  try {
    const up = await fetch(uploadUrl, {
      method: 'PUT',
      headers: {
        'Content-Type': 'video/mp4',
        'Content-Length': String(size),
        'Content-Range': 'bytes 0-' + (size - 1) + '/' + size
      },
      body: Readable.toWeb(fs.createReadStream(filePath)),
      duplex: 'half',
      signal: AbortSignal.timeout(5 * 60 * 1000)
    });
    if (!up.ok && up.status !== 201) return 'upload returned HTTP ' + up.status;
  } catch (err) {
    return 'upload outcome unclear: ' + err.message;
  }
  return null;
}

// ---------- drafts (Content Posting API "Upload") ----------
// The free public route while the app has not passed TikTok's Direct Post
// audit (owner 2026-11-07: no paid third parties). The finished video lands
// in the owner's TikTok inbox as a draft; he opens the TikTok notification,
// pastes the caption and posts it - publicly - from the TikTok app. This
// endpoint has no private-account rule for unaudited apps; TikTok allows at
// most 5 drafts waiting to be posted in any 24 h
// (spam_risk_too_many_pending_share). There is no caption field: the owner
// adds it in the app. Same commitment rule as startPost: the publish_id is
// persisted before any byte uploads.
async function startDraft(filename, persistId) {
  const acc = await account();
  if (!acc) return { ok: false, error: 'TikTok not connected' };

  const filePath = path.join(MEDIA_DIR, path.basename(filename || ''));
  let size;
  try {
    size = fs.statSync(filePath).size;
  } catch {
    return { ok: false, error: 'video file missing on the server' };
  }
  if (!size || size > 60 * 1024 * 1024) {
    return { ok: false, error: 'video must be between 1 byte and 60 MB for TikTok upload' };
  }

  let init;
  try {
    init = await apiPost(acc.access_token, '/post/publish/inbox/video/init/', {
      source_info: {
        source: 'FILE_UPLOAD',
        video_size: size,
        chunk_size: size,
        total_chunk_count: 1
      }
    });
  } catch (err) {
    return { ok: false, error: 'draft init failed: ' + err.message };
  }
  if (!init.data || !init.data.publish_id || (init.error && init.error.code !== 'ok')) {
    const code = init.error && init.error.code;
    const msg = (init.error && init.error.message) || 'draft init returned an unrecognized response';
    if (code === 'spam_risk_too_many_pending_share') {
      return {
        ok: false,
        draftsFull: true,
        // TikTok: "at most 5 pending shares within any 24-hour period".
        error: 'TikTok inbox full (max 5 unposted videos per 24 h): post the waiting ones from TikTok → Inbox → System notifications.'
      };
    }
    return { ok: false, error: 'TikTok refused the draft: ' + msg + (code && code !== 'ok' ? ' (' + code + ')' : '') };
  }

  const persisted = persistId ? await persistId(init.data.publish_id) : true;
  if (!persisted) {
    return { ok: false, abortedPreUpload: true, error: 'could not record the draft id - aborted before any upload, safe to approve again' };
  }
  const warning = await putVideo(init.data.upload_url, filePath, size);
  return warning
    ? { ok: true, creationId: init.data.publish_id, uploadWarning: warning }
    : { ok: true, creationId: init.data.publish_id };
}

// Publish ids of draft uploads look like "v_inbox_file~v2.123"; direct posts
// like "v_pub_file~v2.123".
function isDraftId(publishId) {
  return /^v_inbox/.test(String(publishId || ''));
}

// Phase 2: poll the publish status. definitive:true marks the ONLY failure
// that is safe to retry (TikTok itself says the post failed and will not
// publish). Every other failure here is transient and the caller must keep
// the row parked, never make it retryable.
async function tryFinish(publishId) {
  const acc = await account();
  if (!acc) return { ok: false, error: 'TikTok not connected (token refresh pending?)' };
  let j;
  try {
    j = await apiPost(acc.access_token, '/post/publish/status/fetch/', { publish_id: publishId });
  } catch (err) {
    return { ok: false, error: 'status poll failed: ' + err.message };
  }
  if (!j.data || (j.error && j.error.code !== 'ok')) {
    return { ok: false, error: (j.error && j.error.message) || 'status fetch failed' };
  }
  const st = j.data.status;
  if (st === 'FAILED') {
    return { ok: false, definitive: true, error: 'TikTok processing failed: ' + (j.data.fail_reason || 'unknown reason') };
  }
  if (st === 'PUBLISH_COMPLETE' || st === 'SEND_TO_USER_INBOX') {
    const ids = j.data.publicaly_available_post_id || j.data.publicly_available_post_id || [];
    const postId = Array.isArray(ids) && ids.length ? String(ids[0]) : null;
    return {
      ok: true,
      done: true,
      mediaId: postId,
      permalink: postId ? 'https://www.tiktok.com/@_/video/' + postId : null,
      inbox: st === 'SEND_TO_USER_INBOX'
    };
  }
  return { ok: true, done: false }; // PROCESSING_UPLOAD / PROCESSING_DOWNLOAD / anything in-flight
}

// Flip TIKTOK_APP_AUDITED=true in .env once TikTok approves the app review;
// until then only SELF_ONLY posts are accepted by TikTok.
function appAudited() {
  return String(process.env.TIKTOK_APP_AUDITED || '').toLowerCase() === 'true';
}

module.exports = { account, creatorInfo, startPost, startDraft, isDraftId, tryFinish, appAudited, ALLOWED_PRIVACY };
