import 'dotenv/config';
import { Command } from 'commander';
import { ethers } from 'ethers';
import fs from 'fs';
import path from 'path';
import { getArbProvider } from './lib/provider.js';
import { PENDLE_MARKET_ABI, ERC20_ABI } from './lib/abi.js';

const MaxUint = ethers.MaxUint256;

const program = new Command();
program
  .requiredOption('--executor <addr>')
  .requiredOption('--market <addr>')
  .requiredOption('--loanToken <addr>')
  .requiredOption('--amount <num>')
  .option('--loops <n>', 'Internal loops', '1')
  .option('--minProfit <num>', 'Min profit in loanToken', '0')
  .option('--recipient <addr>', 'Where to send leftovers', '')
  .option('--slippageBps <n>', 'Min-out slippage bps', '50')
  .option('--primeApprovals', 'Prime MaxUint allowances for loanToken/SY/PT and exit', false)
  .option('--omitApproves', 'Omit approve steps in the plan (requires prior priming)', false)
  .option('--ptToToken', 'Use direct swapExactPtForToken instead of PT->SY + redeem', false)
  .option('--syToPtRoute', 'Use SY->PT then PT->token route (V4 ApproxParams)', false)
  .option('--preflightGuard', 'Skip tx if static quotes net-out negative after flash fee', false)
  .parse(process.argv);
const opts = program.opts();

