import { describe, expect, it } from "vitest";
import { STRATEGY } from "@/config/settings";
import { tradingMode } from "@/lib/bot";
import { runTick, type EngineDeps } from "@/lib/engine";
import { HistoricalMarket } from "@/lib/backtest";
import { PaperBroker, type Broker } from "@/lib/exchange/broker";
import { MemoryStore, newState } from "@/lib/store/store";
import type { Candle, Signal } from "@/lib/types";
import { SIGNAL_AGENTS } from "@/lib/agents/signals";
import { fixedRules, HOUR } from "./helpers";
import { vi } from "vitest";

const START = Date.UTC(2026, 0, 1);

/** Flat market, then a final candle that rallies through any target. */
function series(n: number, rallyAt: number): Candle[] {
  return Array.from({ length: n }, (_, i) => {
    const close = i < rallyAt ? 100 * (1 + 0.0005 * Math.sin(i)) : 120;
    return { time: START + i * HOUR, open: close, high: close * 1.001, low: close * 0.999, close, volume: 1 };
  });
}

function deps(store: MemoryStore, market: HistoricalMarket, overrides: Partial<EngineDeps> = {}): EngineDeps {
  return {
    store,
    createBroker: (s) => new PaperBroker(s),
    market,
    decisionModel: { name: "none", winProbability: async () => null },
    baseCalibration: {},
    initialCash: 500,
    products: ["BTCAUD"],
    ...overrides,
  };
}

describe("runTick (paper)", () => {
  const forceLong = () =>
    vi.spyOn(SIGNAL_AGENTS[0], "evaluate").mockImplementation((): Signal => ({ agent: "trend_momentum", direction: "long", confidence: 1, reason: "forced" }));

  it("does not trade uncalibrated signals with exploration off", async () => {
    const spy = forceLong();
    const market = new HistoricalMarket(new Map([["BTCAUD", series(400, 1000)]]), new Map([["BTCAUD", fixedRules(0.01)]]));
    const store = new MemoryStore();
    await store.saveState(newState(500, START));
    market.now = START + 350 * HOUR;
    const res = await runTick({ ...deps(store, market), now: market.now });
    expect(res.actions.filter((a) => a.startsWith("BUY"))).toHaveLength(0);
    spy.mockRestore();
  });

  it("opens a 10%-sized exploration trade, then closes it at the target with fees counted", async () => {
    const spy = forceLong();
    const market = new HistoricalMarket(new Map([["BTCAUD", series(400, 352)]]), new Map([["BTCAUD", fixedRules(0.01)]]));
    const store = new MemoryStore();
    await store.saveState(newState(500, START));

    market.now = START + 350 * HOUR;
    const first = await runTick({ ...deps(store, market, { explore: true }), now: market.now });
    expect(first.actions[0]).toMatch(/^BUY/);
    expect(store.positions).toHaveLength(1);
    const pos = store.positions[0];
    expect(pos.size * pos.entryPrice + pos.entryFee).toBeLessThanOrEqual(50 + 1e-9);
    expect(pos.exploration).toBe(true);

    market.now = START + 354 * HOUR;
    const second = await runTick({ ...deps(store, market, { explore: true }), now: market.now });
    expect(second.actions.some((a) => a.includes("take_profit"))).toBe(true);
    expect(store.positions).toHaveLength(0);
    expect(store.trades[0].pnl).toBeGreaterThan(0);
    expect(store.state!.paperCash).toBeCloseTo(500 + store.trades[0].pnl, 6);
    spy.mockRestore();
  });

  it("never explores with a live broker", async () => {
    const spy = forceLong();
    const market = new HistoricalMarket(new Map([["BTCAUD", series(400, 1000)]]), new Map([["BTCAUD", fixedRules(0.01)]]));
    const store = new MemoryStore();
    await store.saveState(newState(500, START));
    const buy = vi.fn();
    const live: Broker = {
      mode: "live",
      availableCash: async () => 500,
      buy,
      sell: vi.fn(),
      placeStop: vi.fn(),
      stopStatus: vi.fn(),
      cancelStop: vi.fn(),
    };
    market.now = START + 350 * HOUR;
    await runTick({ ...deps(store, market, { explore: true, createBroker: () => live }), now: market.now });
    expect(buy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("halts on the drawdown kill switch and opens nothing", async () => {
    const spy = forceLong();
    const market = new HistoricalMarket(new Map([["BTCAUD", series(400, 1000)]]), new Map([["BTCAUD", fixedRules(0.01)]]));
    const store = new MemoryStore();
    await store.saveState({ ...newState(500, START), peakEquity: 1000, paperCash: 500, day: "2026-01-15", dayStartEquity: 500 });
    market.now = START + 350 * HOUR;
    const res = await runTick({ ...deps(store, market, { explore: true }), now: market.now });
    expect(store.state!.halted).toBe(true);
    expect(res.actions.some((a) => a.startsWith("BUY"))).toBe(false);
    spy.mockRestore();
  });
});

describe("tradingMode", () => {
  it("defaults to paper and needs explicit acknowledgement for live", () => {
    const env = { ...process.env };
    delete process.env.TRADING_MODE;
    expect(tradingMode()).toBe("paper");
    process.env.TRADING_MODE = "live";
    process.env.COINJAR_API_KEY = "x";
    expect(() => tradingMode()).toThrow(/LIVE_TRADING_ACKNOWLEDGED/);
    process.env.LIVE_TRADING_ACKNOWLEDGED = "yes";
    expect(tradingMode()).toBe("live");
    process.env = env;
  });
});

it("strategy candle settings are consistent", () => {
  expect(STRATEGY.candleMs).toBe(60 * 60 * 1000);
});
