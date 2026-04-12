/**
 * AgentCompute Demo Agent
 *
 * Autonomous agent that:
 * 1. Discovers jobs via the server API
 * 2. Funds a fresh Stellar testnet keypair via friendbot
 * 3. Runs 3 jobs via x402 (Soroban SAC transfer — no API keys, no accounts)
 * 4. Runs 1 expensive job via MPP channel (off-chain signed vouchers)
 *
 * x402 payment flow per job:
 *   POST /run-job → 402
 *   Build Soroban USDC SAC transfer, sign auth entries, submit on-chain
 *   Retry POST /run-job with X-Payment: base64({ txHash, type: "soroban" })
 *   Server verifies via Soroban RPC → job executes → result returned
 *
 * MPP channel flow:
 *   POST /channel/run-job → 402 with channel address
 *   Sign ed25519 cumulative commitment (off-chain, ~0 cost)
 *   Retry POST /channel/run-job with voucher credential
 *   Server verifies signature → job executes, ticks every second → result returned
 *
 * No human input required after launch.
 */

import 'dotenv/config';
import * as StellarSdk from '@stellar/stellar-sdk';
import { USDC_SAC_TESTNET, toBaseUnits } from '@stellar/mpp';
import { Mppx, stellar as channelStellar } from '@stellar/mpp/channel/client';

const SERVER_URL   = process.env.SERVER_URL    || 'http://localhost:3000';
const SOROBAN_URL  = process.env.SOROBAN_RPC_URL || 'https://soroban-testnet.stellar.org';
const HORIZON_URL  = process.env.STELLAR_HORIZON_URL || 'https://horizon-testnet.stellar.org';
const FRIENDBOT    = 'https://friendbot.stellar.org';

const horizon    = new StellarSdk.Horizon.Server(HORIZON_URL);
const sorobanRpc = new StellarSdk.rpc.Server(SOROBAN_URL);

// ── Helpers ───────────────────────────────────────────────────────────────────

async function fetchJSON<T>(url: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(url, opts);
  return res.json() as Promise<T>;
}

function encodeProof(proof: object): string {
  return Buffer.from(JSON.stringify(proof)).toString('base64');
}

async function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

// ── Account setup ─────────────────────────────────────────────────────────────

async function fundAccount(publicKey: string): Promise<void> {
  console.log(`[Agent]   Funding via friendbot...`);
  await fetch(`${FRIENDBOT}?addr=${publicKey}`);
  await sleep(3000);
}

