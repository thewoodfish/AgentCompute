# ⬡ AgentCompute

> **Pay-per-job compute for AI agents — no API keys, no accounts, no humans.**

An AI agent needs to run a job. It sends an HTTP request. The server says *pay me first*. The agent pays in USDC on Stellar — autonomously, in seconds — and gets the result. That's it. No signups. No billing dashboards. No humans in the loop.

AgentCompute is a fully autonomous compute marketplace built on the [x402 protocol](https://developers.stellar.org/docs/build/agentic-payments/x402) and [Stellar MPP](https://developers.stellar.org/docs/build/agentic-payments/mpp). It demonstrates what the agentic economy looks like when machines pay machines directly over HTTP.

---

## The Problem

Today's AI agents are trapped behind human-managed API keys. Every tool an agent uses — every API call, every compute job — requires a human to pre-authorize it, manage billing, and rotate credentials. This fundamentally limits what agents can do autonomously.

The emerging solution is HTTP-native payments: agents carry their own wallets, pay per use, and operate indefinitely without human intervention. But there's no reference implementation showing how this actually works in practice — until now.

---

## The Solution

```
Agent POSTs /run-job  ──→  HTTP 402 + payment instructions
                                        │
                                        ▼
                           Agent pays in USDC on Stellar
                                        │
                                        ▼
                           Server verifies via Horizon API
                                        │
                                        ▼
                           Job executes (LLM / code / data)
                                        │
                                        ▼
                           Result returned in JSON
```

AgentCompute implements the full **x402 payment protocol on Stellar** — the agent gets a 402, submits a real USDC transaction, and retries with cryptographic proof. No human touched anything.

Long-running jobs use **Stellar MPP (Machine Payments Protocol)** — a payment channel that streams micropayments every second the job runs. Stop paying? Job stops. Simple.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                         AI Agent (client/agent.ts)                   │
│  discover jobs → fund self → pay per job → receive results           │
└───────────────────────────┬─────────────────────────────────────────┘
                            │  HTTP POST /run-job
                            ▼
┌─────────────────────────────────────────────────────────────────────┐
│                    AgentCompute Server (Express)                      │
│                                                                       │
│   GET  /          →  Dashboard UI (real-time payment flow viz)        │
│   GET  /api       →  Service discovery (jobs, prices, payment info)   │
│   GET  /events    →  SSE stream (live payment + job events)           │
│   POST /run-job   →  x402-gated job execution                         │
│   POST /demo/run-job  →  Demo endpoint (UI Try It panel)              │
└───────────┬───────────────────────┬─────────────────────────────────┘
            │                       │
            ▼                       ▼
┌───────────────────┐   ┌──────────────────────────────────────────┐
│   x402 Middleware  │   │        MPP Middleware (long jobs)         │
│                   │   │                                          │
│  No header?       │   │  Open channel → debit 1¢/sec             │
│  → 402 + memo ID  │   │  Payment stops? → kill + partial result  │
│                   │   │  Job done? → close + settle on-chain     │
│  Has header?      │   └──────────────────────────────────────────┘
│  → decode proof   │
│  → Horizon verify │               ┌──────────────────────────────┐
│  → replay check   │               │   Job Runners                 │
│  → next()         │               │                              │
└───────────────────┘               │  summarize   → Groq LLM      │
                                    │  classify    → Groq LLM      │
┌───────────────────┐               │  analyze     → Groq LLM      │
│  Stellar Layer     │               │  run-code    → vm / python   │
│                   │               │  csv-insights→ papaparse+LLM │
│  stellar.ts       │               │  pdf-to-text → pdf-parse     │
│  → Horizon verify │               └──────────────────────────────┘
│                   │
│  mpp.ts           │
│  → channel mgmt   │
│  → mock → Soroban │
│                   │
│  replay.ts        │
│  → tx hash cache  │
└───────────────────┘
```

---

## Live Dashboard

AgentCompute ships with a real-time dashboard at `http://localhost:3000`:

- **Animated x402 flow diagram** — nodes light up live as each payment stage completes
- **SSE-powered activity terminal** — color-coded feed of every 402, payment, and job event
- **Live stats** — jobs run, USDC earned, avg response time — auto-updating
- **Interactive Try It panel** — pick any job, edit the JSON payload, watch the full flow animate, get real LLM results

---

## Job Catalog

| Job | Price | Est. Time | Description |
|---|---|---|---|
| `summarize` | **$0.05 USDC** | ~3s | LLM text summarization |
| `classify` | **$0.03 USDC** | ~2s | LLM text classification with confidence score |
| `analyze` | **$0.08 USDC** | ~4s | LLM analysis + question answering |
| `run-code` | **$0.10 USDC** | ~8s ⚡ | Sandboxed JS or Python execution |
| `csv-insights` | **$0.07 USDC** | ~6s ⚡ | CSV data analysis with LLM insights |
| `pdf-to-text` | **$0.04 USDC** | ~3s | PDF → plain text extraction |

⚡ = MPP streaming payments (Stellar payment channel, debited per second)

---

## Payment Protocol

### x402 on Stellar

Standard HTTP 402 extended for Stellar USDC. The full flow in one request cycle:

```
→  POST /run-job   { job: "summarize", payload: { text: "..." } }
←  402             { x402Version: 1, accepts: [{ scheme: "exact",
                     network: "stellar-testnet", maxAmountRequired: "0.05",
                     asset: "USDC", payTo: "G...", extra: { memo: "<job_id>" } }] }

   [Agent submits Stellar USDC transaction with memo = job_id]

→  POST /run-job   { job: "summarize", payload: { text: "..." } }
   X-Payment: eyJ0eEhhc2giOiAiYWJjMTIzLi4uIn0=   ← base64(JSON proof)
←  200             { success: true, result: { summary: "...", word_count: 42 },
                     duration_ms: 2847, payment_verified: true, tx_hash: "abc123..." }
```

Server-side verification (all on Horizon testnet):
- ✓ Transaction succeeded on-chain
- ✓ Destination matches server account
- ✓ Asset is USDC (correct testnet issuer)
- ✓ Amount ≥ job price
- ✓ Memo matches job ID
- ✓ Transaction < 60 seconds old
- ✓ TX hash not previously seen (replay protection)

### Stellar MPP (Machine Payments Protocol)

Jobs estimated ≥ 5 seconds open a payment channel at job start:

```
Job starts   → openChannel(jobId, client, maxBalance=1.0 USDC)
Every second → debitTick(channelId, "0.01")   [1 USDC-cent/sec]
Job ends     → closeChannel(channelId)         [final on-chain settlement]

If balance exhausted or client stops:
             → job killed immediately
             → returns { success: false, reason: "payment_stopped", partial_result }
```

MPP is currently mock-implemented (logs `[MPP-MOCK]`) with identical function signatures to the real Soroban implementation — one env var + one file swap to go live.

---

## Quickstart

### 1. Clone & install

```bash
git clone https://github.com/thewoodfish/AgentCompute
cd AgentCompute
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
```

### 3. Generate server keypair & get a free Groq API key

```bash
npm run keygen
# → copy STELLAR_SERVER_PUBLIC_KEY and STELLAR_SERVER_SECRET_KEY into .env
```

Get a free API key at **[console.groq.com](https://console.groq.com)** — no credit card needed.

### 4. Fund server account

```bash
# Paste your public key:
curl "https://friendbot.stellar.org/?addr=YOUR_PUBLIC_KEY"
```

### 5. Add USDC trustline to server

```bash
npx ts-node -e "
import 'dotenv/config';
import * as S from '@stellar/stellar-sdk';
const kp = S.Keypair.fromSecret(process.env.STELLAR_SERVER_SECRET_KEY);
const srv = new S.Horizon.Server('https://horizon-testnet.stellar.org');
const USDC = new S.Asset('USDC','GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5');
srv.loadAccount(kp.publicKey()).then(a => {
  const tx = new S.TransactionBuilder(a,{fee:S.BASE_FEE,networkPassphrase:S.Networks.TESTNET})
    .addOperation(S.Operation.changeTrust({asset:USDC,limit:'10000'}))
    .setTimeout(30).build();
  tx.sign(kp); return srv.submitTransaction(tx);
}).then(()=>console.log('Done!')).catch(console.error);
"
```

### 6. Set up USDC distributor for agent demo (one command)

```bash
npm run setup-usdc
# → generates funded account with ~200 USDC, prints TESTNET_USDC_DISTRIBUTOR_SECRET
# → paste that value into .env
```

### 7. Start the server

```bash
npm run dev
# → http://localhost:3000
```

### 8. Run the autonomous agent demo

```bash
npm run agent
```

Watch the agent generate a fresh wallet, fund itself, and pay for 3 real jobs — end-to-end, zero human input.

---

## Agent Demo Output

```
╔══════════════════════════════════════╗
║   AgentCompute Demo Agent            ║
╚══════════════════════════════════════╝

[Agent] Discovering jobs at http://localhost:3000/api...
[Agent] Found 6 jobs:
  • summarize      $0.05 USDC — LLM-powered text summarization
  • classify       $0.03 USDC — LLM-powered text classification
  • run-code       $0.10 USDC — Sandboxed code execution

[Agent] Generating fresh Stellar keypair...
[Agent] Public key: GDLX4KVL...
[Agent] Account funded. USDC trustline added. 10 USDC received.

[Agent] ── Job: summarize ──
[Agent]   Payment required: 0.05 USDC
[Agent]   Submitting Stellar payment... tx=28b27e19...
[Agent]   ✅ Result in 8.9s → { summary: "AI refers to machine intelligence...", word_count: 19 }

[Agent] ── Job: classify ──
[Agent]   ✅ Result in 9.8s → { label: "positive", confidence: 0.99 }

[Agent] ── Job: run-code ──
[Agent]   ✅ Result in 9.5s → { stdout: "Fibonacci: 0, 1, 1, 2, 3, 5, 8, 13..." }

  Jobs completed : 3
  Total spent    : $0.18 USDC
  Total time     : 28s
```

---

## Example API Calls

### Step 1 — Get 402 payment challenge

```bash
curl -X POST http://localhost:3000/run-job \
  -H "Content-Type: application/json" \
  -d '{"job":"summarize","payload":{"text":"Your text here..."}}'
```

```json
{
  "x402Version": 1,
  "accepts": [{
    "scheme": "exact",
    "network": "stellar-testnet",
    "maxAmountRequired": "0.05",
    "asset": "USDC",
    "payTo": "GCTIQ2ZV...",
    "extra": { "memo": "d8e75a1d58194256" }
  }]
}
```

### Step 2 — Submit payment proof

```bash
PROOF=$(echo '{"txHash":"28b27e19...","amount":"0.05","asset":"USDC","network":"stellar-testnet","memo":"d8e75a1d58194256"}' | base64)

curl -X POST http://localhost:3000/run-job \
  -H "Content-Type: application/json" \
  -H "X-Payment: $PROOF" \
  -d '{"job":"summarize","payload":{"text":"Your text here..."}}'
```

```json
{
  "success": true,
  "job": "summarize",
  "result": { "summary": "...", "word_count": 19 },
  "duration_ms": 2847,
  "payment_verified": true,
  "tx_hash": "28b27e19..."
}
```

---

## Tech Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js + TypeScript (strict mode) |
| Server | Express |
| LLM | Groq API — `llama-3.3-70b-versatile` (free tier) |
| Payments | `@stellar/stellar-sdk` — x402 + MPP |
| Payment verification | Stellar Horizon testnet |
| Code sandbox | Node.js `vm` module + `child_process` (Python) |
| CSV parsing | `papaparse` |
| PDF extraction | `pdf-parse` |
| Real-time UI | Vanilla JS + SSE (no build step) |

---

## Switching MPP Mock → Real Soroban

The MPP implementation in `src/payment/mpp.ts` is a clean mock with identical function signatures to the real Soroban SAC implementation. To go live:

1. Set `MPP_ENABLED=true` in `.env`
2. Replace `src/payment/mpp.ts` with the Soroban SAC version

That's it. One env var, one file. Every function signature stays the same.

---

## Project Structure

```
agentcompute/
├── src/
│   ├── server.ts              # Express server, routes, SSE, demo endpoint
│   ├── types.ts               # Shared TypeScript interfaces
│   ├── eventBus.ts            # Real-time event bus (SSE → dashboard)
│   ├── middleware/
│   │   ├── x402.ts            # Payment gate: 402 challenge + verification
│   │   └── mpp.ts             # Streaming payment runner for long jobs
│   ├── jobs/
│   │   ├── index.ts           # Job registry + dispatcher
│   │   ├── llm.ts             # LLM jobs via Groq (summarize/classify/analyze)
│   │   ├── code.ts            # Sandboxed JS (vm) + Python (child_process)
│   │   ├── data.ts            # CSV analysis (papaparse + LLM)
│   │   └── file.ts            # PDF extraction (pdf-parse)
│   └── payment/
│       ├── stellar.ts         # Horizon verification
│       ├── mpp.ts             # MPP channel management (mock-first)
│       └── replay.ts          # Replay attack protection (10-min TTL cache)
├── client/
│   └── agent.ts               # Autonomous agent demo
├── scripts/
│   └── setup-usdc-distributor.ts  # One-command USDC distributor setup
└── public/
    └── index.html             # Real-time dashboard (no build step)
```

---

## Scripts

```bash
npm run dev          # Start server on :3000
npm run agent        # Run autonomous demo agent
npm run keygen       # Generate a fresh Stellar keypair
npm run setup-usdc   # Set up a funded USDC distributor account
```

---

*Built with [x402](https://developers.stellar.org/docs/build/agentic-payments/x402) + [Stellar MPP](https://developers.stellar.org/docs/build/agentic-payments/mpp) on Stellar testnet.*
