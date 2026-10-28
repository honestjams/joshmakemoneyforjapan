import { describe, expect, it, vi } from "vitest";
import { tradingMode } from "@/lib/bot";
import { runTick, type EngineDeps } from "@/lib/engine";
import { HistoricalMarket } from "@/lib/backtest";
import { PaperBroker, type Broker } from "@/lib/exchange/broker";
import { MemoryStore, newState } from "@/lib/store/store";
import type { Candle } from "@/lib/types";
import { DAY, daily, fixedRules, goodCalibration } from "./helpers";

const START = Date.UTC(2026, 0, 1);
const RANGE = Array.from({ length: 90 }, (_, i) => 100 + (i % 5)); // sideways 100-104

/** Sideways for 90 days, then whatever closes follow. */
function market(after: number[], range = 0.01) {
  const candles: Candle[] = daily(START, [...RANGE, ...after], range);
  return new HistoricalMarket(new Map([[HistoricalMarket.key("BTCAUD", "1d"), candles]]), new Map([["BTCAUD", fixedRules(0.01)]]), "1d");
}

/** The engine runs a few minutes after a daily close; `day` is the index of the candle that just closed. */
const afterClose = (day: number) => START + (day + 1) * DAY + 5 * 60_000;

async function setup(m: HistoricalMarket, overrides: Partial<EngineDeps> = {}) {
  const store = new MemoryStore();
  await store.saveState(newState(500, START));
  const tick = (day: number) => {
    m.now = afterClose(day);
    return runTick({
      store,
      createBroker: (s) => new PaperBroker(s),
      market: m,
      decisionModel: { name: "none", winProbability: async () => null },
      baseCalibration: goodCalibration,
      initialCash: 500,
      products: ["BTCAUD"],
      ...overrides,
      now: m.now,
    });
  };
  return { store, tick };
}

describe("runTick (paper)", () => {
  it("buys a breakout with at most 10% of equity and exits on the 20-day low with fees counted", async () => {
    const m = market([110, 115, 120, 125, 118, 112, 99], 0.05);
    const { store, tick } = await setup(m);

    const quiet = await tick(89);
    expect(quiet.actions).toHaveLength(0);

    const entry = await tick(90); // close 110 > prior 55-day high of 104
    expect(entry.actions[0]).toMatch(/^BUY .*donchian_55_20_1d/);
    const pos = store.positions[0];
    expect(pos.size * pos.entryPrice + pos.entryFee).toBeLessThanOrEqual(50 + 1e-9);

    for (let d = 91; d <= 95; d++) expect((await tick(d)).actions.filter((a) => a.startsWith("SELL"))).toHaveLength(0);
    const exit = await tick(96); // close 100 < prior 20-day low
    expect(exit.actions[0]).toMatch(/^SELL .*signal_exit/);
    expect(store.trades).toHaveLength(1);
    expect(store.state!.paperCash).toBeCloseTo(500 + store.trades[0].pnl, 6);
  });

  it("takes the emergency stop when price crashes through it", async () => {
    const m = market([110, 70], 0.005);
    const { store, tick } = await setup(m);
    await tick(90);
    const crash = await tick(91);
    expect(crash.actions[0]).toMatch(/stop_loss/);
    expect(store.trades[0].pnl).toBeLessThan(0);
    expect(-store.trades[0].pnl).toBeLessThanOrEqual(50); // never more than the 10% position
  });

  it("does not trade a strategy without a proven record", async () => {
    const { store, tick } = await setup(market([110]), { baseCalibration: {} });
    await tick(90);
    expect(store.positions).toHaveLength(0);
  });

  it("acts on the breakout candle that just closed, not one from an earlier day", async () => {
    // Day 90 breaks out (110), day 91 closes at 109 (no new breakout). A bot that was down on day 90 must not buy late on day 91.
    const late = await setup(market([110, 109]));
    await late.tick(91);
    expect(late.store.positions).toHaveLength(0);

    const onTime = await setup(market([110, 109]));
    await onTime.tick(90);
    expect(onTime.store.positions).toHaveLength(1);
  });

  it("halts on the drawdown kill switch and opens nothing", async () => {
    const m = market([110]);
    const store = new MemoryStore();
    await store.saveState({ ...newState(500, START), peakEquity: 1000, day: "2026-04-01", dayStartEquity: 500 });
    m.now = afterClose(90);
    await runTick({
      store,
      createBroker: (s) => new PaperBroker(s),
      market: m,
      decisionModel: { name: "none", winProbability: async () => null },
      baseCalibration: goodCalibration,
      initialCash: 500,
      products: ["BTCAUD"],
      now: m.now,
    });
    expect(store.state!.halted).toBe(true);
    expect(store.positions).toHaveLength(0);
  });

  it("places an exchange stop and sells at market on a signal exit with a live broker", async () => {
    const m = market([110, 115, 120, 125, 118, 112, 99], 0.05);
    const buy = vi.fn(async (_p: string, size: number) => ({ size, price: 110, fee: 0.01 }));
    const sell = vi.fn(async (_p: string, size: number) => ({ size, price: 100, fee: 0.01 }));
    const live: Broker = {
      mode: "live",
      availableCash: async () => 500,
      buy,
      sell,
      placeStop: vi.fn(async () => "stop-1"),
      stopStatus: vi.fn(async () => ({ filledSize: 0, avgPrice: 0, fee: 0, done: false })),
      cancelStop: vi.fn(async () => {}),
    };
    const { store, tick } = await setup(m, { createBroker: () => live });
    await tick(90);
    expect(buy).toHaveBeenCalledOnce();
    expect(store.positions[0].stopOrderId).toBe("stop-1");
    for (let d = 91; d <= 96; d++) await tick(d);
    expect(live.cancelStop).toHaveBeenCalledWith("stop-1");
    expect(sell).toHaveBeenCalledOnce();
    expect(store.trades[0].exitReason).toBe("signal_exit");
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