async function addUSDCTrustline(kp: StellarSdk.Keypair): Promise<void> {
  console.log(`[Agent]   Adding USDC trustline...`);
  const acc = await horizon.loadAccount(kp.publicKey());
  const usdc = new StellarSdk.Asset('USDC', 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5');
  const tx = new StellarSdk.TransactionBuilder(acc, {
    fee: StellarSdk.BASE_FEE,
    networkPassphrase: StellarSdk.Networks.TESTNET,
  })
    .addOperation(StellarSdk.Operation.changeTrust({ asset: usdc, limit: '1000' }))
    .setTimeout(30)
    .build();
  tx.sign(kp);
  await horizon.submitTransaction(tx);
}

async function getTestUSDC(kp: StellarSdk.Keypair): Promise<void> {
  const distributorSecret = process.env.TESTNET_USDC_DISTRIBUTOR_SECRET;
  if (!distributorSecret) {
    console.log(`[Agent]   No TESTNET_USDC_DISTRIBUTOR_SECRET — skipping USDC funding.`);
    return;
  }
  console.log(`[Agent]   Receiving testnet USDC...`);
  const distributor = StellarSdk.Keypair.fromSecret(distributorSecret);
  const distAcc = await horizon.loadAccount(distributor.publicKey());
  const usdc = new StellarSdk.Asset('USDC', 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5');
  const tx = new StellarSdk.TransactionBuilder(distAcc, {
    fee: StellarSdk.BASE_FEE,
    networkPassphrase: StellarSdk.Networks.TESTNET,
  })
    .addOperation(StellarSdk.Operation.payment({ destination: kp.publicKey(), asset: usdc, amount: '10' }))
    .setTimeout(30)
    .build();
  tx.sign(distributor);
  await horizon.submitTransaction(tx);
  console.log(`[Agent]   Received 10 testnet USDC.`);
}

// ── Soroban SAC USDC transfer ─────────────────────────────────────────────────

async function buildAndSubmitSACTransfer(
  kp: StellarSdk.Keypair,
  destination: string,
  amount: string,  // human-readable e.g. "0.05"
): Promise<string> {
  const DECIMALS = 7;
  const amountBaseUnits = toBaseUnits(amount, DECIMALS);  // e.g. "0.05" → 500000n

  const usdcContract = new StellarSdk.Contract(USDC_SAC_TESTNET);

  // Get Soroban account state
  const account = await sorobanRpc.getAccount(kp.publicKey());

  // Build the transfer transaction
  const tx = new StellarSdk.TransactionBuilder(account, {
    fee: StellarSdk.BASE_FEE,
    networkPassphrase: StellarSdk.Networks.TESTNET,
  })
    .addOperation(
      usdcContract.call(
        'transfer',
        new StellarSdk.Address(kp.publicKey()).toScVal(),    // from
        new StellarSdk.Address(destination).toScVal(),       // to
        StellarSdk.nativeToScVal(amountBaseUnits, { type: 'i128' }), // amount
      )
    )
    .setTimeout(180)
    .build();

  // Simulate to populate auth entries
  const sim = await sorobanRpc.simulateTransaction(tx);
  if (!StellarSdk.rpc.Api.isSimulationSuccess(sim)) {
    throw new Error(`Soroban simulation failed: ${JSON.stringify(sim)}`);
  }

  // Assemble: inject auth entries + fee
  const preparedTx = StellarSdk.rpc.assembleTransaction(tx, sim).build();
  preparedTx.sign(kp);

  // Submit to Soroban RPC
  const submitResult = await sorobanRpc.sendTransaction(preparedTx);
  if (submitResult.status === 'ERROR') {
    throw new Error(`Soroban submit failed: ${JSON.stringify(submitResult)}`);
  }

  const hash = submitResult.hash;

  // Poll for confirmation
  for (let i = 0; i < 30; i++) {
    await sleep(2000);
    const result = await sorobanRpc.getTransaction(hash);
    if (result.status === StellarSdk.rpc.Api.GetTransactionStatus.SUCCESS) {
      return hash;
    }
    if (result.status === StellarSdk.rpc.Api.GetTransactionStatus.FAILED) {
      throw new Error(`Soroban transaction failed on ledger`);
    }
  }
  throw new Error('Soroban transaction confirmation timeout');
}

// ── Run a single job via x402 ─────────────────────────────────────────────────

interface ServerDiscovery {
  jobs: Array<{ name: string; price: string; description: string }>;
  payment: { network: string; asset: string; destination: string };
}

interface PaymentChallenge {
  x402Version: number;
  accepts: Array<{ maxAmountRequired: string; payTo: string; extra: Record<string, string> }>;
}

async function runJob(
  jobName: string,
  payload: Record<string, unknown>,
  kp: StellarSdk.Keypair,
  serverDestination: string
): Promise<{ result: unknown; duration_ms: number; txHash: string }> {
  console.log(`\n[Agent] ── Job: ${jobName} ──`);
  const start = Date.now();

  // Step 1: POST without payment → expect 402
  const first = await fetch(`${SERVER_URL}/run-job`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ job: jobName, payload }),
  });

  if (first.status !== 402) throw new Error(`Expected 402, got ${first.status}`);

  const challenge = await first.json() as PaymentChallenge;
  const accept = challenge.accepts[0];
  const { maxAmountRequired, payTo } = accept;

  console.log(`[Agent]   Payment required: ${maxAmountRequired} USDC`);

  // Step 2: Build + submit Soroban SAC transfer (no memo — Soroban forbids it)
  console.log(`[Agent]   Submitting Soroban USDC SAC transfer...`);
  const txHash = await buildAndSubmitSACTransfer(kp, serverDestination, maxAmountRequired);
  console.log(`[Agent]   Soroban tx confirmed: ${txHash.slice(0, 16)}...`);

  // Step 3: Retry with proof (txHash is sufficient — server verifies on-chain)
  const proof = { txHash, type: 'soroban', network: 'stellar:testnet' };
  const second = await fetch(`${SERVER_URL}/run-job`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Payment': encodeProof(proof) },
    body: JSON.stringify({ job: jobName, payload }),
  });

  const jobResult = await second.json() as { success: boolean; result: unknown; duration_ms: number; error?: string };
  if (!jobResult.success) throw new Error(`Job failed: ${jobResult.error}`);

  const elapsed = Date.now() - start;
  console.log(`[Agent]   ✅ Result in ${elapsed}ms:`);
  console.log(`          `, JSON.stringify(jobResult.result, null, 2).replace(/\n/g, '\n           '));

  return { result: jobResult.result, duration_ms: elapsed, txHash };
}

