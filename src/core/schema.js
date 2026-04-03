/**
 * schema.js — Shared message helpers, serializers, and validators
 *
 * Eliminates the copy-pasted stripCodeFence / serializeDraft functions
 * and provides a single place for message envelope logic.
 */

// ------------------------------------------------------------------
// Message envelope
// ------------------------------------------------------------------

/**
 * Create a standard message envelope.
 * Every message on the bus uses this shape.
 */
export function createEnvelope(topic, payload, source = 'system') {
  return {
    id:        payload.id,
    topic,
    source,
    timestamp: new Date().toISOString(),
    payload,
  };
}

/**
 * Validate an incoming envelope has the required fields.
 * Returns { valid: true } or { valid: false, reason: string }.
 */
export function validateEnvelope(msg) {
  if (!msg || typeof msg !== 'object') {
    return { valid: false, reason: 'Message is not an object' };
  }
  if (!msg.payload || typeof msg.payload !== 'object') {
    return { valid: false, reason: 'Missing or invalid payload' };
  }
  if (!msg.payload.id) {
    return { valid: false, reason: 'Missing payload.id (content job ID)' };
  }
  return { valid: true };
}

// ------------------------------------------------------------------
// LLM output helpers
// ------------------------------------------------------------------

/**
 * Strip ```json ... ``` fencing from LLM responses.
 * Previously duplicated across 4 agent files.
 */
export function stripCodeFence(str) {
  return str
    .replace(/^```(?:json)?\n?/m, '')
    .replace(/```\s*$/m, '')
    .trim();
}

/**
 * Serialize a draft object into readable markdown text.
 * Previously duplicated across editor, seo, and publisher.
 */
export function serializeDraft(draft) {
  if (!draft) return '(no draft)';
  const lines = [`# ${draft.title || 'Untitled'}`, '', draft.hook || '', ''];
  for (const s of (draft.sections || [])) {
    lines.push(`## ${s.heading || ''}`, s.content || '', '');
  }
  lines.push(draft.callToAction || '');
  return lines.join('\n');
}
