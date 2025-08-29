import 'dotenv/config';
import { ethers } from 'ethers';
import fs from 'node:fs';
import path from 'node:path';
import { getArbProvider } from './lib/provider.js';
import routerStaticAbi from '../abi/routerstatic.min.json' assert { type: 'json' };
import { PENDLE_MARKET_ABI } from './lib/abi.js';

// fee = 0 per project agreement. Keep ENV override (bps) if set.
function getFlashBps(): bigint {
  return BigInt(process.env.FLASHLOAN_FEE_OVERRIDE_BPS || '0');
}

async function main(){
  const provider = await getArbProvider();
  const rsAddr = (process.env.ROUTER_STATIC || '0xadb09f65bd90d19e3148d9ccb693f3161c6db3e8').toLowerCase();
  const routerStatic = new ethers.Contract(rsAddr, routerStaticAbi as any, provider);
  const cfgPath = process.argv[2] || 'config/candidate-markets.arbitrum.json';
  const cfg = JSON.parse(await fs.promises.readFile(cfgPath,'utf8'));
  const markets: string[] = Array.isArray(cfg.arbitrum) ? cfg.arbitrum : (cfg.markets || []);
  const loanToken = (cfg.loanToken as string) || '0x5979D7b546E38E414F7E9822514be443A4800529';
  const decimals = Number(cfg.decimals || 18);
  const amountList: string[] = Array.isArray(cfg.amounts) && cfg.amounts.length > 0 ? cfg.amounts : [String(cfg.amount || '0.10')];
  const bps = getFlashBps();

  const rows:any[] = [];
  for (const amountHuman of amountList) {
    const amountWei = ethers.parseUnits(String(amountHuman), decimals);
    for (const m of markets){
      try{
        // Read SY from market
        const marketRead = new ethers.Contract(m, PENDLE_MARKET_ABI as any, provider);
        const [SY] = await marketRead.readTokens();
        const syOut: bigint = await routerStatic.mintSyFromTokenStatic(SY, loanToken, amountWei);
        if (syOut === 0n) { rows.push({ amount: amountHuman, market:m, error:'mintSyFromTokenStatic==0' }); continue; }
        const ptOutRes = await routerStatic.swapExactSyForPtStatic(m, syOut);
        const ptOut: bigint = Array.isArray(ptOutRes) ? BigInt(ptOutRes[0] ?? 0) : BigInt(ptOutRes || 0);
        if (ptOut === 0n) { rows.push({ amount: amountHuman, market:m, syOut:syOut.toString(), error:'swapExactSyForPtStatic==0' }); continue; }
        const tokOutRes = await routerStatic.swapExactPtForTokenStatic(m, ptOut, loanToken);
        const tokOut: bigint = Array.isArray(tokOutRes) ? BigInt(tokOutRes[0] ?? 0) : BigInt(tokOutRes || 0);
        const fee = (amountWei * bps) / 10000n;
        const margin = tokOut - amountWei - fee;
        rows.push({ amount: amountHuman, market:m, syOut:syOut.toString(), ptOut:ptOut.toString(), tokOut:tokOut.toString(), flashFeeBps:bps.toString(), flashFeeWei:fee.toString(), margin:margin.toString() });
      }catch(e:any){
        rows.push({ amount: amountHuman, market:m, error: String(e && e.message || e) });
      }
    }
  }
  rows.sort((a,b)=> (BigInt(b.margin||'0') - BigInt(a.margin||'0')) as any);
  const ts = new Date().toISOString().replace(/[:.]/g,'').slice(0,15)+'Z';
  const outDir = path.join('runs', ts);
  await fs.promises.mkdir(outDir, { recursive:true }).catch(()=>{});
  const meta = { chainId: 42161, routerStatic: rsAddr, loanToken, decimals, amounts: amountList, flashFeeBps: bps.toString() };
  await fs.promises.writeFile(path.join(outDir,'scan.json'), JSON.stringify({ meta, rows }, null, 2));
  console.table(rows.slice(0,5));
  console.log('[SCAN] written:', path.join(outDir,'scan.json'));
}

main().catch(e=>{ console.error(e); process.exit(1); });

