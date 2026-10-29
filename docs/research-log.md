# Research log

What has been tested, how, and what was decided. Newest first. Every result
comes from real price history replayed through the production engine, with
fees, spread and stop slippage. "Unseen" means the strategy's numbers were
measured only on earlier data, then scored on a later period.

## 29 Oct 2026: robustness of Donchian 55/20/3, kill-switch basis, 2018 crash

Script: `npx tsx scripts/research/variants.ts --basis mark|cost`

**Settings robustness.** Nine variants (entry 20–100 days, exit 10–30 days, stop 2–4 ATR) on two independent datasets: CoinJar AUD (unseen 2023-01 → now, $350) and Binance USD for the same five coins (unseen 2021-01 → now, which includes the 2022 crash).

- 8 of 9 were profitable on both unseen periods. 100/30 never qualified to trade (fewer than 20 calibration trades).
- No variant beat 55/20/3 on both datasets with no worse drawdown. 20/10/3 and 55/10/3 were better on CoinJar but worse on Binance.
- **Decision:** keep 55/20/3. The edge is broad (trend following in general), not one lucky setting.

**Kill-switch basis.** Measured at market prices, the 20% kill switch halted the bot for good in 2021 on Binance data, after a DOGE trend trade gave back part of a many-fold gain. The bot then missed 2023–24.

| Binance unseen 2021 → now, 55/20/3 | Return | By year |
|---|---|---|
| Kill switch at market prices | +226% | all in 2021, then halted |
| Kill switch counting real losses only | +553% | 21 +357%, 22 −10%, 23 +37%, 24 +29%, 25 −6%, 26 −4% |

Identical on CoinJar 2023 → now (no huge unrealised gains in that period).

- **Decision:** `RISK.drawdownBasis = "cost"`. The kill switch still halts after real losses of 20%. The 10%-a-day rule still uses market prices, so a winner collapsing in one day still sells everything.

**2018 crash** (Binance; BTC, ETH, XRP; rules calibrated on full history but not fitted to it): 2018 −6.7% (market −61% to −83%), 2019 +6.9%, 2020 +44.8%. Max drawdown 14%. No halt under either basis.

**Bug found and fixed:** the engine resolved exits from the built-in strategy list instead of the list it was given. This only affected research runs of variants (positions closed as "strategy retired"); production was unaffected. Regression test added.

## 29 Oct 2026: more markets

Fixed rules, chosen before backtesting: spread ≤ 0.5%, minimum order ≤ $35, 3+ years of history, trades every day. Of ~75 CoinJar AUD markets only BTC, ETH, SOL, XRP and DOGE pass. Adding DOGE: unseen 2023 → now on $350 went from +23% to +37% with the same 14% drawdown. Allowing 5 open positions made +55% but drew down 18%, too close to the kill switch, so max positions stays at 4.

## 28 Oct 2026: from day trading to daily trend following

- Intraday (15m and 1h; momentum, mean reversion, breakout, nine stop/target ratios): every setup lost 0.1–0.9% per trade after costs over a year. CoinJar's 15-minute moves (~0.15–0.2%) are smaller than a round trip's cost (~0.4%). One setup won 63–74% of trades and still lost money.
- Daily trend rules (7 tested, 2019–2026): all profitable, robust to a one-day fill delay and double costs. Donchian 55/20 had the smallest drawdown.
- Daily beat 4h on unseen data; running both together was worse than either.

## Open questions

- **CoinJar vs global prices (lead-lag).** The `quotes` table collects CoinJar bid/ask and Binance's AUD-converted price every 5 minutes. First readings show CoinJar's mid price 0.08–0.18% from global, so a tradeable lag may be too small. Analyse once 2–3 weeks of data exist.
- **Paper vs backtest.** Compare paper trades to what the backtest would have done on the same days, to catch differences between simulated and real fills.
