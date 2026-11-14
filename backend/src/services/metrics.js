// Real numbers from the platforms. This replaces the cycle "sandbox"
// simulation (random views and likes, a hard-coded 15,000 followers) that the
// panel showed until 2026-11-10.
//
// Read-only: nothing in this file posts, edits or deletes anything on a
// platform. Every exported function returns a result and never throws.
//
// What each platform gives us with the permissions the owner granted:
//   Instagram (instagram_basic + instagram_manage_insights): followers, and per
//     reel: views, reach, likes, comments, shares, saves, average watch time.
//   Facebook (pages_read_engagement): Page followers, and per reel whatever the
//     video object returns (likes, comments). Reel views and reach come from
//     video_insights, which needs the read_insights permission - when Meta
//     refuses it, the run report says so instead of inventing a number.
//   TikTok: read through TikTok's business interface (tiktokBusiness.stats,
//     2026-11-13) for posts it published - views, reach, likes, comments,
//     shares, favorites, average watch time, followers. Posts that went through
//     the owner's TikTok inbox have no post id and stay uncounted.
//   YouTube (youtube.readonly, 2026-11-14): subscribers, and per video views,
//     likes and comments (youtubePublish.stats). Reach, shares, saves and watch
//     time live only in YouTube Analytics, which needs another permission, so
//     they stay NULL. Google's data rules: numbers not refreshed for ~30 days,
//     and all of them after a disconnect, are deleted (youtubePublish.dailyCheck
//     / revokeAndDelete); the privacy policy says so.
// NULL in the tables means "the platform did not give us this number", never 0.

const fs = require('fs');
const path = require('path');
const db = require('../database/db');
const metaPublish = require('./metaPublish');
const tiktokBusiness = require('./tiktokBusiness');
const youtubePublish = require('./youtubePublish');

const GRAPH = 'https://graph.facebook.com/v26.0';
const REFRESH_EVERY_MS = 3 * 60 * 60 * 1000;
const FIRST_RUN_DELAY_MS = 90 * 1000;
const MANUAL_COOLDOWN_MS = 5 * 60 * 1000;
const MAX_POSTS = 300;
const TBILISI_OFFSET_MS = 4 * 60 * 60 * 1000; // Georgia: UTC+4 all year
const BACKUP_DIR = process.env.METRICS_BACKUP_DIR || path.join(__dirname, '..', '..', 'backups');

const COLUMNS = ['views', 'reach', 'likes', 'comments', 'shares', 'saves', 'avg_watch_ms'];
// Insight metric name -> our column.
const IG_INSIGHTS = {
  views: 'views',
  reach: 'reach',
  likes: 'likes',
  comments: 'comments',
  shares: 'shares',
  saved: 'saves',
  ig_reels_avg_watch_time: 'avg_watch_ms'
};
const FB_INSIGHTS = {
  blue_reels_play_count: 'views',
  post_impressions_unique: 'reach',
  post_video_avg_time_watched: 'avg_watch_ms'
};
// Facebook video fields, richest first. A field the Page token may not read
// fails the whole call, so the first post of a run finds the set that works.
const FB_FIELD_SETS = [
  'views,likes.summary(true).limit(0),comments.summary(true).limit(0)',
  'likes.summary(true).limit(0),comments.summary(true).limit(0)',
  'likes.summary(true).limit(0)'
];
// A platform listed here shows its note instead of numbers (none right now).
const NOT_COLLECTED = {};
const COLLECTED = ['instagram', 'facebook_page', 'tiktok', 'youtube'];

const state = { running: false, lastRun: null, lastManualAt: 0, timer: null, cleanup: null };

// ---------- helpers ----------

