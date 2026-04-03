/**
 * research.js — ResearchAgent
 *
 * Subscribes to:  refined.request
 * Publishes to:   research.done
 *
 * Simulates web/RAG retrieval then uses the LLM to distill findings
 * into structured facts, key themes, and cited sources.
 */

import { BaseAgent } from '../core/base.js';
import { createBus }   from '../core/bus.js';
import { createStore } from '../core/store.js';

export class ResearchAgent extends BaseAgent {
  inputTopic  = 'refined.request';
  outputTopic = 'research.done';

  async process(content) {
    const {
      topic,
      rawTopic = topic,
      audience = 'general',
      depth = 'standard',
      queryRewrite,
    } = content;

    // --- Simulate retrieval layer (replace with real RAG / web search) ---
    const mockSources = simulateRetrieval(topic);

    const systemPrompt = `You are a research analyst. Synthesize the provided sources into a
structured research brief. Return JSON only with this shape:
{
  "keyThemes": string[],       // 4–6 recurring themes
  "keyFacts": string[],        // 6–10 concrete facts or data points
  "controversies": string[],   // 0–3 tensions or open debates
  "suggestedAngles": string[], // 3–5 editorial angles for the writer
  "sources": { "title": string, "summary": string }[]
}`;

    const userPrompt = `Topic: "${topic}"
Original user input: "${rawTopic}"
Target audience: ${audience}
Research depth: ${depth}
Detected intent: ${queryRewrite?.intent || 'unknown'}
Context added: ${queryRewrite?.context_added || 'none'}
Assumptions: ${formatAssumptions(queryRewrite?.assumptions)}

Sources retrieved:
${mockSources.map((s, i) => `[${i + 1}] ${s.title}\n${s.excerpt}`).join('\n\n')}

Produce the research brief JSON.`;

    const brief = await this.chatJSON(systemPrompt, userPrompt);

    return {
      research: brief,
      sources:  mockSources,
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function simulateRetrieval(topic) {
  return [
    {
      title:   `Latest developments in ${topic}`,
      excerpt: `Recent studies show significant progress in ${topic} with adoption rates growing 40% year-over-year...`,
      url:     `https://example.com/article-1`,
    },
    {
      title:   `The challenges facing ${topic} in 2025`,
      excerpt: `Despite rapid growth, ${topic} faces hurdles around regulation, scalability, and public trust...`,
      url:     `https://example.com/article-2`,
    },
    {
      title:   `Expert opinions on ${topic}`,
      excerpt: `Industry leaders diverge on the long-term trajectory of ${topic}, with optimists citing...`,
      url:     `https://example.com/article-3`,
    },
  ];
}

function formatAssumptions(assumptions) {
  if (!Array.isArray(assumptions) || assumptions.length === 0) {
    return 'none';
  }
  return assumptions.join(' | ');
}

// ---------------------------------------------------------------------------
// Standalone entry point (npm run agent:research)
// ---------------------------------------------------------------------------
if (process.argv[1]?.endsWith('research.js')) {
  const bus   = await createBus();
  const store = createStore(bus.mode === 'redis');
  const agent = new ResearchAgent({ bus, store, name: 'ResearchAgent' });
  await agent.start();
}
