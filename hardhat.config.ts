import 'dotenv/config';
import { HardhatUserConfig } from 'hardhat/config';
import '@nomicfoundation/hardhat-ethers';
import '@nomicfoundation/hardhat-verify';

const { ARBITRUM_RPC, PRIVATE_KEY } = process.env;

const config: HardhatUserConfig = {
  solidity: {
    version: '0.8.23',
    settings: {
      optimizer: { enabled: true, runs: 1000 }
    }
  },
  networks: {
    arbitrum: {
      url: ARBITRUM_RPC || '',
      accounts: PRIVATE_KEY ? [PRIVATE_KEY] : [],
      chainId: 42161
    }
  },
  etherscan: {
    apiKey: {
      arbitrumOne: process.env.ARBISCAN_API_KEY || ''
    }
  }
};
export default config;
