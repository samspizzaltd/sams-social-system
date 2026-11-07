const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const db = require('../database/db');

// YouTube Data API v3 client used by the publish-queue finisher. Same contract
// as metaPublish/tiktokPublish: every function returns { ok, ... } and never
// throws to the caller. Nothing here runs unless the owner approved the
// specific queue row (owner rule 2026-10-12).
//
// THE COMMITMENT POINT IS THE UPLOAD. A resumable upload becomes a video the
// moment its last byte lands - there is no separate publish call. So:
//  - opening the upload session is safe (no bytes = no video) and retryable;
//  - the session URL is persisted BEFORE the first byte (persistId), so a
//    crash mid-upload leaves the row in committed territory for the sweeper;
//  - after that, the only retryable outcome is a definitive one: the session
//    reports the upload INCOMPLETE (HTTP 308), which never becomes a video.

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API = 'https://www.googleapis.com/youtube/v3';
const UPLOAD = 'https://www.googleapis.com/upload/youtube/v3/videos';
const MEDIA_DIR = path.join(__dirname, '..', '..', '..', 'media');

function appCreds() {
  return {
    id: process.env.YOUTUBE_CLIENT_ID,
    secret: process.env.YOUTUBE_CLIENT_SECRET
  };
}

// Google locks uploads from an unaudited API project to Private, whatever
// privacyStatus is requested. Flip YOUTUBE_APP_AUDITED=true in .env once the
// YouTube API compliance audit passes.
function appAudited() {
  return String(process.env.YOUTUBE_APP_AUDITED || '').toLowerCase() === 'true';
}

// ---------- account + token refresh ----------

// Single-flight refresh: the panel routes and the finisher all call account().
let refreshInFlight = null;

async function readAccountRow() {
  const rows = await db.query(
    "SELECT id, business_account_id, access_token, refresh_token, expires_at FROM accounts WHERE platform = 'youtube' AND status = 'active' ORDER BY id DESC LIMIT 1"
  );
  return rows && rows.length ? rows[0] : null;
}

async function doRefresh(acc) {
  const creds = appCreds();
  if (!creds.id || !creds.secret || !acc.refresh_token) return null;
  let j;
  try {
    const r = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: creds.id,
        client_secret: creds.secret,
        refresh_token: acc.refresh_token,
        grant_type: 'refresh_token'
      }),
      signal: AbortSignal.timeout(30 * 1000)
    });
    j = await r.json();
  } catch (err) {
    console.warn('[youtube] token refresh error (transient): ' + err.message);
    return null;
  }
  if (!j.access_token) {
    // Only a definitive grant failure may kill the connection (revoked access,
    // or a Testing-mode consent screen's 7-day refresh-token expiry).
    if (String(j.error || '') === 'invalid_grant') {
      // Access revoked (or expired): the tokens are useless - drop them now;
      // dailyCheck() deletes the rest of the row within 7 days (YouTube API
      // Services Developer Policies).
      await db.query(
        "UPDATE accounts SET status = 'expired', access_token = '', refresh_token = NULL, expires_at = NULL WHERE id = ? AND refresh_token = ?",
        [acc.id, acc.refresh_token]
      );
      console.warn('[youtube] refresh token no longer valid - account marked expired, tokens deleted');
    } else {
      console.warn('[youtube] token refresh rejected (transient?): ' + String(j.error || 'no access_token'));
    }
    return null;
  }
  const expiresAt = new Date(Date.now() + (j.expires_in || 3600) * 1000);
  // Google normally keeps the refresh token; store a new one only if sent.
  const saved = await db.query(
    'UPDATE accounts SET access_token = ?, refresh_token = COALESCE(?, refresh_token), expires_at = ? WHERE id = ? AND refresh_token = ?',
    [j.access_token, j.refresh_token || null, expiresAt, acc.id, acc.refresh_token]
  );
  if (!saved) return null;
  if (!saved.affectedRows) return readAccountRow();
  return { ...acc, access_token: j.access_token };
}

async function account() {
  const acc = await readAccountRow();
  if (!acc) return null;
  const expMs = acc.expires_at ? new Date(String(acc.expires_at).replace(' ', 'T')).getTime() : 0;
  if (expMs - Date.now() > 5 * 60 * 1000) return acc;

  if (!refreshInFlight) {
    refreshInFlight = doRefresh(acc).finally(() => { refreshInFlight = null; });
  }
  const refreshed = await refreshInFlight;
  return refreshed || readAccountRow().then((row) => {
    if (!row) return null;
    const ms = row.expires_at ? new Date(String(row.expires_at).replace(' ', 'T')).getTime() : 0;
    return ms > Date.now() ? row : null;
  });
}

