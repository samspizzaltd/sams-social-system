const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const db = require('../database/db');
const tiktokPublish = require('../services/tiktokPublish');

// TikTok (Sams Social Studio app) OAuth and credential storage.
//
// publicRouter: only what the OAuth dance itself requires without a JWT -
// /auth/tiktok/start, /auth/tiktok/callback, and the owner secret-setup form.
// apiRouter: everything else, mounted behind the /api JWT gate by index.js.
// Never merge these (the meta.js incident).
//
// Rebinding protection, twice over:
//  1. /auth/tiktok/start only works with a short-lived ticket minted by the
//     JWT-protected /api/tiktok/connect-url - a stranger cannot even start.
//  2. First connect wins: once a TikTok account is bound, a DIFFERT open_id
//     is refused unless the owner deliberately clears the connection first.

const publicRouter = express.Router();
const apiRouter = express.Router();

const API = 'https://open.tiktokapis.com/v2';
const SCOPES = 'user.info.basic,video.publish,video.upload';

function esc(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function appCfg() {
  return {
    key: process.env.TIKTOK_CLIENT_KEY,
    secret: process.env.TIKTOK_CLIENT_SECRET,
    redirect: process.env.TIKTOK_REDIRECT_URI ||
      'https://api.sams-social-system.sams.ge/auth/tiktok/callback'
  };
}

// Fail CLOSED: without JWT_SECRET nothing on this public surface validates.
function sign(domain, payload) {
  if (!process.env.JWT_SECRET) return null;
  return crypto.createHmac('sha256', process.env.JWT_SECRET)
    .update('tiktok-' + domain + ':' + payload).digest('hex').slice(0, 32);
}
// Each minted value is single-use (an authorize URL leaks into browser
// history; replaying it must be worthless).
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
  if (usedTokens.has(domain + ':' + str)) return false; // single use
  usedTokens.set(domain + ':' + str, Date.now() + 16 * 60 * 1000);
  sweepUsed();
  return true;
}

// ---------- JWT side ----------

// The panel's Connect button gets the start URL from here, so only a
// logged-in owner can initiate the OAuth dance.
apiRouter.get('/tiktok/connect-url', (req, res) => {
  const cfg = appCfg();
  if (!cfg.key || !cfg.secret) {
    return res.status(503).json({
      error: 'TikTok app credentials not set - open /auth/tiktok/secret-setup first (use the SANDBOX client key and secret while testing)'
    });
  }
  const ticket = makeToken('ticket');
  if (!ticket) return res.status(503).json({ error: 'JWT_SECRET not configured on the server' });
  res.json({ url: cfg.redirect.replace('/auth/tiktok/callback', '') + '/auth/tiktok/start?ticket=' + ticket });
});

apiRouter.get('/tiktok/status', async (req, res) => {
  const rows = await db.query(
    "SELECT business_account_id, expires_at, status, updated_at FROM accounts WHERE platform = 'tiktok' ORDER BY (status = 'active') DESC, id DESC LIMIT 1"
  );
  if (rows === null) return res.status(503).json({ error: 'Database unavailable' });
  if (!rows.length) return res.json({ connected: false });
  const acc = rows[0];
  let profile = null;
  const live = await tiktokPublish.account(); // refreshes if close to expiry
  if (live) {
    try {
      const r = await fetch(API + '/user/info/?fields=open_id,display_name,avatar_url', {
        headers: { Authorization: 'Bearer ' + live.access_token },
        signal: AbortSignal.timeout(15 * 1000)
      });
      const j = await r.json();
      if (j.data && j.data.user) profile = j.data.user;
    } catch { /* profile is cosmetic */ }
  }
  res.json({
    connected: acc.status === 'active' && !!live,
    open_id: acc.business_account_id,
    status: acc.status,
    expires_at: acc.expires_at,
    profile
  });
});

// Creator info for the approve sheet (TikTok UX requirement: show nickname,
// allowed privacy levels and interaction availability before posting).
apiRouter.get('/tiktok/creator-info', async (req, res) => {
  const r = await tiktokPublish.creatorInfo();
  if (!r.ok) return res.status(503).json({ error: r.error });
  res.json({ creator: r.creator });
});

