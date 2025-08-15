import { ethers } from 'ethers';

export const Erc20Abi = [
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address, address) view returns (uint256)',
  'function approve(address, uint256) returns (bool)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function transfer(address, uint256) returns (bool)'
];

export const VaultAbi = [
  'function flashLoan(address recipient, address[] tokens, uint256[] amounts, bytes userData)'
];

export const MarketAbiFrag = [
  'function readTokens() view returns (address SY, address PT, address YT)'
];

export function bn(x: string | number) {
  return ethers.parseUnits(String(x), 18);
}

export function toBase(amount: string | number, decimals: number) {
  return ethers.parseUnits(String(amount), decimals);
}

export function fromBase(amount: bigint, decimals: number) {
  return ethers.formatUnits(amount, decimals);
}

export function bps(x: number, bps: number) {
  return x * (1 - bps / 10_000);
}
