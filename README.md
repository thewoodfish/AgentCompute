# AgentCompute

AgentCompute is a pay-per-job HTTP compute server for AI agents. Agents rent compute capacity on demand by paying in USDC over HTTP using the x402 protocol on Stellar testnet — no API keys, no accounts, no humans in the loop.

Under the hood, short jobs (< 5 seconds) are settled with a single Stellar USDC payment verified against the Horizon API. Long jobs (≥ 5 seconds) open a Stellar MPP (Machine Payments Protocol) payment channel that streams micropayments every second while the job runs. If the agent stops paying mid-job, execution halts and a partial result is returned.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        AI Agent Client                           │
│  client/agent.ts — discover → pay → execute → receive result    │
└────────────────────────┬────────────────────────────────────────┘
                         │ HTTP POST /run-job
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│                     Express Server (src/server.ts)               │
│                                                                  │
│  GET /          → service discovery (jobs, prices, payment info) │
│  GET /jobs      → full job list                                  │
│  GET /health    → health check                                   │
│  POST /run-job  → x402 gated job execution                       │
└────────────────────────┬────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│              x402 Middleware (src/middleware/x402.ts)            │
│                                                                  │
│  No X-Payment header?  → HTTP 402 + payment instructions        │
│  Has X-Payment header? → decode → verify on Horizon → replay    │
│                          check → attach to req → next()         │
└────────────────────────┬────────────────────────────────────────┘
                         │
              ┌──────────┴──────────┐
              │ short job (< 5s)    │ long job (≥ 5s)
              ▼                     ▼
┌─────────────────────┐  ┌──────────────────────────────────────┐
│   Job Runner        │  │  MPP Middleware (src/middleware/mpp)  │
│  src/jobs/index.ts  │  │  open channel → debit 1¢/sec         │
│  • summarize (LLM)  │  │  payment stop? → kill + partial result│
│  • classify  (LLM)  │  │  job done?    → close channel        │
│  • analyze   (LLM)  │  └──────────────────────────────────────┘
│  • run-code (vm/py) │
│  • csv-insights     │
│  • pdf-to-text      │
└────────────┬────────┘
             │
             ▼
┌─────────────────────────────────────────────────────────────────┐
│           Stellar Payment Layer                                  │
│                                                                  │
│  stellar.ts  → Horizon testnet verification                      │
│  mpp.ts      → MPP channel management (mock → real Soroban)     │
│  replay.ts   → In-memory tx hash cache (10-min TTL)             │
└─────────────────────────────────────────────────────────────────┘
```

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
```

### 3. Generate a Stellar keypair for the server

```bash
npm run keygen
```

Copy the public and secret keys into your `.env`:

```
STELLAR_SERVER_SECRET_KEY=S...
STELLAR_SERVER_PUBLIC_KEY=G...
```

### 4. Fund the server account with testnet XLM

Visit `https://friendbot.stellar.org/?addr=<YOUR_PUBLIC_KEY>` or use:

```bash
curl "https://friendbot.stellar.org/?addr=YOUR_PUBLIC_KEY"
```

### 5. Add your Anthropic API key

```
ANTHROPIC_API_KEY=sk-ant-...
```

## Running

```bash
# Start the server (port 3000 by default)
npm run dev

# Run the autonomous agent demo
npm run agent

# Generate a new Stellar keypair
npm run keygen
```

## Job catalog

| Job          | Price     | Est. Duration | Description                            |
|--------------|-----------|---------------|----------------------------------------|
| `summarize`  | $0.05 USDC | ~3s           | LLM text summarization                 |
| `classify`   | $0.03 USDC | ~2s           | LLM text classification                |
| `analyze`    | $0.08 USDC | ~4s           | LLM analysis + question answering      |
| `run-code`   | $0.10 USDC | ~8s (MPP)     | Sandboxed JS or Python execution       |
| `csv-insights`| $0.07 USDC | ~6s (MPP)    | CSV analysis with LLM insights         |
| `pdf-to-text`| $0.04 USDC | ~3s           | PDF → plain text extraction            |

Jobs marked **(MPP)** use Stellar MPP streaming payments (≥ 5 seconds).

## Example curl flows

### Discover jobs

```bash
curl http://localhost:3000/
```

### Summarize (x402 flow)

```bash
# Step 1: get 402 + payment instructions
curl -X POST http://localhost:3000/run-job \
  -H "Content-Type: application/json" \
  -d '{"job":"summarize","payload":{"text":"Your article text here..."}}'
# → HTTP 402 with x402Version, accepts[], payTo, memo (jobId)

# Step 2: submit Stellar USDC payment on testnet (use Stellar laboratory or SDK)
# get tx hash and jobId from the 402 response

# Step 3: retry with payment proof
PROOF=$(echo '{"txHash":"TX_HASH","amount":"0.05","asset":"USDC","network":"stellar-testnet","memo":"JOB_ID"}' | base64)
curl -X POST http://localhost:3000/run-job \
  -H "Content-Type: application/json" \
  -H "X-Payment: $PROOF" \
  -d '{"job":"summarize","payload":{"text":"Your article text here..."}}'
```

### Classify

```bash
# After 402 flow...
curl -X POST http://localhost:3000/run-job \
  -H "Content-Type: application/json" \
  -H "X-Payment: $PROOF" \
  -d '{"job":"classify","payload":{"text":"Great product!","labels":["positive","negative","neutral"]}}'
```

### Run code (MPP long job)

```bash
curl -X POST http://localhost:3000/run-job \
  -H "Content-Type: application/json" \
  -H "X-Payment: $PROOF" \
  -d '{"job":"run-code","payload":{"language":"javascript","code":"console.log(2+2)"}}'
```

## Switching MPP mock to real Soroban

The current MPP implementation is a mock (`src/payment/mpp.ts`) that logs `[MPP-MOCK]` lines and simulates channel operations. To switch to the real Soroban implementation:

1. Set `MPP_ENABLED=true` in your `.env`
2. Replace `src/payment/mpp.ts` with the real Soroban SAC implementation

The function signatures (`openChannel`, `debitTick`, `closeChannel`) are identical — it's a one-file swap.

## Payment protocol details

### x402 on Stellar

1. Client POSTs `/run-job` without payment
2. Server returns HTTP 402 with payment instructions (amount, destination, jobId as memo)
3. Client submits Stellar USDC payment on testnet, receives tx hash
4. Client retries with `X-Payment: <base64(JSON proof)>`
5. Server verifies via Horizon: tx succeeded, correct destination + amount + asset, memo matches jobId, tx < 60s old, not replayed
6. Job executes, result returned

### Stellar MPP (Machine Payments Protocol)

Long jobs (≥ 5s) open a payment channel at job start. The server debits 0.01 USDC per second via off-chain signed transfers. If the client stops paying or the balance is exhausted, the job is killed and a partial result is returned with `reason: "payment_stopped"`. On completion, the channel is closed and the final settlement is posted on-chain.
