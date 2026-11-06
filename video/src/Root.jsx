import React from 'react';
import { Composition } from 'remotion';
import { MenuCard } from './MenuCard.jsx';
import { ScriptPromo } from './ScriptPromo.jsx';
import { ReviewQuote } from './ReviewQuote.jsx';
import { MagicCut } from './MagicCut.jsx';

const FPS = 30;

export const Root = () => (
  <>
    <Composition
      id="MenuCard"
      component={MenuCard}
      durationInFrames={15 * FPS}
      fps={FPS}
      width={1080}
      height={1920}
      defaultProps={{
        image: 'sample.jpg',
        title: 'Chicken Shawarma',
        price: '15 GEL',
        cta: 'Order now - 100 Mirian Mepe St'
      }}
    />
    <Composition
      id="ScriptPromo"
      component={ScriptPromo}
      durationInFrames={30 * FPS}
      fps={FPS}
      width={1080}
      height={1920}
      defaultProps={{
        image: 'sample.jpg',
        video: null,
        beats: [
          { at: '0:00', type: 'hook', text: 'POV: you just found the best shawarma in Tbilisi' },
          { at: '0:08', type: 'body', text: 'Marinated overnight. Carved fresh. No shortcuts.' },
          { at: '0:22', type: 'cta', text: 'Comment HUNGRY and come get yours' }
        ]
      }}
    />
    <Composition
      id="ReviewQuote"
      component={ReviewQuote}
      durationInFrames={10 * FPS}
      fps={FPS}
      width={1080}
      height={1920}
      defaultProps={{
        image: 'sample.jpg',
        quote: 'Best shawarma in Tbilisi, hands down.',
        author: 'Google review'
      }}
    />
    <Composition
      id="MagicCut"
      component={MagicCut}
      durationInFrames={15 * FPS}
      fps={FPS}
      width={1080}
      height={1920}
      // The edit is as long as the owner's video (the worker measures it).
      calculateMetadata={({ props }) => ({
        durationInFrames: Math.max(3 * FPS, Number(props.durationInFrames) || 15 * FPS)
      })}
      defaultProps={{
        video: 'jobs/demo.mp4',
        sound: null,
        hook: 'Watch this come out of the oven',
        endLine: 'Come by tonight',
        fit: 'cover',
        durationInFrames: 15 * FPS
      }}
    />
  </>
);
