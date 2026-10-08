const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const db = require('../database/db');

const router = express.Router();

const MEDIA_DIR = path.join(__dirname, '..', '..', '..', 'media');
if (!fs.existsSync(MEDIA_DIR)) fs.mkdirSync(MEDIA_DIR, { recursive: true });

// multer is optional: if the module is missing, uploads 503 but the rest works.
let upload = null;
try {
  const multer = require('multer');
  const SAFE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.mp4', '.mov', '.webm']);
  const storage = multer.diskStorage({
    destination: MEDIA_DIR,
    filename: (req, file, cb) => {
      const ext = (path.extname(file.originalname) || '').toLowerCase();
      if (!SAFE_EXT.has(ext)) {
        return cb(new Error('File extension not allowed. Accepted: ' + [...SAFE_EXT].join(' ')));
      }
      cb(null, crypto.randomBytes(12).toString('hex') + ext);
    }
  });
  upload = multer({
    storage,
    limits: { fileSize: 60 * 1024 * 1024 }, // 60 MB
    fileFilter: (req, file, cb) => {
      const ok = /^(image|video)\//.test(file.mimetype);
      cb(ok ? null : new Error('Only image and video files are accepted'), ok);
    }
  });
} catch (err) {
  console.warn('[media] multer not installed - uploads disabled');
}

const KINDS = ['photo', 'video', 'rendered'];

function kindFromMime(mime) {
  return mime && mime.startsWith('video/') ? 'video' : 'photo';
}

// GET /api/media?kind=photo|video|rendered|all
router.get('/media', async (req, res) => {
  const kind = req.query.kind || 'all';
  let rows;
  if (kind === 'all' || !KINDS.includes(kind)) {
    rows = await db.query('SELECT * FROM media ORDER BY created_at DESC LIMIT 300');
  } else {
    rows = await db.query('SELECT * FROM media WHERE kind = ? ORDER BY created_at DESC LIMIT 300', [kind]);
  }
  if (rows === null) return res.status(503).json({ error: 'Database unavailable' });
  res.json({ media: rows });
});

const MEDIA_BUDGET_BYTES = (Number(process.env.MEDIA_BUDGET_MB) || 2048) * 1024 * 1024;

// POST /api/media/upload  (multipart form field: "file", optional "title"/"note")
router.post('/media/upload', async (req, res) => {
  if (!upload) return res.status(503).json({ error: 'Uploads unavailable: multer not installed on server' });
  const used = await db.query('SELECT COALESCE(SUM(size_bytes),0) AS used FROM media');
  if (used && Number(used[0].used) > MEDIA_BUDGET_BYTES) {
    return res.status(507).json({ error: 'Media storage budget exceeded - delete old files first (budget ' + Math.round(MEDIA_BUDGET_BYTES / 1048576) + ' MB)' });
  }
  upload.single('file')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'No file received (field name must be "file")' });

    const kind = req.body.kind && KINDS.includes(req.body.kind)
      ? req.body.kind
      : kindFromMime(req.file.mimetype);

    const rows = await db.query(
      'INSERT INTO media (kind, title, filename, url_path, size_bytes, note) VALUES (?,?,?,?,?,?)',
      [
        kind,
        req.body.title ? String(req.body.title).slice(0, 255) : req.file.originalname,
        req.file.filename,
        '/media/' + req.file.filename,
        req.file.size,
        req.body.note ? String(req.body.note).slice(0, 500) : null
      ]
    );
    if (rows === null) {
      // DB down - do not strand an orphan file.
      fs.unlink(path.join(MEDIA_DIR, req.file.filename), () => {});
      return res.status(503).json({ error: 'Database unavailable' });
    }
    res.status(201).json({ ok: true, id: rows.insertId, url_path: '/media/' + req.file.filename });
  });
});

// POST /api/media/path {local_path, title?, kind?, note?}
// Registers a file that lives on the owner's computer. The server cannot read
// it; the local render worker resolves these paths when it runs on that machine.
router.post('/media/path', async (req, res) => {
  const b = req.body || {};
  if (!b.local_path || String(b.local_path).trim().length < 3) {
    return res.status(400).json({ error: 'local_path is required (e.g. D:\\Photos\\shawarma.jpg)' });
  }
  const lp = String(b.local_path).trim().slice(0, 500);
  if (!/\.(jpe?g|png|webp|gif|mp4|mov|webm)$/i.test(lp)) {
    return res.status(400).json({ error: 'Path must point to a media file (jpg, png, webp, gif, mp4, mov, webm)' });
  }
  const guessedKind = /\.(mp4|mov|webm)$/i.test(lp) ? 'video' : 'photo';
  const kind = b.kind && KINDS.includes(b.kind) ? b.kind : guessedKind;

  const rows = await db.query(
    'INSERT INTO media (kind, title, local_path, note) VALUES (?,?,?,?)',
    [kind, b.title ? String(b.title).slice(0, 255) : path.basename(lp), lp, b.note ? String(b.note).slice(0, 500) : null]
  );
  if (rows === null) return res.status(503).json({ error: 'Database unavailable' });
  res.status(201).json({ ok: true, id: rows.insertId, local_path: lp });
});

