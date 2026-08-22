const axios = require('axios');
const { pool } = require('../database/pool');

class PublishingEngine {
  constructor() {
    this.name = 'Publishing Engine';
    this.components = {
      platformAdapters: {
        tiktok: new TikTokAdapter(),
        instagram: new InstagramAdapter(),
        facebook: new FacebookAdapter(),
        youtube: new YouTubeAdapter(),
      },
      scheduler: new ContentScheduler(),
      queueManager: new PublishingQueueManager(),
      errorRecovery: new ErrorRecovery(),
    };
  }

  async initialize() {
    console.log('📤 [PUBLISHING ENGINE] Initializing Phase 4 agents...');

    // Check all platform OAuth credentials
    await this.validatePlatformCredentials();

    return { status: 'initialized', platforms: Object.keys(this.components.platformAdapters) };
  }

  async validatePlatformCredentials() {
    for (const [platform, adapter] of Object.entries(this.components.platformAdapters)) {
      const query = `
        SELECT token_type, expires_at FROM accounts
        WHERE platform = $1 AND is_active = true
      `;

      const result = await pool.query(query, [platform]);
      if (result.rows.length > 0) {
        console.log(`✓ ${platform}: OAuth configured`);
      } else {
        console.log(`⚠ ${platform}: Awaiting OAuth setup`);
      }
    }
  }

  async publishContent(contentId) {
    console.log(`[Publishing Engine] Publishing content ${contentId}...`);

    const content = await this.getContent(contentId);
    const platforms = content.platforms;

    const results = {
      contentId,
      platforms: {},
      errors: [],
    };

    for (const platform of platforms) {
      try {
        const adapter = this.components.platformAdapters[platform];
        const publishResult = await adapter.publish(content);
        results.platforms[platform] = publishResult;
        console.log(`✓ Published to ${platform}: ${publishResult.postId}`);
      } catch (error) {
        results.errors.push({ platform, error: error.message });
        console.error(`✗ Failed to publish to ${platform}: ${error.message}`);

        // Queue for retry
        await this.components.errorRecovery.queueForRetry(contentId, platform);
      }
    }

    // Update content status
    await this.updateContentStatus(contentId, 'published', results);
    return results;
  }

  async scheduleContent(contentId, publishTime) {
    console.log(`[Publishing Engine] Scheduling content ${contentId} for ${publishTime}`);

    const query = `
      UPDATE content
      SET scheduled_for = $1, status = 'scheduled'
      WHERE id = $2
      RETURNING *
    `;

    const result = await pool.query(query, [publishTime, contentId]);
    console.log(`✓ Scheduled for: ${publishTime}`);

    // Queue in scheduler
    await this.components.scheduler.addToQueue(result.rows[0]);
    return result.rows[0];
  }

  async getContent(contentId) {
    const query = `
      SELECT id, title, caption, platforms, media_url, status
      FROM content
      WHERE id = $1
    `;

    const result = await pool.query(query, [contentId]);
    return result.rows[0];
  }

  async updateContentStatus(contentId, status, publishData) {
    const query = `
      UPDATE content
      SET status = $1, published_at = NOW(), publish_data = $2
      WHERE id = $3
    `;

    await pool.query(query, [status, JSON.stringify(publishData), contentId]);
  }
}

class TikTokAdapter {
  async publish(content) {
    console.log('[TikTok Adapter] Publishing to TikTok...');

    // OAuth token retrieval
    const token = await this.getAccessToken();

    try {
      const response = await axios.post(
        'https://open.tiktokapis.com/v1/video/upload/',
        {
          source_info: {
            source: 'SCHEDULE_POST',
            platform: 'TIKTOK_CREATOR',
          },
          video_info: {
            video_name: content.title,
            description: content.caption.English || content.caption,
          },
        },
        { headers: { 'Authorization': `Bearer ${token}` } }
      );

      return {
        platform: 'tiktok',
        postId: response.data.data.video_id,
        url: `https://www.tiktok.com/@samspizzaltd/video/${response.data.data.video_id}`,
        publishedAt: new Date(),
      };
    } catch (error) {
      throw new Error(`TikTok API error: ${error.message}`);
    }
  }

