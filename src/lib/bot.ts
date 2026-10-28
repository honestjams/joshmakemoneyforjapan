import calibrationFile from "@/config/calibration.json";
import type { Calibration } from "./agents/decision";
import { JevDecisionModel } from "./agents/jev";
import type { EngineDeps, MarketData } from "./engine";
import { CoinjarLiveBroker, PaperBroker } from "./exchange/broker";
import { coinjarData, CoinjarTradingClient, fetchProductRules } from "./exchange/coinjar";
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
    initialCash: Number(process.env.PAPER_STARTING_BALANCE ?? "500"),
  };
}
