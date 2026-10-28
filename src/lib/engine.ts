import { RISK, STRATEGY } from "@/config/settings";
import { type Calibration, bracket, decide } from "./agents/decision";
import { blendProbability, type DecisionModel } from "./agents/jev";
import { researchView } from "./agents/research";
import { accountBlock, assessEntry, checkExit } from "./agents/risk";
import { computeFeatures, SIGNAL_AGENTS } from "./agents/signals";
import type { Broker } from "./exchange/broker";
import { mergeCalibration, type Store, utcDay } from "./store/store";
import type { BotState, Candle, ExitReason, Position, ProductRules, Ticker } from "./types";

/** Market-data agent's sources. CoinJar in production; replayed history in backtests. */
export interface MarketData {
  candles(productId: string, interval: string, fromMs: number, toMs: number): Promise<Candle[]>;
  ticker(productId: string): Promise<Ticker>;
  rules(): Promise<Map<string, ProductRules>>;
}

export interface EngineDeps {
  store: Store;
  /** Built per run from the loaded state (the paper broker keeps its cash there). */
  createBroker: (state: BotState) => Broker;
  market: MarketData;
  decisionModel: DecisionModel;
  /** Prior hit rates per agent (from backtests), merged with this mode's real trades. */
  baseCalibration: Calibration;
  /** Starting balance for a brand-new paper account. */
  initialCash: number;
  now?: number;
  products?: readonly string[];
  /** Paper only: trade every signal to gather outcome data. Ignored for live brokers. */
  explore?: boolean;
}

export interface TickResult {
  mode: "paper" | "live";
  equity: number;
  cash: number;
  openPositions: number;
  actions: string[];
  errors: string[];
}

interface ProductView {
  candles: Candle[];
  ticker: Ticker;
}

/**
 * One cycle of the bot, run every few minutes by the scheduler:
 * 1. market data -> 2. manage open positions (exits) -> 3. account risk checks ->
 * 4. signal agents -> research + JEV -> decision -> risk manager -> execution.
 */
export async function runTick(deps: EngineDeps): Promise<TickResult> {
  const now = deps.now ?? Date.now();
  const products = deps.products ?? STRATEGY.products;
  const { store, market } = deps;
  const actions: string[] = [];
  const errors: string[] = [];

  const state = await store.loadState(deps.initialCash);
  const broker = deps.createBroker(state);
  const views = new Map<string, ProductView>();
  await Promise.all(
    products.map(async (pid) => {
      try {
        const [candles, ticker] = await Promise.all([
          market.candles(pid, STRATEGY.candleInterval, now - STRATEGY.lookbackCandles * STRATEGY.candleMs, now),
          market.ticker(pid),
        ]);
        views.set(pid, { candles, ticker });
      } catch (err) {
        errors.push(`${pid} market data: ${(err as Error).message}`);
      }
    }),
  );

  // 2. Exits first, so freed cash and slots are available to new entries.
  let positions = await store.openPositions();
  for (const pos of positions) {
    const view = views.get(pos.productId);
    if (!view) continue;
    try {
      const closed = await manageExit(deps, broker, state, pos, view, now);
      if (closed) actions.push(closed);
    } catch (err) {
      errors.push(`${pos.productId} exit: ${(err as Error).message}`);
    }
  }
  positions = await store.openPositions();

  // 3. Account-level risk.
  let cash = await broker.availableCash();
  const equity = cash + positions.reduce((s, p) => s + p.size * (views.get(p.productId)?.ticker.bid ?? p.entryPrice), 0);
  const today = utcDay(now);
  if (state.day !== today) {
    state.day = today;
    state.dayStartEquity = equity;
  }
  const block = accountBlock(state, equity);
  if (block?.haltNow) {
    state.halted = true;
    state.haltReason = block.reason;
    actions.push(`HALTED: ${block.reason}`);
  }
  state.peakEquity = Math.max(state.peakEquity, equity);

  // 4. New entries.
  if (block) {
    actions.push(`no new trades: ${block.reason}`);
  } else {
    const calibration = mergeCalibration(deps.baseCalibration, await store.tradeCalibration());
    const brief = await store.latestBrief();
    const rules = await market.rules();
    for (const pid of products) {
      const view = views.get(pid);
      if (!view || positions.some((p) => p.productId === pid)) continue;
      if (positions.length >= RISK.maxOpenPositions) break;
      try {
        const opened = await considerEntry({ deps, broker, state, pid, view, calibration, brief, rules, positions, cash, equity, now });
        if (opened) {
          positions.push(opened.position);
          cash = await broker.availableCash();
          actions.push(opened.message);
        }
      } catch (err) {
        errors.push(`${pid} entry: ${(err as Error).message}`);
      }
    }
  }

  const finalCash = await broker.availableCash();
  const finalEquity = finalCash + positions.reduce((s, p) => s + p.size * (views.get(p.productId)?.ticker.bid ?? p.entryPrice), 0);
  await store.saveState(state);
  await store.logRun({ at: now, mode: broker.mode, equity: finalEquity, cash: finalCash, actions, error: errors.length ? errors.join("; ") : null });
  return { mode: broker.mode, equity: finalEquity, cash: finalCash, openPositions: positions.length, actions, errors };
}