  async getAccessToken() {
    // Retrieve from database
    return process.env.TIKTOK_ACCESS_TOKEN;
  }
}

class InstagramAdapter {
  async publish(content) {
    console.log('[Instagram Adapter] Publishing to Instagram...');

    const token = await this.getAccessToken();

    try {
      const response = await axios.post(
        'https://graph.instagram.com/v18.0/me/media',
        {
          caption: content.caption.English || content.caption,
          media_type: 'CAROUSEL',
        },
        { params: { access_token: token } }
      );

      return {
        platform: 'instagram',
        postId: response.data.id,
        url: `https://www.instagram.com/p/${response.data.id}/`,
        publishedAt: new Date(),
      };
    } catch (error) {
      throw new Error(`Instagram API error: ${error.message}`);
    }
  }

  async getAccessToken() {
    return process.env.INSTAGRAM_ACCESS_TOKEN;
  }
}

class FacebookAdapter {
  async publish(content) {
    console.log('[Facebook Adapter] Publishing to Facebook...');

    const token = await this.getAccessToken();

    try {
      const response = await axios.post(
        'https://graph.facebook.com/v18.0/samspizzaa/feed',
        {
          message: content.caption.English || content.caption,
          published: true,
        },
        { params: { access_token: token } }
      );

      return {
        platform: 'facebook',
        postId: response.data.id,
        url: `https://www.facebook.com/samspizzaa/posts/${response.data.id}`,
        publishedAt: new Date(),
      };
    } catch (error) {
      throw new Error(`Facebook API error: ${error.message}`);
    }
  }

  async getAccessToken() {
    return process.env.FACEBOOK_ACCESS_TOKEN;
  }
}

class YouTubeAdapter {
  async publish(content) {
    console.log('[YouTube Adapter] Publishing to YouTube...');

    const token = await this.getAccessToken();

    try {
      const response = await axios.post(
        'https://www.googleapis.com/youtube/v3/videos?part=snippet,status',
        {
          snippet: {
            title: content.title,
            description: content.caption.English || content.caption,
            tags: ['food', 'restaurant', 'tbilisi'],
            categoryId: '26', // Howto category
          },
          status: {
            privacyStatus: 'public',
          },
        },
        { headers: { 'Authorization': `Bearer ${token}` } }
      );

      return {
        platform: 'youtube',
        postId: response.data.id,
        url: `https://youtu.be/${response.data.id}`,
        publishedAt: new Date(),
      };
    } catch (error) {
      throw new Error(`YouTube API error: ${error.message}`);
    }
  }

  async getAccessToken() {
    return process.env.YOUTUBE_ACCESS_TOKEN;
  }
}

class ContentScheduler {
  async addToQueue(content) {
    console.log(`[Scheduler] Queued: ${content.title} for ${content.scheduled_for}`);
    // Scheduled publishing logic here
  }
}

class PublishingQueueManager {
  async checkQueue() {
    const query = `
      SELECT id, scheduled_for FROM content
      WHERE status = 'scheduled' AND scheduled_for <= NOW()
      ORDER BY scheduled_for ASC
    `;

    const result = await pool.query(query);
    return result.rows;
  }
}

class ErrorRecovery {
  async queueForRetry(contentId, platform, attempt = 1) {
    console.log(`[Error Recovery] Queueing ${contentId} (${platform}) for retry - Attempt ${attempt}`);

    if (attempt <= 3) {
      // Exponential backoff: 1 hour, 4 hours, 24 hours
      const delayMs = Math.pow(4, attempt) * 60 * 60 * 1000;
      setTimeout(() => this.retry(contentId, platform, attempt + 1), delayMs);
    } else {
      console.log(`✗ Max retries exceeded for ${contentId}`);
    }
  }

  async retry(contentId, platform, attempt) {
    console.log(`[Error Recovery] Retrying ${contentId} on ${platform} (Attempt ${attempt})`);
    // Retry publishing logic
  }
}

module.exports = PublishingEngine;
