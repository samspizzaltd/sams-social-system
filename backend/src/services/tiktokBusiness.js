const fs = require('fs');
const path = require('path');
const db = require('../database/db');

// TikTok through TikTok's business interface - TikTok API for Business,
// "Accounts API" (owner 2026-11-13: "Yes, TikTok can be automated for free,
// through TikTok's business interface - do it").
//
// Our first TikTok app (Content Posting API, tiktokPublish.js) can only post
// to PRIVATE accounts until TikTok audits it, and TikTok keeps that audit for
// apps made for the public. The Accounts API is made for exactly our case -
// TikTok lists as an authorized use: "Manage the organic presence of brands or
// creators' owned accounts on TikTok, including: Publishing video or photo
// posts". What it needs:
//  - a developer app on business-api.tiktok.com with the "TikTok Accounts"
//    permission (TikTok reviews it; since 2026-03-20 together with the
//    Accounts API Access Application Form) - owner steps;
//  - the owner authorizes the Sam's TikTok account once (Connect in the panel);
//  - TikTok fetches the video from our server, so the URL prefix
//    https://api.sams-social-system.sams.ge/media/ must be verified: a
//    signature file in the media folder (verifyUrlPrefix).
// Facts from TikTok's docs (2026-11-13):
//  - POST /business/video/publish/ publishes a PUBLIC post (no privacy
//    choice) with caption (2,200 chars), comment/duet/stitch settings and the
//    required is_brand_organic / is_branded_content labels; at most 6 posts a
//    minute and 15 a day per account. The answer is a share_id; the result
//    comes from GET /business/publish/status/ (PROCESSING_DOWNLOAD ->
//    PUBLISH_COMPLETE with post_ids, which can take up to 3 minutes, or FAILED
//    with a reason). Hashtags in the caption show as plain text.
//  - Access tokens last one day; the refresh token one year from the
//    authorization (renewing does NOT extend it) - then the owner connects again.
// Nothing here decides WHAT is posted: only rows the owner approved reach
// startPost() (scheduler.js).

const API = 'https://business-api.tiktok.com/open_api/v1.3';
const PLATFORM = 'tiktok_biz'; // accounts.platform of the business connection
const MEDIA_DIR = path.join(__dirname, '..', '..', '..', 'media');
const PUBLIC_ORIGIN = (process.env.PUBLIC_API_ORIGIN || 'https://api.sams-social-system.sams.ge').replace(/\/$/, '');
const URL_PREFIX = PUBLIC_ORIGIN + '/media/';
const STATE_KEY = 'tiktok_biz_state'; // branding: profile, verification, refresh expiry, last error
const ID_PREFIX = 'biz:'; // publish_queue.creation_id of a business post

const state = { refreshing: null, profileAt: 0, profile: null, readyAt: 0, ready: false, lastError: null };

function appCfg() {
  return {
    id: process.env.TIKTOK_BIZ_APP_ID || '',
    secret: process.env.TIKTOK_BIZ_SECRET || '',
    authUrl: process.env.TIKTOK_BIZ_AUTH_URL || '',
    redirect: process.env.TIKTOK_BIZ_REDIRECT_URI || PUBLIC_ORIGIN + '/auth/tiktok-business/callback/'
  };
}
const configured = () => { const c = appCfg(); return !!(c.id && c.secret); };

// ---------- small helpers ----------

