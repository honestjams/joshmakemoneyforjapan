/**
 * Every tunable number in the bot lives here so changes are visible in one diff.
 *
 * RISK rules are enforced by plain code in src/lib/agents/risk.ts. No AI layer
 * (strategies, research brief, JEV) can loosen them.
 */
export const RISK = {
  /** Your rule: never put more than 10% of remaining capital into one trade. */
  maxPositionPctOfEquity: 0.1,
  /** Your rule: never lose more than 10% of remaining capital on one trade (stop-loss distance makes the real figure much smaller). */
  maxLossPctOfEquityPerTrade: 0.1,
  /** Stop opening trades for the rest of the UTC day once down this much from the day's start. */
  dailyLossLimitPct: 0.05,
  /** Kill switch: halt all trading if equity falls this far below its peak. Needs a manual reset. */
  maxDrawdownPct: 0.2,
  /** One per market. With 10% each, at most 40% of equity is ever in the market. */
  maxOpenPositions: 4,
  /** Skip markets whose bid/ask spread is wider than this (thin liquidity = hidden cost). */
  maxSpreadPct: 0.004,
};

export const MARKETS = {
  /** CoinJar's most active AUD markets. */
  products: ["BTCAUD", "ETHAUD", "SOLAUD", "XRPAUD"],
  /** Wait this long after closing a market before trading it again. */
  reentryCooldownMs: 4 * 60 * 60 * 1000,
};

/**
 * Donchian trend following (see scripts/research/trend.ts). Buy when the
 * close breaks above the highest close of the last `entryLookback` candles;
 * sell when it closes below the lowest close of the last `exitLookback`
 * candles. An exchange-side emergency stop sits `stopAtr` ATRs below entry.
 */
export const TREND = {
  entryLookback: 55,
  exitLookback: 20,
  stopAtr: 3,
};

export const DECISION = {
  /** Only trade when expected return per trade (after fees and spread) is at least this. 0.001 = +0.1%. */
  minExpectedValuePct: 0.001,
  /** A strategy needs at least this many measured trades before the bot trusts its numbers. */
  minCalibrationTrades: 20,
};

export const FEES = {
  /** CoinJar Exchange, $0-$100k monthly volume, AUD pairs. Maker and taker are both 0.10%. */
  takerRate: 0.001,
  /** Allowance for slippage when a stop-loss fills below its trigger price (CoinJar's books are thin). */
  stopSlippagePct: 0.005,
  /** Half the bid/ask spread, for backtests. CoinJar AUD spreads measured 0.15-0.28% (Oct 2026). */
  backtestHalfSpread: 0.001,
};

export const RESEARCH = {
  /** A knowledge brief's influence fades to zero over this period, so stale research can't steer trades. */
  briefHalfLifeMs: 36 * 60 * 60 * 1000,
  briefMaxAgeMs: 72 * 60 * 60 * 1000,
  /** Largest change (in probability points) research can make to a win-probability estimate. */
  maxProbabilityAdjustment: 0.05,
  /** Don't open trades this close to a flagged risk event. */
  riskEventWindowMs: 2 * 60 * 60 * 1000,
};

/**
 * Your rule: paper trade until returns are positive. Live mode refuses to run
 * until the paper account's closed trades clear every bar below.
 */
export const GO_LIVE = {
  minPaperTrades: 30,
  /** Net P/L after fees must be above zero... */
  minTotalPnl: 0,
  /** ...and gross wins must exceed gross losses by at least this factor. */
  minProfitFactor: 1.1,
};

export const JEV = {
  /** Weight given to JEV's probability vs the bot's own calibrated estimate, once JEV is connected. */
  blendWeight: 0.5,
  timeoutMs: 2000,
};
