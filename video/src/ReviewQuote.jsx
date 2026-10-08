import React from 'react';
import {
  AbsoluteFill, Img, staticFile, useCurrentFrame, useVideoConfig,
  interpolate, spring, Easing
} from 'remotion';
import { BRAND } from './brand.js';

// 10s vertical: customer quote over a dimmed photo, stars, brand footer.
export const ReviewQuote = ({ image, quote, author }) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();

  const zoom = interpolate(frame, [0, durationInFrames], [1.08, 1.0], {
    easing: Easing.inOut(Easing.ease)
  });
  const quoteIn = spring({ frame: frame - 8, fps, config: { damping: 15 } });
  const authorIn = spring({ frame: frame - 30, fps, config: { damping: 15 } });

  const stars = Array.from({ length: 5 }, (_, i) => {
    const s = spring({ frame: frame - 14 - i * 4, fps, config: { damping: 10 } });
    return (
      <span key={i} style={{
        display: 'inline-block', fontSize: 72, marginRight: 14,
        transform: `scale(${s})`, color: '#FFC536'
      }}>
        ★
      </span>
    );
  });

  return (
    <AbsoluteFill style={{ backgroundColor: BRAND.dark, fontFamily: BRAND.font }}>
      <AbsoluteFill>
        <Img
          src={staticFile(image)}
          style={{
            width: '100%', height: '100%', objectFit: 'cover',
            transform: `scale(${zoom})`, filter: 'brightness(0.45)'
          }}
        />
      </AbsoluteFill>

      <AbsoluteFill style={{ justifyContent: 'center', padding: '0 90px 430px' }}>
        <div>{stars}</div>
        <div style={{
          color: '#fff', fontSize: 84, fontWeight: 800, lineHeight: 1.18,
          marginTop: 40,
          opacity: quoteIn, transform: `translateY(${(1 - quoteIn) * 60}px)`,
          textShadow: '0 4px 24px rgba(0,0,0,0.5)'
        }}>
          “{quote}”
        </div>
        <div style={{
          color: BRAND.cream, fontSize: 46, fontWeight: 600, marginTop: 44,
          opacity: authorIn, transform: `translateY(${(1 - authorIn) * 40}px)`
        }}>
          — {author}
        </div>
      </AbsoluteFill>

      <div style={{
        position: 'absolute', bottom: 90, left: 0, right: 0, textAlign: 'center'
      }}>
        <Img src={staticFile(BRAND.logoFull)} style={{ width: 460 }} />
        <div style={{ color: BRAND.cream, fontSize: 38, fontWeight: 600, marginTop: 16 }}>
          {BRAND.handle}
        </div>
      </div>
    </AbsoluteFill>
  );
};
