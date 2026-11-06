// Render worker - runs on the owner's PC (NOT the server).
//
// Polls the control-panel API for queued render jobs, stages the referenced
// media (local paths read directly; server uploads downloaded), renders the
// requested Remotion template to MP4, uploads the result back to the media
// library and marks the job done.
//
// Security stance: the server and database are NOT trusted. Everything that
// reaches argv, a filesystem path, or a copy operation is re-validated here
// with local whitelists before use.
//
// Usage:  node render-worker.mjs            (process queue once, then exit)
//         node render-worker.mjs --watch    (keep polling every 30s)
//
// Config: video/.env with OWNER_EMAIL, OWNER_PASSWORD, optional API_URL,
//         optional MEDIA_ROOTS (semicolon-separated dirs local_path may read from).

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 20 && !(major === 19 && minor >= 8)) {
  console.error('Node 20+ required (this worker uses fs.openAsBlob). You have ' + process.version);
  process.exit(1);
}
const { openAsBlob } = fs.promises.constants ? await import('node:fs') : await import('node:fs');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const require2 = createRequire(import.meta.url);

// Resolve the Remotion CLI entry so we can run it with process.execPath -
// no shell, no npx, no quoting problems, no cmd.exe metacharacter risk.
const remotionCliPkg = require2.resolve('@remotion/cli/package.json');
const remotionPkgJson = JSON.parse(fs.readFileSync(remotionCliPkg, 'utf8'));
const binRel = typeof remotionPkgJson.bin === 'string'
  ? remotionPkgJson.bin
  : remotionPkgJson.bin.remotion;
const REMOTION_CLI = path.join(path.dirname(remotionCliPkg), binRel);

// ffmpeg/ffprobe ship inside Remotion's compositor package - no separate
// install. Only the Analyze job needs them; renders work without.
let FFMPEG = null;
let FFPROBE = null;
try {
  const compositorDir = path.dirname(require2.resolve('@remotion/compositor-win32-x64-msvc/package.json', {
    paths: [path.dirname(require2.resolve('@remotion/renderer/package.json'))]
  }));
  if (fs.existsSync(path.join(compositorDir, 'ffmpeg.exe'))) FFMPEG = path.join(compositorDir, 'ffmpeg.exe');
  if (fs.existsSync(path.join(compositorDir, 'ffprobe.exe'))) FFPROBE = path.join(compositorDir, 'ffprobe.exe');
} catch { /* not Windows or package missing - Analyze jobs fail with a clear message */ }

// Minimal .env loader (no dependency).
const envPath = path.join(HERE, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

const API = (process.env.API_URL || 'https://api.sams-social-system.sams.ge').replace(/\/$/, '');
const EMAIL = process.env.OWNER_EMAIL;
const PASSWORD = process.env.OWNER_PASSWORD;
const WATCH = process.argv.includes('--watch');

// Local whitelists - the server copy of these rules protects the server;
// this copy protects THIS machine.
// Analyze = autopilot measuring a library video (frames + sound), MagicCut =
// the autopilot's branded edit of it.
const TEMPLATES = new Set(['MenuCard', 'ScriptPromo', 'ReviewQuote', 'Analyze', 'MagicCut']);
const MEDIA_EXT = /\.(jpe?g|png|webp|gif|mp4|mov|webm|m4a|mp3)$/i;
const MEDIA_ROOTS = (process.env.MEDIA_ROOTS || 'D:\\Projects\\Sams.ge\\images')
  .split(';').map((r) => path.resolve(r.trim())).filter(Boolean);

const FPS = 30;
const SCRIPT_PROMO_SECONDS = 30;

if (!EMAIL || !PASSWORD) {
  console.error('Set OWNER_EMAIL and OWNER_PASSWORD in video/.env (same credentials as the control panel).');
  process.exit(1);
}

let token = null;

async function login() {
  const r = await fetch(API + '/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD })
  });
  if (!r.ok) throw new Error('Login failed: HTTP ' + r.status + ' ' + (await r.text()).slice(0, 200));
  token = (await r.json()).token;
  console.log('[worker] logged in');
}