async function considerEntry(a: {
  deps: EngineDeps;
  broker: Broker;
  state: BotState;
  pid: string;
  view: ProductView;
  calibration: Calibration;
  brief: Awaited<ReturnType<Store["latestBrief"]>>;
  rules: Map<string, ProductRules>;
  positions: Position[];
  cash: number;
  equity: number;
  now: number;
}): Promise<{ position: Position; message: string } | null> {
  const { deps, state, pid, view, now } = a;
  if (view.ticker.status !== "continuous") return null;
  const features = computeFeatures(view.candles);
  const i = view.candles.length - 1;
  if (i < 0) return null;
  const signals = SIGNAL_AGENTS.map((agent) => agent.evaluate(features, i));
  if (!signals.some((s) => s.direction === "long")) return null;

  const research = researchView(a.brief, pid, now);
  if (research.blockReason) return null;

  const entryPrice = view.ticker.ask;
  const { stop, takeProfit } = bracket(entryPrice, features.atr14[i]);
  const jevProbability = await deps.decisionModel.winProbability({
    question: "Will this long trade close in profit (take-profit before stop-loss, within the max hold time)?",
    productId: pid,
    entryPrice,
    stopPrice: stop,
    takeProfitPrice: takeProfit,
    maxHoldHours: STRATEGY.maxHoldMs / 3_600_000,
    features: {
      rsi14: features.rsi14[i],
      atrPct: features.atr14[i] / entryPrice,
      ema20GapPct: features.ema20[i] / entryPrice - 1,
      ema200GapPct: features.ema200[i] / entryPrice - 1,
      volumeRatio: features.volSma20[i] > 0 ? view.candles[i].volume / features.volSma20[i] : 0,
    },
    agentReasons: signals.filter((s) => s.direction === "long").map((s) => s.reason),
  });

  const decision = decide({
    productId: pid,
    features,
    index: i,
    signals,
    entryPrice,
    calibration: a.calibration,
    probabilityAdjustment: research.probabilityAdjustment,
    blend: (own) => blendProbability(own, jevProbability),
    explore: deps.explore === true && a.broker.mode === "paper",
  });
  if (decision.action === "skip") return null;

  const rule = a.rules.get(pid);
  if (!rule) throw new Error(`no trading rules for ${pid}`);
  const verdict = assessEntry({
    proposal: decision.proposal,
    portfolio: { equity: a.equity, availableCash: a.cash, openPositions: a.positions },
    state,
    sizeIncrement: rule.sizeIncrementAt(entryPrice),
    spreadPct: (view.ticker.ask - view.ticker.bid) / view.ticker.ask,
    now,
  });
  if (!verdict.approved) return null;

  const fill = await a.broker.buy(pid, verdict.size, view.ticker);
  // Keep the planned stop/target distances relative to the actual fill price.
  const shift = fill.price - entryPrice;
  const position: Position = {
    id: crypto.randomUUID(),
    productId: pid,
    size: fill.size,
    entryPrice: fill.price,
    stopPrice: decision.proposal.stopPrice + shift,
    takeProfitPrice: decision.proposal.takeProfitPrice + shift,
    entryFee: fill.fee,
    openedAt: now,
    stopOrderId: null,
    winProbability: decision.proposal.winProbability,
    expectedValuePct: decision.proposal.expectedValuePct,
    agents: decision.proposal.agents,
    jevProbability,
    exploration: decision.proposal.expectedValuePct < STRATEGY.minExpectedValuePct || decision.proposal.winProbability < STRATEGY.minWinProbability,
  };
  await deps.store.insertPosition(position);
  position.stopOrderId = await a.broker.placeStop(pid, position.size, position.stopPrice);
  if (position.stopOrderId) await deps.store.updatePosition(position);

  return {
    position,
    message:
      `BUY ${fill.size} ${pid} @ ${fill.price} ($${(fill.size * fill.price).toFixed(2)}), ` +
      `stop ${position.stopPrice.toFixed(4)}, target ${position.takeProfitPrice.toFixed(4)}, ` +
      `p(win) ${(decision.proposal.winProbability * 100).toFixed(0)}%, EV ${(decision.proposal.expectedValuePct * 100).toFixed(2)}% [${position.agents.join("+")}]` +
      (position.exploration ? " (paper exploration)" : ""),
  };
}

