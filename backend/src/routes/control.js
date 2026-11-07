const express = require('express');
const db = require('../database/db');
const cycleRepository = require('../database/cycleRepository');

const router = express.Router();

// ---------- Content moderation ----------

// GET /api/content?status=pending|approved|rejected|all
router.get('/content', async (req, res) => {
  const status = req.query.status || 'all';
  const map = {
    pending: ['needs_review', 'pending_review', 'pending_manual', 'draft'],
    approved: ['approved', 'auto_approved'],
    rejected: ['rejected']
  };

  let rows;
  if (status === 'all' || !map[status]) {
    rows = await db.query(
      'SELECT id, cycle_id, title, caption, quality_score, status, created_at, approved_at FROM content ORDER BY created_at DESC LIMIT 200'
    );
  } else {
    const placeholders = map[status].map(() => '?').join(',');
    rows = await db.query(
      'SELECT id, cycle_id, title, caption, quality_score, status, created_at, approved_at FROM content WHERE status IN (' + placeholders + ') ORDER BY created_at DESC LIMIT 200',
      map[status]
    );
  }

  if (rows === null) return res.status(503).json({ error: 'Database unavailable' });
  res.json({ content: rows });
});

// GET /api/content/:id - full record including script, plus every video
// rendered from it, so the owner can review the real thing before approving.
router.get('/content/:id', async (req, res) => {
  const rows = await db.query('SELECT * FROM content WHERE id = ?', [req.params.id]);
  if (rows === null) return res.status(503).json({ error: 'Database unavailable' });
  if (!rows.length) return res.status(404).json({ error: 'Not found' });
  const renders = await db.query(
    'SELECT r.id, r.template, r.status, r.error, r.created_at, m.id AS media_id, m.url_path' +
    ' FROM render_jobs r LEFT JOIN media m ON m.id = r.output_media_id' +
    ' WHERE r.content_id = ? ORDER BY r.created_at DESC LIMIT 10',
    [req.params.id]
  );
  res.json({ ...rows[0], renders: renders || [] });
});

// POST /api/content/:id/status {status: "approved"|"rejected"}
router.post('/content/:id/status', async (req, res) => {
  const next = req.body && req.body.status;
  if (next !== 'approved' && next !== 'rejected') {
    return res.status(400).json({ error: 'status must be "approved" or "rejected"' });
  }
  const rows = await db.query(
    'UPDATE content SET status = ?, approved_at = ? WHERE id = ?',
    [next, next === 'approved' ? new Date() : null, req.params.id]
  );
  if (rows === null) return res.status(503).json({ error: 'Database unavailable' });
  if (!rows.affectedRows) return res.status(404).json({ error: 'Content not found' });
  res.json({ ok: true, id: Number(req.params.id), status: next });
});

// ---------- Revenue (financial gains) ----------

// GET /api/revenue - ledger + summary
router.get('/revenue', async (req, res) => {
  const entries = await db.query(
    'SELECT id, platform, source, amount, currency, note, recorded_at FROM revenue ORDER BY recorded_at DESC LIMIT 500'
  );
  if (entries === null) return res.status(503).json({ error: 'Database unavailable' });

  const summary = { total: 0, byPlatform: {}, bySource: {}, byMonth: {} };
  for (const e of entries) {
    const amount = Number(e.amount) || 0;
    summary.total += amount;
    summary.byPlatform[e.platform] = (summary.byPlatform[e.platform] || 0) + amount;
    summary.bySource[e.source] = (summary.bySource[e.source] || 0) + amount;
    const month = String(e.recorded_at).slice(0, 7);
    summary.byMonth[month] = (summary.byMonth[month] || 0) + amount;
  }
  summary.total = Math.round(summary.total * 100) / 100;

  res.json({ entries, summary });
});

// POST /api/revenue {platform, source, amount, currency?, note?}
router.post('/revenue', async (req, res) => {
  const b = req.body || {};
  const amount = Number(b.amount);
  if (!b.platform || !b.source || !isFinite(amount) || amount === 0) {
    return res.status(400).json({ error: 'platform, source and a non-zero numeric amount are required' });
  }
  const rows = await db.query(
    'INSERT INTO revenue (platform, source, amount, currency, note) VALUES (?,?,?,?,?)',
    [String(b.platform).slice(0, 50), String(b.source).slice(0, 50), amount, String(b.currency || 'GEL').slice(0, 10), b.note ? String(b.note).slice(0, 500) : null]
  );
  if (rows === null) return res.status(503).json({ error: 'Database unavailable' });
  res.status(201).json({ ok: true, id: rows.insertId });
});

