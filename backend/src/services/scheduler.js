const db = require('../database/db');
const brandConfig = require('./brandConfig');
const metaPublish = require('./metaPublish');
const tiktokPublish = require('./tiktokPublish');
const youtubePublish = require('./youtubePublish');
const autopilot = require('./autopilot');
const publicRoute = require('./publicRoute');

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
const TIKTOK_MAX_POLL_ATTEMPTS = 90; // TikTok moderation of a 60 MB video can be slow
// Platforms where the finished UPLOAD itself publishes (no separate publish
// call): once bytes went out, nothing may become a retryable 'failed'.
const COMMIT_ON_UPLOAD = ['tiktok', 'youtube'];
// A YouTube session that reports "incomplete" is only treated as final (no
// video, safe to retry) after it stays incomplete for this many polls (~2 min).
const YT_INCOMPLETE_SETTLE_POLLS = 6;
const STALE_PUBLISHING_MS = 10 * 60 * 1000;
const MISSED_SLOT_MS = 2 * 3600 * 1000;

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
  lastFinisherTickAt: null,
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
  let r = await db.query(
    "UPDATE branding SET cfg_value = ? WHERE cfg_key = 'auto_cycle_last_fire' AND cfg_value <> ?",
    [fireKey, fireKey]
  );
  if (r && r.affectedRows === 0) {
    // Row may simply not exist yet (boot-time seed failed on a DB blip):
    // seed lazily and try once more, so cycles are never disabled forever.
    const probe = await db.query("SELECT 1 FROM branding WHERE cfg_key = 'auto_cycle_last_fire'");
    if (probe && probe.length === 0) {
      await seedLastFire();
      r = await db.query(
        "UPDATE branding SET cfg_value = ? WHERE cfg_key = 'auto_cycle_last_fire' AND cfg_value <> ?",
        [fireKey, fireKey]
      );
    }
  }
  return !!(r && r.affectedRows === 1);
}

