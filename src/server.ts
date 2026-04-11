import 'dotenv/config';
import path from 'path';
import express, { Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { x402Middleware } from './middleware/x402';
import { runWithMPP } from './middleware/mpp';
import { JOB_REGISTRY, dispatchJob, isLongJob } from './jobs/index';
import { closeAllChannels } from './payment/mpp';
import { eventBus, EVENT_CHANNEL, emit, AppEvent } from './eventBus';

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

const PORT = parseInt(process.env.PORT || '3000', 10);
const SERVER_ACCOUNT = process.env.STELLAR_SERVER_PUBLIC_KEY || '';

// ── In-memory stats ───────────────────────────────────────────────────────────

const stats = {
  jobs_run: 0,
  usdc_earned: 0,
  total_duration_ms: 0,
};

eventBus.on(EVENT_CHANNEL, (e: AppEvent) => {
  if (e.type === 'job_complete' && e.success) {
    stats.jobs_run++;
    stats.total_duration_ms += e.duration_ms ?? 0;
  }
  if (e.type === 'payment_verified' && e.amount) {
    stats.usdc_earned += parseFloat(e.amount);
  }
});

// ── SSE /events ───────────────────────────────────────────────────────────────

app.get('/events', (req: Request, res: Response) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders();

  res.write(`data: ${JSON.stringify({ type: 'connected', timestamp: Date.now() })}\n\n`);

  const handler = (event: AppEvent) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  eventBus.on(EVENT_CHANNEL, handler);
  req.on('close', () => eventBus.off(EVENT_CHANNEL, handler));
});

// ── Stats ─────────────────────────────────────────────────────────────────────

app.get('/stats', (_req: Request, res: Response) => {
  res.json({
    jobs_run: stats.jobs_run,
    usdc_earned: stats.usdc_earned.toFixed(2),
    avg_duration_ms: stats.jobs_run ? Math.round(stats.total_duration_ms / stats.jobs_run) : 0,
  });
});

// ── Service Discovery ─────────────────────────────────────────────────────────

app.get('/api', (_req: Request, res: Response) => {
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

app.get('/jobs', (_req: Request, res: Response) => {
  res.json({ jobs: Object.values(JOB_REGISTRY) });
});

app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString(), network: 'stellar-testnet' });
});

// ── Demo endpoint (no payment required) ──────────────────────────────────────

app.post('/demo/run-job', async (req: Request, res: Response) => {
  const { job, payload } = req.body as { job: string; payload: Record<string, unknown> };
  const jobDef = JOB_REGISTRY[job];

  if (!jobDef) {
    res.status(404).json({ success: false, error: `Unknown job: ${job}` });
    return;
  }

  const jobId = uuidv4();
  const start = Date.now();

  emit({ type: 'job_request', job, jobId, price: jobDef.price });

  // Simulate payment verification delay
  await new Promise((r) => setTimeout(r, 600));
  emit({ type: 'payment_verified', job, jobId, txHash: `demo-${jobId.slice(0, 8)}`, amount: jobDef.price });

  emit({ type: 'job_start', job, jobId });

  try {
    const result = await dispatchJob(job, payload);
    const duration_ms = Date.now() - start;
    emit({ type: 'job_complete', job, jobId, duration_ms, success: true });
    res.json({ success: true, job, result, duration_ms, demo: true });
  } catch (err: unknown) {
    const error = err instanceof Error ? err.message : String(err);
    emit({ type: 'job_error', job, jobId, error });
    res.status(500).json({ success: false, error });
  }
});

// ── Run Job (x402 gated) ──────────────────────────────────────────────────────

app.post('/run-job', x402Middleware, async (req: Request, res: Response) => {
  const { job, payload } = req.body as { job: string; payload: Record<string, unknown> };
  const verifiedPayment = req.verifiedPayment!;
  const start = Date.now();

  emit({ type: 'job_start', job, jobId: verifiedPayment.jobId });

  try {
    let result: unknown;
    let duration_ms: number;

    if (isLongJob(job)) {
      const mppResult = await runWithMPP(
        verifiedPayment.jobId,
        'agent-client',
        async () => dispatchJob(job, payload)
      );

      duration_ms = mppResult.duration_ms;

      if (!mppResult.success) {
        emit({ type: 'job_complete', job, duration_ms, success: false });
        res.json({
          success: false, job,
          reason: mppResult.reason,
          partial_result: mppResult.partial_result,
          duration_ms,
          payment_verified: true,
          tx_hash: verifiedPayment.txHash,
        });
        return;
      }
      result = mppResult.result;
    } else {
      result = await dispatchJob(job, payload);
      duration_ms = Date.now() - start;
    }

    emit({ type: 'job_complete', job, duration_ms, success: true });
    res.json({ success: true, job, result, duration_ms, payment_verified: true, tx_hash: verifiedPayment.txHash });

  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    emit({ type: 'job_error', job, error: message });
    res.status(500).json({ success: false, error: message, reason: 'job_execution_failed', code: 'JOB_ERROR' });
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────

const server = app.listen(PORT, () => {
  console.log(`[AgentCompute] Server running on http://localhost:${PORT}`);
  console.log(`[AgentCompute] Stellar account: ${SERVER_ACCOUNT || '(not configured)'}`);
  console.log(`[AgentCompute] Network: stellar-testnet`);
});

async function shutdown() {
  console.log('\n[AgentCompute] Shutting down gracefully...');
  await closeAllChannels();
  server.close(() => { console.log('[AgentCompute] Server closed.'); process.exit(0); });
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
