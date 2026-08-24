class EligibilityChecker {
  constructor(apiKey) { this.apiKey = apiKey; this.checks = []; }
  async checkTikTokCreatorFund(stats) {
    const check = { platform: 'tiktok', program: 'Creator Fund', eligible: stats.followers >= 10000, requirements: { followers: stats.followers, views: stats.monthlyViews } };
    this.checks.push(check);
    return check;
  }
  async checkInstagramReelsBonus(stats) {
    const check = { platform: 'instagram', program: 'Reels Bonus', eligible: stats.followers >= 10000, estimatedMonthly: '$200-400' };
    this.checks.push(check);
    return check;
  }
  getChecks() { return this.checks; }
}
class RevenueTracker {
  constructor() { this.transactions = []; this.accounts = {}; }
  recordRevenue(source, platform, amount) {
    const t = { id: Math.random().toString(36).substr(2, 9), timestamp: new Date(), source, platform, amount };
    this.transactions.push(t);
    if (!this.accounts[platform]) this.accounts[platform] = { balance: 0, totalEarned: 0 };
    this.accounts[platform].balance += amount;
    this.accounts[platform].totalEarned += amount;
    return t;
  }
  getRevenueSummary() {
    return { totalRevenue: this.transactions.reduce((s, t) => s + t.amount, 0), transactions: this.transactions.length, byPlatform: this.accounts };
  }
}
class OpportunityAlert {
  constructor(apiKey) { this.apiKey = apiKey; this.opportunities = []; }
  async identifyOpportunities() {
    this.opportunities = [{ name: 'TikTok Creator Fund', potential: '$500/mo', priority: 'high' }, { name: 'Affiliate Marketing', potential: '$1000+/mo', priority: 'high' }];
    return { opportunities: this.opportunities };
  }
}
module.exports = { EligibilityChecker, RevenueTracker, OpportunityAlert };
