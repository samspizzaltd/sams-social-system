const express = require('express');
const mediaNamer = require('../services/mediaNamer');

// Analyze & name (Library). JWT-protected - mounted under /api by index.js.
// Nothing here publishes; it only names library items (services/mediaNamer.js).

const router = express.Router();

const send = (res, r) => (r.error ? res.status(r.status).json({ error: r.error }) : res.status(r.status).json(r.body));

// POST /api/media/describe-input - the video worker's report (frames, a photo
// or a spectrogram, measurements). Carries images, so it has its own larger
// body limit; the global JSON parser skips this path (index.js).
router.post('/media/describe-input', express.json({ limit: '8mb' }), async (req, res) => {
  send(res, await mediaNamer.saveInput(req.body || {}));
});

// POST /api/media/describe-all {scope?: 'unnamed' | 'all'} - name many at once.
// 'unnamed' (default) = never named or failed; names the owner typed are left alone.
router.post('/media/describe-all', async (req, res) => {
  const scope = req.body && req.body.scope === 'all' ? 'all' : 'unnamed';
  send(res, await mediaNamer.requestMany(scope));
});

// POST /api/media/:id/describe - analyse and name one item.
router.post('/media/:id/describe', async (req, res) => {
  send(res, await mediaNamer.request(req.params.id));
});

// PUT /api/media/:id/title {title} | {restore: true} - the owner's own name,
// or the name it had before.
router.put('/media/:id/title', async (req, res) => {
  send(res, await mediaNamer.setTitle(req.params.id, req.body || {}));
});

// GET /api/media-naming - automatic naming on/off + progress
router.get('/media-naming', async (req, res) => {
  try {
    res.json(await mediaNamer.status());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/media-naming {auto: true|false} - name new uploads automatically
router.put('/media-naming', async (req, res) => {
  const auto = req.body && req.body.auto;
  if (typeof auto !== 'boolean') return res.status(400).json({ error: 'auto must be true or false' });
  send(res, await mediaNamer.setAuto(auto));
});

module.exports = router;
