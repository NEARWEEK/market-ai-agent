/**
 * Phase 4 checkpoint — end-to-end orchestrator test.
 * Run with: npx ts-node scripts/test-orchestrator.ts
 */

import * as dotenv from 'dotenv';
dotenv.config();

import { initSkillLoader, stopSkillLoader } from '../src/skill-loader';
import { runAgentLoop } from '../src/agent/orchestrator';
import { config } from '../src/config';

const PROMPT = "Show me open jobs tagged 'rust'";

async function main() {
  console.log('Phase 4 — Orchestrator checkpoint');
  console.log(`Provider : ${config.llm.provider}`);
  console.log(`Model    : ${config.llm.model}`);
  console.log(`Prompt   : "${PROMPT}"\n`);

  console.log('Initialising skill loader...');
  await initSkillLoader();
  stopSkillLoader();

  console.log('Running agent loop...\n');
  console.log('─'.repeat(60));

  const result = await runAgentLoop(PROMPT);

  console.log('\nFinal response:');
  console.log('─'.repeat(60));
  console.log(result.response);
  console.log('─'.repeat(60));
  console.log(`\nTool calls made : ${result.toolCallCount}`);
  console.log(`History length  : ${result.updatedHistory.length} messages`);
}

main().catch(err => {
  console.error('Fatal:', (err as Error).message);
  process.exit(1);
});
