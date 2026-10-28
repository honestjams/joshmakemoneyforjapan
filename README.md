# joshmakemoneyforjapan: multi-agent crypto trading bot

An automated trading bot for **CoinJar Exchange** (Australian, 0.10% fees). Several agents feed one decision, and hard-coded risk rules have the final say. It runs on **Vercel**, with **Supabase** for data and the 5-minute schedule.

> **Status: paper trading only.** On a year of real CoinJar data, none of the current strategies make money after fees and spread (see [Backtest results](#backtest-results)). The bot is designed to place **no real trades** until a strategy shows positive expected value, measured on data it hasn't seen.

## How it decides

Every 5 minutes, Supabase pg_cron calls `POST /api/tick`, which runs one cycle (`src/lib/engine.ts`):

```
 market data agent ── CoinJar 1h candles + live bid/ask (BTC, ETH, SOL, XRP / AUD)
        │
        ├─► exit manager ── stop-loss / take-profit / 24h time stop on open positions
        │
        ├─► signal agents (src/lib/agents/signals.ts)
        │     trend_momentum · mean_reversion · volume_breakout
        │
        ├─► research agent ── Claude-written knowledge brief, ±5 pts max, fades in 72h
        ├─► JEV ── external AI decision model's win probability (blended 50/50)
        │
        ├─► decision agent ── calibrated p(win) from measured hit rates
        │                      EV = p·win − (1−p)·loss − fees − slippage
        │                      trade only if p ≥ 55% AND EV ≥ +0.1%
        │
        ├─► risk manager (plain code, final veto)
        │     ≤10% of equity per trade · ≤10% max loss per trade
        │     5% daily loss limit · 20% drawdown kill switch · max 3 positions
        │     never rounds up to meet exchange minimums · spread & cooldown checks
        │
        └─► execution agent ── paper broker, or CoinJar market orders + exchange-side stop-loss
```

Every closed trade updates the calibration, so hit rates keep improving with live data. The dashboard (`/`, password-protected) shows equity, win rate, open positions, trades, JEV's accuracy and a **Halt** button.

### Why win rate alone isn't the goal

A 65% win rate can still lose money if the losses are bigger than the wins. The backtest found this directly: one setting won 63–74% of trades and still lost money overall. The bot therefore filters on **expected value after costs** and reports win rate alongside it.

## Backtest results

`npm run backtest` reran on 28 Oct 2026 with 365 days of CoinJar 1h candles. The first 60% was used for calibration and the last 40% was unseen. Over this period BTC fell from $174k to $115k AUD.

| Agent | Trades | Win rate | Avg net return / trade |
|---|---|---|---|
| trend_momentum | 728 | 42% | −0.5% |
| volume_breakout | 230 | 42% | −0.5% |
| mean_reversion | 67 | 48% | −0.2% |

- **Normal mode (EV gate on):** 0 trades. Correct, since nothing had an edge.
- **Exploration mode, $500 paper:** 312 trades, 43.6% wins, −8.0%, max drawdown 8.6%. The risk rules contained the losses.
- **15-minute candles are worse.** A typical 15-minute move on CoinJar (~0.15–0.2%) is smaller than one round trip's costs (0.2% fees plus a 0.15–0.28% spread). 40–76% of 15-minute candles have no trades at all.

## Minimum balance for live trading

CoinJar has minimum order sizes, and the 10% rule means the balance must be at least 10× each minimum. Prices as of Oct 2026:

| Market | Minimum order | Balance needed |
|---|---|---|
| BTCAUD | 0.0001 BTC ≈ $11.50 | ≈ $115 |
| SOLAUD | 0.1 SOL ≈ $14.50 | ≈ $145 |
| XRPAUD | 10 XRP ≈ $19 | ≈ $190 |
| ETHAUD | 0.01 ETH ≈ $33 | ≈ $335 |

With $50 the risk manager rejects every trade rather than break the 10% rule.

## Setup

1. **Supabase:** create a project, then run `supabase/migrations/20261028000000_init.sql` in the SQL editor.
2. **Vercel:** import this repo and set the environment variables from `.env.example`: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `CRON_SECRET` (`openssl rand -hex 32`) and `DASHBOARD_PASSWORD`. Leave `TRADING_MODE=paper`.
3. **Scheduler:** fill in the placeholders in `supabase/scheduler.sql` and run it in the Supabase SQL editor. Vercel's free plan only allows daily crons; Supabase pg_cron runs every 5 minutes for free.
4. Open the Vercel URL and log in with your dashboard password.

### Local development

```bash
npm install
npm test               # unit tests
npm run tick:local     # one cycle on live CoinJar prices, in-memory paper account
npm run backtest       # walk-forward backtest (add --days 180, --cash 50,500)
```

## Going live (only after paper results justify it)

1. Paper trade with `PAPER_EXPLORATION=false` for at least 4 weeks, with a positive win-rate-and-EV record on the dashboard.
2. In CoinJar Exchange → Settings → API Keys, create a key with **trading only, no withdrawals**.
3. Add it in Vercel as `COINJAR_API_KEY`, and set `TRADING_MODE=live` and `LIVE_TRADING_ACKNOWLEDGED=yes`.
4. Deposit at least the balance needed for the markets you want (table above).
5. The live order path follows CoinJar's documented API but **hasn't yet been run against a real account**. Watch the first few trades closely.

## JEV

`src/lib/agents/jev.ts` asks JEV, for each candidate trade, "will this close in profit?". It blends JEV's answer 50/50 with the bot's own measured probability and records it on every trade, so the dashboard can score JEV's accuracy against outcomes (Brier score). JEV is invite-only and its API format isn't public yet. Until `JEV_API_KEY` and `JEV_API_URL` are set and the request code is filled in, the bot uses its own estimate.

## Knowledge updates

Ask Claude for a "knowledge update" in a Claude Code session on this repo. It researches the news and writes a brief to Supabase that the bot reads on its next run. The procedure is in `CLAUDE.md`.
