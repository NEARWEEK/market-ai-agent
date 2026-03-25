import * as dotenv from 'dotenv';

dotenv.config();

function require_env(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optional_env(name: string, defaultValue?: string): string | undefined {
  return process.env[name] ?? defaultValue;
}

const provider = require_env('LLM_PROVIDER') as 'anthropic' | 'openai' | 'ollama';

if (!['anthropic', 'openai', 'ollama'].includes(provider)) {
  throw new Error(
    `Invalid LLM_PROVIDER "${provider}". Must be one of: anthropic, openai, ollama`
  );
}

if (provider === 'anthropic' && !process.env['ANTHROPIC_API_KEY']) {
  throw new Error(
    'Missing required environment variable: ANTHROPIC_API_KEY (required when LLM_PROVIDER=anthropic)'
  );
}

// LLM_API_KEY is the generic key for any OpenAI-compatible provider.
// OPENAI_API_KEY is kept for backwards compatibility with openai provider.
// Priority for non-Anthropic providers: LLM_API_KEY > OPENAI_API_KEY > (dummy 'ollama' for local Ollama)
const llmApiKey =
  optional_env('LLM_API_KEY') ??
  optional_env('OPENAI_API_KEY');

if (provider === 'openai' && !llmApiKey) {
  throw new Error(
    'Missing required environment variable: LLM_API_KEY or OPENAI_API_KEY (required when LLM_PROVIDER=openai)'
  );
}

if (provider === 'ollama' && optional_env('LLM_BASE_URL') && !llmApiKey) {
  console.warn(
    '[config] Warning: LLM_BASE_URL is set but no LLM_API_KEY or OPENAI_API_KEY found. ' +
    'Third-party providers usually require an API key.'
  );
}

export const config = {
  llm: {
    provider,
    model: require_env('LLM_MODEL'),
    baseUrl: optional_env('LLM_BASE_URL'),
    anthropicApiKey: optional_env('ANTHROPIC_API_KEY'),
    /** API key for all OpenAI-compatible providers. Set via LLM_API_KEY or OPENAI_API_KEY. */
    llmApiKey,
  },
  market: {
    apiKey: require_env('MARKET_API_KEY'),
    /**
     * HTTP timeout for market.near.ai API calls in milliseconds.
     * Blockchain-backed endpoints (award, accept, withdraw) can take tens of seconds.
     * Default: 90 000 ms (90 s).
     */
    timeoutMs: parseInt(optional_env('MARKET_API_TIMEOUT_MS', '90000') as string, 10),
  },
  server: {
    port: parseInt(optional_env('PORT', '8080') as string, 10),
  },
  agent: {
    skillRefreshIntervalMs: parseInt(
      optional_env('SKILL_REFRESH_INTERVAL_MS', '1800000') as string,
      10
    ),
    userRole: (optional_env('USER_ROLE', 'auto') as 'requester' | 'worker' | 'auto'),
  },
  /** Enable verbose request/response logging for all outbound API calls. */
  debug: optional_env('DEBUG', 'false') === 'true',
} as const;
