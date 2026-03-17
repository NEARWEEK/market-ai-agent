/**
 * Background worker mode.
 * Connects to the market.near.ai WebSocket and autonomously handles events
 * without the user being present in chat.
 */

import WebSocket from 'ws';
import { config } from '../config';
import { marketAPI } from '../tools/executor';
import { runAgentLoop } from './orchestrator';

const WS_URL = 'wss://market.near.ai/v1/ws';

// ─── Activity log ─────────────────────────────────────────────────────────────

export interface ActivityEntry {
  timestamp: string;
  event: string;
  detail: string;
  action: string;
  success: boolean;
}

const MAX_LOG_ENTRIES = 200;
const activityLog: ActivityEntry[] = [];

function logActivity(entry: Omit<ActivityEntry, 'timestamp'>) {
  const full: ActivityEntry = { timestamp: new Date().toISOString(), ...entry };
  activityLog.push(full);
  if (activityLog.length > MAX_LOG_ENTRIES) activityLog.shift();
  console.log(`[background] [${full.event}] ${full.detail} → ${full.action} (${full.success ? 'ok' : 'error'})`);
}

export function getActivityLog(tail = 20): ActivityEntry[] {
  return activityLog.slice(-tail);
}

// ─── Stats ────────────────────────────────────────────────────────────────────

interface Stats {
  enabled: boolean;
  connectedAt: string | null;
  lastEventAt: string | null;
  eventCounts: Record<string, number>;
  reconnectAttempts: number;
}

const stats: Stats = {
  enabled: false,
  connectedAt: null,
  lastEventAt: null,
  eventCounts: {},
  reconnectAttempts: 0,
};

function bumpEvent(event: string) {
  stats.eventCounts[event] = (stats.eventCounts[event] ?? 0) + 1;
  stats.lastEventAt = new Date().toISOString();
}

export function getBackgroundStatus() {
  return {
    ...stats,
    activityLogTail: getActivityLog(10),
  };
}

// ─── WebSocket management ─────────────────────────────────────────────────────

let ws: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let pingInterval: ReturnType<typeof setInterval> | null = null;
let shuttingDown = false;

const BACKOFF_BASE_MS = 1000;
const BACKOFF_MAX_MS = 60_000;

function backoffDelay(attempt: number): number {
  return Math.min(BACKOFF_BASE_MS * Math.pow(2, attempt), BACKOFF_MAX_MS);
}

function scheduleReconnect(attempt: number) {
  if (shuttingDown) return;
  const delay = backoffDelay(attempt);
  console.log(`[background] Reconnecting in ${delay / 1000}s (attempt ${attempt + 1})`);
  reconnectTimer = setTimeout(() => connect(attempt + 1), delay);
}

function clearPing() {
  if (pingInterval) {
    clearInterval(pingInterval);
    pingInterval = null;
  }
}

// ─── Event handlers ───────────────────────────────────────────────────────────

async function handleMessageReceived(payload: Record<string, unknown>) {
  const assignmentId = payload['assignment_id'] as string | undefined;
  const messageId = payload['message_id'] as string | undefined;

  if (!assignmentId) {
    logActivity({ event: 'message_received', detail: 'missing assignment_id', action: 'skipped', success: false });
    return;
  }

  try {
    // Fetch recent messages for context
    const messages = await marketAPI.getPrivateMessages(assignmentId, { limit: 10 }) as unknown[];
    const context = JSON.stringify(messages);

    const { response } = await runAgentLoop(
      `A message was received on assignment ${assignmentId}. ` +
      `Here is the conversation so far: ${context}. ` +
      'Draft and send an appropriate reply to the latest message.',
    );

    // Send the reply
    await marketAPI.sendPrivateMessage(assignmentId, response);

    logActivity({
      event: 'message_received',
      detail: `assignment=${assignmentId} msg=${messageId ?? '?'}`,
      action: `replied: ${response.slice(0, 80)}`,
      success: true,
    });
  } catch (err) {
    logActivity({
      event: 'message_received',
      detail: `assignment=${assignmentId}`,
      action: `error: ${(err as Error).message}`,
      success: false,
    });
  }
}

async function handleJobAwarded(payload: Record<string, unknown>) {
  const jobId = payload['job_id'] as string | undefined;
  const assignmentId = payload['assignment_id'] as string | undefined;

  if (!jobId) {
    logActivity({ event: 'job_awarded', detail: 'missing job_id', action: 'skipped', success: false });
    return;
  }

  try {
    const job = await marketAPI.getJob(jobId) as Record<string, unknown>;
    const title = job['title'] as string ?? 'Untitled';

    // Acknowledge award with an introductory message
    if (assignmentId) {
      const ack = await runAgentLoop(
        `I was just awarded the job "${title}" (${jobId}). ` +
        'Send a brief acknowledgment message to the requester confirming I will begin work shortly.',
      );
      await marketAPI.sendPrivateMessage(assignmentId, ack.response);
    }

    logActivity({
      event: 'job_awarded',
      detail: `job=${jobId} title="${title}"`,
      action: assignmentId ? 'sent acknowledgment' : 'logged (no assignment_id)',
      success: true,
    });
  } catch (err) {
    logActivity({
      event: 'job_awarded',
      detail: `job=${jobId}`,
      action: `error: ${(err as Error).message}`,
      success: false,
    });
  }
}

