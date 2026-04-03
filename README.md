# 🧠 Multi-Agent Content System

> A decentralized, event-driven AI pipeline that researches, plans, writes, edits, and publishes high-quality articles — fully autonomously.

[![Node.js](https://img.shields.io/badge/Node.js-v18+-green?logo=node.js)](https://nodejs.org)
[![Redis](https://img.shields.io/badge/Redis-7-red?logo=redis)](https://redis.io)
[![Ollama](https://img.shields.io/badge/LLM-Ollama%20llama3-blue)](https://ollama.com)
[![License](https://img.shields.io/badge/License-MIT-yellow)](LICENSE)

---

## 🔍 What Is This?

Most content generation tools use a single LLM prompt and call it done. This system is different.

It runs **eight specialized AI agents** that each own a single responsibility and communicate through a **Redis Pub/Sub message bus** — no central controller, no monolithic chain. Each agent subscribes to a topic, does its job, and fires the next one.

The result: **grounded, structured, SEO-ready articles** built from real retrieved information, not hallucinated filler.

---

## 🚀 Features

| Feature | Description |
|---------|-------------|
| 🤖 **8 Specialized Agents** | Each agent owns one step — rewrite, retrieve, research, plan, write, edit, SEO, publish |
| 🔁 **Event-Driven Architecture** | Redis Pub/Sub decouples every agent — add or remove agents without touching others |
| 🔍 **RAG Retrieval** | RetrieverAgent fetches real context via SerpAPI before writing begins |
| 🛡️ **Grounded Generation** | WriterAgent is strictly forbidden from inventing stats, quotes, or experts |
| 💾 **Smart Caching** | Normalised query cache prevents redundant SerpAPI calls |
| ✏️ **Feedback Loops** | EditorAgent can reject drafts and send them back to WriterAgent for revision |
| 📦 **Multi-Format Output** | Publishes Markdown, HTML, or JSON — ready for any CMS |
| 🏠 **Fully Local** | Runs on Ollama (llama3) — no OpenAI key, no data sent to the cloud |
| 🔌 **Redis-Optional** | Falls back to in-memory mode for local dev — zero infrastructure needed |

---

## 🏗️ Architecture

### Pipeline Flow

```
User Input ("ai in healthcare")
      │
      ▼
┌─────────────────────┐
│  QueryRewriterAgent │  content.request → refined.request
│  Cleans & expands   │  "AI in healthcare" →
│  the raw query      │  "Analyze AI applications in healthcare:
└─────────────────────┘   diagnostics, imaging, drug discovery"
      │
      ├──────────────────────────────────┐
      ▼                                  ▼
┌─────────────────────┐    ┌─────────────────────┐
│   RetrieverAgent    │    │   ResearchAgent      │
│   Fetches real-world│    │   Synthesizes facts, │
│   context via       │    │   themes & angles    │
│   SerpAPI + cache   │    │   using the LLM      │
└─────────────────────┘    └─────────────────────┘
      │ context.ready             │ research.done
      │ (stored in shared store)  ▼
      │                   ┌─────────────────────┐
      │                   │   PlannerAgent       │
      │                   │   Builds structured  │
      │                   │   content plan with  │
      │                   │   sections + goals   │
      │                   └─────────────────────┘
      │                          │ plan.ready
      │                          ▼
      │                   ┌─────────────────────┐
      └──────────────────►│   WriterAgent        │
         context_chunks   │   Drafts each section│
         already in store │   grounded ONLY in   │
                          │   retrieved context  │
                          └─────────────────────┘
                                 │ draft.ready
                    ┌────────────┘
                    │   ┌─ major issues? ─► edit.revision ─► WriterAgent (retry)
                    ▼   │
             ┌─────────────────────┐
             │   EditorAgent        │
             │   Coherence check +  │
             │   style revision     │
             └─────────────────────┘
                    │ edit.done
                    ▼
             ┌─────────────────────┐
             │   SEOAgent           │
             │   Keywords, meta     │
             │   title, slug,       │
             │   alt text           │
             └─────────────────────┘
                    │ seo.done
                    ▼
             ┌─────────────────────┐
             │   PublisherAgent     │
             │   Renders Markdown / │
             │   HTML / JSON and    │
             │   writes to disk     │
             └─────────────────────┘
                    │ published
                    ▼
              📄 ./output/*.md
```

### Pub/Sub Topic Map

| From → To | Topic |
|---|---|
| `index` → `QueryRewriterAgent` | `content.request` |
| `QueryRewriterAgent` → `RetrieverAgent` + `ResearchAgent` | `refined.request` |
| `RetrieverAgent` → store | `context.ready` |
| `ResearchAgent` → `PlannerAgent` | `research.done` |
| `PlannerAgent` → `WriterAgent` | `plan.ready` |
| `WriterAgent` → `EditorAgent` | `draft.ready` |
| `EditorAgent` → `WriterAgent` (revision) | `edit.revision` |
| `EditorAgent` → `SEOAgent` | `edit.done` |
| `SEOAgent` → `PublisherAgent` | `seo.done` |
| `PublisherAgent` → system | `published` |

---

## ⚙️ Tech Stack

| Technology | Role |
|------------|------|
| **Node.js v18+** | Runtime — ESM modules throughout |
| **Redis 7** | Pub/Sub message bus between agents |
| **Docker** | Hosts Redis (one command) |
| **Ollama + llama3** | Local LLM — powers all agent reasoning |
| **SerpAPI** | Real-world web retrieval (optional, free tier available) |
| **ioredis** | Redis client |
| **uuid** | Job ID generation |

---

## 🧑‍💻 Setup

### Prerequisites

- [Node.js v18+](https://nodejs.org)
- [Docker](https://www.docker.com) (for Redis)
- [Ollama](https://ollama.com) installed and running

---

### 1. Clone & Install

```bash
git clone https://github.com/your-username/multi-agent-content-system.git
cd multi-agent-content-system
npm install
```

---

### 2. Configure Environment

```bash
cp .env.example .env
```

Open `.env` and fill in your values (see [Environment Variables](#-environment-variables) below).

---

### 3. Start Redis

```bash
docker run -d -p 6379:6379 --name redis-local redis:7-alpine
```

Verify it's running:
```bash
docker ps | grep redis-local
```

> **No Docker?** Skip this step — the system automatically falls back to in-memory mode for local development.

---

### 4. Start Ollama + Pull llama3

```bash
# Pull the model (one-time, ~4GB)
ollama pull llama3

# Start the server (if not already running)
ollama serve
```

---

### 5. Run the Pipeline

```bash
# Single-process mode — agents + job in one command (no Redis required)
node src/index.js run "AI applications in healthcare"

# With Redis — two terminals
node src/index.js                                       # Terminal 1: start agents
node src/index.js submit "AI applications in healthcare" # Terminal 2: submit job
```

Output is saved to `./output/` as a `.md` file.

---

## 🔐 Environment Variables

Copy `.env.example` → `.env` and configure:

```bash
# ── Redis ──────────────────────────────────────────────────────────────
REDIS_URL=redis://localhost:6379

# ── Ollama (local LLM) ─────────────────────────────────────────────────
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_MODEL=llama3

# ── Agent behaviour ────────────────────────────────────────────────────
MAX_RETRIES=3          # Retry attempts per agent on failure
RETRY_BASE_MS=800      # Base delay (ms) for exponential backoff
MAX_REVISIONS=2        # Max editor→writer feedback loops

# ── Output ─────────────────────────────────────────────────────────────
OUTPUT_DIR=./output

# ── RetrieverAgent — SerpAPI ───────────────────────────────────────────
# Get a free key at: https://serpapi.com (100 free searches/month)
# Leave empty to use LLM-synthesised fallback context instead.
SERPAPI_KEY=your_serpapi_key_here

# Max number of context chunks to keep after filtering (default: 5)
RETRIEVER_MAX_CHUNKS=5
```

> **`SERPAPI_KEY` is optional.** Without it, the RetrieverAgent uses the LLM to synthesise clearly-labelled fallback context. The pipeline still runs end-to-end.

---

## 📦 Project Structure

```text
mas/
├── src/
│   ├── agents/                   # One file per agent
│   │   ├── query-rewriter.js     # Cleans & expands raw user input
│   │   ├── retriever.js          # Fetches real-world context (SerpAPI + cache)
│   │   ├── research.js           # Synthesises facts, themes, angles
│   │   ├── planner.js            # Builds structured content plan
│   │   ├── writer.js             # Drafts article (grounded in context)
│   │   ├── editor.js             # Coherence check + style revision
│   │   ├── seo.js                # Keywords, meta title, slug, alt text
│   │   └── publisher.js          # Renders & saves Markdown/HTML/JSON
│   │
│   ├── core/                     # Shared infrastructure
│   │   ├── base.js               # BaseAgent — lifecycle, retry, LLM helpers
│   │   ├── bus.js                # Redis Pub/Sub bus (in-memory fallback)
│   │   ├── config.js             # Centralised env-var config
│   │   ├── schema.js             # Envelope validation + serialisation
│   │   └── store.js              # Shared job state (Redis or Map)
│   │
│   └── index.js                  # Entry point — run / submit / agents modes
│
├── output/                       # Generated articles land here
├── .env                          # Your local config (gitignored)
├── .env.example                  # Template — copy to .env
├── docker-compose.yml            # Redis via Docker Compose
└── package.json
```

---

## 🧠 How It Works (Plain English)

### No Central Controller

There is no orchestrator telling agents what to do. Each agent is an independent process that **listens on its input topic** and **fires its output topic** when done. The pipeline self-assembles.

### Shared Job State

Every job gets a unique ID. Agents read the full job object from a shared store (Redis hash or in-memory Map), do their work, patch their fields in, then publish the next event. No data is passed inside the event itself — just the job ID.

### Grounded Generation (RAG)

The system fetches real web results **before** the LLM writes anything:

1. `RetrieverAgent` calls SerpAPI → extracts snippets → filters noise → stores `context_chunks`
2. `WriterAgent` receives those chunks and is instructed (via strict prompt rules) to use **only** that content
3. Fabricated statistics, fake expert quotes, and unsupported claims are explicitly forbidden

### API Budget Protection

SerpAPI has a limited free quota. The system protects it aggressively:

- **Cache-first**: queries are normalised (token-sorted, lowercase) so `"AI healthcare"` and `"healthcare AI trends"` share the same cache entry
- **One call per job**: hard limit, never chains multiple searches
- **15-second timeout**: AbortSignal prevents hanging on slow responses
- **LLM fallback**: if SerpAPI is unavailable or quota is hit, the LLM synthesises clearly labelled placeholder context

### Revision Loops

The `EditorAgent` runs a coherence check on every draft. If major issues are found and the revision budget hasn't been spent (default: 2 revisions), it publishes `edit.revision` — the `WriterAgent` picks this up, rewrites flagged sections, and republishes `draft.ready`. Fully automatic.

---

## 🔁 Example Flow

**Input:**
```
node src/index.js run "ai in healthcare"
```

**QueryRewriterAgent output:**
```json
{
  "refined_query": "Analyze AI applications in modern healthcare: diagnostics, imaging analysis, drug discovery, and patient outcome prediction",
  "intent": "informational analysis",
  "context_added": "expanded into specific healthcare AI subdomains"
}
```

**RetrieverAgent output (stored in job):**
```json
{
  "context_chunks": [
    "AI-powered diagnostic tools have demonstrated accuracy comparable to specialist physicians in detecting diabetic retinopathy and certain cancers from medical imaging...",
    "Machine learning models trained on electronic health records can predict patient readmission risk with significantly higher precision than traditional scoring methods...",
    "Drug discovery timelines have been compressed using generative AI, with companies like Insilico Medicine reporting candidates identified in months rather than years..."
  ],
  "sources": ["nature.com", "nejm.org", "thelancet.com"],
  "retriever_cache_used": false
}
```

**Final output** saved to `./output/ai-applications-in-healthcare.md`:

```markdown
---
title: "AI in Healthcare: Transforming Diagnostics, Drug Discovery & Patient Care"
description: "Explore how artificial intelligence is reshaping modern healthcare..."
slug: ai-applications-in-healthcare
keywords: ["AI in healthcare", "medical imaging AI", "drug discovery AI", ...]
---

# AI in Healthcare: Transforming Diagnostics, Drug Discovery & Patient Care

Healthcare is undergoing a quiet revolution. Artificial intelligence...

## Diagnostics & Medical Imaging

AI-powered diagnostic tools have demonstrated accuracy comparable to
specialist physicians in detecting diabetic retinopathy and certain
cancers from medical imaging...

## Drug Discovery

Drug discovery timelines have been compressed using generative AI,
with companies identifying candidates in months rather than years...

...
```

---

## 🧪 Running Individual Agents

Every agent can also run as a standalone process (useful for development and debugging):

```bash
npm run agent:retriever        # Start just the RetrieverAgent
npm run agent:writer           # Start just the WriterAgent
npm run agent:query-rewriter   # etc.
```

---

## ⚠️ Limitations

| Limitation | Mitigation |
|--------|--------|
| **LLM hallucination** | RetrieverAgent + strict grounding prompts in WriterAgent |
| **SerpAPI quota** (100 free/month) | Cache-first normalisation + 1 call per job hard limit |
| **Local setup required** | No SaaS version — Ollama + Docker must be installed |
| **LLM speed** | llama3 on CPU is slow (~1–5 min/article) — use GPU if available |
| **Redis dependency** | In-memory fallback available for local dev |

---

## 🚀 Future Improvements

- [ ] **Parallel agent execution** — ResearchAgent + RetrieverAgent already run in parallel; extend across more stages
- [ ] **Kafka / NATS** — drop-in replacements for Redis Pub/Sub at scale
- [ ] **Vector DB integration** — swap SerpAPI with a local Chroma/Weaviate retrieval layer
- [ ] **Web UI dashboard** — real-time pipeline visualisation and job history
- [ ] **Output validation** — automated fact-checking pass before publish
- [ ] **Multi-model support** — route different agents to different LLMs (e.g., Mistral for research, llama3 for writing)
- [ ] **CMS integration** — PublisherAgent hooks for WordPress, Ghost, Contentful

---

## 🤝 Contributing

Contributions are welcome! Here's how to get started:

1. **Fork** the repository
2. **Create a branch** for your feature: `git checkout -b feature/my-agent`
3. **Commit** your changes with a descriptive message
4. **Open a Pull Request** — describe what your change does and why

### Adding a New Agent

1. Create `src/agents/your-agent.js` extending `BaseAgent`
2. Set `inputTopic` and `outputTopic` as class properties
3. Implement `async process(content, meta)` — return the fields to merge into the store
4. Register it in `src/index.js` → `agentDefs` array
5. Add `"agent:your-agent": "node src/agents/your-agent.js"` to `package.json`

That's it. The bus, retry logic, store reads/writes, and shutdown handling are all inherited from `BaseAgent`.

---

## 📄 License

[MIT](LICENSE) — free to use, modify, and distribute.

---

<div align="center">

Built with 🧠 local AI · ⚡ Redis events · 📡 zero cloud dependency

</div>
