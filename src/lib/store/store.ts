import type { Calibration } from "../agents/decision";
import type { BotState, ClosedTrade, KnowledgeBrief, Position } from "../types";

export interface RunLog {
  at: number;
  mode: "paper" | "live";
  equity: number;
  cash: number;
  actions: string[];
  error: string | null;
}

/** Persistence for one trading mode (paper and live never share positions, trades or state). */
export interface Store {
  loadState(initialCash: number): Promise<BotState>;
  saveState(state: BotState): Promise<void>;
  openPositions(): Promise<Position[]>;
  insertPosition(p: Position): Promise<void>;
  updatePosition(p: Position): Promise<void>;
  /** Removes the open position and records the closed trade. */
  closePosition(trade: ClosedTrade): Promise<void>;
  latestBrief(): Promise<KnowledgeBrief | null>;
  /** Win/loss record per strategy from this mode's closed trades. */
  tradeCalibration(): Promise<Calibration>;
  logRun(run: RunLog): Promise<void>;
}

export function newState(initialCash: number, now: number): BotState {
  return {
    halted: false,
    haltReason: null,
    peakEquity: initialCash,
    day: utcDay(now),
    dayStartEquity: initialCash,
    paperCash: initialCash,
    lastExitAt: {},
  };
}

export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Per-strategy win/loss record from closed trades (returns relative to the position's cost). */
export function calibrationFromTrades(trades: Pick<ClosedTrade, "strategy" | "pnl" | "size" | "entryPrice">[]): Calibration {
  const cal: Calibration = {};
  for (const t of trades) {
    const rec = (cal[t.strategy] ??= { wins: 0, losses: 0, winSum: 0, lossSum: 0 });
    const ret = t.pnl / (t.size * t.entryPrice);
    if (ret > 0) {
      rec.wins++;
      rec.winSum += ret;
    } else {
      rec.losses++;
      rec.lossSum -= ret;
    }
  }
  return cal;
}

export function mergeCalibration(...sources: Calibration[]): Calibration {
  const out: Calibration = {};
  for (const src of sources) {
    for (const [name, rec] of Object.entries(src)) {
      const o = (out[name] ??= { wins: 0, losses: 0, winSum: 0, lossSum: 0 });
      o.wins += rec.wins;
      o.losses += rec.losses;
      o.winSum += rec.winSum;
      o.lossSum += rec.lossSum;
    }
  }
  return out;
}

/** In-memory store for tests, backtests and local dry runs. */
export class MemoryStore implements Store {
  state: BotState | null = null;
  positions: Position[] = [];
  trades: ClosedTrade[] = [];
  briefs: KnowledgeBrief[] = [];
  runs: RunLog[] = [];

  async loadState(initialCash: number): Promise<BotState> {
    this.state ??= newState(initialCash, Date.now());
    return structuredClone(this.state);
  }
  async saveState(state: BotState): Promise<void> {
    this.state = structuredClone(state);
  }
  async openPositions(): Promise<Position[]> {
    return structuredClone(this.positions);
  }
  async insertPosition(p: Position): Promise<void> {
    this.positions.push(structuredClone(p));
  }
  async updatePosition(p: Position): Promise<void> {
    this.positions = this.positions.map((x) => (x.id === p.id ? structuredClone(p) : x));
  }
  async closePosition(trade: ClosedTrade): Promise<void> {
    this.positions = this.positions.filter((p) => p.id !== trade.positionId);
    this.trades.push(structuredClone(trade));
  }
  async latestBrief(): Promise<KnowledgeBrief | null> {
    return this.briefs.reduce<KnowledgeBrief | null>((a, b) => (!a || b.createdAt > a.createdAt ? b : a), null);
  }
  async tradeCalibration(): Promise<Calibration> {
    return calibrationFromTrades(this.trades);
  }
  async logRun(run: RunLog): Promise<void> {
    this.runs.push(run);
  }
}
