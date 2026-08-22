# Sam's Autonomous Social Media System - Agent Documentation

## System Overview

The system is built on a **7-phase agent architecture** where each phase introduces new autonomous capabilities. Agents work in a coordinated pipeline, with data flowing from Research → Production → Publishing → Analytics → Learning → Monetization.

---

## Phase 1: Foundation (✓ Complete)
**Status:** Live
**Components:** Database, Authentication, Dashboard

No autonomous agents in Phase 1. This layer provides the infrastructure for all downstream agents.

---

## Phase 2: Intelligence Coordinator
**Status:** Running (24/7 monitoring)
**Cycle:** Every 24 hours (research), Every 12 hours (vault)

### Core Agents:

#### 🔍 Research Engine
**Purpose:** Discover trends, opportunities, and market insights

**Components:**
- **TikTok Content Analyzer:** Historical performance analysis
  - Analyzes best-performing content types
  - Identifies optimal posting times
  - Detects trending hashtags and audio
  - Benchmarks engagement rates

- **Competitor Intelligence:** Track local and global competitors
  - Monitors competitor account activity
  - Analyzes their top-performing content
  - Identifies content gaps (opportunities)
  - Suggests differentiation strategies

- **Trend Monitor:** Real-time trend detection
  - Tracks viral keywords and hashtags
  - Measures search volume and growth
  - Assigns relevance scores
  - Alerts on emerging opportunities

- **Keyword Research:** Social SEO optimization
  - Identifies high-volume, low-competition keywords
  - Suggests hashtag combinations
  - Analyzes search intent
  - Provides difficulty scores

**Output Example:**
```json
{
  "trends": [
    {
      "keyword": "FoodASMR",
      "volume": 2400000,
      "growth": "+45%",
      "relevance": "HIGH"
    }
  ],
  "competitors": {
    "gaps": ["Story content", "Behind-the-scenes"],
    "opportunities": ["Story-driven series", "Employee spotlights"]
  }
}
```

#### 📚 Content Vault
**Purpose:** Index historical performance and manage content library

**Components:**
- **Media Library:** Organize and track all video/image files
  - Storage usage tracking
  - File type organization
  - Resolution and duration management
  - Auto-tagging support

- **Performance Tracker:** Analyze top-performing content
  - Ranks content by engagement rate
  - Identifies content formats that work
  - Detects viral patterns
  - Generates performance insights

- **Content Catalog:** Searchable content database
  - Query content by platform
  - Filter by performance metrics
  - Track publication status
  - Compare similar content

**Output Example:**
```json
{
  "topPerformers": [
    {
      "title": "Halloumi Fries Close-up",
      "engagement": 7.2,
      "views": 45000,
      "format": "Food Close-up"
    }
  ],
  "mediaLibrary": {
    "videos": 247,
    "storage": "8.2 GB",
    "avgDuration": "18 seconds"
  }
}
```

### Intelligence Coordinator Flow:
```
24-hour cycle:
├─ Research Engine analyzes markets
├─ Content Vault indexes historical data
├─ Patterns are extracted
└─ Recommendations fed to Production Coordinator
```

---

## Phase 3: Production Coordinator
**Status:** Running (weekly production cycles)
**Cycle:** Every 7 days (content generation), On-demand (approvals)

### Core Agents:

#### ✍️ Content Creation Engine
**Purpose:** Generate high-quality, platform-optimized content

**Components:**
- **Script Generator:** AI-powered script writing via Claude API
  - Generates 15-30 second TikTok scripts
  - Creates platform-specific calls-to-action
  - Adapts tone (casual, energetic, educational)
  - Includes visual cues in [brackets]

- **Caption Generator:** Multi-language caption creation
  - Georgian, English, and Arabic support
  - Platform-specific formatting
  - Hashtag insertion
  - Emoji optimization

- **Multilingual Processor:** Text validation and localization
  - Validates Georgian (ქ) characters
  - Validates Arabic (ع) characters
  - Handles RTL text properly
  - Prevents encoding issues

- **Content Vault Manager:** Metadata tagging
  - Auto-tags content with topic/category
  - Assigns estimated reach
  - Creates content relationships
  - Tracks content source

**Output Example:**
```json
{
  "id": "content_1693567890_abc123",
  "topic": "Food Close-up",
  "script": "[ZOOM IN on sizzling food] Watch this 🔥\n[SHOW fries] Crispy perfection\n[BITE SHOT] Taste the quality",
  "captions": {
    "Georgian": "🤤 ხელმოკიდებული პიცა...",
    "English": "🔥 Best pizza in Tbilisi...",
    "Arabic": "🤤 أفضل البيتزا في تبليسي..."
  },
  "status": "draft",
  "requiresApproval": true
}
```

