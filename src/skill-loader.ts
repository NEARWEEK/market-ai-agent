import { createHash } from 'crypto';
import { config } from './config';
import { buildRegistry, EndpointDef, ToolDefinition, toAnthropicTool, toOpenAITool } from './tools/registry';

const SKILL_URL = 'https://market.near.ai/skill.md';

// ─── Internal state ───────────────────────────────────────────────────────────

let _skillContent = '';
let _tools: ToolDefinition[] = [];
let _lastRefreshed: Date | null = null;
let _skillVersion = '';        // SHA-256 content hash (12 hex chars)
let _skillLastUpdated: Date | null = null; // timestamp of last content change
let _lastError: string | null = null;
let _refreshTimer: ReturnType<typeof setInterval> | null = null;

// ─── Hashing ──────────────────────────────────────────────────────────────────

function contentHash(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 12);
}

// ─── Parser ───────────────────────────────────────────────────────────────────

/**
 * Extract the Quick Reference table rows from skill.md.
 */
function parseQuickReference(markdown: string): EndpointDef[] {
  const endpoints: EndpointDef[] = [];
  let inTable = false;

  for (const line of markdown.split('\n')) {
    const trimmed = line.trim();

    if (/^\|\s*Action\s*\|\s*Method\s*\|\s*Endpoint\s*\|/i.test(trimmed)) {
      inTable = true;
      continue;
    }

    if (!inTable) continue;
    if (/^\|[-| ]+\|$/.test(trimmed)) continue;

    if (trimmed === '' || !trimmed.startsWith('|')) {
      inTable = false;
      continue;
    }

    const cells = trimmed.split('|').map(c => c.trim()).filter(c => c.length > 0);
    if (cells.length < 3) continue;

    const [action, method, rawPath] = cells as [string, string, string];
    const path = rawPath.replace(/`/g, '').trim().split('?')[0] ?? '';

    if (path.includes('ws') && method === 'GET' && path.endsWith('/ws')) continue;

    const upperMethod = method.toUpperCase();
    if (!['GET', 'POST', 'PATCH', 'PUT', 'DELETE'].includes(upperMethod)) continue;

    endpoints.push({ action, method: upperMethod, path });
  }

  return endpoints;
}

// ─── Fetch & refresh ──────────────────────────────────────────────────────────

async function fetchAndParse(): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000); // 10s timeout

  let response: Response;
  try {
    response = await fetch(SKILL_URL, { signal: controller.signal });
  } catch (err) {
    clearTimeout(timeout);
    if ((err as Error).name === 'AbortError') {
      throw new Error('skill.md fetch timed out after 10s');
    }
    throw new Error(`skill.md network error: ${(err as Error).message}`);
  }
  clearTimeout(timeout);

  if (!response.ok) {
    throw new Error(`Failed to fetch skill.md: HTTP ${response.status}`);
  }

  const markdown = await response.text();
  const newHash = contentHash(markdown);
  _lastRefreshed = new Date();

  // Content unchanged — update refresh timestamp only, no need to rebuild registry
  if (newHash === _skillVersion && _tools.length > 0) {
    console.log(`[skill-loader] No change (version: ${_skillVersion}) at ${_lastRefreshed.toISOString()}`);
    _lastError = null;
    return;
  }

  const endpoints = parseQuickReference(markdown);
  const newTools = buildRegistry(endpoints);

  // Compute diff vs. previous tool set
  if (_skillVersion) {
    const prevNames = new Set(_tools.map(t => t.name));
    const newNames = new Set(newTools.map(t => t.name));
    const added = newTools.filter(t => !prevNames.has(t.name));
    const removed = [...prevNames].filter(n => !newNames.has(n));

    if (added.length > 0 || removed.length > 0) {
      console.log(
        `[skill-loader] Skill updated: +${added.length} tool(s) added, ${removed.length} removed`,
      );
      for (const t of added) console.log(`  + ${t.name} (${t.method} ${t.path})`);
      for (const n of removed) console.log(`  - ${n}`);
    }
  }

  // Atomically swap state
  _skillContent = markdown;
  _tools = newTools;
  _skillVersion = newHash;
  _skillLastUpdated = _lastRefreshed;
  _lastError = null;

  const versionMatch = markdown.match(/version:\s*(\S+)/);
  const apiVersion = versionMatch ? versionMatch[1] : 'unknown';

  console.log(
    `[skill-loader] Refreshed — api-version: ${apiVersion}, hash: ${_skillVersion}, ` +
    `endpoints: ${endpoints.length}, at: ${_lastRefreshed.toISOString()}`,
  );
}

/** Fetch with graceful fallback — keeps last successful state on error. */
async function safeRefresh(): Promise<void> {
  try {
    await fetchAndParse();
  } catch (err) {
    _lastError = (err as Error).message;
    console.error('[skill-loader] Refresh failed (keeping last successful tool set):', _lastError);
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function getTools(): ToolDefinition[] {
  return _tools;
}

export function getSkillContent(): string {
  return _skillContent;
}

export function getSkillSummary(): string {
  if (!_skillContent) return '';

  const lines = _skillContent.split('\n');
  const kept: string[] = [];
  let capture = false;
  let skipLong = false;

  for (const line of lines) {
    if (line.startsWith('# Agent Market Skill') || line.startsWith('```yaml')) {
      capture = true;
    }

    if (line.startsWith('## 🔒') || line.startsWith('## Getting Started') ||
        line.startsWith('## For Requesters') || line.startsWith('## For Workers') ||
        line.startsWith('## Payment Channels') || line.startsWith('## Delegation') ||
        line.startsWith('## Best Practices') || line.startsWith('## Support')) {
      skipLong = true;
    }

    if (line.startsWith('## Job Lifecycle')) {
      skipLong = false;
      capture = true;
    }

    if (line.startsWith('### Minimum Balance') || line.startsWith('### Job Expiration') ||
        line.startsWith('### Auto-Dispute') || line.startsWith('### Overdue') ||
        line.startsWith('### Job Visibility') || line.startsWith('### Bid Visibility') ||
        line.startsWith('### Competition Lifecycle')) {
      capture = false;
    }

    if (capture && !skipLong) {
      kept.push(line);
    }
  }

  return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

export function getAnthropicTools(): ReturnType<typeof toAnthropicTool>[] {
  return _tools.map(toAnthropicTool);
}

export function getOpenAITools(): ReturnType<typeof toOpenAITool>[] {
  return _tools.map(toOpenAITool);
}

export function getLastRefreshed(): Date | null {
  return _lastRefreshed;
}

export function getSkillVersion(): string {
  return _skillVersion;
}

export function getSkillLastUpdated(): Date | null {
  return _skillLastUpdated;
}

export function getSkillError(): string | null {
  return _lastError;
}

/**
 * Manually trigger a refresh outside the normal interval.
 * Returns a summary of what changed.
 */
export async function manualRefresh(): Promise<{
  version: string;
  toolCount: number;
  changed: boolean;
  error: string | null;
}> {
  const prevVersion = _skillVersion;
  try {
    await fetchAndParse();
    return {
      version: _skillVersion,
      toolCount: _tools.length,
      changed: _skillVersion !== prevVersion,
      error: null,
    };
  } catch (err) {
    _lastError = (err as Error).message;
    return {
      version: _skillVersion,
      toolCount: _tools.length,
      changed: false,
      error: _lastError,
    };
  }
}

/**
 * Fetch skill.md, build the tool registry, and start the background refresh loop.
 * Must be called once at startup before any tool access.
 */
export async function initSkillLoader(): Promise<void> {
  await fetchAndParse();

  if (_refreshTimer) clearInterval(_refreshTimer);
  _refreshTimer = setInterval(safeRefresh, config.agent.skillRefreshIntervalMs);
}

export function stopSkillLoader(): void {
  if (_refreshTimer) {
    clearInterval(_refreshTimer);
    _refreshTimer = null;
  }
}
