// Thin wrapper around the Anthropic SDK.
//
// Design rule (same as database/db.js): Claude is an enhancement, never a
// dependency. If the SDK is missing, the key is unset, or the API errors,
// every method returns null and the calling agent falls back to its own
// deterministic output. A Claude outage must never fail a cycle.

let Anthropic = null;
try {
  Anthropic = require('@anthropic-ai/sdk');
} catch (err) {
  console.warn('[claude] @anthropic-ai/sdk not installed - agents will use fallback content');
}

const MODEL = 'claude-opus-5';

const state = {
  client: null,
  available: false,
  lastError: null,
  calls: 0,
  failures: 0,
  refusals: 0
};

function init() {
  if (!Anthropic) {
    state.lastError = '@anthropic-ai/sdk not installed';
    return false;
  }
  const apiKey = process.env.CLAUDE_API_KEY || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    state.lastError = 'CLAUDE_API_KEY not set';
    console.warn('[claude] ' + state.lastError + ' - agents will use fallback content');
    return false;
  }
  try {
    state.client = new Anthropic({ apiKey });
    state.available = true;
    console.log('[claude] ready (' + MODEL + ')');
    return true;
  } catch (err) {
    state.lastError = err.message;
    console.warn('[claude] init failed: ' + err.message);
    return false;
  }
}

// Ask Claude for JSON matching `schema`. Returns the parsed object, or null
// on any failure so the caller can fall back.
async function generateJSON(options) {
  if (!state.available) return null;

  const opts = options || {};
  state.calls++;

  try {
    const response = await state.client.beta.messages.create({
      model: MODEL,
      max_tokens: opts.maxTokens || 16000,
      system: opts.system,
      messages: [{ role: 'user', content: opts.prompt }],
      output_config: {
        format: { type: 'json_schema', schema: opts.schema },
        effort: opts.effort || 'medium'
      },
      // Opt in to server-side fallbacks: on a policy decline the API re-runs
      // the request on a fallback model within the same call.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default'
    });

    if (response.stop_reason === 'refusal') {
      state.refusals++;
      state.lastError = 'refusal: ' + ((response.stop_details && response.stop_details.category) || 'unknown');
      console.warn('[claude] ' + state.lastError);
      return null;
    }

    const textBlock = response.content.find(b => b.type === 'text');
    if (!textBlock) {
      state.failures++;
      state.lastError = 'no text block in response';
      return null;
    }

    return JSON.parse(textBlock.text);
  } catch (err) {
    state.failures++;
    state.lastError = err.message;
    console.warn('[claude] request failed: ' + err.message);
    return null;
  }
}

function status() {
  return {
    sdk: Anthropic ? 'installed' : 'not installed',
    available: state.available,
    model: state.available ? MODEL : null,
    calls: state.calls,
    failures: state.failures,
    refusals: state.refusals,
    lastError: state.lastError
  };
}

module.exports = { init, generateJSON, status, MODEL };
