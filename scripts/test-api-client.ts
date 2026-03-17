/**
 * Phase 3 checkpoint script — verifies live API connectivity.
 * Run with: npx ts-node scripts/test-api-client.ts
 */

import * as dotenv from 'dotenv';
dotenv.config();

import { marketAPI, MarketAPIError } from '../src/tools/executor';

async function section(title: string, fn: () => Promise<void>) {
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`  ${title}`);
  console.log('─'.repeat(60));
  try {
    await fn();
  } catch (err) {
    if (err instanceof MarketAPIError) {
      console.error(`  API error ${err.status}: ${err.message}`);
      console.error('  Body:', JSON.stringify(err.body, null, 2));
    } else {
      console.error('  Unexpected error:', (err as Error).message);
    }
  }
}

async function main() {
  console.log('market.near.ai API client — Phase 3 checkpoint\n');

  await section('GET /v1/agents/me — My profile', async () => {
    const profile = await marketAPI.getMyProfile() as Record<string, unknown>;
    console.log(`  agent_id : ${profile['agent_id']}`);
    console.log(`  handle   : ${profile['handle'] ?? '(none)'}`);
    console.log(`  near_acc : ${profile['near_account_id']}`);
    console.log(`  rep score: ${profile['reputation_score'] ?? 'N/A'}`);
  });

  await section('GET /v1/wallet/balance — Wallet balance', async () => {
    const balance = await marketAPI.getBalance() as Record<string, unknown>;
    console.log(`  balance   : ${balance['balance']} ${balance['token'] ?? 'NEAR'}`);
    console.log(`  account   : ${balance['account_id']}`);
    const balances = balance['balances'] as Array<Record<string, unknown>> | undefined;
    if (balances?.length) {
      for (const b of balances) {
        console.log(`  ${b['symbol']}: ${b['balance']}`);
      }
    }
  });

  await section('GET /v1/jobs?status=open&limit=3 — Open jobs', async () => {
    const result = await marketAPI.listJobs({ status: 'open', limit: 3 });
    // Handle both bare array and cursor-paginated envelope
    const jobs = Array.isArray(result)
      ? result
      : (result as Record<string, unknown>)['data'] as unknown[];

    if (!jobs || jobs.length === 0) {
      console.log('  No open jobs found.');
      return;
    }
    console.log(`  Found ${jobs.length} job(s):`);
    for (const job of jobs as Record<string, unknown>[]) {
      console.log(`  • [${job['job_id']}] ${job['title']} — ${job['budget_amount']} NEAR`);
    }
  });

  await section('GET /v1/agents/me/bids — My bids', async () => {
    const result = await marketAPI.myBids({ limit: 50 });
    const bids = Array.isArray(result)
      ? result
      : (result as Record<string, unknown>)['data'] as unknown[];

    const count = bids?.length ?? 0;
    console.log(`  Total bids returned: ${count}`);

    if (count > 0) {
      const bid = (bids as Record<string, unknown>[])[0]!;
      console.log(`  Latest bid — id: ${bid['bid_id']}, status: ${bid['status']}`);
    }
  });

  console.log(`\n${'─'.repeat(60)}`);
  console.log('  All checks complete.');
  console.log('─'.repeat(60) + '\n');
}

main().catch(err => {
  console.error('Fatal:', (err as Error).message);
  process.exit(1);
});
