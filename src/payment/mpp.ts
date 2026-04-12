/**
 * Stellar MPP (Machine Payments Protocol) — charge + channel modes.
 *
 * charge mode: uses @stellar/mpp/charge/server — real Soroban SAC transfer,
 *              verified and settled on-chain. Server sponsors fees via feePayer.
 *
 * channel mode: uses @stellar/mpp/channel/server — off-chain signed ed25519
 *               commitments against a deployed one-way-channel Soroban contract.
 *               Per-payment cost: ~0 (just ed25519 verify). 2 on-chain txs total
 *               (open + close). Requires CHANNEL_CONTRACT in .env.
 *
 * Docs: https://developers.stellar.org/docs/build/agentic-payments/mpp
 */

import { Keypair } from '@stellar/stellar-sdk';
import { Mppx as ChargeMppx, stellar as chargeStellar, Store as ChargeStore } from '@stellar/mpp/charge/server';
import { Mppx as ChannelMppx, stellar as channelStellar, Store as ChannelStore, close as closeChannel } from '@stellar/mpp/channel/server';
import { USDC_SAC_TESTNET } from '@stellar/mpp';
import { v4 as uuidv4 } from 'uuid';
import { MPPChannel } from '../types';
import { emit } from '../eventBus';

const serverSecret = process.env.STELLAR_SERVER_SECRET_KEY || '';
const serverPublic = process.env.STELLAR_SERVER_PUBLIC_KEY || '';
const CHANNEL_CONTRACT = process.env.CHANNEL_CONTRACT || '';
const MPP_ENABLED = process.env.MPP_ENABLED === 'true';

// ── Charge mode (Mppx) ────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const mppx: any = ChargeMppx.create({
  secretKey: serverSecret,
  methods: [
    chargeStellar.charge({
      recipient: serverPublic,
      currency: USDC_SAC_TESTNET,
      network: 'stellar:testnet',
      store: ChargeStore.memory(),
      feePayer: {
        envelopeSigner: Keypair.fromSecret(serverSecret),
      },
    }),
  ],
});

// ── Channel mode (Mppx) ───────────────────────────────────────────────────────
// Real one-way payment channel: client signs off-chain cumulative commitments,
// server verifies ed25519 signature, closes on-chain at the end.
// ~0 per-payment cost (just sig verify). 2 on-chain txs total (open + close).

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let channelMppx: any = null;

