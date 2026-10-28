import { MARKETS, RISK } from "@/config/settings";
import { type Calibration, decide } from "./agents/decision";
import { blendProbability, type DecisionModel } from "./agents/jev";
import { researchView } from "./agents/research";
import { accountBlock, assessEntry, stopFill } from "./agents/risk";
import { STRATEGIES, type Strategy, strategyByName } from "./agents/strategies";
import type { Broker } from "./exchange/broker";
import { mergeCalibration, type Store, tradingDay } from "./store/store";
import type { BotState, Candle, ExitReason, KnowledgeBrief, Position, ProductRules, Ticker } from "./types";

/** Market-data agent's sources. CoinJar in production; replayed history in backtests. */
export interface MarketData {
  /** Closed candles only, oldest first. */
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
  /** Measured strategy records from backtests, merged with this mode's real trades. */
  baseCalibration: Calibration;
  /** Starting balance for a brand-new paper account. */
  initialCash: number;
  now?: number;
  products?: readonly string[];
  strategies?: readonly Strategy[];
}

export interface TickResult {
  mode: "paper" | "live";
  equity: number;
  cash: number;
  openPositions: number;
  actions: string[];
  errors: string[];
}

/** Per-run cache so each (market, timeframe) is fetched once. */
class MarketView {
  private candleCache = new Map<string, Promise<Candle[]>>();
  readonly tickers = new Map<string, Ticker>();

  constructor(
    private readonly market: MarketData,
    private readonly now: number,
  ) {}

  candles(pid: string, s: Strategy): Promise<Candle[]> {
    const key = `${pid}:${s.interval}`;
    let p = this.candleCache.get(key);
    if (!p) {
      p = this.market.candles(pid, s.interval, this.now - (s.lookbackCandles + 2) * s.candleMs, this.now);
      this.candleCache.set(key, p);
    }
    return p;
  }

  markPrice(p: Position): number {
    return this.tickers.get(p.productId)?.bid ?? p.entryPrice;
  }
}

/** A run never takes this long; the lock expires on its own if a run crashes mid-way. */
const LOCK_TTL_MS = 2 * 60 * 1000;

/**
 * One cycle of the bot, run every 5 minutes by the scheduler:
 * 1. market data -> 2. exits for open positions -> 3. account risk checks ->
 * 4. strategy agents -> research + JEV -> decision -> risk manager -> execution.
 */
export async function runTick(deps: EngineDeps): Promise<TickResult> {
  const now = deps.now ?? Date.now();
  const products = deps.products ?? MARKETS.products;
  const strategies = deps.strategies ?? STRATEGIES;
  const { store } = deps;
  if (!(await store.tryLock(now, LOCK_TTL_MS))) {
    return { mode: "paper", equity: 0, cash: 0, openPositions: 0, actions: ["skipped: another run is in progress"], errors: [] };
  }
  try {
    return await tick(deps, now, products, strategies);
  } finally {
    await store.unlock();
  }
}