// DELETE /api/media/:id - removes the record and, for uploads, the file.
router.delete('/media/:id', async (req, res) => {
  const rows = await db.query('SELECT filename FROM media WHERE id = ?', [req.params.id]);
  if (rows === null) return res.status(503).json({ error: 'Database unavailable' });
  if (!rows.length) return res.status(404).json({ error: 'Not found' });

  const del = await db.query('DELETE FROM media WHERE id = ?', [req.params.id]);
  if (del === null) return res.status(503).json({ error: 'Database unavailable' });
  if (rows[0].filename) {
    fs.unlink(path.join(MEDIA_DIR, rows[0].filename), () => {});
  }
  res.json({ ok: true });
});

// ---------- Render jobs ----------

const TEMPLATES = ['MenuCard', 'ScriptPromo', 'ReviewQuote'];

// POST /api/render-jobs {template, content_id?, media_ids?, params?}
router.post('/render-jobs', async (req, res) => {
  const b = req.body || {};
  if (!TEMPLATES.includes(b.template)) {
    return res.status(400).json({ error: 'template must be one of: ' + TEMPLATES.join(', ') });
  }
  const mediaIds = Array.isArray(b.media_ids)
    ? b.media_ids.map(Number).filter(Number.isInteger).slice(0, 20).join(',')
    : null;

  const serializedParams = b.params ? JSON.stringify(b.params) : null;
  if (serializedParams && serializedParams.length > 20000) {
    return res.status(400).json({ error: 'params too large (max 20000 characters serialized)' });
  }
  const rows = await db.query(
    'INSERT INTO render_jobs (content_id, template, params, media_ids, status) VALUES (?,?,?,?,?)',
    [
      b.content_id ? Number(b.content_id) : null,
      b.template,
      serializedParams,
      mediaIds,
      'queued'
    ]
  );
  if (rows === null) return res.status(503).json({ error: 'Database unavailable' });
  res.status(201).json({ ok: true, id: rows.insertId, status: 'queued' });
});

// GET /api/render-jobs?status=queued|rendering|done|failed|all
router.get('/render-jobs', async (req, res) => {
  const status = req.query.status || 'all';
  let rows;
  if (status === 'all') {
    rows = await db.query('SELECT * FROM render_jobs ORDER BY created_at DESC LIMIT 100');
  } else {
    rows = await db.query('SELECT * FROM render_jobs WHERE status = ? ORDER BY created_at ASC LIMIT 100', [status]);
  }
  if (rows === null) return res.status(503).json({ error: 'Database unavailable' });

  // Hydrate referenced media + content so the worker gets everything in one call.
  for (const job of rows) {
    if (job.media_ids) {
      const ids = job.media_ids.split(',').map(Number).filter(Number.isInteger);
      if (ids.length) {
        const placeholders = ids.map(() => '?').join(',');
        job.media = (await db.query('SELECT * FROM media WHERE id IN (' + placeholders + ')', ids)) || [];
      }
    }
    if (job.content_id) {
      const c = await db.query('SELECT id, title, caption, script FROM content WHERE id = ?', [job.content_id]);
      job.content = c && c.length ? c[0] : null;
    }
  }
  res.json({ jobs: rows });
});

// POST /api/render-jobs/:id/status {status: rendering|done|failed, error?, output_media_id?}
router.post('/render-jobs/:id/status', async (req, res) => {
  const b = req.body || {};
  if (!['rendering', 'done', 'failed', 'queued'].includes(b.status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }
  const rows = await db.query(
    'UPDATE render_jobs SET status = ?, error = ?, output_media_id = ? WHERE id = ?',
    [b.status, b.error ? String(b.error).slice(0, 2000) : null, b.output_media_id || null, req.params.id]
  );
  if (rows === null) return res.status(503).json({ error: 'Database unavailable' });
  if (!rows.affectedRows) return res.status(404).json({ error: 'Job not found' });
  res.json({ ok: true });
});

module.exports = { router, MEDIA_DIR };
