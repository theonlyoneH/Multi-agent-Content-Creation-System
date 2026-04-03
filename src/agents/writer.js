/**
 * writer.js — WriterAgent
 *
 * Subscribes to:  plan.ready
 * Also listens:   edit.revision  (feedback loop from EditorAgent)
 * Publishes to:   draft.ready
 *
 * Key design:
 *   - Sections are drafted IN PARALLEL — each section is an independent
 *     LLM call with a concurrency limit to stay within API rate limits.
 *   - When receiving edit.revision, the writer revises specific sections
 *     based on editor feedback, then re-publishes draft.ready.
 *
 * Grounded generation (v2):
 *   - Reads context_chunks stored by RetrieverAgent
 *   - Uses strict grounding rules: no invented facts, no fake statistics,
 *     no fabricated expert quotes
 *   - Falls back to research.keyFacts when context_chunks absent
 */

import { BaseAgent }  from '../core/base.js';
import { createBus }   from '../core/bus.js';
import { createStore } from '../core/store.js';

// Concurrency limiter — prevents overwhelming the LLM API
const MAX_CONCURRENT_DRAFTS = 3;

async function limitConcurrency(tasks, limit) {
  const results = [];
  const executing = new Set();

  for (const task of tasks) {
    const p = task().then(result => {
      executing.delete(p);
      return result;
    });
    executing.add(p);
    results.push(p);

    if (executing.size >= limit) {
      await Promise.race(executing);
    }
  }

  return Promise.all(results);
}

export class WriterAgent extends BaseAgent {
  inputTopic       = 'plan.ready';
  outputTopic      = 'draft.ready';
  additionalTopics = ['edit.revision'];   // feedback loop

  async process(content, meta) {
    const { topic, research, audience = 'general', editNotes } = content;
    const isRevision = meta.incomingTopic === 'edit.revision';

    // ── Grounding: read context_chunks injected by RetrieverAgent ────────
    const contextChunks   = Array.isArray(content.context_chunks) && content.context_chunks.length > 0
      ? content.context_chunks
      : null;
    const contextSources  = Array.isArray(content.sources) ? content.sources : [];
    const cacheUsed       = content.retriever_cache_used ?? false;

    if (contextChunks) {
      console.log(`[WriterAgent] 📎  Using ${contextChunks.length} context chunk(s) for grounded generation` +
        (cacheUsed ? ' (from cache)' : ' (fresh retrieval)'));
    } else {
      console.log(`[WriterAgent] ⚠️  No context_chunks available — falling back to research.keyFacts`);
    }

    // Normalize plan — llama3 is inconsistent about structure
    let plan = content.plan;
    if (plan && !plan.sections && plan.plan) plan = plan.plan;   // unwrap nested { plan: {...} }

    // If sections still missing/empty, synthesize from whatever the LLM gave us
    if (!plan || !Array.isArray(plan.sections) || plan.sections.length === 0) {
      console.warn(`[WriterAgent] plan.sections missing — synthesizing fallback sections`);
      plan = {
        title:         plan?.title         || topic,
        hook:          plan?.hook          || `Exploring the key aspects of ${topic}.`,
        toneGuidelines: plan?.toneGuidelines || 'Informative, clear, and engaging.',
        callToAction:  plan?.callToAction  || 'Learn more and get started today.',
        sections: [
          { heading: 'Overview',          goal: 'Introduce the topic',          talkingPoints: [topic] },
          { heading: 'Key Developments',  goal: 'Cover recent developments',    talkingPoints: [topic] },
          { heading: 'Challenges',        goal: 'Discuss challenges',           talkingPoints: [topic] },
          { heading: 'Future Outlook',    goal: 'Describe future implications', talkingPoints: [topic] },
        ],
      };
    }

    if (isRevision && editNotes?.length) {
      return this._reviseFromFeedback(content);
    }

    // Fresh draft: parallel section writing with concurrency limit
    const tasks = [
      () => this._draftHook(plan, topic, audience, contextChunks),
      ...plan.sections.map(section =>
        () => this._draftSection(section, plan, research, topic, audience, contextChunks)
      ),
    ];

    const [hook, ...sectionDrafts] = await limitConcurrency(tasks, MAX_CONCURRENT_DRAFTS);

    const draft = {
      title:          plan.title        || topic,
      hook,
      sections:       plan.sections.map((section, i) => ({
        heading: section.heading,
        content: sectionDrafts[i],
      })),
      callToAction:   plan.callToAction || 'Learn more and get started today.',
      wordCount:      estimateWordCount(hook, sectionDrafts),
      contextSources, // propagate sources to final output
    };

    return {
      draft,
      revisionCount: 0,
    };
  }

  // ------------------------------------------------------------------
  // Targeted revision based on editor feedback
  // ------------------------------------------------------------------

