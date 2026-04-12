export interface JobDefinition {
  name: string;
  price: string; // USDC amount as string e.g. "0.05"
  description: string;
  estimated_duration_ms: number;
}

export interface PaymentProof {
  txHash: string;
  amount: string;
  asset: string;
  network: string;
  memo?: string;
}

export interface VerifiedPayment {
  txHash: string;
  amount: string;
  jobId: string;
  verifiedAt: number;
}

export interface JobRequest {
  job: string;
  payload: Record<string, unknown>;
}

export interface JobResult {
  success: boolean;
  job: string;
  result?: unknown;
  duration_ms: number;
  payment_verified: boolean;
  tx_hash: string;
  reason?: string;
  partial_result?: unknown;
}

export interface ErrorResponse {
  success: false;
  error: string;
  reason: string;
  code: string;
}

export interface PaymentRequiredResponse {
  x402Version: number;
  accepts: Array<{
    scheme: string;
    network: string;
    maxAmountRequired: string;
    asset: string;
    payTo: string;
    extra: Record<string, string>;
  }>;
}

export interface MPPChannel {
  channelId: string;
  jobId: string;
  clientAccount: string;
  maxBalance: string;
  currentBalance: string;
  openedAt: number;
  isOpen: boolean;
}

// Extend Express Request
declare global {
  namespace Express {
    interface Request {
      verifiedPayment?: VerifiedPayment;
      jobId?: string;
    }
  }
}
