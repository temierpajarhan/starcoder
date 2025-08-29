# WARP.md

This file provides guidance to WARP (warp.dev) when working with code in this repository.

Repo purpose
- Atomic Balancer V2 → Pendle “flooping” on Arbitrum mainnet: borrow via Balancer flash loan, mint PY (PT+YT) on Pendle, sell PT back to the loan token, optionally sell some YT to cover residuals, repay loan, and keep leftovers as profit — all in one transaction.

High-level architecture
- On-chain (contracts/FlashFloopExecutor.sol)
  - Minimal Balancer V2 flash-loan recipient.
  - Executes an ordered list of arbitrary target calls (Pendle Router V4 + Market ops; legacy V3 path exists in older script).
  - Enforces a profit threshold in the loan token before allowing repayment; otherwise reverts.
  - Owner-only entrypoint (onlyOwner). Repays principal+fee and sweeps leftover to profitRecipient.
- Off-chain TypeScript runners (scripts/)
  - scripts/simulate.ts: read-only previews via callStatic for mint/swap legs; estimates loop-by-loop profit for candidate params.
  - scripts/runOnce.local.ts: builds the call sequence (N loops) for Router V4 and calls executor.execute; requires a deployed executor and a signer (PRIVATE_KEY).
  - scripts/runOnce.ts: legacy path (Router V3 ABI fetch) kept for reference.
  - scripts/deploy.hardhat.ts: deploys the FlashFloopExecutor using Hardhat runtime to the Arbitrum network.
  - scripts/lib/fetchAbi.ts: lazily fetches live ABIs from Arbiscan (uses ARBISCAN_API_KEY).
  - scripts/lib/helpers.ts: common ABIs (ERC20, Market), unit helpers, etc.
- Configuration
  - hardhat.config.ts: Solidity 0.8.23 with optimizer; network: arbitrum (chainId 42161) via ARBITRUM_RPC; Etherscan key ARBISCAN_API_KEY.
  - config/addresses.arbitrum.json: canonical addresses (Balancer Vault, Pendle Router V4, RouterStatic) and sample market/token addresses.
- CI
  - .github/workflows/ci.yml installs pnpm, installs deps, and runs hardhat compile on Node 20.

Environment
- Requires Node 20+ and pnpm.
- Expected .env variables (not committed):
  - ARBITRUM_RPC: HTTPS RPC URL for Arbitrum One.
  - PRIVATE_KEY: EOA private key used for deploy/execute (owner of the executor).
  - ARBISCAN_API_KEY: to pull ABIs from Arbiscan.

Common commands
- Install
  - pnpm i
- Build/compile
  - pnpm hardhat compile
  - Or via script: pnpm run build
- Deploy executor (Arbitrum)
  - pnpm hardhat run scripts/deploy.hardhat.ts --network arbitrum
- Simulate a candidate loop (no state changes)
  - pnpm ts-node scripts/simulate.ts \
    --market <PENDLE_MARKET> \
    --loanToken <TOKEN_ACCEPTED_BY_SY> \
    --amount <AMOUNT> \
    --loops <N> \
    --slippageBps <BPS>
- Execute once (live)
  - pnpm ts-node scripts/runOnce.local.ts \
    --executor <DEPLOYED_EXECUTOR> \
    --market <PENDLE_MARKET> \
    --loanToken <TOKEN_ACCEPTED_BY_SY> \
    --amount <AMOUNT> \
    --loops <N> \
    --minProfit <MIN_PROFIT_IN_LOAN_TOKEN> \
    --recipient <EOA_TO_RECEIVE_LEFTOVERS> \
    --syToPtRoute --preflightGuard --omitApproves
- Lint/tests
  - No linter or test suite is configured in this repo.

Important notes from README and prompts
- Markets and tokens
  - Use a market with a future maturity (e.g., wstETH – 24 Jun 2026) to avoid expired PT.
  - loanToken must be directly accepted by the market’s SY without going through an aggregator (e.g., for wstETH markets, use wstETH on Arbitrum: 0x5979…0529).
- Fees and safety
  - Balancer flash loan fee is assumed 0% per docs; the contract treats it generically.
  - The whole transaction reverts if any step fails or if loanAmount + fee + minProfit cannot be covered — shielding principal risk.
  - Executor is owner-only; ensure you deploy with the key you intend to use for runOnce.
- GLP/GMX V1
  - GLP strategies are disabled by default here; only enable intentionally and with explicit flags and checks.
- Agent prompt guidance
  - PROMPT_AGENT_MAINNET.md describes a stricter, “live-only” agent flow on Arbitrum mainnet (no forks/sim execution gating; optional private submission). Follow that document if you’re operating in agent mode for live strategies. For development, simulate.ts is the recommended dry-run tool.

Gotchas observed in code
- slippage/minOut handling: simulate.ts supports a slippageBps input for previews; runOnce.local.ts initially sets minOut=0 for first green. After first status=1, enable minOuts from RouterStatic.

See WARP_STATUS.md for current operational guidance.

