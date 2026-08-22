const ContentCreationEngine = require('./ContentCreationEngine');
const ApprovalWorkflow = require('./ApprovalWorkflow');
const { pool } = require('../database/pool');

class ProductionCoordinator {
  constructor(claudeApiKey, ownerEmail) {
    this.name = 'Production Coordinator';
    this.contentCreation = new ContentCreationEngine(claudeApiKey);
    this.approval = new ApprovalWorkflow(ownerEmail);
    this.schedule = {};
  }

  async initialize() {
    console.log('🎬 [PRODUCTION COORDINATOR] Initializing Phase 3 agents...');

    await this.approval.initializeMailer();

    // Weekly content generation cycle
    this.schedule.production = setInterval(
      () => this.runProductionCycle(),
      7 * 24 * 60 * 60 * 1000
    );

    console.log('✓ Production cycle: Every 7 days');
    console.log('✓ Content creation: Claude API (Opus 5)');
    console.log('✓ Approval: Email notifications to owner');

    return { status: 'initialized', agents: ['ContentCreationEngine', 'ApprovalWorkflow'] };
  }

  async runProductionCycle() {
    console.log('\n🎨 [PRODUCTION CYCLE] Starting weekly content generation...');

    try {
      // Daily posting: 3 TikTok + 2 Instagram
      const strategies = [
        {
          platform: 'tiktok',
          topic: 'Food Close-up',
          duration: 15,
          count: 3,
          hashtags: ['#FoodASMR', '#FastFood', '#Tbilisi'],
          tone: 'engaging',
        },
        {
          platform: 'instagram',
          topic: 'Behind-the-scenes',
          duration: 30,
          count: 2,
          hashtags: ['#RestaurantLife', '#FoodPrep'],
          tone: 'casual',
        },
      ];

      for (const strategy of strategies) {
        console.log(`\n→ Generating ${strategy.count} ${strategy.platform} posts...`);
        const batch = await this.contentCreation.generateContent(strategy);

        for (const content of batch.content) {
          await this.approval.submitForApproval(content.id);
        }
      }

      console.log('✓ Production cycle complete');
      return { status: 'complete', contentGenerated: strategies.length };
    } catch (error) {
      console.error('[Production Cycle Error]', error.message);
    }
  }

  async getProductionStatus() {
    console.log('[Production Coordinator] Fetching production status...');

    const pendingQuery = `SELECT COUNT(*) as count FROM content WHERE status = 'draft'`;
    const approvedQuery = `SELECT COUNT(*) as count FROM content WHERE status = 'approved'`;
    const publishedQuery = `SELECT COUNT(*) as count FROM content WHERE status = 'published'`;

    const [pending, approved, published] = await Promise.all([
      pool.query(pendingQuery),
      pool.query(approvedQuery),
      pool.query(publishedQuery),
    ]);

    return {
      draft: parseInt(pending.rows[0].count, 10),
      awaitingApproval: (await this.approval.getPendingApprovals()).count,
      approved: parseInt(approved.rows[0].count, 10),
      published: parseInt(published.rows[0].count, 10),
      nextProductionCycle: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    };
  }

  async approveAndPrepareForPublish(contentId, ownerEmail) {
    console.log(`[Production Coordinator] Processing approval for ${contentId}...`);

    const approved = await this.approval.approveContent(contentId, ownerEmail);

    // Tag for publishing
    const query = `
      UPDATE content
      SET status = 'ready_to_publish'
      WHERE id = $1
      RETURNING *
    `;

    await pool.query(query, [contentId]);
    console.log(`✓ Content ready for distribution: ${contentId}`);

    return approved;
  }

  async rejectContent(contentId, reason, ownerEmail) {
    console.log(`[Production Coordinator] Processing rejection for ${contentId}...`);
    return this.approval.rejectContent(contentId, reason, ownerEmail);
  }

  destroy() {
    console.log('[Production Coordinator] Shutting down...');
    Object.values(this.schedule).forEach(interval => clearInterval(interval));
  }
}

module.exports = ProductionCoordinator;
