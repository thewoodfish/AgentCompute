/**
 * AgentCompute Demo Client
 *
 * Autonomous agent that discovers jobs, funds a Stellar keypair via friendbot,
 * and runs 3 jobs — paying with USDC over x402 on Stellar testnet.
 * No human input required after launch.
 */

import 'dotenv/config';
import * as StellarSdk from '@stellar/stellar-sdk';

const SERVER_URL = process.env.SERVER_URL || 'http://localhost:3000';
const HORIZON_URL = process.env.STELLAR_HORIZON_URL || 'https://horizon-testnet.stellar.org';
const FRIENDBOT_URL = 'https://friendbot.stellar.org';

// Testnet USDC issuer
const USDC_ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';

const horizon = new StellarSdk.Horizon.Server(HORIZON_URL);

// ── Helpers ───────────────────────────────────────────────────────────────────

async function fetchJSON<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, options);
  return res.json() as Promise<T>;
}

function encodePaymentProof(proof: object): string {
  return Buffer.from(JSON.stringify(proof)).toString('base64');
}

// ── Fund Account ──────────────────────────────────────────────────────────────

async function fundAccount(publicKey: string): Promise<void> {
  console.log(`\n[Agent] Funding account ${publicKey} via friendbot...`);
  await fetch(`${FRIENDBOT_URL}?addr=${publicKey}`);
  // Wait a moment for account to be created on ledger
  await new Promise((r) => setTimeout(r, 3000));
  console.log('[Agent] Account funded.');
}

// ── Establish USDC trustline ──────────────────────────────────────────────────

async function addUSDCTrustline(keypair: StellarSdk.Keypair): Promise<void> {
  console.log('[Agent] Adding USDC trustline...');
  const account = await horizon.loadAccount(keypair.publicKey());
  const usdcAsset = new StellarSdk.Asset('USDC', USDC_ISSUER);

  const tx = new StellarSdk.TransactionBuilder(account, {
    fee: StellarSdk.BASE_FEE,
    networkPassphrase: StellarSdk.Networks.TESTNET,
  })
    .addOperation(
      StellarSdk.Operation.changeTrust({
        asset: usdcAsset,
        limit: '1000',
      })
    )
    .setTimeout(30)
    .build();

  tx.sign(keypair);
  await horizon.submitTransaction(tx);
  console.log('[Agent] USDC trustline established.');
}

// ── Get USDC from testnet faucet ──────────────────────────────────────────────

async function getTestUSDC(keypair: StellarSdk.Keypair): Promise<void> {
  console.log('[Agent] Requesting testnet USDC from faucet...');

  // Use the testnet USDC issuer account to send test USDC
  // On Stellar testnet we can use the USDC test faucet at Stellar laboratory
  // or use the known testnet USDC issuer secret (publicly known for testnet)
  // For demo purposes, we use a known testnet USDC faucet keypair
  const TESTNET_USDC_DISTRIBUTOR_SECRET = process.env.TESTNET_USDC_DISTRIBUTOR_SECRET;

  if (!TESTNET_USDC_DISTRIBUTOR_SECRET) {
    console.log('[Agent] TESTNET_USDC_DISTRIBUTOR_SECRET not set.');
    console.log('[Agent] To get testnet USDC manually:');
    console.log(`  1. Go to https://stellar.expert/explorer/testnet`);
    console.log(`  2. Send USDC to: ${keypair.publicKey()}`);
    console.log('[Agent] Continuing with assumption that USDC is available...');
    return;
  }

  const distributorKeypair = StellarSdk.Keypair.fromSecret(TESTNET_USDC_DISTRIBUTOR_SECRET);
  const distributorAccount = await horizon.loadAccount(distributorKeypair.publicKey());
  const usdcAsset = new StellarSdk.Asset('USDC', USDC_ISSUER);

  const tx = new StellarSdk.TransactionBuilder(distributorAccount, {
    fee: StellarSdk.BASE_FEE,
    networkPassphrase: StellarSdk.Networks.TESTNET,
  })
    .addOperation(
      StellarSdk.Operation.payment({
        destination: keypair.publicKey(),
        asset: usdcAsset,
        amount: '10',
      })
    )
    .setTimeout(30)
    .build();

  tx.sign(distributorKeypair);
  await horizon.submitTransaction(tx);
  console.log('[Agent] Received 10 testnet USDC.');
}

