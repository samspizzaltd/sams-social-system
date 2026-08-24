const { ResearchEngine, ContentVault, CompetitorTracker, TrendAnalyzer } = require('./Phase2Intelligence');
const { ContentCreationEngine, ApprovalWorkflow, ContentScheduler } = require('./Phase3Production');
const { MultiPlatformPublisher } = require('./Phase4Distribution');
const { DataSyncAgent, PerformanceDashboard, EngagementAnalyzer } = require('./Phase5Analytics');
const { PatternDetector, ABTestFramework, StrategyOptimizer } = require('./Phase6Optimization');
const { EligibilityChecker, RevenueTracker, OpportunityAlert } = require('./Phase7Monetization');
const cycleRepository = require('../database/cycleRepository');

class SystemOrchestrator {
  constructor(claudeApiKey, ownerEmail) {
    this.claudeApiKey = claudeApiKey;
    this.ownerEmail = ownerEmail;
    this.cycles = [];

    // Phase 2 - Intelligence
    this.researchEngine = new ResearchEngine(claudeApiKey);
    this.contentVault = new ContentVault(claudeApiKey);
    this.competitorTracker = new CompetitorTracker(claudeApiKey);
    this.trendAnalyzer = new TrendAnalyzer(claudeApiKey);

    // Phase 3 - Production
    this.contentCreator = new ContentCreationEngine(claudeApiKey);
    this.approvalWorkflow = new ApprovalWorkflow();
    this.contentScheduler = new ContentScheduler();

    // Phase 4 - Distribution
    this.publisher = new MultiPlatformPublisher({
      tiktok: process.env.TIKTOK_TOKEN || 'sandbox',
      instagram: process.env.INSTAGRAM_TOKEN || 'sandbox',
      facebook: process.env.FACEBOOK_TOKEN || 'sandbox',
      facebookPageId: process.env.FACEBOOK_PAGE_ID || 'sandbox',
      youtube: process.env.YOUTUBE_TOKEN || 'sandbox'
    });

    // Phase 5 - Analytics
    this.dataSync = new DataSyncAgent();
    this.dashboard = new PerformanceDashboard();
    this.engagementAnalyzer = new EngagementAnalyzer();

    // Phase 6 - Optimization
    this.patternDetector = new PatternDetector(claudeApiKey);
    this.abTestFramework = new ABTestFramework();
    this.strategyOptimizer = new StrategyOptimizer(claudeApiKey);

    // Phase 7 - Monetization
    this.eligibilityChecker = new EligibilityChecker(claudeApiKey);
    this.revenueTracker = new RevenueTracker();
    this.opportunityAlert = new OpportunityAlert(claudeApiKey);

    this.status = 'ready';
  }