#### ✅ Approval Workflow
**Purpose:** Owner review and content authorization

**Components:**
- **Submission System:** Queue content for review
  - Assigns submission timestamps
  - Tracks approval duration
  - Stores submission metadata

- **Notification System:** Email alerts to owner
  - Sends review requests
  - Includes preview content
  - Links to dashboard approval UI
  - Tracks notification delivery

- **Approval Handler:** Process owner decisions
  - Updates content status to "approved"
  - Flags content as "ready_to_publish"
  - Records approval timestamp and approver

- **Rejection Handler:** Manage content refunds
  - Stores rejection reason
  - Allows content modification
  - Resubmission workflow
  - Learning feedback loop

**Approval States:**
```
draft → pending_approval → approved → ready_to_publish
                      ↓
                    rejected → (modify) → resubmit
```

### Production Coordinator Flow:
```
Weekly cycle (7 days):
├─ Content Creation Engine generates:
│  ├─ 3 TikTok videos
│  ├─ 2 Instagram Reels
│  └─ Optional Facebook/YouTube content
├─ All content submitted for approval
├─ Owner reviews (email notification)
├─ Approved content queued for publishing
└─ Rejected content returned for revision
```

---

## Phase 4: Publishing Engine
**Status:** Running (on-demand publishing)
**Cycle:** Triggered by approval workflow

### Core Agents:

#### 🚀 Platform Adapters
**Purpose:** Publish to multiple platforms simultaneously

**TikTok Adapter:**
- OAuth token management
- Direct video upload API
- Caption + hashtag formatting
- Hashtag trending check
- Post scheduling support

**Instagram Adapter:**
- Graph API integration
- Reel publishing
- Carousel support
- Story scheduling
- Engagement tracking

**Facebook Adapter:**
- Video publishing
- Feed posting
- Scheduling support
- Community management
- Analytics collection

**YouTube Adapter:**
- Shorts publishing
- Video metadata optimization
- SEO description generation
- Playlist management
- Channel growth tracking

**Publishing Response:**
```json
{
  "contentId": "content_123",
  "platforms": {
    "tiktok": {
      "postId": "7123456789",
      "url": "https://www.tiktok.com/@samspizzaltd/video/7123456789",
      "publishedAt": "2026-08-22T20:15:30Z"
    },
    "instagram": {
      "postId": "18456789",
      "url": "https://www.instagram.com/p/18456789/",
      "publishedAt": "2026-08-22T20:16:00Z"
    }
  }
}
```

#### 📅 Scheduler
**Purpose:** Publish at optimal times

**Logic:**
- Learns best posting times from analytics
- Queues content for future publishing
- Handles timezone adjustments
- Respects platform rate limits

**Configuration:**
```
TikTok:  3 posts/day → 9:00, 16:00, 20:00
Instagram: 2 posts/day → 12:00, 19:00
Facebook: 1 post/day → 18:00
YouTube: 1 video/week → Friday 20:00
```

#### 🔄 Queue Manager
**Purpose:** Manage publishing queue and rate limits

**Features:**
- Rate limiting per platform
- Backoff logic for failures
- Queue prioritization
- Batch publishing support

#### 🛡️ Error Recovery
**Purpose:** Handle and recover from failures

**Retry Logic:**
- Exponential backoff: 1h → 4h → 24h
- Max 3 retry attempts
- Detailed error logging
- Fallback notifications

---

## Phase 5: Analytics Engine
**Status:** Running (daily sync)
**Cycle:** Every 24 hours (data sync), Real-time (engagement)

### Core Agents:

#### 📡 Data Sync
**Purpose:** Collect metrics from all platforms

**Syncs:**
- Views, likes, shares, comments per post
- Engagement rate calculation
- Audience demographics (when available)
- Comment sentiment analysis
- Platform-specific metrics

**Sync Results:**
```json
{
  "tiktok": {
    "totalPosts": 47,
    "totalViews": 1250000,
    "avgEngagement": 6.2,
    "topPost": 45000
  }
}
```

#### 📊 Performance Dashboard
**Purpose:** Real-time metrics visualization

**Metrics Tracked:**
- Total views by platform
- Engagement rate trending
- Audience growth
- Top performing content
- Time-series analytics

#### 💬 Engagement Analysis
**Purpose:** Monitor and respond to comments

**Features:**
- Sentiment classification
- Question detection
- Urgency scoring
- Response recommendations
- Community insights

