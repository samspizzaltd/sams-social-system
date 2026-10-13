const express = require('express');
const db = require('../database/db');

// The publish review queue: the ONLY path content takes to the real accounts.
// Staging is harmless; a row goes public only after the owner clicks Approve
// in the panel, having seen the exact video and caption (owner rule 2026-10-12).
// The actual publishing is completed asynchronously by the scheduler's
// finisher loop, because Instagram processing outlives the proxy timeout.

const router = express.Router();

const PLATFORMS = ['instagram', 'facebook_page', 'tiktok'];
const CAPTION_LIMIT = { instagram: 2200, facebook_page: 5000, tiktok: 2200 };
const TIKTOK_PRIVACY = ['PUBLIC_TO_EVERYONE', 'MUTUAL_FOLLOW_FRIENDS', 'FOLLOWER_OF_CREATOR', 'SELF_ONLY'];

// POST /api/publish-queue {platform, media_id, caption}
router.post('/publish-queue', async (req, res) => {
  const b = req.body || {};
  if (!PLATFORMS.includes(b.platform)) {
    return res.status(400).json({ error: 'platform must be one of: ' + PLATFORMS.join(', ') });
  }
  const mediaId = Number(b.media_id);
  if (!Number.isInteger(mediaId)) return res.status(400).json({ error: 'media_id required' });
  if (!b.caption || !String(b.caption).trim()) return res.status(400).json({ error: 'caption required' });
  const caption = String(b.caption);
  if (caption.length > CAPTION_LIMIT[b.platform]) {
    return res.status(400).json({ error: 'caption too long for ' + b.platform + ' (max ' + CAPTION_LIMIT[b.platform] + ' characters)' });
  }

  const media = await db.query('SELECT id, kind, url_path FROM media WHERE id = ?', [mediaId]);
  if (media === null) return res.status(503).json({ error: 'Database unavailable' });
  if (!media.length) return res.status(404).json({ error: 'Media not found' });
  if (!media[0].url_path) {
    return res.status(400).json({ error: 'This media lives only on the owner PC - it must be a server-hosted file (rendered output or upload) to publish' });
  }

  const rows = await db.query(
    'INSERT INTO publish_queue (platform, media_id, caption, status) VALUES (?,?,?,?)',
    [b.platform, mediaId, caption, 'pending_review']
  );
  if (rows === null) return res.status(503).json({ error: 'Database unavailable' });
  res.status(201).json({ ok: true, id: rows.insertId, status: 'pending_review' });
});

// GET /api/publish-queue?status=pending_review|all
router.get('/publish-queue', async (req, res) => {
  const status = req.query.status || 'all';
  let rows;
  const base =
    'SELECT q.*, m.url_path, m.title AS media_title FROM publish_queue q LEFT JOIN media m ON m.id = q.media_id';
  if (status === 'all') {
    rows = await db.query(base + ' ORDER BY q.created_at DESC LIMIT 100');
  } else {
    rows = await db.query(base + ' WHERE q.status = ? ORDER BY q.created_at ASC LIMIT 100', [status]);
  }
  if (rows === null) return res.status(503).json({ error: 'Database unavailable' });
  res.json({ queue: rows });
});

// POST /api/publish-queue/:id/approve  - the owner's explicit go for THIS post.
// For TikTok rows the body must carry the posting options the owner picked in
// the approve sheet (TikTok UX requirement: explicit privacy level per post).
router.post('/publish-queue/:id/approve', async (req, res) => {
  const row = await db.query('SELECT platform FROM publish_queue WHERE id = ?', [req.params.id]);
  if (row === null) return res.status(503).json({ error: 'Database unavailable' });
  if (!row.length) return res.status(404).json({ error: 'Not found' });

  let postOptions = null;
  if (row[0].platform === 'tiktok') {
    const b = req.body || {};
    if (!TIKTOK_PRIVACY.includes(b.privacy_level)) {
      return res.status(400).json({ error: 'Pick a privacy level for this TikTok post (who can watch it)' });
    }
    postOptions = JSON.stringify({
      privacy_level: b.privacy_level,
      disable_comment: !!b.disable_comment,
      disable_duet: !!b.disable_duet,
      disable_stitch: !!b.disable_stitch
    });
  }

  const rows = await db.query(
    "UPDATE publish_queue SET status = 'approved_publishing', error = NULL, attempts = 0, creation_id = NULL, post_options = ? WHERE id = ? AND status IN ('pending_review','failed')",
    [postOptions, req.params.id]
  );
  if (rows === null) return res.status(503).json({ error: 'Database unavailable' });
  if (!rows.affectedRows) return res.status(409).json({ error: 'Not in an approvable state' });
  res.json({ ok: true, status: 'approved_publishing', note: 'Publishing runs in the background - watch this row for the permalink' });
});

// POST /api/publish-queue/:id/drop
router.post('/publish-queue/:id/drop', async (req, res) => {
  // A TikTok row whose upload already went out CANNOT be stopped - TikTok
  // publishes it on its own. Pretending it was dropped would hide a post
  // that still appears on the account, so such rows park as 'unknown'.
  const info = await db.query('SELECT platform, status, creation_id FROM publish_queue WHERE id = ?', [req.params.id]);
  if (info === null) return res.status(503).json({ error: 'Database unavailable' });
  if (!info.length) return res.status(404).json({ error: 'Not found' });
  const r0 = info[0];
  if (r0.platform === 'tiktok' && r0.creation_id && r0.status === 'approved_publishing') {
    const parked = await db.query(
      "UPDATE publish_queue SET status = 'unknown', error = 'drop requested AFTER the upload was committed - TikTok may still publish this video; CHECK THE ACCOUNT' WHERE id = ? AND status = 'approved_publishing'",
      [req.params.id]
    );
    if (parked === null) return res.status(503).json({ error: 'Database unavailable' });
    if (!parked.affectedRows) return res.status(409).json({ error: 'Row changed state - reload and look again' });
    return res.json({ ok: true, status: 'unknown', note: 'Too late to stop this one: the video was already uploaded to TikTok and may still publish. Check the account.' });
  }
  const rows = await db.query(
    "UPDATE publish_queue SET status = 'dropped' WHERE id = ? AND status IN ('pending_review','failed','approved_publishing','unknown')",
    [req.params.id]
  );
  if (rows === null) return res.status(503).json({ error: 'Database unavailable' });
  if (!rows.affectedRows) return res.status(409).json({ error: 'Not in a droppable state' });
  res.json({ ok: true, status: 'dropped' });
});

module.exports = router;
