/**
 * query-rewriter.js - QueryRewriterAgent
 *
 * Subscribes to:  content.request
 * Publishes to:   refined.request
 *
 * Transforms vague or messy raw user input into a concise, structured query
 * that gives the ResearchAgent a cleaner starting point.
 */

import { BaseAgent } from '../core/base.js';
import { createBus } from '../core/bus.js';
import { createStore } from '../core/store.js';

export class QueryRewriterAgent extends BaseAgent {
  inputTopic = 'content.request';
  outputTopic = 'refined.request';

  async process(content) {
    const rawTopic = String(content.rawTopic ?? content.topic ?? '').trim();

    if (!rawTopic) {
      console.warn(`[${this.name}] Empty topic received, using safe fallback rewrite`);
      const fallback = buildFallbackRewrite('the requested topic');
      return {
        rawTopic: content.rawTopic ?? content.topic ?? '',
        topic: fallback.refined_query,
        queryRewrite: fallback,
      };
    }

    const systemPrompt = `You improve messy user queries before research begins.
Return JSON only with this exact shape:
{
  "refined_query": string,
  "intent": string,
  "context_added": string,
  "assumptions": string[]
}

Rules:
- Rewrite the user's query into a concise but specific research instruction.
- Expand vague phrasing into clear analytical or informational tasks.
- Identify likely meaning without inventing facts.
- Add only safe, generic context that helps research framing.
- Keep assumptions minimal and explicit.
- If the input is already clear, lightly polish it instead of over-expanding.`;

    const userPrompt = `Raw user input: "${rawTopic}"
Audience: ${content.audience || 'general'}
Desired format: ${content.format || 'article'}
Target word count: ${content.wordCount || 1500}

Return the rewritten query object.`;

    let rewrite;
    try {
      rewrite = await this.chatJSON(systemPrompt, userPrompt);
      rewrite = normalizeRewrite(rewrite, rawTopic);
    } catch (err) {
      console.warn(`[${this.name}] Rewrite generation failed, using fallback: ${err.message}`);
      rewrite = buildFallbackRewrite(rawTopic);
    }

    console.log(`[${this.name}] Raw query: "${rawTopic}"`);
    console.log(`[${this.name}] Refined query: "${rewrite.refined_query}"`);

    return {
      rawTopic,
      topic: rewrite.refined_query,
      queryRewrite: rewrite,
    };
  }
}

function normalizeRewrite(rewrite, rawTopic) {
  if (!rewrite || typeof rewrite !== 'object' || Array.isArray(rewrite)) {
    return buildFallbackRewrite(rawTopic);
  }

  const refinedQuery = String(rewrite.refined_query ?? '').trim();
  const intent = String(rewrite.intent ?? '').trim();
  const contextAdded = String(rewrite.context_added ?? '').trim();
  const assumptions = Array.isArray(rewrite.assumptions)
    ? rewrite.assumptions
        .map(value => String(value ?? '').trim())
        .filter(Boolean)
        .slice(0, 5)
    : [];

  if (!refinedQuery || !intent || !contextAdded) {
    return buildFallbackRewrite(rawTopic);
  }

  return {
    refined_query: refinedQuery,
    intent,
    context_added: contextAdded,
    assumptions,
  };
}

function buildFallbackRewrite(rawTopic) {
  return {
    refined_query: `Explain and analyze "${rawTopic}" clearly, including its main meaning, important context, key developments, challenges, and practical implications.`,
    intent: 'informational analysis',
    context_added: 'expanded the raw input into a clearer research brief without adding specific facts',
    assumptions: [],
  };
}

if (process.argv[1]?.endsWith('query-rewriter.js')) {
  const bus = await createBus();
  const store = createStore(bus.mode === 'redis');
  const agent = new QueryRewriterAgent({ bus, store, name: 'QueryRewriterAgent' });
  await agent.start();
}
