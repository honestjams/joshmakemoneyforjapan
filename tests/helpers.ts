import type { BotState, Candle, Position, ProductRules, TradeProposal } from "@/lib/types";
import { newState } from "@/lib/store/store";

export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;

export function state(overrides: Partial<BotState> = {}): BotState {
  return { ...newState(500, Date.UTC(2026, 9, 1)), ...overrides };
}

export function proposal(overrides: Partial<TradeProposal> = {}): TradeProposal {
  return {
    productId: "BTCAUD",
    strategy: "donchian_55_20_1d",
    entryPrice: 100_000,
    stopPrice: 90_000,
    winProbability: 0.5,
    expectedValuePct: 0.1,
    reason: "test",
    ...overrides,
  };
}

export function position(overrides: Partial<Position> = {}): Position {
  return {
    id: "pos-1",
    productId: "BTCAUD",
    size: 0.0005,
    entryPrice: 100_000,
    stopPrice: 90_000,
    entryFee: 0.05,
    openedAt: Date.UTC(2026, 9, 1),
    stopOrderId: null,
    strategy: "donchian_55_20_1d",
    winProbability: 0.5,
    expectedValuePct: 0.1,
    jevProbability: null,
    ...overrides,
  };
}

export function candle(time: number, close: number, range = 0.01): Candle {
  return { time, open: close, high: close * (1 + range), low: close * (1 - range), close, volume: 1 };
}

/** Daily candles from a list of closes. */
export function daily(start: number, closes: number[], range = 0.01): Candle[] {
  return closes.map((c, i) => candle(start + i * DAY, c, range));
}

export const fixedRules = (increment: number): ProductRules => ({ id: "X", sizeIncrementAt: () => increment });

/** A record good enough to pass the decision agent's bar. */
export const goodCalibration = { donchian_55_20_1d: { wins: 40, losses: 45, winSum: 18.9, lossSum: 4.9 } };
