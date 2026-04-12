/**
 * Soroban SAC (Stellar Asset Contract) payment verification.
 *
 * Replaces Horizon payment-op verification with proper Soroban RPC verification.
 * Verifies that a submitted transaction contains an invokeHostFunction calling
 * transfer(from, to, amount) on the USDC SAC contract.
 */

import * as StellarSdk from '@stellar/stellar-sdk';
import { USDC_SAC_TESTNET } from '@stellar/mpp';

const SOROBAN_RPC_URL = process.env.SOROBAN_RPC_URL || 'https://soroban-testnet.stellar.org';
const rpc = new StellarSdk.rpc.Server(SOROBAN_RPC_URL);

export const USDC_SAC = USDC_SAC_TESTNET;

interface VerifyParams {
  txHash: string;
  expectedDestination: string;
  expectedMinAmount: string; // human-readable, e.g. "0.05"
}

interface VerifyResult {
  valid: boolean;
  reason?: string;
  actualAmount?: string;
  payer?: string;
}

const DECIMALS = 7;
const BASE_UNITS = 10 ** DECIMALS;
const MAX_AGE_SECONDS = 60;

export async function verifySorobanPayment(params: VerifyParams): Promise<VerifyResult> {
  const { txHash, expectedDestination, expectedMinAmount } = params;

  // Poll for transaction (may still be pending on ledger)
  let result: StellarSdk.rpc.Api.GetTransactionResponse | undefined;
  for (let i = 0; i < 15; i++) {
    result = await rpc.getTransaction(txHash);
    if (result.status !== StellarSdk.rpc.Api.GetTransactionStatus.NOT_FOUND) break;
    await new Promise((r) => setTimeout(r, 2000));
  }

  if (!result || result.status === StellarSdk.rpc.Api.GetTransactionStatus.NOT_FOUND) {
    return { valid: false, reason: 'Transaction not found on ledger' };
  }

  if (result.status === StellarSdk.rpc.Api.GetTransactionStatus.FAILED) {
    return { valid: false, reason: 'Transaction failed on ledger' };
  }

  const success = result as StellarSdk.rpc.Api.GetSuccessfulTransactionResponse;

  // Check freshness
  const ageSeconds = Date.now() / 1000 - success.createdAt;
  if (ageSeconds > MAX_AGE_SECONDS) {
    return { valid: false, reason: `Transaction too old: ${Math.round(ageSeconds)}s` };
  }

  // Parse the transaction envelope
  const tx = success.envelopeXdr.v1().tx();

  // Find the invokeHostFunction operation
  const ops = tx.operations();
  const ihfOp = ops.find((op) => op.body().switch().name === 'invokeHostFunction');

  if (!ihfOp) {
    return { valid: false, reason: 'No invokeHostFunction operation in transaction' };
  }

  // .value() gets the current union arm's value (works across SDK versions)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ihfBody = (ihfOp.body() as any).value() as any;
  const hostFn = ihfBody.hostFunction();
  if (hostFn.switch().name !== 'hostFunctionTypeInvokeContract') {
    return { valid: false, reason: 'Not an invokeContract call' };
  }

  const invoke = hostFn.invokeContract();

  // Verify contract address is USDC SAC
  const contractId = StellarSdk.Address.fromScAddress(invoke.contractAddress()).toString();
  if (contractId !== USDC_SAC_TESTNET) {
    return { valid: false, reason: `Wrong contract: ${contractId}` };
  }

  // Verify function name is 'transfer'
  const fnName = invoke.functionName().toString();
  if (fnName !== 'transfer') {
    return { valid: false, reason: `Wrong function: ${fnName}` };
  }

  // Parse transfer(from, to, amount)
  const args = invoke.args();
  if (args.length < 3) {
    return { valid: false, reason: 'Insufficient arguments in transfer call' };
  }

  const toAddress = StellarSdk.Address.fromScVal(args[1]).toString();
  const amountRaw = StellarSdk.scValToNative(args[2]) as bigint;
  const amountHuman = (Number(amountRaw) / BASE_UNITS).toFixed(DECIMALS);

  const payer = StellarSdk.Address.fromScVal(args[0]).toString();

  // Verify destination
  if (toAddress !== expectedDestination) {
    return { valid: false, reason: `Wrong destination: ${toAddress}` };
  }

  // Verify amount
  const expectedBaseUnits = BigInt(Math.round(parseFloat(expectedMinAmount) * BASE_UNITS));
  if (amountRaw < expectedBaseUnits) {
    return { valid: false, reason: `Insufficient amount: ${amountHuman} USDC < ${expectedMinAmount} USDC` };
  }

  return { valid: true, actualAmount: amountHuman, payer };
}

export { rpc as sorobanRpc };