async function handleChangesRequested(payload: Record<string, unknown>) {
  const assignmentId = payload['assignment_id'] as string | undefined;
  const jobId = payload['job_id'] as string | undefined;

  if (!assignmentId) {
    logActivity({ event: 'changes_requested', detail: 'missing assignment_id', action: 'skipped', success: false });
    return;
  }

  try {
    const messages = await marketAPI.getPrivateMessages(assignmentId, { limit: 20 }) as unknown[];
    const context = JSON.stringify(messages);

    const { response } = await runAgentLoop(
      `The requester has requested changes on assignment ${assignmentId} (job ${jobId ?? '?'}). ` +
      `Here is the conversation: ${context}. ` +
      'Acknowledge the change request and send a message explaining how you will address the feedback.',
    );

    await marketAPI.sendPrivateMessage(assignmentId, response);

    logActivity({
      event: 'changes_requested',
      detail: `assignment=${assignmentId}`,
      action: `acknowledged: ${response.slice(0, 80)}`,
      success: true,
    });
  } catch (err) {
    logActivity({
      event: 'changes_requested',
      detail: `assignment=${assignmentId}`,
      action: `error: ${(err as Error).message}`,
      success: false,
    });
  }
}

function handleSubmissionReceived(payload: Record<string, unknown>) {
  const jobId = payload['job_id'] as string | undefined;
  const workerId = payload['worker_id'] as string | undefined;

  logActivity({
    event: 'submission_received',
    detail: `job=${jobId ?? '?'} worker=${workerId ?? '?'}`,
    action: 'logged for user review',
    success: true,
  });
}

function handleBidReceived(payload: Record<string, unknown>) {
  const jobId = payload['job_id'] as string | undefined;
  const bidId = payload['bid_id'] as string | undefined;

  logActivity({
    event: 'bid_received',
    detail: `job=${jobId ?? '?'} bid=${bidId ?? '?'}`,
    action: 'logged for user review',
    success: true,
  });
}

// ─── Main connect loop ────────────────────────────────────────────────────────

function connect(attempt = 0) {
  if (shuttingDown) return;

  ws = new WebSocket(WS_URL);
  stats.reconnectAttempts = attempt;

  ws.on('open', () => {
    console.log('[background] WebSocket connected');
    stats.connectedAt = new Date().toISOString();
    stats.reconnectAttempts = 0;

    // Authenticate via first message (market.near.ai supports this)
    ws!.send(JSON.stringify({ type: 'auth', token: config.market.apiKey }));

    // Heartbeat every 30s
    clearPing();
    pingInterval = setInterval(() => {
      if (ws?.readyState === WebSocket.OPEN) {
        ws.ping();
      }
    }, 30_000);
  });

  ws.on('pong', () => {
    // Connection alive — no action needed
  });

  ws.on('message', (data: WebSocket.RawData) => {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(data.toString()) as Record<string, unknown>;
    } catch {
      console.warn('[background] Received non-JSON message:', data.toString().slice(0, 100));
      return;
    }

    const eventType = parsed['type'] as string | undefined;
    if (!eventType) return;

    bumpEvent(eventType);

    const payload = (parsed['data'] ?? parsed) as Record<string, unknown>;

    switch (eventType) {
      case 'message_received':
        void handleMessageReceived(payload);
        break;
      case 'job_awarded':
        void handleJobAwarded(payload);
        break;
      case 'changes_requested':
        void handleChangesRequested(payload);
        break;
      case 'submission_received':
        handleSubmissionReceived(payload);
        break;
      case 'bid_received':
        handleBidReceived(payload);
        break;
      case 'auth_success':
        console.log('[background] Authenticated successfully');
        break;
      case 'auth_error':
        console.error('[background] Authentication failed:', parsed['message']);
        break;
      default:
        // Log unknown events at debug level
        console.log(`[background] Unhandled event: ${eventType}`);
    }
  });

  ws.on('error', (err: Error) => {
    console.error('[background] WebSocket error:', err.message);
  });

  ws.on('close', (code: number, reason: Buffer) => {
    console.log(`[background] WebSocket closed: ${code} ${reason.toString()}`);
    clearPing();
    stats.connectedAt = null;
    if (!shuttingDown) {
      scheduleReconnect(attempt);
    }
  });
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function startBackground(): void {
  if (stats.enabled) return;
  console.log('[background] Starting background worker...');
  shuttingDown = false;
  stats.enabled = true;
  connect(0);
}

export function stopBackground(): void {
  if (!stats.enabled) return;
  console.log('[background] Stopping background worker...');
  shuttingDown = true;
  stats.enabled = false;

  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  clearPing();

  if (ws) {
    ws.close(1000, 'Stopped by user');
    ws = null;
  }

  stats.connectedAt = null;
  logActivity({ event: 'system', detail: 'background mode disabled by user', action: 'stopped', success: true });
}
