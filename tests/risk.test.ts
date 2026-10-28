import { describe, expect, it } from "vitest";
import { accountBlock, assessEntry, checkExit, roundDownToIncrement } from "@/lib/agents/risk";
import { STRATEGY } from "@/config/settings";
import { candle, HOUR, position, proposal, state } from "./helpers";

const portfolio = (equity: number, cash = equity) => ({ equity, availableCash: cash, openPositions: [] });
const base = { spreadPct: 0.001, now: Date.UTC(2026, 9, 2) };

describe("assessEntry", () => {
  it("never puts more than 10% of equity (including the fee) into one trade", () => {
    const v = assessEntry({ ...base, proposal: proposal(), portfolio: portfolio(500), state: state(), sizeIncrement: 0.00001 });
    expect(v.approved).toBe(true);
    if (!v.approved) return;
    expect(v.notional * 1.001).toBeLessThanOrEqual(50 + 1e-9);
    expect(v.notional).toBeGreaterThanOrEqual(49); // rounded down to the 0.00001 BTC increment
    expect(v.maxLoss).toBeLessThanOrEqual(500 * 0.1);
  });

  it("rejects instead of rounding up when the exchange minimum exceeds 10% of a $50 account", () => {
    // BTCAUD at $115k with a 0.0001 BTC minimum = $11.50, but 10% of $50 is $5.
    const v = assessEntry({ ...base, proposal: proposal({ entryPrice: 115_000, stopPrice: 113_000, takeProfitPrice: 117_000 }), portfolio: portfolio(50), state: state({ peakEquity: 50, dayStartEquity: 50 }), sizeIncrement: 0.0001 });
    expect(v.approved).toBe(false);
    if (!v.approved) expect(v.reason).toMatch(/exchange minimum/);
  });

  it("caps size so a stop-out (with slippage and fees) loses at most 10% of equity", () => {
    // A stop 90% below entry would lose almost the whole position, so the loss rule binds before the size rule.
    const v = assessEntry({ ...base, proposal: proposal({ stopPrice: 10_000 }), portfolio: portfolio(1000), state: state(), sizeIncrement: 0.000001 });
    expect(v.approved).toBe(true);
    if (v.approved) expect(v.maxLoss).toBeLessThanOrEqual(100 + 1e-6);
  });

  it("only spends available cash", () => {
    const v = assessEntry({ ...base, proposal: proposal(), portfolio: portfolio(500, 20), state: state(), sizeIncrement: 0.00001 });
    expect(v.approved && v.notional).toBeLessThanOrEqual(20);
  });

  it("enforces max open positions, one position per product, cooldown and spread", () => {
    const open = [position({ productId: "ETHAUD" }), position({ productId: "SOLAUD" }), position({ productId: "XRPAUD" })];
    expect(assessEntry({ ...base, proposal: proposal(), portfolio: { ...portfolio(500), openPositions: open }, state: state(), sizeIncrement: 0.00001 }).approved).toBe(false);
    expect(assessEntry({ ...base, proposal: proposal(), portfolio: { ...portfolio(500), openPositions: [position()] }, state: state(), sizeIncrement: 0.00001 }).approved).toBe(false);
    expect(assessEntry({ ...base, proposal: proposal(), portfolio: portfolio(500), state: state({ lastExitAt: { BTCAUD: base.now - 1000 } }), sizeIncrement: 0.00001 }).approved).toBe(false);
    expect(assessEntry({ ...base, spreadPct: 0.01, proposal: proposal(), portfolio: portfolio(500), state: state(), sizeIncrement: 0.00001 }).approved).toBe(false);
  });
});

describe("accountBlock", () => {
  it("halts at the drawdown kill switch", () => {
    const b = accountBlock(state({ peakEquity: 100, dayStartEquity: 80 }), 79);
    expect(b?.haltNow).toBe(true);
  });
  it("pauses for the day at the daily loss limit without halting", () => {
    const b = accountBlock(state({ peakEquity: 100, dayStartEquity: 100 }), 94);
    expect(b).not.toBeNull();
    expect(b?.haltNow).toBe(false);
  });
  it("stays halted until a person resets it", () => {
    expect(accountBlock(state({ halted: true, haltReason: "test" }), 1_000)?.reason).toMatch(/halted/);
  });
});

describe("checkExit", () => {
  const pos = position({ openedAt: 0 });
  it("assumes the stop hit first when a candle touches both levels", () => {
    const c = { time: 0, open: 100_000, high: 103_000, low: 97_000, close: 100_000, volume: 1 };
    expect(checkExit(pos, c, HOUR)?.reason).toBe("stop_loss");
  });
  it("fills a gap-down stop at the open, not the stop price", () => {
    const c = { time: 0, open: 95_000, high: 95_500, low: 94_000, close: 95_000, volume: 1 };
    const exit = checkExit(pos, c, HOUR)!;
    expect(exit.price).toBeLessThan(95_000);
  });
  it("takes profit at the target", () => {
    expect(checkExit(pos, { ...candle(0, 101_000), high: 102_500 }, HOUR)?.reason).toBe("take_profit");
  });
  it("time-stops after the max hold", () => {
    expect(checkExit(pos, candle(STRATEGY.maxHoldMs, 100_000, 0), HOUR)?.reason).toBe("time_stop");
  });
});

it("roundDownToIncrement never rounds up", () => {
  expect(roundDownToIncrement(0.00049999, 0.0001)).toBe(0.0004);
  expect(roundDownToIncrement(0.0003, 0.0001)).toBe(0.0003);
  expect(roundDownToIncrement(0.00009, 0.0001)).toBe(0);
});

describe("goLiveCheck", () => {
  const t = (pnl: number) => ({ pnl, size: 1, entryPrice: 100 });
  it("blocks live trading until there are enough profitable EV-gated paper trades", async () => {
    const { goLiveCheck } = await import("@/lib/stats");
    expect(goLiveCheck([]).ready).toBe(false);
    expect(goLiveCheck(Array.from({ length: 40 }, (_, i) => t(i % 2 ? 1 : -1.2))).ready).toBe(false); // net negative
    expect(goLiveCheck(Array.from({ length: 40 }, (_, i) => t(i % 2 ? 1.05 : -1))).ready).toBe(false); // PF 1.05 < 1.1
    expect(goLiveCheck(Array.from({ length: 40 }, (_, i) => t(i % 2 ? 1.5 : -1))).ready).toBe(true);
  });
});