// ---------- YouTube API data rules (Developer Policies) ----------
// The owner can revoke the Service's access at any time in his Google Account
// (https://security.google.com/settings/security/permissions). Once a day the
// token is checked (Google answers invalid_grant once access was revoked), and
// the stored data of a revoked, expired or disconnected channel is deleted
// within 7 days - here after 6.
let lastDailyCheck = 0;
async function dailyCheck() {
  if (Date.now() - lastDailyCheck < 24 * 3600 * 1000) return;
  lastDailyCheck = Date.now();
  try {
    await account(); // refreshes a stale token - and notices a revocation
    await db.query(
      "DELETE FROM accounts WHERE platform = 'youtube' AND status IN ('expired','disconnected') AND updated_at < (NOW() - INTERVAL 6 DAY)"
    );
  } catch (err) {
    console.warn('[youtube] daily check failed: ' + err.message);
  }
}

// Disconnect = revoke the grant at Google, then delete every stored YouTube
// token and channel record. Deletion happens even if Google cannot be reached.
async function revokeAndDelete() {
  const rows = await db.query("SELECT id, access_token, refresh_token FROM accounts WHERE platform = 'youtube'");
  if (rows === null) return { ok: false, error: 'Database unavailable' };
  let revoked = false;
  for (const r of rows) {
    const token = r.refresh_token || r.access_token;
    if (!token) continue;
    try {
      const res = await fetch('https://oauth2.googleapis.com/revoke', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token }),
        signal: AbortSignal.timeout(15 * 1000)
      });
      if (res.ok) revoked = true; // 400 = already revoked / no longer valid
    } catch (err) {
      console.warn('[youtube] revoke call failed (data is deleted anyway): ' + err.message);
    }
  }
  const del = await db.query("DELETE FROM accounts WHERE platform = 'youtube'");
  if (del === null) return { ok: false, error: 'Database unavailable' };
  return { ok: true, revoked, deleted: del.affectedRows };
}

