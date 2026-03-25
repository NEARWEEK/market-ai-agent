/**
 * Tool registry: converts parsed EndpointDef[] into provider-agnostic ToolDefinition[].
 * Also exports adapters to Anthropic and OpenAI tool-calling formats.
 */

export interface EndpointDef {
  action: string;
  method: string;
  path: string;
}

export interface ToolProperty {
  type: 'string' | 'number' | 'boolean' | 'object' | 'array';
  description: string;
  enum?: string[];
  items?: { type: string };
}

export interface ToolInputSchema {
  type: 'object';
  properties: Record<string, ToolProperty>;
  required: string[];
}

export interface ToolDefinition {
  name: string;
  description: string;
  method: string;
  path: string;
  inputSchema: ToolInputSchema;
}

// ─── Anthropic format ────────────────────────────────────────────────────────

export interface AnthropicTool {
  name: string;
  description: string;
  input_schema: ToolInputSchema;
}

export function toAnthropicTool(tool: ToolDefinition): AnthropicTool {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema,
  };
}

// ─── OpenAI format ───────────────────────────────────────────────────────────

export interface OpenAITool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: ToolInputSchema;
  };
}

export function toOpenAITool(tool: ToolDefinition): OpenAITool {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  };
}

// ─── Name helpers ────────────────────────────────────────────────────────────

function actionToName(action: string): string {
  return action
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');
}

/** Extract `{param}` placeholders from a path. */
function pathParams(path: string): string[] {
  return [...path.matchAll(/\{([^}]+)\}/g)].map(m => m[1] as string);
}

// ─── Enhanced schemas for core operations ────────────────────────────────────
// Keyed by the action string from the Quick Reference table (lowercase).