if (MPP_ENABLED && CHANNEL_CONTRACT) {
  channelMppx = ChannelMppx.create({
    secretKey: serverSecret,
    methods: [
      channelStellar.channel({
        channel: CHANNEL_CONTRACT,
        commitmentKey: process.env.CHANNEL_DEMO_PUBLIC || serverPublic,
        store: ChannelStore.memory(),
        network: 'stellar:testnet',
        feePayer: {
          envelopeSigner: Keypair.fromSecret(serverSecret),
        },
      }),
    ],
  });
  console.log(`[MPP] Channel mode enabled: ${CHANNEL_CONTRACT.slice(0, 8)}...`);
} else {
  console.log(`[MPP] Channel mode disabled (set MPP_ENABLED=true + CHANNEL_CONTRACT)`);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const mppxChannel: any = channelMppx;
export const channelEnabled = MPP_ENABLED && !!CHANNEL_CONTRACT;
export { closeChannel, CHANNEL_CONTRACT };

// ── Express ↔ Web API adapter ─────────────────────────────────────────────────

import { Request as ExpressRequest, Response as ExpressResponse } from 'express';

const PORT = process.env.PORT || '3000';

export function toWebRequest(req: ExpressRequest): Request {
  const host = req.get('host') || `localhost:${PORT}`;
  const url = `${req.protocol}://${host}${req.originalUrl}`;

  const headers = new Headers();
  Object.entries(req.headers).forEach(([key, value]) => {
    if (value !== undefined) {
      headers.set(key, Array.isArray(value) ? value.join(', ') : value);
    }
  });

  const body = ['POST', 'PUT', 'PATCH'].includes(req.method)
    ? JSON.stringify(req.body)
    : undefined;

  return new Request(url, { method: req.method, headers, body });
}

export async function sendWebResponse(webRes: Response, res: ExpressResponse): Promise<void> {
  res.status(webRes.status);
  webRes.headers.forEach((value: string, key: string) => {
    res.setHeader(key, value);
  });
  const body = await webRes.text();
  if (body) {
    try {
      res.json(JSON.parse(body));
    } catch {
      res.send(body);
    }
  } else {
    res.end();
  }
}

// ── Streaming tick tracker (for MPP channel jobs) ─────────────────────────────
// Tracks in-memory state for running channel jobs. The real payment enforcement
// is the channel contract on-chain — this tracks the server-side tick count.

const TICK_INTERVAL_MS = 1000;
const TICK_AMOUNT_USDC = 0.01; // 1 cent/sec
const TICK_AMOUNT_STR = '0.01';

interface ChannelJobState {
  channelId: string;
  jobId: string;
  tickCount: number;
  totalPaid: number;
  startTime: number;
  isRunning: boolean;
}

const runningJobs = new Map<string, ChannelJobState>();

export function startChannelJob(jobId: string, channelId: string): void {
  runningJobs.set(jobId, {
    channelId,
    jobId,
    tickCount: 0,
    totalPaid: 0,
    startTime: Date.now(),
    isRunning: true,
  });
}

export function tickChannelJob(jobId: string): { totalPaid: number; tickCount: number } | null {
  const state = runningJobs.get(jobId);
  if (!state || !state.isRunning) return null;
  state.tickCount++;
  state.totalPaid = parseFloat((state.tickCount * TICK_AMOUNT_USDC).toFixed(7));
  emit({
    type: 'mpp_tick',
    jobId,
    channelId: state.channelId,
    amount: TICK_AMOUNT_STR,
    totalPaid: state.totalPaid.toFixed(7),
    tickCount: state.tickCount,
  } as never);
  return { totalPaid: state.totalPaid, tickCount: state.tickCount };
}

export function stopChannelJob(jobId: string): ChannelJobState | null {
  const state = runningJobs.get(jobId);
  if (state) {
    state.isRunning = false;
    runningJobs.delete(jobId);
  }
  return state || null;
}

// ── Legacy in-process channel simulation (fallback) ───────────────────────────
// Used only when MPP_ENABLED=false. Kept for reference.

const channels = new Map<string, MPPChannel>();

export async function openChannelLegacy(
  jobId: string,
  clientAccount: string,
  maxBalance: string
): Promise<string> {
  const channelId = uuidv4();
  console.log(`[MPP-MOCK] channel opened channelId=${channelId} job=${jobId} maxBalance=${maxBalance} USDC`);
  channels.set(channelId, {
    channelId, jobId, clientAccount,
    maxBalance, currentBalance: maxBalance,
    openedAt: Date.now(), isOpen: true,
  });
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
    return { success: false, remaining: '0', reason: 'Balance exhausted' };
  }
  const newBalance = (remaining - debit).toFixed(7);
  channel.currentBalance = newBalance;
  channels.set(channelId, channel);
  console.log(`[MPP-MOCK] tick channel=${channelId} debited=${amount} remaining=${newBalance}`);
  return { success: true, remaining: newBalance };
}

export async function closeChannelLegacy(channelId: string): Promise<void> {
  const channel = channels.get(channelId);
  if (!channel) return;
  channel.isOpen = false;
  channels.set(channelId, channel);
  const spent = (parseFloat(channel.maxBalance) - parseFloat(channel.currentBalance)).toFixed(7);
  console.log(`[MPP-MOCK] channel closed channelId=${channelId} spent=${spent} USDC`);
}

export async function closeAllChannels(): Promise<void> {
  for (const [channelId, channel] of channels.entries()) {
    if (channel.isOpen) await closeChannelLegacy(channelId);
  }
  // Stop all running channel jobs
  for (const jobId of runningJobs.keys()) {
    stopChannelJob(jobId);
  }
}