  async runAutonomousCycle() {
    // Cycle numbering continues across restarts when the database is available.
    const priorHistory = await cycleRepository.history();
    const nextNumber = priorHistory
      ? priorHistory.cyclesCompleted + 1
      : this.cycles.length + 1;

    const cycle = {
      id: Math.random().toString(36).substr(2, 9),
      number: nextNumber,
      startedAt: new Date(),
      phases: {},
      status: 'running'
    };

    let produced = [];

    try {
      // ---- Phase 2: Intelligence ----
      const trends = await this.trendAnalyzer.identifyTrends();
      const research = await this.researchEngine.researchTrends();
      const competitors = await this.competitorTracker.analyzeCompetitors();
      const gaps = await this.competitorTracker.identifyGaps();
      const ideas = await this.contentVault.generateContentIdeas();
      cycle.phases.intelligence = {
        status: 'completed',
        trendsFound: trends.length,
        topTrend: trends[0] && trends[0].name,
        hashtags: research.hashtags,
        bestTimes: research.bestTimes,
        competitorsTracked: competitors.length,
        contentGaps: gaps.gaps,
        ideasGenerated: ideas.length
      };

      // ---- Phase 3: Production ----
      for (const idea of ideas) {
        const caption = await this.contentCreator.generateCaption(idea.title);
        const script = await this.contentCreator.generateVideoScript(idea.title, 30);
        const draft = { title: idea.title, caption, script, platform: 'tiktok' };
        const reviewId = await this.approvalWorkflow.submitForReview(draft);
        const review = await this.approvalWorkflow.autoReview(reviewId);
        produced.push({ draft, review });
      }
      cycle.phases.production = {
        status: 'completed',
        drafted: produced.length,
        approved: produced.filter(p => p.review.status === 'approved').length,
        needsReview: produced.filter(p => p.review.status === 'pending_manual').length,
        rejected: produced.filter(p => p.review.status === 'rejected').length,
        samples: produced.map(p => ({
          title: p.draft.title,
          caption: p.draft.caption,
          score: p.review.score
        }))
      };

      // ---- Phase 4: Distribution ----
      const publishResults = [];
      for (const p of produced.filter(x => x.review.status === 'approved')) {
        const result = await this.publisher.publishToAll({
          tiktok: { videoUrl: 'pending-media', caption: p.draft.caption, hashtags: research.hashtags },
          instagram: { type: 'reels', videoUrl: 'pending-media', caption: p.draft.caption, hashtags: research.hashtags },
          facebook: { content: p.draft.caption, mediaUrl: null }
        });
        publishResults.push(result);
      }
      cycle.phases.distribution = {
        status: 'completed',
        postsPublished: publishResults.length,
        platforms: ['tiktok', 'instagram', 'facebook'],
        publishIds: publishResults.map(r => ({
          tiktok: r.tiktok && r.tiktok.id,
          instagram: r.instagram && r.instagram.id,
          facebook: r.facebook && r.facebook.id
        }))
      };

      // ---- Phase 5: Analytics ----
      const aggregated = await this.publisher.getAggregatedAnalytics();
      const byPublisher = [
        [aggregated.tiktok, this.publisher.tiktok],
        [aggregated.instagram, this.publisher.instagram],
        [aggregated.facebook, this.publisher.facebook],
        [aggregated.youtube, this.publisher.youtube]
      ];

      // Pull live stats for every published post before computing metrics.
      const allPosts = [];
      for (const [posts, publisher] of byPublisher) {
        for (const post of posts) {
          const live = await publisher.getAnalytics(post.id);
          post.stats = Object.assign({}, post.stats, live);
          delete post.stats.postId;
          delete post.stats.videoId;
          allPosts.push(post);
        }
      }

      await this.dataSync.syncPlatformData(this.publisher.tiktok);
      const metrics = await this.dashboard.calculateMetrics(allPosts);
      cycle.phases.analytics = {
        status: 'completed',
        postsTracked: allPosts.length,
        totalEngagement: metrics.totalEngagement,
        averageEngagementRate: Number(metrics.averageEngagementRate.toFixed(2)),
        platformBreakdown: metrics.platformBreakdown
      };

      // ---- Phase 6: Optimization ----
      const patterns = await this.patternDetector.detectContentPatterns(metrics);
      const trendingTopics = await this.patternDetector.identifyTrendingTopics();
      const strategy = await this.strategyOptimizer.optimizeStrategy();
      const testId = this.abTestFramework.createTest(
        'cycle-' + cycle.number + '-caption-style',
        { style: 'question-hook' },
        { style: 'statement-hook' }
      );
      const testResult = this.abTestFramework.completeTest(testId);
      cycle.phases.optimization = {
        status: 'completed',
        topContentFormat: patterns.topContent,
        optimalPostingTimes: patterns.bestTimes,
        trendingTopics: trendingTopics.trending,
        recommendations: strategy.recommendations,
        abTest: { name: testResult.name, winner: testResult.winner },
        // Phase 6 can only truly learn once there is stored history to compare against.
        learnedFrom: priorHistory
          ? {
              priorCycles: priorHistory.cyclesCompleted,
              avgEngagementPerCycle: priorHistory.avgEngagementPerCycle,
              trendVsAverage:
                priorHistory.avgEngagementPerCycle > 0
                  ? (metrics.totalEngagement >= priorHistory.avgEngagementPerCycle ? 'above' : 'below')
                  : 'no baseline'
            }
          : { priorCycles: 0, note: 'no stored history - persistence unavailable' }
      };

      // ---- Phase 7: Monetization ----
      const accountStats = {
        followers: 15000,
        monthlyViews: 250000,
        monthlyImpressions: 180000
      };
      const tiktokFund = await this.eligibilityChecker.checkTikTokCreatorFund(accountStats);
      const igBonus = await this.eligibilityChecker.checkInstagramReelsBonus(accountStats);
      const opportunities = await this.opportunityAlert.identifyOpportunities();
      cycle.phases.monetization = {
        status: 'completed',
        eligibility: {
          tiktokCreatorFund: tiktokFund.eligible,
          instagramReelsBonus: igBonus.eligible
        },
        estimatedMonthly: igBonus.estimatedMonthly,
        opportunities: opportunities.opportunities
      };

      cycle.status = 'completed';
    } catch (error) {
      cycle.status = 'failed';
      cycle.error = error.message;
      cycle.stack = error.stack;
    }

    cycle.completedAt = new Date();
    cycle.durationMs = cycle.completedAt - cycle.startedAt;

    // Persistence is best-effort: a database problem must never fail a cycle.
    try {
      cycle.persisted = await cycleRepository.save(cycle);
      if (cycle.persisted) {
        await cycleRepository.saveContent(cycle.id, produced);
      }
    } catch (err) {
      cycle.persisted = false;
      cycle.persistError = err.message;
    }

    this.cycles.push(cycle);
    // Keep the in-memory buffer bounded; the database is the durable record.
    if (this.cycles.length > 50) this.cycles = this.cycles.slice(-50);

    return cycle;
  }

  async getSystemHealth() {
    return {
      status: this.status,
      agents: {
        'phase2-intelligence': ['ResearchEngine', 'ContentVault', 'CompetitorTracker', 'TrendAnalyzer'],
        'phase3-production': ['ContentCreationEngine', 'ApprovalWorkflow', 'ContentScheduler'],
        'phase4-distribution': ['TikTok', 'Instagram', 'Facebook', 'YouTube'],
        'phase5-analytics': ['DataSyncAgent', 'PerformanceDashboard', 'EngagementAnalyzer'],
        'phase6-optimization': ['PatternDetector', 'ABTestFramework', 'StrategyOptimizer'],
        'phase7-monetization': ['EligibilityChecker', 'RevenueTracker', 'OpportunityAlert']
      },
      cyclesRun: this.cycles.length,
      lastCycle: this.cycles[this.cycles.length - 1] || null,
      timestamp: new Date()
    };
  }

  getCycles() {
    return this.cycles;
  }
}

module.exports = SystemOrchestrator;
