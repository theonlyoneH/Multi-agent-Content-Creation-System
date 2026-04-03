/**
 * config.js — Centralized configuration
 *
 * Single source of truth for all environment-driven settings.
 * Loads .env automatically so agents don't need to remember.
 *
 * LLM backend: Ollama (local). No API key needed.
 */

import 'dotenv/config';

export const config = Object.freeze({
  // Redis
  REDIS_URL: process.env.REDIS_URL || 'redis://localhost:6379',

  // Ollama (local LLM)
  OLLAMA_BASE_URL: process.env.OLLAMA_BASE_URL || 'http://localhost:11434',
  OLLAMA_MODEL:    process.env.OLLAMA_MODEL    || 'llama3',

  // Agent behaviour
  MAX_RETRIES:   parseInt(process.env.MAX_RETRIES, 10) || 3,
  RETRY_BASE_MS: parseInt(process.env.RETRY_BASE_MS, 10) || 800,
  MAX_REVISIONS: parseInt(process.env.MAX_REVISIONS, 10) || 2,

  // Output
  OUTPUT_DIR: process.env.OUTPUT_DIR || './output',

  // Store
  STORE_TTL_SECONDS: parseInt(process.env.STORE_TTL_SECONDS, 10) || 60 * 60 * 24, // 24h

  // RetrieverAgent — SerpAPI integration
  // Budget: ≤50 calls/month. Cache-first strategy minimises real calls.
  SERPAPI_KEY:          process.env.SERPAPI_KEY || '',
  RETRIEVER_MAX_CHUNKS: parseInt(process.env.RETRIEVER_MAX_CHUNKS, 10) || 5,
});