async function apiCall(method, route, body) {
  const r = await fetch(API + route, {
    method,
    headers: {
      Authorization: 'Bearer ' + token,
      ...(body && !(body instanceof FormData) ? { 'Content-Type': 'application/json' } : {})
    },
    body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined
  });
  if (!r.ok) throw new Error(method + ' ' + route + ' -> HTTP ' + r.status + ' ' + (await r.text()).slice(0, 300));
  return r.json();
}

function insideMediaRoots(p) {
  const resolved = path.resolve(p);
  return MEDIA_ROOTS.some((root) => {
    const rel = path.relative(root, resolved);
    return rel && !rel.startsWith('..') && !path.isAbsolute(rel);
  });
}

function isVideoFile(p) {
  return /\.(mp4|mov|webm)$/i.test(p || '');
}

function isSoundFile(p) {
  return /\.(m4a|mp3)$/i.test(p || '');
}

// "m:ss" or seconds -> seconds
const toSeconds = (at) => {
  if (typeof at === 'number') return at;
  const m = /^(\d+):(\d+)$/.exec(String(at).trim());
  if (m) return Number(m[1]) * 60 + Number(m[2]);
  const n = Number(at);
  return Number.isFinite(n) ? n : 0;
};

// Sort beats, clamp them inside the composition, keep >=1.5s spacing so a
// late CTA is pulled on screen instead of silently dropped.
function sanitizeBeats(beats) {
  const maxStart = SCRIPT_PROMO_SECONDS - 2;
  const sorted = (beats || [])
    .filter((b) => b && typeof b.text === 'string' && b.text.trim())
    .map((b) => ({ ...b, _sec: Math.max(0, toSeconds(b.at)) }))
    .sort((a, b) => a._sec - b._sec)
    .slice(0, 10);
  for (let i = 0; i < sorted.length; i++) {
    const latestAllowed = maxStart - (sorted.length - 1 - i) * 1.5;
    if (sorted[i]._sec > latestAllowed) sorted[i]._sec = latestAllowed;
    if (i > 0 && sorted[i]._sec < sorted[i - 1]._sec + 1.5) {
      sorted[i]._sec = sorted[i - 1]._sec + 1.5;
    }
  }
  return sorted.map((b) => ({ at: Math.round(b._sec * 10) / 10, type: b.type || 'body', text: b.text }));
}

function parseParams(job) {
  if (!job.params) return {};
  try {
    return JSON.parse(job.params);
  } catch {
    console.warn('[worker] job #' + job.id + ': params JSON unparseable, ignoring params');
    return {};
  }
}

async function stageAssets(job, stagingDir) {
  const jobsRel = 'jobs/' + job.id;
  const staged = [];
  staged.kinds = []; // parallel to staged: the library kind of each file
  let index = 0;
  for (const m of job.media || []) {
    index++;
    if (m.local_path) {
      const lp = String(m.local_path);
      if (!MEDIA_EXT.test(lp)) {
        throw new Error('Refusing local file (extension not a media type): ' + lp);
      }
      if (!insideMediaRoots(lp)) {
        throw new Error(
          'Refusing local file outside MEDIA_ROOTS (' + MEDIA_ROOTS.join('; ') + '): ' + lp +
          ' - add its folder to MEDIA_ROOTS in video/.env if this is intentional'
        );
      }
      if (!fs.existsSync(lp)) throw new Error('Local file not found on this PC: ' + lp);
      const name = index + '-' + path.basename(lp);
      fs.copyFileSync(lp, path.join(stagingDir, name));
      staged.push(jobsRel + '/' + name);
      staged.kinds.push(String(m.kind || ''));
    } else if (m.url_path) {
      const base = path.basename(String(m.url_path));
      if (!MEDIA_EXT.test(base)) {
        throw new Error('Refusing server file (extension not a media type): ' + base);
      }
      const r = await fetch(API + m.url_path);
      if (!r.ok) throw new Error('Download failed: ' + m.url_path + ' HTTP ' + r.status);
      const name = index + '-' + base;
      fs.writeFileSync(path.join(stagingDir, name), Buffer.from(await r.arrayBuffer()));
      staged.push(jobsRel + '/' + name);
      staged.kinds.push(String(m.kind || ''));
    }
  }
  return staged;
}