// ── Submit Stellar USDC Payment ───────────────────────────────────────────────

async function submitUSDCPayment(
  keypair: StellarSdk.Keypair,
  destination: string,
  amount: string,
  memo: string
): Promise<string> {
  const account = await horizon.loadAccount(keypair.publicKey());
  const usdcAsset = new StellarSdk.Asset('USDC', USDC_ISSUER);

  const tx = new StellarSdk.TransactionBuilder(account, {
    fee: StellarSdk.BASE_FEE,
    networkPassphrase: StellarSdk.Networks.TESTNET,
  })
    .addOperation(
      StellarSdk.Operation.payment({
        destination,
        asset: usdcAsset,
        amount,
      })
    )
    .addMemo(StellarSdk.Memo.text(memo))
    .setTimeout(30)
    .build();

  tx.sign(keypair);
  const result = await horizon.submitTransaction(tx);
  return result.hash;
}

// ── Run a Single Job ──────────────────────────────────────────────────────────

interface ServerDiscovery {
  jobs: Array<{ name: string; price: string; description: string }>;
  payment: { network: string; asset: string; destination: string };
}

interface JobPayment {
  x402Version: number;
  accepts: Array<{
    maxAmountRequired: string;
    payTo: string;
    extra: { memo: string };
  }>;
}

