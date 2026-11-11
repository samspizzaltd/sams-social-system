const express = require('express');
const trendSounds = require('../services/trendSounds');
const recommendations = require('../services/recommendations');

// Content Studio: Trending Sounds (review what Instagram says is trending) and
// the owner's Recommendations. JWT-only (mounted after verifyToken).
const router = express.Router();

const STATUSES = ['new', 'approved', 'rejected', 'all'];

// GET /api/trend-sounds?status=new|approved|rejected|all
router.get('/trend-sounds', async (req, res) => {
  const status = String(req.query.status || 'new');
  if (!STATUSES.includes(status)) return res.status(400).json({ error: 'status must be new, approved, rejected or all' });
  const sounds = await trendSounds.list(status, req.query.watch === '1');
  if (sounds === null) return res.status(503).json({ error: 'Database unavailable' });
  res.json({ sounds, counts: await trendSounds.counts(), radar: trendSounds.status(), watch_terms: await trendSounds.watchTerms() });
});

// GET/PUT /api/trend-sounds/watch {terms: ['Fairuz', 'فيروز', ...]} - the
// watch list searched on every read (max 12 terms, 2-40 characters each).
router.get('/trend-sounds/watch', async (req, res) => {
  res.json({ terms: await trendSounds.watchTerms() });
});
router.put('/trend-sounds/watch', async (req, res) => {
  const r = await trendSounds.setWatchTerms(req.body && req.body.terms);
  if (r.error) return res.status(r.status).json({ error: r.error });
  res.json({ ok: true, terms: r.terms });
});

// POST /api/trend-sounds/check-now - read Instagram's trending lists now
// (10-minute cooldown; the radar also runs by itself every 6 hours).
router.post('/trend-sounds/check-now', (req, res) => {
  const r = trendSounds.requestRun();
  res.status(r.started ? 202 : r.running ? 409 : 429).json(r);
});

// POST /api/trend-sounds/:id/approve | reject | undo
for (const [action, status] of [['approve', 'approved'], ['reject', 'rejected'], ['undo', 'new']]) {
  router.post('/trend-sounds/:id/' + action, async (req, res) => {
    const r = await trendSounds.decide(req.params.id, status);
    if (r.error) return res.status(r.status).json({ error: r.error });
    res.json({ ok: true, status });
  });
}

// POST /api/trend-sounds/:id/preview - a fresh preview link (they expire).
router.post('/trend-sounds/:id/preview', async (req, res) => {
  const r = await trendSounds.refreshPreview(req.params.id);
  if (r.error) return res.status(r.status).json({ error: r.error });
  res.json({ preview_url: r.preview_url, preview_link: r.preview_link });
});

// GET /api/recommendations
router.get('/recommendations', async (req, res) => {
  const rows = await recommendations.list();
  if (rows === null) return res.status(503).json({ error: 'Database unavailable' });
  res.json({ recommendations: rows, areas: recommendations.AREAS });
});

// POST /api/recommendations {body, areas: ['sounds',...], active?}
router.post('/recommendations', async (req, res) => {
  const r = await recommendations.create(req.body || {});
  if (r.error) return res.status(r.status).json({ error: r.error });
  res.status(201).json({ ok: true, id: r.id });
});

// PUT /api/recommendations/:id {body?, areas?, active?}
router.put('/recommendations/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid id' });
  const r = await recommendations.update(id, req.body || {});
  if (r.error) return res.status(r.status).json({ error: r.error });
  res.json({ ok: true });
});

// DELETE /api/recommendations/:id
router.delete('/recommendations/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid id' });
  const r = await recommendations.remove(id);
  if (r.error) return res.status(r.status).json({ error: r.error });
  res.json({ ok: true });
});

module.exports = router;
