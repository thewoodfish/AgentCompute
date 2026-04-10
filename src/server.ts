import 'dotenv/config';
import express, { Request, Response } from 'express';
import { x402Middleware } from './middleware/x402';
import { runWithMPP } from './middleware/mpp';
import { JOB_REGISTRY, dispatchJob, isLongJob } from './jobs/index';
import { closeAllChannels } from './payment/mpp';

const app = express();
app.use(express.json({ limit: '10mb' }));

const PORT = parseInt(process.env.PORT || '3000', 10);
const SERVER_ACCOUNT = process.env.STELLAR_SERVER_PUBLIC_KEY || '';

// ── Service Discovery ────────────────────────────────────────────────────────

app.get('/', (_req: Request, res: Response) => {
  res.json({
    name: 'AgentCompute',
    version: '1.0.0',
    description: 'Pay-per-job HTTP compute server for AI agents',
    jobs: Object.values(JOB_REGISTRY).map((j) => ({
      name: j.name,
      price: j.price,
      description: j.description,
      estimated_duration_ms: j.estimated_duration_ms,
    })),
    payment: {
      network: 'stellar-testnet',
      asset: 'USDC',
      destination: SERVER_ACCOUNT,
    },
  });
});

// ── Job List ─────────────────────────────────────────────────────────────────

app.get('/jobs', (_req: Request, res: Response) => {
  res.json({
    jobs: Object.values(JOB_REGISTRY),
  });
});

// ── Health ───────────────────────────────────────────────────────────────────

app.get('/health', (_req: Request, res: Response) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    network: 'stellar-testnet',
  });
});

// ── Run Job (x402 gated) ──────────────────────────────────────────────────────

app.post('/run-job', x402Middleware, async (req: Request, res: Response) => {
  const { job, payload } = req.body as { job: string; payload: Record<string, unknown> };
  const verifiedPayment = req.verifiedPayment!;
  const start = Date.now();

  try {
    if (isLongJob(job)) {
      // Long job: use MPP payment streaming
      const mppResult = await runWithMPP(
        verifiedPayment.jobId,
        'agent-client', // client account placeholder; real impl reads from payment proof
        async () => dispatchJob(job, payload)
      );

      if (!mppResult.success) {
        res.json({
          success: false,
          job,
          reason: mppResult.reason,
          partial_result: mppResult.partial_result,
          duration_ms: mppResult.duration_ms,
          payment_verified: true,
          tx_hash: verifiedPayment.txHash,
        });
        return;
      }

      res.json({
        success: true,
        job,
        result: mppResult.result,
        duration_ms: mppResult.duration_ms,
        payment_verified: true,
        tx_hash: verifiedPayment.txHash,
      });
    } else {
      // Short job: run directly
      const result = await dispatchJob(job, payload);
      res.json({
        success: true,
        job,
        result,
        duration_ms: Date.now() - start,
        payment_verified: true,
        tx_hash: verifiedPayment.txHash,
      });
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({
      success: false,
      error: message,
      reason: 'job_execution_failed',
      code: 'JOB_ERROR',
    });
  }
});

// ── Start ────────────────────────────────────────────────────────────────────

const server = app.listen(PORT, () => {
  console.log(`[AgentCompute] Server running on http://localhost:${PORT}`);
  console.log(`[AgentCompute] Stellar account: ${SERVER_ACCOUNT || '(not configured)'}`);
  console.log(`[AgentCompute] Network: stellar-testnet`);
});

// Graceful shutdown
async function shutdown() {
  console.log('\n[AgentCompute] Shutting down gracefully...');
  await closeAllChannels();
  server.close(() => {
    console.log('[AgentCompute] Server closed.');
    process.exit(0);
  });
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
