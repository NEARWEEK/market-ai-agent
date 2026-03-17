/**
 * Debug logger — emits structured JSON logs when DEBUG=true.
 *
 * API keys and Authorization headers are always redacted even in debug mode.
 */

import { config } from './config';

const SECRET_PATTERN = /\b(sk-[A-Za-z0-9_-]+|sk_live_[A-Za-z0-9_-]+|sk_ant-[A-Za-z0-9_-]+)/g;

/** Recursively redact secret-looking strings in an arbitrary value. */
function redact(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.replace(SECRET_PATTERN, '[REDACTED]');
  }
  if (Array.isArray(value)) {
    return value.map(redact);
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      // Always redact authorization / api-key headers by key name
      if (/^(authorization|x-api-key|api[-_]?key)$/i.test(k)) {
        out[k] = '[REDACTED]';
      } else {
        out[k] = redact(v);
      }
    }
    return out;
  }
  return value;
}

/**
 * Emit a debug log line. No-op when DEBUG is not enabled.
 *
 * @param tag    Short label identifying the subsystem (e.g. "anthropic", "market-api")
 * @param event  One-word action label (e.g. "request", "response")
 * @param data   Arbitrary payload — secrets are automatically redacted
 */
export function debugLog(tag: string, event: string, data: unknown): void {
  if (!config.debug) return;
  const ts = new Date().toISOString();
  const safe = redact(data);
  // Use process.stdout.write to avoid interleaving with console.log buffering
  process.stdout.write(
    `[DEBUG ${ts}] [${tag}] ${event}\n${JSON.stringify(safe, null, 2)}\n`,
  );
}
