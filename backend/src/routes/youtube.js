const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const db = require('../database/db');
const youtubePublish = require('../services/youtubePublish');

// YouTube (Google OAuth, project "Sams Social Studio") connect flow and
// credential storage. Same shape and the same protections as routes/tiktok.js:
// publicRouter carries only what the OAuth dance needs without a JWT;
// apiRouter is mounted behind the /api JWT gate. Never merge them.
//
// Rebinding protection, twice over:
//  1. /auth/youtube/start only works with a single-use ticket minted by the
//     JWT-protected /api/youtube/connect-url.
//  2. First connect wins: once a channel is bound, a DIFFERENT channel id is
//     refused unless the owner explicitly disconnected first.

const publicRouter = express.Router();
const apiRouter = express.Router();

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API = 'https://www.googleapis.com/youtube/v3';
const SCOPES = [
  'https://www.googleapis.com/auth/youtube.upload',
  'https://www.googleapis.com/auth/youtube.readonly'
].join(' ');

function esc(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function appCfg() {
  return {
    id: process.env.YOUTUBE_CLIENT_ID,
    secret: process.env.YOUTUBE_CLIENT_SECRET,
    redirect: process.env.YOUTUBE_REDIRECT_URI ||
      'https://api.sams-social-system.sams.ge/auth/youtube/callback'
  };
}

// Fail CLOSED: without JWT_SECRET nothing on this public surface validates.
function sign(domain, payload) {
  if (!process.env.JWT_SECRET) return null;
  return crypto.createHmac('sha256', process.env.JWT_SECRET)
    .update('youtube-' + domain + ':' + payload).digest('hex').slice(0, 32);
}
// Single use: an authorize URL leaks into browser history; replaying it
// must be worthless.
const usedTokens = new Map(); // value -> expiry ms
function sweepUsed() {
  const now = Date.now();
  if (usedTokens.size > 500) {
    for (const [k, v] of usedTokens) if (v < now) usedTokens.delete(k);
  }
}
function makeToken(domain) {
  const ts = Date.now().toString(36) + '-' + crypto.randomBytes(6).toString('hex');
  const sig = sign(domain, ts);
  return sig ? ts + '.' + sig : null;
}
function consumeToken(domain, t) {
  const str = String(t || '');
  const [ts, sig] = str.split('.');
  if (!ts || !sig) return false;
  const expect = sign(domain, ts);
  if (!expect || sig !== expect) return false;
  const age = Date.now() - parseInt(ts.split('-')[0], 36);
  if (!(age >= 0 && age < 15 * 60 * 1000)) return false;
  if (usedTokens.has(domain + ':' + str)) return false;
  usedTokens.set(domain + ':' + str, Date.now() + 16 * 60 * 1000);
  sweepUsed();
  return true;
}

// ---------- JWT side ----------

apiRouter.get('/youtube/connect-url', (req, res) => {
  const cfg = appCfg();
  if (!cfg.id || !cfg.secret) {
    return res.status(503).json({
      error: 'YouTube app credentials not set - open /auth/youtube/secret-setup first and paste the Client ID and Client secret from Google Cloud'
    });
  }
  const ticket = makeToken('ticket');
  if (!ticket) return res.status(503).json({ error: 'JWT_SECRET not configured on the server' });
  res.json({ url: cfg.redirect.replace('/auth/youtube/callback', '') + '/auth/youtube/start?ticket=' + ticket });
});

apiRouter.get('/youtube/status', async (req, res) => {
  const rows = await db.query(
    "SELECT business_account_id, expires_at, status, updated_at FROM accounts WHERE platform = 'youtube' ORDER BY (status = 'active') DESC, id DESC LIMIT 1"
  );
  if (rows === null) return res.status(503).json({ error: 'Database unavailable' });
  const configured = Boolean(process.env.YOUTUBE_CLIENT_ID && process.env.YOUTUBE_CLIENT_SECRET);
  if (!rows.length) return res.json({ connected: false, configured });
  const acc = rows[0];
  const info = acc.status === 'active' ? await youtubePublish.channelInfo() : { ok: false };
  res.json({
    // A working binding must not read "not connected" just because the
    // channel-name lookup blipped (that invites a needless reconnect).
    connected: acc.status === 'active',
    channel_unavailable: acc.status === 'active' && !info.ok,
    configured,
    channel_id: acc.business_account_id,
    status: acc.status,
    channel: info.ok ? info.channel : null,
    audited: youtubePublish.appAudited()
  });
});

// Channel shown in the approve sheet ("Posting to ...").
apiRouter.get('/youtube/channel-info', async (req, res) => {
  const r = await youtubePublish.channelInfo();
  if (!r.ok) return res.status(503).json({ error: r.error });
  res.json({
    channel: r.channel,
    audited: youtubePublish.appAudited(),
    privacy_options: youtubePublish.appAudited() ? youtubePublish.PRIVACY : ['private']
  });
});

apiRouter.post('/youtube/disconnect', async (req, res) => {
  const rows = await db.query("UPDATE accounts SET status = 'disconnected' WHERE platform = 'youtube'");
  if (rows === null) return res.status(503).json({ error: 'Database unavailable' });
  res.json({ ok: true, note: 'Reconnect from the panel when ready - the next connect may bind a different channel' });
});

// ---------- public OAuth side ----------

publicRouter.get('/auth/youtube/start', (req, res) => {
  const cfg = appCfg();
  if (!cfg.id) return res.status(503).send('YOUTUBE_CLIENT_ID not configured');
  if (!consumeToken('ticket', req.query.ticket)) {
    return res.status(403).send('This link must be opened fresh from the panel (Settings - Platform Connections); each link works once, within 15 minutes.');
  }
  const state = makeToken('state');
  if (!state) return res.status(503).send('Server not configured');
  const url = AUTH_URL +
    '?client_id=' + encodeURIComponent(cfg.id) +
    '&redirect_uri=' + encodeURIComponent(cfg.redirect) +
    '&response_type=code' +
    '&scope=' + encodeURIComponent(SCOPES) +
    // offline + consent: guarantees a refresh token, which unattended
    // publishing needs (Google omits it on repeat consents otherwise).
    '&access_type=offline&prompt=consent' +
    '&state=' + encodeURIComponent(state);
  res.redirect(url);
});

publicRouter.get('/auth/youtube/callback', async (req, res) => {
  const cfg = appCfg();
  const fail = (msg) => res.status(500).send(
    '<h2>YouTube connection failed</h2><p>' + esc(msg) + '</p><p>Go back to the panel and press Connect YouTube again.</p>'
  );
  try {
    if (!consumeToken('state', req.query.state)) return fail('Missing, expired or already-used state - start again from the panel');
    if (req.query.error) return fail('Google returned: ' + req.query.error);
    if (!req.query.code) return fail('No authorization code received');
    if (!cfg.id || !cfg.secret) return fail('YOUTUBE_CLIENT_ID / YOUTUBE_CLIENT_SECRET not configured');

    const r = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code: req.query.code,
        client_id: cfg.id,
        client_secret: cfg.secret,
        redirect_uri: cfg.redirect,
        grant_type: 'authorization_code'
      }),
      signal: AbortSignal.timeout(30 * 1000)
    });
    const j = await r.json();
    if (!j.access_token) {
      // Never echo the raw body - it can contain live tokens.
      console.warn('[youtube] token exchange failed: ' + String(j.error || 'no access_token'));
      return fail('Token exchange failed: ' + String(j.error_description || j.error || 'unexpected response').slice(0, 200));
    }
    if (!j.refresh_token) {
      return fail('Google did not hand out a long-term key. Remove "Sams Social Studio" at myaccount.google.com/permissions, then press Connect YouTube again.');
    }
    const granted = String(j.scope || '');
    if (!granted.includes('youtube.upload')) {
      return fail('Upload permission was not granted - on the Google screen, tick the box that allows managing your YouTube videos.');
    }

    // Which channel did the owner pick? (A Google account can hold several.)
    const cr = await fetch(API + '/channels?part=snippet&mine=true', {
      headers: { Authorization: 'Bearer ' + j.access_token },
      signal: AbortSignal.timeout(15 * 1000)
    });
    const cj = await cr.json().catch(() => ({}));
    if (!cr.ok) {
      return fail('Could not read the channel (' + String((cj.error && cj.error.message) || ('HTTP ' + cr.status)).slice(0, 160) + '). On the Google screen keep BOTH permissions ticked, then try again.');
    }
    const ch = cj.items && cj.items[0];
    if (!ch) {
      return fail('That Google account has no YouTube channel. On the Google screen, choose the account or brand account that owns the Sam’s channel.');
    }

    // Optional hard pin: with YOUTUBE_CHANNEL_ID set, no other channel can
    // ever be bound - not even on the very first connect.
    const pinned = String(process.env.YOUTUBE_CHANNEL_ID || '').trim();
    if (pinned && String(ch.id) !== pinned) {
      return fail('That is the channel "' + ((ch.snippet && ch.snippet.title) || ch.id) + '", not the Sam\u2019s channel this system is locked to. Press Connect YouTube again and pick Sam\u2019s More Than Pizza on the Google screen.');
    }

    const existing = await db.query("SELECT business_account_id, status FROM accounts WHERE platform = 'youtube'");
    if (existing === null) return fail('Database unavailable - nothing was saved. Try again in a minute.');
    const conflict = existing.find((row) => row.business_account_id !== String(ch.id) && row.status !== 'disconnected');
    if (conflict) {
      return fail('A different YouTube channel is already bound (status: ' + conflict.status + '). Disconnect it in the panel first if you really mean to switch channels.');
    }

    const expiresAt = new Date(Date.now() + (j.expires_in || 3600) * 1000);
    const saved = await db.query(
      "INSERT INTO accounts (platform, business_account_id, access_token, refresh_token, expires_at, status) VALUES ('youtube', ?, ?, ?, ?, 'active')" +
      ' ON DUPLICATE KEY UPDATE access_token = VALUES(access_token), refresh_token = VALUES(refresh_token), expires_at = VALUES(expires_at), status = VALUES(status)',
      [String(ch.id), j.access_token, j.refresh_token, expiresAt]
    );
    if (saved === null) return fail('Keys were obtained but could NOT be stored - nothing was saved. Check /api/system and retry.');

    res.send(
      '<h2 style="font-family:sans-serif">YouTube connected</h2>' +
      '<ul style="font-family:sans-serif">' +
      '<li>Channel: ' + esc(ch.snippet && ch.snippet.title) + '</li>' +
      '<li>Channel id: ' + esc(ch.id) + '</li>' +
      '<li>The access key renews itself automatically.</li>' +
      '</ul>' +
      '<p style="font-family:sans-serif">You can close this window. Videos still upload only after your Approve in the panel.</p>'
    );
  } catch (err) {
    fail(err.message);
  }
});

