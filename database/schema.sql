-- Sam's Social Media System Database Schema
-- PostgreSQL

-- Accounts (Platform OAuth)
CREATE TABLE accounts (
  id SERIAL PRIMARY KEY,
  platform VARCHAR(50) NOT NULL,
  business_account_id VARCHAR(255) UNIQUE,
  access_token TEXT,
  refresh_token TEXT,
  expires_at TIMESTAMP,
  status VARCHAR(20) DEFAULT 'active',
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Content (Posts/Videos to be published)
CREATE TABLE content (
  id SERIAL PRIMARY KEY,
  title VARCHAR(255),
  description TEXT,
  script TEXT,
  caption TEXT,
  platforms TEXT[] DEFAULT '{}',
  status VARCHAR(20) DEFAULT 'draft',
  approved_by INTEGER REFERENCES accounts(id),
  approved_at TIMESTAMP,
  scheduled_for TIMESTAMP,
  published_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Media Files
CREATE TABLE media (
  id SERIAL PRIMARY KEY,
  content_id INTEGER REFERENCES content(id) ON DELETE CASCADE,
  filename VARCHAR(255),
  filepath TEXT,
  media_type VARCHAR(50),
  duration INTEGER,
  resolution VARCHAR(50),
  orientation VARCHAR(20),
  size_bytes BIGINT,
  uploaded_at TIMESTAMP DEFAULT NOW()
);

-- Analytics
CREATE TABLE analytics (
  id SERIAL PRIMARY KEY,
  content_id INTEGER REFERENCES content(id) ON DELETE CASCADE,
  platform VARCHAR(50),
  metric VARCHAR(100),
  value BIGINT,
  recorded_at TIMESTAMP DEFAULT NOW()
);

-- Comments
CREATE TABLE comments (
  id SERIAL PRIMARY KEY,
  content_id INTEGER REFERENCES content(id) ON DELETE CASCADE,
  platform VARCHAR(50),
  author_id VARCHAR(255),
  author_name VARCHAR(255),
  text TEXT,
  likes INTEGER DEFAULT 0,
  needs_response BOOLEAN DEFAULT false,
  responded BOOLEAN DEFAULT false,
  response_text TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Competitors
CREATE TABLE competitors (
  id SERIAL PRIMARY KEY,
  platform VARCHAR(50),
  account_name VARCHAR(255),
  account_handle VARCHAR(255),
  followers BIGINT,
  engagement_rate DECIMAL(5,2),
  bio TEXT,
  last_analyzed TIMESTAMP,
  notes TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Trends
CREATE TABLE trends (
  id SERIAL PRIMARY KEY,
  keyword VARCHAR(255),
  category VARCHAR(100),
  volume INTEGER,
  relevance_score DECIMAL(3,2),
  status VARCHAR(20),
  last_checked TIMESTAMP DEFAULT NOW(),
  created_at TIMESTAMP DEFAULT NOW()
);

-- Business Configuration
CREATE TABLE branding (
  key VARCHAR(255) PRIMARY KEY,
  value TEXT,
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Users (Admin/Staff)
CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  username VARCHAR(100) UNIQUE NOT NULL,
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255),
  role VARCHAR(50) DEFAULT 'viewer',
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT NOW(),
  last_login TIMESTAMP
);

-- Indexes for performance
CREATE INDEX idx_content_status ON content(status);
CREATE INDEX idx_content_platforms ON content USING GIN(platforms);
CREATE INDEX idx_content_scheduled ON content(scheduled_for);
CREATE INDEX idx_analytics_content ON analytics(content_id);
CREATE INDEX idx_analytics_platform ON analytics(platform);
CREATE INDEX idx_comments_content ON comments(content_id);
CREATE INDEX idx_comments_needs_response ON comments(needs_response);
CREATE INDEX idx_competitors_platform ON competitors(platform);
CREATE INDEX idx_trends_keyword ON trends(keyword);
