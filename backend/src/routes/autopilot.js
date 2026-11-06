const express = require('express');
const db = require('../database/db');
const autopilot = require('../services/autopilot');
const scheduler = require('../services/scheduler');

// Master switch + autopilot status for the dashboard, and the owner's
// per-video controls. All JWT-protected (mounted under /api).

const router = express.Router();

// GET /api/autopilot - is the system on, and what is it doing
router.get('/autopilot', async (req, res) => {
  try {
    res.json(await autopilot.status(scheduler.status()));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/autopilot {enabled: true|false} - the master switch
router.put('/autopilot', async (req, res) => {
  const b = req.body || {};
  if (typeof b.enabled !== 'boolean') return res.status(400).json({ error: 'enabled must be true or false' });
  const ok = await autopilot.setOn(b.enabled);
  if (!ok) return res.status(503).json({ error: 'Database unavailable - the switch did not change' });
  res.json(await autopilot.status(scheduler.status()));
});

// GET /api/prep - preparation state of every library video
router.get('/prep', async (req, res) => {
  const rows = await autopilot.listPreps();
  if (rows === null) return res.status(503).json({ error: 'Database unavailable' });
  res.json({ preps: rows, hand_staged: await autopilot.handStaged() });
});

// POST /api/prep/analysis - the render worker reports what it measured.
// Frames arrive base64-encoded, so this route has its own larger body limit
// (the global JSON parser skips it - see index.js).
router.post('/prep/analysis', express.json({ limit: '5mb' }), async (req, res) => {
  const r = await autopilot.saveAnalysis(req.body || {});
  if (r.error) return res.status(r.status).json({ error: r.error });
  res.status(r.status).json(r.body);
});

// POST /api/prep/:mediaId/again {sound: 'own'|'rotate'|undefined}
router.post('/prep/:mediaId/again', async (req, res) => {
  const id = Number(req.params.mediaId);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid video id' });
  const sound = req.body && req.body.sound;
  if (sound !== undefined && sound !== 'own' && sound !== 'rotate') {
    return res.status(400).json({ error: 'sound must be "own" or "rotate"' });
  }
  const r = await autopilot.prepareAgain(id, sound);
  if (r.error) return res.status(r.status).json({ error: r.error });
  res.json(r.body);
});

// POST /api/prep/:mediaId/skip - never prepare or post this video
router.post('/prep/:mediaId/skip', async (req, res) => {
  const id = Number(req.params.mediaId);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid video id' });
  const r = await autopilot.skip(id);
  if (r.error) return res.status(r.status).json({ error: r.error });
  res.json(r.body);
});

// PUT /api/media/:id/circulate {on: true|false} - put a sound in or out of
// the circulation.
router.put('/media/:id/circulate', async (req, res) => {
  const on = req.body && req.body.on;
  if (typeof on !== 'boolean') return res.status(400).json({ error: 'on must be true or false' });
  const r = await db.query("UPDATE media SET circulate = ? WHERE id = ? AND kind = 'sound'", [on ? 1 : 0, req.params.id]);
  if (r === null) return res.status(503).json({ error: 'Database unavailable' });
  if (!r.affectedRows) return res.status(404).json({ error: 'Not a sound in the library' });
  res.json({ ok: true, circulate: on });
});

module.exports = router;