// DELETE /api/revenue/:id - remove a mistaken entry
router.delete('/revenue/:id', async (req, res) => {
  const rows = await db.query('DELETE FROM revenue WHERE id = ?', [req.params.id]);
  if (rows === null) return res.status(503).json({ error: 'Database unavailable' });
  res.json({ ok: true, deleted: rows.affectedRows });
});

// ---------- Settings (branding key-value store) ----------

const SETTING_KEYS = [
  'brand_voice', 'posting_cadence', 'auto_approve_threshold',
  'audience_location', 'audience_age', 'audience_gender', 'audience_notes',
  'style_notes', 'music_notes',
  'auto_cycle_enabled', 'auto_cycle_times', 'auto_cycle_days',
  'platform_tiktok_enabled', 'platform_instagram_enabled',
  'platform_facebook_enabled', 'platform_youtube_enabled',
  'publish_slots', 'sound_mode', 'autoprep_buffer', 'tiktok_route'
];
// Settings with a fixed set of values.
const SETTING_CHOICES = { tiktok_route: ['wait', 'drafts'] };
const brandConfig = require('../services/brandConfig');

router.get('/settings', async (req, res) => {
  const rows = await db.query('SELECT cfg_key, cfg_value, updated_at FROM branding');
  if (rows === null) return res.status(503).json({ error: 'Database unavailable' });
  const settings = {};
  for (const r of rows) settings[r.cfg_key] = r.cfg_value;
  res.json({ settings, knownKeys: SETTING_KEYS });
});

router.put('/settings', async (req, res) => {
  const b = req.body || {};
  if (!b.key || typeof b.value === 'undefined') {
    return res.status(400).json({ error: 'key and value are required' });
  }
  if (!SETTING_KEYS.includes(b.key)) {
    return res.status(400).json({ error: 'Unknown setting key', knownKeys: SETTING_KEYS });
  }
  if (SETTING_CHOICES[b.key] && !SETTING_CHOICES[b.key].includes(String(b.value))) {
    return res.status(400).json({ error: b.key + ' must be one of: ' + SETTING_CHOICES[b.key].join(', ') });
  }
  const rows = await db.query(
    'INSERT INTO branding (cfg_key, cfg_value) VALUES (?,?) ON DUPLICATE KEY UPDATE cfg_value = VALUES(cfg_value)',
    [String(b.key).slice(0, 191), String(b.value).slice(0, 2000)]
  );
  if (rows === null) return res.status(503).json({ error: 'Database unavailable' });
  brandConfig.invalidate();
  res.json({ ok: true, key: b.key });
});

// ---------- Overview (one-shot dashboard payload) ----------

router.get('/overview', async (req, res) => {
  const history = await cycleRepository.history();
  const recent = await cycleRepository.recent(5);
  const revenueRows = await db.query('SELECT COALESCE(SUM(amount),0) AS total FROM revenue');
  const pendingRows = await db.query(
    "SELECT COUNT(*) AS n FROM content WHERE status IN ('needs_review','pending_review','draft')"
  );

  res.json({
    history: history || null,
    recentCycles: recent || [],
    revenueTotal: revenueRows && revenueRows.length ? Number(revenueRows[0].total) : null,
    pendingContent: pendingRows && pendingRows.length ? Number(pendingRows[0].n) : null,
    database: db.status()
  });
});

// GET /api/cycle/:id - durable cycle detail (survives restarts; shadows the in-memory route)
router.get('/cycle/:id', async (req, res, next) => {
  if (req.params.id === 'run' || req.params.id === 'in-progress') return next();
  // When persistence is down, fall through to the in-memory route in index.js.
  if (!db.status().available) return next();
  const row = await cycleRepository.byId(req.params.id);
  if (!row) return next();
  res.json(row);
});

module.exports = router;