function scrub(msg) {
  return String(msg || '').replace(/access_token=[^&\s"']+/gi, 'access_token=...').slice(0, 300);
}

function num(v) {
  if (v === null || v === undefined || v === '' || typeof v === 'object') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : null;
}

function blank() {
  const o = {};
  for (const c of COLUMNS) o[c] = null;
  return o;
}

function tbilisiDay(ms) {
  return new Date((ms === undefined ? Date.now() : ms) + TBILISI_OFFSET_MS).toISOString().slice(0, 10);
}

function tbilisiTime(ms) {
  return new Date(Number(ms) + TBILISI_OFFSET_MS).toISOString().slice(11, 16);
}

// Graph API GET. Errors come back as {ok:false, error, code}; tokens never
// appear in an error message.
async function graph(pathAndQuery, token) {
  const url = GRAPH + '/' + pathAndQuery + (pathAndQuery.includes('?') ? '&' : '?') +
    'access_token=' + encodeURIComponent(token);
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(20 * 1000) });
    let j = null;
    try { j = await r.json(); } catch { j = null; }
    if (j && j.error) return { ok: false, error: scrub(j.error.message || 'Graph API error'), code: j.error.code };
    if (!r.ok || !j) return { ok: false, error: 'HTTP ' + r.status };
    return { ok: true, data: j };
  } catch (err) {
    return { ok: false, error: scrub(err.message) };
  }
}

// Insights come back as {data: [{name, values: [{value}]}]} or with
// total_value: {value}. Breakdown objects are not one number and are skipped.
function readInsights(data, map, out) {
  for (const m of (data && data.data) || []) {
    const col = map[m.name];
    if (!col) continue;
    let v = null;
    if (m.total_value && m.total_value.value !== undefined) v = m.total_value.value;
    else if (Array.isArray(m.values) && m.values.length) v = m.values[m.values.length - 1].value;
    const n = num(v);
    if (n !== null) out[col] = n;
  }
}

// One unsupported metric fails the whole insights call, and Meta retires
// metrics now and then (plays became views in 2025). So the first post of a
// run finds out which of our metrics work, one by one if it has to; the rest
// of the run asks for that set in a single call.
async function workingMetrics(objectId, edge, names, token) {
  const all = await graph(objectId + '/' + edge + '?metric=' + names.join(','), token);
  if (all.ok) return { names, first: all };
  if (all.code !== 100) return { names: [], error: all.error, code: all.code };
  const ok = [];
  let lastError = all.error;
  for (const n of names) {
    const one = await graph(objectId + '/' + edge + '?metric=' + n, token);
    if (one.ok) ok.push(n);
    else lastError = one.error;
  }
  return ok.length ? { names: ok } : { names: [], error: lastError, code: 100 };
}

// ---------- storage ----------

async function savePost(row, out, error) {
  const any = COLUMNS.some((c) => out[c] !== null);
  if (any) {
    // COALESCE keeps the last good number when a metric was not readable this time.
    return db.query(
      'INSERT INTO post_metrics (queue_id, platform, external_id, ' + COLUMNS.join(', ') + ', error, fetched_at)' +
      ' VALUES (?,?,?,' + COLUMNS.map(() => '?').join(',') + ',?,NOW())' +
      ' ON DUPLICATE KEY UPDATE platform = VALUES(platform), external_id = VALUES(external_id), ' +
      COLUMNS.map((c) => c + ' = COALESCE(VALUES(' + c + '), ' + c + ')').join(', ') +
      ', error = VALUES(error), fetched_at = NOW()',
      [row.id, row.platform, row.published_media_id].concat(COLUMNS.map((c) => out[c]), [error || null])
    );
  }
  // Nothing readable this time: keep the last good numbers, record why.
  return db.query(
    'INSERT INTO post_metrics (queue_id, platform, external_id, error, fetched_at) VALUES (?,?,?,?,NOW())' +
    ' ON DUPLICATE KEY UPDATE error = VALUES(error)',
    [row.id, row.platform, row.published_media_id, error || 'the platform returned no numbers']
  );
}

async function saveAccount(platform, a) {
  return db.query(
    'INSERT INTO account_metrics (platform, day, followers, posts, fetched_at) VALUES (?,?,?,?,NOW())' +
    ' ON DUPLICATE KEY UPDATE followers = COALESCE(VALUES(followers), followers),' +
    ' posts = COALESCE(VALUES(posts), posts), fetched_at = NOW()',
    [platform, tbilisiDay(), a.followers, a.posts]
  );
}

