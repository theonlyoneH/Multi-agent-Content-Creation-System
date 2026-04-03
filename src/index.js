/**
 * index.js — System entry point
 *
 * THREE modes:
 *
 *   node src/index.js                        → start agents only (Redis required for cross-process jobs)
 *   node src/index.js submit <topic>         → submit job (agents must be running, Redis required)
 *   node src/index.js run <topic>            → agents + job in ONE process (works without Redis)
 *
 * ── Why "run" mode is required without Redis ─────────────────────────────────
 * In-memory mode uses an EventEmitter bus and a plain Map store — both live in
 * a single Node.js process. Two separate processes cannot share memory:
 *
 *   ❌ Process A: node src/index.js         (agents + their own Map store)
 *   ❌ Process B: node src/index.js submit  (different Map store → agents get null → skip)
 *
 *   ✅ Process A: node src/index.js run "topic"
 *                 (agents + submitter share ONE bus instance and ONE store instance)
 *
 * ── Redis mode (production) ──────────────────────────────────────────────────
 *   Terminal 1: node src/index.js
 *   Terminal 2: node src/index.js submit "your topic"
 */

import { config }         from './core/config.js';
import { createBus }      from './core/bus.js';
import { createStore }    from './core/store.js';
import { QueryRewriterAgent } from './agents/query-rewriter.js';
import { RetrieverAgent } from './agents/retriever.js';
import { ResearchAgent }  from './agents/research.js';
import { PlannerAgent }   from './agents/planner.js';
import { WriterAgent }    from './agents/writer.js';
import { EditorAgent }    from './agents/editor.js';
import { SEOAgent }       from './agents/seo.js';
import { PublisherAgent } from './agents/publisher.js';
import { v4 as uuidv4 }  from 'uuid';

// ── Step 1: probe once, decide which backend ─────────────────────────────────
const primaryBus = await createBus();
const useRedis   = primaryBus.mode === 'redis';

// ── Factories ────────────────────────────────────────────────────────────────
// sharedStore: a single store instance used by all components in this process.
// In memory mode this is the ONLY store — sharing is mandatory.
// In Redis mode each call creates its own connection (Redis requirement).
const sharedStore = createStore(useRedis);

async function getBusForAgent() {
  // In-memory: share the single emitter so agents actually hear messages
  if (!useRedis) return primaryBus;
  // Redis: each agent needs dedicated pub+sub connections
  return createBus();
}

// ── Start agents ─────────────────────────────────────────────────────────────
// All agents use sharedStore so they see data written by the submitter.
async function startAgents() {
  const agentDefs = [
    { Agent: QueryRewriterAgent, name: 'QueryRewriterAgent' },
    //
    // RetrieverAgent fires on refined.request (parallel with ResearchAgent).
    // It fetches real-world context via SerpAPI and stores context_chunks
    // into the shared store BEFORE WriterAgent runs on plan.ready.
    //
    { Agent: RetrieverAgent,  name: 'RetrieverAgent'  },
    { Agent: ResearchAgent,   name: 'ResearchAgent'   },
    { Agent: PlannerAgent,    name: 'PlannerAgent'    },
    { Agent: WriterAgent,     name: 'WriterAgent'     },
    { Agent: EditorAgent,     name: 'EditorAgent'     },
    { Agent: SEOAgent,        name: 'SEOAgent'        },
    { Agent: PublisherAgent,  name: 'PublisherAgent'  },
  ];

  for (const { Agent, name } of agentDefs) {
    const bus   = await getBusForAgent();
    const agent = new Agent({ bus, store: sharedStore, name });
    await agent.start();
  }
}

