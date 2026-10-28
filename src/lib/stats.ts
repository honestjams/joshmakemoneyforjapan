import { GO_LIVE } from "@/config/settings";
import type { ClosedTrade } from "./types";

/** Win rate, average win/loss and profit factor for a set of closed trades. */
export function tradeStats(trades: Pick<ClosedTrade, "pnl" | "size" | "entryPrice">[]) {
  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl <= 0);
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  const grossWin = sum(wins.map((t) => t.pnl));
  const grossLoss = -sum(losses.map((t) => t.pnl));
  return {
    trades: trades.length,
    winRate: trades.length ? wins.length / trades.length : 0,
    avgWin: wins.length ? grossWin / wins.length : 0,
    avgLoss: losses.length ? grossLoss / losses.length : 0,
    totalPnl: grossWin - grossLoss,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : wins.length ? Infinity : 0,
    avgReturnPct: trades.length ? sum(trades.map((t) => t.pnl / (t.size * t.entryPrice))) / trades.length : 0,
  };
}

/** Whether the paper record earns the right to trade real money. */
export function goLiveCheck(paperTrades: Pick<ClosedTrade, "pnl" | "size" | "entryPrice">[]): { ready: boolean; reason: string } {
  const s = tradeStats(paperTrades);
  const progress = `${s.trades} trades, net $${s.totalPnl.toFixed(2)}, profit factor ${Number.isFinite(s.profitFactor) ? s.profitFactor.toFixed(2) : "n/a"}`;
  if (s.trades < GO_LIVE.minPaperTrades) return { ready: false, reason: `needs ${GO_LIVE.minPaperTrades} closed paper trades (${progress})` };
  if (s.totalPnl <= GO_LIVE.minTotalPnl) return { ready: false, reason: `paper returns not positive (${progress})` };
  if (s.profitFactor < GO_LIVE.minProfitFactor) return { ready: false, reason: `profit factor below ${GO_LIVE.minProfitFactor} (${progress})` };
  return { ready: true, reason: `paper record qualifies (${progress})` };
}
