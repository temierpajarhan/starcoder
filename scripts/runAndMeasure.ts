import 'dotenv/config';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ethers } from 'ethers';

// --- lightweight ERC20 ABI (без зависимостей на локальные файлы)
const ERC20_MINI = [
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function balanceOf(address) view returns (uint256)',
] as const;

// ---- helpers
const sleep = (ms: number) => new Promise(res => setTimeout(res, ms));

function uniq<T>(arr: T[]): T[] {
  const s = new Set<T>(); const out: T[] = [];
  for (const x of arr) { if (!x || s.has(x)) continue; s.add(x); out.push(x); }
  return out;
}

function buildReaders(): ethers.JsonRpcProvider[] {
  const L = uniq([
    process.env.ARBITRUM_RPC,
    process.env.READONLY_RPC,
    process.env.ALCHEMY_KEY ? `https://arb-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_KEY}` : '',
    process.env.INFURA_KEY  ? `https://arbitrum-mainnet.infura.io/v3/${process.env.INFURA_KEY}`   : '',
    'https://arb1.arbitrum.io/rpc',
    'https://arbitrum-one-rpc.publicnode.com',
    'https://arbitrum.blockpi.network/v1/rpc/public',
    'https://arbitrum.drpc.org',
    'https://1rpc.io/arb',
    'https://rpc.ankr.com/arbitrum',
  ]);
  return L.map(u => new ethers.JsonRpcProvider(u, 42161, { staticNetwork: true }));
}

async function waitReceiptWithFallback(txHash: string, confirmations = 1, timeoutMs = 240000) {
  const readers = buildReaders();
  if (!readers.length) throw new Error('no readers');
  const deadline = Date.now() + timeoutMs;

  let lastErr: any = null;
  while (Date.now() < deadline) {
    for (const p of readers) {
      try {
        // быстрый путь: есть receipt?
        const rcpt = await p.getTransactionReceipt(txHash);
        if (rcpt) {
          // достаточно ли подтверждений?
          const head = await p.getBlockNumber();
          if (rcpt.blockNumber && head - Number(rcpt.blockNumber) + 1 >= confirmations) {
            return { provider: p, receipt: rcpt };
          }
        }
      } catch (e: any) {
        lastErr = e;
      }
    }
    await sleep(3000);
  }
  throw lastErr ?? new Error('timeout waiting receipt');
}

function parseArg(args: string[], flag: string, def = ''): string {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
}

async function decodeRevert(provider: ethers.JsonRpcProvider, txHash: string, blockNumber?: number) {
  try {
    const tx = await provider.getTransaction(txHash);
    const targetBlock = blockNumber && blockNumber > 0 ? blockNumber - 1 : 'latest';
    await provider.call({ from: tx!.from, to: tx!.to!, data: tx!.data }, targetBlock as any);
    return null; // не должно случиться, раз был revert
  } catch (e: any) {
    const raw =
      (e?.data && typeof e.data === 'string' && e.data) ||
      (e?.error?.data && typeof e.error.data === 'string' && e.error.data) ||
      (e?.error?.body && JSON.parse(e.error.body)?.error?.data) ||
      '';
    const hex: string = (typeof raw === 'string' ? raw : '') || '';
    const selector = hex.startsWith('0x') ? hex.slice(0, 10) : '';
    let note = '';
    try {
      // Error(string): 0x08c379a0
      if (selector === '0x08c379a0' && hex.length > 10) {
        const reasonHex = '0x' + hex.slice(10);
        const [reason] = ethers.AbiCoder.defaultAbiCoder().decode(['string'], reasonHex);
        note = `Error(string): ${reason}`;
      }
      // Panic(uint256): 0x4e487b71
      if (selector === '0x4e487b71' && hex.length > 10) {
        const codeHex = '0x' + hex.slice(10);
        const [code] = ethers.AbiCoder.defaultAbiCoder().decode(['uint256'], codeHex);
        note = `Panic(${code})`;
      }
    } catch { /* ignore */ }
    return { selector, dataHead: hex.slice(0, 66), note };
  }
}

