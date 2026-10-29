/**
 * Research: robustness of the Donchian trend rule's settings, through the
 * production engine, on two independent datasets.
 *
 *   npx tsx scripts/research/variants.ts
 *
 * - CoinJar AUD daily candles (Nov 2019 ->), the market the bot trades.
 * - Binance USDT daily candles (Aug 2017 ->), which adds the 2018 crash.
 *   The rule only looks at price shape, so USD prices test it just as well.
 *
 * For each dataset, every variant is calibrated on the early period only and
 * scored on the later period it never saw. A variant is only worth adopting
 * if it beats the current settings on BOTH datasets' unseen periods; a
 * setting that wins on one and loses on the other is noise.
 */
import { RISK } from "../../src/config/settings";
import { donchianBreakout, type Strategy } from "../../src/lib/agents/strategies";
import { HistoricalMarket, simulate, studyStrategy, toCalibration } from "../../src/lib/backtest";
import { fetchProductRules } from "../../src/lib/exchange/coinjar";
import { tradeStats } from "../../src/lib/stats";
import type { Candle, ProductRules } from "../../src/lib/types";
import { binanceHistory, coinjarHistory } from "./data";

const pct = (x: number) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(0)}%`;

interface Dataset {
  name: string;
  products: string[];
  series: Map<string, Candle[]>;
  rules: Map<string, ProductRules>;
  split: number;
  startCash: number;
}

const VARIANTS: [number, number, number][] = [
  // [entry lookback, exit lookback, stop ATRs]; the current setting is 55/20/3.
  [55, 20, 3],
  [20, 10, 3],
  [40, 15, 3],
  [55, 10, 3],
  [55, 30, 3],
  [70, 25, 3],
  [100, 30, 3],
  [55, 20, 2],
  [55, 20, 4],
];

function strategyFor([n, m, s]: [number, number, number]): Strategy {
  return donchianBreakout("1d", n, m, s, `donchian_${n}_${m}_stop${s}_1d`);
}

async function run(ds: Dataset, v: [number, number, number]) {
  const strategy = strategyFor(v);
  const study = ds.products.flatMap((pid) => studyStrategy(strategy, pid, ds.series.get(HistoricalMarket.key(pid, "1d"))!, -Infinity, ds.split));
  const calibration = toCalibration(study.filter((t) => t.exitTime < ds.split));
  const sim = await simulate({
    series: ds.series,
    tickerInterval: "1d",
    rules: ds.rules,
    calibration,
    strategies: [strategy],
    products: ds.products,
    startCash: ds.startCash,
    fromMs: ds.split,
    toMs: Date.now(),
  });
  const s = tradeStats(sim.trades);
  const years = new Map<number, number>();
  let prev = ds.startCash;
  for (const p of sim.curve) years.set(new Date(p.t).getUTCFullYear(), p.equity);
  const byYear = [...years].map(([y, eq]) => {
    const r = eq / prev - 1;
    prev = eq;
    return `${String(y).slice(2)}:${pct(r)}`;
  });
  return { ret: sim.endEquity / ds.startCash - 1, dd: sim.maxDrawdownPct, trades: s.trades, win: s.winRate, pf: s.profitFactor, byYear };
}

async function main() {
  // --basis cost: kill switch counts only real losses (see RISK.drawdownBasis).
  const bi = process.argv.indexOf("--basis");
  if (bi >= 0) RISK.drawdownBasis = process.argv[bi + 1] as "mark" | "cost";
  console.log(`Kill switch basis: ${RISK.drawdownBasis}`);
  const coinjarProducts = ["BTCAUD", "ETHAUD", "SOLAUD", "XRPAUD", "DOGE-AUD"];
  const cj = new Map<string, Candle[]>();
  for (const p of coinjarProducts) cj.set(HistoricalMarket.key(p, "1d"), await coinjarHistory(p, "1d", 2550));
  const binanceProducts = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT", "DOGEUSDT"];
  const bn = new Map<string, Candle[]>();
  for (const p of binanceProducts) bn.set(HistoricalMarket.key(p, "1d"), await binanceHistory(p, "1d", 3400));
  for (const p of binanceProducts) {
    const c = bn.get(HistoricalMarket.key(p, "1d"))!;
    console.log(`${p}: ${c.length} days from ${new Date(c[0].time).toISOString().slice(0, 10)}`);
  }
  // Binance has no AUD minimum-order rules; use tiny increments and a big
  // account so only the strategy (not order minimums) is being tested.
  const tiny: ProductRules = { id: "any", sizeIncrementAt: () => 1e-8 };
  const datasets: Dataset[] = [
    { name: "CoinJar AUD, unseen 2023-01 -> now ($350)", products: coinjarProducts, series: cj, rules: await fetchProductRules(), split: Date.parse("2023-01-01"), startCash: 350 },
    { name: "Binance USD, unseen 2021-01 -> now (incl. 2022 crash)", products: binanceProducts, series: bn, rules: new Map(binanceProducts.map((p) => [p, tiny])), split: Date.parse("2021-01-01"), startCash: 10_000 },
  ];
  const results = new Map<string, Awaited<ReturnType<typeof run>>[]>();
  for (const ds of datasets) {
    console.log(`\n${ds.name}`);
    console.log(`  ${"entry/exit/stop".padEnd(16)} ${"return".padStart(7)} ${"maxDD".padStart(6)} ${"trades".padStart(6)} ${"win".padStart(5)} ${"PF".padStart(5)}  by year`);
    for (const v of VARIANTS) {
      const r = await run(ds, v);
      const key = v.join("/");
      results.set(key, [...(results.get(key) ?? []), r]);
      const label = `${v[0]}/${v[1]}/${v[2]}${key === "55/20/3" ? " *" : ""}`;
      console.log(
        `  ${label.padEnd(16)} ${pct(r.ret).padStart(7)} ${pct(-r.dd).padStart(6)} ${String(r.trades).padStart(6)} ${pct(r.win).padStart(5)} ${r.pf.toFixed(2).padStart(5)}  ${r.byYear.join(" ")}`,
      );
    }
  }
  const base = results.get("55/20/3")!;
  console.log("\nBeats the current 55/20/3 on BOTH unseen periods (higher return and no worse drawdown):");
  const winners = [...results].filter(([k, [a, b]]) => k !== "55/20/3" && a.ret > base[0].ret && b.ret > base[1].ret && a.dd <= base[0].dd + 0.01 && b.dd <= base[1].dd + 0.01);
  console.log(winners.length ? winners.map(([k]) => `  ${k}`).join("\n") : "  none");
  const positive = [...results].filter(([, [a, b]]) => a.ret > 0 && b.ret > 0).length;
  console.log(`\nVariants profitable on both unseen periods: ${positive} of ${results.size}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
