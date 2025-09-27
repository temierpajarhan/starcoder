import { expect } from 'chai';
import { ethers } from 'hardhat';
import { Contract } from 'ethers';
import '@nomicfoundation/hardhat-chai-matchers';

describe('FlashFloopExecutor', function () {
  let recipient: string;
  let executor: Contract;
  let vault: Contract;
  let token: Contract;
  let target: Contract;

  const loanAmount = ethers.parseUnits('100', 18);

  beforeEach(async () => {
    const [, profitRecipient] = await ethers.getSigners();
    recipient = await profitRecipient.getAddress();

    const tokenFactory = await ethers.getContractFactory('MockERC20');
    token = await tokenFactory.deploy('Mock Token', 'MOCK', 18);
    await token.waitForDeployment();

    const vaultFactory = await ethers.getContractFactory('MockBalancerVault');
    vault = await vaultFactory.deploy();
    await vault.waitForDeployment();

    const targetFactory = await ethers.getContractFactory('MockPipelineTarget');
    target = await targetFactory.deploy();
    await target.waitForDeployment();

    const executorFactory = await ethers.getContractFactory('FlashFloopExecutor');
    executor = await executorFactory.deploy(await vault.getAddress());
    await executor.waitForDeployment();

    await token.mint(await vault.getAddress(), ethers.parseUnits('1000000', 18));
    await token.mint(await target.getAddress(), ethers.parseUnits('1000', 18));
  });

  it('reverts when targets and calldatas length mismatch', async () => {
    await expect(
      executor.execute({
        targets: [await target.getAddress()],
        calldatas: [],
        loanToken: await token.getAddress(),
        loanAmount,
        minProfit: 0n,
        profitRecipient: recipient
      })
    ).to.be.revertedWithCustomError(executor, 'BadLengths');
  });

  it('reverts when loan token differs from expectation', async () => {
    const otherTokenFactory = await ethers.getContractFactory('MockERC20');
    const otherToken = await otherTokenFactory.deploy('Other Token', 'OT', 18);
    await otherToken.waitForDeployment();
    await otherToken.mint(await vault.getAddress(), ethers.parseUnits('1000', 18));

    await vault.setOverrideResponse([await otherToken.getAddress()], [loanAmount]);

    await expect(
      executor.execute({
        targets: [],
        calldatas: [],
        loanToken: await token.getAddress(),
        loanAmount,
        minProfit: 0n,
        profitRecipient: recipient
      })
    ).to.be.revertedWithCustomError(executor, 'UnexpectedLoanToken');
  });

  it('reverts when loan amount differs from expectation', async () => {
    await vault.setOverrideResponse([await token.getAddress()], [loanAmount + 1n]);

    await expect(
      executor.execute({
        targets: [],
        calldatas: [],
        loanToken: await token.getAddress(),
        loanAmount,
        minProfit: 0n,
        profitRecipient: recipient
      })
    ).to.be.revertedWithCustomError(executor, 'UnexpectedLoanAmount');
  });

  it('reverts when minimum profit is not achieved', async () => {
    const minProfit = ethers.parseUnits('1', 16);
    await expect(
      executor.execute({
        targets: [],
        calldatas: [],
        loanToken: await token.getAddress(),
        loanAmount,
        minProfit,
        profitRecipient: recipient
      })
    ).to.be.revertedWithCustomError(executor, 'InsufficientProfit');
  });

  it('executes successfully and forwards leftover profit', async () => {
    const minProfit = ethers.parseUnits('5', 16);
    const fee = ethers.parseUnits('1', 16);
    await vault.setFlashFee(fee);

    const extraProfit = ethers.parseUnits('2', 16);
    const profitToSend = minProfit + fee + extraProfit;

    const targetInterface = target.interface;
    const callData = targetInterface.encodeFunctionData('send', [
      await token.getAddress(),
      await executor.getAddress(),
      profitToSend
    ]);

    await expect(
      executor.execute({
        targets: [await target.getAddress()],
        calldatas: [callData],
        loanToken: await token.getAddress(),
        loanAmount,
        minProfit,
        profitRecipient: recipient
      })
    ).to.emit(token, 'Transfer');

    const recipientBalance = await token.balanceOf(recipient);
    expect(recipientBalance).to.equal(minProfit + extraProfit);

    const vaultBalance = await token.balanceOf(await vault.getAddress());
    const expectedVaultBalance = ethers.parseUnits('1000000', 18) + fee;
    expect(vaultBalance).to.equal(expectedVaultBalance);
  });
});
