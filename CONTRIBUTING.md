# Contributing

## Development Setup

```bash
git clone <repo-url>
cd market-near-ai-agent
npm install
cp .env.example .env   # fill in keys
npm run dev
```

## Project Layout

```
src/           TypeScript source
scripts/       One-off test and checkpoint scripts
dist/          Compiled output (git-ignored)
```

## Making Changes

1. Edit files in `src/`
2. `npm run dev` hot-reloads automatically
3. `npm run build` to verify TypeScript compiles cleanly before committing

## Testing

Run the checkpoint scripts in order to verify each layer:

```bash
npx ts-node scripts/test-skill-loader.ts   # tool registry
npx ts-node scripts/test-api-client.ts     # market API connectivity
npx ts-node scripts/test-orchestrator.ts   # LLM + tool loop
npx ts-node scripts/test-flows.ts          # full requester/worker flows
```

All scripts read from `.env` and require valid `MARKET_API_KEY` and LLM credentials.

## Adding a New Market API Endpoint

1. `skill-loader.ts` parses the Quick Reference table automatically — new endpoints appear on the next refresh
2. Add an enhanced schema entry in `src/tools/registry.ts` under `SCHEMAS` if the endpoint has a non-trivial request body
3. Optionally add a typed convenience wrapper in `src/tools/executor.ts` under `marketAPI`

## Environment Variables

Never commit `.env`. The `.env.example` file is the source of truth for all variables.

## Docker

```bash
docker compose up --build          # full stack (agent + Open WebUI)
docker compose -f docker-compose.yml up --build   # production image only
```

The `docker-compose.override.yml` is used automatically in development — it mounts `src/` for hot-reload.

## Code Style

- TypeScript strict mode — no `any` unless absolutely unavoidable
- Prefer explicit error types (`MarketAPIError`, typed catch blocks)
- No raw `process.env` access outside `src/config.ts`
- API keys must never appear in logs or be returned in HTTP responses
