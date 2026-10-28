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
  /** Wins/losses per signal agent from this mode's closed trades. */
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

/** Every agent that agreed on a trade shares its outcome. */
export function calibrationFromTrades(trades: Pick<ClosedTrade, "agents" | "pnl">[]): Calibration {
  const cal: Calibration = {};
  for (const t of trades) {
    for (const a of t.agents) {
      cal[a] ??= { wins: 0, losses: 0 };
      if (t.pnl > 0) cal[a].wins++;
      else cal[a].losses++;
    }
  }
  return cal;
}

export function mergeCalibration(...sources: Calibration[]): Calibration {
  const out: Calibration = {};
  for (const src of sources) {
    for (const [agent, rec] of Object.entries(src)) {
      out[agent] ??= { wins: 0, losses: 0 };
      out[agent].wins += rec.wins;
      out[agent].losses += rec.losses;
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
