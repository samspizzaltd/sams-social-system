const ResearchEngine = require('./ResearchEngine');
const ContentVault = require('./ContentVault');
const { pool } = require('../database/pool');

class IntelligenceCoordinator {
  constructor() {
    this.name = 'Intelligence Coordinator';
    this.researchEngine = new ResearchEngine();
    this.contentVault = new ContentVault();
    this.schedule = {};
  }

  async initialize() {
    console.log('🧠 [INTELLIGENCE COORDINATOR] Initializing Phase 2 agents...');

    this.schedule.research = setInterval(() => this.runResearchCycle(), 24 * 60 * 60 * 1000);
    this.schedule.vault = setInterval(() => this.runVaultCycle(), 12 * 60 * 60 * 1000);

    console.log('✓ Research cycle: Every 24 hours');
    console.log('✓ Content vault: Every 12 hours');

    return { status: 'initialized', agents: ['ResearchEngine', 'ContentVault'] };
  }

  async runResearchCycle() {
    console.log('\n📊 [RESEARCH CYCLE] Starting...');

    try {
      const research = await this.researchEngine.analyzeMarket();

      const insights = {
        timestamp: new Date(),
        topTrends: research.trends.slice(0, 5),
        competitorGaps: research.competitors.gaps,
        opportunities: research.competitors.opportunities,
        recommendations: this.generateRecommendations(research),
      };

      await this.storeInsights(insights);
      console.log('✓ Research cycle complete');

      return insights;
    } catch (error) {
      console.error('[Research Cycle Error]', error.message);
    }
  }

  async runVaultCycle() {
    console.log('\n📚 [CONTENT VAULT CYCLE] Starting...');

    try {
      const vaultData = await this.contentVault.indexContent();

      console.log(`✓ Content indexed: ${vaultData.totalContent} total`);
      console.log(`✓ Media library: ${vaultData.mediaFiles.total} files`);
      console.log(`✓ Top performers identified: ${vaultData.topPerformers.length}`);

      return vaultData;
    } catch (error) {
      console.error('[Vault Cycle Error]', error.message);
    }
  }

  generateRecommendations(research) {
    return [
      {
        type: 'content_strategy',
        priority: 'high',
        recommendation: `Focus on ${research.trends[0]?.keyword || 'trending content'} - High relevance + Growth potential`,
        rationale: research.trends[0]?.relevance || 'High search volume'
      },
      {
        type: 'content_gap',
        priority: 'high',
        recommendation: research.competitors.opportunities[0],
        rationale: 'Competitors not covering this - Opportunity for differentiation',
      },
      {
        type: 'posting_strategy',
        priority: 'medium',
        recommendation: `Post during ${research.trends[0]?.bestTimes?.[0] || '20:00-22:00'} for max reach`,
        rationale: 'Peak engagement hours identified',
      },
    ];
  }

  async storeInsights(insights) {
    const query = `
      INSERT INTO trends (keyword, search_volume, competitor_count, relevance_score, data)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (keyword) DO UPDATE SET data = $5, updated_at = NOW()
    `;

    for (const trend of insights.topTrends) {
      await pool.query(query, [
        trend.keyword,
        trend.volume,
        0,
        'HIGH',
        JSON.stringify(insights),
      ]);
    }
  }

  async getIntelligence() {
    console.log('[Intelligence Coordinator] Compiling market intelligence...');

    return {
      trends: await this.getTrends(),
      topContent: await this.contentVault.components.performanceTracker.getTopPerformers(10),
      recommendations: await this.getRecommendations(),
      nextUpdate: new Date(Date.now() + 24 * 60 * 60 * 1000),
    };
  }

  async getTrends() {
    const query = `
      SELECT keyword, search_volume, relevance_score, updated_at
      FROM trends
      WHERE updated_at > NOW() - INTERVAL '7 days'
      ORDER BY search_volume DESC
      LIMIT 10
    `;

    const result = await pool.query(query);
    return result.rows;
  }

  async getRecommendations() {
    const query = `
      SELECT keyword, relevance_score, data
      FROM trends
      WHERE relevance_score = 'HIGH'
      ORDER BY search_volume DESC
      LIMIT 5
    `;

    const result = await pool.query(query);
    return result.rows.map(row => ({
      trend: row.keyword,
      confidence: row.relevance_score,
      details: row.data,
    }));
  }

  destroy() {
    console.log('[Intelligence Coordinator] Shutting down...');
    Object.values(this.schedule).forEach(interval => clearInterval(interval));
  }
}

module.exports = IntelligenceCoordinator;
