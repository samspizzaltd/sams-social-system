const db = require('./db');

function headlineMetrics(cycle) {
  const p = cycle.phases || {};
  return {
    draftsCreated: (p.production && p.production.drafted) || 0,
    draftsApproved: (p.production && p.production.approved) || 0,
    postsPublished: (p.distribution && p.distribution.postsPublished) || 0,
    totalEngagement: (p.analytics && p.analytics.totalEngagement) || 0
  };
}

function toSqlDate(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  if (isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

async function save(cycle) {
  const m = headlineMetrics(cycle);
  const rows = await db.query(
    'INSERT INTO cycles (id, cycle_number, status, started_at, completed_at, duration_ms, error,' +
    ' drafts_created, drafts_approved, posts_published, total_engagement, phases)' +
    ' VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
    [
      cycle.id,
      cycle.number,
      cycle.status,
      toSqlDate(cycle.startedAt),
      toSqlDate(cycle.completedAt),
      cycle.durationMs != null ? cycle.durationMs : null,
      cycle.error || null,
      m.draftsCreated,
      m.draftsApproved,
      m.postsPublished,
      m.totalEngagement,
      JSON.stringify(cycle.phases || {})
    ]
  );
  return rows !== null;
}

async function saveContent(cycleId, produced) {
  if (!produced || !produced.length) return false;
  for (const item of produced) {
    await db.query(
      'INSERT INTO content (cycle_id, title, caption, script, platforms, quality_score, status, approved_at)' +
      ' VALUES (?,?,?,?,?,?,?,?)',
      [
        cycleId,
        item.draft.title,
        item.draft.caption,
        JSON.stringify(item.draft.script || null),
        JSON.stringify([item.draft.platform]),
        item.review.score != null ? item.review.score : null,
        item.review.status,
        item.review.status === 'approved' ? toSqlDate(new Date()) : null
      ]
    );
  }
  return true;
}

async function recent(limit) {
  const n = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 200);
  const rows = await db.query(
    'SELECT id, cycle_number, status, started_at, completed_at, duration_ms, error,' +
    ' drafts_created, drafts_approved, posts_published, total_engagement' +
    ' FROM cycles ORDER BY started_at DESC LIMIT ' + n
  );
  return rows;
}

async function byId(id) {
  const rows = await db.query('SELECT * FROM cycles WHERE id = ?', [id]);
  if (!rows || !rows.length) return null;
  const row = rows[0];
  try {
    row.phases = JSON.parse(row.phases);
  } catch (e) {
    // leave as-is if it will not parse
  }
  return row;
}

// Aggregate history so Phase 6 can learn from more than the current cycle.
async function history() {
  const rows = await db.query(
    'SELECT COUNT(*) AS cycles, COALESCE(SUM(posts_published),0) AS posts,' +
    ' COALESCE(SUM(total_engagement),0) AS engagement,' +
    ' COALESCE(AVG(NULLIF(total_engagement,0)),0) AS avg_engagement' +
    ' FROM cycles WHERE status = ?',
    ['completed']
  );
  if (!rows || !rows.length) return null;
  const r = rows[0];
  return {
    cyclesCompleted: Number(r.cycles),
    totalPostsPublished: Number(r.posts),
    totalEngagement: Number(r.engagement),
    avgEngagementPerCycle: Math.round(Number(r.avg_engagement))
  };
}

module.exports = { save, saveContent, recent, byId, history };
