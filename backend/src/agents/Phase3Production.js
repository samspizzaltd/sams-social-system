class ContentCreationEngine {
  constructor(apiKey) { this.apiKey = apiKey; }

  async generateCaption(topic, platform = 'tiktok') {
    const tag = String(topic).replace(/[^a-zA-Z0-9]/g, '');
    return `Fresh out of the kitchen: ${topic}! Tag someone who needs this today. #${tag} #halal #foodie #tbilisi`;
  }

  async generateVideoScript(topic, duration = 30) {
    return {
      duration,
      beats: [
        { at: '0:00', type: 'hook', text: `POV: you just found the best ${topic} in Tbilisi` },
        { at: '0:03', type: 'body', text: `Close-up of ${topic} being prepared. Natural sound, no music over the sizzle.` },
        { at: `0:${duration - 5}`, type: 'cta', text: 'Comment "HUNGRY" and we will save you a table.' }
      ]
    };
  }

  async generateCarouselPost(topic) {
    return [1, 2, 3, 4, 5].map(n => ({
      slide: n,
      visual: `Slide ${n} visual for ${topic}`,
      caption: `${topic} — point ${n}`,
      cta: n === 5 ? 'Visit us today' : null
    }));
  }

  async generateProductDescription(productName, ingredients = []) {
    return `${productName} — made with ${ingredients.join(', ') || 'fresh halal ingredients'}. Prepared to order, served hot.`;
  }
}

class ApprovalWorkflow {
  constructor() { this.queue = []; this.approved = []; this.rejected = []; }

  async submitForReview(content) {
    const item = {
      id: Math.random().toString(36).substr(2, 9),
      content,
      status: 'pending_review',
      submittedAt: new Date(),
      score: null,
      feedback: null
    };
    this.queue.push(item);
    return item.id;
  }

  async autoReview(contentId) {
    const item = this.queue.find(q => q.id === contentId);
    if (!item) return null;

    const score = this.calculateQualityScore(item.content);
    item.score = score;

    if (score >= 7.5) {
      item.status = 'auto_approved';
      this.approved.push(item);
      this.queue = this.queue.filter(q => q.id !== contentId);
      return { status: 'approved', score };
    }
    if (score >= 5) {
      item.status = 'needs_review';
      item.feedback = `Flagged for manual review - quality score: ${score}`;
      return { status: 'pending_manual', score };
    }
    item.status = 'rejected';
    item.feedback = `Quality below threshold (score: ${score})`;
    this.rejected.push(item);
    this.queue = this.queue.filter(q => q.id !== contentId);
    return { status: 'rejected', score };
  }

  calculateQualityScore(content) {
    let score = 5;
    const caption = content && content.caption;
    if (!caption) return score;

    if (caption.length > 10) score += 1;
    if ((caption.match(/#/g) || []).length >= 3) score += 1;

    const lower = caption.toLowerCase();
    if (lower.includes('tag') || lower.includes('comment') || lower.includes('visit')) score += 1;

    const emojiCount = (caption.match(/[\u{1F300}-\u{1FAFF}]/gu) || []).length;
    if (emojiCount > 0 && emojiCount <= 5) score += 0.5;

    if (content.platform && content.platform.length > 0) score += 0.5;

    return Math.min(10, Math.max(0, score));
  }

  getApproved() { return this.approved; }
  getPending() { return this.queue.filter(q => q.status === 'needs_review'); }
  getRejected() { return this.rejected; }
}

class ContentScheduler {
  constructor() { this.schedule = []; }

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
    const future = new Date(now.getTime() + days * 86400000);
    return this.schedule
      .filter(p => p.status === 'scheduled' && p.scheduledTime >= now && p.scheduledTime <= future)
      .sort((a, b) => a.scheduledTime - b.scheduledTime);
  }

  publishDue() {
    const now = new Date();
    const due = this.schedule.filter(p => p.status === 'scheduled' && p.scheduledTime <= now);
    due.forEach(p => { p.status = 'published'; p.publishedAt = new Date(); });
    return due;
  }
}

module.exports = { ContentCreationEngine, ApprovalWorkflow, ContentScheduler };
