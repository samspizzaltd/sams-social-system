import React from 'react';
import {
  AbsoluteFill, Img, OffthreadVideo, staticFile, useCurrentFrame,
  useVideoConfig, interpolate, spring, Easing
} from 'remotion';
import { BRAND } from './brand.js';

// Parses "m:ss" or plain seconds into seconds.
const toSeconds = (at) => {
  if (typeof at === 'number') return at;
  const m = /^(\d+):(\d+)$/.exec(String(at).trim());
  if (m) return Number(m[1]) * 60 + Number(m[2]);
  const n = Number(at);
  return Number.isFinite(n) ? n : 0;
};

// 30s vertical: background photo/video with the Claude-written script beats
// appearing as animated captions at their timestamps.
export const ScriptPromo = ({ image, video, beats }) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();

  const list = (beats || []).map((b, i, arr) => {
    const start = toSeconds(b.at) * fps;
    const end = i + 1 < arr.length ? toSeconds(arr[i + 1].at) * fps : durationInFrames;
    return { ...b, start, end: Math.max(end, start + fps) };
  });

  const zoom = interpolate(frame, [0, durationInFrames], [1.0, 1.15], {
    easing: Easing.inOut(Easing.ease)
  });

  return (
    <AbsoluteFill style={{ backgroundColor: BRAND.dark, fontFamily: BRAND.font }}>
      <AbsoluteFill>
        {video ? (
          <OffthreadVideo
            src={staticFile(video)}
            muted
            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
          />
        ) : (
          <Img
            src={staticFile(image)}
            style={{ width: '100%', height: '100%', objectFit: 'cover', transform: `scale(${zoom})` }}
          />
        )}
      </AbsoluteFill>

      <AbsoluteFill style={{
        background: 'linear-gradient(180deg, rgba(0,0,0,0.25) 0%, rgba(0,0,0,0) 30%, rgba(0,0,0,0) 55%, rgba(20,12,8,0.82) 85%)'
      }} />

      <Img
        src={staticFile(BRAND.logoS)}
        style={{ position: 'absolute', top: 64, right: 60, width: 130,
          filter: 'drop-shadow(0 4px 14px rgba(0,0,0,0.35))' }}
      />

      {list.map((b, i) => {
        if (frame < b.start || frame >= b.end) return null;
        const local = frame - b.start;
        const inAnim = spring({ frame: local, fps, config: { damping: 13 } });
        const fadeOut = interpolate(frame, [b.end - fps / 2, b.end], [1, 0], {
          extrapolateLeft: 'clamp', extrapolateRight: 'clamp'
        });
        const isHook = b.type === 'hook';
        const isCta = b.type === 'cta';
        return (
          <div
            key={i}
            style={{
              position: 'absolute', left: 70, right: 70,
              bottom: isCta ? 330 : 420,
              opacity: inAnim * fadeOut,
              transform: `translateY(${(1 - inAnim) * 70}px)`
            }}
          >
            <div style={{
              display: 'inline-block',
              background: isCta ? BRAND.orange : 'rgba(20,12,8,0.72)',
              color: '#fff',
              fontSize: isHook ? 72 : 58,
              fontWeight: 800,
              lineHeight: 1.15,
              padding: '28px 36px',
              borderRadius: 22,
              textShadow: '0 3px 16px rgba(0,0,0,0.4)'
            }}>
              {b.text}
            </div>
          </div>
        );
      })}

      <div style={{ position: 'absolute', bottom: 70, left: 70 }}>
        <Img src={staticFile(BRAND.logoFull)} style={{ width: 320, display: 'block' }} />
      </div>
    </AbsoluteFill>
  );
};
