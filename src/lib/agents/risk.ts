import { FEES, MARKETS, RISK } from "@/config/settings";
import type { BotState, Candle, Position, TradeProposal } from "../types";

export interface PortfolioSnapshot {
  /** Cash + open positions marked at the bid. */
  equity: number;
  /** AUD available to spend right now. */
  availableCash: number;
  openPositions: Position[];
}

export type RiskVerdict = { approved: true; size: number; notional: number; maxLoss: number } | { approved: false; reason: string };

/** Round a size down to the exchange's increment (never up: rounding up could break the 10% rule). */
export function roundDownToIncrement(size: number, increment: number): number {
  if (!(increment > 0)) return 0;
  const steps = Math.floor(size / increment + 1e-9);
  return Number((steps * increment).toFixed(10));
}

/**
 * Account-level checks that apply before any new trade: the kill switch, the
 * drawdown halt and the daily loss limit. Returns the reason trading is
 * blocked, or null. `haltNow` is true when the account should be halted until
 * a person resets it.
 */
export function accountBlock(state: BotState, equity: number): { reason: string; haltNow: boolean } | null {
  if (state.halted) return { reason: `halted: ${state.haltReason ?? "manual"}`, haltNow: false };
  const peak = Math.max(state.peakEquity, equity);
  if (peak > 0 && (peak - equity) / peak >= RISK.maxDrawdownPct) {
    return {
      reason: `drawdown ${(((peak - equity) / peak) * 100).toFixed(1)}% from peak hit the ${RISK.maxDrawdownPct * 100}% kill switch`,
      haltNow: true,
    };
  }
  if (state.dayStartEquity > 0 && (state.dayStartEquity - equity) / state.dayStartEquity >= RISK.dailyLossLimitPct) {
    return { reason: `daily loss limit (${RISK.dailyLossLimitPct * 100}%) reached; resuming tomorrow (UTC)`, haltNow: false };
  }
  return null;
}

/**
 * Risk manager: plain code, final veto, no AI. Enforces the 10% position and
 * loss rules, exchange minimums, spread, position count and cooldown.
 */
export function assessEntry(args: {
  proposal: TradeProposal;
  portfolio: PortfolioSnapshot;
  state: BotState;
  sizeIncrement: number;
  spreadPct: number;
  now: number;
}): RiskVerdict {
  const { proposal, portfolio, state, sizeIncrement, spreadPct, now } = args;

  const block = accountBlock(state, portfolio.equity);
  if (block) return { approved: false, reason: block.reason };
  if (portfolio.openPositions.length >= RISK.maxOpenPositions) {
    return { approved: false, reason: `already ${RISK.maxOpenPositions} positions open` };
  }
  if (portfolio.openPositions.some((p) => p.productId === proposal.productId)) {
    return { approved: false, reason: `already holding ${proposal.productId}` };
  }
  const lastExit = state.lastExitAt[proposal.productId];
  if (lastExit !== undefined && now - lastExit < MARKETS.reentryCooldownMs) {
    return { approved: false, reason: `${proposal.productId} cooling down after last exit` };
  }
  if (spreadPct > RISK.maxSpreadPct) {
    return { approved: false, reason: `spread ${(spreadPct * 100).toFixed(2)}% too wide` };
  }
  if (!(proposal.stopPrice > 0 && proposal.stopPrice < proposal.entryPrice)) {
    return { approved: false, reason: "invalid stop price" };
  }

  // Rule 1: position size (including the entry fee) <= 10% of equity, and only cash we have.
  const budget = Math.min(portfolio.equity * RISK.maxPositionPctOfEquity, portfolio.availableCash) / (1 + FEES.takerRate);
  // Rule 2: worst-case loss if stopped out (with slippage and both fees) <= 10% of equity.
  const lossPerUnit =
    proposal.entryPrice - proposal.stopPrice * (1 - FEES.stopSlippagePct) + FEES.takerRate * (proposal.entryPrice + proposal.stopPrice);
  const maxUnitsByLoss = (portfolio.equity * RISK.maxLossPctOfEquityPerTrade) / lossPerUnit;
  const size = roundDownToIncrement(Math.min(budget / proposal.entryPrice, maxUnitsByLoss), sizeIncrement);

  if (size <= 0) {
    const minNotional = sizeIncrement * proposal.entryPrice;
    return {
      approved: false,
      reason: `exchange minimum is ${sizeIncrement} (~$${minNotional.toFixed(2)}), more than 10% of $${portfolio.equity.toFixed(2)} equity`,
    };
  }
  return { approved: true, size, notional: size * proposal.entryPrice, maxLoss: size * lossPerUnit };
}

/**
 * Emergency stop check for one candle: the fill price if its low reached the
 * stop (at the open if it gapped through, less slippage), else null.
 */
export function stopFill(position: Position, candle: Candle): number | null {
  if (candle.low > position.stopPrice) return null;
  return Math.min(candle.open, position.stopPrice) * (1 - FEES.stopSlippagePct);
}
