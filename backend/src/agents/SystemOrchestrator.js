const { ResearchEngine, ContentVault, CompetitorTracker, TrendAnalyzer } = require('./Phase2Intelligence');
const { ContentCreationEngine, ApprovalWorkflow, ContentScheduler } = require('./Phase3Production');
const cycleRepository = require('../database/cycleRepository');
const brandConfig = require('../services/brandConfig');
const metrics = require('../services/metrics');

// A cycle researches and writes drafts. It never posts (real posting is the
// Publish Queue, with the owner's approval) and it never invents numbers: until
// 2026-11-10 phases 4-7 ran on stub publishers, Math.random() analytics,
// hard-coded optimizer output and a made-up 15,000 followers. Phases 5-6 now
// read the REAL platform numbers collected by services/metrics.js.

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
      const gaps = await this.competitorTracker.identifyGaps();
      const ideas = await this.contentVault.generateContentIdeas();
      cycle.phases.intelligence = {
        status: 'completed',
        trendsFound: trends.length,
        topTrend: trends[0] && trends[0].name,
        hashtags: research.hashtags,
        bestTimes: research.bestTimes,
        contentGaps: gaps.gaps,
        ideasGenerated: ideas.length
      };

      // ---- Phase 3: Production ----
      // Auto-approve only when the owner set a numeric threshold in the panel;
      // anything else ('off', empty) sends every draft to the Approval Queue.
      const cfg = await brandConfig.get();
      const t = parseFloat(cfg.auto_approve_threshold);
      const threshold = Number.isFinite(t) ? t : null;
      for (const idea of ideas) {
        const caption = await this.contentCreator.generateCaption(idea.title);
        const script = await this.contentCreator.generateVideoScript(idea.title, 30);
        const draft = { title: idea.title, caption, script, platform: 'tiktok' };
        const reviewId = await this.approvalWorkflow.submitForReview(draft);
        const review = await this.approvalWorkflow.autoReview(reviewId, threshold);
        produced.push({ draft, review });
      }
      cycle.phases.production = {
        status: 'completed',
        drafted: produced.length,
        approved: produced.filter(p => p.review.status === 'approved').length,
        needsReview: produced.filter(p => p.review.status === 'needs_review').length,
        rejected: produced.filter(p => p.review.status === 'rejected').length,
        samples: produced.map(p => ({
          title: p.draft.title,
          caption: p.draft.caption,
          score: p.review.score
        }))
      };

      // ---- Phase 5: Analytics (real numbers, as of the last refresh) ----
      const real = await metrics.summary();
      cycle.phases.analytics = real ? {
        status: 'completed',
        source: 'Instagram + Facebook (numbers as of the last refresh)',
        asOf: real.lastRun ? real.lastRun.at : null,
        postsTracked: real.totals.tracked,
        views: real.totals.views,
        reach: real.totals.reach,
        interactions: real.totals.interactions,
        followers: {
          instagram: real.platforms.instagram.followers,
          facebook: real.platforms.facebook_page.followers
        }
      } : { status: 'skipped', note: 'database unavailable - no real numbers to read' };

      // ---- Phase 6: What worked (from real posts only) ----
      const withViews = real ? real.posts.filter(p => p.views !== null) : [];
      cycle.phases.optimization = withViews.length ? {
        status: 'completed',
        source: 'your real posts',
        topPosts: withViews.slice().sort((a, b) => b.views - a.views).slice(0, 3).map(p => ({
          platform: p.platform,
          views: p.views,
          interactions: p.interactions,
          caption: Array.from(p.caption || '').slice(0, 80).join('')
        })),
        slots: real.slots
      } : { status: 'skipped', note: 'no real post numbers yet' };

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
        'phase4-distribution': ['Publish Queue (your approval)', 'Posting slots', 'Instagram', 'Facebook', 'TikTok inbox', 'YouTube (held for the audit)'],
        'phase5-analytics': ['Metrics collector - real Instagram + Facebook numbers every 3 hours'],
        'phase6-optimization': ['What worked - top posts and posting slots from real numbers'],
        'phase7-monetization': ['Revenue ledger - income you record']
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
