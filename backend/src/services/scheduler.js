const db = require('../database/db');
const brandConfig = require('./brandConfig');
const metaPublish = require('./metaPublish');
const tiktokPublish = require('./tiktokPublish');

// Two background loops:
//  1. Cycle scheduler - runs an autonomous cycle at the owner-configured
//     Tbilisi times (content lands in the approval queue; nothing publishes).
//  2. Publish finisher - completes queue rows the owner has APPROVED in the
//     panel: claims the row, creates the platform container, polls until
//     processed, publishes. This is the only code that ever publishes, and it
//     acts solely on rows the owner explicitly approved (owner rule 2026-10-12).
//
// Row lifecycle: pending_review -> approved_publishing -> publishing ->
// published | failed | unknown. The 'publishing' claim is taken with an
// atomic conditional UPDATE so two ticks (or two processes) can never work
// the same row. 'unknown' means the publish call may have gone out but the
// result could not be saved - those rows are never retried automatically;
// the owner must check the account first.

const TBILISI_OFFSET_MS = 4 * 3600 * 1000; // Georgia has no DST
const PUBLIC_ORIGIN = process.env.PUBLIC_API_ORIGIN || 'https://api.sams-social-system.sams.ge';
const MAX_POLL_ATTEMPTS = 40;
const STALE_PUBLISHING_MS = 10 * 60 * 1000;

function tbilisiNow() {
  const d = new Date(Date.now() + TBILISI_OFFSET_MS);
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return {
    day: days[d.getUTCDay()],
    hhmm: String(d.getUTCHours()).padStart(2, '0') + ':' + String(d.getUTCMinutes()).padStart(2, '0'),
    dateKey: d.toISOString().slice(0, 10)
  };
}

const state = {
  lastCycleFire: null,
  cycleTicks: 0,
  finisherTicks: 0,
  finisherBusy: false,
  lastError: null
};

// ---------- cycle scheduler ----------

// The last-fire key is persisted in the branding table so a restart inside
// the same minute cannot fire the same slot twice.
async function seedLastFire() {
  await db.query("INSERT IGNORE INTO branding (cfg_key, cfg_value) VALUES ('auto_cycle_last_fire', 'never')");
}

async function readLastFire() {
  const rows = await db.query("SELECT cfg_value FROM branding WHERE cfg_key = 'auto_cycle_last_fire'");
  return rows && rows.length ? rows[0].cfg_value : null;
}

// Atomic claim of the slot: only the process whose UPDATE actually changes the
// value wins. A concurrent second process (deploy overlap) updates 0 rows and
// skips, so one slot can never run the cycle twice.
async function claimFireKey(fireKey) {
  const r = await db.query(
    "UPDATE branding SET cfg_value = ? WHERE cfg_key = 'auto_cycle_last_fire' AND cfg_value <> ?",
    [fireKey, fireKey]
  );
  return !!(r && r.affectedRows === 1);
}

function startCycleScheduler(runCycle) {
  setInterval(async () => {
    state.cycleTicks++;
    try {
      const cfg = await brandConfig.get();
      if (String(cfg.auto_cycle_enabled).toLowerCase() !== 'true') return;

      const now = tbilisiNow();
      const days = (cfg.auto_cycle_days || 'all').split(',').map(s => s.trim()).filter(Boolean);
      if (!(days.includes('all') || days.includes(now.day))) return;

      const times = (cfg.auto_cycle_times || '').split(',').map(s => s.trim()).filter(Boolean);
      if (!times.includes(now.hhmm)) return;

      const fireKey = now.dateKey + ' ' + now.hhmm;
      if (state.lastCycleFire === fireKey) return;
      const persisted = await readLastFire();
      if (persisted === fireKey) { state.lastCycleFire = fireKey; return; }

      // Claim the slot BEFORE running (a crash mid-cycle must not re-fire it),
      // and atomically (two processes in a deploy overlap must not both run).
      // If the claim cannot be recorded, skip the slot entirely.
      const won = await claimFireKey(fireKey);
      state.lastCycleFire = fireKey;
      if (!won) {
        console.warn('[scheduler] slot ' + fireKey + ' not claimed (already taken or DB unavailable) - skipping');
        return;
      }

      console.log('[scheduler] firing autonomous cycle (' + fireKey + ' Tbilisi)');
      await runCycle();
    } catch (err) {
      state.lastError = 'cycle: ' + err.message;
      console.warn('[scheduler] cycle tick failed: ' + err.message);
    }
  }, 30 * 1000);
}

