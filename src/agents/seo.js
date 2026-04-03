/**
 * seo.js — SEOAgent
 *
 * Subscribes to:  edit.done
 * Publishes to:   seo.done
 *
 * Enriches the final draft with SEO metadata:
 *   - Primary + secondary keywords (naturally woven in)
 *   - Meta title and meta description
 *   - Slug suggestion
 *   - Internal linking placeholders
 *   - Alt text suggestions for images
 */

import { BaseAgent } from '../core/base.js';
import { createBus }   from '../core/bus.js';
import { createStore } from '../core/store.js';
import { stripCodeFence, serializeDraft } from '../core/schema.js';

export class SEOAgent extends BaseAgent {
  inputTopic  = 'edit.done';
  outputTopic = 'seo.done';

  async process(content) {
    const { draft, topic, research } = content;

    const system = `You are an SEO specialist. Analyze the article and produce an SEO package.
Return JSON only with this exact shape:
{
  "primaryKeyword": string,
  "secondaryKeywords": string[],       // 4–6 LSI keywords
  "metaTitle": string,                 // ≤60 chars, includes primary keyword
  "metaDescription": string,           // ≤155 chars, compelling, includes keyword
  "slug": string,                      // URL-friendly, hyphenated
  "altTextSuggestions": string[],      // 2–3 image alt text ideas
  "internalLinkPlaceholders": string[] // 2–3 anchor text suggestions for internal links
}`;

    const articleText = serializeDraft(draft);

    const user = `Topic: "${topic}"
Known themes: ${research.keyThemes.join(', ')}

Article:
${articleText}

Produce the SEO package JSON.`;

    const seoPkg = await this.chatJSON(system, user);

    // Optionally rewrite draft sections for better keyword density
    const optimizedDraft = await this._injectKeywords(draft, seoPkg);

    return {
      seo:   seoPkg,
      draft: optimizedDraft,
    };
  }

  // ------------------------------------------------------------------

  async _injectKeywords(draft, seoPkg) {
    const system = `You are an SEO writer. Lightly integrate the provided keywords into the article
without changing meaning or voice. Aim for 1–2% keyword density. Return the full revised draft JSON
with the same shape as the input.`;

    const user = `Primary keyword: "${seoPkg.primaryKeyword}"
Secondary keywords: ${seoPkg.secondaryKeywords.join(', ')}

Draft:
${JSON.stringify(draft, null, 2)}`;

    try {
      return await this.chatJSON(system, user);
    } catch {
      return draft;  // fall back to unmodified draft on parse failure
    }
  }
}

if (process.argv[1]?.endsWith('seo.js')) {
  const bus   = await createBus();
  const store = createStore(bus.mode === 'redis');
  const agent = new SEOAgent({ bus, store, name: 'SEOAgent' });
  await agent.start();
}
