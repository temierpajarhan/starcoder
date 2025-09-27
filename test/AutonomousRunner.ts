import { expect } from 'chai';
import { ethers } from 'hardhat';
import '@nomicfoundation/hardhat-chai-matchers';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';

import { runAutonomousPlan, AutonomousPlanDefinition } from '../scripts/autonomous-runner';

describe('Autonomous runner integration', function () {
  it('retries failed runs and stops once profitable', async function () {
    const [deployer, recipient] = await ethers.getSigners();
    const recipientAddress = await recipient.getAddress();

    const tokenFactory = await ethers.getContractFactory('MockERC20');
    const token = await tokenFactory.deploy('Mock Token', 'MOCK', 18);
    await token.waitForDeployment();

    const vaultFactory = await ethers.getContractFactory('MockBalancerVault');
    const vault = await vaultFactory.deploy();
    await vault.waitForDeployment();

    const targetFactory = await ethers.getContractFactory('MockPipelineTarget');
    const target = await targetFactory.deploy();
    await target.waitForDeployment();

    const executorFactory = await ethers.getContractFactory('FlashFloopExecutor');
    const executor = await executorFactory.deploy(await vault.getAddress());
    await executor.waitForDeployment();

    const vaultAddress = await vault.getAddress();
    const tokenAddress = await token.getAddress();
    const targetAddress = await target.getAddress();
    const executorAddress = await executor.getAddress();

    const fee = ethers.parseUnits('0.01', 18);
    const minProfit = ethers.parseUnits('0.05', 18);
    const extraProfit = ethers.parseUnits('0.02', 18);
    const profitTransfer = fee + minProfit + extraProfit;

    await token.mint(vaultAddress, ethers.parseUnits('1000000', 18));
    await vault.setFlashFee(fee);

    // Intentionally underfund the pipeline target so the first execution reverts.
    await token.mint(targetAddress, fee);

    const targetCalldata = target.interface.encodeFunctionData('send', [
      tokenAddress,
      executorAddress,
      profitTransfer
    ]);

    const artifactRoot = mkdtempSync(path.join(os.tmpdir(), 'autonomous-runner-'));

    const plan: AutonomousPlanDefinition = {
      vault: vaultAddress,
      executor: executorAddress,
      owner: await deployer.getAddress(),
      loan: {
        token: tokenAddress,
        amount: '100',
        minProfit: '0.05',
        decimals: 18
      },
      profitRecipient: recipientAddress,
      targets: [
        {
          address: targetAddress,
          calldata: targetCalldata
        }
      ],
      maxRuns: 3,
      continueOnFailure: true,
      retryActions: [
        {
          target: tokenAddress,
          calldata: token.interface.encodeFunctionData('mint', [targetAddress, profitTransfer])
        }
      ],
      artifactBasePath: artifactRoot,
      runLabel: 'success-case'
    };

    try {
      const summary = await runAutonomousPlan(plan);

      expect(summary.success).to.be.true;
      expect(summary.runs).to.equal(2);
      expect(summary.profit).to.equal(minProfit + extraProfit);
      expect(summary.finalRecipientBalance).to.equal(minProfit + extraProfit);
      expect(summary.lastError).to.contain('ExternalCallFailed');
      expect(summary.terminatedReason).to.equal('success');
      expect(summary.attempts).to.have.length(2);
      expect(summary.attempts[0].success).to.be.false;
      expect(summary.attempts[0].error).to.include('ExternalCallFailed');
      expect(summary.attempts[0].retryActionsRun).to.be.true;
      expect(summary.attempts[1].success).to.be.true;
      expect(summary.artifactPath).to.include('success-case');
      expect(summary.startedAt).to.be.a('string');
      expect(summary.finishedAt).to.be.a('string');

      const summaryPath = path.join(summary.artifactPath, 'summary.json');
      const attemptsPath = path.join(summary.artifactPath, 'attempts.json');
      const parsedSummary = JSON.parse(readFileSync(summaryPath, 'utf8'));
      const parsedAttempts = JSON.parse(readFileSync(attemptsPath, 'utf8'));
      expect(parsedSummary.terminatedReason).to.equal('success');
      expect(parsedSummary.runs).to.equal(2);
      expect(parsedAttempts).to.have.length(2);
    } finally {
      rmSync(artifactRoot, { recursive: true, force: true });
    }
  });

  it('allows unlimited retries with cooldown and duration guardrails', async function () {
    const [deployer] = await ethers.getSigners();

    const tokenFactory = await ethers.getContractFactory('MockERC20');
    const token = await tokenFactory.deploy('Mock Token', 'MOCK', 18);
    await token.waitForDeployment();

    const vaultFactory = await ethers.getContractFactory('MockBalancerVault');
    const vault = await vaultFactory.deploy();
    await vault.waitForDeployment();

    const targetFactory = await ethers.getContractFactory('MockPipelineTarget');
    const target = await targetFactory.deploy();
    await target.waitForDeployment();

    const executorFactory = await ethers.getContractFactory('FlashFloopExecutor');
    const executor = await executorFactory.deploy(await vault.getAddress());
    await executor.waitForDeployment();

    const vaultAddress = await vault.getAddress();
    const tokenAddress = await token.getAddress();
    const executorAddress = await executor.getAddress();
    const targetAddress = await target.getAddress();

    await token.mint(vaultAddress, ethers.parseUnits('1000000', 18));
    await vault.setFlashFee(0n);

    const failCalldata = target.interface.encodeFunctionData('fail');

    const artifactRoot = mkdtempSync(path.join(os.tmpdir(), 'autonomous-runner-'));

    const plan: AutonomousPlanDefinition = {
      vault: vaultAddress,
      executor: executorAddress,
      owner: await deployer.getAddress(),
      loan: {
        token: tokenAddress,
        amount: '10',
        minProfit: '0',
        decimals: 18
      },
      targets: [
        {
          address: targetAddress,
          calldata: failCalldata
        }
      ],
      maxRuns: 0,
      cooldownMs: 5,
      maxDurationSeconds: 0.001,
      artifactBasePath: artifactRoot,
      runLabel: 'duration-guard'
    };

    try {
      const summary = await runAutonomousPlan(plan);

      expect(summary.success).to.be.false;
      expect(summary.runs).to.be.at.most(1);
      expect(summary.terminatedReason).to.equal('duration_exceeded');
      expect(summary.lastError).to.include('ExternalCallFailed');
      expect(summary.attempts.length).to.be.at.least(1);
      expect(summary.artifactPath).to.include('duration-guard');
    } finally {
      rmSync(artifactRoot, { recursive: true, force: true });
    }
  });
});