async function call(method, pathname, opts = {}) {
  const url = new URL(API + pathname);
  for (const [k, v] of Object.entries(opts.query || {})) url.searchParams.set(k, typeof v === 'string' ? v : JSON.stringify(v));
  let r;
  try {
    r = await fetch(url, {
      method,
      headers: Object.assign({ 'Content-Type': 'application/json' }, opts.token ? { 'Access-Token': opts.token } : {}),
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      signal: AbortSignal.timeout(opts.timeoutMs || 30 * 1000)
    });
  } catch (err) {
    return { ok: false, network: true, error: 'TikTok did not answer (' + (err.name === 'TimeoutError' ? 'timeout' : err.message) + ')' };
  }
  let j = null;
  try { j = await r.json(); } catch { j = null; }
  if (!j) return { ok: false, network: true, error: 'TikTok answered HTTP ' + r.status + ' without JSON' };
  if (j.code !== 0) return { ok: false, code: j.code, error: 'TikTok said: ' + String(j.message || 'error').slice(0, 240) + ' (code ' + j.code + ')' };
  return { ok: true, data: j.data || {} };
}

async function readState() {
  const rows = await db.query('SELECT cfg_value FROM branding WHERE cfg_key = ?', [STATE_KEY]);
  if (!rows || !rows.length) return {};
  try { return JSON.parse(rows[0].cfg_value || '{}') || {}; } catch { return {}; }
}
async function saveState(patch) {
  const cur = await readState();
  const next = Object.assign(cur, patch);
  await db.query('INSERT INTO branding (cfg_key, cfg_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE cfg_value = VALUES(cfg_value)', [STATE_KEY, JSON.stringify(next)]);
  state.readyAt = 0; // re-check readiness on the next ask
  return next;
}

async function readAccount() {
  const rows = await db.query("SELECT * FROM accounts WHERE platform = ? AND status IN ('active','expired') ORDER BY (status = 'active') DESC, id DESC LIMIT 1", [PLATFORM]);
  return rows && rows.length ? rows[0] : null;
}

// ---------- connection ----------

// Authorization code -> tokens (OAuth callback). Returns {ok, data} or {ok:false, error}.
async function exchangeCode(code) {
  const c = appCfg();
  const r = await call('POST', '/tt_user/oauth2/token/', {
    body: { client_id: c.id, client_secret: c.secret, grant_type: 'authorization_code', auth_code: code, redirect_uri: c.redirect }
  });
  if (!r.ok) return r;
  if (!r.data.access_token || !r.data.open_id) return { ok: false, error: 'TikTok answered without a token' };
  return r;
}

// First connect wins: a different TikTok account never silently replaces the
// bound one (same rule as the first TikTok app and YouTube).
async function saveConnection(d) {
  const existing = await db.query('SELECT business_account_id, status FROM accounts WHERE platform = ?', [PLATFORM]);
  if (existing === null) return { ok: false, error: 'Database unavailable - nothing was saved' };
  const conflict = existing.find((r) => r.business_account_id !== String(d.open_id) && r.status !== 'disconnected');
  if (conflict) return { ok: false, error: 'A different TikTok account is already connected - disconnect it in the panel first if you really mean to switch accounts' };
  const expiresAt = new Date(Date.now() + (Number(d.expires_in) || 86400) * 1000);
  const saved = await db.query(
    'INSERT INTO accounts (platform, business_account_id, access_token, refresh_token, expires_at, status) VALUES (?, ?, ?, ?, ?, \'active\')' +
    ' ON DUPLICATE KEY UPDATE access_token = VALUES(access_token), refresh_token = VALUES(refresh_token), expires_at = VALUES(expires_at), status = VALUES(status)',
    [PLATFORM, String(d.open_id), d.access_token, d.refresh_token || null, expiresAt]
  );
  if (saved === null) return { ok: false, error: 'The tokens could not be stored - nothing was saved' };
  await saveState({
    scope: String(d.scope || ''),
    refresh_expires_at: d.refresh_token_expires_in ? new Date(Date.now() + Number(d.refresh_token_expires_in) * 1000).toISOString() : null,
    connected_at: new Date().toISOString(),
    last_error: null
  });
  state.profileAt = 0;
  return { ok: true };
}

