// Local ABIs for Pendle Router V3, Pendle Market, and ERC20
// Exported as JS values to avoid JSON import quirks under ts-node ESM

export const PENDLE_ROUTER_ABI = [
  {
    type: 'function',
    stateMutability: 'payable',
    name: 'mintSyFromToken',
    inputs: [
      { name: 'receiver', type: 'address', internalType: 'address' },
      { name: 'SY', type: 'address', internalType: 'address' },
      { name: 'minSyOut', type: 'uint256', internalType: 'uint256' },
      {
        name: 'input', type: 'tuple', internalType: 'struct ActionBaseMintRedeem.TokenInput', components: [
          { name: 'tokenIn', type: 'address', internalType: 'address' },
          { name: 'netTokenIn', type: 'uint256', internalType: 'uint256' },
          { name: 'tokenMintSy', type: 'address', internalType: 'address' },
          { name: 'pendleSwap', type: 'address', internalType: 'address' },
          {
            name: 'swapData', type: 'tuple', internalType: 'struct IPSwapAggregator.SwapData', components: [
              { name: 'swapType', type: 'uint8', internalType: 'uint8' },
              { name: 'extRouter', type: 'address', internalType: 'address' },
              { name: 'extCalldata', type: 'bytes', internalType: 'bytes' },
              { name: 'needScale', type: 'bool', internalType: 'bool' }
            ]
          }
        ]
      }
    ],
    outputs: [ { name: 'netSyOut', type: 'uint256', internalType: 'uint256' } ]
  },
  {
    type: 'function',
    stateMutability: 'nonpayable',
    name: 'mintPyFromSy',
    inputs: [
      { name: 'receiver', type: 'address', internalType: 'address' },
      { name: 'YT', type: 'address', internalType: 'address' },
      { name: 'netSyIn', type: 'uint256', internalType: 'uint256' },
      { name: 'minPyOut', type: 'uint256', internalType: 'uint256' }
    ],
    outputs: [ { name: 'netPyOut', type: 'uint256', internalType: 'uint256' } ]
  },
  {
    type: 'function',
    stateMutability: 'nonpayable',
    name: 'swapExactSyForPt',
    inputs: [
      { name: 'receiver', type: 'address', internalType: 'address' },
      { name: 'market', type: 'address', internalType: 'address' },
      { name: 'exactSyIn', type: 'uint256', internalType: 'uint256' },
      { name: 'minPtOut', type: 'uint256', internalType: 'uint256' },
      {
        name: 'guessPtOut', type: 'tuple', internalType: 'struct ApproxParams', components: [
          { name: 'guessMin', type: 'uint256', internalType: 'uint256' },
          { name: 'guessMax', type: 'uint256', internalType: 'uint256' },
          { name: 'guessOffchain', type: 'uint256', internalType: 'uint256' },
          { name: 'maxIteration', type: 'uint256', internalType: 'uint256' },
          { name: 'eps', type: 'uint256', internalType: 'uint256' }
        ]
      }
    ],
    outputs: [
      { name: 'netPtOut', type: 'uint256', internalType: 'uint256' },
      { name: 'netSyFee', type: 'uint256', internalType: 'uint256' }
    ]
  },
  {
    type: 'function',
    stateMutability: 'nonpayable',
    name: 'swapExactPtForToken',
    inputs: [
      { name: 'receiver', type: 'address', internalType: 'address' },
      { name: 'market', type: 'address', internalType: 'address' },
      { name: 'exactPtIn', type: 'uint256', internalType: 'uint256' },
      {
        name: 'tokenOut', type: 'tuple', internalType: 'struct ActionBaseMintRedeem.TokenOutput', components: [
          { name: 'tokenOut', type: 'address', internalType: 'address' },
          { name: 'minTokenOut', type: 'uint256', internalType: 'uint256' },
          { name: 'tokenRedeemSy', type: 'address', internalType: 'address' },
          { name: 'pendleSwap', type: 'address', internalType: 'address' },
          {
            name: 'swapData', type: 'tuple', internalType: 'struct IPSwapAggregator.SwapData', components: [
              { name: 'swapType', type: 'uint8', internalType: 'uint8' },
              { name: 'extRouter', type: 'address', internalType: 'address' },
              { name: 'extCalldata', type: 'bytes', internalType: 'bytes' },
              { name: 'needScale', type: 'bool', internalType: 'bool' }
            ]
          }
        ]
      },
      {
        name: 'limit', type: 'tuple', internalType: 'struct LimitOrderData', components: [
          { name: 'limitRouter', type: 'address', internalType: 'address' },
          { name: 'epsSkipMarket', type: 'uint256', internalType: 'uint256' },
          { name: 'normalFills', type: 'tuple[]', internalType: 'struct KeyValuePair[]', components: [
            { name: 'key', type: 'bytes32', internalType: 'bytes32' },
            { name: 'value', type: 'uint256', internalType: 'uint256' }
          ] },
          { name: 'flashFills', type: 'tuple[]', internalType: 'struct KeyValuePair[]', components: [
            { name: 'key', type: 'bytes32', internalType: 'bytes32' },
            { name: 'value', type: 'uint256', internalType: 'uint256' }
          ] },
          { name: 'optData', type: 'bytes', internalType: 'bytes' }
        ]
      }
    ],
    outputs: [ { name: 'netTokenOut', type: 'uint256', internalType: 'uint256' } ]
  },
  {
    type: 'function',
    stateMutability: 'nonpayable',
    name: 'swapExactPtForSy',
    inputs: [
      { name: 'receiver', type: 'address', internalType: 'address' },
      { name: 'market', type: 'address', internalType: 'address' },
      { name: 'exactPtIn', type: 'uint256', internalType: 'uint256' },
      { name: 'minSyOut', type: 'uint256', internalType: 'uint256' }
    ],
    outputs: [
      { name: 'netSyOut', type: 'uint256', internalType: 'uint256' },
      { name: 'netSyFee', type: 'uint256', internalType: 'uint256' }
    ]
  },
  {
    type: 'function',
    stateMutability: 'nonpayable',
    name: 'redeemSyToToken',
    inputs: [
      { name: 'receiver', type: 'address', internalType: 'address' },
      { name: 'SY', type: 'address', internalType: 'address' },
      { name: 'exactSyIn', type: 'uint256', internalType: 'uint256' },
      {
        name: 'output', type: 'tuple', internalType: 'struct ActionBaseMintRedeem.TokenOutput', components: [
          { name: 'tokenOut', type: 'address', internalType: 'address' },
          { name: 'minTokenOut', type: 'uint256', internalType: 'uint256' },
          { name: 'tokenRedeemSy', type: 'address', internalType: 'address' },
          { name: 'pendleSwap', type: 'address', internalType: 'address' },
          {
            name: 'swapData', type: 'tuple', internalType: 'struct IPSwapAggregator.SwapData', components: [
              { name: 'swapType', type: 'uint8', internalType: 'uint8' },
              { name: 'extRouter', type: 'address', internalType: 'address' },
              { name: 'extCalldata', type: 'bytes', internalType: 'bytes' },
              { name: 'needScale', type: 'bool', internalType: 'bool' }
            ]
          }
        ]
      }
    ],
    outputs: [
      { name: 'netTokenOut', type: 'uint256', internalType: 'uint256' },
      { name: 'netSyFee', type: 'uint256', internalType: 'uint256' }
    ]
  }
];

