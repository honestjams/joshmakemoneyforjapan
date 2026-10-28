import { describe, expect, it } from "vitest";
import { accountBlock, assessEntry, roundDownToIncrement, stopFill } from "@/lib/agents/risk";
import { checkCoinjarKey, liveReadiness } from "@/lib/live";
import type { CoinjarTradingClient } from "@/lib/exchange/coinjar";
import { candle, position, proposal, state } from "./helpers";

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
    const v = assessEntry({
      ...base,
      proposal: proposal({ entryPrice: 115_000, stopPrice: 105_000 }),
      portfolio: portfolio(50),
      state: state({ peakEquity: 50, dayStartEquity: 50 }),
      sizeIncrement: 0.0001,
    });
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

  it("enforces max open positions, one position per market, cooldown, spread and a valid stop", () => {
    const open = ["ETHAUD", "SOLAUD", "XRPAUD", "LTCAUD"].map((productId) => position({ productId }));
    const ok = { ...base, proposal: proposal(), portfolio: portfolio(500), state: state(), sizeIncrement: 0.00001 };
    expect(assessEntry({ ...ok, portfolio: { ...portfolio(500), openPositions: open } }).approved).toBe(false);
    expect(assessEntry({ ...ok, portfolio: { ...portfolio(500), openPositions: [position()] } }).approved).toBe(false);
    expect(assessEntry({ ...ok, state: state({ lastExitAt: { BTCAUD: base.now - 1000 } }) }).approved).toBe(false);
    expect(assessEntry({ ...ok, spreadPct: 0.01 }).approved).toBe(false);
    expect(assessEntry({ ...ok, proposal: proposal({ stopPrice: 101_000 }) }).approved).toBe(false);
  });
});

describe("accountBlock", () => {
  it("halts at the drawdown kill switch", () => {
    expect(accountBlock(state({ peakEquity: 100, dayStartEquity: 80 }), 79)?.haltNow).toBe(true);
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

describe("stopFill", () => {
  const pos = position({ stopPrice: 90_000 });
  it("ignores candles that stay above the stop", () => {
    expect(stopFill(pos, candle(0, 100_000))).toBeNull();
  });
  it("fills at the stop less slippage when touched", () => {
    expect(stopFill(pos, { ...candle(0, 92_000), low: 89_000 })).toBeCloseTo(90_000 * 0.995);
  });
  it("fills a gap-down at the open, not the stop price", () => {
    expect(stopFill(pos, { time: 0, open: 85_000, high: 86_000, low: 84_000, close: 85_000, volume: 1 })).toBeCloseTo(85_000 * 0.995);
  });
});

it("roundDownToIncrement never rounds up", () => {
  expect(roundDownToIncrement(0.00049999, 0.0001)).toBe(0.0004);
  expect(roundDownToIncrement(0.0003, 0.0001)).toBe(0.0003);
  expect(roundDownToIncrement(0.00009, 0.0001)).toBe(0);
});

describe("go-live checklist", () => {
  const goodKey = { ok: true, problems: [], scopes: ["read", "trade"], audAvailable: 200 };
  const healthy = { runs: 860, errors: 2 };
  const after = Date.parse("2026-11-04T09:00:00+11:00");

  it("passes only when every check passes", () => {
    expect(liveReadiness({ now: after, paperRuns: healthy, paperHalted: false, key: goodKey }).ready).toBe(true);
    expect(liveReadiness({ now: Date.parse("2026-11-01T00:00:00Z"), paperRuns: healthy, paperHalted: false, key: goodKey }).ready).toBe(false);
    expect(liveReadiness({ now: after, paperRuns: { runs: 300, errors: 0 }, paperHalted: false, key: goodKey }).ready).toBe(false);
    expect(liveReadiness({ now: after, paperRuns: { runs: 860, errors: 100 }, paperHalted: false, key: goodKey }).ready).toBe(false);
    expect(liveReadiness({ now: after, paperRuns: healthy, paperHalted: true, key: goodKey }).ready).toBe(false);
    expect(liveReadiness({ now: after, paperRuns: healthy, paperHalted: false, key: null }).ready).toBe(false);
  });

  const client = (scope: string | null, scopes: string[]) =>
    ({ tokenScope: async () => ({ scope, scopes }), accounts: async () => [{ asset_code: "AUD", available: "150.00", balance: "150.00" }] }) as unknown as CoinjarTradingClient;

  it("accepts a trade-only CoinJar key", async () => {
    const k = await checkCoinjarKey(client("trades", ["read", "trade"]));
    expect(k.ok).toBe(true);
    expect(k.audAvailable).toBe(150);
  });
  it("rejects keys that can withdraw, transfer, or do everything", async () => {
    expect((await checkCoinjarKey(client("trades", ["read", "trade", "external_withdrawal"]))).ok).toBe(false);
    expect((await checkCoinjarKey(client("trades", ["read", "trade", "transfer"]))).ok).toBe(false);
    expect((await checkCoinjarKey(client("allaccess", ["read", "trade"]))).ok).toBe(false);
    expect((await checkCoinjarKey(client("readonly", ["read"]))).ok).toBe(false);
  });
});
