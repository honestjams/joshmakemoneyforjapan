import { JEV } from "@/config/settings";

/**
 * What the bot asks JEV for each candidate trade. JEV (TypeSafe AI) is a
 * "System One" decision model that answers narrow, typed questions with a
 * calibrated probability, which is exactly this question's shape.
 */
export interface TradeQuestion {
  question: string;
  productId: string;
  entryPrice: number;
  stopPrice: number;
  takeProfitPrice: number;
  maxHoldHours: number;
  /** Numeric market features the signal agents saw (RSI, ATR %, EMA gaps...). */
  features: Record<string, number>;
  agentReasons: string[];
}

export interface DecisionModel {
  name: string;
  /** Probability (0..1) that the trade closes in profit, or null when unavailable. */
  winProbability(q: TradeQuestion): Promise<number | null>;
}

/**
 * JEV adapter.
 *
 * Not wired yet: JEV is invite-only and its request/response format isn't
 * public, so rather than guess at an API that moves money, this returns null
 * (the bot then relies on its own calibrated estimate). Once you have access,
 * share the API docs/SDK and the call goes in `callJev` below.
 */
export class JevDecisionModel implements DecisionModel {
  name = "jev";

  constructor(
    private readonly apiKey: string | undefined = process.env.JEV_API_KEY,
    private readonly apiUrl: string | undefined = process.env.JEV_API_URL,
  ) {}

  get configured(): boolean {
    return Boolean(this.apiKey && this.apiUrl);
  }

  async winProbability(q: TradeQuestion): Promise<number | null> {
    if (!this.configured) return null;
    try {
      const p = await withTimeout(this.callJev(q), JEV.timeoutMs);
      return p !== null && p >= 0 && p <= 1 ? p : null;
    } catch (err) {
      console.warn("[jev] request failed, falling back to calibrated estimate:", err);
      return null;
    }
  }

  private async callJev(_q: TradeQuestion): Promise<number | null> {
    // TODO(JEV access): POST the question to JEV and return its probability.
    return null;
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms))]);
}

/** Blend JEV's probability with the bot's own; JEV never fully replaces measured hit rates. */
export function blendProbability(own: number, jev: number | null): number {
  if (jev === null) return own;
  return (1 - JEV.blendWeight) * own + JEV.blendWeight * jev;
}
