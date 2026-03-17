/**
 * Anthropic Messages API adapter (direct fetch, no SDK).
 * Docs: https://docs.anthropic.com/en/api/messages
 */

import { config } from '../config';
import { debugLog } from '../debug';
import {
  AgentResponse,
  AssistantMessage,
  LLMAdapter,
  Message,
  ToolCall,
  ToolResultMessage,
} from './adapter';
import { ToolDefinition, toAnthropicTool } from '../tools/registry';

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const MAX_TOKENS = 4096;

// ─── Anthropic wire types ─────────────────────────────────────────────────────

type AnthropicContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean };

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | AnthropicContentBlock[];
}

interface AnthropicResponse {
  content: AnthropicContentBlock[];
  stop_reason: 'end_turn' | 'tool_use' | 'max_tokens';
}

// ─── Conversion helpers ───────────────────────────────────────────────────────

function toAnthropicMessages(messages: Message[]): AnthropicMessage[] {
  const result: AnthropicMessage[] = [];

  for (const msg of messages) {
    if (msg.role === 'user') {
      result.push({ role: 'user', content: msg.content });
      continue;
    }

    if (msg.role === 'assistant') {
      const blocks: AnthropicContentBlock[] = [];
      if (msg.text) {
        blocks.push({ type: 'text', text: msg.text });
      }
      for (const tc of msg.toolCalls ?? []) {
        blocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.input });
      }
      result.push({ role: 'assistant', content: blocks.length === 1 && blocks[0]?.type === 'text' ? msg.text : blocks });
      continue;
    }

    if (msg.role === 'tool_result') {
      const blocks: AnthropicContentBlock[] = (msg as ToolResultMessage).calls.map(c => ({
        type: 'tool_result' as const,
        tool_use_id: c.id,
        content: c.result,
        is_error: c.isError || undefined,
      }));
      result.push({ role: 'user', content: blocks });
    }
  }

  return result;
}

function parseResponse(raw: AnthropicResponse): AgentResponse {
  let text = '';
  const toolCalls: ToolCall[] = [];

  for (const block of raw.content) {
    if (block.type === 'text') {
      text += block.text;
    } else if (block.type === 'tool_use') {
      toolCalls.push({ id: block.id, name: block.name, input: block.input });
    }
  }

  const stopReason =
    raw.stop_reason === 'tool_use'
      ? 'tool_use'
      : raw.stop_reason === 'max_tokens'
        ? 'max_tokens'
        : 'end_turn';

  return {
    content: text,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    stopReason,
  };
}

// ─── Adapter ──────────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export class AnthropicAdapter implements LLMAdapter {
  async complete(
    messages: Message[],
    tools: ToolDefinition[],
    system: string,
  ): Promise<AgentResponse> {
    const body: Record<string, unknown> = {
      model: config.llm.model,
      max_tokens: MAX_TOKENS,
      system,
      messages: toAnthropicMessages(messages),
    };

    if (tools.length > 0) {
      body['tools'] = tools.map(toAnthropicTool);
    }

    const headers = {
      'x-api-key': config.llm.anthropicApiKey ?? '',
      'anthropic-version': ANTHROPIC_VERSION,
      'content-type': 'application/json',
    };

    debugLog('anthropic', 'request', {
      url: ANTHROPIC_API_URL,
      method: 'POST',
      body,
    });

    // Retry up to 3 times on rate limit (429) with exponential backoff
    let lastError: Error | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) {
        const delay = 10000 * attempt; // 10s, 20s
        console.log(`[anthropic] Rate limited — retrying in ${delay / 1000}s (attempt ${attempt + 1}/3)`);
        await sleep(delay);
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 60_000); // 60s for LLM calls

      let response: Response;
      try {
        response = await fetch(ANTHROPIC_API_URL, {
          method: 'POST',
          signal: controller.signal,
          headers,
          body: JSON.stringify(body),
        });
      } catch (err) {
        clearTimeout(timeout);
        if ((err as Error).name === 'AbortError') {
          throw new Error('Anthropic API request timed out after 60s');
        }
        throw new Error(`Anthropic API network error: ${(err as Error).message}`);
      }
      clearTimeout(timeout);

      if (response.status === 429) {
        const err = (await response.json().catch(() => ({}))) as Record<string, unknown>;
        const detail =
          typeof err['error'] === 'object' && err['error'] !== null
            ? (err['error'] as Record<string, unknown>)['message']
            : String(err['error'] ?? 'rate limit');
        lastError = new Error(`Anthropic API error 429: ${detail}`);
        continue;
      }

      if (!response.ok) {
        const err = (await response.json().catch(() => ({}))) as Record<string, unknown>;
        debugLog('anthropic', 'response-error', { status: response.status, body: err });
        const detail =
          typeof err['error'] === 'object' && err['error'] !== null
            ? (err['error'] as Record<string, unknown>)['message']
            : err['error'];
        throw new Error(`Anthropic API error ${response.status}: ${detail ?? response.statusText}`);
      }

      const raw = (await response.json()) as AnthropicResponse;
      debugLog('anthropic', 'response', { status: response.status, body: raw });
      return parseResponse(raw);
    }

    throw lastError ?? new Error('Anthropic API: max retries exceeded');
  }
}

// Exported for use in message history construction
export type { AssistantMessage };
