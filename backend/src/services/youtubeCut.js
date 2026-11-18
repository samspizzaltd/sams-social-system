const db = require('../database/db');
const brandConfig = require('./brandConfig');

// YouTube's own cut (owner 2026-11-18: "make the youtube edits shorter with the
// best shot first, also include interactive questions, and promote following
// and sharing"). Shorts were stopping at ~1.1K views - the first batch of
// viewers swiped away, and 17K views brought 90 likes, no comments and no new
// subscribers. So every new edit and montage also gets a separate, shorter
// render for YouTube only:
//  - 5-10 s, OPENING on its single best shot (MagicCut and the PC worker play
//    the kept parts in the order given - no worker change needed),
//  - an on-screen question for the first seconds (comments are a signal),
//  - an on-screen call to subscribe and share at the end ("follow" is
//    "subscribe" on YouTube),
//  - a title that asks the question; a description that asks it again and
//    asks people to subscribe and share (the writers' briefs below).
// Instagram, Facebook and TikTok keep the full edit. When the YouTube cut
// cannot be made, YouTube gets the full edit as before.

const MIN_TOTAL = 5; // seconds
const MAX_TOTAL = 10;
const FILL_TO = 7; // a cut shorter than this is filled up from the main edit
const BEST_MIN = 1.2;
const BEST_MAX = 4;
const PART_MIN = 1;
const MAX_PARTS = 4; // the worker keeps at most 4 parts of a single video
const QUESTION_MAX = 60; // MagicCut's hook limit
const END_MAX = 48; // MagicCut's end-line limit
const DEFAULT_QUESTION = 'Which one would you order first?';
const DEFAULT_END = 'Subscribe for more and share it';

const round1 = (n) => Math.round(n * 10) / 10;
const round2 = (n) => Math.round(n * 100) / 100;
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), Math.max(lo, hi));
const fin = (v) => (v === null || v === undefined || v === '' ? NaN : Number(v));
const chars = (s, max) => Array.from(String(s || '').replace(/\s+/g, ' ').trim()).slice(0, max).join('').trim();
// on-screen text: no hashtags, no emoji
const plain = (s) => String(s || '')
  .replace(/#\S+/g, '')
  .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu, '')
  .replace(/\s+/g, ' ')
  .trim();

// ---------- the writers' briefs ----------

const TEXT_BRIEF =
  '- yt_question: on-screen question for the first 2.5 s of the YouTube cut - max 7 words, ends with "?", about what is in the video and easy to answer in a comment (e.g. "Hummus or falafel - which one?", "Could you finish this plate?"). No hashtags, no emoji.\n' +
  '- yt_end_line: on-screen line for its last 2.5 s asking people to subscribe and share - max 6 words (e.g. "Subscribe for more, share it"). No hashtags, no emoji.';

// The YouTube title and description (both writers).
const CAPTION_BRIEF =
  '- youtube_title: a question viewers want to answer in the comments, about what is in the video - max 90 characters, ends with #Shorts.\n' +
  '- youtube_description: 1-2 short lines that ask the question again and invite answers in the comments, one line asking people to subscribe for more and share it with a friend, then the address line "Sam\'s - 100 Mirian Mepe St, Tbilisi".';

function editFields() {
  const num = { type: 'number' };
  const str = { type: 'string' };
  return {
    yt_best_start: num, yt_best_end: num,
    yt_next_1_start: num, yt_next_1_end: num, yt_next_2_start: num, yt_next_2_end: num,
    yt_question: str, yt_end_line: str
  };
}

function montageFields(ids) {
  return { yt_best_clip: { type: 'string', enum: ids.length ? ids : ['none'] }, yt_question: { type: 'string' }, yt_end_line: { type: 'string' } };
}

function editBrief(duration) {
  const d = round1(Number(duration) || 0);
  return [
    '',
    'YOUTUBE CUT - YouTube gets its own SHORTER cut of this video (5-10 s). Shorts that open slowly get swiped away, so it OPENS on the single best shot:',
    '- yt_best_start/yt_best_end: the single most appetising moment of the ORIGINAL video, 1.5-4 s (seconds of the original ' + d + ' s video) - the pour, the cut, the cheese pull, the full plate. The YouTube cut starts with it.',
    '- yt_next_1_start/yt_next_1_end and yt_next_2_start/yt_next_2_end: up to two more parts of the ORIGINAL to follow it, in the order to play them (use -1 for both numbers of a part you do not need). Do not repeat the best shot; the whole YouTube cut must stay between 5 and 10 s.',
    TEXT_BRIEF
  ].join('\n');
}