// The connected channel, shown in the panel and the approve sheet so a post
// can never go to a channel the owner did not expect.
async function channelInfo() {
  const acc = await account();
  if (!acc) return { ok: false, error: 'YouTube not connected' };
  try {
    const r = await fetch(API + '/channels?part=snippet&mine=true', {
      headers: { Authorization: 'Bearer ' + acc.access_token },
      signal: AbortSignal.timeout(15 * 1000)
    });
    const j = await r.json();
    const ch = j.items && j.items[0];
    if (!ch) return { ok: false, error: (j.error && j.error.message) || 'no channel on this account' };
    const thumbs = (ch.snippet && ch.snippet.thumbnails) || {};
    return {
      ok: true,
      channel: {
        id: ch.id,
        title: ch.snippet && ch.snippet.title,
        thumbnail: (thumbs.default && thumbs.default.url) || null
      }
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

const PRIVACY = ['private', 'unlisted', 'public'];

function cleanTitle(s) {
  // YouTube rejects < and > in titles and caps them at 100 characters.
  // Array.from slices by code point, so an emoji is never cut in half.
  return Array.from(String(s || '').replace(/[<>]/g, '').replace(/\s+/g, ' ').trim()).slice(0, 100).join('');
}

// YouTube also rejects < and > in descriptions, and caps them at 5000 BYTES:
// a Georgian caption is ~3 bytes per letter, so trim by UTF-8 size.
function cleanDescription(s) {
  const chars = Array.from(String(s || '').replace(/[<>]/g, ''));
  let bytes = 0;
  let out = '';
  for (const ch of chars) {
    const n = Buffer.byteLength(ch, 'utf8');
    if (bytes + n > 5000) break;
    bytes += n;
    out += ch;
  }
  return out;
}

// Phase 1: open a resumable session, persist its URL via persistId (MUST
// succeed before any byte is sent), then upload the file.
// Returns:
//   { ok:true, creationId, uploadWarning? }  - upload done or ambiguous (status check decides)
//   { ok:false, error }                      - nothing uploaded, SAFE to retry
//   { ok:false, error, abortedPreUpload }    - session open but URL not saved; SAFE to retry
async function startPost(filename, caption, options, persistId) {
  const acc = await account();
  if (!acc) return { ok: false, error: 'YouTube not connected' };

  const filePath = path.join(MEDIA_DIR, path.basename(filename || ''));
  let size;
  try {
    size = fs.statSync(filePath).size;
  } catch {
    return { ok: false, error: 'video file missing on the server' };
  }
  if (!size) return { ok: false, error: 'video file is empty' };

  const opts = options || {};
  let privacy = PRIVACY.includes(opts.privacy_status) ? opts.privacy_status : 'private';
  if (!appAudited()) privacy = 'private';
  const title = cleanTitle(opts.title) || cleanTitle(String(caption || '').split('\n')[0]) || "Sam's More Than Pizza";

  let init;
  try {
    init = await fetch(UPLOAD + '?uploadType=resumable&part=snippet,status', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + acc.access_token,
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Length': String(size),
        'X-Upload-Content-Type': 'video/mp4'
      },
      body: JSON.stringify({
        snippet: {
          title,
          description: cleanDescription(caption),
          categoryId: '26' // Howto & Style - food content
        },
        status: {
          privacyStatus: privacy,
          selfDeclaredMadeForKids: false // restaurant marketing, not children's content
        }
      }),
      signal: AbortSignal.timeout(30 * 1000)
    });
  } catch (err) {
    return { ok: false, error: 'upload session failed to open: ' + err.message };
  }
  if (!init.ok) {
    let msg = 'upload session refused (HTTP ' + init.status + ')';
    try {
      const j = await init.json();
      if (j.error && j.error.message) msg = j.error.message;
    } catch { /* keep the HTTP status message */ }
    return { ok: false, error: msg };
  }
  const sessionUrl = init.headers.get('location');
  if (!sessionUrl) return { ok: false, error: 'YouTube did not return an upload session' };

  const persisted = persistId ? await persistId(sessionUrl) : true;
  if (!persisted) {
    return { ok: false, abortedPreUpload: true, error: 'could not record the upload session - aborted before any upload, safe to approve again' };
  }

  // From the first byte onward this row is committed.
  try {
    const up = await fetch(sessionUrl, {
      method: 'PUT',
      headers: {
        Authorization: 'Bearer ' + acc.access_token,
        'Content-Type': 'video/mp4',
        'Content-Length': String(size)
      },
      body: Readable.toWeb(fs.createReadStream(filePath)),
      duplex: 'half',
      redirect: 'manual', // a 308 means "incomplete" here, never a redirect to follow
      signal: AbortSignal.timeout(10 * 60 * 1000)
    });
    if (up.status === 200 || up.status === 201) {
      // The answer already carries the new video - record it straight away
      // instead of depending on a later session query that may not answer.
      let j = null;
      try { j = await up.json(); } catch { /* fall back to the status check */ }
      if (j && j.id) {
        return {
          ok: true,
          creationId: sessionUrl,
          publishedNow: { mediaId: j.id, permalink: 'https://youtu.be/' + j.id, privacy: j.status && j.status.privacyStatus }
        };
      }
      return { ok: true, creationId: sessionUrl, uploadWarning: 'upload finished but returned no video id' };
    }
    return { ok: true, creationId: sessionUrl, uploadWarning: 'upload returned HTTP ' + up.status };
  } catch (err) {
    return { ok: true, creationId: sessionUrl, uploadWarning: 'upload outcome unclear: ' + err.message };
  }
}

// Phase 2: ask the upload session what happened. definitive:true marks the
// only failure that is safe to retry (the upload never completed, so no video
// exists). Everything else is transient and the caller keeps the row parked.
async function tryFinish(sessionUrl, filename) {
  const acc = await account();
  if (!acc) return { ok: false, error: 'YouTube not connected (token refresh pending?)' };

  let total = '*';
  try {
    total = String(fs.statSync(path.join(MEDIA_DIR, path.basename(filename || ''))).size);
  } catch { /* '*' still lets the session answer */ }

  let r;
  try {
    r = await fetch(sessionUrl, {
      method: 'PUT',
      headers: {
        Authorization: 'Bearer ' + acc.access_token,
        'Content-Length': '0',
        'Content-Range': 'bytes */' + total
      },
      redirect: 'manual',
      signal: AbortSignal.timeout(30 * 1000)
    });
  } catch (err) {
    return { ok: false, error: 'status check failed: ' + err.message };
  }

  if (r.status === 200 || r.status === 201) {
    let j = null;
    try { j = await r.json(); } catch { /* fall through */ }
    if (j && j.id) {
      return {
        ok: true,
        done: true,
        mediaId: j.id,
        permalink: 'https://youtu.be/' + j.id,
        privacy: j.status && j.status.privacyStatus
      };
    }
    return { ok: false, error: 'upload confirmed but no video id returned' };
  }
  if (r.status === 308) {
    // "Incomplete" - but right after an aborted upload Google may still be
    // receiving or finishing the last bytes. Report how much arrived and let
    // the scheduler call it final only after it stays incomplete for a while.
    const m = /bytes=0-(\d+)/.exec(r.headers.get('range') || '');
    const received = m ? Number(m[1]) + 1 : 0;
    const fullyReceived = total === '*' || received >= Number(total);
    return {
      ok: false,
      incomplete: true,
      fullyReceived,
      error: 'upload incomplete (' + received + ' of ' + total + ' bytes received)'
    };
  }
  return { ok: false, error: 'status check returned HTTP ' + r.status };
}

module.exports = {
  account, appAudited, channelInfo, startPost, tryFinish, dailyCheck, revokeAndDelete, PRIVACY,
  _resetDailyCheck: () => { lastDailyCheck = 0; } // tests only
};
