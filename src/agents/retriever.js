/**
 * retriever.js — RetrieverAgent
 *
 * Subscribes to:  refined.request
 * Publishes to:   context.ready
 *
 * Pipeline position:
 *   refined.request → RetrieverAgent → context.ready
 *
 * Responsibilities:
 *   1. Cache-first: check store for prior retrieval on same normalised query
 *   2. SerpAPI retrieval (PRIMARY) — max 1 call per user request
 *   3. ContextFilter — deduplicate, remove SEO noise, rank by relevance
 *   4. LLM fallback — synthesised context when API fails / quota exceeded
 *   5. Store context_chunks + sources for WriterAgent to consume
 *
 * API budget: ≤1 SerpAPI call per pipeline run.  Cache hits are free.
 */

import { BaseAgent }  from '../core/base.js';
import { createBus }  from '../core/bus.js';
import { createStore } from '../core/store.js';
import { config }     from '../core/config.js';

// ─── SerpAPI endpoint ────────────────────────────────────────────────────────
const SERP_API_URL = 'https://serpapi.com/search.json';

// ─── Noise patterns to filter out of snippets ───────────────────────────────
const NOISE_PATTERNS = [
  /\b(buy now|click here|subscribe|sign up|newsletter|cookie|privacy policy|terms of service)\b/i,
  /\b(best price|discount|limited offer|sale|promo code)\b/i,
  /^\s*[\d]+\s*(results?|items?|products?)\s+found/i,
  /\.\.\.\s*$/, // trailing ellipsis with nothing useful
];

// ─── Minimum useful snippet length ───────────────────────────────────────────
const MIN_CHUNK_LEN = 40;

export class RetrieverAgent extends BaseAgent {
  inputTopic  = 'refined.request';
  outputTopic = 'context.ready';

  // ------------------------------------------------------------------
  // Main process
  // ------------------------------------------------------------------

  async process(content) {
    const {
      topic,
      rawTopic = topic,
      queryRewrite,
    } = content;

    const refinedQuery = queryRewrite?.refined_query || topic || rawTopic;
    const normalised   = normaliseQuery(refinedQuery);
    const maxChunks    = config.RETRIEVER_MAX_CHUNKS;

    console.log(`[${this.name}] 🔍  query: "${refinedQuery}"`);
    console.log(`[${this.name}]       normalised cache key: "${normalised}"`);

    // ── 1. Cache check ─────────────────────────────────────────────────────
    const cacheHit = await this._checkCache(content.id, normalised);
    if (cacheHit) {
      console.log(`[${this.name}] 💾  Cache HIT — skipping SerpAPI call`);
      return {
        context_chunks:  cacheHit.context_chunks,
        sources:         cacheHit.sources,
        retriever_cache_used: true,
        retriever_query: normalised,
      };
    }

    // ── 2. SerpAPI retrieval ───────────────────────────────────────────────
    let rawResults = null;
    let serpError  = null;

    if (config.SERPAPI_KEY) {
      try {
        rawResults = await this._fetchSerpAPI(refinedQuery);
        console.log(`[${this.name}] 🌐  SerpAPI returned ${rawResults.length} raw result(s)`);
      } catch (err) {
        serpError = err.message;
        console.warn(`[${this.name}] ⚠️  SerpAPI error: ${serpError}`);
      }
    } else {
      serpError = 'SERPAPI_KEY not configured';
      console.warn(`[${this.name}] ⚠️  ${serpError}`);
    }

    // ── 3. ContextFilter → top N chunks ───────────────────────────────────
    let context_chunks;
    let sources;
    let cache_used = false;

    if (rawResults && rawResults.length > 0) {
      const filtered = contextFilter(rawResults, refinedQuery, maxChunks);
      context_chunks  = filtered.chunks;
      sources         = filtered.sources;
      console.log(`[${this.name}] ✅  Kept ${context_chunks.length} chunk(s) after filtering`);
    } else {
      // ── 4. LLM fallback ─────────────────────────────────────────────────
      console.log(`[${this.name}] 🤖  Using LLM fallback (synthesised context)`);
      const fallback = await this._llmFallback(refinedQuery);
      context_chunks = fallback.chunks;
      sources        = fallback.sources;
      cache_used     = false;
      console.log(`[${this.name}] ✅  Synthesised ${context_chunks.length} context chunk(s)`);
    }

    // ── 5. Persist to cache (store-level, keyed by normalised query) ──────
    await this._writeCache(content.id, normalised, { context_chunks, sources });

    return {
      context_chunks,
      sources,
      retriever_cache_used: cache_used,
      retriever_query: normalised,
    };
  }

