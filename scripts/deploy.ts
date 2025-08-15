import 'dotenv/config';
import { ethers } from 'ethers';
import fs from 'fs';
import path from 'path';

const addresses = JSON.parse(fs.readFileSync(path.join('config','addresses.arbitrum.json'),'utf8'));

async function main() {
  const rpc = process.env.ARBITRUM_RPC!;
  const pk = process.env.PRIVATE_KEY!;
  if (!rpc || !pk) throw new Error('Set ARBITRUM_RPC and PRIVATE_KEY in .env');

  const provider = new ethers.JsonRpcProvider(rpc);
  const wallet = new ethers.Wallet(pk, provider);

  const vault = addresses.arbitrum.balancerVault as string;
  const source = fs.readFileSync(path.join('contracts','FlashFloopExecutor.sol'),'utf8');
  // compile minimal via hardhat; here we assume compiled already and use artifact-less deploy using inline bytecode is complex.
  // Simpler: use hardhat 'pnpm hardhat compile' before running this script and then deploy via ethers with compiled artifact.
  // For convenience, rely on hardhat runtime when running via 'pnpm hardhat run scripts/deploy.ts --network arbitrum'.
  console.log('Use Hardhat to deploy: pnpm hardhat run scripts/deploy.ts --network arbitrum');
}

main().catch(e => { console.error(e); process.exit(1); });
