import { FEES } from "@/config/settings";
import type { BotState, Ticker } from "../types";
import { CoinjarTradingClient } from "./coinjar";

export interface Fill {
  size: number;
  price: number;
  fee: number;
}

export interface StopStatus {
  /** Base units already sold by the stop order. */
  filledSize: number;
  avgPrice: number;
  fee: number;
  /** True once the order can no longer fill (fully filled or cancelled). */
  done: boolean;
}

/** Execution agent's view of an exchange. Paper and live share the engine's logic exactly. */
export interface Broker {
  readonly mode: "paper" | "live";
  availableCash(): Promise<number>;
  buy(productId: string, size: number, ticker: Ticker): Promise<Fill>;
  /** `price` is used by the paper broker (it decides fills from candles); live sells at market. */
  sell(productId: string, size: number, price: number): Promise<Fill>;
  /** Places an exchange-side stop-loss; returns its id, or null when the broker simulates stops itself. */
  placeStop(productId: string, size: number, stopPrice: number): Promise<string | null>;
  stopStatus(stopOrderId: string): Promise<StopStatus>;
  cancelStop(stopOrderId: string): Promise<void>;
}

/** Simulated fills at the bid/ask with real CoinJar fees. Cash lives in BotState.paperCash. */
export class PaperBroker implements Broker {
  readonly mode = "paper" as const;

  constructor(private readonly state: BotState) {}

  async availableCash(): Promise<number> {
    return this.state.paperCash;
  }

  async buy(_productId: string, size: number, ticker: Ticker): Promise<Fill> {
    const fill = { size, price: ticker.ask, fee: size * ticker.ask * FEES.takerRate };
    const cost = fill.size * fill.price + fill.fee;
    if (cost > this.state.paperCash + 1e-9) throw new Error(`paper buy needs $${cost.toFixed(2)}, have $${this.state.paperCash.toFixed(2)}`);
    this.state.paperCash -= cost;
    return fill;
  }

  async sell(_productId: string, size: number, price: number): Promise<Fill> {
    const fill = { size, price, fee: size * price * FEES.takerRate };
    this.state.paperCash += fill.size * fill.price - fill.fee;
    return fill;
  }

  async placeStop(): Promise<string | null> {
    return null;
  }

  async stopStatus(): Promise<StopStatus> {
    return { filledSize: 0, avgPrice: 0, fee: 0, done: false };
  }

  async cancelStop(): Promise<void> {}
}

/** Real orders on CoinJar Exchange. Stop-losses sit on the exchange so they work between bot runs. */
export class CoinjarLiveBroker implements Broker {
  readonly mode = "live" as const;

  constructor(private readonly client: CoinjarTradingClient) {}

  async availableCash(): Promise<number> {
    const aud = (await this.client.accounts()).find((a) => a.asset_code === "AUD");
    return aud ? Number(aud.available) : 0;
  }

  async buy(productId: string, size: number): Promise<Fill> {
    const order = await this.client.marketOrder(productId, "buy", size);
    return this.fillOf(order.oid);
  }

  async sell(productId: string, size: number): Promise<Fill> {
    const order = await this.client.marketOrder(productId, "sell", size);
    return this.fillOf(order.oid);
  }

  async placeStop(productId: string, size: number, stopPrice: number): Promise<string | null> {
    // Limit 1% under the trigger so the stop still fills in a fast drop (CoinJar allows down to 80%).
    const order = await this.client.stopLimitSell(productId, size, stopPrice, Number((stopPrice * 0.99).toPrecision(8)));
    return String(order.oid);
  }

  async stopStatus(stopOrderId: string): Promise<StopStatus> {
    const order = await this.client.order(stopOrderId);
    const filledSize = Number(order.filled);
    const fills = filledSize > 0 ? await this.client.fillsFor(order.oid) : null;
    return {
      filledSize,
      avgPrice: fills?.avgPrice ?? 0,
      fee: fills?.fee ?? 0,
      done: order.status === "filled" || order.status === "cancelled",
    };
  }

  async cancelStop(stopOrderId: string): Promise<void> {
    await this.client.cancel(stopOrderId);
  }

  private async fillOf(oid: number): Promise<Fill> {
    // Market orders are IOC; fills can take a moment to appear.
    for (let attempt = 0; attempt < 5; attempt++) {
      const f = await this.client.fillsFor(oid);
      if (f) return { size: f.size, price: f.avgPrice, fee: f.fee };
      await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
    }
    throw new Error(`order ${oid} placed but no fills found; check CoinJar before the next run`);
  }
}