#### 🎯 Attribution Tracker
**Purpose:** Connect orders to social channels

**Logic:**
- Tracks referral source (QR code, link, mention)
- Links orders to social posts
- Calculates ROI per platform
- Identifies high-converting content

**Attribution Report:**
```json
{
  "tiktok": { "orders": 24, "revenue": "₾960" },
  "instagram": { "orders": 18, "revenue": "₾720" },
  "facebook": { "orders": 8, "revenue": "₾320" }
}
```

#### 📧 Report Generator
**Purpose:** Weekly summary emails to owner

**Content:**
- Performance highlights
- Top 5 posts
- Engagement summary
- Growth metrics
- Recommendations

---

## Phase 6: Learning Loop Engine
**Status:** Running (optimization every 3 days)
**Cycle:** Every 3 days

### Core Agents:

#### 🔍 Pattern Detector
**Purpose:** Identify winning content patterns

**Patterns Detected:**
- Topic preferences (food close-ups: 7.2% engagement)
- Best posting times (20:00-21:00)
- Optimal post frequency
- High-performing content types
- Audience preferences

**Pattern Output:**
```json
{
  "topicPatterns": {
    "Food Close-ups": 15,
    "Behind-the-scenes": 12,
    "Customer Testimonials": 9
  },
  "platformPatterns": {
    "tiktok": 7.2,
    "instagram": 5.8
  },
  "timingPatterns": {
    "bestHours": ["20:00", "21:00", "12:00"],
    "bestDays": ["Friday", "Saturday"]
  }
}
```

#### 🧪 A/B Test Framework
**Purpose:** Systematic content experimentation

**Active Tests:**
1. **Post Timing:** 19:00 vs 20:30 (variant_b winning 92%)
2. **Caption Length:** Short vs Medium (medium winning 85%)
3. **Hashtag Count:** 3 vs 8 (8 winning 88%)

**Test Analysis:**
- Tracks engagement per variant
- Calculates statistical significance
- Recommends winner after threshold
- Auto-applies winning strategy

#### ⚙️ Strategy Optimizer
**Purpose:** Generate optimized content strategy

**Optimizations:**
- Posting times adjusted based on historical data
- Content mix adjusted (40% close-ups, 35% behind-scenes, 25% testimonials)
- Caption strategy updated (medium length, 8 hashtags, 2-3 emojis)
- Platform allocation adjusted (50% TikTok, 35% Instagram, 10% Facebook, 5% YouTube)

**Output:**
```json
{
  "postTiming": {
    "weekday": "20:00",
    "weekend": "19:00",
    "frequency": "3x TikTok, 2x Instagram"
  },
  "contentMix": {
    "foodCloseups": "40%",
    "behindTheScenes": "35%",
    "customerTestimonials": "25%"
  }
}
```

#### 💡 Recommendation Engine
**Purpose:** Suggest next content topics

**Recommendations:**
- High priority: "Create Food Preparation series" (7.2% engagement potential)
- Medium priority: "Increase testimonials to 30% of mix"
- Medium priority: "Focus TikTok algorithm (35% growth)"

---

## Phase 7: Monetization Monitor
**Status:** Running (weekly review)
**Cycle:** Every 7 days

### Core Agents:

#### 💰 Eligibility Checker
**Purpose:** Track monetization program eligibility

**Programs Tracked:**

**TikTok Creator Fund:**
- Requirements: 10K followers, 100K views/30 days
- Current Status: Views tracking (pending followers)
- Estimated Revenue: $200-$5000/month
- Target: Q4 2026

**Instagram Badges:**
- Requirements: 10K followers, consistent posting
- Current Status: In progress
- Estimated Revenue: $50-$500/month
- Target: Q1 2027

**YouTube Partner Program:**
- Requirements: 1K subscribers, 4K watch hours
- Current Status: Not yet eligible
- Estimated Revenue: $100-$10000/month
- Target: Q2 2027

**Facebook In-Stream Ads:**
- Requirements: 10K followers, video content
- Current Status: Awaiting approval
- Estimated Revenue: $50-$2000/month
- Target: Q4 2026

#### 💵 Revenue Tracker
**Purpose:** Monitor and project revenue

**Tracking:**
- Creator Fund earnings (real-time sync)
- Brand deal opportunities
- Affiliate commissions
- Merchandise sales
- Sponsorship deals

**Projection Logic:**
- Calculates based on views and engagement
- Conservative 3-month estimate
- Moderate 6-month estimate
- Aggressive 12-month estimate

#### 🚨 Opportunity Alert
**Purpose:** Notify of new monetization features