// Deliberate unbind, so a reconnect with a different account is an explicit
// two-step owner action rather than something an OAuth dance can cause.
apiRouter.post('/tiktok/disconnect', async (req, res) => {
  const rows = await db.query("UPDATE accounts SET status = 'disconnected' WHERE platform = 'tiktok'");
  if (rows === null) return res.status(503).json({ error: 'Database unavailable' });
  res.json({ ok: true, note: 'Reconnect from the panel when ready - the next connect may bind a different TikTok account' });
});

// ---------- public OAuth side ----------

publicRouter.get('/auth/tiktok/start', (req, res) => {
  const cfg = appCfg();
  if (!cfg.key) return res.status(503).send('TIKTOK_CLIENT_KEY not configured');
  if (!consumeToken('ticket', req.query.ticket)) {
    return res.status(403).send('This link must be opened fresh from the panel (Settings - Platform Connections); each link works once, within 15 minutes.');
  }
  const state = makeToken('state');
  if (!state) return res.status(503).send('Server not configured');
  const url = 'https://www.tiktok.com/v2/auth/authorize/' +
    '?client_key=' + encodeURIComponent(cfg.key) +
    '&scope=' + encodeURIComponent(SCOPES) +
    '&response_type=code' +
    '&redirect_uri=' + encodeURIComponent(cfg.redirect) +
    '&state=' + encodeURIComponent(state);
  res.redirect(url);
});

publicRouter.get('/auth/tiktok/callback', async (req, res) => {
  const cfg = appCfg();
  const fail = (msg) => res.status(500).send(
    '<h2>TikTok connection failed</h2><p>' + esc(msg) + '</p><p>Go back to the panel and press Connect TikTok again.</p>'
  );
  try {
    if (!consumeToken('state', req.query.state)) return fail('Missing, expired or already-used state - start again from the panel');
    if (req.query.error) return fail('TikTok returned: ' + (req.query.error_description || req.query.error));
    if (!req.query.code) return fail('No authorization code received');
    if (!cfg.key || !cfg.secret) return fail('TIKTOK_CLIENT_KEY / TIKTOK_CLIENT_SECRET not configured');

    const r = await fetch(API + '/oauth/token/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_key: cfg.key,
        client_secret: cfg.secret,
        grant_type: 'authorization_code',
        code: req.query.code,
        redirect_uri: cfg.redirect
      }),
      signal: AbortSignal.timeout(30 * 1000)
    });
    const j = await r.json();
    if (!j.access_token || !j.open_id) {
      // Never echo the raw body - it can contain live tokens.
      const safe = j.error_description || j.error || 'unexpected response shape (details in the server log)';
      console.warn('[tiktok] token exchange failed: ' + JSON.stringify({ ...j, access_token: undefined, refresh_token: undefined }).slice(0, 300));
      return fail('Token exchange failed: ' + String(safe).slice(0, 200));
    }

    // First connect wins: a different account may not silently replace the
    // bound one. The owner disconnects first (panel button), then reconnects.
    const existing = await db.query(
      "SELECT business_account_id, status FROM accounts WHERE platform = 'tiktok'"
    );
    if (existing === null) return fail('Database unavailable - nothing was saved. Try again in a minute.');
    // Only an EXPLICIT owner disconnect releases the binding - an auto-expired
    // row must still refuse a different account (that is the exact mistake
    // this pinning exists to catch).
    const conflict = existing.find((r) => r.business_account_id !== String(j.open_id) && r.status !== 'disconnected');
    if (conflict) {
      return fail('A different TikTok account is already bound (status: ' + conflict.status + '). Disconnect it in the panel first if you really mean to switch accounts.');
    }

    const expiresAt = new Date(Date.now() + (j.expires_in || 86400) * 1000);
    const saved = await db.query(
      "INSERT INTO accounts (platform, business_account_id, access_token, refresh_token, expires_at, status) VALUES ('tiktok', ?, ?, ?, ?, 'active')" +
      ' ON DUPLICATE KEY UPDATE access_token = VALUES(access_token), refresh_token = VALUES(refresh_token), expires_at = VALUES(expires_at), status = VALUES(status)',
      [String(j.open_id), j.access_token, j.refresh_token || null, expiresAt]
    );
    if (saved === null) return fail('Tokens were obtained but could NOT be stored - nothing was saved. Check /api/system and retry.');

    // Show who got connected, so a wrong-account connect is caught on sight.
    let who = '';
    try {
      const ur = await fetch(API + '/user/info/?fields=open_id,display_name', {
        headers: { Authorization: 'Bearer ' + j.access_token },
        signal: AbortSignal.timeout(15 * 1000)
      });
      const uj = await ur.json();
      if (uj.data && uj.data.user) {
        who = '<li>Account: ' + esc(uj.data.user.display_name || '') + '</li>';
      }
    } catch { /* cosmetic */ }

    res.send(
      '<h2 style="font-family:sans-serif">TikTok connected</h2>' +
      '<ul style="font-family:sans-serif">' + who +
      '<li>open_id: ' + esc(j.open_id) + '</li>' +
      '<li>Scopes: ' + esc(j.scope || SCOPES) + '</li>' +
      '<li>Access token valid ~24h; it refreshes itself automatically.</li>' +
      '</ul>' +
      '<p style="font-family:sans-serif">You can close this window. Posts still publish only after your Approve in the panel.</p>'
    );
  } catch (err) {
    fail(err.message);
  }
});

