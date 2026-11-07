const express = require('express');
const db = require('../database/db');
const tiktokPublish = require('../services/tiktokPublish');
const youtubePublish = require('../services/youtubePublish');
const autopilot = require('../services/autopilot');
const publicRoute = require('../services/publicRoute');

// The publish review queue: the ONLY path content takes to the real accounts.
// Staging is harmless; a row goes public only after the owner clicks Approve
// in the panel, having seen the exact video and caption (owner rule 2026-10-12).
// The actual publishing is completed asynchronously by the scheduler's
// finisher loop, because Instagram processing outlives the proxy timeout.

const router = express.Router();

const PLATFORMS = ['instagram', 'facebook_page', 'tiktok', 'youtube'];
const CAPTION_LIMIT = { instagram: 2200, facebook_page: 5000, tiktok: 2200, youtube: 5000 };
// Platforms whose finished upload publishes by itself (see scheduler.js).
const COMMIT_ON_UPLOAD = ['tiktok', 'youtube'];
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
    // Everything still in play first, then history - a long history must
    // never push a post that waits for the owner off the list.
    rows = await db.query(base + " ORDER BY (q.status IN ('pending_review','failed','unknown','in_drafts','approved_publishing','publishing')) DESC, q.created_at DESC LIMIT 300");
  } else {
    rows = await db.query(base + ' WHERE q.status = ? ORDER BY q.created_at ASC LIMIT 100', [status]);
  }
  if (rows === null) return res.status(503).json({ error: 'Database unavailable' });
  const routes = await publicRoute.routes();
  for (const q of rows) {
    // Why an approved post is not going out (see services/publicRoute.js)
    q.waiting_route = q.status === 'approved_publishing' && !q.creation_id ? publicRoute.reason(q.platform, routes) : null;
  }
  res.json({ queue: rows, routes });
});

// POST /api/publish-queue/:id/approve  - the owner's explicit go for THIS post.
// For TikTok rows the body must carry the posting options the owner picked in
// the approve sheet (TikTok UX requirement: explicit privacy level per post).
router.post('/publish-queue/:id/approve', async (req, res) => {
  const row = await db.query('SELECT platform, prep_media_id FROM publish_queue WHERE id = ?', [req.params.id]);
  if (row === null) return res.status(503).json({ error: 'Database unavailable' });
  if (!row.length) return res.status(404).json({ error: 'Not found' });

  // When: 'slot' = the next free posting slot for this platform (default for
  // autopilot rows, so a batch of approvals is spread out instead of firing at
  // once); 'now' = as soon as the publisher runs (default for hand-staged rows).
  const whenAsked = req.body && req.body.when;
  if (whenAsked !== undefined && whenAsked !== 'now' && whenAsked !== 'slot') {
    return res.status(400).json({ error: 'when must be "now" or "slot"' });
  }
  const when = whenAsked || (row[0].prep_media_id ? 'slot' : 'now');

  const routes = await publicRoute.routes();
  let postOptions = null;
  if (row[0].platform === 'tiktok' && routes.tiktok === 'drafts') {
    // Drafts route: the owner sets who can watch, comments etc. himself in the
    // TikTok app when he posts the draft - nothing to choose here.
    postOptions = JSON.stringify({ route: 'drafts' });
  } else if (row[0].platform === 'tiktok') {
    const b = req.body || {};
    if (!TIKTOK_PRIVACY.includes(b.privacy_level)) {
      return res.status(400).json({ error: 'Pick a privacy level for this TikTok post (who can watch it)' });
    }
    if (b.privacy_level !== 'SELF_ONLY' && !tiktokPublish.appAudited()) {
      return res.status(400).json({ error: 'Until TikTok approves the app review, TikTok only accepts "Only me (private)" posts - pick that for now' });
    }
    postOptions = JSON.stringify({
      privacy_level: b.privacy_level,
      disable_comment: !!b.disable_comment,
      disable_duet: !!b.disable_duet,
      disable_stitch: !!b.disable_stitch
    });
  }
  if (row[0].platform === 'youtube') {
    // YouTube needs a title (max 100, no < or >) and an explicit privacy
    // choice; the caption becomes the description.
    const b = req.body || {};
    const title = String(b.title || '').replace(/[<>]/g, '').replace(/\s+/g, ' ').trim();
    if (!title || title.length > 100) {
      return res.status(400).json({ error: 'Give the YouTube video a title (1-100 characters, no < or >)' });
    }
    if (!youtubePublish.PRIVACY.includes(b.privacy_status)) {
      return res.status(400).json({ error: 'Pick who can watch this YouTube video' });
    }
    if (b.privacy_status !== 'private' && !youtubePublish.appAudited()) {
      return res.status(400).json({ error: 'Until Google audits our YouTube API project, uploads can only be Private - pick that for now' });
    }
    postOptions = JSON.stringify({ title, privacy_status: b.privacy_status });
  }

  const scheduledAt = when === 'slot' ? await autopilot.nextFreeSlot(row[0].platform) : null;
  const rows = await db.query(
    "UPDATE publish_queue SET status = 'approved_publishing', error = NULL, attempts = 0, creation_id = NULL, post_options = ?, scheduled_at = ? WHERE id = ? AND status IN ('pending_review','failed')",
    [postOptions, scheduledAt, req.params.id]
  );
  if (rows === null) return res.status(503).json({ error: 'Database unavailable' });
  if (!rows.affectedRows) return res.status(409).json({ error: 'Not in an approvable state' });
  const on = await autopilot.isOn();
  const waits = publicRoute.reason(row[0].platform, routes);
  res.json({
    ok: true,
    status: 'approved_publishing',
    scheduled_at: scheduledAt,
    system_on: on,
    waiting_route: waits,
    note: waits
      ? 'Approved. ' + waits + '.'
      : row[0].platform === 'tiktok' && routes.tiktok === 'drafts'
        ? 'Approved. ' + (scheduledAt ? 'At its slot' : 'Right away') + ' the video arrives in your TikTok inbox (Inbox → System notifications) - tap it, paste the caption (Copy caption here) and post it.' +
          (on ? '' : ' The system is OFF, so it waits until you switch it ON.')
      : !on
        ? 'Approved. The system is switched OFF, so it waits - switch it ON on the Dashboard to let it publish.'
        : scheduledAt
          ? 'Approved for the next posting slot.'
          : 'Publishing runs in the background - watch this row for the permalink'
  });
});