// ---------- one-time credential setup (owner web form) ----------

const ENV_PATH = path.join(__dirname, '..', '..', '..', '.env');

function setupPage(msg, ok) {
  return '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<body style="font-family:sans-serif;max-width:430px;margin:40px auto;padding:0 16px">' +
    '<h2>YouTube credentials setup</h2>' +
    '<p>Paste the <b>Client ID</b> and <b>Client secret</b> of the <b>Sams Social Studio Web</b> client from Google Cloud (Google Auth Platform &rarr; Clients), or from the JSON file you downloaded.</p>' +
    (msg ? '<p style="padding:10px;border-radius:8px;background:' + (ok ? '#e3f2e9' : '#fde4e4') + '">' + msg + '</p>' : '') +
    '<form method="POST" action="/auth/youtube/secret-setup">' +
    '<p><label>Panel password<br><input type="password" name="password" style="width:100%;padding:8px" required></label></p>' +
    '<p><label>Client ID (ends with .apps.googleusercontent.com)<br><input type="text" name="client_id" style="width:100%;padding:8px" required></label></p>' +
    '<p><label>Client secret (starts with GOCSPX-)<br><input type="password" name="client_secret" style="width:100%;padding:8px" required></label></p>' +
    '<button style="padding:10px 18px;background:#F15C22;color:#fff;border:none;border-radius:8px">Save credentials</button>' +
    '</form></body>';
}

