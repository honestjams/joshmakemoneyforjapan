# joshmakemoneyforjapan: multi-agent crypto trading bot

An automated trading bot for **CoinJar Exchange** (Australian, 0.10% fees). Several agents feed one decision, and hard-coded risk rules have the final say. It runs on **Vercel**, with **Supabase** for data and the 5-minute schedule.

> **Status: paper trading.** Real money is planned from 4 Nov 2026, once the go-live checklist passes (see [Going live](#going-live)).

## Strategy: daily trend following

Intraday day trading on CoinJar loses money: a typical 15-minute or 1-hour move is smaller than the ~0.4% round-trip cost (0.2% fees plus a 0.15–0.28% spread). Every intraday setup tested over a year lost 0.1–0.9% per trade, including one that won 63–74% of its trades.

The bot therefore uses **Donchian 55/20 trend following on daily candles**:

- **Buy** when a market's daily close breaks above its highest close of the previous 55 days.
- **Sell** when the daily close falls below its lowest close of the previous 20 days.
- **Emergency stop:** an exchange-side stop-loss 3 ATR below entry.

It trades rarely (about once a month per market) and **wins only 40–50% of trades**. It makes money because winners average about 4–5× the size of losers. A 65% win rate isn't realistic for any strategy we found that is actually profitable after costs.

## How it decides

Every 5 minutes, Supabase pg_cron calls `POST /api/tick`, which runs one cycle (`src/lib/engine.ts`):

```
 market data agent ── CoinJar daily candles + live bid/ask (BTC, ETH, SOL, XRP / AUD)
        │
        ├─► exits ── strategy exit signal (20-day low) · emergency stop (on the exchange in live mode)
        │
        ├─► strategy agent ── Donchian 55/20 breakout on the candle that just closed
        ├─► research agent ── Claude-written knowledge brief, ±5 pts max, fades in 72h
        ├─► JEV ── external AI decision model's win probability (blended 50/50)
        │
        ├─► decision agent ── strategy's measured record (backtest + live trades):
        │                      EV = p(win)·avg win − (1−p)·avg loss; trade only if ≥ +0.1% and ≥ 20 trades measured
        │
        ├─► risk manager (plain code, final veto)
        │     ≤10% of equity per trade · ≤10% max loss per trade · one position per market (max 4)
        │     −5% in a day: no new trades · −10% in a day: sell everything · −20% from peak: halt
        │     never rounds up to meet exchange minimums
        │
        └─► execution agent ── paper broker, or CoinJar market orders + exchange-side stop-loss
```

The dashboard (`/`, password-protected) shows equity, win rate, positions, trades, JEV's accuracy, the go-live check and a **Halt** button.

## Backtest results

`npm run backtest` replays real CoinJar history through the production engine. Assumed costs: 0.1% fee, 0.1% half-spread and 0.5% stop slippage. Each trade uses ≤10% of equity.

| Period | Start | End | Return | Worst drawdown | Trades | Win rate |
|---|---|---|---|---|---|---|
| Unseen: 2023-01 → 2026-10 (calibrated on 2019–2022 only) | $500 | $722 | **+44%** | −12% | 53 | 40% |
| Unseen, $150 account (ETH too expensive to trade) | $150 | $171 | +14% | −7% | 17 | 41% |
| Full history: 2020-03 → 2026-10 | $500 | $1,218 | +143% | −14% | 80 | 45% |
| $50 account | $50 | $50 | 0% | – | 0 | – (every trade is below CoinJar's minimum order size) |

By year (full history): 2020 +21%, 2021 +38%, 2022 −2%, 2023 +12%, 2024 +39%, 2025 −3%, 2026 −1%. Gains come from bull runs. In bear markets it mostly sits in cash and loses a little.

**Over a 5-month window** (e.g. now → April), across 326 historical windows:

| | Return | On $500 | On $1,000 |
|---|---|---|---|
| Chance of profit | 54% | | |
| Bad case (10th percentile) | −3.6% | −$18 | −$37 |
| Typical (median) | +1.4% | +$7 | +$14 |
| Good case (90th percentile) | +31% | +$154 | +$309 |

`scripts/research/trend.ts` has the 7-rule comparison these choices came from: all 7 trend rules were profitable over 2019–2026, and Donchian 55/20 had the smallest drawdown.

## Minimum balance for live trading

Because of CoinJar's minimum order sizes and the 10% rule, the account must hold at least 10× each market's minimum (Oct 2026 prices):

| Market | Minimum order | Balance needed |
|---|---|---|
| BTCAUD | 0.0001 BTC ≈ $11.50 | ≈ $115 |
| SOLAUD | 0.1 SOL ≈ $14.50 | ≈ $145 |
| XRPAUD | 10 XRP ≈ $19 | ≈ $190 |
| ETHAUD | 0.01 ETH ≈ $33 | ≈ $335 |

## Setup

1. **Supabase:** run the files in `supabase/migrations/` in order, then `supabase/scheduler.sql`.
2. **Vercel:** set `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `CRON_SECRET`, `DASHBOARD_PASSWORD`, `TRADING_MODE=paper` and `PAPER_STARTING_BALANCE` (see `.env.example`).
3. **Vault:** store the same `CRON_SECRET` in Supabase Vault as `trading_bot_cron_secret`.

### Local development

```bash
npm install
npm test               # unit tests
npm run tick:local     # one cycle on live CoinJar prices, in-memory paper account
npm run backtest       # walk-forward backtest through the real engine
npx tsx scripts/research/trend.ts 1d 1 1 3   # rule comparison: interval, fill lag, cost multiplier, stop ATR
```

## Safety controls

- **Per trade:** ≤10% of equity in, and a worst-case loss of ≤10% of equity (in practice ~1–2%, because of the emergency stop).
- **Per day (Sydney time):** down 5% stops new trades for the day; down **10% sells everything** and waits for tomorrow.
- **Overall:** a 20% drop from the peak halts the bot until you press Resume.
- **Sell everything:** the dashboard's "Sell all positions & halt" button sells every position at market and halts.
- **One run at a time:** a lock stops two runs (or a run and a button press) trading at once.

## Going live

The target is **4 November 2026**. `/api/tick` refuses live mode until this checklist passes; the dashboard shows it:

1. The date is 4 Nov 2026 or later.
2. Over the last 3 days the paper bot made ≥90% of its expected 5-minute runs, and ≤2% of them had errors.
3. The paper account isn't halted.
4. The CoinJar key is **trade-only**: no withdrawal or transfer permission, checked on every live run.

To switch over:

1. In CoinJar Exchange → Settings → API Keys, create a key with **trading permission only**.
2. In Vercel, set `COINJAR_API_KEY`, `TRADING_MODE=live` and `LIVE_TRADING_ACKNOWLEDGED=yes`, then redeploy.
3. Deposit at least the balance needed for the markets you want (table above).

The live order path follows CoinJar's documented API but hasn't yet been run against a real account. Watch the first trades closely.

## JEV

For each candidate trade, `src/lib/agents/jev.ts` asks JEV "will this close in profit?". It blends JEV's answer 50/50 with the strategy's measured probability and records it on every trade, so the dashboard can score JEV's accuracy against outcomes. JEV is invite-only; until `JEV_API_KEY` and `JEV_API_URL` are set and the request code is filled in, the bot uses its own estimate.

## Knowledge updates

Ask Claude for a "knowledge update" in a Claude Code session on this repo. It researches the news and writes a brief to Supabase that the bot reads on its next run. The procedure is in `CLAUDE.md`.