async function runJob(
  jobName: string,
  payload: Record<string, unknown>,
  keypair: StellarSdk.Keypair,
  serverDestination: string
): Promise<{ result: unknown; duration_ms: number; tx_hash: string }> {
  console.log(`\n[Agent] ── Job: ${jobName} ──`);
  const start = Date.now();

  // Step 1: POST without payment → expect 402
  const firstRes = await fetch(`${SERVER_URL}/run-job`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ job: jobName, payload }),
  });

  if (firstRes.status !== 402) {
    throw new Error(`Expected 402, got ${firstRes.status}`);
  }

  const paymentRequired = (await firstRes.json()) as JobPayment;
  const accept = paymentRequired.accepts[0];
  const { maxAmountRequired, payTo, extra } = accept;
  const jobId = extra.memo;

  console.log(`[Agent]   Payment required: ${maxAmountRequired} USDC → ${payTo.slice(0, 8)}...`);
  console.log(`[Agent]   Job ID (memo): ${jobId}`);

  // Step 2: Submit Stellar USDC payment
  console.log(`[Agent]   Submitting payment...`);
  const txHash = await submitUSDCPayment(keypair, serverDestination, maxAmountRequired, jobId);
  console.log(`[Agent]   Payment submitted: tx=${txHash.slice(0, 16)}...`);

  // Brief wait for Horizon indexing
  await new Promise((r) => setTimeout(r, 2000));

  // Step 3: Retry with X-Payment header
  const proof = { txHash, amount: maxAmountRequired, asset: 'USDC', network: 'stellar-testnet', memo: jobId };
  const paymentHeader = encodePaymentProof(proof);

  const secondRes = await fetch(`${SERVER_URL}/run-job`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Payment': paymentHeader,
    },
    body: JSON.stringify({ job: jobName, payload }),
  });

  const jobResult = await secondRes.json() as { success: boolean; result: unknown; duration_ms: number; tx_hash: string; error?: string; reason?: string };

  if (!jobResult.success) {
    throw new Error(`Job failed: ${jobResult.error || jobResult.reason}`);
  }

  const elapsed = Date.now() - start;
  console.log(`[Agent]   Result received in ${elapsed}ms`);
  console.log(`[Agent]   Result:`, JSON.stringify(jobResult.result, null, 2));

  return {
    result: jobResult.result,
    duration_ms: elapsed,
    tx_hash: txHash,
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('╔══════════════════════════════════════╗');
  console.log('║   AgentCompute Demo Agent            ║');
  console.log('╚══════════════════════════════════════╝');

  // Step 1: Discover
  console.log(`\n[Agent] Discovering jobs at ${SERVER_URL}/api...`);
  const discovery = await fetchJSON<ServerDiscovery>(`${SERVER_URL}/api`);
  console.log(`[Agent] Found ${discovery.jobs.length} jobs:`);
  for (const j of discovery.jobs) {
    console.log(`  • ${j.name.padEnd(14)} $${j.price} USDC — ${j.description}`);
  }

  const serverDestination = discovery.payment.destination;
  console.log(`[Agent] Server payment destination: ${serverDestination}`);

  // Step 2: Generate and fund a fresh keypair
  console.log('\n[Agent] Generating fresh Stellar keypair...');
  const keypair = StellarSdk.Keypair.random();
  console.log(`[Agent] Public key:  ${keypair.publicKey()}`);
  console.log(`[Agent] Secret key:  ${keypair.secret()}`);

  await fundAccount(keypair.publicKey());
  await addUSDCTrustline(keypair);
  await getTestUSDC(keypair);

  // Step 3: Run 3 jobs
  const totalStart = Date.now();
  const jobSummary: Array<{ job: string; amount: string; duration_ms: number; tx_hash: string }> = [];

  // Job 1: summarize
  const job1Price = discovery.jobs.find((j) => j.name === 'summarize')?.price || '0.05';
  const j1 = await runJob(
    'summarize',
    {
      text: `Artificial intelligence (AI) is intelligence demonstrated by machines, as opposed to the natural
intelligence displayed by animals including humans. AI research has been defined as the field of study
of intelligent agents, which refers to any system that perceives its environment and takes actions that
maximize its chance of achieving its goals. The term "artificial intelligence" had previously been used
to describe machines that mimic and display "human" cognitive skills associated with the human mind,
such as "learning" and "problem-solving". This definition has since been rejected by major AI researchers
who now describe AI in terms of rationality and acting rationally, which does not limit how intelligence
can be articulated.`,
    },
    keypair,
    serverDestination
  );
  jobSummary.push({ job: 'summarize', amount: job1Price, duration_ms: j1.duration_ms, tx_hash: j1.tx_hash });

  // Job 2: classify
  const job2Price = discovery.jobs.find((j) => j.name === 'classify')?.price || '0.03';
  const j2 = await runJob(
    'classify',
    {
      text: 'I absolutely love this product! It exceeded all my expectations and I would highly recommend it.',
      labels: ['positive', 'negative', 'neutral'],
    },
    keypair,
    serverDestination
  );
  jobSummary.push({ job: 'classify', amount: job2Price, duration_ms: j2.duration_ms, tx_hash: j2.tx_hash });

  // Job 3: run-code (long job, triggers MPP)
  const job3Price = discovery.jobs.find((j) => j.name === 'run-code')?.price || '0.10';
  const j3 = await runJob(
    'run-code',
    {
      language: 'javascript',
      code: `
const fib = (n) => n <= 1 ? n : fib(n-1) + fib(n-2);
const results = [];
for (let i = 0; i <= 10; i++) {
  results.push(fib(i));
}
console.log('Fibonacci sequence:', results.join(', '));
console.log('Sum:', results.reduce((a, b) => a + b, 0));
      `.trim(),
    },
    keypair,
    serverDestination
  );
  jobSummary.push({ job: 'run-code', amount: job3Price, duration_ms: j3.duration_ms, tx_hash: j3.tx_hash });

  // Final summary
  const totalTime = Date.now() - totalStart;
  const totalSpent = jobSummary.reduce((acc, j) => acc + parseFloat(j.amount), 0).toFixed(2);

  console.log('\n╔══════════════════════════════════════╗');
  console.log('║   Final Summary                      ║');
  console.log('╚══════════════════════════════════════╝');
  console.log(`  Jobs completed : ${jobSummary.length}`);
  console.log(`  Total spent    : $${totalSpent} USDC`);
  console.log(`  Total time     : ${totalTime}ms`);
  console.log('\n  Job details:');
  for (const j of jobSummary) {
    console.log(`  • ${j.job.padEnd(14)} $${j.amount} USDC  ${j.duration_ms}ms  tx=${j.tx_hash.slice(0, 12)}...`);
  }
}

main().catch((err) => {
  console.error('[Agent] Fatal error:', err);
  process.exit(1);
});