// ── Submit a job ──────────────────────────────────────────────────────────────
async function submitJob(topic) {
  const id = uuidv4();

  console.log('\n' + '─'.repeat(60));
  console.log('  Job  →  ' + topic);
  console.log('  ID   →  ' + id);
  console.log('  LLM  →  ' + config.OLLAMA_MODEL + ' @ ' + config.OLLAMA_BASE_URL);
  console.log('─'.repeat(60) + '\n');

  // Seed into the SAME sharedStore agents will read from
  await sharedStore.set(id, {
    id,
    topic,
    rawTopic:      topic,
    audience:     'general',
    format:       'article',
    wordCount:    1500,
    outputFormat: 'markdown',
    createdAt:    new Date().toISOString(),
  });
  console.log(`[index] 📦  store seeded  (job ${id})`);

  // ── Keep the event loop alive so agents can process async events ───────────
  // In memory mode, once publish() returns the event loop would empty and exit
  // before any setImmediate-based agent handlers fire. The keepAlive timer
  // prevents that. It is cleared as soon as published fires OR on timeout.
  const PIPELINE_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes hard timeout
  const keepAlive = setInterval(() => {}, 5_000);

  const timeoutHandle = setTimeout(() => {
    clearInterval(keepAlive);
    console.error('\n❌  PIPELINE TIMEOUT — no "published" event after 10 minutes.');
    console.error('    Check agent logs above for last successful step.');
    process.exit(2);
  }, PIPELINE_TIMEOUT_MS);

  // Allow the timeout itself to not keep the event loop alive on its own
  if (timeoutHandle.unref) timeoutHandle.unref();

  // Listen for the final "published" event on the shared bus
  await primaryBus.subscribe('published', async (envelope) => {
    if (envelope.payload.id !== id) return;
    clearInterval(keepAlive);
    clearTimeout(timeoutHandle);
    console.log('\n' + '='.repeat(60));
    console.log('🎉  PIPELINE COMPLETE!');
    console.log('    Job ID : ' + id);
    console.log('    Topic  : ' + topic);
    console.log('    Output : ' + config.OUTPUT_DIR + '/');
    console.log('='.repeat(60) + '\n');
    // Give any final log flushes a moment, then exit cleanly
    setTimeout(() => process.exit(0), 500);
  });

  // Kick off the pipeline — publish on the shared primaryBus
  await primaryBus.publish('content.request', { id }, 'index');
  console.log(`[index] 🚀  fired "content.request"  (job ${id})\n`);
}

// ─────────────────────────────────────────────────────────────────────────────
const mode = process.argv[2];

// ── MODE: run  ───────────────────────────────────────────────────────────────
if (mode === 'run') {
  const topic = process.argv.slice(3).join(' ') || 'AI trends in healthcare 2025';

  const modeLabel = useRedis
    ? 'Redis → ' + config.REDIS_URL
    : 'In-Memory (single-process mode, no Redis needed)';

  console.log('='.repeat(60));
  console.log('  Multi-Agent Content System  [run mode]');
  console.log('  LLM : ' + config.OLLAMA_MODEL + ' @ ' + config.OLLAMA_BASE_URL);
  console.log('  Bus : ' + modeLabel);
  console.log('='.repeat(60) + '\n');

  await startAgents();
  console.log('✅  Agents ready — submitting job\n');
  await submitJob(topic);

// ── MODE: submit (requires Redis) ────────────────────────────────────────────
} else if (mode === 'submit') {
  if (!useRedis) {
    console.error('\n❌  "submit" requires Redis. Redis is not reachable at ' + config.REDIS_URL);
    console.error('\n    Fix options:');
    console.error('      1. Start Redis:  docker run -d -p 6379:6379 redis:7-alpine');
    console.error('      2. Single-process (no Redis): node src/index.js run "topic"\n');
    process.exit(1);
  }

  const topic = process.argv.slice(3).join(' ') || 'AI trends in healthcare 2025';
  await submitJob(topic);

// ── MODE: start agents only ───────────────────────────────────────────────────
} else {
  const modeLabel = useRedis
    ? 'Redis → ' + config.REDIS_URL
    : 'In-Memory';

  console.log('='.repeat(60));
  console.log('  Multi-Agent Content System  [agent mode]');
  console.log('  LLM : ' + config.OLLAMA_MODEL + ' @ ' + config.OLLAMA_BASE_URL);
  console.log('  Bus : ' + modeLabel);
  console.log('='.repeat(60));

  await startAgents();

  if (useRedis) {
    console.log('\n✅  Agents running.  Submit a job:');
    console.log('      node src/index.js submit "your topic here"\n');
  } else {
    console.log('\n⚠️  No Redis — cross-process jobs will not work.');
    console.log('   Use this instead (agents + job in one command):');
    console.log('     node src/index.js run "your topic here"\n');
  }
}
