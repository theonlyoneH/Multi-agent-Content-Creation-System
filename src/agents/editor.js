/**
 * editor.js — EditorAgent
 *
 * Subscribes to:  draft.ready
 * Publishes to:   edit.done       (when clean or max revisions hit)
 *            or:  edit.revision   (when major issues found, sends back to Writer)
 *
 * Runs two passes:
 *   1. Coherence check — flags gaps, contradictions, or thin sections
 *   2. Decision gate:
 *      - Major issues AND revisionCount < MAX_REVISIONS → publish edit.revision
 *      - Otherwise → full style revision → publish edit.done
 */

import { BaseAgent } from '../core/base.js';
import { createBus }   from '../core/bus.js';
import { createStore } from '../core/store.js';
import { config } from '../core/config.js';
import { stripCodeFence, serializeDraft } from '../core/schema.js';

export class EditorAgent extends BaseAgent {
  inputTopic  = 'draft.ready';
  outputTopic = 'edit.done';

  async process(content) {
    let { draft, plan, revisionCount = 0 } = content;

    // Normalize draft — ensure it has the expected shape
    if (!draft || !Array.isArray(draft.sections)) {
      console.warn(`[${this.name}] draft.sections missing — passing through without edit`);
      return {
        draft: draft || { title: content.topic || 'Article', hook: '', sections: [], callToAction: '' },
        editNotes: [],
      };
    }

    // Normalize plan sections for coherence check
    if (!plan || !Array.isArray(plan.sections)) {
      plan = { sections: [], toneGuidelines: 'Informative and clear.' };
    }

    // Pass 1: coherence check
    const issues = await this._coherenceCheck(draft, plan);

    // Guard: issues must be an array (LLM may return unexpected shapes)
    if (!Array.isArray(issues)) {
      console.warn(`[${this.name}] _coherenceCheck returned non-array (${typeof issues}) — treating as no issues`);
      return {
        draft: await this._revise(draft, plan, []),
        editNotes: [],
      };
    }

    const hasMajorIssues = issues.some(i => i.severity === 'major');
    const canRevise      = revisionCount < config.MAX_REVISIONS;

    // Decision gate: send back for revision or approve
    if (hasMajorIssues && canRevise) {
      console.log(
        `[${this.name}] 🔄  Major issues found (revision ${revisionCount + 1}/${config.MAX_REVISIONS}) — requesting rewrite`
      );
      return {
        patch: { editNotes: issues },
        publishTo: 'edit.revision',
      };
    }

    if (hasMajorIssues && !canRevise) {
      console.log(
        `[${this.name}] ⚠  Major issues remain but max revisions (${config.MAX_REVISIONS}) reached — proceeding anyway`
      );
    }

    const revised = await this._revise(draft, plan, issues);

    return {
      draft:     revised,
      editNotes: issues,
    };
  }

  // ------------------------------------------------------------------

  async _coherenceCheck(draft, plan) {
    const system = `You are a rigorous editor. Read the draft and the original content plan.
Return JSON only — an array of edit notes, each with shape:
{ "section": string, "issue": string, "severity": "minor"|"major" }
If no issues, return [].`;

    const draftText = serializeDraft(draft);

    const user = `Content plan goals:
${plan.sections.map(s => `• ${s.heading}: ${s.goal}`).join('\n')}

Draft:
${draftText}

Identify issues with coherence, coverage, or tone.`;

    try {
      const result = await this.chatJSON(system, user);

      // The LLM frequently wraps the array in an object like
      // { "issues": [...] } or { "editNotes": [...] } instead of
      // returning a bare array.  Unwrap if needed.
      if (Array.isArray(result)) return result;

      if (result && typeof result === 'object') {
        // Find the first property whose value is an array
        const arrProp = Object.values(result).find(v => Array.isArray(v));
        if (arrProp) return arrProp;
      }

      // Not an array and no array property found — treat as no issues
      console.warn(`[${this.name}] _coherenceCheck: LLM returned non-array JSON — treating as no issues`);
      return [];
    } catch {
      return [];   // no issues found / parse failed — let the draft proceed
    }
  }

  async _revise(draft, plan, issues) {
    const system = `You are a senior editor. Revise the article to fix all noted issues and
improve flow, transitions, and voice consistency.
Return a JSON object with the same shape as the input draft:
{
  "title": string,
  "hook": string,
  "sections": [{ "heading": string, "content": string }],
  "callToAction": string,
  "wordCount": number
}`;

    const user = `Original draft:
${JSON.stringify(draft, null, 2)}

Issues to fix:
${issues.length ? issues.map(i => `[${i.severity}] ${i.section}: ${i.issue}`).join('\n') : 'No major issues — tighten flow and add transitions only.'}

Tone guidelines: ${plan.toneGuidelines}

Return the revised draft JSON.`;

    return this.chatJSON(system, user);
  }
}

if (process.argv[1]?.endsWith('editor.js')) {
  const bus   = await createBus();
  const store = createStore(bus.mode === 'redis');
  const agent = new EditorAgent({ bus, store, name: 'EditorAgent' });
  await agent.start();
}
