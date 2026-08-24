const Anthropic = require('@anthropic-ai/sdk');

class EligibilityChecker {
  constructor(apiKey) {
    this.client = new Anthropic({ apiKey });
    this.checks = [];
  }

  async checkTikTokCreatorFund(accountStats) {
    const check = {
      platform: 'tiktok',
      program: 'Creator Fund',
      timestamp: new Date(),
      requirements: {
        followers: { required: 10000, current: accountStats.followers, met: accountStats.followers >= 10000 },
        videoViews: { required: 100000, current: accountStats.monthlyViews, met: accountStats.monthlyViews >= 100000 },
        age: { required: 18, current: accountStats.creatorAge, met: accountStats.creatorAge >= 18 },
        compliance: { required: true, current: accountStats.communityCompliant, met: accountStats.communityCompliant }
      },
      eligible: null
    };

    check.eligible = Object.values(check.requirements).every(r => r.met);
    this.checks.push(check);
    return check;
  }

  async checkInstagramReelsBonus(accountStats) {
    const check = {
      platform: 'instagram',
      program: 'Reels Bonus Program',
      timestamp: new Date(),
      requirements: {
        followers: { required: 10000, current: accountStats.followers, met: accountStats.followers >= 10000 },
        monthlyImpressions: { required: 100000, current: accountStats.monthlyImpressions, met: accountStats.monthlyImpressions >= 100000 },
        reelsPerMonth: { required: 4, current: accountStats.reelsPerMonth, met: accountStats.reelsPerMonth >= 4 }
      },
      eligible: null,
      estimatedMonthlyEarnings: 0
    };

    check.eligible = Object.values(check.requirements).every(r => r.met);
    if (check.eligible) {
      check.estimatedMonthlyEarnings = accountStats.monthlyImpressions * 0.00002; // Rough estimate
    }
    this.checks.push(check);
    return check;
  }

  async checkYouTubePartner(accountStats) {
    const check = {
      platform: 'youtube',
      program: 'YouTube Partner Program',
      timestamp: new Date(),
      requirements: {
        subscribers: { required: 1000, current: accountStats.subscribers, met: accountStats.subscribers >= 1000 },
        watchTime: { required: 4000, current: accountStats.totalWatchHours, met: accountStats.totalWatchHours >= 4000 },
        compliance: { required: true, current: accountStats.monetizationCompliant, met: accountStats.monetizationCompliant }
      },
      eligible: null,
      estimatedMonthlyEarnings: 0
    };

    check.eligible = Object.values(check.requirements).every(r => r.met);
    if (check.eligible) {
      check.estimatedMonthlyEarnings = accountStats.monthlyViews * 0.00080; // CPM estimate
    }
    this.checks.push(check);
    return check;
  }

  async checkFacebookInStream(accountStats) {
    const check = {
      platform: 'facebook',
      program: 'In-Stream Ads',
      timestamp: new Date(),
      requirements: {
        followers: { required: 10000, current: accountStats.followers, met: accountStats.followers >= 10000 },
        watchTime: { required: 600000, current: accountStats.videoWatchMinutes, met: accountStats.videoWatchMinutes >= 600000 },
        monthlyViews: { required: 600000, current: accountStats.monthlyViews, met: accountStats.monthlyViews >= 600000 }
      },
      eligible: null
    };

    check.eligible = Object.values(check.requirements).every(r => r.met);
    this.checks.push(check);
    return check;
  }

  getChecks() {
    return this.checks;
  }
}

class RevenueTracker {
  constructor() {
    this.transactions = [];
    this.accounts = {};
  }

  recordRevenue(source, platform, amount, description) {
    const transaction = {
      id: Math.random().toString(36).substr(2, 9),
      timestamp: new Date(),
      source, // 'ads', 'affiliate', 'sponsorship', 'direct'
      platform, // 'tiktok', 'instagram', 'youtube', 'facebook'
      amount,
      description,
      status: 'completed'
    };

    this.transactions.push(transaction);

    // Update account balance
    if (!this.accounts[platform]) {
      this.accounts[platform] = { balance: 0, totalEarned: 0 };
    }
    this.accounts[platform].balance += amount;
    this.accounts[platform].totalEarned += amount;

    return transaction;
  }

  getRevenueSummary() {
    const summary = {
      totalRevenue: 0,
      byPlatform: {},
      bySource: {},
      monthlyRevenue: {},
      transactions: this.transactions.length
    };

    this.transactions.forEach(t => {
      summary.totalRevenue += t.amount;

      if (!summary.byPlatform[t.platform]) {
        summary.byPlatform[t.platform] = 0;
      }
      summary.byPlatform[t.platform] += t.amount;

      if (!summary.bySource[t.source]) {
        summary.bySource[t.source] = 0;
      }
      summary.bySource[t.source] += t.amount;

      const month = t.timestamp.toISOString().slice(0, 7);
      if (!summary.monthlyRevenue[month]) {
        summary.monthlyRevenue[month] = 0;
      }
      summary.monthlyRevenue[month] += t.amount;
    });

    return summary;
  }

  getAccountBalance(platform) {
    return this.accounts[platform] || { balance: 0, totalEarned: 0 };
  }
}

class OpportunityAlert {
  constructor(apiKey) {
    this.client = new Anthropic({ apiKey });
    this.opportunities = [];
  }

  async identifyOpportunities(accountStats, revenueData) {
    const message = await this.client.messages.create({
      model: 'claude-opus-5',
      max_tokens: 2048,
      messages: [
        {
          role: 'user',
          content: `Identify monetization opportunities for a social media account.

          Account Stats:
          ${JSON.stringify(accountStats, null, 2)}

          Current Revenue:
          ${JSON.stringify(revenueData, null, 2)}

          Identify:
          1. Immediate monetization opportunities (within 30 days)
          2. Medium-term opportunities (30-90 days)
          3. Long-term opportunities (90+ days)
          4. Partnership opportunities
          5. Sponsorship potential
          6. Affiliate marketing opportunities

          For each opportunity, provide:
          - Name and description
          - Requirements
          - Estimated revenue potential
          - Time to implement
          - Priority level

          Return as JSON with: {opportunities: [{name, description, requirements, potential, timeline, priority}]}`
        }
      ]
    });

    const opportunities = JSON.parse(message.content[0].text);
    this.opportunities = opportunities.opportunities;
    return opportunities;
  }

  async generateMonetizationPlan(accountStats, goals) {
    const message = await this.client.messages.create({
      model: 'claude-opus-5',
      max_tokens: 3000,
      messages: [
        {
          role: 'user',
          content: `Create a comprehensive monetization plan for a social media account.

          Account Stats:
          ${JSON.stringify(accountStats, null, 2)}

          Revenue Goals:
          ${JSON.stringify(goals, null, 2)}

          Create plan with:
          1. Immediate actions (Week 1-2)
          2. Short-term strategy (Month 1-3)
          3. Medium-term strategy (Month 3-6)
          4. Long-term strategy (6-12 months)
          5. Revenue projections
          6. Risk mitigation

          Return as structured JSON plan.`
        }
      ]
    });

    return JSON.parse(message.content[0].text);
  }

  getOpportunities() {
    return this.opportunities;
  }
}

module.exports = {
  EligibilityChecker,
  RevenueTracker,
  OpportunityAlert
};
