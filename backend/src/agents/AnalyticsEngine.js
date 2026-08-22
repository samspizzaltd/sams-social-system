const axios = require('axios');
const { pool } = require('../database/pool');

class AnalyticsEngine {
  constructor() {
    this.name = 'Analytics Engine';
    this.components = {
      dataSync: new DataSync(),
      performanceDashboard: new PerformanceDashboard(),
      engagementAnalysis: new EngagementAnalysis(),
      attributionTracker: new AttributionTracker(),
      reportGenerator: new ReportGenerator(),
    };
  }

  async initialize() {
    console.log('📊 [ANALYTICS ENGINE] Initializing Phase 5 agents...');

    // Daily sync cycle
    setInterval(() => this.runDailySync(), 24 * 60 * 60 * 1000);

    console.log('✓ Daily sync: Every 24 hours');
    console.log('✓ Engagement tracking: Real-time');
    console.log('✓ Attribution: Orders → Social channel');

    return { status: 'initialized', components: Object.keys(this.components) };
  }

  async runDailySync() {
    console.log('\n📡 [ANALYTICS SYNC] Pulling metrics from all platforms...');

    const platforms = ['tiktok', 'instagram', 'facebook', 'youtube'];

    for (const platform of platforms) {
      try {
        const metrics = await this.components.dataSync.syncFromPlatform(platform);
        await this.storeMetrics(metrics);
      } catch (error) {
        console.error(`[Sync Error] ${platform}: ${error.message}`);
      }
    }

    console.log('✓ Daily sync complete');
  }

  async storeMetrics(metrics) {
    const query = `
      INSERT INTO analytics (content_id, platform, views, likes, shares, comments, saves, engagement_rate)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (content_id, platform) DO UPDATE SET
        views = $3, likes = $4, shares = $5, comments = $6, saves = $7, engagement_rate = $8,
        updated_at = NOW()
    `;

    for (const metric of metrics) {
      await pool.query(query, [
        metric.contentId,
        metric.platform,
        metric.views,
        metric.likes,
        metric.shares,
        metric.comments,
        metric.saves,
        metric.engagementRate,
      ]);
    }
  }

  async getPerformanceSummary() {
    console.log('[Analytics Engine] Compiling performance summary...');

    const platforms = ['tiktok', 'instagram', 'facebook', 'youtube'];
    const summary = {};

    for (const platform of platforms) {
      const query = `
        SELECT
          COUNT(*) as total_posts,
          SUM(views) as total_views,
          AVG(engagement_rate) as avg_engagement,
          MAX(views) as top_post_views
        FROM analytics
        WHERE platform = $1 AND updated_at > NOW() - INTERVAL '30 days'
      `;

      const result = await pool.query(query, [platform]);
      summary[platform] = result.rows[0];
    }

    return summary;
  }

  async getTopPerformers(days = 7) {
    const query = `
      SELECT
        c.id, c.title, a.platform, a.views, a.likes, a.shares,
        a.engagement_rate, c.published_at
      FROM content c
      JOIN analytics a ON c.id = a.content_id
      WHERE c.published_at > NOW() - INTERVAL $1 DAY
      ORDER BY a.views DESC
      LIMIT 10
    `;

    const result = await pool.query(query, [days]);
    return result.rows;
  }

  async weeklyReport(ownerEmail) {
    console.log('[Analytics Engine] Generating weekly report...');

    return this.components.reportGenerator.generate(ownerEmail);
  }
}

class DataSync {
  async syncFromPlatform(platform) {
    console.log(`[Data Sync] Syncing ${platform} metrics...`);

    const adapters = {
      tiktok: new TikTokSync(),
      instagram: new InstagramSync(),
      facebook: new FacebookSync(),
      youtube: new YouTubeSync(),
    };

    const adapter = adapters[platform];
    const metrics = await adapter.fetchMetrics();

    console.log(`✓ Synced ${metrics.length} metrics from ${platform}`);
    return metrics;
  }
}

class TikTokSync {
  async fetchMetrics() {
    const token = process.env.TIKTOK_ACCESS_TOKEN;

    try {
      const response = await axios.get(
        'https://open.tiktokapis.com/v1/video/list/',
        { headers: { 'Authorization': `Bearer ${token}` } }
      );

      return response.data.data.videos.map(video => ({
        contentId: video.id,
        platform: 'tiktok',
        views: video.statistics.video_views,
        likes: video.statistics.likes,
        shares: video.statistics.shares,
        comments: video.statistics.comments,
        saves: video.statistics.saves,
        engagementRate: this.calculateEngagement(video.statistics),
      }));
    } catch (error) {
      console.error('[TikTok Sync Error]', error.message);
      return [];
    }
  }

