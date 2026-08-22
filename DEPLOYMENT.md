# Deployment Guide - Sam's Autonomous Social Media System

## Part 1: Local Development Testing

### Prerequisites
- Node.js 18+ installed
- PostgreSQL 12+ installed locally
- Git installed
- A code editor (VS Code recommended)

### Step 1: Clone & Install

```bash
cd D:/Project\ Sindbad/sams-social-system

# Install backend dependencies
cd backend
npm install

# Install frontend dependencies
cd ../frontend
npm install
```

### Step 2: Create Local Database

```bash
# Create database
createdb sams_social

# Run migrations
cd backend
node src/database/migrate.js

# Verify tables were created
psql -d sams_social -c "\dt"
```

### Step 3: Create .env File (Local)

Create `backend/.env`:

```bash
# Server
NODE_ENV=development
PORT=3000

# Database (Local PostgreSQL)
DATABASE_URL=postgresql://localhost/sams_social

# Owner
OWNER_EMAIL=issam.salih@gmail.com

# Claude API - GET FREE KEY FROM: https://console.anthropic.com
CLAUDE_API_KEY=sk-ant-v0-XXXXXXXXXXXXXXXXXXXXXXX

# Email - SKIP FOR LOCAL TESTING (optional)
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=your-email@gmail.com
SMTP_PASS=your-app-password
SMTP_FROM=noreply@sams.social

# Dashboard URL
DASHBOARD_URL=http://localhost:5173

# Platform OAuth - OPTIONAL FOR LOCAL TESTING
# Leave these blank until Phase 4 testing
TIKTOK_CLIENT_ID=
TIKTOK_CLIENT_SECRET=
TIKTOK_ACCESS_TOKEN=

INSTAGRAM_CLIENT_ID=
INSTAGRAM_CLIENT_SECRET=
INSTAGRAM_ACCESS_TOKEN=

FACEBOOK_APP_ID=
FACEBOOK_APP_SECRET=
FACEBOOK_ACCESS_TOKEN=

YOUTUBE_CLIENT_ID=
YOUTUBE_CLIENT_SECRET=
YOUTUBE_ACCESS_TOKEN=
```

### Step 4: Start Local Servers

**Terminal 1 - Backend:**
```bash
cd backend
npm start
```

Expected output:
```
╔════════════════════════════════════════════════════════╗
║   Sam's Autonomous Social Media System                 ║
║   Phases 1-7: Full Stack Implementation                ║
║                                                        ║
║   Server running on: http://localhost:3000             ║
║   Environment: development                             ║
║   Database: Connecting...                              ║
╚════════════════════════════════════════════════════════╝
```

**Terminal 2 - Frontend:**
```bash
cd frontend
npm run dev
```

Expected output:
```
  VITE v4.X.X  ready in XXX ms

  ➜  Local:   http://localhost:5173/
```

### Step 5: Test Local System

**Health Check:**
```bash
curl http://localhost:3000/health
```

Expected response:
```json
{
  "status": "ok",
  "timestamp": "2026-08-22T...",
  "service": "sams-social-backend",
  "orchestrator": "running"
}
```

**System Status:**
```bash
curl http://localhost:3000/api/status
```

**Dashboard:**
Open browser: `http://localhost:5173`

Login with:
- Email: `issam.salih@gmail.com`
- Password: (any password for Phase 1 testing)

---

## Part 2: Getting Required Credentials

### 1️⃣ Claude API Key (Required for Phase 3)

**Step-by-step:**
1. Go to https://console.anthropic.com
2. Sign up or login
3. Click "API Keys" in sidebar
4. Click "Create Key"
5. Name it: "Sam's Social Media"
6. Copy the key (starts with `sk-ant-`)
7. Add to `.env`: `CLAUDE_API_KEY=sk-ant-v0-...`

**Cost:** Pay-as-you-go. Estimate: ₾500/month for 3-5 posts/day

---

### 2️⃣ Platform OAuth Credentials (Required for Phase 4)

#### TikTok Developer Account

1. Go to https://developers.tiktok.com
2. Sign up for Business Account
3. Click "Create an app"
4. Choose "Web" platform
5. Fill in:
   - App name: "Sam's Social"
   - Redirect URI: `http://localhost:3000/api/platforms/tiktok/auth`
6. Get credentials:
   - Client ID
   - Client Secret
   - Add to `.env`:
     ```
     TIKTOK_CLIENT_ID=xxxxx
     TIKTOK_CLIENT_SECRET=xxxxx
     ```

#### Instagram Graph API

1. Go to https://developers.facebook.com
2. Create app → Business app → Business
3. Name: "Sam's Social"
4. Add Instagram product
5. Go to Settings → Basic
6. Get:
   - App ID → `INSTAGRAM_CLIENT_ID`
   - App Secret → `INSTAGRAM_CLIENT_SECRET`