  async _reviseFromFeedback(content) {
    const { draft, editNotes, plan, topic, audience = 'general' } = content;
    const revisionCount = (content.revisionCount || 0) + 1;

    // Find sections flagged by the editor
    const flaggedHeadings = new Set(editNotes.map(n => n.section));

    const revisedSections = await Promise.all(
      draft.sections.map(async (section) => {
        if (!flaggedHeadings.has(section.heading)) return section;

        const relevantNotes = editNotes
          .filter(n => n.section === section.heading)
          .map(n => `[${n.severity}] ${n.issue}`)
          .join('\n');

        const system = `You are an expert writer revising a section based on editor feedback.
Rewrite the section to address ALL noted issues. Keep the same heading.
Return ONLY the revised prose — no heading, no preamble.
Voice: ${plan.toneGuidelines}`;

        const user = `Topic: "${topic}" | Audience: ${audience}
Section: "${section.heading}"

Current content:
${section.content}

Editor feedback:
${relevantNotes}

Revise the section.`;

        const revised = await this.chat(system, user, { maxTokens: 600 });
        return { heading: section.heading, content: revised };
      })
    );

    return {
      draft: {
        ...draft,
        sections:  revisedSections,
        wordCount: estimateWordCount(draft.hook, revisedSections.map(s => s.content)),
      },
      revisionCount,
    };
  }

  // ------------------------------------------------------------------
  // Fresh drafting helpers
  // ------------------------------------------------------------------

  async _draftHook(plan, topic, audience, contextChunks) {
    const hasContext = contextChunks && contextChunks.length > 0;

    const system = hasContext
      ? `You are an expert writer. Write ONLY the opening hook — no heading, no preamble.
Expand the hook outline to 3–4 punchy sentences that make the reader want to continue.
Voice: ${plan.toneGuidelines}

GROUNDING RULES (MANDATORY):
- Base your hook ONLY on the provided context below.
- Do NOT invent statistics, studies, or expert names not found in the context.
- If the context is thin, write a compelling but non-specific hook.
- Do NOT add unsupported claims.`
      : `You are an expert writer. Write ONLY the opening hook — no heading, no preamble.
Use the provided hook outline and expand it to 3–4 punchy sentences that make the reader want to continue.
Voice: ${plan.toneGuidelines}`;

    const contextBlock = hasContext
      ? `\n\nContext to draw from:\n${contextChunks.map((c, i) => `[${i + 1}] ${c}`).join('\n\n')}`
      : '';

    const user = `Topic: "${topic}" | Audience: ${audience}
Hook outline: ${plan.hook}${contextBlock}`;

    return this.chat(system, user, { maxTokens: 300 });
  }

  async _draftSection(section, plan, research, topic, audience, contextChunks) {
    const hasContext = contextChunks && contextChunks.length > 0;

    let system;
    let user;

    if (hasContext) {
      // ── GROUNDED MODE: strict context-only generation ──────────────────
      system = `You are an expert writer. Write the body of ONE content section.
Do NOT include the section heading — just the prose. Aim for 200–300 words.
Voice: ${plan.toneGuidelines}

GROUNDING RULES (MANDATORY — violations are not acceptable):
1. Use ONLY information that appears in the "Retrieved Context" below.
2. Do NOT invent statistics, percentages, or numerical claims not in the context.
3. Do NOT fabricate expert names, quotes, or attribution.
4. Do NOT add claims that seem plausible but lack context support.
5. If the context does not contain enough information for a talking point,
   acknowledge the uncertainty explicitly (e.g., "Available information suggests..."
   or "This aspect requires further research.").
6. Prefer specific, factual statements extracted directly from the context.`;

      user = `Topic: "${topic}" | Audience: ${audience}
Section heading: "${section.heading}"
Goal for this section: ${section.goal}
Talking points to cover:
${section.talkingPoints.map(p => `• ${p}`).join('\n')}

Retrieved Context (use ONLY this):
${contextChunks.map((c, i) => `[${i + 1}] ${c}`).join('\n\n')}`;
    } else {
      // ── FALLBACK MODE: research facts only, clearly labelled ──────────
      system = `You are an expert writer. Write the body of ONE content section.
Do NOT include the section heading — just the prose. Aim for 200–300 words.
Voice: ${plan.toneGuidelines}

IMPORTANT: No external sources were retrieved for this article. Write based on
the research facts provided, but avoid inventing specific statistics or quotes.`;

      user = `Topic: "${topic}" | Audience: ${audience}
Section heading: "${section.heading}"
Goal for this section: ${section.goal}
Talking points to cover:
${section.talkingPoints.map(p => `• ${p}`).join('\n')}

Research facts (fallback — no retrieval available):
${(research?.keyFacts || []).slice(0, 5).map(f => `• ${f}`).join('\n')}`;
    }

    return this.chat(system, user, { maxTokens: 600 });
  }
}

function estimateWordCount(hook, sections) {
  const all = [hook, ...(Array.isArray(sections) ? sections : [])].join(' ');
  return all.split(/\s+/).length;
}

if (process.argv[1]?.endsWith('writer.js')) {
  const bus   = await createBus();
  const store = createStore(bus.mode === 'redis');
  const agent = new WriterAgent({ bus, store, name: 'WriterAgent' });
  await agent.start();
}
