const Anthropic = require('@anthropic-ai/sdk');

class ResearchEngine {
  constructor(apiKey) {
    this.client = new Anthropic({ apiKey });
  }

  async researchTrends() {
    const message = await this.client.messages.create({
      model: 'claude-opus-5',
      max_tokens: 1024,
      messages: [
        {
          role: 'user',
          content: `Research current trends for a halal Middle Eastern fast-food restaurant in Tbilisi (Georgia).
          Provide:
          1. Top 5 trending hashtags on TikTok/Instagram for food content
          2. Best posting times for maximum engagement
          3. Current viral food content trends
          4. Seasonal food trends relevant to Georgian cuisine
          Return as JSON.`
        }
      ]
    });
    return JSON.parse(message.content[0].text);
  }

  async analyzeAudience() {
    const message = await this.client.messages.create({
      model: 'claude-opus-5',
      max_tokens: 1024,
      messages: [
        {
          role: 'user',
          content: `For a halal Middle Eastern fast-food restaurant targeting Tbilisi:
          Analyze ideal audience demographics and interests.
          Return: {demographics, interests, pain_points, content_preferences}`
        }
      ]
    });
    return JSON.parse(message.content[0].text);
  }

  async suggestHashtags(topic) {
    const message = await this.client.messages.create({
      model: 'claude-opus-5',
      max_tokens: 512,
      messages: [
        {
          role: 'user',
          content: `Generate 15 relevant hashtags for: ${topic} (halal food, Georgian market, TikTok/Instagram). Return as JSON array.`
        }
      ]
    });
    return JSON.parse(message.content[0].text);
  }
}

class ContentVault {
  constructor(apiKey) {
    this.client = new Anthropic({ apiKey });
    this.vault = [];
  }

  async generateContentIdeas(topic, count = 5) {
    const message = await this.client.messages.create({
      model: 'claude-opus-5',
      max_tokens: 2048,
      messages: [
        {
          role: 'user',
          content: `Generate ${count} viral-worthy content ideas for a halal Middle Eastern fast-food restaurant about "${topic}".
          For each idea, provide: title, description, format (short_video/carousel/reel), key_hooks, estimated_engagement.
          Return as JSON array.`
        }
      ]
    });

    const ideas = JSON.parse(message.content[0].text);
    this.vault.push(...ideas);
    return ideas;
  }

  async generateContentCalendar(days = 30) {
    const message = await this.client.messages.create({
      model: 'claude-opus-5',
      max_tokens: 4096,
      messages: [
        {
          role: 'user',
          content: `Create a ${days}-day content calendar for a halal Middle Eastern fast-food restaurant.
          Include: date, post_type, topic, hashtags, optimal_posting_time, platform_priority.
          Balance: product showcases, behind-scenes, customer testimonials, trending challenges.
          Return as JSON array.`
        }
      ]
    });

    return JSON.parse(message.content[0].text);
  }

  getVault() {
    return this.vault;
  }
}

class CompetitorTracker {
  constructor(apiKey) {
    this.client = new Anthropic({ apiKey });
  }

  async analyzeCompetitors() {
    const message = await this.client.messages.create({
      model: 'claude-opus-5',
      max_tokens: 2048,
      messages: [
        {
          role: 'user',
          content: `Analyze top fast-food competitors in Tbilisi on social media.
          For each competitor, provide: account_name, follower_count, posting_frequency,
          content_type_distribution, engagement_rate_estimate, unique_strategy.
          Focus on: content quality, engagement tactics, audience interaction.
          Return as JSON array.`
        }
      ]
    });

    return JSON.parse(message.content[0].text);
  }

  async identifyGaps() {
    const message = await this.client.messages.create({
      model: 'claude-opus-5',
      max_tokens: 1024,
      messages: [
        {
          role: 'user',
          content: `Based on Tbilisi fast-food market analysis, identify content gaps and opportunities.
          What content are competitors NOT creating? What audience needs are unmet?
          Return: {gaps: [], opportunities: [], recommendations: []}`
        }
      ]
    });

    return JSON.parse(message.content[0].text);
  }
}

class TrendAnalyzer {
  constructor(apiKey) {
    this.client = new Anthropic({ apiKey });
  }

  async identifyTrends() {
    const message = await this.client.messages.create({
      model: 'claude-opus-5',
      max_tokens: 2048,
      messages: [
        {
          role: 'user',
          content: `Identify top 10 emerging food & restaurant trends for 2026:
          For each: name, description, relevance_to_halal_food, content_opportunity,
          estimated_engagement_potential, implementation_difficulty.
          Return as JSON array.`
        }
      ]
    });

    return JSON.parse(message.content[0].text);
  }

  async seasonalAnalysis() {
    const message = await this.client.messages.create({
      model: 'claude-opus-5',
      max_tokens: 1024,
      messages: [
        {
          role: 'user',
          content: `Analyze seasonal opportunities for fast-food in Tbilisi for next 12 months.
          Include: month, season, holidays, weather_impact, food_trends, content_opportunities.
          Return as JSON object with months as keys.`
        }
      ]
    });

    return JSON.parse(message.content[0].text);
  }
}

module.exports = {
  ResearchEngine,
  ContentVault,
  CompetitorTracker,
  TrendAnalyzer
};
