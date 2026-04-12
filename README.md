# AgentCompute

> **Pay-per-job HTTP compute for AI agents — no API keys, no accounts, no humans.**

An AI agent needs compute. It sends an HTTP request. The server responds with **HTTP 402**. The agent pays in USDC on Stellar and retries. The server verifies on-chain and executes the job.

Zero signups. Zero billing dashboards. Zero human intervention.

Two payment protocols, both fully implemented:

| Protocol | How it works | On-chain txs |
|---|---|---|
| **x402 v2** | Soroban SAC `transfer()` per job, verified via Soroban RPC | 1 per job |
| **MPP channel** | Off-chain ed25519 signed vouchers, backed by a deployed one-way-channel contract | 2 total (open + close) |

---

## Demo

```
╔══════════════════════════════════════════╗
║   AgentCompute Demo Agent                ║
║   x402 v2 · Soroban SAC · MPP channel   ║
╚══════════════════════════════════════════╝

[Agent] Discovering jobs at http://localhost:3000/api...
[Agent] Found 6 jobs: summarize $0.05 · classify $0.03 · run-code $0.10 ...

[Agent] Generating fresh Stellar keypair...
[Agent] Public: GDWBUEE7VIGHCPKKSMHDKGVH6CPYCJCC...
[Agent]   Funded via friendbot, USDC trustline added, 10 USDC received.
[Agent] Channel keypair: GCOZT5N3I5Z7CEPE... (pre-deployed channel contract)

── x402 Jobs ────────────────────────────────────────────
[Agent] ── Job: summarize ──
[Agent]   Submitting Soroban USDC SAC transfer...
[Agent]   Soroban tx confirmed: 715ef527725a253a...
[Agent]   ✅ Result in 7023ms: { "summary": "AI is intelligence shown by machines...", "word_count": 19 }

[Agent] ── Job: classify ──
[Agent]   Soroban tx confirmed: ab7b17b7bf5328d0...
[Agent]   ✅ Result in 3590ms: { "label": "positive", "confidence": 0.99 }

[Agent] ── Job: run-code ──
[Agent]   Soroban tx confirmed: 7efc14851761438b...
[Agent]   ✅ Result in 5672ms: { "stdout": "Fibonacci: 0, 1, 1, 2, 3, 5, 8, 13, 21, 34\nSum: 88" }

── MPP Channel Job ──────────────────────────────────────
[Agent]   Protocol: off-chain ed25519 vouchers (2 on-chain txs total)
[Agent]   Paying via MPP channel (off-chain ed25519 voucher)...
[Agent]   ✅ Channel result in 3242ms (2 ticks, 0.02 USDC streamed):
           { "stdout": "MPP channel streaming demo — 0.01 USDC/sec\nPrimes up to 50000: 5133\nDone" }

╔══════════════════════════════════════════╗
║   Final Summary                          ║
╚══════════════════════════════════════════╝
  Protocols     : x402 v2 · Soroban SAC + MPP channel
  Jobs completed: 4
  Total spent   : $0.20 USDC

  • summarize  [x402       ] $0.05  7023ms  715ef527725a
  • classify   [x402       ] $0.03  3590ms  ab7b17b7bf53
  • run-code   [x402       ] $0.10  5672ms  7efc14851761
  • run-code   [mpp-channel] $0.02  3242ms  2ticks
```

Every x402 payment is a real **Soroban `invokeHostFunction`** call to the USDC SAC contract, verified on-chain via Soroban RPC. The MPP channel payment is a real **ed25519 commitment** verified against a deployed one-way-channel contract at `CBHE62BTDGY7KGXZWAKIR5XS5TJPYSWHUF7ZNVQF26AFBOIHCDRQLOWN` on Stellar testnet.

---

## Why This Matters

Today's AI agents are shackled to human infrastructure. Every API call requires a human to pre-authorize it, manage billing, and rotate credentials. This ceiling is artificial.

**x402 breaks it.** Agents carry their own wallets, pay per call, and operate autonomously and indefinitely. The payment IS the authorization.

