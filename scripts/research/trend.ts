/**
 * Research: long-only trend following on CoinJar daily candles, 2019-2026.
 *
 *   npx tsx scripts/research/trend.ts [interval=1d]
 *
 * Every rule is tested on every market and reported per calendar year so a
 * rule that only worked in one bull run is easy to spot. Costs: 0.10% fee per
 * side plus 0.10% half-spread per side. Portfolio results assume each trade
 * uses 10% of equity (your rule), up to 4 markets at once.
 */
import { atr, ema, sma } from "../../src/lib/indicators";
import type { Candle } from "../../src/lib/types";
import { coinjarHistory } from "./data";

let COST_PER_SIDE = 0.001 + 0.001; // fee + half-spread
/** Candles between the signal and the fill (0 = fill at the signal candle's close). */
let LAG = 0;
const POSITION_PCT = 0.1;
const PRODUCTS = ["BTCAUD", "ETHAUD", "SOLAUD", "XRPAUD"];

interface Rule {
  name: string;
  /** Returns "enter" / "exit" / null for candle i (evaluated at its close). */
  signal(c: Candle[], i: number, inPosition: boolean, ctx: Ctx): "enter" | "exit" | null;
}
interface Ctx {
  close: number[];
  sma20: number[];
  sma50: number[];
  sma100: number[];
  sma200: number[];
  ema10: number[];
  ema50: number[];
  atr14: number[];
}

const hi = (c: Candle[], i: number, n: number) => Math.max(...c.slice(Math.max(0, i - n), i).map((x) => x.close));
const lo = (c: Candle[], i: number, n: number) => Math.min(...c.slice(Math.max(0, i - n), i).map((x) => x.close));

/** Optional disaster stop, in daily ATRs below entry, triggered intraday by the candle low. */
let STOP_ATR = 0;

const RULES: Rule[] = [
  ...[20, 50, 100].map((n) => ({
    name: `close>SMA${n}`,
    signal: (c: Candle[], i: number, inPos: boolean, x: Ctx) => {
      const s = (x as unknown as Record<string, number[]>)[`sma${n}`][i];
      if (Number.isNaN(s)) return null;
      return !inPos && x.close[i] > s ? "enter" : inPos && x.close[i] < s ? "exit" : null;
    },
  })),
  {
    name: "EMA10/50 cross",
    signal: (_c, i, inPos, x) => {
      if (Number.isNaN(x.ema50[i])) return null;
      return !inPos && x.ema10[i] > x.ema50[i] ? "enter" : inPos && x.ema10[i] < x.ema50[i] ? "exit" : null;
    },
  },
  ...[
    [20, 10],
    [55, 20],
  ].map(([n, m]) => ({
    name: `Donchian ${n}/${m}`,
    signal: (c: Candle[], i: number, inPos: boolean) => {
      if (i < n) return null;
      return !inPos && c[i].close > hi(c, i, n) ? "enter" : inPos && c[i].close < lo(c, i, m) ? "exit" : null;
    },
  })),
  {
    name: "SMA50 & BTC-style regime (close>SMA200)",
    signal: (_c, i, inPos, x) => {
      if (Number.isNaN(x.sma200[i])) return null;
      const up = x.close[i] > x.sma50[i] && x.close[i] > x.sma200[i];
      return !inPos && up ? "enter" : inPos && x.close[i] < x.sma50[i] ? "exit" : null;
    },
  },
];

interface Trade {
  product: string;
  entryTime: number;
  exitTime: number;
  ret: number;
}

function runRule(product: string, c: Candle[], rule: Rule): Trade[] {
  const close = c.map((k) => k.close);
  const ctx: Ctx = {
    close,
    sma20: sma(close, 20),
    sma50: sma(close, 50),
    sma100: sma(close, 100),
    sma200: sma(close, 200),
    ema10: ema(close, 10),
    ema50: ema(close, 50),
    atr14: atr(c, 14),
  };
  const trades: Trade[] = [];
  let entry: { price: number; time: number; stop: number } | null = null;
  for (let i = 1; i < c.length; i++) {
    if (entry && STOP_ATR > 0 && c[i].time > entry.time && c[i].low <= entry.stop) {
      const fill = Math.min(c[i].open, entry.stop) * 0.995; // 0.5% stop slippage on a thin book
      trades.push({ product, entryTime: entry.time, exitTime: c[i].time, ret: (fill * (1 - COST_PER_SIDE)) / (entry.price * (1 + COST_PER_SIDE)) - 1 });
      entry = null;
      continue;
    }
    const s = rule.signal(c, i, entry !== null, ctx);
    const f = Math.min(i + LAG, c.length - 1);
    if (s === "enter" && !entry) entry = { price: close[f], time: c[f].time, stop: close[f] - STOP_ATR * ctx.atr14[i] };
    else if (s === "exit" && entry) {
      trades.push({ product, entryTime: entry.time, exitTime: c[f].time, ret: (close[f] * (1 - COST_PER_SIDE)) / (entry.price * (1 + COST_PER_SIDE)) - 1 });
      entry = null;
    }
  }
  if (entry) {
    const i = c.length - 1;
    trades.push({ product, entryTime: entry.time, exitTime: c[i].time, ret: (close[i] * (1 - COST_PER_SIDE)) / (entry.price * (1 + COST_PER_SIDE)) - 1 });
  }
  return trades;
}

