// scripts/lib/locks.ts
import fs from 'fs';
import path from 'path';

const ROOT = path.join(process.cwd(), '.locks');
if (!fs.existsSync(ROOT)) fs.mkdirSync(ROOT, { recursive: true });

export async function withLock<T>(name: string, fn: () => Promise<T>, timeoutMs = 60_000): Promise<T> {
  const file = path.join(ROOT, name + '.lock');
  const start = Date.now();
  while (true) {
    try {
      const fd = fs.openSync(file, 'wx'); // exclusive create
      try {
        const res = await fn();
        return res;
      } finally {
        try { fs.closeSync(fd); } catch {}
        try { fs.unlinkSync(file); } catch {}
      }
    } catch (e) {
      if (Date.now() - start > timeoutMs) throw new Error(`Lock timeout: ${name}`);
      await new Promise(r => setTimeout(r, 150)); // small backoff
    }
  }
}
