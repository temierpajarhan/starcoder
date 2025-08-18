import { JsonRpcProvider, WebSocketProvider, Provider } from 'ethers';
import dns from 'node:dns';
import { setGlobalDispatcher, ProxyAgent } from 'undici';

// IPv4 priority
try { (dns as any).setDefaultResultOrder?.('ipv4first'); } catch {}

// HTTPS proxy (for HTTP-RPC and fetch/undici)
const httpsProxy = process.env.HTTPS_PROXY || process.env.https_proxy || '';
if (httpsProxy) {
  try { setGlobalDispatcher(new ProxyAgent(httpsProxy)); } catch {}
}

const ARB_CHAIN_ID_HEX = '0xa4b1'; // 42161
const TIMEOUT_MS = Number(process.env.RPC_PROBE_TIMEOUT_MS || 6000);

async function probeHttp(url: string): Promise<boolean> {
  try {
    const ctrl = new AbortController();
    const id = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
      signal: ctrl.signal,
    });
    clearTimeout(id);
    const json: any = await res.json();
    return typeof json.result === 'string' && json.result.toLowerCase() === ARB_CHAIN_ID_HEX;
  } catch {
    return false;
  }
}

async function probeWs(url: string): Promise<boolean> {
  try {
    const provider = new WebSocketProvider(url);
    const chainIdHex = await provider.send('eth_chainId', []);
    provider.destroy();
    return typeof chainIdHex === 'string' && chainIdHex.toLowerCase() === ARB_CHAIN_ID_HEX;
  } catch {
    return false;
  }
}

export async function getArbProvider(): Promise<Provider> {
  // === 1) PRIVATE HTTP: env → Alchemy → Infura
  const privHttp: string[] = [];
  if (process.env.ARBITRUM_RPC) privHttp.push(process.env.ARBITRUM_RPC);
  if (process.env.ALCHEMY_KEY) privHttp.push(`https://arb-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_KEY}`);
  if (process.env.INFURA_KEY)  privHttp.push(`https://arbitrum-mainnet.infura.io/v3/${process.env.INFURA_KEY}`);

  const seen1 = new Set<string>();
  const listPrivHttp = privHttp.filter(u => u && !seen1.has(u) && seen1.add(u));
  for (const url of listPrivHttp) {
    if (await probeHttp(url)) {
      console.log('[provider] HTTP (private) using', url);
      return new JsonRpcProvider(url, 42161, { staticNetwork: true });
    }
  }

  // === 2) PRIVATE WSS: env → Alchemy → Infura
  const privWss: string[] = [];
  if (process.env.ARBITRUM_WSS) privWss.push(process.env.ARBITRUM_WSS);
  if (process.env.ALCHEMY_KEY) privWss.push(`wss://arb-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_KEY}`);
  if (process.env.INFURA_KEY)  privWss.push(`wss://arbitrum-mainnet.infura.io/ws/v3/${process.env.INFURA_KEY}`);

  const seen2 = new Set<string>();
  const listPrivWss = privWss.filter(u => u && !seen2.has(u) && seen2.add(u));
  for (const url of listPrivWss) {
    if (await probeWs(url)) {
      console.log('[provider] WSS (private) using', url);
      return new WebSocketProvider(url, 42161);
    }
  }

  // === 3) PUBLIC HTTP: fallback
  const pubHttp: string[] = [
    'https://arb1.arbitrum.io/rpc',
    'https://arbitrum-one-rpc.publicnode.com',
    'https://arbitrum.blockpi.network/v1/rpc/public',
    'https://arbitrum.drpc.org',
    'https://1rpc.io/arb',
    'https://rpc.ankr.com/arbitrum',
  ];
  const seen3 = new Set<string>();
  const listPubHttp = pubHttp.filter(u => u && !seen3.has(u) && seen3.add(u));
  for (const url of listPubHttp) {
    if (await probeHttp(url)) {
      console.log('[provider] HTTP (public) using', url);
      return new JsonRpcProvider(url, 42161, { staticNetwork: true });
    }
  }

  // === 4) PUBLIC WSS: fallback
  const pubWss: string[] = [
    'wss://arbitrum-one-rpc.publicnode.com',
    'wss://arbitrum.blockpi.network/v1/ws/public',
    'wss://arbitrum.drpc.org',
  ];
  const seen4 = new Set<string>();
  const listPubWss = pubWss.filter(u => u && !seen4.has(u) && seen4.add(u));
  for (const url of listPubWss) {
    if (await probeWs(url)) {
      console.log('[provider] WSS (public) using', url);
      return new WebSocketProvider(url, 42161);
    }
  }

  throw new Error('No reachable Arbitrum RPC (private HTTP/WSS or public HTTP/WSS). Set ALCHEMY_KEY/INFURA_KEY or ARBITRUM_RPC/WSS.');
}
