import 'dotenv/config';
import { Command } from 'commander';
import { ethers } from 'ethers';
import fs from 'fs';
import path from 'path';
import { getAbiFromArbiscan } from './lib/fetchAbi.js';
import { Erc20Abi, VaultAbi, MarketAbiFrag } from './lib/helpers.js';

const program = new Command();
program
  .requiredOption('--executor <addr>', 'Deployed FlashFloopExecutor')
  .requiredOption('--market <addr>', 'Pendle Market address')
  .requiredOption('--loanToken <addr>', 'Token to borrow (must be accepted by SY w/o aggregator)')
  .requiredOption('--amount <num>', 'Amount to borrow, natural units')
  .option('--loops <n>', 'Internal loops', '1')
  .option('--minProfit <num>', 'Min profit in loanToken', '0')
  .option('--recipient <addr>', 'Where to send leftovers', '')
  .parse(process.argv);
const opts = program.opts();

async function main() {
  const rpc = process.env.ARBITRUM_RPC!;
  const pk = process.env.PRIVATE_KEY!;
  const provider = new ethers.JsonRpcProvider(rpc);
  const wallet = new ethers.Wallet(pk, provider);

  const market = opts.market as string;
  const loanToken = opts.loanToken as string;
  const loops = parseInt(opts.loops);
  const amountHuman = opts.amount as string;
  const minProfitHuman = opts.minProfit as string;
  const recipient = (opts.recipient || wallet.address) as string;

  // Addresses & ABIs
  const cfg = JSON.parse(fs.readFileSync(path.join('config','addresses.arbitrum.json'),'utf8'));
  const routerAddr = cfg.arbitrum.pendleRouterV3 as string;
  const routerAbi = await getAbiFromArbiscan(routerAddr);
  const marketAbi = await getAbiFromArbiscan(market);

  const marketRead = new ethers.Contract(market, MarketAbiFrag, provider);
  const [SY, PT, YT] = await marketRead.readTokens();

  const loanErc = new ethers.Contract(loanToken, Erc20Abi, provider);
  const dec = await loanErc.decimals();
  const amount = ethers.parseUnits(amountHuman, dec);
  const minProfit = ethers.parseUnits(minProfitHuman, dec);

  const executor = new ethers.Contract(opts.executor, [
    'function execute((address[],bytes[],address,uint256,uint256,address)) external',
    'function owner() view returns (address)'
  ], wallet);

  // Build calldata batch for N loops
  const router = new ethers.Contract(routerAddr, routerAbi, provider);
  const approxZero = { guessMin: 0, guessMax: 0, guessOffchain: 0, maxIteration: 0, eps: 0 };
  const emptyLimitTuple = [ethers.ZeroAddress, 0, [], [], "0x"] as const;
  const zeroSwapDataTuple = [0, ethers.ZeroAddress, "0x", false] as const;

  const targets: string[] = [];
  const datas: string[] = [];

  let curIn = amount;

  for (let i = 0; i < loops; i++) {
    // Approve router to spend loanToken and PT (idempotent)
    targets.push(loanToken);
    datas.push(new ethers.Interface(Erc20Abi).encodeFunctionData('approve', [routerAddr, ethers.MaxUint256]));
    targets.push(PT);
    datas.push(new ethers.Interface(Erc20Abi).encodeFunctionData('approve', [routerAddr, ethers.MaxUint256]));

    // mint PY from token (no aggregator)
    const tokenInputTuple = [
      loanToken,
      curIn,
      SY,
      ethers.ZeroAddress,
      zeroSwapDataTuple
    ];
    targets.push(routerAddr);
    datas.push(new ethers.Interface(routerAbi).encodeFunctionData('mintPyFromToken', [
      opts.executor, // mint PT & YT to executor itself (holds balances for subsequent sells)
      YT,
      0,
      tokenInputTuple
    ]));

    // preview net PY (PT amount) for swap leg
    const [netPyOut] = await router.mintPyFromToken.staticCall(
      opts.executor,
      YT,
      0,
      tokenInputTuple,
      { value: 0 }
    );

    // sell PT → token
    const tokenOutTuple = [
      loanToken,
      0,
      SY,
      ethers.ZeroAddress,
      zeroSwapDataTuple
    ];
    targets.push(routerAddr);
    datas.push(new ethers.Interface(routerAbi).encodeFunctionData('swapExactPtForToken', [
      wallet.address, market, netPyOut, tokenOutTuple, emptyLimitTuple
    ]));

    // OPTIONAL: sell leftover YT to cover any tiny fee/rounding; leave to user for now.
    // For fully automatic coverage, you could encode 'swapExactYtForToken' here as well.
  }

  // Assemble flash plan (as tuple for ABI without component names)
  const planTuple = [
    targets,
    datas,
    loanToken,
    amount,
    minProfit,
    recipient
  ] as const;

  const tx = await executor.execute(planTuple);
  console.log('Submitted tx:', tx.hash);
  const rc = await tx.wait();
  console.log('Mined in block', rc.blockNumber);
}

main().catch(e => { console.error(e); process.exit(1); });