function buildProps(job, stagedFiles) {
  const params = parseParams(job);
  const firstVideo = stagedFiles.find(isVideoFile) || null;
  const firstImage = stagedFiles.find((f) => !isVideoFile(f)) || null;

  // A job that references media but staged nothing must fail loudly -
  // a placeholder video must never silently reach the library.
  if (job.media_ids && !stagedFiles.length) {
    throw new Error('Job references media but none could be staged');
  }

  const props = {};
  if (job.template === 'MenuCard') {
    props.image = firstImage || 'sample.jpg';
    props.title = params.title || (job.content && job.content.title) || "Sam's";
    props.price = params.price || '';
    props.cta = params.cta || 'Order now - 100 Mirian Mepe St';
  } else if (job.template === 'ScriptPromo') {
    props.image = firstImage || 'sample.jpg';
    props.video = firstVideo;
    let beats = params.beats;
    if (!beats && job.content && job.content.script) {
      try {
        const script = JSON.parse(job.content.script);
        beats = script && script.beats;
      } catch { /* script was plain text */ }
    }
    props.beats = sanitizeBeats(
      beats && beats.length ? beats : [
        { at: '0:00', type: 'hook', text: (job.content && job.content.title) || 'Fresh from the grill' },
        { at: '0:20', type: 'cta', text: 'Come and get yours' }
      ]
    );
  } else if (job.template === 'MagicCut') {
    const videoAt = stagedFiles.findIndex((f, i) => isVideoFile(f) && stagedFiles.kinds[i] !== 'sound');
    if (videoAt < 0) throw new Error('MagicCut: the library video could not be staged');
    let sound = null;
    if (params.sound === 'rotated') {
      sound = stagedFiles.find((f) => isSoundFile(f)) || null;
      // The server recorded a circulated sound - never silently fall back to
      // the video's own audio, the review would be mislabelled.
      if (!sound) throw new Error('MagicCut: the circulated sound could not be staged');
    }
    const seconds = Math.min(Math.max(Number(params.duration) || 15, 3), 180);
    const w = Number(params.width) || 1080;
    const h = Number(params.height) || 1920;
    const ratio = w / h;
    props.video = stagedFiles[videoAt];
    props.sound = sound;
    props.hook = String(params.hook || '').slice(0, 60);
    props.endLine = String(params.end_line || '').slice(0, 48);
    // One frame short of the measured length, so the last frame always exists.
    props.durationInFrames = Math.max(FPS * 3, Math.floor(seconds * FPS) - 1);
    props.fit = ratio > 0.5 && ratio < 0.65 ? 'cover' : 'contain';
  } else if (job.template === 'ReviewQuote') {
    props.image = firstImage || 'sample.jpg';
    props.quote = params.quote || 'Best shawarma in Tbilisi, hands down.';
    props.author = params.author || 'Customer review';
  }
  return props;
}