// ---------- one-time credential setup (owner web form, like Meta's) ----------

const ENV_PATH = path.join(__dirname, '..', '..', '..', '.env');

function setupPage(msg, ok) {
  return '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<body style="font-family:sans-serif;max-width:430px;margin:40px auto;padding:0 16px">' +
    '<h2>TikTok credentials setup</h2>' +
    '<p>Paste the <b>Client key</b> and <b>Client secret</b> from the TikTok developer portal. While testing, use the <b>Sandbox</b> credentials (Sams Social Studio Sandbox &rarr; Credentials); switch to the Production ones the same way after app review.</p>' +
    (msg ? '<p style="padding:10px;border-radius:8px;background:' + (ok ? '#e3f2e9' : '#fde4e4') + '">' + msg + '</p>' : '') +
    '<form method="POST" action="/auth/tiktok/secret-setup">' +
    '<p><label>Panel password<br><input type="password" name="password" style="width:100%;padding:8px" required></label></p>' +
    '<p><label>Client key<br><input type="text" name="client_key" style="width:100%;padding:8px" required></label></p>' +
    '<p><label>Client secret<br><input type="password" name="client_secret" style="width:100%;padding:8px" required></label></p>' +
    '<button style="padding:10px 18px;background:#F15C22;color:#fff;border:none;border-radius:8px">Save credentials</button>' +
    '</form></body>';
}

publicRouter.get('/auth/tiktok/secret-setup', (req, res) => {
  res.send(setupPage(null, false));
});

const setupAttempts = new Map();
publicRouter.post('/auth/tiktok/secret-setup', express.urlencoded({ extended: false }), (req, res) => {
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
  const key = String(b.client_key || '').trim();
  const secret = String(b.client_secret || '').trim();
  if (key.length < 10 || key.length > 60 || /\s/.test(key)) {
    return res.status(400).send(setupPage('That client key does not look right (' + key.length + ' characters). Copy it with the Show control in the portal.', false));
  }
  if (secret.length < 20 || secret.length > 100 || /\s/.test(secret)) {
    return res.status(400).send(setupPage('That client secret does not look right (' + secret.length + ' characters). Copy it with the Show control in the portal.', false));
  }
  try {
    let env = fs.readFileSync(ENV_PATH, 'utf8');
    for (const [name, val] of [['TIKTOK_CLIENT_KEY', key], ['TIKTOK_CLIENT_SECRET', secret]]) {
      const re = new RegExp('^' + name + '=.*$', 'm');
      // Replacer FUNCTION: a '$' in the secret must never trigger $-substitution.
      if (re.test(env)) env = env.replace(re, () => name + '=' + val);
      else env = env.trimEnd() + String.fromCharCode(10) + name + '=' + val + String.fromCharCode(10);
    }
    // Atomic: a crash mid-write must never truncate the live .env.
    fs.writeFileSync(ENV_PATH + '.tmp', env);
    fs.renameSync(ENV_PATH + '.tmp', ENV_PATH);
    process.env.TIKTOK_CLIENT_KEY = key;       // effective immediately
    process.env.TIKTOK_CLIENT_SECRET = secret; // no restart needed
    res.send(setupPage('Saved and active. Now go to the panel and press Connect TikTok.', true));
  } catch (err) {
    res.status(500).send(setupPage('Could not write .env: ' + esc(err.message), false));
  }
});

module.exports = { publicRouter, apiRouter };