// ---------- Instagram ----------

async function collectInstagram(rows) {
  const res = { connected: false, posts: rows.length, updated: 0, failed: 0, account: null, notes: [] };
  const ig = await metaPublish.account('instagram');
  if (!ig) { res.notes.push('Instagram is not connected'); return res; }
  res.connected = true;

  const acc = await graph(ig.business_account_id + '?fields=followers_count,media_count', ig.access_token);
  if (acc.ok) {
    res.account = { followers: num(acc.data.followers_count), posts: num(acc.data.media_count) };
    await saveAccount('instagram', res.account);
  } else {
    res.notes.push('followers: ' + acc.error);
  }

  let metricNames = null; // found on the first post that still exists
  let insightsRefused = null; // why insights are off for this run, shown on each post
  for (const row of rows) {
    const id = row.published_media_id;
    const out = blank();
    // Like and comment counts as the post shows them right now.
    const basic = await graph(id + '?fields=like_count,comments_count', ig.access_token);
    if (!basic.ok) {
      // Deleted on Instagram, or the token stopped working: keep the old numbers.
      await savePost(row, out, basic.error);
      res.failed++;
      continue;
    }
    out.likes = num(basic.data.like_count);
    out.comments = num(basic.data.comments_count);

    const ins = blank();
    let insightsError = null;
    if (metricNames === null) {
      const w = await workingMetrics(id, 'insights', Object.keys(IG_INSIGHTS), ig.access_token);
      metricNames = w.names;
      if (!w.names.length) {
        insightsRefused = w.error;
        res.notes.push('insights refused: ' + w.error);
      } else if (w.names.length < Object.keys(IG_INSIGHTS).length) {
        res.notes.push('insights without: ' + Object.keys(IG_INSIGHTS).filter((n) => !w.names.includes(n)).join(', '));
      }
      if (w.first) readInsights(w.first.data, IG_INSIGHTS, ins);
      else if (w.names.length) {
        const r = await graph(id + '/insights?metric=' + w.names.join(','), ig.access_token);
        if (r.ok) readInsights(r.data, IG_INSIGHTS, ins);
        else insightsError = r.error;
      }
    } else if (metricNames.length) {
      const r = await graph(id + '/insights?metric=' + metricNames.join(','), ig.access_token);
      if (r.ok) readInsights(r.data, IG_INSIGHTS, ins);
      else insightsError = r.error;
    }
    for (const c of COLUMNS) {
      if (out[c] === null && ins[c] !== null) out[c] = ins[c];
    }
    const why = insightsError || insightsRefused;
    await savePost(row, out, why ? 'insights: ' + why : null);
    res.updated++;
  }
  return res;
}

// ---------- Facebook Page ----------

