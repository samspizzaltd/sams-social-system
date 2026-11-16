const express = require('express');
const fs = require('fs');
const path = require('path');
const harvest = require('../services/harvest');
const media = require('./media');

// Harvest = pull the account's own top-performing videos into the media
// library and STAGE them for review. Publishing still requires the owner's
// per-post Approve in the panel. Mounted under /api (JWT) by index.js.

const router = express.Router();

// POST /api/harvest/top {min_views?=5000, limit?=12, dry_run?=false}
// dry_run: check only - scans and lists, downloads and stages nothing.
router.post('/harvest/top', (req, res) => {
  const b = req.body || {};
  const minViews = Math.max(0, Number(b.min_views) || 5000);
  const limit = Math.min(25, Math.max(1, Number(b.limit) || 12));
  const r = harvest.start(minViews, limit, b.dry_run === true);
  if (!r.ok) return res.status(409).json({ error: r.error });
  res.status(202).json({ ok: true, note: 'Harvest running in the background - poll /api/harvest/status' });
});

// GET /api/harvest/status
router.get('/harvest/status', (req, res) => {
  res.json(harvest.status());
});

// POST /api/harvest/upload (multipart: file, platform = tiktok|youtube, id) -
// the owner's saved copy of a TikTok / YouTube top video the harvest listed.
router.post('/harvest/upload', async (req, res) => {
  if (!media.upload) return res.status(503).json({ error: 'Uploads unavailable: multer not installed on server' });
  if (await media.budgetFull()) {
    return res.status(507).json({ error: 'Media storage budget exceeded - delete old files first (budget ' + Math.round(media.MEDIA_BUDGET_BYTES / 1048576) + ' MB)' });
  }
  media.upload.single('file')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'No file received (field name must be "file")' });
    let r;
    try {
      r = await harvest.stageUpload(req.file, req.body.platform, req.body.id);
    } catch (e) {
      r = { status: 500, error: e.message };
    }
    if (!r.ok) fs.unlink(path.join(media.MEDIA_DIR, req.file.filename), () => {});
    res.status(r.status).json(r);
  });
});

module.exports = router;
