import { ethers } from 'hardhat';
import fs from 'fs';
import path from 'path';

async function main() {
  const addresses = JSON.parse(fs.readFileSync(path.join('config','addresses.arbitrum.json'),'utf8'));
  const vault: string = addresses.arbitrum.balancerVault;

  const F = await ethers.getContractFactory('FlashFloopExecutor');
  const c = await F.deploy(vault);
  await c.waitForDeployment();
  console.log('FlashFloopExecutor deployed:', await c.getAddress());
}

main().catch((e) => { console.error(e); process.exit(1); });
