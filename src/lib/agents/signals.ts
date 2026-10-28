import { atr, bollinger, ema, priorHigh, rsi, sma } from "../indicators";
import type { Candle, Signal } from "../types";

/** Indicator series computed once per candle set and shared by every signal agent. */
export interface Features {
  candles: Candle[];
  close: number[];
  ema20: number[];
  ema50: number[];
  ema200: number[];
  rsi14: number[];
  atr14: number[];
  bbUpper: number[];
  bbLower: number[];
  volSma20: number[];
}

export function computeFeatures(candles: Candle[]): Features {
  const close = candles.map((c) => c.close);
  const bb = bollinger(close, 20, 2);
  return {
    candles,
    close,
    ema20: ema(close, 20),
    ema50: ema(close, 50),
    ema200: ema(close, 200),
    rsi14: rsi(close, 14),
    atr14: atr(candles, 14),
    bbUpper: bb.upper,
    bbLower: bb.lower,
    volSma20: sma(
      candles.map((c) => c.volume),
      20,
    ),
  };
}

export interface SignalAgent {
  name: string;
  /** Evaluate the setup on the closed candle at index i. */
  evaluate(f: Features, i: number): Signal;
}

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
const flat = (agent: string, reason: string): Signal => ({ agent, direction: "flat", confidence: 0, reason });

/** Rides established uptrends: stacked EMAs, healthy (not overbought) momentum. */
export const trendMomentum: SignalAgent = {
  name: "trend_momentum",
  evaluate(f, i) {
    const { close, ema20, ema50, ema200, rsi14, atr14 } = f;
    if (i < 203 || Number.isNaN(ema200[i])) return flat(this.name, "warming up");
    const stacked = ema20[i] > ema50[i] && ema50[i] > ema200[i];
    const rising = ema20[i] > ema20[i - 3];
    const healthyRsi = rsi14[i] >= 52 && rsi14[i] <= 68;
    if (!(stacked && rising && healthyRsi && close[i] > ema20[i])) return flat(this.name, "no uptrend setup");
    const separation = (ema20[i] - ema50[i]) / atr14[i];
    return {
      agent: this.name,
      direction: "long",
      confidence: clamp01(separation / 2),
      reason: `EMAs stacked up, RSI ${rsi14[i].toFixed(0)}, EMA20 ${separation.toFixed(2)} ATR above EMA50`,
    };
  },
};

/** Buys sharp dips below the lower Bollinger band when the bigger trend is intact and the candle shows a bounce. */
export const meanReversion: SignalAgent = {
  name: "mean_reversion",
  evaluate(f, i) {
    const { candles, close, bbLower, rsi14, ema200, atr14 } = f;
    if (i < 203 || Number.isNaN(ema200[i])) return flat(this.name, "warming up");
    const c = candles[i];
    const stretched = c.low < bbLower[i] && rsi14[i] < 32;
    const bounce = c.close > c.open;
    const trendIntact = close[i] > ema200[i] * 0.97;
    if (!(stretched && bounce && trendIntact)) return flat(this.name, "no oversold bounce");
    const depth = (bbLower[i] - c.low) / atr14[i];
    return {
      agent: this.name,
      direction: "long",
      confidence: clamp01(0.4 + depth / 2),
      reason: `Pierced lower band by ${depth.toFixed(2)} ATR, RSI ${rsi14[i].toFixed(0)}, bullish close`,
    };
  },
};

/** Buys closes above the prior 20-candle high on above-average volume, in a rising market. */
export const volumeBreakout: SignalAgent = {
  name: "volume_breakout",
  evaluate(f, i) {
    const { candles, close, ema50, ema200, volSma20 } = f;
    if (i < 203 || Number.isNaN(ema200[i])) return flat(this.name, "warming up");
    const high20 = priorHigh(candles, i, 20);
    const volRatio = volSma20[i] > 0 ? candles[i].volume / volSma20[i] : 0;
    if (!(close[i] > high20 && volRatio >= 1.5 && ema50[i] > ema200[i])) return flat(this.name, "no breakout");
    return {
      agent: this.name,
      direction: "long",
      confidence: clamp01(volRatio / 4),
      reason: `Closed above 20-candle high on ${volRatio.toFixed(1)}x volume`,
    };
  },
};

export const SIGNAL_AGENTS: SignalAgent[] = [trendMomentum, meanReversion, volumeBreakout];
