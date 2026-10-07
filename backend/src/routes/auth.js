const express = require('express');
const jwt = require('jsonwebtoken');

const router = express.Router();

// Simple in-memory login rate limiter: max 10 attempts per 15 minutes per IP.
const attempts = new Map();
const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 10;

function rateLimited(ip) {
  const now = Date.now();
  const entry = attempts.get(ip) || { count: 0, windowStart: now };
  if (now - entry.windowStart > WINDOW_MS) {
    entry.count = 0;
    entry.windowStart = now;
  }
  entry.count += 1;
  attempts.set(ip, entry);
  // Opportunistic cleanup so the map cannot grow unbounded.
  if (attempts.size > 1000) {
    for (const [k, v] of attempts) {
      if (now - v.windowStart > WINDOW_MS) attempts.delete(k);
    }
  }
  return entry.count > MAX_ATTEMPTS;
}

router.post('/login', (req, res) => {
  const ownerEmail = process.env.OWNER_EMAIL;
  const ownerPassword = process.env.OWNER_PASSWORD;
  const jwtSecret = process.env.JWT_SECRET;

  // Credentials and secret live in the environment, never in source.
  if (!ownerEmail || !ownerPassword || !jwtSecret) {
    return res.status(503).json({
      error: 'Login not configured: OWNER_EMAIL, OWNER_PASSWORD and JWT_SECRET must be set in the environment'
    });
  }

  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
  if (rateLimited(String(ip).split(',')[0].trim())) {
    return res.status(429).json({ error: 'Too many login attempts - try again in 15 minutes' });
  }

  const { email, password } = req.body || {};
  if (email !== ownerEmail || password !== ownerPassword) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  // A successful login clears the counter so normal use never locks the owner out.
  attempts.delete(String(ip).split(',')[0].trim());

  const token = jwt.sign(
    { email, role: 'owner', id: 1 },
    jwtSecret,
    { expiresIn: process.env.JWT_EXPIRY || '7d' }
  );

  res.json({ token, email, role: 'owner' });
});

router.get('/me', (req, res) => {
  const token = req.headers.authorization && req.headers.authorization.split(' ')[1];
  if (!token) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    res.json(decoded);
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
});

module.exports = router;