// Autopilot step 1: measure a library video, grab 4 frames for the
// copywriter, and pull its sound into the Sound Library (once per video).
async function analyzeJob(job, jobId, staged, stagingDir) {
  if (!FFMPEG || !FFPROBE) {
    throw new Error('ffmpeg/ffprobe not found (expected inside @remotion/compositor-win32-x64-msvc) - run npm install in video/');
  }
  const params = parseParams(job);
  const mediaId = Number(params.prep_media_id || (job.media && job.media[0] && job.media[0].id));
  if (!Number.isInteger(mediaId)) throw new Error('Analyze: no video id');
  const at = staged.findIndex((f) => isVideoFile(f));
  if (at < 0) throw new Error('Analyze: the library video could not be staged');
  const file = path.join(HERE, 'public', staged[at]);
  const source = (job.media || []).find((m) => Number(m.id) === mediaId) || {};

  const probe = JSON.parse(execFileSync(FFPROBE,
    ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', file],
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }));
  const vs = (probe.streams || []).find((s) => s.codec_type === 'video');
  const as = (probe.streams || []).find((s) => s.codec_type === 'audio');
  if (!vs) throw new Error('Analyze: no picture track in this file');
  const duration = Number(probe.format && probe.format.duration) || Number(vs.duration) || 0;
  let width = Number(vs.width) || null;
  let height = Number(vs.height) || null;
  const sideRot = (vs.side_data_list || []).find((d) => d.rotation !== undefined);
  const rotation = Number((vs.tags && vs.tags.rotate) || (sideRot && sideRot.rotation) || 0);
  if (Math.abs(rotation) % 180 === 90) [width, height] = [height, width];

  const frames = [];
  for (const f of [0.12, 0.38, 0.62, 0.88]) {
    const out = path.join(stagingDir, 'frame-' + frames.length + '.jpg');
    const r = spawnSync(FFMPEG, ['-v', 'error', '-y', '-ss', (duration * f).toFixed(2), '-i', file,
      '-frames:v', '1', '-vf', 'scale=640:-2', '-q:v', '5', out], { encoding: 'utf8' });
    if (r.status === 0 && fs.existsSync(out)) frames.push(fs.readFileSync(out).toString('base64'));
  }

  // The sound: reuse the one already pulled from this video, otherwise
  // extract it - unless the track is silent (nothing worth circulating).
  let soundId = null;
  if (as) {
    const { media } = await apiCall('GET', '/api/media?kind=sound');
    const existing = media.find((m) => String(m.note || '') === 'sound-from:' + mediaId);
    if (existing) {
      soundId = existing.id;
    } else {
      // Peak level via loudnorm (Remotion's ffmpeg build has no volumedetect).
      const vol = spawnSync(FFMPEG, ['-hide_banner', '-nostats', '-i', file, '-vn', '-af', 'loudnorm=print_format=json', '-f', 'null', '-'], { encoding: 'utf8' });
      const m = /"input_tp"\s*:\s*"(-?inf|-?[\d.]+)"/.exec(vol.stderr || '');
      const peak = m ? (/inf/.test(m[1]) ? -Infinity : Number(m[1])) : null;
      if (peak === null || peak > -45) {
        // MP3: the bundled ffmpeg has no m4a muxer; every browser plays mp3.
        const soundFile = path.join(stagingDir, 'sound-' + mediaId + '.mp3');
        execFileSync(FFMPEG, ['-v', 'error', '-y', '-i', file, '-vn', '-ac', '2', '-ar', '44100',
          '-c:a', 'libmp3lame', '-b:a', '192k', soundFile]);
        const form = new FormData();
        form.append('file', await openAsBlob(soundFile, { type: 'audio/mpeg' }), 'sound-' + mediaId + '.mp3');
        form.append('title', 'Sound · ' + String(source.title || 'video #' + mediaId).slice(0, 200));
        form.append('kind', 'sound');
        form.append('note', 'sound-from:' + mediaId);
        const up = await apiCall('POST', '/api/media/upload', form);
        soundId = up.id;
        console.log('[worker] video #' + mediaId + ': sound -> library #' + soundId);
      } else {
        console.log('[worker] video #' + mediaId + ': sound track is silent (peak ' + peak + ' dB) - not circulated');
      }
    }
  }

  try {
    await apiCall('POST', '/api/prep/analysis', {
      job_id: jobId, media_id: mediaId, duration, width, height,
      has_audio: !!as, frames, sound_media_id: soundId
    });
  } catch (err) {
    // 409 = the owner reset or skipped this video meanwhile - nothing to do.
    if (!/HTTP 409/.test(err.message)) throw err;
    console.log('[worker] video #' + mediaId + ': analysis no longer wanted');
  }
  await apiCall('POST', '/api/render-jobs/' + jobId + '/status', { status: 'done', output_media_id: soundId });
  console.log('[worker] job #' + jobId + ' (Analyze) DONE - ' + duration.toFixed(1) + ' s, ' + frames.length + ' frames');
}

