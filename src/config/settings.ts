/**
 * Every tunable number in the bot lives here so changes are visible in one diff.
 *
 * RISK rules are enforced by plain code in src/lib/agents/risk.ts. No AI layer
 * (signal agents, research brief, JEV) can loosen them.
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
  maxOpenPositions: 3,
  /** Skip markets whose bid/ask spread is wider than this (thin liquidity = hidden cost). */
  maxSpreadPct: 0.004,
};

export const STRATEGY = {
  /** CoinJar's most active AUD markets. */
  products: ["BTCAUD", "ETHAUD", "SOLAUD", "XRPAUD"],
  /**
   * 1h, not 15m: CoinJar's 15-minute moves (~0.15-0.2%) are smaller than a
   * round trip's fees + spread (~0.4%), so 15m trading loses on costs alone.
   */
  candleInterval: "1h",
  candleMs: 60 * 60 * 1000,
  /** Candles fetched per evaluation (enough for EMA-200 to settle). */
  lookbackCandles: 300,
  /** Stop-loss distance in ATRs below entry. */
  stopAtr: 2,
  /** Take-profit distance in ATRs above entry. */
  takeProfitAtr: 2,
  /** Close anything still open after this long. */
  maxHoldMs: 24 * 60 * 60 * 1000,
  /** Wait this long after closing a product before trading it again. */
  reentryCooldownMs: 2 * 60 * 60 * 1000,
  /** Only trade when the calibrated chance of hitting take-profit first is at least this. */
  minWinProbability: 0.55,
  /** Only trade when expected value after fees/spread is at least this (0.001 = +0.1% per trade). */
  minExpectedValuePct: 0.001,
};

export const FEES = {
  /** CoinJar Exchange, $0-$100k monthly volume, AUD pairs. Maker and taker are both 0.10%. */
  takerRate: 0.001,
  /** Allowance for slippage when a stop-loss fills below its trigger price. */
  stopSlippagePct: 0.002,
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

export const JEV = {
  /** Weight given to JEV's probability vs the bot's own calibrated estimate, once JEV is connected. */
  blendWeight: 0.5,
  timeoutMs: 2000,
};
