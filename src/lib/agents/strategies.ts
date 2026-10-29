import { TREND } from "@/config/settings";
import { intervalMs } from "../exchange/coinjar";
import { atr, last } from "../indicators";
import type { Candle } from "../types";

/**
 * A strategy agent watches one timeframe and decides when to get in and out.
 * It sees closed candles only, oldest first; the last one just closed.
 */
export interface Strategy {
  name: string;
  interval: string;
  candleMs: number;
  /** Closed candles needed to evaluate it. */
  lookbackCandles: number;
  /** Reason to buy now, or null. */
  entry(candles: Candle[]): string | null;
  /** Reason to sell an open position now, or null. */
  exit(candles: Candle[]): string | null;
  /** Emergency stop-loss for a new position. */
  stopPrice(candles: Candle[], entryPrice: number): number;
  /** Numbers describing the setup, for JEV. */
  features(candles: Candle[]): Record<string, number>;
}

const closesBefore = (c: Candle[], n: number) => c.slice(-n - 1, -1).map((k) => k.close);

/**
 * Donchian channel breakout, the classic trend-following rule. Buys a close
 * above the prior N-candle closing high; exits on a close below the prior
 * M-candle closing low. Wins less than half the time but the winners run.
 */
export function donchianBreakout(interval: string, entryN: number, exitN: number, stopAtr: number, name?: string): Strategy {
  return {
    name: name ?? `donchian_${entryN}_${exitN}_${interval}`,
    interval,
    candleMs: intervalMs(interval),
    lookbackCandles: Math.max(entryN, exitN) + 30,
    entry(c) {
      if (c.length < entryN + 1) return null;
      const high = Math.max(...closesBefore(c, entryN));
      const close = last(c).close;
      return close > high ? `${interval} close ${close} broke the ${entryN}-candle high ${high}` : null;
    },
    exit(c) {
      if (c.length < exitN + 1) return null;
      const low = Math.min(...closesBefore(c, exitN));
      const close = last(c).close;
      return close < low ? `${interval} close ${close} fell below the ${exitN}-candle low ${low}` : null;
    },
    stopPrice(c, entryPrice) {
      return entryPrice - stopAtr * last(atr(c, 14));
    },
    features(c) {
      const close = last(c).close;
      const high = Math.max(...closesBefore(c, entryN));
      return {
        atrPct: last(atr(c, 14)) / close,
        breakoutPct: close / high - 1,
        return20Pct: close / c[Math.max(0, c.length - 21)].close - 1,
      };
    },
  };
}

/**
 * Strategies in priority order (one position per market, first signal wins).
 *
 * Daily only: on unseen 2023-2026 data it beat the 4h version (+44% vs +38%
 * on $500, drawdown 12% vs 18%), and running both together was worse than
 * either, because 4h breakouts grabbed the market slot first and exited early.
 */
export const STRATEGIES: Strategy[] = [donchianBreakout("1d", TREND.entryLookback, TREND.exitLookback, TREND.stopAtr)];

export function strategyByName(name: string): Strategy | undefined {
  return STRATEGIES.find((s) => s.name === name);
}
