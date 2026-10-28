import type { BotState, Candle, Position, ProductRules, TradeProposal } from "@/lib/types";
import { newState } from "@/lib/store/store";

export const HOUR = 3_600_000;

export function state(overrides: Partial<BotState> = {}): BotState {
  return { ...newState(500, Date.UTC(2026, 9, 1)), ...overrides };
}

export function proposal(overrides: Partial<TradeProposal> = {}): TradeProposal {
  return {
    productId: "BTCAUD",
    entryPrice: 100_000,
    stopPrice: 98_000,
    takeProfitPrice: 102_000,
    winProbability: 0.6,
    expectedValuePct: 0.005,
    agents: ["trend_momentum"],
    reasons: [],
    ...overrides,
  };
}

export function position(overrides: Partial<Position> = {}): Position {
  return {
    id: "pos-1",
    productId: "BTCAUD",
    size: 0.0005,
    entryPrice: 100_000,
    stopPrice: 98_000,
    takeProfitPrice: 102_000,
    entryFee: 0.05,
    openedAt: Date.UTC(2026, 9, 1),
    stopOrderId: null,
    winProbability: 0.6,
    expectedValuePct: 0.005,
    agents: ["trend_momentum"],
    jevProbability: null,
    exploration: false,
    ...overrides,
  };
}

export function candle(time: number, close: number, spread = 0.002, volume = 1): Candle {
  return { time, open: close, high: close * (1 + spread), low: close * (1 - spread), close, volume };
}

/** A steady uptrend with small wiggles: stacked EMAs, RSI in the 50s-60s. */
export function uptrend(n: number, start: number, end: number, step: number = HOUR): Candle[] {
  return Array.from({ length: n }, (_, i) => {
    const base = 100 * (1 + 0.001 * i) * (1 + 0.004 * Math.sin(i / 2));
    return candle(start + i * step, base, 0.003, 1);
  }).filter((c) => c.time < end);
}

export const fixedRules = (increment: number): ProductRules => ({ id: "X", sizeIncrementAt: () => increment });