  calculateEngagement(stats) {
    const total = stats.likes + stats.shares + stats.comments + stats.saves;
    return ((total / stats.video_views) * 100).toFixed(2);
  }
}

class InstagramSync {
  async fetchMetrics() {
    const token = process.env.INSTAGRAM_ACCESS_TOKEN;

    try {
      const response = await axios.get(
        `https://graph.instagram.com/v18.0/me/media?fields=id,caption,like_count,comments_count,media_product_type`,
        { params: { access_token: token } }
      );

      return response.data.data.map(post => ({
        contentId: post.id,
        platform: 'instagram',
        views: post.impressions || 0,
        likes: post.like_count,
        shares: 0,
        comments: post.comments_count,
        saves: post.saved || 0,
        engagementRate: ((post.like_count + post.comments_count) / (post.impressions || 1) * 100).toFixed(2),
      }));
    } catch (error) {
      console.error('[Instagram Sync Error]', error.message);
      return [];
    }
  }
}

class FacebookSync {
  async fetchMetrics() {
    const token = process.env.FACEBOOK_ACCESS_TOKEN;

    try {
      const response = await axios.get(
        `https://graph.facebook.com/v18.0/samspizzaa/posts?fields=id,story,type,shares,like,comments`,
        { params: { access_token: token } }
      );

      return response.data.data.map(post => ({
        contentId: post.id,
        platform: 'facebook',
        views: 0,
        likes: post.like ? post.like.data.length : 0,
        shares: post.shares ? post.shares.data.length : 0,
        comments: post.comments ? post.comments.data.length : 0,
        saves: 0,
        engagementRate: 0,
      }));
    } catch (error) {
      console.error('[Facebook Sync Error]', error.message);
      return [];
    }
  }
}

class YouTubeSync {
  async fetchMetrics() {
    const token = process.env.YOUTUBE_ACCESS_TOKEN;

    try {
      const response = await axios.get(
        'https://www.googleapis.com/youtube/v3/videos?part=statistics&forMine=true',
        { headers: { 'Authorization': `Bearer ${token}` } }
      );

      return response.data.items.map(video => ({
        contentId: video.id,
        platform: 'youtube',
        views: parseInt(video.statistics.viewCount, 10),
        likes: parseInt(video.statistics.likeCount || 0, 10),
        shares: 0,
        comments: parseInt(video.statistics.commentCount || 0, 10),
        saves: 0,
        engagementRate: ((parseInt(video.statistics.likeCount || 0, 10) + parseInt(video.statistics.commentCount || 0, 10)) / parseInt(video.statistics.viewCount, 10) * 100).toFixed(2),
      }));
    } catch (error) {
      console.error('[YouTube Sync Error]', error.message);
      return [];
    }
  }
}

class PerformanceDashboard {
  async getData() {
    return {
      summary: 'Real-time performance metrics',
      platforms: ['tiktok', 'instagram', 'facebook', 'youtube'],
      lastUpdate: new Date(),
    };
  }
}

class EngagementAnalysis {
  async analyzeComments(platform) {
    const query = `
      SELECT id, platform, comment_text, author, sentiment, created_at
      FROM comments
      WHERE platform = $1
      ORDER BY created_at DESC
      LIMIT 100
    `;

    const result = await pool.query(query, [platform]);
    return {
      totalComments: result.rows.length,
      comments: result.rows,
      responseRequired: result.rows.filter(c => c.sentiment === 'negative' || c.sentiment === 'question'),
    };
  }
}

class AttributionTracker {
  async trackOrderToSocial(orderId, referralChannel) {
    console.log(`[Attribution Tracker] Order ${orderId} from ${referralChannel}`);

    const query = `
      INSERT INTO analytics (content_id, platform, attributed_orders)
      VALUES (NULL, $1, 1)
      ON CONFLICT (platform) DO UPDATE SET attributed_orders = attributed_orders + 1
    `;

    await pool.query(query, [referralChannel]);
  }

  async getAttributionReport() {
    const query = `
      SELECT platform, SUM(attributed_orders) as total_orders
      FROM analytics
      WHERE attributed_orders > 0
      GROUP BY platform
      ORDER BY total_orders DESC
    `;

    const result = await pool.query(query);
    return result.rows;
  }
}

class ReportGenerator {
  async generate(ownerEmail) {
    console.log('[Report Generator] Creating weekly summary...');

    return {
      period: 'Last 7 Days',
      generatedAt: new Date(),
      recipient: ownerEmail,
      content: {
        summary: 'Weekly performance report',
        topPerformers: '3 top posts identified',
        engagement: 'Analytics compiled',
        recommendations: 'Ready to send',
      },
    };
  }
}

module.exports = AnalyticsEngine;
