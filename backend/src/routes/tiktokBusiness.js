const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const tiktokBusiness = require('../services/tiktokBusiness');

// TikTok through TikTok's business interface (services/tiktokBusiness.js):
// the owner's one-time setup form, the Connect flow and the panel's controls.
//
// publicRouter: only what the OAuth dance needs without a JWT -
// /auth/tiktok-business/start, /callback/ and the password-protected setup form.
// apiRouter: everything else, behind the /api JWT gate (index.js).
// Same protections as the first TikTok app: start needs a single-use ticket
// minted by the JWT side, the state is signed and single-use, first connect wins.

const publicRouter = express.Router();
const apiRouter = express.Router();

function esc(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function sign(domain, payload) {
  if (!process.env.JWT_SECRET) return null; // fail closed
  return crypto.createHmac('sha256', process.env.JWT_SECRET).update('tiktokbiz-' + domain + ':' + payload).digest('hex').slice(0, 32);
}
const used = new Map();
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
  if (used.has(domain + ':' + str)) return false;
  used.set(domain + ':' + str, Date.now() + 16 * 60 * 1000);
  if (used.size > 500) for (const [k, v] of used) if (v < Date.now()) used.delete(k);
  return true;
}

const page = (title, body) => '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">' +
  '<body style="font-family:sans-serif;max-width:520px;margin:40px auto;padding:0 16px;line-height:1.45">' +
  '<h2>' + esc(title) + '</h2>' + body + '</body>';

// ---------- JWT side ----------