publicRouter.get('/auth/youtube/secret-setup', (req, res) => {
  res.send(setupPage(null, false));
});

const setupAttempts = new Map();
publicRouter.post('/auth/youtube/secret-setup', express.urlencoded({ extended: false }), (req, res) => {
  // Last XFF hop = the one Apache appended (the first is client-spoofable).
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').split(',').pop().trim();
  const now = Date.now();
  const entry = setupAttempts.get(ip) || { count: 0, windowStart: now };
  if (now - entry.windowStart > 15 * 60 * 1000) { entry.count = 0; entry.windowStart = now; }
  entry.count += 1;
  setupAttempts.set(ip, entry);
  if (setupAttempts.size > 500) {
    for (const [k, v] of setupAttempts) {
      if (now - v.windowStart > 15 * 60 * 1000) setupAttempts.delete(k);
    }
  }
  if (entry.count > 5) return res.status(429).send(setupPage('Too many attempts - try again in 15 minutes.', false));

  const b = req.body || {};
  if (!process.env.OWNER_PASSWORD || b.password !== process.env.OWNER_PASSWORD) {
    return res.status(401).send(setupPage('Wrong panel password.', false));
  }
  const id = String(b.client_id || '').trim();
  const secret = String(b.client_secret || '').trim();
  if (!/^[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com$/.test(id)) {
    return res.status(400).send(setupPage('That Client ID does not look right - it should end with .apps.googleusercontent.com.', false));
  }
  if (secret.length < 20 || secret.length > 100 || /\s/.test(secret)) {
    return res.status(400).send(setupPage('That Client secret does not look right (' + secret.length + ' characters) - it usually starts with GOCSPX-.', false));
  }
  try {
    let env = fs.readFileSync(ENV_PATH, 'utf8');
    for (const [name, val] of [['YOUTUBE_CLIENT_ID', id], ['YOUTUBE_CLIENT_SECRET', secret]]) {
      const re = new RegExp('^' + name + '=.*$', 'm');
      // Replacer FUNCTION: a '$' in the secret must never trigger $-substitution.
      if (re.test(env)) env = env.replace(re, () => name + '=' + val);
      else env = env.trimEnd() + String.fromCharCode(10) + name + '=' + val + String.fromCharCode(10);
    }
    // Atomic: a crash mid-write must never truncate the live .env.
    fs.writeFileSync(ENV_PATH + '.tmp', env);
    fs.renameSync(ENV_PATH + '.tmp', ENV_PATH);
    process.env.YOUTUBE_CLIENT_ID = id;
    process.env.YOUTUBE_CLIENT_SECRET = secret;
    res.send(setupPage('Saved and active. Now go to the panel and press Connect YouTube.', true));
  } catch (err) {
    res.status(500).send(setupPage('Could not write .env: ' + esc(err.message), false));
  }
});

module.exports = { publicRouter, apiRouter };
