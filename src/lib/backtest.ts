import { FEES, STRATEGY } from "@/config/settings";
import type { Calibration } from "./agents/decision";
import { bracket } from "./agents/decision";
import type { DecisionModel } from "./agents/jev";
import { checkExit } from "./agents/risk";
import { computeFeatures, SIGNAL_AGENTS } from "./agents/signals";
import { type MarketData, runTick } from "./engine";
import { PaperBroker } from "./exchange/broker";
import { MemoryStore, newState } from "./store/store";
import type { Candle, ClosedTrade, Position, ProductRules } from "./types";

/** Half the bid/ask spread, applied to historical closes. CoinJar AUD spreads measured 0.15-0.28% (Oct 2026). */
export const BACKTEST_HALF_SPREAD = 0.001;

/** Replays stored candles as if they were live, up to `now`. */
export class HistoricalMarket implements MarketData {
  now = 0;

  constructor(
    private readonly series: Map<string, Candle[]>,
    private readonly productRules: Map<string, ProductRules>,
  ) {}

  async candles(pid: string, _interval: string, from: number, to: number): Promise<Candle[]> {
    const all = this.series.get(pid) ?? [];
    const end = upperBound(all, to - STRATEGY.candleMs); // closed by `to`
    const start = upperBound(all, from - 1);
    return all.slice(start, end);
  }

  async ticker(pid: string) {
    const all = this.series.get(pid) ?? [];
    const idx = upperBound(all, this.now - STRATEGY.candleMs) - 1;
    if (idx < 0) throw new Error(`no history for ${pid} at ${new Date(this.now).toISOString()}`);
    const close = all[idx].close;
    return { bid: close * (1 - BACKTEST_HALF_SPREAD), ask: close * (1 + BACKTEST_HALF_SPREAD), last: close, status: "continuous" };
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

export interface AgentStudy {
  wins: number;
  losses: number;
  /** Mean net return per trade (after fees, spread and stop slippage). */
  avgReturn: number;
}

/**
 * Measures each signal agent on its own: every time it fires, simulate the
 * bracket trade forward with fees. Trades by the same agent on the same
 * product never overlap, so one long move isn't counted many times.
 */
export function studyAgents(series: Map<string, Candle[]>, fromMs: number, toMs: number): Record<string, AgentStudy> {
  const out: Record<string, AgentStudy & { sum: number }> = {};
  for (const [pid, candles] of series) {
    const busyUntil: Record<string, number> = {};
    for (let i = STRATEGY.lookbackCandles - 1; i < candles.length; i++) {
      const entryTime = candles[i].time + STRATEGY.candleMs;
      if (entryTime < fromMs || entryTime > toMs) continue;
      const window = candles.slice(i - STRATEGY.lookbackCandles + 1, i + 1);
      const f = computeFeatures(window);
      const k = window.length - 1;
      for (const agent of SIGNAL_AGENTS) {
        if ((busyUntil[agent.name] ?? -1) >= i) continue;
        if (agent.evaluate(f, k).direction !== "long") continue;
        const entry = candles[i].close * (1 + BACKTEST_HALF_SPREAD);
        const { stop, takeProfit } = bracket(entry, f.atr14[k]);
        const pos: Position = {
          id: "study",
          productId: pid,
          size: 1,
          entryPrice: entry,
          stopPrice: stop,
          takeProfitPrice: takeProfit,
          entryFee: entry * FEES.takerRate,
          openedAt: entryTime,
          stopOrderId: null,
          winProbability: 0,
          expectedValuePct: 0,
          agents: [agent.name],
          jevProbability: null,
          exploration: false,
        };
        let j = i + 1;
        let exit: ReturnType<typeof checkExit> = null;
        for (; j < candles.length && !exit; j++) exit = checkExit(pos, candles[j], STRATEGY.candleMs);
        if (!exit) break; // ran out of data; the open trade is not counted
        const exitPrice = exit.reason === "take_profit" || exit.reason === "stop_loss" ? exit.price : exit.price * (1 - BACKTEST_HALF_SPREAD);
        const ret = (exitPrice * (1 - FEES.takerRate) - entry * (1 + FEES.takerRate)) / entry;
        const rec = (out[agent.name] ??= { wins: 0, losses: 0, avgReturn: 0, sum: 0 });
        if (ret > 0) rec.wins++;
        else rec.losses++;
        rec.sum += ret;
        busyUntil[agent.name] = j - 1;
      }
    }
  }
  return Object.fromEntries(
    Object.entries(out).map(([k, v]) => [k, { wins: v.wins, losses: v.losses, avgReturn: v.sum / Math.max(1, v.wins + v.losses) }]),
  );
}

export function toCalibration(study: Record<string, AgentStudy>): Calibration {
  return Object.fromEntries(Object.entries(study).map(([k, v]) => [k, { wins: v.wins, losses: v.losses }]));
}

export interface SimulationResult {
  startCash: number;
  endEquity: number;
  trades: ClosedTrade[];
  maxDrawdownPct: number;
  halted: boolean;
}

const noJev: DecisionModel = { name: "none", winProbability: async () => null };

/** Runs the real engine, candle by candle, over [fromMs, toMs) with a paper account. */
export async function simulate(args: {
  series: Map<string, Candle[]>;
  rules: Map<string, ProductRules>;
  calibration: Calibration;
  startCash: number;
  fromMs: number;
  toMs: number;
  explore?: boolean;
}): Promise<SimulationResult> {
  const market = new HistoricalMarket(args.series, args.rules);
  const store = new MemoryStore();
  await store.saveState(newState(args.startCash, args.fromMs));
  let peak = args.startCash;
  let maxDd = 0;
  let equity = args.startCash;
  for (let t = args.fromMs; t < args.toMs; t += STRATEGY.candleMs) {
    market.now = t;
    const res = await runTick({
      store,
      createBroker: (s) => new PaperBroker(s),
      market,
      decisionModel: noJev,
      baseCalibration: args.calibration,
      initialCash: args.startCash,
      now: t,
      products: [...args.series.keys()],
      explore: args.explore,
    });
    if (res.errors.length) throw new Error(res.errors.join("; "));
    equity = res.equity;
    peak = Math.max(peak, equity);
    maxDd = Math.max(maxDd, (peak - equity) / peak);
  }
  return { startCash: args.startCash, endEquity: equity, trades: store.trades, maxDrawdownPct: maxDd, halted: store.state?.halted ?? false };
}
