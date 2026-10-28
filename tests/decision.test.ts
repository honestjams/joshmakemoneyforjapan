import { describe, expect, it } from "vitest";
import { agentWinProbability, calibratedWinProbability, decide, expectedValuePct } from "@/lib/agents/decision";
import { computeFeatures } from "@/lib/agents/signals";
import { blendProbability } from "@/lib/agents/jev";
import { researchView } from "@/lib/agents/research";
import type { KnowledgeBrief, Signal } from "@/lib/types";
import { HOUR, uptrend } from "./helpers";

const long = (agent: string): Signal => ({ agent, direction: "long", confidence: 0.5, reason: "test" });

describe("calibration", () => {
  it("smooths small samples toward 50%", () => {
    expect(agentWinProbability({ a: { wins: 3, losses: 0 } }, "a")).toBeCloseTo(0.8);
    expect(agentWinProbability({}, "unknown")).toBe(0.5);
  });
  it("weights agents by sample size", () => {
    const p = calibratedWinProbability({ a: { wins: 70, losses: 30 }, b: { wins: 0, losses: 0 } }, [long("a"), long("b")]);
    expect(p).toBeGreaterThan(0.65);
  });
});

describe("expectedValuePct", () => {
  it("shows a 65% win rate can still lose money when losses are bigger than wins", () => {
    // Target +0.5%, stop -1.5%: wins 65% of the time but negative after fees.
    expect(expectedValuePct(0.65, 100, 98.5, 100.5)).toBeLessThan(0);
  });
  it("is positive with a real edge", () => {
    expect(expectedValuePct(0.6, 100, 98, 102)).toBeGreaterThan(0);
  });
});

describe("decide", () => {
  const candles = uptrend(300, 0, Infinity);
  const features = computeFeatures(candles);
  const i = candles.length - 1;
  const input = { productId: "BTCAUD", features, index: i, entryPrice: candles[i].close };

  it("skips when no agent sees a setup", () => {
    expect(decide({ ...input, signals: [], calibration: {} }).action).toBe("skip");
  });
  it("skips uncalibrated agents (50%) under the 55% bar", () => {
    expect(decide({ ...input, signals: [long("a")], calibration: {} }).action).toBe("skip");
  });
  it("enters when calibrated probability and EV clear the bar", () => {
    const d = decide({ ...input, signals: [long("a")], calibration: { a: { wins: 300, losses: 100 } } });
    expect(d.action).toBe("enter");
  });
  it("exploration takes the trade anyway (paper only, enforced by the engine)", () => {
    expect(decide({ ...input, signals: [long("a")], calibration: {}, explore: true }).action).toBe("enter");
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
