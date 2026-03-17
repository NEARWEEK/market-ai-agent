import express, { Request, Response, NextFunction } from 'express';
import { config } from './config';
import {
  initSkillLoader,
  getLastRefreshed,
  getSkillVersion,
  getSkillLastUpdated,
  getSkillError,
  manualRefresh,
} from './skill-loader';
import { runAgentLoop } from './agent/orchestrator';
import { Message, UserMessage, AssistantMessage } from './llm/adapter';
import {
  startBackground,
  stopBackground,
  getBackgroundStatus,
} from './agent/background';

const app = express();

// ─── Middleware ───────────────────────────────────────────────────────────────

app.use(express.json({ limit: '4mb' }));

// CORS — allow Open WebUI and any browser client
app.use((_req: Request, res: Response, next: NextFunction) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  next();
});

app.options('*', (_req: Request, res: Response) => res.status(204).end());

// Request logger
app.use((req: Request, res: Response, next: NextFunction) => {
  const start = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - start;
    console.log(`${req.method} ${req.path} → ${res.statusCode} (${ms}ms)`);
  });
  next();
});

// ─── Types ────────────────────────────────────────────────────────────────────

interface OAIInputMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string | null;
}

interface ChatCompletionRequest {
  model?: string;
  messages: OAIInputMessage[];
  stream?: boolean;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function toNeutralHistory(messages: OAIInputMessage[]): {
  history: Message[];
  lastUserMessage: string;
} {
  const history: Message[] = [];
  let lastUserMessage = '';

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;
    const content = msg.content ?? '';

    if (msg.role === 'system') continue; // we use our own system prompt

    if (i === messages.length - 1 && msg.role === 'user') {
      lastUserMessage = content;
      continue; // this becomes the userMessage arg, not part of history
    }

    if (msg.role === 'user') {
      history.push({ role: 'user', content } satisfies UserMessage);
    } else if (msg.role === 'assistant') {
      history.push({ role: 'assistant', text: content } satisfies AssistantMessage);
    }
    // 'tool' messages from external clients are ignored — handled internally
  }

  return { history, lastUserMessage };
}

function makeCompletionId(): string {
  return `chatcmpl-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function nonStreamingResponse(id: string, content: string) {
  return {
    id,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: 'market-agent',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

function sendSSE(res: Response, id: string, content: string) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  // Role delta
  const roleChunk = {
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: 'market-agent',
    choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
  };
  res.write(`data: ${JSON.stringify(roleChunk)}\n\n`);

  // Content in one chunk (real streaming requires LLM-level streaming — Phase 8+)
  const contentChunk = {
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: 'market-agent',
    choices: [{ index: 0, delta: { content }, finish_reason: null }],
  };
  res.write(`data: ${JSON.stringify(contentChunk)}\n\n`);

  // Stop
  const stopChunk = {
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: 'market-agent',
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
  };
  res.write(`data: ${JSON.stringify(stopChunk)}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
}

// ─── Routes ───────────────────────────────────────────────────────────────────

app.get('/health', (_req: Request, res: Response) => {
  const lastRefresh = getLastRefreshed();
  const lastUpdated = getSkillLastUpdated();
  const skillError = getSkillError();
  res.json({
    status: skillError ? 'degraded' : 'ok',
    llm_provider: config.llm.provider,
    llm_model: config.llm.model,
    user_role: config.agent.userRole,
    skill_loaded: lastRefresh !== null,
    skill_version: getSkillVersion() || null,
    skill_last_refreshed: lastRefresh?.toISOString() ?? null,
    skill_last_updated: lastUpdated?.toISOString() ?? null,
    skill_error: skillError,
  });
});

app.get('/v1/models', (_req: Request, res: Response) => {
  res.json({
    object: 'list',
    data: [
      {
        id: 'market-agent',
        object: 'model',
        created: 1700000000,
        owned_by: 'market.near.ai',
      },
    ],
  });
});

app.post('/v1/chat/completions', async (req: Request, res: Response) => {
  const body = req.body as ChatCompletionRequest;

  if (!body.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
    res.status(400).json({ error: { message: 'messages array is required', type: 'invalid_request_error' } });
    return;
  }

  const { history, lastUserMessage } = toNeutralHistory(body.messages);

  if (!lastUserMessage) {
    res.status(400).json({ error: { message: 'Last message must be from the user', type: 'invalid_request_error' } });
    return;
  }

  try {
    const result = await runAgentLoop(lastUserMessage, history);
    const id = makeCompletionId();

    // Attach tool call count to log
    res.on('finish', () => {
      if (result.toolCallCount > 0) {
        console.log(`  └─ tool calls: ${result.toolCallCount}`);
      }
    });

    if (body.stream) {
      sendSSE(res, id, result.response);
    } else {
      res.json(nonStreamingResponse(id, result.response));
    }
  } catch (err) {
    const raw = (err as Error).message;
    console.error('Orchestrator error:', raw);
    // Strip anything that looks like a secret key before sending to client
    const safe = raw.replace(/sk[-_][A-Za-z0-9_-]{10,}/g, '[REDACTED]');
    res.status(500).json({ error: { message: safe, type: 'internal_error' } });
  }
});

// ─── Skill refresh endpoint ───────────────────────────────────────────────────

app.post('/agent/refresh-skill', async (_req: Request, res: Response) => {
  const result = await manualRefresh();
  res.status(result.error ? 500 : 200).json({
    ok: !result.error,
    version: result.version,
    tool_count: result.toolCount,
    changed: result.changed,
    error: result.error,
  });
});

// ─── Background mode endpoints ───────────────────────────────────────────────

app.post('/agent/background/start', (_req: Request, res: Response) => {
  startBackground();
  res.json({ ok: true, message: 'Background mode started' });
});

app.post('/agent/background/stop', (_req: Request, res: Response) => {
  stopBackground();
  res.json({ ok: true, message: 'Background mode stopped' });
});

app.get('/agent/background/status', (_req: Request, res: Response) => {
  res.json(getBackgroundStatus());
});

// ─── Startup ──────────────────────────────────────────────────────────────────

async function main() {
  console.log('market.near.ai agent starting...');
  console.log(`  LLM provider : ${config.llm.provider}`);
  console.log(`  LLM model    : ${config.llm.model}`);
  console.log(`  User role    : ${config.agent.userRole}`);
  console.log(`  Port         : ${config.server.port}`);

  await initSkillLoader();

  app.listen(config.server.port, () => {
    console.log(`Server listening on http://localhost:${config.server.port}`);
  });
}

main().catch(err => {
  console.error('Startup error:', err);
  process.exit(1);
});
