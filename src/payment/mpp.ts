/**
 * Stellar MPP (Machine Payments Protocol) — Mock Implementation
 *
 * Soroban MPP is not yet fully available on testnet. This mock has identical
 * function signatures to the real implementation so swapping is a one-file change.
 * Set MPP_ENABLED=true in .env when the real Soroban implementation is ready.
 *
 * Real implementation would use @stellar/stellar-sdk Soroban SAC transfers.
 */

import { MPPChannel } from '../types';
import { v4 as uuidv4 } from 'uuid';

const channels = new Map<string, MPPChannel>();

export async function openChannel(
  jobId: string,
  clientAccount: string,
  maxBalance: string
): Promise<string> {
  const channelId = uuidv4();
  const channel: MPPChannel = {
    channelId,
    jobId,
    clientAccount,
    maxBalance,
    currentBalance: maxBalance,
    openedAt: Date.now(),
    isOpen: true,
  };
  channels.set(channelId, channel);
  console.log(`[MPP-MOCK] channel opened channelId=${channelId} job=${jobId} maxBalance=${maxBalance} USDC`);
  return channelId;
}

export async function debitTick(channelId: string, amount: string): Promise<{ success: boolean; remaining: string; reason?: string }> {
  const channel = channels.get(channelId);
  if (!channel || !channel.isOpen) {
    return { success: false, remaining: '0', reason: 'Channel not found or closed' };
  }

  const remaining = parseFloat(channel.currentBalance);
  const debit = parseFloat(amount);

  if (remaining < debit) {
    channel.isOpen = false;
    channels.set(channelId, channel);
    console.log(`[MPP-MOCK] tick channel=${channelId} balance exhausted`);
    return { success: false, remaining: '0', reason: 'Balance exhausted' };
  }

  const newBalance = (remaining - debit).toFixed(7);
  channel.currentBalance = newBalance;
  channels.set(channelId, channel);
  console.log(`[MPP-MOCK] tick channel=${channelId} debited=${amount} remaining=${newBalance}`);
  return { success: true, remaining: newBalance };
}

export async function closeChannel(channelId: string): Promise<void> {
  const channel = channels.get(channelId);
  if (!channel) return;

  channel.isOpen = false;
  channels.set(channelId, channel);

  const durationMs = Date.now() - channel.openedAt;
  const spent = (parseFloat(channel.maxBalance) - parseFloat(channel.currentBalance)).toFixed(7);
  console.log(`[MPP-MOCK] channel closed channelId=${channelId} spent=${spent} USDC duration=${durationMs}ms`);
}

export function getChannel(channelId: string): MPPChannel | undefined {
  return channels.get(channelId);
}

export async function closeAllChannels(): Promise<void> {
  for (const [channelId, channel] of channels.entries()) {
    if (channel.isOpen) {
      await closeChannel(channelId);
    }
  }
}
