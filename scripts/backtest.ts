/**
 * Walk-forward backtest on real CoinJar history.
 *
 *   npm run backtest                         # 180 days, $50 and $500 accounts
 *   npm run backtest -- --days 365 --cash 200
 *   npm run backtest -- --write-calibration  # save measured hit rates for the live bot
 *
 * Phase 1 (first 60%): measure each signal agent's hit rate -> calibration.
 * Phase 2 (last 40%, unseen): run the real engine with that calibration.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { STRATEGY } from "../src/config/settings";
import { simulate, studyAgents, toCalibration } from "../src/lib/backtest";
import { tradeStats } from "../src/lib/stats";
import { coinjarData, fetchProductRules } from "../src/lib/exchange/coinjar";
import type { Candle } from "../src/lib/types";

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const money = (x: number) => `${x < 0 ? "-" : ""}$${Math.abs(x).toFixed(2)}`;

async function main() {
  const days = Number(arg("days", "365"));
  const cashLevels = (arg("cash") ?? "50,500").split(",").map(Number);
  const writeCalibration = process.argv.includes("--write-calibration");

  const now = Date.now();
  const from = now - days * 86_400_000;
  console.log(`Fetching ${days} days of ${STRATEGY.candleInterval} candles from CoinJar...`);
  const series = new Map<string, Candle[]>();
  for (const pid of STRATEGY.products) series.set(pid, await coinjarData.candles(pid, STRATEGY.candleInterval, from, now));
  const rules = await fetchProductRules();
  for (const [pid, c] of series) console.log(`  ${pid}: ${c.length} candles, ${c[0]?.close} -> ${c.at(-1)?.close}`);

  const warmup = from + STRATEGY.lookbackCandles * STRATEGY.candleMs;
  const split = warmup + (now - warmup) * 0.6;

  console.log(`\nPhase 1: agent hit rates, ${new Date(warmup).toISOString().slice(0, 10)} -> ${new Date(split).toISOString().slice(0, 10)} (training)`);
  const train = studyAgents(series, warmup, split);
  printStudy(train);
  console.log(`\nSame agents on the unseen period (for comparison):`);
  const test = studyAgents(series, split, now);
  printStudy(test);

  const calibration = toCalibration(train);
  const results: Record<string, unknown> = { days, train, test };
  const runs = [
    ...cashLevels.map((cash) => ({ cash, explore: false })),
    { cash: Math.max(...cashLevels), explore: true },
  ];
  for (const { cash, explore } of runs) {
    console.log(`\nPhase 2: real engine on unseen period, $${cash}, ${explore ? "paper EXPLORATION (EV gate off)" : "normal (EV gate on)"}`);
    const sim = await simulate({ series, rules, calibration, startCash: cash, fromMs: split, toMs: now - STRATEGY.candleMs, explore });
    const s = tradeStats(sim.trades);
    console.log(
      `  trades ${s.trades} | win rate ${pct(s.winRate)} | avg win ${money(s.avgWin)} | avg loss ${money(s.avgLoss)} | ` +
        `profit factor ${s.profitFactor.toFixed(2)} | avg return/trade ${pct(s.avgReturnPct)}`,
    );
    console.log(
      `  equity ${money(sim.startCash)} -> ${money(sim.endEquity)} (${pct(sim.endEquity / sim.startCash - 1)}), ` +
        `max drawdown ${pct(sim.maxDrawdownPct)}${sim.halted ? ", KILL SWITCH HIT" : ""}`,
    );
    const byReason = sim.trades.reduce<Record<string, number>>((m, t) => ((m[t.exitReason] = (m[t.exitReason] ?? 0) + 1), m), {});
    if (sim.trades.length) console.log(`  exits: ${JSON.stringify(byReason)}`);
    results[`sim_${cash}${explore ? "_explore" : ""}`] = { stats: s, endEquity: sim.endEquity, maxDrawdownPct: sim.maxDrawdownPct, exits: byReason };
  }

  mkdirSync("backtest-results", { recursive: true });
  const out = path.join("backtest-results", `backtest-${new Date(now).toISOString().slice(0, 16).replace(/:/g, "")}.json`);
  writeFileSync(out, JSON.stringify(results, null, 2));
  console.log(`\nSaved ${out}`);

  if (writeCalibration) {
    const full = studyAgents(series, warmup, now);
    const file = {
      generatedAt: new Date(now).toISOString(),
      source: `studyAgents over ${days} days of CoinJar ${STRATEGY.candleInterval} candles (${STRATEGY.products.join(", ")}), stop ${STRATEGY.stopAtr} ATR / target ${STRATEGY.takeProfitAtr} ATR`,
      agents: toCalibration(full),
    };
    writeFileSync("src/config/calibration.json", JSON.stringify(file, null, 2) + "\n");
    console.log("Wrote src/config/calibration.json");
  }
}

function printStudy(study: ReturnType<typeof studyAgents>) {
  for (const [agent, s] of Object.entries(study)) {
    const n = s.wins + s.losses;
    console.log(`  ${agent.padEnd(16)} ${String(n).padStart(4)} trades, win rate ${pct(s.wins / n).padStart(6)}, avg net return ${pct(s.avgReturn)}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
