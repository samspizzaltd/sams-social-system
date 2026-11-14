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
  business_account_id VARCHAR(191),
  UNIQUE KEY uniq_platform_account (platform, business_account_id),
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

CREATE TABLE IF NOT EXISTS revenue (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  platform    VARCHAR(50) NOT NULL,
  source      VARCHAR(50) NOT NULL,
  amount      DECIMAL(12,2) NOT NULL,
  currency    VARCHAR(10) DEFAULT 'GEL',
  note        VARCHAR(500) NULL,
  recorded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_revenue_platform (platform),
  INDEX idx_revenue_recorded (recorded_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS media (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  kind        VARCHAR(20) NOT NULL,
  title       VARCHAR(255) NULL,
  filename    VARCHAR(255) NULL,
  url_path    VARCHAR(500) NULL,
  local_path  VARCHAR(500) NULL,
  size_bytes  BIGINT NULL,
  content_id  INT NULL,
  note        VARCHAR(500) NULL,
  created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_media_kind (kind),
  INDEX idx_media_content (content_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS render_jobs (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  content_id      INT NULL,
  template        VARCHAR(50) NOT NULL,
  params          LONGTEXT NULL,
  media_ids       VARCHAR(500) NULL,
  status          VARCHAR(20) DEFAULT 'queued',
  error           TEXT NULL,
  output_media_id INT NULL,
  created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_render_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS publish_queue (
  id                 INT AUTO_INCREMENT PRIMARY KEY,
  platform           VARCHAR(20) NOT NULL,
  media_id           INT NOT NULL,
  caption            TEXT NOT NULL,
  status             VARCHAR(24) DEFAULT 'pending_review',
  creation_id        VARCHAR(1024) NULL,
  attempts           INT DEFAULT 0,
  published_media_id VARCHAR(64) NULL,
  permalink          VARCHAR(500) NULL,
  error              TEXT NULL,
  created_at         TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at         TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  published_at       DATETIME NULL,
  INDEX idx_pubq_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 2026-10-13: TikTok direct post needs per-row posting options (privacy level,
-- interaction toggles) chosen by the owner at approve time. The ALTER fails
-- harmlessly on every boot after the first (db.js logs and continues).
ALTER TABLE publish_queue ADD COLUMN post_options TEXT NULL;

-- 2026-10-13: platform-scoped uniqueness for connected accounts. The UNIQUE on
-- business_account_id alone let a cross-platform id collision hijack another
-- platform's row. Both ALTERs fail harmlessly once applied / on fresh schemas
-- where the old index name does not exist (db.js logs and continues).
ALTER TABLE accounts ADD UNIQUE KEY uniq_platform_account (platform, business_account_id);
ALTER TABLE accounts DROP INDEX business_account_id;

-- 2026-11-06: YouTube stores its resumable upload-session URL (~300+ chars)
-- as creation_id; 64 chars would make the pre-upload save fail every time.
ALTER TABLE publish_queue MODIFY creation_id VARCHAR(1024) NULL;

-- 2026-11-06: Autopilot. The owner's library videos are prepared automatically
-- (look at the video, write the captions, branded edit with a circulated sound)
-- and staged in the publish queue as pending_review. One row per library video.
-- Status: queued -> analyzing -> analyzed -> writing -> rendering -> staged
--         (| failed | skipped). Nothing here publishes.
CREATE TABLE IF NOT EXISTS media_prep (
  media_id        INT PRIMARY KEY,
  status          VARCHAR(20) NOT NULL DEFAULT 'queued',
  analyze_job_id  INT NULL,
  render_job_id   INT NULL,
  output_media_id INT NULL,
  own_sound_id    INT NULL,
  sound_media_id  INT NULL,
  sound_choice    VARCHAR(10) NULL,
  analysis        TEXT NULL,
  copy_json       TEXT NULL,
  writer          VARCHAR(20) NULL,
  error           TEXT NULL,
  created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_prep_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Publish slots: epoch milliseconds (timezone-free) when an approved row may
-- go out; NULL = as soon as possible. prep_media_id links autopilot rows back
-- to the library video they were made from.
ALTER TABLE publish_queue ADD COLUMN scheduled_at BIGINT NULL;
ALTER TABLE publish_queue ADD COLUMN prep_media_id INT NULL;
-- Sounds (kind 'sound') can be taken out of circulation by the owner.
ALTER TABLE media ADD COLUMN circulate TINYINT(1) NOT NULL DEFAULT 1;

-- 2026-11-10: REAL numbers from the platforms (services/metrics.js), replacing
-- the cycle sandbox simulation. One row per published post, refreshed every
-- 3 hours. NULL = the platform does not give us that number (not the same as 0).
CREATE TABLE IF NOT EXISTS post_metrics (
  queue_id     INT PRIMARY KEY,
  platform     VARCHAR(20) NOT NULL,
  external_id  VARCHAR(64) NULL,
  views        BIGINT NULL,
  reach        BIGINT NULL,
  likes        BIGINT NULL,
  comments     BIGINT NULL,
  shares       BIGINT NULL,
  saves        BIGINT NULL,
  avg_watch_ms BIGINT NULL,
  error        VARCHAR(500) NULL,
  fetched_at   DATETIME NOT NULL,
  INDEX idx_post_metrics_platform (platform)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Audience size per platform per day (Tbilisi date), as the platform reports it.
CREATE TABLE IF NOT EXISTS account_metrics (
  platform   VARCHAR(20) NOT NULL,
  day        DATE NOT NULL,
  followers  BIGINT NULL,
  posts      BIGINT NULL,
  fetched_at DATETIME NOT NULL,
  PRIMARY KEY (platform, day)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 2026-11-11: Trending Sounds radar (services/trendSounds.js). Instagram's own
-- trending audio list (Instagram Audio API, GET /ig_audio), read every few hours.
-- One row per sound, plus one sighting per sound per read, so the panel can show
-- which sounds just started trending, which climb and which fade. Status: new
-- (waiting for the owner), approved (offered for Instagram posts), rejected.
CREATE TABLE IF NOT EXISTS trend_sounds (
  audio_id       VARCHAR(64) PRIMARY KEY,
  platform       VARCHAR(20) NOT NULL DEFAULT 'instagram',
  audio_type     VARCHAR(20) NOT NULL,
  title          VARCHAR(300) NULL,
  artist         VARCHAR(300) NULL,
  duration_ms    INT NULL,
  cover_url      TEXT NULL,
  preview_url    TEXT NULL,
  preview_link   TEXT NULL,
  ads_eligible   TINYINT(1) NULL,
  status         VARCHAR(12) NOT NULL DEFAULT 'new',
  first_seen_at  DATETIME NOT NULL,
  last_seen_at   DATETIME NOT NULL,
  first_position INT NULL,
  best_position  INT NULL,
  last_position  INT NULL,
  times_seen     INT NOT NULL DEFAULT 1,
  uses           INT NOT NULL DEFAULT 0,
  decided_at     DATETIME NULL,
  created_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_trend_status (status, last_seen_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS trend_sightings (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  run_at     DATETIME NOT NULL,
  audio_id   VARCHAR(64) NOT NULL,
  audio_type VARCHAR(20) NOT NULL,
  position   INT NOT NULL,
  INDEX idx_sight_audio (audio_id, run_at),
  INDEX idx_sight_run (run_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 2026-11-11: the owner's Recommendations (Content Studio). Free-text guidance
-- the autopilot follows when it picks sounds and writes hooks, end lines and
-- captions. areas = comma list of sounds, editing, captions, other.
CREATE TABLE IF NOT EXISTS recommendations (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  body       TEXT NOT NULL,
  areas      VARCHAR(100) NOT NULL DEFAULT 'sounds,editing,captions',
  active     TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 2026-11-11: Trending Sounds watch list - sounds found by searching
-- Instagram's audio library for the owner's terms (e.g. Fairuz). source =
-- trending (seen in Instagram's trending list) or watch (only found by a
-- search); watch_terms = the terms that found it; watch_seen_at = last time
-- a search found it.
ALTER TABLE trend_sounds ADD COLUMN source VARCHAR(12) NOT NULL DEFAULT 'trending';
ALTER TABLE trend_sounds ADD COLUMN watch_terms VARCHAR(400) NULL;
ALTER TABLE trend_sounds ADD COLUMN watch_seen_at DATETIME NULL;

-- 2026-11-12: Analyze & name (Library, services/mediaNamer.js). The system
-- looks at a library item and names it after what is in it. original_title
-- keeps the name it had before (a harvested video is recognised by it, and the
-- owner can restore it); title_source = ai | owner (NULL = never renamed);
-- ai_status = queued | working | done | failed; ai_facts = JSON measurements
-- (length, size, sound type...); ai_job_id = the worker's Describe job.
ALTER TABLE media ADD COLUMN original_title VARCHAR(255) NULL;
ALTER TABLE media ADD COLUMN title_source VARCHAR(8) NULL;
ALTER TABLE media ADD COLUMN ai_summary VARCHAR(600) NULL;
ALTER TABLE media ADD COLUMN ai_tags VARCHAR(400) NULL;
ALTER TABLE media ADD COLUMN ai_facts TEXT NULL;
ALTER TABLE media ADD COLUMN ai_status VARCHAR(12) NULL;
ALTER TABLE media ADD COLUMN ai_error VARCHAR(300) NULL;
ALTER TABLE media ADD COLUMN ai_job_id INT NULL;
ALTER TABLE media ADD COLUMN ai_requested_at DATETIME NULL;
ALTER TABLE media ADD COLUMN ai_named_at DATETIME NULL;

-- 2026-11-14: montages (services/montage.js) - the owner's short clips put
-- together. A clip's prep points at the montage it went into (status
-- in_montage); the montage itself is a media row of kind 'montage' with its
-- own prep, rendered by MagicCut and reviewed like any prepared video.
ALTER TABLE media_prep ADD COLUMN montage_id INT NULL;