// A fresh access token (renewed when it has less than 2 hours left).
async function account() {
  if (!configured()) return null;
  let acc = await readAccount();
  if (!acc || acc.status !== 'active') return null;
  const left = acc.expires_at ? new Date(acc.expires_at).getTime() - Date.now() : 0;
  if (left > 2 * 3600 * 1000) return { open_id: acc.business_account_id, access_token: acc.access_token };
  if (!state.refreshing) {
    state.refreshing = (async () => {
      const c = appCfg();
      const r = await call('POST', '/tt_user/oauth2/refresh_token/', {
        body: { client_id: c.id, client_secret: c.secret, grant_type: 'refresh_token', refresh_token: acc.refresh_token }
      });
      if (!r.ok) {
        state.lastError = 'token renewal failed: ' + r.error;
        // Refresh token expired / invalid (40103, 40107, 40131): the owner must connect again.
        if ([40103, 40107, 40131].includes(r.code)) {
          await db.query("UPDATE accounts SET status = 'expired' WHERE platform = ? AND business_account_id = ?", [PLATFORM, acc.business_account_id]);
          await saveState({ last_error: 'The TikTok connection ran out - press Connect again in Settings → Platform Connections' });
        }
        return false;
      }
      const d = r.data;
      await db.query('UPDATE accounts SET access_token = ?, refresh_token = ?, expires_at = ? WHERE platform = ? AND business_account_id = ?',
        [d.access_token, d.refresh_token || acc.refresh_token, new Date(Date.now() + (Number(d.expires_in) || 86400) * 1000), PLATFORM, acc.business_account_id]);
      if (d.refresh_token_expires_in) await saveState({ refresh_expires_at: new Date(Date.now() + Number(d.refresh_token_expires_in) * 1000).toISOString() });
      return true;
    })().finally(() => { state.refreshing = null; });
  }
  const ok = await state.refreshing;
  if (!ok && left <= 0) return null;
  acc = await readAccount();
  return acc && acc.status === 'active' ? { open_id: acc.business_account_id, access_token: acc.access_token } : null;
}

async function disconnect() {
  const r = await db.query("UPDATE accounts SET status = 'disconnected' WHERE platform = ?", [PLATFORM]);
  state.profileAt = 0;
  state.readyAt = 0;
  return r !== null;
}

// ---------- account facts ----------

async function profile(force) {
  if (!force && state.profile && Date.now() - state.profileAt < 10 * 60 * 1000) return state.profile;
  const acc = await account();
  if (!acc) return null;
  const r = await call('GET', '/business/get/', {
    token: acc.access_token,
    query: { business_id: acc.open_id, fields: ['username', 'display_name', 'profile_image', 'followers_count', 'videos_count', 'is_business_account', 'has_advanced_access'] }
  });
  if (!r.ok) { state.lastError = 'profile: ' + r.error; return state.profile; }
  state.profile = {
    username: r.data.username || null,
    display_name: r.data.display_name || null,
    followers: Number.isFinite(Number(r.data.followers_count)) ? Number(r.data.followers_count) : null,
    videos: Number.isFinite(Number(r.data.videos_count)) ? Number(r.data.videos_count) : null,
    is_business_account: r.data.is_business_account,
    has_advanced_access: r.data.has_advanced_access
  };
  state.profileAt = Date.now();
  if (state.profile.username) await saveState({ username: state.profile.username, display_name: state.profile.display_name });
  return state.profile;
}

// What the approve sheet shows (same shape as tiktokPublish.creatorInfo):
// the account it posts to, and which interactions may be switched on.
async function creatorInfo() {
  const acc = await account();
  if (!acc) return { ok: false, error: 'TikTok (business) is not connected - Settings → Platform Connections' };
  const [p, s] = await Promise.all([
    profile(),
    call('GET', '/business/video/settings/', { token: acc.access_token, query: { business_id: acc.open_id } })
  ]);
  if (!s.ok) return { ok: false, error: s.error };
  return {
    ok: true,
    creator: {
      creator_nickname: (p && p.display_name) || null,
      creator_username: (p && p.username) || null,
      // The business endpoint always publishes publicly.
      privacy_level_options: ['PUBLIC_TO_EVERYONE'],
      comment_disabled: !!s.data.comment_disabled,
      duet_disabled: !!s.data.duet_disabled,
      stitch_disabled: !!s.data.stitch_disabled,
      max_video_post_duration_sec: Number(s.data.max_video_post_duration_sec) || null,
      business: true
    }
  };
}

