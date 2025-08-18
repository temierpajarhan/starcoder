import 'dotenv/config';
import { Command } from 'commander';
import { ethers } from 'ethers';
import fs from 'fs';
import path from 'path';
import { Erc20Abi } from './lib/helpers';
import { getRouterAbi, getMarketAbi } from './lib/abiLocal';
import { withRpc } from './lib/ratelimit';
import { withLock } from './lib/locks';

const program = new Command();
program
  .requiredOption('--executor <addr>', 'Deployed FlashFloopExecutor')
  .requiredOption('--market <addr>', 'Pendle Market address')
  .requiredOption('--loanToken <addr>', 'Token to borrow (must be accepted by SY w/o aggregator)')
  .requiredOption('--amount <num>', 'Amount to borrow, natural units')
  .option('--loops <n>', 'Internal loops', '1')
  .option('--minProfit <num>', 'Min profit in loanToken', '0')
  .option('--recipient <addr>', 'Where to send leftovers', '')
  .option('--slippageBps <n>', 'Slippage bps for PT->loanToken minOut', '50')
  .parse(process.argv);
const opts = program.opts();

function bpsMulFloor(x: bigint, bps: number) {
  const bp = BigInt(10_000 - bps);
  return x * bp / 10_000n;
}

async function main() {
  if (!process.env.ARBITRUM_RPC) throw new Error('ARBITRUM_RPC env var required');
  if (!process.env.PRIVATE_KEY) throw new Error('PRIVATE_KEY env var required');
  const rpc = process.env.ARBITRUM_RPC;
  const pk = process.env.PRIVATE_KEY;
  const provider = new ethers.JsonRpcProvider(rpc);
  const wallet = new ethers.Wallet(pk, provider);

  const chainIdHex = await withRpc(() => provider.send('eth_chainId', []));
  if (chainIdHex !== '0xa4b1') throw new Error(`Wrong network ${chainIdHex}, expected 0xa4b1`);

  const market = (opts.market as string).toLowerCase();
  const loanToken = (opts.loanToken as string).toLowerCase();
  const loops = parseInt(opts.loops);
  const amountHuman = opts.amount as string;
  const minProfitHuman = opts.minProfit as string;
  const slippageBps = parseInt(opts.slippageBps);
  const recipient = (opts.recipient || wallet.address) as string;

  // addresses / ABIs
  const cfg = JSON.parse(fs.readFileSync(path.join('config','addresses.arbitrum.json'),'utf8'));
  const routerAddr = (cfg.arbitrum.pendleRouterV3 as string).toLowerCase();
  const routerAbi = getRouterAbi(routerAddr);
  const marketAbi = getMarketAbi(market);

  const marketRead = new ethers.Contract(market, marketAbi, provider);
  const [SY, PT, YT] = await withRpc(async () => marketRead.readTokens());

  // optional GLP/GMX block based on token symbol
  const syErc = new ethers.Contract(SY, Erc20Abi, provider);
  const sySym = await withRpc(() => syErc.symbol());
  if (process.env.GLP_OK !== '1' && /GLP|GMX/i.test(sySym)) {
    throw new Error('GLP/GMX markets disabled; set GLP_OK=1 to override');
  }

  const loanErc = new ethers.Contract(loanToken, Erc20Abi, provider);
  const dec = await withRpc(() => loanErc.decimals());
  const amount = ethers.parseUnits(amountHuman, dec);
  const minProfit = ethers.parseUnits(minProfitHuman, dec);

  const executor = new ethers.Contract(opts.executor, [
    'function execute((address[],bytes[],address,uint256,uint256,address)) external',
    'function owner() view returns (address)'
  ], wallet);

  const router = new ethers.Contract(routerAddr, routerAbi, provider);
  const emptyLimit = { limitRouter: ethers.ZeroAddress, epsSkipMarket: 0, normalFills: [], flashFills: [], optData: "0x" };
  const zeroSwapData = { swapType: 0, extRouter: ethers.ZeroAddress, extCalldata: "0x", needScale: false };

  async function ensureCode(addr: string, name: string) {
    const code = await withRpc(() => provider.getCode(addr));
    if (code === '0x') throw new Error(`No contract code for ${name} at ${addr}`);
  }

  await ensureCode(opts.executor, 'executor');
  await ensureCode(market, 'market');
  await ensureCode(routerAddr, 'router');
  await ensureCode(loanToken, 'loanToken');

  const targets: string[] = [];
  const datas: string[] = [];

  // idempotent approve
  targets.push(loanToken);
  datas.push(new ethers.Interface(Erc20Abi).encodeFunctionData('approve', [routerAddr, ethers.MaxUint256]));

  let curIn = amount;
  for (let i = 0; i < loops; i++) {
    // 1) view: mint PY quote
    const tokenInput = {
      tokenIn: loanToken,
      netTokenIn: curIn,
      tokenMintSy: SY,
      pendleSwap: ethers.ZeroAddress,
      swapData: zeroSwapData
    };
    const [netPyOut] = await withRpc(async () =>
      router.callStatic.mintPyFromToken(ethers.ZeroAddress, YT, 0, tokenInput, { value: 0 })
    );

    // 2) view: PT -> loanToken quote
    const tokenOutPT = {
      tokenOut: loanToken,
      minTokenOut: 0,
      tokenRedeemSy: SY,
      pendleSwap: ethers.ZeroAddress,
      swapData: zeroSwapData
    };
    const quotePTOut = await withRpc(async () =>
      router.callStatic.swapExactPtForToken(ethers.ZeroAddress, market, netPyOut, tokenOutPT, emptyLimit)
    );
    const minOutPT = bpsMulFloor(quotePTOut, slippageBps);

    // 3) encode actual calls with minOut
    targets.push(routerAddr);
    datas.push(new ethers.Interface(routerAbi).encodeFunctionData('mintPyFromToken', [
      wallet.address, YT, 0, tokenInput
    ]));

    const tokenOutExec = {
      tokenOut: loanToken,
      minTokenOut: minOutPT,
      tokenRedeemSy: SY,
      pendleSwap: ethers.ZeroAddress,
      swapData: zeroSwapData
    };
    targets.push(routerAddr);
    datas.push(new ethers.Interface(routerAbi).encodeFunctionData('swapExactPtForToken', [
      wallet.address, market, netPyOut, tokenOutExec, emptyLimit
    ]));

    // next loop will use minOutPT as principal for conservative chaining
    curIn = minOutPT;
  }

  const plan = {
    targets,
    calldatas: datas,
    loanToken,
    loanAmount: amount,
    minProfit,
    profitRecipient: recipient
  };

  // pre balances (for profit log)
  const preToken = await withRpc(() => loanErc.balanceOf(recipient));
  const preEth   = await withRpc(() => provider.getBalance(wallet.address));
  const runTs = Date.now().toString();
  const runDir = path.join('runs', runTs);
  fs.mkdirSync(runDir, { recursive: true });
  const runFile = path.join(runDir, 'run.json');
  const runLog: any = {
    timestamp: new Date().toISOString(),
    args: { executor: opts.executor, market, loanToken, amount: amountHuman, loops, minProfit: minProfitHuman, slippageBps, recipient }
  };

  const nonceKey  = `nonce-${wallet.address.toLowerCase()}`;
  const marketKey = `mkt-${market}-${loanToken}`;

  try {
    await withLock(marketKey, async () => {
      await withLock(nonceKey, async () => {
        const tx = await executor.execute(plan);
        console.log('Submitted tx:', tx.hash);
        runLog.txHash = tx.hash;
        const rc = await tx.wait();
        runLog.blockNumber = rc.blockNumber;
        console.log('Mined in block', rc.blockNumber);

        const postToken = await withRpc(() => loanErc.balanceOf(recipient));
        const postEth   = await withRpc(() => provider.getBalance(wallet.address));

        const tokenDelta = postToken - preToken;
        const gasCostWei = rc.gasUsed * (rc.effectiveGasPrice ?? 0n);
        const gasEth     = ethers.formatEther(gasCostWei);
        const ethDelta   = postEth - preEth;
        runLog.profitToken = tokenDelta.toString();
        runLog.ethDeltaWei = ethDelta.toString();
        runLog.gasUsed = rc.gasUsed.toString();
        runLog.gasCostWei = gasCostWei.toString();
        runLog.gasCostEth = gasEth;
        console.log(`Profit(loanToken) delta: ${tokenDelta.toString()}`);
        console.log(`GasCost(ETH): ${gasEth}`);
      });
    });
  } catch (e: any) {
    runLog.error = e?.message || String(e);
    throw e;
  } finally {
    fs.writeFileSync(runFile, JSON.stringify(runLog, null, 2));
  }
}

main().catch(e => { console.error(e); process.exit(1); });
