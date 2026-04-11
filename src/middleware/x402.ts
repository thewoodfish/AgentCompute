import { Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { verifyPayment } from '../payment/stellar';
import * as replay from '../payment/replay';
import { getJobDefinition } from '../jobs/index';
import { PaymentRequiredResponse, VerifiedPayment } from '../types';
import { emit } from '../eventBus';

const SERVER_ACCOUNT = process.env.STELLAR_SERVER_PUBLIC_KEY || '';

export async function x402Middleware(req: Request, res: Response, next: NextFunction): Promise<void> {
  const jobName = req.body?.job as string | undefined;

  if (!jobName) {
    res.status(400).json({ success: false, error: 'Missing job name', reason: 'bad_request', code: 'MISSING_JOB' });
    return;
  }

  const jobDef = getJobDefinition(jobName);
  if (!jobDef) {
    res.status(404).json({ success: false, error: `Unknown job: ${jobName}`, reason: 'not_found', code: 'JOB_NOT_FOUND' });
    return;
  }

  const paymentHeader = req.headers['x-payment'] as string | undefined;

  if (!paymentHeader) {
    // No payment — issue 402
    const jobId = uuidv4();
    req.jobId = jobId;

    emit({ type: 'job_request', job: jobName, jobId, price: jobDef.price });

    const paymentRequired: PaymentRequiredResponse = {
      x402Version: 1,
      accepts: [
        {
          scheme: 'exact',
          network: 'stellar-testnet',
          maxAmountRequired: jobDef.price,
          asset: 'USDC',
          payTo: SERVER_ACCOUNT,
          extra: { memo: jobId },
        },
      ],
    };

    res.status(402).json(paymentRequired);
    return;
  }

  // Decode payment proof
  let proof: { txHash: string; amount: string; asset: string; network: string; memo: string };
  try {
    const decoded = Buffer.from(paymentHeader, 'base64').toString('utf8');
    proof = JSON.parse(decoded);
  } catch {
    res.status(402).json({ success: false, error: 'Invalid X-Payment header', reason: 'malformed_payment', code: 'BAD_PAYMENT_HEADER' });
    return;
  }

  const { txHash, memo } = proof;

  if (!txHash || !memo) {
    res.status(402).json({ success: false, error: 'Missing txHash or memo in payment proof', reason: 'malformed_payment', code: 'BAD_PAYMENT_PROOF' });
    return;
  }

  // Replay check
  if (replay.has(txHash)) {
    res.status(402).json({ success: false, error: 'Transaction already used', reason: 'replay_attack', code: 'TX_REPLAYED' });
    return;
  }

  // Verify on Horizon
  const verification = await verifyPayment({
    txHash,
    expectedDestination: SERVER_ACCOUNT,
    expectedAsset: 'USDC',
    expectedMinAmount: jobDef.price,
    jobId: memo,
  });

  if (!verification.valid) {
    res.status(402).json({ success: false, error: 'Payment verification failed', reason: verification.reason, code: 'PAYMENT_INVALID' });
    return;
  }

  // Mark as used
  replay.add(txHash);

  console.log(`[x402] VERIFIED tx=${txHash} job=${jobName} amount=${verification.actualAmount} USDC`);
  emit({ type: 'payment_verified', job: jobName, txHash, amount: verification.actualAmount });

  const verifiedPayment: VerifiedPayment = {
    txHash,
    amount: verification.actualAmount || jobDef.price,
    jobId: memo,
    verifiedAt: Date.now(),
  };

  req.verifiedPayment = verifiedPayment;
  req.jobId = memo;

  next();
}
