import 'dotenv/config';
import path from 'path';
import express, { Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { x402Middleware } from './middleware/x402';
import { runWithMPP } from './middleware/mpp';
import { JOB_REGISTRY, dispatchJob, isLongJob } from './jobs/index';
import { closeAllChannels, mppx, mppxChannel, channelEnabled, toWebRequest, sendWebResponse, startChannelJob, tickChannelJob, stopChannelJob, CHANNEL_CONTRACT } from './payment/mpp';
import { eventBus, EVENT_CHANNEL, emit, AppEvent } from './eventBus';

const app = express();
app.use(express.json({ limit: '10mb' }));
// Works for both: tsx (src/) and compiled (dist/src/) — public/ is one level up in both
const publicDir = path.join(__dirname, '..', 'public');
app.use(express.static(publicDir));

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

// ── MPP Run Job (@stellar/mpp charge — Soroban SAC, server-sponsored fees) ───

app.post('/mpp/run-job', async (req: Request, res: Response) => {
  const { job, payload } = req.body as { job: string; payload: Record<string, unknown> };
  const jobDef = JOB_REGISTRY[job];

  if (!jobDef) {
    res.status(404).json({ success: false, error: `Unknown job: ${job}` });
    return;
  }

  const webReq = toWebRequest(req);

  // Run MPP charge check — issues 402 or verifies Soroban SAC payment
  const mppResult = await mppx.charge({
    amount: jobDef.price,
    description: `AgentCompute: ${job}`,
  })(webReq);

  if (mppResult.status === 402) {
    emit({ type: 'job_request', job, price: jobDef.price });
    await sendWebResponse(mppResult.challenge, res);
    return;
  }

  // Payment verified — run the job
  emit({ type: 'payment_verified', job, amount: jobDef.price });
  emit({ type: 'job_start', job });

  const start = Date.now();
  try {
    const result = await dispatchJob(job, payload);
    const duration_ms = Date.now() - start;
    emit({ type: 'job_complete', job, duration_ms, success: true });

    const responseBody = JSON.stringify({ success: true, job, result, duration_ms, protocol: 'mpp' });
    const webResponse = mppResult.withReceipt(
      new globalThis.Response(responseBody, { headers: { 'Content-Type': 'application/json' } })
    );
    await sendWebResponse(webResponse, res);
  } catch (err: unknown) {
    const error = err instanceof Error ? err.message : String(err);
    emit({ type: 'job_error', job, error });
    res.status(500).json({ success: false, error, reason: 'job_execution_failed' });
  }
});

// ── Channel Run Job (MPP channel — off-chain signed vouchers) ─────────────────
// Real one-way payment channel: client signs cumulative ed25519 commitments.
// Per-payment cost: ~0 (just sig verify). 2 on-chain txs total (open + close).

app.post('/channel/run-job', async (req: Request, res: Response) => {
  if (!channelEnabled || !mppxChannel) {
    res.status(503).json({ success: false, error: 'Channel mode not configured. Set MPP_ENABLED=true and CHANNEL_CONTRACT in .env' });
    return;
  }

  const { job, payload } = req.body as { job: string; payload: Record<string, unknown> };
  const jobDef = JOB_REGISTRY[job];

  if (!jobDef) {
    res.status(404).json({ success: false, error: `Unknown job: ${job}` });
    return;
  }

  const webReq = toWebRequest(req);

  // Run MPP channel check — issues 402 with channel address or verifies voucher
  // Channel Mppx uses .stellar.channel() (not .charge()) — different intent
  const mppResult = await mppxChannel.stellar.channel({
    amount: jobDef.price,
    description: `AgentCompute channel: ${job}`,
  })(webReq);

  if (mppResult.status === 402) {
    emit({ type: 'job_request', job, price: jobDef.price });
    await sendWebResponse(mppResult.challenge, res);
    return;
  }

  // Voucher verified — start streaming ticks
  const jobId = uuidv4();
  startChannelJob(jobId, CHANNEL_CONTRACT.slice(0, 8));
  emit({ type: 'payment_verified', job, jobId, amount: jobDef.price, protocol: 'mpp-channel' } as never);
  emit({ type: 'job_start', job, jobId });

  const start = Date.now();

  // Tick every second during job execution (shows streaming payment)
  const tickInterval = setInterval(() => {
    const tick = tickChannelJob(jobId);
    if (tick) {
      console.log(`[MPP-CHANNEL] tick job=${jobId} tick=${tick.tickCount} totalPaid=${tick.totalPaid} USDC`);
    }
  }, 1000);

  try {
    const result = await dispatchJob(job, payload);
    clearInterval(tickInterval);
    const finalState = stopChannelJob(jobId);
    const duration_ms = Date.now() - start;
    const totalPaid = finalState?.totalPaid ?? 0;

    emit({ type: 'job_complete', job, jobId, duration_ms, success: true });
    console.log(`[MPP-CHANNEL] job=${jobId} done totalPaid=${totalPaid.toFixed(7)} USDC ticks=${finalState?.tickCount}`);

    const responseBody = JSON.stringify({
      success: true, job, result, duration_ms,
      protocol: 'mpp-channel',
      channel: CHANNEL_CONTRACT,
      mpp_ticks: finalState?.tickCount,
      mpp_total_paid: totalPaid.toFixed(7),
    });
    const webResponse = mppResult.withReceipt(
      new globalThis.Response(responseBody, { headers: { 'Content-Type': 'application/json' } })
    );
    await sendWebResponse(webResponse, res);

  } catch (err: unknown) {
    clearInterval(tickInterval);
    stopChannelJob(jobId);
    const error = err instanceof Error ? err.message : String(err);
    emit({ type: 'job_error', job, jobId, error });
    res.status(500).json({ success: false, error, reason: 'job_execution_failed' });
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

// Export for Vercel serverless — Vercel imports this module and calls it as a handler
export default app;

if (!process.env.VERCEL) {
  const server = app.listen(PORT, () => {
    console.log(`[AgentCompute] Server running on http://localhost:${PORT}`);
    console.log(`[AgentCompute] Stellar account: ${SERVER_ACCOUNT || '(not configured)'}`);
    console.log(`[AgentCompute] Network: stellar-testnet`);
    if (channelEnabled) {
      console.log(`[AgentCompute] MPP channel: ${CHANNEL_CONTRACT}`);
    }
  });

  async function shutdown() {
    console.log('\n[AgentCompute] Shutting down gracefully...');
    await closeAllChannels();
    server.close(() => { console.log('[AgentCompute] Server closed.'); process.exit(0); });
  }

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
