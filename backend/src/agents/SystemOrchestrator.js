const IntelligenceCoordinator = require('./IntelligenceCoordinator');
const ProductionCoordinator = require('./ProductionCoordinator');
const PublishingEngine = require('./PublishingEngine');
const AnalyticsEngine = require('./AnalyticsEngine');
const LearningLoopEngine = require('./LearningLoopEngine');
const MonetizationMonitor = require('./MonetizationMonitor');

class SystemOrchestrator {
  constructor(claudeApiKey, ownerEmail) {
    this.name = 'System Orchestrator';
    this.claudeApiKey = claudeApiKey;
    this.ownerEmail = ownerEmail;
    this.agents = {};
    this.status = 'idle';
  }

  async initialize() {
    console.log('\n═══════════════════════════════════════════════════════');
    console.log('🚀 SAM\'S AUTONOMOUS SOCIAL MEDIA SYSTEM');
    console.log('═══════════════════════════════════════════════════════\n');

    console.log('📋 PHASE 1: FOUNDATION');
    console.log('✓ Database: PostgreSQL (9 tables)');
    console.log('✓ Authentication: JWT-based owner login');
    console.log('✓ Admin Dashboard: React UI\n');

    // Phase 2: Intelligence
    console.log('📋 PHASE 2: INTELLIGENCE');
    this.agents.intelligence = new IntelligenceCoordinator();
    await this.agents.intelligence.initialize();

    // Phase 3: Production
    console.log('\n📋 PHASE 3: PRODUCTION');
    this.agents.production = new ProductionCoordinator(this.claudeApiKey, this.ownerEmail);
    await this.agents.production.initialize();

    // Phase 4: Distribution
    console.log('\n📋 PHASE 4: DISTRIBUTION');
    this.agents.publishing = new PublishingEngine();
    await this.agents.publishing.initialize();

    // Phase 5: Analytics
    console.log('\n📋 PHASE 5: ANALYTICS');
    this.agents.analytics = new AnalyticsEngine();
    await this.agents.analytics.initialize();

    // Phase 6: Optimization
    console.log('\n📋 PHASE 6: OPTIMIZATION');
    this.agents.learning = new LearningLoopEngine();
    await this.agents.learning.initialize();

    // Phase 7: Monetization
    console.log('\n📋 PHASE 7: MONETIZATION');
    this.agents.monetization = new MonetizationMonitor();
    await this.agents.monetization.initialize();

    this.status = 'running';

    console.log('\n═══════════════════════════════════════════════════════');
    console.log('✨ SYSTEM ONLINE - All agents initialized and running');
    console.log('═══════════════════════════════════════════════════════\n');

    this.displaySystemStatus();

    return {
      status: 'initialized',
      agents: Object.keys(this.agents),
      timestamp: new Date(),
    };
  }

  displaySystemStatus() {
    console.log('📊 SYSTEM STATUS\n');
    console.log('Agent Timeline:');
    console.log('  ├─ Phase 1: Foundation (✓ Live)');
    console.log('  ├─ Phase 2: Intelligence - Research + Content Vault (→ Monitoring)');
    console.log('  ├─ Phase 3: Production - Content Creation + Approval (→ Weekly)');
    console.log('  ├─ Phase 4: Distribution - Multi-platform Publishing (→ On-demand)');
    console.log('  ├─ Phase 5: Analytics - Performance Tracking (→ Daily sync)');
    console.log('  ├─ Phase 6: Optimization - Learning Loop (→ Every 3 days)');
    console.log('  └─ Phase 7: Monetization - Revenue Tracking (→ Weekly review)\n');

    console.log('Data Pipeline:');
    console.log('  Research → Content Creation → Owner Approval → Publishing');
    console.log('                                                      ↓');
    console.log('  Learning Loop ← Analytics ← Platforms ← Published Content\n');

    console.log('Success Metrics:');
    console.log('  • 50K followers by Dec 2026');
    console.log('  • 500K followers by Dec 2027');
    console.log('  • 5-8% engagement rate');
    console.log('  • Creator Fund eligibility by Q2 2027\n');
  }

  async getSystemHealth() {
    return {
      status: this.status,
      agents: Object.keys(this.agents),
      timestamp: new Date(),
      uptime: 'Running',
    };
  }

  async executeAgentAction(agentName, action, params) {
    const agent = this.agents[agentName];

    if (!agent) {
      throw new Error(`Agent not found: ${agentName}`);
    }

    console.log(`\n→ Executing: ${agentName}.${action}()`);

    switch (agentName) {
      case 'intelligence':
        if (action === 'analyze') return await agent.runResearchCycle();
        if (action === 'getIntelligence') return await agent.getIntelligence();
        break;

      case 'production':
        if (action === 'generate') return await agent.runProductionCycle();
        if (action === 'approve') return await agent.approveAndPrepareForPublish(params.id, this.ownerEmail);
        if (action === 'reject') return await agent.rejectContent(params.id, params.reason, this.ownerEmail);
        if (action === 'status') return await agent.getProductionStatus();
        break;

      case 'publishing':
        if (action === 'publish') return await agent.publishContent(params.id);
        if (action === 'schedule') return await agent.scheduleContent(params.id, params.time);
        break;

      case 'analytics':
        if (action === 'sync') return await agent.runDailySync();
        if (action === 'summary') return await agent.getPerformanceSummary();
        if (action === 'report') return await agent.weeklyReport(this.ownerEmail);
        break;

      case 'learning':
        if (action === 'optimize') return await agent.runOptimizationCycle();
        if (action === 'status') return await agent.getOptimizationStatus();
        break;

      case 'monetization':
        if (action === 'review') return await agent.runMonetizationReview();
        if (action === 'status') return await agent.getMonetizationStatus();
        break;

      default:
        throw new Error(`Unknown action: ${action}`);
    }
  }

  async shutdown() {
    console.log('\n🔴 [SYSTEM ORCHESTRATOR] Initiating shutdown...\n');

    this.agents.intelligence.destroy();
    this.agents.production.destroy();

    this.status = 'offline';
    console.log('✓ All agents shut down');
  }
}

module.exports = SystemOrchestrator;