**MPP channel mode goes further.** For long-running jobs, the agent deposits into a payment channel once and streams micropayments with each signed commitment — no per-payment on-chain transaction, no latency, no fees per tick.

AgentCompute is a complete, production-pattern reference implementation of both models.

---

## Payment Protocols

### x402 v2 — Soroban SAC (per-job)

```
1. Agent  POST /run-job
          { job: "summarize", payload: {...} }

2. Server 402
          { x402Version: 2,
            accepts: [{ scheme: "exact",
                        network: "stellar:testnet",
                        maxAmountRequired: "0.05",
                        asset: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
                        payTo: "G..." }] }

3. Agent  builds Soroban invokeHostFunction:
            USDC_SAC.transfer(agent, server, 500000)
          simulates → assembles auth entries → signs → submits → txHash

4. Agent  POST /run-job
          X-Payment: base64({ txHash, type: "soroban" })

5. Server verifies via Soroban RPC:
            ✓ tx succeeded on-chain
            ✓ contract = USDC SAC
            ✓ function = "transfer"
            ✓ destination = server account
            ✓ amount ≥ job price
            ✓ age < 60 seconds
            ✓ txHash not seen before (replay protection)

6. Server 200 { success: true, result: {...} }
```

No memos. No off-chain state. The transaction itself is the proof.

### MPP Channel — off-chain signed vouchers

```
[Setup: agent deploys one-way-channel contract with USDC deposit]
  Contract: CBHE62BTDGY7KGXZWAKIR5XS5TJPYSWHUF7ZNVQF26AFBOIHCDRQLOWN
  Deposit:  1 USDC (covers 100 seconds at 0.01/sec)

1. Agent  POST /channel/run-job

2. Server 402
          { channel: "CBHE62BT...",
            amount: "0.08",
            cumulativeAmount: "0" }

3. Agent  simulates prepare_commitment on-chain (read-only, no fee)
          signs ed25519 commitment off-chain
          { action: "voucher", amount: "800000", signature: "..." }

4. Agent  POST /channel/run-job  (with voucher credential)

5. Server verifies ed25519 signature against channel contract
          job runs — server ticks 0.01 USDC/sec
          job completes → server closes channel on-chain

6. Server 200 { success: true, result: {...}, mpp_ticks: 3, mpp_total_paid: "0.03" }
```

Per-payment cost: ~0 (just ed25519 verify, no on-chain tx). Two on-chain transactions total for any number of payments.

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                   AI Agent  (client/agent.ts)                    │
│                                                                  │
│  discover → fresh keypair → friendbot → USDC → run jobs          │
│                                                                  │
│  x402 flow:   POST /run-job → 402 → Soroban SAC transfer         │
│               → retry with X-Payment: txHash → result            │
│                                                                  │
│  channel flow: POST /channel/run-job → 402 with channel addr     │
│                → sign ed25519 voucher → retry → result           │
└─────────────────────────────┬────────────────────────────────────┘
                              │ HTTP
                              ▼
┌──────────────────────────────────────────────────────────────────┐
│                  AgentCompute Server (Express)                   │
│                                                                  │
│  GET  /              → Real-time dashboard (SSE + canvas UI)     │
│  GET  /api           → Service discovery (jobs, prices, dest)    │
│  GET  /events        → SSE stream of all payment + job events    │
│  POST /run-job       → x402-gated: Soroban SAC verification      │
│  POST /mpp/run-job   → MPP charge mode (server-sponsored fees)   │
│  POST /channel/run-job → MPP channel mode (off-chain vouchers)   │
└──────────┬────────────────────────────┬────────────────────────--┘
           │                            │
           ▼                            ▼