async function tick(deps: EngineDeps, now: number, products: readonly string[], strategies: readonly Strategy[]): Promise<TickResult> {
  const { store } = deps;
  const actions: string[] = [];
  const errors: string[] = [];

  const state = await store.loadState(deps.initialCash);
  const broker = deps.createBroker(state);
  const view = new MarketView(deps.market, now);
  await Promise.all(
    products.map(async (pid) => {
      try {
        view.tickers.set(pid, await deps.market.ticker(pid));
      } catch (err) {
        errors.push(`${pid} ticker: ${(err as Error).message}`);
      }
    }),
  );

  // 2. Exits first, so freed cash and slots are available to new entries.
  for (const pos of await store.openPositions()) {
    if (!view.tickers.has(pos.productId)) continue;
    try {
      const closed = await manageExit(deps, broker, state, view, pos, now);
      if (closed) actions.push(closed);
    } catch (err) {
      errors.push(`${pos.productId} exit: ${(err as Error).message}`);
    }
  }
  let positions = await store.openPositions();

  // 3. Account-level risk.
  let cash = await broker.availableCash();
  let equity = cash + positions.reduce((s, p) => s + p.size * view.markPrice(p), 0);
  if (state.peakEquity <= 0) {
    // First live run: start the drawdown and daily-loss baselines from the real balance.
    state.peakEquity = equity;
    state.dayStartEquity = equity;
  }
  const today = tradingDay(now);
  if (state.day !== today) {
    state.day = today;
    state.dayStartEquity = equity;
  }
  const dayLoss = state.dayStartEquity > 0 ? (state.dayStartEquity - equity) / state.dayStartEquity : 0;
  if (dayLoss >= RISK.maxDailyLossPct && positions.length > 0) {
    // Your rule: never lose more than 10% of capital in a day. Sell everything; new trades resume tomorrow.
    actions.push(`DAILY LOSS LIMIT: down ${(dayLoss * 100).toFixed(1)}% today, selling all positions`);
    for (const pos of positions) {
      try {
        actions.push(await sellNow(deps, broker, state, pos, view.tickers.get(pos.productId)!.bid, "daily_loss_limit", "down 10% today", now));
      } catch (err) {
        errors.push(`${pos.productId} daily-loss sell: ${(err as Error).message}`);
      }
    }
    positions = await store.openPositions();
    cash = await broker.availableCash();
    equity = cash + positions.reduce((s, p) => s + p.size * view.markPrice(p), 0);
  }
  const block = accountBlock(state, equity);
  if (block?.haltNow) {
    state.halted = true;
    state.haltReason = block.reason;
    actions.push(`HALTED: ${block.reason}`);
  }
  state.peakEquity = Math.max(state.peakEquity, equity);

  // 4. New entries: one position per market, strategies in priority order.
  if (block) {
    if (positions.length < RISK.maxOpenPositions) actions.push(`no new trades: ${block.reason}`);
  } else if (positions.length < RISK.maxOpenPositions) {
    const calibration = mergeCalibration(deps.baseCalibration, await store.tradeCalibration());
    const brief = await store.latestBrief();
    const rules = await deps.market.rules();
    for (const pid of products) {
      if (positions.length >= RISK.maxOpenPositions) break;
      const ticker = view.tickers.get(pid);
      if (!ticker || ticker.status !== "continuous" || positions.some((p) => p.productId === pid)) continue;
      for (const strategy of strategies) {
        try {
          const opened = await considerEntry({ deps, broker, state, view, strategy, pid, ticker, calibration, brief, rules, positions, cash, equity, now });
          if (opened) {
            positions.push(opened.position);
            cash = await broker.availableCash();
            actions.push(opened.message);
            break;
          }
        } catch (err) {
          errors.push(`${pid} ${strategy.name} entry: ${(err as Error).message}`);
        }
      }
    }
  }

  const finalCash = await broker.availableCash();
  const finalEquity = finalCash + positions.reduce((s, p) => s + p.size * view.markPrice(p), 0);
  await store.saveState(state);
  await store.logRun({ at: now, mode: broker.mode, equity: finalEquity, cash: finalCash, actions, error: errors.length ? errors.join("; ") : null });
  return { mode: broker.mode, equity: finalEquity, cash: finalCash, openPositions: positions.length, actions, errors };
}

