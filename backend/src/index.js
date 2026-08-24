const express = require('express');
const cors = require('cors');
require('dotenv').config();

const authRoutes = require('./routes/auth');
const SystemOrchestrator = require('./agents/SystemOrchestrator');

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use('/auth', authRoutes);

const orchestrator = new SystemOrchestrator(
  process.env.CLAUDE_API_KEY,
  process.env.OWNER_EMAIL || 'issam.salih@gmail.com'
);

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    service: 'sams-social-backend',
    orchestrator: orchestrator.status,
    cyclesRun: orchestrator.getCycles().length
  });
});

app.get('/api/status', async (req, res) => {
  try {
    res.json(await orchestrator.getSystemHealth());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/agents', async (req, res) => {
  const health = await orchestrator.getSystemHealth();
  res.json({ agents: health.agents });
});

// Run one full 7-phase autonomous cycle
app.post('/api/cycle/run', async (req, res) => {
  try {
    const cycle = await orchestrator.runAutonomousCycle();
    res.status(cycle.status === 'completed' ? 200 : 500).json({
      success: cycle.status === 'completed',
      cycle
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
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
