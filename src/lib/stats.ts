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
