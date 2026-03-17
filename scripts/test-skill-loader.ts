/**
 * Standalone test script for the skill loader.
 * Run with: npx ts-node scripts/test-skill-loader.ts
 */

import * as dotenv from 'dotenv';
dotenv.config();

// Minimal env for config to load without throwing
process.env['LLM_PROVIDER'] ??= 'anthropic';
process.env['LLM_MODEL'] ??= 'claude-sonnet-4-6';
process.env['ANTHROPIC_API_KEY'] ??= 'test';
process.env['MARKET_API_KEY'] ??= 'test';

import { initSkillLoader, getTools, getAnthropicTools, getOpenAITools, stopSkillLoader } from '../src/skill-loader';

async function main() {
  console.log('Fetching skill.md and building tool registry...\n');

  await initSkillLoader();
  stopSkillLoader(); // no background refresh needed for the test

  const tools = getTools();

  console.log(`Total tools parsed: ${tools.length}\n`);
  console.log('─'.repeat(60));

  // Print first 5 tool summaries
  const sample = tools.slice(0, 5);
  for (const tool of sample) {
    const reqCount = tool.inputSchema.required.length;
    const propCount = Object.keys(tool.inputSchema.properties).length;
    console.log(`Tool: ${tool.name}`);
    console.log(`  ${tool.method} ${tool.path}`);
    console.log(`  Properties: ${propCount}, Required: ${reqCount}`);
    if (reqCount > 0) {
      console.log(`  Required params: ${tool.inputSchema.required.join(', ')}`);
    }
    console.log();
  }

  console.log('─'.repeat(60));
  console.log('\nSample Anthropic tool schema (tool #3):');
  console.log(JSON.stringify(getAnthropicTools()[2], null, 2));

  console.log('\n─'.repeat(60));
  console.log('\nSample OpenAI tool schema (tool #4):');
  console.log(JSON.stringify(getOpenAITools()[3], null, 2));

  // Find a few interesting tools to show schemas
  const interesting = ['create_job', 'place_bid', 'submit_work'];
  for (const name of interesting) {
    const tool = tools.find(t => t.name === name);
    if (tool) {
      console.log('\n' + '─'.repeat(60));
      console.log(`\nDetailed schema for "${tool.name}":`);
      console.log(JSON.stringify(tool.inputSchema, null, 2));
    }
  }
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
