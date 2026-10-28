import { DECISION } from "@/config/settings";

/**
 * Measured record of one strategy: from backtests (calibration.json) plus this
 * account's closed trades. Returns are fractions net of fees and spread.
 */
export interface StrategyRecord {
  wins: number;
  losses: number;
  /** Sum of the returns of winning trades (e.g. 0.25 = +25% in total). */
  winSum: number;
  /** Sum of the absolute returns of losing trades. */
  lossSum: number;
}

export type Calibration = Record<string, StrategyRecord>;

export interface RecordSummary {
  trades: number;
  /** Laplace-smoothed win rate: 3 wins from 3 trades reads as 80%, not 100%. */
  winProbability: number;
  avgWin: number;
  avgLoss: number;
}

export function summarize(rec: StrategyRecord | undefined): RecordSummary {
  const r = rec ?? { wins: 0, losses: 0, winSum: 0, lossSum: 0 };
  return {
    trades: r.wins + r.losses,
    winProbability: (r.wins + 1) / (r.wins + r.losses + 2),
    avgWin: r.wins ? r.winSum / r.wins : 0,
    avgLoss: r.losses ? r.lossSum / r.losses : 0,
  };
}

/** Expected return per $1 risked: p × average win − (1 − p) × average loss. */
export function expectedValuePct(p: number, avgWin: number, avgLoss: number): number {
  return p * avgWin - (1 - p) * avgLoss;
}

export type Decision =
  | { action: "enter"; winProbability: number; expectedValuePct: number; trades: number }
  | { action: "skip"; reason: string };

/**
 * Decision agent: given a strategy's entry signal, decide whether the trade is
 * worth taking. Uses the strategy's measured win rate and win/loss sizes,
 * nudged by research and blended with JEV. The risk manager still has the
 * final say.
 */
export function decide(input: {
  strategy: string;
  calibration: Calibration;
  /** Research nudge in probability points (already bounded). */
  probabilityAdjustment?: number;
  /** Optional external model (JEV); blended, never trusted alone. */
  blend?: (ownProbability: number) => number;
}): Decision {
  const s = summarize(input.calibration[input.strategy]);
  if (s.trades < DECISION.minCalibrationTrades) {
    return { action: "skip", reason: `${input.strategy} has only ${s.trades} measured trades (need ${DECISION.minCalibrationTrades})` };
  }
  let p = s.winProbability;
  if (input.blend) p = input.blend(p);
  p = Math.max(0, Math.min(1, p + (input.probabilityAdjustment ?? 0)));
  const ev = expectedValuePct(p, s.avgWin, s.avgLoss);
  if (ev < DECISION.minExpectedValuePct) {
    return { action: "skip", reason: `expected value ${(ev * 100).toFixed(2)}% below ${DECISION.minExpectedValuePct * 100}% after costs` };
  }
  return { action: "enter", winProbability: p, expectedValuePct: ev, trades: s.trades };
}
