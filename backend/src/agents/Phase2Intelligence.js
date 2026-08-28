const claude = require('../services/claudeClient');

const BUSINESS =
  "Sam's, a halal Middle Eastern fast-food restaurant in Tbilisi, Georgia. " +
  'Serves shawarma, falafel, grills and wraps. The audience is local Georgians, ' +
  'the Middle Eastern and Muslim community, and tourists looking for halal food.';

class ResearchEngine {
  constructor(apiKey) { this.apiKey = apiKey; }

  async researchTrends() {
    const generated = await claude.generateJSON({
      system: 'You are a social media strategist for ' + BUSINESS,
      prompt:
        'Identify social media trends worth acting on this week for this restaurant. ' +
        'Give hashtags actually used in the Georgian and halal food scene, realistic ' +
        'best posting times for Tbilisi local time, concrete content trends, and ' +
        'seasonal angles for the current season.',
      effort: 'medium',
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['hashtags', 'bestTimes', 'trends', 'seasonal'],
        properties: {
          hashtags: { type: 'array', items: { type: 'string' }, minItems: 5, maxItems: 8 },
          bestTimes: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 4 },
          trends: { type: 'array', items: { type: 'string' }, minItems: 3, maxItems: 6 },
          seasonal: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 4 }
        }
      }
    });
    if (generated) return Object.assign({ source: 'claude' }, generated);

    return {
      source: 'fallback',
      hashtags: ['#halal', '#fastfood', '#tbilisi', '#food', '#streetfood'],
      bestTimes: ['7-9 AM', '12-1 PM', '6-8 PM'],
      trends: ['Food ASMR', 'Behind-the-scenes', 'Customer reviews'],
      seasonal: ['Summer: salads', 'Winter: comfort food']
    };
  }

  async analyzeAudience() {
    const generated = await claude.generateJSON({
      system: 'You are an audience researcher for ' + BUSINESS,
      prompt: 'Describe the core social media audience for this restaurant.',
      effort: 'low',
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['ages', 'interests', 'locations', 'preferences'],
        properties: {
          ages: { type: 'string' },
          interests: { type: 'array', items: { type: 'string' } },
          locations: { type: 'array', items: { type: 'string' } },
          preferences: { type: 'string' }
        }
      }
    });
    if (generated) return Object.assign({ source: 'claude' }, generated);

    return {
      source: 'fallback',
      ages: '18-35',
      interests: ['food', 'health', 'local'],
      locations: ['Tbilisi'],
      preferences: 'short_videos'
    };
  }

  async suggestHashtags(topic) {
    const generated = await claude.generateJSON({
      system: 'You are a social media strategist for ' + BUSINESS,
      prompt: 'Give 8 hashtags for a post about: ' + (topic || 'the restaurant generally'),
      effort: 'low',
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['hashtags'],
        properties: {
          hashtags: { type: 'array', items: { type: 'string' }, minItems: 5, maxItems: 10 }
        }
      }
    });
    if (generated) return generated.hashtags;

    return ['#halal', '#foodie', '#tbilisi', '#middleeastern', '#fastfood', '#streetfood'];
  }
}

class ContentVault {
  constructor(apiKey) { this.apiKey = apiKey; this.vault = []; }

  async generateContentIdeas(topic, count) {
    const n = count || 3;
    const generated = await claude.generateJSON({
      system: 'You are a short-form video producer for ' + BUSINESS,
      prompt:
        'Propose ' + n + ' specific, filmable content ideas' +
        (topic ? ' about ' + topic : '') +
        '. Each must be something a small restaurant can actually shoot on a phone. ' +
        'Avoid generic ideas - be concrete about what is on screen.',
      effort: 'medium',
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['ideas'],
        properties: {
          ideas: {
            type: 'array',
            minItems: 1,
            maxItems: 6,
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['title', 'format', 'hooks'],
              properties: {
                title: { type: 'string' },
                format: { type: 'string', enum: ['reel', 'video', 'carousel', 'photo'] },
                hooks: { type: 'string' }
              }
            }
          }
        }
      }
    });

    const ideas = generated
      ? generated.ideas
      : [
          { title: 'Food Prep ASMR', format: 'reel', hooks: 'satisfying sounds' },
          { title: 'Customer Stories', format: 'video', hooks: 'authentic testimonials' }
        ];

    this.vault.push.apply(this.vault, ideas);
    return ideas;
  }

  async generateContentCalendar() {
    return [{ date: '2026-08-25', topic: 'New Menu', platform: 'tiktok', time: '12 PM' }];
  }

  getVault() { return this.vault; }
}

class CompetitorTracker {
  constructor(apiKey) { this.apiKey = apiKey; }

  async analyzeCompetitors() {
    // Real competitor data needs platform API access; placeholder until then.
    return [{ name: 'Competitor1', followers: 25000, engagement: '3.5%', strategy: 'daily_posts' }];
  }

  async identifyGaps() {
    const generated = await claude.generateJSON({
      system: 'You are a competitive analyst for ' + BUSINESS,
      prompt:
        'What content gaps and opportunities exist for a halal fast-food restaurant on ' +
        'social media in Tbilisi? Be specific and actionable.',
      effort: 'medium',
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['gaps', 'opportunities'],
        properties: {
          gaps: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 5 },
          opportunities: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 5 }
        }
      }
    });
    if (generated) return generated;

    return {
      gaps: ['educational content', 'live streaming'],
      opportunities: ['cooking tips', 'ingredient stories']
    };
  }
}

class TrendAnalyzer {
  constructor(apiKey) { this.apiKey = apiKey; }

  async identifyTrends() {
    const generated = await claude.generateJSON({
      system: 'You are a food trend analyst for ' + BUSINESS,
      prompt:
        'Identify trends this restaurant could ride on TikTok and Instagram right now. ' +
        'Score potential 1-10 for a small local restaurant.',
      effort: 'medium',
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['trends'],
        properties: {
          trends: {
            type: 'array',
            minItems: 2,
            maxItems: 6,
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['name', 'relevance', 'potential'],
              properties: {
                name: { type: 'string' },
                relevance: { type: 'string', enum: ['high', 'medium', 'low'] },
                potential: { type: 'number' }
              }
            }
          }
        }
      }
    });
    if (generated) return generated.trends;

    return [
      { name: 'Food ASMR', relevance: 'high', potential: 8.5 },
      { name: 'Sustainable Sourcing', relevance: 'medium', potential: 7.0 }
    ];
  }

  async seasonalAnalysis() {
    return { Aug: 'Summer promotions', Sep: 'Back to routine', Dec: 'Holiday specials' };
  }
}

module.exports = { ResearchEngine, ContentVault, CompetitorTracker, TrendAnalyzer };