// ---------- publish finisher ----------

// Conditional update scoped to the claimed status: returns true only when the
// row was still ours and the write landed. A null result (DB gone) or zero
// affected rows (row changed under us) both mean "stop touching this row".
async function bumpClaimed(rowId, fields, params) {
  const r = await db.query(
    "UPDATE publish_queue SET " + fields + " WHERE id = ? AND status = 'publishing'",
    [...params, rowId]
  );
  return !!(r && r.affectedRows);
}

async function processClaimedRow(row) {
  if (!row.url_path) {
    await bumpClaimed(row.id, "status = 'failed', error = ?", ['media file missing on the server']);
    return;
  }
  const videoUrl = PUBLIC_ORIGIN + row.url_path;

  let postOptions = null;
  if (row.post_options) {
    try { postOptions = JSON.parse(row.post_options); } catch { postOptions = null; }
  }

  // Phase 1: no container yet -> create it, record it, return (poll next tick).
  if (!row.creation_id) {
    const start = row.platform === 'instagram'
      ? await metaPublish.igCreateContainer(videoUrl, row.caption)
      : row.platform === 'tiktok'
        ? await tiktokPublish.startPost(row.filename, row.caption, postOptions)
        : await metaPublish.pageStartReel(videoUrl);
    if (start.maybePublished) {
      // The platform may have registered the post request - never retry blind.
      console.error('[scheduler] row #' + row.id + ' start outcome UNKNOWN (' + start.error + ') - leaving for the sweeper');
      return;
    }
    if (!start.ok) {
      await bumpClaimed(row.id, "status = 'failed', error = ?, attempts = attempts + 1", [start.error]);
      return;
    }
    const saved = await bumpClaimed(row.id, 'creation_id = ?, attempts = attempts + 1', [start.creationId]);
    if (saved) {
      // Release the claim so the next tick picks it up for polling. An
      // unpublished container that gets orphaned simply expires - safe.
      await bumpClaimed(row.id, "status = 'approved_publishing'", []);
    }
    return; // if not saved, the row sits in 'publishing' until the sweeper rules on it
  }

  // Phase 2: container exists -> poll / publish.
  const result = row.platform === 'instagram'
    ? await metaPublish.igTryPublish(row.creation_id)
    : row.platform === 'tiktok'
      ? await tiktokPublish.tryFinish(row.creation_id)
      : await metaPublish.pageTryPublish(row.creation_id, row.caption);

  if (!result.ok) {
    if (result.maybePublished) {
      // The publish request went out but its outcome is unknown. Marking this
      // 'failed' would make it retryable and a retry could double-publish.
      // Leave the row claimed; the sweeper parks it as 'unknown'.
      console.error('[scheduler] row #' + row.id + ' publish outcome UNKNOWN (' + result.error + ') - leaving for the sweeper');
      return;
    }
    await bumpClaimed(row.id, "status = 'failed', error = ?, attempts = attempts + 1", [result.error]);
    return;
  }
  if (!result.done) {
    if (row.attempts >= MAX_POLL_ATTEMPTS) {
      await bumpClaimed(row.id, "status = 'failed', error = 'timed out waiting for processing', attempts = attempts + 1", []);
    } else {
      const saved = await bumpClaimed(row.id, 'attempts = attempts + 1', []);
      if (saved) await bumpClaimed(row.id, "status = 'approved_publishing'", []);
    }
    return;
  }

  // The post is LIVE. Saving this outcome is the one write that must not be
  // lost - retry it a few times; if it still fails the row stays 'publishing'
  // and the sweeper parks it as 'unknown' (never auto-retried).
  for (let i = 0; i < 3; i++) {
    const saved = await bumpClaimed(
      row.id,
      "status = 'published', published_media_id = ?, permalink = ?, error = ?, published_at = NOW(), attempts = attempts + 1",
      [result.mediaId, result.permalink,
        result.alreadyPublished ? 'recovered: the platform reported this container was already published' : null]
    );
    if (saved) {
      console.log('[scheduler] published queue row #' + row.id + ' -> ' + (result.permalink || result.mediaId || 'done'));
      return;
    }
    await new Promise(r => setTimeout(r, 1500));
  }
  console.error('[scheduler] row #' + row.id + ' PUBLISHED but the result could not be saved - it will be parked as unknown');
}