const SCHEMAS: Record<string, Partial<ToolInputSchema>> = {
  'list jobs': {
    properties: {
      status: {
        type: 'string',
        description: 'Filter by job status',
        enum: ['open', 'filling', 'in_progress', 'completed', 'expired', 'closed', 'judging'],
      },
      job_type: {
        type: 'string',
        description: 'Filter by job type',
        enum: ['standard', 'competition', 'instant'],
      },
      tags: { type: 'string', description: 'Comma-separated tags to filter by' },
      sort_by: {
        type: 'string',
        description: 'Sort field',
        enum: ['created_at', 'budget_amount', 'deadline_at'],
      },
      limit: { type: 'number', description: 'Number of results (default 20, max 100)' },
      offset: { type: 'number', description: 'Offset for pagination' },
      cursor: { type: 'string', description: 'Cursor for keyset pagination' },
    },
  },
  'create job': {
    properties: {
      title: { type: 'string', description: 'Short job title' },
      description: { type: 'string', description: 'Full job description and requirements' },
      budget_amount: { type: 'string', description: 'Budget in NEAR (e.g. "5.0")' },
      budget_token: { type: 'string', description: 'Token for payment, default "NEAR"' },
      deadline_seconds: {
        type: 'number',
        description: 'Time until expiry in seconds (3600–604800, default 86400)',
      },
      tags: {
        type: 'array',
        description: 'Specialisation tags (max 10)',
        items: { type: 'string' },
      },
      job_type: {
        type: 'string',
        description: 'Job type',
        enum: ['standard', 'competition'],
      },
      max_workers: { type: 'number', description: 'Maximum number of workers for multi-slot jobs' },
    },
    required: ['title', 'description', 'budget_amount'],
  },
  'create instant job': {
    properties: {
      title: { type: 'string', description: 'Short job title' },
      description: { type: 'string', description: 'Full job description' },
      budget_amount: { type: 'string', description: 'Budget in NEAR' },
      tags: {
        type: 'array',
        description: 'Tags used to auto-match a worker',
        items: { type: 'string' },
      },
    },
    required: ['title', 'description', 'budget_amount'],
  },
  'update job': {
    properties: {
      title: { type: 'string', description: 'Updated title' },
      description: { type: 'string', description: 'Updated description' },
      budget_amount: { type: 'string', description: 'Updated budget' },
      tags: {
        type: 'array',
        description: 'Updated tags',
        items: { type: 'string' },
      },
    },
  },
  'award job': {
    properties: {
      bid_id: { type: 'string', description: 'ID of the bid to award' },
    },
    required: ['bid_id'],
  },
  'place bid': {
    properties: {
      amount: { type: 'string', description: 'Bid amount in NEAR' },
      proposal: { type: 'string', description: 'Your proposal explaining your approach' },
      eta_seconds: { type: 'number', description: 'Estimated time to complete in seconds' },
    },
    required: ['amount', 'proposal'],
  },
  'submit work': {
    properties: {
      deliverable: {
        type: 'string',
        description: 'URL or text of the deliverable',
      },
      deliverable_hash: {
        type: 'string',
        description: 'Optional SHA-256 hash for integrity (e.g. "sha256:abc123")',
      },
    },
    required: ['deliverable'],
  },
  'accept work': {
    properties: {
      assignment_id: { type: 'string', description: 'Assignment ID to accept' },
    },
  },
  'open dispute': {
    properties: {
      reason: { type: 'string', description: 'Reason for opening the dispute' },
    },
    required: ['reason'],
  },
  'request changes': {
    properties: {
      feedback: { type: 'string', description: 'Feedback explaining what changes are needed' },
    },
    required: ['feedback'],
  },
  'request changes (assignment)': {
    properties: {
      feedback: { type: 'string', description: 'Feedback explaining what changes are needed' },
    },
    required: ['feedback'],
  },
  'send message (private)': {
    properties: {
      body: { type: 'string', description: 'Message text' },
    },
    required: ['body'],
  },
  'send public message (creator only)': {
    properties: {
      body: { type: 'string', description: 'Public message text visible to all' },
    },
    required: ['body'],
  },
  'read messages (private)': {
    properties: {
      limit: { type: 'number', description: 'Number of messages (default 50)' },
      before: { type: 'string', description: 'Cursor: fetch messages before this message_id' },
    },
  },
  'read public messages': {
    properties: {
      limit: { type: 'number', description: 'Number of messages (default 50)' },
      before: { type: 'string', description: 'Cursor: fetch messages before this message_id' },
    },
  },
  'toggle reaction': {
    properties: {
      emoji: { type: 'string', description: 'Emoji to toggle (e.g. "👍")' },
    },
    required: ['emoji'],
  },
  withdraw: {
    properties: {
      amount: { type: 'string', description: 'Amount to withdraw (e.g. "1.5")' },
      to_account_id: { type: 'string', description: 'Destination NEAR account ID (e.g. "alice.near")' },
      token_id: { type: 'string', description: 'Token to withdraw (e.g. "NEAR")' },
      idempotency_key: { type: 'string', description: 'Optional unique key to prevent duplicate withdrawals (e.g. "withdraw-job-{job_id}-001")' },
    },
    required: ['amount', 'to_account_id', 'token_id'],
  },
  'cross-chain deposit': {
    properties: {
      chain: { type: 'string', description: 'Source chain (e.g. "ethereum", "base")' },
      tx_hash: { type: 'string', description: 'Transaction hash of the deposit' },
    },
    required: ['chain', 'tx_hash'],
  },
  'add evidence': {
    properties: {
      content: { type: 'string', description: 'Evidence description or URL' },
    },
    required: ['content'],
  },
  'resolve dispute': {
    properties: {
      ruling: {
        type: 'string',
        description: 'Ruling decision',
        enum: ['worker', 'requester', 'split'],
      },
      reason: { type: 'string', description: 'Explanation of the ruling' },
    },
    required: ['ruling'],
  },
  'submit competition entry': {
    properties: {
      deliverable: { type: 'string', description: 'URL or text of the competition entry' },
      deliverable_hash: { type: 'string', description: 'Optional SHA-256 hash' },
    },
    required: ['deliverable'],
  },
  'resolve competition': {
    properties: {
      results: {
        type: 'array',
        description: 'Array of {entry_id, bps} objects (bps = basis points, sum <= 10000)',
        items: { type: 'object' },
      },
    },
    required: ['results'],
  },
  'invoke service': {
    properties: {
      input: { type: 'object', description: 'Input payload for the service' },
      channel_id: {
        type: 'string',
        description: 'Payment channel ID for high-frequency calls (optional)',
      },
    },
    required: ['input'],
  },
  'open channel': {
    properties: {
      service_id: { type: 'string', description: 'Service UUID to open a channel for' },
      deposit_amount: { type: 'string', description: 'Amount to deposit (e.g. "50.0")' },
      max_settlement_interval: {
        type: 'number',
        description: 'Max calls before settlement (default 100)',
      },
    },
    required: ['service_id', 'deposit_amount'],
  },
  'top up channel': {
    properties: {
      amount: { type: 'string', description: 'Additional amount to deposit' },
    },
    required: ['amount'],
  },
  'list agents': {
    properties: {
      tag: { type: 'string', description: 'Filter by specialisation tag' },
      sort_by: {
        type: 'string',
        description: 'Sort field',
        enum: ['earned', 'reputation', 'created_at'],
      },
      limit: { type: 'number', description: 'Number of results (default 20, max 100)' },
      cursor: { type: 'string', description: 'Cursor for keyset pagination' },
    },
  },
  register: {
    properties: {
      handle: {
        type: 'string',
        description: 'Custom username (3-20 chars, lowercase alphanumeric + underscore)',
      },
      capabilities: { type: 'object', description: 'JSON object describing agent skills' },
      tags: {
        type: 'array',
        description: 'Specialisation tags (max 10)',
        items: { type: 'string' },
      },
    },
  },
};

// ─── Registry builder ─────────────────────────────────────────────────────────

export function buildRegistry(endpoints: EndpointDef[]): ToolDefinition[] {
  return endpoints.map(ep => {
    const name = actionToName(ep.action);
    const params = pathParams(ep.path);
    const key = ep.action.toLowerCase();
    const override = SCHEMAS[key] ?? {};

    // Base path-param properties (always required)
    const pathProps: Record<string, ToolProperty> = {};
    for (const p of params) {
      pathProps[p] = {
        type: 'string',
        description: `Path parameter: ${p.replace(/_/g, ' ')}`,
      };
    }

    const mergedProps = { ...pathProps, ...(override.properties ?? {}) };
    const mergedRequired = [...params, ...(override.required ?? [])];
    // Deduplicate required
    const required = [...new Set(mergedRequired)];

    return {
      name,
      description: `${ep.method} ${ep.path} — ${ep.action}`,
      method: ep.method,
      path: ep.path,
      inputSchema: {
        type: 'object',
        properties: mergedProps,
        required,
      },
    };
  });
}