  // ------------------------------------------------------------------
  // SerpAPI — exactly ONE call, extract everything useful from it
  // ------------------------------------------------------------------

  async _fetchSerpAPI(query) {
    const params = new URLSearchParams({
      q:       query,
      api_key: config.SERPAPI_KEY,
      num:     '5',        // ask for 5 organic results
      hl:      'en',
      gl:      'us',
    });

    let res;
    try {
      res = await fetch(`${SERP_API_URL}?${params}`, {
        headers: { 'Accept': 'application/json' },
        signal:  AbortSignal.timeout(15_000),   // 15s hard timeout
      });
    } catch (err) {
      throw new Error(`Network error calling SerpAPI: ${err.message}`);
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '(no body)');
      throw new Error(`SerpAPI HTTP ${res.status}: ${body.slice(0, 200)}`);
    }

    const data = await res.json();

    if (data.error) {
      throw new Error(`SerpAPI error: ${data.error}`);
    }

    const results = [];

    // Knowledge graph — highest quality, always include if present
    if (data.knowledge_graph) {
      const kg = data.knowledge_graph;
      const text = [kg.description, kg.type, kg.title]
        .filter(Boolean)
        .join(' — ');
      if (text.length > MIN_CHUNK_LEN) {
        results.push({
          snippet: text,
          title:   kg.title || 'Knowledge Graph',
          source:  kg.website || 'Knowledge Graph',
        });
      }
    }

    // Answer box — very concise factual answer
    if (data.answer_box?.answer) {
      results.push({
        snippet: data.answer_box.answer,
        title:   data.answer_box.title || 'Answer Box',
        source:  data.answer_box.link  || 'Google Answer Box',
      });
    }
    if (data.answer_box?.snippet) {
      results.push({
        snippet: data.answer_box.snippet,
        title:   data.answer_box.title || 'Answer Box',
        source:  data.answer_box.link  || 'Google Answer Box',
      });
    }

    // Organic results
    for (const r of (data.organic_results || [])) {
      if (r.snippet) {
        results.push({
          snippet: r.snippet,
          title:   r.title  || '',
          source:  r.link   || r.displayed_link || '',
        });
      }
    }

    return results;
  }

  // ------------------------------------------------------------------
  // LLM fallback — clearly labelled as synthesised
  // ------------------------------------------------------------------

  async _llmFallback(query) {
    const system = `You are a research assistant.
Generate 3-5 concise, factual context paragraphs about the given topic.
Each paragraph should be a distinct, standalone fact or insight.
Mark EVERY paragraph with the prefix: "(Synthesized context – no reliable sources found)"
Return JSON only:
{ "chunks": string[], "sources": string[] }`;

    const user = `Topic: "${query}"
Generate grounded context paragraphs to help write an article. Be factual and specific.`;

    try {
      const result = await this.chatJSON(system, user);
      const chunks = Array.isArray(result.chunks)
        ? result.chunks
            .map(c => String(c).trim())
            .filter(c => c.length >= MIN_CHUNK_LEN)
        : [];

      if (chunks.length === 0) throw new Error('LLM returned no valid chunks');

      // Ensure every chunk is labelled as synthesised
      const labelled = chunks.map(c =>
        c.startsWith('(Synthesized') ? c : `(Synthesized context – no reliable sources found) ${c}`
      );

      return {
        chunks:  labelled,
        sources: ['(Synthesized — no external sources retrieved)'],
      };
    } catch (err) {
      console.warn(`[${this.name}] LLM fallback failed: ${err.message}`);
      // Last-resort fallback: single generic chunk
      return {
        chunks:  [`(Synthesized context – no reliable sources found) The topic "${query}" could not be retrieved or synthesized at this time. The article will be based on general knowledge.`],
        sources: ['(No sources available)'],
      };
    }
  }

  // ------------------------------------------------------------------
  // Cache helpers — stored inside the job's store entry under a
  // namespaced key to avoid polluting WriterAgent fields
  // ------------------------------------------------------------------

  async _checkCache(jobId, normalisedQuery) {
    try {
      const data = await this.store.get(jobId);
      const cache = data?._retriever_cache;
      if (!cache) return null;
      const entry = cache[normalisedQuery];
      if (!entry) return null;
      console.log(`[${this.name}] 💾  Cache entry age: ${Math.round((Date.now() - entry.ts) / 1000)}s`);
      return entry;
    } catch {
      return null;
    }
  }

  async _writeCache(jobId, normalisedQuery, payload) {
    try {
      const data     = await this.store.get(jobId) || {};
      const cache    = data._retriever_cache || {};
      cache[normalisedQuery] = { ...payload, ts: Date.now() };
      await this.store.update(jobId, { _retriever_cache: cache });
    } catch (err) {
      console.warn(`[${this.name}] Cache write failed (non-fatal): ${err.message}`);
    }
  }
}

