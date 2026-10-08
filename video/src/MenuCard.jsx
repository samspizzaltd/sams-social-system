import React from 'react';
import {
  AbsoluteFill, Img, staticFile, useCurrentFrame, useVideoConfig,
  interpolate, spring, Easing
} from 'remotion';
import { BRAND } from './brand.js';

// 15s vertical card: dish photo slowly zooms, name + price slide in, CTA at the end.
export const MenuCard = ({ image, title, price, cta }) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();

  const zoom = interpolate(frame, [0, durationInFrames], [1.05, 1.22], {
    easing: Easing.inOut(Easing.ease)
  });

  const titleIn = spring({ frame: frame - 12, fps, config: { damping: 14 } });
  const priceIn = spring({ frame: frame - 26, fps, config: { damping: 14 } });
  const ctaStart = durationInFrames - 4 * fps;
  const ctaIn = spring({ frame: frame - ctaStart, fps, config: { damping: 16 } });

  return (
    <AbsoluteFill style={{ backgroundColor: BRAND.dark, fontFamily: BRAND.font }}>
      <AbsoluteFill>
        <Img
          src={staticFile(image)}
          style={{ width: '100%', height: '100%', objectFit: 'cover', transform: `scale(${zoom})` }}
        />
      </AbsoluteFill>

      {/* bottom gradient for legibility */}
      <AbsoluteFill
        style={{
          background: 'linear-gradient(180deg, rgba(0,0,0,0) 45%, rgba(20,12,8,0.88) 78%)'
        }}
      />

      {/* S mark */}
      <Img
        src={staticFile(BRAND.logoS)}
        style={{ position: 'absolute', top: 64, left: 60, width: 150,
          filter: 'drop-shadow(0 4px 14px rgba(0,0,0,0.35))' }}
      />

      {/* Slides up out of the lockup's way during the end card. */}
      <div style={{ position: 'absolute', left: 60, right: 60, bottom: 300,
        transform: `translateY(${-Math.max(0, ctaIn) * 190}px)` }}>
        <div style={{
          color: '#fff', fontSize: 96, fontWeight: 800, lineHeight: 1.06,
          transform: `translateY(${(1 - titleIn) * 80}px)`, opacity: titleIn,
          textShadow: '0 4px 24px rgba(0,0,0,0.55)'
        }}>
          {title}
        </div>
        <div style={{
          display: 'inline-block', marginTop: 36,
          background: BRAND.orange, color: '#fff',
          fontSize: 64, fontWeight: 800, padding: '16px 48px', borderRadius: 24,
          transform: `translateY(${(1 - priceIn) * 60}px)`, opacity: priceIn
        }}>
          {price}
        </div>
      </div>

      <div style={{
        position: 'absolute', left: 60, right: 60, bottom: 90, textAlign: 'left',
        opacity: Math.max(0, ctaIn), transform: `translateY(${(1 - ctaIn) * 40}px)`
      }}>
        <Img src={staticFile(BRAND.logoFull)} style={{ width: 360, display: 'block', marginBottom: 20 }} />
        <div style={{ color: BRAND.cream, fontSize: 42, fontWeight: 600 }}>
          {cta} · {BRAND.handle}
        </div>
      </div>
    </AbsoluteFill>
  );
};
