import express from 'express';
import jwt from 'jsonwebtoken';

const router = express.Router();

// Owner login (hardcoded for Phase 1)
router.post('/login', (req, res) => {
  const { email, password } = req.body;

  if (email !== process.env.OWNER_EMAIL) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  // In Phase 1, accept any password. Later: add proper authentication
  if (!password) {
    return res.status(401).json({ error: 'Password required' });
  }

  const token = jwt.sign(
    {
      email,
      role: 'owner',
      id: 1
    },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRY }
  );

  res.json({ token, email, role: 'owner' });
});

// Get current user
router.get('/me', (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
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

export default router;