async function renderJob(job) {
  // Re-validate everything this machine will act on. The server is not trusted.
  const jobId = Number(job.id);
  if (!Number.isInteger(jobId) || jobId <= 0) throw new Error('Invalid job id from server');
  if (!TEMPLATES.has(job.template)) throw new Error('Unknown template from server: ' + String(job.template).slice(0, 40));

  console.log('[worker] job #' + jobId + ' (' + job.template + ') starting');
  await apiCall('POST', '/api/render-jobs/' + jobId + '/status', { status: 'rendering' });

  const stagingDir = path.join(HERE, 'public', 'jobs', String(jobId));
  fs.mkdirSync(stagingDir, { recursive: true });

  const staged = await stageAssets({ ...job, id: jobId }, stagingDir);
  if (job.template === 'Analyze') {
    try {
      await analyzeJob(job, jobId, staged, stagingDir);
    } finally {
      fs.rmSync(stagingDir, { recursive: true, force: true });
    }
    return;
  }
  const props = buildProps(job, staged);
  const propsFile = path.join(stagingDir, 'props.json');
  fs.writeFileSync(propsFile, JSON.stringify(props));

  const outFile = path.join(HERE, 'out', 'job-' + jobId + '-' + job.template + '.mp4');
  fs.mkdirSync(path.dirname(outFile), { recursive: true });

  // The autopilot edit is as long as the owner's video: give it a bitrate
  // budget so even a 3-minute edit stays under the server's 60 MB upload cap
  // (~45 MB of picture, never above 8 Mbit/s - the platforms re-encode anyway).
  const quality = [];
  if (job.template === 'MagicCut') {
    const seconds = Math.max(3, Number(props.durationInFrames) / FPS);
    const kbps = Math.max(1500, Math.min(8000, Math.floor((45 * 8 * 1000) / seconds)));
    quality.push('--video-bitrate=' + kbps + 'k', '--audio-bitrate=192k');
  }

  console.log('[worker] rendering', job.template, '->', path.basename(outFile));
  execFileSync(
    process.execPath,
    [REMOTION_CLI, 'render', 'src/index.js', job.template, outFile, '--props=' + propsFile, ...quality],
    { cwd: HERE, stdio: 'inherit' }
  );

  console.log('[worker] uploading result');
  const form = new FormData();
  form.append('file', await openAsBlob(outFile, { type: 'video/mp4' }), path.basename(outFile));
  const outParams = parseParams(job);
  form.append('title', outParams.output_title
    ? String(outParams.output_title).slice(0, 200)
    : job.template + ' #' + jobId + (job.content ? ' - ' + job.content.title : ''));
  form.append('kind', 'rendered');
  const uploaded = await apiCall('POST', '/api/media/upload', form);

  await apiCall('POST', '/api/render-jobs/' + jobId + '/status', {
    status: 'done',
    output_media_id: uploaded.id
  });
  console.log('[worker] job #' + jobId + ' DONE -> media #' + uploaded.id);

  // Keep the PC tidy: staging assets are no longer needed once uploaded.
  fs.rmSync(stagingDir, { recursive: true, force: true });
}

// This worker is the only renderer, so on startup any job still marked
// 'rendering' is a leftover from a crash - put it back in the queue.
async function requeueStale() {
  const { jobs } = await apiCall('GET', '/api/render-jobs?status=rendering');
  for (const job of jobs) {
    console.log('[worker] re-queueing stale job #' + job.id);
    await apiCall('POST', '/api/render-jobs/' + job.id + '/status', { status: 'queued' });
  }
}

async function processQueue() {
  const { jobs } = await apiCall('GET', '/api/render-jobs?status=queued');
  if (!jobs.length) {
    console.log('[worker] queue empty');
    return 0;
  }
  for (const job of jobs) {
    try {
      await renderJob(job);
    } catch (err) {
      console.error('[worker] job #' + job.id + ' FAILED: ' + err.message);
      try {
        await apiCall('POST', '/api/render-jobs/' + job.id + '/status', {
          status: 'failed',
          error: err.message
        });
      } catch { /* status update best-effort */ }
    }
  }
  return jobs.length;
}

await login();
await requeueStale().catch((e) => console.warn('[worker] stale check: ' + e.message));
if (WATCH) {
  console.log('[worker] watching queue (30s poll, Ctrl+C to stop)');
  for (;;) {
    try {
      await processQueue();
    } catch (err) {
      console.error('[worker] ' + err.message);
      if (/HTTP 401/.test(err.message)) await login().catch(() => {});
    }
    await new Promise((r) => setTimeout(r, 30000));
  }
} else {
  await processQueue();
}