// ---------- the video address ----------

// TikTok downloads each video from our media folder; that address must be
// verified once: add the URL prefix, put TikTok's signature file in the media
// folder (served at /media/<file>), ask TikTok to check it.
async function verifyUrlPrefix() {
  if (!configured()) return { ok: false, error: 'TikTok business app keys are not set yet' };
  const c = appCfg();
  const meta = { property_type: 2, url: URL_PREFIX };
  let info = null;
  const add = await call('POST', '/business/property/add/', { body: { app_id: c.id, secret: c.secret, url_property_meta: meta } });
  if (add.ok) info = add.data.url_property_info || null;
  if (!info) {
    // Already added earlier (or the add failed): read it from the list.
    const list = await call('GET', '/business/property/list/', { query: { app_id: c.id, secret: c.secret } });
    const rows = list.ok ? (list.data.url_property_info_list || []) : [];
    info = (Array.isArray(rows) ? rows : []).find((p) => String(p.url) === URL_PREFIX) || null;
    if (!info) return { ok: false, error: 'Could not add the video address at TikTok: ' + (add.error || list.error || 'not in the list') };
  }
  if (Number(info.property_status) === 1) {
    await saveState({ url_verified: true, url_checked_at: new Date().toISOString(), url_error: null });
    return { ok: true, verified: true };
  }
  const fileName = String(info.file_name || '');
  const signature = String(info.signature || '');
  if (!/^[A-Za-z0-9_-]{4,120}\.txt$/.test(fileName) || !signature || signature.length > 4000) {
    return { ok: false, error: 'TikTok sent an unexpected signature file name' };
  }
  fs.mkdirSync(MEDIA_DIR, { recursive: true });
  fs.writeFileSync(path.join(MEDIA_DIR, fileName), signature);
  const ver = await call('POST', '/business/property/verify/', { body: { app_id: c.id, secret: c.secret, url_property_meta: meta } });
  const ok = ver.ok && Number(ver.data.url_property_info && ver.data.url_property_info.property_status) === 1;
  await saveState({
    url_verified: ok,
    url_checked_at: new Date().toISOString(),
    url_error: ok ? null : (ver.ok ? 'TikTok could not confirm the signature file yet - press Verify again in a minute' : ver.error)
  });
  return ok ? { ok: true, verified: true } : { ok: false, error: ver.ok ? 'TikTok could not confirm the signature file yet' : ver.error };
}

// ---------- readiness ----------

// Ready = app keys + an active connection + a verified video address.
// Cached for 30 s: the publisher and the panel ask often.
async function ready() {
  if (Date.now() - state.readyAt < 30 * 1000) return state.ready;
  let ok = false;
  if (configured()) {
    const acc = await readAccount();
    if (acc && acc.status === 'active') {
      const st = await readState();
      ok = !!st.url_verified;
    }
  }
  state.ready = ok;
  state.readyAt = Date.now();
  return ok;
}

