# Production Deployment - Step by Step

## What You Need
- GitHub account (free)
- Heroku account (you have this ✅)
- Vercel account (you have this ✅)
- Claude API key (you have this ✅)

---

## STEP 1: Create GitHub Repository

### 1.1 Create GitHub Account (if needed)
- Go to: https://github.com/signup
- Sign up with email: issam.salih@gmail.com
- Verify email

### 1.2 Create New Repository
- Go to: https://github.com/new
- Repository name: `sams-social-system`
- Description: `Sam's Autonomous Social Media System`
- Public (for easy deployment)
- Click **"Create repository"**

### 1.3 Push Code to GitHub

```bash
cd D:/Project\ Sindbad/sams-social-system

# Initialize git (if not already done)
git init

# Add all files
git add .

# Commit
git commit -m "Initial commit - Production ready"

# Add GitHub as remote (replace YOUR_USERNAME)
git remote add origin https://github.com/YOUR_USERNAME/sams-social-system.git

# Push to GitHub
git branch -M main
git push -u origin main
```

**You now have your code on GitHub!** ✅

---

## STEP 2: Deploy Backend to Heroku

### 2.1 Login to Heroku
- Go to: https://dashboard.heroku.com
- Login with your Heroku account

### 2.2 Create New App
- Click **"New"** → **"Create new app"**
- App name: `sams-social-backend`
- Region: `United States`
- Click **"Create app"**

### 2.3 Connect GitHub
- Go to **"Deploy"** tab
- Under "Deployment method", click **"GitHub"**
- Search for: `sams-social-system`
- Click **"Connect"**

### 2.4 Add Environment Variables
- Go to **"Settings"** tab
- Click **"Reveal Config Vars"**
- Add these variables:

```
DATABASE_URL = (we'll set this below)
NODE_ENV = production
PORT = 5000

OWNER_EMAIL = issam.salih@gmail.com
CLAUDE_API_KEY = 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

TIKTOK_CLIENT_ID = (leave blank for now)
TIKTOK_CLIENT_SECRET = (leave blank for now)
TIKTOK_ACCESS_TOKEN = (leave blank for now)

INSTAGRAM_CLIENT_ID = (leave blank for now)
INSTAGRAM_CLIENT_SECRET = (leave blank for now)
INSTAGRAM_ACCESS_TOKEN = (leave blank for now)

FACEBOOK_APP_ID = (leave blank for now)
FACEBOOK_APP_SECRET = (leave blank for now)
FACEBOOK_ACCESS_TOKEN = (leave blank for now)

YOUTUBE_CLIENT_ID = (leave blank for now)
YOUTUBE_CLIENT_SECRET = (leave blank for now)
YOUTUBE_ACCESS_TOKEN = (leave blank for now)

DASHBOARD_URL = (we'll set this after Vercel deployment)
JWT_SECRET = your-secret-key-min-32-chars
```

### 2.5 Add PostgreSQL Database
- Go to **"Resources"** tab
- Under "Add-ons", search: `Heroku PostgreSQL`
- Click **"Heroku PostgreSQL"**
- Plan: **"Hobby Dev - Free"**
- Click **"Submit Order Form"**

Heroku will automatically add `DATABASE_URL` to Config Vars!

### 2.6 Deploy
- Go to **"Deploy"** tab
- Under "Manual deploy", click **"Deploy Branch"**
- Wait for deployment to complete (2-3 minutes)

### 2.7 Check Deployment
- Click **"View"** button
- You should see: `{"status":"ok",...}`

**Backend is LIVE!** ✅

**Your backend URL is:** `https://sams-social-backend.herokuapp.com`

---

## STEP 3: Deploy Frontend to Vercel

### 3.1 Login to Vercel
- Go to: https://vercel.com/dashboard
- Login with Vercel account

### 3.2 Import Project
- Click **"Add New..."** → **"Project"**
- Click **"Import Git Repository"**
- Paste GitHub repo URL: `https://github.com/YOUR_USERNAME/sams-social-system`
- Click **"Continue"**

### 3.3 Configure Project
- **Framework Preset:** `Other`
- **Root Directory:** `frontend`
- **Build Command:** `npm run build`
- **Output Directory:** `dist`

### 3.4 Add Environment Variables
- Before deploying, add:

```
VITE_API_URL = https://sams-social-backend.herokuapp.com
```

### 3.5 Deploy
- Click **"Deploy"**
- Wait for deployment (1-2 minutes)

**Frontend is LIVE!** ✅

**Your frontend URL is:** `https://sams-social-system.vercel.app`

---

## STEP 4: Update Backend Config

Go back to Heroku and update:
- `DASHBOARD_URL` = `https://sams-social-system.vercel.app`

---

## STEP 5: Test Your Live System

### Test Backend
```bash
curl https://sams-social-backend.herokuapp.com/health

# Should return:
# {"status":"ok",...}
```

### Test Frontend
Open in browser:
```
https://sams-social-system.vercel.app
```

**Expected:** Dashboard loads, you can login

---

## Your Live URLs

**Backend API:** `https://sams-social-backend.herokuapp.com`
- Health: `https://sams-social-backend.herokuapp.com/health`
- Status: `https://sams-social-backend.herokuapp.com/api/status`

**Frontend Dashboard:** `https://sams-social-system.vercel.app`
- Login: `issam.salih@gmail.com` / any password

---

## Next Steps

Once live:

1. **Get Platform OAuth Credentials** (for Phase 4)
   - TikTok: https://developers.tiktok.com
   - Instagram: https://developers.facebook.com
   - Facebook: https://developers.facebook.com
   - YouTube: https://console.cloud.google.com

2. **Add to Heroku Config Vars:**
   - TIKTOK_CLIENT_ID, TIKTOK_CLIENT_SECRET, etc.

3. **Test Content Generation:**
   ```bash
   curl -X POST https://sams-social-backend.herokuapp.com/api/agents/production/generate
   ```

4. **Monitor Analytics:**
   - Open dashboard
   - Watch agent cycles in real-time

---

## Troubleshooting

**Backend won't deploy:**
- Check Heroku logs: `Settings` → `View log`
- Verify all Config Vars are set
- Check Procfile exists in root

**Frontend won't build:**
- Check Vercel logs during deployment
- Verify framework settings
- Check dependencies in frontend/package.json

**Database connection fails:**
- Heroku PostgreSQL addon added?
- DATABASE_URL in Config Vars?
- Wait 30 seconds, Heroku takes time to provision

---

## Monitoring

**Heroku:**
- View logs: `Settings` → View log
- Monitor resources: `Resources` tab
- Check errors: `Activity` tab

**Vercel:**
- View logs: Click deployment
- Monitor usage: `Overview` tab
- Check errors: `Deployments` tab

---

## Done!

Your entire system is now LIVE in production! 🎉

- Backend running on Heroku ✓
- Frontend running on Vercel ✓
- Database running on Heroku PostgreSQL ✓
- All 7 agents initialized and running ✓

**Now add platform credentials and go viral!** 🚀