async function considerEntry(a: {
  deps: EngineDeps;
  broker: Broker;
  state: BotState;
  view: MarketView;
  strategy: Strategy;
  pid: string;
  ticker: Ticker;
  calibration: Calibration;
  brief: KnowledgeBrief | null;
  rules: Map<string, ProductRules>;
  positions: Position[];
  cash: number;
  equity: number;
  now: number;
}): Promise<{ position: Position; message: string } | null> {
  const { deps, strategy, pid, ticker, now } = a;
  const candles = await a.view.candles(pid, strategy);
  if (candles.length < strategy.lookbackCandles) return null;
  // Only act on a signal from the candle that just closed, not a stale one.
  if (now - (candles[candles.length - 1].time + strategy.candleMs) >= strategy.candleMs) return null;
  const reason = strategy.entry(candles);
  if (!reason) return null;

  const research = researchView(a.brief, pid, now);
  if (research.blockReason) return null;

  const entryPrice = ticker.ask;
  const stopPrice = strategy.stopPrice(candles, entryPrice);
  const jevProbability = await deps.decisionModel.winProbability({
    question: "Will this trend-following long trade close in profit?",
    productId: pid,
    strategy: strategy.name,
    entryPrice,
    stopPrice,
    features: strategy.features(candles),
    reason,
  });

  const decision = decide({
    strategy: strategy.name,
    calibration: a.calibration,
    probabilityAdjustment: research.probabilityAdjustment,
    blend: (own) => blendProbability(own, jevProbability),
  });
  if (decision.action === "skip") return null;

  const rule = a.rules.get(pid);
  if (!rule) throw new Error(`no trading rules for ${pid}`);
  const verdict = assessEntry({
    proposal: { productId: pid, strategy: strategy.name, entryPrice, stopPrice, winProbability: decision.winProbability, expectedValuePct: decision.expectedValuePct, reason },
    portfolio: { equity: a.equity, availableCash: a.cash, openPositions: a.positions },
    state: a.state,
    sizeIncrement: rule.sizeIncrementAt(entryPrice),
    spreadPct: (ticker.ask - ticker.bid) / ticker.ask,
    now,
  });
  if (!verdict.approved) return null;

  const fill = await a.broker.buy(pid, verdict.size, ticker);
  const position: Position = {
    id: crypto.randomUUID(),
    productId: pid,
    size: fill.size,
    entryPrice: fill.price,
    // Keep the planned stop distance relative to the actual fill price.
    stopPrice: stopPrice + (fill.price - entryPrice),
    entryFee: fill.fee,
    openedAt: now,
    stopOrderId: null,
    strategy: strategy.name,
    winProbability: decision.winProbability,
    expectedValuePct: decision.expectedValuePct,
    jevProbability,
  };
  await deps.store.insertPosition(position);
  position.stopOrderId = await a.broker.placeStop(pid, position.size, position.stopPrice);
  if (position.stopOrderId) await deps.store.updatePosition(position);

  return {
    position,
    message:
      `BUY ${fill.size} ${pid} @ ${fill.price} ($${(fill.size * fill.price).toFixed(2)}) [${strategy.name}] ${reason}; ` +
      `stop ${position.stopPrice.toPrecision(6)}, p(win) ${(decision.winProbability * 100).toFixed(0)}%, EV ${(decision.expectedValuePct * 100).toFixed(1)}%`,
  };
}

/** Exit management for one position. Returns a log line when the position closes. */
async function manageExit(deps: EngineDeps, broker: Broker, state: BotState, view: MarketView, pos: Position, now: number): Promise<string | null> {
  const bid = view.tickers.get(pos.productId)!.bid;
  const strategy = strategyByName(pos.strategy);

  let reason: ExitReason | null = null;
  let detail = "";
  if (!strategy) {
    reason = "strategy_retired";
    detail = `${pos.strategy} is no longer in use`;
  } else {
    const candles = await view.candles(pos.productId, strategy);
    // Only candles that closed after entry can trigger an exit signal.
    const sinceEntry = candles.filter((c) => c.time + strategy.candleMs > pos.openedAt);

    if (broker.mode === "paper") {
      // Simulate the exchange-side stop: replay candle lows since entry, then the live bid.
      for (const c of sinceEntry) {
        const fill = stopFill(pos, c);
        if (fill !== null) return closeAt(deps, state, pos, await broker.sell(pos.productId, pos.size, fill), "stop_loss", "stop hit", now);
      }
      if (bid <= pos.stopPrice) return closeAt(deps, state, pos, await broker.sell(pos.productId, pos.size, bid), "stop_loss", "stop hit", now);
    }

    const signal = sinceEntry.length > 0 ? strategy.exit(candles) : null;
    if (signal) {
      reason = "signal_exit";
      detail = signal;
    }
  }

  if (broker.mode === "paper") {
    return reason ? closeAt(deps, state, pos, await broker.sell(pos.productId, pos.size, bid), reason, detail, now) : null;
  }

  // Live: the stop-loss rests on the exchange. Re-place it if placing it failed after the buy.
  if (!pos.stopOrderId) {
    pos.stopOrderId = await broker.placeStop(pos.productId, pos.size, pos.stopPrice);
    await deps.store.updatePosition(pos);
  }
  if (pos.stopOrderId) {
    const stop = await broker.stopStatus(pos.stopOrderId);
    if (stop.done && stop.filledSize >= pos.size - 1e-12) {
      return closeAt(deps, state, pos, { size: stop.filledSize, price: stop.avgPrice, fee: stop.fee }, "stop_loss", "exchange stop filled", now);
    }
  }
  if (!reason && bid < pos.stopPrice * 0.99) {
    reason = "stop_loss"; // fell through the stop's limit price without filling
    detail = "price fell through the stop";
  }
  if (!reason) return null;

  return sellNow(deps, broker, state, pos, bid, reason, detail, now);
}

