// Sound measurements for "Analyze & name" (owner 2026-11-12: "analyze it and
// name it properly so we can identify what content is in the video ... videos
// and or sounds"). Claude cannot hear audio, so the worker measures the sound
// and draws a spectrogram picture Claude can look at.
//
// Only the ffmpeg that ships with Remotion is used. That build has the wav
// muxer and pcm_s16le, but no raw-PCM muxer, no showspectrumpic and no astats,
// so the sound is decoded to a temporary WAV file and everything else is plain
// JavaScript: an FFT, a few measurements and a tiny PNG encoder.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const RATE = 16000; // Hz - enough for voices and music up to 8 kHz
const N = 1024; // FFT size: 64 ms
const HOP = 512; // 32 ms between frames
const FPS = RATE / HOP; // 31.25 frames per second
const SILENT_DB = -45; // a frame quieter than this counts as silence
const ONSET_MIN = 0.05; // mean onset strength (dB per bin) below which there is no beat
const WOBBLE_MIN = 0.05; // loudness spread (std/mean) below which there is no syllable rhythm

// Decode the first maxSeconds of any audio/video file to mono 16 kHz samples.
export function decodeMono(ffmpeg, file, tmpDir, maxSeconds = 90) {
  const wav = path.join(tmpDir, 'describe-' + process.pid + '-' + Date.now() + '.wav');
  const r = spawnSync(ffmpeg, ['-v', 'error', '-y', '-i', file, '-vn', '-ac', '1', '-ar', String(RATE),
    '-t', String(maxSeconds), '-c:a', 'pcm_s16le', '-f', 'wav', wav], { encoding: 'utf8' });
  if (r.status !== 0 || !fs.existsSync(wav)) {
    fs.rmSync(wav, { force: true });
    throw new Error('could not decode the sound: ' + String(r.stderr || '').trim().slice(0, 200));
  }
  const buf = fs.readFileSync(wav);
  fs.rmSync(wav, { force: true });
  return parseWav(buf);
}

export function parseWav(buf) {
  if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('not a WAV file');
  }
  let off = 12;
  let channels = 1;
  let bits = 16;
  let data = null;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    let size = buf.readUInt32LE(off + 4);
    if (id === 'fmt ') {
      channels = buf.readUInt16LE(off + 10);
      bits = buf.readUInt16LE(off + 22);
    } else if (id === 'data') {
      if (!size || off + 8 + size > buf.length) size = buf.length - off - 8;
      data = buf.subarray(off + 8, off + 8 + size);
      break;
    }
    off += 8 + size + (size & 1);
  }
  if (!data || bits !== 16 || channels !== 1) throw new Error('unexpected WAV layout (' + channels + ' ch, ' + bits + ' bit)');
  const n = Math.floor(data.length / 2);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = data.readInt16LE(i * 2) / 32768;
  return out;
}

// In-place radix-2 FFT (n must be a power of two).
function makeFFT(n) {
  const levels = Math.round(Math.log2(n));
  const cos = new Float64Array(n / 2);
  const sin = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) {
    cos[i] = Math.cos((2 * Math.PI * i) / n);
    sin[i] = Math.sin((2 * Math.PI * i) / n);
  }
  const rev = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    let x = i;
    let y = 0;
    for (let b = 0; b < levels; b++) { y = (y << 1) | (x & 1); x >>= 1; }
    rev[i] = y;
  }
  return (re, im) => {
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    for (let size = 2; size <= n; size *= 2) {
      const half = size / 2;
      const step = n / size;
      for (let i = 0; i < n; i += size) {
        for (let j = i, k = 0; j < i + half; j++, k += step) {
          const tre = re[j + half] * cos[k] + im[j + half] * sin[k];
          const tim = im[j + half] * cos[k] - re[j + half] * sin[k];
          re[j + half] = re[j] - tre;
          im[j + half] = im[j] - tim;
          re[j] += tre;
          im[j] += tim;
        }
      }
    }
  };
}

const median = (arr) => {
  if (!arr.length) return null;
  const s = Float64Array.from(arr).sort();
  return s[Math.floor(s.length / 2)];
};
const r2 = (v) => Math.round(v * 100) / 100;

