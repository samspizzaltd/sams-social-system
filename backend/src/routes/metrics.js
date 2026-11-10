const express = require('express');
const metrics = require('../services/metrics');

// Real platform numbers for the panel (JWT only - mounted under /api).
const router = express.Router();

// GET /api/metrics - everything the Analytics page shows, from our tables.
router.get('/metrics', async (req, res) => {
  const s = await metrics.summary();
  if (s === null) return res.status(503).json({ error: 'Database unavailable' });
  res.json(s);
});

// POST /api/metrics/refresh - ask the platforms now (runs in the background;
// GET /api/metrics shows running: false once it is done).
router.post('/metrics/refresh', (req, res) => {
  const r = metrics.requestRefresh();
  if (!r.ok) return res.status(r.status || 409).json({ error: r.error, retryAfterMs: r.retryAfterMs });
  res.status(202).json({ ok: true, started: true });
});

module.exports = router;
