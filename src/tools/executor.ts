/**
 * Market API executor.
 * Provides a generic `callMarketAPI` function and a `executeTool` entry point
 * that maps tool names → HTTP calls using the ToolDefinition registry.
 */

import { config } from '../config';
import { debugLog } from '../debug';
import { ToolDefinition } from './registry';

const BASE_URL = 'https://market.near.ai/v1';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface APIError {
  status: number;
  message: string;
  body: unknown;
}

export class MarketAPIError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly body: unknown,
  ) {
    super(`Market API error ${status}: ${message}`);
    this.name = 'MarketAPIError';
  }
}

// ─── Core HTTP helper ─────────────────────────────────────────────────────────

/**
 * Make an authenticated request to market.near.ai.
 *
 * @param method   HTTP method (GET, POST, PATCH, PUT, DELETE)
 * @param path     API path starting with /v1/...
 * @param body     Request body (for POST/PATCH/PUT)
 * @param params   Query parameters (for GET/DELETE)
 */
export async function callMarketAPI(
  method: string,
  path: string,
  body?: Record<string, unknown>,
  params?: Record<string, string | number | boolean>,
): Promise<unknown> {
  let url = `${BASE_URL}${path.startsWith('/v1') ? path.slice(3) : path}`;

  // Append query params
  if (params && Object.keys(params).length > 0) {
    const qs = new URLSearchParams(
      Object.entries(params).map(([k, v]) => [k, String(v)]),
    ).toString();
    url += `?${qs}`;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.market.timeoutMs);

  const init: RequestInit = {
    method: method.toUpperCase(),
    signal: controller.signal,
    headers: {
      Authorization: `Bearer ${config.market.apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
  };

  if (body !== undefined && !['GET', 'DELETE', 'HEAD'].includes(method.toUpperCase())) {
    init.body = JSON.stringify(body);
  }

  debugLog('market-api', 'request', {
    method: method.toUpperCase(),
    url,
    body: body ?? null,
  });

  let response: Response;
  try {
    response = await fetch(url, init);
  } catch (err) {
    clearTimeout(timeout);
    if ((err as Error).name === 'AbortError') {
      throw new Error(`Market API request timed out after ${config.market.timeoutMs / 1000}s (${method} ${path})`);
    }
    throw new Error(`Market API network error: ${(err as Error).message}`);
  }
  clearTimeout(timeout);

  // Parse body regardless of status (errors often carry JSON details)
  let responseBody: unknown;
  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    responseBody = await response.json();
  } else {
    responseBody = await response.text();
  }

  debugLog('market-api', response.ok ? 'response' : 'response-error', {
    status: response.status,
    body: responseBody,
  });

  if (!response.ok) {
    const message =
      typeof responseBody === 'object' &&
      responseBody !== null &&
      'detail' in (responseBody as Record<string, unknown>)
        ? String((responseBody as Record<string, unknown>)['detail'])
        : `HTTP ${response.status}`;
    throw new MarketAPIError(response.status, message, responseBody);
  }

  return responseBody;
}

// ─── Path interpolation ───────────────────────────────────────────────────────

/**
 * Replace `{param}` placeholders in a path with values from `inputs`,
 * and return remaining inputs for use as query params or body.
 */
function interpolatePath(
  path: string,
  inputs: Record<string, unknown>,
): { interpolated: string; remaining: Record<string, unknown> } {
  const remaining = { ...inputs };
  const interpolated = path.replace(/\{([^}]+)\}/g, (_match, key: string) => {
    const value = remaining[key];
    if (value === undefined || value === null) {
      throw new Error(`Missing required path parameter: ${key}`);
    }
    delete remaining[key];
    return encodeURIComponent(String(value));
  });
  return { interpolated, remaining };
}

// ─── Tool executor ────────────────────────────────────────────────────────────

/** Redact any value that looks like a secret key before it reaches logs or responses. */
function sanitizeInputs(inputs: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const KEY_PATTERN = /\b(sk-|sk_live_|sk_ant-|Bearer\s)/i;
  for (const [k, v] of Object.entries(inputs)) {
    if (typeof v === 'string' && KEY_PATTERN.test(v)) {
      result[k] = '[REDACTED]';
    } else {
      result[k] = v;
    }
  }
  return result;
}

/**
 * Execute a tool call from the LLM agent.
 *
 * @param tool   The ToolDefinition (from registry)
 * @param inputs Raw key-value inputs from the LLM
 */
export async function executeTool(
  tool: ToolDefinition,
  inputs: Record<string, unknown>,
): Promise<unknown> {
  const safe = sanitizeInputs(inputs);

  // Validate required fields from schema
  const missing = tool.inputSchema.required.filter(
    k => safe[k] === undefined || safe[k] === null || safe[k] === '',
  );
  if (missing.length > 0) {
    throw new Error(`Tool "${tool.name}" missing required inputs: ${missing.join(', ')}`);
  }

  const { interpolated: path, remaining } = interpolatePath(tool.path, safe);
  const method = tool.method.toUpperCase();

  if (['GET', 'DELETE'].includes(method)) {
    // Remaining inputs go as query parameters
    const params: Record<string, string | number | boolean> = {};
    for (const [k, v] of Object.entries(remaining)) {
      if (v !== undefined && v !== null) {
        params[k] = v as string | number | boolean;
      }
    }
    return callMarketAPI(method, path, undefined, params);
  } else {
    // Remaining inputs go as JSON body
    const body: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(remaining)) {
      if (v !== undefined && v !== null) {
        body[k] = v;
      }
    }
    return callMarketAPI(method, path, Object.keys(body).length > 0 ? body : undefined);
  }
}

// ─── Typed convenience wrappers ───────────────────────────────────────────────
// These give the rest of the codebase a cleaner, named API for common operations.

export const marketAPI = {
  // Agents
  getMyProfile: () => callMarketAPI('GET', '/v1/agents/me'),
  getAgent: (agentIdOrHandle: string) =>
    callMarketAPI('GET', `/v1/agents/${encodeURIComponent(agentIdOrHandle)}`),
  listAgents: (params?: Record<string, string | number | boolean>) =>
    callMarketAPI('GET', '/v1/agents', undefined, params),
  registerAgent: (body: Record<string, unknown>) =>
    callMarketAPI('POST', '/v1/agents/register', body),
  rotateApiKey: () => callMarketAPI('POST', '/v1/agents/rotate-key'),

  // Jobs
  listJobs: (params?: Record<string, string | number | boolean>) =>
    callMarketAPI('GET', '/v1/jobs', undefined, params),
  createJob: (body: Record<string, unknown>) => callMarketAPI('POST', '/v1/jobs', body),
  createInstantJob: (body: Record<string, unknown>) =>
    callMarketAPI('POST', '/v1/jobs/instant', body),
  getJob: (jobId: string) => callMarketAPI('GET', `/v1/jobs/${jobId}`),
  updateJob: (jobId: string, body: Record<string, unknown>) =>
    callMarketAPI('PATCH', `/v1/jobs/${jobId}`, body),
  deleteJob: (jobId: string) => callMarketAPI('DELETE', `/v1/jobs/${jobId}`),
  awardJob: (jobId: string, bidId: string) =>
    callMarketAPI('POST', `/v1/jobs/${jobId}/award`, { bid_id: bidId }),
  submitWork: (jobId: string, body: Record<string, unknown>) =>
    callMarketAPI('POST', `/v1/jobs/${jobId}/submit`, body),
  acceptWork: (jobId: string, body?: Record<string, unknown>) =>
    callMarketAPI('POST', `/v1/jobs/${jobId}/accept`, body),
  cancelJob: (jobId: string) => callMarketAPI('POST', `/v1/jobs/${jobId}/cancel`),
  requestChanges: (jobId: string, feedback: string) =>
    callMarketAPI('POST', `/v1/jobs/${jobId}/request-changes`, { feedback }),

  // Bids
  listBids: (jobId: string) => callMarketAPI('GET', `/v1/jobs/${jobId}/bids`),
  placeBid: (jobId: string, body: Record<string, unknown>) =>
    callMarketAPI('POST', `/v1/jobs/${jobId}/bids`, body),
  myBids: (params?: Record<string, string | number | boolean>) =>
    callMarketAPI('GET', '/v1/agents/me/bids', undefined, params),
  withdrawBid: (bidId: string) => callMarketAPI('POST', `/v1/bids/${bidId}/withdraw`),

  // Messages
  sendPrivateMessage: (assignmentId: string, content: string) =>
    callMarketAPI('POST', `/v1/assignments/${assignmentId}/messages`, { body: content }),
  getPrivateMessages: (
    assignmentId: string,
    params?: Record<string, string | number | boolean>,
  ) => callMarketAPI('GET', `/v1/assignments/${assignmentId}/messages`, undefined, params),
  sendPublicMessage: (jobId: string, content: string) =>
    callMarketAPI('POST', `/v1/jobs/${jobId}/messages`, { body: content }),
  getPublicMessages: (jobId: string, params?: Record<string, string | number | boolean>) =>
    callMarketAPI('GET', `/v1/jobs/${jobId}/messages`, undefined, params),

  // Wallet
  getBalance: () => callMarketAPI('GET', '/v1/wallet/balance'),
  getDepositAddress: () => callMarketAPI('GET', '/v1/wallet/deposit_address'),
  withdraw: (body: Record<string, unknown>) => callMarketAPI('POST', '/v1/wallet/withdraw', body),
  listDeposits: () => callMarketAPI('GET', '/v1/wallet/deposits'),

  // Disputes
  openDispute: (jobId: string, reason: string) =>
    callMarketAPI('POST', `/v1/jobs/${jobId}/dispute`, { reason }),
  getDispute: (disputeId: string) => callMarketAPI('GET', `/v1/disputes/${disputeId}`),
  addEvidence: (disputeId: string, content: string) =>
    callMarketAPI('POST', `/v1/disputes/${disputeId}/evidence`, { content }),

  // Services
  invokeService: (serviceId: string, body: Record<string, unknown>) =>
    callMarketAPI('POST', `/v1/services/${serviceId}/invoke`, body),

  // Channels
  openChannel: (body: Record<string, unknown>) => callMarketAPI('POST', '/v1/channels', body),
  listChannels: (params?: Record<string, string | number | boolean>) =>
    callMarketAPI('GET', '/v1/channels', undefined, params),
  getChannel: (channelId: string) => callMarketAPI('GET', `/v1/channels/${channelId}`),
  topUpChannel: (channelId: string, amount: string) =>
    callMarketAPI('POST', `/v1/channels/${channelId}/top-up`, { amount }),
  settleChannel: (channelId: string) =>
    callMarketAPI('POST', `/v1/channels/${channelId}/settle`),
  closeChannel: (channelId: string) =>
    callMarketAPI('POST', `/v1/channels/${channelId}/close`),
};
