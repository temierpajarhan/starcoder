# Balancer ↔ Pendle Flooping (Arbitrum mainnet)

**Goal:** Atomic “flash‑stake style” loop using a **Balancer V2** flash loan to mint **PT+YT (PY)** on **Pendle**, sell **PT** back to the loan token, optionally sell a slice of **YT** to cover residuals, **repay** the flash loan, keep leftover **YT and/or tokens** as profit — all **in one transaction**.

This repo deploys a **generic flash‑loan executor** and a **TypeScript runner** that:
1) builds the calldata (Pendle Router V4 + Market) based on live ABIs pulled from Arbiscan,  
2) quotes everything via `callStatic`,  
3) executes the flash‑loan if expected **PNL ≥ minProfit**,  
4) loops the “mint→sell PT→(optional) sell YT→repay” **N times** inside one flash loan (flooping).

> ⚠️ **GLP note (GMX V1/GLP incidents July 2025)**: GLP strategies are **disabled** here by default. If you purposefully enable any GLP market, the preflight check will force a manual `--i-know-what-im-doing` flag.

> Operational status & runbook: see WARP_STATUS.md for the up‑to‑date production flow.

## What’s inside
- `contracts/FlashFloopExecutor.sol` — minimal, audited‑pattern flash‑loan recipient that performs **arbitrary target calls** and repays Balancer atomically. Profit threshold checked on‑chain.
- `scripts/deploy.ts` — deploys the executor.
- `scripts/simulate.ts` — dry‑run quoting via `callStatic` (no state changes).
- `scripts/runOnce.ts` — executes one full flash‑loan attempt if simulation ≥ `minProfit`.
- `scripts/lib/*` — helpers to fetch ABIs from Arbiscan, build calldata for **Pendle Router V4** & **Market**, compute fees (Balancer is 0% fee as of docs), and assemble a multi‑loop plan.
- `agent_prompts/pendle_flooping_optimizer.md` — a prompt for an auto‑tuner agent (MD) to iterate parameters until profitable.
- `config/addresses.arbitrum.json` — canonical addresses we need (you can edit/add markets).
- `.env.example` — environment setup.

## Quick start (Arbitrum mainnet)
```bash
pnpm i   # or npm i / yarn
cp .env.example .env
# Fill PRIVATE_KEY, ARBITRUM_RPC, ARBISCAN_API_KEY

pnpm hardhat compile
pnpm hardhat run scripts/deploy.hardhat.ts --network arbitrum

# Try a dry run (adjust sample market & amount):
pnpm ts-node scripts/simulate.ts   --market 0xf78452e0f5c0b95fc5dc8353b8cd1e06e53fa25b   --loanToken 0x5979D7b546E38E414F7E9822514be443A4800529   --amount 2   --loops 1

# If sim ≥ minProfit, execute once:
pnpm ts-node scripts/runOnce.ts   --executor <DEPLOYED_EXECUTOR>   --market 0xf78452e0f5c0b95fc5dc8353b8cd1e06e53fa25b   --loanToken 0x5979D7b546E38E414F7E9822514be443A4800529   --amount 2   --loops 1   --minProfit 0.001
```

### Parameter notes
- `--loanToken` should be a token accepted by the market’s **SY** as `tokenIn` **without aggregator** (to avoid extra routing). For **wstETH markets** use **wstETH** (Arbitrum: `0x5979...0529`). For **weETH markets**, use **weETH**, etc.
- Choose a **future maturity** (e.g., **wstETH – 24 Jun 2026** market: `0xf78452e0...fa25b`) to avoid expired PT.
- Balancer flash loan **fee is 0%** according to docs; code still treats it generically.

## Safety
- All target calls are executed **in order**. If any step fails or the balance can’t cover `amount + fee + minProfit`, the entire tx **reverts** (no principal risk).
- `executor` is **Ownable**; only the owner can launch flash‑loans.
- Default slippage guards on all swaps; you must set sensible `minOutBps` on the CLI.

---

### References (verify before changing anything)
- Balancer V2 Vault (Arbitrum): `0xBA12222222228d8Ba445958a75a0704d566BF2C8`
- Pendle Router V4 (Arbitrum): `0x888888888889758F76e7103c6CbF23ABbF58F946`
- RouterStatic (Arbitrum): `0xAdB09F65bd90d19E3148d9cCB693F3161C6dB3E8`
- Example Market (wstETH – 24 Jun 2026): `0xf78452e0f5c0b95fc5dc8353b8cd1e06e53fa25b`
- wstETH (Arbitrum): `0x5979D7b546E38E414F7E9822514be443A4800529`

> Always re‑confirm on Arbiscan / Pendle UI before running size.