async function collectFacebook(rows) {
  const res = { connected: false, posts: rows.length, updated: 0, failed: 0, account: null, notes: [] };
  const page = await metaPublish.account('facebook_page');
  if (!page) { res.notes.push('Facebook Page is not connected'); return res; }
  res.connected = true;

  const acc = await graph(page.business_account_id + '?fields=followers_count,fan_count', page.access_token);
  if (acc.ok) {
    const f = num(acc.data.followers_count);
    res.account = { followers: f !== null ? f : num(acc.data.fan_count), posts: null };
    await saveAccount('facebook_page', res.account);
  } else {
    res.notes.push('followers: ' + acc.error);
  }

  let fieldSet = null;      // the richest field list this token may read
  let insightNames = null;  // working video_insights metrics ([] = refused)
  for (const row of rows) {
    const id = row.published_media_id;
    const out = blank();
    const errors = [];

    let got = null;
    for (const f of fieldSet ? [fieldSet] : FB_FIELD_SETS) {
      const r = await graph(id + '?fields=' + f, page.access_token);
      if (r.ok) { got = r.data; if (!fieldSet) fieldSet = f; break; }
      errors.push(r.error);
      // Only a field or permission problem is worth a smaller field list.
      if (![10, 100, 200].includes(r.code)) break;
    }
    if (got) {
      out.views = num(got.views);
      out.likes = got.likes && got.likes.summary ? num(got.likes.summary.total_count) : null;
      out.comments = got.comments && got.comments.summary ? num(got.comments.summary.total_count) : null;
    }

    if (insightNames === null && got) {
      const w = await workingMetrics(id, 'video_insights', Object.keys(FB_INSIGHTS), page.access_token);
      insightNames = w.names;
      if (!w.names.length) {
        // The video's own "views" field works without it (seen live 2026-11-10).
        res.notes.push((fieldSet === FB_FIELD_SETS[0] ? 'reach and average watch time need' : 'views, reach and average watch time need') +
          ' one more Meta permission (read_insights). Meta said: ' + w.error);
      }
      if (w.first) readInsights(w.first.data, FB_INSIGHTS, out);
      else if (w.names.length) {
        const r = await graph(id + '/video_insights?metric=' + w.names.join(','), page.access_token);
        if (r.ok) readInsights(r.data, FB_INSIGHTS, out);
      }
    } else if (insightNames && insightNames.length) {
      const r = await graph(id + '/video_insights?metric=' + insightNames.join(','), page.access_token);
      if (r.ok) readInsights(r.data, FB_INSIGHTS, out);
      else errors.push('insights: ' + r.error);
    }

    if (!got && COLUMNS.every((c) => out[c] === null)) {
      await savePost(row, out, errors[errors.length - 1] || 'no numbers returned');
      res.failed++;
      continue;
    }
    await savePost(row, out, null);
    res.updated++;
  }
  if (fieldSet === FB_FIELD_SETS[2]) res.notes.push('comment counts need one more Meta permission (pages_read_user_content).');
  return res;
}

// ---------- one-time cleanup of the simulated cycle numbers ----------

// Until 2026-11-10 every cycle stored invented numbers: random "engagement",
// fake publish ids, hard-coded optimizer output (A/B test "results", fixed
// posting times, "+15% engagement") and payout estimates built on a made-up
// 15,000 followers. This removes them once: the cycle rows keep their real
// parts (Claude's research and the drafts it wrote), the invented parts go.
// A copy of every row as it was is written to backend/backups first.
async function clearSimulatedNumbers() {
  if (state.cleanup) return state.cleanup;
  state.cleanup = (async () => {
    const flag = await db.query("SELECT cfg_value FROM branding WHERE cfg_key = 'sim_numbers_cleared'");
    if (flag === null) return { ok: false, error: 'Database unavailable' };
    if (flag.length) return { ok: true, already: true };

    const rows = await db.query('SELECT id, cycle_number, posts_published, total_engagement, phases FROM cycles ORDER BY cycle_number');
    if (rows === null) return { ok: false, error: 'Database unavailable' };

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(BACKUP_DIR, 'cycles-before-clearing-simulated-numbers-' + stamp + '.json');
    try {
      fs.mkdirSync(BACKUP_DIR, { recursive: true });
      fs.writeFileSync(file, JSON.stringify(rows, null, 1));
    } catch (err) {
      // No backup, no change.
      return { ok: false, error: 'backup failed: ' + err.message };
    }

    let changed = 0;
    for (const r of rows) {
      let phases = null;
      try { phases = JSON.parse(r.phases); } catch { phases = null; }
      if (phases && typeof phases === 'object') {
        delete phases.distribution;
        delete phases.analytics;
        delete phases.optimization;
        delete phases.monetization;
        if (phases.intelligence) delete phases.intelligence.competitorsTracked; // a placeholder "competitor"
      }
      const u = await db.query(
        'UPDATE cycles SET posts_published = 0, total_engagement = 0, phases = ? WHERE id = ?',
        [phases ? JSON.stringify(phases) : r.phases, r.id]
      );
      if (u === null) return { ok: false, error: 'Database unavailable mid-way (the rest is retried next time)' };
      changed += u.affectedRows ? 1 : 0;
    }
    const report = { at: new Date().toISOString(), cycles: rows.length, changed, backup: path.basename(file) };
    await db.query(
      "INSERT INTO branding (cfg_key, cfg_value) VALUES ('sim_numbers_cleared', ?) ON DUPLICATE KEY UPDATE cfg_value = VALUES(cfg_value)",
      [JSON.stringify(report)]
    );
    console.log('[metrics] simulated cycle numbers cleared: ' + changed + ' of ' + rows.length + ' cycles (backup ' + report.backup + ')');
    return Object.assign({ ok: true }, report);
  })().finally(() => { state.cleanup = null; });
  return state.cleanup;
}

