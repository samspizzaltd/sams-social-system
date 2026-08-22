const { pool } = require('../database/pool');

class ContentVault {
  constructor() {
    this.name = 'Content Vault';
    this.components = {
      mediaLibrary: new MediaLibrary(),
      performanceTracker: new PerformanceTracker(),
      contentCatalog: new ContentCatalog(),
    };
  }

  async indexContent() {
    console.log('[Content Vault] Indexing historical content...');

    const results = {
      totalContent: await this.components.contentCatalog.count(),
      mediaFiles: await this.components.mediaLibrary.scan(),
      topPerformers: await this.components.performanceTracker.getTopPerformers(),
    };

    return results;
  }

  async getPerformanceData(contentId) {
    const query = `
      SELECT c.id, c.title, c.caption, c.platforms,
             a.views, a.likes, a.shares, a.comments, a.saves,
             a.engagement_rate, a.published_at
      FROM content c
      LEFT JOIN analytics a ON c.id = a.content_id
      WHERE c.id = $1
    `;

    const result = await pool.query(query, [contentId]);
    return result.rows[0] || null;
  }

  async getSimilarContent(characteristics) {
    console.log('[Content Vault] Finding similar high-performing content...');

    const query = `
      SELECT c.id, c.title, c.caption, c.media_type,
             a.views, a.likes, a.engagement_rate
      FROM content c
      LEFT JOIN analytics a ON c.id = a.content_id
      WHERE c.media_type = $1 AND a.engagement_rate > 5
      ORDER BY a.engagement_rate DESC
      LIMIT 10
    `;

    const result = await pool.query(query, [characteristics.type]);
    return result.rows;
  }
}

class MediaLibrary {
  async scan() {
    console.log('[Media Library] Scanning media files...');
    const query = `
      SELECT id, filename, media_type, duration, resolution, file_size, created_at
      FROM media
      ORDER BY created_at DESC
    `;

    const result = await pool.query(query);
    return {
      total: result.rows.length,
      byType: this.groupByType(result.rows),
      storage: this.calculateStorage(result.rows),
    };
  }

  groupByType(files) {
    return files.reduce((acc, file) => {
      acc[file.media_type] = (acc[file.media_type] || 0) + 1;
      return acc;
    }, {});
  }

  calculateStorage(files) {
    const bytes = files.reduce((sum, f) => sum + (f.file_size || 0), 0);
    return {
      bytes,
      mb: (bytes / (1024 * 1024)).toFixed(2),
      gb: (bytes / (1024 * 1024 * 1024)).toFixed(2),
    };
  }
}

class PerformanceTracker {
  async getTopPerformers(limit = 20) {
    console.log('[Performance Tracker] Analyzing top performers...');

    const query = `
      SELECT c.id, c.title, a.views, a.likes, a.shares, a.engagement_rate
      FROM content c
      LEFT JOIN analytics a ON c.id = a.content_id
      WHERE a.views IS NOT NULL
      ORDER BY a.engagement_rate DESC, a.views DESC
      LIMIT $1
    `;

    const result = await pool.query(query, [limit]);
    return result.rows.map(row => ({
      ...row,
      format: this.detectFormat(row),
      insights: this.generateInsights(row),
    }));
  }

  detectFormat(content) {
    if (content.views > 50000) return 'Viral Format';
    if (content.engagement_rate > 6) return 'High Engagement';
    if (content.shares > content.likes * 0.1) return 'Shareable';
    return 'Standard';
  }

  generateInsights(content) {
    return [
      `${content.views || 0} total views`,
      `${content.likes || 0} likes`,
      `${(content.engagement_rate || 0).toFixed(1)}% engagement rate`,
      `${content.shares || 0} shares`,
    ];
  }
}

class ContentCatalog {
  async count() {
    const query = 'SELECT COUNT(*) as total FROM content';
    const result = await pool.query(query);
    return parseInt(result.rows[0].total, 10);
  }

  async getByPlatform(platform) {
    const query = `
      SELECT c.id, c.title, c.caption, c.status,
             a.views, a.engagement_rate
      FROM content c
      LEFT JOIN analytics a ON c.id = a.content_id
      WHERE c.platforms @> $1::jsonb
      ORDER BY c.created_at DESC
    `;

    const result = await pool.query(query, [JSON.stringify([platform])]);
    return result.rows;
  }
}

module.exports = ContentVault;