function montageBrief() {
  return [
    '',
    'YOUTUBE CUT - YouTube gets its own SHORTER cut of this montage (5-10 s) that OPENS on its best moment: yt_best_clip = the clip whose moment is the most appetising - it plays first.',
    TEXT_BRIEF
  ].join('\n');
}

// The on-screen question and end line, made safe.
function texts(out) {
  let q = chars(plain(out && out.yt_question), QUESTION_MAX - 1);
  if (q && !/[?؟]$/.test(q)) q = chars(q.replace(/[.!…,;:]+$/, ''), QUESTION_MAX - 1) + '?';
  if (Array.from(q).length < 4) q = DEFAULT_QUESTION;
  let e = chars(plain(out && out.yt_end_line), END_MAX);
  if (Array.from(e).length < 4) e = DEFAULT_END;
  return { question: q, end_line: e };
}

// ---------- the plans ----------

// The parts of [a, b] no taken range covers, in order.
function minus(range, taken) {
  let pieces = [range];
  for (const [p, q] of taken) {
    const next = [];
    for (const [a, b] of pieces) {
      if (q <= a || p >= b) { next.push([a, b]); continue; }
      if (p > a) next.push([a, p]);
      if (q < b) next.push([q, b]);
    }
    pieces = next;
  }
  return pieces;
}

// Text times on the YouTube cut: the question right away, the end line for
// the last ~2.6 s.
function timing(plan, kept) {
  const duration = round2(kept + (plan.hold || 0));
  const hookEnd = round1(Math.min(2.6, Math.max(1.2, duration * 0.4)));
  const endStart = round1(Math.max(hookEnd + 0.5, duration - 2.6));
  return Object.assign({}, plan, { hook_start: 0, hook_end: hookEnd, end_start: endStart, duration });
}

// A single video: the writer's best shot first, then its next parts, then -
// when that is still short - more of the main edit, at most MAX_TOTAL.
// mainPlan: the main edit's cleaned plan (autopilot.cleanPlan) or null.
// Returns null when the writer gave no usable best shot.
function planEdit(out, analysis, mainPlan) {
  const d = Number(analysis && analysis.duration) || 0;
  const max = round1(Math.max(0, d - 0.1)); // the last kept frame must exist
  if (!out || max < 2) return null;
  let bs = fin(out.yt_best_start);
  let be = fin(out.yt_best_end);
  if (!(Number.isFinite(bs) && Number.isFinite(be) && bs >= 0 && be > bs)) return null;
  bs = round1(clamp(bs, 0, max - BEST_MIN));
  be = round1(clamp(be, bs + BEST_MIN, Math.min(max, bs + BEST_MAX)));
  if (be - bs < 1) return null;
  const taken = [[bs, be]];
  const add = (x, y) => {
    for (const [p, q] of minus([x, y], taken)) {
      if (taken.length >= MAX_PARTS) return;
      if (q - p >= PART_MIN) taken.push([round1(p), round1(q)]);
    }
  };
  for (const [a, b] of [[out.yt_next_1_start, out.yt_next_1_end], [out.yt_next_2_start, out.yt_next_2_end]]) {
    const x = fin(a);
    const y = fin(b);
    if (!(Number.isFinite(x) && Number.isFinite(y) && x >= 0 && y > x)) continue;
    add(clamp(x, 0, max), clamp(y, 0, max));
  }
  const lenOf = (list) => round1(list.reduce((n, [a, b]) => n + (b - a), 0));
  if (lenOf(taken) < FILL_TO) {
    const source = mainPlan && Array.isArray(mainPlan.segments) && mainPlan.segments.length
      ? mainPlan.segments.map((s) => [Number(s.from), Number(s.to)])
      : [[0, max]];
    for (const [a, b] of source) {
      if (lenOf(taken) >= FILL_TO || taken.length >= MAX_PARTS) break;
      add(clamp(a, 0, max), clamp(b, 0, max));
    }
  }
  const segments = [];
  let kept = 0;
  for (const [a, b] of taken) {
    const room = round1(MAX_TOTAL - kept);
    const len = round1(Math.min(b - a, room));
    if (len < (segments.length ? PART_MIN : BEST_MIN)) break;
    segments.push({ from: a, to: round1(a + len) });
    kept = round1(kept + len);
  }
  if (!segments.length || kept < Math.min(MIN_TOTAL, max)) return null;
  return timing({ segments, hold: 0, best: { from: segments[0].from, to: segments[0].to } }, kept);
}

