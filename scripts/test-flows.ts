/**
 * Phase 7 checkpoint — multi-turn flow tests.
 *
 * Simulates Requester and Worker scenarios using real LLM + real API calls.
 * Run with: npx ts-node scripts/test-flows.ts
 *
 * Edge cases encountered are printed at the end.
 */

import * as dotenv from 'dotenv';
dotenv.config();

import { initSkillLoader, stopSkillLoader } from '../src/skill-loader';
import { runAgentLoop } from '../src/agent/orchestrator';
import { Message } from '../src/llm/adapter';

const edgeCases: string[] = [];

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function turn(
  label: string,
  prompt: string,
  history: Message[],
): Promise<{ response: string; history: Message[] }> {
  console.log(`\n  [${label}] User: "${prompt}"`);
  const result = await runAgentLoop(prompt, history);
  const preview = result.response.slice(0, 300).replace(/\n+/g, ' ');
  console.log(`  [${label}] Agent (${result.toolCallCount} tool calls): ${preview}${result.response.length > 300 ? '...' : ''}`);
  return { response: result.response, history: result.updatedHistory };
}

function section(title: string) {
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  ${title}`);
  console.log('═'.repeat(60));
}

// ─── Scenario 1: Requester flow ───────────────────────────────────────────────

async function requesterFlow() {
  section('SCENARIO 1 — Requester flow');
  let history: Message[] = [];

  // Step 1: Ask agent to create a job (missing fields — should ask for details)
  let r = await turn('REQ-1', 'I want to post a new job', history);
  history = r.history;

  if (!r.response.match(/title|description|budget|what|tell me/i)) {
    edgeCases.push('REQ-1: Agent did not ask for job details before posting');
  }

  // Step 2: Provide full job details
  r = await turn(
    'REQ-2',
    'Title: "Test automation for a NEAR smart contract". ' +
    'Description: "Write a comprehensive test suite for a NEAR smart contract using near-workspaces-js. ' +
    'Cover all public methods, edge cases, and error paths. Deliverable: GitHub PR with tests passing." ' +
    'Budget: 3 NEAR. Tags: testing, rust, near.',
    history,
  );
  history = r.history;

  // Agent should show summary and ask for confirmation, not call create_job yet
  if (r.response.match(/created|job_id|successfully posted/i) && !r.response.match(/confirm|sure|proceed/i)) {
    edgeCases.push('REQ-2: Agent created job without asking for confirmation first');
  }

  // Step 3: Confirm
  r = await turn('REQ-3', 'Yes, go ahead and post it', history);
  history = r.history;

  // Step 4: Check balance reminder
  if (!r.response.match(/balance|NEAR|wallet|fund/i)) {
    edgeCases.push('REQ-3: Agent did not remind about wallet balance after job creation');
  }

  // Step 5: Browse bids
  r = await turn('REQ-4', 'Show me the bids on my most recent job', history);
  history = r.history;

  // Step 6: Read messages
  r = await turn('REQ-5', 'What is my current wallet balance?', history);
  history = r.history;

  if (!r.response.match(/NEAR|balance|\d/)) {
    edgeCases.push('REQ-5: Balance response did not contain numeric value');
  }

  console.log('\n  ✓ Requester flow complete');
}

// ─── Scenario 2: Worker flow ──────────────────────────────────────────────────

async function workerFlow() {
  section('SCENARIO 2 — Worker flow');
  let history: Message[] = [];

  // Step 1: Find a rust job
  let r = await turn('WRK-1', "Find me open jobs tagged 'rust'", history);
  history = r.history;

  if (!r.response.match(/job|NEAR|\•|-/i)) {
    edgeCases.push('WRK-1: No job listings found or formatted in response');
  }

  // Step 2: Ask to place a bid (no details — agent should ask for proposal)
  r = await turn('WRK-2', 'I want to bid on the first job you found', history);
  history = r.history;

  if (!r.response.match(/proposal|amount|approach|how much|eta|experience/i)) {
    edgeCases.push('WRK-2: Agent did not ask for bid details before placing bid');
  }

  // Step 3: Provide bid details
  r = await turn(
    'WRK-3',
    'My bid: 8 NEAR. Proposal: "I have 3 years of Rust and NEAR smart contract experience. ' +
    'I will perform a thorough security audit covering reentrancy, integer overflow, access control, ' +
    'and storage vulnerabilities. Deliverable: detailed Markdown report with severity ratings." ' +
    'ETA: 3 days.',
    history,
  );
  history = r.history;

  // Agent should confirm before placing bid
  if (r.response.match(/bid placed|bid_id|successfully bid/i) && !r.response.match(/confirm|proceed|sure/i)) {
    edgeCases.push('WRK-3: Agent placed bid without asking for confirmation first');
  }

  // Step 4: Check bid status
  r = await turn('WRK-4', 'Show me my current bids', history);
  history = r.history;

  // Step 5: Send a message
  r = await turn(
    'WRK-5',
    'What jobs do I have in progress right now?',
    history,
  );
  history = r.history;

  console.log('\n  ✓ Worker flow complete');
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('Phase 7 — Role-aware flow tests\n');

  console.log('Initialising skill loader...');
  await initSkillLoader();
  stopSkillLoader();

  await requesterFlow();
  await workerFlow();

  section('EDGE CASES ENCOUNTERED');
  if (edgeCases.length === 0) {
    console.log('  None — all behavioral checks passed.\n');
  } else {
    for (const ec of edgeCases) {
      console.log(`  ⚠  ${ec}`);
    }
    console.log();
  }
}

main().catch(err => {
  console.error('Fatal:', (err as Error).message);
  process.exit(1);
});
