/**
 * x402 Middleware — Stellar implementation (version 2)
 *
 * Implements the x402 protocol on Stellar using Soroban SAC transfers.
 * Payment proof is a signed Soroban invokeHostFunction transaction (push mode):
 *   - client submits the SAC transfer on-chain (no memo — Soroban forbids memos)
 *   - retries with X-Payment: base64({ txHash, type: 'soroban' })
 *   - server verifies via Soroban RPC (not Horizon); txHash used for replay protection
 *
 * Spec: https://developers.stellar.org/docs/build/agentic-payments/x402
 */

import { Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid'; // used for jobId tracking only
import { verifySorobanPayment, USDC_SAC } from '../payment/soroban';
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
    // Issue 402 with x402Version 2 + Soroban asset (no memo — Soroban forbids memos)
    const jobId = uuidv4().replace(/-/g, '').slice(0, 16);

    emit({ type: 'job_request', job: jobName, jobId, price: jobDef.price });

    const paymentRequired: PaymentRequiredResponse = {
      x402Version: 2,
      accepts: [
        {
          scheme: 'exact',
          network: 'stellar:testnet',
          maxAmountRequired: jobDef.price,
          asset: USDC_SAC,                  // USDC SAC contract address
          payTo: SERVER_ACCOUNT,
          extra: {},
        },
      ],
    };

    res.status(402).json(paymentRequired);
    return;
  }

  // Decode payment proof
  let proof: { txHash: string; type?: string };
  try {
    const decoded = Buffer.from(paymentHeader, 'base64').toString('utf8');
    proof = JSON.parse(decoded);
  } catch {
    res.status(402).json({ success: false, error: 'Invalid X-Payment header', reason: 'malformed_payment', code: 'BAD_PAYMENT_HEADER' });
    return;
  }

  const { txHash } = proof;
  if (!txHash) {
    res.status(402).json({ success: false, error: 'Missing txHash', reason: 'malformed_payment', code: 'BAD_PAYMENT_PROOF' });
    return;
  }

  // Replay protection
  if (replay.has(txHash)) {
    res.status(402).json({ success: false, error: 'Transaction already used', reason: 'replay_attack', code: 'TX_REPLAYED' });
    return;
  }

  // Verify via Soroban RPC
  const verification = await verifySorobanPayment({
    txHash,
    expectedDestination: SERVER_ACCOUNT,
    expectedMinAmount: jobDef.price,
  });

  if (!verification.valid) {
    res.status(402).json({ success: false, error: 'Payment verification failed', reason: verification.reason, code: 'PAYMENT_INVALID' });
    return;
  }

  replay.add(txHash);

  console.log(`[x402] VERIFIED tx=${txHash} job=${jobName} amount=${verification.actualAmount} USDC payer=${verification.payer}`);
  emit({ type: 'payment_verified', job: jobName, txHash, amount: verification.actualAmount });

  const jobId = txHash.slice(0, 16);
  const verifiedPayment: VerifiedPayment = {
    txHash,
    amount: verification.actualAmount || jobDef.price,
    jobId,
    verifiedAt: Date.now(),
  };

  req.verifiedPayment = verifiedPayment;
  req.jobId = jobId;

  next();
}
