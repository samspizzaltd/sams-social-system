import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { Pool } from 'pg';

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

// Database connection pool
export const db = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// Middleware
app.use(cors());
app.use(express.json());

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    service: 'sams-social-backend'
  });
});

// API routes (placeholder)
app.get('/api/status', (req, res) => {
  res.json({
    status: 'Sam\'s Social Media System - Phase 1 Foundation',
    version: '0.1.0',
    features: {
      database: 'initialized',
      dashboard: 'skeleton-ready',
      auth: 'preparing',
      oauth: 'pending-credentials'
    }
  });
});

// Error handling
app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({
    error: err.message,
    timestamp: new Date().toISOString()
  });
});

// Server startup
app.listen(port, () => {
  console.log(`
╔════════════════════════════════════════════════════════╗
║     Sam's Autonomous Social Media System               ║
║     Phase 1: Foundation - Backend API                  ║
║                                                        ║
║     Server running on: http://localhost:${port}           ║
║     Environment: ${process.env.NODE_ENV}                    ║
║     Database: Configured                               ║
╚════════════════════════════════════════════════════════╝
  `);
});

export default app;
