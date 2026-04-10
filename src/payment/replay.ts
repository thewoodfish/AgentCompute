interface ReplayEntry {
  txHash: string;
  addedAt: number;
}

const TTL_MS = 10 * 60 * 1000; // 10 minutes
const cache = new Map<string, ReplayEntry>();

function cleanup(): void {
  const now = Date.now();
  for (const [hash, entry] of cache.entries()) {
    if (now - entry.addedAt > TTL_MS) {
      cache.delete(hash);
    }
  }
}

// Run cleanup every 2 minutes
setInterval(cleanup, 2 * 60 * 1000);

export function add(txHash: string): void {
  cache.set(txHash, { txHash, addedAt: Date.now() });
}

export function has(txHash: string): boolean {
  const entry = cache.get(txHash);
  if (!entry) return false;
  if (Date.now() - entry.addedAt > TTL_MS) {
    cache.delete(txHash);
    return false;
  }
  return true;
}
