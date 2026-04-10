# AgentCompute

Pay-per-job compute server using x402 + Stellar MPP.

x402 docs: https://developers.stellar.org/docs/build/agentic-payments/x402
MPP docs: https://developers.stellar.org/docs/build/agentic-payments/mpp

Stack: Node.js + TypeScript + Express + @stellar/stellar-sdk + @anthropic-ai/sdk

## Key files

- `src/server.ts` — Express server, route handlers, graceful shutdown
- `src/middleware/x402.ts` — x402 payment gate (issues 402, verifies payments)
- `src/middleware/mpp.ts` — MPP streaming for long jobs (>= 5000ms)
- `src/payment/stellar.ts` — Horizon payment verification
- `src/payment/mpp.ts` — MPP channel management (mock-first, swap for real Soroban)
- `src/payment/replay.ts` — In-memory replay attack protection (10-min TTL)
- `src/jobs/index.ts` — Job registry + dispatcher
- `src/jobs/llm.ts` — LLM jobs via claude-haiku-4-5 (summarize/classify/analyze)
- `src/jobs/code.ts` — Sandboxed JS (vm module) + Python (child_process) execution
- `src/jobs/data.ts` — CSV analysis with papaparse + LLM
- `src/jobs/file.ts` — PDF text extraction with pdf-parse
- `client/agent.ts` — Autonomous demo agent (discover → pay → run → result)

## Payment flow

```
Agent POST /run-job
  → 402 + payment instructions (jobId as memo)
  → Agent submits Stellar USDC payment on testnet
  → Agent retries with X-Payment: base64(JSON proof)
  → Server verifies via Horizon (dest, asset, amount, memo, age < 60s)
  → Replay check (in-memory Set, 10-min TTL)
  → Job executes → result returned
```

## Long jobs (>= 5s) use MPP

- Channel opened at job start
- 0.01 USDC debited every second via `debitTick()`
- If balance exhausted: job killed, partial result returned with `reason: payment_stopped`
- Channel closed on completion or failure

## MPP implementation

Currently a mock in `src/payment/mpp.ts` that logs `[MPP-MOCK]` lines.
Real Soroban implementation: set `MPP_ENABLED=true` in `.env` and swap the file.
Function signatures are identical — one-file change.

## Running

```bash
npm install
cp .env.example .env
# Fill in STELLAR_SERVER_SECRET_KEY, STELLAR_SERVER_PUBLIC_KEY, ANTHROPIC_API_KEY
npm run dev        # starts server on PORT 3000
npm run agent      # runs autonomous demo agent
npm run keygen     # generates a fresh Stellar keypair
```