// Measurements + the spectrogram of mono 16 kHz samples.
export function analyzeSamples(x) {
  const frames = x.length >= N ? Math.floor((x.length - N) / HOP) + 1 : 0;
  const duration = x.length / RATE;
  if (frames < 8) {
    return { facts: { analysed_s: r2(duration), too_short: true }, spec: null, frames };
  }
  const win = new Float64Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1));
  const fft = makeFFT(N);
  const bins = N / 2 + 1;
  const binHz = RATE / N;
  const spec = new Array(frames); // dB per bin
  const rmsDb = new Float64Array(frames);
  const flux = new Float64Array(frames);
  const flatness = new Float64Array(frames);
  let voiceE = 0;
  let bassE = 0;
  let totalE = 0;
  let centroidW = 0;
  let prev = null;
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  for (let f = 0; f < frames; f++) {
    let e = 0;
    for (let i = 0; i < N; i++) {
      const s = x[f * HOP + i];
      e += s * s;
      re[i] = s * win[i];
      im[i] = 0;
    }
    rmsDb[f] = 10 * Math.log10(e / N + 1e-12);
    fft(re, im);
    const db = new Float32Array(bins);
    let lnSum = 0;
    let sum = 0;
    let cnt = 0;
    const loud = rmsDb[f] > SILENT_DB;
    for (let b = 0; b < bins; b++) {
      const p = re[b] * re[b] + im[b] * im[b];
      db[b] = 10 * Math.log10(p + 1e-10);
      const hz = b * binHz;
      if (hz >= 100 && hz <= 6000) { lnSum += Math.log(p + 1e-12); sum += p; cnt++; }
      if (loud && hz >= 40) {
        totalE += p;
        centroidW += hz * p;
        if (hz >= 300 && hz <= 3400) voiceE += p;
        if (hz < 150) bassE += p;
      }
    }
    flatness[f] = cnt && sum > 0 ? Math.exp(lnSum / cnt) / (sum / cnt) : 0;
    if (prev) {
      let fl = 0;
      for (let b = 3; b < bins; b++) {
        const d = db[b] - prev[b];
        if (d > 0) fl += d;
      }
      flux[f] = fl / bins;
    }
    prev = db;
    spec[f] = db;
  }

  const loudIdx = [];
  for (let f = 0; f < frames; f++) if (rmsDb[f] > SILENT_DB) loudIdx.push(f);
  const silenceShare = 1 - loudIdx.length / frames;
  const loudDb = loudIdx.map((f) => rmsDb[f]);

  // Beat: autocorrelation of the onset strength (spectral flux minus its
  // local average) between 58 and 200 beats per minute.
  const win1s = Math.round(FPS);
  const onset = new Float64Array(frames);
  let run = 0;
  for (let f = 0; f < frames; f++) {
    run += flux[f];
    if (f >= win1s) run -= flux[f - win1s];
    const avg = run / Math.min(f + 1, win1s);
    onset[f] = Math.max(0, flux[f] - avg);
  }
  let r0 = 0;
  for (let f = 0; f < frames; f++) r0 += onset[f] * onset[f];
  let best = null;
  const minLag = Math.max(2, Math.floor((60 * FPS) / 200));
  const maxLag = Math.min(frames - 2, Math.ceil((60 * FPS) / 58));
  const ac = new Map();
  for (let L = minLag; L <= maxLag; L++) {
    let s = 0;
    for (let f = L; f < frames; f++) s += onset[f] * onset[f - L];
    const v = r0 > 0 ? s / r0 : 0;
    ac.set(L, v);
    if (!best || v > best.v) best = { L, v };
  }
  let bpm = null;
  let beatStrength = 0;
  // Only a sound with real onsets has a beat: a steady tone or a hum gives
  // tiny, random flux whose autocorrelation would look strong when normalised.
  const onsetMean = loudIdx.length ? loudIdx.reduce((sum, f) => sum + onset[f], 0) / loudIdx.length : 0;
  if (best && best.v > 0 && onsetMean >= ONSET_MIN) {
    let L = best.L;
    // Prefer the 70-180 range when the double tempo is almost as strong.
    if ((60 * FPS) / L < 70 && ac.has(Math.round(L / 2)) && ac.get(Math.round(L / 2)) > 0.8 * best.v) L = Math.round(L / 2);
    bpm = Math.round((60 * FPS) / L);
    beatStrength = r2(ac.get(L) || best.v);
  }

  // Loudness wobble at speech-syllable rate (3-7 Hz) vs. all slow changes
  // (0.5-12 Hz), measured on the loudness envelope.
  const env = Array.from(rmsDb, (d) => Math.pow(10, d / 20));
  const mean = env.reduce((a, b) => a + b, 0) / frames;
  const band = (lo, hi) => {
    let e = 0;
    for (let hz = lo; hz <= hi + 1e-9; hz += 0.25) {
      let cr = 0;
      let ci = 0;
      const w = (2 * Math.PI * hz) / FPS;
      for (let f = 0; f < frames; f++) {
        const v = env[f] - mean;
        cr += v * Math.cos(w * f);
        ci -= v * Math.sin(w * f);
      }
      e += cr * cr + ci * ci;
    }
    return e;
  };
  // Only when the loudness really moves (a steady sound has no syllables).
  const envStd = Math.sqrt(env.reduce((sum, v) => sum + (v - mean) * (v - mean), 0) / frames);
  const allMod = band(0.5, 12);
  const speechMod = allMod > 0 && mean > 0 && envStd / mean >= WOBBLE_MIN ? band(3, 7) / allMod : 0;

  const loudFlat = loudIdx.map((f) => flatness[f]);
  const facts = {
    analysed_s: r2(duration),
    loudness_db: loudDb.length ? Math.round(median(loudDb)) : null,
    peak_db: Math.round(Math.max(...rmsDb)),
    silence_share: r2(silenceShare),
    beat_bpm: bpm,
    beat_strength: beatStrength,
    noisiness: loudFlat.length ? r2(median(loudFlat)) : null,
    voice_band_share: totalE > 0 ? r2(voiceE / totalE) : null,
    bass_share: totalE > 0 ? r2(bassE / totalE) : null,
    brightness_hz: totalE > 0 ? Math.round(centroidW / totalE) : null,
    speech_rhythm: r2(speechMod)
  };
  return { facts, spec, frames, binHz };
}

