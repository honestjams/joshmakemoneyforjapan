import calibrationFile from "@/config/calibration.json";
import type { Calibration } from "./agents/decision";
import { JevDecisionModel } from "./agents/jev";
import { GO_LIVE } from "@/config/settings";
import type { EngineDeps, MarketData } from "./engine";
import { CoinjarLiveBroker, PaperBroker } from "./exchange/broker";
import { coinjarData, CoinjarTradingClient, fetchProductRules } from "./exchange/coinjar";
import { checkCoinjarKey, liveReadiness, type Readiness } from "./live";
import type { Store } from "./store/store";
import { SupabaseStore } from "./store/supabase";
import type { ProductRules } from "./types";

export type TradingMode = "paper" | "live";

/**
 * Live trading needs two deliberate settings, so a stray API key alone can
 * never start real trades: TRADING_MODE=live and LIVE_TRADING_ACKNOWLEDGED=yes.
 */
export function tradingMode(): TradingMode {
  if (process.env.TRADING_MODE !== "live") return "paper";
  if (process.env.LIVE_TRADING_ACKNOWLEDGED !== "yes") {
    throw new Error("TRADING_MODE=live requires LIVE_TRADING_ACKNOWLEDGED=yes");
  }
  if (!process.env.COINJAR_API_KEY) throw new Error("TRADING_MODE=live requires COINJAR_API_KEY");
  return "live";
}

export const baseCalibration: Calibration = calibrationFile.strategies;

let rulesCache: { at: number; rules: Map<string, ProductRules> } | null = null;

export const coinjarMarket: MarketData = {
  candles: (pid, interval, from, to) => coinjarData.candles(pid, interval, from, to),
  ticker: (pid) => coinjarData.ticker(pid),
  async rules() {
    if (!rulesCache || Date.now() - rulesCache.at > 60 * 60 * 1000) {
      rulesCache = { at: Date.now(), rules: await fetchProductRules() };
    }
    return rulesCache.rules;
  },
};

/** Wires the production bot: CoinJar market data, Supabase storage, paper or live execution. */
export function productionDeps(store?: Store): EngineDeps {
  const mode = tradingMode();
  const live = mode === "live" ? new CoinjarLiveBroker(new CoinjarTradingClient(process.env.COINJAR_API_KEY!)) : null;
  return {
    store: store ?? new SupabaseStore(mode),
    createBroker: (state) => live ?? new PaperBroker(state),
    market: coinjarMarket,
    decisionModel: new JevDecisionModel(),
    baseCalibration,
    // Live baselines come from the real balance on the first run (see runTick).
    initialCash: mode === "live" ? 0 : Number(process.env.PAPER_STARTING_BALANCE ?? "500"),
  };
}

/** The go-live checklist as it stands now (shown on the dashboard, enforced by liveGate). */
export async function readinessReport(now = Date.now()): Promise<Readiness> {
  const paper = new SupabaseStore("paper");
  const [paperRuns, paperState, key] = await Promise.all([
    paper.paperRunHealth(now - GO_LIVE.healthWindowMs),
    paper.loadState(0),
    process.env.COINJAR_API_KEY ? checkCoinjarKey(new CoinjarTradingClient(process.env.COINJAR_API_KEY)) : Promise.resolve(null),
  ]);
  return liveReadiness({ now, paperRuns, paperHalted: paperState.halted, key });
}

/**
 * Runs before every live tick. The key must always be trade-only. The rest of
 * the checklist must pass once; after that the live account is marked
 * `liveSince` and paper health no longer matters (the paper bot stops when
 * TRADING_MODE switches to live).
 */
export async function liveGate(now = Date.now()): Promise<{ ok: true } | { ok: false; reason: string }> {
  const key = await checkCoinjarKey(new CoinjarTradingClient(process.env.COINJAR_API_KEY!));
  if (!key.ok) return { ok: false, reason: key.problems.join("; ") };
  const live = new SupabaseStore("live");
  const state = await live.loadState(0);
  if (state.liveSince) return { ok: true };
  const report = await readinessReport(now);
  if (!report.ready) {
    return { ok: false, reason: report.checks.filter((c) => !c.ok).map((c) => `${c.label}: ${c.detail}`).join("; ") };
  }
  await live.saveState({ ...state, liveSince: now });
  return { ok: true };
}