// No usable best shot (Claude unavailable or off the video): the first
// MAX_TOTAL seconds of the main edit - still shorter, with the question and
// the call to subscribe.
function fallbackEdit(mainPlan, analysis) {
  const d = Number(analysis && analysis.duration) || 0;
  const max = round1(Math.max(0, d - 0.1));
  const source = mainPlan && Array.isArray(mainPlan.segments) && mainPlan.segments.length
    ? mainPlan.segments.map((s) => [Number(s.from), Number(s.to)])
    : max > 0 ? [[0, max]] : [];
  const segments = [];
  let kept = 0;
  for (const [a, b] of source) {
    if (segments.length >= MAX_PARTS) break;
    const room = round1(MAX_TOTAL - kept);
    if (room < 0.5) break;
    const len = round1(Math.min(b - a, room));
    if (len < 0.5) continue;
    segments.push({ from: round1(a), to: round1(a + len) });
    kept = round1(kept + len);
  }
  if (!segments.length || kept < 2) return null;
  return timing({ segments, hold: 0, best: null }, kept);
}

// A montage: the best clip's moment first, then the others in montage order,
// while the cut stays within MAX_TOTAL. Lengths stay whole beats of the music
// (the parts keep their lengths), so the cuts still land on the beat.
function planMontage(mainPlan, bestClipId) {
  const segs = mainPlan && Array.isArray(mainPlan.segments)
    ? mainPlan.segments.filter((s) => s && Number(s.to) > Number(s.from))
    : [];
  if (segs.length < 2) return null;
  const at = segs.findIndex((s) => String(s.media_id) === String(bestClipId));
  const order = at > 0 ? [segs[at]].concat(segs.filter((_, i) => i !== at)) : segs.slice();
  const lenOf = (s) => Number(s.to) - Number(s.from);
  const sum = (list) => list.reduce((n, s) => n + lenOf(s), 0);
  // the end line needs ~2.6 s over the last shot: hold its last frame up to 1 s
  const holdFor = (list) => round2(Math.min(1, Math.max(0, 2.6 - lenOf(list[list.length - 1]))));
  const picked = [];
  for (const s of order) {
    const next = picked.concat([s]);
    if (picked.length >= 2 && sum(next) + holdFor(next) > MAX_TOTAL + 1e-6) break;
    picked.push(s);
  }
  const hold = holdFor(picked);
  const plan = timing({
    montage: true,
    segments: picked.map((s) => ({ media_id: Number(s.media_id), from: Number(s.from), to: Number(s.to) })),
    hold,
    beat: mainPlan.beat || null,
    best_clip: Number(picked[0].media_id)
  }, round2(sum(picked)));
  return plan;
}

// ---------- render params ----------

// MagicCut params of the YouTube cut of a single edit (the main edit's params
// with YouTube's parts, text and timing).
function editParams(main, plan, t, title) {
  return Object.assign({}, main, {
    hook: t.question,
    end_line: t.end_line,
    segments: plan.segments,
    hold: plan.hold,
    hook_start: plan.hook_start,
    hook_end: plan.hook_end,
    end_start: plan.end_start,
    duration: plan.duration,
    output_title: chars('✨ YouTube: ' + title, 120),
    youtube_cut: true
  });
}

// The same for a montage (its clips carry their own size).
function montageParams(main, plan, t, title) {
  const size = new Map((main.clips || []).map((c) => [Number(c.media_id), c]));
  return Object.assign({}, main, {
    clips: plan.segments.map((s) => {
      const c = size.get(Number(s.media_id)) || {};
      return { media_id: s.media_id, from: s.from, to: s.to, width: c.width, height: c.height };
    }),
    hold: plan.hold,
    hook: t.question,
    end_line: t.end_line,
    duration: plan.duration,
    hook_start: plan.hook_start,
    hook_end: plan.hook_end,
    end_start: plan.end_start,
    output_title: chars('✨ YouTube: ' + title, 120),
    youtube_cut: true
  });
}

// What the panel shows about it (copy_json.youtube_cut).
function summary(plan, t, fromWriter) {
  return {
    question: t.question,
    end_line: t.end_line,
    duration: plan.duration,
    segments: plan.segments,
    best: plan.best || null,
    best_clip: plan.best_clip || null,
    best_first: !!fromWriter
  };
}

// Does YouTube take posts right now (connected and not switched off)?
async function youtubeOn() {
  const rows = await db.query("SELECT 1 AS ok FROM accounts WHERE platform = 'youtube' AND status = 'active' LIMIT 1");
  if (!rows || !rows.length) return false;
  const cfg = await brandConfig.get();
  return String((cfg && cfg.platform_youtube_enabled) || '').toLowerCase() !== 'false';
}

module.exports = {
  MIN_TOTAL, MAX_TOTAL, DEFAULT_QUESTION, DEFAULT_END, CAPTION_BRIEF,
  editFields, montageFields, editBrief, montageBrief, texts,
  planEdit, fallbackEdit, planMontage, editParams, montageParams, summary, youtubeOn
};
