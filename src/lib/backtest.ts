import { FEES } from "@/config/settings";
import type { Calibration } from "./agents/decision";
import type { DecisionModel } from "./agents/jev";
import { stopFill } from "./agents/risk";
import type { Strategy } from "./agents/strategies";
import { type MarketData, runTick } from "./engine";
import { PaperBroker } from "./exchange/broker";
import { intervalMs } from "./exchange/coinjar";
import { MemoryStore, newState } from "./store/store";
import type { Candle, ClosedTrade, Position, ProductRules } from "./types";

const seriesKey = (pid: string, interval: string) => `${pid}:${interval}`;

/** Replays stored candles as if they were live, up to `now`. */
export class HistoricalMarket implements MarketData {
  now = 0;

  /**
   * @param series candles keyed by "PRODUCT:interval"
   * @param tickerInterval the finest interval loaded; its last close (± half-spread) is the simulated bid/ask
   */
  constructor(
    private readonly series: Map<string, Candle[]>,
    private readonly productRules: Map<string, ProductRules>,
    private readonly tickerInterval: string,
  ) {}

  static key = seriesKey;

  async candles(pid: string, interval: string, from: number, to: number): Promise<Candle[]> {
    const all = this.series.get(seriesKey(pid, interval)) ?? [];
    const end = upperBound(all, to - intervalMs(interval)); // closed by `to`
    const start = upperBound(all, from - 1);
    return all.slice(start, end);
  }

  async ticker(pid: string) {
    const all = this.series.get(seriesKey(pid, this.tickerInterval)) ?? [];
    const idx = upperBound(all, this.now - intervalMs(this.tickerInterval)) - 1;
    if (idx < 0) throw new Error(`no history for ${pid} at ${new Date(this.now).toISOString()}`);
    const close = all[idx].close;
    return { bid: close * (1 - FEES.backtestHalfSpread), ask: close * (1 + FEES.backtestHalfSpread), last: close, status: "continuous" };
  }

  async rules() {
    return this.productRules;
  }
}

/** Index of the first candle whose time is > t. */
function upperBound(candles: Candle[], t: number): number {
  let lo = 0;
  let hi = candles.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (candles[mid].time <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export interface StudyTrade {
  strategy: string;
  productId: string;
  entryTime: number;
  exitTime: number;
  /** Net return after fees, spread and stop slippage. */
  ret: number;
}

/**
 * One strategy on one market on its own (no portfolio limits), with the same
 * entry, exit and stop rules as the engine. Used to measure a strategy's
 * record for calibration.
 */
export function studyStrategy(strategy: Strategy, productId: string, candles: Candle[], fromMs = -Infinity, toMs = Infinity): StudyTrade[] {
  const trades: StudyTrade[] = [];
  const buyCost = (1 + FEES.backtestHalfSpread) * (1 + FEES.takerRate);
  const sellKeep = (1 - FEES.backtestHalfSpread) * (1 - FEES.takerRate);
  let pos: Position | null = null;
  for (let i = strategy.lookbackCandles - 1; i < candles.length; i++) {
    const closeTime = candles[i].time + strategy.candleMs;
    const window = candles.slice(i - strategy.lookbackCandles + 1, i + 1);
    if (pos) {
      const stop = stopFill(pos, candles[i]);
      const signal = stop === null ? strategy.exit(window) : null;
      if (stop !== null || signal) {
        const exitPrice = stop !== null ? stop * (1 - FEES.takerRate) : candles[i].close * sellKeep;
        trades.push({ strategy: strategy.name, productId, entryTime: pos.openedAt, exitTime: closeTime, ret: exitPrice / pos.entryPrice - 1 });
        pos = null;
      }
      continue;
    }
    if (closeTime < fromMs || closeTime > toMs) continue;
    if (!strategy.entry(window)) continue;
    const entry = candles[i].close * buyCost;
    pos = {
      id: "study",
      productId,
      size: 1,
      entryPrice: entry,
      stopPrice: strategy.stopPrice(window, candles[i].close),
      entryFee: 0,
      openedAt: closeTime,
      stopOrderId: null,
      strategy: strategy.name,
      winProbability: 0,
      expectedValuePct: 0,
      jevProbability: null,
    };
  }
  return trades; // a position still open at the end isn't counted
}

export function toCalibration(trades: StudyTrade[]): Calibration {
  const cal: Calibration = {};
  for (const t of trades) {
    const rec = (cal[t.strategy] ??= { wins: 0, losses: 0, winSum: 0, lossSum: 0 });
    if (t.ret > 0) {
      rec.wins++;
      rec.winSum += t.ret;
    } else {
      rec.losses++;
      rec.lossSum -= t.ret;
    }
  }
  return cal;
}

export interface SimulationResult {
  startCash: number;
  endEquity: number;
  trades: ClosedTrade[];
  maxDrawdownPct: number;
  halted: boolean;
  /** Equity after each step, for rolling-window analysis. */
  curve: { t: number; equity: number }[];
}

const noJev: DecisionModel = { name: "none", winProbability: async () => null };

/** Runs the real engine, step by step, over [fromMs, toMs) with a paper account. */
export async function simulate(args: {
  series: Map<string, Candle[]>;
  tickerInterval: string;
  rules: Map<string, ProductRules>;
  calibration: Calibration;
  strategies: readonly Strategy[];
  products: readonly string[];
  startCash: number;
  fromMs: number;
  toMs: number;
}): Promise<SimulationResult> {
  const market = new HistoricalMarket(args.series, args.rules, args.tickerInterval);
  const store = new MemoryStore();
  await store.saveState(newState(args.startCash, args.fromMs));
  const step = intervalMs(args.tickerInterval);
  let peak = args.startCash;
  let maxDd = 0;
  let equity = args.startCash;
  const curve: { t: number; equity: number }[] = [];
  for (let t = Math.ceil(args.fromMs / step) * step + 5 * 60_000; t < args.toMs; t += step) {
    market.now = t;
    const res = await runTick({
      store,
      createBroker: (s) => new PaperBroker(s),
      market,
      decisionModel: noJev,
      baseCalibration: args.calibration,
      initialCash: args.startCash,
      now: t,
      products: args.products,
      strategies: args.strategies,
    });
    // Markets that hadn't listed yet (SOLAUD before Oct 2022) simply have no data.
    const real = res.errors.filter((e) => !e.includes("no history"));
    if (real.length) throw new Error(real.join("; "));
    equity = res.equity;
    curve.push({ t, equity });
    peak = Math.max(peak, equity);
    maxDd = Math.max(maxDd, (peak - equity) / peak);
  }
  return { startCash: args.startCash, endEquity: equity, trades: store.trades, maxDrawdownPct: maxDd, halted: store.state?.halted ?? false, curve };
}
