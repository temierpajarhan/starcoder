// scripts/lib/ratelimit.ts
export function qpsLimiter(qps: number) {
  const windowMs = 1000;
  const times: number[] = [];
  async function limit() {
    const now = Date.now();
    while (times.length && now - times[0] >= windowMs) times.shift();
    if (times.length >= qps) {
      const waitMs = windowMs - (now - times[0]) + 1;
      await new Promise(r => setTimeout(r, waitMs));
      return limit();
    }
    times.push(Date.now());
  }
  return limit;
}

const QPS = Number(process.env.RPC_QPS || '10'); // default 10 req/s
export const rpcLimit = qpsLimiter(QPS);

export async function withRpc<T>(fn: () => Promise<T>): Promise<T> {
  await rpcLimit();
  return fn();
}