// ── MPP Channel job ───────────────────────────────────────────────────────────

async function runChannelJob(
  jobName: string,
  payload: Record<string, unknown>,
  channelKp: StellarSdk.Keypair,
): Promise<{ result: unknown; duration_ms: number; mpp_ticks: number; mpp_total_paid: string }> {
  console.log(`\n[Agent] ── Channel Job: ${jobName} ──`);
  const start = Date.now();

  // Build Mppx channel client with the agent's commitment keypair
  const mppxClient = Mppx.create({
    methods: [channelStellar.channel({
      commitmentKey: channelKp,
      sourceAccount: channelKp.publicKey(),
    })],
  });

  // mppx.fetch automatically handles:
  //  1st call → gets 402 with channel address + amount
  //  Signs ed25519 cumulative commitment (off-chain)
  //  Retries with voucher credential
  console.log(`[Agent]   Paying via MPP channel (off-chain ed25519 voucher)...`);

  const response = await mppxClient.fetch(`${SERVER_URL}/channel/run-job`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ job: jobName, payload }),
  });

  if (!response.ok && response.status !== 200) {
    const err = await response.text();
    throw new Error(`Channel job failed: ${response.status} ${err}`);
  }

  const jobResult = await response.json() as {
    success: boolean; result: unknown; duration_ms: number;
    mpp_ticks: number; mpp_total_paid: string; error?: string;
  };
  if (!jobResult.success) throw new Error(`Job failed: ${jobResult.error}`);

  const elapsed = Date.now() - start;
  console.log(`[Agent]   ✅ Channel result in ${elapsed}ms (${jobResult.mpp_ticks} ticks, ${jobResult.mpp_total_paid} USDC streamed):`);
  console.log(`          `, JSON.stringify(jobResult.result, null, 2).replace(/\n/g, '\n           '));

  return { result: jobResult.result, duration_ms: elapsed, mpp_ticks: jobResult.mpp_ticks, mpp_total_paid: jobResult.mpp_total_paid };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('╔══════════════════════════════════════════╗');
  console.log('║   AgentCompute Demo Agent                ║');
  console.log('║   x402 v2 · Soroban SAC · MPP channel   ║');
  console.log('╚══════════════════════════════════════════╝');

  // Step 1: Discover
  console.log(`\n[Agent] Discovering jobs at ${SERVER_URL}/api...`);
  const discovery = await fetchJSON<ServerDiscovery>(`${SERVER_URL}/api`);
  console.log(`[Agent] Found ${discovery.jobs.length} jobs:`);
  discovery.jobs.forEach(j => console.log(`  • ${j.name.padEnd(14)} $${j.price} USDC`));

  const serverDest = discovery.payment.destination;
  console.log(`[Agent] Payment destination: ${serverDest}`);

  // Step 2: Generate & fund fresh x402 keypair
  console.log('\n[Agent] Generating fresh Stellar keypair...');
  const kp = StellarSdk.Keypair.random();
  console.log(`[Agent] Public: ${kp.publicKey()}`);

  await fundAccount(kp.publicKey());
  await addUSDCTrustline(kp);
  await getTestUSDC(kp);

  // Step 3: Load the pre-deployed channel keypair (for MPP channel demo)
  const channelDemoSecret = process.env.CHANNEL_DEMO_SECRET;
  const channelKp = channelDemoSecret
    ? StellarSdk.Keypair.fromSecret(channelDemoSecret)
    : null;

  if (channelKp) {
    console.log(`\n[Agent] Channel keypair: ${channelKp.publicKey().slice(0, 16)}... (pre-funded channel)`);
  }

  // Step 4: Run 3 x402 jobs + 1 MPP channel job
  const totalStart = Date.now();
  const summary: Array<{ job: string; protocol: string; amount: string; duration_ms: number; id: string }> = [];

  const job1Price = discovery.jobs.find(j => j.name === 'summarize')?.price || '0.05';
  const j1 = await runJob('summarize', {
    text: `Artificial intelligence (AI) is intelligence demonstrated by machines, as opposed
to natural intelligence displayed by animals including humans. AI research has been defined
as the field of study of intelligent agents — systems that perceive their environment and
take actions that maximize their chance of achieving their goals. The technology raises profound
questions about the future of work, creativity, and what it means to be human.`,
  }, kp, serverDest);
  summary.push({ job: 'summarize', protocol: 'x402', amount: job1Price, duration_ms: j1.duration_ms, id: j1.txHash.slice(0, 12) });

  const job2Price = discovery.jobs.find(j => j.name === 'classify')?.price || '0.03';
  const j2 = await runJob('classify', {
    text: 'I absolutely love this product! It exceeded all my expectations.',
    labels: ['positive', 'negative', 'neutral'],
  }, kp, serverDest);
  summary.push({ job: 'classify', protocol: 'x402', amount: job2Price, duration_ms: j2.duration_ms, id: j2.txHash.slice(0, 12) });

  const job3Price = discovery.jobs.find(j => j.name === 'run-code')?.price || '0.10';
  const j3 = await runJob('run-code', {
    language: 'javascript',
    code: `const fib = n => n <= 1 ? n : fib(n-1)+fib(n-2);
const seq = Array.from({length:10},(_,i)=>fib(i));
console.log('Fibonacci:', seq.join(', '));
console.log('Sum:', seq.reduce((a,b)=>a+b,0));`,
  }, kp, serverDest);
  summary.push({ job: 'run-code', protocol: 'x402', amount: job3Price, duration_ms: j3.duration_ms, id: j3.txHash.slice(0, 12) });

  // MPP channel job (uses pre-deployed one-way-channel contract)
  if (channelKp) {
    console.log('\n[Agent] ── MPP Channel Demo ──────────────────────────────');
    console.log('[Agent]   Protocol: off-chain ed25519 vouchers (2 on-chain txs total)');
    const channelJobPrice = discovery.jobs.find(j => j.name === 'run-code')?.price || '0.10';
    try {
      // Use Python (child_process) — async, so streaming ticks fire correctly
      const jc = await runChannelJob('run-code', {
        language: 'python',
        code: `import time, math
print("MPP channel streaming demo — 0.01 USDC/sec")
primes = [n for n in range(2, 50000) if all(n%i!=0 for i in range(2,int(n**0.5)+1))]
print(f"Primes up to 50000: {len(primes)}")
time.sleep(2)
result = sum(math.sin(i) for i in range(100000))
print(f"Checksum: {result:.4f}")
print("Done — payment channel will close")`,
      }, channelKp);
      summary.push({ job: 'run-code', protocol: 'mpp-channel', amount: jc.mpp_total_paid, duration_ms: jc.duration_ms, id: `${jc.mpp_ticks}ticks` });
    } catch (e) {
      console.log(`[Agent]   Channel job error: ${e}`);
    }
  }

  // Summary
  const totalTime = Date.now() - totalStart;
  const totalSpent = summary.reduce((acc, j) => acc + parseFloat(j.amount), 0).toFixed(2);

  console.log('\n╔══════════════════════════════════════════╗');
  console.log('║   Final Summary                          ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log(`  Protocols     : x402 v2 · Soroban SAC + MPP channel`);
  console.log(`  Jobs completed: ${summary.length}`);
  console.log(`  Total spent   : $${totalSpent} USDC`);
  console.log(`  Total time    : ${totalTime}ms\n`);
  for (const j of summary) {
    console.log(`  • ${j.job.padEnd(14)} [${j.protocol.padEnd(11)}] $${j.amount}  ${j.duration_ms}ms  ${j.id}`);
  }
}

main().catch(err => { console.error('[Agent] Fatal:', err); process.exit(1); });
