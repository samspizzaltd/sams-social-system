# Local Testing Guide

Get Sam's Autonomous Social Media System running on your machine in **5 minutes**.

---

## Prerequisites Check

```bash
# Node.js 18+
node --version
# Expected: v18.0.0 or higher

# PostgreSQL 12+
psql --version
# Expected: psql (PostgreSQL) 12.0 or higher

# Git
git --version
```

If you're missing any, install them:
- **Node.js:** https://nodejs.org (LTS version)
- **PostgreSQL:** https://www.postgresql.org/download
- **Git:** https://git-scm.com

---

## Step 1: Create Database (2 minutes)

```bash
# Create database
createdb sams_social

# Verify it was created
psql -d sams_social -c "SELECT version();"

# Run migrations (creates 9 tables)
cd backend
node src/database/migrate.js

# Verify tables were created
psql -d sams_social -c "\dt"
```

Expected output:
```
         List of relations
 Schema |   Name   | Type  |  Owner
--------+----------+-------+--------
 public | accounts | table | postgres
 public | analytics| table | postgres
 public | branding | table | postgres
 public | comments | table | postgres
 public | competitors | table | postgres
 public | content  | table | postgres
 public | media    | table | postgres
 public | trends   | table | postgres
 public | users    | table | postgres
```

---

## Step 2: Setup Environment (1 minute)

```bash
# Copy template to actual .env
cd backend
cp .env.example .env
```

Open `backend/.env` and edit:

```bash
# Minimum for Phase 1-2 testing:
DATABASE_URL=postgresql://localhost/sams_social
OWNER_EMAIL=issam.salih@gmail.com

# For Phase 3 (content generation), add:
CLAUDE_API_KEY=sk-ant-v0-XXXXX
# Get free key: https://console.anthropic.com
```

---

## Step 3: Start Servers (1 minute)

### Option A: Automatic (Windows)
```bash
# Double-click START_LOCAL.bat
START_LOCAL.bat
```

This opens two terminal windows:
- Terminal 1: Backend (port 3000)
- Terminal 2: Frontend (port 5173)

### Option B: Automatic (Mac/Linux)
```bash
chmod +x START_LOCAL.sh
./START_LOCAL.sh
```

### Option C: Manual (All Platforms)

**Terminal 1:**
```bash
cd backend
npm install
npm start
```

**Terminal 2:**
```bash
cd frontend
npm install
npm run dev
```

---

## Step 4: Access Dashboard (1 minute)

Open your browser:
```
http://localhost:5173
```

Login:
- Email: `issam.salih@gmail.com`
- Password: `(any password - Phase 1 testing)`

You should see:
```
Dashboard
├─ Overview tab (with status cards)
├─ Content tab (for managing posts)
├─ Analytics tab (for metrics)
└─ Settings tab (for configuration)
```

---

## Testing the Agents

### Phase 2: Intelligence (Research Engine)

**Test manually:**
```bash
# In a third terminal, hit the Research endpoint
curl http://localhost:3000/api/agents/intelligence/analyze

# Expected response: Trends, competitors, opportunities
```

**In code:**
- Check `/backend/src/agents/IntelligenceCoordinator.js`
- Runs every 24 hours automatically
- Can trigger via API endpoint

### Phase 3: Content Creation (Production)

**Requirements:**
1. Set `CLAUDE_API_KEY` in `.env`
2. Wait for Phase 2 research to complete

**Test manually:**
```bash
# Generate content
curl -X POST http://localhost:3000/api/agents/production/generate \
  -H "Content-Type: application/json" \
  -d '{}'

# Expected: Scripts and captions generated
```

**Watch it happen:**
- Content appears in database
- Owner gets email notification
- Dashboard shows pending approvals

### Phase 4: Publishing (Platforms)

**Requirements:**
1. Platform OAuth credentials (see DEPLOYMENT.md)
2. Approved content from Phase 3

**Status without credentials:**
```bash
# Check platform status
curl http://localhost:3000/api/agents/publishing

# Shows: "Awaiting OAuth setup"
```

### Phase 5: Analytics (Metrics)

**Syncs automatically:**
- Every 24 hours from all platforms
- Shows real metrics once Phase 4 is live

**Test manually:**
```bash
# Get performance summary
curl http://localhost:3000/api/agents/analytics/summary
```

### Phase 6: Optimization (Learning Loop)

**Runs automatically:**
- Every 3 days
- Analyzes patterns
- Runs A/B tests
- Generates recommendations

**Test pattern detection:**
```bash
# Analyze patterns from published content
curl http://localhost:3000/api/agents/learning/optimize
```

### Phase 7: Monetization (Revenue)

**Monitors automatically:**
- Weekly eligibility checks
- Creator Fund progress
- Revenue projections

