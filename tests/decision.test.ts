import { describe, expect, it } from "vitest";
import { decide, expectedValuePct, summarize } from "@/lib/agents/decision";
import { blendProbability } from "@/lib/agents/jev";
import { researchView } from "@/lib/agents/research";
import { donchianBreakout } from "@/lib/agents/strategies";
import type { KnowledgeBrief } from "@/lib/types";
import { DAY, daily, goodCalibration, HOUR } from "./helpers";

describe("strategy records", () => {
  it("smooths small samples toward 50%", () => {
    expect(summarize({ wins: 3, losses: 0, winSum: 0.3, lossSum: 0 }).winProbability).toBeCloseTo(0.8);
    expect(summarize(undefined).winProbability).toBe(0.5);
  });
  it("averages win and loss sizes", () => {
    const s = summarize({ wins: 2, losses: 4, winSum: 0.5, lossSum: 0.2 });
    expect(s.avgWin).toBeCloseTo(0.25);
    expect(s.avgLoss).toBeCloseTo(0.05);
  });
});

describe("expectedValuePct", () => {
  it("shows a 65% win rate can still lose money when losses are bigger than wins", () => {
    expect(expectedValuePct(0.65, 0.01, 0.03)).toBeLessThan(0);
  });
  it("shows a 40% win rate can make money when winners are much bigger (trend following)", () => {
    expect(expectedValuePct(0.4, 0.3, 0.08)).toBeGreaterThan(0);
  });
});

describe("decide", () => {
  const strategy = "donchian_55_20_1d";
  it("refuses strategies without enough measured trades", () => {
    expect(decide({ strategy, calibration: {} }).action).toBe("skip");
  });
  it("refuses strategies whose record has negative expected value", () => {
    expect(decide({ strategy, calibration: { [strategy]: { wins: 10, losses: 20, winSum: 0.5, lossSum: 1.5 } } }).action).toBe("skip");
  });
  it("enters with a proven record", () => {
    const d = decide({ strategy, calibration: goodCalibration });
    expect(d.action).toBe("enter");
    if (d.action === "enter") expect(d.expectedValuePct).toBeGreaterThan(0.1);
  });
  it("lets JEV and research move the probability, within bounds", () => {
    const base = decide({ strategy, calibration: goodCalibration });
    const nudged = decide({ strategy, calibration: goodCalibration, probabilityAdjustment: -0.05, blend: (p) => blendProbability(p, 0.2) });
    expect(base.action === "enter" && nudged.action === "enter" && nudged.winProbability < base.winProbability).toBe(true);
  });
});

describe("Donchian strategy agent", () => {
  const s = donchianBreakout("1d", 55, 20, 3);
  const flat = Array.from({ length: 84 }, (_, i) => 100 + (i % 5));

  it("enters only on a close above the prior 55-day high", () => {
    expect(s.entry(daily(0, [...flat, 104]))).toBeNull(); // equals the high, not above
    expect(s.entry(daily(0, [...flat, 105]))).toMatch(/broke the 55-candle high/);
  });
  it("exits on a close below the prior 20-day low", () => {
    expect(s.exit(daily(0, [...flat, 100]))).toBeNull();
    expect(s.exit(daily(0, [...flat, 99]))).toMatch(/fell below the 20-candle low/);
  });
  it("puts the emergency stop 3 ATRs below entry", () => {
    const c = daily(0, [...flat, 105], 0.01);
    expect(s.stopPrice(c, 105)).toBeLessThan(105);
    expect(s.stopPrice(c, 105)).toBeGreaterThan(80);
    expect(s.candleMs).toBe(DAY);
  });
});

describe("JEV blend", () => {
  it("returns own estimate when JEV is unavailable and averages otherwise", () => {
    expect(blendProbability(0.6, null)).toBe(0.6);
    expect(blendProbability(0.6, 0.8)).toBeCloseTo(0.7);
  });
});

describe("research agent", () => {
  const now = Date.UTC(2026, 9, 28);
  const brief = (o: Partial<KnowledgeBrief> = {}): KnowledgeBrief => ({
    createdAt: now,
    marketBias: 1,
    productBias: {},
    pauseTrading: false,
    riskEvents: [],
    summary: "",
    ...o,
  });

  it("nudges by at most 5 points and fades with age", () => {
    expect(researchView(brief(), "BTCAUD", now).probabilityAdjustment).toBeCloseTo(0.05);
    expect(researchView(brief(), "BTCAUD", now + 36 * HOUR).probabilityAdjustment).toBeCloseTo(0.025);
    expect(researchView(brief(), "BTCAUD", now + 73 * HOUR).probabilityAdjustment).toBe(0);
  });
  it("blocks around risk events and when paused", () => {
    expect(researchView(brief({ riskEvents: [{ at: now + HOUR, description: "CPI" }] }), "BTCAUD", now).blockReason).toMatch(/CPI/);
    expect(researchView(brief({ pauseTrading: true }), "BTCAUD", now).blockReason).not.toBeNull();
  });
  it("prefers product-specific bias and clamps it", () => {
    expect(researchView(brief({ productBias: { SOLAUD: -5 } }), "SOLAUD", now).probabilityAdjustment).toBeCloseTo(-0.05);
  });
});
