import { openChannelLegacy as openChannel, debitTick, closeChannelLegacy as closeChannel } from '../payment/mpp';

const TICK_INTERVAL_MS = 1000;
const TICK_AMOUNT = '0.01'; // 1 USDC-cent per second

export interface MPPResult {
  success: boolean;
  result?: unknown;
  reason?: string;
  partial_result?: unknown;
  duration_ms: number;
}

/**
 * Run a long job with MPP payment streaming.
 * Debits the channel every second. Kills the job if payment fails.
 */
export async function runWithMPP(
  jobId: string,
  clientAccount: string,
  jobFn: () => Promise<unknown>
): Promise<MPPResult> {
  const maxBalance = '1.0'; // 1 USDC cap per long job
  const channelId = await openChannel(jobId, clientAccount, maxBalance);

  const startTime = Date.now();
  let partialResult: unknown = null;
  let paymentStopped = false;
  let stopReason = '';

  // Set up interval ticker
  let intervalHandle: ReturnType<typeof setInterval>;

  const paymentPromise = new Promise<void>((resolve) => {
    intervalHandle = setInterval(async () => {
      const tick = await debitTick(channelId, TICK_AMOUNT);
      if (!tick.success) {
        paymentStopped = true;
        stopReason = tick.reason || 'payment_stopped';
        clearInterval(intervalHandle);
        resolve();
      }
    }, TICK_INTERVAL_MS);
  });

  // Race job against payment failure
  let jobResult: unknown = null;
  let jobError: unknown = null;

  const jobPromise = jobFn()
    .then((r) => { jobResult = r; })
    .catch((e) => { jobError = e; });

  // Wait for either the job to finish or payment to stop
  await Promise.race([jobPromise, paymentPromise]);

  clearInterval(intervalHandle!);
  await closeChannel(channelId);

  const duration_ms = Date.now() - startTime;

  if (paymentStopped) {
    return {
      success: false,
      reason: 'payment_stopped',
      partial_result: partialResult,
      duration_ms,
    };
  }

  if (jobError) {
    throw jobError;
  }

  return {
    success: true,
    result: jobResult,
    duration_ms,
  };
}
