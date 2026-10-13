const fs = require('fs');
const path = require('path');
const db = require('../database/db');

// TikTok Content Posting API client used by the publish-queue finisher.
// Same contract as metaPublish: every function returns { ok, ... } and never
// throws to the caller; maybePublished=true marks an outcome that MUST NOT be
// retried blindly (a retry could double-post). Nothing here runs unless the
// owner approved the specific queue row (owner rule 2026-10-12).
//
// Direct post flow: init (FILE_UPLOAD, single chunk <= 60 MB) -> PUT bytes ->
// poll status until PUBLISH_COMPLETE. The video is pushed by file, so no
// extra domain verification is needed for the media host.

const API = 'https://open.tiktokapis.com/v2';
const MEDIA_DIR = path.join(__dirname, '..', '..', '..', 'media');

function appCreds() {
  return {
    key: process.env.TIKTOK_CLIENT_KEY,
    secret: process.env.TIKTOK_CLIENT_SECRET
  };
}

// The stored TikTok account, with the 24h access token refreshed when it is
// within 10 minutes of expiry. Returns null when not connected or refresh fails.
async function account() {
  const rows = await db.query(
    "SELECT id, business_account_id, access_token, refresh_token, expires_at FROM accounts WHERE platform = 'tiktok' AND status = 'active' ORDER BY id DESC LIMIT 1"
  );
  if (!rows || !rows.length) return null;
  const acc = rows[0];

  const expMs = acc.expires_at ? new Date(String(acc.expires_at).replace(' ', 'T')).getTime() : 0;
  if (expMs - Date.now() > 10 * 60 * 1000) return acc;

  // Refresh. TikTok rotates refresh tokens, so store BOTH new tokens.
  const creds = appCreds();
  if (!creds.key || !creds.secret || !acc.refresh_token) return null;
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
    const j = await r.json();
    if (!j.access_token) {
      console.warn('[tiktok] token refresh failed: ' + JSON.stringify(j).slice(0, 200));
      await db.query("UPDATE accounts SET status = 'expired' WHERE id = ?", [acc.id]);
      return null;
    }
    const expiresAt = new Date(Date.now() + (j.expires_in || 86400) * 1000);
    const saved = await db.query(
      'UPDATE accounts SET access_token = ?, refresh_token = ?, expires_at = ? WHERE id = ?',
      [j.access_token, j.refresh_token || acc.refresh_token, expiresAt, acc.id]
    );
    if (!saved) return null; // cannot persist the rotated token - do not use it
    return { ...acc, access_token: j.access_token };
  } catch (err) {
    console.warn('[tiktok] token refresh error: ' + err.message);
    return null;
  }
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

// Phase 1: init the direct post and upload the file. Returns the publish_id
// as creationId. The commitment point is a successful init - from there an
// ambiguous outcome must be treated as maybePublished.
async function startPost(filename, caption, options) {
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
    // The init may or may not have registered - never blind-retry it.
    return { ok: false, maybePublished: true, error: 'init outcome unknown: ' + err.message };
  }
  if (!init.data || !init.data.publish_id || (init.error && init.error.code !== 'ok')) {
    if (init.error && init.error.message) return { ok: false, error: init.error.message };
    return { ok: false, maybePublished: true, error: 'init returned an unrecognized response' };
  }

  // Upload the whole file as one chunk.
  try {
    const up = await fetch(init.data.upload_url, {
      method: 'PUT',
      headers: {
        'Content-Type': 'video/mp4',
        'Content-Length': String(size),
        'Content-Range': 'bytes 0-' + (size - 1) + '/' + size
      },
      body: fs.readFileSync(filePath),
      signal: AbortSignal.timeout(5 * 60 * 1000)
    });
    if (!up.ok && up.status !== 201) {
      // Upload rejected outright: TikTok discards incomplete uploads, but the
      // init is registered, so route through the status poll rather than retry.
      return { ok: true, creationId: init.data.publish_id, uploadWarning: 'upload returned HTTP ' + up.status };
    }
  } catch (err) {
    // Bytes may or may not have fully landed - let the status poll decide.
    return { ok: true, creationId: init.data.publish_id, uploadWarning: 'upload outcome unclear: ' + err.message };
  }
  return { ok: true, creationId: init.data.publish_id };
}

// Phase 2: poll the publish status. Same contract as igTryPublish.
async function tryFinish(publishId) {
  const acc = await account();
  if (!acc) return { ok: false, error: 'TikTok not connected' };
  let j;
  try {
    j = await apiPost(acc.access_token, '/post/publish/status/fetch/', { publish_id: publishId });
  } catch (err) {
    return { ok: false, error: 'status poll failed: ' + err.message }; // clean - nothing changed
  }
  if (!j.data || (j.error && j.error.code !== 'ok')) {
    return { ok: false, error: (j.error && j.error.message) || 'status fetch failed' };
  }
  const st = j.data.status;
  if (st === 'FAILED') {
    return { ok: false, error: 'TikTok processing failed: ' + (j.data.fail_reason || 'unknown reason') };
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

module.exports = { account, creatorInfo, startPost, tryFinish, ALLOWED_PRIVACY };
