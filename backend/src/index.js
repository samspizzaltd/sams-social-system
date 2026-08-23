const express = require('express');
const cors = require('cors');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// System Orchestrator (all 7 phases)
let orchestrator = null;

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    service: 'sams-social-backend',
    orchestrator: orchestrator ? 'running' : 'initializing'
  });
});

// API routes
app.get('/api/status', async (req, res) => {
  try {
    const health = orchestrator ? await orchestrator.getSystemHealth() : { status: 'initializing' };
    res.json({
      status: health.status,
      agents: health.agents || [],
      timestamp: health.timestamp,
      version: '0.7.0',
      phases: {
        '1': 'Foundation (✓ Live)',
        '2': 'Intelligence (→ Running)',
        '3': 'Production (→ Running)',
        '4': 'Distribution (→ Running)',
        '5': 'Analytics (→ Running)',
        '6': 'Optimization (→ Running)',
        '7': 'Monetization (→ Running)'
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Agent execution endpoint
app.post('/api/agents/:agentName/:action', async (req, res) => {
  if (!orchestrator) {
    return res.status(503).json({ error: 'System not initialized' });
  }

  try {
    const { agentName, action } = req.params;
    const result = await orchestrator.executeAgentAction(agentName, action, req.body);
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// List all agents
app.get('/api/agents', async (req, res) => {
  if (!orchestrator) {
    return res.status(503).json({ error: 'System not initialized' });
  }

  res.json({
    agents: {
      intelligence: {
        phase: 2,
        status: 'running',
        components: ['ResearchEngine', 'ContentVault']
      },
      production: {
        phase: 3,
        status: 'running',
        components: ['ContentCreationEngine', 'ApprovalWorkflow']
      },
      publishing: {
        phase: 4,
        status: 'running',
        components: ['TikTok', 'Instagram', 'Facebook', 'YouTube']
      },
      analytics: {
        phase: 5,
        status: 'running',
        components: ['DataSync', 'PerformanceDashboard', 'EngagementAnalysis']
      },
      learning: {
        phase: 6,
        status: 'running',
        components: ['PatternDetector', 'ABTestFramework', 'StrategyOptimizer']
      },
      monetization: {
        phase: 7,
        status: 'running',
        components: ['EligibilityChecker', 'RevenueTracker', 'OpportunityAlert']
      }
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
const server = app.listen(port, () => {
  console.log(`Sam's Social System API running on port ${port}`);
  console.log(`Health check: http://localhost:${port}/health`);
});

// Handle errors
server.on('error', (err) => {
  console.error('Server error:', err);
  process.exit(1);
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
  process.exit(1);
});

process.on('unhandledRejection', (err) => {
  console.error('Unhandled Rejection:', err);
  process.exit(1);
});

module.exports = { app, server };
