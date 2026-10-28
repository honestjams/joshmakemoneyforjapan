export interface Candle {
  /** Candle open time, epoch milliseconds. */
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface Ticker {
  bid: number;
  ask: number;
  last: number;
  /** "continuous" when the market is open for normal trading. */
  status: string;
}

/** Exchange trading rules for one product (e.g. BTCAUD). */
export interface ProductRules {
  id: string;
  /** Minimum order size / size increment (in base units) at a given price. */
  sizeIncrementAt(price: number): number;
}

export type Direction = "long" | "flat";

/** Output of a single signal agent. */
export interface Signal {
  agent: string;
  direction: Direction;
  /** 0..1, how strongly the agent's setup is present. */
  confidence: number;
  reason: string;
}

export interface TradeProposal {
  productId: string;
  entryPrice: number;
  stopPrice: number;
  takeProfitPrice: number;
  /** Calibrated probability the trade hits take-profit before stop-loss. */
  winProbability: number;
  /** Expected return per $1 of position after fees and spread. */
  expectedValuePct: number;
  agents: string[];
  reasons: string[];
}

export interface Position {
  id: string;
  productId: string;
  size: number;
  entryPrice: number;
  stopPrice: number;
  takeProfitPrice: number;
  entryFee: number;
  openedAt: number;
  /** Exchange stop-loss order id (live mode only). */
  stopOrderId: string | null;
  winProbability: number;
  expectedValuePct: number;
  agents: string[];
  /** JEV's own estimate, kept so its accuracy can be scored against outcomes. */
  jevProbability: number | null;
  /** True for paper "exploration" trades taken without passing the EV gate. */
  exploration: boolean;
}

export type ExitReason = "take_profit" | "stop_loss" | "time_stop" | "manual" | "kill_switch";

export interface ClosedTrade {
  positionId: string;
  productId: string;
  size: number;
  entryPrice: number;
  exitPrice: number;
  openedAt: number;
  closedAt: number;
  fees: number;
  /** Net profit/loss in AUD after fees. */
  pnl: number;
  exitReason: ExitReason;
  winProbability: number;
  expectedValuePct: number;
  agents: string[];
  jevProbability: number | null;
  exploration: boolean;
}

export interface BotState {
  halted: boolean;
  haltReason: string | null;
  peakEquity: number;
  /** UTC date (YYYY-MM-DD) that dayStartEquity refers to. */
  day: string;
  dayStartEquity: number;
  /** Paper-mode AUD cash balance. Ignored in live mode. */
  paperCash: number;
  /** productId -> epoch ms of last close, used for re-entry cooldown. */
  lastExitAt: Record<string, number>;
}

/** Research written into the bot by a Claude chat "knowledge update". */
export interface KnowledgeBrief {
  createdAt: number;
  /** -1 (very bearish) .. +1 (very bullish) for crypto overall. */
  marketBias: number;
  /** Optional per-product bias, same scale. */
  productBias: Record<string, number>;
  /** When true the bot opens no new trades until the next brief. */
  pauseTrading: boolean;
  /** Scheduled events to avoid trading around (e.g. US CPI release). */
  riskEvents: { at: number; description: string }[];
  summary: string;
}