7. Go to Tools → Graph API Explorer
8. Get access token → `INSTAGRAM_ACCESS_TOKEN`

#### Facebook API

1. Same Facebook developer app as above
2. Go to Settings → Basic
3. Get:
   - App ID → `FACEBOOK_APP_ID`
   - App Secret → `FACEBOOK_APP_SECRET`
4. Get access token from Graph API Explorer → `FACEBOOK_ACCESS_TOKEN`

#### YouTube Data API

1. Go to https://console.cloud.google.com
2. Create new project: "Sam's Social"
3. Search "YouTube Data API v3"
4. Enable it
5. Go to Credentials → Create API Key
6. Restrict to YouTube Data API v3
7. Add to `.env`:
   ```
   YOUTUBE_CLIENT_ID=xxxxx
   YOUTUBE_CLIENT_SECRET=xxxxx
   YOUTUBE_ACCESS_TOKEN=xxxxx
   ```

---

### 3️⃣ PostgreSQL Database (Required)

**For Local Testing (Already Done):**
- Already installed on your machine
- Database created: `sams_social`
- Tables migrated

**For Production:**
Choose one:

**Option A: Heroku PostgreSQL** (Easiest)
1. Create Heroku account: https://heroku.com
2. Create app: "sams-social"
3. Add PostgreSQL add-on (Hobby tier: free)
4. Copy connection string
5. Add to `.env`: `DATABASE_URL=postgres://...`

**Option B: AWS RDS** (More control)
1. Go to https://console.aws.amazon.com
2. RDS → Create database
3. PostgreSQL, Free tier
4. DB identifier: "sams-social"
5. Copy endpoint
6. Create connection string: `postgresql://user:password@endpoint/sams_social`

**Option C: DigitalOcean Managed Database** (Balance)
1. Go to https://cloud.digitalocean.com
2. Databases → Create Database Cluster
3. PostgreSQL
4. Get connection string
5. Add to `.env`

---

### 4️⃣ Email Service (Optional for Phase 1-3)

**For Local Testing:**
- Skip email setup (leave SMTP vars blank)

**For Production:**

**Option A: Gmail** (Free, limited)
1. Go to myaccount.google.com
2. Security → App Passwords
3. Generate app password for "Email"
4. Add to `.env`:
   ```
   SMTP_USER=your-email@gmail.com
   SMTP_PASS=xxxx xxxx xxxx xxxx (16-char password)
   ```

**Option B: SendGrid** (Professional, ₾50/month)
1. Go to https://sendgrid.com
2. Sign up
3. Create API key
4. Use SendGrid SMTP credentials
5. Add to `.env`

**Option C: AWS SES** (Cheap, ₾0.10 per 1000 emails)
1. Go to AWS Console
2. SES → Email Addresses → Verify your email
3. Get SMTP credentials
4. Add to `.env`

---

## Part 3: Production Deployment

### Architecture Options

#### Option 1: Heroku (Recommended for Starting)
**Cost:** ~₾50-100/month
- Backend: Heroku dyno
- Frontend: Vercel
- Database: Heroku PostgreSQL

**Setup:**
```bash
# Install Heroku CLI
npm install -g heroku

# Login
heroku login

# Create backend app
heroku create sams-social-backend

# Add PostgreSQL
heroku addons:create heroku-postgresql:hobby-dev

# Deploy
git push heroku main

# Set environment variables
heroku config:set CLAUDE_API_KEY=sk-ant-...
heroku config:set OWNER_EMAIL=issam.salih@gmail.com
# ... add all vars from .env
```

#### Option 2: DigitalOcean App Platform (Better Value)
**Cost:** ~₾50-80/month
- Backend: App Platform container
- Frontend: App Platform static site
- Database: Managed PostgreSQL

**Setup:**
1. Create DigitalOcean account
2. App Platform → Create App
3. Connect GitHub repo
4. Specify build command: `cd backend && npm install`
5. Specify start command: `node src/index.js`
6. Add environment variables
7. Deploy

#### Option 3: AWS (Most Control, Steeper Learning Curve)
**Cost:** ~₾100-200/month
- Backend: EC2 instance
- Frontend: CloudFront + S3
- Database: RDS PostgreSQL

---

### Production Deployment Checklist

**Before Going Live:**

- [ ] All 7 platform OAuth credentials obtained
- [ ] Claude API key tested and working
- [ ] PostgreSQL database created and migrated
- [ ] Email service configured and tested
- [ ] Environment variables set in production
- [ ] Backend deployed and running
- [ ] Frontend built and deployed
- [ ] Health check endpoint responding
- [ ] Database connection verified
- [ ] First test content generation successful
- [ ] Owner approval workflow tested
- [ ] First complete publish cycle successful

