## What We Built

AgentCompute is a pay-per-job HTTP compute server designed for AI agents. It implements two agentic payment protocols on Stellar — x402 v2 and MPP channel mode — so any AI agent can autonomously purchase compute with USDC, with zero human involvement.

---

## The Problem

Every API on the internet today assumes a human is paying. Pre-authorized accounts, billing dashboards, API key rotation — all designed for people, not agents. An AI agent that needs to run a job (summarize a document, execute code, analyze data) has no way to pay for it without a human in the loop.

This is an artificial ceiling. The infrastructure for autonomous machine payments exists. We built the server that uses it.

---

## How It Works

An agent hits `POST /run-job`. The server responds with **HTTP 402 — Payment Required**, including the job price and the server's Stellar address. The agent submits a USDC payment on Stellar and retries with the transaction hash as proof. The server verifies the payment on-chain via Soroban RPC and executes the job.

No accounts. No API keys. No humans. The payment *is* the authorization.

---

## Payment Protocols

### x402 v2 — Soroban SAC (per job)

The agent submits a Soroban `invokeHostFunction` call to the USDC SAC contract on Stellar testnet. The server receives the transaction hash as proof, fetches the transaction via Soroban RPC, parses the raw XDR envelope, walks the `invokeHostFunction` operation, and verifies the SAC `transfer()` args directly — contract address, function name, destination, and amount. One on-chain transaction per job.

Key implementation detail: Soroban forbids memos on `invokeHostFunction` operations, so the transaction hash is the sole proof and replay key — simpler and more cryptographically correct than any memo scheme.

### MPP Channel Mode — off-chain ed25519 vouchers

For long-running jobs, the agent uses a one-way payment channel backed by a deployed Soroban contract (`CBHE62BTDGY7KGXZWAKIR5XS5TJPYSWHUF7ZNVQF26AFBOIHCDRQLOWN` on Stellar testnet). The agent signs off-chain ed25519 cumulative commitment vouchers — no on-chain transaction per payment, just a signature verify. The server streams micropayments at 0.01 USDC/sec during job execution. Two on-chain transactions total for any number of payments (open + close).

---

## Jobs Available

| Job | Price | Description |
|---|---|---|
| `summarize` | $0.05 | LLM text summarization (Groq Llama 3.3 70B) |
| `classify` | $0.03 | Text classification with confidence score |
| `analyze` | $0.08 | LLM analysis and question answering |
| `run-code` | $0.10 | Sandboxed JS (`vm`) or Python (`child_process`) |
| `csv-insights` | $0.07 | CSV parsing + LLM narrative insights |
| `pdf-to-text` | $0.04 | PDF → plain text extraction |

---

## Autonomous Agent Demo

`client/agent.ts` is a fully autonomous TypeScript agent that:
1. Calls `GET /api` to discover jobs, prices, and the server's Stellar address
2. Generates a fresh Stellar keypair, funds it via friendbot, adds a USDC trustline
3. Runs x402 jobs — submits Soroban USDC payments, retries with proof, receives results
4. Runs an MPP channel job — signs ed25519 vouchers, streams payment during execution

Zero hardcoded values. Zero human input after `npm run agent`.

---

## Tech Stack

- **Runtime**: Node.js 22 + TypeScript
- **Server**: Express
- **Payment verification**: `@stellar/stellar-sdk` v15 — Soroban RPC, raw XDR parsing
- **MPP**: `@stellar/mpp` — charge mode + channel mode
- **Channel contract**: `stellar-experimental/one-way-channel` — built and deployed to Stellar testnet
- **LLM**: Groq API (`llama-3.3-70b-versatile`)
- **Code sandbox**: Node.js `vm` (JS) + `child_process` (Python)
- **Real-time dashboard**: Vanilla JS + SSE — animated flow diagram, live activity feed, Try It panel
- **Deployed on**: Railway + Vercel

---

## Live

- **Dashboard + API**: https://clever-light-production.up.railway.app
- **Vercel**: https://agentcompute-rosy.vercel.app
- **GitHub**: https://github.com/thewoodfish/AgentCompute
