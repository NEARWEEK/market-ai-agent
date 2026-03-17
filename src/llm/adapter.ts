/**
 * Common LLM adapter interface and neutral message types used throughout the agent.
 */

import { ToolDefinition } from '../tools/registry';

export { ToolDefinition };

// ─── Message types ────────────────────────────────────────────────────────────

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/** A user turn in the conversation. */
export interface UserMessage {
  role: 'user';
  content: string;
}

/** An assistant turn — may contain text, tool calls, or both. */
export interface AssistantMessage {
  role: 'assistant';
  text: string;
  toolCalls?: ToolCall[];
}

/** Tool execution results, returned as a single logical turn. */
export interface ToolResultMessage {
  role: 'tool_result';
  calls: Array<{
    id: string;
    name: string;
    result: string;
    isError: boolean;
  }>;
}

export type Message = UserMessage | AssistantMessage | ToolResultMessage;

// ─── Adapter response ─────────────────────────────────────────────────────────

export interface AgentResponse {
  /** Final or intermediate text from the model. */
  content: string;
  /** Present when the model wants to call tools. */
  toolCalls?: ToolCall[];
  stopReason: 'end_turn' | 'tool_use' | 'max_tokens';
}

// ─── Adapter interface ────────────────────────────────────────────────────────

export interface LLMAdapter {
  complete(
    messages: Message[],
    tools: ToolDefinition[],
    system: string,
  ): Promise<AgentResponse>;
}

// ─── Factory ──────────────────────────────────────────────────────────────────

import { config } from '../config';
import { AnthropicAdapter } from './anthropic';
import { OpenAIAdapter } from './openai';

export function createAdapter(): LLMAdapter {
  switch (config.llm.provider) {
    case 'anthropic':
      return new AnthropicAdapter();
    case 'openai':
    case 'ollama':
      return new OpenAIAdapter();
    default: {
      const exhaustive: never = config.llm.provider;
      throw new Error(`Unknown LLM provider: ${exhaustive}`);
    }
  }
}
