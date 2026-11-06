import React from 'react';
import {
  AbsoluteFill, Audio, Img, OffthreadVideo, staticFile, useCurrentFrame,
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

const clamp = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' };

export const MagicCut = ({ video, sound, hook, endLine, fit }) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();

  const hookEnd = Math.min(Math.round(2.8 * fps), Math.floor(durationInFrames * 0.45));
  const endStart = Math.max(durationInFrames - Math.round(3 * fps), hookEnd + fps);

  const hookIn = spring({ frame, fps, config: { damping: 14 } });
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
          <OffthreadVideo
            src={staticFile(video)}
            muted
            style={{
              width: '100%', height: '100%', objectFit: 'cover',
              filter: 'blur(42px) brightness(0.55)', transform: 'scale(1.25)'
            }}
          />
        </AbsoluteFill>
      )}
      <AbsoluteFill>
        <OffthreadVideo
          src={staticFile(video)}
          muted={!!sound}
          volume={sound ? 0 : fadeTail}
          style={{ width: '100%', height: '100%', objectFit: fit === 'contain' ? 'contain' : 'cover' }}
        />
      </AbsoluteFill>
      {sound ? <Audio src={staticFile(sound)} loop volume={soundVolume} /> : null}

      {/* legibility gradients, only while text is on screen */}
      <AbsoluteFill style={{
        opacity: hookText ? hookOut : 0,
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

      {hookText && frame < hookEnd && (
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
