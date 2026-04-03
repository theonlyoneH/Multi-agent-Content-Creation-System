/**
 * base.js — BaseAgent
 *
 * All agents extend this class. The contract is simple:
 *   - set  inputTopic  and  outputTopic  as class properties
 *   - optionally set  additionalTopics  to subscribe to extra topics
 *   - implement  process(content, meta)  → returns patch to merge into the store
 *
 * BaseAgent handles:
 *   - Subscribing to inputTopic (+ additionalTopics) on start()
 *   - Reading the full content object from the store
 *   - Calling process() with retry + exponential backoff
 *   - Merging the result into the store
 *   - Publishing to outputTopic (overridable per-call)
 *   - Logging with timing
 *   - Graceful shutdown (registered once, not per-agent)
 *   - Agent status tracking (idle / processing / error)
 *
 * LLM: Ollama (local). No external API key required.
 *   Requires Ollama running at OLLAMA_BASE_URL with model OLLAMA_MODEL.
 */

import { config } from './config.js';
import { validateEnvelope } from './schema.js';

// Track agents for coordinated shutdown (registered once globally)
const activeAgents = new Set();
let shutdownRegistered = false;

function registerShutdownOnce() {
  if (shutdownRegistered) return;
  shutdownRegistered = true;

  const shutdown = async (sig) => {
    console.log(`\n[system] ${sig} received — shutting down ${activeAgents.size} agent(s)…`);
    const teardowns = [...activeAgents].map(agent => agent.stop());
    await Promise.allSettled(teardowns);
    process.exit(0);
  };

  process.on('SIGINT',  () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

export class BaseAgent {
  // Subclasses must declare:
  //   inputTopic  = 'some.topic'
  //   outputTopic = 'other.topic'
  //
  // Optional:
  //   additionalTopics = ['extra.topic']   (e.g., Writer listens for revisions)

  constructor({ bus, store, name }) {
    this.bus      = bus;
    this.store    = store;
    this.name     = name;
    this.status   = 'idle';   // idle | processing | error
    this._running = false;
  }

  // ------------------------------------------------------------------
  // Lifecycle
  // ------------------------------------------------------------------

  async start() {
    if (!this.inputTopic)  throw new Error(`${this.name}: inputTopic not set`);
    if (!this.outputTopic) throw new Error(`${this.name}: outputTopic not set`);

    this._running = true;
    activeAgents.add(this);
    registerShutdownOnce();

    // Primary topic
    await this.bus.subscribe(this.inputTopic, envelope => this._handleEnvelope(envelope));
    console.log(`[${this.name}] 🟢  listening on  "${this.inputTopic}"`);

    // Additional topics (e.g., Writer also listens on edit.revision)
    if (Array.isArray(this.additionalTopics)) {
      for (const topic of this.additionalTopics) {
        await this.bus.subscribe(topic, envelope => this._handleEnvelope(envelope));
        console.log(`[${this.name}] 🟢  also listening on  "${topic}"`);
      }
    }
  }

  async stop() {
    console.log(`[${this.name}] 🔴  stopping`);
    this._running = false;
    activeAgents.delete(this);
    await this.bus.disconnect().catch(() => {});
    await this.store.disconnect().catch(() => {});
  }

  // ------------------------------------------------------------------
  // Internal message handler
  // ------------------------------------------------------------------

  async _handleEnvelope(envelope) {
    // Validate envelope structure
    const check = validateEnvelope(envelope);
    if (!check.valid) {
      console.warn(`[${this.name}] ⚠  Invalid message — ${check.reason}`);
      return;
    }

    const { id } = envelope.payload;
    const incomingTopic = envelope.topic || this.inputTopic;

    console.log(`[${this.name}] 📥  received  "${incomingTopic}"  (job ${id})`);
    const t0 = Date.now();
    this.status = 'processing';

    // Read content from store
    let content = await this.store.get(id);
    if (!content) {
      console.error(`[${this.name}] Content ${id} not found in store — skipping`);
      this.status = 'idle';
      return;
    }

    // Run process() with retry + exponential backoff
    let result;
    for (let attempt = 1; attempt <= config.MAX_RETRIES; attempt++) {
      try {
        // Pass metadata so agents can make routing decisions
        result = await this.process(content, {
          incomingTopic,
          attempt,
          jobId: id,
        });
        break;
      } catch (err) {
        const isLast = attempt === config.MAX_RETRIES;
        console.error(
          `[${this.name}] process() error (attempt ${attempt}/${config.MAX_RETRIES}): ${err.message}`
        );
        if (isLast) {
          this.status = 'error';
          throw err;   // bubble up → bus sends to DLQ
        }
        await sleep(config.RETRY_BASE_MS * 2 ** (attempt - 1));
      }
    }

    // result can specify: { patch, publishTo }
    // - patch:     fields to merge into the store  (default: the entire result)
    // - publishTo: override output topic            (default: this.outputTopic)
    const patch     = result.patch     ?? result;
    const publishTo = result.publishTo ?? this.outputTopic;

    // Persist
    await this.store.update(id, {
      ...patch,
      [`${this.name}_completedAt`]: new Date().toISOString(),
    });

    const elapsed = ((Date.now() - t0) / 1000).toFixed(2);
    console.log(`[${this.name}] ✅  done in ${elapsed}s — publishing  "${publishTo}"`);

    await this.bus.publish(publishTo, { id }, this.name);
    this.status = 'idle';
  }

  // ------------------------------------------------------------------
  // LLM helper — calls local Ollama server via fetch
  // ------------------------------------------------------------------

  /**
   * @param {string} systemPrompt
   * @param {string} userPrompt
   * @param {object} [opts]              Optional overrides
   * @param {number} [opts.maxTokens]    Max tokens (maps to Ollama num_predict)
   * @param {boolean} [opts.json]        Force JSON mode (default: false)
   */
  async chat(systemPrompt, userPrompt, opts = {}) {
    // Combine into a single prompt — Ollama /api/generate takes one string
    const prompt = `${systemPrompt}\n\n${userPrompt}`;

    const body = {
      model:  config.OLLAMA_MODEL,
      prompt,
      stream: false,
    };

    // Apply optional overrides
    if (opts.maxTokens) body.num_predict = opts.maxTokens;
    if (opts.json)      body.format = 'json';

    let res;
    try {
      res = await fetch(`${config.OLLAMA_BASE_URL}/api/generate`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(body),
      });
    } catch (err) {
      // Network-level failure — Ollama not running or wrong URL
      throw new Error(
        `[${this.name}] Ollama unreachable at ${config.OLLAMA_BASE_URL} — is Ollama running? (${err.message})`
      );
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '(no body)');
      throw new Error(
        `[${this.name}] Ollama returned HTTP ${res.status}: ${body}`
      );
    }

    const data = await res.json();

    if (!data?.response) {
      throw new Error(
        `[${this.name}] Ollama response missing 'response' field: ${JSON.stringify(data)}`
      );
    }

    return data.response.trim();
  }

  /**
   * chatJSON(systemPrompt, userPrompt) → parsed JS object/array
   *
   * Wraps chat() with:
   *  1. Ollama native JSON mode (format:"json") — guarantees syntactically valid JSON
   *  2. A strong JSON-only instruction prefix as belt-AND-suspenders
   *  3. Extraction of first valid JSON block from any surrounding prose
   * Use this everywhere an agent needs structured JSON back from the LLM.
   */
  async chatJSON(systemPrompt, userPrompt) {
    const strictSystem =
      systemPrompt + '\n\n' +
      'CRITICAL INSTRUCTION: Respond with valid JSON ONLY. ' +
      'No explanation, no markdown, no code fences, no prose before or after. ' +
      'Your entire response must be a single JSON object starting with { or array starting with [.';

    // Use native Ollama JSON mode for structural correctness
    const raw = await this.chat(strictSystem, userPrompt, { json: true });
    return extractJSON(raw, this.name);
  }

  // ------------------------------------------------------------------
  // Subclasses implement this
  // ------------------------------------------------------------------

  /**
   * process(content, meta) → patch object  OR  { patch, publishTo }
   *
   * @param {object} content   Full content object from the store
   * @param {object} meta      { incomingTopic, attempt, jobId }
   * @returns {object}         Fields to merge into the store.
   *                           Optionally wrap in { patch, publishTo } to
   *                           override the default outputTopic.
   */
  async process(content, meta) {
    throw new Error(`${this.name}: process() not implemented`);
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * extractJSON(raw, agentName)
 *
 * Robustly extracts JSON from an LLM response that may contain:
 *  - Surrounding prose  ("Here is the JSON: {...}")
 *  - Markdown fences    (```json\n{...}\n```)
 *  - Just bare JSON     ({...})
 *
 * Tries strategies in order until one succeeds.
 */
function extractJSON(raw, agentName = 'agent') {
  if (!raw || typeof raw !== 'string') {
    throw new Error(`[${agentName}] LLM returned empty response`);
  }

  // Strategy 1: direct parse (the happy path)
  try { return JSON.parse(raw); } catch {}

  // Strategy 2: strip markdown code fences
  const fenceStripped = raw
    .replace(/^```(?:json)?\s*/im, '')
    .replace(/```\s*$/im, '')
    .trim();
  try { return JSON.parse(fenceStripped); } catch {}

  // Strategy 3: extract first { ... } or [ ... ] block
  const objMatch = raw.match(/\{[\s\S]*\}/);
  if (objMatch) {
    try { return JSON.parse(objMatch[0]); } catch {}
  }
  const arrMatch = raw.match(/\[[\s\S]*\]/);
  if (arrMatch) {
    try { return JSON.parse(arrMatch[0]); } catch {}
  }

  // All strategies failed
  throw new Error(
    `[${agentName}] Could not extract JSON from LLM response.\n` +
    `First 300 chars: ${raw.slice(0, 300)}`
  );
}
