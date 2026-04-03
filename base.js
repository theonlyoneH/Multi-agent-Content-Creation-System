/**
 * base.js — BaseAgent
 *
 * All agents extend this class. The contract is simple:
 *   - set  inputTopic  and  outputTopic  as class properties
 *   - implement  process(contentObj)  → returns patch to merge into the store
 *
 * BaseAgent handles:
 *   - Subscribing to inputTopic on start()
 *   - Reading the full content object from the store
 *   - Calling process() with retry + exponential backoff
 *   - Merging the result into the store
 *   - Publishing to outputTopic
 *   - Logging with timing
 *   - Graceful shutdown on SIGINT / SIGTERM
 */

import Anthropic from '@anthropic-ai/sdk';

const MAX_RETRIES  = 3;
const RETRY_BASE_MS = 800;

export class BaseAgent {
  // Subclasses must declare these:
  // inputTopic  = 'some.topic'
  // outputTopic = 'other.topic'

  constructor({ bus, store, name }) {
    this.bus   = bus;
    this.store = store;
    this.name  = name;
    this.llm   = new Anthropic();   // uses ANTHROPIC_API_KEY env var
    this._running = false;
  }
  
  // ------------------------------------------------------------------
  // Lifecycle
  // ------------------------------------------------------------------

  async start() {
    if (!this.inputTopic) throw new Error(`${this.name}: inputTopic not set`);
    if (!this.outputTopic) throw new Error(`${this.name}: outputTopic not set`);

    console.log(`[${this.name}] 🟢  listening on  "${this.inputTopic}"`);
    this._running = true;

    await this.bus.subscribe(this.inputTopic, envelope => this._handleEnvelope(envelope));

    // Graceful shutdown
    const shutdown = async (sig) => {
      console.log(`[${this.name}] ${sig} received — shutting down`);
      this._running = false;
      await this.bus.disconnect();
      await this.store.disconnect();
      process.exit(0);
    };
    process.on('SIGINT',  () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
  }

  // ------------------------------------------------------------------
  // Internal message handler
  // ------------------------------------------------------------------

  async _handleEnvelope(envelope) {
    const { id } = envelope.payload;
    if (!id) {
      console.warn(`[${this.name}] Message missing id — skipping`);
      return;
    }

    console.log(`[${this.name}] 📥  received  "${this.inputTopic}"  (job ${id})`);
    const t0 = Date.now();

    let content = await this.store.get(id);
    if (!content) {
      console.error(`[${this.name}] Content ${id} not found in store — skipping`);
      return;
    }

    // Run process() with retry
    let patch;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        patch = await this.process(content);
        break;
      } catch (err) {
        const isLast = attempt === MAX_RETRIES;
        console.error(`[${this.name}] process() error (attempt ${attempt}/${MAX_RETRIES}): ${err.message}`);
        if (isLast) throw err;   // bubble up → bus sends to DLQ
        await sleep(RETRY_BASE_MS * 2 ** (attempt - 1));
      }
    }

    // Persist the patch returned by process()
    const updated = await this.store.update(id, {
      ...patch,
      [`${this.name}_completedAt`]: new Date().toISOString(),
    });

    const elapsed = ((Date.now() - t0) / 1000).toFixed(2);
    console.log(`[${this.name}] ✅  done in ${elapsed}s — publishing  "${this.outputTopic}"`);

    await this.bus.publish(this.outputTopic, { id });
  }

  // ------------------------------------------------------------------
  // LLM helper — wraps the Anthropic SDK
  // ------------------------------------------------------------------

  async chat(systemPrompt, userPrompt, { maxTokens = 2048 } = {}) {
    const response = await this.llm.messages.create({
      model:      'claude-opus-4-5',
      max_tokens: maxTokens,
      system:     systemPrompt,
      messages:   [{ role: 'user', content: userPrompt }],
    });
    return response.content[0].text;
  }

  // ------------------------------------------------------------------
  // Subclasses implement this
  // ------------------------------------------------------------------

  async process(content) {
    throw new Error(`${this.name}: process() not implemented`);
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