// ---------- TikTok (business interface) ----------

async function collectTikTok(rows) {
  const res = { connected: false, posts: rows.length, updated: 0, failed: 0, account: null, notes: [] };
  if (!(await tiktokBusiness.ready())) {
    res.notes.push('TikTok numbers come once TikTok\'s business interface is connected (Settings → Platform Connections)');
    return res;
  }
  res.connected = true;
  const r = await tiktokBusiness.stats(rows.map((x) => x.published_media_id));
  if (r.followers !== null && r.followers !== undefined) {
    res.account = { followers: r.followers };
    await saveAccount('tiktok', { followers: r.followers, posts: null });
  }
  if (!r.ok) res.notes.push(scrub(r.error));
  const posts = r.posts || {};
  for (const row of rows) {
    const v = posts[String(row.published_media_id)];
    if (!v) {
      res.failed++;
      await savePost(row, blank(), 'TikTok has no numbers for this post yet (they come 24-48 h after posting)');
      continue;
    }
    const out = blank();
    out.views = num(v.video_views);
    out.reach = num(v.reach);
    out.likes = num(v.likes);
    out.comments = num(v.comments);
    out.shares = num(v.shares);
    out.saves = num(v.favorites);
    const avg = Number(v.average_time_watched);
    out.avg_watch_ms = Number.isFinite(avg) && avg > 0 ? Math.round(avg * 1000) : null;
    await savePost(row, out, null);
    res.updated++;
  }
  return res;
}

// ---------- YouTube ----------

async function collectYouTube(rows) {
  const res = { connected: false, posts: rows.length, updated: 0, failed: 0, account: null, notes: [] };
  if (!(await youtubePublish.account())) {
    res.notes.push('YouTube is not connected (Settings → Platform Connections)');
    return res;
  }
  res.connected = true;
  const r = await youtubePublish.stats(rows.map((x) => x.published_media_id));
  if (r.followers !== null && r.followers !== undefined) {
    res.account = { followers: r.followers };
    await saveAccount('youtube', { followers: r.followers, posts: null });
  }
  if (r.error) res.notes.push(scrub(r.error));
  const posts = r.posts || {};
  for (const row of rows) {
    const s = posts[String(row.published_media_id)];
    if (!s) {
      res.failed++;
      await savePost(row, blank(), r.ok
        ? 'YouTube returned no numbers for this video (deleted, or still processing)'
        : 'YouTube could not be read this time' + (r.error ? ' - ' + scrub(r.error) : ''));
      continue;
    }
    const out = blank();
    out.views = num(s.viewCount);
    out.likes = num(s.likeCount); // absent when the channel hides likes
    out.comments = num(s.commentCount); // absent when comments are off
    await savePost(row, out, null);
    res.updated++;
  }
  return res;
}

// ---------- the refresh run ----------

