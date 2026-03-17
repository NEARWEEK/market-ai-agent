/**
 * OpenAI-compatible chat completions adapter.
 * Works with: OpenAI, Ollama, LM Studio, Groq, Together, and any OpenAI-compatible API.
 */

import { config } from '../config';
import { debugLog } from '../debug';
import {
  AgentResponse,
  LLMAdapter,
  Message,
  ToolCall,
  ToolResultMessage,
} from './adapter';
import { ToolDefinition, toOpenAITool } from '../tools/registry';

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';

// ─── OpenAI wire types ────────────────────────────────────────────────────────

interface OAIUserMessage {
  role: 'user';
  content: string;
}

interface OAIAssistantMessage {
  role: 'assistant';
  content: string | null;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
}

interface OAIToolMessage {
  role: 'tool';
  tool_call_id: string;
  content: string;
}

type OAIMessage = OAIUserMessage | OAIAssistantMessage | OAIToolMessage;

interface OAIResponse {
  choices: Array<{
    message: OAIAssistantMessage;
    finish_reason: 'stop' | 'tool_calls' | 'length' | string;
  }>;
}

// ─── Conversion helpers ───────────────────────────────────────────────────────

function toOAIMessages(messages: Message[]): OAIMessage[] {
  const result: OAIMessage[] = [];

  for (const msg of messages) {
    if (msg.role === 'user') {
      result.push({ role: 'user', content: msg.content });
      continue;
    }

    if (msg.role === 'assistant') {
      const oai: OAIAssistantMessage = {
        role: 'assistant',
        content: msg.text || null,
      };
      if (msg.toolCalls && msg.toolCalls.length > 0) {
        oai.tool_calls = msg.toolCalls.map(tc => ({
          id: tc.id,
          type: 'function' as const,
          function: {
            name: tc.name,
            arguments: JSON.stringify(tc.input),
          },
        }));
      }
      result.push(oai);
      continue;
    }

    if (msg.role === 'tool_result') {
      // Each tool result becomes a separate 'tool' message
      for (const call of (msg as ToolResultMessage).calls) {
        result.push({
          role: 'tool',
          tool_call_id: call.id,
          content: call.isError ? `Error: ${call.result}` : call.result,
        });
      }
    }
  }

  return result;
}

function parseResponse(raw: OAIResponse): AgentResponse {
  const choice = raw.choices[0];
  if (!choice) throw new Error('OpenAI returned no choices');

  const msg = choice.message;
  const text = msg.content ?? '';
  const toolCalls: ToolCall[] = (msg.tool_calls ?? []).map(tc => ({
    id: tc.id,
    name: tc.function.name,
    input: (() => {
      try {
        return JSON.parse(tc.function.arguments) as Record<string, unknown>;
      } catch {
        return {};
      }
    })(),
  }));

  const finishReason = choice.finish_reason;
  const stopReason =
    finishReason === 'tool_calls'
      ? 'tool_use'
      : finishReason === 'length'
        ? 'max_tokens'
        : 'end_turn';

  return {
    content: text,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    stopReason,
  };
}

// ─── Adapter ──────────────────────────────────────────────────────────────────

export class OpenAIAdapter implements LLMAdapter {
  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor() {
    this.baseUrl = (config.llm.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
    // LLM_API_KEY or OPENAI_API_KEY for OpenAI / third-party providers.
    // Falls back to 'ollama' only for local Ollama which ignores the Authorization header.
    this.apiKey = config.llm.llmApiKey ?? 'ollama';
  }

  async complete(
    messages: Message[],
    tools: ToolDefinition[],
    system: string,
  ): Promise<AgentResponse> {
    // Prepend system as a user message (works universally across providers)
    const oaiMessages: OAIMessage[] = [
      { role: 'user', content: `[System]\n${system}` },
      ...toOAIMessages(messages),
    ];

    const body: Record<string, unknown> = {
      model: config.llm.model,
      messages: oaiMessages,
    };

    if (tools.length > 0) {
      body['tools'] = tools.map(toOpenAITool);
      body['tool_choice'] = 'auto';
    }

    const headers = {
      Authorization: `Bearer ${this.apiKey}`,
      'content-type': 'application/json',
    };

    const completionsUrl = `${this.baseUrl}/chat/completions`;

    debugLog('openai', 'request', {
      url: completionsUrl,
      method: 'POST',
      body,
    });

    const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

    let lastError: Error | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) {
        const delay = 10000 * attempt;
        console.log(`[openai] Rate limited — retrying in ${delay / 1000}s (attempt ${attempt + 1}/3)`);
        await sleep(delay);
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 60_000); // 60s for LLM calls

      let response: Response;
      try {
        response = await fetch(completionsUrl, {
          method: 'POST',
          signal: controller.signal,
          headers,
          body: JSON.stringify(body),
        });
      } catch (err) {
        clearTimeout(timeout);
        if ((err as Error).name === 'AbortError') {
          throw new Error('OpenAI API request timed out after 60s');
        }
        throw new Error(`OpenAI API network error: ${(err as Error).message}`);
      }
      clearTimeout(timeout);

      if (response.status === 429) {
        const err = (await response.json().catch(() => ({}))) as Record<string, unknown>;
        const detail =
          typeof err['error'] === 'object' && err['error'] !== null
            ? (err['error'] as Record<string, unknown>)['message']
            : 'rate limit';
        lastError = new Error(`OpenAI API error 429: ${detail}`);
        continue;
      }

      if (!response.ok) {
        const err = (await response.json().catch(() => ({}))) as Record<string, unknown>;
        debugLog('openai', 'response-error', { status: response.status, body: err });
        const detail =
          typeof err['error'] === 'object' && err['error'] !== null
            ? (err['error'] as Record<string, unknown>)['message']
            : String(err['error'] ?? response.statusText);
        throw new Error(`OpenAI API error ${response.status}: ${detail}`);
      }

      const raw = (await response.json()) as OAIResponse;
      debugLog('openai', 'response', { status: response.status, body: raw });
      return parseResponse(raw);
    }

    throw lastError ?? new Error('OpenAI API: max retries exceeded');
  }
}