// Rows stuck in 'publishing' (crash mid-work, or a publish whose outcome
// could not be written) get parked as 'unknown' - visible in the panel,
// never auto-retried, not approvable until the owner checks the account.
async function sweepStalePublishing() {
  const staleCond = "status = 'publishing' AND updated_at < (NOW() - INTERVAL " + Math.floor(STALE_PUBLISHING_MS / 1000) + ' SECOND)';
  // No container recorded -> no publish call can have been sent -> safe to retry.
  await db.query(
    "UPDATE publish_queue SET status = 'failed', error = 'stalled before a container was created - safe to approve again' " +
    'WHERE ' + staleCond + ' AND creation_id IS NULL'
  );
  // Container existed -> a publish may have gone out -> owner must check first.
  await db.query(
    "UPDATE publish_queue SET status = 'unknown', error = CONCAT('publish result unverified - CHECK THE ACCOUNT before doing anything with this row', IF(error IS NULL OR error = '', '', CONCAT(' | ', error))) " +
    'WHERE ' + staleCond + ' AND creation_id IS NOT NULL'
  );
}

function startPublishFinisher() {
  setInterval(async () => {
    state.finisherTicks++;
    if (state.finisherBusy) return; // ticks must never overlap
    state.finisherBusy = true;
    try {
      await sweepStalePublishing();

      const rows = await db.query(
        "SELECT q.*, m.url_path, m.filename FROM publish_queue q LEFT JOIN media m ON m.id = q.media_id " +
        "WHERE q.status = 'approved_publishing' ORDER BY q.created_at ASC LIMIT 3"
      );
      if (!rows || !rows.length) return;

      for (const row of rows) {
        // Atomic claim: only the tick that flips the status works the row.
        // This also loses gracefully to a concurrent Drop (drop only acts on
        // approved_publishing, so whichever lands first wins outright).
        const claim = await db.query(
          "UPDATE publish_queue SET status = 'publishing' WHERE id = ? AND status = 'approved_publishing'",
          [row.id]
        );
        if (!claim || !claim.affectedRows) continue;
        // Re-read after the claim: the pre-claim snapshot may be stale (another
        // process could have advanced creation_id/attempts between SELECT and claim).
        const fresh = await db.query(
          "SELECT q.*, m.url_path, m.filename FROM publish_queue q LEFT JOIN media m ON m.id = q.media_id WHERE q.id = ? AND q.status = 'publishing'",
          [row.id]
        );
        if (!fresh || !fresh.length) continue;
        await processClaimedRow(fresh[0]);
      }
    } catch (err) {
      state.lastError = 'finisher: ' + err.message;
      console.warn('[scheduler] finisher tick failed: ' + err.message);
    } finally {
      state.finisherBusy = false;
    }
  }, 20 * 1000);
}

function status() {
  return {
    cycleTicks: state.cycleTicks,
    finisherTicks: state.finisherTicks,
    lastCycleFire: state.lastCycleFire,
    lastError: state.lastError
  };
}

function start(runCycle) {
  seedLastFire().catch(() => {}); // the claim UPDATE needs the row to exist
  startCycleScheduler(runCycle);
  startPublishFinisher();
  console.log('[scheduler] cycle scheduler + publish finisher running');
}

module.exports = { start, status };
