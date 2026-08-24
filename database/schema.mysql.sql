-- Sam's Social Media System - MySQL / MariaDB schema
-- Applied automatically on boot by backend/src/database/db.js

CREATE TABLE IF NOT EXISTS cycles (
  id               VARCHAR(32) PRIMARY KEY,
  cycle_number     INT NOT NULL,
  status           VARCHAR(20) NOT NULL,
  started_at       DATETIME NOT NULL,
  completed_at     DATETIME NULL,
  duration_ms      INT NULL,
  error            TEXT NULL,
  -- denormalised headline metrics so Phase 6 can query history cheaply
  drafts_created   INT DEFAULT 0,
  drafts_approved  INT DEFAULT 0,
  posts_published  INT DEFAULT 0,
  total_engagement BIGINT DEFAULT 0,
  phases           LONGTEXT NOT NULL,
  created_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_cycles_started (started_at),
  INDEX idx_cycles_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS accounts (
  id                  INT AUTO_INCREMENT PRIMARY KEY,
  platform            VARCHAR(50) NOT NULL,
  business_account_id VARCHAR(191) UNIQUE,
  access_token        TEXT,
  refresh_token       TEXT,
  expires_at          DATETIME NULL,
  status              VARCHAR(20) DEFAULT 'active',
  created_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS content (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  cycle_id      VARCHAR(32) NULL,
  title         VARCHAR(255),
  description   TEXT,
  script        TEXT,
  caption       TEXT,
  platforms     TEXT,
  quality_score DECIMAL(4,2) NULL,
  status        VARCHAR(20) DEFAULT 'draft',
  approved_at   DATETIME NULL,
  scheduled_for DATETIME NULL,
  published_at  DATETIME NULL,
  created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_content_status (status),
  INDEX idx_content_cycle (cycle_id),
  INDEX idx_content_scheduled (scheduled_for)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS analytics (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  content_id  INT NULL,
  cycle_id    VARCHAR(32) NULL,
  platform    VARCHAR(50),
  metric      VARCHAR(100),
  value       BIGINT,
  recorded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_analytics_content (content_id),
  INDEX idx_analytics_platform (platform),
  INDEX idx_analytics_cycle (cycle_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS competitors (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  platform        VARCHAR(50),
  account_name    VARCHAR(255),
  account_handle  VARCHAR(255),
  followers       BIGINT,
  engagement_rate DECIMAL(5,2),
  bio             TEXT,
  last_analyzed   DATETIME NULL,
  created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_competitors_platform (platform)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS trends (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  keyword         VARCHAR(191),
  category        VARCHAR(100),
  volume          INT,
  relevance_score DECIMAL(4,2),
  status          VARCHAR(20),
  last_checked    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_trends_keyword (keyword)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS branding (
  cfg_key    VARCHAR(191) PRIMARY KEY,
  cfg_value  TEXT,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