async function collect(trigger) {
  if (state.running) return { ok: false, error: 'A refresh is already running' };
  state.running = true;
  const started = Date.now();
  const report = { at: new Date().toISOString(), trigger: trigger || 'timer', platforms: {}, ms: 0 };
  try {
    const c = await clearSimulatedNumbers();
    if (!c.ok) report.cleanupError = c.error;
    const rows = await db.query(
      "SELECT id, platform, published_media_id FROM publish_queue WHERE status = 'published'" +
      " AND published_media_id IS NOT NULL AND published_media_id <> ''" +
      " AND platform IN ('instagram', 'facebook_page', 'tiktok', 'youtube') ORDER BY id DESC LIMIT " + MAX_POSTS
    );
    if (rows === null) {
      report.error = 'Database unavailable';
    } else {
      report.platforms.instagram = await collectInstagram(rows.filter((r) => r.platform === 'instagram'));
      report.platforms.facebook_page = await collectFacebook(rows.filter((r) => r.platform === 'facebook_page'));
      report.platforms.tiktok = await collectTikTok(rows.filter((r) => r.platform === 'tiktok' && /^\d{5,30}$/.test(String(r.published_media_id))));
      report.platforms.youtube = await collectYouTube(rows.filter((r) => r.platform === 'youtube'));
    }
  } catch (err) {
    report.error = scrub(err.message);
  } finally {
    report.ms = Date.now() - started;
    state.lastRun = report;
    state.running = false;
  }
  await db.query(
    "INSERT INTO branding (cfg_key, cfg_value) VALUES ('metrics_last_run', ?) ON DUPLICATE KEY UPDATE cfg_value = VALUES(cfg_value)",
    [JSON.stringify(report).slice(0, 60000)]
  );
  return { ok: !report.error, report };
}

// The panel's "Refresh now": runs in the background (a run can outlast the
// 60 s proxy timeout), at most once every 5 minutes.
function requestRefresh() {
  if (state.running) return { ok: false, status: 409, error: 'A refresh is already running' };
  const wait = state.lastManualAt + MANUAL_COOLDOWN_MS - Date.now();
  if (wait > 0) return { ok: false, status: 429, error: 'Refreshed a moment ago - try again in ' + Math.ceil(wait / 60000) + ' min', retryAfterMs: wait };
  state.lastManualAt = Date.now();
  collect('manual').catch(() => {});
  return { ok: true, started: true };
}

function start() {
  if (state.timer) return;
  const first = setTimeout(() => { collect('start').catch(() => {}); }, FIRST_RUN_DELAY_MS);
  if (first.unref) first.unref();
  state.timer = setInterval(() => { collect('timer').catch(() => {}); }, REFRESH_EVERY_MS);
  if (state.timer.unref) state.timer.unref();
}

function stop() {
  if (state.timer) clearInterval(state.timer);
  state.timer = null;
}

// ---------- what the panel shows (tables only, no platform calls) ----------

function sumKnown(list, key) {
  let total = 0;
  let known = 0;
  for (const p of list) {
    if (p[key] !== null && p[key] !== undefined) { total += Number(p[key]); known++; }
  }
  return known ? total : null;
}

function interactionsOf(p) {
  const parts = ['likes', 'comments', 'shares', 'saves'].map((k) => p[k]).filter((v) => v !== null && v !== undefined);
  return parts.length ? parts.reduce((a, b) => a + Number(b), 0) : null;
}

