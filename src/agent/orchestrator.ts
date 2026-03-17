/**
 * Agentic loop: LLM → tool calls → executor → results → LLM → ... until end_turn.
 */

import { createAdapter } from '../llm/adapter';
import {
  Message,
  UserMessage,
  AssistantMessage,
  ToolResultMessage,
  ToolCall,
} from '../llm/adapter';
import { getTools } from '../skill-loader';
import { buildSystemPrompt } from './system-prompt';
import { executeTool } from '../tools/executor';
import { MarketAPIError } from '../tools/executor';
import {
  startBackground,
  stopBackground,
  getBackgroundStatus,
  getActivityLog,
} from './background';
import { manualRefresh, getSkillLastUpdated } from '../skill-loader';

export interface OrchestratorOptions {
  /** Maximum LLM→tool→LLM iterations before giving up. Default: 10. */
  maxIterations?: number;
  /**
   * Maximum number of messages to keep in history (excluding the current user message).
   * Oldest messages are dropped first to stay within token budgets. Default: 20.
   */
  maxHistoryMessages?: number;
}

/**
 * Trim history to at most `maxMessages` entries.
 * Always preserves the first message (original context) and trims from the middle.
 */
function trimHistory(history: Message[], maxMessages: number): Message[] {
  if (history.length <= maxMessages) return history;
  // Keep first message + most recent (maxMessages - 1) messages
  return [history[0]!, ...history.slice(-(maxMessages - 1))];
}

export interface OrchestratorResult {
  /** Final text response to show the user. */
  response: string;
  /** Updated conversation history (append to your session history). */
  updatedHistory: Message[];
  /** Number of tool calls made in this run. */
  toolCallCount: number;
}

// ─── Tool execution ───────────────────────────────────────────────────────────

async function executeToolCalls(
  toolCalls: ToolCall[],
): Promise<ToolResultMessage> {
  const tools = getTools();
  const toolMap = new Map(tools.map(t => [t.name, t]));

  const calls = await Promise.all(
    toolCalls.map(async tc => {
      const toolDef = toolMap.get(tc.name);
      if (!toolDef) {
        return {
          id: tc.id,
          name: tc.name,
          result: `Unknown tool: ${tc.name}`,
          isError: true,
        };
      }

      try {
        const result = await executeTool(toolDef, tc.input);
        return {
          id: tc.id,
          name: tc.name,
          result: typeof result === 'string' ? result : JSON.stringify(result, null, 2),
          isError: false,
        };
      } catch (err) {
        const message =
          err instanceof MarketAPIError
            ? `API error ${err.status}: ${err.message}`
            : (err as Error).message;
        return {
          id: tc.id,
          name: tc.name,
          result: message,
          isError: true,
        };
      }
    }),
  );

  return { role: 'tool_result', calls };
}

// ─── Main orchestrator ────────────────────────────────────────────────────────

// ─── Background command intercept ────────────────────────────────────────────

/**
 * Check if the user message is a background mode command.
 * Returns a pre-built response string if handled, otherwise null.
 */