async function main() {
  const args = process.argv.slice(2);

  const executor = parseArg(args, '--executor');
  const market   = parseArg(args, '--market');
  const loanTok  = parseArg(args, '--loanToken');
  const recip    = parseArg(args, '--recipient');
  if (!executor || !market || !loanTok || !recip) {
    console.error('missing required flags: --executor --market --loanToken --recipient');
    process.exit(2);
  }

  // reader для замеров баланса
  const readers = buildReaders();
  const reader = readers[0];

  // pre-balance
  const erc20 = new ethers.Contract(loanTok, ERC20_MINI, reader);
  const [dec, sym] = await Promise.all([erc20.decimals(), erc20.symbol()]);
  const pre = await erc20.balanceOf(recip);

  // запускаем ТВОЙ runOnce.local.ts
  const child = spawn(process.execPath, ['--loader','ts-node/esm','scripts/runOnce.local.ts', ...args], { stdio: ['ignore', 'pipe', 'pipe'], env: process.env });

  let txHash = '';
  child.stdout.on('data', (b) => {
    const s = b.toString();
    process.stdout.write(s);
    const m = s.match(/Submitted tx:\s*(0x[0-9a-fA-F]{64})/);
    if (m) txHash = m[1];
  });
  child.stderr.on('data', (b) => process.stderr.write(b.toString()));

  const code: number = await new Promise(res => child.on('close', res));
  if (code !== 0 && !txHash) {
    console.error('[runOnce.local] exited with code', code);
    process.exit(code);
  }
  if (!txHash) {
    // Allow preflightGuard to exit(0) without submitting a tx
    console.log('[runAndMeasure] no tx hash found; assuming preflight-only run.');
    process.exit(0);
  }

  // ждём receipt с ретраями и фолбэком на публичные RPC
  let rcpt: ethers.TransactionReceipt | null = null;
  let usedProvider: ethers.JsonRpcProvider | null = null;
  try {
    const r = await waitReceiptWithFallback(txHash, 1, Number(process.env.RECEIPT_TIMEOUT_MS || 240000));
    rcpt = r.receipt; usedProvider = r.provider;
  } catch (e: any) {
    console.error('[waitReceipt] failed:', e?.message || e);
  }

  // если всё же получили receipt — посчитаем всё равно, даже при revert
  let gasCostEth = '0';
  if (rcpt) {
    const gasUsed = rcpt.gasUsed ?? 0n;
    // @ts-ignore
    const gasPrice = (rcpt.effectiveGasPrice ?? rcpt.gasPrice ?? 0n) as bigint;
    gasCostEth = ethers.formatEther(gasUsed * gasPrice);

    // post-balance (через того же reader)
    const post = await erc20.balanceOf(recip);
    const deltaHuman = ethers.formatUnits(post - pre, dec);

    console.log(`GasCost(ETH): ${gasCostEth}`);

    if (rcpt.status === 1) {
      console.log(`Profit(loanToken) delta: ${deltaHuman} ${sym}`);
    } else {
      // печатаем краткую диагностику ревёрта
      
      try {
        const tx = await (usedProvider || reader).getTransaction(txHash);
        await (usedProvider || reader).call({ from: tx.from, to: tx.to!, data: tx.data }, (rcpt.blockNumber ?? 'latest'));
      } catch (e) {
        const raw = (e?.data || e?.error?.data || '').toString();
        const head = raw.slice(0, 66);
        let printed = false;
        try {
          const EXEC_IFACE = new ethers.Interface([
            'error ExternalCallFailed(uint256 index, bytes data)'
          ]);
          const parsed = EXEC_IFACE.parseError(raw);
          const idx = Number(parsed?.args?.[0] ?? -1);
          const inner = (parsed?.args?.[1] ?? '0x').toString();
          const innerSel = inner.startsWith('0x') ? inner.slice(0, 10) : '';
          let note = '';
          if (innerSel === '0x08c379a0') {
            try {
              const STR_IFACE = new ethers.Interface(['error E(string)']);
              const dec = STR_IFACE.parseError(inner);
              note = dec?.args?.[0] ?? '';
            } catch {}
          } else if (innerSel === '0x4e487b71') {
            const codeHex = '0x' + inner.slice(10, 74);
            note = `panic(${BigInt(codeHex).toString()})`;
          }
          console.log(`[reverted] ExternalCallFailed index=${idx} innerSelector=${innerSel} note=${note || '<opaque>'} dataHead=${head}`);
          printed = true
        } catch {}
        if (!printed) {
          console.log(`[reverted] head=${head}`);
        }
      }
      console.log(`Profit(loanToken) delta: ${deltaHuman} ${sym}`);

    }

    // артефакт
    const stamp = new Date().toISOString().replace(/[:.]/g, '').slice(0, 15) + 'Z';
    const outDir = path.join('runs', stamp);
    mkdirSync(outDir, { recursive: true });
    writeFileSync(path.join(outDir, 'run.json'), JSON.stringify({
      chainId: 42161,
      txHash,
      status: rcpt.status,
      blockNumber: rcpt.blockNumber,
      loanToken: loanTok,
      recipient: recip,
      gasCostETH: gasCostEth,
      profitTokenDelta: deltaHuman
    }, null, 2));
    console.log('[RC] written:', path.join(outDir, 'run.json'));
  } else {
    console.log('[warn] no receipt yet. Try setting READONLY_RPC or increasing RECEIPT_TIMEOUT_MS');
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
