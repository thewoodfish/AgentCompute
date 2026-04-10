import * as StellarSdk from '@stellar/stellar-sdk';

const HORIZON_URL = process.env.STELLAR_HORIZON_URL || 'https://horizon-testnet.stellar.org';
const server = new StellarSdk.Horizon.Server(HORIZON_URL);

// Testnet USDC issuer
const USDC_ISSUER_TESTNET = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';

interface VerifyPaymentParams {
  txHash: string;
  expectedDestination: string;
  expectedAsset: string;
  expectedMinAmount: string;
  jobId: string;
}

interface VerifyPaymentResult {
  valid: boolean;
  reason?: string;
  actualAmount?: string;
}

export async function verifyPayment(params: VerifyPaymentParams): Promise<VerifyPaymentResult> {
  const { txHash, expectedDestination, expectedAsset, expectedMinAmount, jobId } = params;

  try {
    const tx = await server.transactions().transaction(txHash).call();

    if (!tx.successful) {
      return { valid: false, reason: 'Transaction did not succeed' };
    }

    // Check tx is recent (within 60 seconds)
    const createdAt = new Date(tx.created_at).getTime();
    const ageMs = Date.now() - createdAt;
    if (ageMs > 60_000) {
      return { valid: false, reason: `Transaction too old: ${Math.round(ageMs / 1000)}s` };
    }

    // Check memo matches jobId
    if (tx.memo !== jobId) {
      return { valid: false, reason: `Memo mismatch: expected ${jobId}, got ${tx.memo}` };
    }

    // Load operations for this transaction
    const ops = await server.operations().forTransaction(txHash).call();

    let foundPayment = false;
    let actualAmount = '0';

    for (const op of ops.records) {
      if (op.type !== 'payment') continue;

      const payOp = op as StellarSdk.Horizon.ServerApi.PaymentOperationRecord;

      // Check destination
      if (payOp.to !== expectedDestination) continue;

      // Check asset
      let assetMatch = false;
      if (expectedAsset === 'USDC' || expectedAsset === 'native') {
        if (payOp.asset_type === 'credit_alphanum4' &&
            payOp.asset_code === 'USDC' &&
            payOp.asset_issuer === USDC_ISSUER_TESTNET) {
          assetMatch = true;
        }
      }

      if (!assetMatch) continue;

      // Check amount
      const amount = parseFloat(payOp.amount);
      const minAmount = parseFloat(expectedMinAmount);
      if (amount < minAmount) {
        return { valid: false, reason: `Insufficient payment: got ${amount} USDC, need ${minAmount} USDC` };
      }

      foundPayment = true;
      actualAmount = payOp.amount;
      break;
    }

    if (!foundPayment) {
      return { valid: false, reason: 'No matching USDC payment operation found' };
    }

    return { valid: true, actualAmount };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { valid: false, reason: `Horizon lookup failed: ${message}` };
  }
}

export function getHorizonServer(): StellarSdk.Horizon.Server {
  return server;
}
