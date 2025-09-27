import { ethers, network } from 'hardhat';
import { Contract, Signer } from 'ethers';
import { setTimeout as delay } from 'timers/promises';
import { readFile, writeFile, mkdir } from 'fs/promises';
import path from 'path';

const ERC20_ABI = [
  'function decimals() view returns (uint8)',
  'function balanceOf(address) view returns (uint256)'
];

export interface CallInstruction {
  target: string;
  calldata: string;
  description?: string;
}

export interface TargetInstruction {
  address: string;
  calldata: string;
  description?: string;
}

export interface LoanConfig {
  token: string;
  amount: string;
  minProfit: string;
  decimals?: number;
}

export interface AutonomousPlanDefinition {
  vault: string;
  executor?: string;
  owner?: string;
  loan: LoanConfig;
  profitRecipient?: string;
  targets: TargetInstruction[];
  startupActions?: CallInstruction[];
  preRunActions?: CallInstruction[];
  retryActions?: CallInstruction[];
  maxRuns?: number;
  stopOnSuccess?: boolean;
  continueOnFailure?: boolean;
  cooldownMs?: number;
  maxDurationSeconds?: number;
  artifactBasePath?: string;
  runLabel?: string;
}

export interface RunSummary {
  success: boolean;
  runs: number;
  profit: bigint;
  finalRecipientBalance: bigint;
  lastError?: string;
  executor: string;
  terminatedReason: 'success' | 'max_runs_reached' | 'duration_exceeded' | 'aborted_on_failure';
  artifactPath: string;
  attempts: RunAttemptRecord[];
  startedAt: string;
  finishedAt: string;
}

export interface RunAttemptRecord {
  index: number;
  startedAt: string;
  durationMs?: number;
  txHash?: string;
  blockNumber?: number;
  gasUsed?: string;
  gasPriceWei?: string;
  profitDelta?: string;
  recipientBalance?: string;
  success: boolean;
  error?: string;
  retryActionsRun?: boolean;
}

const JSON_REPLACER = (_: string, value: unknown) =>
  typeof value === 'bigint' ? value.toString() : value;

async function safeWriteJson(filePath: string, payload: unknown) {
  try {
    await writeFile(filePath, JSON.stringify(payload, JSON_REPLACER, 2));
  } catch (error) {
    console.warn(`Failed to write ${filePath}:`, formatError(error));
  }
}

function sanitizePlanForLog(plan: AutonomousPlanDefinition): Record<string, unknown> {
  const { artifactBasePath, runLabel, ...rest } = plan;
  return rest as Record<string, unknown>;
}

function renderReport(summary: RunSummary, plan: AutonomousPlanDefinition): string {
  const lines: string[] = [];
  lines.push('# Autonomous Runner Report');
  lines.push('');
  lines.push(`- Started: ${summary.startedAt}`);
  lines.push(`- Finished: ${summary.finishedAt}`);
  lines.push(`- Runs executed: ${summary.runs}`);
  lines.push(`- Terminated reason: ${summary.terminatedReason}`);
  lines.push(`- Success: ${summary.success}`);
  lines.push(`- Profit (raw): ${summary.profit.toString()}`);
  lines.push(`- Final recipient balance: ${summary.finalRecipientBalance.toString()}`);
  if (summary.lastError) {
    lines.push(`- Last error: ${summary.lastError}`);
  }
  lines.push('');
  lines.push('## Plan Snapshot');
  lines.push('');
  lines.push('```json');
  lines.push(JSON.stringify(sanitizePlanForLog(plan), JSON_REPLACER, 2));
  lines.push('```');
  lines.push('');
  lines.push('## Attempts');
  lines.push('');
  lines.push('| # | Started | Success | TxHash | Profit Δ | Error | Duration (ms) | Retry Actions |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const attempt of summary.attempts) {
    lines.push(
      `| ${attempt.index} | ${attempt.startedAt} | ${attempt.success} | ${attempt.txHash ?? ''} | ${attempt.profitDelta ?? ''} | ${attempt.error ?? ''} | ${attempt.durationMs ?? ''} | ${attempt.retryActionsRun ? 'yes' : 'no'} |`
    );
  }
  lines.push('');
  return lines.join('\n');
}