export const PENDLE_MARKET_ABI = [
  { type: 'function', stateMutability: 'view', name: 'readTokens', inputs: [], outputs: [
    { name: '_SY', type: 'address', internalType: 'address' },
    { name: '_PT', type: 'address', internalType: 'address' },
    { name: '_YT', type: 'address', internalType: 'address' }
  ]},
  { type: 'function', stateMutability: 'view', name: 'isExpired', inputs: [], outputs: [{ name: '', type: 'bool', internalType: 'bool' }]},
  { type: 'function', stateMutability: 'view', name: 'expiry', inputs: [], outputs: [{ name: '', type: 'uint256', internalType: 'uint256' }]}
];

export const ERC20_ABI = [
  { type: 'function', stateMutability: 'view', name: 'decimals', inputs: [], outputs: [{ name: '', type: 'uint8' }] },
  { type: 'function', stateMutability: 'view', name: 'symbol', inputs: [], outputs: [{ name: '', type: 'string' }] },
  { type: 'function', stateMutability: 'view', name: 'balanceOf', inputs: [{ name: 'account', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] },
  { type: 'function', stateMutability: 'nonpayable', name: 'approve', inputs: [ { name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' } ], outputs: [{ name: '', type: 'bool' }] },
  { type: 'function', stateMutability: 'view', name: 'allowance', inputs: [ { name: 'owner', type: 'address' }, { name: 'spender', type: 'address' } ], outputs: [{ name: '', type: 'uint256' }] }
];
