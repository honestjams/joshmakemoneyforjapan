/**
 * Walk-forward backtest of the live strategies on real CoinJar history,
 * through the same engine code the bot runs in production.
 *
 *   npm run backtest                          # $150 and $500 accounts
 *   npm run backtest -- --cash 50,150,500
 *   npm run backtest -- --write-calibration   # refresh src/config/calibration.json from full history
 *
 * 1. Calibrate each strategy on history before --split (default 2023-01-01).
 * 2. Run the engine from --split to today with that calibration (unseen data).
 * 3. Also run 2020 -> today to see how 5-month windows have played out across bull and bear markets.
 */
import { writeFileSync } from "node:fs";
import { MARKETS } from "../src/config/settings";
import { STRATEGIES as ALL_STRATEGIES } from "../src/lib/agents/strategies";
import { RISK } from "../src/config/settings";
import { simulate, type SimulationResult, studyStrategy, toCalibration, HistoricalMarket } from "../src/lib/backtest";
import { fetchProductRules } from "../src/lib/exchange/coinjar";
import { tradeStats } from "../src/lib/stats";
import type { Candle } from "../src/lib/types";
import { coinjarHistory } from "./research/data";

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const pct = (x: number) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)}%`;
const money = (x: number) => `${x < 0 ? "-" : ""}$${Math.abs(x).toFixed(2)}`;
const DAY = 86_400_000;

async function main() {
  const cashLevels = (arg("cash") ?? "150,500").split(",").map(Number);
  // Research knobs: --only 1d (strategy intervals to include), --max-positions 4.
  const only = arg("only")?.split(",");
  const STRATEGIES = only ? ALL_STRATEGIES.filter((s) => only.includes(s.interval)) : ALL_STRATEGIES;
  if (arg("max-positions")) RISK.maxOpenPositions = Number(arg("max-positions"));
  console.log(`Strategies: ${STRATEGIES.map((s) => s.name).join(", ")}; max open positions ${RISK.maxOpenPositions}`);
  const split = Date.parse(arg("split", "2023-01-01")!);
  const intervals = [...new Set(STRATEGIES.map((s) => s.interval))];
  const tickerInterval = intervals.includes("4h") ? "4h" : intervals[0];

  const series = new Map<string, Candle[]>();
  for (const pid of MARKETS.products) {
    for (const interval of intervals) series.set(HistoricalMarket.key(pid, interval), await coinjarHistory(pid, interval, 2550));
  }
  const rules = await fetchProductRules();
  const now = Date.now();

  // 1. Calibration on data before the split only.
  const studyBefore = STRATEGIES.flatMap((s) => MARKETS.products.flatMap((pid) => studyStrategy(s, pid, series.get(HistoricalMarket.key(pid, s.interval))!, -Infinity, split)));
  const calibration = toCalibration(studyBefore.filter((t) => t.exitTime < split));
  console.log(`Calibration (trades closed before ${new Date(split).toISOString().slice(0, 10)}):`);
  printCalibration(calibration);

  // 2. Unseen period through the real engine.
  for (const cash of cashLevels) {
    const sim = await simulate({ series, tickerInterval, rules, calibration, strategies: STRATEGIES, products: MARKETS.products, startCash: cash, fromMs: split, toMs: now });
    report(`Unseen period ${new Date(split).toISOString().slice(0, 10)} -> today, $${cash} paper account`, sim);
  }

  // 3. Full history (2020 ->), calibrated on everything: how did 5-month windows go?
  const fullCal = toCalibration(STRATEGIES.flatMap((s) => MARKETS.products.flatMap((pid) => studyStrategy(s, pid, series.get(HistoricalMarket.key(pid, s.interval))!))));
  const fullStart = Date.parse("2020-03-01");
  const full = await simulate({ series, tickerInterval, rules, calibration: fullCal, strategies: STRATEGIES, products: MARKETS.products, startCash: 500, fromMs: fullStart, toMs: now });
  report("Full history 2020-03 -> today, $500 (rules are textbook; calibration in-sample)", full);
  rollingWindows(full, 152);

  if (process.argv.includes("--write-calibration")) {
    writeFileSync(
      "src/config/calibration.json",
      JSON.stringify(
        {
          generatedAt: new Date(now).toISOString(),
          source: `studyStrategy over CoinJar history since ${new Date(series.get(HistoricalMarket.key("BTCAUD", "1d"))![0].time).toISOString().slice(0, 10)} (${MARKETS.products.join(", ")}), net of 0.1% fees, 0.1% half-spread and 0.5% stop slippage`,
          strategies: fullCal,
        },
        null,
        2,
      ) + "\n",
    );
    console.log("\nWrote src/config/calibration.json");
  }
}

function printCalibration(cal: ReturnType<typeof toCalibration>) {
  for (const [name, r] of Object.entries(cal)) {
    const n = r.wins + r.losses;
    const avgWin = r.wins ? r.winSum / r.wins : 0;
    const avgLoss = r.losses ? r.lossSum / r.losses : 0;
    console.log(`  ${name.padEnd(22)} ${String(n).padStart(4)} trades, win rate ${pct(r.wins / n)}, avg win ${pct(avgWin)}, avg loss ${pct(-avgLoss)}, avg/trade ${pct((r.winSum - r.lossSum) / n)}`);
  }
}

function report(title: string, sim: SimulationResult) {
  const s = tradeStats(sim.trades);
  console.log(`\n${title}`);
  console.log(
    `  ${money(sim.startCash)} -> ${money(sim.endEquity)} (${pct(sim.endEquity / sim.startCash - 1)}), max drawdown ${pct(-sim.maxDrawdownPct)}${sim.halted ? ", KILL SWITCH HIT" : ""}`,
  );
  console.log(`  trades ${s.trades}, win rate ${pct(s.winRate)}, avg win ${money(s.avgWin)}, avg loss ${money(s.avgLoss)}, profit factor ${s.profitFactor.toFixed(2)}`);
  const byYear = new Map<number, number[]>();
  for (const p of sim.curve) {
    const y = new Date(p.t).getUTCFullYear();
    if (!byYear.has(y)) byYear.set(y, [p.equity, p.equity]);
    byYear.get(y)![1] = p.equity;
  }
  let prevEnd = sim.startCash;
  const parts: string[] = [];
  for (const [y, [, end]] of byYear) {
    parts.push(`${y} ${pct(end / prevEnd - 1)}`);
    prevEnd = end;
  }
  console.log(`  by year: ${parts.join(" | ")}`);
  const byStrategy = new Map<string, number[]>();
  for (const t of sim.trades) byStrategy.set(t.strategy, [...(byStrategy.get(t.strategy) ?? []), t.pnl]);
  for (const [name, pnls] of byStrategy) console.log(`  ${name}: ${pnls.length} trades, net ${money(pnls.reduce((a, b) => a + b, 0))}`);
}

/** Return over every `days`-long window starting each week. */
function rollingWindows(sim: SimulationResult, days: number) {
  const rets: number[] = [];
  const c = sim.curve;
  let i = 0;
  let j = 0;
  for (let start = c[0].t; ; start += 7 * DAY) {
    while (i < c.length && c[i].t < start) i++;
    while (j < c.length && c[j].t < start + days * DAY) j++;
    if (j >= c.length) break;
    rets.push(c[j].equity / c[i].equity - 1);
  }
  rets.sort((a, b) => a - b);
  const q = (p: number) => rets[Math.min(rets.length - 1, Math.floor(p * rets.length))];
  const positive = rets.filter((r) => r > 0).length / rets.length;
  console.log(`\n${days}-day windows (${rets.length} starting weekly): profitable ${pct(positive)} of the time`);
  console.log(`  worst ${pct(q(0))}, 10th pct ${pct(q(0.1))}, median ${pct(q(0.5))}, 90th pct ${pct(q(0.9))}, best ${pct(q(1))}`);
  for (const stake of [150, 500, 1000]) {
    console.log(`  on $${stake}: median ${money(stake * q(0.5))}, 10th pct ${money(stake * q(0.1))}, 90th pct ${money(stake * q(0.9))}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