function parseTokenAmount(value: string, decimals: number): bigint {
  if (value.startsWith('0x')) {
    return BigInt(value);
  }
  return ethers.parseUnits(value, decimals);
}

async function resolveSigner(address?: string): Promise<Signer> {
  const available = await ethers.getSigners();
  if (!address) {
    return available[0];
  }
  const needle = address.toLowerCase();
  for (const signer of available) {
    if ((await signer.getAddress()).toLowerCase() === needle) {
      return signer;
    }
  }
  await network.provider.request({ method: 'hardhat_impersonateAccount', params: [address] });
  return await ethers.getSigner(address);
}

async function performCalls(actions: CallInstruction[] | undefined, signer: Signer) {
  if (!actions?.length) return;
  for (const action of actions) {
    const tx = await signer.sendTransaction({ to: action.target, data: action.calldata });
    await tx.wait();
  }
}

function formatError(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}

export async function runAutonomousPlan(plan: AutonomousPlanDefinition): Promise<RunSummary> {
  if (plan.targets.length === 0) {
    throw new Error('Plan must specify at least one target');
  }

  const ownerSigner = await resolveSigner(plan.owner);
  const ownerAddress = await ownerSigner.getAddress();

  const decimals = plan.loan.decimals ?? Number(await new ethers.Contract(plan.loan.token, ERC20_ABI, ownerSigner).decimals());
  const loanAmount = parseTokenAmount(plan.loan.amount, decimals);
  const minProfit = parseTokenAmount(plan.loan.minProfit, decimals);

  const profitRecipient = plan.profitRecipient ?? ownerAddress;

  const startedAt = new Date();
  const startedAtIso = startedAt.toISOString();
  const artifactBase = path.resolve(plan.artifactBasePath ?? path.join(process.cwd(), 'runs'));
  const runLabel = plan.runLabel ?? startedAtIso.replace(/[:.]/g, '-');
  const artifactPath = path.join(artifactBase, runLabel);
  await mkdir(artifactPath, { recursive: true });
  await safeWriteJson(path.join(artifactPath, 'plan.json'), sanitizePlanForLog(plan));

  const attemptsPath = path.join(artifactPath, 'attempts.json');
  const attempts: RunAttemptRecord[] = [];

  let executor: Contract;
  if (plan.executor) {
    executor = await ethers.getContractAt('FlashFloopExecutor', plan.executor, ownerSigner);
  } else {
    const executorFactory = await ethers.getContractFactory('FlashFloopExecutor', ownerSigner);
    executor = await executorFactory.deploy(plan.vault);
    await executor.waitForDeployment();
  }

  const executorAddress = await executor.getAddress();

  const currentOwner: string = await executor.owner();
  if (currentOwner.toLowerCase() !== ownerAddress.toLowerCase()) {
    const tx = await executor.connect(ownerSigner).setOwner(ownerAddress);
    await tx.wait();
  }

  const erc20 = new ethers.Contract(plan.loan.token, ERC20_ABI, ownerSigner);
  const initialBalance: bigint = await erc20.balanceOf(profitRecipient);

  await performCalls(plan.startupActions, ownerSigner);

  const configuredMaxRuns = plan.maxRuns ?? 5;
  const unlimitedRuns = configuredMaxRuns <= 0;
  const maxRuns = unlimitedRuns ? Number.POSITIVE_INFINITY : configuredMaxRuns;
  const stopOnSuccess = plan.stopOnSuccess !== false;
  const continueOnFailure = plan.continueOnFailure !== false;
  const cooldownMs = Math.max(0, plan.cooldownMs ?? 0);
  const maxDurationSeconds = plan.maxDurationSeconds ?? 0;
  const maxDurationMs = maxDurationSeconds > 0 ? maxDurationSeconds * 1000 : 0;
  const startTime = Date.now();

  const targetAddresses = plan.targets.map((t) => t.address);
  const calldatas = plan.targets.map((t) => t.calldata);

  let runs = 0;
  let success = false;
  let profit = 0n;
  let lastError: string | undefined;
  let terminatedReason: RunSummary['terminatedReason'] | undefined;

  while (runs < maxRuns) {
    if (maxDurationMs && Date.now() - startTime >= maxDurationMs) {
      terminatedReason = 'duration_exceeded';
      break;
    }

    const attemptIndex = runs + 1;
    const attemptStart = Date.now();
    const attemptRecord: RunAttemptRecord = {
      index: attemptIndex,
      startedAt: new Date().toISOString(),
      success: false
    };
    attempts.push(attemptRecord);
    await safeWriteJson(attemptsPath, attempts);

    try {
      await performCalls(plan.preRunActions, ownerSigner);
      const tx = await executor.connect(ownerSigner).execute({
        targets: targetAddresses,
        calldatas,
        loanToken: plan.loan.token,
        loanAmount,
        minProfit,
        profitRecipient
      });
      attemptRecord.txHash = tx.hash;
      const receipt = await tx.wait();
      attemptRecord.blockNumber = receipt.blockNumber ?? undefined;
      attemptRecord.gasUsed = receipt.gasUsed?.toString();
      attemptRecord.gasPriceWei = (receipt.effectiveGasPrice ?? 0n).toString();

      const currentBalance: bigint = await erc20.balanceOf(profitRecipient);
      profit = currentBalance - initialBalance;
      attemptRecord.recipientBalance = currentBalance.toString();
      attemptRecord.profitDelta = profit.toString();
      attemptRecord.success = profit >= minProfit;
      attemptRecord.durationMs = Date.now() - attemptStart;

      if (profit >= minProfit) {
        success = true;
        terminatedReason = 'success';
        if (stopOnSuccess) {
          runs += 1;
          break;
        }
      }
    } catch (error) {
      lastError = formatError(error);
      attemptRecord.error = lastError;
      attemptRecord.durationMs = Date.now() - attemptStart;
      const currentBalance: bigint = await erc20.balanceOf(profitRecipient);
      profit = currentBalance - initialBalance;
      attemptRecord.recipientBalance = currentBalance.toString();
      attemptRecord.profitDelta = profit.toString();
      await safeWriteJson(attemptsPath, attempts);
      if (!continueOnFailure) {
        terminatedReason = 'aborted_on_failure';
        throw error;
      }
      await performCalls(plan.retryActions, ownerSigner);
      attemptRecord.retryActionsRun = Boolean(plan.retryActions && plan.retryActions.length > 0);
    }

    runs += 1;
    await safeWriteJson(attemptsPath, attempts);

    if (cooldownMs > 0 && runs < maxRuns && (!maxDurationMs || Date.now() - startTime < maxDurationMs)) {
      await delay(cooldownMs);
    }
  }

  const finalBalance: bigint = await erc20.balanceOf(profitRecipient);

  if (!terminatedReason) {
    terminatedReason = success ? 'success' : 'max_runs_reached';
  }

  const finishedAtIso = new Date().toISOString();

  const summary: RunSummary = {
    success,
    runs,
    profit,
    finalRecipientBalance: finalBalance,
    lastError,
    executor: executorAddress,
    terminatedReason,
    artifactPath,
    attempts,
    startedAt: startedAtIso,
    finishedAt: finishedAtIso
  };

  await safeWriteJson(path.join(artifactPath, 'summary.json'), summary);
  await safeWriteJson(path.join(artifactPath, 'attempts.json'), attempts);

  const reportPath = path.join(artifactPath, 'REPORT.md');
  try {
    await writeFile(reportPath, renderReport(summary, plan));
  } catch (error) {
    console.warn(`Failed to write ${reportPath}:`, formatError(error));
  }

  return summary;
}

export async function runAutonomousPlanFromFile(planPath: string): Promise<RunSummary> {
  const absolute = path.resolve(planPath);
  const raw = await readFile(absolute, 'utf8');
  const parsed = JSON.parse(raw) as AutonomousPlanDefinition;
  return runAutonomousPlan(parsed);
}

if (require.main === module) {
  const planPath = process.argv[2];
  if (!planPath) {
    console.error('Usage: hardhat run scripts/autonomous-runner.ts --network <network> <plan.json>');
    process.exit(1);
  }

  runAutonomousPlanFromFile(planPath)
    .then((summary) => {
      console.log(JSON.stringify(summary, (_, value) => (typeof value === 'bigint' ? value.toString() : value), 2));
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
