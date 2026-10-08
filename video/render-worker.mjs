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

import { execFileSync } from 'node:child_process';
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
const TEMPLATES = new Set(['MenuCard', 'ScriptPromo', 'ReviewQuote']);
const MEDIA_EXT = /\.(jpe?g|png|webp|gif|mp4|mov|webm)$/i;
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
  } else if (job.template === 'ReviewQuote') {
    props.image = firstImage || 'sample.jpg';
    props.quote = params.quote || 'Best shawarma in Tbilisi, hands down.';
    props.author = params.author || 'Customer review';
  }
  return props;
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
  const props = buildProps(job, staged);
  const propsFile = path.join(stagingDir, 'props.json');
  fs.writeFileSync(propsFile, JSON.stringify(props));

  const outFile = path.join(HERE, 'out', 'job-' + jobId + '-' + job.template + '.mp4');
  fs.mkdirSync(path.dirname(outFile), { recursive: true });

  console.log('[worker] rendering', job.template, '->', path.basename(outFile));
  execFileSync(
    process.execPath,
    [REMOTION_CLI, 'render', 'src/index.js', job.template, outFile, '--props=' + propsFile],
    { cwd: HERE, stdio: 'inherit' }
  );

  console.log('[worker] uploading result');
  const form = new FormData();
  form.append('file', await openAsBlob(outFile, { type: 'video/mp4' }), path.basename(outFile));
  form.append('title', job.template + ' #' + jobId + (job.content ? ' - ' + job.content.title : ''));
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
