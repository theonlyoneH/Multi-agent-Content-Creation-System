/**
 * store.js — Shared content state store
 *
 * Two backends, auto-selected:
 *   Redis  — production; atomic Lua-script updates, 24h TTL
 *   Memory — local dev fallback; plain Map, no TTL
 *
 * The public API (get / set / update / append / getField / disconnect)
 * is identical in both backends so agents never need to know which is active.
 */

import Redis from 'ioredis';
import { config } from './config.js';

// Lua script for atomic merge: read → shallow merge → write
const ATOMIC_MERGE_LUA = `
  local key   = KEYS[1]
  local patch = cjson.decode(ARGV[1])
  local ttl   = tonumber(ARGV[2])

  local raw      = redis.call('GET', key)
  local existing = {}
  if raw then existing = cjson.decode(raw) end

  for k, v in pairs(patch) do existing[k] = v end
  existing['updatedAt'] = ARGV[3]

  local encoded = cjson.encode(existing)
  redis.call('SETEX', key, ttl, encoded)
  return encoded
`;

// ─── Redis-backed store ──────────────────────────────────────────────────────
function createRedisStore(url) {
  const client = new Redis(url, {
    lazyConnect:        true,
    enableOfflineQueue: false,
    retryStrategy: (times) => {
      if (times > 5) return null;
      return Math.min(times * 500, 3000);
    },
  });

  client.on('error',        (e) => console.error('[store] Redis error:', e.message));
  client.on('reconnecting', ()  => console.warn('[store] Redis reconnecting…'));

  let connected = false;
  let mergeSha  = null;

  async function connect() {
    if (connected) return;
    await client.connect();
    mergeSha  = await client.script('LOAD', ATOMIC_MERGE_LUA);
    connected = true;
  }

  async function get(id) {
    await connect();
    const raw = await client.get(`content:${id}`);
    return raw ? JSON.parse(raw) : null;
  }

  async function getField(id, field) {
    const obj = await get(id);
    return obj?.[field];
  }

  async function set(id, data) {
    await connect();
    await client.setex(`content:${id}`, config.STORE_TTL_SECONDS, JSON.stringify(data));
  }

  async function update(id, patch) {
    await connect();
    const result = await client.evalsha(
      mergeSha, 1,
      `content:${id}`,
      JSON.stringify(patch),
      String(config.STORE_TTL_SECONDS),
      new Date().toISOString(),
    );
    return JSON.parse(result);
  }

  async function append(id, field, items) {
    await connect();
    const existing = await get(id) || {};
    const arr = existing[field] || [];
    return update(id, { [field]: [...arr, ...items] });
  }

  async function disconnect() {
    try { await client.quit(); } catch {}
  }

  return { get, getField, set, update, append, disconnect, mode: 'redis' };
}

// ─── In-memory fallback store ────────────────────────────────────────────────
function createMemoryStore() {
  const db = new Map();  // id → object

  function get(id) {
    return Promise.resolve(db.get(id) ?? null);
  }

  function getField(id, field) {
    return Promise.resolve(db.get(id)?.[field]);
  }

  function set(id, data) {
    db.set(id, { ...data });
    return Promise.resolve();
  }

  function update(id, patch) {
    const existing = db.get(id) ?? {};
    const merged   = { ...existing, ...patch, updatedAt: new Date().toISOString() };
    db.set(id, merged);
    return Promise.resolve(merged);
  }

  function append(id, field, items) {
    const existing = db.get(id) ?? {};
    const arr      = existing[field] ?? [];
    return update(id, { [field]: [...arr, ...items] });
  }

  function disconnect() { return Promise.resolve(); }

  return { get, getField, set, update, append, disconnect, mode: 'memory' };
}

// ─── Public factory — mirrors the bus auto-detection ────────────────────────
// The store receives the already-resolved mode from the bus probe so both
// agree on which backend to use. Pass `redisAvailable` from the caller.
export function createStore(redisAvailable = false) {
  if (redisAvailable) {
    return createRedisStore(config.REDIS_URL);
  }
  return createMemoryStore();
}
