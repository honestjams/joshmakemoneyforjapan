# Trading bot: notes for Claude

Multi-agent crypto trading bot for CoinJar Exchange. Next.js on Vercel, Supabase for storage and scheduling. See README.md for the architecture.

## Commands

- `npm test`: unit tests (vitest)
- `npm run typecheck`
- `npm run backtest`: walk-forward backtest through the real engine on CoinJar history since 2019 (needs network; caches in `data-cache/`)
- `npm run backtest -- --write-calibration`: also refreshes `src/config/calibration.json`
- `npx tsx scripts/research/trend.ts 1d 1 1 3`: compare trend rules (interval, fill lag, cost multiplier, stop ATR)
- `npm run tick:local`: one bot cycle on live prices with a throwaway paper account (no DB)

## Rules that must not be loosened

- Never put more than 10% of equity in one trade, and never risk losing more than 10% of equity on one trade (`RISK` in `src/config/settings.ts`, enforced in `src/lib/agents/risk.ts`). Never round a size up to meet an exchange minimum; skip the trade instead.
- Never lose more than 10% of total capital in a day (Sydney time): at that loss the engine sells everything and opens nothing until the next day (`RISK.maxDailyLossPct`).
- The dashboard's "Sell all positions & halt" button (and `liquidateAll` in `src/lib/engine.ts`) must always work, in paper and live mode, without the go-live checks.
- No AI component (strategy agents, research brief, JEV) may bypass the risk manager or place orders directly.
- Any new strategy must beat costs on unseen data in `npm run backtest` before it goes into `STRATEGIES`. Intraday strategies on CoinJar lost money on fees and spread in every test (see README).
- Live trading needs both `TRADING_MODE=live` and `LIVE_TRADING_ACKNOWLEDGED=yes`, and `/api/tick` refuses live mode until the go-live checklist passes (`GO_LIVE` in settings.ts, `liveGate` in `src/lib/bot.ts`). On 28 Oct 2026 the user chose to go live after one week of paper trading (from 4 Nov 2026) instead of 30 profitable paper trades. Don't loosen the checklist without their explicit say-so.
- The live CoinJar key must be trade-only: `checkCoinjarKey` rejects keys with withdrawal or transfer permission on every live run.
- Never ask the user to paste API keys into chat. Keys go in Vercel env vars.

## Research

Record every study in `docs/research-log.md` (newest first): what was tested, on which data, unseen-period results, and the decision. Read it before starting new research so work isn't repeated. `npx tsx scripts/research/variants.ts` checks settings robustness on CoinJar and Binance data.

## Knowledge update procedure

When the user asks for a "knowledge update" (or "update the bot's research"):

1. Research the last 24-72 hours with web search: crypto market moves and sentiment for BTC, ETH, SOL, XRP; macro events (FOMC, US CPI/jobs data, RBA decisions); exchange incidents or hacks; Australian/US regulatory news; anything specific to CoinJar.
2. Decide, conservatively:
   - `market_bias`: -1 (very bearish) to +1 (very bullish). Default near 0; go beyond ±0.5 only with strong, specific evidence. The bot can only move probabilities ±5 points from research, and the effect halves every 36h and expires after 72h.
   - `product_bias`: per-product overrides only where news is product-specific, e.g. `{"SOLAUD": -0.4}`.
   - `pause_trading`: true only for exceptional risk (exchange outage or hack, market-wide crash in progress).
   - `risk_events`: scheduled high-volatility events in the next 72h, as `[{"at": "<ISO UTC time>", "description": "US CPI release"}]`. The bot opens no trades within 2h of these.
3. Insert one row into `knowledge_briefs` in the bot's Supabase project with the Supabase MCP `execute_sql` tool:

   ```sql
   insert into public.knowledge_briefs (market_bias, product_bias, pause_trading, risk_events, summary, sources)
   values (0.1, '{}'::jsonb, false, '[{"at":"2026-11-12T13:30:00Z","description":"US CPI"}]'::jsonb,
           'Two-sentence summary of what you found and why you chose the bias.',
           '["https://source-1", "https://source-2"]'::jsonb);
   ```

4. Tell the user the bias you set, the risk events and the sources. Point out that research only nudges decisions; it never overrides the expected-value gate or the risk rules.

Supabase project for the bot: `trading-bot`, ref `asfjmvptnmisgelxvcrz` (ap-southeast-2, Sydney). Never touch the user's other Supabase projects.
