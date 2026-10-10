const express = require('express');
const db = require('../database/db');

// Meta (Instagram + Facebook) OAuth and token storage.
//
// Flow: GET /auth/meta/start redirects the signed-in owner to Facebook's
// consent dialog; Facebook sends the code to GET /auth/meta/callback, which
// exchanges it for a long-lived user token, derives the Page token and the
// Instagram business account id, and stores everything in the accounts table.
// Secrets live in the server .env (META_APP_ID, META_APP_SECRET), never in code.

const router = express.Router();

const GRAPH = 'https://graph.facebook.com/v26.0';
const SCOPES = [
  'instagram_basic',
  'instagram_content_publish',
  'pages_show_list',
  'pages_read_engagement',
  'pages_manage_posts',
  'pages_manage_engagement',
  'instagram_manage_insights',
  'business_management'
].join(',');

function appConfig() {
  return {
    id: process.env.META_APP_ID,
    secret: process.env.META_APP_SECRET,
    redirect: (process.env.META_REDIRECT_URI ||
      'https://api.sams-social-system.sams.ge/auth/meta/callback')
  };
}

async function saveAccount(platform, businessAccountId, accessToken, expiresAt) {
  if (!businessAccountId || !accessToken) return false;
  const rows = await db.query(
    'INSERT INTO accounts (platform, business_account_id, access_token, expires_at, status)' +
    ' VALUES (?,?,?,?,?) ON DUPLICATE KEY UPDATE access_token = VALUES(access_token),' +
    ' expires_at = VALUES(expires_at), status = VALUES(status)',
    [platform, String(businessAccountId), accessToken, expiresAt, 'active']
  );
  return rows !== null;
}

// The owner opens this URL in a browser while logged into the panel is NOT
// required - the consent itself happens on facebook.com as the owner.
router.get('/auth/meta/start', (req, res) => {
  const cfg = appConfig();
  if (!cfg.id) return res.status(503).send('META_APP_ID not configured in .env');
  const url = 'https://www.facebook.com/v26.0/dialog/oauth' +
    '?client_id=' + encodeURIComponent(cfg.id) +
    '&redirect_uri=' + encodeURIComponent(cfg.redirect) +
    '&scope=' + encodeURIComponent(SCOPES) +
    '&response_type=code';
  res.redirect(url);
});

router.get('/auth/meta/callback', async (req, res) => {
  const cfg = appConfig();
  const fail = (msg) => res.status(500).send(
    '<h2>Meta connection failed</h2><p>' + msg + '</p><p><a href="/auth/meta/start">Try again</a></p>'
  );

  try {
    if (req.query.error) return fail('Facebook returned: ' + (req.query.error_description || req.query.error));
    if (!req.query.code) return fail('No authorization code received');
    if (!cfg.id || !cfg.secret) return fail('META_APP_ID / META_APP_SECRET not configured in .env');

    // 1. code -> short-lived user token
    let r = await fetch(GRAPH + '/oauth/access_token' +
      '?client_id=' + cfg.id +
      '&client_secret=' + cfg.secret +
      '&redirect_uri=' + encodeURIComponent(cfg.redirect) +
      '&code=' + encodeURIComponent(req.query.code));
    let j = await r.json();
    if (!j.access_token) return fail('Code exchange failed: ' + JSON.stringify(j.error || j).slice(0, 300));

    // 2. short-lived -> long-lived user token (~60 days)
    r = await fetch(GRAPH + '/oauth/access_token' +
      '?grant_type=fb_exchange_token' +
      '&client_id=' + cfg.id +
      '&client_secret=' + cfg.secret +
      '&fb_exchange_token=' + encodeURIComponent(j.access_token));
    j = await r.json();
    if (!j.access_token) return fail('Long-lived exchange failed: ' + JSON.stringify(j.error || j).slice(0, 300));
    const userToken = j.access_token;
    const expiresAt = j.expires_in
      ? new Date(Date.now() + j.expires_in * 1000)
      : new Date(Date.now() + 55 * 86400000);

    // 3. the Pages this user manages (with their Page tokens)
    r = await fetch(GRAPH + '/me/accounts?fields=id,name,access_token,instagram_business_account{id,username}' +
      '&access_token=' + encodeURIComponent(userToken));
    j = await r.json();
    const pages = (j.data || []);
    if (!pages.length) return fail('No Facebook Pages on this account - the login must be the profile that admins the Sams Pizza Page');

    // Prefer the page with a linked Instagram business account.
    const page = pages.find(p => p.instagram_business_account) || pages[0];
    const ig = page.instagram_business_account || null;

    const saved = [
      await saveAccount('meta_user', 'owner', userToken, expiresAt),
      await saveAccount('facebook_page', page.id, page.access_token, null), // Page tokens from long-lived user tokens do not expire
      ig ? await saveAccount('instagram', ig.id, page.access_token, null) : true
    ];
    if (saved.includes(false)) {
      return fail('Tokens were obtained but could NOT be stored (database write failed) - nothing was saved. Check /api/system and retry.');
    }

    res.send(
      '<h2 style="font-family:sans-serif">Meta connected</h2>' +
      '<ul style="font-family:sans-serif">' +
      '<li>Facebook Page: ' + page.name + ' (' + page.id + ')</li>' +
      '<li>Instagram: ' + (ig ? '@' + ig.username + ' (' + ig.id + ')' : 'NOT linked to this Page - link it in Instagram settings and reconnect') + '</li>' +
      '<li>User token valid until: ' + expiresAt.toISOString().slice(0, 10) + '</li>' +
      '</ul>' +
      '<p style="font-family:sans-serif">You can close this window. The publisher now holds the tokens.</p>'
    );
  } catch (err) {
    fail(err.message);
  }
});

// JWT-protected status for the panel (mounted under /api by index.js).
router.get('/meta/status', async (req, res) => {
  const rows = await db.query(
    "SELECT platform, business_account_id, expires_at, status, updated_at FROM accounts WHERE platform IN ('meta_user','facebook_page','instagram')"
  );
  if (rows === null) return res.status(503).json({ error: 'Database unavailable' });
  res.json({
    configured: Boolean(process.env.META_APP_ID && process.env.META_APP_SECRET),
    connected: rows.length > 0,
    accounts: rows
  });
});

module.exports = router;
