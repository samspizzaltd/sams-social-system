const express = require('express');
const harvest = require('../services/harvest');

// Harvest = pull the account's own top-performing videos into the media
// library and STAGE them for review. Publishing still requires the owner's
// per-post Approve in the panel. Mounted under /api (JWT) by index.js.

const router = express.Router();

// POST /api/harvest/top {min_views?=5000, limit?=12}
router.post('/harvest/top', (req, res) => {
  const b = req.body || {};
  const minViews = Math.max(0, Number(b.min_views) || 5000);
  const limit = Math.min(25, Math.max(1, Number(b.limit) || 12));
  const r = harvest.start(minViews, limit);
  if (!r.ok) return res.status(409).json({ error: r.error });
  res.status(202).json({ ok: true, note: 'Harvest running in the background - poll /api/harvest/status' });
});

// GET /api/harvest/status
router.get('/harvest/status', (req, res) => {
  res.json(harvest.status());
});

module.exports = router;
