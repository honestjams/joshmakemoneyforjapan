import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Calibration } from "../agents/decision";
import type { BotState, ClosedTrade, KnowledgeBrief, Position } from "../types";
import { calibrationFromTrades, newState, type RunLog, type Store } from "./store";

type Mode = "paper" | "live";

/** Server-side only: uses the service-role key, which bypasses row-level security. */
export function supabaseAdmin(): SupabaseClient {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set");
  return createClient(url, key, { auth: { persistSession: false } });
}

function check<T>(res: { data: T; error: { message: string } | null }, what: string): T {
  if (res.error) throw new Error(`supabase ${what}: ${res.error.message}`);
  return res.data;
}

interface PositionRow {
  id: string;
  product_id: string;
  size: number;
  entry_price: number;
  stop_price: number;
  entry_fee: number;
  opened_at: string;
  stop_order_id: string | null;
  strategy: string;
  win_probability: number;
  expected_value_pct: number;
  jev_probability: number | null;
}

const toPosition = (r: PositionRow): Position => ({
  id: r.id,
  productId: r.product_id,
  size: Number(r.size),
  entryPrice: Number(r.entry_price),
  stopPrice: Number(r.stop_price),
  entryFee: Number(r.entry_fee),
  openedAt: Date.parse(r.opened_at),
  stopOrderId: r.stop_order_id,
  strategy: r.strategy,
  winProbability: Number(r.win_probability),
  expectedValuePct: Number(r.expected_value_pct),
  jevProbability: r.jev_probability === null ? null : Number(r.jev_probability),
});

const fromPosition = (p: Position, mode: Mode) => ({
  id: p.id,
  mode,
  product_id: p.productId,
  size: p.size,
  entry_price: p.entryPrice,
  stop_price: p.stopPrice,
  entry_fee: p.entryFee,
  opened_at: new Date(p.openedAt).toISOString(),
  stop_order_id: p.stopOrderId,
  strategy: p.strategy,
  win_probability: p.winProbability,
  expected_value_pct: p.expectedValuePct,
  jev_probability: p.jevProbability,
});

export class SupabaseStore implements Store {
  constructor(
    private readonly mode: Mode,
    private readonly db: SupabaseClient = supabaseAdmin(),
  ) {}

  async loadState(initialCash: number): Promise<BotState> {
    const row = check(await this.db.from("bot_state").select("data").eq("mode", this.mode).maybeSingle(), "load state");
    return row ? (row.data as BotState) : newState(initialCash, Date.now());
  }

  async saveState(state: BotState): Promise<void> {
    check(
      await this.db.from("bot_state").upsert({ mode: this.mode, data: state, updated_at: new Date().toISOString() }),
      "save state",
    );
  }

  async openPositions(): Promise<Position[]> {
    const rows = check(await this.db.from("positions").select("*").eq("mode", this.mode).order("opened_at"), "positions");
    return (rows as PositionRow[]).map(toPosition);
  }

  async insertPosition(p: Position): Promise<void> {
    check(await this.db.from("positions").insert(fromPosition(p, this.mode)), "insert position");
  }

  async updatePosition(p: Position): Promise<void> {
    check(await this.db.from("positions").update(fromPosition(p, this.mode)).eq("id", p.id), "update position");
  }

  async closePosition(t: ClosedTrade): Promise<void> {
    check(
      await this.db.from("trades").insert({
        mode: this.mode,
        position_id: t.positionId,
        product_id: t.productId,
        size: t.size,
        entry_price: t.entryPrice,
        exit_price: t.exitPrice,
        opened_at: new Date(t.openedAt).toISOString(),
        closed_at: new Date(t.closedAt).toISOString(),
        fees: t.fees,
        pnl: t.pnl,
        exit_reason: t.exitReason,
        strategy: t.strategy,
        win_probability: t.winProbability,
        expected_value_pct: t.expectedValuePct,
        jev_probability: t.jevProbability,
      }),
      "insert trade",
    );
    check(await this.db.from("positions").delete().eq("id", t.positionId), "delete position");
  }

  async latestBrief(): Promise<KnowledgeBrief | null> {
    const row = check(
      await this.db.from("knowledge_briefs").select("*").order("created_at", { ascending: false }).limit(1).maybeSingle(),
      "latest brief",
    );
    if (!row) return null;
    return {
      createdAt: Date.parse(row.created_at),
      marketBias: Number(row.market_bias),
      productBias: row.product_bias ?? {},
      pauseTrading: row.pause_trading,
      riskEvents: (row.risk_events ?? []).map((e: { at: string; description: string }) => ({ at: Date.parse(e.at), description: e.description })),
      summary: row.summary,
    };
  }

  async tradeCalibration(): Promise<Calibration> {
    const rows = check(await this.db.from("trades").select("strategy, pnl, size, entry_price").eq("mode", this.mode), "trade calibration");
    return calibrationFromTrades(
      (rows as { strategy: string; pnl: number; size: number; entry_price: number }[]).map((r) => ({
        strategy: r.strategy,
        pnl: Number(r.pnl),
        size: Number(r.size),
        entryPrice: Number(r.entry_price),
      })),
    );
  }

  /** Closed paper trades, for the go-live check. */
  async paperTrades(): Promise<{ pnl: number; size: number; entryPrice: number }[]> {
    const rows = check(await this.db.from("trades").select("pnl, size, entry_price").eq("mode", "paper"), "paper trades");
    return (rows as { pnl: number; size: number; entry_price: number }[]).map((r) => ({
      pnl: Number(r.pnl),
      size: Number(r.size),
      entryPrice: Number(r.entry_price),
    }));
  }

  async logRun(run: RunLog): Promise<void> {
    check(
      await this.db.from("runs").insert({
        at: new Date(run.at).toISOString(),
        mode: run.mode,
        equity: run.equity,
        cash: run.cash,
        actions: run.actions,
        error: run.error,
      }),
      "log run",
    );
  }
}