// ---------- spectrogram picture ----------

const STOPS = [[0, 0, 4], [40, 11, 84], [101, 21, 110], [159, 42, 99], [212, 72, 66], [245, 125, 21], [250, 193, 39], [252, 255, 164]];
function colour(v) {
  const x = Math.min(1, Math.max(0, v)) * (STOPS.length - 1);
  const i = Math.min(STOPS.length - 2, Math.floor(x));
  const t = x - i;
  const a = STOPS[i];
  const b = STOPS[i + 1];
  return [Math.round(a[0] + (b[0] - a[0]) * t), Math.round(a[1] + (b[1] - a[1]) * t), Math.round(a[2] + (b[2] - a[2]) * t)];
}

// Time runs left to right, pitch bottom (60 Hz) to top (8 kHz) on a log
// scale, brighter = louder. Faint lines at 250 Hz, 1 kHz and 4 kHz; a tick
// along the bottom every second (taller every 5 s).
export function spectrogramPng(analysis, opts = {}) {
  const { spec, frames, binHz } = analysis;
  if (!spec || !frames) return null;
  const W = Math.max(240, Math.min(opts.width || 720, frames));
  const H = opts.height || 200;
  const lo = 60;
  const hi = 8000;
  const rowHz = (r) => lo * Math.pow(hi / lo, r / (H - 1)); // r = 0 at the bottom
  const grid = new Float32Array(W * H);
  const all = [];
  for (let c = 0; c < W; c++) {
    const f0 = Math.floor((c * frames) / W);
    const f1 = Math.max(f0 + 1, Math.floor(((c + 1) * frames) / W));
    for (let r = 0; r < H; r++) {
      const b0 = Math.max(1, Math.floor(rowHz(r - 0.5) / binHz));
      const b1 = Math.max(b0, Math.min(spec[0].length - 1, Math.ceil(rowHz(r + 0.5) / binHz)));
      let m = -200;
      for (let f = f0; f < f1; f++) {
        const row = spec[f];
        for (let b = b0; b <= b1; b++) if (row[b] > m) m = row[b];
      }
      grid[r * W + c] = m;
      if ((c + r) % 7 === 0) all.push(m);
    }
  }
  all.sort((a, b) => a - b);
  // Never brighter than 0 dB per bin as the top: silence stays dark.
  const top = Math.max(all[Math.floor(all.length * 0.995)] || 0, 0);
  const floor = top - 70;
  const px = Buffer.alloc(H * (1 + W * 3));
  const lineRows = new Set([250, 1000, 4000].map((hz) => H - 1 - Math.round(((H - 1) * Math.log(hz / lo)) / Math.log(hi / lo))));
  const seconds = frames / FPS;
  for (let y = 0; y < H; y++) {
    const r = H - 1 - y;
    const o = y * (1 + W * 3);
    px[o] = 0; // filter: none
    for (let c = 0; c < W; c++) {
      let [R, G, B] = colour((grid[r * W + c] - floor) / (top - floor));
      if (lineRows.has(y)) { R = Math.max(R, 70); G = Math.max(G, 70); B = Math.max(B, 70); }
      const t = (c * seconds) / W;
      const tPrev = ((c - 1) * seconds) / W;
      if (c > 0 && Math.floor(t) !== Math.floor(tPrev)) {
        const tall = Math.floor(t) % 5 === 0 ? 14 : 6;
        if (y >= H - tall) { R = 255; G = 255; B = 255; }
      }
      px[o + 1 + c * 3] = R;
      px[o + 2 + c * 3] = G;
      px[o + 3 + c * 3] = B;
    }
  }
  return encodePng(W, H, px);
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
// RGB, 8 bit; `rows` already carries the filter byte in front of every row.
export function encodePng(width, height, rows) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: RGB
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(rows, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

// Everything the namer needs about one sound (or a video's soundtrack).
export function describeAudio(ffmpeg, file, tmpDir, opts = {}) {
  const samples = decodeMono(ffmpeg, file, tmpDir, opts.maxSeconds || 90);
  const analysis = analyzeSamples(samples);
  const png = opts.picture === false ? null : spectrogramPng(analysis);
  return { facts: analysis.facts, spectrogram: png ? png.toString('base64') : null };
}
