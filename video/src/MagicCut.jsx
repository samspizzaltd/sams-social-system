import React from 'react';
import {
  AbsoluteFill, Audio, Freeze, Img, OffthreadVideo, Series, staticFile, useCurrentFrame,
  useVideoConfig, interpolate, spring
} from 'remotion';
import { BRAND } from './brand.js';

// The autopilot's branded edit of one of the owner's ready-made videos:
//  - the video itself, full length (vertical videos fill the frame; other
//    shapes sit on a blurred copy of themselves instead of being cropped),
//  - a scroll-stopping hook for the first ~2.8 s,
//  - the real Sam's S mark in the corner throughout (owner branding rule),
//  - the end line + the full "More Than Pizza" lockup for the last 3 s,
//  - the sound: the video's own, or a circulated one from the Sound Library
//    baked in (platform APIs cannot attach in-app music).
// Overlays stay inside the area Reels/TikTok/Shorts leave uncovered.
//
// Edit plan (2026-11-11, optional - the autopilot's writer makes it from
// timestamped frames): `segments` = the parts of the video to KEEP, in order
// (seconds of the original), `hold` = seconds the closing shot is held still,
// hookStart / hookEnd / endStart = when the hook and the end line show, in
// seconds of the EDITED video. Without a plan the edit is the whole video
// with the standard timing, exactly as before.

const clamp = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' };
const within = (v, lo, hi) => Math.min(Math.max(v, lo), Math.max(lo, hi));

// The picture: the whole clip, or the kept parts back to back and then the
// last frame held still.
function Picture({ video, segments, holdFrames, style, muted, volume }) {
  const { fps } = useVideoConfig();
  if (!segments) {
    return <OffthreadVideo src={staticFile(video)} muted={muted} volume={volume} style={style} />;
  }
  const last = segments[segments.length - 1];
  const lastLen = Math.max(1, Math.round((last.to - last.from) * fps));
  return (
    <Series>
      {segments.map((s, i) => (
        <Series.Sequence key={i} durationInFrames={Math.max(1, Math.round((s.to - s.from) * fps))}>
          <OffthreadVideo src={staticFile(video)} trimBefore={Math.round(s.from * fps)}
            muted={muted} volume={muted ? 0 : 1} style={style} />
        </Series.Sequence>
      ))}
      {holdFrames > 0 && (
        // The clip is started ON the last kept frame and frozen at its first
        // frame: inside a sequence the media time stops at the sequence's own
        // length, so freezing "frame N of the last part" would show the wrong
        // picture (found in the 2026-11-11 test render).
        <Series.Sequence durationInFrames={holdFrames}>
          <Freeze frame={0}>
            <OffthreadVideo src={staticFile(video)} trimBefore={Math.round(last.from * fps) + lastLen - 1} muted style={style} />
          </Freeze>
        </Series.Sequence>
      )}
    </Series>
  );
}