/**
 * Sells a whole position at market now. Live: cancels the exchange stop first
 * (it reserves the coins) and accounts for any part the stop already sold.
 */
async function sellNow(
  deps: EngineDeps,
  broker: Broker,
  state: BotState,
  pos: Position,
  bid: number,
  reason: ExitReason,
  detail: string,
  now: number,
): Promise<string> {
  if (broker.mode === "paper") return closeAt(deps, state, pos, await broker.sell(pos.productId, pos.size, bid), reason, detail, now);
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
  return closeAt(deps, state, pos, { size: totalSize, price: avgPrice, fee: alreadySold.fee + sold.fee }, reason, detail, now);
}

/**
 * Emergency button: sell every open position at market and halt the bot
 * until a person presses Resume. Waits briefly if a scheduled run is mid-way.
 */
export async function liquidateAll(deps: EngineDeps, why: string): Promise<{ actions: string[]; errors: string[] }> {
  const { store } = deps;
  const now = deps.now ?? Date.now();
  return withRunLock(store, async () => {
    const actions: string[] = [];
    const errors: string[] = [];
    const state = await store.loadState(deps.initialCash);
    const broker = deps.createBroker(state);
    for (const pos of await store.openPositions()) {
      try {
        const ticker = await deps.market.ticker(pos.productId);
        actions.push(await sellNow(deps, broker, state, pos, ticker.bid, "liquidated", why, now));
      } catch (err) {
        errors.push(`${pos.productId}: ${(err as Error).message}`);
      }
    }
    state.halted = true;
    state.haltReason = `liquidated: ${why}`;
    actions.push(`HALTED: ${state.haltReason}`);
    await store.saveState(state);
    const cash = await broker.availableCash();
    await store.logRun({ at: now, mode: broker.mode, equity: cash, cash, actions, error: errors.length ? errors.join("; ") : null });
    return { actions, errors };
  });
}

/** Runs `fn` holding the run lock, waiting up to ~20s for a scheduled run to finish. For dashboard actions. */
export async function withRunLock<T>(store: Store, fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; !(await store.tryLock(Date.now(), LOCK_TTL_MS)); attempt++) {
    if (attempt >= 20) throw new Error("a bot run is still in progress; try again in a minute");
    await new Promise((r) => setTimeout(r, 1000));
  }
  try {
    return await fn();
  } finally {
    await store.unlock();
  }
}

async function closeAt(
  deps: EngineDeps,
  state: BotState,
  pos: Position,
  fill: { size: number; price: number; fee: number },
  reason: ExitReason,
  detail: string,
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
    strategy: pos.strategy,
    winProbability: pos.winProbability,
    expectedValuePct: pos.expectedValuePct,
    jevProbability: pos.jevProbability,
  });
  state.lastExitAt[pos.productId] = now;
  return `SELL ${pos.size} ${pos.productId} @ ${fill.price} (${reason}: ${detail}), P/L ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}`;
}
