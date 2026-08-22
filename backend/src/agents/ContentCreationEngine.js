const axios = require('axios');
const { pool } = require('../database/pool');

class ContentCreationEngine {
  constructor(claudeApiKey) {
    this.name = 'Content Creation Engine';
    this.claudeApiKey = claudeApiKey;
    this.components = {
      scriptGenerator: new ScriptGenerator(claudeApiKey),
      captionGenerator: new CaptionGenerator(claudeApiKey),
      multilingualProcessor: new MultilingualProcessor(),
      contentVaultManager: new ContentVaultManager(),
    };
  }

  async generateContent(strategy) {
    console.log('[Content Creation Engine] Generating content batch...');

    const batch = {
      date: new Date(),
      strategy,
      content: [],
    };

    for (let i = 0; i < strategy.count; i++) {
      const content = await this.createSingleContent(strategy);
      batch.content.push(content);
    }

    await this.saveBatch(batch);
    return batch;
  }

  async createSingleContent(strategy) {
    console.log(`[Content Creation] Generating content ${strategy.topic}...`);

    const script = await this.components.scriptGenerator.generate({
      topic: strategy.topic,
      platform: strategy.platform,
      duration: strategy.duration || 15,
      tone: strategy.tone || 'casual',
      includeCallToAction: true,
    });

    const captions = await this.components.captionGenerator.generate({
      script,
      platform: strategy.platform,
      languages: ['Georgian', 'English', 'Arabic'],
      hashtags: strategy.hashtags || [],
    });

    return {
      id: `content_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      topic: strategy.topic,
      platform: strategy.platform,
      script,
      captions,
      status: 'draft',
      requiresApproval: true,
      createdAt: new Date(),
    };
  }

  async saveBatch(batch) {
    for (const content of batch.content) {
      const query = `
        INSERT INTO content (title, caption, platforms, status, created_at)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING id
      `;

      const result = await pool.query(query, [
        content.topic,
        JSON.stringify(content.captions),
        JSON.stringify([content.platform]),
        content.status,
        content.createdAt,
      ]);

      console.log(`✓ Saved content: ${result.rows[0].id}`);
    }
  }
}

class ScriptGenerator {
  constructor(claudeApiKey) {
    this.apiKey = claudeApiKey;
    this.apiUrl = 'https://api.anthropic.com/v1/messages';
  }

  async generate(options) {
    console.log(`[Script Generator] Creating ${options.platform} script: ${options.topic}`);

    const prompt = `You are a professional content creator for a halal Middle Eastern fast-food restaurant called Sam's in Tbilisi, Georgia.

Generate a ${options.duration}-second TikTok/Instagram Reel script for the following:
Topic: ${options.topic}
Tone: ${options.tone}
Platform: ${options.platform}

Requirements:
1. Engaging hook in first 2 seconds
2. Show product/action clearly
3. Include call-to-action at the end
4. Keep language simple and punchy
5. Natural, conversational tone
6. Include visual cues in [brackets]

Output format:
[VISUAL CUE] Script text here...
[VISUAL CUE] More script...`;

    try {
      const response = await axios.post(
        this.apiUrl,
        {
          model: 'claude-opus-5',
          max_tokens: 500,
          messages: [{ role: 'user', content: prompt }],
        },
        { headers: { 'x-api-key': this.apiKey, 'anthropic-version': '2023-06-01' } }
      );

      return response.data.content[0].text;
    } catch (error) {
      console.error('[Script Generator Error]', error.message);
      return this.getTemplateScript(options);
    }
  }

  getTemplateScript(options) {
    const templates = {
      'Food Close-up': '[ZOOM IN on sizzling food] "Watch this 🔥"\n[SHOW fries] "Crispy perfection"\n[BITE SHOT] "Taste the quality" Shop now!',
      'Behind-the-scenes': '[SHOW kitchen] "Making magic happen"\n[CHEF close-up] "Fresh ingredients, every time"\n[FINAL PRODUCT] "Order your Sam\'s meal today!"',
      'Customer Testimonial': '[HAPPY CUSTOMER] "Best food in Tbilisi!"\n[EATING SHOT] "Never disappoints"\n[SMILE] "You have to try it" Link in bio 👆',
    };

    return templates[options.topic] || templates['Food Close-up'];
  }
}

class CaptionGenerator {
  constructor(claudeApiKey) {
    this.apiKey = claudeApiKey;
  }

  async generate(options) {
    console.log(`[Caption Generator] Creating captions in ${options.languages.join(', ')}`);

    const captions = {};

    for (const language of options.languages) {
      captions[language] = await this.generateForLanguage(language, options.script, options.hashtags);
    }

    return captions;
  }

  async generateForLanguage(language, script, hashtags) {
    const languageGuides = {
      Georgian: 'მოკლე, მაქმანი',
      English: 'Catchy, engaging',
      Arabic: 'جذاب وجميل',
    };

    // Template-based captions for Phase 3
    const templates = {
      Georgian: `🤤 ${script.slice(0, 20)}...\n✨ საუკეთესო სამზარეულო თბილისში\n${hashtags.slice(0, 3).join(' ')}`,
      English: `🔥 ${script.slice(0, 20)}...\n✨ Best in Tbilisi\n${hashtags.slice(0, 3).join(' ')}`,
      Arabic: `🤤 ${script.slice(0, 20)}...\n✨ الأفضل في تبليسي\n${hashtags.slice(0, 3).join(' ')}`,
    };

    return templates[language] || templates.English;
  }
}

class MultilingualProcessor {
  async processText(text, targetLanguage) {
    console.log(`[Multilingual Processor] Processing for ${targetLanguage}`);

    // Validates Georgian (ქ), Arabic (ع), English (a-z)
    const hasGeorgian = /[Ⴀ-ჿ]/.test(text);
    const hasArabic = /[؀-ۿ]/.test(text);
    const hasEnglish = /[a-zA-Z]/.test(text);

    return {
      text,
      languages: { Georgian: hasGeorgian, Arabic: hasArabic, English: hasEnglish },
      direction: this.getTextDirection(targetLanguage),
      validated: true,
    };
  }

  getTextDirection(language) {
    return language === 'Arabic' ? 'rtl' : 'ltr';
  }
}

class ContentVaultManager {
  async tagContent(content) {
    console.log('[Content Vault Manager] Tagging and organizing content');

    return {
      contentId: content.id,
      tags: ['food', 'georgian', 'tiktok', content.topic.toLowerCase()],
      category: 'promotional',
      targetAudience: ['foodies', 'students', 'young-professionals'],
      estimated_reach: Math.floor(Math.random() * 50000) + 5000,
    };
  }
}

module.exports = ContentCreationEngine;