async function status() {
  const c = appCfg();
  const acc = await readAccount();
  const st = await readState();
  const p = acc && acc.status === 'active' ? await profile().catch(() => null) : null;
  const scope = String(st.scope || '');
  return {
    configured: configured(),
    auth_url_set: !!c.authUrl,
    redirect_uri: c.redirect,
    url_prefix: URL_PREFIX,
    connected: !!(acc && acc.status === 'active'),
    connection_status: acc ? acc.status : 'none',
    open_id: acc ? acc.business_account_id : null,
    username: (p && p.username) || st.username || null,
    display_name: (p && p.display_name) || st.display_name || null,
    followers: p ? p.followers : null,
    token_expires_at: acc ? acc.expires_at : null,
    refresh_expires_at: st.refresh_expires_at || null,
    can_publish: scope ? scope.split(',').includes('video.publish') : null,
    url_verified: !!st.url_verified,
    url_error: st.url_error || null,
    last_error: st.last_error || state.lastError || null,
    ready: await ready()
  };
}

// ---------- publishing ----------

const isBizId = (id) => String(id || '').startsWith(ID_PREFIX);

// One approved post -> TikTok. THE COMMITMENT POINT IS THIS CALL: once TikTok
// has the task it downloads and publishes on its own. A call whose outcome is
// unknown (no answer) is reported as maybePublished and never retried blind.
async function startPost(videoUrl, caption, options) {
  const acc = await account();
  if (!acc) return { ok: false, error: 'TikTok (business) is not connected or the connection ran out - Settings → Platform Connections' };
  const o = options || {};
  const text = Array.from(String(caption || '')).slice(0, 2200).join('');
  const r = await call('POST', '/business/video/publish/', {
    token: acc.access_token,
    timeoutMs: 60 * 1000,
    body: {
      business_id: acc.open_id,
      video_url: videoUrl,
      post_info: {
        caption: text,
        // Sam's promoting its own restaurant: TikTok's "Brand organic"
        // disclosure ("Promotional content" label). The owner can switch it
        // off per post in the approve sheet.
        is_brand_organic: o.brand_organic !== false,
        is_branded_content: false,
        disable_comment: !!o.disable_comment,
        disable_duet: !!o.disable_duet,
        disable_stitch: !!o.disable_stitch,
        is_ai_generated: false
      }
    }
  });
  if (!r.ok) {
    if (r.network) return { ok: false, maybePublished: true, error: r.error };
    return { ok: false, error: r.error };
  }
  const shareId = String(r.data.share_id || '');
  if (!shareId) return { ok: false, maybePublished: true, error: 'TikTok accepted the post but sent no publish id' };
  return { ok: true, creationId: ID_PREFIX + shareId };
}

const FAILURES = {
  file_format_check_failed: 'TikTok could not use the video file format',
  duration_check_failed: 'the video is too short or too long for TikTok',
  frame_rate_check_failed: 'the video frame rate is outside TikTok\'s 23-60 fps',
  picture_size_check_failed: 'the video is smaller than TikTok\'s 360 px minimum',
  internal: 'TikTok had an internal problem - approve again to retry',
  video_pull_failed: 'TikTok could not download the video from our server - approve again to retry',
  auth_removed: 'the TikTok connection was removed while posting',
  spam_risk_too_many_posts: 'TikTok says too many posts were made through the API in 24 hours',
  spam_risk_user_banned_from_posting: 'TikTok has banned this account from posting',
  spam_risk_text: 'TikTok flagged the caption as spammy - edit it and approve again',
  spam_risk: 'TikTok rejected the post as a spam risk',
  publish_cancelled: 'the upload was cancelled'
};

async function tryFinish(creationId) {
  const acc = await account();
  if (!acc) return { ok: false, definitive: false, error: 'TikTok connection not available right now' };
  const r = await call('GET', '/business/publish/status/', {
    token: acc.access_token,
    query: { business_id: acc.open_id, publish_id: String(creationId).slice(ID_PREFIX.length) }
  });
  if (!r.ok) return { ok: false, definitive: false, error: r.error };
  const st = String(r.data.status || '');
  if (st === 'FAILED') {
    const reason = String(r.data.reason || 'unknown');
    return { ok: false, definitive: true, error: 'TikTok: ' + (FAILURES[reason] || reason) + ' (' + reason + ')' };
  }
  if (st === 'SEND_TO_USER_INBOX') return { ok: true, done: true, inbox: true };
  if (st !== 'PUBLISH_COMPLETE') return { ok: true, done: false };
  const ids = Array.isArray(r.data.post_ids) ? r.data.post_ids.filter(Boolean).map(String) : [];
  // Post ids can take up to three minutes after PUBLISH_COMPLETE.
  if (!ids.length) return { ok: true, done: false };
  const st2 = await readState();
  const user = (state.profile && state.profile.username) || st2.username || null;
  return {
    ok: true,
    done: true,
    mediaId: ids[0],
    permalink: user ? 'https://www.tiktok.com/@' + user + '/video/' + ids[0] : 'https://www.tiktok.com/video/' + ids[0]
  };
}