// ─── Standalone entry point ──────────────────────────────────────────────────
if (process.argv[1]?.endsWith('retriever.js')) {
  const bus   = await createBus();
  const store = createStore(bus.mode === 'redis');
  const agent = new RetrieverAgent({ bus, store, name: 'RetrieverAgent' });
  await agent.start();
}

// ─────────────────────────────────────────────────────────────────────────────
// ContextFilter — pure function, no LLM needed
// ─────────────────────────────────────────────────────────────────────────────

/**
 * contextFilter(rawResults, query, maxChunks)
 *
 * Applies:
 *   1. Noise removal (ads, SEO junk, minimal-length)
 *   2. Deduplication (Jaccard-based fuzzy match)
 *   3. Relevance scoring (keyword overlap with query)
 *   4. Top-N selection
 *
 * Returns { chunks: string[], sources: string[] }
 */
function contextFilter(rawResults, query, maxChunks = 5) {
  const queryTokens = tokenise(query);

  // Step 1: clean + score each result
  const scored = rawResults
    .map(r => {
      const text = cleanSnippet(r.snippet || '');
      if (text.length < MIN_CHUNK_LEN) return null;
      if (isNoise(text)) return null;
      const score = relevanceScore(text, queryTokens);
      return { text, source: cleanSource(r.source || r.title || ''), score };
    })
    .filter(Boolean);

  // Step 2: sort by relevance descending
  scored.sort((a, b) => b.score - a.score);

  // Step 3: deduplicate — skip chunks too similar to already-kept ones
  const kept = [];
  const keptTokenSets = [];

  for (const candidate of scored) {
    const tokens = new Set(tokenise(candidate.text));
    const tooSimilar = keptTokenSets.some(existing => jaccard(tokens, existing) > 0.6);
    if (!tooSimilar) {
      kept.push(candidate);
      keptTokenSets.push(tokens);
    }
    if (kept.length >= maxChunks) break;
  }

  return {
    chunks:  kept.map(k => k.text),
    sources: [...new Set(kept.map(k => k.source))].filter(Boolean),
  };
}

// ─── ContextFilter helpers ────────────────────────────────────────────────────

function cleanSnippet(text) {
  return text
    .replace(/\s+/g, ' ')            // collapse whitespace
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

function cleanSource(source) {
  try {
    const url = new URL(source);
    return url.hostname.replace(/^www\./, '');
  } catch {
    return source.slice(0, 80);
  }
}

function isNoise(text) {
  return NOISE_PATTERNS.some(re => re.test(text));
}

function tokenise(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 2);
}

function relevanceScore(text, queryTokens) {
  if (queryTokens.length === 0) return 0;
  const textTokens = new Set(tokenise(text));
  let hits = 0;
  for (const qt of queryTokens) {
    if (textTokens.has(qt)) hits++;
  }
  return hits / queryTokens.length;
}

function jaccard(setA, setB) {
  if (setA.size === 0 && setB.size === 0) return 1;
  let intersection = 0;
  for (const item of setA) {
    if (setB.has(item)) intersection++;
  }
  const union = setA.size + setB.size - intersection;
  return intersection / union;
}

// ─── Query normalisation ──────────────────────────────────────────────────────
/**
 * normaliseQuery(q)
 *
 * Ensures similar queries map to the same cache key.
 * Examples:
 *   "AI healthcare trends"          → "ai healthcare trends"
 *   "healthcare AI trends 2025"     → "ai healthcare trends 2025"
 *   "  Explain  AI in  healthcare " → "ai explain healthcare"
 */
function normaliseQuery(q) {
  return q
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')   // remove punctuation
    .split(/\s+/)
    .filter(t => t.length > 1)      // remove single chars
    .sort()                          // sort alphabetically → order-independent
    .join(' ')
    .trim();
}
