/**
 * planner.js — PlannerAgent
 *
 * Subscribes to:  research.done
 * Publishes to:   plan.ready
 *
 * Reads the research brief and produces a detailed content plan:
 * title, hook, sections (each with goal + talking points), and CTA.
 */

import { BaseAgent } from '../core/base.js';
import { createBus }   from '../core/bus.js';
import { createStore } from '../core/store.js';
import { stripCodeFence } from '../core/schema.js';

export class PlannerAgent extends BaseAgent {
  inputTopic  = 'research.done';
  outputTopic = 'plan.ready';

  async process(content) {
    const { topic, research, audience = 'general', format = 'article', wordCount = 1200 } = content;

    const systemPrompt = `You are a senior content strategist. Your job is to turn a research brief
into a precise, actionable content plan for a writer. Return JSON only with this shape:
{
  "title": string,              // compelling headline
  "hook": string,               // 2–3 sentence opening hook
  "sections": [
    {
      "heading": string,
      "goal": string,           // what this section should achieve
      "talkingPoints": string[] // 3–5 bullet points for the writer
    }
  ],
  "callToAction": string,       // closing CTA
  "toneGuidelines": string      // 1 paragraph on voice & tone
}`;

    const userPrompt = `Topic: "${topic}"
Audience: ${audience}
Format: ${format}
Target word count: ~${wordCount} words

Research brief:
- Key themes: ${research.keyThemes.join(', ')}
- Key facts: ${research.keyFacts.join(' | ')}
- Editorial angles available: ${research.suggestedAngles.join(', ')}

Produce the content plan JSON.`;

    const plan = await this.chatJSON(systemPrompt, userPrompt);

    return { plan };
  }
}

if (process.argv[1]?.endsWith('planner.js')) {
  const bus   = await createBus();
  const store = createStore(bus.mode === 'redis');
  const agent = new PlannerAgent({ bus, store, name: 'PlannerAgent' });
  await agent.start();
}
