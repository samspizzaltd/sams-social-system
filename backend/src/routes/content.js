import express from 'express';
import { verifyToken, requireOwner } from '../middleware/auth.js';

const router = express.Router();

// Get all content
router.get('/', verifyToken, (req, res) => {
  res.json({
    message: 'Content management API',
    status: 'Phase 1 - Skeleton ready',
    endpoints: {
      'GET /': 'List all content',
      'GET /:id': 'Get specific content',
      'POST /': 'Create content',
      'PUT /:id': 'Update content',
      'DELETE /:id': 'Delete content'
    }
  });
});

// Create content
router.post('/', verifyToken, requireOwner, (req, res) => {
  const { title, caption, platforms } = req.body;

  if (!title || !caption) {
    return res.status(400).json({ error: 'Title and caption required' });
  }

  res.status(201).json({
    id: Math.random().toString(36).substr(2, 9),
    title,
    caption,
    platforms,
    status: 'draft',
    created_at: new Date().toISOString(),
    requires_approval: true
  });
});

export default router;