export const MagicCut = ({ video, sound, hook, endLine, fit, segments, hold, hookStart, hookEnd: hookEndAt, endStart: endStartAt }) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();

  const segs = Array.isArray(segments)
    ? segments.filter((s) => s && Number(s.to) - Number(s.from) > 0 && Number(s.from) >= 0)
      .map((s) => ({ from: Number(s.from), to: Number(s.to) }))
    : [];
  const plan = segs.length ? segs : null;
  const holdFrames = plan ? Math.max(0, Math.round((Number(hold) || 0) * fps)) : 0;
  const num = (v) => (v === undefined || v === null || v === '' ? NaN : Number(v));

  const hookFrom = Number.isFinite(num(hookStart)) ? within(Math.round(num(hookStart) * fps), 0, Math.floor(durationInFrames * 0.4)) : 0;
  const hookEnd = Number.isFinite(num(hookEndAt))
    ? within(Math.round(num(hookEndAt) * fps), hookFrom + Math.round(0.8 * fps), Math.floor(durationInFrames * 0.6))
    : Math.min(Math.round(2.8 * fps), Math.floor(durationInFrames * 0.45));
  const endStart = Number.isFinite(num(endStartAt))
    ? within(Math.round(num(endStartAt) * fps), hookEnd + Math.round(0.5 * fps), durationInFrames - fps)
    : Math.max(durationInFrames - Math.round(3 * fps), hookEnd + fps);

  const hookIn = spring({ frame: frame - hookFrom, fps, config: { damping: 14 } });
  const hookOut = interpolate(frame, [hookEnd - 8, hookEnd], [1, 0], clamp);
  const endIn = spring({ frame: frame - endStart, fps, config: { damping: 14 } });

  const fadeTail = (f) => interpolate(f, [durationInFrames - 15, durationInFrames], [1, 0], clamp);
  const soundVolume = (f) => interpolate(f, [0, 8], [0, 1], clamp) * fadeTail(f);

  const hookText = String(hook || '').trim();
  const endText = String(endLine || '').trim();

  return (
    <AbsoluteFill style={{ backgroundColor: BRAND.dark, fontFamily: BRAND.font }}>
      {fit === 'contain' && (
        <AbsoluteFill>
          <Picture video={video} segments={plan} holdFrames={holdFrames} muted
            style={{
              width: '100%', height: '100%', objectFit: 'cover',
              filter: 'blur(42px) brightness(0.55)', transform: 'scale(1.25)'
            }}
          />
        </AbsoluteFill>
      )}
      <AbsoluteFill>
        <Picture video={video} segments={plan} holdFrames={holdFrames}
          muted={!!sound}
          volume={sound ? 0 : fadeTail}
          style={{ width: '100%', height: '100%', objectFit: fit === 'contain' ? 'contain' : 'cover' }}
        />
      </AbsoluteFill>
      {sound ? <Audio src={staticFile(sound)} loop volume={soundVolume} /> : null}

      {/* legibility gradients, only while text is on screen */}
      <AbsoluteFill style={{
        opacity: hookText && frame >= hookFrom ? hookOut : 0,
        background: 'linear-gradient(180deg, rgba(0,0,0,0.55) 0%, rgba(0,0,0,0) 45%)'
      }} />
      <AbsoluteFill style={{
        opacity: interpolate(frame, [endStart, endStart + 10], [0, 1], clamp),
        background: 'linear-gradient(0deg, rgba(20,12,8,0.85) 0%, rgba(20,12,8,0) 50%)'
      }} />

      <Img
        src={staticFile(BRAND.logoS)}
        style={{
          position: 'absolute', top: 150, right: 56, width: 112,
          filter: 'drop-shadow(0 4px 14px rgba(0,0,0,0.4))'
        }}
      />

      {hookText && frame >= hookFrom && frame < hookEnd && (
        <div style={{
          position: 'absolute', left: 70, right: 190, top: 300,
          opacity: hookIn * hookOut,
          transform: `translateY(${(1 - hookIn) * -60}px)`
        }}>
          <div style={{
            display: 'inline-block',
            color: '#fff',
            fontSize: hookText.length > 26 ? 70 : 86,
            fontWeight: 900,
            lineHeight: 1.08,
            letterSpacing: -1,
            textShadow: '0 4px 22px rgba(0,0,0,0.65)'
          }}>
            {hookText}
          </div>
          <div style={{ width: 120, height: 10, borderRadius: 5, background: BRAND.orange, marginTop: 22 }} />
        </div>
      )}

      {frame >= endStart && (
        <div style={{
          position: 'absolute', left: 70, right: 70, bottom: 430,
          opacity: endIn,
          transform: `translateY(${(1 - endIn) * 60}px)`
        }}>
          {endText && (
            <div style={{
              display: 'inline-block',
              background: BRAND.orange,
              color: '#fff',
              fontSize: 60,
              fontWeight: 800,
              lineHeight: 1.15,
              padding: '24px 34px',
              borderRadius: 22,
              marginBottom: 26,
              boxShadow: '0 8px 30px rgba(0,0,0,0.35)'
            }}>
              {endText}
            </div>
          )}
          <Img src={staticFile(BRAND.logoFull)} style={{ width: 360, display: 'block' }} />
        </div>
      )}
    </AbsoluteFill>
  );
};