apiRouter.get('/tiktok-business/status', async (req, res) => {
  try {
    res.json(await tiktokBusiness.status());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

apiRouter.get('/tiktok-business/connect-url', (req, res) => {
  const c = tiktokBusiness.appCfg();
  if (!c.id || !c.secret || !c.authUrl) {
    return res.status(503).json({ error: 'The TikTok business app is not set up yet - open the setup form first (Set up the app keys)' });
  }
  const ticket = makeToken('ticket');
  if (!ticket) return res.status(503).json({ error: 'JWT_SECRET not configured on the server' });
  res.json({ url: c.redirect.replace(/\/auth\/tiktok-business\/callback\/?$/, '') + '/auth/tiktok-business/start?ticket=' + ticket });
});

apiRouter.post('/tiktok-business/verify-url', async (req, res) => {
  const r = await tiktokBusiness.verifyUrlPrefix();
  if (!r.ok) return res.status(502).json({ error: r.error });
  res.json(r);
});

apiRouter.post('/tiktok-business/disconnect', async (req, res) => {
  if (!(await tiktokBusiness.disconnect())) return res.status(503).json({ error: 'Database unavailable' });
  res.json({ ok: true, note: 'Disconnected. TikTok posts wait again until you connect.' });
});

// ---------- OAuth ----------

publicRouter.get('/auth/tiktok-business/start', (req, res) => {
  const c = tiktokBusiness.appCfg();
  if (!c.authUrl) return res.status(503).send(page('TikTok', '<p>The TikTok business app is not set up yet.</p>'));
  if (!consumeToken('ticket', req.query.ticket)) {
    return res.status(403).send(page('TikTok', '<p>This link must be opened fresh from the panel (Settings → Platform Connections); each link works once, within 15 minutes.</p>'));
  }
  const st = makeToken('state');
  if (!st) return res.status(503).send(page('TikTok', '<p>Server not configured.</p>'));
  let url;
  try {
    url = new URL(c.authUrl); // the "TikTok account holder authorization URL" from the developer portal
  } catch {
    return res.status(503).send(page('TikTok', '<p>The saved authorization URL is not a valid address - open the setup form again.</p>'));
  }
  url.searchParams.set('state', st);
  res.redirect(url.toString());
});

publicRouter.get('/auth/tiktok-business/callback', async (req, res) => {
  const fail = (msg) => res.status(500).send(page('TikTok connection failed',
    '<p>' + esc(msg) + '</p><p>Go back to the panel (Settings → Platform Connections) and press Connect again.</p>'));
  try {
    if (!consumeToken('state', req.query.state)) return fail('Missing, expired or already-used state - start again from the panel');
    if (req.query.error) return fail('TikTok returned: ' + (req.query.error_description || req.query.error));
    const code = req.query.code || req.query.auth_code;
    if (!code) return fail('No authorization code received');
    const ex = await tiktokBusiness.exchangeCode(String(code));
    if (!ex.ok) return fail('Token exchange failed: ' + ex.error);
    const saved = await tiktokBusiness.saveConnection(ex.data);
    if (!saved.ok) return fail(saved.error);
    const p = await tiktokBusiness.profile(true).catch(() => null);
    const v = await tiktokBusiness.verifyUrlPrefix().catch((err) => ({ ok: false, error: err.message }));
    const scope = String(ex.data.scope || '');
    res.send(page('TikTok connected',
      '<ul>' +
      (p && (p.display_name || p.username) ? '<li>Account: <b>' + esc(p.display_name || '') + '</b>' + (p.username ? ' (@' + esc(p.username) + ')' : '') + '</li>' : '') +
      '<li>Posting allowed: ' + (scope.split(',').includes('video.publish') ? 'yes' : '<b>NO - the app lacks the video.publish permission</b>') + '</li>' +
      '<li>Video address check: ' + (v.ok ? 'verified ✓' : 'not yet - ' + esc(v.error) + ' (press "Verify video address" in the panel)') + '</li>' +
      '<li>The connection renews itself every day for a year.</li>' +
      '</ul><p>You can close this window. Posts still go out only after your Approve in the panel.</p>'));
  } catch (err) {
    fail(err.message);
  }
});

// ---------- one-time setup form (owner, password-protected) ----------

const ENV_PATH = process.env.TIKTOK_BIZ_ENV_PATH || path.join(__dirname, '..', '..', '..', '.env');

function setupPage(msg, ok) {
  const c = tiktokBusiness.appCfg();
  return page('TikTok business app - setup',
    '<p>From <b>business-api.tiktok.com → My Apps → your app → Basic Information</b>, paste the <b>App ID</b>, the <b>Secret</b> and the ' +
    '<b>TikTok account holder authorization URL</b>.</p>' +
    '<p>In the same place, the <b>TikTok account holder redirect URL</b> must be exactly:<br><code>' + esc(c.redirect) + '</code></p>' +
    (msg ? '<p style="padding:10px;border-radius:8px;background:' + (ok ? '#e3f2e9' : '#fde4e4') + '">' + msg + '</p>' : '') +
    '<form method="POST" action="/auth/tiktok-business/secret-setup">' +
    '<p><label>Panel password<br><input type="password" name="password" style="width:100%;padding:8px" required></label></p>' +
    '<p><label>App ID<br><input type="text" name="app_id" style="width:100%;padding:8px" required></label></p>' +
    '<p><label>Secret<br><input type="password" name="secret" style="width:100%;padding:8px" required></label></p>' +
    '<p><label>TikTok account holder authorization URL<br><input type="url" name="auth_url" style="width:100%;padding:8px" required></label></p>' +
    '<button style="padding:10px 18px;background:#F15C22;color:#fff;border:none;border-radius:8px">Save</button>' +
    '</form>');
}

publicRouter.get('/auth/tiktok-business/secret-setup', (req, res) => res.send(setupPage(null, false)));

const attempts = new Map();
publicRouter.post('/auth/tiktok-business/secret-setup', express.urlencoded({ extended: false }), async (req, res) => {
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').split(',').pop().trim();
  const now = Date.now();
  const e = attempts.get(ip) || { count: 0, windowStart: now };
  if (now - e.windowStart > 15 * 60 * 1000) { e.count = 0; e.windowStart = now; }
  e.count += 1;
  attempts.set(ip, e);
  if (attempts.size > 500) for (const [k, v] of attempts) if (now - v.windowStart > 15 * 60 * 1000) attempts.delete(k);
  if (e.count > 5) return res.status(429).send(setupPage('Too many attempts - try again in 15 minutes.', false));

  const b = req.body || {};
  if (!process.env.OWNER_PASSWORD || b.password !== process.env.OWNER_PASSWORD) {
    return res.status(401).send(setupPage('Wrong panel password.', false));
  }
  const appId = String(b.app_id || '').trim();
  const secret = String(b.secret || '').trim();
  const authUrl = String(b.auth_url || '').trim();
  if (!/^\d{6,30}$/.test(appId)) return res.status(400).send(setupPage('That App ID does not look right - it is a long number.', false));
  if (secret.length < 16 || secret.length > 120 || /\s/.test(secret)) return res.status(400).send(setupPage('That Secret does not look right (' + secret.length + ' characters).', false));
  let u;
  try { u = new URL(authUrl); } catch { u = null; }
  if (!u || u.protocol !== 'https:' || !/(^|\.)tiktok\.com$/.test(u.hostname)) {
    return res.status(400).send(setupPage('The authorization URL must be the https://www.tiktok.com/... address from the portal.', false));
  }
  try {
    let env = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, 'utf8') : '';
    for (const [name, val] of [['TIKTOK_BIZ_APP_ID', appId], ['TIKTOK_BIZ_SECRET', secret], ['TIKTOK_BIZ_AUTH_URL', authUrl]]) {
      const re = new RegExp('^' + name + '=.*$', 'm');
      // Replacer FUNCTION: a '$' in a value must never trigger $-substitution.
      if (re.test(env)) env = env.replace(re, () => name + '=' + val);
      else env = env.trimEnd() + String.fromCharCode(10) + name + '=' + val + String.fromCharCode(10);
    }
    fs.writeFileSync(ENV_PATH + '.tmp', env); // atomic: never a half-written .env
    fs.renameSync(ENV_PATH + '.tmp', ENV_PATH);
    process.env.TIKTOK_BIZ_APP_ID = appId; // effective at once, no restart
    process.env.TIKTOK_BIZ_SECRET = secret;
    process.env.TIKTOK_BIZ_AUTH_URL = authUrl;
  } catch (err) {
    return res.status(500).send(setupPage('Could not save: ' + esc(err.message), false));
  }
  // The video address can be verified right away (it needs only the app keys).
  const v = await tiktokBusiness.verifyUrlPrefix().catch((err) => ({ ok: false, error: err.message }));
  res.send(setupPage('Saved and active. Video address check: ' + (v.ok ? 'verified ✓' : 'not yet - ' + esc(v.error)) +
    '. Now go to the panel (Settings → Platform Connections) and press Connect TikTok (business).', true));
});

module.exports = { publicRouter, apiRouter };
