import 'dotenv/config';
import fetch from 'node-fetch';

// Minimal fallbacks to avoid blocking when ARBISCAN_API_KEY is missing.
// Covers Pendle Router V3 functions used by runOnce and a minimal Market ABI.
const PENDLE_ROUTER_FALLBACK_ABI = [
  {
    type: 'function',
    name: 'mintPyFromToken',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'receiver', type: 'address' },
      { name: 'yt', type: 'address' },
      { name: 'minPyOut', type: 'uint256' },
      {
        name: 'tokenInput', type: 'tuple', components: [
          { name: 'tokenIn', type: 'address' },
          { name: 'netTokenIn', type: 'uint256' },
          { name: 'tokenMintSy', type: 'address' },
          { name: 'pendleSwap', type: 'address' },
          {
            name: 'swapData', type: 'tuple', components: [
              { name: 'swapType', type: 'uint8' },
              { name: 'extRouter', type: 'address' },
              { name: 'extCalldata', type: 'bytes' },
              { name: 'needScale', type: 'bool' }
            ]
          }
        ]
      }
    ],
    outputs: [
      { name: 'netPyOut', type: 'uint256' },
      { name: 'netSyInterm', type: 'uint256' }
    ]
  },
  {
    type: 'function',
    name: 'swapExactPtForToken',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'receiver', type: 'address' },
      { name: 'market', type: 'address' },
      { name: 'exactPtIn', type: 'uint256' },
      {
        name: 'tokenOut', type: 'tuple', components: [
          { name: 'tokenOut', type: 'address' },
          { name: 'minTokenOut', type: 'uint256' },
          { name: 'tokenRedeemSy', type: 'address' },
          { name: 'pendleSwap', type: 'address' },
          {
            name: 'swapData', type: 'tuple', components: [
              { name: 'swapType', type: 'uint8' },
              { name: 'extRouter', type: 'address' },
              { name: 'extCalldata', type: 'bytes' },
              { name: 'needScale', type: 'bool' }
            ]
          }
        ]
      },
      {
        name: 'limit', type: 'tuple', components: [
          { name: 'limitRouter', type: 'address' },
          { name: 'epsSkipMarket', type: 'uint256' },
          { name: 'normalFills', type: 'tuple[]', components: [
            { name: 'key', type: 'bytes32' },
            { name: 'value', type: 'uint256' }
          ] },
          { name: 'flashFills', type: 'tuple[]', components: [
            { name: 'key', type: 'bytes32' },
            { name: 'value', type: 'uint256' }
          ] },
          { name: 'optData', type: 'bytes' }
        ]
      }
    ],
    outputs: [ { name: 'netTokenOut', type: 'uint256' } ]
  },
  {
    type: 'function',
    name: 'swapExactYtForToken',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'receiver', type: 'address' },
      { name: 'market', type: 'address' },
      { name: 'exactYtIn', type: 'uint256' },
      {
        name: 'tokenOut', type: 'tuple', components: [
          { name: 'tokenOut', type: 'address' },
          { name: 'minTokenOut', type: 'uint256' },
          { name: 'tokenRedeemSy', type: 'address' },
          { name: 'pendleSwap', type: 'address' },
          {
            name: 'swapData', type: 'tuple', components: [
              { name: 'swapType', type: 'uint8' },
              { name: 'extRouter', type: 'address' },
              { name: 'extCalldata', type: 'bytes' },
              { name: 'needScale', type: 'bool' }
            ]
          }
        ]
      },
      {
        name: 'limit', type: 'tuple', components: [
          { name: 'limitRouter', type: 'address' },
          { name: 'epsSkipMarket', type: 'uint256' },
          { name: 'normalFills', type: 'tuple[]', components: [
            { name: 'key', type: 'bytes32' },
            { name: 'value', type: 'uint256' }
          ] },
          { name: 'flashFills', type: 'tuple[]', components: [
            { name: 'key', type: 'bytes32' },
            { name: 'value', type: 'uint256' }
          ] },
          { name: 'optData', type: 'bytes' }
        ]
      }
    ],
    outputs: [ { name: 'netTokenOut', type: 'uint256' } ]
  }
];

const PENDLE_MARKET_MIN_ABI = [
  'function readTokens() view returns (address SY, address PT, address YT)'
];

export async function getAbiFromArbiscan(address: string): Promise<any> {
  const apiKey = process.env.ARBISCAN_API_KEY || '';
  const url = `https://api.arbiscan.io/api?module=contract&action=getabi&address=${address}&apikey=${apiKey}`;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Arbiscan HTTP ${res.status}`);
    const j = await res.json();
    if (j.status !== '1') throw new Error(`Arbiscan error: ${j.result}`);
    return JSON.parse(j.result);
  } catch (e) {
    // Fallbacks
    const addr = address.toLowerCase();
    const pendleRouter = (process.env.PENDLE_ROUTER_V3 || '0x00000000005BBB0eF59571E58418F9A4357B68A0').toLowerCase();
    if (addr === pendleRouter) return PENDLE_ROUTER_FALLBACK_ABI;
    // Assume non-router target is a Pendle Market; return minimal ABI sufficient for readTokens
    return PENDLE_MARKET_MIN_ABI;
  }
}