// POST /api/publish-queue/:id/now - an approved row waiting for its slot goes
// out as soon as the publisher runs (still only while the system is ON).
router.post('/publish-queue/:id/now', async (req, res) => {
  const rows = await db.query(
    "UPDATE publish_queue SET scheduled_at = NULL WHERE id = ? AND status = 'approved_publishing' AND creation_id IS NULL",
    [req.params.id]
  );
  if (rows === null) return res.status(503).json({ error: 'Database unavailable' });
  if (!rows.affectedRows) return res.status(409).json({ error: 'This row is not waiting for a slot any more - reload' });
  res.json({ ok: true });
});

// PUT /api/publish-queue/:id/caption {caption} - edit before approving.
router.put('/publish-queue/:id/caption', async (req, res) => {
  const caption = String((req.body && req.body.caption) || '');
  if (!caption.trim()) return res.status(400).json({ error: 'caption required' });
  const info = await db.query('SELECT platform FROM publish_queue WHERE id = ?', [req.params.id]);
  if (info === null) return res.status(503).json({ error: 'Database unavailable' });
  if (!info.length) return res.status(404).json({ error: 'Not found' });
  if (caption.length > CAPTION_LIMIT[info[0].platform]) {
    return res.status(400).json({ error: 'Too long for this platform (max ' + CAPTION_LIMIT[info[0].platform] + ' characters)' });
  }
  const rows = await db.query(
    "UPDATE publish_queue SET caption = ? WHERE id = ? AND status IN ('pending_review','failed')",
    [caption, req.params.id]
  );
  if (rows === null) return res.status(503).json({ error: 'Database unavailable' });
  if (!rows.affectedRows) return res.status(409).json({ error: 'Only posts waiting for review can be edited' });
  res.json({ ok: true });
});

// POST /api/publish-queue/:id/posted - the owner posted this TikTok draft from
// the TikTok app (the system also notices by itself within ~10 minutes).
router.post('/publish-queue/:id/posted', async (req, res) => {
  const rows = await db.query(
    "UPDATE publish_queue SET status = 'published', error = NULL, published_at = NOW() WHERE id = ? AND status = 'in_drafts'",
    [req.params.id]
  );
  if (rows === null) return res.status(503).json({ error: 'Database unavailable' });
  if (!rows.affectedRows) return res.status(409).json({ error: 'This post is not waiting in your TikTok inbox - reload' });
  res.json({ ok: true, status: 'published' });
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
  if (r0.platform === 'tiktok' && r0.status === 'approved_publishing' && tiktokPublish.isDraftId(r0.creation_id)) {
    // A draft upload under way publishes nothing by itself - it can only
    // land in the owner's TikTok inbox, where he simply ignores it.
    const gone = await db.query(
      "UPDATE publish_queue SET status = 'dropped' WHERE id = ? AND status = 'approved_publishing'",
      [req.params.id]
    );
    if (gone === null) return res.status(503).json({ error: 'Database unavailable' });
    if (!gone.affectedRows) return res.status(409).json({ error: 'Row changed state - reload and look again' });
    return res.json({ ok: true, status: 'dropped', note: 'Dropped. The video may still show up in your TikTok inbox - ignore it; nothing is posted unless you post it.' });
  }
  if (COMMIT_ON_UPLOAD.includes(r0.platform) && r0.creation_id && r0.status === 'approved_publishing') {
    const parked = await db.query(
      "UPDATE publish_queue SET status = 'unknown', error = 'drop requested AFTER the upload was committed - the platform may still publish this video; CHECK THE ACCOUNT' WHERE id = ? AND status = 'approved_publishing'",
      [req.params.id]
    );
    if (parked === null) return res.status(503).json({ error: 'Database unavailable' });
    if (!parked.affectedRows) return res.status(409).json({ error: 'Row changed state - reload and look again' });
    return res.json({ ok: true, status: 'unknown', note: 'Too late to stop this one: the video was already uploaded and may still publish. Check the account.' });
  }
  const rows = await db.query(
    // in_drafts: the owner decided not to post the draft (it stays in his
    // TikTok inbox; nothing of it is public)
    "UPDATE publish_queue SET status = 'dropped' WHERE id = ? AND status IN ('pending_review','failed','approved_publishing','unknown','in_drafts')" +
      " AND NOT (status = 'approved_publishing' AND creation_id IS NOT NULL AND platform IN ('tiktok','youtube'))",
    [req.params.id]
  );
  if (rows === null) return res.status(503).json({ error: 'Database unavailable' });
  if (!rows.affectedRows) return res.status(409).json({ error: 'Not in a droppable state' });
  res.json({ ok: true, status: 'dropped' });
});

module.exports = router;
