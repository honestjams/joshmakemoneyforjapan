import { FEES, STRATEGY } from "@/config/settings";
import type { Features } from "./signals";
import type { Signal, TradeProposal } from "../types";

/** Historical results per signal agent (from backtests plus live trades). */
export type Calibration = Record<string, { wins: number; losses: number }>;

/**
 * Probability a signal agent's trade closes in profit, from its measured
 * record. Laplace smoothing pulls small samples toward 50%, so an agent with
 * 3 wins from 3 trades reads as 80%, not 100%.
 */
export function agentWinProbability(calibration: Calibration, agent: string): number {
  const rec = calibration[agent] ?? { wins: 0, losses: 0 };
  return (rec.wins + 1) / (rec.wins + rec.losses + 2);
}

/** Sample-size-weighted probability across every agent that wants to go long. */
export function calibratedWinProbability(calibration: Calibration, longSignals: Signal[]): number {
  let weighted = 0;
  let total = 0;
  for (const s of longSignals) {
    const rec = calibration[s.agent] ?? { wins: 0, losses: 0 };
    const w = rec.wins + rec.losses + 2;
    weighted += agentWinProbability(calibration, s.agent) * w;
    total += w;
  }
  return total === 0 ? 0.5 : weighted / total;
}

/**
 * Expected return per $1 of position after fees, treating outcomes as
 * "take-profit" vs "stop-loss" (with stop slippage). Time-stop exits land
 * between the two, so this is a fair approximation.
 */
export function expectedValuePct(p: number, entry: number, stop: number, takeProfit: number): number {
  const fees = 2 * FEES.takerRate;
  const winPct = (takeProfit - entry) / entry - fees;
  const lossPct = (entry - stop) / entry + FEES.stopSlippagePct + fees;
  return p * winPct - (1 - p) * lossPct;
}

/** Bracket for a long entry, sized by volatility (ATR). */
export function bracket(entry: number, atrValue: number): { stop: number; takeProfit: number } {
  return {
    stop: entry - STRATEGY.stopAtr * atrValue,
    takeProfit: entry + STRATEGY.takeProfitAtr * atrValue,
  };
}

export interface DecisionInput {
  productId: string;
  features: Features;
  index: number;
  signals: Signal[];
  /** Price we'd actually pay (the ask in live/paper; candle close in backtests). */
  entryPrice: number;
  calibration: Calibration;
  /** Research nudge in probability points (already bounded). */
  probabilityAdjustment?: number;
  /** Optional external model probability (JEV); blended, never trusted alone. */
  blend?: (ownProbability: number) => number;
  /**
   * Paper-only: take every signal regardless of probability/EV thresholds, to
   * collect outcome data (and score JEV) without risking money.
   */
  explore?: boolean;
}

export type Decision = { action: "enter"; proposal: TradeProposal } | { action: "skip"; reason: string };

/**
 * Decision agent: combines signal agents, calibration, research and JEV into
 * one proposal, and only proposes trades whose expected value after fees
 * clears the bar. The risk manager still gets the final say.
 */
export function decide(input: DecisionInput): Decision {
  const longs = input.signals.filter((s) => s.direction === "long");
  if (longs.length === 0) return { action: "skip", reason: "no agent sees a setup" };

  const atrValue = input.features.atr14[input.index];
  if (!(atrValue > 0)) return { action: "skip", reason: "ATR unavailable" };

  const { stop, takeProfit } = bracket(input.entryPrice, atrValue);
  let p = calibratedWinProbability(input.calibration, longs);
  if (input.blend) p = input.blend(p);
  p = Math.max(0, Math.min(1, p + (input.probabilityAdjustment ?? 0)));

  const ev = expectedValuePct(p, input.entryPrice, stop, takeProfit);
  const agents = longs.map((s) => s.agent);
  if (!input.explore && p < STRATEGY.minWinProbability) {
    return { action: "skip", reason: `win probability ${(p * 100).toFixed(1)}% below ${STRATEGY.minWinProbability * 100}% (${agents.join(", ")})` };
  }
  if (!input.explore && ev < STRATEGY.minExpectedValuePct) {
    return { action: "skip", reason: `expected value ${(ev * 100).toFixed(2)}% below ${STRATEGY.minExpectedValuePct * 100}% after fees` };
  }
  return {
    action: "enter",
    proposal: {
      productId: input.productId,
      entryPrice: input.entryPrice,
      stopPrice: stop,
      takeProfitPrice: takeProfit,
      winProbability: p,
      expectedValuePct: ev,
      agents,
      reasons: longs.map((s) => `${s.agent}: ${s.reason}`),
    },
  };
}