function startCycleScheduler(runCycle) {
  setInterval(async () => {
    state.cycleTicks++;
    try {
      // Master switch first: while the system is OFF no cycle runs.
      if (!(await autopilot.isOn())) return;
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

// Save the platform's session/publish id BEFORE any byte uploads, then read
// it back: if the column silently truncated it, uploading would strand the row.
async function persistCreationId(rowId, value) {
  if (!(await bumpClaimed(rowId, 'creation_id = ?', [value]))) return false;
  const back = await db.query("SELECT creation_id FROM publish_queue WHERE id = ? AND status = 'publishing'", [rowId]);
  return !!(back && back.length && back[0].creation_id === value);
}

// The post is LIVE. Saving this outcome is the one write that must not be
// lost - retry it a few times; if it still fails the row stays 'publishing'
// and the sweeper parks it as 'unknown' (never auto-retried).
async function markPublished(row, result) {
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

async function processClaimedRow(row, routes) {
  // A committed row (creation_id set) must reach its real outcome even if the
  // Library item was deleted meanwhile - only an uncommitted row may fail here.
  if (!row.url_path && !row.creation_id) {
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
    // TikTok on the drafts route (publicRoute.js): the video goes to the
    // owner's TikTok drafts and he posts it from the TikTok app.
    const tiktokDrafts = row.platform === 'tiktok' && routes && routes.tiktok === 'drafts';
    const start = row.platform === 'instagram'
      ? await metaPublish.igCreateContainer(videoUrl, row.caption)
      : tiktokDrafts
        ? await tiktokPublish.startDraft(row.filename,
            // Same rule as a direct post: the id is saved before any byte.
            (publishId) => persistCreationId(row.id, publishId))
      : row.platform === 'tiktok'
        ? await tiktokPublish.startPost(row.filename, row.caption, postOptions,
            // Persist the publish id BEFORE any byte uploads: once bytes
            // land, TikTok publishes on its own, so the row must already
            // read as committed territory for the sweeper.
            (publishId) => persistCreationId(row.id, publishId))
        : row.platform === 'youtube'
          ? await youtubePublish.startPost(row.filename, row.caption, postOptions,
              // Same rule as TikTok: the session URL is saved before any byte.
              (sessionUrl) => persistCreationId(row.id, sessionUrl))
          : await metaPublish.pageStartReel(videoUrl, row.filename);
    if (start.maybePublished) {
      // The platform may have registered the post request - never retry blind.
      console.error('[scheduler] row #' + row.id + ' start outcome UNKNOWN (' + start.error + ') - leaving for the sweeper');
      return;
    }
    if (!start.ok && start.draftsFull) {
      // TikTok keeps at most 5 unposted drafts. Nothing was uploaded: keep the
      // approval and move the post to the next free slot.
      const next = await autopilot.nextFreeSlot(row.platform);
      await bumpClaimed(row.id, "status = 'approved_publishing', scheduled_at = ?, error = ?", [next, start.error]);
      console.log('[scheduler] row #' + row.id + ' TikTok drafts full - moved to ' + new Date(next).toISOString());
      return;
    }
    if (!start.ok) {
      await bumpClaimed(row.id, "status = 'failed', error = ?, attempts = attempts + 1", [start.error]);
      return;
    }
    if (start.uploadWarning) {
      console.warn('[scheduler] row #' + row.id + ' ' + start.uploadWarning);
      await bumpClaimed(row.id, 'error = ?', ['upload warning: ' + start.uploadWarning]);
    }
    const saved = await bumpClaimed(row.id, 'creation_id = ?, attempts = attempts + 1', [start.creationId]);
    if (saved && start.publishedNow) {
      await markPublished(row, start.publishedNow);
      return;
    }
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
      : row.platform === 'youtube'
        ? await youtubePublish.tryFinish(row.creation_id, row.filename)
        : await metaPublish.pageTryPublish(row.creation_id, row.caption);

  const pollCap = row.platform === 'tiktok' ? TIKTOK_MAX_POLL_ATTEMPTS : MAX_POLL_ATTEMPTS;
  if (!result.ok) {
    if (result.maybePublished) {
      // The publish request went out but its outcome is unknown. Marking this
      // 'failed' would make it retryable and a retry could double-publish.
      // Leave the row claimed; the sweeper parks it as 'unknown'.
      console.error('[scheduler] row #' + row.id + ' publish outcome UNKNOWN (' + result.error + ') - leaving for the sweeper');
      return;
    }
    if (result.incomplete) {
      if (!result.fullyReceived && row.attempts >= YT_INCOMPLETE_SETTLE_POLLS) {
        // Stayed incomplete with bytes missing: no video exists - safe to retry.
        await bumpClaimed(row.id, "status = 'failed', error = ?, attempts = attempts + 1", [result.error + ' - no video was created; safe to approve again']);
      } else if (row.attempts >= pollCap) {
        await bumpClaimed(row.id, "status = 'unknown', error = 'upload never confirmed - CHECK THE CHANNEL before doing anything with this row', attempts = attempts + 1", []);
      } else {
        const saved = await bumpClaimed(row.id, 'attempts = attempts + 1, error = ?', ['waiting: ' + result.error]);
        if (saved) await bumpClaimed(row.id, "status = 'approved_publishing'", []);
      }
      return;
    }
    if (COMMIT_ON_UPLOAD.includes(row.platform) && !result.definitive) {
      // The upload is already committed (the platform publishes it on its own), so
      // a transient poll problem must NEVER become a retryable 'failed' -
      // that invites a re-approve and a double post. Keep polling instead.
      if (row.attempts >= pollCap) {
        await bumpClaimed(row.id, "status = 'unknown', error = 'status unreadable after a committed upload - CHECK THE ACCOUNT before doing anything with this row', attempts = attempts + 1", []);
      } else {
        const saved = await bumpClaimed(row.id, 'attempts = attempts + 1, error = ?', ['transient: ' + result.error]);
        if (saved) await bumpClaimed(row.id, "status = 'approved_publishing'", []);
      }
      return;
    }
    await bumpClaimed(row.id, "status = 'failed', error = ?, attempts = attempts + 1", [result.error]);
    return;
  }
  if (!result.done) {
    if (row.attempts >= pollCap) {
      if (COMMIT_ON_UPLOAD.includes(row.platform)) {
        // Committed upload still processing - parking as retryable would
        // invite a double post. The owner checks the account first.
        await bumpClaimed(row.id, "status = 'unknown', error = 'still processing after ~30 min - CHECK THE ACCOUNT before doing anything with this row', attempts = attempts + 1", []);
      } else {
        await bumpClaimed(row.id, "status = 'failed', error = 'timed out waiting for processing', attempts = attempts + 1", []);
      }
    } else {
      const saved = await bumpClaimed(row.id, 'attempts = attempts + 1', []);
      if (saved) await bumpClaimed(row.id, "status = 'approved_publishing'", []);
    }
    return;
  }

  if (row.platform === 'tiktok' && result.inbox) {
    // Delivered to the owner's TikTok drafts (SEND_TO_USER_INBOX). He posts
    // it from the TikTok app; watchDrafts() notices when he has.
    await bumpClaimed(row.id, "status = 'in_drafts', error = NULL, attempts = attempts + 1", []);
    console.log('[scheduler] row #' + row.id + ' is in the TikTok drafts');
    return;
  }

  await markPublished(row, result);
}

// Posts sitting in the owner's TikTok drafts: TikTok reports PUBLISH_COMPLETE
// once he has posted one from the TikTok app. Checked every 10 min, for about
// a week (attempts counts the checks); the owner can also mark a post as
// posted (or drop it) in the panel.
const DRAFT_CHECK_EVERY_MIN = 10;
const DRAFT_MAX_CHECKS = 1100;
async function watchDrafts() {
  const rows = await db.query(
    "SELECT id, creation_id FROM publish_queue WHERE status = 'in_drafts' AND platform = 'tiktok' AND creation_id IS NOT NULL" +
    ' AND attempts < ? AND updated_at < (NOW() - INTERVAL ' + DRAFT_CHECK_EVERY_MIN + ' MINUTE) ORDER BY updated_at ASC LIMIT 3',
    [DRAFT_MAX_CHECKS]
  );
  for (const r of rows || []) {
    const res = await tiktokPublish.tryFinish(r.creation_id);
    if (res.ok && res.done && !res.inbox) {
      const saved = await db.query(
        "UPDATE publish_queue SET status = 'published', published_media_id = ?, permalink = ?, error = NULL, published_at = NOW(), attempts = attempts + 1" +
        " WHERE id = ? AND status = 'in_drafts'",
        [res.mediaId, res.permalink, r.id]
      );
      if (saved && saved.affectedRows) console.log('[scheduler] row #' + r.id + ' posted from the TikTok drafts');
    } else {
      // Not posted yet (or TikTok unreadable right now): look again later.
      await db.query(
        "UPDATE publish_queue SET attempts = attempts + 1, error = ?, updated_at = NOW() WHERE id = ? AND status = 'in_drafts'",
        [res.ok ? null : 'draft status: ' + String(res.error || 'unreadable').slice(0, 200), r.id]
      );
    }
  }
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

async function finisherTick() {
    state.finisherTicks++;
    // Heartbeat before the busy check: a long upload keeps the tick busy, but
    // the publisher is still alive and the dashboard must say so.
    state.lastFinisherTickAt = Date.now();
    if (state.finisherBusy) return; // ticks must never overlap
    state.finisherBusy = true;
    try {
      await sweepStalePublishing();
      await watchDrafts();

      // Posts for a platform that does not yet show this system's posts
      // publicly wait (publicRoute.js) - left out here, they are neither
      // attempted nor re-slotted. An upload already under way (creation_id)
      // is still watched to the end.
      const routes = await publicRoute.routes();
      const waitingFor = await publicRoute.waitingPlatforms(routes);
      const rows = await db.query(
        "SELECT q.*, m.url_path, m.filename FROM publish_queue q LEFT JOIN media m ON m.id = q.media_id " +
        "WHERE q.status = 'approved_publishing'" +
        (waitingFor.length
          ? " AND (q.creation_id IS NOT NULL OR q.platform NOT IN (" + waitingFor.map(() => '?').join(',') + '))'
          : '') +
        // Uploads under way first (they must be watched), then the earliest due.
        ' ORDER BY (q.creation_id IS NULL) ASC, COALESCE(q.scheduled_at, 0) ASC, q.created_at ASC LIMIT 50',
        waitingFor
      );
      if (!rows || !rows.length) return;

      // Master switch (owner request 2026-11-06). OFF: nothing new starts and
      // no Instagram/Facebook container gets its final publish call. A TikTok
      // or YouTube upload that already went out cannot be called back - those
      // rows are still watched to the end so their outcome is recorded.
      // ON: rows go out once their posting slot (scheduled_at) has come.
      const on = await autopilot.isOn();
      const now = Date.now();
      if (on) {
        // A slot missed by more than 2 h (system was OFF, server was down)
        // moves to the next free slot - otherwise switching back ON would
        // fire every overdue post at once and undo the spacing.
        for (const r of rows) {
          if (r.creation_id || !r.scheduled_at || Number(r.scheduled_at) >= now - MISSED_SLOT_MS) continue;
          const next = await autopilot.nextFreeSlot(r.platform);
          const moved = await db.query(
            "UPDATE publish_queue SET scheduled_at = ? WHERE id = ? AND status = 'approved_publishing' AND creation_id IS NULL",
            [next, r.id]
          );
          if (moved && moved.affectedRows) {
            r.scheduled_at = next;
            console.log('[scheduler] row #' + r.id + ' missed its slot - moved to ' + new Date(next).toISOString());
          }
        }
      }
      const due = rows.filter((r) => {
        if (r.creation_id && COMMIT_ON_UPLOAD.includes(r.platform)) return true;
        if (!on) return false;
        if (r.creation_id) return true; // mid-publish container: finish it
        return !r.scheduled_at || Number(r.scheduled_at) <= now;
      }).slice(0, 3);

      for (const row of due) {
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
        await processClaimedRow(fresh[0], routes);
      }
    } catch (err) {
      state.lastError = 'finisher: ' + err.message;
      console.warn('[scheduler] finisher tick failed: ' + err.message);
    } finally {
      state.finisherBusy = false;
    }
}

function startPublishFinisher() {
  setInterval(finisherTick, 20 * 1000);
}

function status() {
  return {
    cycleTicks: state.cycleTicks,
    finisherTicks: state.finisherTicks,
    lastCycleFire: state.lastCycleFire,
    lastFinisherTickAt: state.lastFinisherTickAt,
    lastError: state.lastError
  };
}

function start(runCycle) {
  seedLastFire().catch(() => {}); // the claim UPDATE needs the row to exist
  startCycleScheduler(runCycle);
  startPublishFinisher();
  console.log('[scheduler] cycle scheduler + publish finisher running');
}

module.exports = { start, status, _finisherTick: finisherTick };
