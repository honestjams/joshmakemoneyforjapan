import { RESEARCH } from "@/config/settings";
import type { KnowledgeBrief } from "../types";

export interface ResearchView {
  /** Probability-point adjustment, within ±RESEARCH.maxProbabilityAdjustment. */
  probabilityAdjustment: number;
  /** Non-null when research says not to open new trades right now. */
  blockReason: string | null;
  note: string;
}

/**
 * Research agent: turns the latest Claude-written knowledge brief into a small,
 * bounded nudge on the win-probability estimate. Its influence halves every
 * `briefHalfLifeMs` and drops to zero after `briefMaxAgeMs`, so a forgotten
 * brief can't keep steering trades.
 */
export function researchView(brief: KnowledgeBrief | null, productId: string, now: number): ResearchView {
  if (!brief) return { probabilityAdjustment: 0, blockReason: null, note: "no knowledge brief" };
  const age = now - brief.createdAt;
  if (age > RESEARCH.briefMaxAgeMs || age < 0) {
    return { probabilityAdjustment: 0, blockReason: null, note: "knowledge brief expired" };
  }
  if (brief.pauseTrading) {
    return { probabilityAdjustment: 0, blockReason: "knowledge brief paused trading", note: brief.summary };
  }
  const event = brief.riskEvents.find((e) => Math.abs(e.at - now) <= RESEARCH.riskEventWindowMs);
  if (event) {
    return { probabilityAdjustment: 0, blockReason: `risk event nearby: ${event.description}`, note: brief.summary };
  }
  const weight = 0.5 ** (age / RESEARCH.briefHalfLifeMs);
  const rawBias = brief.productBias[productId] ?? brief.marketBias;
  const bias = Math.max(-1, Math.min(1, rawBias));
  return {
    probabilityAdjustment: bias * RESEARCH.maxProbabilityAdjustment * weight,
    blockReason: null,
    note: `bias ${bias.toFixed(2)} at weight ${weight.toFixed(2)}`,
  };
}