**Check status:**
```bash
# Get monetization status
curl http://localhost:3000/api/agents/monetization/status
```

---

## API Endpoints for Testing

```bash
# Health check
curl http://localhost:3000/health

# System status
curl http://localhost:3000/api/status

# List all agents
curl http://localhost:3000/api/agents

# Execute agent actions
curl -X POST http://localhost:3000/api/agents/intelligence/analyze
curl -X POST http://localhost:3000/api/agents/production/generate
curl -X POST http://localhost:3000/api/agents/analytics/sync
curl -X POST http://localhost:3000/api/agents/learning/optimize
```

---

## Troubleshooting

### "Connection refused" on startup

**Issue:** Backend won't start
```
Error: connect ECONNREFUSED 127.0.0.1:5432
```

**Solution:** PostgreSQL not running
```bash
# Mac
brew services start postgresql

# Linux
sudo service postgresql start

# Windows
# Start PostgreSQL service in Services app
```

### "Database does not exist"

```bash
# Create it
createdb sams_social

# Migrate tables
node backend/src/database/migrate.js
```

### ".env file not found"

```bash
# Copy template
cp backend/.env.example backend/.env
# Edit and add your Claude API key
```

### Frontend can't reach backend

```bash
# Check backend is running
curl http://localhost:3000/health

# Check CORS is enabled (should be by default)
# Check frontend is on right port: http://localhost:5173
```

### "CLAUDE_API_KEY not valid"

```bash
# Get free key from: https://console.anthropic.com
# Make sure to set in backend/.env
# Restart backend after changing .env
```

---

## Testing Checklist

- [ ] Database created and migrated
- [ ] Backend running on port 3000
- [ ] Frontend running on port 5173
- [ ] Dashboard loads at http://localhost:5173
- [ ] Can login (any password)
- [ ] Health check: `curl http://localhost:3000/health`
- [ ] System status: `curl http://localhost:3000/api/status`
- [ ] Agents listed: `curl http://localhost:3000/api/agents`

---

## Performance & Memory

**Typical resource usage:**

| Component | RAM | CPU | Notes |
|-----------|-----|-----|-------|
| Backend (Node.js) | 50-100 MB | 1-5% | Idle |
| Frontend (Vite) | 100-150 MB | 1-3% | Development |
| PostgreSQL | 100-200 MB | 2-5% | Idle |
| **Total** | **~300-450 MB** | **<15%** | Normal operation |

---

## Monitoring During Testing

### Terminal 1 (Backend) - Watch for:
```
✓ Database connection established
✓ Server running on http://localhost:3000
🧠 [INTELLIGENCE COORDINATOR] Initializing...
✓ Research cycle: Every 24 hours
✓ Content vault: Every 12 hours
🎬 [PRODUCTION COORDINATOR] Initializing...
✓ Production cycle: Every 7 days
```

### Terminal 2 (Frontend) - Watch for:
```
VITE v5.X.X ready in XXX ms
➜ Local: http://localhost:5173/
```

### Browser Console - Watch for:
- No red error messages
- API requests completing (check Network tab)
- State updates working

---

## Next Steps After Local Testing

1. **Phase 1 Verification** (✓ Should already work)
   - Database ✓
   - Auth ✓
   - Dashboard ✓

2. **Phase 2 Verification** (Should work)
   - Research Engine running ✓
   - Content Vault indexing ✓

3. **Phase 3 Verification** (Requires Claude API key)
   - Content generation ✓
   - Approval workflow ✓

4. **Phase 4+ Verification** (Requires platform credentials)
   - See DEPLOYMENT.md for credential setup
   - Test platform OAuth flow
   - Test publishing to each platform

---

## Common Questions

**Q: Can I run everything on localhost?**
A: Yes! All services can run on your local machine. Good for testing.

**Q: How do I test content generation?**
A: Set CLAUDE_API_KEY in .env, then curl the production endpoint.

**Q: Can I test publishing without platform credentials?**
A: No, but the publishing engine will simulate responses.

**Q: How do I reset everything?**
A: 
```bash
dropdb sams_social
createdb sams_social
node backend/src/database/migrate.js
```

**Q: Can I use a hosted database instead of local?**
A: Yes! Set DATABASE_URL to your hosted database URL in .env

**Q: How do I see what the agents are doing?**
A: Check backend terminal output - all agent activity is logged.

---

## Ready?

```bash
# Quick start
./START_LOCAL.bat          # Windows
# or
./START_LOCAL.sh           # Mac/Linux

# Then open: http://localhost:5173
```

**Expected startup time: ~30 seconds**

---

*Last Updated: 2026-08-22*
*Status: Ready for Local Testing ✓*