**Monitored Opportunities:**
- TikTok Shop integration ($high potential)
- Brand collaboration partnerships
- Creator Fund updates
- New ad formats
- Seasonal monetization campaigns

#### ✅ Compliance Checker
**Purpose:** Ensure platform policy compliance

**Checks:**
- Community guidelines violations
- Copyright strikes
- Age-appropriate content
- Ad-friendly content ratings
- Account standing status

**Status:** Good Standing (0 strikes, 0 issues)

---

## System Orchestrator
**Purpose:** Master coordinator for all agents

**Responsibilities:**
- Initialize all phase agents on startup
- Manage agent lifecycle (start, stop, restart)
- Route API requests to appropriate agents
- Handle cross-agent communication
- Monitor system health
- Display unified status dashboard

**API Endpoints:**
```
GET    /api/agents                    - List all agents
GET    /api/status                    - System status
POST   /api/agents/:name/:action      - Execute agent action
GET    /health                        - Health check
```

---

## Data Flow Visualization

```
WEEK 1-2 (PHASE 1-2):
Research Engine scans market
    ↓
Content recommendations generated
    ↓

WEEK 3-4 (PHASE 3):
Content Creation Engine writes scripts
    ↓
Caption Generator creates multilingual captions
    ↓
Approval Workflow sends to owner
    ↓
Owner reviews and approves
    ↓

WEEK 5-7 (PHASE 4):
Publishing Engine queues content
    ↓
Scheduler selects optimal time
    ↓
Platform Adapters publish simultaneously
    ├→ TikTok (3/day)
    ├→ Instagram (2/day)
    ├→ Facebook (1/day)
    └→ YouTube (1/week)
    ↓

CONTINUOUS (PHASE 5):
Analytics Engine syncs metrics (daily)
    ↓
Performance Dashboard updated (real-time)
    ↓
Attribution Tracker links orders
    ↓

EVERY 3 DAYS (PHASE 6):
Learning Loop analyzes patterns
    ↓
A/B Tests run automatically
    ↓
Strategy Optimizer adjusts tactics
    ↓
Recommendations fed back to Research
    ↓

EVERY 7 DAYS (PHASE 7):
Monetization Monitor reviews eligibility
    ↓
Revenue Tracker projects earnings
    ↓
Opportunity Alert notifies owner
    ↓
Compliance Checker verifies standing
```

---

## Environment Variables Required

All agents need these configured in `.env`:

```
# Claude API (Content Generation)
CLAUDE_API_KEY=sk-...

# Database
DATABASE_URL=postgresql://user:pass@host/dbname

# Owner Email
OWNER_EMAIL=issam.salih@gmail.com

# Platform OAuth (Phase 4+)
TIKTOK_CLIENT_ID=...
TIKTOK_CLIENT_SECRET=...
TIKTOK_ACCESS_TOKEN=...

INSTAGRAM_CLIENT_ID=...
INSTAGRAM_CLIENT_SECRET=...
INSTAGRAM_ACCESS_TOKEN=...

FACEBOOK_APP_ID=...
FACEBOOK_APP_SECRET=...
FACEBOOK_ACCESS_TOKEN=...

YOUTUBE_CLIENT_ID=...
YOUTUBE_CLIENT_SECRET=...
YOUTUBE_ACCESS_TOKEN=...

# Email Notifications
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=...
SMTP_PASS=...
SMTP_FROM=noreply@sams.social

# Dashboard
DASHBOARD_URL=http://localhost:5173
```

---

## Success Metrics

| Metric | Target | Timeline |
|--------|--------|----------|
| TikTok Followers | 50K | Dec 2026 |
| TikTok Followers | 500K | Dec 2027 |
| Avg Engagement | 5-8% | Ongoing |
| Daily Posts | 3-5 | Week 8+ |
| Creator Fund Eligible | Yes | Q4 2026 |
| Monthly Revenue | $500+ | Q1 2027 |

---

## Development Status

✅ **Phase 1:** Complete - Database, Auth, Dashboard
✅ **Phase 2:** Complete - Research Engine, Content Vault
✅ **Phase 3:** Complete - Content Creation, Approval Workflow
✅ **Phase 4:** Complete - Publishing Engine, Platform Adapters
✅ **Phase 5:** Complete - Analytics Engine, Data Sync
✅ **Phase 6:** Complete - Learning Loop, Optimization
✅ **Phase 7:** Complete - Monetization Monitor

**All 7 phases fully implemented and integrated.**

---

*Last Updated: 2026-08-22*
*System Version: 0.7.0*
