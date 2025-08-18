// scripts/lib/abiLocal.ts
// Minimal ABI fragments sufficient for runOnce operations.
// Avoids fetching ABIs from Arbiscan to prevent network failures.
export function getRouterAbi(_addr: string) {
  return [
    // returns (uint256 netPyOut)
    "function mintPyFromToken(address receiver,address YT,uint256 minPyOut,(address tokenIn,uint256 netTokenIn,address tokenMintSy,address pendleSwap,(uint8 swapType,address extRouter,bytes extCalldata,bool needScale) swapData) tokenInput) returns (uint256)",
    // returns (uint256 netTokenOut)
    "function swapExactPtForToken(address receiver,address market,uint256 exactPtIn,(address tokenOut,uint256 minTokenOut,address tokenRedeemSy,address pendleSwap,(uint8 swapType,address extRouter,bytes extCalldata,bool needScale) swapData) tokenOut,(address limitRouter,uint256 epsSkipMarket,tuple[] normalFills,tuple[] flashFills,bytes optData) limit) returns (uint256)"
  ];
}

export function getMarketAbi(_addr: string) {
  return [
    "function readTokens() view returns (address SY,address PT,address YT)"
  ];
}
