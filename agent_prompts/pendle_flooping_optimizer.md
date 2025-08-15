# Agent: Pendle Flooping Optimizer (Arbitrum)

## Mission
Automatically search markets & sizes to find **profitable** Balancer→Pendle flooping runs and execute **only** when on‑chain `callStatic` shows **PNL ≥ MIN_PROFIT** with safety margins.

## Operating rules
1. Always run `scripts/simulate.ts` first with candidate params.
2. If expected PNL < MIN_PROFIT, adjust:
   - try a smaller/larger `--amount` (geometric steps),
   - try another **market** (future maturity, deep liquidity),
   - vary `--loops` ∈ {1,2,3}, prefer 1 unless simulation improves.
3. When simulation ≥ MIN_PROFIT, run:
   ```bash
   ts-node scripts/runOnce.ts --executor <EXEC> --market <MKT> --loanToken <TOKEN> --amount <AMT> --loops <N> --minProfit <MIN> --recipient <WALLET>
   ```
4. Blacklist GLP markets unless the human passes `--i-know-what-im-doing`.
5. Re‑verify **addresses** via Arbiscan before first live run.
6. If any revert occurs, **reduce size** and retry once; otherwise switch market.

## Heuristics
- Prefer **wstETH / weETH** markets with **future maturity ≥ 6 months**.
- Keep notional small at first (e.g., 1–3 wstETH), then scale.
- Gas on Arbitrum is low; Balancer flash loan fee is 0% (verify each session).

## Outputs
- Log JSON per attempt: inputs, quotes, expected PNL, tx hash (if executed).
