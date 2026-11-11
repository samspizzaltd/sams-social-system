const db = require('../database/db');
const youtubePublish = require('./youtubePublish');

// One-time step for Google's 2 Nov 2026 change (see youtubePublish.appAudited).
// Until then the approve sheet could only offer "Private", so every YouTube
// post approved before it would upload as Private. Each of those - approved,
// nothing uploaded yet - goes back to the owner's review, where he picks who
// can watch it and approves it again (owner rule: nothing posts without his
// yes to that exact post). Until this step has run, YouTube posts keep
// waiting (publicRoute.js), so none can upload as Private in the meantime.
//
// It runs the first time public uploads are allowed and is then remembered in
// the branding table, so a post the owner approves as Private on purpose
// later is never touched.
const KEY = 'yt_private_only_returned';
const NOTE = 'YouTube now allows public uploads - pick who can watch, then approve it again';

let done = false;
let inFlight = null;

async function run() {
  const seen = await db.query('SELECT cfg_value FROM branding WHERE cfg_key = ?', [KEY]);
  if (seen === null) return false; // database not ready - the next call tries again
  if (seen.length) return true;
  const r = await db.query(
    "UPDATE publish_queue SET status = 'pending_review', scheduled_at = NULL, error = ?" +
    " WHERE platform = 'youtube' AND status = 'approved_publishing' AND creation_id IS NULL",
    [NOTE]
  );
  if (r === null) return false;
  const mark = await db.query(
    'INSERT IGNORE INTO branding (cfg_key, cfg_value) VALUES (?, ?)',
    [KEY, new Date().toISOString() + ' - ' + r.affectedRows + ' post(s) returned for review']
  );
  if (mark === null) return false;
  console.log('[youtube] public uploads allowed: ' + r.affectedRows + ' Private-only approved post(s) returned for review');
  return true;
}

// true once the step has run. While public uploads are switched off there is
// nothing to return yet (the step waits for the first time they are allowed).
// Single-flight; retried on every call until the database answers.
async function ready() {
  if (done) return true;
  if (!youtubePublish.appAudited()) return true;
  if (!inFlight) {
    inFlight = run()
      .catch((err) => {
        console.warn('[youtube] returning Private-only posts failed: ' + err.message);
        return false;
      })
      .then((ok) => {
        if (ok) done = true;
        inFlight = null;
        return ok;
      });
  }
  return inFlight;
}

// test harness: forget the in-memory flag (the branding key stays)
function _reset() {
  done = false;
  inFlight = null;
}

module.exports = { ready, KEY, NOTE, _reset };