---

### Environment Variables for Production

Create `.env.production`:

```bash
# Server
NODE_ENV=production
PORT=3000

# Database
DATABASE_URL=postgresql://user:pass@host:5432/sams_social

# Owner
OWNER_EMAIL=issam.salih@gmail.com

# Claude API
CLAUDE_API_KEY=sk-ant-v0-...

# Platform OAuth - MUST HAVE ALL 4
TIKTOK_CLIENT_ID=xxxxx
TIKTOK_CLIENT_SECRET=xxxxx
TIKTOK_ACCESS_TOKEN=xxxxx

INSTAGRAM_CLIENT_ID=xxxxx
INSTAGRAM_CLIENT_SECRET=xxxxx
INSTAGRAM_ACCESS_TOKEN=xxxxx

FACEBOOK_APP_ID=xxxxx
FACEBOOK_APP_SECRET=xxxxx
FACEBOOK_ACCESS_TOKEN=xxxxx

YOUTUBE_CLIENT_ID=xxxxx
YOUTUBE_CLIENT_SECRET=xxxxx
YOUTUBE_ACCESS_TOKEN=xxxxx

# Email
SMTP_HOST=smtp.sendgrid.net
SMTP_PORT=587
SMTP_USER=apikey
SMTP_PASS=SG.xxxxx
SMTP_FROM=noreply@sams.social

# Dashboard
DASHBOARD_URL=https://sams-social.example.com

# Security
JWT_SECRET=your-secret-key-min-32-chars-long
```

---

### Production Security Checklist

- [ ] Never commit `.env` files to git
- [ ] Rotate API keys regularly
- [ ] Use HTTPS only (not HTTP)
- [ ] Enable CORS only for your domain
- [ ] Set database max connections
- [ ] Enable database backups
- [ ] Monitor error logs daily
- [ ] Set up uptime monitoring
- [ ] Enable rate limiting on APIs
- [ ] Regular security updates

---

### Monitoring & Maintenance

**Daily:**
- Check `/health` endpoint
- Review error logs
- Monitor database disk usage
- Check API response times

**Weekly:**
- Review system status (`/api/status`)
- Check agent cycle completion
- Verify content generation
- Audit platform credentials (not expired)

**Monthly:**
- Database backups
- API usage review (Claude costs)
- Platform quota checks
- Security log review

---

### Troubleshooting Production Issues

**Database Connection Fails:**
```bash
# Test connection
psql $DATABASE_URL

# Check connection string format
postgresql://user:password@host:5432/dbname
```

**Backend won't start:**
```bash
# Check logs
npm start

# Verify all env vars set
heroku config (if using Heroku)

# Check Node version
node --version
```

**Frontend can't reach backend:**
```bash
# Check CORS configuration
# Verify API_URL is correct
# Check backend is running
curl https://api.example.com/health
```

**Content creation fails:**
```bash
# Test Claude API key
curl https://api.anthropic.com/v1/models \
  -H "x-api-key: $CLAUDE_API_KEY"

# Check remaining token budget
```

**Email notifications not working:**
```bash
# Test SMTP connection
# Verify SMTP credentials
# Check email service quota
# Review error logs
```

---

## Part 4: Scaling to Production

### Phase 1-2 (Weeks 1-4): Monitoring
- Run locally, monitor system
- Test all agents in development
- Collect initial data

### Phase 3-4 (Weeks 5-8): Deploy
- Deploy to production
- Configure platform OAuth
- Generate first batch of content
- Publish to all platforms

### Phase 5-6 (Weeks 9-16): Optimize
- Monitor analytics daily
- Run A/B tests
- Adjust strategy based on data
- Scale to 5-7 posts/day

### Phase 7+ (Month 4+): Monetize
- Track Creator Fund eligibility
- Apply for monetization programs
- Monitor revenue
- Plan next growth phase

---

## Success Metrics - First Month

| Metric | Target | How to Check |
|--------|--------|-------------|
| System Uptime | 99%+ | `/health` endpoint |
| Content Generated | 20+ posts | `/api/content` |
| Publishing Success | 95%+ | `/api/status` analytics |
| API Response Time | <200ms | Monitor in dashboard |
| Database Size | <100MB | Database admin panel |

---

## Getting Help

**System Issues:**
- Check `/health` and `/api/status` endpoints
- Review logs in terminal
- Check `.env` configuration
- Verify database connection

**Platform Issues:**
- Check platform API documentation
- Verify OAuth credentials are current
- Check platform rate limits
- Review platform error responses

**Code Issues:**
- Check AGENTS.md for agent documentation
- Review backend/src/agents/ code
- Check database schema (schema.sql)
- Review API endpoints (backend/src/routes/)

---

**Ready to start local testing? Follow Part 1 above!**
