const Anthropic = require('@anthropic-ai/sdk');

class ContentCreationEngine {
  constructor(apiKey) {
    this.client = new Anthropic({ apiKey });
  }

  async generateCaption(topic, platform = 'tiktok', style = 'engaging') {
    const prompt = this.getCaptionPrompt(topic, platform, style);
    const message = await this.client.messages.create({
      model: 'claude-opus-5',
      max_tokens: 512,
      messages: [{ role: 'user', content: prompt }]
    });
    return message.content[0].text;
  }

  async generateVideoScript(topic, duration = 30) {
    const message = await this.client.messages.create({
      model: 'claude-opus-5',
      max_tokens: 1024,
      messages: [
        {
          role: 'user',
          content: `Create a ${duration}-second video script for a halal fast-food restaurant about: "${topic}"
          Include: hook (1-2 sec), main content (5-10 sec), call-to-action (2-3 sec).
          Format: [0:00] Hook text, [0:02] Main content, [0:25] CTA.
          Make it viral-ready with trending elements.`
        }
      ]
    });
    return message.content[0].text;
  }

  async generateCarouselPost(topic) {
    const message = await this.client.messages.create({
      model: 'claude-opus-5',
      max_tokens: 2048,
      messages: [
        {
          role: 'user',
          content: `Create a 5-slide Instagram carousel about: "${topic}" for a halal fast-food restaurant.
          For each slide: description, visual_guide, caption_text, CTA.
          Make it educational, entertaining, and conversion-focused.
          Return as JSON array with 5 objects.`
        }
      ]
    });
    return JSON.parse(message.content[0].text);
  }

  getCaptionPrompt(topic, platform, style) {
    const platformGuidelines = {
      tiktok: 'Keep under 150 chars, use trending sounds/music cues, include 3-5 relevant hashtags, add emojis strategically',
      instagram: 'Mix story with CTA, use line breaks for readability, include 10-15 hashtags, encourage comments',
      facebook: 'Conversational tone, longer format OK (100-200 chars), ask questions, emphasize community'
    };

    return `Write a ${style} caption for ${platform} about: "${topic}" (halal fast-food restaurant).
    Guidelines: ${platformGuidelines[platform] || platformGuidelines.tiktok}
    Make it shareable and engagement-maximizing.`;
  }

  async generateProductDescription(productName, ingredients) {
    const message = await this.client.messages.create({
      model: 'claude-opus-5',
      max_tokens: 512,
      messages: [
        {
          role: 'user',
          content: `Write a mouth-watering product description for: ${productName}
          Ingredients: ${ingredients.join(', ')}
          Style: appetizing, authentic, Instagram-worthy.
          Include: flavor profile, texture, pairing suggestions, why it's special.`
        }
      ]
    });
    return message.content[0].text;
  }
}

class ApprovalWorkflow {
  constructor() {
    this.queue = [];
    this.approved = [];
    this.rejected = [];
  }

  async submitForReview(content) {
    this.queue.push({
      id: Math.random().toString(36).substr(2, 9),
      content,
      status: 'pending_review',
      submittedAt: new Date(),
      score: null,
      feedback: null
    });
    return this.queue[this.queue.length - 1].id;
  }

  async autoReview(contentId) {
    const item = this.queue.find(q => q.id === contentId);
    if (!item) return null;

    // Quick quality check
    const qualityScore = this.calculateQualityScore(item.content);
    item.score = qualityScore;

    if (qualityScore >= 7.5) {
      item.status = 'auto_approved';
      this.approved.push(item);
      this.queue = this.queue.filter(q => q.id !== contentId);
      return { status: 'approved', score: qualityScore };
    } else if (qualityScore >= 5) {
      item.status = 'needs_review';
      item.feedback = 'Flagged for manual review - quality score: ' + qualityScore;
      return { status: 'pending_manual', score: qualityScore };
    } else {
      item.status = 'rejected';
      item.feedback = 'Quality below threshold (score: ' + qualityScore + ')';
      this.rejected.push(item);
      this.queue = this.queue.filter(q => q.id !== contentId);
      return { status: 'rejected', score: qualityScore };
    }
  }

  calculateQualityScore(content) {
    let score = 5; // base

    // Grammar/spelling (positive indicator if present)
    if (content.caption && content.caption.length > 10) score += 1;

    // Hashtag presence
    if (content.caption && (content.caption.match(/#/g) || []).length >= 3) score += 1;

    // Call-to-action
    if (content.caption && (content.caption.toLowerCase().includes('tag') ||
        content.caption.toLowerCase().includes('comment') ||
        content.caption.toLowerCase().includes('visit'))) score += 1;

    // Emoji use (moderate)
    const emojiCount = (content.caption && (content.caption.match(/[😀-🙏]/g) || []).length) || 0;
    if (emojiCount > 0 && emojiCount <= 5) score += 0.5;

    // Platform optimization
    if (content.platform && content.platform.length > 0) score += 0.5;

    return Math.min(10, Math.max(0, score));
  }

  getApproved() {
    return this.approved;
  }

  getPending() {
    return this.queue.filter(q => q.status === 'needs_review');
  }

  getRejected() {
    return this.rejected;
  }
}

class ContentScheduler {
  constructor() {
    this.schedule = [];
  }

  schedulePost(content, platform, scheduledTime) {
    const post = {
      id: Math.random().toString(36).substr(2, 9),
      content,
      platform,
      scheduledTime: new Date(scheduledTime),
      status: 'scheduled',
      createdAt: new Date()
    };
    this.schedule.push(post);
    return post.id;
  }

  getUpcoming(days = 7) {
    const now = new Date();
    const future = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);

    return this.schedule.filter(post =>
      post.status === 'scheduled' &&
      post.scheduledTime >= now &&
      post.scheduledTime <= future
    ).sort((a, b) => a.scheduledTime - b.scheduledTime);
  }

  publishDue() {
    const now = new Date();
    const dueForPublish = this.schedule.filter(post =>
      post.status === 'scheduled' &&
      post.scheduledTime <= now
    );

    dueForPublish.forEach(post => {
      post.status = 'published';
      post.publishedAt = new Date();
    });

    return dueForPublish;
  }
}

module.exports = {
  ContentCreationEngine,
  ApprovalWorkflow,
  ContentScheduler
};