const pct = (x: number) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)}%`;
const year = (t: number) => new Date(t).getUTCFullYear();

/** Mark-to-market max drawdown of the 10%-per-trade portfolio (trades from all markets, compounding). */
function portfolioDrawdown(trades: Trade[], data: Map<string, Candle[]>): { finalMultiple: number; maxDd: number } {
  const times = [...new Set([...data.values()].flatMap((c) => c.map((k) => k.time)))].sort((a, b) => a - b);
  const closeAt = new Map([...data].map(([p, c]) => [p, new Map(c.map((k) => [k.time, k.close]))]));
  let cash = 1;
  const open = new Map<Trade, number>(); // trade -> units
  let peak = 1;
  let maxDd = 0;
  const lastPx = new Map<string, number>();
  for (const t of times) {
    for (const [p, m] of closeAt) if (m.has(t)) lastPx.set(p, m.get(t)!);
    const equityNow = () => cash + [...open].reduce((s, [tr, u]) => s + u * lastPx.get(tr.product)!, 0);
    for (const [tr, u] of [...open]) {
      if (tr.exitTime === t) {
        cash += u * lastPx.get(tr.product)! * (1 - COST_PER_SIDE);
        open.delete(tr);
      }
    }
    for (const tr of trades) {
      if (tr.entryTime === t) {
        const stake = equityNow() * POSITION_PCT;
        if (stake > cash) continue;
        cash -= stake;
        open.set(tr, (stake / (1 + COST_PER_SIDE)) / lastPx.get(tr.product)!);
      }
    }
    const eq = equityNow();
    peak = Math.max(peak, eq);
    maxDd = Math.max(maxDd, (peak - eq) / peak);
  }
  const final = cash + [...open].reduce((s, [tr, u]) => s + u * lastPx.get(tr.product)!, 0);
  return { finalMultiple: final, maxDd };
}

async function main() {
  const interval = process.argv[2] ?? "1d";
  LAG = Number(process.argv[3] ?? "0");
  COST_PER_SIDE *= Number(process.argv[4] ?? "1");
  STOP_ATR = Number(process.argv[5] ?? "0");
  console.log(`interval ${interval}, fill lag ${LAG} candle(s), cost per side ${(COST_PER_SIDE * 100).toFixed(2)}%, disaster stop ${STOP_ATR || "none"} ATR`);
  const data = new Map<string, Candle[]>();
  for (const p of PRODUCTS) {
    const c = await coinjarHistory(p, interval, 2550);
    data.set(p, c);
    console.log(`${p}: ${c.length} ${interval} candles from ${new Date(c[0].time).toISOString().slice(0, 10)}`);
  }
  const years = [2020, 2021, 2022, 2023, 2024, 2025, 2026];

  console.log(`\nBuy & hold per year (asset return):`);
  for (const p of PRODUCTS) {
    const c = data.get(p)!;
    const row = years.map((y) => {
      const ys = c.filter((k) => year(k.time) === y);
      return ys.length > 30 ? pct(ys[ys.length - 1].close / ys[0].close - 1).padStart(8) : "     n/a";
    });
    console.log(`  ${p}  ${row.join(" ")}`);
  }

  console.log(`\nPortfolio return per year (10% of equity per trade, by exit year) | all trades: n, win rate, avg net return`);
  console.log(`  ${"rule".padEnd(42)} ${years.map((y) => String(y).padStart(7)).join(" ")}    n   win   avg  total  maxDD`);
  for (const rule of RULES) {
    const trades = PRODUCTS.flatMap((p) => runRule(p, data.get(p)!, rule));
    const perYear = years.map((y) => trades.filter((t) => year(t.exitTime) === y).reduce((s, t) => s + POSITION_PCT * t.ret, 0));
    const wins = trades.filter((t) => t.ret > 0).length;
    const avg = trades.reduce((s, t) => s + t.ret, 0) / trades.length;
    const pf = portfolioDrawdown(trades, data);
    console.log(
      `  ${rule.name.padEnd(42)} ${perYear.map((r) => pct(r).padStart(7)).join(" ")} ${String(trades.length).padStart(4)} ${pct(wins / trades.length).padStart(6)} ${pct(avg).padStart(6)} ${pct(pf.finalMultiple - 1).padStart(7)} ${pct(-pf.maxDd).padStart(6)}`,
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
