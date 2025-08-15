import 'dotenv/config';
import { Command } from 'commander';
import { ethers } from 'ethers';
import fs from 'fs';
import path from 'path';
import { getAbiFromArbiscan } from './lib/fetchAbi.js';
import { Erc20Abi, MarketAbiFrag, fromBase } from './lib/helpers.js';

const program = new Command();
program
  .requiredOption('--market <addr>', 'Pendle Market address (e.g., wstETH 24 Jun 2026)')
  .requiredOption('--loanToken <addr>', 'Token to borrow (must be accepted by market SY without aggregator, e.g., wstETH)')
  .requiredOption('--amount <num>', 'Amount to borrow, in natural units')
  .option('--loops <n>', 'Number of internal loops', '1')
  .option('--slippageBps <n>', 'Min out slippage bps for sells', '50')
  .parse(process.argv);
const opts = program.opts();

async function main() {
  const rpc = process.env.ARBITRUM_RPC!;
  const provider = new ethers.JsonRpcProvider(rpc);

  const market = opts.market as string;
  const loanToken = opts.loanToken as string;
  const loops = parseInt(opts.loops);
  const amountHuman = opts.amount as string;
  const slipBps = parseInt(opts.slippageBps);

  // Fetch ABIs
  const routerAddr = JSON.parse(fs.readFileSync(path.join('config','addresses.arbitrum.json'),'utf8')).arbitrum.pendleRouterV3 as string;
  const routerAbi = await getAbiFromArbiscan(routerAddr);
  const marketAbi = await getAbiFromArbiscan(market);

  const marketRead = new ethers.Contract(market, MarketAbiFrag, provider);
  const [SY, PT, YT] = await marketRead.readTokens();

  const loanErc = new ethers.Contract(loanToken, Erc20Abi, provider);
  const loanDec = await loanErc.decimals();
  const amount = ethers.parseUnits(amountHuman, loanDec);

  const router = new ethers.Contract(routerAddr, routerAbi, provider);
  const mk = new ethers.Contract(market, marketAbi, provider);

  // Build a single-loop static quote:
  // 1) mint PY from TOKEN (no aggregator: tokenIn = loanToken, tokenMintSy = SY, pendleSwap = 0, swapData empty)
  // 2) sell exact PT for TOKEN
  // 3) if shortfall > 0, sell some YT for TOKEN to cover

  // Helper structs (typed as plain JS objects; ethers v6 encodes them per ABI)
  const approxZero = { guessMin: 0, guessMax: 0, guessOffchain: 0, maxIteration: 0, eps: 0 };
  const emptyLimit = { limitRouter: ethers.ZeroAddress, epsSkipMarket: 0, normalFills: [], flashFills: [], optData: "0x" };
  const zeroSwapData = { swapType: 0, extRouter: ethers.ZeroAddress, extCalldata: "0x", needScale: false };

  let netLoanIn = amount;
  let totalExpectedProfit = 0n;

  for (let i = 0; i < loops; i++) {
    // 1) preview mint PY from token
    const tokenInput = {
      tokenIn: loanToken,
      netTokenIn: netLoanIn,
      tokenMintSy: SY,
      pendleSwap: ethers.ZeroAddress,
      swapData: zeroSwapData
    };
    // NOTE: ethers callStatic requires a signer or provider; using provider ok for static
    const [netPyOut/*, netSyInterm*/] = await router.callStatic.mintPyFromToken(
      ethers.ZeroAddress, // receiver ignored in static
      YT,
      0,
      tokenInput,
      { value: 0 }
    );

    // 2) preview sell PT -> TOKEN
    const tokenOut = {
      tokenOut: loanToken,
      minTokenOut: 0,
      tokenRedeemSy: SY,
      pendleSwap: ethers.ZeroAddress,
      swapData: zeroSwapData
    };
    const netTokenOutPT = await router.callStatic.swapExactPtForToken(
      ethers.ZeroAddress,
      market,
      netPyOut,
      tokenOut,
      emptyLimit
    );

    // Assume fee=0 for Balancer (docs). Your gas will be the only cost here.
    const shortfall = netLoanIn - netTokenOutPT > 0 ? (netLoanIn - netTokenOutPT) : 0n;
    let soldYt = 0n, netTokenOutYT = 0n;
    if (shortfall > 0n) {
      // sell minimal YT to cover shortfall (binary step: try shortfall, else double, else cap to netPyOut)
      let tryIn = shortfall;
      if (tryIn > netPyOut) tryIn = netPyOut;
      netTokenOutYT = await router.callStatic.swapExactYtForToken(
        ethers.ZeroAddress,
        market,
        tryIn,
        tokenOut,
        emptyLimit
      );
      if (netTokenOutYT < shortfall) {
        // coarse top-up: sell all YT
        tryIn = netPyOut;
        netTokenOutYT = await router.callStatic.swapExactYtForToken(
          ethers.ZeroAddress, market, tryIn, tokenOut, emptyLimit
        );
      }
      soldYt = tryIn;
    }

    const netBack = netTokenOutPT + netTokenOutYT;
    const loopProfit = netBack > netLoanIn ? (netBack - netLoanIn) : 0n;
    totalExpectedProfit += loopProfit;

    // For next loop, reuse the returned TOKEN (principal only)
    netLoanIn = netBack;
    console.log(`Loop #${i+1}: minted PY=${netPyOut}, sold PT→token=${netTokenOutPT}, sold YT=${soldYt}→token=${netTokenOutYT}, loopProfit=${loopProfit}`);
  }

  console.log('Total expected profit (raw):', fromBase(totalExpectedProfit, loanDec), await loanErc.symbol());
}

main().catch(e => { console.error(e); process.exit(1); });
