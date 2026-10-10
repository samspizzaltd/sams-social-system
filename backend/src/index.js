const express = require('express');
const cors = require('cors');
require('dotenv').config();

const authRoutes = require('./routes/auth');
const controlRoutes = require('./routes/control');
const { verifyToken } = require('./middleware/auth');
const SystemOrchestrator = require('./agents/SystemOrchestrator');
const db = require('./database/db');
const cycleRepository = require('./database/cycleRepository');
const claude = require('./services/claudeClient');
const mediaRoutes = require('./routes/media');
const metaRoutes = require('./routes/meta');
const brandConfig = require('./services/brandConfig');

const app = express();
const port = process.env.PORT || 3000;

const ALLOWED_ORIGINS = (process.env.CORS_ORIGINS ||
  'https://sams-social-system.vercel.app,http://localhost:5173,http://localhost:4173'
).split(',').map(o => o.trim());
app.use(cors({ origin: ALLOWED_ORIGINS }));
app.use(express.json());
app.use('/auth', authRoutes);
// Uploaded media is public-read (it is destined for social media anyway);
// uploading/deleting requires a JWT via the /api routes below.
app.use('/', metaRoutes); // /auth/meta/start + /auth/meta/callback (public by design)
app.use('/media', express.static(mediaRoutes.MEDIA_DIR, {
  maxAge: '7d',
  setHeaders: (res) => res.setHeader('X-Content-Type-Options', 'nosniff')
}));
app.use('/api', verifyToken);
app.use('/api', controlRoutes);
app.use('/api', mediaRoutes.router);
app.use('/api', metaRoutes); // adds JWT-protected /api/meta/status

// Full system diagnostics (JWT-protected; public /health is deliberately slim)
app.get('/api/system', (req, res) => {
  const dbStatus = db.status();
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    service: 'sams-social-backend',
    orchestrator: orchestrator.status,
    cyclesRunThisProcess: orchestrator.getCycles().length,
    persistence: dbStatus.available ? 'mysql' : 'in-memory only',
    contentGeneration: claude.status().available ? 'claude' : 'fallback templates',
    database: dbStatus,
    claude: claude.status()
  });
});

const orchestrator = new SystemOrchestrator(
  process.env.CLAUDE_API_KEY,
  process.env.OWNER_EMAIL || 'issam.salih@gmail.com'
);

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString(), service: 'sams-social-backend' });
});

// Database diagnostics - lets us confirm persistence remotely without a shell.
app.get('/api/db/status', async (req, res) => {
  const status = db.status();
  const stored = await cycleRepository.history();
  res.json({ database: status, storedHistory: stored });
});

// Durable cycle history (survives restarts)
app.get('/api/history', async (req, res) => {
  const summary = await cycleRepository.history();
  const recent = await cycleRepository.recent(req.query.limit);
  if (summary === null && recent === null) {
    return res.status(503).json({
      error: 'Persistence unavailable',
      database: db.status()
    });
  }
  res.json({ summary, recent });
});

app.get('/api/status', async (req, res) => {
  try {
    res.json(await orchestrator.getSystemHealth());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/agents', async (req, res) => {
  try {
    const health = await orchestrator.getSystemHealth();
    res.json({ agents: health.agents });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Run one full 7-phase autonomous cycle
let cycleInProgress = false;
let cycleStartedAt = 0;
const CYCLE_WATCHDOG_MS = 15 * 60 * 1000; // a hung cycle must not block runs forever
app.post('/api/cycle/run', async (req, res) => {
  if (cycleInProgress && Date.now() - cycleStartedAt < CYCLE_WATCHDOG_MS) {
    return res.status(409).json({ error: 'A cycle is already running' });
  }
  cycleInProgress = true;
  cycleStartedAt = Date.now();
  try {
    const cycle = await orchestrator.runAutonomousCycle();
    res.status(cycle.status === 'completed' ? 200 : 500).json({
      success: cycle.status === 'completed',
      cycle
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  } finally {
    cycleInProgress = false;
  }
});

app.get('/api/cycle/in-progress', (req, res) => {
  const running = cycleInProgress && Date.now() - cycleStartedAt < CYCLE_WATCHDOG_MS;
  res.json({ running });
});

app.get('/api/cycles', (req, res) => {
  res.json({ count: orchestrator.getCycles().length, cycles: orchestrator.getCycles() });
});

app.get('/api/cycle/:cycleId', (req, res) => {
  const cycle = orchestrator.getCycles().find(c => c.id === req.params.cycleId);
  if (!cycle) return res.status(404).json({ error: 'Cycle not found' });
  res.json(cycle);
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.message, timestamp: new Date().toISOString() });
});

const server = app.listen(port, '0.0.0.0', () => {
  console.log("Sam's Social System API running on port " + port);
  console.log('All 7 phases ready: Intelligence -> Production -> Distribution -> Analytics -> Optimization -> Monetization');

  // Connect and migrate after the server is already accepting traffic, so a
  // database problem degrades persistence rather than taking the API down.
  db.init().catch(err => console.warn('[db] init failed: ' + err.message));
  claude.init();
});

server.on('error', (err) => {
  console.error('Server error:', err);
  process.exit(1);
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
  process.exit(1);
});

module.exports = { app, server, orchestrator };