┌──────────────────────┐   ┌────────────────────────────────────┐
│   Payment Layer       │   │   Job Runners                      │
│                      │   │                                    │
│  soroban.ts          │   │  summarize    → Groq LLM           │
│  → Soroban RPC       │   │  classify     → Groq LLM           │
│  → parse XDR         │   │  analyze      → Groq LLM           │
│  → verify SAC args   │   │  run-code     → vm / python        │
│                      │   │  csv-insights → papaparse + LLM    │
│  mpp.ts              │   │  pdf-to-text  → pdf-parse          │
│  → charge: Mppx      │   └────────────────────────────────────┘
│    (@stellar/mpp)    │
│  → channel: Mppx     │   ┌────────────────────────────────────┐
│    (ed25519 verify)  │   │   Stellar Layer (testnet)          │
│                      │   │                                    │
│  replay.ts           │   │  USDC SAC contract                 │
│  → txHash cache      │   │  CBIELTK6YBZJU5UP2WWQEUCYKLPU...   │
│    10-min TTL        │   │                                    │
└──────────────────────┘   │  Channel contract                  │
                           │  CBHE62BTDGY7KGXZWAKIR5XS5TJ...   │
                           └────────────────────────────────────┘
```

---

## Live Dashboard

Open `http://localhost:3000`:

- **Animated flow diagram** — 6 nodes light up as each payment stage fires
- **Live activity terminal** — SSE stream of every 402, payment, and job event
- **Stats counters** — jobs completed, USDC earned, average response time
- **Try It panel** — pick any job, edit the payload, get real LLM results

---

## Job Catalog

| Job | Price | Description |
|---|---|---|
| `summarize` | **$0.05** | LLM text summarization (Groq Llama 3.3 70B) |
| `classify` | **$0.03** | Text classification with confidence score |
| `analyze` | **$0.08** | LLM analysis and question answering |
| `run-code` | **$0.10** | Sandboxed JS (`vm`) or Python (`child_process`) |
| `csv-insights` | **$0.07** | CSV analysis with LLM narrative insights |
| `pdf-to-text` | **$0.04** | PDF → plain text extraction |

---

## Quickstart

### 1. Clone & install

```bash
git clone https://github.com/thewoodfish/AgentCompute
cd AgentCompute
npm install
```

### 2. Generate server keypair

```bash
npm run keygen
# Copy STELLAR_SERVER_PUBLIC_KEY and STELLAR_SERVER_SECRET_KEY into .env
```

### 3. Get a free Groq API key

