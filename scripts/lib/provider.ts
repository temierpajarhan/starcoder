import { JsonRpcProvider, WebSocketProvider, Provider } from 'ethers';
import dns from 'node:dns';
import { setGlobalDispatcher, ProxyAgent } from 'undici';

try { (dns as any).setDefaultResultOrder?.('ipv4first'); } catch {}

const httpsProxy = process.env.HTTPS_PROXY || process.env.https_proxy || '';
if (httpsProxy) { try { setGlobalDispatcher(new ProxyAgent(httpsProxy)); } catch {} }

const ARB_CHAIN_ID_HEX = '0xa4b1';
const TIMEOUT_MS = Number(process.env.RPC_PROBE_TIMEOUT_MS || 6000);

async function probeHttp(url: string){ try{
  const ac=new AbortController(); const t=setTimeout(()=>ac.abort(),TIMEOUT_MS);
  const r=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({jsonrpc:'2.0',id:1,method:'eth_chainId',params:[]}),signal:ac.signal});
  clearTimeout(t); const j:any=await r.json().catch(()=>({}));
  return !!(j&&(j.result===ARB_CHAIN_ID_HEX||j.result==='0xA4B1'));
}catch{return false}}

async function probeWs(url: string){ try{
  const p=new WebSocketProvider(url,42161);
  const ac=new AbortController(); const t=setTimeout(()=>ac.abort(),TIMEOUT_MS);
  await p.getNetwork(); clearTimeout(t); p.destroy(); return true;
}catch{return false}}

export async function getArbProvider(): Promise<Provider> {
  // 1) PRIVATE HTTP
  const privHttp = [process.env.ARBITRUM_RPC,
    process.env.ALCHEMY_KEY?`https://arb-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_KEY}`:'',
    process.env.INFURA_KEY? `https://arbitrum-mainnet.infura.io/v3/${process.env.INFURA_KEY}`:''
  ].filter(Boolean) as string[];
  for (const u of [...new Set(privHttp)]) if (await probeHttp(u)) {
    console.log('[provider] HTTP (private) using', u); return new JsonRpcProvider(u,42161,{staticNetwork:true});
  }

  // 2) PRIVATE WSS
  const privWss = [process.env.ARBITRUM_WSS,
    process.env.ALCHEMY_KEY?`wss://arb-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_KEY}`:'',
    process.env.INFURA_KEY? `wss://arbitrum-mainnet.infura.io/ws/v3/${process.env.INFURA_KEY}`:''
  ].filter(Boolean) as string[];
  for (const u of [...new Set(privWss)]) if (await probeWs(u)) {
    console.log('[provider] WSS (private) using', u); return new WebSocketProvider(u,42161);
  }

  // 3) PUBLIC HTTP
  const pubHttp = [
    'https://arb1.arbitrum.io/rpc',
    'https://arbitrum-one-rpc.publicnode.com',
    'https://arbitrum.blockpi.network/v1/rpc/public',
    'https://arbitrum.drpc.org',
    'https://1rpc.io/arb',
    'https://rpc.ankr.com/arbitrum'
  ];
  for (const u of pubHttp) if (await probeHttp(u)) {
    console.log('[provider] HTTP (public) using', u); return new JsonRpcProvider(u,42161,{staticNetwork:true});
  }

  // 4) PUBLIC WSS
  const pubWss = [
    'wss://arbitrum-one-rpc.publicnode.com',
    'wss://arbitrum.blockpi.network/v1/ws/public',
    'wss://arbitrum.drpc.org'
  ];
  for (const u of pubWss) if (await probeWs(u)) {
    console.log('[provider] WSS (public) using', u); return new WebSocketProvider(u,42161);
  }

  throw new Error('No reachable Arbitrum RPC (private/public HTTP/WSS). Set ALCHEMY_KEY/INFURA_KEY or ARBITRUM_RPC/WSS or HTTPS_PROXY.');
}