// ---------- one-time return of the waiting TikTok posts ----------

// TikTok posts approved while TikTok allowed only private posts (or the inbox
// route) waited for a public route. Before any of them can go out publicly,
// they go back to the owner's review once (same as YouTube on 2026-11-11):
// he sees each post again and approves it as a public post.
const RETURN_KEY = 'tiktok_biz_returned';
const RETURN_NOTE = 'TikTok can now post publicly through the business connection - check this post and approve it again (it was approved while TikTok allowed only private posts or your inbox).';
let returnDone = false;
let returning = null;
async function returnedReady() {
  if (returnDone) return true;
  if (!returning) {
    returning = (async () => {
      const rows = await db.query('SELECT cfg_value FROM branding WHERE cfg_key = ?', [RETURN_KEY]);
      if (rows === null) return false;
      if (rows.length) return true;
      const upd = await db.query(
        "UPDATE publish_queue SET status = 'pending_review', scheduled_at = NULL, error = ? WHERE platform = 'tiktok' AND status = 'approved_publishing' AND creation_id IS NULL",
        [RETURN_NOTE]
      );
      if (upd === null) return false;
      const mark = await db.query('INSERT INTO branding (cfg_key, cfg_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE cfg_value = VALUES(cfg_value)',
        [RETURN_KEY, JSON.stringify({ at: new Date().toISOString(), returned: upd.affectedRows })]);
      if (mark === null) return false;
      console.log('[tiktok-business] ' + upd.affectedRows + ' waiting TikTok post(s) sent back for review before public posting');
      return true;
    })().then((ok) => { if (ok) returnDone = true; return ok; }).finally(() => { returning = null; });
  }
  return returning;
}

// ---------- real numbers (services/metrics.js) ----------

// Lifetime numbers of our own TikTok posts (by post id) + followers.
async function stats(postIds) {
  const acc = await account();
  if (!acc) return { ok: false, error: 'TikTok (business) is not connected' };
  const out = {};
  const ids = (postIds || []).map(String).filter((x) => /^\d{5,30}$/.test(x));
  for (let i = 0; i < ids.length; i += 20) {
    const r = await call('GET', '/business/video/list/', {
      token: acc.access_token,
      query: {
        business_id: acc.open_id,
        fields: ['item_id', 'video_views', 'reach', 'likes', 'comments', 'shares', 'favorites', 'average_time_watched', 'share_url'],
        filters: { video_ids: ids.slice(i, i + 20) },
        max_count: 20
      }
    });
    if (!r.ok) return { ok: false, error: r.error, posts: out };
    for (const v of r.data.videos || []) out[String(v.item_id)] = v;
  }
  const p = await profile(true);
  return { ok: true, posts: out, followers: p ? p.followers : null };
}

module.exports = {
  appCfg, configured, exchangeCode, saveConnection, account, disconnect, profile, creatorInfo,
  verifyUrlPrefix, ready, status, isBizId, startPost, tryFinish, stats, readState, saveState, returnedReady,
  URL_PREFIX, PLATFORM, ID_PREFIX,
  _state: state, // test harness
  _resetReturn: () => { returnDone = false; } // test harness
};
