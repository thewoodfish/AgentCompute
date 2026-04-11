import { EventEmitter } from 'events';

export interface AppEvent {
  type: 'job_request' | 'payment_verified' | 'job_start' | 'job_complete' | 'job_error';
  timestamp: number;
  job?: string;
  jobId?: string;
  price?: string;
  txHash?: string;
  amount?: string;
  duration_ms?: number;
  success?: boolean;
  error?: string;
}

const bus = new EventEmitter();
bus.setMaxListeners(200);

export const eventBus = bus;
export const EVENT_CHANNEL = 'event';

export function emit(data: Omit<AppEvent, 'timestamp'>): void {
  bus.emit(EVENT_CHANNEL, { ...data, timestamp: Date.now() });
}
