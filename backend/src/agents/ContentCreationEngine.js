const claude = require('../services/claudeClient');

const BUSINESS =
  "Sam's, a halal Middle Eastern fast-food restaurant in Tbilisi, Georgia. " +
  'Serves shawarma, falafel, grills and wraps.';

const VOICE =
  'Write like a real restaurant, not a marketing agency. Warm, direct, a little playful. ' +
  'No corporate filler, no excessive exclamation marks, no invented awards or claims. ' +
  'Never promise anything the restaurant has not actually said it offers.';

class ContentCreationEngine {
  constructor(apiKey) { this.apiKey = apiKey; }

  async generateCaption(topic, platform) {
    const target = platform || 'tiktok';
    const generated = await claude.generateJSON({
      system: 'You write social captions for ' + BUSINESS + ' ' + VOICE,
      prompt:
        'Write one ' + target + ' caption about: ' + topic + '. ' +
        'Include a natural call to action and 3-5 hashtags that fit the Tbilisi food scene.',
      effort: 'low',
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['caption'],
        properties: { caption: { type: 'string' } }
      }
    });
    if (generated) return generated.caption;

    const tag = String(topic).replace(/[^a-zA-Z0-9]/g, '');
    return 'Fresh out of the kitchen: ' + topic +
      '! Tag someone who needs this today. #' + tag + ' #halal #foodie #tbilisi';
  }

  async generateVideoScript(topic, duration) {
    const seconds = duration || 30;
    const generated = await claude.generateJSON({
      system: 'You are a short-form video director for ' + BUSINESS + ' ' + VOICE,
      prompt:
        'Write a ' + seconds + '-second vertical video script about: ' + topic + '. ' +
        'It must be shootable on a phone inside a small restaurant. Each beat needs a ' +
        'timestamp, what is on screen, and any spoken or on-screen text.',
      effort: 'medium',
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['beats'],
        properties: {
          beats: {
            type: 'array',
            minItems: 2,
            maxItems: 8,
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['at', 'type', 'text'],
              properties: {
                at: { type: 'string' },
                type: { type: 'string', enum: ['hook', 'body', 'cta'] },
                text: { type: 'string' }
              }
            }
          }
        }
      }
    });
    if (generated) return { duration: seconds, source: 'claude', beats: generated.beats };

    return {
      duration: seconds,
      source: 'fallback',
      beats: [
        { at: '0:00', type: 'hook', text: 'POV: you just found the best ' + topic + ' in Tbilisi' },
        { at: '0:03', type: 'body', text: 'Close-up of ' + topic + ' being prepared, natural sound.' },
        { at: '0:' + (seconds - 5), type: 'cta', text: 'Comment HUNGRY and we will save you a table.' }
      ]
    };
  }

  async generateCarouselPost(topic) {
    const generated = await claude.generateJSON({
      system: 'You design Instagram carousels for ' + BUSINESS + ' ' + VOICE,
      prompt: 'Design a 5-slide Instagram carousel about: ' + topic,
      effort: 'medium',
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['slides'],
        properties: {
          slides: {
            type: 'array',
            minItems: 3,
            maxItems: 6,
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['slide', 'visual', 'caption'],
              properties: {
                slide: { type: 'integer' },
                visual: { type: 'string' },
                caption: { type: 'string' }
              }
            }
          }
        }
      }
    });
    if (generated) return generated.slides;

    return [1, 2, 3, 4, 5].map(n => ({
      slide: n,
      visual: 'Slide ' + n + ' visual for ' + topic,
      caption: topic + ' - point ' + n
    }));
  }

  async generateProductDescription(productName, ingredients) {
    const list = (ingredients || []).join(', ');
    const generated = await claude.generateJSON({
      system: 'You write menu copy for ' + BUSINESS + ' ' + VOICE,
      prompt:
        'Write a short, appetising description of ' + productName +
        (list ? ' made with ' + list : '') + '. Two sentences maximum.',
      effort: 'low',
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['description'],
        properties: { description: { type: 'string' } }
      }
    });
    if (generated) return generated.description;

    return productName + ' - made with ' + (list || 'fresh halal ingredients') +
      '. Prepared to order, served hot.';
  }
}

module.exports = { ContentCreationEngine };
