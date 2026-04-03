/**
 * bus.js — Redis Pub/Sub message bus with in-memory fallback
 *
 * Behaviour:
 *   - Tries to connect to Redis on first use
 *   - If Redis is unavailable, automatically falls back to an in-process
 *     EventEmitter bus so the system works for local development
 *   - Logs clearly which mode is active
 *   - Dead-letter queue works in Redis mode; skipped silently in fallback mode
 *   - Message deduplication active in both modes
 */

import Redis      from 'ioredis';
import { EventEmitter } from 'events';
import { config }       from './config.js';
import { createEnvelope } from './schema.js';

const DEDUP_WINDOW_MS  = 5_000;  // 5 seconds — messages arriving faster than this are duplicates
const REDIS_CONNECT_TIMEOUT_MS = 3_000; // give Redis 3s to answer

// ─── Shared dedup state (bus-instance level) ────────────────────────────────
// BUG FIX: Original used map.has(key) which permanently blocked any repeated
// (jobId, topic) pair — silently killing the draft.ready → edit.revision → draft.ready loop.
// Now uses a time-window: only identical messages within DEDUP_WINDOW_MS are suppressed.
function makeDedupMap() {
  const map = new Map();
  return {
    seen(key) {
      const now = Date.now();
      const lastSeen = map.get(key);
      // Only treat as duplicate if seen within the dedup window
      if (lastSeen !== undefined && (now - lastSeen) < DEDUP_WINDOW_MS) {
        return true;
      }
      // First time OR outside window — allow through and record timestamp
      map.set(key, now);
      // Trim stale entries when map grows large
      if (map.size > 200) {
        const cutoff = now - DEDUP_WINDOW_MS;
        for (const [k, ts] of map) if (ts < cutoff) map.delete(k);
      }
      return false;
    },
  };
}

// ─── Try to reach Redis within a timeout ────────────────────────────────────
async function probeRedis(url) {
  return new Promise((resolve) => {
    const probe = new Redis(url, {
      lazyConnect:        true,
      connectTimeout:     REDIS_CONNECT_TIMEOUT_MS,
      maxRetriesPerRequest: 0,
      enableOfflineQueue: false,
    });

    const done = (ok) => {
      probe.disconnect();
      resolve(ok);
    };

    probe.once('ready',  () => done(true));
    probe.once('error',  () => done(false));

    probe.connect().catch(() => done(false));

    // Hard timeout in case neither event fires
    setTimeout(() => done(false), REDIS_CONNECT_TIMEOUT_MS + 500);
  });
}

// ─── Redis-backed bus ────────────────────────────────────────────────────────
function createRedisBus(url) {
  const retryStrategy = (times) => {
    if (times > 5) {
      console.error('[bus] Redis: max reconnect attempts reached — giving up');
      return null; // stop retrying
    }
    const delay = Math.min(times * 500, 3000);
    console.warn(`[bus] Redis: reconnecting in ${delay}ms (attempt ${times})…`);
    return delay;
  };

  const makeClient = () => new Redis(url, {
    lazyConnect:        true,
    enableOfflineQueue: false,
    retryStrategy,
  });

  const pub = makeClient();
  const sub = makeClient();

  // Swallow unhandled errors — retryStrategy handles reconnection
  pub.on('error', (e) => console.error('[bus:pub] Redis error:', e.message));
  sub.on('error', (e) => console.error('[bus:sub] Redis error:', e.message));
  pub.on('reconnecting', () => console.warn('[bus:pub] Redis reconnecting…'));
  sub.on('reconnecting', () => console.warn('[bus:sub] Redis reconnecting…'));

  const handlers = new Map();
  const dedup    = makeDedupMap();
  let   connected = false;

  sub.on('message', async (channel, raw) => {
    let msg;
    try { msg = JSON.parse(raw); }
    catch { console.error(`[bus] Unparseable message on ${channel}`); return; }

    const key = `${msg.id}:${channel}`;
    if (dedup.seen(key)) { console.log(`[bus] ⏭  dedup skip ${key}`); return; }

    for (const handler of (handlers.get(channel) || [])) {
      try {
        await handler(msg);
      } catch (err) {
        console.error(`[bus] Handler error on ${channel}:`, err.message);
        // DLQ — best-effort, don't crash on failure
        try {
          const entry = JSON.stringify({ channel, reason: err.message, message: raw, at: new Date().toISOString() });
          await pub.lpush(`dlq:${channel}`, entry);
          await pub.ltrim(`dlq:${channel}`, 0, 99);
          console.warn(`[bus] ⚠  pushed to dlq:${channel}`);
        } catch {}
      }
    }
  });

  async function connect() {
    if (connected) return;
    await pub.connect();
    await sub.connect();
    connected = true;
  }

  async function subscribe(topic, handler) {
    await connect();
    if (!handlers.has(topic)) {
      handlers.set(topic, []);
      await sub.subscribe(topic);
    }
    handlers.get(topic).push(handler);
  }

  async function publish(topic, payload, source = 'system') {
    await connect();
    const envelope = createEnvelope(topic, payload, source);
    await pub.publish(topic, JSON.stringify(envelope));
    console.log(`[bus] ✉  ${topic}  (job ${payload.id})  from ${source}`);
  }

  async function disconnect() {
    try { await sub.quit(); } catch {}
    try { await pub.quit(); } catch {}
  }

  return { subscribe, publish, disconnect, mode: 'redis' };
}

// ─── In-memory EventEmitter fallback bus ────────────────────────────────────
function createMemoryBus() {
  const emitter  = new EventEmitter();
  const dedup    = makeDedupMap();
  const handlers = new Map();    // topic → [fn, ...]

  emitter.setMaxListeners(50);   // avoid Node warning with many agents

  function subscribe(topic, handler) {
    if (!handlers.has(topic)) {
      handlers.set(topic, []);
      emitter.on(topic, async (msg) => {
        const key = `${msg.id}:${topic}`;
        if (dedup.seen(key)) return;
        for (const fn of (handlers.get(topic) || [])) {
          try { await fn(msg); }
          catch (err) { console.error(`[bus:mem] Handler error on ${topic}:`, err.message); }
        }
      });
    }
    handlers.get(topic).push(handler);
    return Promise.resolve();
  }

  function publish(topic, payload, source = 'system') {
    const envelope = createEnvelope(topic, payload, source);
    // Use setImmediate so the caller's await completes before handlers fire
    setImmediate(() => emitter.emit(topic, envelope));
    console.log(`[bus:mem] ✉  ${topic}  (job ${payload.id})  from ${source}`);
    return Promise.resolve();
  }

  function disconnect() { return Promise.resolve(); }

  return { subscribe, publish, disconnect, mode: 'memory' };
}

// ─── Public factory — auto-detects Redis availability ───────────────────────
export async function createBus() {
  const redisAvailable = await probeRedis(config.REDIS_URL);

  if (redisAvailable) {
    console.log(`[bus] ✅  Redis connected  →  ${config.REDIS_URL}`);
    return createRedisBus(config.REDIS_URL);
  }

  console.warn('[bus] ⚠️  Redis unavailable — running in IN-MEMORY fallback mode');
  console.warn('[bus]     (Messages are not persisted and do not cross processes)');
  return createMemoryBus();
}