/** Exit management for one position. Returns a log line when the position closes. */
async function manageExit(
  deps: EngineDeps,
  broker: Broker,
  state: BotState,
  pos: Position,
  view: ProductView,
  now: number,
): Promise<string | null> {
  const { bid } = view.ticker;
  const timeUp = now - pos.openedAt >= STRATEGY.maxHoldMs;

  if (broker.mode === "paper") {
    // Replay candles since entry so stops/targets hit between runs aren't missed.
    for (const c of view.candles) {
      if (c.time < pos.openedAt) continue;
      const exit = checkExit(pos, c, STRATEGY.candleMs);
      if (exit) return closeAt(deps, state, pos, await broker.sell(pos.productId, pos.size, exit.price), exit.reason, now);
    }
    if (bid <= pos.stopPrice) return closeAt(deps, state, pos, await broker.sell(pos.productId, pos.size, bid), "stop_loss", now);
    if (bid >= pos.takeProfitPrice) return closeAt(deps, state, pos, await broker.sell(pos.productId, pos.size, bid), "take_profit", now);
    if (timeUp) return closeAt(deps, state, pos, await broker.sell(pos.productId, pos.size, bid), "time_stop", now);
    return null;
  }

  // Live: the stop-loss rests on the exchange. Re-place it if placing it failed after the buy.
  if (!pos.stopOrderId) {
    pos.stopOrderId = await broker.placeStop(pos.productId, pos.size, pos.stopPrice);
    await deps.store.updatePosition(pos);
  }
  if (pos.stopOrderId) {
    const stop = await broker.stopStatus(pos.stopOrderId);
    if (stop.done && stop.filledSize >= pos.size - 1e-12) {
      return closeAt(deps, state, pos, { size: stop.filledSize, price: stop.avgPrice, fee: stop.fee }, "stop_loss", now);
    }
  }
  const missedStop = bid < pos.stopPrice * 0.99; // fell through the stop's limit price
  const reason: ExitReason | null = bid >= pos.takeProfitPrice ? "take_profit" : missedStop ? "stop_loss" : timeUp ? "time_stop" : null;
  if (!reason) return null;

  let alreadySold = { size: 0, price: 0, fee: 0 };
  if (pos.stopOrderId) {
    await broker.cancelStop(pos.stopOrderId);
    const s = await broker.stopStatus(pos.stopOrderId);
    alreadySold = { size: s.filledSize, price: s.avgPrice, fee: s.fee };
  }
  const remaining = pos.size - alreadySold.size;
  const sold = remaining > 1e-12 ? await broker.sell(pos.productId, remaining, bid) : { size: 0, price: 0, fee: 0 };
  const totalSize = alreadySold.size + sold.size;
  const avgPrice = totalSize > 0 ? (alreadySold.size * alreadySold.price + sold.size * sold.price) / totalSize : bid;
  return closeAt(deps, state, pos, { size: totalSize, price: avgPrice, fee: alreadySold.fee + sold.fee }, reason, now);
}

async function closeAt(
  deps: EngineDeps,
  state: BotState,
  pos: Position,
  fill: { size: number; price: number; fee: number },
  reason: ExitReason,
  now: number,
): Promise<string> {
  const fees = pos.entryFee + fill.fee;
  const pnl = fill.size * fill.price - pos.size * pos.entryPrice - fees;
  await deps.store.closePosition({
    positionId: pos.id,
    productId: pos.productId,
    size: pos.size,
    entryPrice: pos.entryPrice,
    exitPrice: fill.price,
    openedAt: pos.openedAt,
    closedAt: now,
    fees,
    pnl,
    exitReason: reason,
    winProbability: pos.winProbability,
    expectedValuePct: pos.expectedValuePct,
    agents: pos.agents,
    jevProbability: pos.jevProbability,
    exploration: pos.exploration,
  });
  state.lastExitAt[pos.productId] = now;
  return `SELL ${pos.size} ${pos.productId} @ ${fill.price} (${reason}), P/L ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}`;
}