async function tryHandleBackgroundCommand(msg: string): Promise<string | null> {
  const lower = msg.toLowerCase().trim();

  if (/\b(disable|stop|turn off|deactivate)\b.*\bbackground\b/.test(lower) ||
      /\bbackground\b.*\b(disable|stop|off)\b/.test(lower)) {
    stopBackground();
    return '🔴 **Background mode disabled.** The WebSocket connection has been closed.';
  }

  if (/\b(enable|start|turn on|activate)\b.*\bbackground\b/.test(lower) ||
      /\bbackground\b.*\b(enable|start|on)\b/.test(lower)) {
    startBackground();
    return '✅ **Background mode enabled.** I will now autonomously handle incoming messages, job awards, and change requests. Use "show background activity" to see what I\'ve done.';
  }

  if (/\bbackground\b.*\b(activity|log|actions|history)\b/.test(lower) ||
      /\b(show|what happened|recent)\b.*\bbackground\b/.test(lower) ||
      /while i was away/.test(lower)) {
    const log = getActivityLog(20);
    if (log.length === 0) {
      return '📋 **Background activity log is empty.** No autonomous actions have been taken yet.';
    }
    const lines = log.map(e =>
      `- \`${e.timestamp}\` **[${e.event}]** ${e.detail} → ${e.action} ${e.success ? '✓' : '✗'}`
    );
    return `📋 **Recent background activity (${log.length} entries):**\n\n${lines.join('\n')}`;
  }

  if (/\bbackground\b.*\b(status|state|info)\b/.test(lower) ||
      /\b(status|state)\b.*\bbackground\b/.test(lower)) {
    const status = getBackgroundStatus();
    const counts = Object.entries(status.eventCounts)
      .map(([k, v]) => `  - ${k}: ${v}`)
      .join('\n') || '  (none)';
    return `🔌 **Background mode status:**\n\n` +
      `- **Enabled:** ${status.enabled ? 'Yes' : 'No'}\n` +
      `- **Connected since:** ${status.connectedAt ?? 'N/A'}\n` +
      `- **Last event:** ${status.lastEventAt ?? 'N/A'}\n` +
      `- **Reconnect attempts:** ${status.reconnectAttempts}\n` +
      `- **Event counts:**\n${counts}`;
  }

  // Skill refresh command
  if (/\b(refresh|update|reload)\b.*\b(skill|api|tools?)\b/.test(lower) ||
      /\b(skill|api|tools?)\b.*\b(refresh|update|reload)\b/.test(lower)) {
    const result = await manualRefresh();
    if (result.error) {
      return `❌ **Skill refresh failed:** ${result.error}\n\nUsing the last known tool set (${result.toolCount} tools, version \`${result.version}\`).`;
    }
    const changeNote = result.changed
      ? `✅ **Skill updated** — new version \`${result.version}\``
      : `ℹ️ **No changes** — skill.md is unchanged (version \`${result.version}\`)`;
    return `${changeNote}\n- **Tools available:** ${result.toolCount}\n- **Last updated:** ${getSkillLastUpdated()?.toISOString() ?? 'N/A'}`;
  }

  return null;
}

// ─── Agentic loop ─────────────────────────────────────────────────────────────

/**
 * Run the agentic loop for a single user turn.
 *
 * @param userMessage   The user's latest message text
 * @param history       Prior conversation history (mutated copy returned)
 * @param options       Optional settings
 */
export async function runAgentLoop(
  userMessage: string,
  history: Message[] = [],
  options: OrchestratorOptions = {},
): Promise<OrchestratorResult> {
  // Fast-path: handle background control commands without hitting the LLM
  const bgResponse = await tryHandleBackgroundCommand(userMessage);
  if (bgResponse !== null) {
    const messages: Message[] = [
      ...history,
      { role: 'user', content: userMessage } satisfies UserMessage,
      { role: 'assistant', text: bgResponse } satisfies AssistantMessage,
    ];
    return { response: bgResponse, updatedHistory: messages, toolCallCount: 0 };
  }

  const maxIterations = options.maxIterations ?? 10;
  const maxHistoryMessages = options.maxHistoryMessages ?? 20;
  const adapter = createAdapter();
  const tools = getTools();
  const system = buildSystemPrompt();

  // Trim history before appending the new user message
  const trimmedHistory = trimHistory(history, maxHistoryMessages);

  // Append the new user message
  const messages: Message[] = [
    ...trimmedHistory,
    { role: 'user', content: userMessage } satisfies UserMessage,
  ];

  let toolCallCount = 0;
  let iterations = 0;
  let finalResponse = '';

  while (iterations < maxIterations) {
    iterations++;

    const agentResponse = await adapter.complete(messages, tools, system);
    finalResponse = agentResponse.content;

    if (agentResponse.stopReason === 'end_turn' || !agentResponse.toolCalls?.length) {
      // Record final assistant message
      messages.push({
        role: 'assistant',
        text: agentResponse.content,
      } satisfies AssistantMessage);
      break;
    }

    // Tool use turn — record assistant message with tool calls
    messages.push({
      role: 'assistant',
      text: agentResponse.content,
      toolCalls: agentResponse.toolCalls,
    } satisfies AssistantMessage);

    // Execute all tool calls
    const toolResults = await executeToolCalls(agentResponse.toolCalls);
    toolCallCount += agentResponse.toolCalls.length;
    messages.push(toolResults);

    if (agentResponse.stopReason === 'max_tokens') {
      finalResponse = '[Response truncated due to token limit]';
      break;
    }
  }

  if (iterations >= maxIterations && !finalResponse) {
    finalResponse = '[Max iterations reached without a final response]';
  }

  return {
    response: finalResponse,
    updatedHistory: messages,
    toolCallCount,
  };
}
