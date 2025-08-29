# WARP_STATUS — Mainnet‑only Pendle Flooping (Arbitrum, Router V4)

## Кратко
- Сеть: Arbitrum One (42161), **только мейннет**.
- Flash‑loan: **fee = 0** (жёстко).
- Маршрут: **SY → PT → token** (без агрегатора).
- Роуты:
  - Router V4: `0x888888888889758F76e7103c6CbF23ABbF58F946`
  - RouterStatic: `0xAdB09F65bd90d19E3148d9cCB693F3161C6dB3E8`
- Селекторы и структуры:
  - `swapExactSyForPt` — `0x2a50917c` + `ApproxParams` + пустой `LimitOrderData`.
  - `swapExactPtForToken` — `0x594a88cc` + `TokenOutput(no-aggregator)` + пустой `LimitOrderData`.
- Approve‑priming на RouterV4 выполнен; есть режим `--omitApproves`.

## Префлайт и сканер
- Префлайт‑guard (только view): 
  - `syQuote = mintSyFromTokenStatic`, `ptQuote = swapExactSyForPtStatic`, `tokQuote = swapExactPtForTokenStatic`.
  - `margin = tokQuote − amount` (fee=0).
  - Если `margin ≤ 0` → **скип** (пишется `preflight.json`, газа 0).
- Сканер рынков: `scripts/scanMarkets.ts` — перебор адресов из `config/candidate-markets.arbitrum.json` и/или сетки `amount`.

## Команды
### Скан
```bash
TS_NODE_TRANSPILE_ONLY=1 node --loader ts-node/esm scripts/scanMarkets.ts config/candidate-markets.arbitrum.json
```

### Первый «зелёный»

```bash
export EXACT_SY_IN_FRAC_BPS=10000
export EXACT_PT_IN_FRAC_BPS=9990
export FLASHLOAN_FEE_OVERRIDE_BPS=0

TS_NODE_TRANSPILE_ONLY=1 RPC_QPS=10 node --loader ts-node/esm scripts/runAndMeasure.ts \
  --executor <EXECUTOR> \
  --market   <MARKET_FROM_SCAN> \
  --loanToken 0x5979D7b546E38E414F7E9822514be443A4800529 \
  --amount <AMOUNT_FROM_SCAN> \
  --loops 1 --minProfit 0 --slippageBps 75 \
  --omitApproves --syToPtRoute --preflightGuard
```

### После «зелёного» (в плюс)

* Вернуть `minOut` (из RouterStatic) на обе ноге.
* Стянуть фаджи к 100% (`EXACT_PT_IN_FRAC_BPS=9980–10000`, `EXACT_SY_IN_FRAC_BPS=9950–10000`).
* Снизить `slippageBps`, увеличивать `amount`.

## Папки и артефакты

* `runs/<ts>/scan.json`, `runs/<ts>/preflight.json`, `runs/<ts>/run.json`, `REPORT.md`.

## Ограничения/безопасность

* 1 tx одновременно на EOA (нонс‑локи в коде).
* Лок по (market, loanToken) на поток.
* RPC QPS лимит 8–12 req/s с backoff.
* Не логировать `PRIVATE_KEY`. Secrets — только из `.env`.