async function summary() {
  const posts = await db.query(
    'SELECT q.id AS queue_id, q.platform, q.caption, q.permalink, q.published_at, q.scheduled_at,' +
    ' m.views, m.reach, m.likes, m.comments, m.shares, m.saves, m.avg_watch_ms, m.error, m.fetched_at' +
    ' FROM publish_queue q LEFT JOIN post_metrics m ON m.queue_id = q.id' +
    " WHERE q.status = 'published' ORDER BY q.published_at DESC, q.id DESC LIMIT " + MAX_POSTS
  );
  if (posts === null) return null;
  const accounts = await db.query(
    'SELECT platform, day, followers, posts, fetched_at FROM account_metrics WHERE day >= ? ORDER BY day',
    [tbilisiDay(Date.now() - 60 * 24 * 60 * 60 * 1000)]
  );
  const flags = await db.query(
    "SELECT cfg_key, cfg_value FROM branding WHERE cfg_key IN ('metrics_last_run', 'sim_numbers_cleared')"
  );
  const flag = {};
  for (const f of flags || []) {
    try { flag[f.cfg_key] = JSON.parse(f.cfg_value); } catch { flag[f.cfg_key] = null; }
  }

  const list = posts.map((p) => {
    const row = {
      queue_id: p.queue_id,
      platform: p.platform,
      caption: Array.from(String(p.caption || '').split('\n')[0]).slice(0, 140).join(''),
      permalink: p.permalink,
      published_at: p.published_at,
      slot: p.scheduled_at ? tbilisiTime(p.scheduled_at) : null
    };
    for (const c of COLUMNS) row[c] = p[c] === null || p[c] === undefined ? null : Number(p[c]);
    row.interactions = interactionsOf(row);
    row.error = p.error || null;
    row.fetched_at = p.fetched_at || null;
    row.collected = COLLECTED.includes(p.platform);
    return row;
  });

  const platforms = {};
  for (const name of COLLECTED) {
    const mine = list.filter((p) => p.platform === name);
    const tracked = mine.filter((p) => p.fetched_at);
    const hist = (accounts || []).filter((a) => a.platform === name)
      .map((a) => ({ day: a.day, followers: a.followers === null ? null : Number(a.followers) }));
    const latest = (accounts || []).filter((a) => a.platform === name).slice(-1)[0] || null;
    platforms[name] = {
      published: mine.length,
      tracked: tracked.length,
      followers: latest && latest.followers !== null ? Number(latest.followers) : null,
      followersDay: latest ? latest.day : null,
      followerHistory: hist,
      views: sumKnown(tracked, 'views'),
      viewsKnown: tracked.filter((p) => p.views !== null).length,
      reach: sumKnown(tracked, 'reach'),
      likes: sumKnown(tracked, 'likes'),
      comments: sumKnown(tracked, 'comments'),
      shares: sumKnown(tracked, 'shares'),
      saves: sumKnown(tracked, 'saves'),
      interactions: sumKnown(tracked.map((p) => ({ i: p.interactions })), 'i')
    };
  }
  for (const name of Object.keys(NOT_COLLECTED)) {
    platforms[name] = { published: list.filter((p) => p.platform === name).length, note: NOT_COLLECTED[name] };
  }

  const tracked = list.filter((p) => p.collected && p.fetched_at);
  const followers = COLLECTED.map((n) => platforms[n].followers).filter((v) => v !== null);
  const totals = {
    tracked: tracked.length,
    views: sumKnown(tracked, 'views'),
    reach: sumKnown(tracked, 'reach'),
    interactions: sumKnown(tracked.map((p) => ({ i: p.interactions })), 'i'),
    followers: followers.length ? followers.reduce((a, b) => a + b, 0) : null
  };

  // Average views per posting slot (Tbilisi time), from posts with real views.
  const bySlot = {};
  for (const p of tracked) {
    if (!p.slot || p.views === null) continue;
    const k = p.platform + ' ' + p.slot;
    if (!bySlot[k]) bySlot[k] = { platform: p.platform, slot: p.slot, posts: 0, views: 0, interactions: 0 };
    bySlot[k].posts++;
    bySlot[k].views += p.views;
    bySlot[k].interactions += p.interactions || 0;
  }
  const slots = Object.values(bySlot)
    .map((s) => ({ platform: s.platform, slot: s.slot, posts: s.posts, avgViews: Math.round(s.views / s.posts), avgInteractions: Math.round(s.interactions / s.posts) }))
    .sort((a, b) => (a.platform + a.slot).localeCompare(b.platform + b.slot));

  return {
    posts: list,
    platforms,
    totals,
    slots,
    lastRun: state.lastRun || flag.metrics_last_run || null,
    running: state.running,
    refreshEveryHours: REFRESH_EVERY_MS / 3600000,
    cleanup: flag.sim_numbers_cleared || null
  };
}

module.exports = {
  collect, requestRefresh, start, stop, summary, clearSimulatedNumbers,
  _state: state // tests only
};
