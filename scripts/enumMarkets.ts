import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { ethers } from 'ethers';
import { getArbProvider } from './lib/provider.js';
import { PENDLE_MARKET_ABI } from './lib/abi.js';

// Minimal ABIs for common factory patterns
const FACTORY_ABI_A = [
  { type: 'function', stateMutability: 'view', name: 'allMarketsLength', inputs: [], outputs: [{ name: '', type: 'uint256' }] },
  { type: 'function', stateMutability: 'view', name: 'allMarkets', inputs: [{ name: '', type: 'uint256' }], outputs: [{ name: '', type: 'address' }] },
] as const;

const FACTORY_ABI_B = [
  { type: 'function', stateMutability: 'view', name: 'getMarkets', inputs: [{ name: 'offset', type: 'uint256' }, { name: 'limit', type: 'uint256' }], outputs: [{ name: '', type: 'address[]' }] },
] as const;

async function main(){
  const args = process.argv.slice(2);
  const get = (flag: string, def = '') => { const i = args.indexOf(flag); return i>=0 && args[i+1] ? args[i+1] : def; };

  const provider = await getArbProvider();

  const addrCfgPath = path.join('config','addresses.arbitrum.json');
  const addrCfg = fs.existsSync(addrCfgPath) ? JSON.parse(fs.readFileSync(addrCfgPath,'utf8')) : { arbitrum: {} };
  const factoryArg = get('--factory');
  const factory = (factoryArg || addrCfg?.arbitrum?.pendleMarketFactory || '').toString();
  if (!factory) {
    console.error('Missing --factory and addresses.arbitrum.json.arbitrum.pendleMarketFactory. Please supply a factory address.');
    process.exit(2);
  }

  const outPath = get('--out', path.join('config','candidate-markets.arbitrum.json'));
  const limit = Number(get('--limit','500'));

  // Determine loanToken from existing candidate config or addresses sample
  let loanToken = '';
  try {
    const cand = JSON.parse(fs.readFileSync(outPath,'utf8'));
    loanToken = cand.loanToken || addrCfg?.arbitrum?.sample?.wstETH || '';
  } catch {
    loanToken = addrCfg?.arbitrum?.sample?.wstETH || '';
  }
  const wantLoanToken = (get('--loanToken', loanToken) || '').toString();

  const syAbi = JSON.parse(fs.readFileSync(path.join('abi','sy.min.json'),'utf8'));

  // Try ABI A then B
  let markets: string[] = [];
  try {
    const facA = new ethers.Contract(factory, FACTORY_ABI_A, provider);
    const len: bigint = await facA.allMarketsLength();
    const n = Math.min(Number(len), limit);
    for (let i=0;i<n;i++) { const a = await facA.allMarkets(i); markets.push(a); }
  } catch {
    try {
      const facB = new ethers.Contract(factory, FACTORY_ABI_B, provider);
      let off = 0; const page = 200; // safe default
      while (markets.length < limit) {
        const batch: string[] = await facB.getMarkets(off, page);
        if (!batch || batch.length === 0) break;
        markets.push(...batch);
        off += batch.length;
      }
    } catch (e:any) {
      console.error('Failed to enumerate markets via known factory ABIs. Provide correct factory ABI/address. Error:', e?.message || e);
      process.exit(2);
    }
  }

  // Dedup
  markets = Array.from(new Set(markets.map(m => m.toLowerCase())));

  // Filter: non-expired and optionally SY accepts loanToken
  const kept: string[] = [];
  for (const m of markets) {
    try {
      const market = new ethers.Contract(m, PENDLE_MARKET_ABI as any, provider);
      // @ts-ignore
      const expired: boolean = await market.isExpired();
      if (expired) continue;
      const [SY] = await market.readTokens();
      if (wantLoanToken) {
        const sy = new ethers.Contract(SY, syAbi, provider);
        let okIn = false;
        try { okIn = await sy.isValidTokenIn(wantLoanToken); } catch {}
        if (!okIn) {
          try {
            const tins: string[] = await sy.getTokensIn();
            okIn = Array.isArray(tins) && tins.map(a => a.toLowerCase()).includes(wantLoanToken.toLowerCase());
          } catch {}
        }
        if (!okIn) continue;
      }
      kept.push(m);
    } catch {}
  }

  // Prepare output JSON
  let base = { arbitrum: [] as string[], loanToken: wantLoanToken || loanToken, amount: '0.10', decimals: 18 };
  try { const prev = JSON.parse(fs.readFileSync(outPath,'utf8')); base = { ...base, ...prev }; } catch {}

  base.arbitrum = Array.from(new Set([...(base.arbitrum||[]).map((x:string)=>x.toLowerCase()), ...kept]));

  // Backup and write
  try { fs.copyFileSync(outPath, outPath + '.bak'); } catch {}
  fs.writeFileSync(outPath, JSON.stringify(base, null, 2));

  console.log(`[ENUM] found=${markets.length} kept=${kept.length} written: ${outPath}`);
}

main().catch(e=>{ console.error(e); process.exit(1); });
