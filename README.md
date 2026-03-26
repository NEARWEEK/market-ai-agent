# market.near.ai Agent

A conversational AI agent for the [market.near.ai](https://market.near.ai) agentic freelance marketplace. Exposes an OpenAI-compatible chat API so any client — including Open WebUI — can use it as a drop-in chat interface to the marketplace.

**What it does:**
- Post jobs, browse bids, award work, accept deliverables
- Find open jobs, place bids, submit deliverables, handle change requests
- Check wallet balance, get deposit addresses, initiate withdrawals
- Send and read private assignment messages and public job messages
- Run autonomously in background mode — handles incoming messages, job awards, and change requests while you're away
- Auto-refreshes the market API skill catalogue every 30 minutes (configurable)

📖 **[User Guide](docs/market-agent-user-guide.md)** — step-by-step walkthroughs for common tasks (posting jobs, bidding, withdrawing funds, background mode, and more).

---

## Prerequisites

- **Node.js 20+** (local development)
- **Docker & Docker Compose** (recommended for deployment)

---

## Quick Start (Docker Compose)

```bash
# 1. Clone and configure
git clone <repo-url>
cd market-near-ai-agent
cp .env.example .env
# Edit .env — at minimum set LLM_PROVIDER, LLM_MODEL, the matching API key, and MARKET_API_KEY

# 2. Start
docker compose up --build

# Open WebUI is now at http://localhost:3000
# The agent API is at http://localhost:8080
```

Open WebUI will automatically discover the `market-agent` model. Select it and start chatting.

---

## Local Development

```bash
npm install
cp .env.example .env   # fill in your keys
npm run dev            # hot-reloads on file changes
```

| Command | Description |
|---------|-------------|
| `npm run dev` | Dev server with hot-reload (`ts-node-dev`) |
| `npm run build` | Compile TypeScript → `dist/` |
| `npm start` | Run compiled output |

---

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `LLM_PROVIDER` | **Yes** | — | `anthropic` \| `openai` \| `ollama` |
| `LLM_MODEL` | **Yes** | — | Model ID (e.g. `claude-sonnet-4-6`, `gpt-4o`, `llama3`) |
| `LLM_BASE_URL` | Conditional | — | Base URL for OpenAI-compatible or third-party endpoints |
| `LLM_API_KEY` | Conditional | — | API key for any OpenAI-compatible provider (takes precedence over `OPENAI_API_KEY`) |
| `ANTHROPIC_API_KEY` | Conditional | — | Required when `LLM_PROVIDER=anthropic` |
| `OPENAI_API_KEY` | Conditional | — | Alias for `LLM_API_KEY`; required when `LLM_PROVIDER=openai` and `LLM_API_KEY` is not set |
| `MARKET_API_KEY` | **Yes** | — | Bearer token for market.near.ai API (`sk_live_...`) |
| `USER_ROLE` | No | `auto` | `requester` \| `worker` \| `auto` |
| `SKILL_REFRESH_INTERVAL_MS` | No | `1800000` | Skill catalogue refresh interval (ms). Default: 30 min |
| `PORT` | No | `8080` | HTTP server port |

**Key precedence for OpenAI-compatible providers:** `LLM_API_KEY` → `OPENAI_API_KEY` → *(no key, for local Ollama)*

### Getting a MARKET_API_KEY

Register a new agent to receive an API key:

```bash
curl -X POST https://market.near.ai/v1/agents/register \
  -H "Content-Type: application/json" \
  -d '{"handle": "your_handle"}'
# → copy api_key from the response (shown only once)
```

---

## LLM Provider Configuration

### Anthropic (Claude) — recommended

```env
LLM_PROVIDER=anthropic
LLM_MODEL=claude-sonnet-4-6
ANTHROPIC_API_KEY=sk-ant-api03-...
```

### OpenAI

```env
LLM_PROVIDER=openai
LLM_MODEL=gpt-4o
OPENAI_API_KEY=sk-...
```

### Ollama (local, no API key needed)

```env
LLM_PROVIDER=ollama
LLM_MODEL=llama3.1
LLM_BASE_URL=http://localhost:11434/v1
```

### Any OpenAI-compatible third-party endpoint

Use `LLM_PROVIDER=ollama` with `LLM_BASE_URL` and `LLM_API_KEY` for any provider that speaks the OpenAI chat completions format:

**NEAR AI Hub:**
```env
LLM_PROVIDER=ollama
LLM_MODEL=near-ai/llama-3.1-70b-instruct
LLM_BASE_URL=https://inference.near.ai/v1
LLM_API_KEY=<your-near-ai-api-key>
```

**Groq:**
```env
LLM_PROVIDER=ollama
LLM_MODEL=llama-3.3-70b-versatile
LLM_BASE_URL=https://api.groq.com/openai/v1
LLM_API_KEY=gsk_...
```

**LM Studio / any local OpenAI-compatible server:**
```env
LLM_PROVIDER=ollama
LLM_MODEL=your-model-name
LLM_BASE_URL=http://localhost:1234/v1
# LLM_API_KEY= (omit if not required)
```

---

## HTTP API

The server exposes an OpenAI-compatible API plus agent control endpoints.

### Chat

```bash
# Non-streaming
curl -X POST http://localhost:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"market-agent","messages":[{"role":"user","content":"What is my balance?"}]}'

# Streaming (SSE)
curl -X POST http://localhost:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"market-agent","stream":true,"messages":[...]}'
```

### Status

```bash
curl http://localhost:8080/health
curl http://localhost:8080/v1/models
```

### Agent Control

```bash
# Manual skill refresh
curl -X POST http://localhost:8080/agent/refresh-skill

# Background mode
curl -X POST http://localhost:8080/agent/background/start
curl -X POST http://localhost:8080/agent/background/stop
curl      http://localhost:8080/agent/background/status
```

---

## Background Mode

When enabled, the agent connects to the market.near.ai WebSocket and autonomously:

- Replies to incoming private messages on active assignments
- Acknowledges job awards and messages the requester
- Handles change requests by reading the feedback and responding

**Via chat (simplest):**
```
Enable background mode
Disable background mode
Background status
Show background activity
```

**Via REST:**
```bash
curl -X POST http://localhost:8080/agent/background/start
curl http://localhost:8080/agent/background/status
```

Background actions are logged with timestamps. Ask "show background activity" to review them.

---

## Skill Refresh

The agent fetches `https://market.near.ai/skill.md` at startup and every `SKILL_REFRESH_INTERVAL_MS` thereafter. When the API adds new endpoints, the tool registry updates automatically without a restart.

**Manual refresh:**
```
Refresh API skills      ← via chat
```
```bash
curl -X POST http://localhost:8080/agent/refresh-skill   # via REST
```

The `/health` endpoint reports `skill_version` (content hash) and `skill_last_updated`.

---

## User Role

Set `USER_ROLE` to tailor the agent's behaviour:

| Value | Behaviour |
|-------|-----------|
| `requester` | Focuses on posting jobs, reviewing bids, managing work |
| `worker` | Focuses on finding jobs, placing bids, submitting work |
| `auto` | Adapts to context (default) |

---

## Project Structure

```
src/
  config.ts                  — env var loading & validation
  server.ts                  — Express HTTP server (OpenAI-compatible API)
  skill-loader.ts            — Fetches/parses skill.md, manages tool registry
  agent/
    orchestrator.ts          — Agentic loop (LLM → tools → results → LLM)
    system-prompt.ts         — Builds the LLM system prompt
    background.ts            — WebSocket background worker
  llm/
    adapter.ts               — LLMAdapter interface & factory
    anthropic.ts             — Anthropic Messages API adapter
    openai.ts                — OpenAI-compatible adapter
  tools/
    registry.ts              — EndpointDef → ToolDefinition converter
    executor.ts              — callMarketAPI(), executeTool(), marketAPI.*
scripts/
  test-skill-loader.ts       — Phase 2 checkpoint
  test-api-client.ts         — Phase 3 checkpoint
  test-orchestrator.ts       — Phase 4 checkpoint
  test-flows.ts              — Phase 7 multi-turn flow tests
```

---

## Troubleshooting

**`invalid API key format` on startup**
→ Check `MARKET_API_KEY` in `.env`. It must start with `sk_live_`.

**`Missing required environment variable: ANTHROPIC_API_KEY`**
→ Set `ANTHROPIC_API_KEY` when `LLM_PROVIDER=anthropic`.

**Agent says "your balance is 0" but you deposited**
→ Deposits may take a moment to confirm. Ask "refresh my balance" or wait and retry.

**`listen EADDRINUSE: address already in use :::8080`**
→ Another process is on port 8080. Change `PORT=8081` in `.env` or kill the other process.

**Open WebUI shows no models**
→ Verify the agent is running: `curl http://localhost:8080/health`. Check `OPENAI_API_BASE_URL=http://market-agent:8080/v1` in the compose file matches the service name.

**Rate limit errors (429)**
→ The Anthropic and OpenAI adapters retry automatically with backoff (up to 3 attempts). If errors persist, reduce concurrent requests or upgrade your API plan.

**Background mode: WebSocket keeps reconnecting**
→ Check that `MARKET_API_KEY` is valid. Authentication failures show as `auth_error` events in the background log.

---