Sign up at **[console.groq.com](https://console.groq.com)** — no credit card. Add to `.env`:

```env
GROQ_API_KEY=gsk_...
```

### 4. Fund the server account

```bash
curl "https://friendbot.stellar.org/?addr=YOUR_PUBLIC_KEY"
```

### 5. Set up USDC distributor for the agent demo

```bash
npm run setup-usdc
# Generates a funded testnet account with USDC
# Paste TESTNET_USDC_DISTRIBUTOR_SECRET into .env
```

### 6. Deploy the MPP channel contract (optional — enables channel mode)

```bash
# Install stellar-cli
brew install stellar-cli

# Build the one-way-channel contract
git clone https://github.com/stellar-experimental/one-way-channel /tmp/one-way-channel
cd /tmp/one-way-channel/contracts/channel && stellar contract build

# Generate a channel demo keypair
npm run keygen
# → use this as CHANNEL_DEMO_SECRET / CHANNEL_DEMO_PUBLIC

# Fund the channel account via friendbot, add USDC trustline, get test USDC
# Then deploy the channel contract:
stellar contract deploy \
  --wasm-hash <from build output> \
  --source CHANNEL_DEMO_SECRET \
  --network testnet \
  --rpc-url https://soroban-testnet.stellar.org \
  --network-passphrase "Test SDF Network ; September 2015" \
  -- \
  --token CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA \
  --from CHANNEL_DEMO_PUBLIC \
  --commitment-key <32-byte raw pubkey hex> \
  --to SERVER_PUBLIC_KEY \
  --amount 10000000 \
  --refund-waiting-period 17280

# Add to .env:
# MPP_ENABLED=true
# CHANNEL_CONTRACT=C...  (from deploy output)
# CHANNEL_DEMO_SECRET=S...
# CHANNEL_DEMO_PUBLIC=G...
```

> A pre-deployed channel contract is already configured in `.env.example` for the demo.

### 7. Start the server

```bash
npm run dev
# Server running on http://localhost:3000
# [MPP] Channel mode enabled: CBHE62BT...
```

### 8. Run the autonomous agent

```bash
npm run agent
```

---

## Scripts

| Command | Description |
|---|---|
| `npm run dev` | Start server on `:3000` |
| `npm run agent` | Run the autonomous demo agent (x402 + MPP channel) |
| `npm run keygen` | Generate a fresh Stellar keypair |
| `npm run setup-usdc` | Create and fund a USDC distributor account |

---

## Tech Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js 24 + TypeScript (strict) |
| Server | Express |
| LLM | Groq API — `llama-3.3-70b-versatile` (free tier) |
| x402 payment | Soroban SAC `transfer()` — `@stellar/stellar-sdk` v15 |
| x402 verification | Soroban RPC — parses raw `envelopeXdr`, walks `invokeHostFunction` |
| MPP charge | `@stellar/mpp/charge/server` — server-sponsored fees |
| MPP channel | `@stellar/mpp/channel/server` — off-chain ed25519 vouchers |
| Channel contract | `one-way-channel` Soroban WASM deployed to testnet |
| Code sandbox | Node.js `vm` (JS) + `child_process` (Python) |
| CSV parsing | `papaparse` |
| PDF extraction | `pdf-parse` |
| Real-time UI | Vanilla JS + SSE (no build step) |

---

## Project Structure

```
agentcompute/
├── src/
│   ├── server.ts              # Express server, all routes, SSE
│   ├── types.ts               # Shared TypeScript interfaces
│   ├── eventBus.ts            # SSE event bus → real-time dashboard
│   ├── middleware/
│   │   ├── x402.ts            # x402: 402 challenge + Soroban RPC verification
│   │   └── mpp.ts             # MPP streaming tick runner
│   ├── jobs/
│   │   ├── index.ts           # Job registry + dispatcher
│   │   ├── llm.ts             # Groq: summarize / classify / analyze
│   │   ├── code.ts            # Sandboxed JS (vm) + Python (child_process)
│   │   ├── data.ts            # CSV analysis (papaparse + Groq)
│   │   └── file.ts            # PDF text extraction (pdf-parse)
│   └── payment/
│       ├── soroban.ts         # Soroban RPC verifier (SAC invokeHostFunction)
│       ├── mpp.ts             # @stellar/mpp charge + channel + Express adapters
│       └── replay.ts          # TX hash replay protection (10-min TTL)
├── client/
│   └── agent.ts               # Autonomous agent: x402 + MPP channel
├── scripts/
│   └── setup-usdc-distributor.ts
└── public/
    └── index.html             # Real-time dashboard (canvas + SSE)
```

---

## Key Design Decisions

**No memos in Soroban transactions.** Stellar's Soroban runtime forbids memos on `invokeHostFunction` operations. AgentCompute uses the transaction hash as the sole job correlator and replay key — simpler and more correct than any memo scheme.

**Soroban RPC over Horizon.** Payment verification parses the raw `envelopeXdr` from `getTransaction()`, walks the `invokeHostFunction` op, and checks SAC `transfer()` args directly. Cryptographically authoritative — no off-chain indexer.

**Server-sponsored fees.** The server's keypair signs the envelope for both charge and channel mode. Clients only sign Soroban auth entries (x402) or ed25519 commitments (channel). No XLM required on the agent side beyond account activation.

**Real one-way-channel contract.** The MPP channel is not simulated. The contract (`CBHE62BTDGY7KGXZWAKIR5XS5TJPYSWHUF7ZNVQF26AFBOIHCDRQLOWN`) is deployed on Stellar testnet from the [`stellar-experimental/one-way-channel`](https://github.com/stellar-experimental/one-way-channel) source. Ed25519 commitments are verified against the on-chain contract state.

**Replay protection without memos.** In-memory set of spent TX hashes (10-min TTL, matching Stellar's max transaction age) prevents double-spend without any off-chain nonce scheme.

---

*Built on [x402](https://developers.stellar.org/docs/build/agentic-payments/x402) · [Stellar MPP](https://developers.stellar.org/docs/build/agentic-payments/mpp) · Stellar testnet*