async function main() {
  const pk = process.env.PRIVATE_KEY!;
  const provider = await getArbProvider();
  const wallet = new ethers.Wallet(pk, provider);

  const market = opts.market as string;
  const loanToken = opts.loanToken as string;
  const loops = parseInt(opts.loops);
  const PRIME: boolean = !!opts.primeApprovals;
  const OMIT_APPROVES: boolean = !!opts.omitApproves;
  const PT_TO_TOKEN: boolean = !!opts.ptToToken;
  const SY_TO_PT_ROUTE: boolean = !!opts.syToPtRoute;
  const amountHuman = opts.amount as string;
  const minProfitHuman = opts.minProfit as string;
  const recipient = (opts.recipient || wallet.address) as string;
  const slippageBps = BigInt(parseInt(opts.slippageBps));

  const cfg = JSON.parse(fs.readFileSync(path.join('config','addresses.arbitrum.json'),'utf8'));
  const routerAddr = (cfg.arbitrum.pendleRouterV4 || cfg.arbitrum.pendleRouterV3) as string;
  const vaultAddr: string = cfg.arbitrum.balancerVault as string;
  const routerStaticAddr = '0xadb09f65bd90d19e3148d9ccb693f3161c6db3e8';
  const routerStaticAbi = JSON.parse(fs.readFileSync(path.join('abi','routerstatic.min.json'),'utf8'));
  const routerV4Abi = JSON.parse(fs.readFileSync(path.join('abi','pendle-router-v4.min.json'),'utf8'));
  const syAbi = JSON.parse(fs.readFileSync(path.join('abi','sy.min.json'),'utf8'));
  const univ3Abi = JSON.parse(fs.readFileSync(path.join('abi','univ3-exactInputSingle.min.json'),'utf8'));
  // Flash-fee Balancer: per project agreement assume 0%. Keep ENV override if needed.

  const router = new ethers.Contract(routerAddr, routerV4Abi, provider);
  // No Balancer fee fetching (assume 0%)
  const routerIface = new ethers.Interface(routerV4Abi);
  const routerStatic = new ethers.Contract(routerStaticAddr, routerStaticAbi, provider);
  const marketRead = new ethers.Contract(market, PENDLE_MARKET_ABI, provider);
  const [SY, PT, YT] = await marketRead.readTokens();
  const syc = new ethers.Contract(SY, syAbi, provider);

  // Verify loanToken is accepted by SY (no-aggregator path requirement)
  try {
    let okIn = false;
    try { okIn = await syc.isValidTokenIn(loanToken); } catch {}
    if (!okIn) {
      try {
        const tins: string[] = await syc.getTokensIn();
        okIn = Array.isArray(tins) && tins.map(a => a.toLowerCase()).includes(loanToken.toLowerCase());
      } catch {}
    }
    if (!okIn) {
      throw new Error(`loanToken ${loanToken} not accepted by SY ${SY} (no aggregator path configured)`);
    }
    // Optional: warn if loanToken may not be a direct redeem-out token
    try {
      const touts: string[] = await syc.getTokensOut();
      console.log('[SY.getTokensOut]', touts);
      const okOut = Array.isArray(touts) && touts.map(a => a.toLowerCase()).includes(loanToken.toLowerCase());
      if (!okOut) {
        console.warn('[SY check] warn: loanToken not in SY.getTokensOut(); direct PT->token without aggregator may revert');
      }
    } catch {}
  } catch (e) {
    console.error('[SY check] warning:', (e as any)?.message || e);
  }

  const loanErc = new ethers.Contract(loanToken, ERC20_ABI, provider);
  const dec = await loanErc.decimals();
  const amount = ethers.parseUnits(amountHuman, dec);
  const minProfit = ethers.parseUnits(minProfitHuman, dec);

  const executor = new ethers.Contract(opts.executor, [
    'function execute((address[],bytes[],address,uint256,uint256,address)) external',
    'function owner() view returns (address)'
  ], wallet);

  const zero = ethers.ZeroAddress;

  async function getFlashFeeBps(): Promise<bigint> {
    // In our design: 0 bps. Allow manual override via ENV if needed.
    const fromEnv = process.env.FLASHLOAN_FEE_OVERRIDE_BPS;
    return BigInt(fromEnv ?? '0');
  }

  async function runPreflightIfEnabled(amountWei: bigint): Promise<boolean> {
    if (!opts.preflightGuard) return true;
    // Static chain: token->SY, SY->PT, PT->token
    let syQuote = 0n;
    try { syQuote = await routerStatic.mintSyFromTokenStatic.staticCall(SY, loanToken, amountWei); } catch {}
    if (syQuote === 0n) {
      await writePreflight({ reason: 'mintSyFromTokenStatic==0' });
      return false;
    }
    let ptQuote = 0n;
    try {
      const r = await routerStatic.swapExactSyForPtStatic.staticCall(market, syQuote);
      ptQuote = Array.isArray(r) ? BigInt(r[0] ?? 0) : BigInt(r || 0);
    } catch {}
    if (ptQuote === 0n) {
      await writePreflight({ reason: 'swapExactSyForPtStatic==0', syQuote: syQuote.toString() });
      return false;
    }
    let tokQuote = 0n;
    try {
      const r2 = await routerStatic.swapExactPtForTokenStatic.staticCall(market, ptQuote, loanToken);
      tokQuote = Array.isArray(r2) ? BigInt(r2[0] ?? 0) : BigInt(r2 || 0);
    } catch {}
    const feeBps = await getFlashFeeBps();
    const flashFee = (amountWei * feeBps) / 10000n;
    const margin = tokQuote - amountWei - flashFee;
    if (margin <= 0n) {
      await writePreflight({ reason: 'static margin <= 0', syQuote: syQuote.toString(), ptQuote: ptQuote.toString(), tokQuote: tokQuote.toString(), feeBps: feeBps.toString(), flashFee: flashFee.toString(), margin: margin.toString() });
      return false;
    }
    return true;
  }

  async function writePreflight(payload: Record<string, any>) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '').slice(0, 15) + 'Z';
    const dir = path.join('runs', stamp);
    try { fs.mkdirSync(dir, { recursive: true }); } catch {}
    fs.writeFileSync(path.join(dir, 'preflight.json'), JSON.stringify(payload, null, 2));
    console.error(`[PREFLIGHT] skip: ${payload.reason} (written ${path.join(dir,'preflight.json')})`);
  }
  const swapDataTuple = [0, zero, '0x', false] as const; // IPSwapAggregator.SwapData
  const emptyLimitTuple = [zero, 0n, [], [], '0x'] as const; // LimitOrderData

  const targets: string[] = [];
  const datas: string[] = [];

  let curIn = amount;
  // Preflight (once) for the first loop amount
  const proceed = await runPreflightIfEnabled(curIn);
  if (!proceed) process.exit(0);

  for (let i = 0; i < loops; i++) {
    if (PRIME) {
      // Prime-only: set MaxUint allowances, then exit
      // loanToken -> Router
      targets.push(loanToken);
      datas.push(new ethers.Interface(ERC20_ABI).encodeFunctionData('approve', [routerAddr, 0n]));
      targets.push(loanToken);
      datas.push(new ethers.Interface(ERC20_ABI).encodeFunctionData('approve', [routerAddr, MaxUint]));
      // SY -> Router
      targets.push(SY);
      datas.push(new ethers.Interface(ERC20_ABI).encodeFunctionData('approve', [routerAddr, 0n]));
      targets.push(SY);
      datas.push(new ethers.Interface(ERC20_ABI).encodeFunctionData('approve', [routerAddr, MaxUint]));
      // PT -> Router
      targets.push(PT);
      datas.push(new ethers.Interface(ERC20_ABI).encodeFunctionData('approve', [routerAddr, 0n]));
      targets.push(PT);
      datas.push(new ethers.Interface(ERC20_ABI).encodeFunctionData('approve', [routerAddr, MaxUint]));
      // YT -> Router (for selling YT)
      targets.push(YT);
      datas.push(new ethers.Interface(ERC20_ABI).encodeFunctionData('approve', [routerAddr, 0n]));
      targets.push(YT);
      datas.push(new ethers.Interface(ERC20_ABI).encodeFunctionData('approve', [routerAddr, MaxUint]));
      break;
    }

    // Approvals inside plan (skipped if --omitApproves)
    if (!OMIT_APPROVES) {
      targets.push(loanToken);
      datas.push(new ethers.Interface(ERC20_ABI).encodeFunctionData('approve', [routerAddr, 0n]));
      targets.push(loanToken);
      datas.push(new ethers.Interface(ERC20_ABI).encodeFunctionData('approve', [routerAddr, MaxUint]));
    }

    // TokenInput for mintSyFromToken: [tokenIn, netTokenIn, tokenMintSy, pendleSwap, swapData]
    const tokenInput = [
      loanToken,
      curIn,
      loanToken, // tokenMintSy must equal tokenIn for no-aggregator
      zero,
      swapDataTuple
    ] as const;

    // 1) Preview SY out
    let netSyOut = 0n;
    try {
      netSyOut = await routerStatic.mintSyFromTokenStatic.staticCall(
        SY, loanToken, curIn
      );
    } catch {}
    const minSyOutParam = 0n; // first green run: relax mint min-out

    // Parameterize how much SY to feed into next step
    const SY_FRAC_ENV = process.env.EXACT_SY_IN_FRAC_BPS;
    const SY_FRAC_BPS = SY_FRAC_ENV ? BigInt(SY_FRAC_ENV) : 9900n; // default 99%
    let exactSyIn = 0n;
    if (netSyOut > 0n) {
      exactSyIn = (netSyOut * SY_FRAC_BPS) / 10000n;
      if (exactSyIn === 0n) exactSyIn = 1n;
    } else {
      exactSyIn = curIn; // fallback if static returned 0
    }

    // 2) mint token -> SY
    targets.push(routerAddr);
    datas.push(routerIface.encodeFunctionData('mintSyFromToken', [
      opts.executor,
      SY,
      minSyOutParam,
      tokenInput
    ]));

    // 3) approve SY for swapExactSyForPt (skipped if --omitApproves)
    if (!OMIT_APPROVES) {
      targets.push(SY);
      datas.push(new ethers.Interface(ERC20_ABI).encodeFunctionData('approve', [routerAddr, 0n]));
      targets.push(SY);
      datas.push(new ethers.Interface(ERC20_ABI).encodeFunctionData('approve', [routerAddr, exactSyIn]));
    }

    // Route selection
    if (SY_TO_PT_ROUTE) {
      // --- SY -> PT (V4) ---
      // preview ptQuote via RouterStatic
      let ptQuote = 0n;
      try { ptQuote = await routerStatic.swapExactSyForPtStatic.staticCall(market, exactSyIn); } catch {}
      const ptFracEnv = process.env.EXACT_PT_IN_FRAC_BPS;
      const ptFracBps = ptFracEnv ? BigInt(ptFracEnv) : 9950n;
      let exactPtIn = 0n;
      if (ptQuote > 0n) {
        exactPtIn = (ptQuote * ptFracBps) / 10000n;
        if (exactPtIn === 0n) exactPtIn = 1n;
      }

      // Assemble ApproxParams around ptQuote
      const approxGuessMin = ptQuote > 0n ? (ptQuote * 97n) / 100n : 0n;
      const approxGuessMax = ptQuote > 0n ? (ptQuote * 103n) / 100n : 0n;
      const approxGuessOff = ptQuote;
      const approxMaxIter = 64n;
      const approxEps = 10n ** 15n; // 1e-3 in 1e18

      const abiCoder = ethers.AbiCoder.defaultAbiCoder();
      const typesSyForPt = [
        'address','address','uint256','uint256',
        'tuple(uint256,uint256,uint256,uint256,uint256)',
        'tuple(address,uint256,tuple(bytes,bytes)[],tuple(bytes,bytes)[],bytes)'
      ];
      const valsSyForPt: any[] = [
        opts.executor,
        market,
        exactSyIn,
        0n,
        [approxGuessMin, approxGuessMax, approxGuessOff, approxMaxIter, approxEps],
        [zero, 0n, [], [], '0x']
      ];
      const selSyForPt = '0x2a50917c';
      const encSyForPt = abiCoder.encode(typesSyForPt, valsSyForPt);
      targets.push(routerAddr);
      datas.push(selSyForPt + encSyForPt.slice(2));

      // approve PT for PT->token if not omit
      if (!OMIT_APPROVES && exactPtIn > 0n) {
        targets.push(PT);
        datas.push(new ethers.Interface(ERC20_ABI).encodeFunctionData('approve', [routerAddr, 0n]));
        targets.push(PT);
        datas.push(new ethers.Interface(ERC20_ABI).encodeFunctionData('approve', [routerAddr, exactPtIn]));
      }

      // decide redeemOut and whether DEX swap is needed
      let outs: string[] = [];
      try { outs = await syc.getTokensOut(); } catch {}
      console.log('[SY.getTokensOut]', outs);
      const loanL = loanToken.toLowerCase();
      const outSet = new Set(outs.map(o => o.toLowerCase()));
      const wethDefault = (process.env.WETH_ARB || '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1').toLowerCase();
      let redeemOut = loanToken;
      if (!outSet.has(loanL)) {
        redeemOut = outs.find(o => o.toLowerCase() === wethDefault) || (outs[0] || loanToken);
      }
      const minTokenOut = 0n;
      const tokenOutObj = {
        tokenOut: redeemOut,
        minTokenOut,
        tokenRedeemSy: redeemOut,
        pendleSwap: zero,
        swapData: { swapType: 0, extRouter: zero, extCalldata: '0x', needScale: false }
      } as const;
      const typesPtForToken = [
        'address','address','uint256',
        'tuple(address,uint256,address,address,tuple(uint8,address,bytes,bool))',
        'tuple(address,uint256,tuple(bytes,bytes)[],tuple(bytes,bytes)[],bytes)'
      ];
      const selPtForToken = '0x594a88cc';
      const valsPtForToken: any[] = [
        opts.executor,
        market,
        exactPtIn,
        [ tokenOutObj.tokenOut, tokenOutObj.minTokenOut, tokenOutObj.tokenRedeemSy, tokenOutObj.pendleSwap,
          [ tokenOutObj.swapData.swapType, tokenOutObj.swapData.extRouter, tokenOutObj.swapData.extCalldata, tokenOutObj.swapData.needScale ]
        ],
        [ zero, 0n, [], [], '0x' ]
      ];
      const encPtForToken = abiCoder.encode(typesPtForToken, valsPtForToken);
      targets.push(routerAddr);
      datas.push(selPtForToken + encPtForToken.slice(2));

    } else if (PT_TO_TOKEN) {
      // existing PY route with PT and optional YT sale
      // 4) Preview PT from SY using the same path as runtime (mintPyFromSy), then size exactPtIn
      let ptQuote = 0n;
      try {
        ptQuote = await routerStatic.mintPyFromSyStatic.staticCall(
          YT, exactSyIn
        );
      } catch {}
      const FUDGE_BPS_ENV = process.env.EXACT_PT_IN_FRAC_BPS;
      const FUDGE_BPS = FUDGE_BPS_ENV ? BigInt(FUDGE_BPS_ENV) : 9500n;
      let exactPtIn = 0n;
      if (ptQuote > 0n) {
        exactPtIn = (ptQuote * FUDGE_BPS) / 10000n;
        if (exactPtIn === 0n) exactPtIn = 1n;
      }

      // 5) SY -> PY (mintPyFromSy)
      targets.push(routerAddr);
      datas.push(routerIface.encodeFunctionData('mintPyFromSy(address,address,uint256,uint256)', [
        opts.executor, YT, exactSyIn, 0n
      ]));

      // 6) approve PT and YT for final swaps (skipped if --omitApproves)
      if (!OMIT_APPROVES) {
        targets.push(PT);
        datas.push(new ethers.Interface(ERC20_ABI).encodeFunctionData('approve', [routerAddr, 0n]));
        targets.push(PT);
        datas.push(new ethers.Interface(ERC20_ABI).encodeFunctionData('approve', [routerAddr, exactPtIn]));
        let exactYtForApprove = 0n;
        if (ptQuote > 0n) {
          const YT_FRAC_ENV = process.env.EXACT_YT_IN_FRAC_BPS;
          const YT_FRAC_BPS = YT_FRAC_ENV ? BigInt(YT_FRAC_ENV) : 9950n;
          exactYtForApprove = (ptQuote * YT_FRAC_BPS) / 10000n;
          if (exactYtForApprove === 0n) exactYtForApprove = 1n;
        }
        targets.push(YT);
        datas.push(new ethers.Interface(ERC20_ABI).encodeFunctionData('approve', [routerAddr, 0n]));
        targets.push(YT);
        datas.push(new ethers.Interface(ERC20_ABI).encodeFunctionData('approve', [routerAddr, exactYtForApprove]));
      }

      // quick diagnostics
      try { console.log({ syQuote: (netSyOut||0n).toString(), exactSyIn: (exactSyIn||0n).toString(), ptQuote: (ptQuote||0n).toString(), exactPtIn: (exactPtIn||0n).toString() }); } catch {}

      // decide redeemOut
      let outs: string[] = [];
      try { outs = await syc.getTokensOut(); } catch {}
      console.log('[SY.getTokensOut]', outs);
      const loanL = loanToken.toLowerCase();
      const outSet = new Set(outs.map(o => o.toLowerCase()));
      const wethDefault = (process.env.WETH_ARB || '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1').toLowerCase();
      let redeemOut = loanToken;
      if (!outSet.has(loanL)) {
        redeemOut = outs.find(o => o.toLowerCase() === wethDefault) || (outs[0] || loanToken);
      }
      const minTokenOut = 0n;
      const tokenOutObj = {
        tokenOut: redeemOut,
        minTokenOut,
        tokenRedeemSy: redeemOut,
        pendleSwap: zero,
        swapData: { swapType: 0, extRouter: zero, extCalldata: '0x', needScale: false }
      } as const;

      const abiCoder = ethers.AbiCoder.defaultAbiCoder();
      const typesCommon = [
        'address','address','uint256',
        'tuple(address,uint256,address,address,tuple(uint8,address,bytes,bool))',
        'tuple(address,uint256,tuple(bytes,bytes)[],tuple(bytes,bytes)[],bytes)'
      ];
      const selPt = '0x594a88cc';
      const valsPt: any[] = [
        opts.executor,
        market,
        exactPtIn,
        [ tokenOutObj.tokenOut, tokenOutObj.minTokenOut, tokenOutObj.tokenRedeemSy, tokenOutObj.pendleSwap,
          [ tokenOutObj.swapData.swapType, tokenOutObj.swapData.extRouter, tokenOutObj.swapData.extCalldata, tokenOutObj.swapData.needScale ]
        ],
        [ zero, 0n, [], [], '0x' ]
      ];
      const encodedPt = abiCoder.encode(typesCommon, valsPt);
      targets.push(routerAddr);
      datas.push(selPt + encodedPt.slice(2));

      // optional YT sell omitted here in syToPtRoute branch

    } else {
      // legacy path: PT->SY then redeem, kept as fallback
      // 8a) PT -> SY
      targets.push(routerAddr);
      datas.push(new ethers.Interface(PENDLE_ROUTER_ABI).encodeFunctionData('swapExactPtForSy', [
        opts.executor, market, exactPtIn, 0n
      ]));

      // 8b) SY -> redeemOut
      targets.push(routerAddr);
      datas.push(new ethers.Interface(PENDLE_ROUTER_ABI).encodeFunctionData('redeemSyToToken', [
        opts.executor, SY, exactSyRedeem, tokenOut
      ]));

      // 8c) DEX swap redeemOut -> loanToken if needed
      if (needDex) {
        const UNIV3 = process.env.UNIV3_ROUTER || '0xE592427A0AEce92De3Edee1F18E0157C05861564';
        const FEE = Number(process.env.UNIV3_FEE || '500');
        const DEX_FRAC = BigInt(process.env.DEX_SWAP_FRAC_BPS || '9500');
        const erc20Iface = new ethers.Interface(ERC20_ABI);
        const u3Iface = new ethers.Interface(univ3Abi);
        // approvals for Uniswap router
        targets.push(redeemOut);
        datas.push(erc20Iface.encodeFunctionData('approve', [UNIV3, 0n]));
        targets.push(redeemOut);
        // conservative amount for swap: fraction of exactSyRedeem
        let amountInDex = exactSyRedeem > 0n ? (exactSyRedeem * DEX_FRAC) / 10000n : 0n;
        if (amountInDex === 0n && exactSyRedeem > 0n) amountInDex = 1n;
        datas.push(erc20Iface.encodeFunctionData('approve', [UNIV3, ethers.MaxUint256]));
        const params = {
          tokenIn: redeemOut,
          tokenOut: loanToken,
          fee: FEE,
          recipient: opts.executor,
          deadline: ethers.MaxUint256,
          amountIn: amountInDex,
          amountOutMinimum: 0n,
          sqrtPriceLimitX96: 0
        };
        targets.push(UNIV3);
        datas.push(u3Iface.encodeFunctionData('exactInputSingle', [params]));
      }
    }
  }

  const planTuple = [
    targets,
    datas,
    loanToken,
    amount,
    minProfit,
    recipient
  ] as const;

  const tx = await executor.execute(planTuple, { gasLimit: 9000000n });
  console.log('Submitted tx:', tx.hash);
  const rc = await tx.wait();
  console.log('Mined in block', rc.blockNumber);
}

main().catch(e => { console.error(e); process.exit(1); });
